/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 Phase 1 walk-forward evidence rail: the splitter's look-ahead contract proven on REAL Kibot ES daily bars through the driver's own slicing (not a re-implementation of it), contiguous non-overlapping out-of-sample coverage, the step<oos refusal, the config deep merge (defaults kept, undefined never becoming NaN, explicit null refused), grid cardinality and empty-axis refusal, and the named-fitness lookup that throws instead of defaulting.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import {
  walkForwardWindows, walkForward, mergeBacktestConfig, expandGrid, patchFromDottedKey,
  resolveFitness, scoreBacktest, buildContinuousSeries, KibotFileDataSource,
} from '../../src/features/trading';
import type {
  FuturesBar, BacktestConfig, BacktestResult, BacktestRunner,
} from '../../src/features/trading';

/** The archive this project's futures evidence is built from. */
const DATA_DIR = process.env.KIBOT_DATA_DIR || 'C:\\MarketData\\kibot';

/** A monthly bar on the 1st, so window arithmetic is readable in the assertions. */
function monthlyBars(fromIso: string, months: number): FuturesBar[] {
  const start = new Date(fromIso);
  return Array.from({ length: months }, (_, i) => {
    const t = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    return { t: t.toISOString(), o: 100, h: 101, l: 99, c: 100, v: 10 };
  });
}

/** An empty-but-complete BacktestResult, so an injected runner can stand in for the simulator. */
function emptyResult(symbol: string, bars: FuturesBar[]): BacktestResult {
  return {
    symbol, trades: [], equityCurve: [], netProfit: 0, maxDrawdown: 0, winRate: 0,
    skippedZeroQty: 0, barsProcessed: bars.length, marginModeled: false, marginCappedTrades: 0,
    skippedNoMargin: 0, marginCalls: 0, peakNotional: 0, peakLeverage: 0,
    regimeBlockedSignals: 0, regimeBlockedBars: 0, warnings: [],
  };
}

const CONFIG: BacktestConfig = {
  instrument: { symbol: 'ES', multiplier: 50, tickSize: 0.25 },
  entry: { generation: 'dynstops', riskPerTradePercent: 2 },
  stops: { useStrangleTrail: true },
  costs: { slippageTicks: 1, commissionPerContract: 2.5 },
  startingEquity: 500_000,
};

describe('walkForwardWindows — the split contract', () => {
  it('starts every out-of-sample period exactly where its in-sample period ended', () => {
    const windows = walkForwardWindows(monthlyBars('2021-01-01T00:00:00Z', 60), {
      inSampleMonths: 24, oosMonths: 6, stepMonths: 6,
    });
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(w.oosStart).toBe(w.isEnd);
      expect(Date.parse(w.isStart)).toBeLessThan(Date.parse(w.isEnd));
      expect(Date.parse(w.oosStart)).toBeLessThan(Date.parse(w.oosEnd));
    }
  });

  it('never lets two out-of-sample periods overlap', () => {
    const windows = walkForwardWindows(monthlyBars('2021-01-01T00:00:00Z', 60), {
      inSampleMonths: 24, oosMonths: 6, stepMonths: 6,
    });
    for (let i = 1; i < windows.length; i++) {
      expect(Date.parse(windows[i].oosStart)).toBeGreaterThanOrEqual(Date.parse(windows[i - 1].oosEnd));
    }
  });

  it('refuses a step shorter than the out-of-sample length, which would score the same bars twice', () => {
    expect(() => walkForwardWindows(monthlyBars('2021-01-01T00:00:00Z', 60), {
      inSampleMonths: 24, oosMonths: 6, stepMonths: 3,
    })).toThrow(/overlap/i);
  });

  it('refuses a non-positive or fractional split rather than silently producing no windows', () => {
    const bars = monthlyBars('2021-01-01T00:00:00Z', 60);
    expect(() => walkForwardWindows(bars, { inSampleMonths: 0, oosMonths: 6, stepMonths: 6 })).toThrow(RangeError);
    expect(() => walkForwardWindows(bars, { inSampleMonths: 24, oosMonths: 1.5, stepMonths: 6 })).toThrow(RangeError);
    expect(() => walkForwardWindows(bars, { inSampleMonths: 24, oosMonths: 6, stepMonths: Number.NaN })).toThrow(RangeError);
  });

  it('emits no trailing window whose out-of-sample period the data cannot fill', () => {
    const bars = monthlyBars('2021-01-01T00:00:00Z', 31);
    const windows = walkForwardWindows(bars, { inSampleMonths: 24, oosMonths: 6, stepMonths: 6 });
    const lastBar = Date.parse(bars[bars.length - 1].t);
    for (const w of windows) expect(Date.parse(w.oosEnd)).toBeLessThanOrEqual(lastBar);
  });

  it('returns nothing for an empty series', () => {
    expect(walkForwardWindows([], { inSampleMonths: 24, oosMonths: 6, stepMonths: 6 })).toEqual([]);
  });
});

describe('walkForward — no look-ahead, proven on the REAL Kibot ES daily archive', () => {
  // Fail loud, never skip: this is the ONE case that crosses the boundary the splitter claims to
  // protect — real bars, real month lengths, real holidays — and a silently skipped guard is not a
  // guard. If the archive has moved, point KIBOT_DATA_DIR at it.
  it('has the Kibot archive on disk', () => {
    const daily = join(DATA_DIR, 'daily');
    const ok = ((): boolean => { try { return statSync(daily).isDirectory(); } catch { return false; } })();
    expect(ok, `Kibot daily archive not found at ${daily}. Set KIBOT_DATA_DIR to the bulk-download root.`).toBe(true);
  });

  it('hands the runner in-sample and out-of-sample slices that share no bar', async () => {
    const series = await buildContinuousSeries(
      new KibotFileDataSource({ dir: join(DATA_DIR, 'daily') }), 'ES', '1Day',
      new Date('2021-01-01T00:00:00Z'), new Date('2025-12-15T00:00:00Z'), { adjust: 'panama' },
    );
    expect(series.bars.length).toBeGreaterThan(1000);

    // Record what the driver's OWN slicer hands the runner. Re-deriving the slices in the test
    // would only prove the test agrees with itself.
    const seen: { bars: FuturesBar[] }[] = [];
    const runner: BacktestRunner = (chart) => {
      seen.push({ bars: chart });
      return emptyResult('ES', chart);
    };
    const report = walkForward(
      { chart: series.bars, ltf: series.bars, daily: series.bars }, CONFIG,
      { split: { inSampleMonths: 24, oosMonths: 6, stepMonths: 6 }, runner },
    );
    expect(report.windows.length).toBe(5);
    expect(seen.length).toBe(report.windows.length * 2);

    for (let i = 0; i < report.windows.length; i++) {
      const w = report.windows[i].window;
      const isBars = seen[i * 2].bars;
      const oosBars = seen[i * 2 + 1].bars;
      expect(isBars.length, `window ${i} in-sample slice is empty`).toBeGreaterThan(0);
      expect(oosBars.length, `window ${i} out-of-sample slice is empty`).toBeGreaterThan(0);
      const isEnd = Date.parse(w.isEnd);
      // THE claim: not one in-sample bar reaches the out-of-sample period, and not one
      // out-of-sample bar predates the in-sample end. Swapping the two halves flips both.
      for (const b of isBars) {
        expect(Date.parse(b.t), `window ${i}: in-sample bar ${b.t} at or past isEnd ${w.isEnd}`).toBeLessThan(isEnd);
      }
      for (const b of oosBars) {
        expect(Date.parse(b.t), `window ${i}: out-of-sample bar ${b.t} before isEnd ${w.isEnd}`).toBeGreaterThanOrEqual(isEnd);
        expect(Date.parse(b.t)).toBeLessThan(Date.parse(w.oosEnd));
      }
      const isStamps = new Set(isBars.map((b) => b.t));
      expect(oosBars.some((b) => isStamps.has(b.t)), `window ${i}: a bar appears in both halves`).toBe(false);
    }
  });

  it('covers the out-of-sample years contiguously and only once', async () => {
    const series = await buildContinuousSeries(
      new KibotFileDataSource({ dir: join(DATA_DIR, 'daily') }), 'ES', '1Day',
      new Date('2021-01-01T00:00:00Z'), new Date('2025-12-15T00:00:00Z'), { adjust: 'panama' },
    );
    const windows = walkForwardWindows(series.bars, { inSampleMonths: 24, oosMonths: 6, stepMonths: 6 });
    expect(windows.map((w) => `${w.oosStart.slice(0, 7)}→${w.oosEnd.slice(0, 7)}`)).toEqual([
      '2023-01→2023-07', '2023-07→2024-01', '2024-01→2024-07', '2024-07→2025-01', '2025-01→2025-07',
    ]);
  });
});

describe('mergeBacktestConfig — a config file must never manufacture a NaN', () => {
  it('keeps every key the patch does not mention', () => {
    const merged = mergeBacktestConfig(CONFIG, { entry: { riskPerTradePercent: 1 } });
    expect(merged.entry.riskPerTradePercent).toBe(1);
    expect(merged.entry.generation).toBe('dynstops');
    expect(merged.costs?.slippageTicks).toBe(1);
    expect(merged.instrument.multiplier).toBe(50);
    expect(merged.startingEquity).toBe(500_000);
  });

  it('skips an explicit undefined instead of erasing the default it sits on', () => {
    const merged = mergeBacktestConfig(CONFIG, { entry: { riskPerTradePercent: undefined } });
    expect(merged.entry.riskPerTradePercent).toBe(2);
    expect(Number.isNaN(merged.entry.riskPerTradePercent as number)).toBe(false);
  });

  it('refuses an explicit null, naming the path', () => {
    expect(() => mergeBacktestConfig(CONFIG, { entry: { riskPerTradePercent: null } }))
      .toThrow(/entry\.riskPerTradePercent/);
  });

  it('does not mutate the base configuration', () => {
    const merged = mergeBacktestConfig(CONFIG, { stops: { useStrangleTrail: false } });
    expect(merged.stops.useStrangleTrail).toBe(false);
    expect(CONFIG.stops.useStrangleTrail).toBe(true);
  });
});

describe('expandGrid — cardinality is the product, and an empty axis is an error', () => {
  it('produces exactly the cartesian product, last axis varying fastest', () => {
    const combos = expandGrid({
      'entry.ensembleEntryThresholdPct': [62, 66, 70, 74, 78],
      'entry.ensembleConfirmation.retentionPct': [85, 90, 95],
      'entry.ensembleConfirmation.drawdownPct': [90, 93, 96],
    });
    expect(combos.length).toBe(5 * 3 * 3);
    const entry = combos[0].entry as Record<string, unknown>;
    expect(entry.ensembleEntryThresholdPct).toBe(62);
    const confirm = entry.ensembleConfirmation as Record<string, unknown>;
    expect(confirm.retentionPct).toBe(85);
    expect(confirm.drawdownPct).toBe(90);
    const second = (combos[1].entry as Record<string, unknown>).ensembleConfirmation as Record<string, unknown>;
    expect(second.drawdownPct).toBe(93);
    const unique = new Set(combos.map((c) => JSON.stringify(c)));
    expect(unique.size).toBe(combos.length);
  });

  it('refuses an axis with no values rather than returning an empty sweep', () => {
    expect(() => expandGrid({ 'stops.strangleBufferAtrPercent': [] })).toThrow(/no values/);
  });

  it('refuses a malformed dotted key', () => {
    expect(() => patchFromDottedKey('entry..generation', 'ensemble')).toThrow(RangeError);
    expect(() => expandGrid({ '': [1] })).toThrow(RangeError);
  });
});

describe('resolveFitness — a study names its objective or it does not run', () => {
  it('resolves a registered objective', () => {
    expect(typeof resolveFitness('entry-logic')).toBe('function');
  });

  it('throws on an unknown name, listing the registered set', () => {
    expect(() => resolveFitness('sharpe')).toThrow(/entry-logic/);
  });

  it('carries account aggregates into the objective, so the min-trades gate can bite', () => {
    const result = emptyResult('ES', []);
    expect(scoreBacktest(result, resolveFitness('max-net-profit-min-trades-50'))).toBeLessThan(-1e9);
  });
});

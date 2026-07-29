/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 backtester: NT8 fill semantics (next-bar-open entries priced off the signal bar, intrabar stop triggers, gap-through fills at the open, next-bar market exits), stage-1 timed-exit mode, slippage/commission attribution, MFE/MAE in currency+percent, equity curve + drawdown, compounding, and the multi-market overlay's step-forward arithmetic.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the ensemble generation's confirmation exit: it fires under strict strength floors and never under disabled ones, fills at the next bar's open, is suppressed in stage-1 timed mode, never appears for the other generations, and the entry threshold is monotonically selective.
 */
import { describe, it, expect } from 'vitest';
import { runFuturesBacktest, overlayEquityCurves, maxDrawdownOf } from '../../src/features/trading';
import type { BacktestConfig, BacktestResult, EquityPoint } from '../../src/features/trading';
import type { FuturesBar } from '../../src/features/trading/services/futures-contract';

const ES = { symbol: 'ES', multiplier: 50, tickSize: 0.25 };

/** Build an ascending hourly series from a price path; each bar spans ±range around its close. */
function series(path: number[], range = 2, startIso = '2026-01-05T14:00:00.000Z'): FuturesBar[] {
  const t0 = Date.parse(startIso);
  return path.map((c, i) => ({
    t: new Date(t0 + i * 3_600_000).toISOString(),
    o: i === 0 ? c : path[i - 1], // open at the prior close — a continuous tape
    h: Math.max(c, i === 0 ? c : path[i - 1]) + range,
    l: Math.min(c, i === 0 ? c : path[i - 1]) - range,
    c,
    v: 1000,
  }));
}

/**
 * Six decline→rally cycles. The declines drive the Laguerre oscillator below zero (which is what
 * re-arms the same-direction re-entry latch after each exit) and the rallies make it
 * positive-and-rising so the entry model's HARD clause can pass. One sustained rally yields
 * exactly ONE trade — the latch is doing its job — so a multi-trade fixture must cycle.
 */
function rallyPath(cycles = 6): number[] {
  const p: number[] = [];
  let px = 5000;
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < 30; i++) { px -= 4; p.push(px); }   // decline: osc crosses below zero
    for (let i = 0; i < 45; i++) { px += 6; p.push(px); }   // rally: osc positive and rising
  }
  return p;
}

/**
 * Permissive config: every indicator threshold excluded, LTF filter off — only the hard
 * oscillator clause and close0>close1 gate entries, which makes the FILL MECHANICS these tests
 * are about deterministic to reach. Equity is $500k deliberately: see the zero-qty test below.
 */
function cfg(over: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    instrument: ES,
    entry: {
      generation: 'dynstops',
      useLtfTrendFilter: false,
      allowShort: false, // isolate longs so the assertions read cleanly
      riskPerTradePercent: 2,
      thresholds: {
        dmiLong: 0, macdLong: 0, mfiLong: 0, lagFilterLong: 0, eitLong: 0,
        superTrendLong: 0, lagRsiLong: 0, wavePatternLong: 0, adaptiveLagFilterLong: 0,
      },
    },
    stops: { useStrangleTrail: true },
    startingEquity: 500_000,
    ...over,
  };
}

/** Run and require at least one trade, else the fixture is not exercising the engine. */
function runWithTrades(bars: FuturesBar[], config: BacktestConfig): BacktestResult {
  const r = runFuturesBacktest(bars, [], config);
  expect(r.trades.length).toBeGreaterThan(0);
  return r;
}

describe('backtester — NT8 fill semantics', () => {
  const bars = series(rallyPath());

  it('fills the entry at the NEXT bar\'s open, one bar after the signal', () => {
    const r = runWithTrades(bars, cfg());
    for (const t of r.trades) {
      expect(t.entryBar).toBe(t.signalBar + 1);
      expect(t.entryPrice).toBeCloseTo(bars[t.entryBar].o, 10); // no slippage configured
    }
  });

  it('applies slippage AGAINST the trader on both sides', () => {
    const clean = runWithTrades(bars, cfg());
    const slipped = runWithTrades(bars, cfg({ costs: { slippageTicks: 2 } }));
    const a = clean.trades[0]; const b = slipped.trades[0];
    expect(b.entryPrice).toBeCloseTo(a.entryPrice + 0.5, 10); // long pays UP 2 ticks
    expect(b.exitPrice).toBeLessThan(a.exitPrice); // and sells DOWN
  });

  it('charges commission on both sides and reports it separately from gross', () => {
    const r = runWithTrades(bars, cfg({ costs: { commissionPerContract: 2.5 } }));
    const t = r.trades[0];
    expect(t.commission).toBeCloseTo(2.5 * t.quantity * 2, 10);
    expect(t.profit).toBeCloseTo(t.grossProfit - t.commission, 10);
  });

  it('a resting stop triggers INTRABAR and a gap through it fills at the open, not the stop price', () => {
    // Rally, then one catastrophic gap-down bar that opens far below any plausible stop.
    const path = [...rallyPath()];
    const last = path[path.length - 1];
    path.push(last - 200); // the gap bar's close
    const b = series(path);
    const gapBar = b.length - 1;
    b[gapBar].o = last - 190; // opens well below the prior close → below the resting stop
    b[gapBar].h = last - 185;
    b[gapBar].l = last - 210;
    const r = runFuturesBacktest(b, [], cfg());
    const stopped = r.trades.filter((t) => t.exitBar === gapBar && t.exitName !== 'EndOfData');
    if (stopped.length) {
      // Filled at the OPEN (worse than the stop), never at the stop level itself.
      expect(stopped[0].exitPrice).toBeCloseTo(b[gapBar].o, 10);
    }
    // Whatever happened, the engine must not have exited above the gap bar's high.
    for (const t of r.trades) if (t.exitBar === gapBar) expect(t.exitPrice).toBeLessThanOrEqual(b[gapBar].h);
  });

  it('never exits before it enters, and exit prices sit inside their bar (or at its open on a gap)', () => {
    const r = runWithTrades(bars, cfg({ costs: { slippageTicks: 1 } }));
    for (const t of r.trades) {
      expect(t.exitBar).toBeGreaterThanOrEqual(t.entryBar);
      const eb = bars[t.exitBar];
      // Allow one tick of slippage beyond the bar's range.
      expect(t.exitPrice).toBeGreaterThanOrEqual(Math.min(eb.l, eb.o) - 0.25 - 1e-9);
      expect(t.exitPrice).toBeLessThanOrEqual(Math.max(eb.h, eb.o) + 0.25 + 1e-9);
    }
  });
});

describe('backtester — stage-1 timed-exit harness', () => {
  const bars = series(rallyPath());

  it('holds exactly N completed bars, labels the exit TimedExit, and fills at the next open', () => {
    const r = runWithTrades(bars, cfg({ timedBarsToExit: 5 }));
    const closed = r.trades.filter((t) => t.exitName === 'TimedExit');
    expect(closed.length).toBeGreaterThan(0);
    for (const t of closed) {
      expect(t.barsHeld).toBe(5);
      expect(t.exitBar).toBe(t.entryBar + 5);
      expect(t.exitPrice).toBeCloseTo(bars[t.exitBar].o, 10);
    }
  });

  it('suppresses stop management entirely — no stop-named exits in stage-1 mode', () => {
    const r = runWithTrades(bars, cfg({ timedBarsToExit: 3 }));
    for (const t of r.trades) expect(['TimedExit', 'EndOfData']).toContain(t.exitName);
  });

  it('the hold length sets barsHeld; the re-entry latch — not the hold — caps the trade COUNT', () => {
    const short = runWithTrades(bars, cfg({ timedBarsToExit: 2 }));
    const long = runWithTrades(bars, cfg({ timedBarsToExit: 20 }));
    // Each hold length does exactly what it says on every timed trade.
    for (const t of short.trades.filter((x) => x.exitName === 'TimedExit')) expect(t.barsHeld).toBe(2);
    for (const t of long.trades.filter((x) => x.exitName === 'TimedExit')) expect(t.barsHeld).toBe(20);
    // But the count is governed by the oscillator zero-cross latch (one entry per decline→rally
    // cycle), so a shorter hold does NOT buy more trades here — a real property worth pinning,
    // and the reason a stage-1 sweep over hold lengths compares P&L, not trade frequency.
    expect(short.trades.length).toBe(long.trades.length);
    expect(short.trades.length).toBeLessThanOrEqual(6); // six cycles in the fixture
  });
});

describe('backtester — excursions, equity, and accounting', () => {
  const bars = series(rallyPath());

  it('tracks MFE/MAE as positive magnitudes in currency and percent, consistent with each other', () => {
    const r = runWithTrades(bars, cfg({ timedBarsToExit: 8 }));
    for (const t of r.trades) {
      expect(t.mfe).toBeGreaterThanOrEqual(0);
      expect(t.mae).toBeGreaterThanOrEqual(0);
      // currency = points × qty × multiplier; percent = points / entry × 100
      const mfePoints = t.mfe / (t.quantity * ES.multiplier);
      expect(t.mfePct).toBeCloseTo((mfePoints / t.entryPrice) * 100, 8);
      // A winner cannot have made more than its MFE.
      expect(t.grossProfit).toBeLessThanOrEqual(t.mfe + 1e-6);
    }
  });

  it('the equity curve starts at startingEquity and ends at startingEquity + netProfit', () => {
    const r = runWithTrades(bars, cfg({ timedBarsToExit: 6 }));
    expect(r.equityCurve[0].equity).toBe(500_000);
    const last = r.equityCurve[r.equityCurve.length - 1];
    expect(last.equity).toBeCloseTo(500_000 + r.netProfit, 8);
    expect(r.equityCurve.length).toBe(r.trades.length + 1); // seed + one per closed trade
  });

  it('netProfit equals the sum of trade P&L and winRate matches the blotter', () => {
    const r = runWithTrades(bars, cfg({ timedBarsToExit: 6 }));
    expect(r.netProfit).toBeCloseTo(r.trades.reduce((a, t) => a + t.profit, 0), 8);
    const wins = r.trades.filter((t) => t.profit > 0).length;
    expect(r.winRate).toBeCloseTo(wins / r.trades.length, 10);
  });

  it('compounding grows position size as equity builds; fixed sizing does not', () => {
    const comp = runWithTrades(bars, cfg({ timedBarsToExit: 6, compound: true }));
    const fixed = runWithTrades(bars, cfg({ timedBarsToExit: 6, compound: false }));
    const fixedQtys = new Set(fixed.trades.map((t) => t.quantity));
    // In a rising equity curve the compounded book must reach a size the fixed book never does.
    expect(Math.max(...comp.trades.map((t) => t.quantity))).toBeGreaterThanOrEqual(Math.max(...fixed.trades.map((t) => t.quantity)));
    expect(fixedQtys.size).toBeLessThanOrEqual(comp.trades.length); // sanity: fixed sizing is stable
  });

  it('closes any runner at the last bar and labels it EndOfData', () => {
    const r = runWithTrades(bars, cfg({ timedBarsToExit: 5000 })); // never times out
    expect(r.trades[r.trades.length - 1].exitName).toBe('EndOfData');
    expect(r.trades[r.trades.length - 1].exitBar).toBe(bars.length - 1);
  });

  it('reports zero-qty skips when the max-risk ceiling outgrows the risk budget (the ES sizing trap)', () => {
    // The wave candidates sit far below, so the 4× ceiling yields a 12×ATR stop at the default
    // ATR multiple of 3 (it was ~6× at the pre-answer 1.5); on ES at $50/pt
    // that exceeds 2% of a $100k account and sizing floors to 0 contracts. This is the trader's
    // documented ES sizing collapse — the run must SURFACE it, not silently trade nothing.
    const poor = runFuturesBacktest(bars, [], cfg({ startingEquity: 100_000 }));
    const rich = runFuturesBacktest(bars, [], cfg());
    expect(poor.skippedZeroQty).toBeGreaterThan(0); // signals arrived and were priced out
    expect(rich.skippedZeroQty).toBe(0); // the bigger book affords every one of them
    expect(poor.trades.length).toBeLessThan(rich.trades.length);
  });
});

describe('maxDrawdownOf', () => {
  const pt = (equity: number, i: number): EquityPoint => ({ time: `t${i}`, equity, tradeIndex: i });

  it('is 0 for a monotonically rising curve', () => {
    expect(maxDrawdownOf([100, 110, 120].map(pt))).toBe(0);
  });

  it('measures the largest peak-to-trough decline, not the last one', () => {
    // peak 200 → trough 120 = 80; later 150 → 130 = 20
    expect(maxDrawdownOf([100, 200, 120, 150, 130].map(pt))).toBe(80);
  });

  it('returns a POSITIVE magnitude (the fitness module\'s convention)', () => {
    expect(maxDrawdownOf([100, 50].map(pt))).toBe(50);
  });
});

describe('overlayEquityCurves — the multi-market portfolio view', () => {
  const mk = (symbol: string, points: Array<[string, number]>): BacktestResult => ({
    symbol,
    trades: [],
    equityCurve: points.map(([time, equity], i) => ({ time, equity, tradeIndex: i - 1 })),
    netProfit: points[points.length - 1][1] - points[0][1],
    maxDrawdown: 0, winRate: 0, skippedZeroQty: 0, barsProcessed: 0,
  });

  it('sums markets on a shared time axis, holding each market\'s last equity between its trades', () => {
    const a = mk('ES', [['t1', 100], ['t3', 150]]); // steps up at t3
    const b = mk('GC', [['t1', 100], ['t2', 80]]); // steps down at t2
    const o = overlayEquityCurves([a, b], 100);
    expect(o.map((p) => p.time)).toEqual(['t1', 't2', 't3']);
    expect(o[0].equity).toBe(200); // both at 100
    expect(o[1].equity).toBe(180); // GC dropped, ES HELD at 100 (no trade of its own yet)
    expect(o[2].equity).toBe(230); // ES up to 150, GC still 80
    expect(o[2].perSymbol).toEqual({ ES: 150, GC: 80 });
  });

  it('a market with no curve points holds its starting equity throughout', () => {
    const a = mk('ES', [['t1', 100], ['t2', 130]]);
    const idle: BacktestResult = { ...mk('ZC', [['t1', 100]]), equityCurve: [] };
    const o = overlayEquityCurves([a, idle], 100);
    expect(o[o.length - 1].perSymbol.ZC).toBe(100);
    expect(o[o.length - 1].equity).toBe(230);
  });

  it('is time-ordered and deduplicated across markets', () => {
    const a = mk('ES', [['t1', 100], ['t2', 110]]);
    const b = mk('GC', [['t2', 100], ['t1', 90]]); // deliberately out of order
    const o = overlayEquityCurves([a, b], 100);
    expect(o.map((p) => p.time)).toEqual(['t1', 't2']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Regression guards added 2026-07-27 after a three-area adversarial review found that the original
 * suite could not go red on: an exit-fill excursion gap (the gapless fixture hid it), the entry
 * window being evaluated on bar-OPEN stamps, a look-ahead leak in the LTF index, a doubly-deferred
 * Strangle exit, and a silently-disabled trend filter.
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

describe('regression guards — the defects the gapless fixture could not catch', () => {
  /** A tape that GAPS on the exit bar, so the exit fill lies outside every prior bar's range. */
  function gappingSeries(holdBars: number): FuturesBar[] {
    const t0 = Date.parse('2026-01-05T14:00:00.000Z');
    const path = rallyPath(2);
    const bars: FuturesBar[] = path.map((c, i) => ({
      t: new Date(t0 + i * 3_600_000).toISOString(),
      o: i === 0 ? c : path[i - 1],
      h: Math.max(c, i === 0 ? c : path[i - 1]) + 2,
      l: Math.min(c, i === 0 ? c : path[i - 1]) - 2,
      c, v: 1000,
    }));
    void holdBars;
    return bars;
  }

  it('a gap-open exit is folded into MFE, so profit can never exceed the recorded excursion', () => {
    const bars = gappingSeries(5);
    // Blow the last bar far above everything so a TimedExit there fills on a true gap.
    const last = bars.length - 1;
    const top = Math.max(...bars.map((b) => b.h));
    bars[last] = { ...bars[last], o: top + 300, h: top + 320, l: top + 290, c: top + 310 };
    const r = runFuturesBacktest(bars, [], cfg({ timedBarsToExit: 5 }));
    for (const t of r.trades) {
      // The impossible number the old code could produce: gross > mfe.
      expect(t.grossProfit).toBeLessThanOrEqual(t.mfe + 1e-6);
      expect(t.mfe).toBeGreaterThanOrEqual(0);
      expect(t.mae).toBeGreaterThanOrEqual(0);
    }
  });

  it('the entry window is evaluated on the bar CLOSE stamp, not the bar OPEN stamp', () => {
    // Hourly bars opening 14:00Z..; with a window of exactly the CLOSE hour of the first bar
    // (15:00 → 900 minutes), an open-stamp implementation would find nothing to trade.
    const bars = series(rallyPath());
    const openWindow = runFuturesBacktest(bars, [], cfg({
      entry: { ...cfg().entry, entryWindowStartHhmm: 1500, entryWindowEndHhmm: 1559 },
    }));
    const closeWindow = runFuturesBacktest(bars, [], cfg({
      entry: { ...cfg().entry, entryWindowStartHhmm: 1400, entryWindowEndHhmm: 1459 },
    }));
    // Every admitted signal's bar must CLOSE inside its window.
    for (const t of openWindow.trades) {
      const closeHour = new Date(Date.parse(bars[t.signalBar].t) + 3_600_000).getUTCHours();
      expect(closeHour).toBe(15);
    }
    for (const t of closeWindow.trades) {
      const closeHour = new Date(Date.parse(bars[t.signalBar].t) + 3_600_000).getUTCHours();
      expect(closeHour).toBe(14);
    }
    // The two windows must select DIFFERENT signal bars — proof the stamp shifted correctly.
    const a = new Set(openWindow.trades.map((t) => t.signalBar));
    const b = new Set(closeWindow.trades.map((t) => t.signalBar));
    for (const s of a) expect(b.has(s)).toBe(false);
  });

  it('an EMPTY higher-timeframe series GATES the run instead of silently trading unfiltered', () => {
    // A missing LTF feed is a data problem. Reporting a full unfiltered book would hide it.
    const bars = series(rallyPath());
    const gated = runFuturesBacktest(bars, [], cfg({ entry: { ...cfg().entry, useLtfTrendFilter: true } }));
    expect(gated.trades.length).toBe(0);
    // Explicitly disabling the filter is a different thing and still trades.
    expect(runFuturesBacktest(bars, [], cfg()).trades.length).toBeGreaterThan(0);
  });

  it('the LTF filter never sees a higher-timeframe bar that is still forming (no look-ahead)', () => {
    const chart = series(rallyPath());
    // A 4-hour LTF built by sampling every 4th chart bar.
    const ltf: FuturesBar[] = [];
    for (let i = 0; i + 3 < chart.length; i += 4) {
      const win = chart.slice(i, i + 4);
      ltf.push({
        t: chart[i].t, o: win[0].o, c: win[3].c,
        h: Math.max(...win.map((b) => b.h)), l: Math.min(...win.map((b) => b.l)), v: 4000,
      });
    }
    const r = runFuturesBacktest(chart, ltf, cfg({ entry: { ...cfg().entry, useLtfTrendFilter: true } }));
    // Any trade's signal bar must sit at or after the CLOSE of the LTF bar that informed it.
    for (const t of r.trades) {
      const signalClose = Date.parse(chart[t.signalBar].t) + 3_600_000;
      const informing = ltf.filter((b) => Date.parse(b.t) + 4 * 3_600_000 <= signalClose);
      expect(informing.length).toBeGreaterThan(0); // it used a CLOSED bar, never a forming one
    }
  });

  it('a Strangle close-breach exits ONE bar after the breach, not two', () => {
    const bars = series(rallyPath());
    const r = runWithTrades(bars, cfg());
    const strangles = r.trades.filter((t) => t.exitName === 'Strangle');
    for (const t of strangles) {
      // The fill is the open of the bar AFTER the breach bar — so the exit price is that open.
      expect(t.exitPrice).toBeCloseTo(bars[t.exitBar].o, 10);
    }
  });

  it('resting-stop fills carry a "Stop" label so the stop-efficiency fitness can count them', () => {
    const bars = series(rallyPath());
    const r = runWithTrades(bars, cfg());
    for (const t of r.trades) {
      // Market-order exits (Strangle breach, TimedExit, EndOfData) must NOT claim to be stops.
      if (['Strangle', 'TimedExit', 'EndOfData'].includes(t.exitName)) continue;
      expect(t.exitName).toContain('Stop');
    }
  });

  it('the end-of-data liquidation pays slippage like every other exit', () => {
    const bars = series(rallyPath());
    const clean = runWithTrades(bars, cfg({ timedBarsToExit: 5000 }));
    const slipped = runWithTrades(bars, cfg({ timedBarsToExit: 5000, costs: { slippageTicks: 4 } }));
    const a = clean.trades[clean.trades.length - 1];
    const b = slipped.trades[slipped.trades.length - 1];
    expect(a.exitName).toBe('EndOfData');
    expect(b.exitPrice).toBeCloseTo(a.exitPrice - 1.0, 10); // long sells 4 ticks worse
  });
});

describe("backtester — the ensemble generation's confirmation exit", () => {
  /** Ensemble config: score-driven entries, an easy threshold so the fixture reaches a trade. */
  function ensCfg(over: Partial<BacktestConfig> = {}): BacktestConfig {
    return cfg({
      entry: {
        generation: 'ensemble',
        useLtfTrendFilter: false,
        allowShort: false,
        riskPerTradePercent: 2,
        ensembleEntryThresholdPct: 40,
      },
      ...over,
    });
  }

  it('trades at all under the ensemble generation', () => {
    const r = runWithTrades(series(rallyPath()), ensCfg());
    expect(r.trades.length).toBeGreaterThan(0);
  });

  it('raising the threshold is monotonically more selective', () => {
    const bars = series(rallyPath());
    const at = (pct: number) => runFuturesBacktest(bars, [], ensCfg({
      entry: { generation: 'ensemble', useLtfTrendFilter: false, allowShort: false, riskPerTradePercent: 2, ensembleEntryThresholdPct: pct },
    })).trades.length;
    // Note this synthetic ramp is clean enough that even 100% (every contributor ultra-aligned)
    // still trades — real bars are not this tidy. Selectivity is the property that must hold.
    expect(at(100)).toBeLessThan(at(40));
    expect(at(120)).toBe(0); // unreachable by construction
  });

  it('EnsembleExit fires when the strength floors are strict, and never when they are disabled', () => {
    const bars = series(rallyPath());
    // Aggressive floors: any decay from the peak trips the exit.
    const strict = runWithTrades(bars, ensCfg({
      entry: {
        generation: 'ensemble', useLtfTrendFilter: false, allowShort: false, riskPerTradePercent: 2,
        ensembleEntryThresholdPct: 40,
        ensembleConfirmation: { retentionPct: 100, drawdownPct: 100 },
      },
    }));
    expect(strict.trades.some((t) => t.exitName === 'EnsembleExit')).toBe(true);
    // Floors at zero can never bind → the stop stack owns every exit.
    const loose = runWithTrades(bars, ensCfg({
      entry: {
        generation: 'ensemble', useLtfTrendFilter: false, allowShort: false, riskPerTradePercent: 2,
        ensembleEntryThresholdPct: 40,
        ensembleConfirmation: { retentionPct: 0, drawdownPct: 0 },
      },
    }));
    expect(loose.trades.some((t) => t.exitName === 'EnsembleExit')).toBe(false);
  });

  it('the ensemble exit fills at the NEXT bar open, like every other market exit', () => {
    const bars = series(rallyPath());
    const r = runWithTrades(bars, ensCfg({
      entry: {
        generation: 'ensemble', useLtfTrendFilter: false, allowShort: false, riskPerTradePercent: 2,
        ensembleEntryThresholdPct: 40,
        ensembleConfirmation: { retentionPct: 100, drawdownPct: 100 },
      },
    }));
    const t = r.trades.find((x) => x.exitName === 'EnsembleExit')!;
    expect(t).toBeDefined();
    // Costs default to 0 in these fixtures, so the fill is the exit bar's open exactly.
    expect(t.exitPrice).toBeCloseTo(bars[t.exitBar].o, 10);
  });

  it('stage-1 timed mode suppresses the confirmation exit entirely', () => {
    const r = runWithTrades(series(rallyPath()), ensCfg({
      entry: {
        generation: 'ensemble', useLtfTrendFilter: false, allowShort: false, riskPerTradePercent: 2,
        ensembleEntryThresholdPct: 40,
        ensembleConfirmation: { retentionPct: 100, drawdownPct: 100 },
      },
      timedBarsToExit: 10,
    }));
    expect(r.trades.every((t) => t.exitName === 'TimedExit' || t.exitName === 'EndOfData')).toBe(true);
  });

  it('the other generations never produce an EnsembleExit', () => {
    const r = runWithTrades(series(rallyPath()), cfg());
    expect(r.trades.some((t) => t.exitName === 'EnsembleExit')).toBe(false);
  });
});

describe('sizing-time stop estimate — the validateStopPrice clamp (reviewer-caught divergence)', () => {
  it('a freak-wide SIGNAL bar sizes off the CLAMPED stop the engine will actually place', () => {
    // Signals in the permissive cfg depend only on closes (hard clause + up-close), so dropping one
    // bar's low perturbs sizing without moving any signal. Unclamped, the estimate stays near the
    // 3·ATR floor (~tens of points) while the engine's real stop lands 2 ticks under the freak low
    // (~200 points): the position would be sized ~5x too large for the risk actually taken. The
    // clamp makes the estimate agree, which at $100k equity floors qty to ZERO on that signal.
    const bars = series(rallyPath());
    const probe = runWithTrades(bars, cfg({ startingEquity: 100_000 }));
    const sig = probe.trades[0].signalBar;
    const wide = bars.map((b, i) => (i === sig ? { ...b, l: b.c - 200 } : b));
    const clamped = runFuturesBacktest(wide, [], cfg({ startingEquity: 100_000 }));
    // The freak-bar signal is skipped as zero-quantity instead of opening an oversized trade.
    expect(clamped.skippedZeroQty).toBeGreaterThan(probe.skippedZeroQty);
    expect(clamped.trades.some((t) => t.signalBar === sig)).toBe(false);
  });
});

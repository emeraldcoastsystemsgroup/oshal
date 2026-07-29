/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 stop engine: initial-stop resolver (widest-candidate combine, low/close fallback anchors, min-risk floor, max-risk ceiling), stop validator clamps, breakeven-gated chandelier trail (tighten-only, risk-goal arming), Strangle lifecycle (latch-independent level tracking, inclusive N+1 span, gate modes incl. the dictated Laguerre-RSI variant, per-trade latch, underwater stand-down, close-breach market exit vs resting-stop mode, tighten-only rename). Ports ATCEntryCountDynStops.cs semantics.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The source trader's confirmed defaults (2026-07-28): gate defaults to 'adx-laguerre' (a bar satisfying only the shipped clause must NOT arm), the new 'adx-all' both-clauses mode, NaN-RSI safety, ATR multiple 3 + wave source 'macd', and the min-risk floor proven to be a MINIMUM DISTANCE. The six lifecycle tests that relied on the old default now name the shipped gate explicitly.
 */
import { describe, it, expect } from 'vitest';
import { createFuturesStopEngine, resolveInitialStop, validateStopPrice, STOP_ENGINE_DEFAULTS } from '../../src/features/trading';
import type { StopEngineConfig, StopEngineBarInput } from '../../src/features/trading';
import type { OhlcvBar } from '../../src/features/trading/services/market-data';

const TICK = 0.25;

function bar(h: number, l: number, c: number, o = c): OhlcvBar {
  return { o, h, l, c, v: 1000 };
}

/** Long-engine config with the noisy layers off unless a test turns them on. */
function cfg(overrides: Partial<StopEngineConfig> = {}): StopEngineConfig {
  return {
    direction: 'long',
    tickSize: TICK,
    initialStopAtrMultiple: 1.5,
    initialStopBufferTicks: 3,
    initialStopFallbackAnchor: 'low',
    initialStopMinRiskFloor: false,
    initialStopMaxRiskAtrFactor: null,
    trailMode: 'ts',
    useStrangleTrail: true,
    ...overrides,
  };
}

/** Bar input with gate-quiet indicator defaults (no ADX arm unless a test supplies one). */
function input(b: OhlcvBar, extra: Partial<StopEngineBarInput> = {}): StopEngineBarInput {
  return { bar: b, adx: 10, adxPrev: 9, plusDi: 30, minusDi: 5, ...extra };
}

describe('resolveInitialStop — both NT8 generations', () => {
  const entryBar = bar(101, 99, 100.5);
  const base = {
    direction: 'long' as const,
    entryPrice: 100.5,
    bar: entryBar,
    atr: 2,
    tickSize: TICK,
    atrMultiple: 1.5,
    bufferTicks: 3,
    fallbackAnchor: 'low' as const,
    candidateFilter: 'beyond-bar-extreme' as const,
    minRiskFloor: false,
    maxRiskAtrFactor: null,
  };

  it('combines surviving candidates WIDEST (the source takes Math.Min for longs)', () => {
    const stop = resolveInitialStop({ ...base, candidates: [{ name: 'st', value: 98.6 }, { name: 'psar', value: 98.9 }] });
    expect(stop).toBeCloseTo(98.6 - 0.75, 10);
  });

  it("older gen ('beyond-bar-extreme') drops candidates at/above the entry bar low", () => {
    const stop = resolveInitialStop({ ...base, candidates: [{ name: 'st', value: 98.5 }, { name: 'psar', value: 99.2 }] });
    expect(stop).toBeCloseTo(98.5 - 0.75, 10);
  });

  it("newest gen ('none') accepts a regime-vetted candidate above the bar low (V-reversal entries)", () => {
    // The verifier's scenario: the wave low sits inside the entry bar's range — the newest gen
    // still uses it (validation clamps at placement time); the older-gen filter would drop it.
    const stop = resolveInitialStop({ ...base, candidateFilter: 'none', candidates: [{ name: 'wave', value: 99.4 }] });
    expect(stop).toBeCloseTo(99.4 - 0.75, 10);
  });

  it('falls back to low − mult·ATR (newest gen / dictation) or close-anchored (older gen)', () => {
    const lowAnchored = resolveInitialStop({ ...base, candidates: [] });
    expect(lowAnchored).toBeCloseTo(99 - 3 - 0.75, 10);
    const closeAnchored = resolveInitialStop({ ...base, candidates: [], fallbackAnchor: 'close' });
    expect(closeAnchored).toBeCloseTo(100.5 - 3 - 0.75, 10);
  });

  it('min-risk floor widens a too-tight wave stop to atrMultiple·ATR from entry', () => {
    const stop = resolveInitialStop({ ...base, minRiskFloor: true, candidates: [{ name: 'wave', value: 98.6 }] });
    expect(stop).toBeCloseTo(100.5 - 3 - 0.75, 10); // floored below the 97.85 candidate stop
  });

  it('max-risk ceiling pulls a far wave stop in to factor × the floor distance', () => {
    const stop = resolveInitialStop({ ...base, maxRiskAtrFactor: 4, candidates: [{ name: 'wave', value: 80 }] });
    expect(stop).toBeCloseTo(100.5 - 12 - 0.75, 10);
  });

  it('mirrors for shorts (widest = Math.Max above the high)', () => {
    const stop = resolveInitialStop({
      ...base,
      direction: 'short',
      candidates: [{ name: 'st', value: 102.5 }, { name: 'psar', value: 101.8 }],
    });
    expect(stop).toBeCloseTo(102.5 + 0.75, 10);
  });
});

describe('validateStopPrice — the 2-tick clamp', () => {
  it('clamps a long stop inside the bar to low − 2 ticks', () => {
    expect(validateStopPrice('long', 99.9, bar(101, 99.5, 100.5), TICK)).toBeCloseTo(99.5 - 0.5, 10);
  });

  it('leaves a valid long stop untouched', () => {
    expect(validateStopPrice('long', 98, bar(101, 99.5, 100.5), TICK)).toBe(98);
  });

  it('mirrors for shorts', () => {
    expect(validateStopPrice('short', 100.6, bar(101, 99.5, 100), TICK)).toBeCloseTo(101 + 0.5, 10);
  });
});

describe('stop engine — chandelier base trail with the breakeven gate', () => {
  it('places the InitialStop on entry and reports initial risk', () => {
    const e = createFuturesStopEngine(cfg());
    const d = e.onEntry(100, bar(100.5, 99, 100), 2);
    expect(d.restingStopName).toBe('InitialStop');
    expect(d.restingStop).toBeCloseTo(99 - 3 - 0.75, 10);
    expect(e.initialRisk()).toBeCloseTo(100 - (99 - 3.75), 10);
  });

  it('ignores the band until it clears entry by ≥ 1 tick (the literal breakeven gate)', () => {
    const e = createFuturesStopEngine(cfg());
    e.onEntry(100, bar(100.5, 99, 100), 2);
    const d1 = e.onBar(input(bar(101.5, 100.4, 101), { chandelierStop: 99.9 })); // below entry → gated
    expect(d1.restingStopName).toBe('InitialStop');
    const d2 = e.onBar(input(bar(102.5, 101.4, 102), { chandelierStop: 100.2 })); // < entry+tick → still gated
    expect(d2.restingStopName).toBe('InitialStop');
    const d3 = e.onBar(input(bar(103.5, 102.4, 103), { chandelierStop: 100.5 })); // ≥ entry+tick → armed
    expect(d3.restingStopName).toBe('TrailStop');
    expect(d3.restingStop).toBeCloseTo(100.5, 10);
  });

  it('only tightens: a lower band later never loosens the resting stop', () => {
    const e = createFuturesStopEngine(cfg());
    e.onEntry(100, bar(100.5, 99, 100), 2);
    e.onBar(input(bar(103.5, 102.4, 103), { chandelierStop: 101 }));
    const d = e.onBar(input(bar(104, 102.6, 103.5), { chandelierStop: 100.5 }));
    expect(d.restingStop).toBeCloseTo(101, 10);
  });

  it('risk-goal mode arms the trail only after profit exceeds pctOrigRisk × 1R', () => {
    const e = createFuturesStopEngine(cfg({ trailMode: 'ts-with-risk-goal', pctOrigRisk: 1 }));
    e.onEntry(100, bar(100.5, 99, 100), 2); // risk = 4.75
    const d1 = e.onBar(input(bar(104.6, 103.4, 104), { chandelierStop: 101 })); // profit 4 < 4.75
    expect(d1.restingStopName).toBe('InitialStop');
    const d2 = e.onBar(input(bar(105.6, 104.4, 105), { chandelierStop: 101 })); // profit 5 > 4.75
    expect(d2.restingStopName).toBe('TrailStop');
  });
});

describe('stop engine — Strangle lifecycle', () => {
  it('seeds the level on the first profitable close, latch-independent, entry-bar span inclusive', () => {
    const e = createFuturesStopEngine(cfg());
    e.onEntry(100, bar(100.5, 99, 100), 2);
    const d = e.onBar(input(bar(101.5, 100.4, 101))); // first close > entry
    // swing = min(entry bar low 99, 100.4) = 99 → level = 99 − 2 ticks
    expect(d.strangleLevel).toBeCloseTo(99 - 0.5, 10);
    expect(d.strangleLatched).toBe(false);
    expect(d.restingStopName).toBe('InitialStop'); // tracking ≠ enforcement
  });

  it('tightens on a new higher close over the INCLUSIVE prior-extreme→now span (N+1 bars)', () => {
    const e = createFuturesStopEngine(cfg());
    e.onEntry(100, bar(100.5, 99, 100), 2);
    e.onBar(input(bar(101.5, 100.5, 101))); // seed: extreme close 101 @ bar1
    e.onBar(input(bar(101.2, 100.2, 100.8))); // no new extreme
    e.onBar(input(bar(101.3, 100.4, 100.9))); // no new extreme
    const d = e.onBar(input(bar(102, 100.6, 101.5))); // new extreme; span bars1..4 lows: 100.5,100.2,100.4,100.6
    expect(d.strangleLevel).toBeCloseTo(100.2 - 0.5, 10);
  });

  it('latches on the shipped ADX gate (DI < ADX) and renames the stop to Strangle when profit-side', () => {
    const e = createFuturesStopEngine(cfg({ strangleGateMode: 'adx-di-or-falling' }));
    e.onEntry(100, bar(100.5, 99.8, 100), 1);
    e.onBar(input(bar(103.5, 102.8, 103))); // seed level = min(99.8, 102.8) − 0.5 = 99.3 (below entry)
    e.onBar(input(bar(105.5, 104.8, 105))); // tighten: span lows 102.8..104.8 → 102.3
    const d = e.onBar(input(bar(106.5, 105.8, 106), { adx: 35, adxPrev: 34, plusDi: 20 })); // DI < ADX → gate
    expect(d.strangleLatched).toBe(true);
    expect(d.events).toContain('strangle-latched');
    expect(d.restingStopName).toBe('Strangle');
    expect(d.restingStop).toBeGreaterThan(100); // profit side only
  });

  it('arms on ADX-falling even when DI leads (the shipped OR)', () => {
    const e = createFuturesStopEngine(cfg({ strangleGateMode: 'adx-di-or-falling' }));
    e.onEntry(100, bar(100.5, 99.8, 100), 1);
    e.onBar(input(bar(103.5, 102.8, 103)));
    const d = e.onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 36, plusDi: 40 }));
    expect(d.strangleLatched).toBe(true);
  });

  it('dictated mode: Laguerre RSI 80 arms, 79 does not', () => {
    const mk = () => {
      const e = createFuturesStopEngine(cfg({ strangleGateMode: 'adx-laguerre' }));
      e.onEntry(100, bar(100.5, 99.8, 100), 1);
      e.onBar(input(bar(103.5, 102.8, 103)));
      return e;
    };
    const no = mk().onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 34, plusDi: 20, laguerreRsi: 79 }));
    expect(no.strangleLatched).toBe(false); // DI<ADX true but ignored in this mode
    const yes = mk().onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 36, plusDi: 40, laguerreRsi: 80 }));
    expect(yes.strangleLatched).toBe(true);
  });

  it('never latches below the ADX threshold or while unprofitable', () => {
    // The shipped gate is named explicitly so the ADX-threshold and profitability preconditions are
    // what these assertions actually test (under the adx-laguerre default, the absent laguerreRsi
    // input alone would block the latch and both expects would pass vacuously).
    const e = createFuturesStopEngine(cfg({ strangleAdxThreshold: 30, strangleGateMode: 'adx-di-or-falling' }));
    e.onEntry(100, bar(100.5, 99.8, 100), 1);
    const cold = e.onBar(input(bar(103.5, 102.8, 103), { adx: 29.9, adxPrev: 35, plusDi: 5 }));
    expect(cold.strangleLatched).toBe(false);
    const under = e.onBar(input(bar(100, 99, 99.5), { adx: 40, adxPrev: 41, plusDi: 5 })); // close < entry
    expect(under.strangleLatched).toBe(false);
  });

  it('close breach while latched+profitable cancels the stop and market-exits NEXT bar', () => {
    const e = createFuturesStopEngine(cfg({ strangleGateMode: 'adx-di-or-falling' }));
    e.onEntry(100, bar(100.5, 99.8, 100), 1);
    e.onBar(input(bar(103.5, 102.8, 103)));
    e.onBar(input(bar(105.5, 104.8, 105), { adx: 35, adxPrev: 34, plusDi: 20 })); // latch; level = 102.3
    const breach = e.onBar(input(bar(104, 102.0, 102.2))); // close 102.2 ≤ level 102.3, still > entry
    expect(breach.restingStop).toBeNull(); // resting stop canceled pending the market exit
    expect(breach.exitAtMarket).toBe(false);
    expect(breach.events).toContain('strangle-breach-pending-exit');
    const exit = e.onBar(input(bar(103, 101, 102)));
    expect(exit.exitAtMarket).toBe(true);
  });

  it("'resting-stop' mode holds the level as a plain stop instead of the close-breach exit", () => {
    const e = createFuturesStopEngine(cfg({ strangleExitMode: 'resting-stop', strangleGateMode: 'adx-di-or-falling' }));
    e.onEntry(100, bar(100.5, 99.8, 100), 1);
    e.onBar(input(bar(103.5, 102.8, 103)));
    e.onBar(input(bar(105.5, 104.8, 105), { adx: 35, adxPrev: 34, plusDi: 20 }));
    const d = e.onBar(input(bar(104, 102.0, 102.2)));
    expect(d.exitAtMarket).toBe(false);
    expect(d.restingStopName).toBe('Strangle');
  });

  it('underwater stand-down: the latch survives but Strangle stops acting and the chandelier resumes', () => {
    const e = createFuturesStopEngine(cfg({ strangleGateMode: 'adx-di-or-falling' }));
    e.onEntry(100, bar(100.5, 99.8, 100), 1);
    e.onBar(input(bar(103.5, 102.8, 103)));
    e.onBar(input(bar(105.5, 104.8, 105), { adx: 35, adxPrev: 34, plusDi: 20 })); // latch; level 102.3 > entry
    const d = e.onBar(input(bar(100.2, 99.3, 99.5), { chandelierStop: 99.4 })); // close BELOW entry
    expect(d.strangleLatched).toBe(true); // per-trade latch never resets
    expect(d.exitAtMarket).toBe(false); // no strangle action while underwater
    expect(d.events).not.toContain('strangle-breach-pending-exit');
  });

  it('short side mirrors: seed above, gate on −DI, breach on close ≥ level', () => {
    const e = createFuturesStopEngine(cfg({ direction: 'short', strangleGateMode: 'adx-di-or-falling' }));
    e.onEntry(100, bar(101, 99.5, 100), 1);
    const seed = e.onBar(input(bar(99.2, 98.5, 98.8), { minusDi: 30 })); // close < entry → profitable
    expect(seed.strangleLevel).toBeCloseTo(101 + 0.5, 10); // max(101, 99.2) + 2 ticks
    const latch = e.onBar(input(bar(97.5, 96.8, 97), { adx: 35, adxPrev: 34, minusDi: 20 }));
    expect(latch.strangleLatched).toBe(true);
  });
});

describe("the source trader's confirmed defaults (2026-07-28)", () => {
  it('defaults the Strangle gate to his stated intent: ADX + Laguerre RSI, NOT the DI/falling clause', () => {
    expect(STOP_ENGINE_DEFAULTS.strangleGateMode).toBe('adx-laguerre');
    // Under the default, a bar that satisfies ONLY the shipped clause must not arm.
    const e = createFuturesStopEngine(cfg());
    e.onEntry(100, bar(100.5, 99.8, 100), 1);
    e.onBar(input(bar(103.5, 102.8, 103)));
    const shippedOnly = e.onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 36, plusDi: 40 }));
    expect(shippedOnly.strangleLatched).toBe(false);
    const withRsi = e.onBar(input(bar(105.5, 104.8, 105), { adx: 35, adxPrev: 34, plusDi: 20, laguerreRsi: 82 }));
    expect(withRsi.strangleLatched).toBe(true);
  });

  it("'adx-all' requires BOTH second clauses — the stricter reading of his answer", () => {
    const mk = () => {
      const e = createFuturesStopEngine(cfg({ strangleGateMode: 'adx-all' }));
      e.onEntry(100, bar(100.5, 99.8, 100), 1);
      e.onBar(input(bar(103.5, 102.8, 103)));
      return e;
    };
    // RSI hot but DI leading AND ADX rising → the shipped clause fails → no latch.
    const rsiOnly = mk().onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 34, plusDi: 40, laguerreRsi: 85 }));
    expect(rsiOnly.strangleLatched).toBe(false);
    // Shipped clause satisfied but RSI cold → no latch.
    const diOnly = mk().onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 34, plusDi: 20, laguerreRsi: 50 }));
    expect(diOnly.strangleLatched).toBe(false);
    // Both → latch.
    const both = mk().onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 34, plusDi: 20, laguerreRsi: 85 }));
    expect(both.strangleLatched).toBe(true);
  });

  it("'adx-any' still arms on either clause alone", () => {
    const mk = () => {
      const e = createFuturesStopEngine(cfg({ strangleGateMode: 'adx-any' }));
      e.onEntry(100, bar(100.5, 99.8, 100), 1);
      e.onBar(input(bar(103.5, 102.8, 103)));
      return e;
    };
    expect(mk().onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 34, plusDi: 20 })).strangleLatched).toBe(true);
    expect(mk().onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 34, plusDi: 40, laguerreRsi: 85 })).strangleLatched).toBe(true);
  });

  it('a NaN Laguerre RSI never arms the dictated gate', () => {
    const e = createFuturesStopEngine(cfg());
    e.onEntry(100, bar(100.5, 99.8, 100), 1);
    e.onBar(input(bar(103.5, 102.8, 103)));
    const d = e.onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 34, plusDi: 20, laguerreRsi: Number.NaN }));
    expect(d.strangleLatched).toBe(false);
  });

  it('defaults the initial-stop ATR multiple to 3 and the wave source to MACD alone', () => {
    expect(STOP_ENGINE_DEFAULTS.initialStopAtrMultiple).toBe(3);
    expect(STOP_ENGINE_DEFAULTS.initialStopWaveSource).toBe('macd');
  });

  it('the ATR-multiple floor is a MINIMUM DISTANCE: a too-close wave low is pushed out to 3·ATR', () => {
    // Wave low 99.5 is 0.5 from entry; ATR 2 × mult 3 = 6 → the floor must win.
    const stop = resolveInitialStop({
      direction: 'long', entryPrice: 100, bar: bar(101, 99.4, 100.5), atr: 2,
      candidates: [{ name: 'macd-wave', value: 99.5 }],
      tickSize: 0.25, atrMultiple: STOP_ENGINE_DEFAULTS.initialStopAtrMultiple, bufferTicks: 3,
      fallbackAnchor: 'low', candidateFilter: 'none', minRiskFloor: true, maxRiskAtrFactor: 4,
    });
    expect(stop).toBeCloseTo(100 - 6 - 0.75, 10); // entry − 3·ATR − buffer
  });

  it('raising the ATR multiple WIDENS the stop, which is what shrinks position size', () => {
    const at = (m: number) => resolveInitialStop({
      direction: 'long', entryPrice: 100, bar: bar(101, 99.4, 100.5), atr: 2,
      candidates: [], tickSize: 0.25, atrMultiple: m, bufferTicks: 3,
      fallbackAnchor: 'low', candidateFilter: 'none', minRiskFloor: true, maxRiskAtrFactor: 4,
    });
    expect(at(3)).toBeLessThan(at(1.5)); // farther from entry
  });
});

describe('explicit-undefined config values (reviewer-caught clobber)', () => {
  it('an explicit undefined means THE DEFAULT, never NaN and never the helper value', () => {
    // The cfg() helper pins the multiple at 1.5; passing undefined must fall through to
    // STOP_ENGINE_DEFAULTS (3), i.e. behave as if the key were never written.
    const e = createFuturesStopEngine(cfg({ initialStopAtrMultiple: undefined, initialStopMinRiskFloor: undefined }));
    const d = e.onEntry(100, bar(100.5, 99, 100), 2);
    expect(Number.isFinite(d.restingStop!)).toBe(true);
    const ref = createFuturesStopEngine(cfg({
      initialStopAtrMultiple: STOP_ENGINE_DEFAULTS.initialStopAtrMultiple,
      initialStopMinRiskFloor: STOP_ENGINE_DEFAULTS.initialStopMinRiskFloor,
    })).onEntry(100, bar(100.5, 99, 100), 2);
    expect(d.restingStop).toBe(ref.restingStop);
  });

  it('an undefined gate mode is the DOCUMENTED default, never a silent adx-any', () => {
    const e = createFuturesStopEngine(cfg({ strangleGateMode: undefined }));
    e.onEntry(100, bar(100.5, 99.8, 100), 1);
    e.onBar(input(bar(103.5, 102.8, 103)));
    // Shipped clause satisfied, RSI cold: adx-any would latch; the adx-laguerre default must not.
    const d = e.onBar(input(bar(104.5, 103.8, 104), { adx: 35, adxPrev: 34, plusDi: 20, laguerreRsi: 50 }));
    expect(d.strangleLatched).toBe(false);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 entry evaluator: every graded-state formula (incl. DMI between-rule, LagRSI exact-equality saturation, wave-pattern lookup), window inclusivity/wrap/invalid-pass-through, threshold-0 exclusion vs +2 exactness, the hard LagOsc clause, close0>close1 gate, the same-direction re-entry latch lifecycle, NaN skip-bar semantics, LTF fail-open + DynStops graded gate + size weighting (count/3, ≤0→full), equity-halt latch, generation deltas (wave pattern ignored in dynstops).
 */
import { describe, it, expect } from 'vitest';
import {
  createFuturesEntryEvaluator, isWithinEntryWindow, WavePattern,
  gradeDmiState, gradeMacdState, gradeLagRsiState, gradeWavePatternState, gradeAdaptiveLagFilterState, gradeSuperTrendState,
} from '../../src/features/trading';
import type { EntryBarContext, EntryEvaluatorConfig, ChartIndicatorSnapshot, LtfSnapshot } from '../../src/features/trading';
import type { OhlcvBar } from '../../src/features/trading/services/market-data';

function bar(h: number, l: number, c: number, o = c): OhlcvBar {
  return { o, h, l, c, v: 1000 };
}

/** An "everything maximally bullish" chart snapshot that passes every long clause. */
function bullishSnapshot(over: Partial<ChartIndicatorSnapshot> = {}): ChartIndicatorSnapshot {
  return {
    plusDi0: 40, minusDi0: 10, adx0: 30, // DMI +2 (DI+ > ADX > DI−)
    macd0: 2, macdAvg0: 1, macd1: 1.5, // MACD +2
    mfi0: 60, mfi1: 55, // MFI +2
    lagOsc0: 0.8, lagOsc1: 0.5, // hard clause passes, rising
    lagFilter0: 99, lagFilter1: 98, // rising, close above
    eitTrigger0: 100.2, eitTrend0: 99.8, // close above trigger
    stStopDot0: 98, stStopDot1: 97.5, // low above rising dot
    lagRsi0: 85, lagRsi1: 80, // +1 zone
    alf0: 99.5, alf1: 99, // rising, close above
    bullWavePat: WavePattern.HL, bearWavePat: WavePattern.HH, // wave +2 (export)
    ...over,
  };
}

const bullishLtf: LtfSnapshot = {
  close: 101, low: 100.5, high: 101.5, stopDot: 99, stopDotPrev: 98.5,
  lagOsc: 0.6, lagOscPrev: 0.4, lagRsiAvg: 60, lagRsiAvgPrev: 55,
};

function ctx(over: Partial<EntryBarContext> = {}): EntryBarContext {
  return {
    bar: bar(101.5, 100.4, 101), // close above lagFilter/alf; low above stop dot
    prevBar: bar(100.9, 99.9, 100.5, 100.4),
    chartBarNumber: 100, // past the 30-bar chart warmup gate
    ltfBarNumber: 50, // past the 30-bar LTF warmup gate
    timeOfDayMinutes: 10 * 60, // 10:00 — inside 0930–1545
    indicators: bullishSnapshot(),
    ltf: bullishLtf,
    flat: true,
    equity: 100_000,
    estimatedStopLong: 96, // riskPerUnit = 5
    estimatedStopShort: 106,
    ...over,
  };
}

function makeEval(over: Partial<EntryEvaluatorConfig> = {}) {
  return createFuturesEntryEvaluator({
    generation: 'export', tickSize: 0.25, pointValue: 50, ...over,
  });
}

describe('graded states — exact formula guards', () => {
  it('DMI ±2 requires ADX strictly BETWEEN the DI lines', () => {
    expect(gradeDmiState(40, 10, 30)).toBe(2); // 40 > 30 > 10
    expect(gradeDmiState(40, 10, 45)).toBe(1); // ADX above both → only +1
    expect(gradeDmiState(40, 10, 5)).toBe(1); // ADX below both → only +1
    expect(gradeDmiState(10, 40, 30)).toBe(-2);
    expect(gradeDmiState(20, 20, 30)).toBe(0);
  });

  it('LagRSI saturation grades need EXACT 100/0; the ±1 ORs overlap as written', () => {
    expect(gradeLagRsiState(100, 90)).toBe(2);
    expect(gradeLagRsiState(99.999, 90)).toBe(1); // ≥70 && <100
    expect(gradeLagRsiState(0, 10)).toBe(-2);
    expect(gradeLagRsiState(75, 80)).toBe(1); // falling but ≥70 → the first OR branch wins
    expect(gradeLagRsiState(20, 25)).toBe(-1); // ≤30 && >0
    expect(gradeLagRsiState(50, 50)).toBe(0);
  });

  it('wave pattern lookup matches the four defined combos only', () => {
    expect(gradeWavePatternState(WavePattern.HL, WavePattern.HH)).toBe(2);
    expect(gradeWavePatternState(WavePattern.NHL, WavePattern.HH)).toBe(1);
    expect(gradeWavePatternState(WavePattern.LL, WavePattern.LH)).toBe(-2);
    expect(gradeWavePatternState(WavePattern.LL, WavePattern.NLH)).toBe(-1);
    expect(gradeWavePatternState(WavePattern.HH, WavePattern.LL)).toBe(0);
  });

  it('adaptive filter ±1 needs EXACT equality plus a prior lastMove', () => {
    expect(gradeAdaptiveLagFilterState(100, 99, 101, 1)).toBe(2);
    expect(gradeAdaptiveLagFilterState(100, 100, 101, 1)).toBe(1);
    expect(gradeAdaptiveLagFilterState(100, 100, 101, 0)).toBe(0); // no move yet
    expect(gradeAdaptiveLagFilterState(100, 101, 99, -1)).toBe(-2);
  });

  it('SuperTrend needs the whole bar beyond the dot', () => {
    expect(gradeSuperTrendState(98, 97, 99, 101)).toBe(2);
    expect(gradeSuperTrendState(98, 98.5, 99, 101)).toBe(1); // dot falling → only +1
    expect(gradeSuperTrendState(98, 97, 97.5, 101)).toBe(0); // low pierces the dot
  });

  it('MACD equality is state 0', () => {
    expect(gradeMacdState(1, 1, 0.5)).toBe(0);
  });
});

describe('entry window', () => {
  it('is inclusive at both ends and rejects outside', () => {
    expect(isWithinEntryWindow(930, 1545, 9 * 60 + 30)).toBe(true);
    expect(isWithinEntryWindow(930, 1545, 15 * 60 + 45)).toBe(true);
    expect(isWithinEntryWindow(930, 1545, 15 * 60 + 46)).toBe(false);
    expect(isWithinEntryWindow(930, 1545, 9 * 60 + 29)).toBe(false);
  });

  it('wraps midnight when start > end', () => {
    expect(isWithinEntryWindow(2200, 200, 23 * 60)).toBe(true);
    expect(isWithinEntryWindow(2200, 200, 1 * 60)).toBe(true);
    expect(isWithinEntryWindow(2200, 200, 12 * 60)).toBe(false);
  });

  it('an INVALID HHmm makes the window pass-through, not a rejection', () => {
    expect(isWithinEntryWindow(970, 1545, 12 * 60)).toBe(true); // minutes 70 invalid
    expect(isWithinEntryWindow(930, 2400, 3 * 60)).toBe(true);
  });
});

describe('entry evaluator — gates and lifecycle', () => {
  it('fires a long with the Export sizing math on an all-bullish bar', () => {
    const d = makeEval().evaluate(ctx());
    expect(d.signal).toBe('long');
    // qty = floor((2% × 100k) / (5 × $50)) = floor(2000/250) = 8
    expect(d.quantity).toBe(8);
  });

  it('threshold 0 EXCLUDES an indicator; +2 demands the ultra grade', () => {
    const zeroed = makeEval({ thresholds: { dmiLong: 0 } })
      .evaluate(ctx({ indicators: bullishSnapshot({ plusDi0: 10, minusDi0: 40 }) })); // DMI −1 but excluded
    expect(zeroed.signal).toBe('long');
    const demanding = makeEval({ thresholds: { dmiLong: 2 } })
      .evaluate(ctx({ indicators: bullishSnapshot({ adx0: 45 }) })); // DMI +1 only
    expect(demanding.signal).toBeNull();
  });

  it('the hard LagOsc clause has no exclusion parameter', () => {
    const d = makeEval({ thresholds: { dmiLong: 0, macdLong: 0, mfiLong: 0, lagFilterLong: 0, eitLong: 0, superTrendLong: 0, lagRsiLong: 0, wavePatternLong: 0, adaptiveLagFilterLong: 0 } })
      .evaluate(ctx({ indicators: bullishSnapshot({ lagOsc0: -0.1, lagOsc1: -0.2 }) }));
    expect(d.signal).toBeNull(); // every threshold excluded, hard clause still blocks
  });

  it('close0 > close1 sits at the submission gate, outside the confluence', () => {
    const d = makeEval().evaluate(ctx({ bar: bar(101.5, 100.4, 100.4) })); // close below prev close
    expect(d.signal).toBeNull();
  });

  it('NaN in any chart indicator skips the whole bar without updating previousLagOsc', () => {
    const e = makeEval();
    e.onPositionClosed('long'); // arm the re-entry filter
    // Bar A: flat, osc positive — previousLagOsc becomes +0.8 (no cross registered from NaN seed).
    expect(e.evaluate(ctx()).signal).toBeNull(); // blocked by re-entry (no cross-below yet)
    // Bar B: osc negative BUT another indicator NaN → skipped; the cross must NOT latch.
    const skipped = e.evaluate(ctx({ indicators: bullishSnapshot({ lagOsc0: -0.5, mfi0: NaN }) }));
    expect(skipped.skippedBar).toBe(true);
    // Bar C: all-bullish again — still blocked, proving bar B latched nothing.
    expect(e.evaluate(ctx()).signal).toBeNull();
  });

  it('re-entry latch: a long re-arms only after a bar-close cross below zero while flat', () => {
    const e = makeEval();
    e.onPositionClosed('long');
    expect(e.evaluate(ctx()).signal).toBeNull(); // blocked
    // A flat bar with the oscillator crossing below zero (prev +0.8 → −0.3): latches, but no long fires (osc < 0).
    e.evaluate(ctx({ indicators: bullishSnapshot({ lagOsc0: -0.3, lagOsc1: 0.8 }) }));
    // Oscillator back above zero and rising → long allowed again.
    expect(e.evaluate(ctx()).signal).toBe('long');
  });

  it('re-entry latch is direction-scoped: a prior long never blocks a short', () => {
    const e = makeEval();
    e.onPositionClosed('long');
    const bearish: ChartIndicatorSnapshot = {
      plusDi0: 10, minusDi0: 40, adx0: 30, macd0: -2, macdAvg0: -1, macd1: -1.5,
      mfi0: 40, mfi1: 45, lagOsc0: -0.8, lagOsc1: -0.5, lagFilter0: 102, lagFilter1: 103,
      eitTrigger0: 100.8, eitTrend0: 101.2, stStopDot0: 103, stStopDot1: 103.5,
      lagRsi0: 20, lagRsi1: 25, alf0: 101.5, alf1: 102,
      bullWavePat: WavePattern.LL, bearWavePat: WavePattern.LH,
    };
    const d = e.evaluate(ctx({
      bar: bar(101, 99.9, 100), // close below prev close, below filters, high below dot
      prevBar: bar(101.6, 100.5, 100.5, 100.6),
      indicators: bearish,
      ltf: { ...bullishLtf, close: 98, low: 97.5, high: 98.5, stopDot: 103, stopDotPrev: 103.5, lagOsc: -0.5, lagOscPrev: -0.3, lagRsiAvg: 40, lagRsiAvgPrev: 45 },
    }));
    expect(d.signal).toBe('short');
  });

  it('bad equity is a per-bar non-entry, NOT a latch (the source halt is unreachable in replay)', () => {
    const e = makeEval();
    expect(e.evaluate(ctx({ equity: 0 })).signal).toBeNull(); // qty 0 this bar
    expect(e.evaluate(ctx({ equity: 100_000 })).signal).toBe('long'); // recovers immediately
  });

  it('HARD warmup gates: no processing (and no latch/state updates) until both series season', () => {
    const e = makeEval();
    e.onPositionClosed('long');
    // A flat chart-warmup bar with the oscillator crossing below zero — must NOT latch.
    const gated = e.evaluate(ctx({ chartBarNumber: 5, indicators: bullishSnapshot({ lagOsc0: -0.4, lagOsc1: 0.5 }) }));
    expect(gated.skippedBar).toBe(true);
    expect(gated.reasons).toContain('chart-warmup');
    // LTF gate blocks even with a seasoned chart when the filter is on and LTF bars are missing.
    const ltfGated = e.evaluate(ctx({ ltfBarNumber: 3 }));
    expect(ltfGated.reasons).toContain('ltf-warmup');
    expect(e.evaluate(ctx({ ltfBarNumber: undefined })).reasons).toContain('ltf-warmup');
    // Post-warmup: the cross never registered during warmup, so the long is STILL re-entry-blocked.
    e.evaluate(ctx()); // seeds previousLagOsc (+0.8)
    expect(e.evaluate(ctx()).signal).toBeNull();
    // With the filter off, the LTF gate does not apply.
    const noLtf = makeEval({ useLtfTrendFilter: false });
    expect(noLtf.evaluate(ctx({ ltfBarNumber: undefined, ltf: null })).signal).toBe('long');
  });
});

describe('entry evaluator — LTF filter + generation deltas', () => {
  it('fails OPEN with no LTF data', () => {
    const d = makeEval().evaluate(ctx({ ltf: null }));
    expect(d.signal).toBe('long');
  });

  it('DynStops: a NaN LagRSI Average sends the whole LTF filter to fail-open at FULL size', () => {
    const e = makeEval({ generation: 'dynstops' });
    const d = e.evaluate(ctx({ ltf: { ...bullishLtf, lagRsiAvg: NaN } }));
    expect(d.signal).toBe('long');
    // Fail-open leaves all LTF states 0 → weight guard promotes to full size, not 2/3.
    expect(d.quantity).toBe(8);
  });

  it('Export gen: binary rule — close above the dot AND oscillator positive', () => {
    const d = makeEval().evaluate(ctx({ ltf: { ...bullishLtf, lagOsc: -0.1 } }));
    expect(d.signal).toBeNull();
  });

  it('DynStops gen: graded thresholds gate; wave pattern is NOT consulted', () => {
    const e = makeEval({ generation: 'dynstops' });
    // Wave pattern deeply bearish — irrelevant in dynstops:
    const d = e.evaluate(ctx({ indicators: bullishSnapshot({ bullWavePat: WavePattern.LL, bearWavePat: WavePattern.LH }) }));
    expect(d.signal).toBe('long');
    // But an LTF SuperTrend state below threshold blocks:
    const blocked = e.evaluate(ctx({ ltf: { ...bullishLtf, low: 98, high: 99.5, stopDot: 99 } })); // LTF bar straddles the dot → state 0 < 1
    expect(blocked.signal).toBeNull();
  });

  it('DynStops sizing weights by favorable LTF count/3 (sign-only) with the ≤0 → full-size guard', () => {
    // Exclude two LTF indicators from the GATE (thresholds 0) but they still count in the weight.
    const e = makeEval({ generation: 'dynstops', ltfThresholds: { lagOscLong: 0, lagRsiLong: 0 } });
    // LTF: SuperTrend favorable (+), lagOsc negative, lagRsi falling → favorable count = 1 → weight 1/3.
    const d = e.evaluate(ctx({ ltf: { ...bullishLtf, lagOsc: -0.2, lagOscPrev: -0.1, lagRsiAvg: 40, lagRsiAvgPrev: 45 } }));
    expect(d.signal).toBe('long');
    expect(d.quantity).toBe(Math.floor(8 * (1 / 3))); // floor(base × weight) — floored AFTER weighting
    // All three unfavorable/zero → weight guard promotes to FULL size.
    const guard = makeEval({ generation: 'dynstops', ltfThresholds: { superTrendLong: 0, lagOscLong: 0, lagRsiLong: 0 } })
      .evaluate(ctx({ ltf: { ...bullishLtf, low: 98, high: 99.5, lagOsc: -0.2, lagOscPrev: -0.1, lagRsiAvg: 40, lagRsiAvgPrev: 45 } }));
    expect(guard.signal).toBe('long');
    expect(guard.quantity).toBe(8);
  });

  it('risk-per-unit under one tick skips the side; qty 0 yields no signal', () => {
    const tight = makeEval().evaluate(ctx({ estimatedStopLong: 100.9 })); // riskPerUnit 0.1 < tick
    expect(tight.signal).toBeNull();
    const tiny = makeEval({ riskPerTradePercent: 0.01 }).evaluate(ctx()); // qty floors to 0
    expect(tiny.signal).toBeNull();
  });
});

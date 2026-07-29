/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 entry evaluator: every graded-state formula (incl. DMI between-rule, LagRSI exact-equality saturation, wave-pattern lookup), window inclusivity/wrap/invalid-pass-through, threshold-0 exclusion vs +2 exactness, the hard LagOsc clause, close0>close1 gate, the same-direction re-entry latch lifecycle, NaN skip-bar semantics, LTF fail-open + DynStops graded gate + size weighting (count/3, ≤0→full), equity-halt latch, generation deltas (wave pattern ignored in dynstops).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the third generation 'ensemble': the reading is attached to every graded bar (in-position included) and never to the other generations, entry on score alone with no up-close gate and no re-entry latch, the hard-clause difference isolated from the threshold, membership scaling, and LTF parity — the ensemble uses the BINARY export-style rule (ATCEnsembleGen.cs:291-292), not the DynStops graded gate.
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
    plusDi0: 40, minusDi0: 10, adx0: 30, adx1: 25, // DMI +2 (DI+ > ADX > DI−; rising for the ensemble grade)
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

describe("generation 'ensemble' — the scalar model (ATCEnsembleGen parity)", () => {
  const ens = (over: Partial<EntryEvaluatorConfig> = {}) =>
    makeEval({ generation: 'ensemble', ...over });

  it('attaches the ensemble reading to every graded bar, IN-POSITION included', () => {
    // The confirmation exit needs the score each bar, so the in-position path must carry it.
    const e = ens();
    const held = e.evaluate(ctx({ flat: false }));
    expect(held.signal).toBeNull();
    expect(held.reasons).toContain('in-position');
    expect(held.ensemble).toBeDefined();
    expect(held.ensemble!.maxPossible).toBe(18);
  });

  it('the other generations never carry an ensemble reading', () => {
    expect(makeEval({ generation: 'export' }).evaluate(ctx()).ensemble).toBeUndefined();
    expect(makeEval({ generation: 'dynstops' }).evaluate(ctx()).ensemble).toBeUndefined();
  });

  it('enters on score alone with NO up-close bar — his ensemble has no close0>close1 gate', () => {
    // A DOWN close that the unanimous-AND generations reject at the submission gate.
    const downClose = ctx({
      bar: bar(101.5, 100.4, 101),
      prevBar: bar(102.5, 101.0, 101.5, 101.2), // prev close 101.5 > this close 101
    });
    expect(makeEval({ generation: 'export' }).evaluate(downClose).signal).toBeNull();
    const d = ens().evaluate(downClose);
    expect(d.signal).toBe('long');
    expect(d.ensemble!.score).toBeGreaterThanOrEqual(13); // ≥ 70% of 18
  });

  it('enters when the HARD oscillator clause fails — no indicator is mandatory', () => {
    // Positive but FALLING: the hard clause needs lagOsc0 > lagOsc1, so 'export' must refuse. The
    // state still grades +1, so the ensemble score stays above threshold — isolating the CLAUSE as
    // the only difference between the two models, not the score.
    const oscFalling = ctx({ indicators: bullishSnapshot({ lagOsc0: 0.8, lagOsc1: 0.9 }) });
    expect(makeEval({ generation: 'export' }).evaluate(oscFalling).signal).toBeNull();
    const d = ens().evaluate(oscFalling);
    expect(d.signal).toBe('long');
    expect(d.ensemble!.contributions.lagOsc).toBe(1);
  });

  it('a strongly-adverse contributor moves the ARITHMETIC, never a mandate', () => {
    // lagOsc at −2 drops the score from 17 to 13 (under the ensemble's own grades): still ≥ 70% of
    // 18 (12.6) so the trade fires, and a slightly stricter threshold refuses the very same bar.
    // The oscillator has no veto — only its four points of weight.
    const oscAgainst = ctx({ indicators: bullishSnapshot({ lagOsc0: -0.5, lagOsc1: -0.2 }) });
    const d = ens().evaluate(oscAgainst);
    expect(d.ensemble!.score).toBe(13);
    expect(d.signal).toBe('long');
    expect(ens({ ensembleEntryThresholdPct: 75 }).evaluate(oscAgainst).signal).toBeNull(); // 13.5 bar
  });

  it('refuses below the threshold and says so', () => {
    // Only three contributors bullish → score well under 12.6.
    const weak = ctx({
      indicators: bullishSnapshot({
        macd0: 1, macdAvg0: 2, macd1: 1.5, // MACD negative
        mfi0: 40, mfi1: 45, // MFI negative
        lagFilter0: 98, lagFilter1: 99, // falling
        eitTrigger0: 99.5, eitTrend0: 100.2, // below trend
        stStopDot0: 102, stStopDot1: 102.5, // dot above the bar
        lagRsi0: 20, lagRsi1: 25,
        bullWavePat: WavePattern.LL, bearWavePat: WavePattern.LH,
      }),
    });
    const d = ens().evaluate(weak);
    expect(d.signal).toBeNull();
    expect(d.reasons).toContain('ensemble-below-threshold');
  });

  it('honours the membership flags — dropping contributors moves the bar', () => {
    const c = ctx();
    const full = ens().evaluate(c);
    expect(full.ensemble!.maxPossible).toBe(18);
    const trimmed = ens({ ensembleMembership: { lagRsi: false, wavePattern: false } }).evaluate(c);
    expect(trimmed.ensemble!.maxPossible).toBe(14);
    expect(trimmed.ensemble!.contributions.lagRsi).toBeUndefined();
  });

  it('a 100% threshold blocks a merely-strong bar', () => {
    expect(ens({ ensembleEntryThresholdPct: 100 }).evaluate(ctx()).signal).toBeNull();
  });

  it('ignores the same-direction re-entry latch that gates the older generations', () => {
    // After a long exit with no zero-cross, 'export' is latched out; the ensemble is not.
    const exp = makeEval({ generation: 'export' });
    exp.evaluate(ctx());
    exp.onPositionClosed('long');
    expect(exp.evaluate(ctx()).signal).toBeNull(); // latched out
    const e = ens();
    e.evaluate(ctx());
    e.onPositionClosed('long');
    expect(e.evaluate(ctx()).signal).toBe('long'); // no latch in the ensemble
  });

  it('still respects the hard warmup gates and the entry window', () => {
    expect(ens().evaluate(ctx({ chartBarNumber: 5 })).skippedBar).toBe(true);
    expect(ens().evaluate(ctx({ timeOfDayMinutes: 5 * 60 })).reasons).toContain('outside-window');
  });
});

describe("generation 'ensemble' — contributor grades that DIFFER from the Export chain", () => {
  const ens = (over: Partial<EntryEvaluatorConfig> = {}) => makeEval({ generation: 'ensemble', ...over });

  it('DMI contributes NOTHING when ADX is not rising (ATCEnsembleGen.cs:402-406)', () => {
    // Export grades this bar +2 (DI+ 40 > ADX 30 > DI− 10); his ensemble requires dmiAdx0 > dmiAdx1
    // in BOTH branches, so a falling ADX zeroes the contribution.
    const falling = ctx({ indicators: bullishSnapshot({ adx1: 35 }) });
    const d = ens().evaluate(falling);
    expect(d.ensemble!.contributions.dmi).toBe(0);
    expect(d.states!.dmi).toBe(0); // the ensemble's own graded state, not Export's
    expect(makeEval({ generation: 'export' }).evaluate(falling).states!.dmi).toBe(2);
  });

  it('a MISSING adx1 falls back to adx0 — not-rising — never to Export behavior', () => {
    const noPrev = ctx({ indicators: bullishSnapshot({ adx1: undefined as never }) });
    expect(ens().evaluate(noPrev).ensemble!.contributions.dmi).toBe(0);
  });

  it('the Laguerre-filter ±2 upgrade is an up CLOSE, not close-above-open + higher high (cs:442-446)', () => {
    // Close 101 above prev close 100.5 but BELOW its own open 101.2, no higher high: Export grades
    // +1, his ensemble +2. This one point flips entries near the threshold.
    const bar0 = bar(101.5, 100.4, 101, 101.2);
    const c = ctx({ bar: bar0 });
    const d = ens().evaluate(c);
    expect(d.ensemble!.contributions.lagFilter).toBe(2);
    expect(makeEval({ generation: 'export' }).evaluate(c).states!.lagFilter).toBe(1);
  });

  it("the ensemble's NaN skip-bar guard has NO adaptive-filter term (his eleven-value list)", () => {
    const alfNaN = ctx({ indicators: bullishSnapshot({ alf0: Number.NaN }) });
    expect(makeEval({ generation: 'export' }).evaluate(alfNaN).skippedBar).toBe(true);
    const d = ens().evaluate(alfNaN);
    expect(d.skippedBar).toBe(false);
    expect(d.signal).toBe('long');
  });
});

describe("generation 'ensemble' — LTF filter parity (ATCEnsembleGen.cs:291-292)", () => {
  const ens = (over: Partial<EntryEvaluatorConfig> = {}) => makeEval({ generation: 'ensemble', ...over });

  it('uses the BINARY export-style rule, not the DynStops graded gate', () => {
    // An LTF snapshot that the binary rule REJECTS (lagOsc ≤ 0) but whose graded states would pass
    // the DynStops gate on SuperTrend alone. The ensemble must refuse.
    const flatOsc: LtfSnapshot = {
      close: 101, low: 100.5, high: 101.5, stopDot: 99, stopDotPrev: 98.5,
      lagOsc: 0, lagOscPrev: -0.2, lagRsiAvg: 60, lagRsiAvgPrev: 55,
    };
    expect(ens().evaluate(ctx({ ltf: flatOsc })).ltfBullish).toBe(false);
    expect(ens().evaluate(ctx({ ltf: flatOsc })).signal).toBeNull();
    // Same snapshot under the export generation → identically rejected (proves rule equivalence).
    expect(makeEval({ generation: 'export' }).evaluate(ctx({ ltf: flatOsc })).ltfBullish).toBe(false);
  });

  it('does NOT gate on the LagRSI Average line (that is DynStops-only)', () => {
    // Missing lagRsiAvg sends DynStops to its fail-open branch; the ensemble never reads it at all,
    // so the binary rule still evaluates normally.
    const noRsiAvg: LtfSnapshot = {
      close: 101, low: 100.5, high: 101.5, stopDot: 99, stopDotPrev: 98.5,
      lagOsc: 0.6, lagOscPrev: 0.4,
    };
    const d = ens().evaluate(ctx({ ltf: noRsiAvg }));
    expect(d.ltfBullish).toBe(true);
    expect(d.signal).toBe('long');
  });

  it('fails OPEN on a missing LTF SNAPSHOT after warmup (NaN-value fail-open, not a gate)', () => {
    const d = ens().evaluate(ctx({ ltf: null }));
    expect(d.skippedBar).toBe(false);
    expect(d.signal).toBe('long');
  });

  it('the LTF WARMUP gate is unconditional for the ensemble whenever an LTF series exists', () => {
    // His ensemble always loads its LTF series and gates on its bar count regardless of the filter
    // flag (ATCEnsembleGen.cs:271-276); Export gates only when the filter is ON.
    const young = ctx({ ltfBarNumber: 5 });
    expect(ens({ useLtfTrendFilter: false }).evaluate(young).skippedBar).toBe(true);
    expect(makeEval({ generation: 'export', useLtfTrendFilter: false }).evaluate(young).skippedBar).toBe(false);
    // NT8 DEVIATION: with NO LTF series at all (a state his code cannot reach) the ensemble fails
    // open instead of gating forever.
    const none = ctx({ ltf: null, ltfBarNumber: undefined });
    expect(ens({ useLtfTrendFilter: false }).evaluate(none).skippedBar).toBe(false);
  });
});

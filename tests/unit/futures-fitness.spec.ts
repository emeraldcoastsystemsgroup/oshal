/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — parity guards for the ADR-116 optimization objectives (the nine NT8 OptimizationFitness ports): per-fitness empty-trade sentinels (-Infinity / NaN / -1e10), maxAvgMfeMinAvgMae's avgMae<=0 branch + NaN propagation, entryLogic's avgMae fallback of 1 and POPULATION variance, stopLossMae's +1 stop-efficiency guard and banker's-rounded 5% tail (50 trades → 2, where Math.round would give 3), trailingStop's MFE<=0 skip and the duplicated 1.8 P/MFE weight, targetOrder's case-sensitive substring exit matching, emergencyExit's TRUNCATED tail (30 trades → 1) and all-penalty sign incl. |worstTrade| on an all-winner set, positionSizing's maxDD==0 → 0 branches and trade-count-as-day-count, and maxNetProfitMinTrades' NaN-before-gate ordering with the exact -1e10 sentinel. Every expectation is hand-computed; the arithmetic is in the comment above it.
 */
import { describe, it, expect } from 'vitest';
import {
  maxAvgMfeMinAvgMae, entryLogicFitness, stopLossMaeFitness, trailingStopFitness, targetOrderFitness,
  emergencyExitFitness, positionSizingFitness, maxNetProfitMinTrades, bankersRound,
  FITNESS_FUNCTIONS, MIN_TRADES_GATE_SENTINEL, fitnessNames,
} from '../../src/features/trading';
import type { FitnessTrade } from '../../src/features/trading';

/** Build a closed trade; every field the objectives read defaults to a neutral 0 / null. */
function mk(p: Partial<FitnessTrade> & { profit: number }): FitnessTrade {
  return {
    profit: p.profit,
    mfe: p.mfe ?? 0,
    mae: p.mae ?? 0,
    mfePct: p.mfePct ?? 0,
    maePct: p.maePct ?? 0,
    exitName: p.exitName ?? null,
  };
}

/** A non-empty, non-degenerate sample every registered objective can be run over. */
const SAMPLE: FitnessTrade[] = [
  mk({ profit: 120, mfe: 200, mae: 40, mfePct: 2, maePct: 0.4, exitName: 'LongTarget1' }),
  mk({ profit: -80, mfe: 30, mae: 90, mfePct: 0.3, maePct: 0.9, exitName: 'LongStop' }),
  mk({ profit: 15, mfe: 60, mae: 20, mfePct: 0.6, maePct: 0.2, exitName: 'TimedExit' }),
];

describe('bankersRound — C# Math.Round is half-to-EVEN, JS Math.round is not', () => {
  it('sends exact halves to the even neighbour', () => {
    expect(bankersRound(0.5)).toBe(0);
    expect(bankersRound(1.5)).toBe(2);
    expect(bankersRound(2.5)).toBe(2);
    expect(bankersRound(3.5)).toBe(4);
    expect(bankersRound(4.5)).toBe(4);
  });

  it('genuinely differs from Math.round (the whole reason it exists)', () => {
    // Math.round rounds halves AWAY from zero: 0.5→1, 2.5→3, 4.5→5.
    expect(Math.round(0.5)).toBe(1);
    expect(Math.round(2.5)).toBe(3);
    expect(bankersRound(0.5)).not.toBe(Math.round(0.5));
    expect(bankersRound(2.5)).not.toBe(Math.round(2.5));
  });

  it('rounds non-halves normally and handles negatives half-to-even', () => {
    expect(bankersRound(2.4)).toBe(2);
    expect(bankersRound(2.6)).toBe(3);
    expect(bankersRound(-1.5)).toBe(-2); // even neighbour of −1.5 is −2
    expect(bankersRound(-0.5)).toBe(0);  // even neighbour of −0.5 is 0
    expect(bankersRound(-2.5)).toBe(-2);
  });
});

describe('empty-trade sentinels differ ON PURPOSE (optimizer ranking depends on it)', () => {
  it('returns -Infinity for the six objectives that guard on an empty list', () => {
    expect(entryLogicFitness([])).toBe(-Infinity);
    expect(stopLossMaeFitness([])).toBe(-Infinity);
    expect(trailingStopFitness([])).toBe(-Infinity);
    expect(targetOrderFitness([])).toBe(-Infinity);
    expect(emergencyExitFitness([], { maxDrawdown: 100 })).toBe(-Infinity);
    expect(positionSizingFitness([], { maxDrawdown: 100 })).toBe(-Infinity);
  });

  it('returns NaN (not -Infinity) for maxAvgMfeMinAvgMae — mean of nothing is 0/0', () => {
    expect(maxAvgMfeMinAvgMae([])).toBeNaN();
    expect(maxAvgMfeMinAvgMae([])).not.toBe(-Infinity);
  });

  it('returns the -1e10 gate sentinel (not -Infinity) for maxNetProfitMinTrades', () => {
    // net profit of an empty list is 0 (finite, so no NaN), count 0 < 50 → the hard gate fires.
    expect(maxNetProfitMinTrades([])).toBe(-1e10);
    expect(maxNetProfitMinTrades([])).not.toBe(-Infinity);
  });
});

describe('1) maxAvgMfeMinAvgMae — percent-basis excursion ratio', () => {
  it('divides the percent means', () => {
    // avgMfe% = (2.0 + 1.0 + 3.0)/3 = 2 ; avgMae% = (0.5 + 1.5 + 1.0)/3 = 1 → 2/1 = 2
    const trades = [
      mk({ profit: 1, mfePct: 2.0, maePct: 0.5 }),
      mk({ profit: 1, mfePct: 1.0, maePct: 1.5 }),
      mk({ profit: 1, mfePct: 3.0, maePct: 1.0 }),
    ];
    expect(maxAvgMfeMinAvgMae(trades)).toBeCloseTo(2, 10);
  });

  it('falls back to avgMfe when avgMae <= 0 (the double.Epsilon guard is literally "<= 0")', () => {
    // avgMfe% = (2.0 + 4.0)/2 = 3 ; avgMae% = 0 → return avgMfe = 3, NOT Infinity.
    const trades = [mk({ profit: 1, mfePct: 2.0, maePct: 0 }), mk({ profit: 1, mfePct: 4.0, maePct: 0 })];
    expect(maxAvgMfeMinAvgMae(trades)).toBe(3);
    expect(maxAvgMfeMinAvgMae(trades)).not.toBe(Infinity);
  });

  it('does NOT take the fallback for a tiny-but-positive avgMae (Number.EPSILON would be wrong)', () => {
    // C# double.Epsilon is 4.94e-324, so the guard means "<= 0". avgMae% = 1e-20 sits BELOW JS
    // Number.EPSILON (2.22e-16) but far above 0 → the ratio 2/1e-20 ≈ 2e20 must be returned, not
    // the fallback avgMfe = 2. Porting the guard with Number.EPSILON would return 2 here.
    const trades = [mk({ profit: 1, mfePct: 2.0, maePct: 1e-20 })];
    expect(maxAvgMfeMinAvgMae(trades)).toBeGreaterThan(1e19);
    expect(maxAvgMfeMinAvgMae(trades)).not.toBe(2);
  });

  it('propagates NaN from any trade and collapses Infinity to NaN', () => {
    expect(maxAvgMfeMinAvgMae([mk({ profit: 1, mfePct: NaN, maePct: 1 })])).toBeNaN();
    expect(maxAvgMfeMinAvgMae([mk({ profit: 1, mfePct: 2, maePct: NaN })])).toBeNaN();
    // A non-finite mean must become NaN, never ±Infinity — the C# guard checks both.
    expect(maxAvgMfeMinAvgMae([mk({ profit: 1, mfePct: Infinity, maePct: 1 })])).toBeNaN();
    expect(maxAvgMfeMinAvgMae([mk({ profit: 1, mfePct: 2, maePct: Infinity })])).toBeNaN();
  });
});

describe('2) entryLogicFitness — edge ratio + expectancy + win rate + stability', () => {
  it('falls back to avgMae = 1 when no trade had a positive MAE', () => {
    // trades: (P=100, MFE=150, MAE=0), (P=-50, MFE=50, MAE=0)
    //   mfeList = [150, 50] → avgMfe = 100 ; maeList = [] → avgMae = 1 (fallback) → edgeRatio = 100
    //   cumProfit = 50, N = 2 → expectancy = 25 ; winners = 1 → winRate = 0.5
    //   returns = [100, -50], mean = 25 → POPULATION var = (75² + 75²)/2 = 5625 → stability = 1/5626
    //   value = 1.0(100) + 0.8(25) + 0.5(0.5) + 0.3(1/5626) = 120.25 + 0.00005332 = 120.25005332
    const trades = [mk({ profit: 100, mfe: 150 }), mk({ profit: -50, mfe: 50 })];
    expect(entryLogicFitness(trades)).toBeCloseTo(120.25 + 0.3 / 5626, 10);
  });

  it('uses POPULATION variance (÷N) and skips non-positive excursions from their averages', () => {
    // trades: (100, MFE 200, MAE 50), (-60, MFE 40, MAE 80), (0, MFE 0, MAE 20)
    //   mfeList = [200, 40] (MFE 0 excluded) → avgMfe = 120
    //   maeList = [50, 80, 20] → avgMae = 50 → edgeRatio = 2.4
    //   cumProfit = 40, N = 3 → expectancy = 40/3 ; winners = 1 (P=0 is NOT a winner) → winRate = 1/3
    //   returns = [100, -60, 0], mean = 40/3 → deviations 260/3, -220/3, -40/3
    //     POPULATION var = (67600 + 48400 + 1600)/9/3 = 117600/27 = 39200/9 ≈ 4355.5556
    //     stability = 1/(1 + 39200/9) = 9/39209
    //   value = 2.4 + 0.8(40/3) + 0.5(1/3) + 0.3(9/39209) = 2.4 + 32/3 + 1/6 + 2.7/39209 ≈ 13.2334022
    //   (a SAMPLE variance, ÷(N-1) = 117600/18, would give 0.3/6534.33 ≈ 4.59e-5 instead of 6.89e-5)
    const trades = [
      mk({ profit: 100, mfe: 200, mae: 50 }),
      mk({ profit: -60, mfe: 40, mae: 80 }),
      mk({ profit: 0, mfe: 0, mae: 20 }),
    ];
    expect(entryLogicFitness(trades)).toBeCloseTo(2.4 + 32 / 3 + 1 / 6 + 2.7 / 39209, 10);
    // Sample variance would land here — prove we are not there.
    expect(entryLogicFitness(trades)).not.toBeCloseTo(2.4 + 32 / 3 + 1 / 6 + 0.3 / (117600 / 18 + 1), 8);
  });

  it('zeroes the variance term for a single trade (returns.length > 1 guard)', () => {
    // one trade (P=10, MFE=20, MAE=5): avgMfe=20, avgMae=5 → edge 4 ; expectancy 10 ; winRate 1
    //   variance = 0 (guard) → stability = 1 → value = 4 + 8 + 0.5 + 0.3 = 12.8
    expect(entryLogicFitness([mk({ profit: 10, mfe: 20, mae: 5 })])).toBeCloseTo(12.8, 10);
  });
});

describe('3) stopLossMaeFitness — stop efficiency, MAE tail, winners stopped', () => {
  it('applies the +1 soft guard even when winnersStopped is 0', () => {
    // (-100, MAE 100, LongStop), (-80, MAE 80, ShortStop), (200, MAE 10, LongTarget1)
    //   losersStopped = 2, winnersStopped = 0 → stopEfficiency = 2/(1+0) = 2 (NOT 2/0 = Infinity)
    //   cumProfit = 20, N = 3 → expectancy = 20/3
    //   allMae sorted = [10, 80, 100] ; tail = max(1, bankers(3*0.05=0.15)=0) = 1 → tailMaeAvg = 100
    //   winnersStoppedRatio = 0
    //   value = 2 + 0.5(20/3) - 0.2(100) - 0 = 2 + 10/3 - 20 = -14.6666667
    const trades = [
      mk({ profit: -100, mae: 100, exitName: 'LongStop' }),
      mk({ profit: -80, mae: 80, exitName: 'ShortStop' }),
      mk({ profit: 200, mae: 10, exitName: 'LongTarget1' }),
    ];
    expect(stopLossMaeFitness(trades)).toBeCloseTo(2 + 10 / 3 - 20, 10);
    expect(Number.isFinite(stopLossMaeFitness(trades))).toBe(true);
  });

  it('counts a stopped winner in the divisor and the ratio, and keeps breakevens in N only', () => {
    // (-100, MAE 100, LongStop), (-80, MAE 80, ShortStop), (+50, MAE 10, LongStop), (0, MAE 5, TimedExit)
    //   losersStopped = 2 ; winnersStopped = 1 → stopEfficiency = 2/(1+1) = 1
    //   cumProfit = -130, N = 4 (the breakeven counts) → expectancy = -32.5
    //   allMae sorted = [5, 10, 80, 100] ; tail = max(1, bankers(0.2)=0) = 1 → tailMaeAvg = 100
    //   winnersStoppedRatio = 1/4 = 0.25
    //   value = 1 + 0.5(-32.5) - 0.2(100) - 0.5(0.25) = 1 - 16.25 - 20 - 0.125 = -35.375
    const trades = [
      mk({ profit: -100, mae: 100, exitName: 'LongStop' }),
      mk({ profit: -80, mae: 80, exitName: 'ShortStop' }),
      mk({ profit: 50, mae: 10, exitName: 'LongStop' }),
      mk({ profit: 0, mae: 5, exitName: 'TimedExit' }),
    ];
    expect(stopLossMaeFitness(trades)).toBeCloseTo(-35.375, 10);
  });

  it("sizes the 5% MAE tail with BANKER'S rounding — 50 trades → 2, where Math.round gives 3", () => {
    // 50 trades, P = +1 each (no stops at all), MAE = 1..50
    //   stopEfficiency = 0/(1+0) = 0 ; cumProfit = 50, N = 50 → expectancy = 1
    //   tail = max(1, bankers(50*0.05 = 2.5) = 2) = 2 → largest two MAEs = [49, 50] → avg 49.5
    //   value = 0 + 0.5(1) - 0.2(49.5) - 0 = 0.5 - 9.9 = -9.4
    //   With JS Math.round(2.5) = 3 the tail would be [48,49,50] → 49 → 0.5 - 9.8 = -9.3.
    const trades = Array.from({ length: 50 }, (_, i) => mk({ profit: 1, mae: i + 1 }));
    expect(stopLossMaeFitness(trades)).toBeCloseTo(-9.4, 10);
    expect(stopLossMaeFitness(trades)).not.toBeCloseTo(-9.3, 6);
  });

  it("matches exit names by CASE-SENSITIVE substring — 'TimedExit' is not a stop", () => {
    // (-100, MAE 100, TimedExit), (-50, MAE 50, longstop lowercase) → losersStopped = 0
    //   stopEfficiency = 0 ; cumProfit = -150, N = 2 → expectancy = -75
    //   allMae sorted = [50, 100]; tail = max(1, bankers(0.1)=0) = 1 → 100
    //   value = 0 + 0.5(-75) - 0.2(100) - 0 = -37.5 - 20 = -57.5
    const trades = [
      mk({ profit: -100, mae: 100, exitName: 'TimedExit' }),
      mk({ profit: -50, mae: 50, exitName: 'longstop' }),
    ];
    expect(stopLossMaeFitness(trades)).toBeCloseTo(-57.5, 10);
  });
});

describe('4) trailingStopFitness — the duplicated P/MFE weight', () => {
  it('skips MFE <= 0 trades entirely and applies the effective 1.8 weight', () => {
    // survivors (MFE > 0): (60, MFE 100) and (-40, MFE 50). Skipped: (-10, MFE 0), (5, MFE -3) —
    //   including either would make P/MFE non-finite / nonsense.
    //   mean(P/MFE) = (0.6 + (-0.8))/2 = -0.1
    //   mean(MFE)   = (100 + 50)/2 = 75
    //   mean(MFE-P) = (40 + 90)/2 = 65
    //   value = 1.0(-0.1) + 0.8(-0.1) + 0.4(75) - 0.6(65) = -0.18 + 30 - 39 = -9.18
    const trades = [
      mk({ profit: 60, mfe: 100 }),
      mk({ profit: -40, mfe: 50 }),
      mk({ profit: -10, mfe: 0 }),
      mk({ profit: 5, mfe: -3 }),
    ];
    const value = trailingStopFitness(trades);
    expect(value).toBeCloseTo(-9.18, 10);
    expect(Number.isFinite(value)).toBe(true);
    // A "fixed" single-weight runup definition (1.0 instead of 1.8 on P/MFE) would give -9.10.
    expect(value).not.toBeCloseTo(-9.1, 6);
  });

  it('returns -Infinity when every trade has MFE <= 0 (nothing for a trail to trail)', () => {
    expect(trailingStopFitness([mk({ profit: -10, mfe: 0 }), mk({ profit: -5, mfe: 0 })])).toBe(-Infinity);
  });

  it('mixes the unit-less ratio with raw currency, as designed (currency dominates)', () => {
    // one trade (P=500, MFE=1000): mean(P/MFE)=0.5, mean(MFE)=1000, mean(MFE-P)=500
    //   value = 1.8(0.5) + 0.4(1000) - 0.6(500) = 0.9 + 400 - 300 = 100.9
    expect(trailingStopFitness([mk({ profit: 500, mfe: 1000 })])).toBeCloseTo(100.9, 10);
  });
});

describe('5) targetOrderFitness — MFE utilization, payoff, target hit rate', () => {
  const trades = [
    mk({ profit: 100, mfe: 200, exitName: 'LongTarget1' }),
    mk({ profit: -50, mfe: 25, exitName: 'ShortStop' }),
    mk({ profit: 30, mfe: 0, exitName: 'ShortTarget1' }),
    mk({ profit: -20, mfe: 40, exitName: null }),
    mk({ profit: 10, mfe: 20, exitName: 'TimedExit' }),
  ];

  it('counts hits over ALL trades but averages utilization only over MFE > 0', () => {
    // mfeUtil (MFE>0 only): 100/200=0.5, -50/25=-2, -20/40=-0.5, 10/20=0.5 → sum -1.5 → avg -0.375
    //   (the MFE=0 target hit contributes NO utilization but IS a hit)
    // targetHits = LongTarget1 + ShortTarget1 = 2 → targetHitRate = 2/5 = 0.4
    // cumProfit = 100-50+30-20+10 = 70, N = 5 → expectancy = 14
    // avgWin = (100+30+10)/3 = 140/3 ; avgLoss = |(-50 + -20)/2| = 35 → payoff = (140/3)/35 = 4/3
    // value = 1.0(-0.375) + 0.7(14) + 0.5(4/3) + 0.3(0.4) = -0.375 + 9.8 + 2/3 + 0.12 ≈ 10.2116667
    expect(targetOrderFitness(trades)).toBeCloseTo(-0.375 + 9.8 + 2 / 3 + 0.12, 10);
  });

  it("matches 'Target' case-sensitively — 'longtarget1' is not a hit", () => {
    // Same set with the first exit lowercased: targetHits drops 2 → 1, hitRate 0.4 → 0.2,
    //   so the value drops by exactly 0.3 * 0.2 = 0.06 → ≈ 10.1516667. Nothing else moves.
    const lowered = trades.map((t, i) => (i === 0 ? { ...t, exitName: 'longtarget1' } : t));
    expect(targetOrderFitness(lowered)).toBeCloseTo(-0.375 + 9.8 + 2 / 3 + 0.06, 10);
  });

  it('yields payoffRatio 0 (not Infinity) when there are no losers', () => {
    // (10, MFE 20) and (20, MFE 40): mfeUtil = (0.5 + 0.5)/2 = 0.5 ; hits 0 → rate 0
    //   cumProfit = 30, N = 2 → expectancy = 15 ; avgWin = 15, avgLoss = 0 → payoff = 0
    //   value = 0.5 + 0.7(15) + 0 + 0 = 0.5 + 10.5 = 11
    expect(targetOrderFitness([mk({ profit: 10, mfe: 20 }), mk({ profit: 20, mfe: 40 })])).toBeCloseTo(11, 10);
  });

  it('defaults avgMfeUtil to 0 when no trade had a positive MFE', () => {
    // one trade (P=10, MFE=0): util list empty → 0 ; hits 0 ; expectancy 10 ; avgLoss 0 → payoff 0
    //   value = 0 + 0.7(10) + 0 + 0 = 7
    expect(targetOrderFitness([mk({ profit: 10, mfe: 0 })])).toBeCloseTo(7, 10);
  });
});

describe('6) emergencyExitFitness — every term is a penalty', () => {
  // 30 trades: MAE = 1..30, P = -(1..30) → worst trade = -30.
  const thirty = Array.from({ length: 30 }, (_, i) => mk({ profit: -(i + 1), mae: i + 1 }));

  it('TRUNCATES the 5% tail — 30 trades → 1, where banker\'s rounding would give 2', () => {
    // tail = max(1, trunc(30*0.05 = 1.5) = 1) = 1 → tailMaeAvg = 30 (the single largest MAE)
    // worstTrade = -30 → |worst| = 30 ; maxDD = 100 → |maxDD| = 100
    // catastrophic: -30 < -100*0.5 = -50 ? NO → 0
    // value = -1.0(30) - 0.8(30) - 0.6(100) - 1.2(0) = -30 - 24 - 60 = -114
    // (bankers(1.5) = 2 → tail [29,30] = 29.5 → -113.5; JS Math.round(1.5) = 2 likewise.)
    expect(emergencyExitFitness(thirty, { maxDrawdown: 100 })).toBeCloseTo(-114, 10);
    expect(emergencyExitFitness(thirty, { maxDrawdown: 100 })).not.toBeCloseTo(-113.5, 6);
  });

  it('fires the catastrophic flag when one trade exceeds half the max drawdown', () => {
    // same 30 trades, maxDD = 40 → threshold -20 ; worstTrade -30 < -20 → penalty 1
    // value = -30 - 0.8(30) - 0.6(40) - 1.2(1) = -30 - 24 - 24 - 1.2 = -79.2
    expect(emergencyExitFitness(thirty, { maxDrawdown: 40 })).toBeCloseTo(-79.2, 10);
  });

  it('penalizes |worstTrade| even when every trade WON (the as-written quirk)', () => {
    // (100, MAE 0) and (20, MAE 0), no aggregates → maxDD = 0
    // tail = max(1, trunc(2*0.05 = 0.1) = 0) = 1 → tailMaeAvg = 0
    // worstTrade = 20 (the smallest WIN) → -0.8(20) = -16
    // catastrophic: 20 < -0*0.5 = 0 ? NO → 0
    // value = -0 - 16 - 0 - 0 = -16 — an all-winner strategy still scores negative.
    expect(emergencyExitFitness([mk({ profit: 100 }), mk({ profit: 20 })])).toBeCloseTo(-16, 10);
  });

  it('reduces the catastrophic test to "worstTrade < 0" when no drawdown is supplied', () => {
    // (-5, MAE 5) and (10, MAE 1), agg omitted → maxDD = 0
    // tail = max(1, trunc(0.1) = 0) = 1 → sorted MAE [1, 5] → tailMaeAvg = 5
    // worstTrade = -5 → -0.8(5) = -4 ; |maxDD| = 0 ; catastrophic: -5 < 0 → 1 → -1.2
    // value = -5 - 4 - 0 - 1.2 = -10.2
    expect(emergencyExitFitness([mk({ profit: -5, mae: 5 }), mk({ profit: 10, mae: 1 })])).toBeCloseTo(-10.2, 10);
  });

  it('never returns a positive value', () => {
    expect(emergencyExitFitness(SAMPLE, { maxDrawdown: 500 })).toBeLessThanOrEqual(0);
    expect(emergencyExitFitness(thirty, { maxDrawdown: 0 })).toBeLessThanOrEqual(0);
  });
});

describe('7) positionSizingFitness — return per unit of drawdown', () => {
  const three = [mk({ profit: 100 }), mk({ profit: -50 }), mk({ profit: 25 })]; // net = 75

  it('defines RoMaD and MAR as 0 (not Infinity) when maxDD is 0', () => {
    // netProfit = 75, maxDD = 0 → romad = 0, mar = 0, ulcerIndex = 0, smoothness = 1/(1+0) = 1
    // value = 1.0(0) + 0.7(0) + 0.4(1) - 0.6(0) = 0.4
    expect(positionSizingFitness(three)).toBeCloseTo(0.4, 10);
    expect(positionSizingFitness(three, { maxDrawdown: 0 })).toBeCloseTo(0.4, 10);
    expect(Number.isFinite(positionSizingFitness(three))).toBe(true);
  });

  it('computes the weighted sum with a real drawdown', () => {
    // netProfit = 75, N = 3, maxDD = 50
    //   romad = 75/50 = 1.5
    //   totalDays = max(1, 3) = 3 → annualReturn = 75/3*252 = 6300 → mar = 6300/50 = 126
    //   ulcerIndex = 50 → smoothness = 1/51
    //   value = 1.5 + 0.7(126) + 0.4(1/51) - 0.6(50) = 1.5 + 88.2 + 0.00784314 - 30 ≈ 59.70784314
    expect(positionSizingFitness(three, { maxDrawdown: 50 })).toBeCloseTo(1.5 + 88.2 + 0.4 / 51 - 30, 10);
  });

  it('uses the TRADE COUNT as the day count — same net profit scores higher with fewer trades', () => {
    // one trade, net = 75, maxDD = 50: totalDays = max(1,1) = 1 → annualReturn = 75*252 = 18900
    //   mar = 18900/50 = 378 → 0.7(378) = 264.6 ; romad = 1.5 ; smoothness = 1/51 ; ulcer = 50
    //   value = 1.5 + 264.6 + 0.4/51 - 30 ≈ 236.10784314  (vs 59.708 for the same 75 over 3 trades)
    const one = [mk({ profit: 75 })];
    expect(positionSizingFitness(one, { maxDrawdown: 50 })).toBeCloseTo(1.5 + 264.6 + 0.4 / 51 - 30, 10);
    expect(positionSizingFitness(one, { maxDrawdown: 50 }))
      .toBeGreaterThan(positionSizingFitness(three, { maxDrawdown: 50 }));
  });

  it('treats ulcerIndex as plain |maxDD| (both smoothness denominator and raw penalty)', () => {
    // net = 0 (a +50/-50 pair), maxDD = 9 → romad = 0/9 = 0 ; annualReturn = 0 → mar = 0
    //   ulcer = 9 → smoothness = 0.1 → value = 0 + 0 + 0.4(0.1) - 0.6(9) = 0.04 - 5.4 = -5.36
    const flat = [mk({ profit: 50 }), mk({ profit: -50 })];
    expect(positionSizingFitness(flat, { maxDrawdown: 9 })).toBeCloseTo(-5.36, 10);
  });
});

describe('8/9) maxNetProfitMinTrades — NaN beats the gate, and the gate is exactly -1e10', () => {
  it('checks NaN BEFORE the min-trades gate', () => {
    // 3 trades (< 50) with a non-finite net profit → NaN, NOT the -1e10 sentinel.
    const trades = [mk({ profit: 10 }), mk({ profit: NaN }), mk({ profit: 5 })];
    expect(maxNetProfitMinTrades(trades)).toBeNaN();
    expect(maxNetProfitMinTrades(trades)).not.toBe(MIN_TRADES_GATE_SENTINEL);
    // Infinity takes the same branch.
    expect(maxNetProfitMinTrades([mk({ profit: Infinity }), mk({ profit: 5 })])).toBeNaN();
  });

  it('returns the exact -1e10 sentinel below the gate (never -Infinity)', () => {
    // 3 trades, net = 30, count 3 < 50 → sentinel.
    const trades = [mk({ profit: 10 }), mk({ profit: 10 }), mk({ profit: 10 })];
    expect(maxNetProfitMinTrades(trades)).toBe(-1e10);
    expect(maxNetProfitMinTrades(trades)).toBe(MIN_TRADES_GATE_SENTINEL);
    expect(maxNetProfitMinTrades(trades)).not.toBe(-Infinity);
  });

  it('returns raw net profit once the gate clears', () => {
    // 50 trades × +2 = 100 net, count 50 >= 50 → 100.
    const fifty = Array.from({ length: 50 }, () => mk({ profit: 2 }));
    expect(maxNetProfitMinTrades(fifty)).toBeCloseTo(100, 10);
    // Exactly at the boundary: 49 trades is below the gate.
    expect(maxNetProfitMinTrades(fifty.slice(0, 49))).toBe(-1e10);
  });

  it('takes the minTrades parameter — the …100 variant rejects the same 50-trade set', () => {
    const fifty = Array.from({ length: 50 }, () => mk({ profit: 2 }));
    expect(maxNetProfitMinTrades(fifty, undefined, 100)).toBe(-1e10);
    const hundred = Array.from({ length: 100 }, () => mk({ profit: 2 }));
    expect(maxNetProfitMinTrades(hundred, undefined, 100)).toBeCloseTo(200, 10);
  });
});

describe('FITNESS_FUNCTIONS registry', () => {
  it('registers all nine shipped objectives under stable kebab-case keys', () => {
    expect(fitnessNames()).toEqual([
      'max-avg-mfe-min-avg-mae',
      'entry-logic',
      'stop-loss-mae',
      'trailing-stop',
      'target-order',
      'emergency-exit',
      'position-sizing',
      'max-net-profit-min-trades-50',
      'max-net-profit-min-trades-100',
    ]);
    expect(fitnessNames()).toHaveLength(9);
  });

  it('maps the seven single-variant keys to the functions themselves', () => {
    expect(FITNESS_FUNCTIONS['max-avg-mfe-min-avg-mae']).toBe(maxAvgMfeMinAvgMae);
    expect(FITNESS_FUNCTIONS['entry-logic']).toBe(entryLogicFitness);
    expect(FITNESS_FUNCTIONS['stop-loss-mae']).toBe(stopLossMaeFitness);
    expect(FITNESS_FUNCTIONS['trailing-stop']).toBe(trailingStopFitness);
    expect(FITNESS_FUNCTIONS['target-order']).toBe(targetOrderFitness);
    expect(FITNESS_FUNCTIONS['emergency-exit']).toBe(emergencyExitFitness);
    expect(FITNESS_FUNCTIONS['position-sizing']).toBe(positionSizingFitness);
  });

  it('binds the two min-trades gates to 50 and 100', () => {
    const fifty = Array.from({ length: 50 }, () => mk({ profit: 2 }));
    expect(FITNESS_FUNCTIONS['max-net-profit-min-trades-50'](fifty)).toBeCloseTo(100, 10);
    expect(FITNESS_FUNCTIONS['max-net-profit-min-trades-100'](fifty)).toBe(-1e10);
  });

  it('every registered objective scores a normal trade list without throwing', () => {
    for (const name of fitnessNames()) {
      const value = FITNESS_FUNCTIONS[name](SAMPLE, { maxDrawdown: 120 });
      expect(typeof value).toBe('number');
      expect(Number.isNaN(value)).toBe(false);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Mutation-proven gaps closed 2026-07-27 after an adversarial review demonstrated that the
 * original suite stayed green when bankersRound was swapped for Math.trunc, when the breakeven
 * comparison was loosened, when the 0.05 tail fraction was shrunk, and when a defensive epsilon
 * guard was added to entryLogic. Each case below is chosen at a value where the WRONG rule
 * produces a DIFFERENT number, so the guard genuinely bites.
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

describe('quirk guards — the mutations that used to slip through', () => {
  /** n trades whose MAEs are 1..n, so the tail mean is a function of the tail COUNT alone. */
  function ladder(n: number): FitnessTrade[] {
    return Array.from({ length: n }, (_, i) => mk({ profit: -1, mae: i + 1, exitName: 'LongStop' }));
  }

  it('stopLossMae rounds its 5% tail BANKER\'S — 30 trades → 2 tail trades, not trunc\'s 1', () => {
    // 30 × 0.05 = 1.5 → bankersRound = 2 (half-to-even), Math.trunc = 1. The two disagree here,
    // which is exactly the count the spec calls out and the count the old suite never used.
    const t = ladder(30); // MAEs 1..30; largest two = 29, 30 → mean 29.5 (trunc would give 30)
    const value = stopLossMaeFitness(t, { maxDrawdown: 0 });
    // stopEfficiency = 30 losers stopped / (1 + 0 winners) = 30; expectancy = -30/30 = -1
    // value = 1.0(30) + 0.5(-1) − 0.2(29.5) − 0.5(0) = 30 − 0.5 − 5.9 = 23.6
    expect(value).toBeCloseTo(23.6, 10);
    // The truncating variant would use tail 30 → 30 − 0.5 − 6.0 = 23.5. Prove we are NOT that.
    expect(value).not.toBeCloseTo(23.5, 6);
  });

  it('emergencyExit TRUNCATES its 5% tail — the same 30 trades give 1 tail trade, not 2', () => {
    const t = ladder(30); // largest one = 30
    // −1.0(30) − 0.8|worst −1| − 0.6(0) − 1.2(catastrophic: −1 < −0 → true) = −30 − 0.8 − 1.2
    expect(emergencyExitFitness(t, { maxDrawdown: 0 })).toBeCloseTo(-32.0, 10);
    // Banker's would take the largest TWO (mean 29.5) → −29.5 − 0.8 − 1.2 = −31.5.
    expect(emergencyExitFitness(t, { maxDrawdown: 0 })).not.toBeCloseTo(-31.5, 6);
  });

  it('the tail FRACTION is 0.05, pinned at a count where 0.04 would differ', () => {
    // 60 × 0.05 = 3 (bankers 3); 60 × 0.04 = 2.4 (bankers 2). Different tails → different means.
    const t = ladder(60); // largest three = 58,59,60 → mean 59
    const value = stopLossMaeFitness(t, { maxDrawdown: 0 });
    // stopEfficiency 60; expectancy −1; value = 60 − 0.5 − 0.2(59) = 47.7
    expect(value).toBeCloseTo(47.7, 10);
    expect(value).not.toBeCloseTo(60 - 0.5 - 0.2 * 59.5, 6); // the 0.04 (two-trade) tail
  });

  it('breakeven trades (P == 0) count in NEITHER winners nor losers, even when STOPPED out', () => {
    // The old fixture gave its breakeven trade a 'TimedExit', so loosening > 0 to >= 0 was invisible.
    const base = [
      mk({ profit: 100, mae: 5, exitName: 'LongTarget1' }),
      mk({ profit: -50, mae: 10, exitName: 'LongStop' }),
    ];
    const withBreakeven = [...base, mk({ profit: 0, mae: 7, exitName: 'LongStop' })];
    const b = stopLossMaeFitness(withBreakeven, { maxDrawdown: 0 });
    // losersStopped = 1 (only the −50); winnersStopped = 0 → stopEfficiency = 1/(1+0) = 1.
    // If P==0 counted as a winner: winnersStopped = 1 → stopEfficiency = 0.5 AND ratio = 1/3.
    // expectancy = 50/3; tail = max(1, bankers(3×0.05)=0) = 1 → largest MAE = 10.
    expect(b).toBeCloseTo(1 + 0.5 * (50 / 3) - 0.2 * 10 - 0.5 * 0, 10);
    // The mutated (>= 0) reading would land here — prove we are not it.
    expect(b).not.toBeCloseTo(0.5 + 0.5 * (50 / 3) - 0.2 * 10 - 0.5 * (1 / 3), 6);
  });

  it('entryLogic\'s edgeRatio has NO epsilon guard — a tiny MAE makes it explode, as written', () => {
    // The source's ONLY protection is the empty-maeList fallback of 1. A "helpful" hardening here
    // would silently re-rank every parameter set with sub-epsilon average heat.
    const t = [mk({ profit: 1, mfe: 100, mae: 1e-20 })];
    const value = entryLogicFitness(t, { maxDrawdown: 0 });
    expect(value).toBeGreaterThan(1e21); // edgeRatio ≈ 100/1e-20 = 1e22
    expect(Number.isFinite(value)).toBe(true);
  });

  it('maxAvgMfeMinAvgMae treats maePct as a MAGNITUDE, so a signed feed cannot fake the fallback', () => {
    const positive = [mk({ profit: 1, mfePct: 2, maePct: 1 })];
    const signed = [mk({ profit: 1, mfePct: 2, maePct: -1 })]; // NT8's signed MaePercent
    expect(maxAvgMfeMinAvgMae(positive)).toBeCloseTo(2, 10);
    // Without abs() this would hit the avgMae <= 0 branch and return the raw avgMfe (2) —
    // the same number by coincidence, so use an asymmetric case to make the bug visible:
    const asym = [mk({ profit: 1, mfePct: 6, maePct: -3 })];
    expect(maxAvgMfeMinAvgMae(asym)).toBeCloseTo(2, 10); // 6/3, NOT the unguarded 6
    expect(maxAvgMfeMinAvgMae(signed)).toBeCloseTo(2, 10);
  });

  it('maxNetProfitMinTrades prefers a supplied NetProfit over the raw trade sum', () => {
    const t = Array.from({ length: 60 }, () => mk({ profit: 100 })); // sum = 6000
    expect(maxNetProfitMinTrades(t)).toBeCloseTo(6000, 10); // no aggregate → falls back
    // Commission-bearing NetProfit supplied by the caller must win.
    expect(maxNetProfitMinTrades(t, { maxDrawdown: 0, netProfit: 5700 })).toBeCloseTo(5700, 10);
    // The gate still bites regardless of source.
    expect(maxNetProfitMinTrades(t, { maxDrawdown: 0, netProfit: 5700 }, 100)).toBe(-1e10);
  });

  it('emergencyExit survives a trade list far past the argument-spread limit', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => mk({ profit: i === 0 ? -999 : 1, mae: 1 }));
    expect(() => emergencyExitFitness(many, { maxDrawdown: 100 })).not.toThrow();
    expect(Number.isFinite(emergencyExitFitness(many, { maxDrawdown: 100 }))).toBe(true);
  });
});

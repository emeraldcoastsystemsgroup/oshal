/**
 * Scalar ENSEMBLE entry model — the source trader's second entry generation (ADR-116).
 *
 * His first model (ported in `futures-entry-evaluator.ts`) is unanimous-AND: every enabled indicator
 * must clear its own graded threshold, plus a hard non-excludable Laguerre-oscillator clause. He
 * abandoned that shape, and his own notes say why: with only 2 of 7 indicators enabled for entry and
 * an exit that needs 3 indicators to turn, the early exit can never fire (EntryEnsemble.md:10-11).
 *
 * The replacement, confirmed by him on 2026-07-28 ("This wouldn't require specific indicators to
 * create a signal but would require a minimal score when accumulating all the scalers from the state
 * of each indi"), is a pure score model:
 *
 *   1. Each ENABLED contributor grades to the SAME {−2…+2} scaler the other generations already
 *      compute — ultra-bullish 2, bullish 1, neutral 0, bearish −1, ultra-bearish −2.
 *   2. `score` is their integer sum; `maxPossible` is `enabledCount × 2` — computed from MEMBERSHIP,
 *      never hardcoded. (His prose says "range of (−14, 14) when there are 7 indicators", and the
 *      spec's pseudocode then hardcodes 14; his shipped `CalculateMaxPossibleScore()` counts the
 *      enabled flags and multiplies by 2, and the shipped code is what we port.)
 *   3. Entry fires when `score ≥ thresholdPct% × maxPossible` (long) or `≤ −threshold` (short). NO
 *      single indicator is mandatory — that is the whole point of the model.
 *   4. While in the trade, ensemble STRENGTH is monitored against two protective floors — a share of
 *      the entry score and a share of the running peak — and the position exits at market when
 *      current strength drops below the greater of them. He flags the peak floor as "this is the key"
 *      (EntryEnsemble.md:24).
 *
 * Nine contributors participate, NOT the ten graded states: the adaptive-Laguerre-filter state is
 * absent from his ensemble (ATCEnsembleGen.cs:400-491). The spec doc lists only seven — it predates
 * the LagRSI and wave-pattern additions that the code carries.
 *
 * The confirmation exit is a SIGNAL exit, not a stop: it coexists with the three-layer stop stack
 * rather than replacing it, and in his code it cancels working stop/target orders, exits at market,
 * and returns early so no entry is evaluated on the same bar.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ensemble score over the nine enabled contributors with membership-derived maxPossible, percentage entry threshold, and the per-trade dual-floor confirmation tracker (entry-retention + peak-drawdown, MAX of the two). Ported from NT8Custom ATCEnsembleGen.cs / EntryEnsemble.md for ADR-116.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review blockers: TWO contributors grade differently in his ensemble than in the Export chain the evaluator reuses — DMI requires ADX RISING in both branches, and the Laguerre-filter ±2 upgrade tests an up CLOSE rather than close-above-open + higher high. Added gradeDmiStateEnsemble / gradeLagFilterStateEnsemble (selected per generation by the evaluator); labelled the zero-max entry guard as an NT8 DEVIATION.
 *
 * @module futures-entry-ensemble
 */

import type { GradedStates } from './futures-entry-evaluator';

/**
 * The graded states that contribute to the ensemble score, in his summation order
 * (ATCEnsembleGen.cs:400-491). `adaptiveLagFilter` is deliberately absent — it is graded by the
 * evaluator for the other generations but takes no part in the ensemble.
 */
export const ENSEMBLE_CONTRIBUTORS = [
  'dmi', 'macd', 'mfi', 'lagOsc', 'lagFilter', 'eit', 'superTrend', 'lagRsi', 'wavePattern',
] as const;

/** A contributor key. */
export type EnsembleContributor = typeof ENSEMBLE_CONTRIBUTORS[number];

/** Which contributors are in the ensemble — his `Use*` flags. Omitted keys default to enabled. */
export type EnsembleMembership = Partial<Record<EnsembleContributor, boolean>>;

/** One scored ensemble reading. */
export interface EnsembleScore {
  /** Integer sum of the enabled contributors' {−2…+2} scalers. */
  score: number;
  /** `enabledCount × 2` — the denominator the entry threshold is a percentage OF. */
  maxPossible: number;
  /** Per-contributor scaler for the enabled members (explainability; excludes disabled ones). */
  contributions: Partial<Record<EnsembleContributor, number>>;
}

/**
 * @description The ensemble's DMI grade — which is NOT the Export generation's.
 *
 * His ensemble requires ADX to be **rising** before DMI contributes anything at all
 * (`dmiAdx0 > dmiAdx1 &&` opens BOTH branches, ATCEnsembleGen.cs:402-406); the Export chain has no
 * such term (ATCEntryCountExport.cs:724-728). Reusing Export's grade here scored ±1/±2 on every
 * flat-or-falling-ADX bar where his ensemble scores 0 — a systematic upward bias in |score| that
 * manufactured entries he would never take. Port the difference, do not smooth it away.
 * @param plusDi0 - +DI at this bar.
 * @param minusDi0 - −DI at this bar.
 * @param adx0 - ADX at this bar.
 * @param adx1 - ADX at the prior bar (his prev-NaN→current fallback applies before this call).
 * @returns The scaler in {−2, −1, 0, +1, +2}.
 */
export function gradeDmiStateEnsemble(plusDi0: number, minusDi0: number, adx0: number, adx1: number): number {
  const rising = adx0 > adx1;
  if (rising && plusDi0 > minusDi0) return plusDi0 > adx0 && adx0 > minusDi0 ? 2 : 1;
  if (rising && plusDi0 < minusDi0) return minusDi0 > adx0 && adx0 > plusDi0 ? -2 : -1;
  return 0;
}

/**
 * @description The ensemble's Laguerre-filter grade — also NOT the Export generation's.
 *
 * His ensemble upgrades ±1 → ±2 on a simple up/down CLOSE (`close0 > close1`,
 * ATCEnsembleGen.cs:442-446). Export instead demands close-above-open AND a higher high
 * (`close0 > open0 && high0 > high1`, ATCEntryCountExport.cs:748-754). The two disagree on the
 * ordinary in-trend bar — filter rising, price above it — so the wrong one shifts the score
 * constantly rather than at the margin.
 * @param lagFilter0 - Filter value at this bar.
 * @param lagFilter1 - Filter value at the prior bar.
 * @param close0 - This bar's close.
 * @param close1 - The prior bar's close.
 * @returns The scaler in {−2, −1, 0, +1, +2}.
 */
export function gradeLagFilterStateEnsemble(lagFilter0: number, lagFilter1: number, close0: number, close1: number): number {
  if (lagFilter0 > lagFilter1 && close0 > lagFilter0) return close0 > close1 ? 2 : 1;
  if (lagFilter0 < lagFilter1 && close0 < lagFilter0) return close0 < close1 ? -2 : -1;
  return 0;
}

/**
 * @description Score the ensemble for one bar.
 * @param states - The graded states for this bar (the evaluator computes these).
 * @param membership - Which contributors participate; omitted keys are enabled.
 * @returns The integer score, the membership-derived maximum, and per-contributor scalers.
 */
export function ensembleScore(states: GradedStates, membership: EnsembleMembership = {}): EnsembleScore {
  let score = 0;
  let enabled = 0;
  const contributions: Partial<Record<EnsembleContributor, number>> = {};
  for (const key of ENSEMBLE_CONTRIBUTORS) {
    if (membership[key] === false) continue;
    const v = states[key];
    enabled += 1;
    contributions[key] = v;
    score += v;
  }
  return { score, maxPossible: enabled * 2, contributions };
}

/**
 * @description The entry rule: `score ≥ pct% × maxPossible` goes long, `score ≤ −threshold` goes
 * short. No indicator is mandatory.
 *
 * NT8 DEVIATION (deliberate, labelled): his code has no zero-max guard — with every contributor
 * disabled his threshold is 0 and `score >= 0` fires a LONG on every bar (ATCEnsembleGen.cs:902,
 * :905). An always-long strategy from an empty ensemble is a foot-gun, not a strategy, so this port
 * returns null instead. Remove the first guard clause below to reproduce his artifact.
 * @param scored - The scored ensemble for this bar.
 * @param thresholdPct - Entry threshold as a percent of maxPossible (his default 70; he optimizes 62–78).
 * @returns 'long' | 'short' | null.
 */
export function ensembleEntrySignal(scored: EnsembleScore, thresholdPct: number): 'long' | 'short' | null {
  if (scored.maxPossible <= 0) return null;
  const threshold = (thresholdPct / 100) * scored.maxPossible;
  if (scored.score >= threshold) return 'long';
  if (scored.score <= -threshold) return 'short';
  return null;
}

/** Tuning for {@link createEnsembleConfirmation}. */
export interface EnsembleConfirmationConfig {
  /** Floor as a percent of the ENTRY score (his default 90; range 85–95). */
  retentionPct?: number;
  /** Floor as a percent of the running PEAK score (his default 93; range 90–96 — "this is the key"). */
  drawdownPct?: number;
}

/** One bar's confirmation verdict. */
export interface EnsembleConfirmationVerdict {
  /** True when ensemble strength has degraded below the binding floor — exit at market. */
  exit: boolean;
  /** The binding floor this bar (MAX of the two), NaN while the tracker is inactive. */
  minAllowed: number;
  /** The running peak score in the trade's direction. */
  peak: number;
}

/** Per-trade ensemble-strength monitor. */
export interface EnsembleConfirmation {
  /** Arm on the entry bar with the score that produced the signal. */
  onEntry(entryScore: number, direction: 'long' | 'short'): void;
  /** Advance one bar; returns whether ensemble strength has decayed past its floors. */
  onBar(currentScore: number): EnsembleConfirmationVerdict;
}

/**
 * @description The dual-floor confirmation exit: track the peak score in the trade's direction, and
 * exit when |current| falls below MAX(retentionPct% × |entry|, drawdownPct% × |peak|). Comparison is
 * on ABSOLUTE scores, so longs and shorts are symmetric.
 *
 * Faithful to two of his guards: the tracker stays INACTIVE when the entry score was exactly 0 (his
 * `ensembleStateAtEntry != 0` test, which stops a position from exiting before its ensemble state has
 * been recorded), and the peak is a high-water mark that never retreats.
 * @param config - Floor percentages.
 * @returns A per-trade {@link EnsembleConfirmation}.
 */
export function createEnsembleConfirmation(config: EnsembleConfirmationConfig = {}): EnsembleConfirmation {
  const retentionPct = config.retentionPct ?? 90;
  const drawdownPct = config.drawdownPct ?? 93;
  let entryScore = 0;
  let peak = 0;
  let long = true;
  let armed = false;

  return {
    onEntry(score: number, direction: 'long' | 'short'): void {
      entryScore = score;
      peak = score;
      long = direction === 'long';
      // His `ensembleStateAtEntry != 0` guard: a zero entry score leaves the monitor dormant.
      armed = score !== 0;
    },

    onBar(currentScore: number): EnsembleConfirmationVerdict {
      if (!armed) return { exit: false, minAllowed: Number.NaN, peak };
      peak = long ? Math.max(peak, currentScore) : Math.min(peak, currentScore);
      const minAllowed = Math.max(
        Math.abs(entryScore) * (retentionPct / 100),
        Math.abs(peak) * (drawdownPct / 100),
      );
      return { exit: Math.abs(currentScore) < minAllowed, minAllowed, peak };
    },
  };
}

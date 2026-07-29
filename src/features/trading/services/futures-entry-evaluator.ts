/**
 * Futures entry evaluator — ADR-116 entry port, part 3 of 3.
 *
 * The graded-state entry model shared byte-for-byte by both NT8 strategy generations
 * (ATCEntryCountExport.cs = ten states incl. the wave pattern, Daily LTF filter;
 * ATCEntryCountDynStops.cs = nine states, 240-minute LTF filter with graded thresholds + size
 * weighting). Ported as a per-trade-loop state machine with pure, exported state graders.
 *
 * The rules that make or break parity (all ported, all guarded by tests):
 *  - Threshold 0 EXCLUDES an indicator (its clause short-circuits true); +1 means ≥ +1; +2 means
 *    exactly +2 (states never exceed 2).
 *  - The Laguerre oscillator clause is HARD-CODED — osc > 0 AND rising for longs — with no
 *    parameter to exclude it; the graded lagOscState exists but is never consulted for entry.
 *  - close0 > close1 (long) sits at the SUBMISSION gate, outside the indicator confluence.
 *  - A NaN in any chart indicator skips the whole bar (previousLagOsc NOT updated); NaN
 *    prev-bar values fall back to current values (which structurally fails the hard clause).
 *  - The same-direction re-entry filter: after a long exit, no new long until the oscillator
 *    prints a bar-close cross below zero while flat (latched; opposite direction unaffected).
 *  - The entry window is inclusive at both ends, wraps midnight when start > end, and an
 *    INVALID HHmm makes the window pass-through (not a rejection).
 *  - HARD WARMUP GATES precede everything: no bar is processed (no state updates, no entries)
 *    until the chart series has ≥ chartWarmupBars bars and — when the LTF filter is on — the LTF
 *    series has ≥ ltfWarmupBars bars, exactly the sources' early returns. The LTF filter's
 *    fail-OPEN branch (both directions allowed) applies to NaN VALUES after warmup; in the
 *    DynStops generation that NaN gate includes the LagRSI Average line, and the fail-open path
 *    leaves all three LTF states 0 so the sizing weight hits the ≤0 → full-size guard.
 *  - In the DynStops generation the graded LTF states also weight position size (sign-only
 *    count/3, with the ≤0 → full-size guard).
 *  - There is NO equity-halt latch: the sources' tradingHalted is unreachable on completed-bar
 *    replay (every account-value path returns positive or NaN, and disabled sizing skips
 *    valuation entirely); a bad equity simply produces a zero-quantity non-entry that bar.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ten pure graded-state functions, the entry-window rule, and createEntryEvaluator (confluence + hard LagOsc clause + submission gates + re-entry latch + generation-specific LTF filter + sizing incl. the DynStops LTF weight and the equity-halt latch). Ported from NT8Custom ATCEntryCountExport/ATCEntryCountDynStops for ADR-116.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Third generation 'ensemble' (NT8Custom ATCEnsembleGen.cs): scores the nine participating graded states and enters on a percentage-of-maximum threshold with NO mandatory indicator — the trader's stated direction of travel (2026-07-28). Faithful to his ensemble's absent gates: no up-close submission test and no zero-cross re-entry latch. Every graded bar now carries the ensemble reading (in-position included) so the caller can drive the dual-floor confirmation exit. The two unanimous-AND generations are behaviorally untouched.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review fixes for ensemble parity: adx1 joins the snapshot and the ensemble selects gradeDmiStateEnsemble (ADX must be rising) + gradeLagFilterStateEnsemble (up-close upgrade) — his ATCEnsembleGen grades those two differently than the Export chain; the LTF warmup gate is unconditional for the ensemble whenever an LTF series exists (his is always loaded; running with none at all fails open, a labelled deviation); the ensemble's NaN skip-bar guard drops alf0 (his eleven-value list has no adaptive-filter term).
 *
 * @module futures-entry-evaluator
 */

import type { OhlcvBar } from './market-data';
import { WavePattern } from './futures-wave-tracking';
import {
  ensembleScore, ensembleEntrySignal, gradeDmiStateEnsemble, gradeLagFilterStateEnsemble,
  type EnsembleMembership, type EnsembleScore, type EnsembleConfirmationConfig,
} from './futures-entry-ensemble';

/**
 * Which NT8 strategy generation's variant rules apply.
 *
 * 'export' and 'dynstops' are the two unanimous-AND generations — every enabled indicator must clear
 * its graded threshold AND the hard Laguerre-oscillator clause must hold. 'ensemble' is his newer
 * scalar model: no indicator is mandatory and entry fires on a minimum accumulated score (see
 * futures-entry-ensemble.ts). Parity requirement: adding 'ensemble' must not change what the two
 * older generations do on any bar.
 */
export type EntryGeneration = 'export' | 'dynstops' | 'ensemble';

/** Graded indicator states, each in {−2, −1, 0, +1, +2}. */
export interface GradedStates {
  dmi: number; macd: number; mfi: number; lagOsc: number; lagFilter: number;
  eit: number; superTrend: number; lagRsi: number; wavePattern: number; adaptiveLagFilter: number;
}

/** DMI state: ±2 requires ADX strictly BETWEEN the DI lines (the "ultra" grade). */
export function gradeDmiState(plusDi0: number, minusDi0: number, adx0: number): number {
  if (plusDi0 > minusDi0) return plusDi0 > adx0 && adx0 > minusDi0 ? 2 : 1;
  if (minusDi0 > plusDi0) return minusDi0 > adx0 && adx0 > plusDi0 ? -2 : -1;
  return 0;
}

/** MACD state: above signal → +1, rising too → +2. */
export function gradeMacdState(macd0: number, sig0: number, macd1: number): number {
  if (macd0 > sig0) return macd0 > macd1 ? 2 : 1;
  if (macd0 < sig0) return macd0 < macd1 ? -2 : -1;
  return 0;
}

/** MFI state around the 50 line. */
export function gradeMfiState(mfi0: number, mfi1: number): number {
  if (mfi0 > 50) return mfi0 > mfi1 ? 2 : 1;
  if (mfi0 < 50) return mfi0 < mfi1 ? -2 : -1;
  return 0;
}

/** Laguerre oscillator state (computed for reporting; entry uses the HARD clause instead). */
export function gradeLagOscState(o0: number, o1: number): number {
  if (o0 > 0) return o0 > o1 ? 2 : 1;
  if (o0 < 0) return o0 < o1 ? -2 : -1;
  return 0;
}

/** Laguerre filter state: rising filter + close/open/high confirmations for the ±2 grade. */
export function gradeLagFilterState(lf0: number, lf1: number, bar0: OhlcvBar, bar1: OhlcvBar): number {
  if (lf0 > lf1) return bar0.c > lf0 && bar0.c > bar0.o && bar0.h > bar1.h ? 2 : bar0.c > lf0 ? 1 : 0;
  if (lf0 < lf1) return bar0.c < lf0 && bar0.c < bar0.o && bar0.l < bar1.l ? -2 : bar0.c < lf0 ? -1 : 0;
  return 0;
}

/** Ehlers InstTrend state: trigger above trendline with close beyond trigger. */
export function gradeEitState(trigger0: number, itrend0: number, close0: number, close1: number): number {
  if (trigger0 > itrend0 && close0 > trigger0) return close0 > close1 ? 2 : 1;
  if (trigger0 < itrend0 && close0 < trigger0) return close0 < close1 ? -2 : -1;
  return 0;
}

/** SuperTrend state: whole bar beyond the stop dot; rising dot upgrades to ±2. */
export function gradeSuperTrendState(sd0: number, sd1: number, low0: number, high0: number): number {
  if (low0 > sd0) return sd0 > sd1 ? 2 : 1;
  if (high0 < sd0) return sd0 < sd1 ? -2 : -1;
  return 0;
}

/** Laguerre RSI state on the 0–100 scale — exact-equality saturation grades, overlapping ±1 ORs. */
export function gradeLagRsiState(r0: number, r1: number): number {
  if (r0 === 100) return 2;
  if (r0 === 0) return -2;
  if ((r0 > 30 && r0 > r1) || (r0 >= 70 && r0 < 100)) return 1;
  if ((r0 < 70 && r0 < r1) || (r0 <= 30 && r0 > 0)) return -1;
  return 0;
}

/** Wave-pattern state (Export generation only) from the Laguerre wave-stops pattern pair. */
export function gradeWavePatternState(bull: WavePattern, bear: WavePattern): number {
  if (bull === WavePattern.HL && bear === WavePattern.HH) return 2;
  if (bull === WavePattern.NHL && bear === WavePattern.HH) return 1;
  if (bull === WavePattern.LL && bear === WavePattern.LH) return -2;
  if (bull === WavePattern.LL && bear === WavePattern.NLH) return -1;
  return 0;
}

/** Adaptive Laguerre filter state: needs the persistent lastMove direction (±1, 0 until first move). */
export function gradeAdaptiveLagFilterState(alf0: number, alf1: number, close0: number, lastMove: number): number {
  if (lastMove === 1 && alf0 > alf1 && close0 > alf0) return 2;
  if (lastMove === 1 && alf0 === alf1 && close0 > alf0) return 1;
  if (lastMove === -1 && alf0 < alf1 && close0 < alf0) return -2;
  if (lastMove === -1 && alf0 === alf1 && close0 < alf0) return -1;
  return 0;
}

/** Parse an HHmm int to minutes-of-day, or null when invalid (source: invalid → window passes). */
function parseHhmm(hhmm: number): number | null {
  if (!Number.isInteger(hhmm) || hhmm < 0 || hhmm > 2359) return null;
  const h = Math.floor(hhmm / 100); const m = hhmm % 100;
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/**
 * @description The entry-window rule: inclusive at both ends, wraps midnight when start > end,
 * and an invalid HHmm on either side makes the window pass-through (all entries allowed) —
 * exactly the source's TryParseHHMM / IsWithinEntryWindow pair.
 * @param startHhmm - e.g. 930. @param endHhmm - e.g. 1545.
 * @param timeOfDayMinutes - The closed bar's close time as minutes since midnight.
 * @returns Whether entries are allowed at this bar.
 */
export function isWithinEntryWindow(startHhmm: number, endHhmm: number, timeOfDayMinutes: number): boolean {
  const start = parseHhmm(startHhmm); const end = parseHhmm(endHhmm);
  if (start == null || end == null) return true;
  if (start <= end) return timeOfDayMinutes >= start && timeOfDayMinutes <= end;
  return timeOfDayMinutes >= start || timeOfDayMinutes <= end;
}

/** Per-indicator entry thresholds (0 = excluded). Defaults: every long +1, every short −1. */
export interface EntryThresholds {
  dmiLong: number; dmiShort: number; macdLong: number; macdShort: number;
  mfiLong: number; mfiShort: number; lagFilterLong: number; lagFilterShort: number;
  eitLong: number; eitShort: number; superTrendLong: number; superTrendShort: number;
  lagRsiLong: number; lagRsiShort: number; wavePatternLong: number; wavePatternShort: number;
  adaptiveLagFilterLong: number; adaptiveLagFilterShort: number;
}

/** DynStops LTF thresholds (0 = excluded from the gate; still counted in the size weight). */
export interface LtfThresholds {
  superTrendLong: number; superTrendShort: number;
  lagOscLong: number; lagOscShort: number;
  lagRsiLong: number; lagRsiShort: number;
}

/** Evaluator configuration; defaults mirror both generations' shipped SetDefaults. */
export interface EntryEvaluatorConfig {
  generation: EntryGeneration;
  tickSize: number;
  /** Instrument point value (dollars per point per contract) for sizing. */
  pointValue: number;
  thresholds?: Partial<EntryThresholds>;
  ltfThresholds?: Partial<LtfThresholds>;
  entryWindowStartHhmm?: number;
  entryWindowEndHhmm?: number;
  allowLong?: boolean;
  allowShort?: boolean;
  useLtfTrendFilter?: boolean;
  riskPerTradePercent?: number;
  maxPositionSize?: number;
  /** DynStops-only: weight size by favorable LTF state count / 3 (sign-only, ≤0 → 1.0). */
  weightPosSizeOnLtfIndis?: boolean;
  disableSizing?: boolean;
  /** Chart-series warmup gate — the sources' LaguerreRmsLength early return (default 30 bars). */
  chartWarmupBars?: number;
  /** LTF-series warmup gate when the LTF filter is on — max(10, LaguerrePeriod) (default 30 bars). */
  ltfWarmupBars?: number;
  /**
   * `generation: 'ensemble'` only — which contributors are in the ensemble (his `Use*` flags).
   * Omitted keys are enabled, so the default is all nine. Ignored by the other generations.
   */
  ensembleMembership?: EnsembleMembership;
  /**
   * `generation: 'ensemble'` only — entry threshold as a percent of the membership-derived maximum
   * (his default 70; he optimizes 62–78). Ignored by the other generations.
   */
  ensembleEntryThresholdPct?: number;
  /**
   * `generation: 'ensemble'` only — the dual-floor confirmation-exit percentages. The evaluator does
   * not act on these (it never closes positions); it carries them so the whole ensemble policy is one
   * config object, and the CALLER that owns exits drives {@link createEnsembleConfirmation} with them.
   */
  ensembleConfirmation?: EnsembleConfirmationConfig;
}

/** Chart-side indicator values at the evaluated bar (current and prior where the rules need them). */
export interface ChartIndicatorSnapshot {
  plusDi0: number; minusDi0: number; adx0: number;
  /**
   * ADX at the prior bar — read ONLY by the ensemble generation, whose DMI grade requires ADX to be
   * RISING before DMI contributes anything (ATCEnsembleGen.cs:402-406; the Export chain has no such
   * term). NaN/omitted falls back to adx0 (his prev-NaN cache behavior), which reads as not-rising.
   */
  adx1?: number;
  macd0: number; macdAvg0: number; macd1: number;
  mfi0: number; mfi1: number;
  lagOsc0: number; lagOsc1: number;
  lagFilter0: number; lagFilter1: number;
  eitTrigger0: number; eitTrend0: number;
  stStopDot0: number; stStopDot1: number;
  lagRsi0: number; lagRsi1: number;
  alf0: number; alf1: number;
  /** Export generation only — the Laguerre wave-stops pattern pair. */
  bullWavePat?: WavePattern; bearWavePat?: WavePattern;
}

/** Latest completed LTF-bar values as of this chart bar; null = fail-open (both directions allowed). */
export interface LtfSnapshot {
  close: number; low: number; high: number;
  stopDot: number; stopDotPrev: number;
  lagOsc: number; lagOscPrev: number;
  /** DynStops only — the LTF Laguerre RSI AVERAGE line (not LaRSI itself). */
  lagRsiAvg?: number; lagRsiAvgPrev?: number;
}

/** One bar's evaluation context. */
export interface EntryBarContext {
  bar: OhlcvBar; prevBar: OhlcvBar;
  /** 0-based index of this completed chart bar (the source's CurrentBars[CHART_TF]). */
  chartBarNumber: number;
  /** 0-based index of the latest completed LTF bar; undefined = none yet (gates when the filter is on). */
  ltfBarNumber?: number;
  /** Closed bar's close time as minutes since midnight (exchange local). */
  timeOfDayMinutes: number;
  indicators: ChartIndicatorSnapshot;
  ltf: LtfSnapshot | null;
  /** Whether a position is open (entries evaluate only when flat). */
  flat: boolean;
  /** Account equity for sizing + the halt latch. */
  equity: number;
  /** Estimated initial stop for each side (from the stop-engine resolver); NaN skips that side. */
  estimatedStopLong?: number;
  estimatedStopShort?: number;
}

/** The evaluator's per-bar decision. */
export interface EntryDecision {
  signal: 'long' | 'short' | null;
  /** Contracts to submit (≥1 when signal set; 0 with a signal never happens — it becomes null). */
  quantity: number;
  states: GradedStates | null;
  ltfBullish: boolean; ltfBearish: boolean;
  /** True when the NaN guard skipped the whole bar. */
  skippedBar: boolean;
  /** Why no signal (diagnostic). */
  reasons: string[];
  /**
   * `generation: 'ensemble'` only — the bar's ensemble reading. Present whenever states were graded,
   * so a caller can drive the dual-floor confirmation exit (which needs the score EVERY bar, not
   * just on entry bars) and report why a trade opened. Undefined for the other generations.
   */
  ensemble?: EnsembleScore;
}

/** The per-run entry evaluator (holds the re-entry latch, halt latch, and lastMove state). */
export interface FuturesEntryEvaluator {
  evaluate(ctx: EntryBarContext): EntryDecision;
  /** Report a position close so the same-direction re-entry filter arms. */
  onPositionClosed(direction: 'long' | 'short'): void;
}

const DEFAULT_THRESHOLDS: EntryThresholds = {
  dmiLong: 1, dmiShort: -1, macdLong: 1, macdShort: -1, mfiLong: 1, mfiShort: -1,
  lagFilterLong: 1, lagFilterShort: -1, eitLong: 1, eitShort: -1, superTrendLong: 1, superTrendShort: -1,
  lagRsiLong: 1, lagRsiShort: -1, wavePatternLong: 1, wavePatternShort: -1,
  adaptiveLagFilterLong: 1, adaptiveLagFilterShort: -1,
};

const DEFAULT_LTF: LtfThresholds = {
  superTrendLong: 1, superTrendShort: -1, lagOscLong: 1, lagOscShort: -1, lagRsiLong: 1, lagRsiShort: -1,
};

/** pass = threshold 0 (excluded) or state meets it (≥ for longs, ≤ for shorts). */
const meetsLong = (state: number, threshold: number) => threshold === 0 || state >= threshold;
const meetsShort = (state: number, threshold: number) => threshold === 0 || state <= threshold;

/**
 * @description Creates the entry evaluator (see module doc for the ported rules). Pure decision
 * logic: the caller owns bars, indicator series, position state, and order submission; the
 * evaluator owns the graded confluence, the hard oscillator clause, the window, the re-entry
 * latch, the LTF gate, sizing, and the equity-halt latch.
 * @param config - Generation + thresholds + sizing parameters.
 * @returns A {@link FuturesEntryEvaluator}.
 */
export function createFuturesEntryEvaluator(config: EntryEvaluatorConfig): FuturesEntryEvaluator {
  const cfg = {
    entryWindowStartHhmm: 930, entryWindowEndHhmm: 1545,
    allowLong: true, allowShort: true, useLtfTrendFilter: true,
    riskPerTradePercent: 2.0, maxPositionSize: 0, weightPosSizeOnLtfIndis: true, disableSizing: false,
    chartWarmupBars: 30, ltfWarmupBars: 30,
    ensembleEntryThresholdPct: 70,
    ...config,
    thresholds: { ...DEFAULT_THRESHOLDS, ...config.thresholds },
    ltfThresholds: { ...DEFAULT_LTF, ...config.ltfThresholds },
  };
  let previousLagOsc = NaN;
  let crossedBelowZero = false;
  let crossedAboveZero = false;
  let lastTradeDirection: 'long' | 'short' | null = null;
  let lastMoveAlf = 0;

  /** LTF gate per generation; fail-open on missing data. Returns graded LTF states for sizing. */
  function ltfFilter(ltf: LtfSnapshot | null): { bullish: boolean; bearish: boolean; states: [number, number, number] } {
    if (!cfg.useLtfTrendFilter || ltf == null) return { bullish: true, bearish: true, states: [0, 0, 0] };
    // NaN-value fail-open — in the DynStops generation the gate includes the LagRSI Average line
    // (its NaN sends the source to the fail-open branch, NOT to a 0-graded rsi state).
    const gateValues = cfg.generation === 'dynstops'
      ? [ltf.close, ltf.stopDot, ltf.lagOsc, ltf.lagRsiAvg]
      : [ltf.close, ltf.stopDot, ltf.lagOsc];
    if (gateValues.some((v) => v == null || Number.isNaN(v))) {
      return { bullish: true, bearish: true, states: [0, 0, 0] };
    }
    // The Export generation's BINARY rule — and the ensemble's too: ATCEnsembleGen.cs:291-292
    // computes `closeLTF0 > superTrendLTF0 && lagOscLTF0 > 0`, the same two-term test, NOT the
    // DynStops graded gate. Only DynStops grades its LTF states.
    if (cfg.generation === 'export' || cfg.generation === 'ensemble') {
      return {
        bullish: ltf.close > ltf.stopDot && ltf.lagOsc > 0,
        bearish: ltf.close < ltf.stopDot && ltf.lagOsc < 0,
        states: [0, 0, 0],
      };
    }
    const sdPrev = Number.isNaN(ltf.stopDotPrev) ? ltf.stopDot : ltf.stopDotPrev;
    const oscPrev = Number.isNaN(ltf.lagOscPrev) ? ltf.lagOsc : ltf.lagOscPrev;
    const st = ltf.low > ltf.stopDot ? (ltf.stopDot > sdPrev ? 2 : 1) : ltf.high < ltf.stopDot ? (ltf.stopDot < sdPrev ? -2 : -1) : 0;
    const osc = ltf.lagOsc > 0 ? (ltf.lagOsc > oscPrev ? 2 : 1) : ltf.lagOsc < 0 ? (ltf.lagOsc < oscPrev ? -2 : -1) : 0;
    const a0 = ltf.lagRsiAvg as number; // gate above guarantees non-NaN in this generation
    const a1raw = ltf.lagRsiAvgPrev;
    const a1 = a1raw == null || Number.isNaN(a1raw) ? a0 : a1raw; // prev-NaN → current fallback
    const rsi = a0 > a1 && a0 > 20 ? 1 : a0 < a1 && a0 < 80 ? -1 : 0;
    const t = cfg.ltfThresholds;
    return {
      bullish: meetsLong(st, t.superTrendLong) && meetsLong(osc, t.lagOscLong) && meetsLong(rsi, t.lagRsiLong),
      bearish: meetsShort(st, t.superTrendShort) && meetsShort(osc, t.lagOscShort) && meetsShort(rsi, t.lagRsiShort),
      states: [osc, rsi, st],
    };
  }

  /** Sizing per generation; returns contracts (0 = no trade). */
  function sizeEntry(direction: 'long' | 'short', ctx: EntryBarContext, ltfStates: [number, number, number]): number {
    if (cfg.disableSizing) return 1;
    const estStop = direction === 'long' ? ctx.estimatedStopLong : ctx.estimatedStopShort;
    if (estStop == null || Number.isNaN(estStop)) return 0;
    const APPROX = 1e-9; // NT8 ApproxCompare tolerance at the sizing boundaries
    const riskPerUnit = Math.abs(ctx.bar.c - estStop);
    if (Number.isNaN(riskPerUnit) || riskPerUnit - cfg.tickSize < -APPROX) return 0;
    if (Number.isNaN(ctx.equity) || ctx.equity <= APPROX) return 0;
    const riskAmount = (cfg.riskPerTradePercent / 100) * ctx.equity;
    const dollarRisk = riskPerUnit * cfg.pointValue;
    if (riskAmount <= 0 || dollarRisk <= 0) return 0;
    let qty: number;
    if (cfg.generation === 'dynstops' && cfg.weightPosSizeOnLtfIndis) {
      const favorable = ltfStates.filter((s) => (direction === 'long' ? s > 0 : s < 0)).length;
      let weight = favorable / 3;
      if (weight <= 0) weight = 1.0; // the source's guard: never wipe a valid entry to zero size
      qty = Math.floor((riskAmount / dollarRisk) * weight);
    } else {
      qty = Math.floor(riskAmount / dollarRisk);
    }
    if (cfg.maxPositionSize > 0) qty = Math.min(qty, cfg.maxPositionSize);
    return qty;
  }

  function computeStates(ctx: EntryBarContext): GradedStates {
    const s = ctx.indicators;
    // Prev-bar NaN → current-value fallback (the source's cache behavior).
    const macd1 = Number.isNaN(s.macd1) ? s.macd0 : s.macd1;
    const mfi1 = Number.isNaN(s.mfi1) ? s.mfi0 : s.mfi1;
    const lagOsc1 = Number.isNaN(s.lagOsc1) ? s.lagOsc0 : s.lagOsc1;
    const lagRsi1 = Number.isNaN(s.lagRsi1) ? s.lagRsi0 : s.lagRsi1;
    const alf1 = Number.isNaN(s.alf1) ? s.alf0 : s.alf1;
    const sd1 = Number.isNaN(s.stStopDot1) ? s.stStopDot0 : s.stStopDot1;
    // Two contributors grade DIFFERENTLY in his ensemble strategy than in the Export chain the
    // other generations use (reviewer-caught parity break): DMI needs ADX rising, and the Laguerre
    // filter upgrades on an up close instead of close-above-open + higher high. The other seven are
    // character-for-character identical across his strategies.
    const isEnsemble = cfg.generation === 'ensemble';
    const adx1 = s.adx1 == null || Number.isNaN(s.adx1) ? s.adx0 : s.adx1;
    return {
      dmi: isEnsemble
        ? gradeDmiStateEnsemble(s.plusDi0, s.minusDi0, s.adx0, adx1)
        : gradeDmiState(s.plusDi0, s.minusDi0, s.adx0),
      macd: gradeMacdState(s.macd0, s.macdAvg0, macd1),
      mfi: gradeMfiState(s.mfi0, mfi1),
      lagOsc: gradeLagOscState(s.lagOsc0, lagOsc1),
      lagFilter: isEnsemble
        ? gradeLagFilterStateEnsemble(s.lagFilter0, s.lagFilter1, ctx.bar.c, ctx.prevBar.c)
        : gradeLagFilterState(s.lagFilter0, s.lagFilter1, ctx.bar, ctx.prevBar),
      eit: gradeEitState(s.eitTrigger0, s.eitTrend0, ctx.bar.c, ctx.prevBar.c),
      superTrend: gradeSuperTrendState(s.stStopDot0, sd1, ctx.bar.l, ctx.bar.h),
      lagRsi: gradeLagRsiState(s.lagRsi0, lagRsi1),
      wavePattern: gradeWavePatternState(s.bullWavePat ?? WavePattern.None, s.bearWavePat ?? WavePattern.None),
      adaptiveLagFilter: gradeAdaptiveLagFilterState(s.alf0, alf1, ctx.bar.c, lastMoveAlf),
    };
  }

  /**
   * The ensemble generation's decision: a pure score test, no mandatory indicator. Returns the
   * scored reading alongside the verdict so the caller can drive the confirmation exit.
   */
  function ensembleConfluence(states: GradedStates): { long: boolean; short: boolean; scored: EnsembleScore } {
    const scored = ensembleScore(states, cfg.ensembleMembership);
    const signal = ensembleEntrySignal(scored, cfg.ensembleEntryThresholdPct);
    return { long: signal === 'long', short: signal === 'short', scored };
  }

  function confluence(states: GradedStates, ctx: EntryBarContext): { long: boolean; short: boolean } {
    const t = cfg.thresholds;
    const s = ctx.indicators;
    const lagOsc1 = Number.isNaN(s.lagOsc1) ? s.lagOsc0 : s.lagOsc1;
    const hardLong = !Number.isNaN(s.lagOsc0) && !Number.isNaN(lagOsc1) && s.lagOsc0 > 0 && s.lagOsc0 > lagOsc1;
    const hardShort = !Number.isNaN(s.lagOsc0) && !Number.isNaN(lagOsc1) && s.lagOsc0 < 0 && s.lagOsc0 < lagOsc1;
    const waveLong = cfg.generation === 'export' ? meetsLong(states.wavePattern, t.wavePatternLong) : true;
    const waveShort = cfg.generation === 'export' ? meetsShort(states.wavePattern, t.wavePatternShort) : true;
    return {
      long: meetsLong(states.dmi, t.dmiLong) && meetsLong(states.macd, t.macdLong) && meetsLong(states.mfi, t.mfiLong)
        && hardLong && meetsLong(states.lagFilter, t.lagFilterLong) && meetsLong(states.eit, t.eitLong)
        && meetsLong(states.superTrend, t.superTrendLong) && meetsLong(states.lagRsi, t.lagRsiLong)
        && waveLong && meetsLong(states.adaptiveLagFilter, t.adaptiveLagFilterLong),
      short: meetsShort(states.dmi, t.dmiShort) && meetsShort(states.macd, t.macdShort) && meetsShort(states.mfi, t.mfiShort)
        && hardShort && meetsShort(states.lagFilter, t.lagFilterShort) && meetsShort(states.eit, t.eitShort)
        && meetsShort(states.superTrend, t.superTrendShort) && meetsShort(states.lagRsi, t.lagRsiShort)
        && waveShort && meetsShort(states.adaptiveLagFilter, t.adaptiveLagFilterShort),
    };
  }

  return {
    evaluate(ctx: EntryBarContext): EntryDecision {
      const none = (reasons: string[], states: GradedStates | null = null, skipped = false, ltfB = true, ltfS = true): EntryDecision =>
        ({ signal: null, quantity: 0, states, ltfBullish: ltfB, ltfBearish: ltfS, skippedBar: skipped, reasons });
      const s = ctx.indicators;
      // The HARD warmup gates — the sources return before ANY processing (no state updates,
      // no latches, no previousLagOsc) until both series are seasoned. The two older generations
      // gate the LTF only when the filter is ON (ATCEntryCountExport.cs:462); his ensemble gates it
      // UNCONDITIONALLY because its LTF series is always loaded ("it's always loaded now",
      // ATCEnsembleGen.cs:271-276) — so the ensemble applies the gate whenever an LTF series is
      // actually present. NT8 DEVIATION: an ensemble run with NO LTF series at all (a state his
      // code cannot be in) fails open rather than gating forever.
      if (ctx.chartBarNumber < cfg.chartWarmupBars) return none(['chart-warmup'], null, true);
      const ltfGated = cfg.useLtfTrendFilter || (cfg.generation === 'ensemble' && ctx.ltfBarNumber != null);
      if (ltfGated && (ctx.ltfBarNumber == null || ctx.ltfBarNumber < cfg.ltfWarmupBars)) {
        return none(['ltf-warmup'], null, true);
      }
      // The NaN skip-bar guard — previousLagOsc deliberately NOT updated on skipped bars. His
      // ensemble's guard lists eleven values with NO adaptive-filter term (the indicator does not
      // exist in that strategy), so the ensemble generation drops alf0 from the set.
      const nanGuard = [s.plusDi0, s.minusDi0, s.macd0, s.macdAvg0, s.mfi0, s.lagOsc0, s.lagFilter0,
        s.eitTrigger0, s.eitTrend0, s.stStopDot0, s.lagRsi0,
        ...(cfg.generation === 'ensemble' ? [] : [s.alf0])];
      if (nanGuard.some((v) => Number.isNaN(v))) return none(['nan-skip-bar'], null, true);
      // lastMove update precedes state grading (source order).
      const alf1 = Number.isNaN(s.alf1) ? s.alf0 : s.alf1;
      if (s.alf0 > alf1) lastMoveAlf = 1; else if (s.alf0 < alf1) lastMoveAlf = -1;
      // Zero-cross latches: only while flat, only with both values real.
      if (ctx.flat && !Number.isNaN(previousLagOsc) && !Number.isNaN(s.lagOsc0)) {
        if (previousLagOsc >= 0 && s.lagOsc0 < 0) crossedBelowZero = true;
        if (previousLagOsc <= 0 && s.lagOsc0 > 0) crossedAboveZero = true;
      }
      previousLagOsc = s.lagOsc0;
      const states = computeStates(ctx);
      const ltf = ltfFilter(ctx.ltf);
      const isEnsemble = cfg.generation === 'ensemble';
      // The ensemble reading is attached on EVERY graded bar, in-position included: the dual-floor
      // confirmation exit needs the current score each bar, not only on entry bars.
      const ens = isEnsemble ? ensembleConfluence(states) : null;
      const withEns = (d: EntryDecision): EntryDecision => (ens ? { ...d, ensemble: ens.scored } : d);
      if (!ctx.flat) return withEns(none(['in-position'], states, false, ltf.bullish, ltf.bearish));
      if (!isWithinEntryWindow(cfg.entryWindowStartHhmm, cfg.entryWindowEndHhmm, ctx.timeOfDayMinutes)) {
        return withEns(none(['outside-window'], states, false, ltf.bullish, ltf.bearish));
      }
      const cond = ens ?? confluence(states, ctx);
      // Three gates belong to the unanimous-AND generations ONLY — his ATCEnsembleGen has no
      // up-close submission test and no zero-cross re-entry latch (it gates on a session-close
      // cutoff instead of a fixed window, which a caller reproduces via a pass-through window).
      const upCloseLong = isEnsemble || ctx.bar.c > ctx.prevBar.c;
      const upCloseShort = isEnsemble || ctx.bar.c < ctx.prevBar.c;
      const reentryLongOk = isEnsemble || !(lastTradeDirection === 'long' && !crossedBelowZero);
      const reentryShortOk = isEnsemble || !(lastTradeDirection === 'short' && !crossedAboveZero);
      const reasons: string[] = [];
      if (cond.long && upCloseLong && cfg.allowLong && ltf.bullish && reentryLongOk) {
        const qty = sizeEntry('long', ctx, ltf.states);
        if (qty >= 1) return withEns({ signal: 'long', quantity: qty, states, ltfBullish: ltf.bullish, ltfBearish: ltf.bearish, skippedBar: false, reasons });
        reasons.push('long-qty-zero');
      }
      if (cond.short && upCloseShort && cfg.allowShort && ltf.bearish && reentryShortOk) {
        const qty = sizeEntry('short', ctx, ltf.states);
        if (qty >= 1) return withEns({ signal: 'short', quantity: qty, states, ltfBullish: ltf.bullish, ltfBearish: ltf.bearish, skippedBar: false, reasons });
        reasons.push('short-qty-zero');
      }
      if (!reasons.length) reasons.push(isEnsemble ? 'ensemble-below-threshold' : 'no-confluence');
      return withEns(none(reasons, states, false, ltf.bullish, ltf.bearish));
    },

    onPositionClosed(direction: 'long' | 'short'): void {
      lastTradeDirection = direction;
      if (direction === 'long') crossedBelowZero = false;
      else crossedAboveZero = false;
    },
  };
}

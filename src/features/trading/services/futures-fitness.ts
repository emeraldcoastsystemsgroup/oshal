/**
 * Futures optimization fitness functions — ADR-116, the trader's own objectives.
 *
 * A faithful port of the nine NinjaTrader 8 `OptimizationFitness` classes the trader optimizes his
 * ATC strategies against (`OptimizationFitnesses/ATC*.cs`). In NT8 each class implements
 * `OnCalculatePerformanceValue` and sets one scalar `Value` that the optimizer MAXIMIZES; each is a
 * pure function of the closed-trade list plus a couple of account-level aggregates. Here they are
 * plain functions over a {@link FitnessTrade}[] so oshal's futures backtester can rank parameter
 * sets by the SAME objective the trader's optimizer used — without that, our "best" parameters and
 * his "best" parameters are answers to different questions.
 *
 * PARITY IS THE REQUIREMENT, NOT CORRECTNESS. Several of these objectives contain documented
 * oddities. They are reproduced deliberately and must not be "fixed" — changing any of them
 * re-ranks the trader's shipped parameter sets and silently breaks comparability:
 *
 *  1. {@link trailingStopFitness} — `mfeCapture` and `runupRetention` are the IDENTICAL formula
 *     (`P / MFE`) summed under two weights, so one quantity carries an effective weight of 1.8.
 *  2. {@link emergencyExitFitness} — penalizes `|worstTrade|`, so a strategy whose worst trade is a
 *     big WINNER is penalized by the size of that win.
 *  3. {@link positionSizingFitness} — uses the trade COUNT as the day count when annualizing
 *     (`netProfit / max(1, N) * 252`), and defines `ulcerIndex` as plain `|maxDD|`, not a real
 *     Ulcer Index.
 *  4. The two 5% MAE-tail computations round DIFFERENTLY: {@link stopLossMaeFitness} uses C#
 *     `Math.Round` (banker's / half-to-even — see {@link bankersRound}) while
 *     {@link emergencyExitFitness} uses `(int)` truncation. At 50 trades that is 2 vs 2, at 30
 *     trades 2 vs 1 — and JS `Math.round` matches NEITHER (it would give 3 at 50 trades).
 *  5. Empty-trade sentinels differ ON PURPOSE: most return `-Infinity`,
 *     {@link maxAvgMfeMinAvgMae} returns `NaN`, and {@link maxNetProfitMinTrades} returns its
 *     `-1e10` gate sentinel. Optimizer ranking depends on the distinction.
 *
 * Source: NT8-entry-extraction-2026-07-27.md, section "OptimizationFitnesses (9 .cs files)".
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — port of the nine NT8 OptimizationFitness objectives as pure functions over a closed-trade list: maxAvgMfeMinAvgMae (percent-basis ratio), entryLogicFitness, stopLossMaeFitness (banker's-rounded MAE tail), trailingStopFitness (the duplicated P/MFE weight), targetOrderFitness, emergencyExitFitness (truncated MAE tail, all-penalty), positionSizingFitness (trade-count day proxy), maxNetProfitMinTrades (NaN-before-gate, -1e10 sentinel), plus the FITNESS_FUNCTIONS registry and the C# half-to-even bankersRound helper. Quirks reproduced as-written for optimizer parity.
 *
 * @module futures-fitness
 */

/**
 * One closed trade, reduced to exactly what the nine NT8 fitness objectives read.
 *
 * Currency fields mirror NT8's `Trade.ProfitCurrency` / `MfeCurrency` / `MaeCurrency`; the percent
 * pair mirrors `Percent.AverageMfe` / `Percent.AverageMae` inputs, which only
 * {@link maxAvgMfeMinAvgMae} consumes.
 */
export interface FitnessTrade {
  /** Signed realized P/L in currency. Negative = loss, exactly 0 = breakeven (neither winner nor loser). */
  profit: number;
  /** Maximum favorable excursion in currency. Trades with `mfe <= 0` are skipped by the MFE-ratio fitnesses. */
  mfe: number;
  /**
   * Maximum adverse excursion in currency, as a POSITIVE MAGNITUDE. The C# source wraps every MAE
   * read in `Math.Abs`, so pass |MAE| — a negative value here would flip the tail penalties' sign.
   */
  mae: number;
  /** Maximum favorable excursion on a PERCENT basis (percent-of-entry, e.g. `1.5` = 1.5%). */
  mfePct: number;
  /** Maximum adverse excursion on a PERCENT basis, again a POSITIVE MAGNITUDE (same |·| convention as {@link FitnessTrade.mae}). */
  maePct: number;
  /**
   * Name of the exit execution: 'LongStop' | 'ShortStop' | 'LongTarget1' | 'ShortTarget1' |
   * 'TimedExit' | 'EarlyExit', or null when the exit is unlabeled. Matched by CASE-SENSITIVE
   * SUBSTRING ('Stop' / 'Target'), so a timed or early exit counts as neither a stop nor a target.
   */
  exitName: string | null;
}

/**
 * Account-level aggregates the closed-trade list cannot supply on its own.
 *
 * Only the drawdown-aware objectives ({@link emergencyExitFitness}, {@link positionSizingFitness})
 * read this; the others ignore it. Omitting it is equivalent to a zero drawdown.
 */
export interface FitnessAggregates {
  /**
   * Peak-to-trough account drawdown in currency (NT8 `Currency.Drawdown` over AllTrades), carried
   * as a POSITIVE MAGNITUDE.
   *
   * CONVENTION NOTE (the one judgement call in this port): the C# source wraps `maxDD` in
   * `Math.Abs` everywhere EXCEPT the catastrophic-loss flag, which reads literally
   * `worstTrade < -maxDD * 0.5`. With a positive magnitude that means "the worst single trade lost
   * more than half of the whole max drawdown", which is plainly the intent. Had we carried maxDD as
   * a NEGATIVE number (NT8's convention in some fields), `-maxDD * 0.5` would be positive and the
   * flag would fire for nearly every strategy. We pick the positive-magnitude convention and keep
   * the formula literal — see {@link emergencyExitFitness}. A caller reading NT8's signed field
   * directly must abs() it HERE, at the ingestion boundary, never inside the formula.
   */
  maxDrawdown: number;
  /**
   * Net profit in currency, NET OF COMMISSION (NT8 `TradesPerformance.NetProfit`) — a different
   * aggregate from `Currency.CumProfit`, which is the raw sum of per-trade profit. Only
   * {@link maxNetProfitMinTrades} distinguishes them; supply this whenever commission lives
   * outside `FitnessTrade.profit`, or the gate ranks a commissioned book too generously.
   * Omitted → falls back to the trade sum.
   */
  netProfit?: number;
}

/** The uniform shape every fitness exposes, so the registry can hold them side by side. */
export type FitnessFunction = (trades: FitnessTrade[], agg?: FitnessAggregates) => number;

/**
 * @description Arithmetic mean. Returns NaN for an empty list (0/0) — which is load-bearing:
 * {@link maxAvgMfeMinAvgMae}'s empty-trade sentinel IS that NaN, matching the C# behavior where the
 * percent aggregates come back non-finite with no trades.
 * @param xs - The values to average.
 * @returns The mean, or NaN when `xs` is empty.
 */
function mean(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

/**
 * @description Mean of the LAST `count` elements of an ascending-sorted list — i.e. the largest
 * `count` values. Both MAE-tail penalties want the worst excursions, and both reach them by sorting
 * ascending and averaging the tail.
 * @param sortedAsc - Values already sorted ascending.
 * @param count - How many trailing elements to average (callers clamp this to >= 1).
 * @returns The mean of the tail slice.
 */
function tailMean(sortedAsc: number[], count: number): number {
  return mean(sortedAsc.slice(sortedAsc.length - count));
}

/**
 * @description C# `Math.Round(double)` — banker's rounding, half-to-EVEN. Required because
 * {@link stopLossMaeFitness}'s 5% tail count comes from `Math.Round(n * 0.05)` in the C# source and
 * JS `Math.round` rounds halves AWAY from zero, which changes the tail size at common trade counts:
 * 50 trades → `2.5` → 2 here vs 3 with `Math.round`; 90 trades → `4.5` → 4 here vs 5.
 * ({@link emergencyExitFitness} deliberately does NOT use this — its C# source casts to `(int)`,
 * which truncates. The two fitnesses genuinely disagree; see the module doc.)
 * @param value - The value to round.
 * @returns `value` rounded to the nearest integer, ties going to the even neighbor (0.5→0, 1.5→2, 2.5→2, −1.5→−2).
 */
export function bankersRound(value: number): number {
  const floor = Math.floor(value);
  const frac = value - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Sum of signed P/L over the trade list — NT8's `Currency.CumProfit`. */
function cumProfit(trades: FitnessTrade[]): number {
  let total = 0;
  for (const t of trades) total += t.profit;
  return total;
}

/** Case-sensitive substring test on the exit label, null-safe (the C# `Exit.Name.Contains(...)`). */
function exitNameHas(trade: FitnessTrade, needle: string): boolean {
  return trade.exitName != null && trade.exitName.includes(needle);
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 1) ATCMaxAvgMfeMinAvgMae — "ATC MaxAvgMfe / MinAvgMae"
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/**
 * @description Ratio of average favorable to average adverse excursion, on a PERCENT basis (the
 * only fitness of the nine that reads percent rather than currency — it is measuring trade shape,
 * so instrument tick value must not enter). Non-finite inputs collapse to NaN rather than to a
 * ranking-poisoning ±Infinity, and a zero average MAE degenerates to the raw average MFE instead of
 * dividing by zero. The C# guard is `avgMae <= double.Epsilon`, and C#'s `double.Epsilon` is
 * 4.94e-324 (the smallest denormal), NOT JS `Number.EPSILON` (2.22e-16) — so the guard means
 * literally "avgMae <= 0" and is ported that way; using `Number.EPSILON` would change behavior for
 * tiny-but-real MAE averages.
 * @param trades - Closed trades; `mfePct` / `maePct` are read, `maePct` as a positive magnitude.
 * @param agg - Unused by this fitness (accepted so every objective shares one call shape).
 * @returns avgMfe% / avgMae%, or avgMfe% when avgMae% <= 0, or NaN when either mean is non-finite (including the empty-trade case — this fitness's sentinel is NaN, not -Infinity).
 */
export function maxAvgMfeMinAvgMae(trades: FitnessTrade[], agg?: FitnessAggregates): number {
  void agg;
  const avgMfe = mean(trades.map((t) => t.mfePct));
  // abs() to match every currency-MAE read in this file and the spec's "always wrap in abs()".
  // Without it a caller feeding NT8's SIGNED MaePercent silently takes the avgMae<=0 fallback and
  // gets a plausible-looking but wrong number instead of an obviously wrong negative ratio.
  const avgMae = mean(trades.map((t) => Math.abs(t.maePct)));
  if (!Number.isFinite(avgMfe) || !Number.isFinite(avgMae)) return NaN;
  if (avgMae <= 0) return avgMfe;
  return avgMfe / avgMae;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 2) ATCEntryLogic — "ATC Entry Logic"
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/** ATCEntryLogic weights (const in the source, never optimized). */
const ENTRY_LOGIC_W = { edgeRatio: 1.0, expectancy: 0.8, winRate: 0.5, stability: 0.3 } as const;

/**
 * @description Scores ENTRY quality: how much favorable excursion an entry earns per unit of heat
 * it takes (edge ratio), plus raw per-trade expectancy, hit rate, and a consistency term. Only
 * strictly-positive excursions enter their averages, so trades that never moved favorably (or never
 * moved against) do not dilute the ratio.
 *
 * As-written quirks kept for parity: `avgMae` falls back to 1 (a currency unit) when no trade had a
 * positive MAE, which is the only div-by-zero guard the edge ratio has — a non-empty but tiny MAE
 * list makes the ratio explode. `variance` is the POPULATION variance of per-trade P/L in
 * currency-SQUARED, so `stability = 1/(1+variance)` is ~0 for any real strategy and the term is
 * effectively inert; do not switch it to a sample variance or normalize the units.
 * @param trades - Closed trades; `profit`, `mfe` and `mae` (positive magnitude) are read.
 * @param agg - Unused by this fitness.
 * @returns 1.0·edgeRatio + 0.8·expectancy + 0.5·winRate + 0.3·stability, or -Infinity with no trades.
 */
export function entryLogicFitness(trades: FitnessTrade[], agg?: FitnessAggregates): number {
  void agg;
  const n = trades.length;
  if (n === 0) return -Infinity;
  const mfeList = trades.map((t) => t.mfe).filter((v) => v > 0);
  const maeList = trades.map((t) => Math.abs(t.mae)).filter((v) => v > 0);
  const returns = trades.map((t) => t.profit);
  const winners = trades.filter((t) => t.profit > 0).length;

  const avgMfe = mfeList.length ? mean(mfeList) : 0;
  const avgMae = maeList.length ? mean(maeList) : 1;
  const edgeRatio = avgMfe / avgMae;
  const expectancy = cumProfit(trades) / n;
  const winRate = winners / n;
  const avgReturn = mean(returns);
  const variance = returns.length > 1
    ? mean(returns.map((r) => (r - avgReturn) * (r - avgReturn)))
    : 0;
  const stability = 1 / (1 + variance);

  return ENTRY_LOGIC_W.edgeRatio * edgeRatio
    + ENTRY_LOGIC_W.expectancy * expectancy
    + ENTRY_LOGIC_W.winRate * winRate
    + ENTRY_LOGIC_W.stability * stability;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 3) ATCStopLossMae — "ATC StopLoss MAE"
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/** ATCStopLossMae weights (const in the source). */
const STOP_LOSS_MAE_W = { stopEfficiency: 1.0, expectancy: 0.5, tailMaePenalty: 0.2, winnersStopped: 0.5 } as const;

/**
 * @description Scores the STOP placement: it rewards a stop that catches losers, punishes one that
 * catches winners (twice — once by shrinking the efficiency ratio, once through an explicit ratio
 * penalty), and punishes the fat right tail of adverse excursion, i.e. the trades that ran far
 * against the position before resolving.
 *
 * As-written details: `stopEfficiency = losersStopped / (1 + winnersStopped)` applies the +1 soft
 * guard ALWAYS, even when no winner was stopped, so a perfect stop scores `losersStopped` and not
 * `Infinity`. Breakeven trades (`profit === 0`) count in N and in the MAE list but are neither
 * winners nor losers. The tail count uses C# banker's rounding ({@link bankersRound}), NOT
 * `Math.round`, and never drops below 1.
 * @param trades - Closed trades; `profit`, `mae` (positive magnitude) and `exitName` are read.
 * @param agg - Unused by this fitness.
 * @returns 1.0·stopEfficiency + 0.5·expectancy − 0.2·tailMaeAvg − 0.5·winnersStoppedRatio, or -Infinity with no trades.
 */
export function stopLossMaeFitness(trades: FitnessTrade[], agg?: FitnessAggregates): number {
  void agg;
  const n = trades.length;
  if (n === 0) return -Infinity;
  const allMae = trades.map((t) => Math.abs(t.mae));
  // Unreachable while n > 0; the C# source carries the guard, so we carry it too.
  if (allMae.length === 0) return -Infinity;

  const expectancy = cumProfit(trades) / n;
  const losersStopped = trades.filter((t) => t.profit < 0 && exitNameHas(t, 'Stop')).length;
  const winnersStopped = trades.filter((t) => t.profit > 0 && exitNameHas(t, 'Stop')).length;
  const stopEfficiency = losersStopped / (1 + winnersStopped);

  const sorted = allMae.slice().sort((a, b) => a - b);
  const tailCount = Math.max(1, bankersRound(sorted.length * 0.05));
  const tailMaeAvg = tailMean(sorted, tailCount);
  const winnersStoppedRatio = winnersStopped / n;

  return STOP_LOSS_MAE_W.stopEfficiency * stopEfficiency
    + STOP_LOSS_MAE_W.expectancy * expectancy
    - STOP_LOSS_MAE_W.tailMaePenalty * tailMaeAvg
    - STOP_LOSS_MAE_W.winnersStopped * winnersStoppedRatio;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 4) ATCTrailingStop — "ATC Trailing Stop"
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/** ATCTrailingStop weights (const in the source). `runupRetention` multiplies the SAME quantity as `mfeCapture`. */
const TRAILING_STOP_W = { mfeCapture: 1.0, runupRetention: 0.8, avgFe: 0.4, givebackPenalty: 0.6 } as const;

/**
 * @description Scores the TRAILING stop: how much of each trade's peak open profit actually made it
 * into the realized P/L, against how much was handed back. Trades that never went favorable
 * (`mfe <= 0`) are skipped entirely — a trailing stop had nothing to trail on them — and if that
 * leaves nothing, the whole parameter set is rejected with -Infinity.
 *
 * PARITY QUIRK (do not fix): the source computes `mfeCapture = P / MFE` and `runupRetention = P/MFE`
 * — the identical formula — then sums them under weights 1.0 and 0.8, so one ratio carries an
 * effective weight of 1.8. We implement the algebraically-equivalent single term
 * `1.8 · mean(P/MFE)`. A second quirk: `feBeforeStop` is the raw currency MFE applied to EVERY
 * surviving trade (the source's comment claims "if the trailing stop triggered", the code does not
 * check), which mixes a unit-less ratio with raw currency — for large-tick instruments the currency
 * terms dominate. That is as-designed for this objective; do not normalize it.
 * @param trades - Closed trades; `profit` and `mfe` are read.
 * @param agg - Unused by this fitness.
 * @returns 1.8·mean(P/MFE) + 0.4·mean(MFE) − 0.6·mean(MFE − P) over trades with MFE > 0, or -Infinity when there are no trades / no such trades.
 */
export function trailingStopFitness(trades: FitnessTrade[], agg?: FitnessAggregates): number {
  void agg;
  if (trades.length === 0) return -Infinity;
  const survivors = trades.filter((t) => t.mfe > 0);
  if (survivors.length === 0) return -Infinity;

  const avgMfeCapture = mean(survivors.map((t) => t.profit / t.mfe));
  const avgRunupRetention = avgMfeCapture; // identical formula in the source — the known duplication
  const avgFeBeforeStop = mean(survivors.map((t) => t.mfe));
  const avgGiveback = mean(survivors.map((t) => t.mfe - t.profit));

  return TRAILING_STOP_W.mfeCapture * avgMfeCapture
    + TRAILING_STOP_W.runupRetention * avgRunupRetention
    + TRAILING_STOP_W.avgFe * avgFeBeforeStop
    - TRAILING_STOP_W.givebackPenalty * avgGiveback;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 5) ATCTargetOrder — "ATC Target Order"
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/** ATCTargetOrder weights (const in the source). Every term is additive — this objective has no penalties. */
const TARGET_ORDER_W = { mfeUtilization: 1.0, expectancy: 0.7, payoffRatio: 0.5, targetHitRate: 0.3 } as const;

/**
 * @description Scores the profit TARGET: how much of the available favorable excursion the target
 * actually harvested, the win/loss payoff it produced, and how often it was reached at all. Target
 * hits are counted by case-sensitive substring on the exit label ('LongTarget1' / 'ShortTarget1'),
 * so a 'TimedExit' or 'EarlyExit' is not a hit even when it closed in profit.
 *
 * As-written details: MFE utilization only averages over trades with `mfe > 0` and falls back to 0
 * when there are none (the C# `DefaultIfEmpty(0)`), same for the win/loss averages; the payoff ratio
 * is 0 rather than Infinity when there were no losers.
 * @param trades - Closed trades; `profit`, `mfe` and `exitName` are read.
 * @param agg - Unused by this fitness.
 * @returns 1.0·avgMfeUtil + 0.7·expectancy + 0.5·payoffRatio + 0.3·targetHitRate, or -Infinity with no trades.
 */
export function targetOrderFitness(trades: FitnessTrade[], agg?: FitnessAggregates): number {
  void agg;
  const n = trades.length;
  if (n === 0) return -Infinity;
  const mfeUtilList = trades.filter((t) => t.mfe > 0).map((t) => t.profit / t.mfe);
  const avgMfeUtil = mfeUtilList.length ? mean(mfeUtilList) : 0;
  const targetHits = trades.filter((t) => exitNameHas(t, 'Target')).length;

  const expectancy = cumProfit(trades) / n;
  const wins = trades.filter((t) => t.profit > 0).map((t) => t.profit);
  const losses = trades.filter((t) => t.profit < 0).map((t) => t.profit);
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = Math.abs(losses.length ? mean(losses) : 0);
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const targetHitRate = targetHits / n;

  return TARGET_ORDER_W.mfeUtilization * avgMfeUtil
    + TARGET_ORDER_W.expectancy * expectancy
    + TARGET_ORDER_W.payoffRatio * payoffRatio
    + TARGET_ORDER_W.targetHitRate * targetHitRate;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 6) ATCEmergencyExit — "ATC Emergency Exit"
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/** ATCEmergencyExit weights (const in the source). All four terms are subtracted — the value is <= 0 always. */
const EMERGENCY_EXIT_W = { tailMaeReduction: 1.0, worstTrade: 0.8, drawdownImpact: 0.6, catastrophicPen: 1.2 } as const;

/**
 * @description Pure TAIL-RISK objective: every term is a penalty, so the value is always <= 0 and
 * "maximize" means "least damaged". It charges for the average of the worst 5% of adverse
 * excursions, for the single worst trade, for the account drawdown, and adds a flat 1.2 whenever one
 * trade alone accounted for more than half the max drawdown.
 *
 * As-written quirks kept for parity: the tail count TRUNCATES (`(int)(n * 0.05)`) rather than
 * rounding — deliberately different from {@link stopLossMaeFitness}, which banker's-rounds, so 30
 * trades give a tail of 1 here and 2 there. And the worst-trade term is `0.8 · |worstTrade|`, so a
 * strategy in which every trade WON is still penalized by the magnitude of its smallest win.
 * The catastrophic flag is the literal source formula `worstTrade < -maxDD * 0.5`, which is why
 * {@link FitnessAggregates.maxDrawdown} must be a positive magnitude.
 * @param trades - Closed trades; `profit` and `mae` (positive magnitude) are read.
 * @param agg - Account aggregates; `maxDrawdown` (positive magnitude) is read. Omitted = zero drawdown, which zeroes the drawdown term and reduces the catastrophic test to `worstTrade < 0` — so any losing trade trips it. Supply a real drawdown when one exists.
 * @returns −1.0·tailMaeAvg − 0.8·|worstTrade| − 0.6·|maxDD| − 1.2·catastrophicPenalty, or -Infinity with no trades.
 */
export function emergencyExitFitness(trades: FitnessTrade[], agg?: FitnessAggregates): number {
  const n = trades.length;
  if (n === 0) return -Infinity;
  const sorted = trades.map((t) => Math.abs(t.mae)).sort((a, b) => a - b);
  // TRUNCATION, not rounding — see the module doc; this is the documented divergence from ATCStopLossMae.
  const tailCount = Math.max(1, Math.trunc(sorted.length * 0.05));
  const tailMaeAvg = tailMean(sorted, tailCount);

  // Explicit fold, not Math.min(...spread): a multi-year tick-level optimization can exceed the
  // argument-count limit and throw mid-run rather than return a wrong number.
  let worstTrade = Infinity;
  for (const t of trades) if (t.profit < worstTrade) worstTrade = t.profit;
  const maxDd = agg?.maxDrawdown ?? 0;
  const catastrophicPenalty = worstTrade < -maxDd * 0.5 ? 1 : 0;

  return -EMERGENCY_EXIT_W.tailMaeReduction * tailMaeAvg
    - EMERGENCY_EXIT_W.worstTrade * Math.abs(worstTrade)
    - EMERGENCY_EXIT_W.drawdownImpact * Math.abs(maxDd)
    - EMERGENCY_EXIT_W.catastrophicPen * catastrophicPenalty;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 7) ATCPositionSizing — "ATC Position Sizing"
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/** ATCPositionSizing weights (const in the source). */
const POSITION_SIZING_W = { roMaD: 1.0, mar: 0.7, smoothness: 0.4, ulcerPen: 0.6 } as const;

/** Trading days per year, the source's annualization factor. */
const TRADING_DAYS_PER_YEAR = 252;

/**
 * @description Scores POSITION SIZING as return-per-unit-of-drawdown: RoMaD (net profit over max
 * drawdown), a MAR-style annualized twin, a smoothness bonus, and a straight drawdown penalty. With
 * no drawdown at all, RoMaD and MAR are defined as 0 rather than Infinity — so a zero-drawdown
 * strategy scores exactly `0.4` (the smoothness term), not "infinitely good".
 *
 * As-written quirks kept for parity: `totalDays = max(1, tradeCount)` uses the TRADE COUNT as a
 * day-count proxy, so the "annual" return is `netProfit / trades * 252` and a strategy that trades
 * more often is annualized DOWN for the same net profit. And `ulcerIndex` is literally `|maxDD|` —
 * not a real Ulcer Index (no squared-drawdown series) — which makes it both the smoothness
 * denominator and the raw penalty, i.e. drawdown is charged three times over.
 * @param trades - Closed trades; only `profit` is read (net profit and trade count).
 * @param agg - Account aggregates; `maxDrawdown` (positive magnitude) is read. Omitted = zero drawdown.
 * @returns 1.0·romad + 0.7·mar + 0.4·smoothness − 0.6·ulcerIndex, or -Infinity with no trades.
 */
export function positionSizingFitness(trades: FitnessTrade[], agg?: FitnessAggregates): number {
  const n = trades.length;
  if (n === 0) return -Infinity;
  const netProfit = cumProfit(trades);
  const maxDd = agg?.maxDrawdown ?? 0;

  const romad = maxDd !== 0 ? netProfit / Math.abs(maxDd) : 0;
  const totalDays = Math.max(1, n); // trade COUNT standing in for a day count, as written
  const annualReturn = (netProfit / totalDays) * TRADING_DAYS_PER_YEAR;
  const mar = maxDd !== 0 ? annualReturn / Math.abs(maxDd) : 0;
  const ulcerIndex = Math.abs(maxDd); // NOT a true Ulcer Index — just |maxDD|
  const smoothness = 1 / (1 + ulcerIndex);

  return POSITION_SIZING_W.roMaD * romad
    + POSITION_SIZING_W.mar * mar
    + POSITION_SIZING_W.smoothness * smoothness
    - POSITION_SIZING_W.ulcerPen * ulcerIndex;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * 8/9) ATCMaxNetProfitMinTrades50 / ATCMaxNetProfitMinTrades100
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/** The below-gate sentinel — exactly -1e10, NOT -Infinity (the optimizer still ranks among rejects). */
export const MIN_TRADES_GATE_SENTINEL = -1e10;

/**
 * @description Raw net profit behind a hard sample-size gate: maximize money, but refuse to reward a
 * parameter set that only traded a handful of times (an over-fit 3-trade curve otherwise wins every
 * optimization run). The two shipped C# classes differ ONLY in this constant — 50 and 100 — so one
 * function with a parameter covers both, and both are registered in {@link FITNESS_FUNCTIONS}.
 *
 * ORDER MATTERS, as written: the NaN/Infinity check runs BEFORE the min-trades gate, so a non-finite
 * net profit with 3 trades yields NaN, not the sentinel. And the sentinel is exactly `-1e10`, not
 * `-Infinity` — swapping it would flatten the ordering among rejected sets that the optimizer relies
 * on. An empty trade list therefore returns the sentinel (net profit 0, count 0 < minTrades), unlike
 * the other objectives' -Infinity.
 * @param trades - Closed trades; only `profit` is read (summed to net profit).
 * @param agg - Unused by this fitness.
 * @param minTrades - Minimum trade count to clear the gate (50 in ATCMaxNetProfitMinTrades50, 100 in the …100 twin).
 * @returns Net profit when the gate clears, {@link MIN_TRADES_GATE_SENTINEL} below it, or NaN when net profit is not finite.
 */
export function maxNetProfitMinTrades(trades: FitnessTrade[], agg?: FitnessAggregates, minTrades = 50): number {
  // The source reads TradesPerformance.NetProfit (net of commission as configured), which is a
  // DIFFERENT aggregate from Currency.CumProfit. Prefer the caller-supplied netProfit; fall back to
  // the trade sum only when it is absent (identical whenever commission is already inside profit).
  const netProfit = agg?.netProfit ?? cumProfit(trades);
  if (!Number.isFinite(netProfit)) return NaN;
  if (trades.length < minTrades) return MIN_TRADES_GATE_SENTINEL;
  return netProfit;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Registry
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/**
 * The nine shipped NT8 objectives, keyed by stable kebab-case name.
 *
 * Keys are the optimizer-facing identifiers (persisted in backtest runs and study configs), so they
 * are part of the contract: rename one and every stored run loses its objective. The two
 * min-trades entries share {@link maxNetProfitMinTrades} with different gates, exactly as the two
 * C# classes share their body.
 */
export const FITNESS_FUNCTIONS: Record<string, FitnessFunction> = {
  'max-avg-mfe-min-avg-mae': maxAvgMfeMinAvgMae,
  'entry-logic': entryLogicFitness,
  'stop-loss-mae': stopLossMaeFitness,
  'trailing-stop': trailingStopFitness,
  'target-order': targetOrderFitness,
  'emergency-exit': emergencyExitFitness,
  'position-sizing': positionSizingFitness,
  'max-net-profit-min-trades-50': (trades, agg) => maxNetProfitMinTrades(trades, agg, 50),
  'max-net-profit-min-trades-100': (trades, agg) => maxNetProfitMinTrades(trades, agg, 100),
};

/**
 * @description The registered objective names, for UI pickers and study validation — so a study can
 * be rejected at configuration time with the valid set in hand rather than failing mid-optimization
 * on an unknown key.
 * @returns The {@link FITNESS_FUNCTIONS} keys in declaration order.
 */
export function fitnessNames(): string[] {
  return Object.keys(FITNESS_FUNCTIONS);
}

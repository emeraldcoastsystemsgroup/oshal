/**
 * Futures profit-target ladder — the Target-1 partial scale-out, ADR-116.
 *
 * The source trader's EXPORT generation (`ATCEntryCountExport.cs`) scales out of half the position
 * at 1R and then slides the stop up to half of maximum favorable excursion. His newest DYNSTOPS
 * generation has NO target code at all — its exits are InitialStop / TrailStop / Strangle /
 * EarlyExit / TimedExit. That asymmetry is the whole reason this lives in its own module and is
 * OFF by default: turning it on is choosing the Export generation's exit geometry, not a tweak.
 *
 * PARAMETER PROVENANCE (every number below is his, none of them ours):
 *   UseTargets          default true          ATCEntryCountExport.cs (SetDefaults)
 *   Target1Multiplier   default 1.0           target = entry ± 1R
 *   Target1Percent      default 50            percent of FILLED qty closed at Target-1
 *   MFEStopPct          default 50.0          post-target stop = entry + 50% of the MFE distance
 *   FudgeMult           default 0.5           fallback stop move = entry ± 0.5·ATR when MFE invalid
 * Extracted from the NT8 sources at ATCEntryCountExport.cs:2789-2805 (fill → stop + Target-1) and
 * :1572-1671 (post-target MFE stop move); mirrored for shorts at :2905-2947.
 *
 * THREE SEMANTICS WORTH KNOWING, because they are easy to get flatteringly wrong:
 *  - **The 1R that sizes the target is the RAW initial stop, not the validated one.** His code
 *    computes `riskPerUnit = |entry − initialStop|` off `CalculateInitialStop` while the resting
 *    stop order carries the CLAMPED price, so on a wide entry bar the target distance and the
 *    actual stop distance differ. Porting the "tidier" version would move every target.
 *  - **`qty1 = max(1, trunc(filled × pct/100))`.** The truncation is a C# int cast. A ONE-LOT
 *    position therefore takes a one-lot "partial" — Target-1 closes the WHOLE position and the
 *    post-target stop move never happens. That is not a bug to fix; it is the behavior of the
 *    strategy at small size, and hiding it would misreport small-account runs.
 *  - **The post-target stop move fires exactly ONCE**, and only after the target resolves.
 *
 * Scope: pure functions, no state, no I/O. The caller owns order lifecycle and fills; this module
 * owns prices and quantities.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Target-1 partial scale-out port for the ADR-116 backtester: resolveTarget1 (raw-stop 1R, truncating percent-of-filled quantity, direction mirror), target1FillPrice (limit-order fill semantics incl. gap-open improvement), and resolvePostTargetStop (MFE-fraction stop with the ATR fudge fallback and 2-tick buffer).
 *
 * @module futures-targets
 */

import type { OhlcvBar } from './market-data';
import type { FuturesDirection } from './futures-stop-engine';

/** Target-ladder configuration. Defaults are the EXPORT generation's shipped values. */
export interface TargetLadderConfig {
  /**
   * Enable the Target-1 partial. DEFAULT FALSE in this port, unlike the source's `true`, because
   * the backtester's default generation is DYNSTOPS — which ships no targets at all. Enabling it
   * selects the Export generation's exit geometry deliberately.
   */
  useTargets?: boolean;
  /** Percent of the FILLED quantity closed at Target-1 (source default 50; truncated, min 1). */
  target1Percent?: number;
  /** Target distance as a multiple of initial risk (source default 1.0 = entry ± 1R). */
  target1Multiplier?: number;
  /** Post-target stop as a percent of the MFE distance from entry (source default 50). */
  mfeStopPct?: number;
  /** Fallback post-target stop distance as an ATR multiple, used when MFE is invalid (source 0.5). */
  fudgeMult?: number;
}

/** The EXPORT generation's shipped target parameters, minus `useTargets` (see the field's doc). */
export const TARGET_LADDER_DEFAULTS = Object.freeze({
  useTargets: false,
  target1Percent: 50,
  target1Multiplier: 1.0,
  mfeStopPct: 50.0,
  fudgeMult: 0.5,
});

/** A resolved Target-1 limit order. */
export interface Target1Order {
  /** Limit price the partial rests at. */
  price: number;
  /** Contracts the partial closes (≥ 1, ≤ the filled quantity). */
  quantity: number;
  /** The 1R reference the target was measured from (|entry − RAW initial stop|). */
  riskPerUnit: number;
  /**
   * True when the "partial" covers the entire position — the `max(1, trunc(...))` floor at small
   * size. The caller must treat the resulting fill as a full exit and never arm the post-target
   * stop move.
   */
  closesWholePosition: boolean;
}

/** Inputs to {@link resolveTarget1}. */
export interface Target1Params {
  direction: FuturesDirection;
  /** Entry fill price. */
  entryPrice: number;
  /** The RAW (pre-validation) initial stop — his 1R basis. See the module doc. */
  rawInitialStop: number;
  /** Contracts actually filled on entry. */
  filledQuantity: number;
  config?: TargetLadderConfig;
}

/**
 * @description Resolves the Target-1 limit order for a freshly filled entry, exactly as
 * `ATCEntryCountExport.cs` places it: 1R measured off the RAW initial stop, quantity a truncated
 * percent of the filled size with a one-contract floor.
 * @param p - Direction, entry fill, raw initial stop, filled quantity and configuration.
 * @returns The target order, or null when targets are disabled, the quantity is empty, or the 1R
 *   reference is not a usable positive distance (an unmeasurable target must not be invented).
 */
export function resolveTarget1(p: Target1Params): Target1Order | null {
  const cfg = { ...TARGET_LADDER_DEFAULTS, ...stripUndefined(p.config) };
  if (!cfg.useTargets) return null;
  if (!(p.filledQuantity >= 1)) return null;
  const riskPerUnit = Math.abs(p.entryPrice - p.rawInitialStop);
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return null;
  const quantity = Math.max(1, Math.trunc(p.filledQuantity * cfg.target1Percent / 100));
  const capped = Math.min(quantity, p.filledQuantity);
  const offset = riskPerUnit * cfg.target1Multiplier;
  const price = p.direction === 'long' ? p.entryPrice + offset : p.entryPrice - offset;
  return { price, quantity: capped, riskPerUnit, closesWholePosition: capped >= p.filledQuantity };
}

/**
 * @description Limit-order fill semantics for the resting target over one completed bar. A sell
 * limit above the market fills the moment the bar trades through it; a bar that OPENS beyond the
 * limit fills at the OPEN, which is BETTER than the limit — the mirror of a stop's gap-through
 * penalty, and the reason gaps must be modelled on both order types or the book is biased.
 *
 * Slippage is deliberately NOT applied: a limit order fills at its price or better by definition.
 * Charging slippage against a limit would invent a fill that the exchange cannot produce.
 * @param direction - Trade direction (long = sell limit above, short = buy limit below).
 * @param targetPrice - The resting limit price.
 * @param bar - The completed bar to test.
 * @returns The fill price, or null when the bar never reached the limit.
 */
export function target1FillPrice(direction: FuturesDirection, targetPrice: number, bar: OhlcvBar): number | null {
  if (!Number.isFinite(targetPrice)) return null;
  if (direction === 'long') {
    if (bar.h < targetPrice) return null;
    return Math.max(targetPrice, bar.o);
  }
  if (bar.l > targetPrice) return null;
  return Math.min(targetPrice, bar.o);
}

/** Inputs to {@link resolvePostTargetStop}. */
export interface PostTargetStopParams {
  direction: FuturesDirection;
  entryPrice: number;
  /**
   * The most favorable PRICE reached since entry (highest high for a long, lowest low for a short)
   * — his `currentMFE`, a price level rather than a distance. Pass NaN when it is unavailable; the
   * ATR fudge fallback then applies.
   */
  mfePrice: number;
  /** ATR at the current bar, for the fudge fallback. */
  atr: number;
  tickSize: number;
  config?: TargetLadderConfig;
}

/**
 * @description The post-target stop move: once Target-1 resolves, the remaining position's stop
 * jumps to a fraction of maximum favorable excursion (default half), or to an ATR fudge above entry
 * when MFE has not moved in the trade's favor. A 2-tick buffer widens it, as in the source. The
 * result is PRE-validation — the caller still runs `validateStopPrice` and the tighten-only rule.
 * @param p - Direction, entry, MFE price, ATR, tick size and configuration.
 * @returns The proposed stop level (pre-validation).
 */
export function resolvePostTargetStop(p: PostTargetStopParams): number {
  const cfg = { ...TARGET_LADDER_DEFAULTS, ...stripUndefined(p.config) };
  const long = p.direction === 'long';
  const favorable = Number.isFinite(p.mfePrice) && (long ? p.mfePrice > p.entryPrice : p.mfePrice < p.entryPrice);
  const distance = favorable
    ? Math.abs(p.mfePrice - p.entryPrice) * cfg.mfeStopPct / 100
    : Math.max(0, p.atr) * cfg.fudgeMult;
  const buffer = p.tickSize * 2;
  return long ? p.entryPrice + distance - buffer : p.entryPrice - distance + buffer;
}

/**
 * Drop explicit-undefined keys before merging over the frozen defaults. `{ mfeStopPct: undefined }`
 * typechecks (exactOptionalPropertyTypes is off) and a plain spread would overwrite the default
 * with undefined, producing a NaN stop that silently never triggers.
 */
function stripUndefined(cfg: TargetLadderConfig | undefined): TargetLadderConfig {
  if (!cfg) return {};
  return Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined)) as TargetLadderConfig;
}

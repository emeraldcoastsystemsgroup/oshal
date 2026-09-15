/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-159 made the engine withhold every order for a position its own filled orders cannot account for, and TRADING_CORE_SYMBOLS has always withheld for a ring-fenced name. Both facts were invisible on the surface: the operator could see a holding sitting with no stop and no exit and had no way to tell the silence was deliberate. This module is the ONE place that turns the marks the engine already attaches (`unmanaged` / `engineAvgCost`, from withEngineCostBasis) and the operator's own ring-fence (coreConfig) into a readable answer for a surface. It DECIDES nothing and reads no database: it restates, in the operator's words, what the order paths already do, which is what stops the surface growing a second definition of "unmanaged" that can drift away from the engine's. Deliberately outside the dispatch graph - nothing that emits an order imports it.
 */

import type { Position } from '@/features/trading';
import type { CoreConfig } from './trading-dispatch-core';

/** Why the engine withholds. Each is an INDEPENDENT reason with its own fix. */
export type PositionGovernanceKind =
  /** ADR-159: the engine's own filled orders do not account for the quantity held. */
  | 'unaccounted'
  /** Named in TRADING_CORE_SYMBOLS at a 0% target: held, never bought, never sold. */
  | 'ring-fenced'
  /** Named in TRADING_CORE_SYMBOLS at a real target: no sleeve exit, but the core rebalances it. */
  | 'core-holding'
  /** The engine's own ledger could not be read, so its answer for this position is NOT KNOWN. */
  | 'accountability-unknown';

/** One reason, with the words a surface shows and the words that explain them. */
export interface PositionGovernanceReason {
  kind: PositionGovernanceKind;
  /** Badge text - two or three words, lower case. */
  label: string;
  /** What it MEANS for this position, and what would change it. Plain words, no jargon. */
  detail: string;
}

/**
 * The engine's posture toward one position, as the order paths actually behave.
 *
 * `exitsApply` / `ordersApply` are three-valued on purpose. `false` is a finding - the engine
 * looked and will withhold. `null` is a FAILED LOOK - its ledger could not be read, so neither
 * "managed" nor "unmanaged" may be claimed. A surface that cannot tell those two apart is the
 * failure mode this codebase keeps paying for.
 */
export interface PositionGovernance {
  /** UPPER-CASE symbol. */
  symbol: string;
  /** Does the engine's protective exit set (stop, take-profit, trailing, rotation, trim) run? */
  exitsApply: boolean | null;
  /** Does the engine emit ANY order for this position - an exit, a trim, or an entry that adds? */
  ordersApply: boolean | null;
  /** Every reason the engine withholds, strongest first. Empty when it manages the position. */
  reasons: PositionGovernanceReason[];
}

/** The engine's own words for a holding it cannot account for (ADR-159). */
function unaccountedReason(symbol: string, qty: number): PositionGovernanceReason {
  return {
    kind: 'unaccounted',
    label: 'not managed',
    detail:
      `The engine's own filled orders do not account for the ${qty} ${symbol} held here, so it emits no `
      + 'order for this position at all: no stop-loss, no take-profit, no trailing exit, no rotation or '
      + 'rebalance trim, and no entry that adds to it. It is monitored, not managed, and that is '
      + 'deliberate (ADR-159) - the shares were bought outside the engine, or sold outside it, so the '
      + 'engine has no cost of its own to measure an exit against and will not act on a number it never '
      + 'paid. The position still counts toward exposure, capital and drawdown; it is real money at the '
      + "venue. It leaves this state when the engine's own ledger accounts for the whole quantity again.",
  };
}

/** The operator's own ring-fence at a 0% target: held, never bought, never sold. */
function ringFencedReason(symbol: string): PositionGovernanceReason {
  return {
    kind: 'ring-fenced',
    label: 'ring-fenced',
    detail:
      `${symbol} is named in TRADING_CORE_SYMBOLS at a 0% target, which is a hold: the engine neither `
      + 'buys it nor sells it, and every sleeve exit - stop-loss, take-profit, trailing exit, rotation '
      + 'and rebalance trim - is filtered out before it can fire. This one is a setting, not a finding: '
      + 'the position leaves this state when the symbol is removed from TRADING_CORE_SYMBOLS.',
  };
}

/** A beta-core holding at a real target: exempt from the sleeve, still rebalanced by the core. */
function coreHoldingReason(symbol: string, targetPct: number, alsoUnaccounted: boolean): PositionGovernanceReason {
  const rebalance = alsoUnaccounted
    ? 'The core rebalance would normally top it up toward that target and trim it back when it drifts '
      + 'above; that is withheld too while the engine cannot account for the position.'
    : `The core rebalance still tops it up toward ${targetPct}% of equity and trims it back when it `
      + 'drifts above - so this position is traded, just never exited on a loss or a target.';
  return {
    kind: 'core-holding',
    label: `core hold ${targetPct}%`,
    detail:
      `${symbol} is a beta-core holding in TRADING_CORE_SYMBOLS at a ${targetPct}% target, so no sleeve `
      + 'exit runs on it: no stop-loss, no take-profit, no trailing exit, no rotation or rebalance trim. '
      + rebalance,
  };
}

/** The honest answer when the engine's own ledger could not be read. */
function unknownReason(symbol: string, longPosition: boolean): PositionGovernanceReason {
  return {
    kind: 'accountability-unknown',
    label: 'not known',
    detail: longPosition
      ? `Whether the engine manages ${symbol} is NOT KNOWN here: its own order ledger could not be read `
        + 'for this book, so neither answer can be shown. This is a failed read, not a finding - the row '
        + 'is not claiming the position is managed, and it is not claiming it is unmanaged either. The '
        + "engine itself falls back to the venue's cost basis when this read fails, so it keeps trading "
        + 'the book; it is this readout that is blind, not the engine.'
      : `The engine's accounting rule (ADR-159) is defined for LONG positions and ${symbol} is not one, `
        + 'so no answer is given for it here rather than a guessed one.',
  };
}

/**
 * @description Whether the engine's protective exit set runs for this position.
 *
 * The dispatch drops EVERY exit whose symbol is ring-fenced (`exits.filter(e => !coreSet.has(...))`,
 * whatever its target), and ADR-159 withholds every exit for an unaccounted holding. Otherwise the
 * exits run - unless nobody could check, which is `null`, not `true`.
 *
 * @param fenced - The symbol is named in TRADING_CORE_SYMBOLS.
 * @param unaccounted - The engine's ledger does not cover the quantity held.
 * @param accountabilityKnown - The ledger read succeeded for this position.
 * @returns true / false, or null when it could not be determined.
 */
function exitsApplyTo(fenced: boolean, unaccounted: boolean, accountabilityKnown: boolean): boolean | null {
  if (fenced || unaccounted) return false;
  return accountabilityKnown ? true : null;
}

/**
 * @description Whether the engine emits ANY order for this position.
 *
 * A `:0` ring-fence and an unaccounted holding both mean none at all. A ring-fence at a real target
 * still gets its core top-up and its core trim - `ensureCore` skips only a symbol whose held shares
 * carry the `unmanaged` mark - so it is traded, just never exited.
 *
 * @param fenced - The symbol is named in TRADING_CORE_SYMBOLS.
 * @param targetPct - That symbol's core target percent (0 = exemption-only hold).
 * @param unaccounted - The engine's ledger does not cover the quantity held.
 * @param accountabilityKnown - The ledger read succeeded for this position.
 * @returns true / false, or null when it could not be determined.
 */
function ordersApplyTo(
  fenced: boolean, targetPct: number, unaccounted: boolean, accountabilityKnown: boolean,
): boolean | null {
  if (unaccounted) return false;
  if (fenced && targetPct <= 0) return false;
  return accountabilityKnown ? true : null;
}

/**
 * @description The engine's posture toward ONE position, restated from the marks the engine itself
 * attached. Pure: it reads `unmanaged` / `engineAvgCost` (set by `withEngineCostBasis`) and the
 * parsed ring-fence, and derives nothing of its own.
 *
 * The three-valued result is the point. `withEngineCostBasis` marks EVERY long it looked at - with
 * `engineAvgCost` where its ledger covers the quantity and `unmanaged` where it does not - and
 * marks NOTHING when the ledger read itself failed. So a long carrying neither mark is a position
 * nobody looked at, and calling it "managed" would be exactly the lie ADR-159 exists to prevent.
 *
 * @param p - A position, ideally after the same pinned-lot subtraction and cost attachment the
 *   dispatch applies, so the answer is the engine's own and not a parallel computation.
 * @param core - The parsed TRADING_CORE_SYMBOLS ring-fence (`coreConfig()`), override-aware when
 *   the caller has an applied Strategy Library override.
 * @returns What the engine will and will not do for this position, and why, in words.
 */
export function positionGovernance(p: Position, core: CoreConfig): PositionGovernance {
  const symbol = p.symbol.toUpperCase();
  const fenced = core.symbols.includes(symbol);
  const targetPct = core.perSymbolPct.get(symbol) ?? 0;
  if (!(p.qty > 0)) {
    return { symbol, exitsApply: null, ordersApply: null, reasons: [unknownReason(symbol, false)] };
  }
  const unaccounted = p.unmanaged === true;
  // The attachment marks every long it saw, one way or the other. Neither mark = it never ran.
  const accountabilityKnown = unaccounted || p.engineAvgCost !== undefined;
  const reasons: PositionGovernanceReason[] = [];
  if (unaccounted) reasons.push(unaccountedReason(symbol, p.qty));
  if (fenced && targetPct <= 0) reasons.push(ringFencedReason(symbol));
  else if (fenced) reasons.push(coreHoldingReason(symbol, targetPct, unaccounted));
  // A `:0` ring-fence withholds on its own, so an unreadable ledger changes nothing there and is
  // not reported as doubt. Everywhere else a failed read is reported as a failed read.
  if (!accountabilityKnown && !(fenced && targetPct <= 0)) reasons.push(unknownReason(symbol, true));
  return {
    symbol,
    exitsApply: exitsApplyTo(fenced, unaccounted, accountabilityKnown),
    ordersApply: ordersApplyTo(fenced, targetPct, unaccounted, accountabilityKnown),
    reasons,
  };
}

/**
 * @description The same answer for a whole book, keyed by UPPER-CASE symbol, ready to ride a
 * positions payload.
 * @param positions - The book's positions, marked by `withEngineCostBasis`.
 * @param core - The parsed ring-fence.
 * @returns Symbol to governance, one entry per position.
 */
export function positionGovernanceBySymbol(
  positions: readonly Position[], core: CoreConfig,
): Record<string, PositionGovernance> {
  const out: Record<string, PositionGovernance> = {};
  for (const p of positions) out[p.symbol.toUpperCase()] = positionGovernance(p, core);
  return out;
}

/**
 * Idle-cash yield sleeve (ADR-052 addendum P6, paper-to-live parity) — the PURE half.
 *
 * Cash the book is not using earns next to nothing at the broker's sweep. The sleeve parks the cash
 * above a working FLOAT in an intraday-liquid T-bill fund (SGOV by default) and treats that holding
 * as spendable: an entry leg that needs more than the cash on hand sells the sleeve FIRST, waits
 * for the sale, re-reads the real cash and only then buys. The engine sizes off broker cash, so a
 * naive sleeve would starve every entry; sell-first is what keeps it from doing so.
 *
 * This file holds the ONE resolver the dispatch and the Strategy Lab both read (a finite
 * StrategyConfig knob decides; an absent knob inherits the mode-aware TRADING_YIELD_SLEEVE /
 * TRADING_YIELD_SLEEVE_FLOAT_PCT env default, OFF unless armed; a Lab walk has no book, so an absent
 * knob is off there), the sleeve symbol, and the sizing math. The dispatch half lives in
 * src/app/trading-dispatch-yield-sleeve.ts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — yieldSleeveFloatPct (the one resolver: knob, else the mode-aware env arm, off by default; blank env value = the pre-registered 5% float), yieldSleeveSymbol (TRADING_YIELD_SLEEVE_SYMBOL, default SGOV, validated as a ticker), sleeveRebalancePlan (park spendable cash above the float, refill the float from the sleeve, hold inside a 1%-of-equity dead band; unsettled sleeve proceeds count toward the float but are never parked) and sleeveFundingQty (the shares a sell-first funding sale needs, rounded up and bounded by what is held).
 *
 * @module yield-sleeve
 */

import { modeArmed, envNumberOr } from './entry-guards';

/** The fund the sleeve parks in when TRADING_YIELD_SLEEVE_SYMBOL is unset: the operator's 2026-07-09
 *  spec names it ("SGOV or equivalent T-bill ETF") — 0-3 month Treasury bills, intraday-liquid. */
export const DEFAULT_YIELD_SLEEVE_SYMBOL = 'SGOV';

/** Pre-registered working float, percent of equity: the pop-catcher's default reserve (1% tranches ×
 *  5, TRADING_POP_TRANCHE_PCT / TRADING_POP_MAX) and one full name at the balanced posture's per-name
 *  cap (maxPerNamePct 5). The float funds the legs that never sell the sleeve (the pop-catcher and
 *  the beta-core top-up) and is the only same-day buying power a cash-type book has. */
export const DEFAULT_YIELD_SLEEVE_FLOAT_PCT = 5;

/** Dead band, percent of equity, on both sides of the float: the beta core's own band
 *  (trading-dispatch-core CORE_BAND_PCT), so neither the core nor the sleeve trades a rounding error. */
export const YIELD_SLEEVE_BAND_PCT = 1;

/** Ceiling on the float: a wider float is indistinguishable from "off". */
const MAX_FLOAT_PCT = 95;

/**
 * @description The working float for one book or one Strategy Lab walk — the ONE resolver both read.
 * A finite `knob` (StrategyConfig.yieldSleeveFloatPct on the applied strategy) decides: 0 is an
 * explicit off, a positive value arms the sleeve with that float. An absent knob (null/undefined, the
 * default for every strategy saved before the knob existed) inherits the book's mode-aware env
 * default: TRADING_YIELD_SLEEVE (paper | live | both | true) arms the book kind and
 * TRADING_YIELD_SLEEVE_FLOAT_PCT sets the float (blank = {@link DEFAULT_YIELD_SLEEVE_FLOAT_PCT}).
 * A Lab walk passes mode null, so an absent knob is off there.
 * @param knob - The applied StrategyConfig's yieldSleeveFloatPct (null/undefined = inherit).
 * @param mode - The book kind firing, or null for a Lab walk.
 * @returns The float as a positive percent of equity; 0 means the sleeve is off.
 */
export function yieldSleeveFloatPct(knob: number | null | undefined, mode: 'paper' | 'live' | null): number {
  if (knob !== null && knob !== undefined) {
    const k = Number(knob);
    return Number.isFinite(k) && k > 0 ? Math.min(MAX_FLOAT_PCT, k) : 0;
  }
  if (!mode || !modeArmed('TRADING_YIELD_SLEEVE', mode)) return 0;
  const raw = envNumberOr('TRADING_YIELD_SLEEVE_FLOAT_PCT', DEFAULT_YIELD_SLEEVE_FLOAT_PCT);
  return Number.isFinite(raw) && raw > 0 ? Math.min(MAX_FLOAT_PCT, raw) : 0;
}

/**
 * @description The fund the sleeve parks in: TRADING_YIELD_SLEEVE_SYMBOL when it is a well-formed
 * ticker, else {@link DEFAULT_YIELD_SLEEVE_SYMBOL}. Read per call, like every TRADING_* dial.
 * @returns The UPPERCASE sleeve symbol.
 */
export function yieldSleeveSymbol(): string {
  const raw = String(process.env.TRADING_YIELD_SLEEVE_SYMBOL ?? '').trim().toUpperCase();
  return /^[A-Z.]{1,6}$/.test(raw) ? raw : DEFAULT_YIELD_SLEEVE_SYMBOL;
}

/** What the sleeve should do on a quiet fire. */
export interface SleeveRebalance { action: 'hold' | 'park' | 'refill'; qty: number }

/** The inputs one rebalance judges — all in dollars except the float and the share counts. */
export interface SleeveBook {
  /** Account equity (the float's base). */
  equity: number;
  /** Cash the book may SPEND now: settled cash on a cash-type book, after reservations. */
  cash: number;
  /** Sleeve sale proceeds still inside the settlement window (cash-type books; 0 elsewhere). */
  pending: number;
  /** The working float, percent of equity. */
  floatPct: number;
  /** The sleeve fund's current price. */
  price: number;
  /** Sleeve shares the engine holds and may sell. */
  heldQty: number;
}

/**
 * @description Pure rebalance for one quiet fire: park the SPENDABLE cash above the float, or sell
 * enough of the sleeve to bring the float back, or hold inside the dead band. Unsettled proceeds of an
 * earlier sleeve sale count toward the float (so a cash-type book does not sell again for cash that is
 * already on its way) but are never parked — only cash the book can spend now buys the fund.
 * @param b - The book facts.
 * @returns The trade (qty 0 ⇒ 'hold').
 */
export function sleeveRebalancePlan(b: SleeveBook): SleeveRebalance {
  const hold: SleeveRebalance = { action: 'hold', qty: 0 };
  if (!(b.equity > 0) || !(b.price > 0) || !(b.floatPct > 0)) return hold;
  const float = (b.floatPct / 100) * b.equity;
  const band = (YIELD_SLEEVE_BAND_PCT / 100) * b.equity;
  const pending = Math.max(0, b.pending);
  const excess = Math.max(0, b.cash) + pending - float;
  if (excess > band) {
    const qty = Math.floor(Math.max(0, Math.min(excess, b.cash - float)) / b.price);
    return qty >= 1 ? { action: 'park', qty } : hold;
  }
  if (excess < -band) {
    const qty = sleeveFundingQty(-excess, b.price, b.heldQty);
    return qty >= 1 ? { action: 'refill', qty } : hold;
  }
  return hold;
}

/**
 * @description Shares a sell-first funding sale needs to raise `shortfall` dollars: rounded UP (an
 * entry short by a fraction of a share would otherwise lose a share to rounding) and bounded by the
 * shares actually held, so a stale holding can never open a short.
 * @param shortfall - Dollars the buys need beyond the cash on hand.
 * @param price - The sleeve fund's price.
 * @param heldQty - Sleeve shares available to sell.
 * @returns Shares to sell (0 = nothing to raise or nothing to sell).
 */
export function sleeveFundingQty(shortfall: number, price: number, heldQty: number): number {
  if (!(shortfall > 0) || !(price > 0) || !(heldQty >= 1)) return 0;
  return Math.min(Math.floor(heldQty), Math.ceil(shortfall / price));
}

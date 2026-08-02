/**
 * Futures margin model — ADR-116, the risk check the backtester was missing.
 *
 * Risk-percent sizing answers "how many contracts can I afford to be WRONG on"; it says nothing
 * about "how many contracts can I afford to HOLD". Those diverge badly in futures: a tight stop on
 * a $50/point contract sizes a position whose performance bond an account may not cover, and the
 * backtest happily books its P&L. This module is the second question.
 *
 * TWO LAYERS, deliberately separated by what is knowable:
 *
 *  1. NOTIONAL + LEVERAGE — computable from the contract specs already in `futures-contract.ts`
 *     (multiplier, tick) and the fill price. Always available, never an estimate: notional =
 *     price × multiplier × qty, leverage = notional / equity. A run reporting 40× leverage has told
 *     you it could not be funded without anyone having to look up a margin table.
 *  2. PERFORMANCE BOND — the exchange's actual initial/maintenance requirement in dollars. This is
 *     an OPERATOR-SUPPLIED, CITED figure ({@link FuturesMarginSpec} carries `asOf` + `source`) and
 *     there is no built-in table on purpose. CME revises performance bonds on notice, several times
 *     a year; a number hard-typed into this file would be a stale figure presented as fact, which
 *     is precisely the drift the repo's anti-drift rules exist to stop. No spec supplied = margin
 *     checking is OFF and the result says so (`marginModeled: false`) — never a silent default.
 *
 * When a spec IS supplied the model is fail-closed in both directions: sizing is capped to what the
 * account can fund (and a signal that cannot fund even ONE contract is refused, not silently
 * traded), and equity falling under maintenance × qty is a margin call — liquidated at the next
 * bar's open by default, because that is what a real account does.
 *
 * Scope: pure arithmetic, no I/O, no clock reads except the caller-supplied `asOf` comparison.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — futures margin model for the ADR-116 backtester: cited FuturesMarginSpec (initial/maintenance/day-trade with asOf + source, no built-in table by design), staleness check, affordable-contract cap, maintenance margin-call test, and the always-available notional/leverage arithmetic derived from the real contract specs.
 *
 * @module futures-margin
 */

/**
 * An exchange performance-bond requirement for one root, WITH its provenance.
 *
 * `asOf` and `source` are required, not decorative: a margin figure without a date and a citation
 * is indistinguishable from a guess, and a backtest sized off a guess is fiction with a decimal
 * point. Populate from the exchange's published margin table (CME "Performance Bonds / Margins")
 * or the clearing broker's schedule, and record which one.
 */
export interface FuturesMarginSpec {
  /** Root ticker the requirement applies to, e.g. 'ES'. */
  root: string;
  /** Initial performance bond per contract, in `currency`. */
  initialMargin: number;
  /** Maintenance performance bond per contract — the level a margin call is measured against. */
  maintenanceMargin: number;
  /**
   * Intraday ("day-trade") margin per contract, if the broker offers one. Optional because it is a
   * BROKER concession, not an exchange requirement — brokers set and withdraw it independently.
   */
  dayTradeMargin?: number;
  /** ISO-4217 currency of the figures above (must match the instrument's). */
  currency: string;
  /** ISO date (YYYY-MM-DD) the figures were published/effective. */
  asOf: string;
  /** Where the figures came from, e.g. 'CME performance bond table, 2026-07-01 notice'. */
  source: string;
}

/** How the margin model behaves inside a run. */
export interface MarginModelConfig {
  /**
   * The cited requirement. ABSENT = margin checking off; the run reports `marginModeled: false`
   * and behaves exactly as it did before this module existed. There is no default spec.
   */
  spec?: FuturesMarginSpec;
  /** Which requirement sizes the position: 'initial' (default) or 'day-trade' (needs dayTradeMargin). */
  basis?: 'initial' | 'day-trade';
  /**
   * What a maintenance breach does. 'flatten' (default) liquidates at the next bar's open, which is
   * what a real account does; 'count-only' records the breach without changing the trade, for
   * measuring how often a config would have been called.
   */
  marginCallAction?: 'flatten' | 'count-only';
  /**
   * Fraction of equity usable as margin (default 1 = the whole account). Below 1 models a house
   * buffer — the broker's, or the trader's own rule about never posting the last dollar.
   */
  usableEquityFraction?: number;
  /**
   * Refuse a spec older than this many days as of `specAsOfNow` (default 0 = no age check).
   * Set it on a study you intend to quote: a two-year-old performance bond is not a margin model.
   */
  maxSpecAgeDays?: number;
  /** "Now" for the staleness check, ISO date. Defaults to the run's last bar when the caller passes it. */
  specAsOfNow?: string;
}

/** Margin-model defaults. Note there is deliberately NO default `spec`. */
export const MARGIN_MODEL_DEFAULTS = Object.freeze({
  basis: 'initial' as 'initial' | 'day-trade',
  marginCallAction: 'flatten' as 'flatten' | 'count-only',
  usableEquityFraction: 1,
  maxSpecAgeDays: 0,
});

const MS_PER_DAY = 86_400_000;

/**
 * @description The per-contract requirement a run should size against, honouring the basis. Falls
 * back to `initialMargin` when 'day-trade' is asked for but the spec carries no day-trade figure —
 * the conservative direction, because a missing broker concession must never be read as a cheaper
 * requirement than the exchange's.
 * @param spec - The cited margin spec.
 * @param basis - 'initial' (exchange requirement) or 'day-trade' (broker concession).
 * @returns Dollars of margin required per contract.
 */
export function marginPerContract(spec: FuturesMarginSpec, basis: 'initial' | 'day-trade' = 'initial'): number {
  if (basis === 'day-trade' && spec.dayTradeMargin != null && spec.dayTradeMargin > 0) return spec.dayTradeMargin;
  return spec.initialMargin;
}

/**
 * @description How many contracts the account can actually fund. This is the cap that turns a
 * risk-percent size into a fundable one.
 * @param equity - Account equity available to the position.
 * @param spec - The cited margin spec.
 * @param cfg - Margin model configuration (basis + usable fraction).
 * @returns Whole contracts affordable; 0 means the signal cannot be taken at all.
 */
export function affordableContracts(equity: number, spec: FuturesMarginSpec, cfg: MarginModelConfig = {}): number {
  const per = marginPerContract(spec, cfg.basis ?? MARGIN_MODEL_DEFAULTS.basis);
  if (!(per > 0)) return 0;
  const fraction = cfg.usableEquityFraction ?? MARGIN_MODEL_DEFAULTS.usableEquityFraction;
  const usable = equity * fraction;
  if (!Number.isFinite(usable) || usable <= 0) return 0;
  return Math.max(0, Math.floor(usable / per));
}

/**
 * @description Maintenance test: has equity fallen below what the OPEN position must maintain?
 * Measured on equity INCLUDING open P&L, which is what a clearing firm marks to market.
 * @param equityIncludingOpenPnl - Realized equity plus the open position's mark-to-market.
 * @param quantity - Contracts held.
 * @param spec - The cited margin spec.
 * @returns True when the account is under maintenance margin (a call).
 */
export function isMarginCall(equityIncludingOpenPnl: number, quantity: number, spec: FuturesMarginSpec): boolean {
  if (quantity <= 0) return false;
  const required = spec.maintenanceMargin * quantity;
  if (!(required > 0)) return false;
  return equityIncludingOpenPnl < required;
}

/**
 * @description Staleness check on a margin spec. Exchanges revise performance bonds on notice, so a
 * spec's age is part of whether a number means anything.
 * @param spec - The cited margin spec.
 * @param now - ISO date to measure age against.
 * @param maxAgeDays - Maximum tolerated age in days; 0 disables the check.
 * @returns A human-readable warning string, or null when the spec is acceptable.
 */
export function marginSpecStaleness(spec: FuturesMarginSpec, now: string, maxAgeDays: number): string | null {
  if (!(maxAgeDays > 0)) return null;
  const asOf = Date.parse(spec.asOf);
  const at = Date.parse(now);
  if (Number.isNaN(asOf) || Number.isNaN(at)) return `margin spec for ${spec.root} has an unparseable date (asOf='${spec.asOf}', now='${now}')`;
  const ageDays = Math.floor((at - asOf) / MS_PER_DAY);
  if (ageDays <= maxAgeDays) return null;
  return `margin spec for ${spec.root} is ${ageDays} days old (asOf ${spec.asOf}, limit ${maxAgeDays}) — source: ${spec.source}`;
}

/**
 * @description Notional value of a position — the layer that needs no margin table at all, only the
 * real contract multiplier.
 * @param price - Contract price.
 * @param multiplier - Dollars per full price point (ES = 50).
 * @param quantity - Contracts held.
 * @returns Notional exposure in the contract's currency.
 */
export function notionalValue(price: number, multiplier: number, quantity: number): number {
  return Math.abs(price * multiplier * quantity);
}

/**
 * @description Leverage of a position against account equity — notional / equity. Reported on every
 * run because it is derivable from the real specs and immediately answers "could this account have
 * held that?" even when no performance bond has been supplied.
 * @param price - Contract price.
 * @param multiplier - Dollars per full price point.
 * @param quantity - Contracts held.
 * @param equity - Account equity at the time.
 * @returns Leverage multiple; 0 when equity is non-positive (an unfundable book, not infinite leverage).
 */
export function leverageAt(price: number, multiplier: number, quantity: number, equity: number): number {
  if (!(equity > 0)) return 0;
  return notionalValue(price, multiplier, quantity) / equity;
}

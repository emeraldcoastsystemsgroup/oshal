/**
 * Trading autopilot — the IDLE-CASH YIELD SLEEVE (ADR-052 addendum P6), the dispatch half.
 *
 * When the sleeve is armed for a book (yieldSleeveFloatPct > 0 through the one resolver the Strategy
 * Lab also reads), the fund it parks in (SGOV by default) stops being a position of any leg and
 * becomes the book's parked cash:
 *  - EXEMPT: the dispatch removes the holding from every leg's view (sleevePositions) and adds the
 *    symbol to the core exemption set, so no stop, trailing exit, cap trim, rotation drop-out, bench,
 *    breakdown or technical sell can touch it, it takes no maxPositions slot, it does not count as
 *    deployed exposure, and no scan or rotation can buy it as an entry.
 *  - SELL FIRST, THEN BUY: an entry leg that needs more than the cash on hand sells the sleeve for the
 *    shortfall (decision reason 'yield-sleeve-fund'), waits for the sale, RE-READS the real cash
 *    through capAccount and only then buys, never spending anticipated proceeds. The scan leg sizes its
 *    entries as if the sleeve were cash and places them after the sale (placeSleeveFunded); the rotation
 *    sells the sleeve before its own settle wait and re-read (fundRotation).
 *  - SETTLED CASH: capAccount clamps a cash-type book to settled cash (ADR-134 D8, c1804d49), so a
 *    sleeve sale's unsettled proceeds are never spent the day they are raised. Those proceeds, read from
 *    this book's own ledger, count as cash already raised, so a cash book does not sell again for them.
 *  - REBALANCES ITSELF: on a QUIET fire (regular hours, book enabled, no order placed this fire, no
 *    working order in the book) the sleeve parks the spendable cash above the float and refills the
 *    float from the sleeve, inside a 1%-of-equity dead band.
 * A held sleeve symbol the engine cannot account for (ADR-159 `unmanaged`) disarms the sleeve for the
 * fire, so the holding stays monitored-not-managed. The sleeve's own working order makes it idle for
 * the fire, and a failed ledger read does too. Unarmed, every export here is a no-op that performs no
 * I/O, so the fire is byte-identical to before.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — YieldSleeveControl and resolveYieldSleeve (knob or mode-aware env arm; disarmed when the symbol is a beta-core symbol or the holding is unaccounted; idle while its own order works or a ledger read fails; unsettled sleeve proceeds on a cash-type book), sleevePositions / sleeveExemptSymbols (the exemption), sleeveSpendable, fundFromSleeve (the 'yield-sleeve-fund' sell), placeSleeveFunded (the scan leg's sell-first placement against the re-read cash), rotationDemand / rotationProceeds (the rotation buy loop's dollars and its own sale proceeds, walked the way the loops walk them), fundRotation (the rotation's shortfall, sold before its own settle and re-read) and rebalanceYieldSleeve (park / refill on a quiet fire). Logs as module 'trading-schedule-dispatch', the watchdog/operator contract.
 *
 * @module trading-dispatch-yield-sleeve
 */

import type { AppContext } from './composition-root';
import {
  getBrokerAdapter, yieldSleeveFloatPct, yieldSleeveSymbol, sleeveRebalancePlan, sleeveFundingQty,
  type Position, type TradingBook, type BrokerAccount,
} from '@/features/trading';
import type { ConfigOverrideRow } from './trading-config-overrides';
import { placeManaged, bookBinding, capAccount, loadInFlight, type RunOrder, type DecisionInput } from './trading-dispatch-rail';
import { coreConfig, sizingPrice } from './trading-dispatch-core';
import { settlementApplies, unsettledLedgerSells } from './trading-settlement';
import type { PlanLedger } from './trading-position-plans';
import { createChildLogger } from '@/shared/logger';

// Module name kept as the dispatch's: the log stream is the watchdog/operator contract.
const logger = createChildLogger({ module: 'trading-schedule-dispatch' });

/** The wait between a sell-first funding sale and the cash re-read: the rotation's own settle wait. */
export const SLEEVE_SETTLE_MS = 6000;

type Errors = Array<{ symbol: string; error: string }>;

/** The armed sleeve for one fire. Null everywhere means the sleeve is off for the book. */
export interface YieldSleeveControl {
  /** The fund the sleeve parks in (UPPERCASE). */
  symbol: string;
  /** The working float, percent of equity. */
  floatPct: number;
  /** Engine-managed sleeve shares held at fire start. */
  heldQty: number;
  /** Their market value at fire start. */
  heldValue: number;
  /** Why the sleeve places nothing this fire (its own order still working, an unreadable ledger); null = active. */
  idleReason: string | null;
  /** True when the book has any working order: the quiet-fire rebalance waits; entry funding does not. */
  bookWorking: boolean;
  /** Filled sleeve sales whose proceeds have not settled (cash-type books only; 0 elsewhere). */
  pendingProceeds: number;
  /** Shares this fire has already sold to fund entries, so no second leg sells them again. */
  soldQty: number;
}

/**
 * @description Resolve the sleeve for one fire. Off (null, no I/O) unless the applied strategy's knob
 * or the mode-aware env arms the book. Also null when the sleeve symbol is a beta-core symbol (the two
 * rails would fight over one holding) or the held sleeve shares are unaccounted (ADR-159: the engine
 * never manages what its own fills do not explain). Reads, only when armed: the book's working orders
 * (the sleeve is idle while its own order works) and, on a cash-type book, the sleeve's unsettled sales.
 * A failed read idles the sleeve for the fire, never trades it.
 * @param pool - Postgres pool (order ledger).
 * @param sub - Owner sub.
 * @param book - The book firing.
 * @param override - The applied Strategy Library override, when one is active.
 * @param positions - The fire's marked, overlaid positions (before any leg reads them).
 * @returns The control, or null when the sleeve is off or disarmed for this fire.
 */
export async function resolveYieldSleeve(
  pool: AppContext['pool'], sub: string, book: TradingBook, override: ConfigOverrideRow | null, positions: Position[],
): Promise<YieldSleeveControl | null> {
  const floatPct = yieldSleeveFloatPct(override?.config.yieldSleeveFloatPct, book.kind);
  if (floatPct <= 0) return null;
  const symbol = yieldSleeveSymbol();
  if (coreConfig(override).symbols.includes(symbol)) {
    logger.warn({ sub, bookRef: book.ref, symbol }, 'yield sleeve NOT armed this fire: its symbol is a beta-core symbol');
    return null;
  }
  const rows = positions.filter((p) => p.symbol.toUpperCase() === symbol && p.qty > 0);
  if (rows.some((p) => p.unmanaged === true)) {
    logger.info({ sub, bookRef: book.ref, symbol }, 'yield sleeve WITHHELD — the engine cannot account for this holding from its own fills; monitored, not managed');
    return null;
  }
  const [working, pending] = await Promise.all([workingOrders(pool, sub, book), pendingSleeveProceeds(pool, sub, book, symbol)]);
  const idleReason = working == null ? 'the working-order ledger could not be read'
    : working.has(symbol) ? `a ${symbol} order is still working at the venue`
      : pending == null ? 'the unsettled-sales ledger could not be read' : null;
  const control: YieldSleeveControl = {
    symbol, floatPct, heldQty: rows.reduce((s, p) => s + p.qty, 0), heldValue: rows.reduce((s, p) => s + Math.max(0, p.marketValue), 0),
    idleReason, bookWorking: working == null || working.size > 0, pendingProceeds: pending ?? 0, soldQty: 0,
  };
  if (idleReason) logger.info({ sub, bookRef: book.ref, symbol, idleReason }, 'yield sleeve idle this fire (exempt, but places nothing)');
  return control;
}

/** The book's working-order symbols, or null when the ledger read failed (logged). */
async function workingOrders(pool: AppContext['pool'], sub: string, book: TradingBook): Promise<Set<string> | null> {
  try { return (await loadInFlight(pool, sub, book)).symbols; } catch (err) {
    logger.error({ err, sub, bookRef: book.ref }, 'yield sleeve: working-order read FAILED — sleeve idle this fire');
    return null;
  }
}

/** Unsettled proceeds of this book's own sleeve sales (0 on a book settlement does not apply to); null on a failed read. */
async function pendingSleeveProceeds(pool: AppContext['pool'], sub: string, book: TradingBook, symbol: string): Promise<number | null> {
  if (!settlementApplies(book)) return 0;
  try {
    const sells = await unsettledLedgerSells(pool, sub, book);
    return sells.filter((s) => s.symbol === symbol).reduce((t, s) => t + s.qty * s.price, 0);
  } catch (err) {
    logger.error({ err, sub, bookRef: book.ref }, 'yield sleeve: unsettled-sales read FAILED on a cash-type book — sleeve idle this fire');
    return null;
  }
}

/**
 * @description Every leg's view of the book: the armed sleeve's holding removed (it is parked cash,
 * not a position). Unarmed, the SAME array comes back.
 * @param positions - The fire's marked positions.
 * @param control - The fire's sleeve control (null = off).
 * @returns The positions the legs read.
 */
export function sleevePositions(positions: Position[], control: YieldSleeveControl | null | undefined): Position[] {
  if (!control) return positions;
  return positions.filter((p) => p.symbol.toUpperCase() !== control.symbol);
}

/**
 * @description The symbols the armed sleeve adds to the core exemption set (never scanned, ranked,
 * bought as an entry or sold by a sleeve leg). Empty when off.
 * @param control - The fire's sleeve control (null = off).
 * @returns [] or [the sleeve symbol].
 */
export function sleeveExemptSymbols(control: YieldSleeveControl | null | undefined): string[] {
  return control ? [control.symbol] : [];
}

/**
 * @description Dollars of sleeve an entry leg may count as spendable right now: the held value not
 * yet sold this fire. 0 while the sleeve is idle or empty.
 * @param control - The fire's sleeve control (null = off).
 * @returns Spendable sleeve dollars.
 */
export function sleeveSpendable(control: YieldSleeveControl | null | undefined): number {
  if (!control || control.idleReason || !(control.heldQty > 0)) return 0;
  return Math.max(0, control.heldQty - control.soldQty) * (control.heldValue / control.heldQty);
}

/** A sleeve decision for the rail. */
function sleeveDecision(control: YieldSleeveControl, side: 'buy' | 'sell', qty: number, price: number, reason: string, rationale: string): DecisionInput {
  return {
    symbol: control.symbol, action: side, side, qty, confidence: 1, rationale,
    indicators: { reason, floatPct: control.floatPct }, price, source: 'yield-sleeve',
  };
}

/** The sleeve fund's sizing price: the book's own venue (live fails closed), paper falling back to the held mark. */
function sleevePrice(sub: string, book: TradingBook, control: YieldSleeveControl): Promise<number | null> {
  const mark = control.heldQty > 0 ? control.heldValue / control.heldQty : null;
  return sizingPrice(book.kind, sub, control.symbol, mark);
}

/**
 * @description Sell the sleeve FIRST for what a leg's buys need beyond the cash already on hand or on
 * its way (decision reason 'yield-sleeve-fund'). Places nothing when the sleeve is off, idle or empty,
 * when there is no shortfall, or when the fund cannot be priced from the book's own venue.
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param book - The book firing.
 * @param control - The fire's sleeve control (null = off).
 * @param shortfall - Dollars the leg's buys need beyond the cash it can see.
 * @param orders - Run-order accumulator.
 * @param errors - Run-error accumulator.
 * @param leg - The leg asking ('scan' | 'rotation' | 'blend-rotation'), for the journal.
 * @returns The dollars the sale is expected to raise (0 when nothing was placed). An estimate: the
 *   caller still funds its buys only from a re-read of the real cash.
 */
export async function fundFromSleeve(
  ctx: AppContext, sub: string, book: TradingBook, control: YieldSleeveControl | null | undefined, shortfall: number,
  orders: RunOrder[], errors: Errors, leg: string,
): Promise<number> {
  if (!control || control.idleReason) return 0;
  const need = shortfall - control.pendingProceeds;
  if (!(need > 0) || !(control.heldQty - control.soldQty >= 1)) return 0;
  const px = await sleevePrice(sub, book, control);
  if (!px) return 0;
  const qty = sleeveFundingQty(need, px, control.heldQty - control.soldQty);
  if (qty < 1) return 0;
  const before = orders.length;
  await placeManaged(ctx, sub, book, sleeveDecision(control, 'sell', qty, px, 'yield-sleeve-fund',
    `Yield sleeve — selling ${qty} ${control.symbol} FIRST to fund this fire's ${leg} buys ($${Math.round(need)} beyond the cash on hand); the buys are sized from the cash re-read after the sale.`),
  orders, errors, 'yield-sleeve-fund');
  if (orders.length === before) return 0;
  control.soldQty += qty;
  logger.info({ sub, bookRef: book.ref, leg, symbol: control.symbol, qty, need: Math.round(need) }, 'yield sleeve sold first to fund entries');
  return qty * px;
}

/**
 * @description Wait for a funding sale, then re-read the account through capAccount (the capital cap,
 * then the settled-cash clamp on a cash-type book). Null when the read fails (logged): the caller then
 * spends only the cash it already had.
 * @param sub - Owner sub.
 * @param book - The book firing.
 * @returns The fresh capped snapshot, or null.
 */
async function settleAndReread(sub: string, book: TradingBook): Promise<BrokerAccount | null> {
  await new Promise((r) => setTimeout(r, SLEEVE_SETTLE_MS));
  const fresh = await getBrokerAdapter(book.kind, sub, bookBinding(book)).getAccount().catch((err) => {
    logger.warn({ err, sub, bookRef: book.ref }, 'yield sleeve: post-sale account re-read failed — buys spend only the cash already on hand');
    return null;
  });
  return fresh ? capAccount(fresh, book) : null;
}

/** One scan entry the leg sized and deferred until the sleeve has been sold. */
export interface DeferredBuy { decision: DecisionInput; price: number }

/**
 * @description The scan leg's sell-first placement: the entries were sized as if the sleeve were cash;
 * sell the sleeve for the shortfall, wait, re-read the real cash, then place each entry in order,
 * clipped to the cash actually available — min(re-read cash, cash on hand + the sale's estimate), so
 * neither an unsettled proceed nor a failed sale is ever spent.
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param book - The book firing.
 * @param account - The leg's account snapshot (in-flight and core cash already reserved).
 * @param buys - The sized entries, strongest first.
 * @param control - The fire's sleeve control.
 * @param orders - Run-order accumulator.
 * @param errors - Run-error accumulator.
 * @param plans - The fire's exit-plan ledger (each buy stamps its plan exactly as an unfunded one does).
 * @returns Resolves when every entry has been placed or clipped away.
 */
export async function placeSleeveFunded(
  ctx: AppContext, sub: string, book: TradingBook, account: BrokerAccount, buys: DeferredBuy[],
  control: YieldSleeveControl, orders: RunOrder[], errors: Errors, plans: PlanLedger | null | undefined,
): Promise<void> {
  const demand = buys.reduce((s, b) => s + b.decision.qty * b.price, 0);
  const raised = await fundFromSleeve(ctx, sub, book, control, demand - account.cash, orders, errors, 'scan');
  let cash = Math.max(0, account.cash);
  if (raised > 0) {
    const fresh = await settleAndReread(sub, book);
    if (fresh) cash = Math.max(0, Math.min(fresh.cash, account.cash + raised));
  }
  for (const b of buys) {
    const qty = Math.min(b.decision.qty, Math.floor(cash / b.price));
    if (qty < 1) {
      logger.info({ sub, bookRef: book.ref, symbol: b.decision.symbol, wanted: b.decision.qty, cash: Math.round(cash) }, 'sleeve-funded entry skipped — the re-read cash does not cover a share');
      continue;
    }
    await placeManaged(ctx, sub, book, { ...b.decision, qty }, orders, errors, undefined, plans);
    cash -= qty * b.price;
  }
}

/** What a rotation rebalance knows when it asks the sleeve for its shortfall. */
export interface RotationNeed {
  /** The buy targets, in buy order. */
  targets: string[];
  /** Each target's dollar goal. */
  goalOf: (sym: string) => number;
  /** Dollars already held per target (after the drop-out sells). */
  heldNow: Map<string, number>;
  /** The rebalance's dust threshold. */
  dust: number;
  /** Open positions after the drop-out sells. */
  open: number;
  /** The policy's position cap. */
  maxPositions: number;
  /** Market value of the drop-out sells this rebalance placed. */
  soldValue: number;
  /** Targets the rebalance never trims (ADR-159 unaccounted holdings). */
  skip: Set<string>;
}

/**
 * @description The dollars a rotation's buy loop would spend, walked the way the loop walks it (targets
 * in order, the loop stops once the book is at its position cap, a new name takes a slot, a gap within
 * the dust is skipped). A withheld (ADR-159) target counts too: the loop reserves its dollars rather
 * than spending them elsewhere, so the targets after it need that cash covered. Pure.
 * @param n - The rebalance facts.
 * @returns The buy demand in dollars.
 */
export function rotationDemand(n: RotationNeed): number {
  let open = n.open;
  let demand = 0;
  for (const sym of n.targets) {
    if (open >= n.maxPositions) break;
    const gap = n.goalOf(sym) - (n.heldNow.get(sym) ?? 0);
    if (gap <= n.dust) continue;
    demand += gap;
    if (!n.heldNow.has(sym)) open += 1;
  }
  return demand;
}

/**
 * @description The dollars a rotation's own sales are expected to raise: its drop-out sells plus every
 * over-goal trim, measured the way the trim loop measures them (before share rounding). Pure.
 * @param n - The rebalance facts.
 * @returns The expected proceeds in dollars.
 */
export function rotationProceeds(n: RotationNeed): number {
  let trims = 0;
  for (const sym of n.targets) {
    const cur = n.heldNow.get(sym) ?? 0;
    const over = cur - n.goalOf(sym);
    if (cur > 0 && over > n.dust && !n.skip.has(sym.toUpperCase())) trims += over;
  }
  return Math.max(0, n.soldValue) + trims;
}

/**
 * @description A rotation's sell-first funding: sell the sleeve for what the buy loop will need beyond
 * the cash on hand and the rebalance's own sale proceeds, BEFORE the rotation's settle wait, so its
 * existing re-read of the real cash funds the buys. No-op when the sleeve is off, idle or empty.
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param book - The book firing.
 * @param control - The fire's sleeve control (null = off).
 * @param account - The rotation's opening snapshot.
 * @param need - The rebalance facts.
 * @param orders - Run-order accumulator.
 * @param errors - Run-error accumulator.
 * @param leg - 'rotation' | 'blend-rotation'.
 * @returns Resolves when the sale (if any) has been placed.
 */
export async function fundRotation(
  ctx: AppContext, sub: string, book: TradingBook, control: YieldSleeveControl | null | undefined, account: BrokerAccount,
  need: RotationNeed, orders: RunOrder[], errors: Errors, leg: string,
): Promise<void> {
  if (!control || control.idleReason) return;
  await fundFromSleeve(ctx, sub, book, control, rotationDemand(need) - (Math.max(0, account.cash) + rotationProceeds(need)), orders, errors, leg);
}

/**
 * @description The sleeve's own rebalance, on a QUIET fire only: regular hours, book enabled, the
 * sleeve active, no working order in the book and no order placed by any leg this fire (a fire that
 * traded waits for the next one, so every figure is one the venue has already settled into cash).
 * Parks the spendable cash above the float, or refills the float from the sleeve, from a fresh
 * account read through capAccount.
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param book - The book firing.
 * @param control - The fire's sleeve control (null = off: returns at once, no I/O).
 * @param orders - Run-order accumulator (read to detect a quiet fire; the sleeve's order is appended).
 * @param errors - Run-error accumulator.
 * @param extHours - True in pre/post-market (the sleeve does not trade off-hours).
 * @returns Resolves when the park or refill (if any) has been placed.
 */
export async function rebalanceYieldSleeve(
  ctx: AppContext, sub: string, book: TradingBook, control: YieldSleeveControl | null | undefined,
  orders: RunOrder[], errors: Errors, extHours: boolean,
): Promise<void> {
  if (!control) return;
  if (extHours || !book.enabled || control.idleReason || control.bookWorking || control.soldQty > 0 || orders.length > 0) return;
  const fresh = await getBrokerAdapter(book.kind, sub, bookBinding(book)).getAccount().catch((err) => {
    logger.warn({ err, sub, bookRef: book.ref }, 'yield sleeve: account read failed — no rebalance this fire');
    return null;
  });
  if (!fresh) return;
  const acct = capAccount(fresh, book);
  const px = await sleevePrice(sub, book, control);
  if (!px) return;
  const plan = sleeveRebalancePlan({ equity: acct.equity, cash: acct.cash, pending: control.pendingProceeds, floatPct: control.floatPct, price: px, heldQty: control.heldQty });
  if (plan.action === 'hold') return;
  const park = plan.action === 'park';
  await placeManaged(ctx, sub, book, sleeveDecision(control, park ? 'buy' : 'sell', plan.qty, px, park ? 'yield-sleeve-park' : 'yield-sleeve-refill', park
    ? `Yield sleeve — parking idle cash above the ${control.floatPct}% working float in ${control.symbol}; it is sold first whenever an entry needs the cash.`
    : `Yield sleeve — selling ${plan.qty} ${control.symbol} to restore the ${control.floatPct}% working cash float.`),
  orders, errors, park ? 'yield-sleeve-park' : 'yield-sleeve-refill');
  logger.info({ sub, bookRef: book.ref, symbol: control.symbol, action: plan.action, qty: plan.qty, cash: Math.round(acct.cash) }, 'yield sleeve rebalanced');
}

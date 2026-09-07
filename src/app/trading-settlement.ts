/**
 * Cash-account settlement (ADR-134 D8) — a thin kernel layer over facts the venue already reports.
 *
 * A CASH account settles a sale T+n business days after the trade (US equities: T+1). Buying with
 * the unsettled proceeds is allowed by the venue, but selling THAT purchase before the proceeds
 * settle is a good-faith violation, and three of those freeze the account for 90 days. Margin
 * accounts (every Alpaca paper account) have no such constraint. This module therefore:
 *
 *   - builds ONE SettlementView per book: the account type (the bound account's discovered type
 *     first, then the venue's report; an unknown type on a LIVE book is treated as cash — fail
 *     closed, which means EVERY BUY on a typeless live book — the legacy live book included — costs
 *     one venue account read, and a failed read under 'refuse' refuses that buy even when the
 *     venue would have reported MARGIN), the settled and unsettled cash (venue figures first, else
 *     derived from this book's own filled sells in the ledger) and the date the proceeds settle;
 *   - exposes one PURE clamp (settledBuyingPower / clampToSettled: cash := min(cash, settled)) the
 *     autopilot's capAccount routes through so rotation/core/pop sizing spends only settled cash;
 *   - exposes one refusal helper (assertSettledFunding) the engine's single order path calls for
 *     every BUY, so an operator buy and an autonomous buy meet the same wall: 422 settlement_blocked
 *     under 'refuse', a logged warning under 'warn'. SELLs are never touched — protective exits stay
 *     unconditional, and the sell short-circuit performs ZERO I/O.
 *
 * Policy is config-first: TRADING_CASH_SETTLEMENT_POLICY (refuse | warn | off, default refuse) is
 * the fleet default; oshal_trading_books.settlement_policy (refuse | warn) overrides it per book;
 * 'off' exists only in the env — a book can tighten or soften the guard, never disarm it.
 * TRADING_SETTLEMENT_DAYS (default 1) is the settlement cycle; every message derives its "T+n" from
 * it. settlesOn is weekday-only (no exchange-holiday calendar — the same documented limitation as
 * ADR-136 D4 timed orders).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — settlement policy/days readers (env, per call), business-day settlesOn in ET, the book-scoped ledger fallback (filled sells keyed on COALESCE(submitted_at, created_at) — never updated_at, which every status re-poll bumps), buildSettlementView (venue figures win; unknown live type = cash), the pure clamp, settlementViolation (only a BUY that needs unsettled proceeds trips it — a plain shortfall is the venue's own refusal), gfvAdvisory (a warning on selling a symbol bought while proceeds were unsettled — never a block) and assertSettledFunding (the engine backstop: 422 settlement_blocked / 503 settlement_unknown under refuse, structured warn under warn). Guard: tests/unit/trading-settlement.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: the market-price read for a market BUY no longer swallows its error (a bare catch that returned null) — sizingPrice() logs the failure at error and, under 'warn', assertSettledFunding returns an explicit "this buy was NOT checked" advisory (blindGuardWarning) instead of silently passing a $0 notional; 'refuse' stays 503 settlement_unknown. Documented the typeless-live-book cost (one venue read per BUY, failed read = refused buy) and the withdrawable-only fallback's possible over-refusal.
 *
 * @module trading-settlement
 */

import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import type { BrokerAccount, TradingBook } from '@/features/trading';
import { TradingError } from './routes/trading-routes-helpers';

const logger = createChildLogger({ module: 'trading-settlement' });

/** The guard's posture. 'off' can only come from the env — see settlementPolicy(). */
export type SettlementPolicy = 'refuse' | 'warn' | 'off';
/** The account type the guard reasons about; 'unknown' is treated as cash on a live book. */
export type SettlementAccountType = 'cash' | 'margin' | 'unknown';

/** A settlement date: the ET calendar day plus the words every surface shows. */
export interface SettlesOn { iso: string; words: string }

/** One filled SELL from this book's ledger, as the fallback reads it. */
export interface LedgerSell { symbol: string; qty: number; price: number; tradedAt: Date }

/** The settlement facts for one book at one instant — what the ticket, the clamp and the refusal all read. */
export interface SettlementView {
  accountType: SettlementAccountType;
  policy: SettlementPolicy;
  /** Total cash as the venue reports it (null when the account could not be read). */
  cash: number | null;
  /** Cash spendable without touching unsettled proceeds (null when unknown — see `source`). */
  settledCash: number | null;
  /** Sale proceeds still inside the settlement window. */
  unsettledCash: number;
  /** When the unsettled proceeds settle (the LATEST date across the sells); null when nothing is unsettled. */
  settlesOn: SettlesOn | null;
  /** Where the settled figure came from: the venue, this book's own ledger, or nowhere (n/a). */
  source: 'venue' | 'ledger' | 'n/a';
  /** How many business days a sale takes to settle (TRADING_SETTLEMENT_DAYS). */
  settlementDays: number;
}

/** @description US-equity settlement cycle in business days. Config → env TRADING_SETTLEMENT_DAYS → default 1. */
export function settlementDays(): number {
  const n = Number(process.env.TRADING_SETTLEMENT_DAYS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

/** @description The "T+n" label every message uses — derived from TRADING_SETTLEMENT_DAYS, never typed. */
export function settlementLabel(days: number = settlementDays()): string { return `T+${days}`; }

/** @description The fleet default. Config → env TRADING_CASH_SETTLEMENT_POLICY (refuse|warn|off) → default 'refuse'. */
export function fleetSettlementPolicy(): SettlementPolicy {
  const v = String(process.env.TRADING_CASH_SETTLEMENT_POLICY || 'refuse').toLowerCase();
  return v === 'warn' || v === 'off' ? v : 'refuse';
}

/**
 * @description The effective policy for a book: the env 'off' disarms the guard fleet-wide (the
 * rollback switch); otherwise the book's own refuse|warn override wins over the env default.
 * @param book - The trading book.
 * @returns refuse | warn | off.
 */
export function settlementPolicy(book: TradingBook): SettlementPolicy {
  const fleet = fleetSettlementPolicy();
  if (fleet === 'off') return 'off';
  return book.settlementPolicy === 'refuse' || book.settlementPolicy === 'warn' ? book.settlementPolicy : fleet;
}

/**
 * @description Whether the guard has anything to do for this book BEFORE any I/O: a margin book, a
 * paper book with no discovered type (Alpaca paper = margin) and policy 'off' are all no-ops.
 * @param book - The trading book.
 * @returns True when a BUY on this book must be checked against settled cash.
 */
export function settlementApplies(book: TradingBook): boolean {
  if (settlementPolicy(book) === 'off') return false;
  if (book.accountType === 'margin') return false;
  if (book.kind === 'paper' && !book.accountType) return false;
  return true;
}

/* ── Eastern calendar helpers (weekday-only; holidays are the documented ADR-136 D4 limitation) ── */
const ET_TZ = 'America/New_York';
const ET_DAY = new Intl.DateTimeFormat('en-US', { timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const WORDS = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

/** @description The ET calendar day of an instant as 'YYYY-MM-DD'. */
export function etDay(at: Date): string {
  const p: Record<string, string> = {};
  for (const part of ET_DAY.formatToParts(at)) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * @description The settlement date of a trade: `days` business days (Mon–Fri) after its ET trade day.
 * @param tradedAt - The trade instant.
 * @param days - Business days to settle (default TRADING_SETTLEMENT_DAYS).
 * @returns The ET date and its words ('Tue Sep 8').
 */
export function nextSettlementDate(tradedAt: Date, days: number = settlementDays()): SettlesOn {
  const [y, m, d] = etDay(tradedAt).split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  const weekend = () => cur.getUTCDay() === 0 || cur.getUTCDay() === 6;
  // A trade dated on a weekend (a reconcile row) counts as the next business day's trade — the
  // conservative reading: its proceeds stay unsettled longer, never shorter.
  while (weekend()) cur.setUTCDate(cur.getUTCDate() + 1);
  let left = days;
  while (left > 0) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (!weekend()) left -= 1;
  }
  return { iso: cur.toISOString().slice(0, 10), words: WORDS.format(cur).replace(',', '') };
}

/** Whether a trade's proceeds are still unsettled at `now` (they are spendable ON the settlement day). */
function isUnsettled(tradedAt: Date, now: Date, days: number): boolean {
  return nextSettlementDate(tradedAt, days).iso > etDay(now);
}

/**
 * @description This book's own filled SELLs whose proceeds have not settled yet — the fallback when
 * the venue reports no settlement figures (and the source of the settlement DATE in every case).
 * Keyed on COALESCE(submitted_at, created_at): recordOrder keeps the first submitted_at, whereas
 * updated_at is bumped by every status re-poll and would make a days-old sell look like today's.
 * The book-scoped WHERE is the wall under system identity (dispatch runs is_operator=on).
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param book - The book.
 * @param now - The clock (injected for specs).
 * @returns The unsettled sells, oldest first.
 */
export async function unsettledLedgerSells(pool: AppContext['pool'], sub: string, book: TradingBook, now: Date = new Date()): Promise<LedgerSell[]> {
  const days = settlementDays();
  // Wide calendar window (business days + weekends + slack); the exact business-day test runs in TS.
  const sinceMs = now.getTime() - (days * 2 + 4) * 86_400_000;
  const rows = (await pool.query(
    `SELECT symbol, filled_qty, filled_avg_price, COALESCE(submitted_at, created_at) AS traded_at
       FROM oshal_trading_orders
      WHERE user_sub=$1 AND book_id=$2 AND side='sell' AND status IN ('filled','partially_filled')
        AND filled_qty > 0 AND COALESCE(submitted_at, created_at) >= $3
      ORDER BY COALESCE(submitted_at, created_at) ASC`,
    [sub, book.bookId, new Date(sinceMs).toISOString()])).rows;
  return rows
    .map((r) => ({ symbol: String(r.symbol).toUpperCase(), qty: Number(r.filled_qty), price: Number(r.filled_avg_price || 0), tradedAt: new Date(r.traded_at) }))
    .filter((s) => Number.isFinite(s.tradedAt.getTime()) && isUnsettled(s.tradedAt, now, days));
}

/** The latest settlement date across a set of sells (null when empty). */
function latestSettlesOn(sells: LedgerSell[], days: number): SettlesOn | null {
  let best: SettlesOn | null = null;
  for (const s of sells) { const d = nextSettlementDate(s.tradedAt, days); if (!best || d.iso > best.iso) best = d; }
  return best;
}

/**
 * @description Build the settlement view for a book. PURE. Account type = the book's discovered type,
 * else the venue's report, else 'unknown' on a live book (treated as cash — fail closed) / 'margin'
 * on paper. Venue settled/unsettled figures win; otherwise settled = cash − Σ(unsettled ledger sells).
 * The settlement DATE comes from the ledger sells when there are any, else (venue says unsettled > 0
 * but the ledger saw no sell — a sale made outside oshal) from a trade dated now.
 * @param account - The broker snapshot, or null when the read failed.
 * @param book - The book.
 * @param ledgerSells - This book's unsettled sells (see unsettledLedgerSells); [] when not consulted.
 * @param now - The clock.
 * @returns The view.
 */
export function buildSettlementView(account: BrokerAccount | null, book: TradingBook, ledgerSells: LedgerSell[], now: Date = new Date()): SettlementView {
  const days = settlementDays();
  const policy = settlementPolicy(book);
  const accountType: SettlementAccountType = book.accountType ?? account?.accountType ?? (book.kind === 'live' ? 'unknown' : 'margin');
  const cash = account ? Number(account.cash || 0) : null;
  if (accountType === 'margin') {
    return { accountType, policy, cash, settledCash: cash, unsettledCash: 0, settlesOn: null, source: 'n/a', settlementDays: days };
  }
  if (!account) return { accountType, policy, cash: null, settledCash: null, unsettledCash: 0, settlesOn: null, source: 'n/a', settlementDays: days };
  const ledgerUnsettled = ledgerSells.reduce((sum, s) => sum + s.qty * s.price, 0);
  if (typeof account.settledCash === 'number' && Number.isFinite(account.settledCash)) {
    // Fallback derivation (venue gave settledCash but no unsettledCash — Schwab's withdrawable-only
    // shape): unsettled = cash − settled may also count non-settlement holds (pending buys, fees),
    // so this path can over-refuse. Fail-closed by design; the primary path uses the venue's own figure.
    const unsettled = typeof account.unsettledCash === 'number' ? Math.max(0, account.unsettledCash) : Math.max(0, (cash as number) - account.settledCash);
    const settlesOn = unsettled > 0 ? (latestSettlesOn(ledgerSells, days) ?? nextSettlementDate(now, days)) : null;
    return { accountType, policy, cash, settledCash: Math.max(0, account.settledCash), unsettledCash: unsettled, settlesOn, source: 'venue', settlementDays: days };
  }
  return {
    accountType, policy, cash, settledCash: Math.max(0, (cash as number) - ledgerUnsettled), unsettledCash: ledgerUnsettled,
    settlesOn: latestSettlesOn(ledgerSells, days), source: 'ledger', settlementDays: days,
  };
}

/**
 * @description PURE clamp: on a cash-type book under an armed policy, cash and buyingPower can never
 * exceed settled cash. Margin books, policy 'off' and an unknown settled figure return the SAME
 * object values (paper byte-identity; an unreadable account is already $0 upstream).
 * @param account - The (possibly capped) broker snapshot.
 * @param view - The settlement view for the same book.
 * @returns The clamped snapshot.
 */
export function clampToSettled(account: BrokerAccount, view: SettlementView): BrokerAccount {
  if (view.policy === 'off' || view.accountType === 'margin' || view.settledCash == null) return account;
  return { ...account, cash: Math.min(account.cash, view.settledCash), buyingPower: Math.min(account.buyingPower, view.settledCash) };
}

/**
 * @description The one-line hook for the autopilot's capAccount (trading-schedule-dispatch.ts):
 * the venue snapshot the dispatcher already holds is enough — no ledger read in the sizing loop.
 * @param account - The capped account snapshot.
 * @param book - The book being run.
 * @param now - The clock.
 * @returns The snapshot with cash/buyingPower clamped to settled cash on a cash-type book.
 */
export function settledBuyingPower(account: BrokerAccount, book: TradingBook, now: Date = new Date()): BrokerAccount {
  if (!settlementApplies(book)) return account;
  return clampToSettled(account, buildSettlementView(account, book, [], now));
}

/** A refusal (or, under 'warn', an advisory) the guard hands back. */
export interface SettlementViolation { code: 'settlement_blocked'; message: string; settlesOn: SettlesOn | null; warnOnly: boolean }

const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * @description PURE: does a BUY of `notional` dollars need unsettled proceeds? Only a buy that exceeds
 * settled cash WHILE unsettled proceeds exist trips this — a plain shortfall with nothing unsettled
 * is the venue's own insufficient-funds refusal, not a settlement matter.
 * @param view - The settlement view.
 * @param notional - The buy's dollar size.
 * @returns The violation, or null.
 */
export function settlementViolation(view: SettlementView, notional: number): SettlementViolation | null {
  if (view.policy === 'off' || view.accountType === 'margin' || view.settledCash == null) return null;
  if (!(view.unsettledCash > 0) || notional <= view.settledCash + 0.005) return null;
  const when = view.settlesOn ? `on ${view.settlesOn.words}` : 'later';
  const message = `Only ${usd(view.settledCash)} of your ${usd(view.cash ?? view.settledCash + view.unsettledCash)} cash is settled; this ${usd(notional)} buy would use proceeds that settle ${when} (${settlementLabel(view.settlementDays)}). Wait for settlement or reduce the size.`;
  return { code: 'settlement_blocked', message, settlesOn: view.settlesOn, warnOnly: view.policy === 'warn' };
}

/**
 * @description PURE advisory for a SELL: selling a symbol that was BOUGHT on this book while sale
 * proceeds were still unsettled is the good-faith-violation shape. A warning, never a block — the
 * venue is the authority and protective exits must always be allowed to run.
 * @param view - The settlement view.
 * @param symbol - The symbol being sold.
 * @param recentBuys - This book's filled buys since the earliest unsettled sell (symbol + trade time).
 * @returns The advisory sentence, or null.
 */
export function gfvAdvisory(view: SettlementView, symbol: string, recentBuys: Array<{ symbol: string; tradedAt: Date }>): string | null {
  if (view.accountType === 'margin' || !(view.unsettledCash > 0) || !view.settlesOn) return null;
  const sym = symbol.toUpperCase();
  if (!recentBuys.some((b) => b.symbol.toUpperCase() === sym)) return null;
  return `${sym} was bought while ${usd(view.unsettledCash)} of sale proceeds were still unsettled — selling it before ${view.settlesOn.words} may be a good-faith violation (${settlementLabel(view.settlementDays)}). Three in a year freeze a cash account for 90 days.`;
}

/** The seams the engine hands the guard: the venue read and the price of a market order. */
export interface SettlementDeps {
  readAccount: () => Promise<BrokerAccount>;
  priceOf: (symbol: string) => Promise<number | null>;
  now?: Date;
}

/** Read the account through the seam; under 'refuse' an unreadable cash live book is a 503, under 'warn' a null. */
async function readAccountOrFail(deps: SettlementDeps, book: TradingBook, policy: SettlementPolicy): Promise<BrokerAccount | null> {
  try { return await deps.readAccount(); }
  catch (err) {
    logger.error({ err, bookRef: book.ref, policy }, 'settlement guard: broker account read failed');
    if (policy === 'refuse') throw new TradingError(503, 'settlement_unknown', `Could not read the account's settled cash for book '${book.ref}' — refusing the buy rather than risk spending unsettled proceeds (${settlementLabel()}).`);
    return null;
  }
}

/**
 * The price a BUY is sized at: the decision's own limit/stop price, else (market order) the book's
 * latest print — read ONLY when unsettled proceeds exist, since with nothing unsettled the guard
 * cannot trip regardless of size. A failed/absent price is LOGGED (never swallowed): under 'refuse'
 * it is a 503 settlement_unknown; under 'warn' it returns null so the caller can warn that the
 * guard was blind rather than silently pass a $0 notional.
 */
async function sizingPrice(deps: SettlementDeps, view: SettlementView, book: TradingBook, symbol: string, refPrice: number, policy: SettlementPolicy): Promise<number | null> {
  if (refPrice > 0) return refPrice;
  if (!(view.unsettledCash > 0)) return 0;
  let price: number | null = null;
  try { price = await deps.priceOf(symbol); }
  catch (err) { logger.error({ err, bookRef: book.ref, symbol, policy }, 'settlement guard: market-data price read failed'); }
  if (price != null && price > 0) return price;
  if (policy === 'refuse') {
    throw new TradingError(503, 'settlement_unknown', `No price for ${symbol} to size this buy against ${usd(view.settledCash ?? 0)} of settled cash (${usd(view.unsettledCash)} unsettled) — refusing rather than guess.`);
  }
  logger.warn({ bookRef: book.ref, symbol, settledCash: view.settledCash, unsettledCash: view.unsettledCash }, 'settlement guard: no price to size a market buy (policy warn) — proceeding unchecked');
  return null;
}

/** The advisory a 'warn' book gets when the guard could not price the buy — the operator learns the guard was blind. */
function blindGuardWarning(view: SettlementView, symbol: string): string {
  const when = view.settlesOn ? `on ${view.settlesOn.words}` : 'later';
  return `Could not price ${symbol} to check it against ${usd(view.settledCash ?? 0)} of settled cash — ${usd(view.unsettledCash)} of sale proceeds settle ${when} (${settlementLabel(view.settlementDays)}); this buy was NOT checked for unsettled funding.`;
}

/**
 * @description The engine backstop (ADR-134 D8): for a BUY on a cash-type book, refuse (422
 * settlement_blocked) or warn when the order would be funded by unsettled proceeds. A SELL returns
 * immediately with ZERO I/O (no venue read, no ledger query) — protective exits are untouched; so do
 * margin books, typeless paper books and policy 'off'. A market order is priced through `priceOf`
 * (refPrice is 0 for market orders); with unsettled proceeds present and no price, 'refuse' fails
 * closed (503 settlement_unknown) and 'warn' returns an explicit "not checked" advisory (the price
 * failure is logged, never swallowed). This helper only refuses or warns — it never places, cancels
 * or resizes anything.
 * @param pool - Postgres pool (ledger fallback + settlement date).
 * @param sub - Owner sub.
 * @param book - The book.
 * @param side - Order side.
 * @param symbol - Symbol.
 * @param qty - Shares.
 * @param refPrice - The decision's limit/stop price, or 0 for a market order.
 * @param deps - Venue read + price seams (+ an injectable clock).
 * @returns The warning (under 'warn') and the view, or nulls when the guard did not apply.
 */
export async function assertSettledFunding(
  pool: AppContext['pool'], sub: string, book: TradingBook, side: 'buy' | 'sell', symbol: string, qty: number, refPrice: number, deps: SettlementDeps,
): Promise<{ warning: string | null; view: SettlementView | null }> {
  if (side !== 'buy' || !settlementApplies(book)) return { warning: null, view: null };
  const policy = settlementPolicy(book);
  const now = deps.now ?? new Date();
  const account = await readAccountOrFail(deps, book, policy);
  if (!account) return { warning: null, view: null };
  const sells = await unsettledLedgerSells(pool, sub, book, now).catch((err) => {
    logger.error({ err, bookRef: book.ref }, 'settlement guard: ledger read failed — using venue figures only');
    return [] as LedgerSell[];
  });
  const view = buildSettlementView(account, book, sells, now);
  if (view.accountType === 'margin') return { warning: null, view };
  const price = await sizingPrice(deps, view, book, symbol, refPrice, policy);
  if (price == null) return { warning: blindGuardWarning(view, symbol), view };
  const violation = settlementViolation(view, qty * price);
  if (!violation) return { warning: null, view };
  if (!violation.warnOnly) {
    logger.warn({ sub, bookRef: book.ref, symbol, qty, notional: qty * price, settledCash: view.settledCash, unsettledCash: view.unsettledCash, settlesOn: view.settlesOn?.iso, source: view.source }, 'settlement guard: BUY refused — funded by unsettled proceeds');
    throw new TradingError(422, violation.code, violation.message);
  }
  logger.warn({ sub, bookRef: book.ref, symbol, qty, notional: qty * price, settledCash: view.settledCash, unsettledCash: view.unsettledCash, settlesOn: view.settlesOn?.iso, source: view.source }, 'settlement guard: BUY proceeds on unsettled funds (policy warn)');
  return { warning: violation.message, view };
}

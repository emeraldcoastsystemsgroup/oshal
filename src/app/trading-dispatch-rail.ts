/**
 * Trading autopilot — the order RAIL every leg places through (a leg of the dispatch loop).
 *
 * Carved VERBATIM out of trading-schedule-dispatch.ts (its CHANGE LOG SEQ 1-19 hold the history of
 * every function here: SEQ 1 persistDecision/placeManaged, SEQ 4 loadInFlight, SEQ 5 capAccount's
 * live-only scope, SEQ 7 the book-scoped requestId, SEQ 3 the exit/scan/breakdown decision mappers).
 * Zero behavior change: SQL, requestId text, guardrails snapshot and error accounting are byte-identical
 * to the monolith. The logger keeps module 'trading-schedule-dispatch' on purpose — the log stream is
 * the watchdog/operator contract, and the file split must be invisible to it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — decomposition of trading-schedule-dispatch.ts (890 code lines) along its section seams: bookBinding, the RunOrder/RunSummary/DecisionInput shapes, persistDecision + placeManaged (the signal → decision → placeDecisionOrder provenance chain), IN_FLIGHT_STATUSES + loadInFlight, the exit/scan/breakdown decision mappers and capAccount move here unchanged. Env names unchanged: TRADING_CAPITAL_CAP_USD. Golden-plan guard: tests/unit/trading-dispatch-golden-plan.spec.ts.
 *
 * @module trading-dispatch-rail
 */

import * as crypto from 'crypto';
import type { AppContext } from './composition-root';
import type { MtfDecision, TradingMode, TradingBook, BrokerAccount, ExitOrder } from '@/features/trading';
import { guardrails, placeDecisionOrder } from './trading-engine';
import { legacyBook } from './trading-books-store';
import { WORLD_SENT_MIN_POINTS, type WorldSent } from './trading-dispatch-world-gate';

/** Agent id stamped on autopilot-authored decisions/signals (deterministic engine, no LLM). */
const AUTOPILOT_AGENT = 'mtf-autopilot';

/**
 * @description A book's adapter binding — undefined for legacy/unbound books (the factory also ignores bindings
 *  entirely while TRADING_MULTI_ACCOUNT is off; ADR-134 flag-off byte-parity).
 * @param book - The book being run.
 * @returns The account binding for the broker factory, or undefined for a legacy/unbound book.
 */
export function bookBinding(book: TradingBook): { accountNumber: string; connectionKey: string | null } | undefined {
  return book.accountNumber ? { accountNumber: book.accountNumber, connectionKey: book.connectionKey } : undefined;
}

/** A placed/attempted order in a run summary. */
export interface RunOrder { symbol: string; side: 'buy' | 'sell'; qty: number; status: string; id: string; reason?: string; }
/** The outcome of one autopilot fire. */
export interface RunSummary { scanned: number; entries: number; exits: number; orders: RunOrder[]; errors: Array<{ symbol: string; error: string }>; posture: string; }

/** A persistable decision (entry from a scan, or a protective exit) — the input to persistDecision. */
export interface DecisionInput {
  symbol: string; action: 'buy' | 'sell'; side: 'buy' | 'sell'; qty: number;
  confidence: number; rationale: string; indicators: unknown; price: number | null; source: string;
}

/**
 * @description Persist the provenance chain for one decision: a signal snapshot, then a decision row
 * referencing it. Returns the decision id placeDecisionOrder executes. Shared by entries + exits.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param mode - Book (paper).
 * @param d - The decision to persist.
 * @returns The persisted decision id.
 */
async function persistDecision(pool: AppContext['pool'], sub: string, bookOrMode: TradingBook | TradingMode, d: DecisionInput): Promise<string> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  // Minute-bucketed hash → each run is a distinct signal; same run de-dupes idempotently.
  const bucket = new Date().toISOString().slice(0, 16);
  const hash = crypto.createHash('sha256').update(JSON.stringify({ s: d.symbol, a: d.action, src: d.source, ind: d.indicators, bucket })).digest('hex');
  const sig = (await pool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, title, body, symbols, indicators, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_sub, book_id, content_hash) DO UPDATE SET observed_at = oshal_trading_signals.observed_at
     RETURNING signal_id`,
    [sub, book.kind, book.bookId, d.source, `${d.symbol} ${d.action} @ ${d.price ?? '?'}`, d.rationale, [d.symbol],
     JSON.stringify({ confidence: d.confidence, indicators: d.indicators }), hash])).rows[0];
  const g = guardrails();
  const row = (await pool.query(
    `INSERT INTO oshal_trading_decisions
       (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, confidence, rationale, indicators, guardrails)
     VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9,'market',$10,$11,$12,$13)
     RETURNING decision_id`,
    [sub, book.kind, book.bookId, [sig.signal_id], AUTOPILOT_AGENT, d.action, d.symbol, d.side, d.qty, d.confidence, d.rationale,
     JSON.stringify(d.indicators), JSON.stringify(g)])).rows[0];
  return row.decision_id;
}

/**
 * @description Persist + place one decision. Pushes to orders/errors.
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param bookOrMode - The book (or legacy mode) the order belongs to.
 * @param d - The decision to persist and execute.
 * @param orders - Run-order accumulator.
 * @param errors - Run-error accumulator.
 * @param reason - Optional journal tag carried on the run order.
 * @returns Resolves when the order is recorded (success or accounted failure).
 */
export async function placeManaged(ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, d: DecisionInput, orders: RunOrder[], errors: Array<{ symbol: string; error: string }>, reason?: string): Promise<void> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  try {
    const decisionId = await persistDecision(ctx.pool, sub, book, d);
    // The BOOK REF must be in the requestId: books fire on the same 5-min tick, so a book-independent
    // id gave two books' orders for one symbol the SAME clientOrderId — and the ON CONFLICT upsert
    // then let one book's fill overwrite the other's broker id (2026-07-08). Legacy refs are literally
    // 'paper'/'live', so this string is BYTE-IDENTICAL to the pre-ADR-134 format for the legacy books.
    // Book-scoped here AND in the unique index (user_sub, book_id, client_order_id); either alone
    // suffices, together they can't regress.
    const requestId = `auto-${book.ref}-${new Date().toISOString().slice(0, 16)}-${d.symbol}-${d.side}`;
    // Live orders require confirm=true (placeDecisionOrder's gate); paper passes false. The minute-
    // granular requestId → clientOrderId is the idempotency key (UNIQUE user_sub,book_id,client_order_id).
    const r = await placeDecisionOrder(ctx.pool, sub, book, decisionId, requestId, book.kind === 'live');
    orders.push({ symbol: d.symbol, side: d.side, qty: d.qty, status: r.status, id: r.id, reason });
  } catch (e) {
    errors.push({ symbol: d.symbol, error: (e as Error).message });
  }
}

/** Non-terminal order statuses — a working order at the venue that getPositions() can't see yet. */
export const IN_FLIGHT_STATUSES = ['pending', 'accepted', 'partially_filled'];

/** A still-working order in the book: its symbol (for dedup) + remaining pending buy notional (for
 *  cash reservation). Net of any already-filled shares so a partial fill only reserves the rest. */
export interface InFlight { symbols: Set<string>; pendingBuyNotional: number; }

/**
 * @description Read still-working (non-terminal) orders for a book from the ledger. A pre/post-market
 * limit order sits pending for hours and never shows in getPositions(), so without this the dedup and
 * the cash math only see FILLED positions and re-buy the same name every fire (the pyramiding bug).
 * recordOrder writes the pending row at submit time, so the ledger is the authoritative in-flight view.
 * @param pool - Postgres pool.
 * @param sub - Owner sub (caller-scoped).
 * @param mode - Book (paper|live).
 * @returns The set of symbols with a working order + the total un-filled pending BUY notional.
 */
export async function loadInFlight(pool: AppContext['pool'], sub: string, bookOrMode: TradingBook | TradingMode): Promise<InFlight> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const rows = (await pool.query(
    `SELECT symbol, side, COALESCE(qty,0) AS qty, COALESCE(filled_qty,0) AS filled_qty, COALESCE(limit_price,0) AS px
       FROM oshal_trading_orders
      WHERE user_sub=$1 AND book_id=$2 AND status = ANY($3)`,
    [sub, book.bookId, IN_FLIGHT_STATUSES])).rows;
  const symbols = new Set<string>();
  let pendingBuyNotional = 0;
  for (const r of rows) {
    symbols.add(String(r.symbol).toUpperCase());
    if (r.side === 'buy') {
      const remaining = Math.max(0, Number(r.qty) - Number(r.filled_qty));
      pendingBuyNotional += remaining * Number(r.px || 0); // ext-hours entries are limit orders → px is set
    }
  }
  return { symbols, pendingBuyNotional };
}

/**
 * @description Map a protective exit (or a rotation bench) to a persistable sell decision.
 * @param e - The exit the portfolio manager wants.
 * @returns The decision input for placeManaged.
 */
export function exitDecision(e: ExitOrder): DecisionInput {
  const rationale = e.reason === 'rotation'
    ? `Benched (rotation) — gone cold, capital rotated to a hotter name. Position P&L ${e.pnlPct.toFixed(1)}%.`
    : e.reason === 'cap_trim'
      ? `Cap trim — position grew past the per-name cap; sold the excess to rebalance. Position P&L ${e.pnlPct.toFixed(1)}%.`
      : e.reason === 'ext_dip'
        ? `Extended-hours defensive exit — printed past the off-hours dip line (TRADING_EXT_DIP_SELL_PCT below the regular close). Off-hours doctrine: protect, never chase. Position P&L ${e.pnlPct.toFixed(1)}%.`
        : `Risk exit (${e.reason}) — position P&L ${e.pnlPct.toFixed(1)}%.`;
  return {
    symbol: e.symbol, action: 'sell', side: 'sell', qty: e.qty, confidence: 1, rationale,
    indicators: { reason: e.reason, pnlPct: e.pnlPct }, price: null, source: e.reason === 'rotation' ? 'rotation' : 'risk-exit',
  };
}

/**
 * @description Map a technical scan call to a persistable decision. `world` (entries only) records the influence
 *  signal that shaped sizing, so the decision journal shows WHY the size was tilted.
 * @param d - The multi-timeframe decision.
 * @param side - Buy or sell.
 * @param qty - Sized share count.
 * @param world - Optional world-sentiment read that tilted the size.
 * @returns The decision input for placeManaged.
 */
export function scanDecision(d: MtfDecision, side: 'buy' | 'sell', qty: number, world?: WorldSent): DecisionInput {
  const worldNote = world && world.score != null && world.points >= WORLD_SENT_MIN_POINTS
    ? ` World sentiment ${world.score >= 0 ? '+' : ''}${world.score.toFixed(2)} (${world.points} pts) → size tilted.`
    : '';
  return {
    symbol: d.symbol, action: side, side, qty, confidence: d.confidence, rationale: `${d.rationale}${worldNote}`,
    indicators: { score: d.score, regime: d.regime, perTimeframe: d.perTimeframe, world: world ?? null },
    price: d.price, source: 'mtf-autopilot',
  };
}

/**
 * @description Map a fast short-timeframe breakdown to a protective sell decision (its own clear journal entry).
 * @param d - The multi-timeframe decision showing the breakdown.
 * @param qty - Shares held (the whole position is sold).
 * @returns The decision input for placeManaged.
 */
export function breakdownDecision(d: MtfDecision, qty: number): DecisionInput {
  const fast = d.perTimeframe.filter((v) => v.timeframe === '5Min' || v.timeframe === '1Hour');
  return {
    symbol: d.symbol, action: 'sell', side: 'sell', qty, confidence: 1,
    rationale: `Protective exit — short-timeframe breakdown (${fast.map((v) => `${v.timeframe}:${v.score.toFixed(2)}`).join(', ')}) while regime ${d.regime.toFixed(2)} still up.`,
    indicators: { reason: 'breakdown', regime: d.regime, perTimeframe: d.perTimeframe }, price: d.price, source: 'mtf-breakdown',
  };
}

/**
 * @description Cap the account snapshot to TRADING_CAPITAL_CAP_USD so the strategy sizes as if the
 * account were that small — e.g. run a 10K book on a 50K account. Equity (the % sizing base) is capped
 * to the cap; cash/buyingPower are capped to the HEADROOM left under the cap after the current position
 * value (derived as equity−cash), so `positions + new buys ≤ cap` on every run and every deploy path —
 * it can never leverage the real account past the cap. No-op when the cap is unset/≤0.
 * LIVE-ONLY: the cap exists to bound the real-money book (ADR-052 arming). It must NEVER apply to
 * paper — on 2026-07-07 the unscoped cap pinned the $104K paper book's equity to $20K, so the
 * per-name cap became $2K and rebalanceTrims "cap-trimmed" (mass-liquidated) two-thirds of every
 * paper position at 4 AM pre-market prices. Paper is the full-size reference book by design.
 * NOTE: because equity is pinned at the cap while the real account exceeds it, the account-level
 * daily-loss breaker is muted at the capped scale; per-position stops (trailing/backstop) stay active.
 * @param account - The real broker account snapshot.
 * @param mode - The book being run; the cap applies to 'live' only.
 * @returns The capped snapshot (or the original for paper / when no cap is set).
 */
export function capAccount(account: BrokerAccount, book: TradingBook): BrokerAccount {
  if (book.kind !== 'live') return account;
  // ADR-134: effective cap = LEAST(env fleet floor, the book's own cap); nulls fall through.
  const envCap = Number(process.env.TRADING_CAPITAL_CAP_USD) || 0;
  const bookCap = book.capitalCapUsd ?? 0;
  const cap = envCap > 0 && bookCap > 0 ? Math.min(envCap, bookCap) : (envCap > 0 ? envCap : bookCap);
  if (cap <= 0) return account;
  const positionsValue = Math.max(0, (account.equity || 0) - (account.cash || 0)); // equity = cash + positions
  const room = Math.max(0, cap - positionsValue); // cash headroom so positions + new buys ≤ cap
  return {
    ...account,
    equity: Math.min(account.equity, cap),
    cash: Math.min(account.cash, room),
    buyingPower: Math.min(account.buyingPower, room),
  };
}

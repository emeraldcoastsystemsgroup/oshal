/**
 * Pinned lots (ADR-138 D3) — shares an operator bought by hand, ring-fenced from the autopilot and
 * governed only by the exit rules declared at purchase (take-profit, stop or trailing stop, time
 * stop). Two mechanisms:
 *
 *  1. THE OVERLAY — subtractPinnedLots(positions, pinnedBySymbol): the autopilot's fire sees every
 *     symbol's broker quantity MINUS its pinned shares (a fully pinned symbol vanishes from its view),
 *     so rotation drop-out sells, protective exits, trims and capacity counts never touch them.
 *     Applied in trading-schedule-dispatch right after the positions read; a failed pinned read
 *     fails the fire CLOSED (the positions-read doctrine: never act on a book you cannot see).
 *  2. THE LOT LEG — a lot starts as an INTENT keyed to the operator's manual decision (pending_fill).
 *     The leg (riding the per-user 'trading-events' cadence) reads the entry order from the ledger;
 *     on a fill it records qty/avg and places the exits as venue-resident GTC orders through the
 *     engine's single order path — TP sell LIMIT, and a STOP sell or a TRAILING_STOP sell. When one
 *     exit fills the sibling is cancelled; a time stop sells at market. Release cancels the exits and
 *     hands the shares back to the autopilot. Lot orders carry a `lot-` request-id prefix so
 *     freeStaleSells never cancels them.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — FORCE-RLS lot table, rules normalizer (pct XOR price per leg; stop XOR trailing), intent/list/get/release, pinnedQtyBySymbol + the pure overlay, the tick state machine with injectable venue deps (shared with the event-plan leg), and the `lot-` request-id convention.
 *
 * @module trading-pinned-lots
 */

import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { TradingBook, Position, OrderResult } from '@/features/trading';
import { loadBook } from './trading-books-store';
import { guardrails, TradingError } from './trading-engine';
import { defaultDeps, type EventPlanDeps } from './trading-event-plans';

const logger = createChildLogger({ module: 'trading-pinned-lots' });

/** The exit rules an operator may declare at purchase. Percents are whole percents (10 = 10%). */
export interface PinnedLotRules {
  takeProfitPct?: number | null; takeProfitPrice?: number | null;
  stopLossPct?: number | null; stopPrice?: number | null; trailingStopPct?: number | null;
  timeStopDays?: number | null;
}
export type PinnedLotStatus = 'pending_fill' | 'open' | 'exits_placed' | 'closed' | 'released' | 'error';
/** One lot as the routes/UI see it. */
export interface PinnedLotRow {
  lotId: string; userSub: string; bookId: string; bookRef: string; symbol: string; qty: number;
  filledQty: number | null; filledAvgPrice: number | null; status: PinnedLotStatus; rules: PinnedLotRules;
  entry: Record<string, unknown> | null; exits: Record<string, unknown> | null; result: Record<string, unknown> | null;
  timeline: Array<{ at: string; event: string; detail?: string }>; createdAt: string; updatedAt: string;
}
const HELD: PinnedLotStatus[] = ['open', 'exits_placed'];
const ACTIVE: PinnedLotStatus[] = ['pending_fill', 'open', 'exits_placed'];

const num = (v: unknown): number | null => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n; };
const round2 = (n: number): number => Math.round(n * 100) / 100;
const money = (n: number | null | undefined): string => n == null ? '—' : '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * @description Validate + clamp the purchase-time exit rules. Each leg is a percent OR a price,
 * never both; the downside leg is a stop OR a trailing stop, never both.
 * @param raw - Rules as posted.
 * @returns Normalized rules ({} when none were given).
 */
export function normalizePinnedLotRules(raw: unknown): PinnedLotRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tpPct = num(r.takeProfitPct), tpPx = num(r.takeProfitPrice), slPct = num(r.stopLossPct), slPx = num(r.stopPrice), tr = num(r.trailingStopPct), ts = num(r.timeStopDays);
  if (tpPct != null && tpPx != null) throw new TradingError(400, 'rules_invalid', 'Take-profit: give a percent OR a price, not both.');
  if ((slPct != null ? 1 : 0) + (slPx != null ? 1 : 0) + (tr != null ? 1 : 0) > 1) throw new TradingError(400, 'rules_invalid', 'Downside: give a stop percent, a stop price, OR a trailing percent — one of them.');
  const pos = (v: number | null, lo: number, hi: number, what: string): number | null => { if (v == null) return null; if (!(v >= lo && v <= hi)) throw new TradingError(400, 'rules_invalid', `${what} must be between ${lo} and ${hi}.`); return v; };
  return {
    takeProfitPct: pos(tpPct, 0.1, 1000, 'Take-profit percent'), takeProfitPrice: pos(tpPx, 0.01, 1_000_000, 'Take-profit price'),
    stopLossPct: pos(slPct, 0.1, 99, 'Stop percent'), stopPrice: pos(slPx, 0.01, 1_000_000, 'Stop price'), trailingStopPct: pos(tr, 0.5, 50, 'Trailing percent'),
    timeStopDays: ts == null ? null : Math.round(pos(ts, 1, 3650, 'Time stop days')!),
  };
}
/** @description True when at least one exit leg is set (an intent is only worth recording then). */
export function hasExitRules(rules: PinnedLotRules): boolean {
  return [rules.takeProfitPct, rules.takeProfitPrice, rules.stopLossPct, rules.stopPrice, rules.trailingStopPct, rules.timeStopDays].some((v) => v != null);
}
/** @description Lot order request ids start with `lot-`; the ledger's client_order_id is `${sub}:${requestId}`. */
export function isLotOrderClientId(clientOrderId: unknown): boolean { return String(clientOrderId ?? '').includes(':lot-'); }

/* ── schema ────────────────────────────────────────────────────────────────── */
/** @description Create the FORCE-RLS lot table (idempotent). */
export async function ensurePinnedLotsSchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading pinned lots',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_pinned_lots (
        lot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL, book_id UUID NOT NULL, book_ref TEXT NOT NULL, symbol TEXT NOT NULL,
        qty NUMERIC(18,6) NOT NULL, filled_qty NUMERIC(18,6), filled_avg_price NUMERIC(18,4),
        status TEXT NOT NULL DEFAULT 'pending_fill', rules JSONB NOT NULL DEFAULT '{}'::jsonb,
        entry JSONB, exits JSONB, result JSONB, timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_trd_pinned_lots_book_status ON oshal_trading_pinned_lots (user_sub, book_id, status)',
      ...buildOwnerRlsPolicyStatements('oshal_trading_pinned_lots', 'user_sub'),
    ],
    requirements: [{ table: 'oshal_trading_pinned_lots', columns: ['lot_id', 'user_sub', 'book_id', 'symbol', 'qty', 'status', 'rules'] }],
  });
}
function rowToLot(r: Record<string, unknown>): PinnedLotRow {
  return {
    lotId: String(r.lot_id), userSub: String(r.user_sub), bookId: String(r.book_id), bookRef: String(r.book_ref), symbol: String(r.symbol), qty: Number(r.qty),
    filledQty: r.filled_qty == null ? null : Number(r.filled_qty), filledAvgPrice: r.filled_avg_price == null ? null : Number(r.filled_avg_price),
    status: String(r.status) as PinnedLotStatus, rules: (r.rules as PinnedLotRules) ?? {},
    entry: (r.entry as Record<string, unknown>) ?? null, exits: (r.exits as Record<string, unknown>) ?? null, result: (r.result as Record<string, unknown>) ?? null,
    timeline: (r.timeline as PinnedLotRow['timeline']) ?? [], createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

/* ── CRUD ──────────────────────────────────────────────────────────────────── */
/** @description Record the intent behind a manual BUY: the lot is born pending_fill and the leg watches its order. */
export async function createPinnedLotIntent(pool: AppContext['pool'], sub: string, input: { book: TradingBook; decisionId: string; symbol: string; qty: number; rules: PinnedLotRules }): Promise<PinnedLotRow> {
  await ensurePinnedLotsSchema(pool);
  if (!hasExitRules(input.rules)) throw new TradingError(400, 'rules_required', 'A protected lot needs at least one exit rule.');
  const r = await pool.query(
    `INSERT INTO oshal_trading_pinned_lots (user_sub, book_id, book_ref, symbol, qty, rules, entry, timeline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [sub, input.book.bookId, input.book.ref, input.symbol.toUpperCase(), input.qty, JSON.stringify(input.rules), JSON.stringify({ decisionId: input.decisionId }),
      JSON.stringify([{ at: new Date().toISOString(), event: 'intent', detail: `${input.qty} ${input.symbol.toUpperCase()} on ${input.book.ref}: ${describeRules(input.rules)}` }])]);
  logger.info({ sub, lotId: r.rows[0].lot_id, symbol: input.symbol, book: input.book.ref }, 'pinned lot intent recorded');
  return rowToLot(r.rows[0]);
}
/** @description Plain-words rules ('sell at +10% · stop at $46.00 · time stop 30d'). */
export function describeRules(r: PinnedLotRules): string {
  const bits: string[] = [];
  if (r.takeProfitPct != null) bits.push(`take profit +${r.takeProfitPct}%`); if (r.takeProfitPrice != null) bits.push(`take profit at ${money(r.takeProfitPrice)}`);
  if (r.stopLossPct != null) bits.push(`stop −${r.stopLossPct}%`); if (r.stopPrice != null) bits.push(`stop at ${money(r.stopPrice)}`); if (r.trailingStopPct != null) bits.push(`trailing stop ${r.trailingStopPct}%`);
  if (r.timeStopDays != null) bits.push(`time stop ${r.timeStopDays}d`);
  return bits.join(' · ') || 'no exit rules';
}
/** @description Lots for the caller, optionally one book and/or a status set, newest first. */
export async function listPinnedLots(pool: AppContext['pool'], sub: string, opts?: { bookId?: string; status?: PinnedLotStatus[] }): Promise<PinnedLotRow[]> {
  await ensurePinnedLotsSchema(pool);
  const where = ['user_sub = $1']; const vals: unknown[] = [sub];
  if (opts?.bookId) { vals.push(opts.bookId); where.push(`book_id = $${vals.length}`); }
  if (opts?.status?.length) { vals.push(opts.status); where.push(`status = ANY($${vals.length}::text[])`); }
  const r = await pool.query(`SELECT * FROM oshal_trading_pinned_lots WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, vals);
  return r.rows.map(rowToLot);
}
/** @description One lot (owner-scoped). */
export async function getPinnedLot(pool: AppContext['pool'], sub: string, lotId: string): Promise<PinnedLotRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(lotId))) return null;
  await ensurePinnedLotsSchema(pool);
  const r = await pool.query('SELECT * FROM oshal_trading_pinned_lots WHERE user_sub = $1 AND lot_id = $2', [sub, lotId]);
  return r.rows[0] ? rowToLot(r.rows[0]) : null;
}
async function patchLot(pool: AppContext['pool'], sub: string, lotId: string, fields: Record<string, unknown>, event?: { event: string; detail?: string }): Promise<PinnedLotRow> {
  const cols = Object.keys(fields); const vals: unknown[] = [sub, lotId];
  const sets = cols.map((c, i) => { vals.push(typeof fields[c] === 'object' && fields[c] !== null ? JSON.stringify(fields[c]) : fields[c]); return `${c} = $${i + 3}`; });
  if (event) { vals.push(JSON.stringify([{ at: new Date().toISOString(), ...event }])); sets.push(`timeline = timeline || $${vals.length}::jsonb`); }
  sets.push('updated_at = now()');
  const r = await pool.query(`UPDATE oshal_trading_pinned_lots SET ${sets.join(', ')} WHERE user_sub = $1 AND lot_id = $2 RETURNING *`, vals);
  if (!r.rows[0]) throw new TradingError(404, 'lot_not_found', 'Lot not found.');
  return rowToLot(r.rows[0]);
}

/** @description Release a lot: cancel its working exits; the shares return to the autopilot's view. */
export async function releasePinnedLot(ctx: AppContext, sub: string, lotId: string, deps: EventPlanDeps = defaultDeps()): Promise<PinnedLotRow> {
  const cur = await getPinnedLot(ctx.pool, sub, lotId); if (!cur) throw new TradingError(404, 'lot_not_found', 'Lot not found.');
  if (!ACTIVE.includes(cur.status)) throw new TradingError(409, 'lot_not_active', `Lot is ${cur.status}.`);
  const notes: string[] = [];
  const book = await loadBook(ctx.pool, sub, cur.bookId);
  if (book && cur.status === 'exits_placed') {
    const broker = deps.broker(book, sub);
    for (const id of exitOrderIds(cur)) { try { await broker.cancelOrder(id); notes.push(`cancelled ${id}`); } catch (err) { logger.error({ err, lotId, id }, 'release cancel failed'); notes.push(`cancel FAILED ${id}`); } }
  }
  notes.push('shares returned to the autopilot');
  return patchLot(ctx.pool, sub, lotId, { status: 'released' }, { event: 'released', detail: notes.join('; ') });
}
function exitOrderIds(l: PinnedLotRow): string[] {
  const ex = l.exits ?? {}; return [ex.tpOrderId, ex.stopOrderId, ex.trailOrderId].filter(Boolean).map(String);
}

/* ── the overlay ───────────────────────────────────────────────────────────── */
/** @description Shares currently held under protected lots, per symbol, for one book (open or exits working). */
export async function pinnedQtyBySymbol(pool: AppContext['pool'], sub: string, bookId: string): Promise<Map<string, number>> {
  await ensurePinnedLotsSchema(pool);
  const r = await pool.query(
    `SELECT symbol, SUM(COALESCE(filled_qty, 0))::float8 AS q FROM oshal_trading_pinned_lots WHERE user_sub = $1 AND book_id = $2 AND status = ANY($3::text[]) GROUP BY symbol`,
    [sub, bookId, HELD]);
  const m = new Map<string, number>();
  for (const row of r.rows) { const q = Number(row.q); if (q > 0) m.set(String(row.symbol).toUpperCase(), q); }
  return m;
}
/**
 * @description The autopilot's view of the book: every position minus its pinned shares. A symbol
 * pinned in full disappears; a partial pin keeps the residual with marketValue/P&L scaled pro rata.
 * Pure — the guard spec drives it without a database.
 * @param positions - Broker positions for the book.
 * @param pinned - Pinned quantity per symbol (pinnedQtyBySymbol).
 * @returns Positions the autopilot may act on.
 */
export function subtractPinnedLots(positions: Position[], pinned: Map<string, number>): Position[] {
  if (!pinned.size) return positions;
  const out: Position[] = [];
  for (const p of positions) {
    const pin = pinned.get(p.symbol.toUpperCase()) ?? 0;
    if (pin <= 0) { out.push(p); continue; }
    const residual = Number(p.qty) - pin;
    if (residual <= 0) continue;
    const f = residual / Number(p.qty);
    out.push({ ...p, qty: residual, marketValue: Number(p.marketValue) * f,
      unrealizedPl: Number(p.unrealizedPl) * f,
      unrealizedIntradayPl: p.unrealizedIntradayPl != null ? Number(p.unrealizedIntradayPl) * f : p.unrealizedIntradayPl });
  }
  return out;
}

/* ── the leg ───────────────────────────────────────────────────────────────── */
/**
 * @description One tick over the caller's active lots: pending intents watch their entry order and,
 * on a fill, place the exits; working exits are polled — a fill cancels its sibling; a time stop
 * sells at market. One lot's failure is recorded on that lot; the others still run.
 * @param ctx - App context.
 * @param sub - Owner.
 * @param deps - Venue/clock deps (production by default; the spec injects fakes).
 * @returns Transitions this tick.
 */
export async function tickPinnedLots(ctx: AppContext, sub: string, deps: EventPlanDeps = defaultDeps()): Promise<{ processed: number; transitions: string[] }> {
  const lots = await listPinnedLots(ctx.pool, sub, { status: ACTIVE });
  const transitions: string[] = [];
  for (const lot of lots) {
    try {
      const book = await loadBook(ctx.pool, sub, lot.bookId);
      if (!book) { await patchLot(ctx.pool, sub, lot.lotId, { status: 'error' }, { event: 'error', detail: 'account/book no longer exists' }); transitions.push(`${lot.lotId}:error`); continue; }
      const next = lot.status === 'pending_fill' ? await stepPendingFill(ctx, sub, lot, book, deps)
        : lot.status === 'open' ? await stepOpen(ctx, sub, lot, book, deps)
        : await stepExitsPlaced(ctx, sub, lot, book, deps);
      if (next) transitions.push(`${lot.lotId}:${next}`);
    } catch (err) {
      logger.error({ err, lotId: lot.lotId, status: lot.status }, 'pinned lot tick failed');
      await patchLot(ctx.pool, sub, lot.lotId, {}, { event: 'tick_error', detail: (err as Error).message.slice(0, 300) }).catch(() => undefined);
    }
  }
  return { processed: lots.length, transitions };
}

/** Watch the entry order (ledger row for the decision → venue truth); on a fill the lot opens. */
async function stepPendingFill(ctx: AppContext, sub: string, lot: PinnedLotRow, book: TradingBook, deps: EventPlanDeps): Promise<string | null> {
  const decisionId = String((lot.entry ?? {}).decisionId ?? '');
  const row = (await ctx.pool.query(
    `SELECT broker_order_id, status, filled_qty, filled_avg_price FROM oshal_trading_orders WHERE user_sub = $1 AND book_id = $2 AND decision_id = $3 ORDER BY created_at DESC LIMIT 1`,
    [sub, book.bookId, decisionId])).rows[0];
  if (!row) {
    const ageMs = deps.now().getTime() - new Date(lot.createdAt).getTime();
    if (ageMs > 2 * 86_400_000) { await patchLot(ctx.pool, sub, lot.lotId, { status: 'released' }, { event: 'released', detail: 'entry order never placed within 2 days' }); return 'released'; }
    return null;
  }
  let filledQty = Number(row.filled_qty || 0), avg = row.filled_avg_price == null ? null : Number(row.filled_avg_price), status = String(row.status);
  if (row.broker_order_id) {
    try { const o = await deps.broker(book, sub).getOrder(String(row.broker_order_id)); filledQty = Number(o.filledQty || filledQty); avg = o.filledAvgPrice ?? avg; status = String(o.status); } catch (err) { logger.warn({ err, lotId: lot.lotId }, 'entry order poll failed — using the ledger row'); }
  }
  const terminal = ['filled', 'canceled', 'cancelled', 'expired', 'rejected'].includes(status);
  if (status === 'filled' || (terminal && filledQty > 0)) {
    const next = { ...(lot.entry ?? {}), orderId: row.broker_order_id, filledAt: deps.now().toISOString() };
    await patchLot(ctx.pool, sub, lot.lotId, { status: 'open', filled_qty: filledQty, filled_avg_price: avg, entry: next }, { event: 'filled', detail: `${filledQty} @ ${money(avg)}` });
    return stepOpen(ctx, sub, { ...lot, status: 'open', filledQty, filledAvgPrice: avg, entry: next }, book, deps);
  }
  if (terminal) { await patchLot(ctx.pool, sub, lot.lotId, { status: 'released' }, { event: 'released', detail: `entry ${status} with no fill` }); return 'released'; }
  return null;
}

/** Place the exits for the filled quantity: TP limit GTC, and a stop OR a trailing stop, GTC. */
async function stepOpen(ctx: AppContext, sub: string, lot: PinnedLotRow, book: TradingBook, deps: EventPlanDeps): Promise<string | null> {
  const qty = Number(lot.filledQty || 0); const avg = Number(lot.filledAvgPrice || 0); const r = lot.rules;
  if (qty < 1) { await patchLot(ctx.pool, sub, lot.lotId, { status: 'error' }, { event: 'error', detail: 'filled quantity is zero' }); return 'error'; }
  const tag = lot.lotId.slice(0, 8); const attempt = Number((lot.exits ?? {}).attempts ?? 0) + 1; const exits: Record<string, unknown> = { attempts: attempt, qty };
  const tpPx = r.takeProfitPrice ?? (r.takeProfitPct != null && avg > 0 ? round2(avg * (1 + r.takeProfitPct / 100)) : null);
  const stopPx = r.stopPrice ?? (r.stopLossPct != null && avg > 0 ? round2(avg * (1 - r.stopLossPct / 100)) : null);
  if (tpPx) { const d = await mintLotDecision(ctx.pool, sub, book, lot, { side: 'sell', qty, orderType: 'limit', limitPrice: tpPx, why: `Protected lot ${lot.symbol}: take-profit ${money(tpPx)}` }); const o = await deps.place(ctx.pool, sub, book, d, `lot-${tag}-tp-${attempt}`); exits.tpOrderId = o.id; exits.tpPx = tpPx; }
  if (stopPx) { const d = await mintLotDecision(ctx.pool, sub, book, lot, { side: 'sell', qty, orderType: 'stop', stopPrice: stopPx, why: `Protected lot ${lot.symbol}: stop ${money(stopPx)}` }); const o = await deps.place(ctx.pool, sub, book, d, `lot-${tag}-stop-${attempt}`); exits.stopOrderId = o.id; exits.stopPx = stopPx; }
  else if (r.trailingStopPct != null) { const d = await mintLotDecision(ctx.pool, sub, book, lot, { side: 'sell', qty, orderType: 'trailing_stop', trailPercent: r.trailingStopPct, why: `Protected lot ${lot.symbol}: trailing stop ${r.trailingStopPct}%` }); const o = await deps.place(ctx.pool, sub, book, d, `lot-${tag}-trail-${attempt}`); exits.trailOrderId = o.id; exits.trailPct = r.trailingStopPct; }
  const placed = [exits.tpOrderId && `TP ${money(tpPx)}`, exits.stopOrderId && `stop ${money(stopPx)}`, exits.trailOrderId && `trail ${r.trailingStopPct}%`].filter(Boolean).join(' · ');
  await patchLot(ctx.pool, sub, lot.lotId, { status: 'exits_placed', exits }, { event: 'exits_placed', detail: placed || 'time stop only' });
  return 'exits_placed';
}

/** Poll the exits: a fill cancels the sibling and closes the lot; a time stop sells at market. */
async function stepExitsPlaced(ctx: AppContext, sub: string, lot: PinnedLotRow, book: TradingBook, deps: EventPlanDeps): Promise<string | null> {
  const ex = lot.exits ?? {}; const broker = deps.broker(book, sub); const qty = Number(ex.qty ?? lot.filledQty ?? 0); const avg = Number(lot.filledAvgPrice || 0);
  const ids = { tp: ex.tpOrderId ? String(ex.tpOrderId) : null, dn: ex.stopOrderId ? String(ex.stopOrderId) : (ex.trailOrderId ? String(ex.trailOrderId) : null) };
  const [tp, dn] = await Promise.all([ids.tp ? broker.getOrder(ids.tp) : null, ids.dn ? broker.getOrder(ids.dn) : null]);
  const tpF = tp?.status === 'filled', dnF = dn?.status === 'filled';
  if (tpF && dnF) { await patchLot(ctx.pool, sub, lot.lotId, { status: 'error' }, { event: 'error', detail: 'BOTH exits filled — the account may be short; review NOW' }); return 'error'; }
  if (tpF || dnF) {
    const winner = (tpF ? tp : dn)!; const loser = tpF ? ids.dn : ids.tp;
    if (loser) { try { await broker.cancelOrder(loser); } catch (err) { logger.error({ err, lotId: lot.lotId }, 'sibling cancel failed'); } }
    const exitPx = Number(winner.filledAvgPrice ?? 0); const pnl = exitPx && avg ? round2((exitPx - avg) * qty) : null;
    await patchLot(ctx.pool, sub, lot.lotId, { status: 'closed', result: { reason: tpF ? 'take_profit' : (ex.trailOrderId ? 'trailing_stop' : 'stop'), exitPx, qty, pnl, closedAt: deps.now().toISOString() } }, { event: 'closed', detail: `${tpF ? 'take-profit' : 'stop'} ${qty} @ ${money(exitPx)} · P&L ${money(pnl)}` });
    return 'closed';
  }
  const days = lot.rules.timeStopDays; const filledAt = new Date(String((lot.entry ?? {}).filledAt ?? lot.createdAt));
  if (days != null && deps.now().getTime() - filledAt.getTime() > days * 86_400_000 && (await deps.session()) === 'regular') {
    for (const id of [ids.tp, ids.dn]) { if (id) { try { await broker.cancelOrder(id); } catch (err) { logger.error({ err, lotId: lot.lotId }, 'time-stop cancel failed'); } } }
    const d = await mintLotDecision(ctx.pool, sub, book, lot, { side: 'sell', qty, orderType: 'market', why: `Protected lot ${lot.symbol}: time stop after ${days} days` });
    const out = await deps.place(ctx.pool, sub, book, d, `lot-${lot.lotId.slice(0, 8)}-time-${Number(ex.attempts ?? 1)}`);
    const exitPx = Number(out.filledAvgPrice ?? 0);
    await patchLot(ctx.pool, sub, lot.lotId, { status: 'closed', result: { reason: 'time_stop', exitPx: exitPx || null, qty, pnl: exitPx && avg ? round2((exitPx - avg) * qty) : null, orderId: out.id, closedAt: deps.now().toISOString() } }, { event: 'closed', detail: `time stop — market sell ${qty} (${out.status})` });
    return 'closed';
  }
  return null;
}

/** Mint the 'pinned-lot' signal + decision the engine executes (book_id explicit on both). */
async function mintLotDecision(pool: AppContext['pool'], sub: string, book: TradingBook, lot: PinnedLotRow, o: { side: 'sell'; qty: number; orderType: 'market' | 'limit' | 'stop' | 'trailing_stop'; limitPrice?: number; stopPrice?: number; trailPercent?: number; why: string }): Promise<string> {
  const hash = crypto.createHash('sha256').update(JSON.stringify({ source: 'pinned-lot', lotId: lot.lotId, ...o, at: Date.now() })).digest('hex');
  const sig = (await pool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, title, body, symbols, indicators, content_hash)
       VALUES ($1,$2,$3,'pinned-lot',$4,$5,$6,$7,$8) RETURNING signal_id`,
    [sub, book.kind, book.bookId, `Protected lot: ${lot.symbol}`, o.why, [lot.symbol], JSON.stringify({ lotId: lot.lotId, rules: lot.rules }), hash])).rows[0];
  const row = (await pool.query(
    `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, limit_price, stop_price, trail_percent, time_in_force, confidence, rationale, indicators, guardrails)
       VALUES ($1,$2,$3,$4::uuid[],'pinned-lot','sell',$5,'sell',$6,$7,$8,$9,$10,$11,1,$12,$13,$14) RETURNING decision_id`,
    [sub, book.kind, book.bookId, [sig.signal_id], lot.symbol, o.qty, o.orderType, o.limitPrice ?? null, o.stopPrice ?? null, o.trailPercent ?? null, o.orderType === 'market' ? 'day' : 'gtc', o.why, JSON.stringify({ lotId: lot.lotId }), JSON.stringify(guardrails())])).rows[0];
  return String(row.decision_id);
}

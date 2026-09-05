/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-136 D4 dated (timed) orders. An operator decision minted now, PLACED later: a FORCE-RLS `oshal_trading_dated_orders` row carries the fire time (an Eastern wall-clock the operator chose, stored as an instant); the tick rides the existing `trading-events:<sub>` leg (5-minute cadence, TRADING_EVENT_PLANS-gated — no new schedule type, no cron change) and fires each due row ONCE through the same `deps.place` seam the event playbooks and protected lots use, so the engine's guardrails, live gate and reservation arbiter apply unchanged. Safety: a row whose window was missed (box asleep, leg off) EXPIRES instead of firing stale — never a market order 3 hours late; a closed market at the fire time (an exchange holiday) expires it too; an engine refusal is terminal (no retry loop); transient errors retry only inside the late window. v1 window = the leg's own 09:00–16:55 ET weekdays, 5-minute steps, ≤ TRADING_DATED_MAX_DAYS ahead.
 */
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { TradingBook } from '@/features/trading';
import { loadBook } from './trading-books-store';
import { TradingError } from './trading-engine';
import { defaultDeps, type EventPlanDeps } from './trading-event-plans';

const logger = createChildLogger({ module: 'trading-dated-orders' });

export type DatedOrderStatus = 'pending' | 'fired' | 'cancelled' | 'expired' | 'error';
export interface DatedOrderRow {
  datedId: string; userSub: string; bookId: string; bookRef: string; decisionId: string;
  symbol: string; side: 'buy' | 'sell'; qty: number; orderType: string;
  fireAt: string; status: DatedOrderStatus; firedOrderId: string | null; firedStatus: string | null; firedAt: string | null;
  error: string | null; timeline: Array<{ at: string; event: string; detail?: string }>; createdAt: string; updatedAt: string;
}

/** The leg's timezone — every wall-clock here is Eastern, the market's clock. */
export const DATED_TIMEZONE = 'America/New_York';
/** The v1 fire window in ET minutes-of-day: the leg's own cron (every 5 minutes, hours 9-16, weekdays) ticks 09:00–16:55. */
export const DATED_WINDOW = { startMin: 9 * 60, endMin: 16 * 60 + 55, stepMin: 5 } as const;
/** @description How far ahead an order may be dated (days). Config → env → default 30. */
export function datedMaxDays(): number { const n = Number(process.env.TRADING_DATED_MAX_DAYS); return Number.isFinite(n) && n > 0 ? n : 30; }
/** @description Grace after the fire time within which a due order may still fire (minutes). Past it the order EXPIRES. Config → env → default 20. */
export function datedLateMinutes(): number { const n = Number(process.env.TRADING_DATED_LATE_MINUTES); return Number.isFinite(n) && n > 0 ? n : 20; }

interface WallParts { y: number; m: number; d: number; hh: number; mm: number; weekday: number }
const ET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: DATED_TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** @description The Eastern wall-clock parts of an instant. */
export function etWallParts(at: Date): WallParts {
  const p: Record<string, string> = {};
  for (const part of ET_FMT.formatToParts(at)) if (part.type !== 'literal') p[part.type] = part.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute), weekday: WEEKDAYS[p.weekday] ?? -1 };
}

/**
 * @description Turn an Eastern wall-clock ('YYYY-MM-DD' + 'HH:MM') into the instant it names. Eastern is
 * UTC-4 or UTC-5; both candidates are formatted back and the one that round-trips wins, so DST needs no
 * table. A wall time that does not exist (the spring-forward gap) is refused rather than guessed.
 * @param date - Calendar date in ET, YYYY-MM-DD.
 * @param time - Wall time in ET, HH:MM (24h).
 * @returns The instant.
 */
export function etWallToInstant(date: string, time: string): Date {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '')), tm = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
  if (!dm || !tm) throw new TradingError(400, 'fire_at_invalid', 'Give the date as YYYY-MM-DD and the time as HH:MM (Eastern).');
  const [y, m, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])], [hh, mm] = [Number(tm[1]), Number(tm[2])];
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) throw new TradingError(400, 'fire_at_invalid', 'That date or time is out of range.');
  for (const offsetHours of [4, 5]) {
    const cand = new Date(Date.UTC(y, m - 1, d, hh + offsetHours, mm));
    const w = etWallParts(cand);
    if (w.y === y && w.m === m && w.d === d && w.hh === hh && w.mm === mm) return cand;
  }
  throw new TradingError(400, 'fire_at_invalid', 'That time does not exist in Eastern time (clocks change that morning).');
}

/** @description 'Wed Sep 9, 2026 at 9:35 AM ET' — the words every surface uses for a fire time. */
export function formatEt(at: Date): string {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: DATED_TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
  return s.replace(', ', ' ').replace(/(\d{4}), /, '$1 at ') + ' ET';
}

/**
 * @description Refuse a fire time the leg cannot honour: in the past, too far out, a weekend, outside
 * 09:00–16:55 ET, or off the 5-minute grid the leg ticks on (what you pick is when it fires).
 * @param fireAt - The instant.
 * @param now - The clock (injected for specs).
 */
export function validateFireAt(fireAt: Date, now: Date = new Date()): void {
  const bad = (why: string) => new TradingError(400, 'fire_at_invalid', why);
  if (!(fireAt instanceof Date) || Number.isNaN(fireAt.getTime())) throw bad('A fire time is required.');
  if (fireAt.getTime() < now.getTime() + 60_000) throw bad('The fire time must be at least a minute from now.');
  if (fireAt.getTime() > now.getTime() + datedMaxDays() * 86_400_000) throw bad(`The fire time must be within ${datedMaxDays()} days.`);
  const w = etWallParts(fireAt);
  if (w.weekday === 0 || w.weekday === 6) throw bad('Timed orders fire on trading days (Monday to Friday, Eastern).');
  const min = w.hh * 60 + w.mm;
  if (min < DATED_WINDOW.startMin || min > DATED_WINDOW.endMin) throw bad('Timed orders fire between 9:00 AM and 4:55 PM Eastern.');
  if (w.mm % DATED_WINDOW.stepMin !== 0) throw bad(`Pick a time on the ${DATED_WINDOW.stepMin}-minute grid (9:00, 9:05, …) — that is when the leg ticks.`);
}

/** @description Create the FORCE-RLS dated-orders table (idempotent; owner policy on user_sub). */
export async function ensureDatedOrdersSchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading dated orders',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_dated_orders (
        dated_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL, book_id UUID NOT NULL, book_ref TEXT NOT NULL, decision_id UUID NOT NULL,
        symbol TEXT NOT NULL, side TEXT NOT NULL, qty NUMERIC(18,6) NOT NULL, order_type TEXT NOT NULL,
        fire_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        fired_order_id TEXT, fired_status TEXT, fired_at TIMESTAMPTZ, error TEXT,
        timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_trd_dated_orders_due ON oshal_trading_dated_orders (user_sub, status, fire_at)',
      'CREATE INDEX IF NOT EXISTS idx_trd_dated_orders_book ON oshal_trading_dated_orders (user_sub, book_id, status)',
      ...buildOwnerRlsPolicyStatements('oshal_trading_dated_orders', 'user_sub'),
    ],
    requirements: [{ table: 'oshal_trading_dated_orders', columns: ['dated_id', 'user_sub', 'book_id', 'decision_id', 'fire_at', 'status'] }],
  });
}

function rowToDated(r: Record<string, unknown>): DatedOrderRow {
  const iso = (v: unknown) => v == null ? null : new Date(v as string).toISOString();
  return {
    datedId: String(r.dated_id), userSub: String(r.user_sub), bookId: String(r.book_id), bookRef: String(r.book_ref), decisionId: String(r.decision_id),
    symbol: String(r.symbol), side: r.side as 'buy' | 'sell', qty: Number(r.qty), orderType: String(r.order_type),
    fireAt: iso(r.fire_at) as string, status: r.status as DatedOrderStatus,
    firedOrderId: r.fired_order_id == null ? null : String(r.fired_order_id), firedStatus: r.fired_status == null ? null : String(r.fired_status), firedAt: iso(r.fired_at),
    error: r.error == null ? null : String(r.error), timeline: (r.timeline as DatedOrderRow['timeline']) ?? [],
    createdAt: iso(r.created_at) as string, updatedAt: iso(r.updated_at) as string,
  };
}

/**
 * @description Record a dated order for an already-minted operator decision. Nothing is placed here —
 * the leg places it at the fire time through the engine.
 * @param pool - DB pool.
 * @param sub - Owner.
 * @param input - Book, the decision, its order summary (for the card), and the fire instant.
 * @param now - Clock (injected for specs).
 * @returns The pending row.
 */
export async function createDatedOrder(pool: AppContext['pool'], sub: string, input: { book: TradingBook; decisionId: string; symbol: string; side: 'buy' | 'sell'; qty: number; orderType: string; fireAt: Date }, now: Date = new Date()): Promise<DatedOrderRow> {
  await ensureDatedOrdersSchema(pool);
  validateFireAt(input.fireAt, now);
  const detail = `${input.side.toUpperCase()} ${input.qty} ${input.symbol.toUpperCase()} (${input.orderType}) on ${input.book.ref} at ${formatEt(input.fireAt)}`;
  const r = await pool.query(
    `INSERT INTO oshal_trading_dated_orders (user_sub, book_id, book_ref, decision_id, symbol, side, qty, order_type, fire_at, timeline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [sub, input.book.bookId, input.book.ref, input.decisionId, input.symbol.toUpperCase(), input.side, input.qty, input.orderType, input.fireAt.toISOString(),
      JSON.stringify([{ at: now.toISOString(), event: 'scheduled', detail }])]);
  logger.info({ sub, datedId: r.rows[0].dated_id, decisionId: input.decisionId, book: input.book.ref, fireAt: input.fireAt.toISOString() }, 'dated order scheduled');
  return rowToDated(r.rows[0]);
}

/** @description The caller's dated orders, soonest first; optionally one book and/or a status set. */
export async function listDatedOrders(pool: AppContext['pool'], sub: string, opts?: { bookId?: string; status?: DatedOrderStatus[] }): Promise<DatedOrderRow[]> {
  await ensureDatedOrdersSchema(pool);
  const where = ['user_sub = $1']; const args: unknown[] = [sub];
  if (opts?.bookId) { args.push(opts.bookId); where.push(`book_id = $${args.length}`); }
  if (opts?.status?.length) { args.push(opts.status); where.push(`status = ANY($${args.length})`); }
  const r = await pool.query(`SELECT * FROM oshal_trading_dated_orders WHERE ${where.join(' AND ')} ORDER BY fire_at ASC, created_at ASC`, args);
  return r.rows.map(rowToDated);
}

/** @description One dated order by id (owner-scoped), or null. */
export async function getDatedOrder(pool: AppContext['pool'], sub: string, datedId: string): Promise<DatedOrderRow | null> {
  const r = await pool.query('SELECT * FROM oshal_trading_dated_orders WHERE user_sub = $1 AND dated_id = $2', [sub, datedId]);
  return r.rows[0] ? rowToDated(r.rows[0]) : null;
}

async function patchDated(pool: AppContext['pool'], sub: string, datedId: string, fields: Record<string, unknown>, event: { event: string; detail?: string }, now: Date): Promise<DatedOrderRow> {
  const keys = Object.keys(fields); const args: unknown[] = [sub, datedId, JSON.stringify([{ at: now.toISOString(), ...event }])];
  const sets = keys.map((k) => { args.push(fields[k]); return `${k} = $${args.length}`; });
  const r = await pool.query(
    `UPDATE oshal_trading_dated_orders SET ${[...sets, 'timeline = timeline || $3::jsonb', 'updated_at = now()'].join(', ')} WHERE user_sub = $1 AND dated_id = $2 RETURNING *`, args);
  return rowToDated(r.rows[0]);
}

/**
 * @description Cancel a pending dated order so it never fires. Only `pending` can be cancelled — a
 * fired one is an order in the journal now, and expired/errored ones are already inert.
 * @param pool - DB pool.
 * @param sub - Owner.
 * @param datedId - The row.
 * @param now - Clock.
 * @returns The cancelled row.
 */
export async function cancelDatedOrder(pool: AppContext['pool'], sub: string, datedId: string, now: Date = new Date()): Promise<DatedOrderRow> {
  const row = await getDatedOrder(pool, sub, datedId);
  if (!row) throw new TradingError(404, 'dated_order_not_found', 'No such timed order on this account.');
  if (row.status !== 'pending') throw new TradingError(409, 'not_pending', `This timed order is already ${row.status}.`);
  const out = await patchDated(pool, sub, datedId, { status: 'cancelled' }, { event: 'cancelled', detail: 'cancelled by the operator before it fired' }, now);
  logger.info({ sub, datedId }, 'dated order cancelled');
  return out;
}

/**
 * @description Fire every due dated order for this owner — once each. Rides the trading-events leg.
 * Late beyond the grace window → `expired` (never a stale order); engine refusal → `error` (terminal);
 * any other failure is recorded and retried on the next tick while still inside the grace window.
 * @param ctx - App context.
 * @param sub - Owner.
 * @param deps - Clock + order placement (the production deps place through the engine with confirm).
 * @returns Counts + the transitions made this tick.
 */
export async function tickDatedOrders(ctx: AppContext, sub: string, deps: EventPlanDeps = defaultDeps()): Promise<{ processed: number; transitions: string[] }> {
  const now = deps.now();
  const due = (await listDatedOrders(ctx.pool, sub, { status: ['pending'] })).filter((r) => new Date(r.fireAt).getTime() <= now.getTime());
  const transitions: string[] = [];
  for (const row of due) {
    try {
      const next = await fireDatedOrder(ctx, sub, row, deps, now);
      if (next) transitions.push(`${row.datedId}:${next}`);
    } catch (err) {
      logger.error({ err, datedId: row.datedId }, 'dated order tick failed');
      await patchDated(ctx.pool, sub, row.datedId, {}, { event: 'tick_error', detail: (err as Error).message.slice(0, 300) }, now).catch(() => undefined);
    }
  }
  return { processed: due.length, transitions };
}

async function fireDatedOrder(ctx: AppContext, sub: string, row: DatedOrderRow, deps: EventPlanDeps, now: Date): Promise<string | null> {
  const lateMin = (now.getTime() - new Date(row.fireAt).getTime()) / 60_000;
  if (lateMin > datedLateMinutes()) {
    await patchDated(ctx.pool, sub, row.datedId, { status: 'expired' }, { event: 'expired', detail: `fire window missed by ${Math.round(lateMin)} min — not placed (stale)` }, now);
    logger.warn({ sub, datedId: row.datedId, lateMin: Math.round(lateMin) }, 'dated order expired unfired — window missed');
    return 'expired';
  }
  // Never place into a closed market (an exchange holiday the calendar rules cannot see): expire, say why.
  if ((await deps.session()) === 'closed') {
    await patchDated(ctx.pool, sub, row.datedId, { status: 'expired' }, { event: 'expired', detail: 'market closed at the fire time (holiday?) — not placed' }, now);
    logger.warn({ sub, datedId: row.datedId }, 'dated order expired unfired — market closed at fire time');
    return 'expired';
  }
  const book = await loadBook(ctx.pool, sub, row.bookId);
  if (!book) { await patchDated(ctx.pool, sub, row.datedId, { status: 'error', error: 'account/book no longer exists' }, { event: 'error', detail: 'account/book no longer exists' }, now); return 'error'; }
  // ONE requestId per decision for its whole life — the engine's reservation arbiter dedupes a retry
  // after a transient failure, so a second tick can never place the order twice.
  const requestId = `dated-${row.datedId.slice(0, 8)}`;
  try {
    const o = await deps.place(ctx.pool, sub, book, row.decisionId, requestId);
    await patchDated(ctx.pool, sub, row.datedId, { status: 'fired', fired_order_id: o.id, fired_status: o.status, fired_at: now.toISOString() },
      { event: 'fired', detail: `${row.side.toUpperCase()} ${row.qty} ${row.symbol} placed (${o.status})` }, now);
    logger.info({ sub, datedId: row.datedId, orderId: o.id, status: o.status }, 'dated order fired');
    return 'fired';
  } catch (err) {
    if (err instanceof TradingError) {
      await patchDated(ctx.pool, sub, row.datedId, { status: 'error', error: err.message.slice(0, 300) }, { event: 'error', detail: `${err.code}: ${err.message.slice(0, 200)}` }, now);
      logger.warn({ sub, datedId: row.datedId, code: err.code }, 'dated order refused by the engine — terminal');
      return 'error';
    }
    throw err;
  }
}

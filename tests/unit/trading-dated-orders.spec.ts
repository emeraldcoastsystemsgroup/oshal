/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-136 D4 dated orders, against the live oshal Postgres (real FORCE-RLS table, real rows): the ET wall-clock → instant conversion round-trips across DST and refuses the spring-forward gap; validateFireAt refuses past / too-far / weekend / outside 09:00–16:55 ET / off-grid times; a due order fires EXACTLY once through the injected place seam with one requestId; a cancelled order never fires; a window missed by more than the grace EXPIRES unfired; an engine refusal is terminal (no retry). Run with --no-file-parallelism (concurrent schema bootstrap races).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-136 D4 follow-up: minute precision (09:37 accepted), the window derived from the leg cron (07:00–19:59 ET) and proven to AGREE with cron-parser's actual fires of EVENT_PLANS_CRON in America/New_York (first fire 07:00, last 19:59, none at 20:00 or Saturday, 60 s steps); the extended-session rule (pre/post only for limit + extendedHours + day; market / GTC / non-ext refused) and its FAIL-CLOSED form (no order shape → refused, so the 1.9.2 store call cannot widen the window); NYSE holidays refused BY NAME (Labor Day 3 days out; Thanksgiving + observed Independence Day with injected clocks; a TRADING_MARKET_HOLIDAYS one-off); an early-close afternoon (2026-11-27 15:00) is ACCEPTED and the runtime places it when the venue says 'post' (only 'closed' expires) — the as-built "early closes are runtime-only" sentence, guarded. Real-DB: a 07:30 pre-session limit+ext+day row fires exactly once when the session is 'pre'. Source pins: the engine honours a decision's extended_hours on a LIMIT outside the TRADING_EXTENDED_HOURS branch (so a dated ext limit places with the flag off).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | De-fuse a dated time bomb in the PROTECTED-timed-entry case. It pinned notBefore to the hardcoded FIRE (2026-09-09 09:35 ET) but ticked the clock at Date.now() + 3 days, while createPinnedLotIntent stamps createdAt from the REAL clock with no injection seam. Written 2026-09-04 it passed; on 2026-09-09 the calendar reached FIRE, Date.now() + 3d moved past notBefore + 2d, the lot correctly released, and the assertion failed - a green-to-red flip with no code change behind it. Worse, its premise (a moment both 3 days after intent AND before the fire time) had become unreachable, so no tick value could fix it. notBefore now moves with the real clock. The guard keeps its teeth: mutating the release clock back to createdAt-only (dropping Math.max in stepPendingFill) still fails it with the same message.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { CronExpressionParser } from 'cron-parser';
import {
  ensureDatedOrdersSchema, etWallToInstant, etWallParts, validateFireAt, formatEt, createDatedOrder, listDatedOrders, getDatedOrder,
  cancelDatedOrder, tickDatedOrders, datedWindow, regularSession,
} from '../../src/app/trading-dated-orders';
import { EVENT_PLANS_CRON, EVENT_PLANS_TIMEZONE, type EventPlanDeps } from '../../src/app/trading-event-plans';
import { createPinnedLotIntent, ensurePinnedLotsSchema, getPinnedLot, tickPinnedLots } from '../../src/app/trading-pinned-lots';
import { ensureBooksSchema, ensureLegacyBooks, legacyBook } from '../../src/app/trading-books-store';
import { ensureTradingSchema, TradingError } from '../../src/app/trading-engine';
import type { AppContext } from '../../src/app/composition/app-context';
import type { OrderResult } from '../../src/features/trading';

const DSN = process.env.OSHAL_TEST_DSN || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-dated-${RUN}`;
let pool: Pool;
const ctx = () => ({ pool } as unknown as AppContext);

/** Fri 2026-09-04 14:00 ET (18:00Z) — a trading day, inside the window. */
const NOW = new Date('2026-09-04T18:00:00Z');
/** Wed 2026-09-09 09:35 ET = 13:35Z (EDT). */
const FIRE = etWallToInstant('2026-09-09', '09:35');

function fakePlace() {
  const calls: Array<{ decisionId: string; requestId: string }> = [];
  let refuse: TradingError | null = null;
  const place = async (_p: unknown, _s: string, _b: unknown, decisionId: string, requestId: string): Promise<OrderResult> => {
    calls.push({ decisionId, requestId });
    if (refuse) throw refuse;
    return { id: `o-${calls.length}`, clientOrderId: requestId, status: 'accepted', symbol: 'MSFT', side: 'buy', qty: 5, type: 'market', filledQty: 0, provider: 'alpaca', mode: 'paper', decisionId } as unknown as OrderResult;
  };
  const deps = (now: Date, session: 'closed' | 'pre' | 'regular' | 'post' = 'regular'): EventPlanDeps => ({
    now: () => now, session: async () => session, edgarSearch: async () => [], fetchText: async () => null,
    broker: (() => ({ getOrder: async () => { throw new Error('no venue in this spec'); } })) as unknown as EventPlanDeps['broker'], latestTrade: async () => null, place: place as unknown as EventPlanDeps['place'],
  });
  return { calls, deps, setRefusal: (e: TradingError | null) => { refuse = e; } };
}

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  process.env.TRADING_MAX_NOTIONAL_USD = '50000'; process.env.TRADING_MAX_QTY = '100000';
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try { await pool.query('SELECT 1'); } catch (error) {
    throw new Error(`trading-dated-orders requires the live oshal Postgres at ${DSN.replace(/:[^:@/]+@/, ':***@')} — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  await ensureBooksSchema(pool as never); await ensureTradingSchema(pool as never); await ensureDatedOrdersSchema(pool as never); await ensurePinnedLotsSchema(pool as never);
  await pool.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN EXECUTE 'ALTER TABLE oshal_trading_dated_orders OWNER TO oshal_app'; EXECUTE 'ALTER TABLE oshal_trading_pinned_lots OWNER TO oshal_app'; END IF; END $$;`);
  await ensureLegacyBooks(pool as never, SUB);
}, 120_000);

afterAll(async () => {
  for (const t of ['oshal_trading_dated_orders', 'oshal_trading_pinned_lots', 'oshal_trading_books']) await pool.query(`DELETE FROM ${t} WHERE user_sub = $1`, [SUB]).catch(() => {});
  await pool.end();
});

describe('the leg fires dated orders — dispatchTradingEventSchedule ticks them on the same cadence/gate as plans + lots', () => {
  it('source pin: the event-plans dispatch dynamically imports trading-dated-orders and calls tickDatedOrders on EVERY fire (outside the full-tick branch)', () => {
    const plans = readFileSync(path.resolve(__dirname, '../../src/app/trading-event-plans.ts'), 'utf8');
    expect(plans).toContain("await import('./trading-dated-orders.js').then((m) => m.tickDatedOrders(ctx, sub))");
    expect(plans.indexOf('m.tickDatedOrders(ctx, sub)')).toBeGreaterThan(plans.indexOf("if (!eventPlansEnabled())"));
    expect(plans).toContain('const full = isFullTick(');
    expect(plans).toContain("const dated = await import('./trading-dated-orders.js')");
  });
  it('source pin: the engine honours a decision\'s extended_hours on a LIMIT outside the TRADING_EXTENDED_HOURS branch — a dated ext limit places with the flag off', () => {
    const engine = readFileSync(path.resolve(__dirname, '../../src/app/trading-engine.ts'), 'utf8');
    const flag = engine.indexOf("process.env.TRADING_EXTENDED_HOURS");
    const ext = engine.indexOf("if (d.extended_hours === true && effType === 'limit') extendedHours = true;");
    expect(flag).toBeGreaterThan(0); expect(ext).toBeGreaterThan(flag);
    const between = engine.slice(engine.lastIndexOf('if (', flag), ext);
    expect((between.match(/\{/g) ?? []).length).toBe((between.match(/\}/g) ?? []).length);   // the flag block is closed before the ext line
  });
});

describe('Eastern wall-clock → instant', () => {
  it('round-trips in winter (UTC-5) and summer (UTC-4) without a DST table', () => {
    expect(etWallToInstant('2026-01-15', '09:35').toISOString()).toBe('2026-01-15T14:35:00.000Z');
    expect(etWallToInstant('2026-07-15', '09:35').toISOString()).toBe('2026-07-15T13:35:00.000Z');
    expect(etWallParts(FIRE)).toMatchObject({ y: 2026, m: 9, d: 9, hh: 9, mm: 35, weekday: 3 });
  });
  it('refuses a wall time that does not exist (spring-forward gap) and malformed input', () => {
    expect(() => etWallToInstant('2026-03-08', '02:30')).toThrow(/does not exist/);
    expect(() => etWallToInstant('2026-3-8', '9:35')).toThrow(/YYYY-MM-DD/);
  });
  it('formats the fire time in words, in ET', () => {
    expect(formatEt(FIRE)).toBe('Wed Sep 9, 2026 at 9:35 AM ET');
  });
});

describe('validateFireAt — the leg can only honour what it ticks, the venue only what it accepts', () => {
  const at = (d: string, t: string) => etWallToInstant(d, t);
  const EXT = { orderType: 'limit', extendedHours: true, timeInForce: 'day' };
  const MKT = { orderType: 'market', extendedHours: false, timeInForce: 'day' };
  it('accepts ANY weekday minute inside the regular session within the horizon (the 5-minute grid is gone)', () => {
    expect(() => validateFireAt(FIRE, NOW)).not.toThrow();
    expect(() => validateFireAt(at('2026-09-09', '09:37'), NOW, MKT)).not.toThrow();
    expect(() => validateFireAt(at('2026-09-09', '09:30'), NOW, MKT)).not.toThrow();
    expect(() => validateFireAt(at('2026-09-09', '15:59'), NOW, MKT)).not.toThrow();
    expect(datedWindow()).toEqual({ startMin: 7 * 60, endMin: 19 * 60 + 59 });
    expect(regularSession()).toEqual({ startMin: 9 * 60 + 30, endMin: 16 * 60 });
  });
  it('refuses the past, the far future, weekends, and outside the leg window (07:00–19:59 ET)', () => {
    expect(() => validateFireAt(at('2026-09-04', '13:55'), NOW)).toThrow(/a minute from now/);
    expect(() => validateFireAt(at('2026-10-30', '09:35'), NOW)).toThrow(/within 30 days/);
    expect(() => validateFireAt(at('2026-09-12', '09:35'), NOW)).toThrow(/trading days/);
    expect(() => validateFireAt(at('2026-09-09', '06:59'), NOW, EXT)).toThrow(/7:00 AM and 7:59 PM/);
    expect(() => validateFireAt(at('2026-09-09', '20:00'), NOW, EXT)).toThrow(/7:00 AM and 7:59 PM/);
  });
  it('pre/post-market: only a limit + extended-hours + day order; market, GTC and non-ext limit are refused', () => {
    expect(() => validateFireAt(at('2026-09-09', '07:00'), NOW, EXT)).not.toThrow();
    expect(() => validateFireAt(at('2026-09-09', '07:30'), NOW, EXT)).not.toThrow();
    expect(() => validateFireAt(at('2026-09-09', '19:59'), NOW, EXT)).not.toThrow();
    expect(() => validateFireAt(at('2026-09-09', '07:30'), NOW, MKT)).toThrow(/extended hours/);
    expect(() => validateFireAt(at('2026-09-09', '07:30'), NOW, { ...EXT, timeInForce: 'gtc' })).toThrow(/extended hours/);
    expect(() => validateFireAt(at('2026-09-09', '07:30'), NOW, { ...EXT, extendedHours: false })).toThrow(/extended hours/);
    expect(() => validateFireAt(at('2026-09-09', '16:00'), NOW, MKT)).toThrow(/extended hours/);   // the close is 'post'
    expect(() => validateFireAt(at('2026-09-09', '16:30'), NOW, { orderType: 'stop', extendedHours: true, timeInForce: 'day' })).toThrow(/extended hours/);
  });
  it('FAILS CLOSED: a caller that omits the order shape (the 1.9.2 store) cannot widen the window', () => {
    expect(() => validateFireAt(at('2026-09-09', '07:30'), NOW)).toThrow(/extended hours/);
    expect(() => validateFireAt(at('2026-09-09', '16:30'), NOW)).toThrow(/extended hours/);
    expect(() => validateFireAt(at('2026-09-09', '09:37'), NOW)).not.toThrow();
  });
  it('refuses an exchange holiday BY NAME: Labor Day (3 days out), Thanksgiving and the observed Independence Day (injected clocks), an operator one-off', () => {
    expect(() => validateFireAt(at('2026-09-07', '10:00'), NOW, MKT)).toThrow(/closed on Mon, Sep 7, 2026 \(Labor Day\)/);
    expect(() => validateFireAt(at('2026-11-26', '10:00'), new Date('2026-11-20T18:00:00Z'), MKT)).toThrow(/Thanksgiving Day/);
    expect(() => validateFireAt(at('2026-07-03', '10:00'), new Date('2026-06-25T18:00:00Z'), MKT)).toThrow(/Independence Day/);
    const prev = process.env.TRADING_MARKET_HOLIDAYS; process.env.TRADING_MARKET_HOLIDAYS = '2026-09-09=Spec closure';
    try { expect(() => validateFireAt(FIRE, NOW, MKT)).toThrow(/Spec closure/); }
    finally { if (prev === undefined) delete process.env.TRADING_MARKET_HOLIDAYS; else process.env.TRADING_MARKET_HOLIDAYS = prev; }
    expect(() => validateFireAt(FIRE, NOW, MKT)).not.toThrow();
  });
  it('an early-close afternoon (Fri 2026-11-27, 13:00 close) is ACCEPTED at 15:00 — early closes are runtime-only, by design', () => {
    expect(() => validateFireAt(at('2026-11-27', '15:00'), new Date('2026-11-20T18:00:00Z'), MKT)).not.toThrow();
  });
  it('AGREES with the leg: cron-parser fires of EVENT_PLANS_CRON in America/New_York start 07:00, end 19:59, step 60 s, skip Saturday', () => {
    const win = datedWindow();
    const e = CronExpressionParser.parse(EVENT_PLANS_CRON, { currentDate: new Date('2026-09-08T23:59:30Z'), tz: EVENT_PLANS_TIMEZONE }); // Tue 19:59:30 ET
    const first = e.next().toDate(), second = e.next().toDate();
    expect(etWallParts(first)).toMatchObject({ y: 2026, m: 9, d: 9, hh: Math.floor(win.startMin / 60), mm: win.startMin % 60 });
    expect(second.getTime() - first.getTime()).toBe(60_000);
    const late = CronExpressionParser.parse(EVENT_PLANS_CRON, { currentDate: new Date('2026-09-11T23:58:30Z'), tz: EVENT_PLANS_TIMEZONE });  // Fri 19:58:30 ET
    const last = late.next().toDate(), afterWeekend = late.next().toDate();
    expect(etWallParts(last)).toMatchObject({ d: 11, hh: Math.floor(win.endMin / 60), mm: win.endMin % 60 });
    expect(etWallParts(afterWeekend)).toMatchObject({ d: 14, weekday: 1, hh: 7, mm: 0 });   // nothing at 20:00, nothing Sat/Sun
  });
});

describe('dated orders — schedule → fire once → never twice; cancel; expire; terminal refusal', () => {
  const book = legacyBook(SUB, 'paper');
  const mk = (fireAt = FIRE) => createDatedOrder(pool as never, SUB, { book, decisionId: crypto.randomUUID(), symbol: 'msft', side: 'buy', qty: 5, orderType: 'market', fireAt }, NOW);

  it('the table is FORCE-RLS with an owner policy on user_sub', async () => {
    const t = (await pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'oshal_trading_dated_orders'`)).rows[0];
    expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const pols = (await pool.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'oshal_trading_dated_orders'`)).rows[0].n;
    expect(pols).toBeGreaterThan(0);
  });

  it('records a pending row (symbol upper-cased, fire time kept as the exact instant) and refuses a bad fire time before writing', async () => {
    const row = await mk();
    expect(row).toMatchObject({ status: 'pending', symbol: 'MSFT', side: 'buy', qty: 5, bookId: book.bookId, fireAt: FIRE.toISOString() });
    expect(row.timeline[0]).toMatchObject({ event: 'scheduled' });
    await expect(createDatedOrder(pool as never, SUB, { book, decisionId: crypto.randomUUID(), symbol: 'MSFT', side: 'buy', qty: 1, orderType: 'market', fireAt: etWallToInstant('2026-09-12', '09:35') }, NOW)).rejects.toThrow(/trading days/);
    expect((await listDatedOrders(pool as never, SUB, { bookId: book.bookId })).length).toBe(1);
  });

  it('a due order fires exactly once with one requestId, and a second tick does not place again', async () => {
    const row = (await listDatedOrders(pool as never, SUB, { status: ['pending'] }))[0];
    const venue = fakePlace();
    const before = await tickDatedOrders(ctx(), SUB, venue.deps(new Date(FIRE.getTime() - 60_000)));
    expect(before.processed).toBe(0); expect(venue.calls.length).toBe(0);            // not due yet → untouched
    const t1 = await tickDatedOrders(ctx(), SUB, venue.deps(new Date(FIRE.getTime() + 60_000)));
    expect(t1.transitions).toEqual([`${row.datedId}:fired`]);
    expect(venue.calls).toEqual([{ decisionId: row.decisionId, requestId: `dated-${row.datedId.slice(0, 8)}` }]);
    const fired = await getDatedOrder(pool as never, SUB, row.datedId);
    expect(fired).toMatchObject({ status: 'fired', firedOrderId: 'o-1', firedStatus: 'accepted' });
    const t2 = await tickDatedOrders(ctx(), SUB, venue.deps(new Date(FIRE.getTime() + 6 * 60_000)));
    expect(t2.processed).toBe(0); expect(venue.calls.length).toBe(1);
  });

  it('a cancelled order never fires, and cannot be cancelled twice', async () => {
    const row = await mk();
    const c = await cancelDatedOrder(pool as never, SUB, row.datedId, NOW);
    expect(c.status).toBe('cancelled');
    await expect(cancelDatedOrder(pool as never, SUB, row.datedId, NOW)).rejects.toThrow(/already cancelled/);
    const venue = fakePlace();
    await tickDatedOrders(ctx(), SUB, venue.deps(new Date(FIRE.getTime() + 60_000)));
    expect(venue.calls.length).toBe(0);
    expect((await getDatedOrder(pool as never, SUB, row.datedId))?.status).toBe('cancelled');
  });

  it('a window missed by more than the grace EXPIRES unfired — never a stale order', async () => {
    const row = await mk();
    const venue = fakePlace();
    const out = await tickDatedOrders(ctx(), SUB, venue.deps(new Date(FIRE.getTime() + 40 * 60_000)));
    expect(out.transitions).toEqual([`${row.datedId}:expired`]);
    expect(venue.calls.length).toBe(0);
    const r = await getDatedOrder(pool as never, SUB, row.datedId);
    expect(r?.status).toBe('expired');
    expect(r?.timeline.at(-1)).toMatchObject({ event: 'expired' });
  });

  it('a closed market at the fire time (exchange holiday) EXPIRES it unfired — never an order into a closed venue', async () => {
    const row = await mk();
    const venue = fakePlace();
    const out = await tickDatedOrders(ctx(), SUB, venue.deps(new Date(FIRE.getTime() + 60_000), 'closed'));
    expect(out.transitions).toEqual([`${row.datedId}:expired`]);
    expect(venue.calls.length).toBe(0);
    expect((await getDatedOrder(pool as never, SUB, row.datedId))?.timeline.at(-1)).toMatchObject({ event: 'expired', detail: expect.stringContaining('market closed') });
  });

  it('a PROTECTED timed entry is not released before it can fire: the lot release clock starts at notBefore', async () => {
    const rules = { takeProfitPct: 10, stopLossPct: 5 };
    // The release clock is max(createdAt, notBefore) + 2 days, and createPinnedLotIntent stamps
    // createdAt from the REAL clock with no injection seam. So notBefore has to move with the real
    // clock too: a hardcoded FIRE made this test pass only until the calendar reached it. It went
    // red on 2026-09-09 -- the very date FIRE named -- because by then "3 days after intent" was
    // already past "FIRE + 2 days", so the timed lot correctly released and the test's premise
    // (a moment both 3 days after intent AND before the fire time) had become impossible.
    const notBefore = new Date(Date.now() + 5 * 86_400_000);
    const timed = await createPinnedLotIntent(pool as never, SUB, { book, decisionId: crypto.randomUUID(), symbol: 'MSFT', qty: 5, rules, notBefore });
    const plain = await createPinnedLotIntent(pool as never, SUB, { book, decisionId: crypto.randomUUID(), symbol: 'MSFT', qty: 5, rules });
    expect(timed.entry).toMatchObject({ notBefore: notBefore.toISOString() });
    const venue = fakePlace();
    // 3 days after intent, before the fire time: the plain lot is released (never placed), the timed one waits.
    await tickPinnedLots(ctx(), SUB, venue.deps(new Date(Date.now() + 3 * 86_400_000)));
    expect((await getPinnedLot(pool as never, SUB, plain.lotId))?.status).toBe('released');
    expect((await getPinnedLot(pool as never, SUB, timed.lotId))?.status).toBe('pending_fill');
    // 3 days after notBefore with still no order: now it is genuinely never-placed → released.
    await tickPinnedLots(ctx(), SUB, venue.deps(new Date(notBefore.getTime() + 3 * 86_400_000)));
    expect((await getPinnedLot(pool as never, SUB, timed.lotId))?.status).toBe('released');
  });

  it('a 07:30 PRE-session limit + extended-hours day order is accepted and fires exactly once when the venue session is pre', async () => {
    const pre = etWallToInstant('2026-09-09', '07:30');
    await expect(createDatedOrder(pool as never, SUB, { book, decisionId: crypto.randomUUID(), symbol: 'MSFT', side: 'buy', qty: 5, orderType: 'limit', fireAt: pre }, NOW)).rejects.toThrow(/extended hours/);
    const row = await createDatedOrder(pool as never, SUB, { book, decisionId: crypto.randomUUID(), symbol: 'MSFT', side: 'buy', qty: 5, orderType: 'limit', fireAt: pre, extendedHours: true, timeInForce: 'day' }, NOW);
    expect(row).toMatchObject({ status: 'pending', fireAt: pre.toISOString() });
    expect(row.timeline[0].detail).toContain('extended hours');
    const venue = fakePlace();
    const out = await tickDatedOrders(ctx(), SUB, venue.deps(new Date(pre.getTime() + 60_000), 'pre'));
    expect(out.transitions).toEqual([`${row.datedId}:fired`]);
    expect(venue.calls).toEqual([{ decisionId: row.decisionId, requestId: `dated-${row.datedId.slice(0, 8)}` }]);
    await tickDatedOrders(ctx(), SUB, venue.deps(new Date(pre.getTime() + 2 * 60_000), 'pre'));
    expect(venue.calls.length).toBe(1);
  });

  it('an early-close afternoon order (2026-11-27 15:00) is accepted and PLACES when the venue reports post — only closed expires', async () => {
    const nov20 = new Date('2026-11-20T18:00:00Z'); const fire = etWallToInstant('2026-11-27', '15:00');
    const row = await createDatedOrder(pool as never, SUB, { book, decisionId: crypto.randomUUID(), symbol: 'MSFT', side: 'buy', qty: 5, orderType: 'market', fireAt: fire }, nov20);
    const venue = fakePlace();
    const out = await tickDatedOrders(ctx(), SUB, venue.deps(new Date(fire.getTime() + 60_000), 'post'));
    expect(out.transitions).toEqual([`${row.datedId}:fired`]);
    expect(venue.calls.length).toBe(1);
  });

  it('an engine refusal is terminal: status error, no retry on the next tick', async () => {
    const row = await mk();
    const venue = fakePlace();
    venue.setRefusal(new TradingError(422, 'guardrail_blocked', 'over the notional cap'));
    const out = await tickDatedOrders(ctx(), SUB, venue.deps(new Date(FIRE.getTime() + 60_000)));
    expect(out.transitions).toEqual([`${row.datedId}:error`]);
    const r = await getDatedOrder(pool as never, SUB, row.datedId);
    expect(r).toMatchObject({ status: 'error', error: 'over the notional cap' });
    venue.setRefusal(null);
    await tickDatedOrders(ctx(), SUB, venue.deps(new Date(FIRE.getTime() + 2 * 60_000)));
    expect(venue.calls.length).toBe(1);
  });
});

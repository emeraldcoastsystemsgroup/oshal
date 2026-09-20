/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-138 D3 lot state machine against the REAL oshal Postgres (fail-loud when down) with injected venue fakes: intent → the entry order fills (ledger row + venue truth) → open → exits placed as TP LIMIT GTC + STOP GTC 'pinned-lot' decisions on the lot's book → the take-profit fills → the stop is CANCELLED and the lot closes with P&L; pinnedQtyBySymbol counts only held lots; a trailing-stop variant places TRAILING_STOP; release cancels working exits; the FORCE-RLS table exists.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | This spec now STARTS its own PostgreSQL and removes it, instead of taking an address from the environment at all. Refusing an unpointed run made the 2026-09-14 accident impossible but left the spec unrunnable: the `const DSN = specDatabaseUrl(...)` threw AT IMPORT, so every case in the file collapsed before it ran and the lot state machine was guarded by nothing in any gate. A private server makes it both safe and executable, and there is no longer any value a caller can supply that would reach a deployment. The DELETE-by-sub teardown goes with it — the container is destroyed, so no cleanup SQL runs anywhere, which is the property that failed twice. The conditional `ALTER TABLE ... OWNER TO oshal_app` goes too: that role exists only in the shared deployment this spec no longer touches, so the guard could never fire; the FORCE-RLS assertion reads pg_class and does not depend on the owner. One setting is NEW rather than carried: `statementTimeoutMs: 60_000`. The old pool declared no statement timeout at all, and the fixture's own default is 15 s, which a cold container plus schema bootstrap can exceed on a loaded box; it matches the trading-event-plans reference conversion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import crypto from 'crypto';
import {
  ensurePinnedLotsSchema, normalizePinnedLotRules, createPinnedLotIntent, getPinnedLot, listPinnedLots, releasePinnedLot,
  pinnedQtyBySymbol, tickPinnedLots,
} from '../../src/app/trading-pinned-lots';
import type { EventPlanDeps } from '../../src/app/trading-event-plans';
import { ensureBooksSchema, ensureLegacyBooks, legacyBook } from '../../src/app/trading-books-store';
import { ensureTradingSchema } from '../../src/app/trading-engine';
import type { AppContext } from '../../src/app/composition/app-context';
import type { OrderResult } from '../../src/features/trading';
import { DisposablePostgres } from '../helpers/disposable-postgres';

// A PostgreSQL this file owns: started here, removed in afterAll, reachable from nothing else.
// `row_security=off` keeps the superuser's reads across the FORCE-RLS lot table explicit, and the
// pool size is the four the old environment-resolved pool asked for.
const database = new DisposablePostgres({
  purpose: 'trading-pinned-lots', database: 'trading_fixture', memory: '384m', max: 4,
  statementTimeoutMs: 60_000, options: '-c row_security=off',
});
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-lot-${RUN}`;
let pool: Pool;
const ctx = () => ({ pool } as unknown as AppContext);

function fakeVenue() {
  const orders = new Map<string, OrderResult>(); const cancelled: string[] = []; let n = 0;
  const place = async (_p: unknown, _s: string, _b: unknown, decisionId: string, requestId: string): Promise<OrderResult> => {
    const id = `o-${++n}-${requestId}`;
    const o = { id, clientOrderId: requestId, status: 'accepted', symbol: 'MSFT', side: 'sell', qty: 0, type: 'limit', filledQty: 0, provider: 'alpaca', mode: 'paper', decisionId } as unknown as OrderResult;
    orders.set(id, o); return o;
  };
  const broker = () => ({
    configured: () => true, getAccount: async () => ({ equity: 100_000 }),
    getOrder: async (id: string) => { const o = orders.get(id); if (!o) throw new Error('unknown order ' + id); return o; },
    cancelOrder: async (id: string) => { cancelled.push(id); const o = orders.get(id); if (o && o.status !== 'filled') (o as { status: string }).status = 'canceled'; },
  });
  const seed = (id: string, o: Partial<OrderResult>) => orders.set(id, { id, clientOrderId: id, status: 'accepted', symbol: 'MSFT', side: 'buy', qty: 0, type: 'limit', filledQty: 0, provider: 'alpaca', mode: 'paper', ...o } as OrderResult);
  const fill = (pred: (id: string) => boolean, avg: number, qty: number) => { for (const [id, o] of orders) if (pred(id) && o.status !== 'filled') Object.assign(o, { status: 'filled', filledQty: qty, filledAvgPrice: avg }); };
  return { orders, cancelled, place, broker, seed, fill };
}

/** Mint a real operator decision + a FILLED ledger row for it, the way the manual route + engine would. */
async function seedFilledEntry(bookId: string, symbol: string, qty: number, avg: number, brokerOrderId: string): Promise<string> {
  const d = (await pool.query(
    `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, confidence, rationale)
       VALUES ($1,'paper',$2,'{}'::uuid[],'operator','buy',$3,'buy',$4,'limit',1,'spec entry') RETURNING decision_id`, [SUB, bookId, symbol, qty])).rows[0].decision_id;
  await pool.query(
    `INSERT INTO oshal_trading_orders (user_sub, mode, book_id, decision_id, broker, broker_order_id, client_order_id, symbol, side, qty, order_type, status, raw_status, filled_qty, filled_avg_price, submitted_at)
       VALUES ($1,'paper',$2,$3,'alpaca',$4,$5,$6,'buy',$7,'limit','filled','FILLED',$7,$8,now())`, [SUB, bookId, d, brokerOrderId, `${SUB}:spec-entry-${brokerOrderId}`, symbol, qty, avg]);
  return String(d);
}

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  process.env.TRADING_MAX_NOTIONAL_USD = '50000'; process.env.TRADING_MAX_QTY = '100000';
  pool = await database.start();
  await ensureBooksSchema(pool as never); await ensureTradingSchema(pool as never); await ensurePinnedLotsSchema(pool as never);
  await ensureLegacyBooks(pool as never, SUB);
}, 120_000);

// No DELETE pass: the whole server goes away, so there is nothing to clean and nowhere to clean it.
afterAll(async () => { await database.stop(); });

describe('protected lots — intent → fill → exits → take-profit closes and cancels the stop', () => {
  const book = legacyBook(SUB, 'paper');
  const venue = fakeVenue();
  const deps: EventPlanDeps = {
    now: () => new Date('2026-09-04T15:00:00Z'), session: async () => 'regular', edgarSearch: async () => [], fetchText: async () => null,
    broker: venue.broker as unknown as EventPlanDeps['broker'], latestTrade: async () => null, place: venue.place as unknown as EventPlanDeps['place'],
  };
  let lotId = '';

  it('the table is FORCE-RLS with an owner policy', async () => {
    const r = await pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'oshal_trading_pinned_lots'`);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('an intent is recorded pending_fill and counts ZERO pinned shares until filled', async () => {
    const decisionId = await seedFilledEntry(book.bookId, 'MSFT', 20, 500, 'o-entry-1');
    venue.seed('o-entry-1', { status: 'filled', filledQty: 20, filledAvgPrice: 500, symbol: 'MSFT' });
    const lot = await createPinnedLotIntent(pool as never, SUB, { book, decisionId, symbol: 'MSFT', qty: 20, rules: normalizePinnedLotRules({ takeProfitPct: 10, stopLossPct: 8 }) });
    lotId = lot.lotId;
    expect(lot.status).toBe('pending_fill');
    expect((await pinnedQtyBySymbol(pool as never, SUB, book.bookId)).get('MSFT')).toBeUndefined();
  });

  it('the fill opens the lot and places TP LIMIT GTC at +10% and STOP GTC at −8% as pinned-lot decisions on the book', async () => {
    const t = await tickPinnedLots(ctx(), SUB, deps);
    expect(t.transitions).toContain(`${lotId}:exits_placed`);
    const lot = (await getPinnedLot(pool as never, SUB, lotId))!;
    expect(lot.filledQty).toBe(20); expect(lot.filledAvgPrice).toBe(500);
    expect(lot.exits).toMatchObject({ tpPx: 550, stopPx: 460 });
    const d = await pool.query(`SELECT side, order_type, limit_price, stop_price, time_in_force, book_id FROM oshal_trading_decisions WHERE user_sub = $1 AND agent_id = 'pinned-lot' ORDER BY created_at`, [SUB]);
    expect(d.rows.map((r) => [r.order_type, r.time_in_force])).toEqual([['limit', 'gtc'], ['stop', 'gtc']]);
    expect(Number(d.rows[0].limit_price)).toBe(550); expect(Number(d.rows[1].stop_price)).toBe(460);
    expect(String(d.rows[0].book_id)).toBe(book.bookId);
    // now the shares ARE pinned — the autopilot overlay subtracts them
    expect((await pinnedQtyBySymbol(pool as never, SUB, book.bookId)).get('MSFT')).toBe(20);
  });

  it('the take-profit fills → the stop is CANCELLED, the lot closes with P&L, and the pin lifts', async () => {
    venue.fill((id) => id.includes('-tp-'), 551, 20);
    const t = await tickPinnedLots(ctx(), SUB, deps);
    expect(t.transitions).toContain(`${lotId}:closed`);
    const lot = (await getPinnedLot(pool as never, SUB, lotId))!;
    expect(lot.result).toMatchObject({ reason: 'take_profit', exitPx: 551, qty: 20 });
    expect(Number(lot.result!.pnl)).toBeCloseTo((551 - 500) * 20, 1);
    expect(venue.cancelled.some((id) => id.includes('-stop-'))).toBe(true);
    expect((await pinnedQtyBySymbol(pool as never, SUB, book.bookId)).get('MSFT')).toBeUndefined();
  });

  it('a trailing-stop rule places TRAILING_STOP; release cancels the working exits and returns the shares', async () => {
    const decisionId = await seedFilledEntry(book.bookId, 'NVDA', 5, 120, 'o-entry-2');
    venue.seed('o-entry-2', { status: 'filled', filledQty: 5, filledAvgPrice: 120, symbol: 'NVDA' });
    const lot = await createPinnedLotIntent(pool as never, SUB, { book, decisionId, symbol: 'NVDA', qty: 5, rules: normalizePinnedLotRules({ trailingStopPct: 6 }) });
    await tickPinnedLots(ctx(), SUB, deps);
    const opened = (await getPinnedLot(pool as never, SUB, lot.lotId))!;
    expect(opened.status).toBe('exits_placed'); expect(opened.exits).toMatchObject({ trailPct: 6 });
    const d = await pool.query(`SELECT order_type, trail_percent FROM oshal_trading_decisions WHERE user_sub = $1 AND symbol = 'NVDA' AND agent_id = 'pinned-lot'`, [SUB]);
    expect(d.rows[0].order_type).toBe('trailing_stop'); expect(Number(d.rows[0].trail_percent)).toBe(6);
    const before = venue.cancelled.length;
    const rel = await releasePinnedLot(ctx(), SUB, lot.lotId, deps);
    expect(rel.status).toBe('released'); expect(venue.cancelled.length).toBe(before + 1);
    expect((await listPinnedLots(pool as never, SUB, { bookId: book.bookId, status: ['open', 'exits_placed'] })).length).toBe(0);
  });
});

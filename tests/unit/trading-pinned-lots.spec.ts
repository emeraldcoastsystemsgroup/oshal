/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-138 D3 lot state machine against the REAL oshal Postgres (fail-loud when down) with injected venue fakes: intent → the entry order fills (ledger row + venue truth) → open → exits placed as TP LIMIT GTC + STOP GTC 'pinned-lot' decisions on the lot's book → the take-profit fills → the stop is CANCELLED and the lot closes with P&L; pinnedQtyBySymbol counts only held lots; a trailing-stop variant places TRAILING_STOP; release cancels working exits; the FORCE-RLS table exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
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

const DSN = process.env.OSHAL_TEST_DSN || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
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
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try { await pool.query('SELECT 1'); } catch (error) {
    throw new Error(`trading-pinned-lots requires the live oshal Postgres at ${DSN.replace(/:[^:@/]+@/, ':***@')} — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  await ensureBooksSchema(pool as never); await ensureTradingSchema(pool as never); await ensurePinnedLotsSchema(pool as never);
  await pool.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN EXECUTE 'ALTER TABLE oshal_trading_pinned_lots OWNER TO oshal_app'; END IF; END $$;`);
  await ensureLegacyBooks(pool as never, SUB);
}, 120_000);

afterAll(async () => {
  for (const t of ['oshal_trading_orders', 'oshal_trading_decisions', 'oshal_trading_signals', 'oshal_trading_pinned_lots', 'oshal_trading_books']) {
    await pool.query(`DELETE FROM ${t} WHERE user_sub = $1`, [SUB]).catch(() => {});
  }
  await pool.end();
});

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

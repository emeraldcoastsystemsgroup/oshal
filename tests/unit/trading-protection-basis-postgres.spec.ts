/** CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real fill replay, book/owner scope, dispatch exits and persisted peaks in an owned disposable PostgreSQL, with only market bars explicitly stubbed.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
vi.mock('@/features/trading', async () => ({ ...await vi.importActual<object>('@/features/trading'), barsBatch: vi.fn(async () => new Map()) }));
import { withEngineCostBasis } from '../../src/app/trading-engine-cost-basis';
import { ensureBooksSchema } from '../../src/app/trading-books-store';
import { ensureTradingSchema } from '../../src/app/trading-engine';
import { ensurePeaksTable, loadPeaks } from '../../src/app/trading-peaks-store';
import { computeExits } from '../../src/app/trading-dispatch-exits-entries';
import { RISK_POLICIES } from '../../src/features/trading/services/portfolio';
import type { Position, TradingBook } from '../../src/features/trading';
import type { AppContext } from '../../src/app/composition-root';
import { DisposablePostgres } from '../helpers/disposable-postgres';
vi.setConfig({ hookTimeout: 300_000 });
const database = new DisposablePostgres({ purpose: 'protection-basis', database: 'protection_fixture', memory: '384m', max: 4 });
let pool: Pool;
const live: TradingBook = { bookId: '00000000-0000-4000-8000-00000000b451', ref: 'live', kind: 'live', broker: null, accountNumber: null, connectionKey: null, capitalCapUsd: null, learn: false, enabled: true };
const paper: TradingBook = { ...live, bookId: '00000000-0000-4000-8000-00000000b452', ref: 'paper', kind: 'paper' };
const owner = (name: string) => `protection-${process.pid}-${name}`;
const position = (last: number, venue = 130, qty = 10): Position => ({ symbol: 'ABC', qty, avgEntryPrice: venue, currentPrice: last, marketValue: qty * last, unrealizedPl: qty * (last - venue) });
async function fill(sub: string, book: TradingBook, side: 'buy' | 'sell', qty: number, px: number, at = '2026-10-01T14:00:00Z') {
  const decision = (await pool.query(`INSERT INTO oshal_trading_decisions (user_sub, mode, signal_ids, action, rationale)
    VALUES ($1,$2,'{}'::uuid[],$3,'owned protection fixture') RETURNING decision_id`, [sub, book.kind, side])).rows[0].decision_id;
  await pool.query(`INSERT INTO oshal_trading_orders
    (user_sub, mode, decision_id, broker, client_order_id, symbol, side, qty, order_type, status, filled_qty, filled_avg_price, created_at, book_id)
    VALUES ($1,$2,$3,'schwab',gen_random_uuid()::text,'ABC',$4,$5,'market','filled',$5,$6,$7::timestamptz,$8)`,
    [sub, book.kind, decision, side, qty, px, at, book.bookId]);
}
async function fire(sub: string, p: Position[], book = live) {
  const ctx = { pool } as AppContext;
  const marked = await withEngineCostBasis(ctx, sub, book, p);
  const exits = await computeExits(ctx, sub, book, marked, RISK_POLICIES.active, 1_000_000, false);
  return { marked, exits, peaks: await loadPeaks(pool as never, sub, book) };
}

describe('protection basis through actual ledger SQL, dispatch and peak persistence', () => {
  beforeAll(async () => {
    pool = await database.start();
    await ensureBooksSchema(pool as never);
    await ensureTradingSchema(pool as never);
    await ensurePeaksTable(pool as never);
  });
  afterAll(async () => { await database.stop(); });

  it('takes active-policy engine profit after a full loss round-trip and replacement buy', async () => {
    const sub = owner('replacement');
    await fill(sub, live, 'buy', 10, 120);
    await fill(sub, live, 'sell', 10, 90, '2026-10-02T14:00:00Z');
    await fill(sub, live, 'buy', 10, 100, '2026-10-03T14:00:00Z');
    const result = await fire(sub, [position(110)]);
    expect(result.marked[0].engineAvgCost).toBe(100);
    expect(result.marked[0].avgEntryPrice).toBe(130);
    expect(result.exits).toEqual([{ symbol: 'ABC', qty: 10, reason: 'take_profit', pnlPct: 10 }]);
    expect(result.peaks.get('ABC')).toBe(110);
  });

  it('persists observed marks and trails from a seeded earlier high on the same economic basis', async () => {
    const sub = owner('trail'); await fill(sub, live, 'buy', 10, 100);
    const first = await fire(sub, [position(107)]);
    expect(first.exits).toEqual([]); expect(first.peaks.get('ABC')).toBe(107);
    // Use the active arm (+5%) and giveback (3%) with a previously observed 110 high.
    await pool.query('UPDATE oshal_trading_peaks SET peak_price=110 WHERE user_sub=$1 AND book_id=$2', [sub, live.bookId]);
    const second = await fire(sub, [position(106)]);
    expect(second.exits[0]).toMatchObject({ reason: 'trailing_stop', pnlPct: 6 });
    expect(second.peaks.get('ABC')).toBe(110);
  });

  it('does not borrow engine coverage from another owner or book', async () => {
    const sub = owner('scope'); await fill(sub, paper, 'buy', 10, 100); await fill(owner('foreign'), live, 'buy', 10, 100);
    const result = await fire(sub, [position(110)]);
    expect(result.marked[0].unmanaged).toBe(true);
    expect(result.marked[0].engineAvgCost).toBeUndefined(); expect(result.exits).toEqual([]);
  });

  it('marks partial coverage unmanaged and never creates profit or trailing exits from it', async () => {
    const sub = owner('partial'); await fill(sub, live, 'buy', 5, 100);
    const result = await fire(sub, [position(110)]);
    expect(result.marked[0].unmanaged).toBe(true); expect(result.exits).toEqual([]);
  });

  it('keeps a genuine stop loss and does not create a new stop on a higher engine basis', async () => {
    const sub = owner('stops'); await fill(sub, live, 'buy', 10, 100);
    expect((await fire(sub, [position(94)])).exits[0].reason).toBe('stop_loss');
    expect((await fire(sub, [position(94, 90)])).exits).toEqual([]);
  });

  it('prunes closed peaks and starts a re-entry from its fresh actual replacement cost', async () => {
    const sub = owner('flat'); await fill(sub, live, 'buy', 10, 100);
    await fire(sub, [position(107)]);
    await fill(sub, live, 'sell', 10, 107, '2026-10-02T14:00:00Z');
    expect((await fire(sub, [])).peaks.size).toBe(0);
    await fill(sub, live, 'buy', 10, 80, '2026-10-03T14:00:00Z');
    const result = await fire(sub, [position(84, 130)]);
    expect(result.marked[0].engineAvgCost).toBe(80); expect(result.peaks.get('ABC')).toBe(84);
  });

  it('preserves prior stored peaks and never repairs unknown historic observations by guessing', async () => {
    const sub = owner('prior'); await fill(sub, live, 'buy', 10, 100);
    await fire(sub, [position(107)]);
    await pool.query('UPDATE oshal_trading_peaks SET peak_price=140 WHERE user_sub=$1 AND book_id=$2', [sub, live.bookId]);
    expect((await fire(sub, [position(106)])).peaks.get('ABC')).toBe(140);
  });
});

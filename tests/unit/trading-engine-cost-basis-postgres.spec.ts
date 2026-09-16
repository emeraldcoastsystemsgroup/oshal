/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cross the real boundary of the wash-sale veto. withEngineCostBasis catches ANY error and returns the positions unchanged, so a wrong column name or a broken book filter would make the fix silently inert in production while every pure test stayed green - the stop-losses would keep firing and nothing would say why. This drives the real SQL against a real PostgreSQL and the real oshal_trading_orders schema, inside a transaction that is always rolled back.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | engineRealizedForBook against the real schema: prices a live sell on the live book's own fill, keyed by order id, ignores a rejected row, and reads nothing from the paper book on the same symbol.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-159 at the same real boundary: the `unmanaged` mark is what withholds every order decision for a position, so the query that decides it has to be exercised against the real oshal_trading_orders schema - a wrong column or a broken book filter would otherwise mark a whole covered book unmanaged and silently strip its protective exits. Asserts the mark on a venue quantity the ledger only partly covers and its ABSENCE on a covered one.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | This spec now STARTS its own PostgreSQL and removes it, the way the ADR-159 dispatch guards do, instead of taking an address from the environment at all, and it builds the trading schema itself rather than borrowing whatever the deployment happened to have. That also retires the vacuous shape the borrowed database forced: every case opened `if (!client) return`, and a soft assertion reported the missing server — so a run with no database PASSED while proving nothing, which is the false green this file exists to prevent. Setup now fails loudly and the cases have no escape. The rolled-back transaction is kept (it is the file's own design) but is no longer load-bearing: the server it rolls back is thrown away.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { withEngineCostBasis, engineRealizedForBook } from '../../src/app/trading-engine-cost-basis';
import { ensureBooksSchema } from '../../src/app/trading-books-store';
import { ensureTradingSchema } from '../../src/app/trading-engine';
import type { Position, TradingBook } from '../../src/features/trading';
import { DisposablePostgres } from '../helpers/disposable-postgres';

// Starting a server is the slow part; the assertions themselves are milliseconds.
vi.setConfig({ hookTimeout: 300_000 });

// A PostgreSQL this file owns: started here, removed in afterAll, reachable from nothing else.
const database = new DisposablePostgres({
  purpose: 'trading-cost-basis', database: 'trading_fixture', memory: '384m', max: 4, statementTimeoutMs: 60_000,
});

const SUB = `cost-basis-spec-${process.pid}-${Date.now()}`;
const LIVE = '00000000-0000-4000-8000-00000000c0b1';
const PAPER = '00000000-0000-4000-8000-00000000c0b2';

const book = (bookId: string): TradingBook => ({
  bookId, ref: 'live', kind: 'live', broker: null, accountNumber: null, connectionKey: null,
  capitalCapUsd: null, learn: false, enabled: true,
});

const position = (symbol: string, qty: number, venueAvg: number, last: number): Position => ({
  symbol, qty, avgEntryPrice: venueAvg, currentPrice: last, marketValue: qty * last, unrealizedPl: qty * (last - venueAvg),
});

let client: PoolClient;

/**
 * Every order must reference a real decision row (oshal_trading_orders_decision_id_fkey) - the
 * signal -> decision -> order provenance the route enforces. The fixture honours it rather than
 * dropping the constraint, so this spec runs against the schema exactly as production has it.
 */
async function fill(bookId: string, symbol: string, side: 'buy' | 'sell', qty: number, px: number, at: string): Promise<void> {
  const decision = (await client.query(
    `INSERT INTO oshal_trading_decisions (user_sub, mode, signal_ids, action, rationale)
     VALUES ($1, 'live', '{}'::uuid[], $2, 'cost-basis spec fixture') RETURNING decision_id`,
    [SUB, side])).rows[0].decision_id;
  await client.query(
    `INSERT INTO oshal_trading_orders
       (user_sub, mode, decision_id, broker, client_order_id, symbol, side, qty, order_type,
        status, filled_qty, filled_avg_price, created_at, book_id)
     VALUES ($1, 'live', $8, 'schwab', gen_random_uuid()::text, $2, $3, $4, 'market',
             'filled', $4, $5, $6::timestamptz, $7)`,
    [SUB, symbol, side, qty, px, at, bookId, decision]);
}

describe('withEngineCostBasis against the real oshal_trading_orders schema', () => {
  // A failure here fails the file. There is no "no database" branch any more: the spec brings its
  // own, so an unreachable one is a broken fixture, never a reason to report green.
  beforeAll(async () => {
    const pool = await database.start();
    await ensureBooksSchema(pool as never);
    await ensureTradingSchema(pool as never);
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterAll(async () => {
    try {
      await client?.query('ROLLBACK').catch(() => undefined);
      client?.release();
    } finally { await database.stop(); }
  });

  it('attaches the engine’s own basis, replaying the CRM round-trip the venue folded a loss into', async () => {
    // The real 09-02..09-04 shape: sell at a loss, re-buy. The venue carries 7.51/sh into the re-buy.
    await fill(LIVE, 'CRM', 'buy', 5, 244.465, '2026-09-10T14:00:00Z');
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('CRM', 5, 265.878, 252.3901)]);
    expect(p.engineAvgCost).toBeCloseTo(244.465, 6);
    expect(p.avgEntryPrice).toBe(265.878); // the venue figure is carried untouched
  });

  it('prices each sell of one book on that book’s own fills, by order id, ignoring rejected rows', async () => {
    await fill(LIVE, 'NTAP', 'buy', 4, 100, '2026-09-11T14:00:00Z');
    await fill(PAPER, 'NTAP', 'buy', 4, 10, '2026-09-11T14:05:00Z');
    await fill(LIVE, 'NTAP', 'sell', 4, 90, '2026-09-11T15:00:00Z');
    await client.query(
      `INSERT INTO oshal_trading_orders (user_sub, mode, decision_id, broker, client_order_id, symbol, side, qty, order_type,
         status, filled_qty, created_at, book_id)
       SELECT user_sub, mode, decision_id, broker, gen_random_uuid()::text, symbol, 'sell', 4, 'market', 'rejected', 0,
              '2026-09-11T15:01:00Z'::timestamptz, book_id
         FROM oshal_trading_orders WHERE user_sub = $1 AND book_id = $2 AND symbol = 'NTAP' LIMIT 1`, [SUB, LIVE]);
    const live = await engineRealizedForBook({ pool: client as never }, SUB, LIVE, ['ntap']);
    const sells = (await client.query(
      `SELECT order_id::text AS id FROM oshal_trading_orders WHERE user_sub = $1 AND book_id = $2 AND symbol = 'NTAP' AND side = 'sell' AND status = 'filled'`,
      [SUB, LIVE])).rows;
    expect(sells).toHaveLength(1);
    expect(live.size).toBe(1);
    expect(live.get(sells[0].id)).toEqual({ costBasis: 100, realizedPnl: -40 });
    expect((await engineRealizedForBook({ pool: client as never }, SUB, PAPER)).size).toBe(0);
  });

  it('is book-scoped: paper fills on the same symbol never leak into the live basis', async () => {
    await fill(LIVE, 'SLB', 'buy', 23, 55.2902, '2026-09-11T14:00:00Z');
    await fill(PAPER, 'SLB', 'buy', 50, 61.0, '2026-09-11T14:05:00Z'); // a different book entirely
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('SLB', 23, 58.2665, 55.215)]);
    expect(p.engineAvgCost).toBeCloseTo(55.2902, 6);
  });

  it('resets on flat: a loss round-trip does not follow the re-buy', async () => {
    await fill(LIVE, 'DUOL', 'buy', 18, 176.0, '2026-09-01T14:00:00Z');
    await fill(LIVE, 'DUOL', 'sell', 18, 150.0, '2026-09-05T14:00:00Z');
    await fill(LIVE, 'DUOL', 'buy', 18, 150.0288, '2026-09-11T14:00:00Z');
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('DUOL', 18, 167.7443, 147.705)]);
    expect(p.engineAvgCost).toBeCloseTo(150.0288, 6);
  });

  it('attaches nothing, and MARKS the position unmanaged, when the venue holds lots the engine did not buy', async () => {
    await fill(LIVE, 'USO', 'buy', 9, 150.0, '2026-09-10T14:00:00Z');
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('USO', 200, 154.54, 157.77)]);
    expect(p.engineAvgCost).toBeUndefined();
    // ADR-159 - 9 of 200 shares is no basis for the other 191, so the engine withholds every order
    // decision for this position. The mark is read off the REAL ledger query, not a doubled one.
    expect(p.unmanaged).toBe(true);
  });

  it('does NOT mark a position its own fills fully cover — the mark is the query\'s answer, not a default', async () => {
    await fill(LIVE, 'TEM', 'buy', 14, 59.37, '2026-09-11T14:00:00Z');
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('TEM', 14, 62.9879, 59.05)]);
    expect(p.engineAvgCost).toBeCloseTo(59.37, 6);
    expect(p.unmanaged).toBeUndefined();
  });

  it('marks a position the OTHER book covers but this one does not — the mark is book-scoped too', async () => {
    await fill(PAPER, 'HOOD', 'buy', 25, 114.6411, '2026-09-11T14:00:00Z');
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('HOOD', 25, 121.7664, 114.05)]);
    expect(p.unmanaged).toBe(true);
  });

  it('matches symbols case-insensitively, as every other trading store does', async () => {
    await fill(LIVE, 'gild', 'buy', 6, 145.17, '2026-09-11T14:00:00Z');
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('GILD', 6, 153.2, 144.045)]);
    expect(p.engineAvgCost).toBeCloseTo(145.17, 6);
  });
});

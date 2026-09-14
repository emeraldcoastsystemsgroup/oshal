/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cross the real boundary of the wash-sale veto. withEngineCostBasis catches ANY error and returns the positions unchanged, so a wrong column name or a broken book filter would make the fix silently inert in production while every pure test stayed green - the stop-losses would keep firing and nothing would say why. This drives the real SQL against a real PostgreSQL and the real oshal_trading_orders schema, inside a transaction that is always rolled back.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { withEngineCostBasis } from '../../src/app/trading-engine-cost-basis';
import type { Position, TradingBook } from '../../src/features/trading';

const ADMIN_URL = process.env.TRADING_TEST_ADMIN_URL
  ?? process.env.OWNERSHIP_TEST_ADMIN_URL
  ?? 'postgresql://oshal:oshal-dev@127.0.0.1:55433/oshal';

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

let client: Client | null = null;

/**
 * Every order must reference a real decision row (oshal_trading_orders_decision_id_fkey) - the
 * signal -> decision -> order provenance the route enforces. The fixture honours it rather than
 * dropping the constraint, so this spec runs against the schema exactly as production has it.
 */
async function fill(bookId: string, symbol: string, side: 'buy' | 'sell', qty: number, px: number, at: string): Promise<void> {
  const decision = (await client!.query(
    `INSERT INTO oshal_trading_decisions (user_sub, mode, signal_ids, action, rationale)
     VALUES ($1, 'live', '{}'::uuid[], $2, 'cost-basis spec fixture') RETURNING decision_id`,
    [SUB, side])).rows[0].decision_id;
  await client!.query(
    `INSERT INTO oshal_trading_orders
       (user_sub, mode, decision_id, broker, client_order_id, symbol, side, qty, order_type,
        status, filled_qty, filled_avg_price, created_at, book_id)
     VALUES ($1, 'live', $8, 'schwab', gen_random_uuid()::text, $2, $3, $4, 'market',
             'filled', $4, $5, $6::timestamptz, $7)`,
    [SUB, symbol, side, qty, px, at, bookId, decision]);
}

describe('withEngineCostBasis against the real oshal_trading_orders schema', () => {
  beforeAll(async () => {
    const c = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 4000 });
    try { await c.connect(); client = c; await client.query('BEGIN'); }
    catch { await c.end().catch(() => undefined); client = null; }
  }, 20000);

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  });

  it('reaches a database — otherwise this guard proves nothing and says so', () => {
    expect.soft(client, `No PostgreSQL at ${ADMIN_URL.replace(/:[^:@]*@/, ':***@')}. This spec proves the `
      + 'REAL query; without a server it asserts nothing. Start the stack or set TRADING_TEST_ADMIN_URL.').not.toBeNull();
  });

  it('attaches the engine’s own basis, replaying the CRM round-trip the venue folded a loss into', async () => {
    if (!client) return;
    // The real 09-02..09-04 shape: sell at a loss, re-buy. The venue carries 7.51/sh into the re-buy.
    await fill(LIVE, 'CRM', 'buy', 5, 244.465, '2026-09-10T14:00:00Z');
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('CRM', 5, 265.878, 252.3901)]);
    expect(p.engineAvgCost).toBeCloseTo(244.465, 6);
    expect(p.avgEntryPrice).toBe(265.878); // the venue figure is carried untouched
  });

  it('is book-scoped: paper fills on the same symbol never leak into the live basis', async () => {
    if (!client) return;
    await fill(LIVE, 'SLB', 'buy', 23, 55.2902, '2026-09-11T14:00:00Z');
    await fill(PAPER, 'SLB', 'buy', 50, 61.0, '2026-09-11T14:05:00Z'); // a different book entirely
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('SLB', 23, 58.2665, 55.215)]);
    expect(p.engineAvgCost).toBeCloseTo(55.2902, 6);
  });

  it('resets on flat: a loss round-trip does not follow the re-buy', async () => {
    if (!client) return;
    await fill(LIVE, 'DUOL', 'buy', 18, 176.0, '2026-09-01T14:00:00Z');
    await fill(LIVE, 'DUOL', 'sell', 18, 150.0, '2026-09-05T14:00:00Z');
    await fill(LIVE, 'DUOL', 'buy', 18, 150.0288, '2026-09-11T14:00:00Z');
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('DUOL', 18, 167.7443, 147.705)]);
    expect(p.engineAvgCost).toBeCloseTo(150.0288, 6);
  });

  it('attaches nothing when the venue holds lots the engine did not buy', async () => {
    if (!client) return;
    await fill(LIVE, 'USO', 'buy', 9, 150.0, '2026-09-10T14:00:00Z');
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('USO', 200, 154.54, 157.77)]);
    expect(p.engineAvgCost).toBeUndefined();
  });

  it('matches symbols case-insensitively, as every other trading store does', async () => {
    if (!client) return;
    await fill(LIVE, 'gild', 'buy', 6, 145.17, '2026-09-11T14:00:00Z');
    const [p] = await withEngineCostBasis({ pool: client as never }, SUB, book(LIVE), [position('GILD', 6, 153.2, 144.045)]);
    expect(p.engineAvgCost).toBeCloseTo(145.17, 6);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — regression guard for the 2026-08-18 live twin-order incident: two same-fire paths shared a minute-bucketed clientOrderId and Schwab (no server-side client-order-id) placed BOTH, then recordOrder's upsert overwrote the filled row with the rejected twin. Locks placeDecisionOrder's submission reservation: (a) the ledger claim is inserted BEFORE the venue call, (b) a losing racer gets 409 duplicate_submission and never reaches the venue, (c) any throw between reservation and recordOrder releases the still-'submitting' claim (venue error AND the ext-hours stale_quote refusal), (d) the fill upsert lands on the reserved clientOrderId row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrderResult } from '../../src/features/trading';

const h = vi.hoisted(() => ({
  placeOrder: vi.fn(),
  getPositions: vi.fn(async () => []),
  tradingSession: vi.fn(async () => 'regular'),
  latestTrade: vi.fn(async () => null),
  /** Interleaving recorder: every ledger touch and venue call appends here in real order. */
  seq: [] as string[],
}));

vi.mock('@/features/trading', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/trading')>();
  return {
    ...actual,
    liveTradingEnabled: () => true,
    tradingSession: h.tradingSession,
    getMarketData: () => ({ latestTrade: h.latestTrade }),
    getBrokerAdapter: () => ({
      provider: 'schwab',
      mode: 'live',
      configured: () => true,
      placeOrder: h.placeOrder,
      getPositions: h.getPositions,
    }),
  };
});

import { placeDecisionOrder, TradingError } from '../../src/app/trading-engine';

const SUB = 'sub-1';
const DECISION = {
  action: 'sell', symbol: 'ARKG', side: 'sell', qty: 30, order_type: 'market',
  limit_price: null, stop_price: null, trail_price: null, trail_percent: null, time_in_force: null,
};

const FILL: OrderResult = {
  id: 'sch-264', clientOrderId: `${SUB}:req-1`, symbol: 'ARKG', side: 'sell', qty: 30,
  type: 'market', status: 'filled', rawStatus: 'FILLED', filledQty: 30, filledAvgPrice: 43.065,
  provider: 'schwab', mode: 'live',
} as OrderResult;

/**
 * @description Minimal pool stub routing placeDecisionOrder's four statements by SQL shape and
 * recording their interleaving with the venue call into h.seq.
 * @param reserve - Whether the reservation insert wins (rows back) or loses the race (zero rows).
 * @returns The pool plus the captured calls for assertions.
 */
function makePool(reserve: boolean) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (/FROM oshal_trading_decisions/.test(sql)) return { rows: [DECISION] };
      // ADR-134: the reservation/record arbiter is the BOOK-scoped unique index. Pinning the exact
      // conflict target here is deliberate — a regression back to the mode index (or to no arbiter)
      // fails this match and the spec goes red.
      if (/ON CONFLICT \(user_sub, book_id, client_order_id\) DO NOTHING/.test(sql)) {
        h.seq.push('reserve');
        return { rows: reserve ? [{ order_id: 'res-1' }] : [] };
      }
      if (/DELETE FROM oshal_trading_orders/.test(sql)) { h.seq.push('release'); return { rows: [] }; }
      if (/ON CONFLICT \(user_sub, book_id, client_order_id\) DO UPDATE/.test(sql)) { h.seq.push('record'); return { rows: [] }; }
      return { rows: [] };
    }),
  };
  return { pool: pool as never, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.seq.length = 0;
  h.getPositions.mockResolvedValue([]);
  h.tradingSession.mockResolvedValue('regular');
  h.placeOrder.mockImplementation(async () => { h.seq.push('venue'); return FILL; });
  process.env.TRADING_EXTENDED_HOURS = 'false';
});

describe('placeDecisionOrder — submission reservation (2026-08-18 twin-order guard)', () => {
  it('claims the clientOrderId in the ledger BEFORE the venue call, then records onto that row', async () => {
    const { pool, calls } = makePool(true);
    const r = await placeDecisionOrder(pool, SUB, 'live', 'dec-1', 'req-1', true);
    expect(r.status).toBe('filled');
    expect(h.seq).toEqual(['reserve', 'venue', 'record']);
    const reservation = calls.find((c) => /DO NOTHING/.test(c.sql));
    expect(reservation?.sql).toMatch(/'submitting'/);
    expect(reservation?.params).toContain(`${SUB}:req-1`);
    expect(reservation?.params).toContain('schwab');
    // The fill upsert targets the SAME idempotency key — it completes the reservation row.
    const record = calls.find((c) => /DO UPDATE/.test(c.sql));
    expect(record?.params).toContain(`${SUB}:req-1`);
  });

  it('REFUSES the loser of the race with 409 duplicate_submission and never touches the venue', async () => {
    const { pool } = makePool(false);
    const err = await placeDecisionOrder(pool, SUB, 'live', 'dec-1', 'req-1', true).catch((e) => e);
    expect(err).toBeInstanceOf(TradingError);
    expect((err as TradingError).httpStatus).toBe(409);
    expect((err as TradingError).code).toBe('duplicate_submission');
    expect(h.placeOrder).not.toHaveBeenCalled();
    expect(h.seq).toEqual(['reserve']); // no venue, no record, no release — the row belongs to the winner
  });

  it('releases the still-submitting claim when the venue call throws, so a later retry is not locked out', async () => {
    const { pool, calls } = makePool(true);
    h.placeOrder.mockRejectedValue(new Error('schwab place order 500'));
    await expect(placeDecisionOrder(pool, SUB, 'live', 'dec-1', 'req-1', true)).rejects.toThrow('schwab place order 500');
    expect(h.seq).toEqual(['reserve', 'release']);
    const release = calls.find((c) => /DELETE FROM oshal_trading_orders/.test(c.sql));
    expect(release?.sql).toMatch(/status='submitting'/);
    expect(release?.params).toContain(`${SUB}:req-1`);
  });

  it('releases the claim on the ext-hours stale_quote refusal too (throw between reserve and venue)', async () => {
    const { pool } = makePool(true);
    process.env.TRADING_EXTENDED_HOURS = 'true';
    h.tradingSession.mockResolvedValue('pre');
    h.latestTrade.mockResolvedValue(null); // no fresh tick → placeDecisionOrder refuses to price
    const err = await placeDecisionOrder(pool, SUB, 'live', 'dec-1', 'req-1', true).catch((e) => e);
    expect(err).toBeInstanceOf(TradingError);
    expect((err as TradingError).code).toBe('stale_quote');
    expect(h.placeOrder).not.toHaveBeenCalled();
    expect(h.seq).toEqual(['reserve', 'release']);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 paper futures broker: multiplier-scaled long P&L, partial-close realized P&L into cash, short-side gain when price falls, clientOrderId idempotency, and rejection of a non-futures symbol.
 */
import { describe, it, expect } from 'vitest';
import { createPaperFuturesBroker, type OrderRequest } from '../../src/features/trading';

/** A mutable mark so a test can move the price after a fill. */
function markBox(initial: number) {
  const state = { price: initial };
  return { state, resolver: async () => state.price };
}

function ord(symbol: string, side: 'buy' | 'sell', qty: number, tag: string): OrderRequest {
  return { userSub: 'u', symbol, side, qty, type: 'market', clientOrderId: `${symbol}:${side}:${tag}` };
}

describe('paper futures broker — long P&L with multiplier', () => {
  it('fills a market buy at the mark and marks-to-market with the ES $50 multiplier', async () => {
    const mark = markBox(5000);
    const broker = createPaperFuturesBroker({ startingCash: 100_000, priceResolver: mark.resolver });
    const buy = await broker.placeOrder(ord('ESZ25', 'buy', 2, '1'));
    expect(buy.status).toBe('filled');
    expect(buy.filledAvgPrice).toBe(5000);
    mark.state.price = 5010;
    const [pos] = await broker.getPositions();
    expect(pos.qty).toBe(2);
    expect(pos.unrealizedPl).toBe((5010 - 5000) * 2 * 50); // 1000
    const acct = await broker.getAccount();
    expect(acct.equity).toBe(101_000);
  });

  it('realizes P&L into cash on a partial close', async () => {
    const mark = markBox(5000);
    const broker = createPaperFuturesBroker({ startingCash: 100_000, priceResolver: mark.resolver });
    await broker.placeOrder(ord('ESZ25', 'buy', 2, '1'));
    mark.state.price = 5010;
    await broker.placeOrder(ord('ESZ25', 'sell', 1, '2')); // close 1 of 2 at 5010
    const acct = await broker.getAccount();
    expect(acct.cash).toBe(100_500);      // realized (5010-5000)*1*50
    expect(acct.equity).toBe(101_000);    // + unrealized on the remaining 1
    const [pos] = await broker.getPositions();
    expect(pos.qty).toBe(1);
  });
});

describe('paper futures broker — short side + idempotency + rejects', () => {
  it('a short gains when price falls', async () => {
    const mark = markBox(5000);
    const broker = createPaperFuturesBroker({ startingCash: 100_000, priceResolver: mark.resolver });
    await broker.placeOrder(ord('ESZ25', 'sell', 1, '1')); // open short at 5000
    mark.state.price = 4990;
    const [pos] = await broker.getPositions();
    expect(pos.qty).toBe(-1);
    expect(pos.unrealizedPl).toBe((4990 - 5000) * -1 * 50); // +500
  });

  it('is idempotent on clientOrderId — a replay places nothing new', async () => {
    const broker = createPaperFuturesBroker({ startingCash: 100_000, priceResolver: async () => 5000 });
    const a = await broker.placeOrder(ord('ESZ25', 'buy', 1, 'dup'));
    const b = await broker.placeOrder(ord('ESZ25', 'buy', 1, 'dup'));
    expect(b.id).toBe(a.id);
    const [pos] = await broker.getPositions();
    expect(pos.qty).toBe(1); // not 2
  });

  it('rejects an order on a non-futures symbol', async () => {
    const broker = createPaperFuturesBroker({ startingCash: 100_000, priceResolver: async () => 100 });
    const r = await broker.placeOrder(ord('AAPL', 'buy', 1, '1'));
    expect(r.status).toBe('rejected');
    expect(r.rejectReason).toMatch(/not a known futures contract/);
  });

  it('uses the micro (MES) $5 multiplier', async () => {
    const mark = markBox(5000);
    const broker = createPaperFuturesBroker({ startingCash: 100_000, priceResolver: mark.resolver });
    await broker.placeOrder(ord('MESZ25', 'buy', 1, '1'));
    mark.state.price = 5100;
    const [pos] = await broker.getPositions();
    expect(pos.unrealizedPl).toBe((5100 - 5000) * 1 * 5); // 500, not 5000
  });
});

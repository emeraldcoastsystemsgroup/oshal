/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the pure safety logic of the transaction-based ledger reconcile, locking the fixes an adversarial review surfaced: match already-booked sells by qty+price+date when broker_order_id is NULL (never book them twice), refuse a symbol whose unbooked sells don't sum to the excess (the SKHYV ticker-conversion case), FIFO basis from full replay, skip a short venue position. Uses the REAL 2026-07-10 PANW history from the live Schwab pull.
 */
import { describe, it, expect } from 'vitest';
import { planSymbol, isAlreadyBooked, fifoBasisFor } from '../../src/app/trading-reconcile-ledger';

function tx(id: string, side: 'buy' | 'sell', qty: number, price: number, date: string, orderId: string | null = null) {
  return { transactionId: id, orderId, symbol: 'X', side, qty, price, fees: 0, netAmount: 0, tradeDate: date };
}
// The REAL PANW transaction history pulled from the live Schwab account 2026-07-15.
const PANW = [
  tx('t1', 'buy', 5, 348.74, '2026-07-07T16:20:00Z', 'o1'),
  tx('t2', 'sell', 5, 318.975, '2026-07-08T18:50:00Z', 'o2'),
  tx('t3', 'buy', 4, 319.786, '2026-07-09T13:31:00Z', 'o3'),
  tx('MISSING', 'sell', 4, 331.335, '2026-07-10T04:00:00Z', 'o4'), // the unbooked close
  tx('t5', 'buy', 4, 324.56, '2026-07-13T13:31:00Z', 'o5'),
  tx('t6', 'sell', 4, 331.801, '2026-07-14T13:30:00Z', 'o6'),
];
// The two PANW sells the engine already booked (07-08 + 07-14).
const PANW_LEDGER_SELLS = [
  { brokerOrderId: 'o2', qty: 5, price: 318.975, createdAtMs: Date.parse('2026-07-08T18:50:00Z') },
  { brokerOrderId: 'o6', qty: 4, price: 331.801, createdAtMs: Date.parse('2026-07-14T13:30:00Z') },
];

describe('planSymbol — PANW clean case (the real reconcile)', () => {
  it('books exactly the one unbooked 07-10 close, with the correct FIFO basis', () => {
    const r = planSymbol('PANW', 4, 0, PANW, PANW_LEDGER_SELLS);
    expect(r.action).toBe('book');
    expect(r.bookings).toHaveLength(1);
    const b = r.bookings[0];
    expect(b.qty).toBe(4);
    expect(b.price).toBe(331.335);
    expect(b.costBasis).toBeCloseTo(319.786, 3);           // FIFO: the 07-09 lot, not the 07-13 lot
    expect(b.realizedPnl).toBeCloseTo((331.335 - 319.786) * 4, 2); // +$46.20
    expect(b.clientOrderId).toBe('reconcile:schwab:MISSING');
  });

  it('does NOT re-book the two already-booked sells', () => {
    const r = planSymbol('PANW', 4, 0, PANW, PANW_LEDGER_SELLS);
    expect(r.bookings.map((b) => b.price)).not.toContain(318.975);
    expect(r.bookings.map((b) => b.price)).not.toContain(331.801);
  });
});

describe('planSymbol — refuses ambiguous / mismatched histories', () => {
  it('REFUSES when unbooked sells do not sum to the excess (the SKHYV ticker-conversion shape)', () => {
    // Ledger tracked 69 long; venue shows a commingled 119-share sale (one clip here) → 119 != 69.
    const skhyv = [tx('b1', 'buy', 119, 170, '2026-07-10T15:34:00Z'), tx('s1', 'sell', 119, 173.86, '2026-07-10T16:59:00Z')];
    const r = planSymbol('SKHYV', 69, 0, skhyv, []);
    expect(r.action).toBe('refuse');
    expect(r.reason).toMatch(/do not sum/i);
  });

  it('refuses on FIFO underflow (opening buy outside the window)', () => {
    // A sell with no prior buy in the pulled window → basis unresolved → refuse.
    const t = [tx('s1', 'sell', 4, 100, '2026-07-10T00:00:00Z')];
    const r = planSymbol('Y', 4, 0, t, []);
    expect(r.action).toBe('refuse');
    expect(r.reason).toMatch(/basis|history/i);
  });
});

describe('planSymbol — guards', () => {
  it('skips a symbol that nets SHORT at the venue (long-only reconcile)', () => {
    const r = planSymbol('Z', 5, -3, [], []);
    expect(r.action).toBe('skip-short');
  });

  it('reports already-clean when the ledger matches the venue', () => {
    const r = planSymbol('Z', 10, 10, [], []);
    expect(r.action).toBe('already-clean');
    expect(r.bookings).toHaveLength(0);
  });

  it('excess is measured against the venue LONG (positive) position', () => {
    // ledger 10, venue holds 6 → excess 4.
    const t = [tx('b', 'buy', 10, 100, '2026-07-01T00:00:00Z'), tx('s', 'sell', 4, 110, '2026-07-05T00:00:00Z')];
    const r = planSymbol('Z', 10, 6, t, []);
    expect(r.excess).toBe(4);
    expect(r.action).toBe('book');
    expect(r.bookings[0].qty).toBe(4);
  });
});

describe('isAlreadyBooked — the broker_order_id-unreliable fix (Blocker 1)', () => {
  it('matches by qty+price+date when the ledger row has a NULL broker_order_id', () => {
    const sell = tx('s', 'sell', 4, 331.801, '2026-07-14T13:30:00Z', 'o6');
    const ledgerNullId = [{ brokerOrderId: null, qty: 4, price: 331.801, createdAtMs: Date.parse('2026-07-14T13:32:00Z') }];
    expect(isAlreadyBooked(sell, ledgerNullId)).toBe(true); // would be MISSED by an orderId-only / IS NOT NULL dedup
  });

  it('matches by orderId even when qty/price drift slightly', () => {
    const sell = tx('s', 'sell', 4, 331.80, '2026-07-14T13:30:00Z', 'o6');
    const ledger = [{ brokerOrderId: 'o6', qty: 4, price: 331.90, createdAtMs: Date.parse('2026-07-20T00:00:00Z') }];
    expect(isAlreadyBooked(sell, ledger)).toBe(true);
  });

  it('does NOT match a genuinely different sell (different price + day)', () => {
    const sell = tx('s', 'sell', 4, 331.335, '2026-07-10T04:00:00Z', 'o4');
    expect(isAlreadyBooked(sell, PANW_LEDGER_SELLS)).toBe(false); // the real unbooked close
  });
});

describe('fifoBasisFor', () => {
  it('resolves the PANW 07-10 sell to the 07-09 lot (319.786)', () => {
    expect(fifoBasisFor(PANW, 'MISSING')).toBeCloseTo(319.786, 3);
  });
  it('resolves the 07-14 sell to the 07-13 lot (324.56)', () => {
    expect(fifoBasisFor(PANW, 't6')).toBeCloseTo(324.56, 3);
  });
  it('returns null on underflow', () => {
    expect(fifoBasisFor([tx('s', 'sell', 1, 100, '2026-07-01T00:00:00Z')], 's')).toBeNull();
  });
});

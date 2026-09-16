/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The wash-sale guard measured from the VENUE ADAPTER, which is where the defect enters. Every existing spec hands exitsToRun a hand-built Position, so all of them stay green if the Schwab mapping stops carrying `averagePrice` onto `avgEntryPrice` or starts carrying something else - and the veto is then measuring a number the adapter no longer produces. This drives a RECORDED Schwab `?fields=positions` payload through SchwabBrokerAdapter.getPositions() and then through the fire's own computeExits, and asserts: a position whose venue average exceeds the engine's own fill price (the wash-sale adjustment folded into the replacement shares) emits NO stop and NO trim; a real decline past the stop measured from the engine's OWN fill price still emits one; and a holding the engine has no fill for emits nothing at all even though it breaches both the stop and the per-name cap. Scoped double: the pool. The ledger query has its own real-PostgreSQL companion in trading-engine-cost-basis-postgres.spec.ts; the boundary THIS spec exists to cross is the adapter, and that one is real.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The stand-in pool answers `connect()` too. A bootstrap that names an advisory lock key checks out ONE client and issues every statement on it, so a stand-in pool has to answer `connect()` as well as `query()`. The client shares the same reader, so the two reads this spec depends on - the engine's own filled orders and the empty trailing-peak table - are answered identically however the path reaches them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SchwabBrokerAdapter } from '../../src/features/trading/services/schwab-broker-adapter';
import { withEngineCostBasis } from '../../src/app/trading-engine-cost-basis';
import { computeExits } from '../../src/app/trading-dispatch-exits-entries';
import { riskPolicy } from '../../src/features/trading';
import type { AppContext } from '../../src/app/composition-root';
import type { Position, TradingBook } from '../../src/features/trading';

/** The live book's posture (TRADING_POSTURE=active): stop 5%, per-name cap 3%, trail arms at +5%. */
const POLICY = riskPolicy('live', { posture: 'active' });

/** Big enough that the covered name sits inside the 3% per-name cap and the hand-bought one does not. */
const EQUITY = 600_000;

const BOOK: TradingBook = {
  bookId: '00000000-0000-4000-8000-0000000ba515',
  ref: 'live', kind: 'live', broker: 'schwab', accountNumber: null, connectionKey: null,
  capitalCapUsd: null, learn: false, enabled: true,
};

/** One filled order as `oshal_trading_orders` stores it - the engine's own record of what it paid. */
interface Fill { symbol: string; side: 'buy' | 'sell'; filled_qty: number; filled_avg_price: number }

/**
 * The CRM round trip the operator verified to the cent on the live book: bought at 144.56, stopped
 * out at 137.05 (7.51/share disallowed), re-bought at 143.97 the same week. The engine's own cost of
 * the position it holds now is 143.97; the venue reports 143.97 + 7.51.
 */
const CRM_FILLS: Fill[] = [
  { symbol: 'CRM', side: 'buy', filled_qty: 100, filled_avg_price: 144.56 },
  { symbol: 'CRM', side: 'sell', filled_qty: 100, filled_avg_price: 137.05 },
  { symbol: 'CRM', side: 'buy', filled_qty: 100, filled_avg_price: 143.97 },
];

/**
 * @description A Schwab `?fields=positions` row, exactly as the Trader API shapes one.
 * @param symbol - Ticker.
 * @param qty - Long quantity held.
 * @param averagePrice - The venue's average, which after a wash sale carries the disallowed loss.
 * @param last - Current price, from which marketValue and open P&L are derived.
 * @returns The recorded position row.
 */
function venuePosition(symbol: string, qty: number, averagePrice: number, last: number): Record<string, unknown> {
  return {
    longQuantity: qty, shortQuantity: 0, averagePrice,
    marketValue: qty * last,
    longOpenProfitLoss: (last - averagePrice) * qty,
    currentDayProfitLoss: 0,
    instrument: { symbol, assetType: 'EQUITY' },
  };
}

/**
 * @description A pool that answers the two reads this path makes: the engine's own filled orders
 * (the fixture) and the trailing-peak table (empty, which is what a fresh re-entry has). Everything
 * else on the path is DDL whose result nothing reads.
 * @param fills - The engine's own filled orders for this book.
 * @returns The stand-in pool.
 */
function poolFor(fills: Fill[]): AppContext['pool'] {
  const query = async (sql: string) => {
    if (/FROM oshal_trading_orders/i.test(sql)) {
      return {
        rows: fills.map((f) => ({
          symbol: f.symbol.toUpperCase(), side: f.side,
          filled_qty: f.filled_qty, filled_avg_price: f.filled_avg_price,
        })),
      };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    query,
    // The advisory-lock bootstrap path runs its statements on a checked-out client, not the pool.
    connect: async () => ({ query, release: () => { /* a fake pool has nothing to reclaim */ } }),
  } as unknown as AppContext['pool'];
}

/**
 * @description Serve the recorded Schwab responses to the adapter's own fetch, and nothing else.
 * @param positions - The recorded position rows for the account.
 */
function serveSchwab(positions: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url);
    if (u.includes('/accounts/accountNumbers')) {
      return new Response(JSON.stringify([{ accountNumber: '10000001', hashValue: 'HASH-ONE' }]), { status: 200 });
    }
    if (u.includes('/accounts/HASH-ONE?fields=positions')) {
      return new Response(JSON.stringify({ securitiesAccount: { accountNumber: '10000001', positions } }), { status: 200 });
    }
    // The prior-close enrichment is a separate, optional read: an unavailable quote leaves the
    // "Today" columns blank and changes no exit rule.
    if (u.includes('/quotes')) return new Response('{}', { status: 200 });
    return new Response('not stubbed: ' + u, { status: 500 });
  });
}

/**
 * @description One full regular-session fire, from the venue payload the adapter parses to the exit
 * orders the dispatch would place.
 * @param positions - The recorded venue position rows.
 * @param fills - The engine's own filled orders.
 * @param sub - Owner sub (unique per case: the adapter caches the account hash per sub).
 * @returns The adapter's positions, the marked positions, and the exits the fire would emit.
 */
async function fireFrom(
  positions: Array<Record<string, unknown>>, fills: Fill[], sub: string,
): Promise<{ venue: Position[]; marked: Position[]; exits: Array<{ symbol: string; reason: string }> }> {
  serveSchwab(positions);
  const adapter = new SchwabBrokerAdapter('live', async () => 'test-token', sub, '10000001');
  const venue = await adapter.getPositions();
  const ctx = { pool: poolFor(fills) } as AppContext;
  const marked = await withEngineCostBasis(ctx, sub, BOOK, venue);
  const exits = await computeExits(ctx, sub, BOOK, marked, POLICY, EQUITY, false);
  return { venue, marked, exits };
}

let caseId = 0;
beforeEach(() => {
  caseId += 1;
  process.env.SCHWAB_CLIENT_ID = 'spec-client';
  process.env.SCHWAB_CLIENT_SECRET = 'spec-secret';
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the wash-sale veto, measured from the Schwab adapter', () => {
  it('carries the venue AVERAGE onto avgEntryPrice - the field every money rule keys off', async () => {
    const { venue } = await fireFrom([venuePosition('CRM', 100, 151.48, 143.00)], CRM_FILLS, `wash-map-${process.pid}-${caseId}`);
    expect(venue).toHaveLength(1);
    // If this mapping changes, every pure exit spec stays green while the veto measures nothing.
    expect(venue[0].avgEntryPrice).toBeCloseTo(151.48, 4);
    expect(venue[0].currentPrice).toBeCloseTo(143.00, 4);
  });

  it('emits NO stop and NO trim when the venue average exceeds the engine own fill price', async () => {
    // The venue reads -5.60% (143.00 against 151.48) and wants the 5% stop; the engine paid 143.97,
    // so its own money is down 0.67% and there is nothing wrong with the position.
    const { marked, exits } = await fireFrom(
      [venuePosition('CRM', 100, 151.48, 143.00)], CRM_FILLS, `wash-veto-${process.pid}-${caseId}`);
    expect(marked[0].engineAvgCost).toBeCloseTo(143.97, 4);
    expect(marked[0].unmanaged).toBeUndefined();
    expect(exits).toEqual([]);
  });

  it('still stops out a real decline past the stop measured from the engine own fill price', async () => {
    // 130.00 is -9.7% on the 143.97 the engine actually paid: a real loss, and it must still fire.
    const { exits } = await fireFrom(
      [venuePosition('CRM', 100, 151.48, 130.00)], CRM_FILLS, `wash-real-${process.pid}-${caseId}`);
    expect(exits.map((e) => [e.symbol, e.reason])).toEqual([['CRM', 'stop_loss']]);
  });

  it('emits nothing at all for a holding the engine has no fill for, past stop AND past the cap', async () => {
    // 500 USO bought outside the engine: -14.3% against the venue average (past the 5% stop) and
    // $30,000 against an $18,000 per-name cap (past the trim). ADR-159: monitored, never traded.
    const { marked, exits } = await fireFrom(
      [venuePosition('USO', 500, 70.00, 60.00)], [], `wash-unmanaged-${process.pid}-${caseId}`);
    expect(marked[0].unmanaged).toBe(true);
    expect(marked[0].engineAvgCost).toBeUndefined();
    expect(exits).toEqual([]);
  });

  it('withholds only the unaccounted name - a covered one in the same payload still fires', async () => {
    const { exits } = await fireFrom(
      [venuePosition('USO', 500, 70.00, 60.00), venuePosition('CRM', 100, 151.48, 130.00)],
      CRM_FILLS, `wash-mixed-${process.pid}-${caseId}`);
    expect(exits.map((e) => e.symbol)).toEqual(['CRM']);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — venue-routed sizing prices (sizingPrice + ensureCore). The LIVE book SIZED off raw Alpaca IEX latestPrice while EXECUTING at Schwab. Guards: (a) live sizing reads the routed per-book source (getMarketData) and never the raw Alpaca function, (b) an executing-venue failure SKIPS the name — fail-closed, no daily-close fallback for live — without killing the fire (other names still trade), (c) paper semantics unchanged (Alpaca feed first, caller's daily-close fallback honored on the rotation paths).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MarketDataSource, BrokerAccount } from '../../src/features/trading';

const h = vi.hoisted(() => ({
  /** The WRONG venue for live sizing — the raw Alpaca free function. Poisoned at 999: any sizing
   *  math that lands on 999-derived quantities (or any call at all) means the routing regressed. */
  rawLatestPrice: vi.fn(),
  /** The per-book source factory every sizing price must be resolved through. */
  getMarketData: vi.fn(),
  placeDecisionOrder: vi.fn(),
}));

vi.mock('@/features/trading', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/trading')>();
  return { ...actual, latestPrice: h.rawLatestPrice, getMarketData: h.getMarketData };
});

// (repointed with the trading engine extraction, ADR-085 pre-carve: the dispatch loop imports
//  placeDecisionOrder/ensureTradingSchema from app/trading-engine.ts, not the route surface.)
vi.mock('../../src/app/trading-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/trading-engine')>();
  return { ...actual, placeDecisionOrder: h.placeDecisionOrder, ensureTradingSchema: vi.fn() };
});

import { sizingPrice, ensureCore, type CoreConfig } from '../../src/app/trading-schedule-dispatch';
import { getMarketData as realGetMarketData } from '../../src/features/trading/services/market-data-source';

/** A faked MarketDataSource whose latestPrice behavior each test controls. */
function fakeSource(kind: 'alpaca' | 'schwab', latest: (s: string) => Promise<number | null>): MarketDataSource & { latestPrice: ReturnType<typeof vi.fn> } {
  return {
    kind,
    configured: () => true,
    latestPrice: vi.fn(latest),
    latestTrade: vi.fn(async () => null),
    dailyCloses: vi.fn(async () => []),
    closesForTimeframe: vi.fn(async () => []),
    barsBatch: vi.fn(async () => new Map<string, number[]>()),
  } as unknown as MarketDataSource & { latestPrice: ReturnType<typeof vi.fn> };
}

/** Minimal AppContext: placeManaged → persistDecision only needs pool.query to return id rows. */
function makeCtx(): Parameters<typeof ensureCore>[0] {
  const pool = { query: vi.fn().mockResolvedValue({ rows: [{ signal_id: 'sig-1', decision_id: 'dec-1' }] }) };
  return { pool } as unknown as Parameters<typeof ensureCore>[0];
}

const ACCOUNT: BrokerAccount = { equity: 100_000, cash: 50_000, buyingPower: 50_000, currency: 'USD' };

beforeEach(() => {
  vi.clearAllMocks();
  h.rawLatestPrice.mockResolvedValue(999); // poison — sizing must never consult this venue
  h.placeDecisionOrder.mockResolvedValue({ status: 'accepted', id: 'ord-1' });
});

describe('sizingPrice — venue-routed, fail-closed for live', () => {
  it('live: prices from the routed (executing-venue) source, never the raw Alpaca function', async () => {
    const src = fakeSource('schwab', async () => 512.34);
    h.getMarketData.mockReturnValue(src);
    const px = await sizingPrice('live', 'sub-1', 'SPY');
    expect(px).toBe(512.34);
    expect(h.getMarketData).toHaveBeenCalledWith('live', 'sub-1');
    expect(src.latestPrice).toHaveBeenCalledWith('SPY');
    expect(h.rawLatestPrice).not.toHaveBeenCalled();
  });

  it('live: a venue read that THROWS returns null (skip) — never the daily-close fallback', async () => {
    h.getMarketData.mockReturnValue(fakeSource('schwab', async () => { throw new Error('schwab-md 500'); }));
    await expect(sizingPrice('live', 'sub-1', 'SPY', 500)).resolves.toBeNull();
  });

  it('live: no positive price from the venue returns null even with a fallback close on offer', async () => {
    h.getMarketData.mockReturnValue(fakeSource('schwab', async () => null));
    expect(await sizingPrice('live', 'sub-1', 'SPY', 500)).toBeNull();
    h.getMarketData.mockReturnValue(fakeSource('schwab', async () => 0));
    expect(await sizingPrice('live', 'sub-1', 'SPY', 500)).toBeNull();
  });

  it('paper: the feed price wins, resolved through the paper source (unchanged semantics)', async () => {
    const src = fakeSource('alpaca', async () => 101);
    h.getMarketData.mockReturnValue(src);
    expect(await sizingPrice('paper', 'sub-1', 'SPY', 99)).toBe(101);
    expect(h.getMarketData).toHaveBeenCalledWith('paper', 'sub-1');
    expect(h.rawLatestPrice).not.toHaveBeenCalled();
  });

  it('paper: a feed miss falls back to the caller\'s daily close (the rotation paths\' behavior)', async () => {
    h.getMarketData.mockReturnValue(fakeSource('alpaca', async () => { throw new Error('iex down'); }));
    expect(await sizingPrice('paper', 'sub-1', 'SPY', 99)).toBe(99);
    h.getMarketData.mockReturnValue(fakeSource('alpaca', async () => null));
    expect(await sizingPrice('paper', 'sub-1', 'SPY', 99)).toBe(99);
    expect(await sizingPrice('paper', 'sub-1', 'SPY')).toBeNull();       // no fallback → skip
    expect(await sizingPrice('paper', 'sub-1', 'SPY', 0)).toBeNull();    // non-positive fallback → skip
  });
});

describe('ensureCore — the live core top-up sizes off the executing venue', () => {
  const core60: CoreConfig = { symbols: ['SPY'], targetPct: 60, perSymbolPct: new Map([['SPY', 60]]) };

  it('sizes the live buy from the routed source price, not the poisoned raw latestPrice', async () => {
    const src = fakeSource('schwab', async () => 500);
    h.getMarketData.mockReturnValue(src);
    const orders: Parameters<typeof ensureCore>[6] = [];
    const errors: Parameters<typeof ensureCore>[7] = [];
    const spent = await ensureCore(makeCtx(), 'sub-1', 'live', ACCOUNT, [], core60, orders, errors);
    // target 60% of 100K = 60K; cash bound 50K*0.98 = 49K → 98 shares @ 500 (999 would give 49).
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ symbol: 'SPY', side: 'buy', qty: 98 });
    expect(spent).toBe(98 * 500);
    expect(errors).toHaveLength(0);
    expect(h.getMarketData).toHaveBeenCalledWith('live', 'sub-1');
    expect(src.latestPrice).toHaveBeenCalledWith('SPY');
    expect(h.rawLatestPrice).not.toHaveBeenCalled();
  });

  it('a venue-unpriceable name is SKIPPED — the fire survives and the other core names still trade', async () => {
    const core2: CoreConfig = {
      symbols: ['SPY', 'QQQ'], targetPct: 60,
      perSymbolPct: new Map([['SPY', 30], ['QQQ', 30]]),
    };
    h.getMarketData.mockReturnValue(fakeSource('schwab', async (s) => {
      if (s === 'SPY') throw new Error('schwab-md /quotes 503'); // the executing venue cannot price SPY
      return 400;
    }));
    const orders: Parameters<typeof ensureCore>[6] = [];
    const errors: Parameters<typeof ensureCore>[7] = [];
    const spent = await ensureCore(makeCtx(), 'sub-1', 'live', ACCOUNT, [], core2, orders, errors);
    expect(orders).toHaveLength(1); // SPY skipped, QQQ still sized + placed
    expect(orders[0]).toMatchObject({ symbol: 'QQQ', side: 'buy', qty: 75 }); // floor(30K/400)
    expect(spent).toBe(75 * 400);
    expect(errors).toHaveLength(0); // a skip is not an error — and never a throw
    expect(h.rawLatestPrice).not.toHaveBeenCalled(); // the skip must not fall back to the wrong venue
  });

  it('paper is unchanged: the paper source (Alpaca) prices the top-up with identical math', async () => {
    const src = fakeSource('alpaca', async () => 500);
    h.getMarketData.mockReturnValue(src);
    const orders: Parameters<typeof ensureCore>[6] = [];
    const errors: Parameters<typeof ensureCore>[7] = [];
    await ensureCore(makeCtx(), 'sub-1', 'paper', ACCOUNT, [], core60, orders, errors);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ symbol: 'SPY', side: 'buy', qty: 98 });
    expect(h.getMarketData).toHaveBeenCalledWith('paper', 'sub-1');
    expect(src.latestPrice).toHaveBeenCalledWith('SPY');
  });
});

describe('venue selection — the real getMarketData wiring sizingPrice rides', () => {
  it('paper resolves Alpaca; live under BROKER_PROVIDER_LIVE=schwab resolves the Schwab source', () => {
    expect(realGetMarketData('paper', 'sub-1').kind).toBe('alpaca');
    const prev = process.env.BROKER_PROVIDER_LIVE;
    process.env.BROKER_PROVIDER_LIVE = 'schwab';
    try {
      expect(realGetMarketData('live', 'sub-1').kind).toBe('schwab');
    } finally {
      if (prev === undefined) delete process.env.BROKER_PROVIDER_LIVE;
      else process.env.BROKER_PROVIDER_LIVE = prev;
    }
  });
});

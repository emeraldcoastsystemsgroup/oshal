/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-159 - the two autopilot legs that can act on a holding the engine did not buy. sizeEntry cannot add to an open name at all, but the beta-core top-up (ensureCore) and the rotation sleeve both add to one, and rotation additionally sells a held name in full the moment it drops off the leaderboard - the path that traded the operator's hand-bought shares, since TRADING_SLEEVE_ROTATION owns the sleeve on the live box. These drive the REAL functions with the venue, market-data and order rails doubled outside them, and assert both halves of the contract: nothing is emitted for the unmanaged name, and the covered run's plan for every OTHER name is unchanged - including the cash-bound case, which is what proves a withheld buy's dollars are reserved rather than recycled into another name's order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrokerAccount, MarketDataSource, Position } from '../../src/features/trading';

const h = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {};
  const pin = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  // The operator box has several of these armed; the spec must not inherit the shell.
  for (const k of ['TRADING_SECTOR_TILT', 'TRADING_SYMBOL_BLOCKLIST', 'TRADING_ROTATION_EVERY_DAYS',
    'TRADING_ROTATION_EXT_HOURS', 'TRADING_CORE_TARGET_PCT', 'TRADING_CAPITAL_CAP_USD']) pin(k, undefined);
  pin('TRADING_CORE_SYMBOLS', '');                 // rotation owns 100% of the book here
  pin('TRADING_ROTATION_RANK', 'momentum');        // a deterministic ranker over the fixture closes
  pin('TRADING_ROTATION_TOPN', '2');
  pin('TRADING_ROTATION_WEIGHTING', 'equal');
  pin('TRADING_ROTATION_MAX_GAP_DOWN_PCT', '0');   // gap guard OFF: it is not what is under test
  return {
    saved,
    /** UPPERCASE symbol -> price, used by BOTH the sizing source and the fixtures. */
    price: {} as Record<string, number>,
    /** UPPERCASE symbol -> 150 ascending daily closes for the momentum ranker. */
    bars: new Map<string, number[]>(),
    /** Cash the broker reports AFTER rotation's settle wait (the only cash the buy leg may spend). */
    cashAfterSettle: 50_000,
    placeDecisionOrder: vi.fn(),
  };
});

vi.mock('@/features/trading', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/trading')>();
  const source = {
    kind: 'alpaca', configured: () => true,
    latestPrice: async (s: string) => h.price[s.toUpperCase()] ?? null,
    latestTrade: async () => null,
    dailyCloses: async (s: string) => h.bars.get(s.toUpperCase()) ?? [],
    closesForTimeframe: async () => [],
    barsBatch: async () => new Map(h.bars),
  } as unknown as MarketDataSource;
  return {
    ...actual,
    getMarketData: () => source,
    barsBatch: async () => new Map(h.bars),
    getBrokerAdapter: () => ({
      mode: () => 'paper', configured: () => true,
      getAccount: async () => ({ cash: h.cashAfterSettle, buyingPower: h.cashAfterSettle, equity: 100_000, currency: 'USD' }),
      getPositions: async () => [],
      placeOrder: async () => { throw new Error('spec: no order may reach a venue'); },
      getOrder: async () => { throw new Error('spec: unexpected'); },
      listOrders: async () => [],
      cancelOrder: async () => {},
    }),
  };
});

vi.mock('../../src/app/trading-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/trading-engine')>();
  return { ...actual, placeDecisionOrder: h.placeDecisionOrder, ensureTradingSchema: vi.fn() };
});

import { RISK_POLICIES } from '../../src/features/trading';
import { ensureCore, type CoreConfig } from '../../src/app/trading-dispatch-core';
import { rotateSleeve } from '../../src/app/trading-dispatch-rotation';
import type { RunOrder } from '../../src/app/trading-dispatch-rail';

const active = RISK_POLICIES.active;
const SUB = 'spec-adr159-entry';
const ACCOUNT: BrokerAccount = { cash: 50_000, buyingPower: 50_000, equity: 100_000, currency: 'USD' };

/** Minimal AppContext: placeManaged -> persistDecision only needs pool.query to return id rows. */
const makeCtx = () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [{ signal_id: 'sig-1', decision_id: 'dec-1' }] }) } } as never);

const pos = (symbol: string, qty: number, last: number, mark: Partial<Position> = {}): Position => ({
  symbol, qty, avgEntryPrice: last, currentPrice: last, marketValue: qty * last, unrealizedPl: 0, ...mark,
});
const unmanaged = (p: Position): Position => ({ ...p, unmanaged: true });

/** 150 ascending closes with a constant per-bar drift; a positive drift gives a positive 20-day return. */
const closes = (drift: number): number[] => Array.from({ length: 150 }, (_, i) => 100 * (1 + drift * i));

/** Every order placeManaged pushed, as [symbol, side, qty]. */
const placed = (orders: RunOrder[]): Array<[string, string, number]> => orders.map((o) => [o.symbol, o.side, o.qty]);

async function runRotation(positions: Position[]): Promise<RunOrder[]> {
  const orders: RunOrder[] = [];
  const errors: Array<{ symbol: string; error: string }> = [];
  await rotateSleeve(makeCtx(), SUB, 'paper', ACCOUNT, positions, active, new Set(), [...h.bars.keys()], orders, errors);
  expect(errors).toEqual([]);
  return orders;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.placeDecisionOrder.mockResolvedValue({ status: 'accepted', id: 'ord-1' });
  h.cashAfterSettle = 50_000;
  h.bars.clear();
  for (const k of Object.keys(h.price)) delete h.price[k];
});

describe('the beta-core top-up never adds to a holding the engine cannot account for', () => {
  /** SPY at a 35%-of-100K target, so a 20K holding is 15K under target and a 50K holding is 15K over. */
  const core: CoreConfig = { symbols: ['SPY'], targetPct: 35, perSymbolPct: new Map([['SPY', 35]]) };

  beforeEach(() => { h.price.SPY = 500; });

  it('tops a COVERED core holding up to its target (unchanged behaviour)', async () => {
    const orders: RunOrder[] = []; const errors: Array<{ symbol: string; error: string }> = [];
    const spent = await ensureCore(makeCtx(), SUB, 'paper', ACCOUNT, [pos('SPY', 40, 500)], core, orders, errors);
    expect(placed(orders)).toEqual([['SPY', 'buy', 30]]);   // 15,000 short / 500 = 30 shares
    expect(spent).toBe(15_000);
  });

  it('places NOTHING for an unmanaged core holding — and still reserves the dollars it withheld', async () => {
    const orders: RunOrder[] = []; const errors: Array<{ symbol: string; error: string }> = [];
    const spent = await ensureCore(makeCtx(), SUB, 'paper', ACCOUNT, [unmanaged(pos('SPY', 40, 500))], core, orders, errors);
    expect(orders).toEqual([]);
    expect(h.placeDecisionOrder).not.toHaveBeenCalled();
    // The sleeve subtracts `spent` from its own cash: reserving the withheld notional is what stops a
    // withheld top-up from handing the sleeve room it does not have today.
    expect(spent).toBe(15_000);
    expect(errors).toEqual([]);
  });

  it('trims a COVERED core holding back to target, and withholds that trim for an unmanaged one', async () => {
    const a: RunOrder[] = []; const b: RunOrder[] = [];
    await ensureCore(makeCtx(), SUB, 'paper', ACCOUNT, [pos('SPY', 100, 500)], core, a, []);
    expect(placed(a)).toEqual([['SPY', 'sell', 30]]);       // 50,000 held vs a 35,000 target
    await ensureCore(makeCtx(), SUB, 'paper', ACCOUNT, [unmanaged(pos('SPY', 100, 500))], core, b, []);
    expect(b).toEqual([]);
  });
});

describe('the rotation sleeve withholds every decision for an unmanaged holding', () => {
  beforeEach(() => {
    for (const [sym, drift] of [['TOPA', 0.004], ['TOPB', 0.003], ['DROP', -0.002], ['HAND', -0.003]] as Array<[string, number]>) {
      h.bars.set(sym, closes(drift));
      h.price[sym] = 100;
    }
  });

  it('rotates a COVERED name out when it drops off the leaderboard (unchanged behaviour)', async () => {
    const orders = await runRotation([pos('DROP', 10, 100), pos('HAND', 10, 100)]);
    expect(placed(orders)).toEqual([
      ['DROP', 'sell', 10], ['HAND', 'sell', 10], ['TOPA', 'buy', 30], ['TOPB', 'buy', 30],
    ]);
  }, 30_000);

  it('does NOT rotate an unmanaged name out — and every other name\'s order is byte-identical', async () => {
    const orders = await runRotation([pos('DROP', 10, 100), unmanaged(pos('HAND', 10, 100))]);
    expect(placed(orders)).toEqual([
      ['DROP', 'sell', 10], ['TOPA', 'buy', 30], ['TOPB', 'buy', 30],
    ]);
    expect(orders.some((o) => o.symbol === 'HAND')).toBe(false);
  }, 30_000);
});

describe('the rotation sleeve never adds to, or trims, an unmanaged holding', () => {
  beforeEach(() => {
    // HAND ranks FIRST, so in the cash-bound case it reaches the buy leg before TOPA does.
    for (const [sym, drift] of [['HAND', 0.004], ['TOPA', 0.003], ['TOPB', 0.002]] as Array<[string, number]>) {
      h.bars.set(sym, closes(drift));
      h.price[sym] = 100;
    }
  });

  it('trims a COVERED target back to its weight, and withholds that trim when it is unmanaged', async () => {
    // 100 shares x $100 = $10,000 against a $3,000 (3% of equity) target weight.
    expect(placed(await runRotation([pos('HAND', 100, 100)]))).toContainEqual(['HAND', 'sell', 70]);
    const withheld = await runRotation([unmanaged(pos('HAND', 100, 100))]);
    expect(withheld.some((o) => o.symbol === 'HAND')).toBe(false);
  }, 60_000);

  it('tops a COVERED target up toward its weight with the cash it has', async () => {
    h.cashAfterSettle = 2_000;   // binds: HAND wants $2,500 more and takes every dollar there is
    expect(placed(await runRotation([pos('HAND', 5, 100)]))).toEqual([['HAND', 'buy', 20]]);
  }, 30_000);

  it('withholds that top-up when it is unmanaged, and RESERVES the dollars rather than passing them on', async () => {
    h.cashAfterSettle = 2_000;
    const orders = await runRotation([unmanaged(pos('HAND', 5, 100))]);
    // Nothing for HAND, and — the whole point — nothing for TOPA either: the $2,000 the withheld buy
    // would have spent is reserved, so the next target sees exactly the cash it sees today. Recycling
    // it instead would hand TOPA 20 shares it never gets on the covered run.
    expect(orders).toEqual([]);
    expect(h.placeDecisionOrder).not.toHaveBeenCalled();
  }, 30_000);
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the ADR-052 addendum P6 idle-cash yield sleeve. Pure half: the one resolver (knob beats env; mode-aware arm; blank float = the pre-registered 5% as the compose file forwards it; 0 and junk are off), the fund symbol, the quiet-fire rebalance (park above the float plus the band, refill below it, hold inside it; unsettled proceeds count toward the float and are never parked) and the funding share count. Legs, driven for real with the venue, market data and the order rail doubled outside them and a pool double for the ledger reads (the trading-settlement-autopilot-clamp pattern, no database): resolveYieldSleeve (off = no read; core-symbol and unaccounted holdings disarm it; its own working order or a failed read idles it; a cash book's unsettled sleeve sales are counted), the scan leg's placeSleeveFunded and both rotation paths sell the sleeve BEFORE any buy and fund the buys from the re-read cash (no starved entry where the unfunded twin buys a fraction), a cash-type book never spends the sale's unsettled proceeds (capAccount's settled clamp), and the quiet-fire rebalance parks, refills or stays still.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { BrokerAccount, MarketDataSource, Position, TradingBook } from '../../src/features/trading';

const h = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {};
  const pin = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  for (const k of ['TRADING_YIELD_SLEEVE', 'TRADING_YIELD_SLEEVE_FLOAT_PCT', 'TRADING_YIELD_SLEEVE_SYMBOL', 'TRADING_SECTOR_TILT',
    'TRADING_SYMBOL_BLOCKLIST', 'TRADING_ROTATION_EVERY_DAYS', 'TRADING_ROTATION_EXT_HOURS', 'TRADING_CORE_TARGET_PCT',
    'TRADING_CAPITAL_CAP_USD', 'TRADING_CASH_SETTLEMENT_POLICY', 'TRADING_SETTLEMENT_DAYS']) pin(k, undefined);
  pin('TRADING_CORE_SYMBOLS', '');
  pin('TRADING_ROTATION_RANK', 'momentum');
  pin('TRADING_ROTATION_TOPN', '2');
  pin('TRADING_ROTATION_WEIGHTING', 'equal');
  pin('TRADING_ROTATION_MAX_GAP_DOWN_PCT', '0');
  return {
    saved,
    price: {} as Record<string, number>,
    bars: new Map<string, number[]>(),
    /** What the venue reports to every getAccount (the post-sale re-read and the rebalance read). */
    account: null as BrokerAccount | null,
    getAccount: vi.fn(),
    placeDecisionOrder: vi.fn(),
    /** Every order the rail placed, as [symbol, side, qty, reason] in placement order. */
    placed: [] as Array<[string, string, number, string | undefined]>,
    working: [] as Array<{ symbol: string; side: string; qty: number; filled_qty: number; px: number }>,
    unsettled: [] as Array<{ symbol: string; filled_qty: number; filled_avg_price: number; traded_at: string }>,
    failWorking: false,
    failUnsettled: false,
    queries: [] as string[],
  };
});

vi.mock('@/features/trading', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/trading')>();
  const source = {
    kind: 'schwab', configured: () => true,
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
      getAccount: h.getAccount,
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

import {
  RISK_POLICIES, yieldSleeveFloatPct, yieldSleeveSymbol, sleeveRebalancePlan, sleeveFundingQty,
  DEFAULT_YIELD_SLEEVE_FLOAT_PCT, DEFAULT_YIELD_SLEEVE_SYMBOL,
} from '../../src/features/trading';
import { capAccount, type RunOrder } from '../../src/app/trading-dispatch-rail';
import { rotateSleeve } from '../../src/app/trading-dispatch-rotation';
import {
  resolveYieldSleeve, placeSleeveFunded, rebalanceYieldSleeve, rotationDemand, rotationProceeds, sleevePositions,
  sleeveExemptSymbols, sleeveSpendable, SLEEVE_SETTLE_MS, type YieldSleeveControl,
} from '../../src/app/trading-dispatch-yield-sleeve';
import { legacyBook } from '../../src/app/trading-books-store';
import { normalizeConfig } from '../../src/app/trading-strategy-lab-sim';
import type { ConfigOverrideRow } from '../../src/app/trading-config-overrides';
import { composeEnvDefault } from '../helpers/compose-env-default';

const SUB = 'spec-yield-sleeve';
const POLICY = { ...RISK_POLICIES.active, maxPerNamePct: 50 };

/** A bound live CASH book (the IRA shape), the fleet default settlement policy. */
const cashBook = (over: Partial<TradingBook> = {}): TradingBook => ({
  bookId: '00000000-0000-4000-8000-00000000c0a2', ref: 'b-spec1cash', kind: 'live', broker: 'schwab',
  accountNumber: null, connectionKey: null, capitalCapUsd: null, learn: false, enabled: true,
  accountType: 'cash', settlementPolicy: null, ...over,
});
const paperBook = (): TradingBook => legacyBook(SUB, 'paper');

/** A venue snapshot; settledCash/unsettledCash are the venue's own figures (the Schwab shape). */
const venue = (equity: number, cash: number, settledCash?: number): BrokerAccount => ({
  equity, cash, buyingPower: cash, currency: 'USD',
  ...(settledCash === undefined ? {} : { accountType: 'cash' as const, settledCash, unsettledCash: cash - settledCash }),
});

const pos = (symbol: string, qty: number, last: number, extra: Partial<Position> = {}): Position => ({
  symbol, qty, avgEntryPrice: last, currentPrice: last, marketValue: qty * last, unrealizedPl: 0, ...extra,
});

/** A pool double: the rail's provenance INSERTs and the two ledger reads the sleeve makes. */
const makeCtx = () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      h.queries.push(sql);
      if (/FROM oshal_trading_orders[\s\S]*status = ANY/.test(sql) && /limit_price/.test(sql)) {
        if (h.failWorking) throw new Error('spec: working-order read failed');
        return { rows: h.working };
      }
      if (/side='sell' AND status IN \('filled','partially_filled'\)/.test(sql)) {
        if (h.failUnsettled) throw new Error('spec: unsettled read failed');
        return { rows: h.unsettled };
      }
      return { rows: [{ signal_id: 'sig-1', decision_id: 'dec-1' }] };
    }),
  },
} as never);

/** An armed control, as resolveYieldSleeve builds it. */
const control = (over: Partial<YieldSleeveControl> = {}): YieldSleeveControl => ({
  symbol: 'SGOV', floatPct: 5, heldQty: 100, heldValue: 10_000, idleReason: null, bookWorking: false, pendingProceeds: 0, soldQty: 0, ...over,
});

const override = (config: Record<string, unknown>): ConfigOverrideRow => ({
  id: 'ov-1', bookId: null, strategyId: null, strategyName: 'spec', config: normalizeConfig({ kind: 'ensemble', ...config }),
  applyPct: 100, active: true, note: '', createdAt: '', deactivatedAt: null,
});

/** Run an async leg to completion under fake timers (the 6 s settle waits). */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

const closes = (drift: number): number[] => Array.from({ length: 150 }, (_, i) => 100 * (1 + drift * i));

beforeEach(() => {
  vi.clearAllMocks();
  h.placed.length = 0; h.working.length = 0; h.unsettled.length = 0; h.queries.length = 0;
  h.failWorking = false; h.failUnsettled = false;
  h.placeDecisionOrder.mockImplementation(async (_pool: unknown, _sub: string, _book: unknown, _decisionId: string, requestId: string) => {
    const m = /-([A-Z.]+)-(buy|sell)$/.exec(requestId);
    h.placed.push([m ? m[1] : '?', m ? m[2] : '?', 0, undefined]);
    return { status: 'accepted', id: `ord-${h.placed.length}` };
  });
  h.getAccount.mockImplementation(async () => ({ ...(h.account as BrokerAccount) }));
  h.bars.clear();
  for (const k of Object.keys(h.price)) delete h.price[k];
  for (const [sym, drift] of [['TOPA', 0.004], ['TOPB', 0.003], ['DROP', -0.002]] as Array<[string, number]>) {
    h.bars.set(sym, closes(drift));
    h.price[sym] = 100;
  }
  h.price.SGOV = 100;
  delete process.env.TRADING_YIELD_SLEEVE; delete process.env.TRADING_YIELD_SLEEVE_FLOAT_PCT; delete process.env.TRADING_YIELD_SLEEVE_SYMBOL;
  process.env.TRADING_CORE_SYMBOLS = '';
});

afterEach(() => { vi.useRealTimers(); });

afterAll(() => {
  for (const [k, v] of Object.entries(h.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** The orders a leg pushed, as [symbol, side, qty, reason]. */
const plan = (orders: RunOrder[]): Array<[string, string, number, string | undefined]> => orders.map((o) => [o.symbol, o.side, o.qty, o.reason]);

describe('yieldSleeveFloatPct — the one resolver the dispatch and the Lab read', () => {
  it('a finite knob decides: 0 is off, a positive value is the float, clamped to 95; the env is not consulted', () => {
    process.env.TRADING_YIELD_SLEEVE = 'both';
    expect(yieldSleeveFloatPct(0, 'paper')).toBe(0);
    expect(yieldSleeveFloatPct(3, 'live')).toBe(3);
    expect(yieldSleeveFloatPct(400, 'paper')).toBe(95);
    expect(yieldSleeveFloatPct(Number.NaN, 'paper')).toBe(0);
  });

  it('an absent knob inherits the mode-aware arm; OFF when unset, and a Lab walk (mode null) is always off', () => {
    expect(yieldSleeveFloatPct(null, 'paper')).toBe(0);
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    expect(yieldSleeveFloatPct(undefined, 'paper')).toBe(DEFAULT_YIELD_SLEEVE_FLOAT_PCT);
    expect(yieldSleeveFloatPct(undefined, 'live'), 'a paper arm must not arm live').toBe(0);
    expect(yieldSleeveFloatPct(undefined, null)).toBe(0);
    process.env.TRADING_YIELD_SLEEVE = 'true';
    expect(yieldSleeveFloatPct(null, 'live')).toBe(DEFAULT_YIELD_SLEEVE_FLOAT_PCT);
  });

  it('the float value compose forwards for an unset .env is the pre-registered 5%, a deliberate 0 is off, junk is off', () => {
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    process.env.TRADING_YIELD_SLEEVE_FLOAT_PCT = composeEnvDefault('TRADING_YIELD_SLEEVE_FLOAT_PCT');
    expect(yieldSleeveFloatPct(null, 'paper')).toBe(5);
    process.env.TRADING_YIELD_SLEEVE_FLOAT_PCT = '0';
    expect(yieldSleeveFloatPct(null, 'paper')).toBe(0);
    process.env.TRADING_YIELD_SLEEVE_FLOAT_PCT = 'lots';
    expect(yieldSleeveFloatPct(null, 'paper')).toBe(0);
    process.env.TRADING_YIELD_SLEEVE_FLOAT_PCT = '12';
    expect(yieldSleeveFloatPct(null, 'paper')).toBe(12);
  });

  it('the fund: a well-formed TRADING_YIELD_SLEEVE_SYMBOL, else SGOV (blank as compose forwards it, or junk)', () => {
    process.env.TRADING_YIELD_SLEEVE_SYMBOL = composeEnvDefault('TRADING_YIELD_SLEEVE_SYMBOL');
    expect(yieldSleeveSymbol()).toBe(DEFAULT_YIELD_SLEEVE_SYMBOL);
    process.env.TRADING_YIELD_SLEEVE_SYMBOL = ' bil ';
    expect(yieldSleeveSymbol()).toBe('BIL');
    process.env.TRADING_YIELD_SLEEVE_SYMBOL = 'DROP TABLE';
    expect(yieldSleeveSymbol()).toBe('SGOV');
  });
});

describe('the sleeve math (pure)', () => {
  const book = { equity: 100_000, floatPct: 5, price: 100, heldQty: 300, pending: 0 };

  it('parks the spendable cash above the float once it clears the 1% band, and holds inside the band', () => {
    expect(sleeveRebalancePlan({ ...book, cash: 20_000 })).toEqual({ action: 'park', qty: 150 });
    expect(sleeveRebalancePlan({ ...book, cash: 5_900 })).toEqual({ action: 'hold', qty: 0 });
    expect(sleeveRebalancePlan({ ...book, cash: 4_100 })).toEqual({ action: 'hold', qty: 0 });
  });

  it('refills the float from the sleeve below the band, bounded by the shares held', () => {
    expect(sleeveRebalancePlan({ ...book, cash: 1_000 })).toEqual({ action: 'refill', qty: 40 });
    expect(sleeveRebalancePlan({ ...book, cash: 1_000, heldQty: 12 })).toEqual({ action: 'refill', qty: 12 });
    expect(sleeveRebalancePlan({ ...book, cash: 1_000, heldQty: 0 })).toEqual({ action: 'hold', qty: 0 });
  });

  it('unsettled sleeve proceeds count toward the float (no second sale) but are never parked', () => {
    expect(sleeveRebalancePlan({ ...book, cash: 1_000, pending: 4_000 })).toEqual({ action: 'hold', qty: 0 });
    expect(sleeveRebalancePlan({ ...book, cash: 5_000, pending: 30_000 }), 'only spendable cash above the float may buy the fund').toEqual({ action: 'hold', qty: 0 });
    expect(sleeveRebalancePlan({ ...book, cash: 8_000, pending: 30_000 })).toEqual({ action: 'park', qty: 30 });
  });

  it('holds on a missing price, equity or float', () => {
    expect(sleeveRebalancePlan({ ...book, cash: 20_000, price: 0 }).action).toBe('hold');
    expect(sleeveRebalancePlan({ ...book, cash: 20_000, equity: 0 }).action).toBe('hold');
    expect(sleeveRebalancePlan({ ...book, cash: 20_000, floatPct: 0 }).action).toBe('hold');
  });

  it('a funding sale rounds UP to whole shares and never sells more than is held', () => {
    expect(sleeveFundingQty(1_001, 100, 50)).toBe(11);
    expect(sleeveFundingQty(1_000_000, 100, 50)).toBe(50);
    expect(sleeveFundingQty(0, 100, 50)).toBe(0);
    expect(sleeveFundingQty(500, 100, 0)).toBe(0);
  });

  it('rotationDemand walks the buy loop (slots, dust, withheld names); rotationProceeds adds the trims to the drop-outs', () => {
    const goals: Record<string, number> = { A: 6_000, B: 6_000, C: 6_000, H: 1_000 };
    const need = {
      targets: ['A', 'B', 'C', 'H'], goalOf: (s: string) => goals[s], heldNow: new Map([['B', 2_000], ['H', 3_000]]),
      dust: 60, open: 1, maxPositions: 2, soldValue: 4_000, skip: new Set<string>(),
    };
    // Cap 2: A takes the last slot (6000) and the loop breaks at the top of the next target, as the buy loop does.
    expect(rotationDemand(need)).toBe(6_000);
    // Cap 3: A (6000, a slot), B held (4000 more, no slot), C (6000, the last slot); H is over its goal.
    expect(rotationDemand({ ...need, maxPositions: 3 })).toBe(16_000);
    // A withheld holding still counts: the buy loop RESERVES its dollars, so the later targets need them covered.
    expect(rotationDemand({ ...need, maxPositions: 3, skip: new Set(['B']) })).toBe(16_000);
    expect(rotationProceeds(need)).toBe(6_000); // 4000 dropped out + H trimmed 2000
    expect(rotationProceeds({ ...need, skip: new Set(['H']) }), 'a withheld holding is never trimmed').toBe(4_000);
  });

  it('the exemption: the armed sleeve leaves every leg view and joins the core set; off, the same array and nothing added', () => {
    const book0 = [pos('SGOV', 100, 100), pos('AAPL', 10, 200)];
    expect(sleevePositions(book0, null)).toBe(book0);
    expect(sleeveExemptSymbols(null)).toEqual([]);
    expect(sleevePositions(book0, control()).map((p) => p.symbol)).toEqual(['AAPL']);
    expect(sleeveExemptSymbols(control())).toEqual(['SGOV']);
    expect(sleeveSpendable(control({ soldQty: 40 }))).toBe(6_000);
    expect(sleeveSpendable(control({ idleReason: 'working' }))).toBe(0);
  });
});

describe('resolveYieldSleeve', () => {
  const positions = [pos('SGOV', 100, 100), pos('AAPL', 10, 200)];

  it('OFF: null and no ledger read at all', async () => {
    const ctx = makeCtx() as { pool: { query: ReturnType<typeof vi.fn> } };
    expect(await resolveYieldSleeve(ctx.pool as never, SUB, paperBook(), null, positions)).toBeNull();
    expect(ctx.pool.query).not.toHaveBeenCalled();
  });

  it('armed on paper: the held fund, its value and an active control; the live book is not armed by a paper arm', async () => {
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    const ctx = makeCtx() as { pool: never };
    expect(await resolveYieldSleeve(ctx.pool, SUB, paperBook(), null, positions)).toMatchObject({
      symbol: 'SGOV', floatPct: 5, heldQty: 100, heldValue: 10_000, idleReason: null, bookWorking: false, pendingProceeds: 0, soldQty: 0,
    });
    expect(await resolveYieldSleeve(ctx.pool, SUB, legacyBook(SUB, 'live'), null, positions)).toBeNull();
  });

  it('an applied strategy knob arms it with the env off, and its explicit 0 disarms an env-armed book', async () => {
    const ctx = makeCtx() as { pool: never };
    expect(await resolveYieldSleeve(ctx.pool, SUB, paperBook(), override({ yieldSleeveFloatPct: 8 }), positions)).toMatchObject({ floatPct: 8 });
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    expect(await resolveYieldSleeve(ctx.pool, SUB, paperBook(), override({ yieldSleeveFloatPct: 0 }), positions)).toBeNull();
  });

  it('disarmed when the fund is a beta-core symbol, or when the engine cannot account for the held fund (ADR-159)', async () => {
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    const ctx = makeCtx() as { pool: never };
    process.env.TRADING_CORE_SYMBOLS = 'SPY:30,SGOV:10';
    expect(await resolveYieldSleeve(ctx.pool, SUB, paperBook(), null, positions)).toBeNull();
    process.env.TRADING_CORE_SYMBOLS = '';
    expect(await resolveYieldSleeve(ctx.pool, SUB, paperBook(), null, [pos('SGOV', 100, 100, { unmanaged: true })])).toBeNull();
  });

  it('idle while its own order works or a ledger read fails; another name working only holds the quiet-fire rebalance', async () => {
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    const ctx = makeCtx() as { pool: never };
    h.working.push({ symbol: 'SGOV', side: 'sell', qty: 10, filled_qty: 0, px: 0 });
    expect((await resolveYieldSleeve(ctx.pool, SUB, paperBook(), null, positions))?.idleReason).toContain('SGOV order is still working');
    h.working.length = 0;
    h.working.push({ symbol: 'AAPL', side: 'buy', qty: 1, filled_qty: 0, px: 0 });
    expect(await resolveYieldSleeve(ctx.pool, SUB, paperBook(), null, positions)).toMatchObject({ idleReason: null, bookWorking: true });
    h.failWorking = true;
    expect((await resolveYieldSleeve(ctx.pool, SUB, paperBook(), null, positions))?.idleReason).toContain('could not be read');
  });

  it('a cash-type book counts its own unsettled SLEEVE sales (other names ignored); a failed read idles it', async () => {
    process.env.TRADING_YIELD_SLEEVE = 'live';
    const ctx = makeCtx() as { pool: never };
    const now = new Date().toISOString();
    h.unsettled.push({ symbol: 'SGOV', filled_qty: 30, filled_avg_price: 100, traded_at: now }, { symbol: 'AAPL', filled_qty: 5, filled_avg_price: 200, traded_at: now });
    expect(await resolveYieldSleeve(ctx.pool, SUB, cashBook(), null, positions)).toMatchObject({ pendingProceeds: 3_000, idleReason: null });
    h.failUnsettled = true;
    expect((await resolveYieldSleeve(ctx.pool, SUB, cashBook(), null, positions))?.idleReason).toContain('unsettled-sales ledger');
  });
});

describe('sell FIRST, then buy — the scan leg (placeSleeveFunded)', () => {
  const buys = () => [
    { decision: { symbol: 'TOPA', action: 'buy' as const, side: 'buy' as const, qty: 20, confidence: 0.7, rationale: 'spec', indicators: {}, price: 50, source: 'mtf-autopilot' }, price: 50 },
    { decision: { symbol: 'TOPB', action: 'buy' as const, side: 'buy' as const, qty: 50, confidence: 0.5, rationale: 'spec', indicators: {}, price: 20, source: 'mtf-autopilot' }, price: 20 },
  ];

  it('margin book: sells the shortfall of the fund before any buy, waits, re-reads, and funds every entry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const orders: RunOrder[] = []; const errors: Array<{ symbol: string; error: string }> = [];
    h.account = venue(100_000, 2_000); // the fill landed: $1,000 on hand + the $1,000 sale
    const c = control();
    await settle(placeSleeveFunded(makeCtx(), SUB, paperBook(), venue(100_000, 1_000), buys(), c, orders, errors, null));
    expect(errors).toEqual([]);
    expect(plan(orders)).toEqual([['SGOV', 'sell', 10, 'yield-sleeve-fund'], ['TOPA', 'buy', 20, undefined], ['TOPB', 'buy', 50, undefined]]);
    expect(h.placed.map(([s, side]) => `${s}-${side}`)).toEqual(['SGOV-sell', 'TOPA-buy', 'TOPB-buy']);
    expect(c.soldQty).toBe(10);
    expect(h.getAccount).toHaveBeenCalledTimes(1);
  });

  it('cash-type book: the re-read is clamped to settled cash, so the sale\'s unsettled proceeds buy nothing today', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const orders: RunOrder[] = []; const errors: Array<{ symbol: string; error: string }> = [];
    h.account = venue(100_000, 2_000, 1_000); // $1,000 of the re-read cash is the unsettled sale
    await settle(placeSleeveFunded(makeCtx(), SUB, cashBook(), capAccount(venue(100_000, 1_000, 1_000), cashBook()), buys(), control(), orders, errors, null));
    expect(plan(orders)).toEqual([['SGOV', 'sell', 10, 'yield-sleeve-fund'], ['TOPA', 'buy', 20, undefined]]);
  });

  it('unsettled sleeve proceeds already on their way are not sold for again', async () => {
    const orders: RunOrder[] = [];
    await placeSleeveFunded(makeCtx(), SUB, cashBook(), venue(100_000, 1_000, 1_000), buys(), control({ pendingProceeds: 5_000 }), orders, [], null);
    expect(plan(orders)).toEqual([['TOPA', 'buy', 20, undefined]]);
    expect(h.getAccount).not.toHaveBeenCalled();
  });

  it('no shortfall: no sale, no wait, the entries go in as sized; a failed re-read spends only the cash on hand', async () => {
    const orders: RunOrder[] = [];
    await placeSleeveFunded(makeCtx(), SUB, paperBook(), venue(100_000, 5_000), buys(), control(), orders, [], null);
    expect(plan(orders)).toEqual([['TOPA', 'buy', 20, undefined], ['TOPB', 'buy', 50, undefined]]);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    h.getAccount.mockRejectedValueOnce(new Error('venue down'));
    const clipped: RunOrder[] = [];
    await settle(placeSleeveFunded(makeCtx(), SUB, paperBook(), venue(100_000, 1_000), buys(), control(), clipped, [], null));
    expect(plan(clipped)).toEqual([['SGOV', 'sell', 10, 'yield-sleeve-fund'], ['TOPA', 'buy', 20, undefined]]);
  });

  it('the settle wait is the rotation\'s own', () => { expect(SLEEVE_SETTLE_MS).toBe(6000); });
});

describe('sell FIRST, then buy — the rotation (rotateSleeve with an armed sleeve)', () => {
  // $12,000 book: $2,000 cash and the fund's $10,000. Two leaders want $6,000 each (50% per name).
  const rotate = async (book: TradingBook, before: BrokerAccount, afterSale: BrokerAccount, sleeve: YieldSleeveControl | null): Promise<RunOrder[]> => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    h.account = afterSale;
    const orders: RunOrder[] = []; const errors: Array<{ symbol: string; error: string }> = [];
    await settle(rotateSleeve(makeCtx(), SUB, book, capAccount(before, book), [], POLICY, new Set(['SGOV']), [...h.bars.keys()], orders, errors,
      null, new Set(), new Set(), sleeve ? { marketGap: null, plans: null, yieldSleeve: sleeve } : null));
    expect(errors).toEqual([]);
    return orders;
  };

  it('margin book: the fund is sold before the settle wait, and the re-read cash funds both leaders in full', async () => {
    const orders = await rotate(paperBook(), venue(12_000, 2_000), venue(12_000, 12_000), control());
    expect(plan(orders)).toEqual([['SGOV', 'sell', 100, 'yield-sleeve-fund'], ['TOPA', 'buy', 60, 'rotation'], ['TOPB', 'buy', 60, 'rotation']]);
  });

  it('no starved entries: the unfunded twin (sleeve off) buys only what the $2,000 on hand covers', async () => {
    const orders = await rotate(paperBook(), venue(12_000, 2_000), venue(12_000, 2_000), null);
    expect(plan(orders)).toEqual([['TOPA', 'buy', 20, 'rotation']]);
  });

  it('cash-type book: the fund is still sold first, but the buys spend only settled cash', async () => {
    const orders = await rotate(cashBook(), venue(12_000, 2_000, 2_000), venue(12_000, 12_000, 2_000), control());
    expect(plan(orders)).toEqual([['SGOV', 'sell', 100, 'yield-sleeve-fund'], ['TOPA', 'buy', 20, 'rotation']]);
  });

  it('an idle sleeve (its own order still working) sells nothing', async () => {
    const orders = await rotate(paperBook(), venue(12_000, 2_000), venue(12_000, 2_000), control({ idleReason: 'a SGOV order is still working at the venue' }));
    expect(plan(orders)).toEqual([['TOPA', 'buy', 20, 'rotation']]);
  });
});

describe('the quiet-fire rebalance (rebalanceYieldSleeve)', () => {
  const run = async (c: YieldSleeveControl | null, account: BrokerAccount, opts: { orders?: RunOrder[]; extHours?: boolean; book?: TradingBook } = {}): Promise<RunOrder[]> => {
    h.account = account;
    const orders = opts.orders ?? [];
    await rebalanceYieldSleeve(makeCtx(), SUB, opts.book ?? paperBook(), c, orders, [], opts.extHours ?? false);
    return orders;
  };

  it('parks the cash above the float, and refills the float from the fund', async () => {
    expect(plan(await run(control(), venue(100_000, 20_000)))).toEqual([['SGOV', 'buy', 150, 'yield-sleeve-park']]);
    expect(plan(await run(control(), venue(100_000, 1_000)))).toEqual([['SGOV', 'sell', 40, 'yield-sleeve-refill']]);
    expect(plan(await run(control(), venue(100_000, 5_500)))).toEqual([]);
  });

  it('does nothing unless the fire is quiet: any order this fire, a working order, off-hours, a disabled book, a funding sale, an idle sleeve, or off', async () => {
    const traded: RunOrder[] = [{ symbol: 'LOSR', side: 'sell', qty: 50, status: 'accepted', id: 'x', reason: 'stop_loss' }];
    expect(plan(await run(control(), venue(100_000, 20_000), { orders: traded }))).toEqual([['LOSR', 'sell', 50, 'stop_loss']]);
    for (const c of [control({ bookWorking: true }), control({ soldQty: 3 }), control({ idleReason: 'x' })]) {
      expect(plan(await run(c, venue(100_000, 20_000)))).toEqual([]);
    }
    expect(plan(await run(control(), venue(100_000, 20_000), { extHours: true }))).toEqual([]);
    expect(plan(await run(control(), venue(100_000, 20_000), { book: { ...paperBook(), enabled: false } }))).toEqual([]);
    expect(plan(await run(null, venue(100_000, 20_000)))).toEqual([]);
    expect(h.getAccount).not.toHaveBeenCalled();
  });

  it('cash-type book: parks settled cash only, and does not sell again while earlier sale proceeds are settling', async () => {
    expect(plan(await run(control(), venue(100_000, 30_000, 20_000), { book: cashBook() }))).toEqual([['SGOV', 'buy', 150, 'yield-sleeve-park']]);
    expect(plan(await run(control({ pendingProceeds: 4_000 }), venue(100_000, 1_000, 1_000), { book: cashBook() }))).toEqual([]);
  });
});

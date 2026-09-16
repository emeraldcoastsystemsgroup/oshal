/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-134 D8 tail: the autopilot sizes a CASH book against SETTLED cash. Drives the REAL rotateSleeve, capAccount and settledBuyingPower with the venue (getBrokerAdapter), market data and the order rail (placeDecisionOrder) doubled outside them and a pool double for the provenance INSERTs — the trading-unmanaged-entry-paths pattern, no database. Pins: (1) a rotation's post-sell re-read on a cash book sizes its buys against settled cash only, never against the sale's own unsettled proceeds; (2) the same venue figures on the legacy live book, which the venue reports as MARGIN, size against the whole cash balance exactly as before; (3) on a CAPPED cash book the clamp runs on the capped snapshot, so the cap headroom a rotation sale frees is still deployed from settled cash — clamping BEFORE the cap counts the unsettled proceeds as positions and loses that headroom; plus capAccount's pure composition (settled cash binds under a cap, equity never moves, typeless paper and policy 'off' are untouched).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { BrokerAccount, MarketDataSource, Position, TradingBook } from '../../src/features/trading';

const h = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {};
  const pin = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  // The operator box arms several of these; the spec must not inherit the shell. The settlement
  // policy is cleared so the fleet default ('refuse') is what runs — an inherited 'off' would disarm
  // the very clamp under test.
  for (const k of ['TRADING_SECTOR_TILT', 'TRADING_SYMBOL_BLOCKLIST', 'TRADING_ROTATION_EVERY_DAYS',
    'TRADING_ROTATION_EXT_HOURS', 'TRADING_CORE_TARGET_PCT', 'TRADING_CAPITAL_CAP_USD',
    'TRADING_CASH_SETTLEMENT_POLICY', 'TRADING_SETTLEMENT_DAYS']) pin(k, undefined);
  pin('TRADING_CORE_SYMBOLS', '');                 // rotation owns 100% of the book here
  pin('TRADING_ROTATION_RANK', 'momentum');        // a deterministic ranker over the fixture closes
  pin('TRADING_ROTATION_TOPN', '2');
  pin('TRADING_ROTATION_WEIGHTING', 'equal');
  pin('TRADING_ROTATION_MAX_GAP_DOWN_PCT', '0');   // gap guard OFF: it is not what is under test
  return {
    saved,
    /** UPPERCASE symbol -> price, used by BOTH the sizing source and the fixtures. */
    price: {} as Record<string, number>,
    /** UPPERCASE symbol -> 150 daily closes for the momentum ranker. */
    bars: new Map<string, number[]>(),
    /** What the venue reports AFTER rotation's settle wait — the post-sell re-read under test. */
    afterSell: null as BrokerAccount | null,
    getAccount: vi.fn(),
    placeDecisionOrder: vi.fn(),
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
      mode: () => 'live', configured: () => true,
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

import { RISK_POLICIES } from '../../src/features/trading';
import { capAccount, type RunOrder } from '../../src/app/trading-dispatch-rail';
import { rotateSleeve } from '../../src/app/trading-dispatch-rotation';
import { legacyBook } from '../../src/app/trading-books-store';

const SUB = 'spec-settlement-autopilot-clamp';
/** Half the sleeve per name, so two leaders can each want more than the settled cash on hand. */
const POLICY = { ...RISK_POLICIES.active, maxPerNamePct: 50 };

/** A bound live CASH book (the IRA shape): the type rides the book, the policy is the fleet default. */
const cashBook = (over: Partial<TradingBook> = {}): TradingBook => ({
  bookId: '00000000-0000-4000-8000-00000000c0a1', ref: 'b-spec0cash', kind: 'live', broker: 'schwab',
  accountNumber: null, connectionKey: null, capitalCapUsd: null, learn: false, enabled: true,
  accountType: 'cash', settlementPolicy: null, ...over,
});

/** A venue snapshot. settledCash/unsettledCash are the venue's own figures (the Schwab adapter's shape). */
const venue = (equity: number, cash: number, settledCash: number, accountType: 'cash' | 'margin' = 'cash'): BrokerAccount => ({
  equity, cash, buyingPower: cash, currency: 'USD', accountType, settledCash, unsettledCash: cash - settledCash,
});

/** Minimal AppContext: placeManaged -> persistDecision only needs pool.query to return id rows. */
const makeCtx = () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [{ signal_id: 'sig-1', decision_id: 'dec-1' }] }) } } as never);

const pos = (symbol: string, qty: number, last: number): Position => ({
  symbol, qty, avgEntryPrice: last, currentPrice: last, marketValue: qty * last, unrealizedPl: 0,
});

/** 150 closes with a constant per-bar drift; a positive drift gives a positive 20-day return. */
const closes = (drift: number): number[] => Array.from({ length: 150 }, (_, i) => 100 * (1 + drift * i));

/** Every order placeManaged pushed, as [symbol, side, qty]. */
const placed = (orders: RunOrder[]): Array<[string, string, number]> => orders.map((o) => [o.symbol, o.side, o.qty]);

/**
 * One rotation fire exactly as the dispatcher runs it: the opening snapshot goes through capAccount
 * (trading-schedule-dispatch.ts), the sells are placed, and the venue then reports `afterSell` to
 * the rotation's own post-sell re-read.
 */
async function rotate(book: TradingBook, before: BrokerAccount, afterSell: BrokerAccount, positions: Position[]): Promise<RunOrder[]> {
  h.afterSell = afterSell;
  const orders: RunOrder[] = [];
  const errors: Array<{ symbol: string; error: string }> = [];
  await rotateSleeve(makeCtx(), SUB, book, capAccount(before, book), positions, POLICY, new Set(), [...h.bars.keys()], orders, errors);
  expect(errors).toEqual([]);
  expect(h.getAccount).toHaveBeenCalledTimes(1); // the post-sell re-read happened, and only once
  return orders;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.placeDecisionOrder.mockResolvedValue({ status: 'accepted', id: 'ord-1' });
  h.getAccount.mockImplementation(async () => ({ ...(h.afterSell as BrokerAccount) }));
  h.bars.clear();
  for (const k of Object.keys(h.price)) delete h.price[k];
  // TOPA and TOPB lead the momentum board; DROP has fallen off it and is sold by the rotation.
  for (const [sym, drift] of [['TOPA', 0.004], ['TOPB', 0.003], ['DROP', -0.002]] as Array<[string, number]>) {
    h.bars.set(sym, closes(drift));
    h.price[sym] = 100;
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(h.saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('a rotation\'s post-sell re-read on a CASH book sizes against settled cash only', () => {
  // $12,000 book: DROP (100 x $100) is sold, so the re-read shows $12,000 cash of which the $10,000
  // sale proceeds are unsettled. Each leader wants $6,000 (50% per name, two names).
  const before = venue(12_000, 2_000, 2_000);
  const afterSell = venue(12_000, 12_000, 2_000);

  it('spends the $2,000 that is settled — the sale\'s own unsettled proceeds are never sized into a buy', async () => {
    const orders = await rotate(cashBook(), before, afterSell, [pos('DROP', 100, 100)]);
    // Unclamped, the re-read's $12,000 funds TOPA 60 + TOPB 60, and the engine then refuses both
    // buys (422 settlement_blocked) instead of the autopilot sizing them down.
    expect(placed(orders)).toEqual([['DROP', 'sell', 100], ['TOPA', 'buy', 20]]);
  }, 30_000);

  it('the same figures on the legacy live book (the venue reports MARGIN) size against the whole cash balance, as before', async () => {
    const orders = await rotate(legacyBook(SUB, 'live'), venue(12_000, 2_000, 2_000, 'margin'), venue(12_000, 12_000, 2_000, 'margin'), [pos('DROP', 100, 100)]);
    expect(placed(orders)).toEqual([['DROP', 'sell', 100], ['TOPA', 'buy', 60], ['TOPB', 'buy', 60]]);
  }, 30_000);
});

describe('on a CAPPED cash book the clamp runs on the capped snapshot', () => {
  it('deploys the cap headroom the rotation sale freed, from settled cash', async () => {
    // $100,000 account under a $10,000 book cap: DROP (50 x $100 = $5,000) fills half the cap. After
    // the sale nothing is held, so the cap allows $10,000 of buys — and $95,000 is settled, so all of
    // it can be spent. Clamping before the cap would read the $5,000 unsettled proceeds as a position
    // (equity - settled cash) and fund TOPA alone.
    const book = cashBook({ capitalCapUsd: 10_000 });
    const orders = await rotate(book, venue(100_000, 95_000, 95_000), venue(100_000, 100_000, 95_000), [pos('DROP', 50, 100)]);
    expect(placed(orders)).toEqual([['DROP', 'sell', 50], ['TOPA', 'buy', 50], ['TOPB', 'buy', 50]]);
  }, 30_000);
});

describe('capAccount — the capital cap, then the settled-cash clamp', () => {
  it('under a cap, settled cash still binds, and the cap headroom is measured from TOTAL cash', () => {
    // Cap $10,000; nothing held; $4,000 settled of $100,000 cash. Cap headroom is $10,000, settled is
    // $4,000 → $4,000. (Clamp-first reads $96,000 of unsettled cash as positions → $0.)
    const capped = capAccount(venue(100_000, 100_000, 4_000), cashBook({ capitalCapUsd: 10_000 }));
    expect(capped).toMatchObject({ equity: 10_000, cash: 4_000, buyingPower: 4_000 });
  });

  it('an uncapped cash book keeps its equity and is clamped to the venue\'s settled figure', () => {
    expect(capAccount(venue(12_000, 12_000, 2_000), cashBook())).toMatchObject({ equity: 12_000, cash: 2_000, buyingPower: 2_000 });
  });

  it('a typeless paper book and policy \'off\' come back unclamped', () => {
    const acct = venue(12_000, 12_000, 2_000);
    expect(capAccount(acct, legacyBook(SUB, 'paper'))).toEqual(acct);
    process.env.TRADING_CASH_SETTLEMENT_POLICY = 'off';
    try {
      expect(capAccount(acct, cashBook())).toEqual(acct);
    } finally {
      delete process.env.TRADING_CASH_SETTLEMENT_POLICY;
    }
  });
});

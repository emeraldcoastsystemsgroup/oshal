/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the ADR-052 addendum P6 idle-cash yield sleeve driven through REAL dispatchTradingSchedule fires against a PostgreSQL this file owns (the parity-fire harness: venue adapter, market data, scan and placeDecisionOrder doubled OUTSIDE the ledger boundary; placeOrder throws; every placed order "fills" into the venue's cash so the post-sale re-read is a real re-read). Armed on paper, a scan fire whose cash sits below the float sells the fund FIRST (source yield-sleeve, reason yield-sleeve-fund) and then places the entries at full size, where the unarmed twin buys the fraction its cash covers; the fund is never stopped out although it sits past the stop, is never scanned, and takes no slot; the decision ledger records the sale before the buys it funded, and the Test Lab sleeve readback reads exactly that back from the same database. A rotation fire sells the fund before its settle wait and never drops it out. A quiet fire parks the cash above the float. While the fund's own order works, the sleeve sells nothing and the fund stays exempt.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import type { AppContext } from '../../src/app/composition/app-context';
import type { MtfDecision, Position, DatedClose, MarketDataSource, TimeframeView } from '../../src/features/trading';

/* ── env pins (hoisted: the dispatch module reads several TRADING_* values at IMPORT time) ───────── */
const h = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {};
  const pin = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  for (const k of [
    'TRADING_SECTOR_TILT', 'TRADING_ROTATION_MAX_GAP_DOWN_PCT', 'TRADING_POP_CATCHER', 'TRADING_EARNINGS_GATE',
    'TRADING_WORLD_RANK', 'TRADING_EXTENDED_HOURS', 'TRADING_CAPITAL_CAP_USD', 'TRADING_SYMBOL_BLOCKLIST',
    'TRADING_ROTATION_RANK', 'TRADING_ROTATION_TOPN', 'TRADING_ROTATION_WEIGHTING', 'TRADING_ROTATION_EVERY_DAYS',
    'TRADING_ROTATION_EXT_HOURS', 'TRADING_MULTI_ACCOUNT', 'TRADING_MAX_ORDERS_PER_RUN', 'TRADING_EXT_ENTRIES',
    'TRADING_BASELINE_VOL_PCT', 'ENABLE_WORLD_INTELLIGENCE', 'TRADING_TAKE_PROFIT_PCT', 'TRADING_SLEEVE_ROTATION',
    'TRADING_WORLD_SENTIMENT_CLEAN', 'TRADING_EARNINGS_BLACKOUT_DAYS', 'TRADING_WORLD_RANK_WEIGHT', 'TRADING_CORE_TARGET_PCT',
    'TRADING_RISK_POSTURE_LIVE', 'TRADING_LIVE_ENABLED', 'TRADING_AUTOPILOT_LIVE', 'TRADING_HALT',
    'TRADING_MARKET_GAP_FILTER', 'TRADING_MARKET_GAP_PCT', 'TRADING_EXIT_PLANS', 'TRADING_EXIT_PLAN_SESSIONS',
    'TRADING_YIELD_SLEEVE', 'TRADING_YIELD_SLEEVE_FLOAT_PCT', 'TRADING_YIELD_SLEEVE_SYMBOL',
    'TRADING_CASH_SETTLEMENT_POLICY', 'TRADING_SETTLEMENT_DAYS',
  ]) pin(k, undefined);
  pin('TRADING_MAX_NOTIONAL_USD', '50000');
  pin('TRADING_MAX_QTY', '100000');
  pin('TRADING_CORE_SYMBOLS', 'SPY:35');
  pin('TRADING_RISK_POSTURE', 'balanced');
  pin('SESSION_SECRET', process.env.SESSION_SECRET || `spec-secret-${require('crypto').randomUUID()}`);

  /** Last close == the quoted price; strong names ramp UP into it, weak names fall INTO it. */
  const PRICE: Record<string, number> = { SPY: 500, LOSR: 88, BRKD: 102, SELL: 52, COLD: 101, HOTA: 50, HOTB: 20, INFL: 30, FLIP: 90, SGOV: 100 };
  const STRONG = new Set(['HOTA', 'HOTB', 'INFL', 'SGOV']);
  const closesOf = (sym: string): number[] => {
    const p = PRICE[sym]; if (!p) return [];
    const out: number[] = [];
    for (let i = 0; i < 150; i++) out.push(Number((STRONG.has(sym) ? p * (1 + 0.004 * (i - 149)) : p * (1 - 0.003 * (i - 149))).toFixed(4)));
    return out;
  };
  const tf = (timeframe: string, action: 'buy' | 'sell' | 'hold', score: number): TimeframeView =>
    ({ timeframe: timeframe as TimeframeView['timeframe'], weight: 1, action, score, confidence: Math.abs(score), bars: 60 });
  const mtf = (symbol: string, action: 'buy' | 'sell' | 'hold', score: number, confidence: number, per: TimeframeView[]): MtfDecision =>
    ({ symbol, price: PRICE[symbol], action, side: action === 'hold' ? null : action, score, confidence, regime: 0.3, perTimeframe: per, rationale: `fixture ${symbol} ${action}` });
  const SCAN: MtfDecision[] = [
    mtf('LOSR', 'hold', -0.1, 0.2, [tf('5Min', 'hold', -0.1), tf('1Hour', 'hold', -0.1), tf('1Day', 'hold', -0.1)]),
    mtf('BRKD', 'hold', -0.5, 0.6, [tf('5Min', 'sell', -0.6), tf('1Hour', 'sell', -0.5), tf('1Day', 'hold', 0.1)]),
    mtf('SELL', 'sell', -0.4, 0.5, [tf('5Min', 'sell', -0.2), tf('1Hour', 'hold', 0), tf('1Day', 'sell', -0.5)]),
    mtf('COLD', 'hold', 0.05, 0.2, [tf('5Min', 'hold', 0.05), tf('1Hour', 'hold', 0.05), tf('1Day', 'hold', 0.05)]),
    mtf('HOTA', 'buy', 0.6, 0.7, [tf('5Min', 'buy', 0.3), tf('1Hour', 'buy', 0.6), tf('1Day', 'buy', 0.7)]),
    mtf('HOTB', 'buy', 0.45, 0.5, [tf('5Min', 'buy', 0.2), tf('1Hour', 'buy', 0.4), tf('1Day', 'buy', 0.5)]),
    mtf('INFL', 'buy', 0.5, 0.6, [tf('5Min', 'buy', 0.2), tf('1Hour', 'buy', 0.5), tf('1Day', 'buy', 0.6)]),
    mtf('FLIP', 'hold', 0.25, 0.3, [tf('5Min', 'hold', 0.25), tf('1Hour', 'hold', 0.25), tf('1Day', 'hold', 0.25)]),
    // The fund signals a buy too: armed, it must never reach the scan at all.
    mtf('SGOV', 'buy', 0.7, 0.8, [tf('5Min', 'buy', 0.3), tf('1Hour', 'buy', 0.6), tf('1Day', 'buy', 0.7)]),
  ];
  const pos = (symbol: string, qty: number, avgEntryPrice: number): Position => {
    const currentPrice = PRICE[symbol];
    return { symbol, qty, avgEntryPrice, marketValue: qty * currentPrice, unrealizedPl: qty * (currentPrice - avgEntryPrice), currentPrice };
  };
  /** The book: the fund sits 16.7% under its cost, far past the balanced 9% stop, and cash is below the 5% float. */
  const BOOK: Position[] = [
    pos('SPY', 40, 480), pos('LOSR', 50, 100), pos('BRKD', 30, 100), pos('SELL', 20, 50), pos('COLD', 10, 100), pos('SGOV', 150, 120),
  ];
  const venue = { positions: BOOK as Position[], cash: 1_000, equity: 100_000 };
  const rec = { orders: [] as Array<{ decisionId: string; requestId: string }>, scanned: [] as string[] };
  const broker = {
    mode: () => 'paper', configured: () => true,
    getPositions: async () => venue.positions.map((p) => ({ ...p })),
    getAccount: async () => ({ cash: venue.cash, buyingPower: venue.cash, equity: venue.equity, currency: 'USD' }),
    cancelOrder: async () => undefined,
    placeOrder: async () => { throw new Error('yield-sleeve spec: every order must route through placeDecisionOrder (recorded)'); },
    getOrder: async () => { throw new Error('yield-sleeve spec: getOrder not expected'); },
    listOrders: async () => [],
  };
  const source: MarketDataSource = {
    kind: 'alpaca', configured: () => true,
    latestPrice: async (s: string) => PRICE[s.toUpperCase()] ?? null,
    latestTrade: async () => null,
    dailyCloses: async (s: string, n = 60) => closesOf(s.toUpperCase()).slice(-n),
    closesForTimeframe: async (s: string, _t: unknown, n = 60) => closesOf(s.toUpperCase()).slice(-n),
    barsBatch: async (syms: string[]) => new Map(syms.map((s) => [s.toUpperCase(), closesOf(s.toUpperCase())])),
  };
  return { saved, PRICE, SCAN, BOOK, pos, venue, closesOf, rec, broker, source };
});

vi.mock('@/features/trading', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/trading')>();
  const dated = (sym: string): DatedClose[] => {
    const closes = h.closesOf(sym);
    const today = actual.etSessionDate();
    return closes.map((c, i) => {
      const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - (closes.length - i));
      return { d: d.toISOString().slice(0, 10), c };
    });
  };
  return {
    ...actual,
    getBrokerAdapter: () => h.broker,
    getBrokerReader: () => h.broker,
    marketDataConfigured: () => true,
    tradableSessionDetailed: async () => ({ session: 'regular', reason: 'ok', blind: false }),
    multiTimeframeScan: async (symbols: string[]) => {
      h.rec.scanned = symbols.map((s) => s.toUpperCase());
      const want = new Set(h.rec.scanned);
      return new Map(h.SCAN.filter((d) => want.has(d.symbol)).map((d) => [d.symbol, { ...d, perTimeframe: d.perTimeframe.map((v) => ({ ...v })) }]));
    },
    barsBatch: async (symbols: string[]) => new Map(symbols.map((s) => [s.toUpperCase(), h.closesOf(s.toUpperCase())])),
    barsBatchSince: async (symbols: string[]) => new Map(symbols.map((s) => [s.toUpperCase(), dated(s.toUpperCase())])),
    dailyCloses: async (symbol: string, n = 60) => h.closesOf(symbol.toUpperCase()).slice(-n),
    latestPrice: async (symbol: string) => h.PRICE[symbol.toUpperCase()] ?? null,
    getMarketData: () => h.source,
  };
});

vi.mock('../../src/app/trading-reconcile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/trading-reconcile')>();
  return { ...actual, reconcileOpenOrders: async () => ({ checked: 0, updated: 0 }) };
});

vi.mock('../../src/app/trading-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/trading-engine')>();
  return {
    ...actual,
    // Records the order and "fills" it into the venue's cash at the fixture price, so the sleeve's
    // post-sale re-read sees what a real venue would: every sale's proceeds, every buy's cost.
    placeDecisionOrder: async (pool: Pool, sub: string, _book: unknown, decisionId: string, requestId: string) => {
      h.rec.orders.push({ decisionId, requestId });
      const d = (await pool.query('SELECT symbol, side, qty::float8 AS qty FROM oshal_trading_decisions WHERE decision_id = $1 AND user_sub = $2', [decisionId, sub])).rows[0];
      const px = h.PRICE[String(d.symbol).toUpperCase()] ?? 0;
      h.venue.cash += (d.side === 'sell' ? 1 : -1) * Number(d.qty) * px;
      return { status: 'accepted', id: `fake-${h.rec.orders.length}` };
    },
  };
});

import { legacyBook } from '../../src/app/trading-books-store';
import { dispatchTradingSchedule } from '../../src/app/trading-schedule-dispatch';
import { gatherSleeveFacts } from '../../src/app/routes/test-lab-trading-parity-scenarios';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { ensureTradingSpecSchema } from '../helpers/trading-spec-schema';

const fixture = new DisposablePostgres({
  purpose: 'trading-yield-sleeve-fire', database: 'trading_fixture', memory: '384m', max: 4,
  statementTimeoutMs: 60_000, options: '-c row_security=off',
});
const RUN = crypto.randomUUID().slice(0, 8);
const UNIVERSE = ['SPY', 'LOSR', 'BRKD', 'SELL', 'COLD', 'HOTA', 'HOTB', 'INFL', 'FLIP', 'SGOV'];
let pool: Pool;
const ctx = () => ({ pool, ticketService: { createTicket: async () => ({}) } } as unknown as AppContext);

/** One placed order resolved back to its persisted decision row. */
interface Placed { decisionId: string; symbol: string; side: string; qty: number; source: string; reason: string | null; createdAt: Date }

beforeAll(async () => {
  pool = await fixture.start();
  await ensureTradingSpecSchema(pool);
}, 240_000);

afterAll(async () => {
  try { await fixture.stop(); }
  finally { for (const [k, v] of Object.entries(h.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}, 120_000);

/** Seed one ledger order (with its signal and decision) for `sub`'s paper book. */
async function seedOrder(sub: string, sym: string, side: 'buy' | 'sell', qty: number, status: string, px: number | null): Promise<void> {
  const book = legacyBook(sub, 'paper');
  const sig = (await pool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, title, body, symbols, indicators, content_hash)
       VALUES ($1,'paper',$2,'spec-seed',$3,'seed',$4,'{}',$5) RETURNING signal_id`, [sub, book.bookId, `${sym} seed`, [sym], crypto.randomUUID()])).rows[0];
  const dec = (await pool.query(
    `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, confidence, rationale, indicators, guardrails)
       VALUES ($1,'paper',$2,$3::uuid[],'spec-seed',$4,$5,$4,$6,'market',1,'seed','{}','{}') RETURNING decision_id`,
    [sub, book.bookId, [sig.signal_id], side, sym, qty])).rows[0];
  await pool.query(
    `INSERT INTO oshal_trading_orders (user_sub, mode, book_id, decision_id, broker, broker_order_id, client_order_id, symbol, side, qty, order_type, limit_price, status, filled_qty, filled_avg_price)
       VALUES ($1,'paper',$2,$3,'alpaca',$4,$5,$6,$7,$8,'market',$9,$10,$11,$12)`,
    [sub, book.bookId, dec.decision_id, `brk-${crypto.randomUUID()}`, `${sub}:seed-${crypto.randomUUID()}`, sym, side, qty,
      status === 'filled' ? null : px, status, status === 'filled' ? qty : 0, status === 'filled' ? px : null]);
}

/** A fresh owner whose every position the engine bought itself (ADR-159), plus an optional working order. */
async function freshSub(tag: string, positions: Position[], working: Array<[string, 'buy' | 'sell', number, number]> = []): Promise<string> {
  const sub = `spec-sleeve-${tag}-${RUN}`;
  for (const p of positions) await seedOrder(sub, p.symbol, 'buy', p.qty, 'filled', p.avgEntryPrice);
  for (const [sym, side, qty, px] of working) await seedOrder(sub, sym, side, qty, 'accepted', px);
  return sub;
}

/** Drive ONE real autopilot fire for `sub`'s paper book and resolve every placed order to its decision row. */
async function fire(sub: string, opts: { rotation?: boolean; universe?: string[]; cash?: number; positions?: Position[] } = {}): Promise<Placed[]> {
  h.rec.orders.length = 0; h.rec.scanned = [];
  h.venue.cash = opts.cash ?? 1_000;
  h.venue.positions = opts.positions ?? h.BOOK;
  if (opts.rotation) process.env.TRADING_SLEEVE_ROTATION = 'true'; else delete process.env.TRADING_SLEEVE_ROTATION;
  try {
    await dispatchTradingSchedule(ctx(), {
      id: `spec-sleeve-${RUN}`, taskType: `trading-autopilot:${sub}`, taskData: { userSub: sub, mode: 'paper', universe: opts.universe ?? UNIVERSE },
    } as never);
  } finally { delete process.env.TRADING_SLEEVE_ROTATION; }
  const out: Placed[] = [];
  for (const o of h.rec.orders) {
    const r = (await pool.query(
      `SELECT d.decision_id, d.symbol, d.side, d.qty::float8 AS qty, s.source, d.indicators->>'reason' AS reason, d.created_at
         FROM oshal_trading_decisions d JOIN oshal_trading_signals s ON s.signal_id = d.signal_ids[1]
        WHERE d.decision_id = $1 AND d.user_sub = $2`, [o.decisionId, sub])).rows[0];
    out.push({ decisionId: String(r.decision_id), symbol: String(r.symbol), side: String(r.side), qty: Number(r.qty), source: String(r.source), reason: r.reason, createdAt: r.created_at });
  }
  return out;
}

const bySym = (plan: Placed[], sym: string) => plan.filter((o) => o.symbol === sym);
const entryBuys = (plan: Placed[]) => plan.filter((o) => o.side === 'buy' && o.source === 'mtf-autopilot').map((o) => [o.symbol, o.qty]);

describe('idle-cash yield sleeve — through a real scan fire', () => {
  it('armed on paper: the fund is sold FIRST, the entries then go in at full size, and the fund is never stopped out or scanned', async () => {
    const sub = await freshSub('scan', h.BOOK, [['INFL', 'buy', 10, 30]]);
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    try {
      const plan = await fire(sub);
      const fund = bySym(plan, 'SGOV');
      // Exactly one fund order — the funding sale — and no stop-loss on a holding 16.7% under its cost.
      expect(fund.map((o) => [o.side, o.source, o.reason])).toEqual([['sell', 'yield-sleeve', 'yield-sleeve-fund']]);
      expect(h.rec.scanned, 'an armed fund is never scanned').not.toContain('SGOV');
      // Sell first: the funding sale precedes every entry it funded, in placement order and in the ledger.
      const firstEntry = plan.findIndex((o) => o.source === 'mtf-autopilot' && o.side === 'buy');
      expect(plan.indexOf(fund[0])).toBeLessThan(firstEntry);
      for (const b of plan.filter((o) => o.source === 'mtf-autopilot' && o.side === 'buy')) expect(fund[0].createdAt.getTime()).toBeLessThan(b.createdAt.getTime());
      // Sized as if the fund were cash, so the book's own caps bind instead of the cash: here the 22%
      // 'other'-sector cap, with $21,010 of it already in SPY and COLD, leaves $990 per name. The unarmed
      // twin below is bound by the $200 of cash left after the core top-up and INFL's working buy.
      expect(entryBuys(plan)).toEqual([['HOTA', 19], ['HOTB', 49]]);
      expect(fund[0].qty, 'the shortfall beyond the $200 on hand, rounded up to whole shares').toBe(Math.ceil((19 * 50 + 49 * 20 - 200) / 100));
      // The protective legs are untouched.
      expect(bySym(plan, 'LOSR').map((o) => o.reason)).toEqual(['stop_loss']);
      expect(bySym(plan, 'BRKD').map((o) => o.reason)).toEqual(['breakdown']);
      expect(bySym(plan, 'SPY').map((o) => [o.side, o.source])).toEqual([['buy', 'beta-core']]);
      // The Test Lab readback reads the same ledger back: one funding sale, followed by the buys it funded.
      const facts = await gatherSleeveFacts({ ctx: ctx(), ownerSub: sub, issuer: null, apiBaseUrl: '' });
      expect(facts.books).toEqual([{ book: 'paper', floatPct: 5, source: 'env' }, { book: 'live', floatPct: 0, source: 'off' }]);
      expect(facts.paperLedger).toMatchObject({ fundSales: 1, fundedFires: 1, unfollowedSales: 0, parks: 0, refills: 0 });
    } finally { delete process.env.TRADING_YIELD_SLEEVE; }
  }, 180_000);

  it('the unarmed twin: the fund is an ordinary position (stopped out), and the entries get only what the cash covers', async () => {
    const sub = await freshSub('scan-off', h.BOOK, [['INFL', 'buy', 10, 30]]);
    const plan = await fire(sub);
    expect(bySym(plan, 'SGOV').map((o) => [o.side, o.reason])).toEqual([['sell', 'stop_loss']]);
    expect(entryBuys(plan)).toEqual([['HOTA', 4], ['HOTB', 10]]);
    const facts = await gatherSleeveFacts({ ctx: ctx(), ownerSub: sub, issuer: null, apiBaseUrl: '' });
    expect(facts.books[0]).toEqual({ book: 'paper', floatPct: 0, source: 'off' });
    expect(facts.paperLedger).toMatchObject({ fundSales: 0, fundedFires: 0 });
  }, 180_000);

  it('while the fund\'s own order is still working, the sleeve sells nothing — and the fund stays exempt', async () => {
    const sub = await freshSub('idle', h.BOOK, [['SGOV', 'sell', 5, 99]]);
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    try {
      const plan = await fire(sub);
      expect(bySym(plan, 'SGOV')).toEqual([]);
      // Sized against the $500 on hand only (no working buy this time, so INFL is an entry too).
      expect(entryBuys(plan)).toEqual([['HOTA', 10], ['INFL', 16], ['HOTB', 25]]);
    } finally { delete process.env.TRADING_YIELD_SLEEVE; }
  }, 180_000);
});

describe('idle-cash yield sleeve — rotation and the quiet-fire rebalance', () => {
  it('rotation: the fund is sold before the rebalance buys and is never dropped out', async () => {
    const sub = await freshSub('rot', h.BOOK);
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    try {
      const plan = await fire(sub, { rotation: true });
      const fund = bySym(plan, 'SGOV');
      expect(fund.map((o) => [o.side, o.source, o.reason])).toEqual([['sell', 'yield-sleeve', 'yield-sleeve-fund']]);
      const rotBuys = plan.filter((o) => o.source === 'gravity-rotation' && o.side === 'buy');
      expect(rotBuys.length).toBeGreaterThan(0);
      expect(plan.indexOf(fund[0])).toBeLessThan(plan.indexOf(rotBuys[0]));
    } finally { delete process.env.TRADING_YIELD_SLEEVE; }
  }, 240_000);

  it('a quiet fire parks the cash above the float in the fund', async () => {
    const book = [h.pos('SPY', 70, 480)]; // exactly the 35% core target: nothing to top up
    const sub = await freshSub('park', book);
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    try {
      const plan = await fire(sub, { universe: ['SPY', 'FLIP'], cash: 40_000, positions: book });
      expect(plan.map((o) => [o.symbol, o.side, o.qty, o.source, o.reason])).toEqual([['SGOV', 'buy', 350, 'yield-sleeve', 'yield-sleeve-park']]);
      const facts = await gatherSleeveFacts({ ctx: ctx(), ownerSub: sub, issuer: null, apiBaseUrl: '' });
      expect(facts.paperLedger).toMatchObject({ fundSales: 0, parks: 1 });
    } finally { delete process.env.TRADING_YIELD_SLEEVE; }
  }, 180_000);

  it('an UNARMED quiet fire places nothing at all', async () => {
    const book = [h.pos('SPY', 70, 480)];
    const sub = await freshSub('park-off', book);
    expect(await fire(sub, { universe: ['SPY', 'FLIP'], cash: 40_000, positions: book })).toEqual([]);
  }, 180_000);
});

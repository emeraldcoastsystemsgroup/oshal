/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-159 at the FIRE boundary. The unit guards cover each order-decision function on its own, and the golden plan seeds an engine fill for EVERY fixture position - so every position in the corpus was accounted for by construction and no test could reach a leg through `runAutopilot` (which is not exported) holding an unaccounted position. That is how the 2a short-timeframe breakdown leg kept its sell: it reads the plain quantity map, which carries no mark, and it runs on every fire rather than only when rotation does not own the sleeve. This spec drives a REAL dispatchTradingSchedule fire over a book whose ledger covers only half its positions and asserts that no order of any kind reaches the uncovered half - through the stop, the 2a breakdown (isShortTermBreakdown true for that symbol), the 2b technical sell, the 2c bench, the entry dedup and both rotation paths. A COVERED twin of each uncovered name is in the same book and its order IS asserted, so a fire that simply did nothing cannot pass. The withheld plan is then compared order-for-order against the same fire on a fully covered book to prove the property is SUPPRESSIVE: every order it still places also occurs there, never larger, and no buy notional grows. Runs against a DISPOSABLE PostgreSQL container - a deployment database is never read or written.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { AppContext } from '../../src/app/composition/app-context';
import type { MtfDecision, Position, BrokerAccount, DatedClose, MarketDataSource, TimeframeView } from '../../src/features/trading';

/* ── fixtures (hoisted: the dispatch module reads several TRADING_* values at IMPORT time) ───────── */
const h = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {};
  const pin = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  // The operator box has several of these armed; the spec must not inherit the shell.
  for (const k of [
    'TRADING_SECTOR_TILT', 'TRADING_ROTATION_MAX_GAP_DOWN_PCT', 'TRADING_POP_CATCHER', 'TRADING_EARNINGS_GATE',
    'TRADING_WORLD_RANK', 'TRADING_EXTENDED_HOURS', 'TRADING_CAPITAL_CAP_USD', 'TRADING_SYMBOL_BLOCKLIST',
    'TRADING_ROTATION_RANK', 'TRADING_ROTATION_TOPN', 'TRADING_ROTATION_WEIGHTING', 'TRADING_ROTATION_EVERY_DAYS',
    'TRADING_ROTATION_EXT_HOURS', 'TRADING_MULTI_ACCOUNT', 'TRADING_MAX_ORDERS_PER_RUN', 'TRADING_EXT_ENTRIES',
    'TRADING_BASELINE_VOL_PCT', 'ENABLE_WORLD_INTELLIGENCE', 'TRADING_TAKE_PROFIT_PCT', 'TRADING_SLEEVE_ROTATION',
    'TRADING_WORLD_SENTIMENT_CLEAN', 'TRADING_EARNINGS_BLACKOUT_DAYS', 'TRADING_WORLD_RANK_WEIGHT', 'TRADING_CORE_TARGET_PCT',
    'TRADING_RISK_POSTURE_LIVE', 'TRADING_LIVE_ENABLED', 'TRADING_AUTOPILOT_LIVE', 'TRADING_HALT',
  ]) pin(k, undefined);
  pin('TRADING_MAX_NOTIONAL_USD', '50000');
  pin('TRADING_MAX_QTY', '100000');
  pin('TRADING_CORE_SYMBOLS', 'SPY:35');
  pin('TRADING_RISK_POSTURE', 'balanced');
  // `require` and not the module import: vi.hoisted runs BEFORE the ESM imports are initialized.
  pin('SESSION_SECRET', process.env.SESSION_SECRET || `spec-secret-${require('crypto').randomUUID()}`);

  /** Last close == the quoted price; strong names ramp UP into it, weak names fall INTO it. */
  const PRICE: Record<string, number> = {
    SPY: 500, USTP: 88, MSTP: 88, UBRK: 102, MBRK: 102, USEL: 52, MSEL: 52,
    UCLD: 101, MCLD: 102, UBUY: 30, HOTA: 50, HOTB: 20, HOTC: 40,
  };
  const STRONG = new Set(['UBUY', 'HOTA', 'HOTB', 'HOTC']);
  const closesOf = (sym: string): number[] => {
    const p = PRICE[sym]; if (!p) return [];
    const out: number[] = [];
    for (let i = 0; i < 150; i++) out.push(Number((STRONG.has(sym) ? p * (1 + 0.004 * (i - 149)) : p * (1 - 0.003 * (i - 149))).toFixed(4)));
    return out;
  };
  const tf = (timeframe: string, action: 'buy' | 'sell' | 'hold', score: number): TimeframeView =>
    ({ timeframe: timeframe as TimeframeView['timeframe'], weight: 1, action, score, confidence: Math.abs(score), bars: 60 });
  const mtf = (symbol: string, action: 'buy' | 'sell' | 'hold', score: number, per: TimeframeView[]): MtfDecision =>
    ({ symbol, price: PRICE[symbol], action, side: action === 'hold' ? null : action, score, confidence: 0.6, regime: 0.3, perTimeframe: per, rationale: `fixture ${symbol} ${action}` });
  /** A holding down past the stop, with NO breakdown and NO technical sell — leg 1 only. */
  const stopShape = (s: string): MtfDecision => mtf(s, 'hold', 0.25, [tf('5Min', 'hold', 0.25), tf('1Hour', 'hold', 0.25), tf('1Day', 'hold', 0.25)]);
  /** Both short timeframes selling hard while the regime is up — isShortTermBreakdown TRUE (leg 2a). */
  const breakdownShape = (s: string): MtfDecision => mtf(s, 'hold', 0.25, [tf('5Min', 'sell', -0.6), tf('1Hour', 'sell', -0.5), tf('1Day', 'hold', 0.1)]);
  /** A weighted SELL that is not a breakdown (the 1-hour view is flat) — leg 2b. */
  const technicalSellShape = (s: string): MtfDecision => mtf(s, 'sell', 0.25, [tf('5Min', 'sell', -0.2), tf('1Hour', 'hold', 0), tf('1Day', 'sell', -0.5)]);
  /** Cold enough to be benched when a much hotter name sits unheld — leg 2c. */
  const coldShape = (s: string, score: number): MtfDecision => mtf(s, 'hold', score, [tf('5Min', 'hold', score), tf('1Hour', 'hold', score), tf('1Day', 'hold', score)]);
  const hotShape = (s: string, score: number): MtfDecision => mtf(s, 'buy', score, [tf('5Min', 'buy', score / 2), tf('1Hour', 'buy', score), tf('1Day', 'buy', score)]);

  const SCAN: MtfDecision[] = [
    stopShape('USTP'), stopShape('MSTP'),
    breakdownShape('UBRK'), breakdownShape('MBRK'),
    technicalSellShape('USEL'), technicalSellShape('MSEL'),
    coldShape('UCLD', 0.01), coldShape('MCLD', 0.02),
    hotShape('UBUY', 0.5), hotShape('HOTA', 0.6), hotShape('HOTB', 0.45), hotShape('HOTC', 0.4),
  ];
  const pos = (symbol: string, qty: number, avgEntryPrice: number): Position => {
    const currentPrice = PRICE[symbol];
    return { symbol, qty, avgEntryPrice, marketValue: qty * currentPrice, unrealizedPl: qty * (currentPrice - avgEntryPrice), currentPrice };
  };
  /** Five UNCOVERED names, each paired with a COVERED twin of the identical shape, plus the core. */
  const UNCOVERED = ['USTP', 'UBRK', 'USEL', 'UCLD', 'UBUY'];
  const POSITIONS: Position[] = [
    pos('SPY', 40, 480),
    pos('USTP', 50, 100), pos('MSTP', 50, 100),      // −12% → stop (balanced stops at 9%)
    pos('UBRK', 40, 100), pos('MBRK', 40, 100),      // +2% → no stop; short timeframes break down
    pos('USEL', 20, 50), pos('MSEL', 20, 50),        // +4% → no stop; weighted action is sell
    pos('UCLD', 10, 100), pos('MCLD', 10, 100),      // ~flat and cold → bench candidate
    pos('UBUY', 20, 30),                             // buy-rated AND held — must never be bought
  ];
  const ACCOUNT: BrokerAccount = { cash: 40_000, buyingPower: 40_000, equity: 100_000, currency: 'USD' };

  const rec = { orders: [] as Array<{ decisionId: string; symbol: string; side: string; qty: number }>, canceled: [] as string[] };
  const broker = {
    mode: () => 'paper', configured: () => true,
    getPositions: async () => POSITIONS.map((p) => ({ ...p })),
    getAccount: async () => ({ ...ACCOUNT }),
    cancelOrder: async (id: string) => { rec.canceled.push(id); },
    placeOrder: async () => { throw new Error('spec: every order must route through placeDecisionOrder (recorded)'); },
    getOrder: async () => { throw new Error('spec: getOrder not expected'); },
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
  return { saved, PRICE, SCAN, POSITIONS, ACCOUNT, UNCOVERED, closesOf, rec, broker, source };
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
      const want = new Set(symbols.map((s) => s.toUpperCase()));
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
    placeDecisionOrder: async (_pool: unknown, _sub: string, _book: unknown, decisionId: string) => {
      h.rec.orders.push({ decisionId, symbol: '', side: '', qty: 0 });
      return { status: 'accepted', id: `fake-${h.rec.orders.length}` };
    },
  };
});

import { ensureBooksSchema, legacyBook } from '../../src/app/trading-books-store';
import { ensureTradingSchema } from '../../src/app/trading-engine';
import { ensureEquityGuardTable } from '../../src/app/trading-equity-guard';
import { ensureGateBlockTable } from '../../src/app/trading-gate-block-store';
import { ensurePeaksTable } from '../../src/app/trading-peaks-store';
import { ensureDailyEquityTable } from '../../src/app/trading-daily-equity-store';
import { ensureRotationStateTable } from '../../src/app/trading-rotation-store';
import { ensurePinnedLotsSchema } from '../../src/app/trading-pinned-lots';
import { dispatchTradingSchedule } from '../../src/app/trading-schedule-dispatch';

/** Every name the scan knows, plus the core — the universe each fire is pinned to. */
const UNIVERSE = ['SPY', 'USTP', 'MSTP', 'UBRK', 'MBRK', 'USEL', 'MSEL', 'UCLD', 'MCLD', 'UBUY', 'HOTA', 'HOTB', 'HOTC'];
/** The book whose ledger covers only the M-twins; the U-names are the operator's hand-bought shares. */
const SUB_HALF = 'spec-adr159-fire-half';
/** The same book with every position covered — the control the withheld plan is compared against. */
const SUB_FULL = 'spec-adr159-fire-full';

const CONTAINER = `oshal-adr159-fixture-${randomUUID()}`;
let pool: Pool;
const tickets: Array<{ title: string }> = [];
const ctx = (): AppContext => ({ pool, ticketService: { createTicket: async (t: { title: string }) => { tickets.push(t); return {}; } } } as unknown as AppContext);

/** One recorded order, resolved back to the decision row the recorder's id points at. */
interface PlacedOrder { symbol: string; side: string; qty: number; source: string }

/** Docker argv is fixed apart from the generated fixture password; no inherited DSN is ever read. */
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
}

/** Bring up a private PostgreSQL for this file and return a pool once it answers.
 * @description Start the disposable database the fire writes its ledger into.
 * @returns The connected pool.
 */
async function startDisposablePostgres(): Promise<Pool> {
  const password = randomUUID();
  docker(['run', '--detach', '--rm', '--name', CONTAINER, '--label', 'oshal.test-fixture=trading-dispatch-unmanaged',
    '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data', '--memory', '384m', '--cpus', '1',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=trading_fixture', 'postgres:16-alpine']);
  const published = docker(['port', CONTAINER, '5432/tcp']);
  const match = /127\.0\.0\.1:(\d+)/.exec(published);
  if (!match) throw new Error('disposable PostgreSQL must publish exactly one loopback port');
  const p = new Pool({ host: '127.0.0.1', port: Number(match[1]), user: 'postgres', password, database: 'trading_fixture', max: 6, statement_timeout: 30_000 });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { await p.query('SELECT 1'); return p; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('disposable PostgreSQL did not become ready');
}

/** Seed the engine's OWN filled BUY for `symbols`, exactly covering each venue quantity at the venue's
 *  average price: exact coverage is what makes a position ACCOUNTED, and an equal price keeps the
 *  wash-sale veto inert. A name left out of `symbols` is what the operator bought by hand.
 * @description Cover the given positions with engine fills on the sub's legacy paper book.
 * @param sub - The owner sub whose legacy paper book is seeded.
 * @param symbols - The position symbols to cover.
 * @returns Nothing.
 */
async function seedEngineFills(sub: string, symbols: string[]): Promise<void> {
  const book = legacyBook(sub, 'paper');
  for (const p of h.POSITIONS.filter((x) => symbols.includes(x.symbol))) {
    const sig = (await pool.query(
      `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, title, body, symbols, indicators, content_hash)
         VALUES ($1,'paper',$2,'spec-seed',$3,'seed',$4,'{}',$5) RETURNING signal_id`,
      [sub, book.bookId, `${p.symbol} engine buy`, [p.symbol], randomUUID()])).rows[0];
    const dec = (await pool.query(
      `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, confidence, rationale, indicators, guardrails)
         VALUES ($1,'paper',$2,$3::uuid[],'spec-seed','buy',$4,'buy',$5,'market',1,'seeded engine fill','{}','{}') RETURNING decision_id`,
      [sub, book.bookId, [sig.signal_id], p.symbol, p.qty])).rows[0];
    await pool.query(
      `INSERT INTO oshal_trading_orders (user_sub, mode, book_id, decision_id, broker, broker_order_id, client_order_id, symbol, side, qty, order_type, status, filled_qty, filled_avg_price)
         VALUES ($1,'paper',$2,$3,'alpaca',$4,$5,$6,'buy',$7,'market','filled',$7,$8)`,
      [sub, book.bookId, dec.decision_id, `brk-fill-${sub}-${p.symbol}`, `${sub}:seed-fill-${p.symbol}`, p.symbol, p.qty, p.avgEntryPrice]);
  }
}

/** Drive ONE real autopilot fire and resolve every recorded order back to its persisted decision row.
 * @description Fire the trading schedule for `sub` and return the ordered plan it placed.
 * @param sub - The owner sub whose legacy paper book fires.
 * @param rotation - Whether TRADING_SLEEVE_ROTATION is armed for this fire.
 * @returns The ordered list of placed orders.
 */
async function fire(sub: string, rotation: boolean): Promise<PlacedOrder[]> {
  h.rec.orders.length = 0; h.rec.canceled.length = 0; tickets.length = 0;
  if (rotation) process.env.TRADING_SLEEVE_ROTATION = 'true'; else delete process.env.TRADING_SLEEVE_ROTATION;
  try {
    await dispatchTradingSchedule(ctx(), {
      id: `spec-adr159-${sub}`, taskType: `trading-autopilot:${sub}`, taskData: { userSub: sub, mode: 'paper', universe: UNIVERSE },
    } as never);
  } finally {
    delete process.env.TRADING_SLEEVE_ROTATION;
  }
  const out: PlacedOrder[] = [];
  for (const o of h.rec.orders) {
    const r = (await pool.query(
      `SELECT d.symbol, d.side, d.qty::float8 AS qty, s.source
         FROM oshal_trading_decisions d JOIN oshal_trading_signals s ON s.signal_id = d.signal_ids[1]
        WHERE d.decision_id = $1 AND d.user_sub = $2`, [o.decisionId, sub])).rows[0];
    out.push({ symbol: String(r.symbol), side: String(r.side), qty: Number(r.qty), source: String(r.source) });
  }
  return out;
}

/** The plan entries for one symbol, as `side×qty` strings — the shape the assertions compare.
 * @description Reduce a plan to the orders it placed for `symbol`.
 * @param plan - The fire's ordered plan.
 * @param symbol - The symbol to select.
 * @returns One `side qty` string per order.
 */
const forSymbol = (plan: PlacedOrder[], symbol: string): string[] =>
  plan.filter((o) => o.symbol === symbol).map((o) => `${o.side} ${o.qty}`);

/** The same reduction for several symbols at once, so ONE assertion reports EVERY leg that leaked
 *  rather than stopping at the first — a per-symbol loop hides the rest behind its first failure.
 * @description Reduce a plan to a symbol → orders map over `symbols`.
 * @param plan - The fire's ordered plan.
 * @param symbols - The symbols to select.
 * @returns A map of symbol to its `side qty` strings.
 */
const byLeg = (plan: PlacedOrder[], symbols: string[]): Record<string, string[]> =>
  Object.fromEntries(symbols.map((s) => [s, forSymbol(plan, s)]));

beforeAll(async () => {
  pool = await startDisposablePostgres();
  for (const ensure of [ensureBooksSchema, ensureTradingSchema, ensureEquityGuardTable, ensureGateBlockTable,
    ensurePeaksTable, ensureDailyEquityTable, ensureRotationStateTable, ensurePinnedLotsSchema]) {
    await (ensure as (p: never) => Promise<unknown>)(pool as never);
  }
  const covered = h.POSITIONS.map((p) => p.symbol).filter((s) => !h.UNCOVERED.includes(s));
  await seedEngineFills(SUB_HALF, covered);
  await seedEngineFills(SUB_FULL, h.POSITIONS.map((p) => p.symbol));
}, 240_000);

afterAll(async () => {
  try { if (pool) await pool.end(); }
  finally {
    try { docker(['rm', '--force', CONTAINER]); } catch { /* the --rm container may already be gone */ }
    for (const [k, v] of Object.entries(h.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}, 120_000);

describe('a full autopilot fire places NO order for a position the engine cannot account for (ADR-159)', () => {
  it('scan sleeve: the stop, the 2a breakdown, the 2b technical sell and the 2c bench all withhold', async () => {
    const plan = await fire(SUB_HALF, false);
    // The COVERED twins prove each leg actually ran in THIS fire — without them a dispatch that did
    // nothing at all (a closed market, a failed read, an empty scan) would satisfy every assertion below.
    expect(byLeg(plan, ['MSTP', 'MBRK', 'MSEL', 'MCLD']), 'each leg placed the order for its covered twin')
      .toEqual({ MSTP: ['sell 50'], MBRK: ['sell 40'], MSEL: ['sell 20'], MCLD: ['sell 10'] });
    expect(plan.some((o) => o.side === 'buy'), 'the fire is also placing buys').toBe(true);
    // ADR-159: not one order for any name the ledger does not cover — the same legs, the same fire.
    expect(byLeg(plan, h.UNCOVERED), 'an unaccounted holding gets NO order of any kind')
      .toEqual({ USTP: [], UBRK: [], USEL: [], UCLD: [], UBUY: [] });
  }, 180_000);

  it('rotation sleeve: the drop-out sell, the trim, the top-up and the always-on 2a breakdown all withhold', async () => {
    const plan = await fire(SUB_HALF, true);
    // Rotation OWNS the sleeve here (2b/2c/2d are skipped); the protective exits and 2a still run.
    expect(forSymbol(plan, 'MBRK'), 'leg 2a runs on EVERY fire — the covered twin is still sold').toContain('sell 40');
    expect(plan.some((o) => o.source === 'gravity-rotation'), 'rotation actually traded this fire').toBe(true);
    expect(byLeg(plan, h.UNCOVERED), 'an unaccounted holding gets NO order of any kind')
      .toEqual({ USTP: [], UBRK: [], USEL: [], UCLD: [], UBUY: [] });
  }, 240_000);
});

describe('withholding only ever REMOVES an order — it never frees capital for another target', () => {
  it('every order of the withheld scan fire also occurs, at no smaller size, on the fully covered book', async () => {
    const withheld = await fire(SUB_HALF, false);
    const covered = await fire(SUB_FULL, false);
    // Each withheld name IS traded once the same book accounts for it, so the difference between the
    // two plans is the withholding under test and not a fixture that never reaches these legs.
    for (const sym of ['USTP', 'UBRK', 'USEL', 'UCLD']) {
      expect(forSymbol(covered, sym).length, `${sym} trades when it IS accounted for`).toBeGreaterThan(0);
    }
    // UBUY is the OTHER direction: a buy-rated name that is already held is never re-bought, covered or
    // not. It is asserted on BOTH books because that is what `held` buys us — the withheld name has to
    // stay in the entry leg's dedup map, or withholding its sell would let the engine buy it instead.
    expect(forSymbol(covered, 'UBUY'), 'a held name is not re-bought even when fully accounted for').toEqual([]);
    expectSuppressive(withheld, covered);
  }, 240_000);

  it('the same holds for the rotation fire, where rotation owns the sleeve', async () => {
    const withheld = await fire(SUB_HALF, true);
    const covered = await fire(SUB_FULL, true);
    for (const sym of h.UNCOVERED) {
      expect(forSymbol(covered, sym).length, `${sym} trades when it IS accounted for`).toBeGreaterThan(0);
    }
    expectSuppressive(withheld, covered);
  }, 300_000);
});

/** Assert the ONE property that makes this safe on real money: the withheld plan is a weakening of
 *  the covered plan. Every (symbol, side) it still places occurs on the covered book too and is no
 *  larger there — so no capital the withholding held back can have flowed into another name — and
 *  the total buy notional never grows.
 * @description Compare a withheld plan against its fully covered control.
 * @param withheld - The plan the half-covered book produced.
 * @param covered - The plan the same fire produced with every position accounted for.
 * @returns Nothing; throws through expect on the first violation.
 */
function expectSuppressive(withheld: PlacedOrder[], covered: PlacedOrder[]): void {
  const cap = new Map<string, number>();
  for (const o of covered) {
    const k = `${o.symbol} ${o.side}`;
    cap.set(k, (cap.get(k) ?? 0) + o.qty);
  }
  const placed = new Map<string, number>();
  for (const o of withheld) {
    const k = `${o.symbol} ${o.side}`;
    placed.set(k, (placed.get(k) ?? 0) + o.qty);
  }
  for (const [k, qty] of placed) {
    expect(cap.has(k), `${k} is placed only when a holding is WITHHELD — withholding created an order`).toBe(true);
    expect(qty, `${k} is larger when a holding is withheld — withholding enlarged an order`).toBeLessThanOrEqual(cap.get(k) as number);
  }
  const notional = (plan: PlacedOrder[]): number =>
    plan.filter((o) => o.side === 'buy').reduce((s, o) => s + o.qty * (h.PRICE[o.symbol] ?? 0), 0);
  expect(notional(withheld), 'withholding deployed MORE cash than the fully covered fire').toBeLessThanOrEqual(notional(covered));
}

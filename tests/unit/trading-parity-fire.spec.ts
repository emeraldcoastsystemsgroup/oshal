/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the ADR-052 addendum parity features driven through REAL dispatchTradingSchedule fires against a PostgreSQL this file owns (the golden-plan harness: venue adapter, market data, scan and placeDecisionOrder doubled OUTSIDE the ledger boundary; placeOrder throws). MARKET GAP: armed on paper with SPY down 2% the scan leg places no entry while the stop, the breakdown and the technical sell still run and the beta-core rebalance is untouched, and the would-be buys land as 'market-gap' counterfactual rows; a 0.4% dip, an unmeasurable SPY and the unarmed default all place the golden entries; the rotation rebalance holds whole (no drop-out sell into the gap), keeps its daily slot, records its fresh targets, and runs on the next ungapped fire; an applied strategy's knob arms the book with the env off, and its explicit 0 disarms an env-armed book; the live book is not armed by a paper arm. EXIT PLANS: armed on paper, every scan and rotation buy stamps a fresh plan under its own decision (the beta core does not); a POLICY CHANGE does not re-price a stored plan (a name planned under the aggressive posture holds at -10% while its unplanned twin meets today's balanced stop); the expiry door and an event door (breakdown, rotation drop-out) exit and close the plan with the door and the decision; a held name with a fresh buy signal is re-underwritten; an unarmed fire writes no plan.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import type { AppContext } from '../../src/app/composition/app-context';
import type { MtfDecision, Position, BrokerAccount, DatedClose, MarketDataSource, TimeframeView } from '../../src/features/trading';

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
  ]) pin(k, undefined);
  pin('TRADING_MAX_NOTIONAL_USD', '50000');
  pin('TRADING_MAX_QTY', '100000');
  pin('TRADING_CORE_SYMBOLS', 'SPY:35');
  pin('TRADING_RISK_POSTURE', 'balanced');
  pin('SESSION_SECRET', process.env.SESSION_SECRET || `spec-secret-${require('crypto').randomUUID()}`);

  /** Last close == the quoted price; strong names ramp UP into it, weak names fall INTO it. */
  const PRICE: Record<string, number> = {
    SPY: 500, LOSR: 88, BRKD: 102, SELL: 52, COLD: 101, HOTA: 50, HOTB: 20, INFL: 30, GAPD: 100,
    FLIP: 90, FLOP: 90, XPIR: 101, HELD: 95,
  };
  const STRONG = new Set(['HOTA', 'HOTB', 'INFL', 'GAPD', 'HELD']);
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
  const quiet = (s: string): MtfDecision => mtf(s, 'hold', 0.25, 0.3, [tf('5Min', 'hold', 0.25), tf('1Hour', 'hold', 0.25), tf('1Day', 'hold', 0.25)]);
  const SCAN: MtfDecision[] = [
    mtf('LOSR', 'hold', -0.1, 0.2, [tf('5Min', 'hold', -0.1), tf('1Hour', 'hold', -0.1), tf('1Day', 'hold', -0.1)]),
    mtf('BRKD', 'hold', -0.5, 0.6, [tf('5Min', 'sell', -0.6), tf('1Hour', 'sell', -0.5), tf('1Day', 'hold', 0.1)]),
    mtf('SELL', 'sell', -0.4, 0.5, [tf('5Min', 'sell', -0.2), tf('1Hour', 'hold', 0), tf('1Day', 'sell', -0.5)]),
    mtf('COLD', 'hold', 0.05, 0.2, [tf('5Min', 'hold', 0.05), tf('1Hour', 'hold', 0.05), tf('1Day', 'hold', 0.05)]),
    mtf('HOTA', 'buy', 0.6, 0.7, [tf('5Min', 'buy', 0.3), tf('1Hour', 'buy', 0.6), tf('1Day', 'buy', 0.7)]),
    mtf('HOTB', 'buy', 0.45, 0.5, [tf('5Min', 'buy', 0.2), tf('1Hour', 'buy', 0.4), tf('1Day', 'buy', 0.5)]),
    mtf('INFL', 'buy', 0.5, 0.6, [tf('5Min', 'buy', 0.2), tf('1Hour', 'buy', 0.5), tf('1Day', 'buy', 0.6)]),
    mtf('GAPD', 'hold', 0.1, 0.3, [tf('5Min', 'hold', 0.1), tf('1Hour', 'hold', 0.1), tf('1Day', 'buy', 0.3)]),
    quiet('FLIP'), quiet('FLOP'), quiet('XPIR'),
    mtf('HELD', 'buy', 0.5, 0.6, [tf('5Min', 'buy', 0.2), tf('1Hour', 'buy', 0.5), tf('1Day', 'buy', 0.6)]),
  ];
  const pos = (symbol: string, qty: number, avgEntryPrice: number): Position => {
    const currentPrice = PRICE[symbol];
    return { symbol, qty, avgEntryPrice, marketValue: qty * currentPrice, unrealizedPl: qty * (currentPrice - avgEntryPrice), currentPrice };
  };
  const POSITIONS: Position[] = [
    pos('SPY', 40, 480), pos('LOSR', 50, 100), pos('BRKD', 30, 100), pos('SELL', 20, 50), pos('COLD', 10, 100),
    pos('FLIP', 1, 100), pos('FLOP', 1, 100), pos('XPIR', 1, 100), pos('HELD', 1, 90),
  ];
  const ACCOUNT: BrokerAccount = { cash: 40_000, buyingPower: 40_000, equity: 100_000, currency: 'USD' };
  /** The tape the market-gap filter reads (latestPrice SPY); every other name quotes its PRICE. */
  const tape = { spy: 500 as number | null };
  const LATEST: Record<string, number> = { ...PRICE, GAPD: 85 };

  const rec = { orders: [] as Array<{ decisionId: string; requestId: string }> };
  const broker = {
    mode: () => 'paper', configured: () => true,
    getPositions: async () => POSITIONS.map((p) => ({ ...p })),
    getAccount: async () => ({ ...ACCOUNT }),
    cancelOrder: async () => undefined,
    placeOrder: async () => { throw new Error('parity spec: every order must route through placeDecisionOrder (recorded)'); },
    getOrder: async () => { throw new Error('parity spec: getOrder not expected'); },
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
  return { saved, PRICE, LATEST, SCAN, POSITIONS, ACCOUNT, closesOf, rec, broker, source, tape };
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
    latestPrice: async (symbol: string) => (symbol.toUpperCase() === 'SPY' ? h.tape.spy : (h.LATEST[symbol.toUpperCase()] ?? null)),
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
    placeDecisionOrder: async (_pool: unknown, _sub: string, _book: unknown, decisionId: string, requestId: string) => {
      h.rec.orders.push({ decisionId, requestId });
      return { status: 'accepted', id: `fake-${h.rec.orders.length}` };
    },
  };
});

import { legacyBook, legacyBookId } from '../../src/app/trading-books-store';
import { dispatchTradingSchedule } from '../../src/app/trading-schedule-dispatch';
import { applyOverride } from '../../src/app/trading-config-overrides';
import { stampPlan, type PlanLedger } from '../../src/app/trading-position-plans';
import { resolveParityControls } from '../../src/app/trading-dispatch-market-gate';
import { RISK_POLICIES, addSessions, etSessionDate, riskPolicy } from '../../src/features/trading';
import { normalizeConfig } from '../../src/app/trading-strategy-lab-sim';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { ensureTradingSpecSchema } from '../helpers/trading-spec-schema';

const fixture = new DisposablePostgres({
  purpose: 'trading-parity-fire', database: 'trading_fixture', memory: '384m', max: 4,
  statementTimeoutMs: 60_000, options: '-c row_security=off',
});
const RUN = crypto.randomUUID().slice(0, 8);
const UNIVERSE = ['SPY', 'LOSR', 'BRKD', 'SELL', 'COLD', 'HOTA', 'HOTB', 'INFL', 'GAPD', 'FLIP', 'FLOP', 'XPIR', 'HELD'];
let pool: Pool;
const tickets: Array<{ title: string }> = [];
const ctx = () => ({ pool, ticketService: { createTicket: async (t: { title: string }) => { tickets.push(t); return {}; } } } as unknown as AppContext);

/** One placed order resolved back to its persisted decision row. */
interface Placed { decisionId: string; symbol: string; side: string; qty: number; source: string; indicators: Record<string, unknown> }

beforeAll(async () => {
  pool = await fixture.start();
  await ensureTradingSpecSchema(pool);
}, 240_000);

afterAll(async () => {
  try { await fixture.stop(); }
  finally { for (const [k, v] of Object.entries(h.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}, 120_000);

/** A fresh owner with the engine's OWN fills covering every fixture position (ADR-159) and a working INFL buy. */
async function freshSub(tag: string): Promise<string> {
  const sub = `spec-parity-${tag}-${RUN}`;
  const book = legacyBook(sub, 'paper');
  const insert = async (sym: string, side: 'buy' | 'sell', qty: number, status: string, px: number | null) => {
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
        status === 'pending' ? px : null, status, status === 'filled' ? qty : 0, status === 'filled' ? px : null]);
  };
  for (const p of h.POSITIONS) await insert(p.symbol, 'buy', p.qty, 'filled', p.avgEntryPrice);
  await insert('INFL', 'buy', 10, 'pending', 30);
  return sub;
}

/** Drive ONE real autopilot fire for `sub`'s paper book and resolve every placed order to its decision row. */
async function fire(sub: string, opts: { rotation?: boolean } = {}): Promise<Placed[]> {
  h.rec.orders.length = 0; tickets.length = 0;
  if (opts.rotation) process.env.TRADING_SLEEVE_ROTATION = 'true'; else delete process.env.TRADING_SLEEVE_ROTATION;
  try {
    await dispatchTradingSchedule(ctx(), {
      id: `spec-parity-${RUN}`, taskType: `trading-autopilot:${sub}`, taskData: { userSub: sub, mode: 'paper', universe: UNIVERSE },
    } as never);
  } finally { delete process.env.TRADING_SLEEVE_ROTATION; }
  const out: Placed[] = [];
  for (const o of h.rec.orders) {
    const r = (await pool.query(
      `SELECT d.decision_id, d.symbol, d.side, d.qty::float8 AS qty, s.source, d.indicators
         FROM oshal_trading_decisions d JOIN oshal_trading_signals s ON s.signal_id = d.signal_ids[1]
        WHERE d.decision_id = $1 AND d.user_sub = $2`, [o.decisionId, sub])).rows[0];
    out.push({ decisionId: String(r.decision_id), symbol: String(r.symbol), side: String(r.side), qty: Number(r.qty), source: String(r.source), indicators: r.indicators });
  }
  return out;
}

const sides = (plan: Placed[], side: 'buy' | 'sell') => plan.filter((o) => o.side === side).map((o) => o.symbol);
const gateRows = async (sub: string) => (await pool.query(
  `SELECT symbol FROM oshal_trading_gate_blocks WHERE user_sub = $1 AND gate = 'market-gap' ORDER BY symbol`, [sub])).rows.map((r) => r.symbol);
const plans = async (sub: string, symbol: string) => (await pool.query(
  'SELECT * FROM oshal_trading_position_plans WHERE user_sub = $1 AND symbol = $2 ORDER BY created_at, plan_id', [sub, symbol])).rows;
const slotRows = async (sub: string) => Number((await pool.query('SELECT count(*)::int AS n FROM oshal_trading_rotation_state WHERE user_sub = $1', [sub])).rows[0].n);

describe('market-wide gap-down entry filter — through a real fire', () => {
  it('armed on paper, SPY down 2%: the scan places NO entry; exits, breakdown and the beta core are untouched; would-be buys are recorded', async () => {
    const sub = await freshSub('gap-scan');
    process.env.TRADING_MARKET_GAP_FILTER = 'paper'; h.tape.spy = 490;
    try {
      const plan = await fire(sub);
      expect(sides(plan, 'buy'), 'only the beta-core rebalance buys — it is not an entry decision').toEqual(['SPY']);
      expect(sides(plan, 'sell')).toEqual(expect.arrayContaining(['LOSR', 'BRKD', 'SELL']));
      // The counterfactual write is fire-and-forget (evidence loss must never affect the fire), so wait for it to land.
      await vi.waitFor(async () => expect(await gateRows(sub), 'the scan buys the gate held back (INFL has a working order, HELD is already held)').toEqual(['HOTA', 'HOTB']), { timeout: 15_000 });
    } finally { delete process.env.TRADING_MARKET_GAP_FILTER; h.tape.spy = 500; }
  }, 180_000);

  it('a 0.4% dip, an unmeasurable SPY and the unarmed default all place the entries', async () => {
    for (const [tag, arm, spy] of [['dip', 'paper', 498], ['nodata', 'paper', null], ['off', undefined, 450]] as const) {
      const sub = await freshSub(`gap-${tag}`);
      if (arm) process.env.TRADING_MARKET_GAP_FILTER = arm; else delete process.env.TRADING_MARKET_GAP_FILTER;
      h.tape.spy = spy;
      try {
        const plan = await fire(sub);
        expect(sides(plan, 'buy'), tag).toEqual(['SPY', 'HOTA', 'HOTB']);
        expect(await gateRows(sub), tag).toEqual([]);
      } finally { delete process.env.TRADING_MARKET_GAP_FILTER; h.tape.spy = 500; }
    }
  }, 300_000);

  it('rotation: the WHOLE rebalance holds (no drop-out sell into the gap), the slot stays open, and it runs on the next ungapped fire', async () => {
    const sub = await freshSub('gap-rot');
    process.env.TRADING_MARKET_GAP_FILTER = 'paper'; h.tape.spy = 490;
    try {
      const held = await fire(sub, { rotation: true });
      expect(held.filter((o) => o.source === 'gravity-rotation'), 'no rotation order of any kind').toEqual([]);
      expect(sides(held, 'sell')).toEqual(expect.arrayContaining(['LOSR', 'BRKD'])); // the stop and the always-on breakdown
      expect(await slotRows(sub), 'a held rebalance must not burn the day').toBe(0);
      await vi.waitFor(async () => expect(await gateRows(sub), 'the rotation leaderboard fresh targets (GAPD refused by the per-name guard)').toEqual(['HOTA', 'HOTB', 'INFL']), { timeout: 15_000 });
      h.tape.spy = 500;
      const next = await fire(sub, { rotation: true });
      expect(next.some((o) => o.source === 'gravity-rotation' && o.side === 'buy')).toBe(true);
      expect(await slotRows(sub)).toBe(1);
    } finally { delete process.env.TRADING_MARKET_GAP_FILTER; h.tape.spy = 500; }
  }, 300_000);

  it('an applied strategy knob arms the book with the env off, and its explicit 0 disarms an env-armed book', async () => {
    h.tape.spy = 490;
    const cfg = (knob: number) => normalizeConfig({ kind: 'ensemble', posture: 'balanced', corePct: 35, marketGapFilterPct: knob });
    try {
      const armed = await freshSub('gap-knob-on');
      await applyOverride(pool, armed, { strategyId: null, strategyName: 'gap on', config: cfg(1), applyPct: 100, note: 'spec', bookId: legacyBookId(armed, 'paper'), bookRef: 'paper' });
      expect(sides(await fire(armed), 'buy')).not.toContain('HOTA');
      const disarmed = await freshSub('gap-knob-off');
      process.env.TRADING_MARKET_GAP_FILTER = 'paper';
      await applyOverride(pool, disarmed, { strategyId: null, strategyName: 'gap off', config: cfg(0), applyPct: 100, note: 'spec', bookId: legacyBookId(disarmed, 'paper'), bookRef: 'paper' });
      expect(sides(await fire(disarmed), 'buy')).toEqual(expect.arrayContaining(['HOTA', 'HOTB']));
    } finally { delete process.env.TRADING_MARKET_GAP_FILTER; h.tape.spy = 500; }
  }, 300_000);

  it('a paper arm does not arm the live book (mode-aware), and `both` does', async () => {
    h.tape.spy = 490;
    try {
      process.env.TRADING_MARKET_GAP_FILTER = 'paper';
      const live = legacyBook('spec-parity-live', 'live');
      expect((await resolveParityControls('spec-parity-live', live, null, riskPolicy('live'))).marketGap).toBeNull();
      process.env.TRADING_MARKET_GAP_FILTER = 'both';
      expect((await resolveParityControls('spec-parity-live', live, null, riskPolicy('live'))).marketGap).toMatchObject({ blocked: true, spyPriorClose: 500, spyPrice: 490 });
    } finally { delete process.env.TRADING_MARKET_GAP_FILTER; h.tape.spy = 500; }
  }, 60_000);
});

describe('per-position exit plans — through a real fire', () => {
  /** A ledger for seeding plans as a past fire would have stamped them. */
  const seedLedger = (sub: string, posture: keyof typeof RISK_POLICIES, today: string, sessions = 20): PlanLedger =>
    ({ sub, book: legacyBook(sub, 'paper'), policy: RISK_POLICIES[posture], sessions, today, stampedThisFire: new Set() });

  it('scan fire: buys stamp fresh plans; a posture flip does not re-price a plan; expiry and breakdown doors close their plans; a held buy signal re-underwrites', async () => {
    const sub = await freshSub('plans-scan');
    const today = etSessionDate();
    // Stamped when the book ran `aggressive` (15% stop); the book has since flipped to `balanced` (9%).
    await stampPlan(pool, seedLedger(sub, 'aggressive', today), { symbol: 'FLIP', entryPrice: 100, source: 'scan', decisionId: null });
    await stampPlan(pool, seedLedger(sub, 'balanced', '2026-08-03', 5), { symbol: 'XPIR', entryPrice: 100, source: 'scan', decisionId: null });
    await stampPlan(pool, seedLedger(sub, 'balanced', today), { symbol: 'BRKD', entryPrice: 100, source: 'scan', decisionId: null });
    await stampPlan(pool, seedLedger(sub, 'balanced', today), { symbol: 'HELD', entryPrice: 90, source: 'scan', decisionId: null });
    process.env.TRADING_EXIT_PLANS = 'paper';
    try {
      const plan = await fire(sub);
      const bySym = (s: string) => plan.filter((o) => o.symbol === s);
      // Posture flip: the planned name (-10%) holds on its stored 15% stop; its unplanned twin meets today's 9% and is stopped out.
      expect(bySym('FLIP')).toEqual([]);
      expect(bySym('FLOP').map((o) => (o.indicators as { reason?: string }).reason)).toEqual(['stop_loss']);
      expect((await plans(sub, 'FLIP'))[0]).toMatchObject({ status: 'open', posture: 'aggressive', stop_loss_pct: '15.0000', stop_price: '85.0000' });
      // Expiry door: the decision names the door and the plan; the plan closes with that decision.
      const [xp] = bySym('XPIR');
      const xpPlan = (await plans(sub, 'XPIR'))[0];
      expect(xp).toMatchObject({ side: 'sell', qty: 1, source: 'position-plan', indicators: { reason: 'plan-expiry', planId: xpPlan.plan_id } });
      expect(xpPlan).toMatchObject({ status: 'closed', closed_by_door: 'plan-expiry', closed_decision_id: xp.decisionId });
      // Event door: the breakdown exits early and the ledger records WHICH door fired vs the plan.
      const [bd] = bySym('BRKD');
      expect((await plans(sub, 'BRKD'))[0]).toMatchObject({ status: 'closed', closed_by_door: 'breakdown', closed_decision_id: bd.decisionId });
      // Fresh buys stamp fresh plans under their own decisions; the beta core never gets one.
      for (const s of ['HOTA', 'HOTB']) {
        const [buy] = bySym(s);
        expect((await plans(sub, s))[0], s).toMatchObject({ status: 'open', source: 'scan', decision_id: buy.decisionId, posture: 'balanced', entry_price: `${h.PRICE[s]}.0000` });
        expect((await plans(sub, s))[0].expiry_session.toISOString().slice(0, 10)).toBe(addSessions(today, 20));
      }
      expect(await plans(sub, 'SPY')).toEqual([]);
      // A held name with a fresh buy signal re-earns its plan at today's price with a new clock.
      expect((await plans(sub, 'HELD')).map((r) => [r.status, r.entry_price, r.source])).toEqual([
        ['superseded', '90.0000', 'scan'], ['open', '95.0000', 'scan-reunderwrite'],
      ]);
      // An unplanned name keeps the global rules: LOSR is stopped out and no plan appears for it.
      expect(bySym('LOSR').map((o) => (o.indicators as { reason?: string }).reason)).toEqual(['stop_loss']);
      expect(await plans(sub, 'LOSR')).toEqual([]);
    } finally { delete process.env.TRADING_EXIT_PLANS; }
  }, 180_000);

  it('rotation fire: rotation buys carry fresh plans; a drop-out sell closes its plan with door rotation', async () => {
    const sub = await freshSub('plans-rot');
    await stampPlan(pool, seedLedger(sub, 'balanced', etSessionDate()), { symbol: 'COLD', entryPrice: 100, source: 'scan', decisionId: null });
    process.env.TRADING_EXIT_PLANS = 'paper';
    try {
      const plan = await fire(sub, { rotation: true });
      const rotBuys = plan.filter((o) => o.source === 'gravity-rotation' && o.side === 'buy');
      // HELD is a held leader under its goal: its top-up is a buy too, and re-stamps its plan like any entry.
      expect(rotBuys.map((o) => o.symbol)).toEqual(['HOTA', 'INFL', 'HELD', 'HOTB']);
      for (const b of rotBuys) expect((await plans(sub, b.symbol))[0], b.symbol).toMatchObject({ status: 'open', source: 'rotation', decision_id: b.decisionId });
      const drop = plan.find((o) => o.symbol === 'COLD' && o.source === 'gravity-rotation');
      expect((await plans(sub, 'COLD'))[0]).toMatchObject({ status: 'closed', closed_by_door: 'rotation', closed_decision_id: drop?.decisionId });
    } finally { delete process.env.TRADING_EXIT_PLANS; }
  }, 240_000);

  it('an UNARMED fire writes no plan row at all', async () => {
    const sub = await freshSub('plans-off');
    const plan = await fire(sub);
    expect(sides(plan, 'buy')).toEqual(['SPY', 'HOTA', 'HOTB']);
    expect(Number((await pool.query('SELECT count(*)::int AS n FROM oshal_trading_position_plans WHERE user_sub = $1', [sub])).rows[0].n)).toBe(0);
  }, 180_000);
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GOLDEN DISPATCH PLAN characterization for the trading-schedule-dispatch decomposition (zero-behavior-change proof). Written and made green against the UNSPLIT module first; the split tree must reproduce it byte-for-byte. Drives ONE real `dispatchTradingSchedule` fire per configuration — (a) the PAPER scan sleeve (exits → breakdown → 2b technical sells → 2c benches → 2d entries), (b) the PAPER rotation sleeve (rotateSleeve with the entry guard refusing a gap-down leader) and (c) the legacy LIVE book under the double opt-in with TRADING_CAPITAL_CAP_USD armed (refused without the opt-in; then the same rotation fire sized off the CAPPED snapshot: capAccount's LEAST(env, book cap) headroom math, confirm=true on every order, requestId `auto-live-…`, the daily-equity store keeping the UNCAPPED truth while the equity-HWM store sees the capped equity) — against the REAL Postgres stores (books, signals, decisions, orders, peaks, daily-equity, equity-HWM, rotation-state, pinned lots) with the venue adapter (placeOrder THROWS — no venue call is possible), market data, the multi-timeframe scan, reconcile and placeDecisionOrder doubled OUTSIDE that boundary. Asserts the explicit ORDERED plan from the placeDecisionOrder recorder (requestId shape minus the minute bucket, confirm flag, book ref), the persisted signal→decision rows joined back by the recorder's decision_id (never by created_at — sub-ms ties reorder), that freeStaleSells cancels the stop-hit name's stale working sell but never a `<sub>:lot-…` client_order_id, and that a leg-module log line still carries module 'trading-schedule-dispatch'. Fails loud when the DB is down (the trading-books-schema.spec.ts shape), and afterAll fails loud when any spec row is left behind (a renamed table/column must not leak rows into the operator DB silently).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Residue-proof + load-proof: the two rotation fires (two full rotations with the real 6s settle and 1.5s cancel wait) got 180s budgets after a 60s budget timed out on a busy box; every fire's promise is tracked so afterAll AWAITS an abandoned run (bounded by SETTLE_MS) before it deletes, so the cleanup assertion can no longer race a still-writing fire; beforeAll sweeps the residue of earlier `spec-golden-` runs first (the sub now carries the run start time, so a sub younger than STALE_MS — a concurrent instance of this spec — is never swept), so rows a killed run left behind are cleared on the next run instead of accumulating in the operator DB; and the schema bootstrap retries once past the repo-wide concurrent-CREATE trigger race.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import type { AppContext } from '../../src/app/composition/app-context';
import type { MtfDecision, Position, BrokerAccount, DatedClose, MarketDataSource, TimeframeView } from '../../src/features/trading';

/* ── env pins (hoisted: the dispatch module reads several TRADING_* values at IMPORT time) ───────── */
const h = vi.hoisted(() => {
  // `t<base36 ms>-<hex>`: the embedded start time is what lets the residue sweep delete only runs
  // that are long finished, never a spec instance running beside this one.
  const RUN = `t${Date.now().toString(36)}-${require('crypto').randomUUID().slice(0, 8)}` as string;
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
  pin('SESSION_SECRET', process.env.SESSION_SECRET || `spec-secret-${RUN}`);

  /* ── fixtures ─────────────────────────────────────────────────────────────────────────────── */
  /** Last close == the quoted price; strong names ramp UP into it, weak names fall INTO it. */
  const PRICE: Record<string, number> = { SPY: 500, LOSR: 88, BRKD: 102, SELL: 52, COLD: 101, HOTA: 50, HOTB: 20, INFL: 30, GAPD: 100 };
  const STRONG = new Set(['HOTA', 'HOTB', 'INFL', 'GAPD']);
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
    mtf('BRKD', 'hold', -0.5, 0.6, [tf('5Min', 'sell', -0.6), tf('1Hour', 'sell', -0.5), tf('1Day', 'hold', 0.1)]),   // short-timeframe breakdown
    mtf('SELL', 'sell', -0.4, 0.5, [tf('5Min', 'sell', -0.2), tf('1Hour', 'hold', 0), tf('1Day', 'sell', -0.5)]),      // technical sell (not a breakdown)
    mtf('COLD', 'hold', 0.05, 0.2, [tf('5Min', 'hold', 0.05), tf('1Hour', 'hold', 0.05), tf('1Day', 'hold', 0.05)]),  // cold starter → benched
    mtf('HOTA', 'buy', 0.6, 0.7, [tf('5Min', 'buy', 0.3), tf('1Hour', 'buy', 0.6), tf('1Day', 'buy', 0.7)]),
    mtf('HOTB', 'buy', 0.45, 0.5, [tf('5Min', 'buy', 0.2), tf('1Hour', 'buy', 0.4), tf('1Day', 'buy', 0.5)]),
    mtf('INFL', 'buy', 0.5, 0.6, [tf('5Min', 'buy', 0.2), tf('1Hour', 'buy', 0.5), tf('1Day', 'buy', 0.6)]),          // has a WORKING buy → no entry
    mtf('GAPD', 'hold', 0.1, 0.3, [tf('5Min', 'hold', 0.1), tf('1Hour', 'hold', 0.1), tf('1Day', 'buy', 0.3)]),      // rotation leader gapped -15%
  ];
  const pos = (symbol: string, qty: number, avgEntryPrice: number): Position => {
    const currentPrice = PRICE[symbol];
    return { symbol, qty, avgEntryPrice, marketValue: qty * currentPrice, unrealizedPl: qty * (currentPrice - avgEntryPrice), currentPrice };
  };
  const POSITIONS: Position[] = [pos('SPY', 40, 480), pos('LOSR', 50, 100), pos('BRKD', 30, 100), pos('SELL', 20, 50), pos('COLD', 10, 100)];
  const ACCOUNT: BrokerAccount = { cash: 40_000, buyingPower: 40_000, equity: 100_000, currency: 'USD' };
  /** The gap-down leader: quoted 15% under its prior close so the rotation entry guard refuses it. */
  const LATEST: Record<string, number> = { ...PRICE, GAPD: 85 };

  const rec = { orders: [] as Array<{ decisionId: string; requestId: string; confirm: boolean; bookRef: string }>, canceled: [] as string[], logs: [] as Array<{ module: string; level: string; msg: string }> };
  const broker = {
    mode: () => 'paper', configured: () => true,
    getPositions: async () => POSITIONS.map((p) => ({ ...p })),
    getAccount: async () => ({ ...ACCOUNT }),
    cancelOrder: async (id: string) => { rec.canceled.push(id); },
    placeOrder: async () => { throw new Error('golden spec: every order must route through placeDecisionOrder (recorded)'); },
    getOrder: async () => { throw new Error('golden spec: getOrder not expected'); },
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
  return { RUN, saved, PRICE, LATEST, SCAN, POSITIONS, ACCOUNT, closesOf, rec, broker, source };
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
    latestPrice: async (symbol: string) => h.LATEST[symbol.toUpperCase()] ?? null,
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
    placeDecisionOrder: async (_pool: unknown, _sub: string, book: { ref: string }, decisionId: string, requestId: string, confirm: boolean) => {
      h.rec.orders.push({ decisionId, requestId, confirm, bookRef: book.ref });
      return { status: 'accepted', id: `fake-${h.rec.orders.length}` };
    },
  };
});

vi.mock('@/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/logger')>();
  return {
    ...actual,
    createChildLogger: (bindings: Record<string, unknown>) => {
      const real = actual.createChildLogger(bindings as never);
      const wrapped = Object.create(real);
      for (const level of ['info', 'warn', 'error'] as const) {
        wrapped[level] = (...args: unknown[]) => {
          const msg = typeof args[args.length - 1] === 'string' ? String(args[args.length - 1]) : '';
          h.rec.logs.push({ module: String(bindings.module), level, msg });
          return (real[level] as (...a: unknown[]) => unknown).apply(real, args);
        };
      }
      return wrapped;
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

const DSN = process.env.OSHAL_TEST_DSN
  || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const SUB_SCAN = `spec-golden-${h.RUN}-scan`;
const SUB_ROT = `spec-golden-${h.RUN}-rot`;
const SUB_LIVE = `spec-golden-${h.RUN}-live`;
const SUBS = [SUB_SCAN, SUB_ROT, SUB_LIVE];
const UNIVERSE = ['SPY', 'LOSR', 'BRKD', 'SELL', 'COLD', 'HOTA', 'HOTB', 'INFL', 'GAPD'];
/** Every table a fire (or the seed) writes under the spec subs — FK order: orders → decisions → signals. */
const SPEC_TABLES = ['oshal_trading_orders', 'oshal_trading_decisions', 'oshal_trading_signals', 'oshal_trading_peaks', 'oshal_trading_daily_equity',
  'oshal_trading_equity_hwm', 'oshal_trading_rotation_state', 'oshal_trading_gate_blocks', 'oshal_trading_pinned_lots', 'trading_config_overrides', 'oshal_trading_books'];
/** The live cap under test: below the fixture's 100K equity, above its 60K positions value, so headroom (20K) is non-zero. */
const LIVE_CAP_USD = '80000';

let pool: Pool;
/** Every dispatch promise this file starts; afterAll waits on them so cleanup cannot race a live fire. */
const inFlight = new Set<Promise<unknown>>();
/** Upper bound on that wait — past it the next run's beforeAll sweep is the backstop. */
const SETTLE_MS = 90_000;
/** A `spec-golden-` sub older than this is residue, not a spec instance running beside this one. */
const STALE_MS = 30 * 60_000;
const tickets: Array<{ title: string }> = [];
const ctx = () => ({ pool, ticketService: { createTicket: async (t: { title: string }) => { tickets.push(t); return {}; } } } as unknown as AppContext);

beforeAll(async () => {
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(`trading-dispatch-golden-plan requires the live oshal Postgres at ${DSN.replace(/:[^:@/]+@/, ':***@')} — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  for (const ensure of [ensureBooksSchema, ensureTradingSchema, ensureEquityGuardTable, ensureGateBlockTable,
    ensurePeaksTable, ensureDailyEquityTable, ensureRotationStateTable, ensurePinnedLotsSchema]) {
    await bootstrapOnce(ensure as (p: never) => Promise<unknown>);
  }
  // trading_config_overrides is created lazily by getActiveOverride on the first fire (null override).
  await sweepGoldenResidue();
  await seedWorkingOrders(SUB_SCAN, 'paper');
  await seedWorkingOrders(SUB_ROT, 'paper');
  await seedWorkingOrders(SUB_LIVE, 'live');
}, 120_000);

afterAll(async () => {
  try {
    // A test that timed out left its fire RUNNING: wait for it (bounded) before deleting, or the
    // COUNT(*)=0 assertion below passes while the abandoned run is still inserting rows.
    if (inFlight.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => { timer = setTimeout(resolve, SETTLE_MS); }),
      ]);
      if (timer) clearTimeout(timer);
    }
    // FAIL LOUD: a delete that throws (renamed table/column) or leaves rows behind is a spec defect,
    // never a silent leak into the operator's DB.
    for (const t of SPEC_TABLES) await pool.query(`DELETE FROM ${t} WHERE user_sub = ANY($1::text[])`, [SUBS]);
    for (const t of SPEC_TABLES) {
      const n = (await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_sub = ANY($1::text[])`, [SUBS])).rows[0].n;
      expect(n, `${t} still holds spec rows after cleanup`).toBe(0);
    }
  } finally {
    await pool.end();
    for (const [k, v] of Object.entries(h.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}, SETTLE_MS + 60_000);

/** Run one schema bootstrap, retrying ONCE past the repo-wide concurrent-CREATE race (two DB specs
 *  bootstrapping the same trading schema race on `CREATE TRIGGER`, which Postgres reports as
 *  "already exists" — the object is there, so a single retry is enough).
 * @description Bootstrap a trading table/schema idempotently under a concurrent create.
 * @param ensure - The ensure* function to run against the spec pool.
 * @returns Nothing; throws when the retry fails too, or when the failure is not the create race. */
async function bootstrapOnce(ensure: (p: never) => Promise<unknown>): Promise<void> {
  try {
    await ensure(pool as never);
  } catch (error) {
    if (!/already exists/i.test((error as Error).message)) throw error;
    await ensure(pool as never);
  }
}

/** Delete the residue of EARLIER runs of this spec, not just this run's subs: a killed or timed-out
 *  run cannot clean up after itself, and its rows are live-shaped rows sitting in the operator's
 *  database. Only this spec ever writes the `spec-golden-` prefix, and the sub carries the run's start
 *  time (`spec-golden-t<base36 ms>-…`), so a sub younger than STALE_MS — i.e. a second instance of this
 *  spec running right now — is left alone. Subs in the older nonce-only shape are always swept.
 * @description Clear residue left by any earlier, finished run of this spec before seeding.
 * @returns Nothing. */
async function sweepGoldenResidue(): Promise<void> {
  const subs = new Set<string>();
  for (const t of SPEC_TABLES) {
    const r = await pool.query(`SELECT DISTINCT user_sub FROM ${t} WHERE user_sub LIKE 'spec-golden-%'`);
    for (const row of r.rows) subs.add(String(row.user_sub));
  }
  const stale = [...subs].filter((sub) => {
    const m = /^spec-golden-t([0-9a-z]+)-/.exec(sub);
    if (!m) return true;                                   // pre-timestamp shape → always residue
    const started = parseInt(m[1], 36);
    return !Number.isFinite(started) || Date.now() - started > STALE_MS;
  });
  if (!stale.length) return;
  for (const t of SPEC_TABLES) await pool.query(`DELETE FROM ${t} WHERE user_sub = ANY($1::text[])`, [stale]);
}

/** Seed still-WORKING ledger rows through the real FK chain (signal → decision → order) into the legacy
 *  book of `mode`: the stop-hit name's stale autopilot sell (must be canceled), a protected lot's sell on
 *  the same name (must NOT be), and a pending BUY on INFL (in-flight → excluded from entries, notional reserved). */
async function seedWorkingOrders(sub: string, mode: 'paper' | 'live'): Promise<void> {
  const book = legacyBook(sub, mode);
  const rows: Array<{ sym: string; side: 'buy' | 'sell'; qty: number; px: number | null; brokerId: string; clientId: string }> = [
    { sym: 'LOSR', side: 'sell', qty: 50, px: 95, brokerId: `brk-stale-${sub}`, clientId: `${sub}:auto-${mode}-2026-01-02T09:35-LOSR-sell` },
    { sym: 'LOSR', side: 'sell', qty: 5, px: 120, brokerId: `brk-lot-${sub}`, clientId: `${sub}:lot-${crypto.randomUUID().slice(0, 8)}-tp-1` },
    { sym: 'INFL', side: 'buy', qty: 10, px: 30, brokerId: `brk-infl-${sub}`, clientId: `${sub}:auto-${mode}-2026-01-02T09:35-INFL-buy` },
  ];
  for (const r of rows) {
    const sig = (await pool.query(
      `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, title, body, symbols, indicators, content_hash)
         VALUES ($1,$2,$3,'spec-seed',$4,'seed',$5,'{}',$6) RETURNING signal_id`,
      [sub, mode, book.bookId, `${r.sym} ${r.side}`, [r.sym], crypto.randomUUID()])).rows[0];
    const dec = (await pool.query(
      `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, confidence, rationale, indicators, guardrails)
         VALUES ($1,$2,$3,$4::uuid[],'spec-seed',$5,$6,$5,$7,'limit',1,'seeded working order','{}','{}') RETURNING decision_id`,
      [sub, mode, book.bookId, [sig.signal_id], r.side, r.sym, r.qty])).rows[0];
    await pool.query(
      `INSERT INTO oshal_trading_orders (user_sub, mode, book_id, decision_id, broker, broker_order_id, client_order_id, symbol, side, qty, order_type, limit_price, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'limit',$11,'pending')`,
      [sub, mode, book.bookId, dec.decision_id, mode === 'live' ? 'schwab' : 'alpaca', r.brokerId, r.clientId, r.sym, r.side, r.qty, r.px]);
  }
}

/** One autopilot fire for `sub` on its legacy `mode` book, returning the ordered plan: recorder calls + their persisted rows. */
async function fire(sub: string, mode: 'paper' | 'live' = 'paper'): Promise<{ result: unknown; calls: Array<Record<string, unknown>>; rows: Array<Record<string, unknown>>; canceled: string[] }> {
  h.rec.orders.length = 0; h.rec.canceled.length = 0; h.rec.logs.length = 0; tickets.length = 0;
  // Tracked so afterAll can WAIT for a fire this test abandoned (a vitest timeout kills the await,
  // not the run) — otherwise the cleanup DELETE races rows the abandoned fire is still writing.
  const run = dispatchTradingSchedule(ctx(), {
    id: `spec-golden-${h.RUN}`, taskType: `trading-autopilot:${sub}`, taskData: { userSub: sub, mode, universe: UNIVERSE },
  } as never);
  inFlight.add(run);
  const result = await run;
  const minute = new RegExp(`^auto-${mode}-\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}-`);
  const calls = h.rec.orders.map((o) => ({ requestId: o.requestId.replace(minute, `auto-${mode}-<min>-`), confirm: o.confirm, bookRef: o.bookRef }));
  const rows: Array<Record<string, unknown>> = [];
  for (const o of h.rec.orders) {
    const r = (await pool.query(
      `SELECT d.symbol, d.side, d.qty::float8 AS qty, d.agent_id, s.source, d.rationale
         FROM oshal_trading_decisions d JOIN oshal_trading_signals s ON s.signal_id = d.signal_ids[1]
        WHERE d.decision_id = $1 AND d.user_sub = $2 AND d.book_id = $3`, [o.decisionId, sub, legacyBook(sub, mode).bookId])).rows[0];
    rows.push(r);
  }
  return { result, calls, rows, canceled: [...h.rec.canceled] };
}

const CORE_BUY = { symbol: 'SPY', side: 'buy', qty: 30, agent_id: 'mtf-autopilot', source: 'beta-core', rationale: 'Beta core — deploying idle cash into SPY for market exposure; held as a core (the sleeve never sells it).' };
const STOP_SELL = { symbol: 'LOSR', side: 'sell', qty: 50, agent_id: 'mtf-autopilot', source: 'risk-exit', rationale: 'Risk exit (stop_loss) — position P&L -12.0%.' };
const BREAKDOWN_SELL = { symbol: 'BRKD', side: 'sell', qty: 30, agent_id: 'mtf-autopilot', source: 'mtf-breakdown', rationale: 'Protective exit — short-timeframe breakdown (5Min:-0.60, 1Hour:-0.50) while regime 0.30 still up.' };
/** placeManaged's contract per book: legacy ref = the mode, confirm ONLY for live (placeDecisionOrder's 428 gate). */
const call = (sym: string, side: 'buy' | 'sell', mode: 'paper' | 'live' = 'paper') => ({ requestId: `auto-${mode}-<min>-${sym}-${side}`, confirm: mode === 'live', bookRef: mode });

describe('golden dispatch plan — scan sleeve (TRADING_SLEEVE_ROTATION unset)', () => {
  it('places exactly this ordered plan and persists exactly these signal→decision rows', async () => {
    delete process.env.TRADING_SLEEVE_ROTATION;
    const p = await fire(SUB_SCAN);
    expect(p.result).toMatchObject({ success: true, taskId: `autopilot-spec-golden-${h.RUN}` });
    // 0 core top-up → 1 protective stop → 2a breakdown → 2b technical sell → 2c benches (none: the
    // coldest-first slice is filled by names already exiting) → 2d entries (INFL excluded: working buy;
    // HOTA/HOTB sized to the sector-cap room left beside the SPY core, 990 USD).
    expect(p.calls).toEqual([
      call('SPY', 'buy'), call('LOSR', 'sell'), call('BRKD', 'sell'), call('SELL', 'sell'), call('HOTA', 'buy'), call('HOTB', 'buy'),
    ]);
    expect(p.rows).toEqual([
      CORE_BUY, STOP_SELL, BREAKDOWN_SELL,
      { symbol: 'SELL', side: 'sell', qty: 20, agent_id: 'mtf-autopilot', source: 'mtf-autopilot', rationale: 'fixture SELL sell' },
      { symbol: 'HOTA', side: 'buy', qty: 19, agent_id: 'mtf-autopilot', source: 'mtf-autopilot', rationale: 'fixture HOTA buy' },
      { symbol: 'HOTB', side: 'buy', qty: 49, agent_id: 'mtf-autopilot', source: 'mtf-autopilot', rationale: 'fixture HOTB buy' },
    ]);
    // freeStaleSells: the stop-hit name's stale autopilot sell is canceled; the protected lot's is not; the INFL buy is not a sell.
    expect(p.canceled).toEqual([`brk-stale-${SUB_SCAN}`]);
    const n = (await pool.query('SELECT count(*)::int AS n FROM oshal_trading_decisions WHERE user_sub=$1 AND agent_id=$2', [SUB_SCAN, 'mtf-autopilot'])).rows[0].n;
    expect(n).toBe(p.calls.length);
    expect(tickets.map((t) => t.title)).toEqual(['🤖 Autopilot: 3 buy · 3 exit · 8 scanned [paper/balanced]']);
    expect(h.rec.logs).toContainEqual({ module: 'trading-schedule-dispatch', level: 'info', msg: 'stale working sell canceled so the exit can re-price' });
  }, 120_000);
});

describe('golden dispatch plan — rotation sleeve (TRADING_SLEEVE_ROTATION=true)', () => {
  it('places exactly this ordered plan, refuses the gap-down leader, and logs through the shared module name', async () => {
    process.env.TRADING_SLEEVE_ROTATION = 'true';
    try {
      const p = await fire(SUB_ROT);
      expect(p.result).toMatchObject({ success: true, taskId: `autopilot-spec-golden-${h.RUN}` });
      // 0 core top-up → 1 protective stop → 1b rotation (drop-out sells for every held name off the
      // leaderboard — LOSR a second time, the HOLD set is deliberately unguarded — then guarded buys
      // strongest-first; GAPD refused at -15%) → 2a breakdown (BRKD again: rotation's sell is not in `exiting`).
      const ROT_SELL = (symbol: string, qty: number) => ({ symbol, side: 'sell', qty, agent_id: 'mtf-autopilot', source: 'gravity-rotation', rationale: 'Rotation (blend) — dropped out of the top 13; rotating capital to stronger names.' });
      const ROT_BUY = (symbol: string, qty: number) => ({ symbol, side: 'buy', qty, agent_id: 'mtf-autopilot', source: 'gravity-rotation', rationale: 'Rotation (blend/conviction) — size into top-13 at target weight ($5000; score 1.00).' });
      expect(p.calls).toEqual([
        call('SPY', 'buy'), call('LOSR', 'sell'), call('LOSR', 'sell'), call('BRKD', 'sell'), call('SELL', 'sell'), call('COLD', 'sell'),
        call('HOTA', 'buy'), call('INFL', 'buy'), call('HOTB', 'buy'), call('BRKD', 'sell'),
      ]);
      expect(p.rows).toEqual([
        CORE_BUY, STOP_SELL, ROT_SELL('LOSR', 50), ROT_SELL('BRKD', 30), ROT_SELL('SELL', 20), ROT_SELL('COLD', 10),
        ROT_BUY('HOTA', 100), ROT_BUY('INFL', 166), ROT_BUY('HOTB', 250), BREAKDOWN_SELL,
      ]);
      expect(p.canceled).toEqual([`brk-stale-${SUB_ROT}`]);
      expect(tickets.map((t) => t.title)).toEqual(['🤖 Autopilot: 4 buy · 6 exit · 8 scanned [paper/balanced]']);
      // The entry guard's refusal is a LEG-module log line (rotation) — it must still carry the shared module name.
      expect(h.rec.logs).toContainEqual({ module: 'trading-schedule-dispatch', level: 'info', msg: 'rotation entry guard refused candidates' });
      const rot = (await pool.query('SELECT count(*)::int AS n FROM oshal_trading_rotation_state WHERE user_sub=$1', [SUB_ROT])).rows[0].n;
      expect(rot).toBe(1);
    } finally {
      delete process.env.TRADING_SLEEVE_ROTATION;
    }
  }, 180_000);
});

describe('golden dispatch plan — legacy LIVE book (double opt-in + TRADING_CAPITAL_CAP_USD, rotation sleeve)', () => {
  const LIVE_BOOK = () => legacyBook(SUB_LIVE, 'live');

  it('refuses the live schedule without BOTH opt-ins — nothing is persisted or placed', async () => {
    process.env.TRADING_LIVE_ENABLED = 'true'; // one of the two is not enough
    try {
      const p = await fire(SUB_LIVE, 'live');
      expect(p.result).toEqual({ success: false, scheduleId: `spec-golden-${h.RUN}`, error: 'autopilot live is disabled; set TRADING_LIVE_ENABLED=true AND TRADING_AUTOPILOT_LIVE=true to arm it' });
      expect(p.calls).toEqual([]);
      expect(p.canceled).toEqual([]);
      const n = (await pool.query('SELECT count(*)::int AS n FROM oshal_trading_decisions WHERE user_sub=$1 AND agent_id=$2', [SUB_LIVE, 'mtf-autopilot'])).rows[0].n;
      expect(n).toBe(0);
    } finally {
      delete process.env.TRADING_LIVE_ENABLED;
    }
  }, 30_000);

  it('places the rotation plan sized off the CAPPED snapshot, confirm=true on every order, requestId auto-live-…', async () => {
    process.env.TRADING_LIVE_ENABLED = 'true';
    process.env.TRADING_AUTOPILOT_LIVE = 'true';
    process.env.TRADING_CAPITAL_CAP_USD = LIVE_CAP_USD;
    process.env.TRADING_SLEEVE_ROTATION = 'true';
    try {
      const p = await fire(SUB_LIVE, 'live');
      expect(p.result).toMatchObject({ success: true, taskId: `autopilot-spec-golden-${h.RUN}` });
      // capAccount (live only): equity 100K → 80K; positions value 60K → cash headroom 20K. Every sizing
      // site below reads that snapshot (rotation's post-settle re-read is re-capped too):
      //  core  35% × 80K = 28K target − 20K held = 8K → 16 SPY   (paper: 30)
      //  rotation per-name 5% × 80K = $4,000 goals → HOTA 80 · INFL 133 · HOTB 200   (paper: 100 / 166 / 250)
      // Same ORDER as the paper rotation plan; only the sizes move with the cap.
      const L = (sym: string, side: 'buy' | 'sell') => call(sym, side, 'live');
      expect(p.calls).toEqual([
        L('SPY', 'buy'), L('LOSR', 'sell'), L('LOSR', 'sell'), L('BRKD', 'sell'), L('SELL', 'sell'), L('COLD', 'sell'),
        L('HOTA', 'buy'), L('INFL', 'buy'), L('HOTB', 'buy'), L('BRKD', 'sell'),
      ]);
      for (const c of p.calls) expect(c).toMatchObject({ confirm: true, bookRef: 'live' });
      const ROT_SELL = (symbol: string, qty: number) => ({ symbol, side: 'sell', qty, agent_id: 'mtf-autopilot', source: 'gravity-rotation', rationale: 'Rotation (blend) — dropped out of the top 13; rotating capital to stronger names.' });
      const ROT_BUY = (symbol: string, qty: number) => ({ symbol, side: 'buy', qty, agent_id: 'mtf-autopilot', source: 'gravity-rotation', rationale: 'Rotation (blend/conviction) — size into top-13 at target weight ($4000; score 1.00).' });
      expect(p.rows).toEqual([
        { ...CORE_BUY, qty: 16 }, STOP_SELL, ROT_SELL('LOSR', 50), ROT_SELL('BRKD', 30), ROT_SELL('SELL', 20), ROT_SELL('COLD', 10),
        ROT_BUY('HOTA', 80), ROT_BUY('INFL', 133), ROT_BUY('HOTB', 200), BREAKDOWN_SELL,
      ]);
      expect(p.canceled).toEqual([`brk-stale-${SUB_LIVE}`]);
      expect(tickets.map((t) => t.title)).toEqual(['🤖 Autopilot: 4 buy · 6 exit · 8 scanned [live/balanced]']);
      // The two equity stores prove the cap is applied in the right place: the daily-equity store keeps
      // the REAL (uncapped) equity — recordDailyEquity runs BEFORE capAccount (SEQ 5) — while the equity
      // guard's high-water mark is the CAPPED equity every sizing site saw.
      const daily = (await pool.query('SELECT equity::float8 AS equity FROM oshal_trading_daily_equity WHERE user_sub=$1 AND book_id=$2', [SUB_LIVE, LIVE_BOOK().bookId])).rows;
      expect(daily).toEqual([{ equity: 100_000 }]);
      const hwm = (await pool.query('SELECT high_water_mark::float8 AS hwm, last_equity::float8 AS last FROM oshal_trading_equity_hwm WHERE user_sub=$1 AND book_id=$2', [SUB_LIVE, LIVE_BOOK().bookId])).rows;
      expect(hwm).toEqual([{ hwm: 80_000, last: 80_000 }]);
      // Every persisted row of the live fire is on the LIVE legacy book (mode + book_id), none on paper.
      const byBook = (await pool.query(
        `SELECT mode, book_id, count(*)::int AS n FROM oshal_trading_decisions WHERE user_sub=$1 AND agent_id='mtf-autopilot' GROUP BY mode, book_id`, [SUB_LIVE])).rows;
      expect(byBook).toEqual([{ mode: 'live', book_id: LIVE_BOOK().bookId, n: p.calls.length }]);
    } finally {
      delete process.env.TRADING_LIVE_ENABLED;
      delete process.env.TRADING_AUTOPILOT_LIVE;
      delete process.env.TRADING_CAPITAL_CAP_USD;
      delete process.env.TRADING_SLEEVE_ROTATION;
    }
  }, 180_000);
});

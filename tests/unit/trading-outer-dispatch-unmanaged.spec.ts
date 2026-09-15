/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-159 at the OUTER dispatch boundary. The PR #486 closure enumerated the order-emitting paths reachable from dispatchTradingSchedule/runAutopilot; the swing sleeve and the research/fast brain are separate ScheduleService branches over the SAME book and reached neither the unmanaged mark nor TRADING_CORE_SYMBOLS. This spec drives the REAL dispatchTradingSwing and dispatchTradingResearch over a book whose ledger covers only half its positions and asserts no order reaches the uncovered half, while a COVERED twin of identical shape in the same book DOES get its order — so a fire that simply did nothing cannot pass. A ring-fenced name (TRADING_CORE_SYMBOLS, the fence protecting USO on the live book) is asserted separately from the unmanaged case so the two gates cannot cover for each other. The swing file also carries the INVERSION case: an uncovered holding whose closes are a breakout, which the correct nesting withholds entirely and a withhold folded into the `qtyHeld > 0` test would turn into a BUY. Runs against a DISPOSABLE PostgreSQL container — a deployment database is never read or written.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { AppContext } from '../../src/app/composition/app-context';
import type { Position, BrokerAccount, NewsItem } from '../../src/features/trading';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

/* ── fixtures (hoisted: both dispatchers read TRADING_ and SWING_ values at IMPORT time) ───────────── */
const h = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {};
  const pin = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  // The operator box has several of these armed; the spec must not inherit the shell.
  for (const k of [
    'SWING_ENTRY_N', 'SWING_EXIT_N', 'SWING_ALLOC_PCT', 'SWING_MAX_NAMES', 'TRADING_HALT',
    'TRADING_WORLD_SIGNALS', 'ENABLE_WORLD_INTELLIGENCE', 'TRADING_EXT_SIZE_MULT', 'TRADING_SYMBOL_BLOCKLIST',
    'TRADING_LIVE_ENABLED', 'TRADING_CAPITAL_CAP_USD', 'TRADING_MULTI_ACCOUNT', 'TRADING_CORE_TARGET_PCT',
  ]) pin(k, undefined);
  pin('TRADING_MAX_NOTIONAL_USD', '50000');
  pin('TRADING_MAX_QTY', '100000');
  pin('TRADING_RISK_POSTURE', 'balanced');
  // The ring-fence under test. `:0` is the operator's exemption shape — held, never bought, never
  // sleeve-sold. USO and SKHY are the live book's REAL fenced names, so the fixture uses them.
  pin('TRADING_CORE_SYMBOLS', 'USO:0,SKHY:0');
  pin('SESSION_SECRET', process.env.SESSION_SECRET || `spec-secret-${require('crypto').randomUUID()}`);

  /** Donchian defaults the dispatcher reads at import: 20-day entry high, 10-day exit low. */
  const ENTRY_N = 20, EXIT_N = 10;
  const PRICE: Record<string, number> = { MSWG: 90, USWG: 90, USO: 70, UBKO: 110, MRES: 60, URES: 60, SKHY: 25 };
  /** Names whose close series RAMPS so the last close clears the 20-day high (a breakout entry). */
  const BREAKOUT = new Set(['UBKO']);
  /** 40 closes per name: a falling series ends under its own 10-day low (channel EXIT); a rising one
   *  ends over its 20-day high (breakout ENTRY). Both end exactly at the symbol's quoted PRICE. */
  const closesOf = (sym: string): number[] => {
    const p = PRICE[sym]; if (!p) return [];
    const out: number[] = [];
    for (let i = 0; i < 40; i++) out.push(Number((BREAKOUT.has(sym) ? p * (1 + 0.004 * (i - 39)) : p * (1 - 0.004 * (i - 39))).toFixed(4)));
    return out;
  };

  const pos = (symbol: string, qty: number, avgEntryPrice: number): Position => ({
    symbol, qty, avgEntryPrice, marketValue: qty * PRICE[symbol],
    unrealizedPl: qty * (PRICE[symbol] - avgEntryPrice), currentPrice: PRICE[symbol],
  });
  /* The book under test. Each UNCOVERED name is paired with a COVERED twin of the identical shape.
   *   MSWG/USWG — falling into a channel exit: the twin must sell, the uncovered one must not.
   *   USO       — falling the same way and fully COVERED, but ring-fenced: the fence alone withholds it.
   *   UBKO      — uncovered AND breaking OUT: the inversion case (withheld, never bought).
   *   MRES/URES — the research pair the analyst calls a sell.
   *   SKHY      — covered, ring-fenced, and the analyst calls it a sell too. */
  const POSITIONS: Position[] = [
    pos('MSWG', 50, 100), pos('USWG', 50, 100), pos('USO', 50, 100), pos('UBKO', 50, 100),
    pos('MRES', 40, 55), pos('URES', 40, 55), pos('SKHY', 40, 20),
  ];
  /** The names the engine's own ledger does NOT cover — the operator's hand-bought shares. */
  const UNCOVERED = ['USWG', 'UBKO', 'URES'];
  const ACCOUNT: BrokerAccount = { cash: 60_000, buyingPower: 60_000, equity: 100_000, currency: 'USD' };

  const rec = { orders: [] as string[] };
  const broker = {
    mode: () => 'paper', configured: () => true,
    getPositions: async () => POSITIONS.map((p) => ({ ...p })),
    getAccount: async () => ({ ...ACCOUNT }),
    cancelOrder: async () => {},
    placeOrder: async () => { throw new Error('spec: every order must route through placeDecisionOrder (recorded)'); },
    getOrder: async () => { throw new Error('spec: getOrder not expected'); },
    listOrders: async () => [],
  };
  /** One fresh headline per research name, so every one of them is analyzed on a fire. */
  const news = (symbol: string): NewsItem => ({
    id: `n-${symbol}`, headline: `${symbol} reports`, summary: `${symbol} summary`, source: 'spec',
    url: `https://example.invalid/${symbol}`, symbols: [symbol], at: new Date().toISOString(),
  } as unknown as NewsItem);
  return { saved, PRICE, POSITIONS, UNCOVERED, ACCOUNT, closesOf, rec, broker, news, ENTRY_N, EXIT_N };
});

vi.mock('@/features/trading', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/trading')>();
  return {
    ...actual,
    getBrokerAdapter: () => h.broker,
    getBrokerReader: () => h.broker,
    marketDataConfigured: () => true,
    tradableSession: async () => 'regular',
    dailyCloses: async (symbol: string, n = 60) => h.closesOf(symbol.toUpperCase()).slice(-n),
    latestPrice: async (symbol: string) => h.PRICE[symbol.toUpperCase()] ?? null,
    // Every research name carries one fresh headline; fundamentals are absent so the fixture's only
    // signal is the news row (captureSignals skips the fundamentals insert on null).
    recentNews: async (universe: string[]) => universe.map((s) => h.news(s.toUpperCase())),
    fundamentalsSummary: async () => null,
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
    // The analyst is replaced, not the persistence: a REAL decision row is written so the assertions
    // resolve each recorded order back through the same join production uses. Every name is a SELL —
    // the withheld ones must still place nothing.
    analyzeAndRecordDecision: async (c: { pool: Pool }, sub: string, mode: string, signals: Array<{ signal_id: string; symbols: string[] }>) => {
      const symbol = String(signals[0]?.symbols?.[0] ?? '').toUpperCase();
      const row = (await c.pool.query(
        `INSERT INTO oshal_trading_decisions (user_sub, mode, signal_ids, agent_id, action, symbol, side, qty, order_type, confidence, rationale, indicators, guardrails)
           VALUES ($1,$2,$3::uuid[],'spec-analyst','sell',$4,'sell',1,'market',0.8,'spec sell','{}','{}') RETURNING decision_id`,
        [sub, mode, signals.map((s) => s.signal_id), symbol])).rows[0];
      return { decisionId: row.decision_id, decision: { action: 'sell', symbol, confidence: 0.8 } };
    },
    placeDecisionOrder: async (_pool: unknown, _sub: string, _book: unknown, decisionId: string) => {
      h.rec.orders.push(decisionId);
      return { status: 'accepted', id: `fake-${h.rec.orders.length}` };
    },
  };
});

import { ensureBooksSchema, legacyBook } from '../../src/app/trading-books-store';
import { ensureTradingSchema } from '../../src/app/trading-engine';
import { dispatchTradingSwing } from '../../src/app/trading-swing-dispatch';
import { dispatchTradingResearch } from '../../src/app/trading-research-dispatch';

/** The swing sleeve's universe for this fire — the four Donchian names. */
const SWING_UNIVERSE = ['MSWG', 'USWG', 'USO', 'UBKO'];
/** The research brain's universe for this fire — the pair plus the ring-fenced name. */
const RESEARCH_UNIVERSE = ['MRES', 'URES', 'SKHY'];
/** The book whose ledger covers only the M-twins and the fenced names. */
const SUB = `spec-adr159-outer-${randomUUID().slice(0, 8)}`;

const CONTAINER = `oshal-adr159-outer-${randomUUID()}`;
let pool: Pool;
const tickets: Array<{ title: string }> = [];
const ctx = (): AppContext => ({
  pool, ticketService: { createTicket: async (t: { title: string }) => { tickets.push(t); return {}; } },
} as unknown as AppContext);

/** One recorded order, resolved back to the decision row the recorder's id points at. */
interface PlacedOrder { symbol: string; side: string; qty: number }

/** Docker argv is fixed apart from the generated fixture password; no inherited DSN is ever read. */
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
}

/**
 * @description Bring up a private PostgreSQL for this file and return a pool once it answers.
 * @returns The connected pool.
 */
async function startDisposablePostgres(): Promise<Pool> {
  const password = randomUUID();
  docker(['run', '--detach', '--rm', '--name', CONTAINER, '--label', 'oshal.test-fixture=trading-outer-dispatch',
    '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data', '--memory', '384m', '--cpus', '1',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=trading_fixture', 'postgres:16-alpine']);
  const published = docker(['port', CONTAINER, '5432/tcp']);
  const match = /127\.0\.0\.1:(\d+)/.exec(published);
  if (!match) throw new Error('disposable PostgreSQL must publish exactly one loopback port');
  const p = new Pool({ host: '127.0.0.1', port: Number(match[1]), user: 'postgres', password, database: 'trading_fixture', max: 6, statement_timeout: 30_000 });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try { await p.query('SELECT 1'); return p; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('disposable PostgreSQL did not become ready');
}

/**
 * @description Seed the engine's OWN filled BUY for `symbols`, exactly covering each venue quantity at
 * the venue's average price — exact coverage is what makes a position ACCOUNTED. A name left out is
 * what the operator bought by hand.
 * @param symbols - The position symbols to cover.
 * @returns Nothing.
 */
async function seedEngineFills(symbols: string[]): Promise<void> {
  const book = legacyBook(SUB, 'paper');
  for (const p of h.POSITIONS.filter((x) => symbols.includes(x.symbol))) {
    const sig = (await pool.query(
      `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, title, body, symbols, indicators, content_hash)
         VALUES ($1,'paper',$2,'spec-seed',$3,'seed',$4,'{}',$5) RETURNING signal_id`,
      [SUB, book.bookId, `${p.symbol} engine buy`, [p.symbol], randomUUID()])).rows[0];
    const dec = (await pool.query(
      `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, confidence, rationale, indicators, guardrails)
         VALUES ($1,'paper',$2,$3::uuid[],'spec-seed','buy',$4,'buy',$5,'market',1,'seeded engine fill','{}','{}') RETURNING decision_id`,
      [SUB, book.bookId, [sig.signal_id], p.symbol, p.qty])).rows[0];
    await pool.query(
      `INSERT INTO oshal_trading_orders (user_sub, mode, book_id, decision_id, broker, broker_order_id, client_order_id, symbol, side, qty, order_type, status, filled_qty, filled_avg_price)
         VALUES ($1,'paper',$2,$3,'alpaca',$4,$5,$6,'buy',$7,'market','filled',$7,$8)`,
      [SUB, book.bookId, dec.decision_id, `brk-fill-${p.symbol}`, `${SUB}:seed-fill-${p.symbol}`, p.symbol, p.qty, p.avgEntryPrice]);
  }
}

/**
 * @description Resolve every recorded order back to its persisted decision row.
 * @returns The ordered list of placed orders.
 */
async function resolvePlaced(): Promise<PlacedOrder[]> {
  const out: PlacedOrder[] = [];
  for (const decisionId of h.rec.orders) {
    const r = (await pool.query(
      'SELECT symbol, side, qty::float8 AS qty FROM oshal_trading_decisions WHERE decision_id = $1 AND user_sub = $2',
      [decisionId, SUB])).rows[0];
    out.push({ symbol: String(r.symbol), side: String(r.side), qty: Number(r.qty) });
  }
  return out;
}

/**
 * @description Drive ONE real swing fire and return the plan it placed.
 * @returns The ordered list of placed orders.
 */
async function fireSwing(): Promise<PlacedOrder[]> {
  h.rec.orders.length = 0; tickets.length = 0;
  await dispatchTradingSwing(ctx(), {
    id: `spec-swing-${SUB}`, taskType: `trading-swing:${SUB}`,
    taskData: { userSub: SUB, mode: 'paper', universe: SWING_UNIVERSE },
  } as never);
  return resolvePlaced();
}

/**
 * @description Drive ONE real research fire and return the plan it placed.
 * @returns The ordered list of placed orders.
 */
async function fireResearch(): Promise<PlacedOrder[]> {
  h.rec.orders.length = 0; tickets.length = 0;
  await dispatchTradingResearch(ctx(), {
    id: `spec-research-${SUB}`, taskType: `trading-research:${SUB}`,
    taskData: { userSub: SUB, mode: 'paper', universe: RESEARCH_UNIVERSE },
  } as never);
  return resolvePlaced();
}

/** The plan entries for one symbol, as `side×qty` strings — the shape the assertions compare. */
const forSymbol = (plan: PlacedOrder[], symbol: string): string[] =>
  plan.filter((o) => o.symbol === symbol).map((o) => `${o.side} ${o.qty}`);

/** The same reduction over several symbols, so ONE assertion reports EVERY leg that leaked rather
 *  than stopping at the first — a per-symbol loop hides the rest behind its first failure. */
const byLeg = (plan: PlacedOrder[], symbols: string[]): Record<string, string[]> =>
  Object.fromEntries(symbols.map((s) => [s, forSymbol(plan, s)]));

beforeAll(async () => {
  pool = await startDisposablePostgres();
  await ensureBooksSchema(pool as never);
  await ensureTradingSchema(pool as never);
  const covered = h.POSITIONS.map((p) => p.symbol).filter((s) => !h.UNCOVERED.includes(s));
  await seedEngineFills(covered);
});

afterAll(async () => {
  try { if (pool) await pool.end(); }
  finally {
    try { docker(['rm', '--force', CONTAINER]); } catch { /* the --rm container may already be gone */ }
    for (const [k, v] of Object.entries(h.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

describe('the swing sleeve withholds for a holding the engine cannot account for (ADR-159)', () => {
  it('sells the COVERED twin and places nothing at all for its uncovered pair', async () => {
    const plan = await fireSwing();
    // The covered twin proves the leg RAN and the fixture actually reaches the channel-exit rule —
    // without it an empty plan would pass this file vacuously.
    expect(forSymbol(plan, 'MSWG')).toEqual(['sell 50']);
    expect(byLeg(plan, ['USWG'])).toEqual({ USWG: [] });
  });

  it('places nothing for a TRADING_CORE_SYMBOLS name even though its ledger fully covers it', async () => {
    const plan = await fireSwing();
    // USO is COVERED — seedEngineFills included it — so only the ring-fence can be withholding it.
    // That separation is the point: neither gate may stand in for the other.
    expect(byLeg(plan, ['USO'])).toEqual({ USO: [] });
    expect(forSymbol(plan, 'MSWG')).toEqual(['sell 50']);
  });

  it('never BUYS the uncovered holding whose closes are a breakout — the withhold must not invert', async () => {
    const plan = await fireSwing();
    // UBKO is held, uncovered, and its last close clears its 20-day high. A withhold folded into the
    // `qtyHeld > 0` test would drop it into the entry branch and buy it; the nested withhold refuses
    // outright. This case is what makes the nesting load-bearing rather than stylistic.
    expect(byLeg(plan, ['UBKO'])).toEqual({ UBKO: [] });
    expect(plan.filter((o) => o.side === 'buy')).toEqual([]);
  });

  it('withholding only ever REMOVES orders — every order it still places is a covered name', async () => {
    const plan = await fireSwing();
    const uncovered = new Set(h.UNCOVERED);
    expect(plan.filter((o) => uncovered.has(o.symbol))).toEqual([]);
    expect(plan.length).toBeGreaterThan(0);
  });
});

describe('the research/fast brain withholds for a holding the engine cannot account for (ADR-159)', () => {
  it('closes the COVERED twin on the analyst sell and places nothing for its uncovered pair', async () => {
    const plan = await fireResearch();
    expect(forSymbol(plan, 'MRES')).toEqual(['sell 40']);
    expect(byLeg(plan, ['URES'])).toEqual({ URES: [] });
  });

  it('places nothing for a TRADING_CORE_SYMBOLS name the analyst calls a sell', async () => {
    const plan = await fireResearch();
    // SKHY is covered by the ledger and is a real fenced name on the live book (SKHY:0). It is
    // dropped from the universe before news is even fetched, so it is never analyzed and never traded.
    expect(byLeg(plan, ['SKHY'])).toEqual({ SKHY: [] });
    expect(forSymbol(plan, 'MRES')).toEqual(['sell 40']);
  });

  it('withholding only ever REMOVES orders — the uncovered half of the book gets nothing', async () => {
    const plan = await fireResearch();
    const uncovered = new Set(h.UNCOVERED);
    expect(plan.filter((o) => uncovered.has(o.symbol))).toEqual([]);
    expect(plan.length).toBeGreaterThan(0);
  });
});

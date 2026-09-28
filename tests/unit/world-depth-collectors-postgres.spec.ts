/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for "the congress collector never runs in the world depth cycle". The depth fire (`app:world-world-refresh`, the store world manifest's `world-refresh` schedule) is dispatched through the real dispatchWorldSchedule, which calls the real collectPoliticalTrades, which reads a real local HTTP feed and writes a private TimescaleDB through the real world service. The subject sweep is held open (it never finishes until the spec releases it) — the shape of a sweep that an api restart ends: the collector must already have written observed congress_* rows by the time the first subject starts. Also proves the pulse never calls the flow collectors, a flag-disabled collector is logged at WARN on every depth fire, and one collector failing does not stop the congress collector or the sweep.
 */

/**
 * @description What is real: the dispatch, the congress collector, its feed fetch (node:http on
 * 127.0.0.1), the world service and every SQL statement (timescale/timescaledb, the image the stack
 * runs). What is doubled, and why: the subject sweep's `ingestFeeds` (it pulls public news feeds and
 * classifies them — here it only records the subject and waits on a gate), the four sibling collectors
 * (market events, insider, short volume, gov contracts — each calls a public endpoint; they record the
 * order they ran in), the graph connector (no depth path touches it; it throws if one does), and the
 * logger (a recorder, so the skip/failure lines can be asserted).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import type { GraphConnector } from '@/features/graph';
import type { AppContext } from '@/app/composition-root';
import type { ScheduleRecord } from '@/features/scheduling';
import { DisposablePostgres } from '../helpers/disposable-postgres';

interface LogLine { level: 'info' | 'warn' | 'error'; msg: string; obj: Record<string, unknown> }

const h = vi.hoisted(() => ({
  svc: null as unknown,
  /** Everything the depth fire did, in order: a collector name, `congress-feed`, or `sweep:<entity>`. */
  events: [] as string[],
  sweepGate: Promise.resolve() as Promise<void>,
  failMarketEvents: false,
  logs: [] as Array<{ level: 'info' | 'warn' | 'error'; msg: string; obj: Record<string, unknown> }>,
}));

vi.mock('@/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/logger')>();
  const record = (level: 'info' | 'warn' | 'error') => (obj: unknown, msg?: string) => {
    h.logs.push({ level, msg: typeof obj === 'string' ? obj : String(msg ?? ''), obj: typeof obj === 'object' && obj ? obj as Record<string, unknown> : {} });
  };
  const logger: Record<string, unknown> = { info: record('info'), warn: record('warn'), error: record('error'), debug: () => {}, trace: () => {}, fatal: record('error') };
  logger.child = () => logger;
  return { ...actual, createChildLogger: () => logger, logger };
});

vi.mock('@/features/world-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/world-data')>();
  const sibling = (name: string, result: object) => async () => {
    h.events.push(name);
    if (name === 'market events' && h.failMarketEvents) throw new Error('nasdaq calendar unreachable');
    return result;
  };
  return {
    ...actual,
    createWorldIntelligenceService: () => h.svc,
    ingestFeeds: async (_svc: unknown, _query: string, entity: string) => {
      h.events.push(`sweep:${entity}`);
      await h.sweepGate;
      return { perSource: [], usedLlm: false };
    },
    collectMarketEvents: sibling('market events', { earnings: 0, fomc: 0, jobs: 0 }),
    collectInsiderTrades: sibling('insider trades', { tickers: 0, trades: 0 }),
    collectShortInterest: sibling('short interest', { day: null, tickers: 0 }),
    collectGovContracts: sibling('gov contracts', { tickers: 0, totalNotional: 0 }),
  };
});

import { WorldIntelligenceService } from '@/features/world-data/world-intelligence-service';
import { dispatchWorldSchedule, isTickerPulse, isWorldSchedule } from '@/app/world-schedule-dispatch';

const DAY_MS = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
/** `app:${appName}-${scheduleId}` (swarm-app-schedule-wiring.ts) for the world package's two schedules. */
const DEPTH_TASK = 'app:world-world-refresh';
const PULSE_TASK = 'app:world-ticker-pulse';
const FLAG_KEYS = ['WORLD_EVENTS_ENABLED', 'WORLD_FLOW_ENABLED', 'WORLD_GOV_ENABLED', 'WORLD_FIREHOSE_ENABLED', 'WORLD_POLITICAL_URL'] as const;
const savedEnv = Object.fromEntries(FLAG_KEYS.map((k) => [k, process.env[k]]));

const noGraph = {
  getTenantGraph: async () => { throw new Error('the depth collectors must not touch the graph'); },
} as unknown as GraphConnector;
const ctx = {} as AppContext;
const feedRows = [
  { Ticker: 'NVDA', Transaction: 'Purchase', TransactionDate: daysAgo(40), ReportDate: daysAgo(3), Amount: '1,001' },
  { Ticker: 'AAPL', Transaction: 'Sale (Full)', TransactionDate: daysAgo(30), ReportDate: daysAgo(8), Amount: 15001 },
];

let fixture: DisposablePostgres;
let pool: Pool;
let server: Server;

/** A due schedule record exactly as the scheduler hands it to the dispatch. */
function schedule(taskType: string): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: taskType.replace(':', '_'), taskType, cron: '0 */6 * * *', taskData: { prompt: 'refresh' }, status: 'active',
    createdAt: now, updatedAt: now, nextRunAt: now, lastRunAt: null, executionCount: 0, ownerSub: null,
  };
}

/** Observed congress_* rows (written by the collector with observed_at) per metric. */
async function observedCongressRows(): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM world_metrics WHERE metric LIKE 'congress_%' AND observed_at IS NOT NULL`);
  return r.rows[0].n as number;
}

const logged = (msg: string, level?: LogLine['level']): LogLine[] => h.logs.filter((l) => l.msg === msg && (!level || l.level === level));

beforeAll(async () => {
  fixture = new DisposablePostgres({
    purpose: 'world-depth-collectors', image: 'timescale/timescaledb:latest-pg16',
    database: 'oshal_ts', memory: '512m', statementTimeoutMs: 60_000,
  });
  pool = await fixture.start();
  await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  h.svc = new WorldIntelligenceService(noGraph, pool);

  server = createServer((_req, res) => {
    h.events.push('congress-feed');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(feedRows));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.WORLD_POLITICAL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/congress`;
  process.env.WORLD_FIREHOSE_ENABLED = 'false';
}, 240_000);

afterAll(async () => {
  for (const k of FLAG_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (fixture) await fixture.stop();
}, 120_000);

beforeEach(() => {
  h.events.length = 0;
  h.logs.length = 0;
  h.sweepGate = Promise.resolve();
  h.failMarketEvents = false;
  for (const k of ['WORLD_EVENTS_ENABLED', 'WORLD_FLOW_ENABLED', 'WORLD_GOV_ENABLED'] as const) delete process.env[k];
});

describe('world depth fire → congress collector → world_metrics (real TimescaleDB, real feed fetch)', () => {
  it('routes the manifest task types the way the scheduler does', () => {
    expect(isWorldSchedule(DEPTH_TASK) && !isTickerPulse(DEPTH_TASK)).toBe(true);
    expect(isWorldSchedule(PULSE_TASK) && isTickerPulse(PULSE_TASK)).toBe(true);
  });

  it('writes observed congress rows BEFORE the subject sweep starts, so a sweep that never finishes cannot starve it', async () => {
    let release!: () => void;
    h.sweepGate = new Promise<void>((resolve) => { release = resolve; });
    const fire = dispatchWorldSchedule(ctx, schedule(DEPTH_TASK));

    await vi.waitFor(() => expect(h.events.some((e) => e.startsWith('sweep:'))).toBe(true), { timeout: 60_000, interval: 50 });
    // The sweep is now stuck on its first subject — the moment an api restart would end the run.
    const firstSweep = h.events.findIndex((e) => e.startsWith('sweep:'));
    expect(h.events.slice(0, firstSweep)).toEqual(['market events', 'congress-feed', 'insider trades', 'short interest', 'gov contracts']);
    expect(await observedCongressRows(), 'NVDA buy + AAPL sale, five metrics each').toBe(10);
    const collected = logged('congress trades collected', 'info');
    expect(collected).toHaveLength(1);
    expect(collected[0].obj).toMatchObject({ scheduleId: 'app_world-world-refresh', tickers: 2, trades: 2, written: 10, unchanged: 0 });

    release();
    await expect(fire).resolves.toMatchObject({ success: true });
    expect(h.events.filter((e) => e === 'congress-feed'), 'one feed read per depth fire').toHaveLength(1);
    const done = logged('world refresh complete', 'info');
    expect(done).toHaveLength(1);
    expect(done[0].obj).toMatchObject({ mode: 'depth-refresh' });
  }, 120_000);

  it('a ticker pulse never calls the flow collectors or the congress feed', async () => {
    await expect(dispatchWorldSchedule(ctx, schedule(PULSE_TASK))).resolves.toMatchObject({ success: true });
    expect(h.events.some((e) => e.startsWith('sweep:world:ticker:'))).toBe(true);
    expect(h.events.filter((e) => !e.startsWith('sweep:'))).toEqual([]);
    expect(logged('congress trades collected')).toEqual([]);
  }, 120_000);

  it('a flag-disabled collector is reported at WARN on every depth fire, and the rest still run', async () => {
    process.env.WORLD_FLOW_ENABLED = 'false';
    await expect(dispatchWorldSchedule(ctx, schedule(DEPTH_TASK))).resolves.toMatchObject({ success: true });
    expect(h.events).not.toContain('congress-feed');
    expect(h.events).toContain('market events');
    const flow = logged('flow signal collectors skipped — disabled by flag', 'warn');
    expect(flow).toHaveLength(1);
    expect(flow[0].obj).toMatchObject({ flag: 'WORLD_FLOW_ENABLED', skipped: ['congress trades', 'insider trades', 'short interest', 'gov contracts'] });

    h.events.length = 0;
    h.logs.length = 0;
    delete process.env.WORLD_FLOW_ENABLED;
    process.env.WORLD_EVENTS_ENABLED = 'false';
    process.env.WORLD_GOV_ENABLED = 'false';
    await expect(dispatchWorldSchedule(ctx, schedule(DEPTH_TASK))).resolves.toMatchObject({ success: true });
    expect(h.events.slice(0, h.events.findIndex((e) => e.startsWith('sweep:')))).toEqual(['congress-feed', 'insider trades', 'short interest']);
    expect(logged('market events collector skipped — disabled by flag', 'warn')[0]?.obj).toMatchObject({ flag: 'WORLD_EVENTS_ENABLED' });
    expect(logged('gov contracts collector skipped — disabled by flag', 'warn')[0]?.obj).toMatchObject({ flag: 'WORLD_GOV_ENABLED' });
    // Same feed as the first fire: the collector ran, and appended nothing.
    expect(logged('congress trades collected', 'info')[0]?.obj).toMatchObject({ written: 0, unchanged: 10 });
  }, 120_000);

  it('one collector failing is logged and does not stop the congress collector or the sweep', async () => {
    h.failMarketEvents = true;
    await expect(dispatchWorldSchedule(ctx, schedule(DEPTH_TASK))).resolves.toMatchObject({ success: true });
    expect(logged('market events failed', 'warn')).toHaveLength(1);
    expect(logged('congress trades collected', 'info')).toHaveLength(1);
    expect(h.events.some((e) => e.startsWith('sweep:'))).toBe(true);
  }, 120_000);
});

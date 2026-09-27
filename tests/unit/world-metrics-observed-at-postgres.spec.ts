/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for congressional disclosure provenance on the series store. A private TimescaleDB (the image the stack runs) starts with world_metrics in its PRE-change shape — a hypertable with no observed_at, legacy transaction-day rows, and the world_metrics_daily continuous aggregate already over it — and the real service + the real collector run against it, fed by a real local HTTP feed. Proves: the ALTER lands on that hypertable without back-stamping old rows; points are keyed on the ReportDate day with observed_at recorded; an identical second run appends nothing; a revised value is appended and wins the same-day tie on observed_at; the ALTER is not re-issued once the column exists; and the recent-feed read returns observed disclosures only, newest first, bounded.
 */

/**
 * @description Nothing below doubles the database: the SQL, the hypertable, the continuous aggregate
 * and the ALTER all run on TimescaleDB. The only double is the graph connector, which none of these
 * paths touches (it throws if one ever does). The feed is a real node:http server on 127.0.0.1.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import type { GraphConnector } from '@/features/graph';
import { WorldIntelligenceService } from '@/features/world-data/world-intelligence-service';
import { ensureMetricsPreaggregate } from '@/features/world-data/world-preaggregate';
import { collectPoliticalTrades } from '@/features/world-data/political-trades';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const CONGRESS_METRICS = ['congress_buys', 'congress_sells', 'congress_net', 'congress_sentiment', 'congress_notional'];
const DAY_MS = 86_400_000;
/** A calendar day `n` days before today (UTC), as the feed writes it. */
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
const REPORT_NVDA = daysAgo(3);
const REPORT_AAPL = daysAgo(10);
const TRADE_NVDA = daysAgo(40);

const noGraph = {
  getTenantGraph: async () => { throw new Error('the series paths must not touch the graph'); },
} as unknown as GraphConnector;

const feed = { rows: [] as Array<Record<string, unknown>> };
let server: Server;
let fixture: DisposablePostgres;
let pool: Pool;
const savedUrl = process.env.WORLD_POLITICAL_URL;

/** Count rows for one entity/metric, split by whether observed_at was recorded. */
async function counts(entity: string, metric: string): Promise<{ observed: number; legacy: number }> {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE observed_at IS NOT NULL)::int AS observed,
            count(*) FILTER (WHERE observed_at IS NULL)::int AS legacy
       FROM world_metrics WHERE entity = $1 AND metric = $2`,
    [entity, metric],
  );
  return r.rows[0] as { observed: number; legacy: number };
}

beforeAll(async () => {
  fixture = new DisposablePostgres({
    purpose: 'world-metrics-observed-at', image: 'timescale/timescaledb:latest-pg16',
    database: 'oshal_ts', memory: '512m', statementTimeoutMs: 60_000,
  });
  pool = await fixture.start();
  await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  // The shape a deployed box has today: no observed_at, a hypertable, legacy rows, the head over it.
  await pool.query(`CREATE TABLE world_metrics (
    entity TEXT NOT NULL, metric TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, value DOUBLE PRECISION NOT NULL, source TEXT)`);
  await pool.query(`SELECT create_hypertable('world_metrics','ts')`);
  await pool.query(
    `INSERT INTO world_metrics (entity, metric, ts, value, source) VALUES
       ('world:ticker:nvda', 'congress_buys', $1, 1, 'quiver-congress'),
       ('world:ticker:tsla', 'congress_net', $2, 5, 'quiver-congress'),
       ('world:ticker:aapl', 'congress_buys', $3, 1, 'quiver-congress')`,
    [`${TRADE_NVDA}T00:00:00Z`, `${daysAgo(5)}T00:00:00Z`, `${REPORT_AAPL}T00:00:00Z`],
  );
  await ensureMetricsPreaggregate(pool);
  const head = await pool.query(`SELECT 1 FROM timescaledb_information.continuous_aggregates WHERE view_name = 'world_metrics_daily'`);
  expect(head.rowCount, 'the head must exist BEFORE the column is added').toBe(1);

  server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(feed.rows)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.WORLD_POLITICAL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/congress`;
}, 240_000);

afterAll(async () => {
  if (savedUrl === undefined) delete process.env.WORLD_POLITICAL_URL; else process.env.WORLD_POLITICAL_URL = savedUrl;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (fixture) await fixture.stop();
}, 120_000);

describe('world_metrics.observed_at on a real TimescaleDB hypertable with its continuous aggregate', () => {
  const svc = () => new WorldIntelligenceService(noGraph, pool);

  it('run 1 adds the column, keeps legacy rows NULL, and writes ReportDate-keyed observed points', async () => {
    feed.rows = [
      { Ticker: 'NVDA', Transaction: 'Purchase', TransactionDate: TRADE_NVDA, ReportDate: REPORT_NVDA, Amount: '1,001' },
      // Same value and day as the legacy AAPL row: it must still get an observed copy.
      { Ticker: 'AAPL', Transaction: 'Purchase', TransactionDate: daysAgo(30), ReportDate: REPORT_AAPL, Amount: 15001 },
      { Ticker: 'MSFT', Transaction: 'Purchase', TransactionDate: daysAgo(2) },
    ];
    const result = await collectPoliticalTrades(svc());
    expect(result).toEqual({ tickers: 2, trades: 2, written: 10, unchanged: 0 });

    const column = await pool.query(
      `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'world_metrics' AND column_name = 'observed_at'`,
    );
    expect(column.rows).toEqual([{ is_nullable: 'YES', column_default: null }]);
    expect(await counts('world:ticker:tsla', 'congress_net')).toEqual({ observed: 0, legacy: 1 });
    expect(await counts('world:ticker:aapl', 'congress_buys')).toEqual({ observed: 1, legacy: 1 });

    const nvda = await pool.query(
      `SELECT metric, ts, value, source, observed_at FROM world_metrics
        WHERE entity = 'world:ticker:nvda' AND observed_at IS NOT NULL ORDER BY metric`,
    );
    expect(nvda.rows.map((r) => r.metric)).toEqual([...CONGRESS_METRICS].sort());
    for (const row of nvda.rows) {
      expect(new Date(row.ts).toISOString()).toBe(`${REPORT_NVDA}T00:00:00.000Z`);
      expect(row.source).toBe('quiver-congress');
    }
    expect(await pool.query(`SELECT 1 FROM world_metrics WHERE entity = 'world:ticker:msft'`)).toHaveProperty('rowCount', 0);
  });

  it('run 2 over the same feed appends nothing', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM world_metrics');
    const result = await collectPoliticalTrades(svc());
    expect(result).toEqual({ tickers: 2, trades: 2, written: 0, unchanged: 10 });
    const after = await pool.query('SELECT count(*)::int AS n FROM world_metrics');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('a revised disclosure day appends only the changed points, and the newest observation wins the tie', async () => {
    const first = (await svc().latestMetricPoints(['world:ticker:nvda'], ['congress_buys']))[0];
    feed.rows = [
      ...feed.rows,
      { Ticker: 'NVDA', Transaction: 'Purchase', TransactionDate: daysAgo(35), ReportDate: REPORT_NVDA, Amount: 500 },
    ];
    const result = await collectPoliticalTrades(svc());
    // buys 1->2, net 1->2, notional 1001->1501 change; sells 0 and sentiment 1 do not.
    expect(result).toEqual({ tickers: 2, trades: 3, written: 3, unchanged: 7 });

    const [latest] = await svc().latestMetricPoints(['world:ticker:nvda'], ['congress_buys']);
    expect(latest).toMatchObject({ value: 2, ts: `${REPORT_NVDA}T00:00:00.000Z`, source: 'quiver-congress' });
    expect(Date.parse(latest.observedAt!)).toBeGreaterThan(Date.parse(first.observedAt!));
    expect(await counts('world:ticker:nvda', 'congress_sells')).toEqual({ observed: 1, legacy: 0 });
  });

  it('a later warm-up finds the column and never re-issues the ALTER', async () => {
    const seen: string[] = [];
    const recording = { query: (text: string, values?: unknown[]) => { seen.push(text); return pool.query(text, values); } } as unknown as Pool;
    await new WorldIntelligenceService(noGraph, recording).latestMetricPoints(['world:ticker:nvda'], ['congress_net']);
    expect(seen.some((q) => /information_schema\.columns/.test(q))).toBe(true);
    expect(seen.some((q) => /ALTER TABLE world_metrics/.test(q))).toBe(false);
  });

  it('the recent-feed read lists observed disclosures only, newest first, bounded', async () => {
    const points = await svc().recentFeedMetricPoints(CONGRESS_METRICS, 'quiver-congress', 90, 10);
    const entities = [...new Set(points.map((p) => p.entity))];
    expect(entities).toEqual(['world:ticker:nvda', 'world:ticker:aapl']);
    expect(points.every((p) => p.observedAt !== null && p.source === 'quiver-congress')).toBe(true);
    const nvdaBuys = points.find((p) => p.entity === 'world:ticker:nvda' && p.metric === 'congress_buys');
    expect(nvdaBuys).toMatchObject({ value: 2, ts: `${REPORT_NVDA}T00:00:00.000Z` });

    const one = await svc().recentFeedMetricPoints(CONGRESS_METRICS, 'quiver-congress', 90, 1);
    expect([...new Set(one.map((p) => p.entity))]).toEqual(['world:ticker:nvda']);
    const narrow = await svc().recentFeedMetricPoints(CONGRESS_METRICS, 'quiver-congress', 5, 10);
    expect([...new Set(narrow.map((p) => p.entity))], 'AAPL was disclosed 10 days ago').toEqual(['world:ticker:nvda']);
    expect(await svc().recentFeedMetricPoints(CONGRESS_METRICS, 'model', 90, 10)).toEqual([]);
  });
});

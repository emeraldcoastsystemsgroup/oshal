/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Deterministic date-preserving aggregation guard for congressional trade feed rows.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Points are keyed on the disclosure ReportDate, never the TransactionDate: a row without a real calendar ReportDate is refused (no fallback), a trade day never leaks into the series, and the collector hands the feed source, the report day and its own run clock to the idempotent write. The feed is served by a real local HTTP server; the world service is a recording double here because the store boundary is proven in world-metrics-observed-at-postgres.spec.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorldIntelligenceService } from '@/features/world-data';
import { aggregatePoliticalTrades, collectPoliticalTrades, disclosureDay } from '@/features/world-data/political-trades';

const NOW = new Date('2026-09-25T12:00:00Z');

describe('political trade feed aggregation — keyed on the disclosure day', () => {
  it('groups by ticker and ReportDate day, ignoring an earlier TransactionDate', () => {
    const result = aggregatePoliticalTrades([
      { Ticker: ' msft ', Transaction: 'Purchase', TransactionDate: '2026-08-02', ReportDate: '2026-09-20', Amount: '$1,001' },
      { Ticker: 'MSFT', Transaction: 'Sale', TransactionDate: '2026-08-15', ReportDate: '2026-09-20T23:30:00-05:00', Amount: 2000 },
      { Ticker: 'MSFT', Transaction: 'Purchase', TransactionDate: '2026-09-18', ReportDate: '2026-09-19', Amount: 300 },
    ], NOW, 30);
    expect(result.trades).toBe(3);
    expect(result.observations).toEqual([
      { ticker: 'MSFT', disclosureDate: '2026-09-19T00:00:00.000Z', buys: 1, sells: 0, notional: 300 },
      { ticker: 'MSFT', disclosureDate: '2026-09-20T00:00:00.000Z', buys: 1, sells: 1, notional: 3001 },
    ]);
    const days = result.observations.map((o) => o.disclosureDate.slice(0, 10));
    expect(days, 'a trade day must never become a series timestamp').not.toContain('2026-08-02');
    expect(days).not.toContain('2026-08-15');
  });

  it('refuses a row without a real ReportDate instead of falling back to the trade day', () => {
    const result = aggregatePoliticalTrades([
      { Ticker: 'AAPL', Transaction: 'Purchase', TransactionDate: '2026-09-24', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Purchase', TransactionDate: '2026-09-24', ReportDate: '', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Purchase', ReportDate: 'not-a-date', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Purchase', ReportDate: '2026-02-30', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Purchase', ReportDate: '09/24/2026', Amount: 10 },
    ], NOW, 365);
    expect(result).toEqual({ observations: [], trades: 0 });
  });

  it('refuses stale, future, unrelated and invalid-ticker rows', () => {
    const result = aggregatePoliticalTrades([
      { Ticker: 'AAPL', Transaction: 'Purchase', ReportDate: '2026-09-24', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Purchase', ReportDate: '2026-08-01', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Purchase', ReportDate: '2026-09-26', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Dividend', ReportDate: '2026-09-24', Amount: 10 },
      { Ticker: '123', Transaction: 'Purchase', ReportDate: '2026-09-24', Amount: 10 },
    ], NOW, 30);
    expect(result.trades).toBe(1);
    expect(result.observations).toEqual([{ ticker: 'AAPL', disclosureDate: '2026-09-24T00:00:00.000Z', buys: 1, sells: 0, notional: 10 }]);
  });

  it('reads only the literal calendar day of a ReportDate', () => {
    expect(disclosureDay('2026-09-20T23:30:00-05:00')).toEqual({ day: '2026-09-20', epoch: Date.UTC(2026, 8, 20) });
    expect(disclosureDay('2024-02-29')).toEqual({ day: '2024-02-29', epoch: Date.UTC(2024, 1, 29) });
    expect(disclosureDay('2026-02-29')).toBeNull();
    expect(disclosureDay(undefined)).toBeNull();
    expect(disclosureDay(20260920)).toBeNull();
  });
});

describe('collectPoliticalTrades — feed source, disclosure day and run clock reach the write', () => {
  const feed = { status: 200, body: '[]' };
  let server: Server;
  const savedUrl = process.env.WORLD_POLITICAL_URL;

  beforeAll(async () => {
    server = createServer((_req, res) => { res.writeHead(feed.status, { 'content-type': 'application/json' }); res.end(feed.body); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.WORLD_POLITICAL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/congress`;
  });
  afterAll(async () => {
    if (savedUrl === undefined) delete process.env.WORLD_POLITICAL_URL; else process.env.WORLD_POLITICAL_URL = savedUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A recording world service: only the write the collector is allowed to use. */
  function recorder(existing: Set<string>) {
    const writes: Array<{ entity: string; metric: string; value: number; source: string; at: string; observedAt: string }> = [];
    const svc = {
      async writeMetricIfChanged(entity: string, metric: string, value: number, source: string, at: string, observedAt: string) {
        writes.push({ entity, metric, value, source, at, observedAt });
        return !existing.has(`${entity}|${metric}|${at}|${value}`);
      },
    };
    return { writes, svc: svc as unknown as WorldIntelligenceService };
  }

  it('writes quiver-congress points on the report day with the run clock as observed_at', async () => {
    const today = new Date().toISOString().slice(0, 10);
    feed.status = 200;
    feed.body = JSON.stringify([
      { Ticker: 'NVDA', Transaction: 'Purchase', TransactionDate: '2020-01-02', ReportDate: today, Amount: '15,001' },
    ]);
    const before = Date.now();
    const { writes, svc } = recorder(new Set([`world:ticker:nvda|congress_buys|${today}T00:00:00.000Z|1`]));
    const result = await collectPoliticalTrades(svc);

    expect(writes.map((w) => w.metric)).toEqual(['congress_buys', 'congress_sells', 'congress_net', 'congress_sentiment', 'congress_notional']);
    for (const w of writes) {
      expect(w.entity).toBe('world:ticker:nvda');
      expect(w.source).toBe('quiver-congress');
      expect(w.at).toBe(`${today}T00:00:00.000Z`);
      expect(Date.parse(w.observedAt)).toBeGreaterThanOrEqual(before - 1);
    }
    expect(new Set(writes.map((w) => w.observedAt)).size, 'one run, one observation clock').toBe(1);
    expect(result).toEqual({ tickers: 1, trades: 1, written: 4, unchanged: 1 });
  });

  it('a failed feed writes nothing and reports zeros', async () => {
    feed.status = 503;
    feed.body = '{"error":"down"}';
    const { writes, svc } = recorder(new Set());
    expect(await collectPoliticalTrades(svc)).toEqual({ tickers: 0, trades: 0, written: 0, unchanged: 0 });
    expect(writes).toEqual([]);
  });
});

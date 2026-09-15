/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the 2026-09-14 series-store saturation: the market-hours pulse rolled 184 entities up with nothing bounding the sum of overlapping fires, so oshal-local-tsdb answered 19 concurrent copies of the same aggregate at 282% CPU. Pins the two properties whose loss recreates it — a process-wide ceiling on in-flight read statements, and one statement for identical concurrent reads.
 */

/**
 * @description Guards for the world series-read gate (`world-series-gate.ts`).
 *
 * Boundary note (real-boundary regression audit): the double here is the pg client, not the gate.
 * These specs exercise the REAL service methods, the real statement text and the real gate, and
 * measure what the pg client is asked to do concurrently — which is exactly the quantity that
 * saturated the store. They do NOT prove anything about PostgreSQL's own behaviour under load; the
 * live companion is the pulse's own `seriesStatements`/`elapsedMs` record after deploy, plus the
 * read-only EXPLAIN evidence in the PR.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import type { GraphConnector } from '@/features/graph';
import { WorldIntelligenceService } from '@/features/world-data/world-intelligence-service';
import {
  resetSeriesReadStats,
  runSeriesRead,
  seriesReadKey,
  seriesReadStats,
} from '@/features/world-data/world-series-gate';
import { pulseOverrun } from '@/app/world-schedule-dispatch';

/** The read shapes the rollup issues against the series store — what the pulse actually costs. */
const GATED_READ = /^\s*SELECT/i;
const SERIES_RELATION = /FROM\s+(world_metrics_daily|world_metrics|world_items)\b/i;

/** A pg double that records how many series reads it is asked to answer AT ONCE. Every gated read
 *  is held open for a real timer tick, so concurrency is observable rather than a microtask race. */
function makeSeriesPool() {
  const pool = {
    maxInFlight: 0,
    inFlight: 0,
    reads: [] as string[],
    async query(text: string, _values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
      const sql = String(text);
      const gated = GATED_READ.test(sql) && SERIES_RELATION.test(sql);
      if (!gated) return { rows: [], rowCount: 0 };
      pool.reads.push(sql.replace(/\s+/g, ' ').trim());
      pool.inFlight += 1;
      if (pool.inFlight > pool.maxInFlight) pool.maxInFlight = pool.inFlight;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { rows: [{ source: 'reuters', points: 3, avg: 0.42 }], rowCount: 1 };
      } finally {
        pool.inFlight -= 1;
      }
    },
  };
  return pool;
}

/** The graph side of the service is not under test — the rollup only asks it for a degree. */
const graphConnector = { getTenantGraph: async () => ({ neighbors: async () => [] }) };

/** How many of the recorded statements are the per-source sentiment aggregate for one entity. */
function sentimentReads(reads: string[]): string[] {
  return reads.filter((sql) => /metric='sentiment'/.test(sql) && /GROUP BY source/.test(sql));
}

describe('world series-read gate — the bound survives overlapping pulses', () => {
  const saved = { ...process.env };

  beforeEach(() => { resetSeriesReadStats(); });
  afterEach(() => {
    for (const key of ['WORLD_SERIES_READ_CONCURRENCY']) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('never puts more read statements on the store than the configured bound', async () => {
    process.env.WORLD_SERIES_READ_CONCURRENCY = '3';
    const pool = makeSeriesPool();
    const svc = new WorldIntelligenceService(graphConnector as unknown as GraphConnector, pool as unknown as Pool);

    // 12 entities at once: one fire's fan-out plus an abandoned fire still running on top of it.
    // Unbounded, all 12 reach the client in the same microtask drain (measured: maxInFlight 12).
    const entities = Array.from({ length: 12 }, (_, i) => `world:ticker:t${i}`);
    await Promise.all(entities.map((entity) => svc.rollupFeatures(entity)));

    expect(pool.reads.length, 'the rollup must still do its reads').toBeGreaterThan(12);
    expect(pool.maxInFlight, 'the store must never see more than the configured bound').toBeLessThanOrEqual(3);
    expect(seriesReadStats().maxInFlight).toBeLessThanOrEqual(3);
  });

  it('honours a bound set in the environment rather than a compiled-in one', async () => {
    process.env.WORLD_SERIES_READ_CONCURRENCY = '1';
    const pool = makeSeriesPool();
    const svc = new WorldIntelligenceService(graphConnector as unknown as GraphConnector, pool as unknown as Pool);

    await Promise.all(['world:ticker:aaa', 'world:ticker:bbb', 'world:ticker:ccc']
      .map((entity) => svc.rollupFeatures(entity)));

    expect(pool.maxInFlight).toBe(1);
  });
});

describe('world series-read gate — identical concurrent reads issue one statement', () => {
  beforeEach(() => { resetSeriesReadStats(); });
  afterEach(() => { delete process.env.WORLD_SERIES_READ_CONCURRENCY; });

  it('two overlapping rollups of the same entity ask the store once per window', async () => {
    process.env.WORLD_SERIES_READ_CONCURRENCY = '4';
    const pool = makeSeriesPool();
    const svc = new WorldIntelligenceService(graphConnector as unknown as GraphConnector, pool as unknown as Pool);

    // The shape the box actually hit: the pulse is re-dispatched while the previous one is still
    // rolling the same name up. Unbounded, that is four sentiment statements for two answers.
    const [a, b] = await Promise.all([
      svc.rollupFeatures('world:ticker:nvda'),
      svc.rollupFeatures('world:ticker:nvda'),
    ]);

    expect(sentimentReads(pool.reads), 'one statement per window, not per caller').toHaveLength(2);
    expect(seriesReadStats().coalesced).toBeGreaterThanOrEqual(2);
    expect(a.sentiment_mean).toEqual(b.sentiment_mean);
  });

  it('coalesces only while a read is in flight — it is not a cache', async () => {
    const key = seriesReadKey('sentiment-days', 'world:ticker:nvda', 1);
    let issued = 0;
    const read = async (): Promise<number> => {
      issued += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return issued;
    };

    const [first, second] = await Promise.all([runSeriesRead(key, read), runSeriesRead(key, read)]);
    expect([first, second]).toEqual([1, 1]);

    const third = await runSeriesRead(key, read);
    expect(third, 'a settled key must re-read, not serve a stale answer').toBe(2);
  });

  it('keys a different entity, metric window or shape apart', () => {
    expect(seriesReadKey('sentiment-days', 'world:ticker:nvda', 1))
      .not.toEqual(seriesReadKey('sentiment-days', 'world:ticker:nvda', 7));
    expect(seriesReadKey('sentiment-days', 'world:ticker:nvda', 1))
      .not.toEqual(seriesReadKey('sentiment-days', 'world:ticker:amd', 1));
    expect(seriesReadKey('sentiment-days', 'world:ticker:nvda', 1))
      .not.toEqual(seriesReadKey('sentiment-hours', 'world:ticker:nvda', 1));
  });
});

describe('world series-read gate — the whole-day window reads the head', () => {
  beforeEach(() => { resetSeriesReadStats(); });

  it('answers the rollup 24h/168h windows off the daily head, not the stream', async () => {
    const pool = makeSeriesPool();
    const svc = new WorldIntelligenceService(graphConnector as unknown as GraphConnector, pool as unknown as Pool);
    await svc.rollupFeatures('world:ticker:nvda');

    const sentiment = sentimentReads(pool.reads);
    expect(sentiment).toHaveLength(2);
    for (const sql of sentiment) {
      expect(sql, 'a whole-day window belongs on the head').toContain('world_metrics_daily');
      expect(sql, 'the head recovers the mean as sum/count').toContain('sum(sum_v)');
      expect(sql).not.toMatch(/FROM world_metrics\b/);
    }
  });

  it('still scans the stream for a window the head cannot express', async () => {
    const pool = makeSeriesPool();
    const svc = new WorldIntelligenceService(graphConnector as unknown as GraphConnector, pool as unknown as Pool);
    await svc.rollupFeatures('world:ticker:nvda', { windowHours: 6, baselineHours: 18 });

    const sentiment = sentimentReads(pool.reads);
    expect(sentiment).toHaveLength(2);
    for (const sql of sentiment) {
      expect(sql, 'a sub-day window only exists on the stream').toMatch(/FROM world_metrics\b/);
      expect(sql).toContain("' hours')::interval");
    }
  });
});

describe('world pulse budget — a long run is visible before fires start stacking', () => {
  const saved = { ...process.env };
  afterEach(() => {
    delete process.env.WORLD_PULSE_WINDOW_MS;
    delete process.env.WORLD_PULSE_WARN_FRACTION;
    Object.assign(process.env, saved);
  });

  it('warns above the configured fraction of the window and not below it', () => {
    const env = { WORLD_PULSE_WINDOW_MS: '300000', WORLD_PULSE_WARN_FRACTION: '0.8' } as NodeJS.ProcessEnv;
    expect(pulseOverrun(239_000, env).over).toBe(false);
    expect(pulseOverrun(241_000, env).over).toBe(true);
    expect(pulseOverrun(241_000, env).thresholdMs).toBe(240_000);
  });

  it('falls back to the pulse cadence when the knobs are unset or nonsense', () => {
    const unset = pulseOverrun(1000, {} as NodeJS.ProcessEnv);
    expect(unset.budgetMs).toBe(300_000);
    expect(unset.fraction).toBe(0.8);
    const junk = pulseOverrun(1000, { WORLD_PULSE_WINDOW_MS: 'soon', WORLD_PULSE_WARN_FRACTION: '9' } as NodeJS.ProcessEnv);
    expect(junk.budgetMs).toBe(300_000);
    expect(junk.fraction).toBe(0.8);
  });

  it('is tunable for a schedule on a different cadence', () => {
    const env = { WORLD_PULSE_WINDOW_MS: '60000', WORLD_PULSE_WARN_FRACTION: '0.5' } as NodeJS.ProcessEnv;
    expect(pulseOverrun(29_000, env).over).toBe(false);
    expect(pulseOverrun(31_000, env).over).toBe(true);
  });
});

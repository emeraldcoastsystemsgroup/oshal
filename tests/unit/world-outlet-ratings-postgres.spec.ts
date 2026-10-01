/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for oshal's own OBSERVED outlet ratings (operator decision 2026-09-22). A private TimescaleDB (the image the stack runs) gets world_metrics, its hypertable and the world_metrics_daily continuous aggregate from the real service, then hand-computed sentiment observations. Proves the divergence aggregate on that head: leave-one-out comparisons on shared subject-days only, exact counts, observations and date range, the window excluding old rows, other metrics ignored, a lone source never compared; the service reads every source through those ratings (rated vs insufficient below the stated minimums); the same rows give the same ratings; and a rating changes only when stored rows change.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Deterministic against the head's own refresh job (verifier, round 2: 2 failed | 6 passed on one run, 8 passed on the next, unchanged code). The policy world-preaggregate.ts adds could materialise these day buckets mid-insert, after which a later row in a materialised bucket is invisible until the next refresh. The spec now stops that job once the service has created it (asserting exactly one) and refreshes the head explicitly after the setup inserts and after the last block's inserts. The long service describe is split in three; the block that adds rows stays last.
 */

/**
 * @description Nothing below doubles the database: the head, the window functions and the service's
 * reads all run on TimescaleDB. The only double is the graph connector, which none of these paths
 * touches (it throws if one ever does).
 *
 * The data (three days d1..d3, values chosen so every expectation is hand-computable):
 *  - s1, every day: alpha 0.6 and 0.8 (mean 0.7), beta 0.1, gamma 0.0
 *      divergence: alpha 0.7-(0.1+0)/2 = 0.65, beta 0.1-(0.7+0)/2 = -0.25, gamma 0-(0.7+0.1)/2 = -0.4
 *  - s2, every day: alpha 0.3, beta 0.3, gamma 0.0
 *      divergence: alpha 0.15, beta 0.15, gamma -0.3
 *  => alpha mean 0.4 |0.4| sd 0.27386; beta mean -0.05 |0.2| sd 0.21909; gamma mean -0.35 |0.35| sd 0.05477
 *  - s3 d1: thin 0.5, other -0.5 (one comparison each, below the minimums)
 *  - s4 d1: lone 0.2 (no other source that day: never compared)
 *  - s1, 200 days ago: values that would move every rating if the 90-day window leaked
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { GraphConnector } from '@/features/graph';
import { WorldIntelligenceService } from '@/features/world-data/world-intelligence-service';
import { readOutletDivergenceStats } from '@/features/world-data/outlet-observations';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const DAY_MS = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
const D1 = daysAgo(3);
const D2 = daysAgo(2);
const D3 = daysAgo(1);
const A = 'world:outlet:alpha';
const B = 'world:outlet:beta';
const C = 'world:outlet:gamma';
const T = 'world:outlet:thin';
const U = 'world:outlet:other';
const V = 'world:outlet:lone';

const noGraph = {
  getTenantGraph: async () => { throw new Error('the series paths must not touch the graph'); },
} as unknown as GraphConnector;

const ENV_KEYS = ['WORLD_OUTLET_RATING_MIN_COMPARISONS', 'WORLD_OUTLET_RATING_MIN_SUBJECTS', 'WORLD_OUTLET_RATING_TTL_MS', 'WORLD_OUTLET_RATING_WINDOW_DAYS'] as const;
const savedEnv: Record<string, string | undefined> = {};

let fixture: DisposablePostgres;
let pool: Pool;
let svc: WorldIntelligenceService;

/** Insert one stored observation (the shape ingest writes: entity, metric, ts, value, source). */
async function observe(entity: string, metric: string, day: string, value: number, source: string): Promise<void> {
  await pool.query(`INSERT INTO world_metrics (entity, metric, ts, value, source) VALUES ($1, $2, $3, $4, $5)`, [entity, metric, `${day}T12:00:00Z`, value, source]);
}

/**
 * Stop the head's scheduled refresh (the policy world-preaggregate.ts adds). Run on its own clock it
 * can materialise these buckets in the middle of the inserts, and a row inserted afterwards into a
 * materialised bucket stays out of the head until the next refresh, so the answer would depend on
 * timing. The spec refreshes explicitly instead, as the scheduled job would after the rows land.
 */
async function stopScheduledRefresh(): Promise<void> {
  const stopped = await pool.query(
    `SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE proc_name = 'policy_refresh_continuous_aggregate'`,
  );
  expect(stopped.rowCount, 'exactly one refresh policy on the head').toBe(1);
}

/** Bring the head up to date with every stored row, once the inserts are done. */
async function refreshHead(): Promise<void> {
  await pool.query(`CALL refresh_continuous_aggregate('world_metrics_daily', NULL, NULL)`);
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.WORLD_OUTLET_RATING_MIN_COMPARISONS = '4';
  process.env.WORLD_OUTLET_RATING_MIN_SUBJECTS = '2';
  process.env.WORLD_OUTLET_RATING_TTL_MS = '0';
  delete process.env.WORLD_OUTLET_RATING_WINDOW_DAYS;

  fixture = new DisposablePostgres({
    purpose: 'world-outlet-ratings', image: 'timescale/timescaledb:latest-pg16',
    database: 'oshal_ts', memory: '512m', statementTimeoutMs: 60_000,
  });
  pool = await fixture.start();
  await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  svc = new WorldIntelligenceService(noGraph, pool);
  // The service builds the hypertable and the daily head exactly as it does on the box.
  const empty = await svc.outletRatings();
  expect(empty.ratings.size).toBe(0);
  await stopScheduledRefresh();

  for (const day of [D1, D2, D3]) {
    await observe('world:topic:s1', 'sentiment', day, 0.6, A);
    await observe('world:topic:s1', 'sentiment', day, 0.8, A);
    await observe('world:topic:s1', 'sentiment', day, 0.1, B);
    await observe('world:topic:s1', 'sentiment', day, 0.0, C);
    await observe('world:topic:s2', 'sentiment', day, 0.3, A);
    await observe('world:topic:s2', 'sentiment', day, 0.3, B);
    await observe('world:topic:s2', 'sentiment', day, 0.0, C);
  }
  await observe('world:topic:s3', 'sentiment', D1, 0.5, T);
  await observe('world:topic:s3', 'sentiment', D1, -0.5, U);
  await observe('world:topic:s4', 'sentiment', D1, 0.2, V);
  await observe('world:topic:s1', 'mentions', D1, 5, A);
  for (const [src, v] of [[A, 1], [B, -1], [C, -1]] as const) await observe('world:topic:s1', 'sentiment', daysAgo(200), v, src);
  await refreshHead();
}, 240_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (fixture) await fixture.stop();
});

describe('the divergence aggregate on the daily head', () => {
  it('compares each source with the others on shared subject-days, with exact counts and dates', async () => {
    const stats = new Map((await readOutletDivergenceStats(pool, 90)).map((s) => [s.source, s]));
    expect([...stats.keys()].sort()).toEqual([A, B, U, C, T].sort()); // the lone source was never compared
    const a = stats.get(A)!;
    expect(a).toMatchObject({ comparisons: 6, subjects: 2, observations: 9, firstDay: D1, lastDay: D3 });
    expect(a.meanDivergence).toBeCloseTo(0.4, 9);
    expect(a.sdDivergence).toBeCloseTo(Math.sqrt(0.075), 9);
    expect(a.meanAbsDivergence).toBeCloseTo(0.4, 9);
    const b = stats.get(B)!;
    expect(b).toMatchObject({ comparisons: 6, subjects: 2, observations: 6, firstDay: D1, lastDay: D3 });
    expect(b.meanDivergence).toBeCloseTo(-0.05, 9);
    expect(b.sdDivergence).toBeCloseTo(Math.sqrt(0.048), 9);
    expect(b.meanAbsDivergence).toBeCloseTo(0.2, 9);
    const c = stats.get(C)!;
    expect(c.meanDivergence).toBeCloseTo(-0.35, 9);
    expect(c.sdDivergence).toBeCloseTo(Math.sqrt(0.003), 9);
    expect(c.meanAbsDivergence).toBeCloseTo(0.35, 9);
    expect(stats.get(T)).toMatchObject({ comparisons: 1, subjects: 1, observations: 1, firstDay: D1, lastDay: D1, sdDivergence: null });
    expect(stats.get(T)!.meanDivergence).toBeCloseTo(1, 9);
  });

  it('lets the window exclude old rows (a 365-day window sees them)', async () => {
    const wide = new Map((await readOutletDivergenceStats(pool, 365)).map((s) => [s.source, s]));
    expect(wide.get(A)!.comparisons).toBe(7);
    expect(wide.get(A)!.firstDay).toBe(daysAgo(200));
  });
});

describe('the service rates every source from those rows', () => {
  it('rates above the minimums and marks the thin pair insufficient', async () => {
    const set = await svc.outletRatings();
    expect(set).toMatchObject({ method: 'consensus-divergence-v1', windowDays: 90, minComparisons: 4, minSubjects: 2, leanZ: 2 });
    expect(set.ratings.get(A)).toMatchObject({ status: 'rated', lean: 0.4, leanBucket: 'above', reliability: 0.8, comparisons: 6, observations: 9 });
    expect(set.ratings.get(B)).toMatchObject({ status: 'rated', lean: -0.05, leanBucket: 'near', reliability: 0.9 });
    expect(set.ratings.get(C)).toMatchObject({ status: 'rated', lean: -0.35, leanBucket: 'below', reliability: 0.825 });
    expect(set.ratings.get(T)).toMatchObject({ status: 'insufficient', lean: null, reliability: null, comparisons: 1 });
    expect(set.ratings.has(V)).toBe(false);
  });

  it('gives the same ratings from the same stored rows', async () => {
    const first = await svc.outletRatings();
    const second = await svc.outletRatings();
    expect([...second.ratings.entries()]).toEqual([...first.ratings.entries()]);
  });
});

describe('the subject breakdown is read through the ratings', () => {
  it('builds the subject breakdown from those ratings', async () => {
    const r = await svc.sentimentBreakdown('world:topic:s1', 30) as Record<string, any>;
    expect(r).not.toHaveProperty('political');
    expect(r.lean.byLean.below).toBeCloseTo(0, 9);
    expect(r.lean.byLean.near).toBeCloseTo(0.1, 9);
    expect(r.lean.byLean.above).toBeCloseTo(0.7, 9);
    expect(r.balanced).toBeCloseTo(0.267, 3);
    // 0.7 - 0.0 sits exactly on the mixed/divergent boundary, so only the spread is asserted here;
    // the consensus label is asserted on the 365-day read below, far from any boundary.
    expect(r.lean.spread).toBeCloseTo(0.7, 9);
    expect(r.reliabilityWeighted).toBeCloseTo(0.257, 3);
    const alpha = r.bySource.find((s: { source: string }) => s.source === A);
    expect(alpha).toMatchObject({ points: 6, bias: 'above', lean: 0.4, reliability: 0.8 });
    expect(alpha.rating).toMatchObject({ comparisons: 6, subjects: 2, observations: 9, firstObserved: D1, lastObserved: D3 });
    expect(r.ratings).toMatchObject({ rated: 3, insufficient: 0, minComparisons: 4, minSubjects: 2 });
  });

  it('keeps the rating window independent of the read window', async () => {
    // 365 days pulls the old s1 rows into the per-source means (alpha 5.2/7, beta -0.7/4, gamma -1/4)
    // while every rating is still the 90-day one.
    const r = await svc.sentimentBreakdown('world:topic:s1', 365) as Record<string, any>;
    expect(r.ratings.windowDays).toBe(90);
    expect(r.bySource.find((s: { source: string }) => s.source === A)).toMatchObject({ points: 7, lean: 0.4, reliability: 0.8 });
    expect(r.lean.byLean.above).toBeCloseTo(5.2 / 7, 9);
    expect(r.lean.byLean.near).toBeCloseTo(-0.175, 9);
    expect(r.lean.byLean.below).toBeCloseTo(-0.25, 9);
    expect(r.lean.spread).toBeCloseTo(5.2 / 7 + 0.25, 3);
    expect(r.consensus).toBe('divergent');
    expect(r.reliabilityWeighted).toBeCloseTo(0.091, 3);
  });

  it('shows a subject covered only by insufficient sources as insufficient, not a number', async () => {
    const r = await svc.sentimentBreakdown('world:topic:s3', 30) as Record<string, any>;
    expect(r.lean.consensus).toBe('insufficient');
    expect(r.lean.byLean).toEqual({ below: null, near: null, above: null });
    expect(r.reliabilityWeighted).toBeNull();
    expect(r.bySource.map((s: { bias: string }) => s.bias)).toEqual(['insufficient', 'insufficient']);
    expect(r.ratings).toMatchObject({ rated: 0, insufficient: 2 });
  });
});

// Last on purpose: it adds rows, and every block above reads the original ones.
describe('a rating changes only when stored rows change', () => {
  it('rates the thin source once it has the data, and leaves the others as they were', async () => {
    for (const day of [D2, D3]) {
      await observe('world:topic:s3', 'sentiment', day, 0.5, T);
      await observe('world:topic:s3', 'sentiment', day, -0.5, U);
    }
    await observe('world:topic:s5', 'sentiment', D1, 0.5, T);
    await observe('world:topic:s5', 'sentiment', D1, -0.5, U);
    await refreshHead();
    const set = await svc.outletRatings();
    expect(set.ratings.get(T)).toMatchObject({ status: 'rated', lean: 1, leanBucket: 'above', reliability: 0.5, comparisons: 4, subjects: 2 });
    expect(set.ratings.get(U)).toMatchObject({ status: 'rated', lean: -1, leanBucket: 'below', reliability: 0.5 });
    expect(set.ratings.get(A)).toMatchObject({ lean: 0.4, reliability: 0.8, comparisons: 6 });
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Read the per-source divergence statistics oshal's own outlet ratings are computed from (operator decision 2026-09-22: no external rating license, ever). One aggregate over the daily sentiment head: per subject and day, each source's mean against the mean of the OTHER sources' means; per source, the count, subjects, observations, date range and divergence moments. Memoized per window for one head refresh interval and run through the series-read gate, so the rollup and the surface share one read.
 */

/**
 * @description The I/O half of the observed outlet ratings. The arithmetic that turns these
 * statistics into a rating is pure and lives in outlet-ratings.ts (rateOutlets).
 *
 * The statistics come from the daily head (`world_metrics_daily`, metric 'sentiment'), whose rows
 * are exact per-day sums and counts of the stored stream, so the same stored rows always give the
 * same rating. Only subject-days scored by two or more sources are compared, and each source is
 * compared with the others only (leave-one-out), so a source never agrees with itself.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  outletRatingParams,
  rateOutlets,
  type OutletDivergenceStats,
  type OutletRatingParams,
  type OutletRatingSet,
} from './outlet-ratings';
import { METRICS_DAILY_VIEW, alignedWindowStart } from './world-preaggregate';
import { runSeriesRead, seriesReadKey } from './world-series-gate';

const logger = createChildLogger({ module: 'outlet-observations' });

/** How long a computed rating set is reused: the head's refresh policy runs every 30 minutes, so a
 *  fresher read could not see new rows anyway. Overridable with WORLD_OUTLET_RATING_TTL_MS. */
const DEFAULT_TTL_MS = 30 * 60_000;

/** The divergence aggregate. $1 = the window in whole days (aligned to the head's day buckets). */
const DIVERGENCE_SQL = `
  WITH per AS (
    SELECT bucket, entity, source, sum(sum_v) / NULLIF(sum(cnt), 0) AS m, sum(cnt)::bigint AS n
      FROM ${METRICS_DAILY_VIEW}
     WHERE metric = 'sentiment' AND source IS NOT NULL AND bucket >= ${alignedWindowStart('$1')}
     GROUP BY bucket, entity, source
  ), ctx AS (
    SELECT bucket, entity, source, m, n,
           sum(m) OVER (PARTITION BY bucket, entity) AS sum_m,
           count(*) OVER (PARTITION BY bucket, entity) AS k
      FROM per WHERE m IS NOT NULL
  ), div AS (
    SELECT source, entity, bucket, n, m - (sum_m - m) / (k - 1) AS d FROM ctx WHERE k >= 2
  )
  SELECT source,
         count(*)::int AS comparisons,
         count(DISTINCT entity)::int AS subjects,
         sum(n)::bigint AS observations,
         to_char(min(bucket) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first_day,
         to_char(max(bucket) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last_day,
         avg(d) AS mean_div,
         stddev_samp(d) AS sd_div,
         avg(abs(d)) AS mean_abs_div
    FROM div
   GROUP BY source`;

type StatsRow = {
  source: string; comparisons: number; subjects: number; observations: string | number;
  first_day: string | null; last_day: string | null;
  mean_div: string | number | null; sd_div: string | number | null; mean_abs_div: string | number | null;
};

const numOrNull = (v: string | number | null): number | null => (v == null ? null : Number(v));

/**
 * @description Read every source's divergence statistics over the trailing window.
 * @param pool - The world series pool (TimescaleDB) whose head is already ensured.
 * @param windowDays - Trailing whole days.
 * @returns One statistics row per source that had at least one compared subject-day.
 */
export async function readOutletDivergenceStats(pool: Pool, windowDays: number): Promise<OutletDivergenceStats[]> {
  const r = await runSeriesRead(seriesReadKey('outlet-divergence', windowDays), () => pool.query(DIVERGENCE_SQL, [windowDays]));
  return (r.rows as StatsRow[]).map((row) => ({
    source: String(row.source),
    comparisons: Number(row.comparisons),
    subjects: Number(row.subjects),
    observations: Number(row.observations),
    firstDay: row.first_day,
    lastDay: row.last_day,
    meanDivergence: numOrNull(row.mean_div),
    sdDivergence: numOrNull(row.sd_div),
    meanAbsDivergence: numOrNull(row.mean_abs_div),
  }));
}

/** The reuse interval: WORLD_OUTLET_RATING_TTL_MS when it is a non-negative number, else the default. */
function ratingTtlMs(env: NodeJS.ProcessEnv): number {
  const text = (env.WORLD_OUTLET_RATING_TTL_MS || '').trim();
  const n = Number(text);
  return text !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

/** A memoized reader of the observed rating set. */
export interface OutletRatingReader {
  /** The current rating set (recomputed at most once per TTL; concurrent callers share one read). */
  read(): Promise<OutletRatingSet>;
}

/**
 * @description Build the memoized rating reader one world service holds.
 * @param pool - The world series pool.
 * @param env - Process environment (rating parameters and WORLD_OUTLET_RATING_TTL_MS).
 * @param now - Clock seam for the TTL (tests).
 * @returns The reader.
 */
export function createOutletRatingReader(pool: Pool, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now): OutletRatingReader {
  const params: OutletRatingParams = outletRatingParams(env);
  const ttlMs = ratingTtlMs(env);
  let memo: { at: number; set: Promise<OutletRatingSet> } | null = null;
  return {
    read(): Promise<OutletRatingSet> {
      if (memo && now() - memo.at < ttlMs) return memo.set;
      const at = now();
      const set = readOutletDivergenceStats(pool, params.windowDays)
        .then((stats) => rateOutlets(stats, params, new Date(at).toISOString()));
      memo = { at, set };
      // A failed read must not be served from the memo for a whole TTL.
      set.catch((err: unknown) => {
        logger.error({ err, windowDays: params.windowDays }, 'outlet rating read failed — the next read retries');
        if (memo?.set === set) memo = null;
      });
      return set;
    },
  };
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The HEAD over the world running stream: a daily continuous aggregate for world_metrics + a world_subjects catalog head. Reads were re-aggregating the raw stream on every call — the trading autopilot's 100-name basket cost 10.5s every 5 minutes and the cockpit surface needed 7.8s just to list its subjects. See docs/architecture/world-read-head-and-stream.md.
 */

/**
 * @description World-layer PRE-AGGREGATION — the "head" that sits in front of the running stream.
 *
 * The world layer has two shapes of data and they want different storage:
 *
 *  - the RUNNING STREAM (`world_metrics`, `world_items`, `world_pulls`) — every observation, kept
 *    forever, the substrate for backtests and deep history;
 *  - the HEAD — the small, current, pre-aggregated answer that interactive readers actually want
 *    (the trading autopilot's influence gate, the cockpit surface, Jarvis' brief).
 *
 * Before this module every head read was computed by re-scanning the stream. That is why the
 * feature rollup made things WORSE rather than better: `rollupFeatures` already pre-computes the
 * signal vector, but it appends its answers back into `world_metrics`, so the pre-aggregated
 * numbers became 88% of the very stream that readers then had to re-aggregate. The stream grows
 * ~6M rows/month, so every read got slower every month.
 *
 * Two heads are built here:
 *
 *  1. `world_metrics_daily` — a TimescaleDB continuous aggregate bucketing the metric stream to
 *     (day, entity, metric, source) with `sum(value)` + `count(*)`. Readers recover an EXACT mean as
 *     `sum(sum_v)/sum(cnt)` — this is arithmetically identical to `avg(value)` over the same rows,
 *     not an approximation, which is what makes it safe to put under the trading path.
 *  2. `world_subjects` — one row per tracked subject (label, item count, last seen), maintained
 *     incrementally as items are archived, so listing the catalog is a 400-row read instead of a
 *     full aggregation of a million-row archive.
 *
 * WHY `materialized_only = false` IS LOAD-BEARING: with it, a continuous aggregate that has never
 * been materialized still returns the CORRECT answer (TimescaleDB computes the un-materialized span
 * from the raw hypertable) — it is merely as slow as the old path until the refresh lands. Without
 * it (and `true` is the DEFAULT in TimescaleDB 2.13+, verified on 2.28) an unmaterialized aggregate
 * returns ZERO ROWS, which the trading gate reads as "no world coverage" and silently drops the
 * signal. A fast wrong number under an autopilot is far worse than a slow right one, so the read
 * path must never be able to see an empty head as an answer.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'world-preaggregate' });

/** The daily metric head (continuous aggregate over `world_metrics`). */
export const METRICS_DAILY_VIEW = 'world_metrics_daily';
/** The subject-catalog head (one row per tracked world subject). */
export const SUBJECTS_TABLE = 'world_subjects';

/**
 * Chunk interval for the metric stream. The original 7 days was sized for "a few months of live
 * feeds", but archived articles carry their REAL publication date (CNN 1995, CNBC 2000), so the
 * hypertable spans ~50 years: 798 weekly chunks, 739 of which held 0.7% of the rows. A wide query
 * then paid a 798-chunk planning fan-out — 1.1s of PLANNING to touch three buffers of data. Widening
 * to 30 days cuts the sparse historical tail ~4x. It applies to chunks created from here on;
 * existing chunks keep their interval (they are not rewritten, and the old rows are real history —
 * nothing is dropped).
 */
const CHUNK_INTERVAL_DAYS = 30;

/**
 * @description Create (idempotently) the daily metric head and its refresh policy, and widen the
 * chunk interval for future stream chunks. Safe to call on every service warm-up: every statement is
 * `IF NOT EXISTS`-guarded, and a failure is logged and swallowed so the caller degrades to reading
 * the raw stream rather than failing the request.
 * @param pool - The TSDB pool (the world series store).
 * @returns Nothing; failures are logged, not thrown.
 */
export async function ensureMetricsPreaggregate(pool: Pool): Promise<void> {
  // Future chunks only — cheap metadata change, no rewrite of existing chunks.
  try {
    await pool.query(`SELECT set_chunk_time_interval('world_metrics', INTERVAL '${CHUNK_INTERVAL_DAYS} days')`);
  } catch (err) {
    logger.warn({ err }, 'set_chunk_time_interval on world_metrics failed — new chunks keep the previous interval');
  }

  // The head itself. WITH NO DATA so creating it never blocks a request on a full materialization
  // (the first one over ~9M rows takes ~50s); the policy below fills it in, and until it does the
  // real-time setting keeps answers correct.
  try {
    await pool.query(
      `CREATE MATERIALIZED VIEW IF NOT EXISTS ${METRICS_DAILY_VIEW}
         WITH (timescaledb.continuous) AS
         SELECT time_bucket('1 day', ts) AS bucket, entity, metric, source,
                sum(value) AS sum_v, count(*)::bigint AS cnt
           FROM world_metrics
          GROUP BY 1, 2, 3, 4
         WITH NO DATA`,
    );
  } catch (err) {
    logger.warn({ err }, 'world_metrics_daily create failed — reads fall back to the raw stream');
    return;
  }

  // See the module note: this is a CORRECTNESS setting, not a tuning knob. Applied unconditionally
  // (not just at create time) so an aggregate created by an older build gets repaired on warm-up.
  try {
    await pool.query(`ALTER MATERIALIZED VIEW ${METRICS_DAILY_VIEW} SET (timescaledb.materialized_only = false)`);
  } catch (err) {
    logger.error({ err }, 'could not set materialized_only=false on world_metrics_daily — an unmaterialized head returns EMPTY, which reads as "no coverage"; leaving the head in place but it must be repaired');
  }

  // TimescaleDB auto-indexes each GROUP BY column against the bucket individually — (entity,bucket),
  // (metric,bucket), (source,bucket) — but every hot read filters on entity AND metric together, so
  // none of them is selective enough on its own. The composite is worth 3x on the sentiment read
  // (442ms -> 133ms measured) and is what keeps the trading basket flat as the head grows.
  try {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS world_metrics_daily_entity_metric_bucket_idx
         ON ${METRICS_DAILY_VIEW} (entity, metric, bucket DESC)`,
    );
  } catch (err) {
    logger.warn({ err }, 'world_metrics_daily (entity,metric,bucket) index create failed — head reads will be slower');
  }

  // start_offset NULL = the whole history, deliberately. Archived articles arrive with old
  // publication dates, so invalidations land in buckets years back; a bounded window would leave
  // those buckets permanently stale. A full-range refresh only processes INVALIDATED ranges, so it
  // is incremental in practice (measured: 49s for the initial build, then ~0.8s per run).
  try {
    await pool.query(
      `SELECT add_continuous_aggregate_policy('${METRICS_DAILY_VIEW}',
                start_offset => NULL,
                end_offset => INTERVAL '1 hour',
                schedule_interval => INTERVAL '30 minutes',
                if_not_exists => TRUE)`,
    );
  } catch (err) {
    logger.warn({ err }, 'world_metrics_daily refresh policy not added — the head stays correct via real-time aggregation but will not get faster until refreshed');
  }
}

/**
 * @description Create (idempotently) the subject-catalog head and backfill it from the archive the
 * first time. Also adds the `world_pulls (entity_id, ts)` index — the pull-rate read filtered on
 * `entity_id` with only a `ts` index to work from, so it sequential-scanned every chunk.
 * @param pool - The TSDB pool.
 * @returns Nothing; failures are logged, not thrown.
 */
export async function ensureSubjectsHead(pool: Pool): Promise<void> {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${SUBJECTS_TABLE} (
         entity TEXT PRIMARY KEY,
         label TEXT,
         items BIGINT NOT NULL DEFAULT 0,
         last_seen TIMESTAMPTZ
       )`,
    );
    // The catalog is read "most-covered first", so the ordering column needs its own index.
    await pool.query(`CREATE INDEX IF NOT EXISTS world_subjects_items_idx ON ${SUBJECTS_TABLE} (items DESC)`);
  } catch (err) {
    logger.warn({ err }, 'world_subjects head create failed — listEntities falls back to aggregating the archive');
    return;
  }

  // Backfill once. An empty head is indistinguishable from "nothing tracked yet", so this runs only
  // when the head is empty AND the archive is not — on a fresh install both are empty and this is a
  // no-op. INSERT ... ON CONFLICT keeps it safe if two containers warm up concurrently.
  try {
    const seeded = await pool.query(`SELECT 1 FROM ${SUBJECTS_TABLE} LIMIT 1`);
    if (seeded.rowCount === 0) {
      const res = await pool.query(
        `INSERT INTO ${SUBJECTS_TABLE} (entity, label, items, last_seen)
         SELECT entity_id, max(entity_label), count(*), max(first_seen_at)
           FROM world_items GROUP BY entity_id
         ON CONFLICT (entity) DO NOTHING`,
      );
      if (res.rowCount) logger.info({ subjects: res.rowCount }, 'world_subjects head backfilled from the archive');
    }
  } catch (err) {
    logger.warn({ err }, 'world_subjects backfill failed — the head will fill in as new items are archived');
  }

  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS world_pulls_entity_ts_idx ON world_pulls (entity_id, ts DESC)`);
  } catch (err) {
    logger.warn({ err }, 'world_pulls (entity_id, ts) index create failed — pull-rate reads stay slow');
  }
}

/**
 * @description SQL fragment for the inclusive start of an N-day window, aligned to a whole day.
 *
 * The head buckets by day, so a window must start on a bucket boundary to read the head exactly.
 * This also makes a window REPRODUCIBLE: "the last 30 days" now means 30 whole days rather than a
 * trailing 30x24h that shifts every second, so two reads a minute apart agree and a replayed
 * backtest matches the live read. The cost is that a window reaches back to midnight of its first
 * day, so it can include up to one extra day of observations at the far edge.
 * The day count is cast to `int` and multiplied by a literal interval rather than concatenated into
 * an interval string: the parameter's type is then unambiguous to the planner, which a bare
 * `$n::text || ' days'` is not when the driver sends the parameter untyped.
 * @param daysParam - The bind-parameter placeholder holding the day count (e.g. '$3').
 * @returns A SQL expression usable in a WHERE clause.
 */
export function alignedWindowStart(daysParam: string): string {
  return `date_trunc('day', now()) - (${daysParam}::int * INTERVAL '1 day')`;
}

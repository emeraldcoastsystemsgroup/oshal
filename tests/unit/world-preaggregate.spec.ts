/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the world read HEAD: the pre-aggregated mean must equal the raw-stream mean, the window must stay day-aligned, and materialized_only must stay false (an unmaterialized head with materialized_only=true returns ZERO rows, which the trading gate reads as "no coverage").
 */

/**
 * @description Guards for the world-layer pre-aggregation (see world-preaggregate.ts).
 *
 * The head sits under the trading autopilot's influence gate, so the failure that matters is not
 * "slow" — it is "fast and quietly wrong". The properties pinned here are the ones whose violation
 * would not show up as an error, only as different numbers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { alignedWindowStart, METRICS_DAILY_VIEW, SUBJECTS_TABLE } from '../../src/features/world-data/world-preaggregate';

const SLICE = join(__dirname, '..', '..', 'src', 'features', 'world-data');
const preaggSrc = readFileSync(join(SLICE, 'world-preaggregate.ts'), 'utf8');
const serviceSrc = readFileSync(join(SLICE, 'world-intelligence-service.ts'), 'utf8');

/**
 * The SQL a service method issues, with the slice's table/view constants resolved. The source
 * interpolates them (`${METRICS_DAILY_VIEW}`), so resolving here lets the assertions below name the
 * real relation — and so a hardcoded wrong table name still fails.
 */
function sqlOf(method: string): string {
  const start = serviceSrc.indexOf(`async ${method}(`);
  expect(start, `${method} not found in the service`).toBeGreaterThan(-1);
  const body = serviceSrc.slice(start);
  const q = body.indexOf('this.tsdb.query(');
  expect(q, `${method} issues no query`).toBeGreaterThan(-1);
  return body
    .slice(q, body.indexOf('`,', q) + 1)
    .split('${METRICS_DAILY_VIEW}').join(METRICS_DAILY_VIEW)
    .split('${SUBJECTS_TABLE}').join(SUBJECTS_TABLE)
    .split('${alignedWindowStart(\'$2\')}').join(alignedWindowStart('$2'))
    .split('${alignedWindowStart(\'$3\')}').join(alignedWindowStart('$3'));
}

describe('world pre-aggregate — the mean must survive pre-aggregation', () => {
  it('sum/count recovers the exact stream mean, and is not a mean-of-means', () => {
    // Deliberately lopsided: 3 observations one day, 1 the next. A weighted mean over (sum, count)
    // equals the mean over the 4 raw observations; averaging the two daily means does not.
    const buckets = [{ sum: 0.9, cnt: 3 }, { sum: 0.9, cnt: 1 }];
    const totalSum = buckets.reduce((a, b) => a + b.sum, 0);
    const totalCnt = buckets.reduce((a, b) => a + b.cnt, 0);

    expect(totalSum / totalCnt).toBeCloseTo(1.8 / 4, 12); // == avg(value) over the raw rows
    expect(totalSum / totalCnt).not.toBeCloseTo((0.3 + 0.9) / 2, 3); // != mean-of-means
  });

  it.each(['metricAvg', 'metricsBatch', 'sentimentBreakdown'])(
    '%s reads the head and recovers the mean as sum(sum_v)/sum(cnt)',
    (method) => {
      const sql = sqlOf(method);
      expect(sql, 'must read the pre-aggregated head').toContain(METRICS_DAILY_VIEW);
      expect(sql, 'must weight by observation count').toMatch(/sum\(sum_v\)\s*\/\s*NULLIF\(sum\(cnt\), 0\)/);
      expect(sql, 'must not average the buckets — that is a mean-of-means').not.toMatch(/avg\(/);
    },
  );

  it('keeps the sub-day rollup window on the raw stream', () => {
    // perSourceSentimentHours serves rollupFeatures' 24h/168h windows — below day granularity, so it
    // must NOT be moved onto the daily head, which cannot answer an hours-scale window.
    const sql = sqlOf('perSourceSentimentHours');
    expect(sql).toContain('FROM world_metrics');
    expect(sql).not.toContain(METRICS_DAILY_VIEW);
    expect(sql, 'must stay an hours-scale window').toContain("' hours')::interval");
  });
});

describe('world pre-aggregate — window alignment', () => {
  it('aligns the window start to a whole day, matching the bucket width', () => {
    const sql = alignedWindowStart('$3');
    expect(sql).toContain("date_trunc('day', now())");
    // Typed interval arithmetic, not string concatenation into an untyped bind parameter.
    expect(sql).toContain("$3::int * INTERVAL '1 day'");
    expect(sql).not.toContain("|| ' days'");
  });

  it('is what the head-backed reads actually use', () => {
    for (const method of ['metricAvg', 'metricsBatch', 'sentimentBreakdown']) {
      expect(sqlOf(method), `${method} must use the aligned window`).toContain("date_trunc('day', now())");
    }
  });
});

describe('world pre-aggregate — the head can never read as empty', () => {
  it('forces materialized_only=false', () => {
    // TimescaleDB 2.13+ defaults this to TRUE, and with it true an aggregate that has not been
    // materialized returns ZERO rows instead of falling through to the raw stream — which the
    // trading gate cannot distinguish from "this subject has no world coverage".
    expect(preaggSrc).toContain('timescaledb.materialized_only = false');
    expect(preaggSrc).not.toMatch(/materialized_only\s*=\s*true/);
  });

  it('refreshes the whole history, not a bounded recent window', () => {
    // Archived articles carry their real publication date, so invalidations land in buckets years
    // back; a bounded start_offset would leave those permanently stale.
    expect(preaggSrc).toMatch(/start_offset\s*=>\s*NULL/);
  });

  it('creates the head without blocking on a full materialization', () => {
    expect(preaggSrc).toContain('WITH NO DATA');
  });
});

describe('world pre-aggregate — the catalog head', () => {
  it('listEntities reads the head instead of aggregating the archive', () => {
    const sql = sqlOf('listEntities');
    expect(sql).toContain(SUBJECTS_TABLE);
    // The full 1.36 GB sequential scan this replaced.
    expect(sql).not.toContain('FROM world_items');
    expect(sql).not.toContain('GROUP BY entity_id');
  });

  it('archiveItem keeps the head in step, counting only genuinely new items', () => {
    const start = serviceSrc.indexOf('async archiveItem(');
    const body = serviceSrc.slice(start, serviceSrc.indexOf('async existingHashes('));
    expect(body).toContain(SUBJECTS_TABLE);
    expect(body).toContain('ON CONFLICT (entity) DO UPDATE');
    // A re-sighting must not inflate the count (the archive counts distinct items, so the head must too).
    expect(body).toContain('inserted ? 1 : 0');
  });

  it('indexes world_pulls on the column the pull-rate read filters by', () => {
    expect(preaggSrc).toMatch(/world_pulls \(entity_id, ts DESC\)/);
  });

  it('indexes the head on (entity, metric, bucket) — the shape every hot read filters by', () => {
    // TimescaleDB's auto-created indexes pair each GROUP BY column with the bucket separately, so
    // none of them covers an entity+metric filter on its own.
    expect(preaggSrc).toMatch(/\(entity, metric, bucket DESC\)/);
  });
});

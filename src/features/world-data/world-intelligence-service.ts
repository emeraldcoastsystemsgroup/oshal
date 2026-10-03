/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-058 Layer B: World-Intelligence Service — shared world graph (ArangoDB) + series (TimescaleDB)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Update docs/ paths after docs directory consolidation
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Memoize the service per TSDB url — the factory built a new un-ended pg Pool on every scheduler tick (every 5 min via trading-assess-dispatch), a steady connection leak (2026-07-05 leak audit)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | scheduledEventsBetween(eventType, fromIso, toIso) — ranged sibling of upcomingEvents (now()-anchored) for the Strategy Lab earnings-gate walks, which need "who prints between session D and D+N" for past walk dates; ingested calendar rows persist, so pinned regression windows replay identically.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Read the windowed averages and the subject catalog from the pre-aggregated HEAD (world-preaggregate) instead of re-scanning the running stream on every call. The trading autopilot's 100-name basket read cost 10.5s every 5 minutes and listEntities cost 7.8s to return 402 rows; both are now sub-200ms. Means are recovered as sum/count, which is arithmetically identical to avg over the same rows — verified equal across 6,714 (entity,metric) pairs.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Put the rollup's four per-entity reads behind the bounded, coalescing series gate, and answer a whole-day sentiment window from the daily HEAD instead of scanning the stream per source. The 2026-09-14 saturation had both shapes: 19 concurrent sessions on oshal-local-tsdb (282% CPU) all running perSourceSentimentHours, and overlapping pulses recomputing the same aggregate twice. Measured read-only on the live store: the 24h stream read is 786ms planning + 366ms execution and the 168h one 810 + 651, against 245 + 16 and 303 + 20 for the same answers off world_metrics_daily — which carries `source`, so it can answer the per-source question. Whole-day windows are now day-aligned, matching the head-backed metricAvg the trading gate already reads these features back through.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Own the memoized TimescaleDB pool's connection 'error' events (ownPoolConnectionErrors) - a server-terminated connection on an unowned pool is an uncaught exception that ends the api process.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Expose a bounded latest-point read that preserves timestamp/source provenance for feed-backed read-only consumers such as the Trading congressional watchlist projection.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Record when a feed point was observed: world_metrics gains a nullable observed_at column (added once, never back-stamped onto existing rows), writeMetric takes an optional observedAt, and writeMetricIfChanged appends a point only when the newest stored value for the same entity/metric/ts/source differs, so a collector re-reading the same disclosure window stops piling identical rows. latestMetricPoints breaks same-ts ties on observed_at and returns it. recentFeedMetricPoints is the bounded "which names did this feed disclose lately" read the Trading disclosure list needs. The congress_* namespace and the quiver-congress source are reserved: ingest() refuses them, and writeMetric only accepts them together.
 * 10 | maintainer@emeraldcoastsystemsgroup.com  | Read sentiment through oshal's OWN observed outlet ratings (operator decision 2026-09-22: the seed table is deleted, no external license). sentimentBreakdown and rollupFeatures take the rating set from one memoized reader (outlet-observations.ts) over the daily head, and outletRatings() exposes it. No schema change: the ratings are computed from the stored sentiment series on read.
 * 11 | maintainer@emeraldcoastsystemsgroup.com  | rollupFeatures was already over the 50-line function limit and entry 10 grew it by a line, so its attention, sentiment and catalyst reads move into three private helpers (rollupAttention, rollupSentiment, rollupEvents). Code motion only: the same statements, in the same order, under the same series-gate keys, and the same features written.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | sourceControl(): the operator source switches and collector run record (world-source-control.ts) on this service's series-store pool, one instance per pool.
 */

/**
 * World-Intelligence Service (Layer B) — the sibling of the Personal-Intelligence Service, but for the
 * SHARED world. Same propose/dispose rule: feeder bots (the beefed-up news-aggregator) PROPOSE
 * WorldContributions; this deterministic service DISPOSES — writing the shared world graph and series.
 *
 * It is the only writer of the `world` tenant graph + the `world_metrics` hypertable. Start-param
 * gated (ENABLE_WORLD_INTELLIGENCE). Graph → ArangoDB via the ADR-045 connector (`getTenantGraph`);
 * time-series → TimescaleDB. World entities use canonical ids (`world:<type>:<key>`), so upsert-by-id
 * is idempotent and resolution is free.
 */
import { Pool } from 'pg';
import { readWorldCoverage } from './world-coverage-read';
import { worldSourceControl, type WorldSourceControl } from './world-source-control';
import { createGraphConnector, type GraphConnector, type GraphNode, type GraphEdge } from '@/features/graph';
import { createChildLogger } from '@/shared/logger';
import { ownPoolConnectionErrors } from '@/shared/services/database';
import {
  CongressTradeQueryFilter,
  CongressTradeRecord,
  isReservedCongressMetric,
  isReservedCongressSource,
  type WorldContribution,
} from './world-types';
import { computeSentimentBreakdown, type SentimentBreakdown, type SentimentRow } from './sentiment-math';
import { createOutletRatingReader, type OutletRatingReader } from './outlet-observations';
import type { OutletRatingSet } from './outlet-ratings';
import {
  METRICS_DAILY_VIEW,
  SUBJECTS_TABLE,
  alignedWindowStart,
  ensureMetricsPreaggregate,
  ensureSubjectsHead,
} from './world-preaggregate';
import { runSeriesRead, seriesReadKey } from './world-series-gate';

const logger = createChildLogger({ module: 'world-intelligence-service' });
const WORLD_TENANT = 'world';

/** Map a bias-consensus label to a numeric feature in [0,1] (null when insufficient). */
function consensusScore(c: string): number | null {
  return c === 'agree' ? 1 : c === 'mixed' ? 0.5 : c === 'divergent' ? 0 : null;
}
/** Population stdev of a sample (null when <2 points) — sentiment dispersion across outlets. */
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}
const round3 = (x: number | null): number | null => (x != null && Number.isFinite(x) ? Number(x.toFixed(3)) : null);

/** True for an ArangoDB write-write conflict (optimistic-locking contention) — safe to retry. */
function isWriteConflict(e: unknown): boolean {
  const err = e as { errorNum?: number; code?: number } | null;
  return err?.errorNum === 1200 || err?.code === 409;
}

/** Retry a graph write on write-write conflict with jittered backoff. Concurrent ingests into the
 *  SHARED world graph (the ticker pulse refreshes many names at once) race on shared nodes; Arango
 *  aborts the loser, so we retry it. Non-conflict errors propagate immediately. */
async function withWriteConflictRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!isWriteConflict(e)) throw e;
      lastErr = e;
      const backoff = Math.min(500, 25 * 2 ** i) + Math.floor(Math.random() * 25);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

export interface WorldIngestResult { nodes: number; edges: number; facts: number; }

/** One latest raw metric point, retaining the source and timestamps that make it auditable. */
export interface LatestMetricPoint {
  entity: string;
  metric: string;
  /** The series timestamp (for a feed point, the source-backed day it describes). */
  ts: string;
  value: number;
  source: string | null;
  /** When the collector read this point from its feed; null for rows written before it was recorded. */
  observedAt: string | null;
}

/** Hard caps on the recent-feed read: it backs an interactive list, never a scan. */
const RECENT_FEED_MAX_DAYS = 120;
const RECENT_FEED_MAX_ENTITIES = 100;
const RECENT_FEED_MAX_METRICS = 20;

/**
 * @description Refuse a congressional disclosure point unless metric and source are paired. The
 * disclosure feed collector is the only caller that writes that pairing; any other writer naming
 * either half would be authoring a congressional holding the feed never reported.
 * @param metric - Metric being written.
 * @param source - Provenance being written.
 * @returns Nothing; throws on a mismatched pairing.
 */
function assertCongressProvenance(metric: string, source: string): void {
  if (isReservedCongressMetric(metric) !== isReservedCongressSource(source)) {
    throw new Error(`world metric ${metric} with source ${source}: congress_* points are written only with the quiver-congress feed source`);
  }
}

/** Map a raw latest-point row into its auditable shape. */
function toLatestPoint(row: { entity: string; metric: string; ts: string | Date; value: string | number; source?: string | null; observed_at?: string | Date | null }): LatestMetricPoint {
  return {
    entity: String(row.entity), metric: String(row.metric), ts: new Date(row.ts).toISOString(),
    value: Number(row.value), source: row.source == null ? null : String(row.source),
    observedAt: row.observed_at == null ? null : new Date(row.observed_at).toISOString(),
  };
}

/** The immutable record of one pulled item + what we classified it as — the backtest substrate. */
export interface ArchiveRecord {
  itemHash: string;
  entityId: string; entityLabel: string;
  feedId: string; category: string; queryVariant: string;
  outlet: string; outletId: string | null; lean: number | null; reliability: number | null;
  title: string; description: string; link: string; pubDate: string | null;
  sentiment: number | null; entities: Array<{ name: string; type: string }>;
  eventType: string | null; eventIntensity: number | null;
  classifierModel: string; classifierVersion: string; usedLlm: boolean;
}

export interface PullLogRecord {
  entityId: string; feedId: string; category: string;
  fetched: number; uniqueItems: number; newItems: number; classified: number; usedLlm: boolean;
  variants: Array<{ label: string; fetched: number }>;
}

/** An archived item rehydrated for backtesting. */
export interface ArchivedItem {
  itemHash: string; entityId: string; entityLabel: string;
  title: string; description: string; outlet: string;
  sentiment: number | null; entities: Array<{ name: string; type: string }>;
  classifierModel: string; classifierVersion: string; pubDate: string | null;
}

export class WorldIntelligenceService {
  /** Shared archive coverage only; unlike historical readers this never bootstraps a schema. */
  async coverageSnapshot(subjects?: readonly string[]) { return readWorldCoverage(this.tsdb, new Date(), subjects); }
  /** The operator's source switches and the collector run record, on this service's series store. */
  sourceControl(): WorldSourceControl { return worldSourceControl(this.tsdb); }
  private seriesReady = false;
  private archiveReady = false;
  private eventsReady = false;
  private congressTradesReady = false;
  private ratingReader: OutletRatingReader | null = null;

  constructor(private readonly connector: GraphConnector, private readonly tsdb: Pool) {}

  /** oshal's own observed outlet ratings (outlet-ratings.ts), computed from the stored sentiment
   *  series and reused for one head refresh interval. */
  async outletRatings(): Promise<OutletRatingSet> {
    await this.ensureSeries();
    this.ratingReader ??= createOutletRatingReader(this.tsdb);
    return this.ratingReader.read();
  }

  /** Lazily ensure the TimescaleDB hypertable for world series exists. */
  private async ensureSeries(): Promise<void> {
    if (this.seriesReady) return;
    await this.tsdb.query(
      `CREATE TABLE IF NOT EXISTS world_metrics (
         entity TEXT NOT NULL, metric TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL,
         value DOUBLE PRECISION NOT NULL, source TEXT
       )`,
    );
    await this.ensureObservedAtColumn();
    try {
      await this.tsdb.query(`SELECT create_hypertable('world_metrics','ts', if_not_exists => TRUE)`);
    } catch (err) {
      // Falls back to a plain table if the timescaledb extension isn't present — still works, just no hypertable.
      logger.warn({ err }, 'create_hypertable failed (timescaledb extension missing?) — using a plain table');
    }
    // The only auto-created index is on ts, so every metricAvg(entity,metric,…) re-scanned the whole
    // window (≈67ms each). This composite index turns each read into a sub-ms range scan — it speeds up
    // EVERY world consumer (trading veto/tilt, the reasoner joins), not just the batched read below.
    try {
      await this.tsdb.query(`CREATE INDEX IF NOT EXISTS world_metrics_entity_metric_ts_idx ON world_metrics (entity, metric, ts DESC)`);
    } catch (err) {
      logger.warn({ err }, 'world_metrics (entity,metric,ts) index create failed — reads will be slower');
    }
    // The pre-aggregated HEAD in front of this stream. The index above still matters — the rollup's
    // sub-day window reads (perSourceSentimentHours) go straight to the stream, below day granularity.
    await ensureMetricsPreaggregate(this.tsdb);
    this.seriesReady = true;
  }

  /**
   * Add `observed_at` to world_metrics once. It is nullable with no default on purpose: rows written
   * before it existed stay NULL instead of being back-stamped with a time nobody observed them at.
   * The catalog check keeps the ALTER — an ACCESS EXCLUSIVE lock on every chunk of the hypertable —
   * off every warm-up after the first.
   */
  private async ensureObservedAtColumn(): Promise<void> {
    const present = await this.tsdb.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'world_metrics' AND column_name = 'observed_at'`,
    );
    if (present.rowCount) return;
    await this.tsdb.query(`ALTER TABLE world_metrics ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ`);
    logger.info('world_metrics.observed_at added (existing rows keep NULL)');
  }

  /** Lazily ensure the archive (raw items + classification) and pull-log tables exist. */
  private async ensureArchive(): Promise<void> {
    if (this.archiveReady) return;
    await this.tsdb.query(
      `CREATE TABLE IF NOT EXISTS world_items (
         item_hash TEXT PRIMARY KEY,
         entity_id TEXT NOT NULL, entity_label TEXT,
         feed_id TEXT, category TEXT, query_variant TEXT,
         outlet TEXT, outlet_id TEXT, lean DOUBLE PRECISION, reliability DOUBLE PRECISION,
         title TEXT, description TEXT, link TEXT, pub_date TIMESTAMPTZ,
         sentiment DOUBLE PRECISION, entities JSONB,
         event_type TEXT, event_intensity DOUBLE PRECISION,
         classifier_model TEXT, classifier_version TEXT, used_llm BOOLEAN,
         first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         seen_count INT NOT NULL DEFAULT 1
       )`,
    );
    // Additive columns for an existing archive (world_items is runtime-created, not a migration) — the
    // §2 event_* catalyst tag. Guarded so it's safe on both fresh and already-populated DBs.
    await this.tsdb.query(`ALTER TABLE world_items ADD COLUMN IF NOT EXISTS event_type TEXT`);
    await this.tsdb.query(`ALTER TABLE world_items ADD COLUMN IF NOT EXISTS event_intensity DOUBLE PRECISION`);
    await this.tsdb.query(`CREATE INDEX IF NOT EXISTS world_items_entity_idx ON world_items (entity_id, first_seen_at DESC)`);
    await this.tsdb.query(`CREATE INDEX IF NOT EXISTS world_items_event_idx ON world_items (entity_id, event_type, first_seen_at DESC) WHERE event_type IS NOT NULL`);
    await this.tsdb.query(
      `CREATE TABLE IF NOT EXISTS world_pulls (
         ts TIMESTAMPTZ NOT NULL DEFAULT now(),
         entity_id TEXT NOT NULL, feed_id TEXT, category TEXT,
         fetched INT, unique_items INT, new_items INT, classified INT, used_llm BOOLEAN,
         variants JSONB
       )`,
    );
    try { await this.tsdb.query(`SELECT create_hypertable('world_pulls','ts', if_not_exists => TRUE)`); } catch { /* plain table is fine */ }
    // The subject-catalog head + the world_pulls (entity_id, ts) index.
    await ensureSubjectsHead(this.tsdb);
    this.archiveReady = true;
  }

  /** Archive one pulled item + its classification. Idempotent by content hash; returns whether it was
   *  newly inserted (vs a re-sighting of an already-archived item) — the basis of the pull-rate accounting. */
  async archiveItem(r: ArchiveRecord): Promise<{ inserted: boolean }> {
    await this.ensureArchive();
    const res = await this.tsdb.query(
      `INSERT INTO world_items
         (item_hash, entity_id, entity_label, feed_id, category, query_variant,
          outlet, outlet_id, lean, reliability, title, description, link, pub_date,
          sentiment, entities, event_type, event_intensity, classifier_model, classifier_version, used_llm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (item_hash) DO UPDATE
         SET last_seen_at = now(), seen_count = world_items.seen_count + 1
       RETURNING (xmax = 0) AS inserted`,
      [
        r.itemHash, r.entityId, r.entityLabel, r.feedId, r.category, r.queryVariant,
        r.outlet, r.outletId, r.lean, r.reliability, r.title.slice(0, 500), r.description.slice(0, 2000),
        r.link, r.pubDate, r.sentiment, JSON.stringify(r.entities),
        r.eventType, r.eventIntensity, r.classifierModel, r.classifierVersion, r.usedLlm,
      ],
    );
    const inserted = Boolean((res.rows[0] as { inserted?: boolean })?.inserted);
    // Keep the catalog head in step with the archive. Only a genuinely NEW item bumps the count, so
    // the head's `items` matches `count(*)` over the archive rather than counting re-sightings; a
    // re-sighting still refreshes the label and last_seen. Best-effort: the head is a cache of the
    // archive and is rebuildable, so a failure here must not fail the ingest that owns the real row.
    try {
      await this.tsdb.query(
        `INSERT INTO ${SUBJECTS_TABLE} (entity, label, items, last_seen)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (entity) DO UPDATE
           SET items = ${SUBJECTS_TABLE}.items + $3,
               label = COALESCE(EXCLUDED.label, ${SUBJECTS_TABLE}.label),
               last_seen = GREATEST(${SUBJECTS_TABLE}.last_seen, EXCLUDED.last_seen)`,
        [r.entityId, r.entityLabel, inserted ? 1 : 0],
      );
    } catch (err) {
      logger.warn({ err, entity: r.entityId }, 'world_subjects head update failed — the catalog count for this subject is now behind the archive');
    }
    return { inserted };
  }

  /** Which of these content hashes are ALREADY archived — so re-pulls skip re-classifying (LLM cost). */
  async existingHashes(hashes: string[]): Promise<Set<string>> {
    if (!hashes.length) return new Set();
    await this.ensureArchive();
    const r = await this.tsdb.query(`SELECT item_hash FROM world_items WHERE item_hash = ANY($1::text[])`, [hashes]);
    return new Set((r.rows as Array<{ item_hash: string }>).map((x) => x.item_hash));
  }

  /** Per-feed recent NOVELTY (new/fetched) from the pull ledger — the reward signal the deep-dive meter
   *  learns from. Scoped to one bucket entity (the firehose logs pulls under the market bucket). */
  async pullNoveltyByFeed(entityId: string, hours: number): Promise<Map<string, { fetched: number; newItems: number; novelty: number }>> {
    await this.ensureArchive();
    const r = await this.tsdb.query(
      `SELECT feed_id, sum(fetched)::int AS fetched, sum(new_items)::int AS new_items
         FROM world_pulls WHERE entity_id=$1 AND ts >= now() - ($2 || ' hours')::interval
         GROUP BY feed_id`,
      [entityId, String(hours)],
    );
    const out = new Map<string, { fetched: number; newItems: number; novelty: number }>();
    for (const row of r.rows as Array<{ feed_id: string; fetched: number; new_items: number }>) {
      const fetched = Number(row.fetched) || 0;
      const newItems = Number(row.new_items) || 0;
      out.set(String(row.feed_id), { fetched, newItems, novelty: fetched ? newItems / fetched : 0 });
    }
    return out;
  }

  /** The freshest SPEED-READ items for a feed/bucket that the deep dive hasn't LLM-classified yet
   *  (`used_llm=false`), most recent first — the deep-dive work queue. */
  async recentUndeepened(entityId: string, feedId: string, limit: number): Promise<Array<{ itemHash: string; title: string; description: string; outlet: string; link: string; pubDate: string | null }>> {
    if (limit <= 0) return [];
    await this.ensureArchive();
    const r = await this.tsdb.query(
      `SELECT item_hash, title, description, outlet, link, pub_date
         FROM world_items
        WHERE entity_id=$1 AND feed_id=$2 AND used_llm = false
        ORDER BY first_seen_at DESC LIMIT $3`,
      [entityId, feedId, limit],
    );
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      itemHash: String(row.item_hash), title: String(row.title || ''), description: String(row.description || ''),
      outlet: String(row.outlet || ''), link: String(row.link || ''),
      pubDate: row.pub_date ? new Date(row.pub_date as string).toISOString() : null,
    }));
  }

  /** Upgrade a speed-read row in place with the deep-dive classification (real sentiment + catalyst). Flips
   *  `used_llm=true` so it leaves the work queue; bumps the classifier version. Does NOT write series facts
   *  (the deep-dive caller writes the authoritative sentiment fact once, to avoid double-counting). */
  async markDeepened(itemHash: string, r: { sentiment: number | null; eventType: string | null; eventIntensity: number | null; entities: Array<{ name: string; type: string }>; classifierModel: string; classifierVersion: string }): Promise<void> {
    await this.ensureArchive();
    await this.tsdb.query(
      `UPDATE world_items SET sentiment=$2, event_type=$3, event_intensity=$4, entities=$5,
              classifier_model=$6, classifier_version=$7, used_llm=true, last_seen_at=now()
        WHERE item_hash=$1`,
      [itemHash, r.sentiment, r.eventType, r.eventIntensity, JSON.stringify(r.entities), r.classifierModel, r.classifierVersion],
    );
  }

  /** Lazily ensure the forward market-events calendar table (scheduled earnings / FOMC / econ releases). */
  private async ensureEvents(): Promise<void> {
    if (this.eventsReady) return;
    await this.tsdb.query(
      `CREATE TABLE IF NOT EXISTS world_events (
         entity_id TEXT NOT NULL, event_type TEXT NOT NULL, scheduled_at TIMESTAMPTZ NOT NULL,
         title TEXT, source TEXT, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (entity_id, event_type, scheduled_at)
       )`,
    );
    await this.tsdb.query(`CREATE INDEX IF NOT EXISTS world_events_sched_idx ON world_events (scheduled_at)`);
    this.eventsReady = true;
  }

  /** Upsert a forward event (scheduled earnings / FOMC / jobs / econ release). Idempotent by
   *  (entity, type, date) so re-collecting the calendar doesn't duplicate. */
  async upsertEvent(r: { entityId: string; eventType: string; scheduledAt: string; title: string; source: string }): Promise<void> {
    await this.ensureEvents();
    await this.tsdb.query(
      `INSERT INTO world_events (entity_id, event_type, scheduled_at, title, source)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (entity_id, event_type, scheduled_at) DO UPDATE SET title=$4, source=$5, ingested_at=now()`,
      [r.entityId, r.eventType, r.scheduledAt, r.title, r.source],
    );
  }

  /** Upcoming events within `days` (optionally for one entity) — what the gate/surface reads. */
  async upcomingEvents(withinDays: number, entityId?: string): Promise<Array<{ entityId: string; eventType: string; scheduledAt: string; title: string }>> {
    await this.ensureEvents();
    const r = await this.tsdb.query(
      `SELECT entity_id, event_type, scheduled_at, title FROM world_events
        WHERE scheduled_at >= now() AND scheduled_at <= now() + ($1 || ' days')::interval
          ${entityId ? 'AND entity_id=$2' : ''}
        ORDER BY scheduled_at ASC`,
      entityId ? [String(withinDays), entityId] : [String(withinDays)],
    );
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      entityId: String(row.entity_id), eventType: String(row.event_type),
      scheduledAt: new Date(row.scheduled_at as string).toISOString(), title: String(row.title || ''),
    }));
  }

  /**
   * @description Scheduled events of one type inside a date range — the RANGED sibling of
   * `upcomingEvents` (which is anchored at now()). Built for the Strategy Lab's earnings-gate
   * walks, which need "who prints between session D and D+N" for PAST walk dates too (the
   * calendar table keeps rows once ingested, so a pinned regression window replays identically).
   * @param eventType - e.g. 'earnings'.
   * @param fromIso - Inclusive range start (YYYY-MM-DD or ISO).
   * @param toIso - Inclusive range end.
   * @returns entityId + scheduledAt, ascending.
   */
  async scheduledEventsBetween(eventType: string, fromIso: string, toIso: string): Promise<Array<{ entityId: string; scheduledAt: string }>> {
    await this.ensureEvents();
    const r = await this.tsdb.query(
      `SELECT entity_id, scheduled_at FROM world_events
        WHERE event_type=$1 AND scheduled_at >= $2::timestamptz AND scheduled_at <= $3::timestamptz
        ORDER BY scheduled_at ASC`,
      [eventType, fromIso, toIso],
    );
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      entityId: String(row.entity_id), scheduledAt: new Date(row.scheduled_at as string).toISOString(),
    }));
  }

  /**
   * @description Write a single metric point (e.g. days_to_earnings) — used by the events collector
   * and the flow collectors.
   * @param entity - world:<type>:<key>.
   * @param metric - Metric name; a congress_* metric must carry the quiver-congress source.
   * @param value - The point's value.
   * @param source - Provenance label.
   * @param at - Series timestamp (defaults to now).
   * @param observedAt - When the collector read the point from its feed; omitted means not recorded (NULL).
   * @returns Nothing.
   */
  async writeMetric(entity: string, metric: string, value: number, source: string, at?: string, observedAt?: string): Promise<void> {
    assertCongressProvenance(metric, source);
    await this.ensureSeries();
    await this.tsdb.query(
      `INSERT INTO world_metrics (entity, metric, ts, value, source, observed_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [entity, metric, at || new Date().toISOString(), value, source, observedAt ?? null],
    );
  }

  /**
   * @description Append a feed point only when it would change what readers see: skipped when the
   * newest OBSERVED value for the same entity/metric/ts/source already equals it. A collector that
   * re-reads an overlapping window therefore appends only new or revised points. Rows written before
   * observed_at existed are never the comparison: the first run records an observed copy of every
   * point, so provenance-requiring readers see the whole window.
   * @param entity - world:<type>:<key>.
   * @param metric - Metric name; a congress_* metric must carry the quiver-congress source.
   * @param value - The point's value.
   * @param source - Provenance label.
   * @param at - Series timestamp (the source-backed day the point describes).
   * @param observedAt - When the collector read the point from its feed.
   * @returns True when a row was appended, false when the stored value was already current.
   */
  async writeMetricIfChanged(entity: string, metric: string, value: number, source: string, at: string, observedAt: string): Promise<boolean> {
    assertCongressProvenance(metric, source);
    await this.ensureSeries();
    const r = await this.tsdb.query(
      `INSERT INTO world_metrics (entity, metric, ts, value, source, observed_at)
       SELECT $1::text, $2::text, $3::timestamptz, $4::double precision, $5::text, $6::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM (
            SELECT value FROM world_metrics
             WHERE entity = $1::text AND metric = $2::text AND ts = $3::timestamptz AND source = $5::text
               AND observed_at IS NOT NULL
             ORDER BY observed_at DESC
             LIMIT 1
          ) newest
          WHERE newest.value = $4::double precision
        )`,
      [entity, metric, at, value, source, observedAt],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** The ticker entities with the most NEW items recently — the attention/velocity signal that meters which
   *  names earn the expensive full deep-search this pulse (hot names first), not just time rotation. */
  async topAttentionTickers(hours: number, limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    await this.ensureArchive();
    const r = await this.tsdb.query(
      `SELECT entity_id, count(*)::int AS n FROM world_items
         WHERE entity_id LIKE 'world:ticker:%' AND first_seen_at >= now() - ($1 || ' hours')::interval
         GROUP BY entity_id ORDER BY n DESC LIMIT $2`,
      [String(hours), limit],
    );
    return (r.rows as Array<{ entity_id: string }>).map((x) => String(x.entity_id));
  }

  /** Bump seen_count/last_seen for re-sighted items (we keep how often an item keeps resurfacing). */
  async touchItems(hashes: string[]): Promise<void> {
    if (!hashes.length) return;
    await this.ensureArchive();
    await this.tsdb.query(`UPDATE world_items SET seen_count = seen_count + 1, last_seen_at = now() WHERE item_hash = ANY($1::text[])`, [hashes]);
  }

  /** Record a pull (per source, across its query variants) so pull-rate is measurable over time. */
  async logPull(r: PullLogRecord): Promise<void> {
    await this.ensureArchive();
    await this.tsdb.query(
      `INSERT INTO world_pulls (entity_id, feed_id, category, fetched, unique_items, new_items, classified, used_llm, variants)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.entityId, r.feedId, r.category, r.fetched, r.uniqueItems, r.newItems, r.classified, r.usedLlm, JSON.stringify(r.variants)],
    );
  }

  /** Pull-rate roll-up for an entity over N days: per-source totals + freshness ratio. */
  async pullStats(entity: string, days: number): Promise<Record<string, unknown>> {
    await this.ensureArchive();
    const pulls = await this.tsdb.query(
      `SELECT feed_id, count(*)::int AS pulls,
              sum(fetched)::int AS fetched, sum(unique_items)::int AS unique_items,
              sum(new_items)::int AS new_items, sum(classified)::int AS classified,
              max(ts) AS last_pull
         FROM world_pulls WHERE entity_id=$1 AND ts >= now() - ($2 || ' days')::interval
         GROUP BY feed_id ORDER BY feed_id`,
      [entity, String(days)],
    );
    const archived = await this.tsdb.query(
      `SELECT count(*)::int AS items FROM world_items WHERE entity_id=$1 AND first_seen_at >= now() - ($2 || ' days')::interval`,
      [entity, String(days)],
    );
    const bySource = (pulls.rows as Array<Record<string, unknown>>).map((row) => {
      const fetched = Number(row.fetched) || 0;
      const newItems = Number(row.new_items) || 0;
      return {
        feedId: row.feed_id, pulls: Number(row.pulls) || 0,
        fetched, uniqueItems: Number(row.unique_items) || 0, newItems, classified: Number(row.classified) || 0,
        freshRate: fetched ? Number((newItems / fetched).toFixed(3)) : null, // new / fetched = how much was actually new
        lastPull: row.last_pull,
      };
    });
    return { entity, days, archivedItems: Number((archived.rows[0] as { items?: number })?.items) || 0, bySource };
  }

  /** Rehydrate archived items for an entity (most recent first) — the input to a backtest replay. */
  async archivedItems(entity: string, days: number, limit = 60): Promise<ArchivedItem[]> {
    await this.ensureArchive();
    const r = await this.tsdb.query(
      `SELECT item_hash, entity_id, entity_label, title, description, outlet, sentiment, entities,
              classifier_model, classifier_version, pub_date
         FROM world_items
        WHERE entity_id=$1 AND first_seen_at >= now() - ($2 || ' days')::interval AND sentiment IS NOT NULL
        ORDER BY first_seen_at DESC LIMIT $3`,
      [entity, String(days), limit],
    );
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      itemHash: String(row.item_hash), entityId: String(row.entity_id), entityLabel: String(row.entity_label || ''),
      title: String(row.title || ''), description: String(row.description || ''), outlet: String(row.outlet || ''),
      sentiment: row.sentiment != null ? Number(row.sentiment) : null,
      entities: Array.isArray(row.entities) ? row.entities as Array<{ name: string; type: string }> : [],
      classifierModel: String(row.classifier_model || ''), classifierVersion: String(row.classifier_version || ''),
      pubDate: row.pub_date ? new Date(row.pub_date as string).toISOString() : null,
    }));
  }

  /** Ingest a world contribution: upsert nodes/edges into the shared graph + append series points.
   *  A contribution can never carry a congressional disclosure: the schema refuses it at the HTTP
   *  edge, and this refuses it again for in-process callers that build contributions unparsed —
   *  before anything is written, so a refused contribution leaves no partial graph write behind. */
  async ingest(c: WorldContribution): Promise<WorldIngestResult> {
    if (isReservedCongressSource(c.source) || c.facts.some((f) => isReservedCongressMetric(f.metric))) {
      throw new Error('world contribution refused: congress_* metrics and the quiver-congress source are written only by the congressional disclosure feed collector');
    }
    const g = await this.connector.getTenantGraph(WORLD_TENANT);

    const nodes: GraphNode[] = c.entities.map((e) => ({
      id: e.id,
      labels: [e.type],
      props: { type: e.type, label: e.label, ...e.props, source: c.source, ingestedAt: c.ingestedAt },
    }));
    const edges: GraphEdge[] = c.edges.map((e) => ({
      from: e.from, to: e.to, type: e.type, props: { ...e.props, source: c.source },
    }));

    // Retry on Arango write-write conflicts: the world graph is SHARED, so concurrent ingests (the
    // market-hours ticker pulse refreshes many names at once) race on shared nodes — outlet nodes,
    // co-mentioned entities. errorNum 1200 / HTTP 409 is optimistic-locking contention, safe to retry.
    if (nodes.length) await withWriteConflictRetry(() => g.upsertNodes(nodes));
    if (edges.length) await withWriteConflictRetry(() => g.upsertEdges(edges));

    if (c.facts.length) {
      await this.ensureSeries();
      const sql = `INSERT INTO world_metrics (entity, metric, ts, value, source) VALUES ($1,$2,$3,$4,$5)`;
      for (const f of c.facts) await this.tsdb.query(sql, [f.entity, f.metric, f.at, f.value, c.source]);
    }

    return { nodes: nodes.length, edges: edges.length, facts: c.facts.length };
  }

  /** The historical series the reasoner joins against personal data: avg of a metric over N days.
   *  Served from the daily HEAD — the mean is recovered as sum/count, which is the same number
   *  `avg(value)` produced over the same rows (see world-preaggregate). */
  async metricAvg(entity: string, metric: string, days: number): Promise<{ points: number; avg: number | null }> {
    await this.ensureSeries();
    const r = await this.tsdb.query(
      `SELECT sum(cnt)::int AS points, sum(sum_v) / NULLIF(sum(cnt), 0) AS avg
         FROM ${METRICS_DAILY_VIEW}
        WHERE entity=$1 AND metric=$2 AND bucket >= ${alignedWindowStart('$3')}`,
      [entity, metric, days],
    );
    const row = (r.rows[0] || {}) as { points?: number; avg?: string | number | null };
    return { points: row.points || 0, avg: row.avg != null ? Number(row.avg) : null };
  }

  /**
   * @description Batched metricAvg: avg + count for MANY (entity × metric) pairs in ONE query. Replaces
   * `entities.length × metrics.length` single reads — each of which re-scanned the window — with a single
   * indexed GROUP BY (see the (entity,metric,ts) index in ensureSeries). Returns entity → metric →
   * { points, avg }; pairs with no data are simply absent.
   * @param entities - Entity ids (e.g. world:ticker:nvda).
   * @param metrics - Metric names to fetch for each entity.
   * @param days - Lookback window in days.
   * @returns Nested map entity → metric → { points, avg }.
   */
  async metricsBatch(entities: string[], metrics: string[], days: number): Promise<Map<string, Map<string, { points: number; avg: number }>>> {
    const out = new Map<string, Map<string, { points: number; avg: number }>>();
    if (!entities.length || !metrics.length) return out;
    await this.ensureSeries();
    const r = await this.tsdb.query(
      `SELECT entity, metric, sum(cnt)::int AS points, sum(sum_v) / NULLIF(sum(cnt), 0) AS avg
         FROM ${METRICS_DAILY_VIEW}
        WHERE entity = ANY($1::text[]) AND metric = ANY($2::text[]) AND bucket >= ${alignedWindowStart('$3')}
        GROUP BY entity, metric`,
      [entities, metrics, days],
    );
    for (const row of r.rows as Array<{ entity: string; metric: string; points: number; avg: string | number | null }>) {
      if (row.avg == null) continue;
      let m = out.get(row.entity);
      if (!m) { m = new Map(); out.set(row.entity, m); }
      m.set(row.metric, { points: row.points || 0, avg: Number(row.avg) });
    }
    return out;
  }

  /**
   * @description Read the newest point for each requested entity/metric pair without collapsing
   * away its timestamps or source. Among points with the same ts, the most recently observed wins,
   * so a revised feed value replaces the one it corrected. Bounded by the caller's arrays; used by
   * read-only projections that must show provenance beside a value.
   * @param entities - Entity ids (at most 100 are read).
   * @param metrics - Metric names (at most 20 are read).
   * @returns One auditable point per pair that has data.
   */
  async latestMetricPoints(entities: string[], metrics: string[]): Promise<LatestMetricPoint[]> {
    if (!entities.length || !metrics.length) return [];
    await this.ensureSeries();
    const r = await this.tsdb.query(
      `SELECT DISTINCT ON (entity, metric) entity, metric, ts, value, source, observed_at
         FROM world_metrics
        WHERE entity = ANY($1::text[]) AND metric = ANY($2::text[])
        ORDER BY entity, metric, ts DESC, observed_at DESC NULLS LAST`,
      [entities.slice(0, 100), metrics.slice(0, 20)],
    );
    return (r.rows as Array<Parameters<typeof toLatestPoint>[0]>)
      .map(toLatestPoint)
      .filter((row) => Number.isFinite(row.value) && !Number.isNaN(Date.parse(row.ts)));
  }

  /**
   * @description Which names did one feed report lately — the bounded discovery read behind a
   * "recent disclosures" list. Candidates come from the daily head's (metric, bucket) index, newest
   * first; each candidate's newest point per metric then comes from the stream's
   * (entity, metric, ts) index. Only points with a recorded observed_at qualify: those are the rows
   * a collector wrote with full provenance, so older rows keyed on a different date never surface
   * beside a "disclosed" label. Every dimension is hard-capped.
   * @param metrics - Metric names to return per entity (at most 20).
   * @param source - The exact feed source every returned point must carry.
   * @param sinceDays - Window over the point timestamp, in whole days (1–120).
   * @param limit - Maximum distinct entities (1–100).
   * @returns The newest observed point per (entity, metric), newest entities first.
   */
  async recentFeedMetricPoints(metrics: string[], source: string, sinceDays: number, limit: number): Promise<LatestMetricPoint[]> {
    const names = metrics.slice(0, RECENT_FEED_MAX_METRICS);
    if (!names.length || !source) return [];
    const days = Math.min(RECENT_FEED_MAX_DAYS, Math.max(1, Math.floor(Number(sinceDays) || 1)));
    const cap = Math.min(RECENT_FEED_MAX_ENTITIES, Math.max(1, Math.floor(Number(limit) || 1)));
    await this.ensureSeries();
    const r = await this.tsdb.query(
      `WITH candidates AS (
         SELECT entity, max(bucket) AS newest
           FROM ${METRICS_DAILY_VIEW}
          WHERE metric = ANY($1::text[]) AND source = $2 AND bucket >= ${alignedWindowStart('$3')}
          GROUP BY entity
          ORDER BY newest DESC, entity
          LIMIT $4
       )
       SELECT c.entity, p.metric, p.ts, p.value, p.source, p.observed_at
         FROM candidates c
         CROSS JOIN LATERAL (
           SELECT DISTINCT ON (w.metric) w.metric, w.ts, w.value, w.source, w.observed_at
             FROM world_metrics w
            WHERE w.entity = c.entity AND w.metric = ANY($1::text[]) AND w.source = $2
              AND w.observed_at IS NOT NULL AND w.ts >= ${alignedWindowStart('$3')}
            ORDER BY w.metric, w.ts DESC, w.observed_at DESC
         ) p
        ORDER BY c.newest DESC, c.entity, p.metric`,
      [names, source, days, cap],
    );
    return (r.rows as Array<Parameters<typeof toLatestPoint>[0]>)
      .map(toLatestPoint)
      .filter((row) => Number.isFinite(row.value) && !Number.isNaN(Date.parse(row.ts)));
  }

  /** Lazily ensure the world_congress_trades table and indexes exist. */
  private async ensureCongressTrades(): Promise<void> {
    if (this.congressTradesReady) return;
    await this.tsdb.query(
      `CREATE TABLE IF NOT EXISTS world_congress_trades (
         trade_id TEXT PRIMARY KEY,
         representative TEXT NOT NULL,
         bio_guide_id TEXT,
         party TEXT,
         chamber TEXT,
         state TEXT,
         district TEXT,
         ticker TEXT NOT NULL,
         asset_description TEXT,
         transaction_type TEXT NOT NULL,
         direction TEXT NOT NULL,
         transaction_date DATE,
         disclosure_date DATE NOT NULL,
         amount TEXT,
         amount_range_low DOUBLE PRECISION,
         amount_range_high DOUBLE PRECISION,
         ptr_link TEXT,
         source TEXT NOT NULL,
         observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    try {
      await this.tsdb.query(`CREATE INDEX IF NOT EXISTS world_congress_trades_rep_idx ON world_congress_trades (representative, disclosure_date DESC)`);
      await this.tsdb.query(`CREATE INDEX IF NOT EXISTS world_congress_trades_ticker_idx ON world_congress_trades (ticker, disclosure_date DESC)`);
      await this.tsdb.query(`CREATE INDEX IF NOT EXISTS world_congress_trades_disclosure_idx ON world_congress_trades (disclosure_date DESC)`);
    } catch (err) {
      logger.warn({ err }, 'world_congress_trades index creation warning — reads may be slower');
    }
    this.congressTradesReady = true;
  }

  /**
   * @description Record granular congressional trade disclosures idempotently by deterministic trade_id.
   * Skipped when a trade with the same trade_id is already stored.
   * @param trades - Array of normalized congressional trade records.
   * @returns Total processed and how many new records were inserted.
   */
  async recordCongressTrades(trades: CongressTradeRecord[]): Promise<{ inserted: number; total: number }> {
    if (!trades.length) return { inserted: 0, total: 0 };
    await this.ensureCongressTrades();
    let inserted = 0;
    for (const t of trades) {
      try {
        const res = await this.tsdb.query(
          `INSERT INTO world_congress_trades
             (trade_id, representative, bio_guide_id, party, chamber, state, district,
              ticker, asset_description, transaction_type, direction,
              transaction_date, disclosure_date, amount, amount_range_low, amount_range_high,
              ptr_link, source, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           ON CONFLICT (trade_id) DO NOTHING`,
          [
            t.tradeId, t.representative, t.bioGuideId ?? null, t.party ?? null, t.chamber ?? null,
            t.state ?? null, t.district ?? null, t.ticker, t.assetDescription ?? null,
            t.transactionType, t.direction, t.transactionDate ? t.transactionDate.slice(0, 10) : null,
            t.disclosureDate.slice(0, 10), t.amount ?? null, t.amountRangeLow ?? null,
            t.amountRangeHigh ?? null, t.ptrLink ?? null, t.source, t.observedAt,
          ],
        );
        if ((res.rowCount ?? 0) > 0) inserted += 1;
      } catch (err) {
        logger.error({ err, tradeId: t.tradeId, ticker: t.ticker }, 'failed to insert congress trade record');
      }
    }
    return { inserted, total: trades.length };
  }

  /**
   * @description Query granular congressional trades with optional filtering by politician, ticker, party, chamber, etc.
   * @param filter - Search criteria and pagination limits.
   * @returns Array of matched congressional trades, newest disclosure first.
   */
  async queryCongressTrades(filter: CongressTradeQueryFilter = {}): Promise<CongressTradeRecord[]> {
    await this.ensureCongressTrades();
    const clauses: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (filter.ticker) {
      clauses.push(`ticker = $${p++}`);
      params.push(filter.ticker.toUpperCase().trim());
    }
    if (filter.representative) {
      clauses.push(`representative ILIKE $${p++}`);
      params.push(`%${filter.representative.trim()}%`);
    }
    if (filter.party) {
      clauses.push(`party ILIKE $${p++}`);
      params.push(`%${filter.party.trim()}%`);
    }
    if (filter.chamber) {
      clauses.push(`chamber ILIKE $${p++}`);
      params.push(`%${filter.chamber.trim()}%`);
    }
    if (filter.direction) {
      clauses.push(`direction = $${p++}`);
      params.push(filter.direction.toLowerCase());
    }
    const days = Math.min(365, Math.max(1, Math.floor(Number(filter.sinceDays) || 90)));
    clauses.push(`disclosure_date >= (CURRENT_DATE - INTERVAL '${days} days')`);

    const limit = Math.min(200, Math.max(1, Math.floor(Number(filter.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(filter.offset) || 0));

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT trade_id, representative, bio_guide_id, party, chamber, state, district,
                        ticker, asset_description, transaction_type, direction,
                        transaction_date, disclosure_date, amount, amount_range_low, amount_range_high,
                        ptr_link, source, observed_at
                   FROM world_congress_trades
                  ${where}
                  ORDER BY disclosure_date DESC, representative ASC, ticker ASC
                  LIMIT $${p++} OFFSET $${p++}`;
    params.push(limit, offset);

    const r = await this.tsdb.query(sql, params);
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      tradeId: String(row.trade_id),
      representative: String(row.representative),
      bioGuideId: row.bio_guide_id == null ? null : String(row.bio_guide_id),
      party: row.party == null ? null : String(row.party),
      chamber: row.chamber == null ? null : String(row.chamber),
      state: row.state == null ? null : String(row.state),
      district: row.district == null ? null : String(row.district),
      ticker: String(row.ticker),
      assetDescription: row.asset_description == null ? null : String(row.asset_description),
      transactionType: String(row.transaction_type),
      direction: row.direction === 'buy' ? 'buy' : 'sell',
      transactionDate: row.transaction_date ? String(row.transaction_date).slice(0, 10) : null,
      disclosureDate: `${String(row.disclosure_date).slice(0, 10)}T00:00:00.000Z`,
      amount: row.amount == null ? null : String(row.amount),
      amountRangeLow: row.amount_range_low == null ? null : Number(row.amount_range_low),
      amountRangeHigh: row.amount_range_high == null ? null : Number(row.amount_range_high),
      ptrLink: row.ptr_link == null ? null : String(row.ptr_link),
      source: String(row.source),
      observedAt: new Date(row.observed_at as string).toISOString(),
    }));
  }

  /**
   * Bias-AWARE sentiment for an entity (the whole point). Reads sentiment per SOURCE, reads each
   * source through its OBSERVED lean + reliability (outlet-ratings.ts), and returns the signals a
   * naive average destroys:
   *  - naive:               the misleading simple average (what most tools show)
   *  - balanced:            mean of the below/near/above lean-bucket means — one habitual slant can't
   *                         dominate by volume
   *  - reliabilityWeighted: trusts the sources that track the others more
   *  - byLean + consensus:  do sources that usually read below, near and above the others AGREE here?
   *  - bySource:            per-source, with its observed rating, counts and date range
   */
  async sentimentBreakdown(entity: string, days: number): Promise<Record<string, unknown>> {
    await this.ensureSeries();
    const r = await this.tsdb.query(
      `SELECT source, sum(cnt)::int AS points, sum(sum_v) / NULLIF(sum(cnt), 0) AS avg
         FROM ${METRICS_DAILY_VIEW}
        WHERE entity=$1 AND metric='sentiment' AND bucket >= ${alignedWindowStart('$2')}
        GROUP BY source`,
      [entity, days],
    );
    const rows: SentimentRow[] = (r.rows as Array<{ source: string; points: number; avg: string | number | null }>)
      // A head row always carries cnt >= 1, so avg is never null in practice — but Number(null) is 0,
      // and a fabricated 0.00 sentiment reads as "neutral coverage" rather than "no coverage".
      .filter((row) => row.avg != null)
      .map((row) => ({ source: String(row.source), points: row.points, avg: Number(row.avg) }));
    // The bias-aware math is PURE + unit-tested in sentiment-math.ts; this method only does the I/O.
    return { entity, days, ...computeSentimentBreakdown(rows, await this.outletRatings()) };
  }

  /** Per-source average sentiment over the last N HOURS (the rollup's window read; the days-based
   *  sentimentBreakdown is the interactive read). Feeds computeSentimentBreakdown for the bias-aware family.
   *
   *  A WHOLE number of days is answered from the daily HEAD, which buckets by (day, entity, metric,
   *  SOURCE) — so it can answer a per-source question, and answers it off a relation ~3 orders of
   *  magnitude smaller than the stream. The cost is the head's day alignment (see alignedWindowStart):
   *  a 24h window becomes "since midnight of yesterday", so it can reach up to one extra day back.
   *  That is the same window every other head-backed read already uses — including metricAvg, which
   *  is how the trading gate reads these very features back — so the producer now matches its
   *  consumer's granularity instead of being finer than it. Anything not a whole day still scans the
   *  stream, which is the only place a sub-day window exists. */
  private async perSourceSentimentHours(entity: string, hours: number): Promise<SentimentRow[]> {
    return hours >= 24 && hours % 24 === 0
      ? this.perSourceSentimentDays(entity, hours / 24)
      : this.perSourceSentimentStream(entity, hours);
  }

  /** Per-source sentiment over N whole days, read from the daily HEAD. The mean is recovered as
   *  sum/count, arithmetically identical to avg(value) over the same rows (see world-preaggregate). */
  private async perSourceSentimentDays(entity: string, days: number): Promise<SentimentRow[]> {
    await this.ensureSeries();
    const r = await runSeriesRead(seriesReadKey('sentiment-days', entity, days), () => this.tsdb.query(
      `SELECT source, sum(cnt)::int AS points, sum(sum_v) / NULLIF(sum(cnt), 0) AS avg
         FROM ${METRICS_DAILY_VIEW}
        WHERE entity=$1 AND metric='sentiment' AND bucket >= ${alignedWindowStart('$2')}
        GROUP BY source`,
      [entity, days],
    ));
    return (r.rows as Array<{ source: string; points: number; avg: string | number | null }>)
      // A head row always carries cnt >= 1, so avg is never null in practice — but Number(null) is 0,
      // and a fabricated 0.00 sentiment reads as "neutral coverage" rather than "no coverage".
      .filter((row) => row.avg != null)
      .map((row) => ({ source: String(row.source), points: row.points, avg: Number(row.avg) }));
  }

  /** Per-source sentiment over a sub-day window, straight off the running stream (the head cannot
   *  answer below day granularity). Gated like every other series read. */
  private async perSourceSentimentStream(entity: string, hours: number): Promise<SentimentRow[]> {
    await this.ensureSeries();
    const r = await runSeriesRead(seriesReadKey('sentiment-hours', entity, hours), () => this.tsdb.query(
      `SELECT source, count(*)::int AS points, avg(value) AS avg
         FROM world_metrics WHERE entity=$1 AND metric='sentiment' AND ts >= now() - ($2 || ' hours')::interval
         GROUP BY source`,
      [entity, String(hours)],
    ));
    return (r.rows as Array<{ source: string; points: number; avg: string | number }>)
      .map((row) => ({ source: String(row.source), points: row.points, avg: Number(row.avg) }));
  }

  /**
   * FEATURE ROLLUP (trading signal dataset §1, docs/apps/trading/signal-dataset.md). Roll the raw `world_items`
   * archive + sentiment series up into the queryable signal-vector metrics and WRITE them back into
   * `world_metrics` (one row per metric, `source='feature-rollup'`) so the dataset is a time-series the
   * Gravity model + mining harness can join against. Reuses what already exists (the archive, the
   * bias-aware sentiment math, the graph) — no new substrate. Pure DB work (no feeds, no LLM): cheap.
   *
   * Metrics written (the derivable-now subset; event_* + price/labels are separate spec items):
   *   mention_count, mention_velocity (vs trailing baseline), novelty (new/total), sentiment_mean
   *   (bias-balanced), sentiment_shift (vs baseline), sentiment_dispersion (stdev across outlets),
   *   sentiment_consensus (agreement across the observed below/near/above lean buckets),
   *   reliability_weighted_sentiment (observed reliability), comention_degree.
   *
   * @param entity - world:<type>:<key> to roll up.
   * @param opts - windowHours (default 24), baselineHours (default 168 = 7d), source tag.
   * @returns The features actually written (null/insufficient ones are skipped).
   */
  async rollupFeatures(entity: string, opts: { windowHours?: number; baselineHours?: number; source?: string } = {}): Promise<Record<string, number>> {
    await this.ensureArchive();
    const win = opts.windowHours ?? 24;
    const base = opts.baselineHours ?? 24 * 7;
    const src = opts.source ?? 'feature-rollup';

    // 1) Attention + novelty from the archive: new vs re-sighted items in the window, and the baseline rate.
    const attention = await this.rollupAttention(entity, win, base);
    // 2) Bias-aware sentiment family for the window, plus the baseline for the shift.
    const sentiment = await this.rollupSentiment(entity, win, base);
    // 3) Contagion: graph co-mention degree.
    let degree = 0;
    try { degree = (await this.neighbors(entity, 1)).length; } catch { degree = 0; }
    // 4) Catalysts: the strongest intensity of each event_* type seen in the window (the KIND of news).
    const eventFeatures = await this.rollupEvents(entity, win);

    const features: Record<string, number | null> = {
      mention_count: attention.mentionCount,
      mention_velocity: round3(attention.mentionVelocity),
      novelty: round3(attention.novelty),
      sentiment_mean: sentiment.window.balanced,
      sentiment_shift: round3(sentiment.shift),
      sentiment_dispersion: round3(sentiment.dispersion),
      sentiment_consensus: consensusScore(sentiment.window.consensus),
      reliability_weighted_sentiment: sentiment.window.reliabilityWeighted,
      comention_degree: degree,
      ...eventFeatures,
    };

    await this.ensureSeries();
    const ts = new Date().toISOString();
    const out: Record<string, number> = {};
    for (const [metric, value] of Object.entries(features)) {
      if (value == null) continue;
      await this.tsdb.query(`INSERT INTO world_metrics (entity, metric, ts, value, source) VALUES ($1,$2,$3,$4,$5)`, [entity, metric, ts, value, src]);
      out[metric] = value;
    }
    return out;
  }

  /** The rollup's attention block: new vs re-sighted items in the window and the baseline new-item rate. */
  private async rollupAttention(entity: string, win: number, base: number): Promise<{ mentionCount: number; novelty: number | null; mentionVelocity: number }> {
    const mq = await runSeriesRead(seriesReadKey('items-attention', entity, win, base), () => this.tsdb.query(
      `SELECT
         count(*) FILTER (WHERE first_seen_at >= now() - ($2 || ' hours')::interval)::int AS new_win,
         count(*) FILTER (WHERE last_seen_at  >= now() - ($2 || ' hours')::interval
                            AND first_seen_at <  now() - ($2 || ' hours')::interval)::int AS reseen_win,
         count(*) FILTER (WHERE first_seen_at >= now() - ($3 || ' hours')::interval)::int AS new_base
       FROM world_items WHERE entity_id=$1`,
      [entity, String(win), String(base)],
    ));
    const newWin = Number(mq.rows[0]?.new_win) || 0;
    const reseen = Number(mq.rows[0]?.reseen_win) || 0;
    const newBase = Number(mq.rows[0]?.new_base) || 0;
    const baseAvg = win > 0 ? newBase / (base / win) : 0; // avg new items per window-length over baseline
    return {
      mentionCount: newWin,
      novelty: newWin + reseen ? newWin / (newWin + reseen) : null,
      mentionVelocity: baseAvg > 0 ? newWin / baseAvg : (newWin > 0 ? 2 : 0), // ratio; >1 = accelerating
    };
  }

  /** The rollup's sentiment family: the window and baseline breakdowns read through the observed ratings. */
  private async rollupSentiment(entity: string, win: number, base: number): Promise<{ window: SentimentBreakdown; shift: number | null; dispersion: number | null }> {
    const ratings = await this.outletRatings();
    const bdWin = computeSentimentBreakdown(await this.perSourceSentimentHours(entity, win), ratings);
    const bdBase = computeSentimentBreakdown(await this.perSourceSentimentHours(entity, base), ratings);
    return {
      window: bdWin,
      shift: bdWin.balanced != null && bdBase.balanced != null ? bdWin.balanced - bdBase.balanced : null,
      dispersion: stdev(bdWin.bySource.map((s) => s.value)),
    };
  }

  /** The rollup's catalysts: the strongest intensity of each event_* type seen in the window. */
  private async rollupEvents(entity: string, win: number): Promise<Record<string, number | null>> {
    const eq = await runSeriesRead(seriesReadKey('items-events', entity, win), () => this.tsdb.query(
      `SELECT event_type, max(event_intensity) AS intensity
         FROM world_items
        WHERE entity_id=$1 AND event_type IS NOT NULL
          AND first_seen_at >= now() - ($2 || ' hours')::interval
        GROUP BY event_type`,
      [entity, String(win)],
    ));
    const eventFeatures: Record<string, number | null> = {};
    for (const row of eq.rows as Array<{ event_type: string; intensity: string | number }>) {
      eventFeatures[`event_${String(row.event_type)}`] = round3(Number(row.intensity));
    }
    return eventFeatures;
  }

  /** The world subjects already tracked (ingested), most-covered first — the catalog the
   *  surface lists and the world_entities tool returns. Read from the catalog HEAD: this used to
   *  aggregate the whole million-row archive (a 1.36 GB sequential scan, ~7.8s) to return ~400 rows,
   *  and it is the FIRST request the cockpit surface makes, so every other panel queued behind it. */
  async listEntities(limit = 50): Promise<Array<{ entity: string; label: string; items: number; lastSeen: string | null }>> {
    await this.ensureArchive();
    const r = await this.tsdb.query(
      `SELECT entity, label, items, last_seen FROM ${SUBJECTS_TABLE}
        ORDER BY items DESC LIMIT $1`,
      [limit],
    );
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      entity: String(row.entity),
      label: String(row.label || row.entity),
      items: Number(row.items) || 0,
      lastSeen: row.last_seen ? new Date(row.last_seen as string).toISOString() : null,
    }));
  }

  /** Graph neighbourhood of a world node (the relate-join surface). */
  async neighbors(id: string, depth = 1): Promise<GraphNode[]> {
    const g = await this.connector.getTenantGraph(WORLD_TENANT);
    return g.neighbors(id, depth);
  }
}

// One service (and ONE pg Pool) per TSDB url for the life of the process. Before this memo,
// every scheduler tick (trading-assess-dispatch fires every 5 minutes) constructed a new Pool
// that nothing ever ended — a steady connection/memory leak in the controller.
const serviceMemo = new Map<string, WorldIntelligenceService>();

/** Factory — only constructs when ENABLE_WORLD_INTELLIGENCE=true AND the graph + TSDB are configured. */
export function createWorldIntelligenceService(env: NodeJS.ProcessEnv = process.env): WorldIntelligenceService | null {
  if (env.ENABLE_WORLD_INTELLIGENCE !== 'true') return null;
  const tsdbUrl = env.TSDB_URL;
  if (!tsdbUrl) { logger.warn('World service disabled — TSDB_URL unset (no series store)'); return null; }
  const memoized = serviceMemo.get(tsdbUrl);
  if (memoized) return memoized;
  const connector = createGraphConnector();
  if (!connector) { logger.warn('World service disabled — ARANGO_URL unset (no graph engine)'); return null; }
  const svc = new WorldIntelligenceService(connector, ownPoolConnectionErrors(new Pool({ connectionString: tsdbUrl }), 'world-intelligence'));
  serviceMemo.set(tsdbUrl, svc);
  return svc;
}

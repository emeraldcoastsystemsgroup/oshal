/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-058 Layer B: World-Intelligence Service — shared world graph (ArangoDB) + series (TimescaleDB)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Update docs/ paths after docs directory consolidation
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Memoize the service per TSDB url — the factory built a new un-ended pg Pool on every scheduler tick (every 5 min via trading-assess-dispatch), a steady connection leak (2026-07-05 leak audit)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | scheduledEventsBetween(eventType, fromIso, toIso) — ranged sibling of upcomingEvents (now()-anchored) for the Strategy Lab earnings-gate walks, which need "who prints between session D and D+N" for past walk dates; ingested calendar rows persist, so pinned regression windows replay identically.
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
import { createGraphConnector, type GraphConnector, type GraphNode, type GraphEdge } from '@/features/graph';
import { createChildLogger } from '@/shared/logger';
import type { WorldContribution } from './world-types';
import { computeSentimentBreakdown, type SentimentRow } from './sentiment-math';

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
  private seriesReady = false;
  private archiveReady = false;
  private eventsReady = false;

  constructor(private readonly connector: GraphConnector, private readonly tsdb: Pool) {}

  /** Lazily ensure the TimescaleDB hypertable for world series exists. */
  private async ensureSeries(): Promise<void> {
    if (this.seriesReady) return;
    await this.tsdb.query(
      `CREATE TABLE IF NOT EXISTS world_metrics (
         entity TEXT NOT NULL, metric TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL,
         value DOUBLE PRECISION NOT NULL, source TEXT
       )`,
    );
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
    this.seriesReady = true;
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
    return { inserted: Boolean((res.rows[0] as { inserted?: boolean })?.inserted) };
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

  /** Write a single metric point (e.g. days_to_earnings) — used by the events collector + future callers. */
  async writeMetric(entity: string, metric: string, value: number, source: string, at?: string): Promise<void> {
    await this.ensureSeries();
    await this.tsdb.query(`INSERT INTO world_metrics (entity, metric, ts, value, source) VALUES ($1,$2,$3,$4,$5)`, [entity, metric, at || new Date().toISOString(), value, source]);
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

  /** Ingest a world contribution: upsert nodes/edges into the shared graph + append series points. */
  async ingest(c: WorldContribution): Promise<WorldIngestResult> {
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

  /** The historical series the reasoner joins against personal data: avg of a metric over N days. */
  async metricAvg(entity: string, metric: string, days: number): Promise<{ points: number; avg: number | null }> {
    await this.ensureSeries();
    const r = await this.tsdb.query(
      `SELECT count(*)::int AS points, avg(value) AS avg
         FROM world_metrics WHERE entity=$1 AND metric=$2 AND ts >= now() - ($3 || ' days')::interval`,
      [entity, metric, String(days)],
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
      `SELECT entity, metric, count(*)::int AS points, avg(value) AS avg
         FROM world_metrics
        WHERE entity = ANY($1::text[]) AND metric = ANY($2::text[]) AND ts >= now() - ($3 || ' days')::interval
        GROUP BY entity, metric`,
      [entities, metrics, String(days)],
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
   * Bias-AWARE sentiment for an entity (the whole point). Reads sentiment per OUTLET, maps each outlet
   * to its lean + reliability, and returns the signals a naive average destroys:
   *  - naive:               the misleading simple average (what most tools show)
   *  - balanced:            mean of the left/center/right means — one lean can't dominate by volume
   *  - reliabilityWeighted: trusts the factual sources more
   *  - byLean + consensus:  do the left/center/right actually AGREE? (agreement = the real signal)
   *  - bySource:            per-outlet, with bias + reliability, so you can see who broke their lean
   */
  async sentimentBreakdown(entity: string, days: number): Promise<Record<string, unknown>> {
    await this.ensureSeries();
    const r = await this.tsdb.query(
      `SELECT source, count(*)::int AS points, avg(value) AS avg
         FROM world_metrics WHERE entity=$1 AND metric='sentiment' AND ts >= now() - ($2 || ' days')::interval
         GROUP BY source`,
      [entity, String(days)],
    );
    const rows: SentimentRow[] = (r.rows as Array<{ source: string; points: number; avg: string | number }>)
      .map((row) => ({ source: String(row.source), points: row.points, avg: Number(row.avg) }));
    // The bias-aware math is PURE + unit-tested in sentiment-math.ts; this method only does the I/O.
    return { entity, days, ...computeSentimentBreakdown(rows) };
  }

  /** Per-source average sentiment over the last N HOURS (the rollup's window read; the days-based
   *  sentimentBreakdown is the interactive read). Feeds computeSentimentBreakdown for the bias-aware family. */
  private async perSourceSentimentHours(entity: string, hours: number): Promise<SentimentRow[]> {
    await this.ensureSeries();
    const r = await this.tsdb.query(
      `SELECT source, count(*)::int AS points, avg(value) AS avg
         FROM world_metrics WHERE entity=$1 AND metric='sentiment' AND ts >= now() - ($2 || ' hours')::interval
         GROUP BY source`,
      [entity, String(hours)],
    );
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
   *   sentiment_consensus (left/center/right agreement), reliability_weighted_sentiment, comention_degree.
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
    const mq = await this.tsdb.query(
      `SELECT
         count(*) FILTER (WHERE first_seen_at >= now() - ($2 || ' hours')::interval)::int AS new_win,
         count(*) FILTER (WHERE last_seen_at  >= now() - ($2 || ' hours')::interval
                            AND first_seen_at <  now() - ($2 || ' hours')::interval)::int AS reseen_win,
         count(*) FILTER (WHERE first_seen_at >= now() - ($3 || ' hours')::interval)::int AS new_base
       FROM world_items WHERE entity_id=$1`,
      [entity, String(win), String(base)],
    );
    const newWin = Number(mq.rows[0]?.new_win) || 0;
    const reseen = Number(mq.rows[0]?.reseen_win) || 0;
    const newBase = Number(mq.rows[0]?.new_base) || 0;
    const mentionCount = newWin;
    const novelty = newWin + reseen ? newWin / (newWin + reseen) : null;
    const baseAvg = win > 0 ? newBase / (base / win) : 0; // avg new items per window-length over baseline
    const mentionVelocity = baseAvg > 0 ? mentionCount / baseAvg : (mentionCount > 0 ? 2 : 0); // ratio; >1 = accelerating

    // 2) Bias-aware sentiment family for the window, plus the baseline for the shift.
    const bdWin = computeSentimentBreakdown(await this.perSourceSentimentHours(entity, win));
    const bdBase = computeSentimentBreakdown(await this.perSourceSentimentHours(entity, base));
    const sentimentShift = bdWin.balanced != null && bdBase.balanced != null ? bdWin.balanced - bdBase.balanced : null;
    const dispersion = stdev(bdWin.bySource.map((s) => s.value));

    // 3) Contagion: graph co-mention degree.
    let degree = 0;
    try { degree = (await this.neighbors(entity, 1)).length; } catch { degree = 0; }

    // 4) Catalysts: the strongest intensity of each event_* type seen in the window (the KIND of news).
    const eq = await this.tsdb.query(
      `SELECT event_type, max(event_intensity) AS intensity
         FROM world_items
        WHERE entity_id=$1 AND event_type IS NOT NULL
          AND first_seen_at >= now() - ($2 || ' hours')::interval
        GROUP BY event_type`,
      [entity, String(win)],
    );
    const eventFeatures: Record<string, number | null> = {};
    for (const row of eq.rows as Array<{ event_type: string; intensity: string | number }>) {
      eventFeatures[`event_${String(row.event_type)}`] = round3(Number(row.intensity));
    }

    const features: Record<string, number | null> = {
      mention_count: mentionCount,
      mention_velocity: round3(mentionVelocity),
      novelty: round3(novelty),
      sentiment_mean: bdWin.balanced,
      sentiment_shift: round3(sentimentShift),
      sentiment_dispersion: round3(dispersion),
      sentiment_consensus: consensusScore(bdWin.consensus),
      reliability_weighted_sentiment: bdWin.reliabilityWeighted,
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

  /** The world subjects already tracked (ingested), most-covered first — the catalog the
   *  surface lists and the world_entities tool returns. Sourced from the archive. */
  async listEntities(limit = 50): Promise<Array<{ entity: string; label: string; items: number; lastSeen: string | null }>> {
    await this.ensureArchive();
    const r = await this.tsdb.query(
      `SELECT entity_id, max(entity_label) AS label, count(*)::int AS items, max(first_seen_at) AS last_seen
         FROM world_items GROUP BY entity_id ORDER BY items DESC LIMIT $1`,
      [limit],
    );
    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      entity: String(row.entity_id),
      label: String(row.label || row.entity_id),
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
  const svc = new WorldIntelligenceService(connector, new Pool({ connectionString: tsdbUrl }));
  serviceMemo.set(tsdbUrl, svc);
  return svc;
}

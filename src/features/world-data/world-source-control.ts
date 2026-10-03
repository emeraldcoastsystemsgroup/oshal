/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Operator source switches and the collector run record behind the World sources screen (operator ask 2026-10-02: see the pull locations and turn them on or off). Two small tables on the series store: `world_source_switches` (one row per source the operator switched off; switching back on deletes it) and `world_collector_runs` (the last run of each depth collector: when, ok / failed / skipped, its counts). The switch set is cached for WORLD_SOURCE_SWITCH_TTL_MS (default 30 s) so the per-subject ingest reads it from memory; a change made here clears the cache at once. A switch can only turn a source OFF beyond what .env allows — the .env flags stay the ceiling.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes: a collector run can end 'partial' (some of its feed requests answered), collectorFeedOutcome() turns answered/asked into that outcome for the collectors, and an unreadable pull aggregate logs at ERROR.
 */

import type { Pool, QueryConfig } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'world-source-control' });

/** How long a read of the switch set is reused before the table is read again. */
const SWITCH_TTL_MS_DEFAULT = 30_000;
/** Ceiling for the 24-hour pull aggregate the screen shows (it must never hold up a page). */
const STATS_QUERY_TIMEOUT_MS = 3_000;

/** One source an operator switched off (switching it back on removes the row). */
export interface WorldSourceSwitch { sourceId: string; enabled: boolean; updatedBy: string | null; updatedAt: string }

/** How one depth collector's last run ended: `partial` = some of its feed requests failed. */
export type WorldCollectorOutcome = 'ok' | 'partial' | 'failed' | 'skipped';

/** How a collector's own feed requests went, as the collector reports it in its result. */
export type CollectorFeedOutcome = 'ok' | 'partial' | 'failed';

/**
 * @description A collector's feed outcome from how many of its requests answered.
 * @param answered - Requests that returned a readable answer (an empty list counts).
 * @param asked - Requests made.
 * @returns ok when all answered, failed when none did, partial in between.
 */
export function collectorFeedOutcome(answered: number, asked: number): CollectorFeedOutcome {
  if (answered >= asked) return 'ok';
  return answered <= 0 ? 'failed' : 'partial';
}

/** The last run of one depth collector. */
export interface WorldCollectorRun { collector: string; ranAt: string; outcome: WorldCollectorOutcome; detail: Record<string, unknown> }

/** One feed id's pulls over the reporting window, from `world_pulls`. */
export interface WorldFeedPullStats { feedId: string; pulls: number; fetched: number; newItems: number; lastPull: string | null }

/**
 * @description How long a read of the switch set is reused.
 * @param env - Environment carrying WORLD_SOURCE_SWITCH_TTL_MS.
 * @returns Milliseconds (0 reads the table every time); the default when unset or negative.
 */
export function worldSourceSwitchTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORLD_SOURCE_SWITCH_TTL_MS;
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : SWITCH_TTL_MS_DEFAULT;
}

/**
 * @description The operator's source switches and the collector run record, on the series store.
 * Every read and write here is small (a handful of rows); the 24-hour pull aggregate is bounded by
 * the `world_pulls` time partitioning and a per-query timeout.
 */
export class WorldSourceControl {
  private ready: Promise<void> | null = null;
  private cache: { at: number; off: ReadonlySet<string> } | null = null;

  constructor(private readonly pool: Pool, private readonly ttlMs: number = worldSourceSwitchTtlMs()) {}

  /** @description Create the two tables once per process (idempotent DDL). */
  private ensure(): Promise<void> {
    this.ready ??= (async () => {
      await this.pool.query(`CREATE TABLE IF NOT EXISTS world_source_switches (
        source_id text PRIMARY KEY, enabled boolean NOT NULL,
        updated_by text, updated_at timestamptz NOT NULL DEFAULT now())`);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS world_collector_runs (
        collector text PRIMARY KEY, ran_at timestamptz NOT NULL,
        outcome text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb)`);
    })().catch((err) => { this.ready = null; throw err; });
    return this.ready;
  }

  /**
   * @description The ids the operator switched off. Served from memory for the TTL. When the table
   * cannot be read the last known set is kept (an empty set before the first read), so a series-store
   * hiccup never switches a source on or off by itself; the failure is logged at ERROR.
   * @returns The switched-off source ids.
   */
  async switchedOff(): Promise<ReadonlySet<string>> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.off;
    try {
      await this.ensure();
      const r = await this.pool.query<{ source_id: string }>('SELECT source_id FROM world_source_switches WHERE enabled = false');
      this.cache = { at: Date.now(), off: new Set(r.rows.map((row) => row.source_id)) };
    } catch (err) {
      logger.error({ err }, 'World source switches could not be read — keeping the last known set');
      this.cache = { at: Date.now(), off: this.cache?.off ?? new Set<string>() };
    }
    return this.cache.off;
  }

  /**
   * @description Every stored switch, for the screen.
   * @returns The switched-off sources with who changed them and when.
   */
  async listSwitches(): Promise<WorldSourceSwitch[]> {
    await this.ensure();
    const r = await this.pool.query('SELECT source_id, enabled, updated_by, updated_at FROM world_source_switches ORDER BY source_id');
    return r.rows.map((row) => ({
      sourceId: String(row.source_id), enabled: Boolean(row.enabled),
      updatedBy: row.updated_by ? String(row.updated_by) : null, updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  /**
   * @description Switch one source on or off. Off stores a row; on deletes it, so the .env
   * configuration applies again. The cached set is cleared so the next read sees the change.
   * @param sourceId - A source id from the inventory (validated by the caller).
   * @param enabled - The new state.
   * @param actor - The operator's subject, for the record.
   * @returns Nothing.
   */
  async setSwitch(sourceId: string, enabled: boolean, actor: string | null): Promise<void> {
    await this.ensure();
    if (enabled) {
      await this.pool.query('DELETE FROM world_source_switches WHERE source_id = $1', [sourceId]);
    } else {
      await this.pool.query(`INSERT INTO world_source_switches (source_id, enabled, updated_by, updated_at)
        VALUES ($1, false, $2, now())
        ON CONFLICT (source_id) DO UPDATE SET enabled = false, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [sourceId, actor]);
    }
    this.cache = null;
    logger.info({ sourceId, enabled, actor }, 'World source switch changed');
  }

  /**
   * @description Record how one depth collector's run ended. Never throws: a failure to record is
   * logged at ERROR and the fire carries on.
   * @param collector - The collector's source id.
   * @param outcome - ok, failed or skipped.
   * @param detail - The collector's counts, the error message, or the skip reason (no credentials).
   * @returns Nothing.
   */
  async recordCollectorRun(collector: string, outcome: WorldCollectorOutcome, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.ensure();
      await this.pool.query(`INSERT INTO world_collector_runs (collector, ran_at, outcome, detail)
        VALUES ($1, now(), $2, $3::jsonb)
        ON CONFLICT (collector) DO UPDATE SET ran_at = now(), outcome = EXCLUDED.outcome, detail = EXCLUDED.detail`,
      [collector, outcome, JSON.stringify(detail)]);
    } catch (err) {
      logger.error({ err, collector, outcome }, 'Recording a world collector run failed');
    }
  }

  /**
   * @description The last run of every depth collector that has run.
   * @returns One row per collector.
   */
  async collectorRuns(): Promise<WorldCollectorRun[]> {
    await this.ensure();
    const r = await this.pool.query('SELECT collector, ran_at, outcome, detail FROM world_collector_runs ORDER BY collector');
    return r.rows.map((row) => ({
      collector: String(row.collector), ranAt: new Date(row.ran_at).toISOString(),
      outcome: row.outcome as WorldCollectorOutcome, detail: (row.detail ?? {}) as Record<string, unknown>,
    }));
  }

  /**
   * @description Pulls per feed id over the last `hours`, from `world_pulls`. A source that returned
   * nothing or failed writes no pull row, so absence here means "no successful pull", not "not tried".
   * Returns an empty list (logged at WARN) when the archive does not exist yet or the read times out.
   * @param hours - The window (default 24).
   * @returns One row per feed id seen in the window.
   */
  async feedPullStats(hours = 24): Promise<WorldFeedPullStats[]> {
    try {
      // pg honours a per-query timeout; its separately versioned QueryConfig type omits it.
      const config: QueryConfig & { query_timeout: number } = {
        text: `SELECT feed_id, count(*)::int AS pulls, coalesce(sum(fetched),0)::int AS fetched,
                 coalesce(sum(new_items),0)::int AS new_items, max(ts) AS last_pull
               FROM world_pulls WHERE ts > now() - make_interval(hours => $1::int)
               GROUP BY feed_id ORDER BY feed_id`,
        values: [hours],
        query_timeout: STATS_QUERY_TIMEOUT_MS,
      };
      const r = await this.pool.query(config);
      return r.rows.map((row: Record<string, unknown>) => ({
        feedId: String(row.feed_id), pulls: Number(row.pulls), fetched: Number(row.fetched),
        newItems: Number(row.new_items), lastPull: row.last_pull ? new Date(row.last_pull as string).toISOString() : null,
      }));
    } catch (err) {
      logger.error({ err }, 'World feed pull stats unavailable');
      return [];
    }
  }
}

const byPool = new WeakMap<Pool, WorldSourceControl>();

/**
 * @description The one source-control instance for a series-store pool, so the switch cache is shared
 * by the dispatcher, the ingest and the screen within a process.
 * @param pool - The series-store pool.
 * @returns The instance for that pool.
 */
export function worldSourceControl(pool: Pool): WorldSourceControl {
  let control = byPool.get(pool);
  if (!control) {
    control = new WorldSourceControl(pool);
    byPool.set(pool, control);
  }
  return control;
}

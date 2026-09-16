/**
 * World-intelligence refresh dispatch — the framework-intelligence branch of the shared scheduler.
 *
 * When the `app:world-refresh` schedule fires there is NO user session and NO subject in the prompt,
 * so an LLM-driven "refresh the layer" instruction has nothing concrete to ingest (world_ingest needs
 * {q, entity}). This module makes the refresh DETERMINISTIC (the world analogue of
 * trading-schedule-dispatch.ts): on each fire it
 *  (a) builds the World-Intelligence Service (skips quietly when the world layer is disabled),
 *  (b) enumerates the subjects already tracked in the shared archive (svc.listEntities),
 *  (c) re-pulls + classifies fresh news for EACH subject across the registered feeds via the SAME
 *      `ingestFeeds` core the /api/world/ingest-news route uses (so the pull-rate ledger, dedup, and
 *      bias-aware classification all apply identically), and
 *  (d) returns a run summary; the `world_pulls` ledger is the per-run record (its whole purpose).
 *
 * The classify step runs the swarm's Claude creds in-process exactly like the interactive world route
 * already does — this path introduces no NEW controller-side LLM call, it triggers the established one
 * on a timer instead of on a bot tool call. Work is bounded: at most MAX_SUBJECTS subjects per fire,
 * LIMIT items per feed variant.
 *
 * The shared scheduler stays generic: schedule-runtime only branches here when isWorldSchedule matches.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — deterministic world-refresh loop (enumerate tracked subjects → re-ingest+classify each via ingestFeeds), replacing the subject-less LLM dispatch that never pulled.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Log the global classify-budget snapshot in the completion line — the 2026-06-29 burn ran 9 HOURS before a human noticed because spend was invisible; now every cycle's record says how much of the LLM budget the world layer has used and whether it was denied any.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bound the rollup fan-out from config (WORLD_ROLLUP_CONCURRENCY, default 4 instead of a compiled-in 8) and record what each fire costs the series store: entity count, statements issued, statements coalesced and wall time at INFO, plus a WARN once a pulse crosses a configured fraction of its window. On 2026-09-14 the 184-entity fan-out put 19 concurrent aggregates on oshal-local-tsdb (282% CPU) because an abandoned dispatch keeps running while the next fire starts, and the only evidence a human had was pg_stat_activity while it was happening.
 *
 * @module world-schedule-dispatch
 */

import type { AppContext } from './composition-root';
import type { ScheduleRecord, ScheduleDispatchResult } from '@/features/scheduling';
import {
  createWorldIntelligenceService,
  ingestFeeds, speedReadFirehose, deepDiveFirehose,
  collectMarketEvents,
  collectPoliticalTrades,
  collectInsiderTrades,
  collectShortInterest,
  collectGovContracts,
  DEFAULT_FEED_IDS, FINANCE_FEED_IDS, PULSE_FEED_IDS,
  firehoseEnabled, firehoseFeeds, firehoseLimit, firehoseEveryNPulses,
  deepDiveEnabled, deepDiveBudget, deepDiveMetered, feedBudgetMs, classifyBudgetSnapshot,
  seriesReadStats, seriesReadConcurrency, type SeriesReadStats,
  DEFAULT_WORLD_TOPICS, tickerSubject, type WorldSubject,
  MARKET_SUBJECTS,
} from '@/features/world-data';
import { DEFAULT_UNIVERSE } from '@/features/trading';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'world-schedule-dispatch' });

/** Default refresh cadence (manifest `world-refresh`): every 6 hours. */
export const WORLD_REFRESH_CRON_DEFAULT = '0 */6 * * *';
/** Hard cap on subjects per fire — bounds feed requests + LLM cost (defaults topics+universe ≈ 115). */
const MAX_SUBJECTS = 200;
/** Items per feed variant per subject. */
const DEFAULT_LIMIT = 15;
/** Tickers refreshed concurrently on the every-5-min pulse so 100 names finish inside the window
 *  (each is mostly cheap re-pulls — only genuinely-new items hit the classifier). Depth refresh stays
 *  sequential (no rush at 6h, and it's gentler on the feeds + LLM). Kept modest because concurrent
 *  ingests race on the SHARED world graph — the service retries write-write conflicts, but lower
 *  concurrency keeps that contention (and retry churn) down. */
const PULSE_SUBJECT_CONCURRENCY = 3;

/** How many universe names get the FULL finance fan-out per pulse (the rest get the lean 3-source pull).
 *  The slice rotates each fire so every name gets deep coverage over ~ceil(100/size) pulses (~45 min),
 *  while any single pulse stays bounded (mostly lean) and finishes inside the 5-min window. */
// How many names get the full finance fan-out per pulse (rotation slice + an equal attention-metered set).
// This is the dominant per-pulse LLM cost — env-tunable so you can throttle classify burn without a rebuild.
// 0 = all-lean (no full fan-out → minimal classify). Default 12.
const PULSE_DEEP_SLICE_SIZE = Math.max(0, Number(process.env.WORLD_PULSE_DEEP_SLICE) || 12);
/** Concurrency for the post-refresh feature rollup. DB-only (TSDB reads + inserts, no Arango graph
 *  write-conflict risk), so it can run wider than the ingest concurrency — but only as wide as the
 *  series store can answer. Read per fire so an operator can throttle it in .env without a rebuild;
 *  the process-wide bound in the series gate is what holds when two pulses overlap. */
const FEATURE_ROLLUP_CONCURRENCY_DEFAULT = 4;

/** @description How many entities the feature rollup may work on at once within ONE fire.
 *  @param env - Environment to read.
 *  @returns The configured fan-out, or the default when unset/invalid. */
function featureRollupConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WORLD_ROLLUP_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : FEATURE_ROLLUP_CONCURRENCY_DEFAULT;
}

/** The pulse's cadence — the window one fire has to finish in before the next one lands on top of
 *  it. Matches the manifest's every-5-minutes market-hours cron, and is env-tunable with it. */
const PULSE_WINDOW_MS_DEFAULT = 5 * 60 * 1000;
/** Fraction of the window above which a completed pulse is logged as an overrun. */
const PULSE_WARN_FRACTION_DEFAULT = 0.8;

/**
 * @description Whether a finished pulse ran long enough to be worth warning about — the run before
 * the one that actually overruns, so a regression is visible in the journal before the scheduler
 * starts abandoning dispatches and pulses start stacking.
 * @param elapsedMs - Wall time the fire took.
 * @param env - Environment to read (WORLD_PULSE_WINDOW_MS, WORLD_PULSE_WARN_FRACTION).
 * @returns The verdict plus the window and threshold it was judged against.
 */
export function pulseOverrun(
  elapsedMs: number,
  env: NodeJS.ProcessEnv = process.env,
): { over: boolean; budgetMs: number; fraction: number; thresholdMs: number } {
  const parsedBudget = Number(env.WORLD_PULSE_WINDOW_MS);
  const budgetMs = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : PULSE_WINDOW_MS_DEFAULT;
  const parsedFraction = Number(env.WORLD_PULSE_WARN_FRACTION);
  const fraction = Number.isFinite(parsedFraction) && parsedFraction > 0 && parsedFraction <= 1
    ? parsedFraction
    : PULSE_WARN_FRACTION_DEFAULT;
  const thresholdMs = budgetMs * fraction;
  return { over: elapsedMs > thresholdMs, budgetMs, fraction, thresholdMs };
}

/** @description The rotating set of ticker entity ids that get the full finance fan-out THIS pulse.
 *  Time-derived (advances every 5 min) so it needs no persisted cursor and is stable across restarts. */
function deepTickerSlice(symbols: readonly string[], size: number): Set<string> {
  const n = symbols.length;
  if (n === 0) return new Set();
  const slices = Math.max(1, Math.ceil(n / size));
  const tick = Math.floor(Date.now() / (5 * 60 * 1000)); // one step per 5-min pulse
  const start = (tick % slices) * size;
  return new Set(symbols.slice(start, start + size).map((s) => `world:ticker:${s.toLowerCase()}`));
}

/** Run `fn` over `items` with at most `n` in flight, preserving order. */
async function mapPool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next; next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** @description True for any framework world-intelligence schedule (`app:world-...`). */
export function isWorldSchedule(taskType: string): boolean {
  return taskType.startsWith('app:world-');
}

/** @description True for the frequent market-hours TICKER PULSE (vs the 6-hourly depth refresh). The
 *  pulse keeps the trading universe's sentiment fresh enough to feed the every-5-min autopilot gate. */
export function isTickerPulse(taskType: string): boolean {
  return taskType.includes('ticker-pulse');
}

/** Per-subject outcome of one refresh fire. */
interface SubjectResult { entity: string; label: string; fetched: number; newItems: number; usedLlm: boolean; error?: string; }

/**
 * @description The DEPTH-refresh subject set: the canonical default topics/macro + any tracked NON-ticker
 * subjects. Tickers are deliberately EXCLUDED — they are owned by the every-5-min pulse (which also runs
 * the full finance fan-out on a rotating slice). Keeping the depth handler off the 100-name fan-out is
 * what stops it hogging the single-flight scheduler cycle and starving the pulse.
 * @param tracked - Subjects already in the archive (svc.listEntities).
 * @returns Ordered subject list (deep topics first, then broad topics, then extra tracked non-tickers).
 */
function buildSubjectSet(tracked: Array<{ entity: string; label: string }>): WorldSubject[] {
  const byEntity = new Map<string, WorldSubject>();
  for (const t of DEFAULT_WORLD_TOPICS) byEntity.set(t.entity, t);
  for (const e of tracked) {
    if (e.entity.startsWith('world:ticker:')) continue; // tickers belong to the pulse, not the depth refresh
    if (!byEntity.has(e.entity)) byEntity.set(e.entity, { entity: e.entity, label: e.label, query: e.label });
  }
  const all = [...byEntity.values()];
  // Deep subjects first so the bias-balanced pulls run even if a later cap/timeout truncates the run.
  return all.sort((a, b) => Number(Boolean(b.deep)) - Number(Boolean(a.deep)));
}

/**
 * @description Re-pull + classify fresh news for one subject. Treatment by subject kind:
 *  - TICKER (subject.symbol set): the finance feed set (Yahoo per-symbol + finance-angle news/social),
 *    fanned out across the per-ticker query plan keyed on the company name — broad coverage per name.
 *  - DEEP topic: the full cross-spectrum bias-balanced news plan.
 *  - other topic: the light base pull so the broad topic set finishes in the window.
 * @param svc - The world-intelligence service (deterministic disposer).
 * @param subject - The subject (entity id, label, query, deep?/symbol?/name?).
 * @param topicSources - Feed ids to pull for TOPIC subjects (tickers always use the finance set).
 * @param limit - Items per feed variant.
 * @returns The per-subject fetched/new/llm summary (error captured, never thrown).
 */
async function refreshSubject(
  svc: NonNullable<ReturnType<typeof createWorldIntelligenceService>>,
  subject: WorldSubject,
  topicSources: string[],
  limit: number,
  lean = false,
): Promise<SubjectResult> {
  try {
    const isTicker = Boolean(subject.symbol);
    // Pulse tickers pull the lean 3-source set (speed); depth tickers pull the full finance set (breadth).
    const sources = isTicker ? (lean ? PULSE_FEED_IDS : FINANCE_FEED_IDS) : topicSources;
    const opts = isTicker
      ? { limit, ticker: { symbol: subject.symbol as string, name: subject.name || (subject.symbol as string), lean } }
      : { limit, light: !subject.deep };
    const r = await ingestFeeds(svc, subject.query, subject.entity, subject.label, sources, opts);
    const fetched = r.perSource.reduce((n, s) => n + (s.fetched ?? 0), 0);
    const newItems = r.perSource.reduce((n, s) => n + (s.newItems ?? 0), 0);
    return { entity: subject.entity, label: subject.label, fetched, newItems, usedLlm: r.usedLlm };
  } catch (e) {
    logger.warn({ err: e, entity: subject.entity }, 'world refresh: subject ingest failed');
    return { entity: subject.entity, label: subject.label, fetched: 0, newItems: 0, usedLlm: false, error: (e as Error).message };
  }
}

/** What one completed fire did — the numbers the completion record is built from. */
interface FireOutcome {
  scheduleId: string;
  pulse: boolean;
  entities: number;
  deepSlice: number;
  rolled: number;
  elapsedMs: number;
  seriesBefore: SeriesReadStats;
  totals: { fetched: number; newItems: number; errors: number };
}

/**
 * @description Record what one fire cost — not just what it FETCHED but what it cost the series
 * store. `seriesStatements` is the delta of the gate's cumulative counter, so it is this fire's own
 * share even while another fire is still running, and `seriesCoalesced` is the statements the gate
 * did not have to issue because an identical read was already in flight. Without these numbers a
 * regression is only visible in `pg_stat_activity`, and only while it is happening. A pulse that has
 * eaten most of its window also gets a WARN, because the next thing that happens is fires stacking.
 * @param o - The completed fire's counts and timings.
 * @returns Nothing; this only writes the journal.
 */
function logFireOutcome(o: FireOutcome): void {
  const series = seriesReadStats();
  const seriesStatements = series.issued - o.seriesBefore.issued;
  logger.info({
    scheduleId: o.scheduleId, mode: o.pulse ? 'ticker-pulse' : 'depth-refresh', entities: o.entities,
    deepSlice: o.deepSlice, rolled: o.rolled, elapsedMs: o.elapsedMs, seriesStatements,
    seriesCoalesced: series.coalesced - o.seriesBefore.coalesced,
    seriesMaxInFlight: series.maxInFlight, seriesReadConcurrency: seriesReadConcurrency(),
    classifyBudget: classifyBudgetSnapshot(), ...o.totals,
  }, 'world refresh complete');
  if (!o.pulse) return;
  const budget = pulseOverrun(o.elapsedMs);
  if (!budget.over) return;
  logger.warn({
    scheduleId: o.scheduleId, entities: o.entities, elapsedMs: o.elapsedMs, seriesStatements,
    thresholdMs: budget.thresholdMs, budgetMs: budget.budgetMs, fraction: budget.fraction,
  }, 'world ticker pulse used most of its window — the next fire will start on top of this one if it grows');
}

/**
 * @description Dispatch a world-intelligence schedule that just came due. Two modes, keyed off taskType,
 * BOTH bounded so neither hogs the single-flight scheduler cycle (which would starve the other):
 *  - TICKER PULSE (`...ticker-pulse`, every 5 min, market hours): the trading universe. Every name gets
 *    the LEAN 3-source pull; a ROTATING slice (PULSE_DEEP_SLICE_SIZE) additionally gets the full finance
 *    fan-out, so deep breadth still runs continuously while any single pulse stays short. Concurrent.
 *  - DEPTH REFRESH (`...refresh`, every 6h): topics/macro + tracked NON-ticker subjects only (tickers are
 *    owned by the pulse). Sequential, but small — finishes in minutes.
 * Re-ingests each deterministically (no LLM decides whether to loop); classification uses the swarm
 * Claude creds inside ingestFeeds, exactly like the interactive route.
 * @param _ctx - App context (unused; the world service builds its own graph + TSDB handles).
 * @param schedule - The due schedule record (taskData may carry sources/limit/maxSubjects overrides).
 * @returns Dispatch result for scheduler accounting.
 */
export async function dispatchWorldSchedule(_ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const svc = createWorldIntelligenceService();
  if (!svc) {
    logger.info({ scheduleId: schedule.id }, 'world refresh skipped — world intelligence disabled (ENABLE_WORLD_INTELLIGENCE / ARANGO_URL / TSDB_URL)');
    return { success: true, scheduleId: schedule.id };
  }

  const startedAt = Date.now();
  const seriesBefore = seriesReadStats();
  const pulse = isTickerPulse(schedule.taskType);
  const td = (schedule.taskData || {}) as Record<string, unknown>;
  const sources = Array.isArray(td.sources) && td.sources.length ? (td.sources as unknown[]).map(String) : DEFAULT_FEED_IDS;
  const limit = Number(td.limit) > 0 ? Number(td.limit) : DEFAULT_LIMIT;
  const maxSubjects = Number(td.maxSubjects) > 0 ? Number(td.maxSubjects) : MAX_SUBJECTS;

  try {
    // PULSE: the whole trading universe + market context (indices/sectors/commodities/rates/crypto, §1);
    // tickers get a rotating full fan-out, the rest lean. DEPTH: topics/macro + tracked non-tickers.
    const subjects = pulse
      ? [...DEFAULT_UNIVERSE.map(tickerSubject), ...MARKET_SUBJECTS]
      : buildSubjectSet(await svc.listEntities(500).catch(() => [])).slice(0, maxSubjects);
    // Deep-search set = time-rotation slice (coverage) ∪ top-attention names (metered: hot names get the
    // full fan-out every pulse, not just on their rotation turn).
    const deep = pulse ? deepTickerSlice(DEFAULT_UNIVERSE, PULSE_DEEP_SLICE_SIZE) : new Set<string>();
    if (pulse) {
      const movers = await svc.topAttentionTickers(24, PULSE_DEEP_SLICE_SIZE).catch(() => [] as string[]);
      for (const m of movers) deep.add(m);
    }

    // Pulse: refresh the universe concurrently so all 100 names land inside the 5-min window (deep slice
    // gets the full fan-out, the rest lean). Depth: sequential (no rush at 6h, gentler on feeds + LLM).
    const results: SubjectResult[] = pulse
      ? await mapPool(subjects, PULSE_SUBJECT_CONCURRENCY, (s) => refreshSubject(svc, s, sources, limit, !deep.has(s.entity)))
      : await (async () => { const r: SubjectResult[] = []; for (const s of subjects) r.push(await refreshSubject(svc, s, sources, limit, false)); return r; })();

    const totals = results.reduce((a, r) => ({ fetched: a.fetched + r.fetched, newItems: a.newItems + r.newItems, errors: a.errors + (r.error ? 1 : 0) }), { fetched: 0, newItems: 0, errors: 0 });

    // FIREHOSE (pulse only): the fluent O(feeds) path. Two tiers —
    //  - SPEED READ: pull every publisher feed once, cheap lexicon + entity match (no LLM) → volume +
    //    attention + breaking news, fast. Always (every Nth pulse).
    //  - DEEP DIVE: spend the metered LLM budget on the freshest un-deepened items, allocated across feeds
    //    by the learned novelty meter. Both run before the rollup so their items fold into the features.
    if (pulse && firehoseEnabled()) {
      const tick = Math.floor(Date.now() / (5 * 60 * 1000));
      if (tick % firehoseEveryNPulses() === 0) {
        const feeds = firehoseFeeds();
        try {
          const sr = await speedReadFirehose(svc, feeds, { limit: firehoseLimit(), feedBudgetMs: feedBudgetMs() });
          logger.info({ scheduleId: schedule.id, feeds: sr.perFeed.length, fresh: sr.perFeed.reduce((n, f) => n + f.fresh, 0), attached: sr.perFeed.reduce((n, f) => n + f.attached, 0) }, 'world firehose speed-read');
        } catch (e) { logger.warn({ err: e, scheduleId: schedule.id }, 'world firehose speed-read failed'); }
        if (deepDiveEnabled()) {
          try {
            const dd = await deepDiveFirehose(svc, feeds, { budget: deepDiveBudget(), metered: deepDiveMetered() });
            logger.info({ scheduleId: schedule.id, deepened: dd.deepened }, 'world firehose deep-dive');
          } catch (e) { logger.warn({ err: e, scheduleId: schedule.id }, 'world firehose deep-dive failed'); }
        }
      }
    }

    // FORWARD MARKET-EVENTS CALENDAR (earnings / FOMC / jobs) — refreshed on the 6h DEPTH cycle (a calendar
    // doesn't change intraday). Writes world_events + days_to_* metrics the gate/miner read. Isolated.
    if (!pulse && process.env.WORLD_EVENTS_ENABLED !== 'false') {
      try {
        const ev = await collectMarketEvents(svc);
        logger.info({ scheduleId: schedule.id, ...ev }, 'market events collected');
      } catch (e) {
        logger.warn({ err: e, scheduleId: schedule.id }, 'market events collect failed');
      }
    }

    // INFORMED-MONEY FLOW SIGNALS (depth cycle): congress trades, corporate insider (Form 4), short volume.
    // Each isolated — one source failing never blocks the others. Lagged/slow signals (positioning, not catalysts).
    if (!pulse && process.env.WORLD_FLOW_ENABLED !== 'false') {
      try { const p = await collectPoliticalTrades(svc); logger.info({ scheduleId: schedule.id, ...p }, 'congress trades collected'); }
      catch (e) { logger.warn({ err: e, scheduleId: schedule.id }, 'congress trades failed'); }
      try { const ins = await collectInsiderTrades(svc); logger.info({ scheduleId: schedule.id, ...ins }, 'insider trades collected'); }
      catch (e) { logger.warn({ err: e, scheduleId: schedule.id }, 'insider trades failed'); }
      try { const sh = await collectShortInterest(svc); logger.info({ scheduleId: schedule.id, ...sh }, 'short interest collected'); }
      catch (e) { logger.warn({ err: e, scheduleId: schedule.id }, 'short interest failed'); }
      if (process.env.WORLD_GOV_ENABLED !== 'false') {
        try { const gv = await collectGovContracts(svc); logger.info({ scheduleId: schedule.id, ...gv }, 'gov contracts collected'); }
        catch (e) { logger.warn({ err: e, scheduleId: schedule.id }, 'gov contracts failed'); }
      }
    }

    // Feature rollup (trading signal dataset §1): turn the raw archive we just refreshed into the queryable
    // signal-vector metrics in world_metrics. No feeds and no LLM — but four indexed aggregates per entity
    // over 184 entities is not "cheap" to the series store, which is what 2026-09-14 proved. This mapPool
    // bounds ONE fire; the series gate inside the service is what bounds the sum of every fire still running.
    let rolled = 0;
    await mapPool(subjects, featureRollupConcurrency(), async (s) => {
      try { await svc.rollupFeatures(s.entity); rolled += 1; }
      catch (e) { logger.warn({ err: e, entity: s.entity }, 'feature rollup failed'); }
    });

    logFireOutcome({
      scheduleId: schedule.id, pulse, entities: subjects.length, deepSlice: deep.size, rolled,
      elapsedMs: Date.now() - startedAt, seriesBefore, totals,
    });
    return { success: true, scheduleId: schedule.id, taskId: `world-refresh-${schedule.id}` };
  } catch (e) {
    logger.error({ err: e, scheduleId: schedule.id }, 'world refresh failed');
    return { success: false, scheduleId: schedule.id, error: (e as Error).message };
  }
}

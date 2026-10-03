/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab card for the congressional (STOCK Act) disclosure signal. One read-only step reports what the installed collector has actually written: how many names carry an observed disclosure in the last 90 days, the newest disclosure (ReportDate) day and the newest observed_at. It makes no write and no feed call. The ReportDate keying, observed_at, idempotent re-runs and the reserved congress_* namespace are proven by the attached suites on a disposable TimescaleDB; this step is the live half, and says which half it is.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Attach tests/unit/world-depth-collectors-postgres.spec.ts: the depth fire runs the congress collector before its subject sweep (real dispatch, real collector, real feed fetch, disposable TimescaleDB). The collector used to sit behind that sweep, which took about 33 minutes on 2026-06-26, against a 240 s dispatch abandonment.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The degraded detail names the credential refusal line too: on 2026-09-28 the default congress feed answered HTTP 401 without WORLD_POLITICAL_TOKEN, and a refused feed writes nothing, so "nothing observed" has that as a cause to check.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The World sources and schedules card (the operator page, 2026-10-02): two read-only live steps — the two World schedule records with on/off, cron and any operator override, and the source inventory with switches, .env gates and each depth collector's last run — plus the suites that prove the controls across a real Redis (app-schedule-control) and a real TimescaleDB (world-depth-collectors-postgres).
 *
 * @module routes/test-lab-world-signal-scenarios
 */

import { createChildLogger } from '@/shared/logger';
import {
  createWorldIntelligenceService, describeWorldSources, WORLD_COLLECTOR_IDS, type WorldIntelligenceService,
} from '@/features/world-data';
import type { ScheduleService } from '@/features/scheduling';
import { getHomeScheduleService } from '../home-schedule-dispatch';
import type { Scenario, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-world-signal-scenarios' });

const APP = 'world';
const LABEL = 'Observed congressional disclosures (last 90 days)';
export const CONGRESS_LAB_METRICS = ['congress_buys', 'congress_sells', 'congress_net', 'congress_sentiment', 'congress_notional'];
export const CONGRESS_LAB_SOURCE = 'quiver-congress';
export const CONGRESS_LAB_WINDOW_DAYS = 90;
/** The recent-feed read's own entity cap; a count at the cap is reported as "at least". */
export const CONGRESS_LAB_MAX_NAMES = 100;
const READ_TIMEOUT_MS = 20_000;

/** The one method this step reads through. */
type CoverageReader = Pick<WorldIntelligenceService, 'recentFeedMetricPoints'>;

const result = (state: StepResult['state'], detail: string, output?: unknown): StepResult => ({
  app: APP, label: LABEL, state, detail, ...(output === undefined ? {} : { output }),
});

/** Race the read against a bounded timer so an unreachable series store cannot hang the Lab run. */
async function boundedRead(reader: CoverageReader) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`series store did not answer within ${READ_TIMEOUT_MS / 1000}s`)), READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      reader.recentFeedMetricPoints(CONGRESS_LAB_METRICS, CONGRESS_LAB_SOURCE, CONGRESS_LAB_WINDOW_DAYS, CONGRESS_LAB_MAX_NAMES),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @description Read-only live readback of the congressional disclosure rows. Degraded when the
 * world layer is off or nothing observed has been written yet; fail when the store cannot be read.
 * @param reader - The world service (null when world intelligence is disabled on this deployment).
 * @returns The step result; its output names the counts and dates it read.
 */
export async function congressCoverageStep(reader: CoverageReader | null): Promise<StepResult> {
  if (!reader) return result('degraded', 'World intelligence is disabled on this deployment (ENABLE_WORLD_INTELLIGENCE, TSDB_URL, ARANGO_URL), so there is no disclosure series to read.');
  let points: Awaited<ReturnType<CoverageReader['recentFeedMetricPoints']>>;
  try {
    points = await boundedRead(reader);
  } catch (err) {
    logger.error({ err }, 'Test Lab congressional disclosure readback failed');
    return result('fail', `The world series store could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const names = [...new Set(points.map((p) => p.entity.replace(/^world:ticker:/, '').toUpperCase()))];
  if (!names.length) {
    return result('degraded', `No observed congressional disclosure in the last ${CONGRESS_LAB_WINDOW_DAYS} days. The 6-hour depth cycle has not written one with observed_at yet, or the feed returned nothing - check the api log for "political trades collected", "congress trades feed refused" (the feed needs WORLD_POLITICAL_TOKEN) or "congress trades fetch failed". Locally tested only; not live-proven.`);
  }
  const newestDisclosure = points.reduce((a, p) => (p.ts > a ? p.ts : a), '').slice(0, 10);
  const lastObservedAt = points.reduce((a, p) => (p.observedAt && p.observedAt > a ? p.observedAt : a), '');
  const count = names.length >= CONGRESS_LAB_MAX_NAMES ? `at least ${names.length}` : String(names.length);
  return result('pass', `Live: ${count} name(s) carry an observed quiver-congress disclosure; newest disclosure day ${newestDisclosure}, last observed ${lastObservedAt}. Read-only; no feed call was made.`, {
    names: names.length, newestDisclosure, lastObservedAt, sample: names.slice(0, 5),
  });
}

const SCHEDULES_LABEL = 'World schedules (records and operator overrides)';
const SOURCES_LABEL = 'World sources (switches, gates, collector runs)';
/** The World manifest's framework schedules, as the registrar names them. */
export const WORLD_LAB_SCHEDULES = ['world-refresh', 'ticker-pulse'] as const;

/** @description Race any read against the Lab's bounded timer. */
async function withTimeout<T>(read: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${READ_TIMEOUT_MS / 1000}s`)), READ_TIMEOUT_MS);
  });
  try { return await Promise.race([read, timeout]); } finally { if (timer) clearTimeout(timer); }
}

/**
 * @description Read-only readback of the two World schedule records and any operator override.
 * Degraded when the scheduler is not running here or a schedule is not registered; fail when the
 * schedule store cannot be read.
 * @param svc - The running schedule service (null when this process runs no scheduler).
 * @returns The step result; its output lists each schedule's state.
 */
export async function worldScheduleStep(svc: Pick<ScheduleService, 'getScheduleForTaskType' | 'getManifestOverride'> | null): Promise<StepResult> {
  const out = (state: StepResult['state'], detail: string, output?: unknown): StepResult => ({ app: APP, label: SCHEDULES_LABEL, state, detail, ...(output === undefined ? {} : { output }) });
  if (!svc) return out('degraded', 'No scheduler runs in this process, so there are no World schedule records to read.');
  try {
    const rows = await withTimeout(Promise.all(WORLD_LAB_SCHEDULES.map(async (id) => {
      const record = await svc.getScheduleForTaskType(`app:world-${id}`);
      const override = await svc.getManifestOverride(`world-${id}`);
      return { id, registered: Boolean(record), enabled: record ? record.status === 'active' : null, cron: record?.cron ?? null,
        nextRunAt: record?.nextRunAt ?? null, override: override ? { enabled: override.enabled ?? null, cron: override.cron ?? null } : null };
    })), 'the schedule store');
    const missing = rows.filter((r) => !r.registered).map((r) => r.id);
    if (missing.length) return out('degraded', `Not registered: ${missing.join(', ')}. The World app is not active, or its schedules did not register.`, { schedules: rows });
    const said = rows.map((r) => `${r.id} ${r.enabled ? 'on' : 'off'} at "${r.cron}"${r.override ? ' (operator override)' : ''}`).join('; ');
    return out('pass', `Live: ${said}. Read-only; nothing was changed.`, { schedules: rows });
  } catch (err) {
    logger.error({ err }, 'Test Lab World schedule readback failed');
    return out('fail', `The schedule store could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * @description Read-only readback of the World source inventory the operator page shows. Degraded when
 * world intelligence is off; fail when a depth collector is missing from it or the read fails.
 * @param reader - The world service (null when world intelligence is disabled on this deployment).
 * @returns The step result; its output names the counts, what is not pulling and each collector's last run.
 */
export async function worldSourcesStep(reader: Pick<WorldIntelligenceService, 'sourceControl'> | null): Promise<StepResult> {
  const out = (state: StepResult['state'], detail: string, output?: unknown): StepResult => ({ app: APP, label: SOURCES_LABEL, state, detail, ...(output === undefined ? {} : { output }) });
  if (!reader) return out('degraded', 'World intelligence is disabled on this deployment (ENABLE_WORLD_INTELLIGENCE, TSDB_URL, ARANGO_URL), so there are no World sources to read.');
  try {
    const { sources } = await withTimeout(describeWorldSources(reader.sourceControl()), 'the world series store');
    const missing = WORLD_COLLECTOR_IDS.filter((id) => !sources.some((src) => src.id === id));
    if (missing.length) return out('fail', `The inventory lacks depth collectors: ${missing.join(', ')}.`);
    const count = (kind: string) => sources.filter((src) => src.kind === kind).length;
    const notPulling = sources.filter((src) => !src.pulling).map((src) => src.id);
    const runs = sources.filter((src) => src.kind === 'collector').map((src) => ({ id: src.id, outcome: src.lastRun?.outcome ?? null, ranAt: src.lastRun?.ranAt ?? null }));
    const ran = runs.map((r) => `${r.id} ${r.outcome ?? 'no run yet'}`).join(', ');
    return out('pass', `Live: ${count('feed')} feeds, ${count('firehose')} firehose entries, ${count('collector')} collectors; not pulling: ${notPulling.length ? notPulling.join(', ') : 'none'}; collectors: ${ran}. Read-only; no feed call was made.`,
      { feeds: count('feed'), firehose: count('firehose'), collectors: runs, notPulling });
  } catch (err) {
    logger.error({ err }, 'Test Lab World sources readback failed');
    return out('fail', `The World sources could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** @description The congressional disclosure card: attached real-boundary suites plus the live readback. */
export const WORLD_SIGNAL_SCENARIOS: Scenario[] = [{
  id: 'congress-disclosures',
  title: 'Congressional disclosure signal (STOCK Act)',
  group: 'tool',
  description: 'Reads, without writing, the congress_* rows the world feed collector wrote to world_metrics: names with an observed disclosure in the last 90 days, the newest disclosure (ReportDate) day and the newest observed_at. The attached suites prove ReportDate keying, observed_at, idempotent re-runs and the reserved namespace on a disposable TimescaleDB; a pass here is the live proof that the installed collector ran.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/political-trades.spec.ts' },
    { level: 'unit', path: 'tests/unit/world-congress-provenance.spec.ts' },
    { level: 'unit', path: 'tests/unit/world-series-read-gate.spec.ts' },
    { level: 'integration', path: 'tests/unit/world-metrics-observed-at-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/world-depth-collectors-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/world-signal-test-lab.spec.ts' },
  ],
  steps: [{ id: 'live-coverage', app: APP, label: LABEL, run: async () => congressCoverageStep(createWorldIntelligenceService()) }],
}, {
  id: 'world-sources-schedules',
  title: 'World sources and schedules (operator page)',
  group: 'tool',
  description: 'Reads, without changing anything, what the World Sources & schedules page shows: the two World schedule records with on/off, cron and any operator override, and every place World pulls from with its switch, .env gates and each depth collector\'s last run. The attached suites prove the controls across a real Redis and a real TimescaleDB.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/app-schedule-control.spec.ts' },
    { level: 'integration', path: 'tests/unit/world-depth-collectors-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/world-signal-test-lab.spec.ts' },
  ],
  steps: [
    { id: 'live-schedules', app: APP, label: SCHEDULES_LABEL, run: async () => worldScheduleStep(getHomeScheduleService()) },
    { id: 'live-sources', app: APP, label: SOURCES_LABEL, run: async () => worldSourcesStep(createWorldIntelligenceService()) },
  ],
}];

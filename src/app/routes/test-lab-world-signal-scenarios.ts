/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab card for the congressional (STOCK Act) disclosure signal. One read-only step reports what the installed collector has actually written: how many names carry an observed disclosure in the last 90 days, the newest disclosure (ReportDate) day and the newest observed_at. It makes no write and no feed call. The ReportDate keying, observed_at, idempotent re-runs and the reserved congress_* namespace are proven by the attached suites on a disposable TimescaleDB; this step is the live half, and says which half it is.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Attach tests/unit/world-depth-collectors-postgres.spec.ts: the depth fire runs the congress collector before its subject sweep (real dispatch, real collector, real feed fetch, disposable TimescaleDB), because the collector sat behind that sweep and wrote once between 2026-06-26 and 2026-09-28.
 *
 * @module routes/test-lab-world-signal-scenarios
 */

import { createChildLogger } from '@/shared/logger';
import { createWorldIntelligenceService, type WorldIntelligenceService } from '@/features/world-data';
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
    return result('degraded', `No observed congressional disclosure in the last ${CONGRESS_LAB_WINDOW_DAYS} days. The 6-hour depth cycle has not written one with observed_at yet, or the feed returned nothing - check the api log for "political trades collected" or "congress trades fetch failed". Locally tested only; not live-proven.`);
  }
  const newestDisclosure = points.reduce((a, p) => (p.ts > a ? p.ts : a), '').slice(0, 10);
  const lastObservedAt = points.reduce((a, p) => (p.observedAt && p.observedAt > a ? p.observedAt : a), '');
  const count = names.length >= CONGRESS_LAB_MAX_NAMES ? `at least ${names.length}` : String(names.length);
  return result('pass', `Live: ${count} name(s) carry an observed quiver-congress disclosure; newest disclosure day ${newestDisclosure}, last observed ${lastObservedAt}. Read-only; no feed call was made.`, {
    names: names.length, newestDisclosure, lastObservedAt, sample: names.slice(0, 5),
  });
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
}];

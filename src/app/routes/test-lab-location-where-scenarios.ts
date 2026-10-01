/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab card for Jarvis "where am I" (ADR-169 D3, the model-safe current-place read). One step on the running build's database: two uniquely tagged synthetic people; the one with no position is pointed to Settings, Location; a fix taken through the real browser ingest inside a saved place is answered with that place; an old fix leads with its age; the other person still sees no position; no answer carries a coordinate. Everything is erased with a zero-row check.
 */

import { randomUUID } from 'node:crypto';
import { eraseLocationData, withLocationOwnerSession, type LocationPrincipal } from '@/features/location';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import type { GeoPoint } from '@/shared/utils/geo';
import { optInBrowserDevice } from '../location-consent';
import { runJarvisLocationTurn } from '../location-jarvis-intent';
import { createLocationPlace, parsePlaceInput } from '../location-places';
import { ingestBrowserFix, parseBrowserFix } from '../location-presence';
import type { Scenario, ScenarioRunContext, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-location-where' });
const APP = 'location';
const LABEL = 'Jarvis answers "where am I" from the person\'s own position, by saved place only (ADR-169 D3)';
const PROBE_ISSUER = 'urn:oshal:test-lab';
const HOME: GeoPoint = { lat: -21.4712, lon: -27.3051 };
/** Any decimal with two or more places: a coordinate, however it was rounded. */
const COORDINATE = /\d+\.\d{2,}/;

type Check = [string, boolean];
type Pool = ScenarioRunContext['ctx']['pool'];

/** Ask "where am I" as this person at a given clock. */
const ask = (pool: Pool, who: LocationPrincipal, nowMs: number): Promise<string> =>
  runJarvisLocationTurn(pool, { kind: 'where', principal: who }, nowMs);

/**
 * @description The five checks: no position, at a saved place, an old fix, the other person, no coordinate.
 * @param pool - The running server's pool.
 * @param owner - The person who reports a position.
 * @param other - The person who never does.
 * @returns The named checks.
 */
async function whereChecks(pool: Pool, owner: LocationPrincipal, other: LocationPrincipal): Promise<Check[]> {
  const before = await ask(pool, owner, Date.now());
  const device = await optInBrowserDevice(pool, owner, { deviceId: null, precisionClass: 'block' });
  await createLocationPlace(pool, owner, parsePlaceInput({ name: 'Lab Home', label: 'home', center: HOME, radiusM: 150 }, 'create'));
  const fixedAt = Date.now();
  await ingestBrowserFix(pool, owner, parseBrowserFix({ deviceId: device.deviceId, lat: HOME.lat, lon: HOME.lon, accuracyM: 10,
    observedAt: new Date(fixedAt).toISOString() }, fixedAt), { minIntervalMs: 0, nowMs: fixedAt });
  const atHome = await ask(pool, owner, fixedAt + 20_000);
  const later = await ask(pool, owner, fixedAt + 3 * 3600_000 + 60_000);
  const otherAnswer = await ask(pool, other, fixedAt + 20_000);
  return [
    ['a person with no position is pointed to Settings, Location', before.includes('I don\'t have a position for you yet') && before.includes('/cockpit/tools/location.html')],
    ['a fresh fix inside a saved place is answered with that place', atHome === 'You\'re at Lab Home (updated just now).'],
    ['an old fix leads with its age', later.startsWith('As of 3 hours ago, you were at Lab Home.')],
    ['the other person sees no position', otherAnswer.includes('I don\'t have a position for you yet') && !otherAnswer.includes('Lab Home')],
    ['no answer carries a coordinate', ![before, atHome, later, otherAnswer].some((answer) => COORDINATE.test(answer))],
  ];
}

/**
 * @description Erase both synthetic people's location rows and count what is left, each under their own owner session.
 * @param pool - The running server's pool.
 * @param people - The synthetic people.
 * @returns The rows that remain (0 when clean).
 */
async function cleanup(pool: Pool, people: LocationPrincipal[]): Promise<number> {
  let left = 0;
  for (const who of people) {
    await eraseLocationData(pool, who);
    left += await withLocationOwnerSession(pool, who, async (client) => Number((await client.query(`SELECT
        (SELECT count(*) FROM location_observations WHERE owner_sub = $1) + (SELECT count(*) FROM location_current WHERE owner_sub = $1)
      + (SELECT count(*) FROM location_devices WHERE owner_sub = $1) + (SELECT count(*) FROM location_places WHERE owner_sub = $1) AS n`,
    [who.sub])).rows[0].n));
  }
  return left;
}

/**
 * @description Jarvis "where am I" for two synthetic people on the real database, with a full erase and a zero-row check.
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function whereAmIStep(runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = (state: StepResult['state'], detail: string, output?: unknown): StepResult =>
    ({ app: APP, label: LABEL, state, detail, ...(output === undefined ? {} : { output }) });
  if (!runtime?.ctx?.pool) return result('gap', 'Needs the running server\'s database pool; run it from the Test Lab.');
  const pool = runtime.ctx.pool;
  const tag = randomUUID();
  const owner: LocationPrincipal = { sub: `test-lab-location-where-owner-${tag}`, principalIssuer: PROBE_ISSUER };
  const other: LocationPrincipal = { sub: `test-lab-location-where-other-${tag}`, principalIssuer: PROBE_ISSUER };
  let checks: Check[] = [];
  let failure = '';
  try {
    checks = await whereChecks(pool, owner, other);
  } catch (error) {
    logger.error({ op: 'lab-where', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab where-am-I step could not run');
    failure = `The step could not run: ${(error as { code?: string }).code ?? (error as Error).name}.`;
  }
  let left = -1;
  try {
    left = await cleanup(pool, [owner, other]);
  } catch (error) {
    logger.error({ op: 'lab-where-cleanup', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab where-am-I cleanup failed');
  }
  if (left !== 0) return result('fail', `${failure} Cleanup incomplete: ${left < 0 ? 'the cleanup failed' : `${left} synthetic rows remain`}.`.trim());
  if (failure) return result('fail', `${failure} Synthetic rows were deleted.`);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Failed: ${failed.join('; ')}. Synthetic rows were deleted.`, { failed });
  return result('pass', `${checks.length} checks hold: ${checks.map(([name]) => name).join('; ')}. Every synthetic location row was deleted.`);
}

/** The Jarvis "where am I" Test Lab card. */
export const LOCATION_WHERE_SCENARIOS: Scenario[] = [{
  id: 'location-where-am-i',
  title: 'Location — Jarvis "where am I" (ADR-169 D3)',
  group: 'tool',
  description: 'Checks Jarvis "where am I" on the running build\'s database with two synthetic people: no position points to Settings, Location; a fix inside a saved place names that place; an old fix leads with its age; the other person sees no position; no answer carries a coordinate. All rows are erased.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/location-jarvis-intent.spec.ts' },
    { level: 'integration', path: 'tests/unit/location-where-am-i-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-reporter.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-location-where-registration.spec.ts' },
  ],
  steps: [
    { id: 'where-am-i', app: APP, label: LABEL, run: async (_cookie, _prior, runtime) => whereAmIStep(runtime) },
  ],
}];

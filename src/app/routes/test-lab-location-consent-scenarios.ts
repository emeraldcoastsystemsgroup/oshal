/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for ADR-169 slice L3 (browser ingest, consent and the step-up). Three steps on the running build. The service-rail step calls POST /api/location/presence over the loopback with the service secret (the configured one when set, never printed) and expects 401. The gate step, as the Lab's signed-in person, tries every exposure-raising call with no proof and with a challenge it opened but could not prove (opt-in, accepting a share), confirms arming has no route to reach, checks the person's device and share counts did not move, and withdraws its challenge. The lifecycle step runs the same consent and ingest services the routes call, for a uniquely tagged synthetic person on the real database: opt a browser in, post a fix whose body names another owner, see the fix stored for the synthetic person at block precision and placed in their synthetic place, opt out (current row cleared, history kept, ingest refused), purge, then erase and prove no row of the synthetic person remains; incomplete cleanup is a failure. No real person's location is read or written.
 */

import { randomUUID } from 'node:crypto';
import { eraseLocationData, purgeOwnLocationHistory, withLocationOwnerSession, type LocationPrincipal } from '@/features/location';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import { optInBrowserDevice, optOutDevice } from '../location-consent';
import { readLocationOverview } from '../location-overview';
import { ingestBrowserFix, parseBrowserFix } from '../location-presence';
import { LocationRequestError } from '../location-request';
import type { Scenario, ScenarioRunContext, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-location-consent' });
const APP = 'location';
const RAIL_LABEL = 'The service secret is refused on /api/location (ADR-169 L3)';
const GATE_LABEL = 'Nothing raises exposure without a fresh sign-in (ADR-169 L3)';
const LIFECYCLE_LABEL = 'Opt in, ingest, opt out, purge for a synthetic person (ADR-169 L3)';
const PROBE_ISSUER = 'urn:oshal:test-lab';
const SYNTHETIC_PLACE = { lat: -12.35, lon: -31.99, radiusM: 100 };

type Result = (state: StepResult['state'], detail: string, output?: unknown) => StepResult;
const resultFor = (label: string): Result => (state, detail, output) =>
  ({ app: APP, label, state, detail, ...(output === undefined ? {} : { output }) });

/** A loopback call to the location routes. Only the headers named here are sent. */
async function call(base: string, headers: Record<string, string>, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${base}/api/location${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> };
}

/**
 * @description POST /api/location/presence with the service rail must answer 401.
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function serviceRailStep(runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(RAIL_LABEL);
  if (!runtime?.apiBaseUrl) return result('gap', 'Needs the running server; run it from the Test Lab.');
  const configured = (process.env.SWARM_SERVICE_SECRET ?? '').trim();
  const headers = { 'x-service-secret': configured || 'test-lab-unconfigured-secret', 'x-oshal-user-sub': `test-lab-location-${randomUUID().slice(0, 8)}` };
  const res = await call(runtime.apiBaseUrl, headers, 'POST', '/presence', { deviceId: randomUUID(), lat: SYNTHETIC_PLACE.lat, lon: SYNTHETIC_PLACE.lon });
  if (res.status !== 401) return result('fail', `The service rail was answered HTTP ${res.status}, not 401.`, { status: res.status });
  return result('pass', `HTTP 401 ${String(res.json.error ?? '')} with ${configured ? 'the configured' : 'a placeholder (no secret is configured here)'} service secret; nothing was written.`);
}

/** The exposure-raising calls the gate step makes, and what each must answer. */
async function gateChecks(base: string, cookie: string): Promise<Array<[string, boolean]>> {
  const h = { cookie };
  const optIn = { deviceId: null, precisionClass: 'place-only' };
  const share = { tenantId: randomUUID(), placeIds: [randomUUID()] };
  const opened = await call(base, h, 'POST', '/step-up', { operation: 'opt-in', params: optIn });
  const handle = typeof opened.json.challengeId === 'string' ? opened.json.challengeId : '';
  const checks: Array<[string, boolean]> = [];
  try {
    checks.push(['a challenge opens pending', opened.status === 201 && opened.json.state === 'pending']);
    checks.push(['opt-in without a proof is refused', (await call(base, h, 'POST', '/devices/browser/opt-in', optIn)).json.error === 'step_up_required']);
    checks.push(['opt-in with an unproven challenge is refused',
      (await call(base, { ...h, 'x-oshal-location-step-up': handle }, 'POST', '/devices/browser/opt-in', optIn)).json.error === 'step_up_required']);
    checks.push(['accepting a share without a proof is refused', (await call(base, h, 'POST', '/shares', share)).json.error === 'step_up_required']);
    checks.push(['arming a rule has no route to reach', (await call(base, h, 'POST', '/step-up', { operation: 'arm-rule', params: {} })).status === 400]);
  } finally {
    if (handle) await call(base, h, 'DELETE', `/step-up/${encodeURIComponent(handle)}`).catch(() => undefined);
  }
  return checks;
}

/**
 * @description As the signed-in person, every exposure-raising call without a fresh proof is refused
 * and the person's devices and shares do not change.
 * @param cookie - The Lab's session cookie.
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function stepUpGateStep(cookie: string, runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(GATE_LABEL);
  if (!cookie || !runtime?.apiBaseUrl) return result('gap', 'Needs a signed-in Test Lab session on the running server.');
  const before = await call(runtime.apiBaseUrl, { cookie }, 'GET', '/state');
  if (before.status !== 200) return result('gap', `This session cannot read /api/location/state (HTTP ${before.status} ${String(before.json.error ?? '')}); it must be a browser sign-in with a verified issuer.`);
  const checks = await gateChecks(runtime.apiBaseUrl, cookie);
  const after = await call(runtime.apiBaseUrl, { cookie }, 'GET', '/state');
  const count = (s: Record<string, any>) => `${s.devices?.length}/${s.visibility?.memberShares?.length}`;
  checks.push(['the person\'s devices and shares did not change', after.status === 200 && count(after.json) === count(before.json)]);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Gate failed: ${failed.join('; ')}.`, { failed });
  return result('pass', `${checks.length} checks hold: ${checks.map(([name]) => name).join('; ')}. The Lab's challenge was withdrawn.`);
}

/** Rows of the synthetic person left in each person table, read as that person. */
async function remainingRows(runtime: ScenarioRunContext, who: LocationPrincipal): Promise<number> {
  return withLocationOwnerSession(runtime.ctx.pool, who, async (client) => {
    const r = await client.query(`SELECT (SELECT count(*) FROM location_observations WHERE owner_sub = $1)
      + (SELECT count(*) FROM location_current WHERE owner_sub = $1) + (SELECT count(*) FROM location_devices WHERE owner_sub = $1)
      + (SELECT count(*) FROM location_places WHERE owner_sub = $1) + (SELECT count(*) FROM location_settings WHERE owner_sub = $1) AS n`, [who.sub]);
    return Number(r.rows[0].n);
  });
}

/** The lifecycle on the real database for one synthetic person; each check is named. */
async function lifecycleChecks(runtime: ScenarioRunContext, who: LocationPrincipal): Promise<Array<[string, boolean]>> {
  const pool = runtime.ctx.pool;
  const placeId = await withLocationOwnerSession(pool, who, async (client) => String((await client.query(`INSERT INTO location_places
    (owner_sub, principal_issuer, name, label, center_lat, center_lon, radius_m, created_by_sub)
    VALUES ($1, $2, 'Test Lab place', 'other', $3, $4, $5, $1) RETURNING place_id`,
  [who.sub, who.principalIssuer, SYNTHETIC_PLACE.lat, SYNTHETIC_PLACE.lon, SYNTHETIC_PLACE.radiusM])).rows[0].place_id));
  const device = await optInBrowserDevice(pool, who, { deviceId: null, precisionClass: 'block' });
  const fix = parseBrowserFix({ deviceId: device.deviceId, lat: SYNTHETIC_PLACE.lat + 0.00012, lon: SYNTHETIC_PLACE.lon, accuracyM: 10, ownerSub: 'someone-else', sub: 'someone-else' });
  const accepted = await ingestBrowserFix(pool, who, fix, { minIntervalMs: 0 });
  const stored = await withLocationOwnerSession(pool, who, async (client) => (await client.query(
    'SELECT owner_sub, precision_class, lat FROM location_observations WHERE owner_sub = $1', [who.sub])).rows);
  const checks: Array<[string, boolean]> = [
    ['the fix is placed in the person\'s place', accepted.place?.placeId === placeId],
    ['it is stored for the session person at block precision, whatever the body named',
      stored.length === 1 && stored[0].owner_sub === who.sub && stored[0].precision_class === 'block' && Number(stored[0].lat) === -12.35],
    ['the overview shows the place', (await readLocationOverview(pool, who)).current?.place?.name === 'Test Lab place'],
  ];
  const out = await optOutDevice(pool, who, device.deviceId);
  const overview = await readLocationOverview(pool, who);
  checks.push(['opting out clears the current place and keeps the history', out.currentCleared === 1 && overview.current === null && overview.history.observationCount === 1]);
  const refused = await ingestBrowserFix(pool, who, fix, { minIntervalMs: 0 }).then(() => false, (e) => e instanceof LocationRequestError && e.code === 'reporting_off');
  checks.push(['ingest stops after opting out', refused]);
  checks.push(['the purge removes the history', (await purgeOwnLocationHistory(pool, who)).observationCount === 1]);
  return checks;
}

/**
 * @description The consent and ingest lifecycle for a synthetic person on the real database, with erasure and a zero-row check.
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function consentLifecycleStep(runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(LIFECYCLE_LABEL);
  if (!runtime?.ctx?.pool) return result('gap', 'Needs the running server\'s database pool; run it from the Test Lab.');
  const who: LocationPrincipal = { sub: `test-lab-location-${randomUUID()}`, principalIssuer: PROBE_ISSUER };
  let checks: Array<[string, boolean]> = [];
  let failure = '';
  try {
    checks = await lifecycleChecks(runtime, who);
  } catch (error) {
    logger.error({ op: 'lab-lifecycle', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab location lifecycle could not run');
    failure = `The lifecycle could not run: ${(error as { code?: string }).code ?? (error as Error).name}.`;
  }
  let left = -1;
  try {
    await eraseLocationData(runtime.ctx.pool, who);
    left = await remainingRows(runtime, who);
  } catch (error) {
    logger.error({ op: 'lab-cleanup', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab location cleanup failed');
  }
  if (left !== 0) return result('fail', `${failure} Cleanup incomplete: ${left < 0 ? 'the erase failed' : `${left} synthetic rows remain`}.`.trim());
  if (failure) return result('fail', `${failure} Synthetic rows were erased.`);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Lifecycle failed: ${failed.join('; ')}. Synthetic rows were erased.`, { failed });
  return result('pass', `${checks.length} checks hold: ${checks.map(([name]) => name).join('; ')}. The synthetic person was erased and no row of theirs remains. These are the services the /api/location routes call; the route-level gate is the step above.`);
}

/** The ADR-169 L3 Test Lab card. */
export const LOCATION_CONSENT_SCENARIOS: Scenario[] = [{
  id: 'location-browser-consent',
  title: 'Location — browser ingest, consent and the step-up (ADR-169 L3)',
  group: 'tool',
  description: 'Checks ADR-169 slice L3 on the running build. The service secret is refused on /api/location with 401. As the signed-in person, opting in and accepting a share are refused without a fresh sign-in, a challenge the page opened but did not prove does not help, arming has no route, and the person\'s devices and shares do not change (the Lab withdraws its challenge). Then a uniquely tagged synthetic person goes through the consent and ingest services on the real database: opt in, a fix whose body names another owner is stored for the synthetic person at block precision in their place, opting out clears the current place and keeps the history, ingest stops, the purge removes the history, and an erase leaves no row of theirs. No real person\'s location is read or written.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/location-step-up.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-route-policy.spec.ts' },
    { level: 'integration', path: 'tests/unit/location-browser-consent-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/location-step-up-totp-postgres.spec.ts' },
    { level: 'browser', path: 'tests/unit/location-settings-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/location-oidc-step-up-browser.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-location-consent-registration.spec.ts' },
  ],
  steps: [
    { id: 'service-rail-refused', app: APP, label: RAIL_LABEL, run: async (_cookie, _prior, runtime) => serviceRailStep(runtime) },
    { id: 'step-up-gate', app: APP, label: GATE_LABEL, run: async (cookie, _prior, runtime) => stepUpGateStep(cookie, runtime) },
    { id: 'consent-lifecycle', app: APP, label: LIFECYCLE_LABEL, run: async (_cookie, _prior, runtime) => consentLifecycleStep(runtime) },
  ],
}];

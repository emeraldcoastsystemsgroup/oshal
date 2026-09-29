/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for ADR-169 slice L6 (group ownership, the location credential and the device ingest). Two steps on the running build. The route step, as the Lab's signed-in person over the loopback: the device ingest refuses a browser session (401 device_credential_required), issuing a credential is refused without a fresh sign-in (403 step_up_required), the devices list names the kinds that report under a credential, and nothing of the person's changes. The lifecycle step, for three uniquely tagged synthetic people on the real database: an admin makes a group with a member and a group place, enrols a drone to the group and issues its credential in process (the same service the route calls); the credential then drives the REAL ingest over the loopback as a drone node would, with the bearer alone, and the fix is stored as the device subject and placed in the group place; the same credential is refused on another device's path; the Lab's signed-in person cannot mint a node token for the drone's id through the real /api/join/enroll; the member reads the drone by reference (currentPlace, distanceBand, locatedDevice) and the stranger gets nothing. Everything created is deleted (the credential row, the device record with its observation and current rows, the place, the group with its memberships) and a zero-row check runs; incomplete cleanup is a failure. No real person's location is read or written and no position is ever logged.
 */

import { randomUUID } from 'node:crypto';
import { currentPlace, distanceBand, locatedDevice, withLocationOwnerSession, type LocationPrincipal } from '@/features/location';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { issueLocationDeviceCredential } from '../location-device-ingest';
import { enrolPlacedDevice, parseEnrolInput, unenrolPlacedDevice } from '../location-devices';
import { createLocationPlace, deleteLocationPlace, parsePlaceInput } from '../location-places';
import { addMember, createTenant } from './connector-tenancy';
import type { Scenario, ScenarioRunContext, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-location-device' });
const APP = 'location';
const ROUTES_LABEL = 'The device ingest and the credential route refuse what is not a device (ADR-169 L6)';
const LIFECYCLE_LABEL = 'A group drone reports under its credential for synthetic people (ADR-169 L6)';
const PROBE_ISSUER = 'urn:oshal:test-lab';
const FIELD = { lat: -12.37, lon: -31.95 };
const COORDINATE_KEYS = /"(lat|lon|latitude|longitude|center|center_lat|center_lon|address)"/;

type Check = [string, boolean];
type Result = (state: StepResult['state'], detail: string, output?: unknown) => StepResult;
type Reply = { status: number; json: Record<string, any> };
const resultFor = (label: string): Result => (state, detail, output) =>
  ({ app: APP, label, state, detail, ...(output === undefined ? {} : { output }) });

/** A loopback call to a core route: as the Lab's signed-in person (cookie), or as a device (bearer alone). */
async function call(base: string, auth: { cookie?: string; bearer?: string }, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: {
      'content-type': 'application/json',
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> };
}

/**
 * @description As the signed-in person: the ingest refuses a browser session, the credential route needs a proof, and nothing changes.
 * @param cookie - The Lab's session cookie.
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function deviceRoutesStep(cookie: string, runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(ROUTES_LABEL);
  if (!cookie || !runtime?.apiBaseUrl) return result('gap', 'Needs a signed-in Test Lab session on the running server.');
  const base = runtime.apiBaseUrl;
  const devices = await call(base, { cookie }, 'GET', '/api/location/devices');
  if (devices.status !== 200) {
    return result('gap', `This session cannot read /api/location/devices (HTTP ${devices.status}); it must be a browser sign-in with a verified issuer.`);
  }
  const id = randomUUID();
  const ingest = await call(base, { cookie }, 'POST', `/api/location/devices/${id}/presence`, { lat: FIELD.lat, lon: FIELD.lon });
  const credential = await call(base, { cookie }, 'POST', `/api/location/devices/${id}/credential`, { precisionClass: 'exact' });
  const after = await call(base, { cookie }, 'GET', '/api/location/devices');
  const checks: Check[] = [
    ['the device ingest refuses a browser session', ingest.status === 401 && ingest.json.error === 'device_credential_required'],
    ['issuing a credential needs a fresh sign-in', credential.status === 403 && credential.json.error === 'step_up_required'],
    ['the devices list names the kinds that report under a credential', Array.isArray(devices.json.credentialKinds) && devices.json.credentialKinds.includes('drone')],
    ['the list carries no coordinate', !COORDINATE_KEYS.test(JSON.stringify(devices.json))],
    ['the person\'s devices did not change', after.json.devices?.length === devices.json.devices?.length],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Route checks failed: ${failed.join('; ')}.`, { failed });
  return result('pass', `${checks.length} checks hold: ${checks.map(([name]) => name).join('; ')}.`);
}

/** The synthetic people and what the lifecycle created, for the cleanup. */
interface LabWorld {
  admin: LocationPrincipal;
  member: LocationPrincipal;
  stranger: LocationPrincipal;
  tag: string;
  groupId: string;
  placeId: string;
  deviceId: string;
}

/** Run `fn` with the ambient identity of one synthetic person, never an operator. */
const as = <T>(who: LocationPrincipal, fn: () => Promise<T>): Promise<T> =>
  runWithRequestIdentity({ sub: who.sub, principalIssuer: who.principalIssuer, isOperator: false }, fn);

/** Group, place, the drone and its credential, recorded on the world as they are made. */
async function buildWorld(pool: ScenarioRunContext['ctx']['pool'], w: LabWorld): Promise<{ token: string }> {
  w.groupId = (await as(w.admin, () => createTenant(pool, { name: `Test Lab L6 ${w.tag}`, createdBySub: w.admin.sub }))).tenant_id;
  await as(w.admin, () => addMember(pool, w.groupId, w.member.sub, w.admin.sub));
  const field = await createLocationPlace(pool, w.admin, parsePlaceInput({ name: 'Test Lab field', center: FIELD, groupId: w.groupId }, 'create'));
  w.placeId = field.placeId;
  const drone = await enrolPlacedDevice(pool, w.admin, parseEnrolInput({ kind: 'drone', ref: `lab-${w.tag.slice(-12)}`, groupId: w.groupId }, w.admin));
  w.deviceId = drone.deviceId;
  const issued = await issueLocationDeviceCredential(pool, w.admin, { deviceId: w.deviceId, precisionClass: 'exact' });
  return { token: issued.credential.token };
}

/** The real ingest over the loopback, the refusals, and the reads over the world the step built. */
async function lifecycleChecks(pool: ScenarioRunContext['ctx']['pool'], base: string, cookie: string, w: LabWorld, token: string): Promise<Check[]> {
  const fix = { lat: FIELD.lat + 0.0001, lon: FIELD.lon - 0.0001, altM: 25, observedAt: new Date().toISOString(), mock: true };
  const accepted = await call(base, { bearer: token }, 'POST', `/api/location/devices/${w.deviceId}/presence`, fix);
  const foreign = await call(base, { bearer: token }, 'POST', `/api/location/devices/${randomUUID()}/presence`, fix);
  const enrol = cookie ? await call(base, { cookie }, 'POST', '/api/join/enroll', { clientId: w.deviceId }) : null;
  const seen = await as(w.member, () => currentPlace(pool, { deviceId: w.deviceId }));
  const stranger = await as(w.stranger, () => currentPlace(pool, { deviceId: w.deviceId }).then(() => 'found', (e: Error) => e.name));
  return [
    ['the drone\'s fix is accepted under its credential and placed in the group place',
      accepted.status === 201 && accepted.json.place?.placeId === w.placeId && accepted.json.precisionClass === 'exact'],
    ['the reply carries no coordinate', !COORDINATE_KEYS.test(JSON.stringify(accepted.json))],
    ['the credential is refused on another device\'s path', foreign.status === 401 && foreign.json.error === 'device_credential_required'],
    ['the signed-in person cannot mint a node token for the drone\'s id',
      enrol === null || (enrol.status === 409 && enrol.json.error === 'location_device_id')],
    ['the member reads the drone at the group place by reference', seen.basis === 'observed' && seen.place?.placeId === w.placeId],
    ['the drone is "at" the group place for the member', await as(w.member, () => distanceBand(pool, { deviceId: w.deviceId }, w.placeId)) === 'at'],
    ['locatedDevice finds the drone for the member and not for the stranger',
      (await as(w.member, () => locatedDevice(pool, 'drone', `lab-${w.tag.slice(-12)}`)))?.groupId === w.groupId
        && (await as(w.stranger, () => locatedDevice(pool, 'drone', `lab-${w.tag.slice(-12)}`))) === null],
    ['a stranger gets nothing from the location reads', stranger === 'LocationNotFoundError'],
  ];
}

/** Delete what the step created, then count what is left. */
async function cleanup(pool: ScenarioRunContext['ctx']['pool'], w: LabWorld): Promise<number> {
  if (w.deviceId) await unenrolPlacedDevice(pool, w.admin, w.deviceId);
  if (w.placeId) await deleteLocationPlace(pool, w.admin, w.placeId);
  return withLocationOwnerSession(pool, w.admin, async (client, who) => {
    if (w.deviceId) await client.query('DELETE FROM oshal_cli_tokens WHERE location_device_id = $1 AND user_sub = $2', [w.deviceId, who.sub]);
    if (w.groupId) await client.query('DELETE FROM oshal_tenants WHERE tenant_id = $1', [w.groupId]);
    const r = await client.query(`SELECT (SELECT count(*) FROM location_devices WHERE tenant_id::text = $1 OR device_id::text = $2)
      + (SELECT count(*) FROM location_observations WHERE tenant_id::text = $1 OR device_id::text = $2)
      + (SELECT count(*) FROM location_current WHERE tenant_id::text = $1 OR device_id::text = $2)
      + (SELECT count(*) FROM location_places WHERE tenant_id::text = $1)
      + (SELECT count(*) FROM oshal_tenants WHERE tenant_id::text = $1)
      + (SELECT count(*) FROM oshal_cli_tokens WHERE location_device_id = $2) AS n`, [w.groupId || '', w.deviceId || '']);
    return Number(r.rows[0].n);
  });
}

/**
 * @description A group drone's credential and ingest for three synthetic people on the real database, with a full cleanup and a zero-row check.
 * @param cookie - The Lab's session cookie (for the /api/join/enroll refusal; skipped without one).
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function deviceLifecycleStep(cookie: string, runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(LIFECYCLE_LABEL);
  if (!runtime?.ctx?.pool || !runtime.apiBaseUrl) return result('gap', 'Needs the running server\'s database pool and address; run it from the Test Lab.');
  const tag = randomUUID();
  const person = (role: string): LocationPrincipal => ({ sub: `test-lab-location-l6-${role}-${tag}`, principalIssuer: PROBE_ISSUER });
  const w: LabWorld = { admin: person('admin'), member: person('member'), stranger: person('stranger'), tag, groupId: '', placeId: '', deviceId: '' };
  let checks: Check[] = [];
  let failure = '';
  try {
    const { token } = await buildWorld(runtime.ctx.pool, w);
    checks = await lifecycleChecks(runtime.ctx.pool, runtime.apiBaseUrl, cookie, w, token);
  } catch (error) {
    logger.error({ op: 'lab-lifecycle', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab location device lifecycle could not run');
    failure = `The lifecycle could not run: ${(error as { code?: string }).code ?? (error as Error).name}.`;
  }
  let left = -1;
  try {
    left = await cleanup(runtime.ctx.pool, w);
  } catch (error) {
    logger.error({ op: 'lab-cleanup', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab location device cleanup failed');
  }
  if (left !== 0) return result('fail', `${failure} Cleanup incomplete: ${left < 0 ? 'the cleanup failed' : `${left} synthetic rows remain`}.`.trim());
  if (failure) return result('fail', `${failure} Synthetic rows were deleted.`);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Lifecycle failed: ${failed.join('; ')}. Synthetic rows were deleted.`, { failed });
  return result('pass', `${checks.length} checks hold: ${checks.map(([name]) => name).join('; ')}. The credential, the device with its fixes, the place and the group were deleted and no row of theirs remains.`);
}

/** The ADR-169 L6 Test Lab card. */
export const LOCATION_DEVICE_SCENARIOS: Scenario[] = [{
  id: 'location-device-ingest',
  title: 'Location — a group drone reports under its own credential (ADR-169 L6)',
  group: 'tool',
  description: 'Checks ADR-169 slice L6 on the running build. As the signed-in person, the device ingest refuses a browser session, issuing a credential needs a fresh sign-in, and the devices list names the kinds that report under a credential. Then three uniquely tagged synthetic people on the real database: an admin makes a group with a member and a group place, enrols a drone to the group and issues its credential; the credential drives the real ingest over the loopback as a drone node would and the fix lands in the group place as the device subject; the same credential is refused on another device\'s path; the signed-in person cannot mint a node token for the drone\'s id; the member reads the drone by reference through currentPlace, distanceBand and locatedDevice and the stranger gets nothing. Everything created is deleted and a zero-row check runs. No real person\'s location is read or written.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/location-device-ingest-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-token-scope.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-route-policy.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-rls-no-operator-guard.spec.ts' },
    { level: 'unit', path: 'tests/unit/machine-write-identity.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-location-device-registration.spec.ts' },
  ],
  steps: [
    { id: 'device-routes', app: APP, label: ROUTES_LABEL, run: async (cookie, _prior, runtime) => deviceRoutesStep(cookie, runtime) },
    { id: 'device-lifecycle', app: APP, label: LIFECYCLE_LABEL, run: async (cookie, _prior, runtime) => deviceLifecycleStep(cookie, runtime) },
  ],
}];

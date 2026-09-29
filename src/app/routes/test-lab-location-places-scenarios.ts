/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for ADR-169 slice L4 (places and device enrolment). Two steps on the running build. The route step, as the Lab's signed-in person over the loopback: the places and devices lists answer without a coordinate or an address, and three refusals hold without writing anything (a camera with no group, a node the person does not own, a place for a group they do not administer); the person's place and device counts do not move. The lifecycle step runs the same place, enrolment and kernel-read services the routes and packages call, for three uniquely tagged synthetic people on the real database: an admin makes a group with a member, a place of their own and a group place, records a synthetic node binding of their own, enrols that node, a camera (to the group) and a TV with places and changes the TV's place; the member cannot change the camera (403) or find the node (404), the stranger cannot find the camera, and the member's currentPlace, distanceBand and placeAt read the camera's place by reference. Everything the step created is then deleted (devices, places, the group with its memberships, the binding) and a zero-row check runs; incomplete cleanup is a failure. No real person's location is read or written.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | regressionTests lists tests/unit/location-fleet-id-shape.spec.ts, which holds the restated camera and drone fleet id shape equal to CAMERA_ID_RE and DRONE_ID_RE.
 */

import { randomUUID } from 'node:crypto';
import { currentPlace, distanceBand, placeAt, withLocationOwnerSession, type LocationPrincipal } from '@/features/location';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { enrolPlacedDevice, parseEnrolInput, setPlacedDevicePlace, unenrolPlacedDevice } from '../location-devices';
import { createLocationPlace, deleteLocationPlace, parsePlaceInput } from '../location-places';
import { LocationRequestError } from '../location-request';
import { addMember, createTenant } from './connector-tenancy';
import type { Scenario, ScenarioRunContext, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-location-places' });
const APP = 'location';
const ROUTES_LABEL = 'Places and device enrolment refuse what is not yours (ADR-169 L4)';
const LIFECYCLE_LABEL = 'A node, a camera and a TV at places for synthetic people (ADR-169 L4)';
const PROBE_ISSUER = 'urn:oshal:test-lab';
const HOME = { lat: -12.35, lon: -31.99 };
const SCHOOL = { lat: -12.36, lon: -31.97 };
const COORDINATE_KEYS = /"(lat|lon|latitude|longitude|center|center_lat|center_lon|address)"/;

type Check = [string, boolean];
type Result = (state: StepResult['state'], detail: string, output?: unknown) => StepResult;
const resultFor = (label: string): Result => (state, detail, output) =>
  ({ app: APP, label, state, detail, ...(output === undefined ? {} : { output }) });

/** A loopback call to the location routes as the Lab's signed-in person. */
async function call(base: string, cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${base}/api/location${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> };
}

/** The refusals the route step makes; none of them may write. */
async function routeChecks(base: string, cookie: string): Promise<Check[]> {
  const camera = await call(base, cookie, 'POST', '/devices', { kind: 'camera', ref: `lab-cam-${randomUUID().slice(0, 8)}` });
  const node = await call(base, cookie, 'POST', '/devices', { kind: 'node', ref: `test-lab-no-such-node-${randomUUID()}` });
  const place = await call(base, cookie, 'POST', '/places', { name: 'Test Lab place', center: HOME, groupId: randomUUID() });
  return [
    ['a camera with no group is refused', camera.status === 400 && camera.json.error === 'group_required'],
    ['a node the person does not own is refused', node.status === 404 && node.json.error === 'node_not_found'],
    ['a place for a group the person does not administer is refused', place.status === 403 && place.json.error === 'group_admin_required'],
  ];
}

/**
 * @description As the signed-in person: the lists carry no coordinate or address, and the three refusals hold without a write.
 * @param cookie - The Lab's session cookie.
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function placeRoutesStep(cookie: string, runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(ROUTES_LABEL);
  if (!cookie || !runtime?.apiBaseUrl) return result('gap', 'Needs a signed-in Test Lab session on the running server.');
  const base = runtime.apiBaseUrl;
  const places = await call(base, cookie, 'GET', '/places');
  const devices = await call(base, cookie, 'GET', '/devices');
  if (places.status !== 200 || devices.status !== 200) {
    return result('gap', `This session cannot read /api/location/places and /devices (HTTP ${places.status}/${devices.status}); it must be a browser sign-in with a verified issuer.`);
  }
  const checks: Check[] = [['the lists carry no coordinate and no address', !COORDINATE_KEYS.test(JSON.stringify(places.json) + JSON.stringify(devices.json))]];
  checks.push(...await routeChecks(base, cookie));
  const after = [await call(base, cookie, 'GET', '/places'), await call(base, cookie, 'GET', '/devices')];
  checks.push(['the person\'s places and devices did not change',
    after[0].json.places?.length === places.json.places?.length && after[1].json.devices?.length === devices.json.devices?.length]);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Route checks failed: ${failed.join('; ')}.`, { failed });
  return result('pass', `${checks.length} checks hold: ${checks.map(([name]) => name).join('; ')}.`);
}

/** The synthetic people and what the lifecycle created, for the cleanup. */
interface LabWorld {
  admin: LocationPrincipal;
  member: LocationPrincipal;
  stranger: LocationPrincipal;
  clientId: string;
  groupId: string;
  places: string[];
  devices: string[];
}

/** Run `fn` with the ambient identity of one synthetic person, never an operator. */
const as = <T>(who: LocationPrincipal, fn: () => Promise<T>): Promise<T> =>
  runWithRequestIdentity({ sub: who.sub, principalIssuer: who.principalIssuer, isOperator: false }, fn);

/** The refusal code a service call ends with, or 'resolved'. */
async function refusalCode(work: Promise<unknown>): Promise<string> {
  return work.then(() => 'resolved', (e) => (e instanceof LocationRequestError ? e.code : String((e as { name?: string }).name)));
}

/** Group, places, binding and the three enrolments, recorded on the world as they are made. */
async function buildWorld(pool: ScenarioRunContext['ctx']['pool'], w: LabWorld): Promise<Record<string, string>> {
  w.groupId = (await as(w.admin, () => createTenant(pool, { name: `Test Lab L4 ${w.clientId}`, createdBySub: w.admin.sub }))).tenant_id;
  await as(w.admin, () => addMember(pool, w.groupId, w.member.sub, w.admin.sub));
  const home = await createLocationPlace(pool, w.admin, parsePlaceInput({ name: 'Test Lab home', center: HOME }, 'create'));
  const school = await createLocationPlace(pool, w.admin, parsePlaceInput({ name: 'Test Lab school', center: SCHOOL, groupId: w.groupId }, 'create'));
  w.places.push(home.placeId, school.placeId);
  await withLocationOwnerSession(pool, w.admin, (client, who) =>
    client.query('INSERT INTO remote_task_journal_client_owners (client_id, owner_sub) VALUES ($1, $2)', [w.clientId, who.sub]));
  const enrol = async (body: Record<string, unknown>): Promise<string> => {
    const device = await enrolPlacedDevice(pool, w.admin, parseEnrolInput(body, w.admin));
    w.devices.push(device.deviceId);
    return device.deviceId;
  };
  return {
    home: home.placeId, school: school.placeId,
    node: await enrol({ kind: 'node', ref: w.clientId, placeId: home.placeId }),
    camera: await enrol({ kind: 'camera', ref: `lab-${w.clientId.slice(-12)}`, groupId: w.groupId, placeId: school.placeId }),
    tv: await enrol({ kind: 'tv', ref: 'Test Lab den', placeId: home.placeId }),
  };
}

/** The ownership and read checks over the world the step built. */
async function lifecycleChecks(pool: ScenarioRunContext['ctx']['pool'], w: LabWorld, ids: Record<string, string>): Promise<Check[]> {
  const moved = await setPlacedDevicePlace(pool, w.admin, ids.tv, { placeId: ids.school, room: 'Den' });
  const camera = await as(w.member, () => currentPlace(pool, { deviceId: ids.camera }));
  return [
    ['the owner moves the TV to the group place', moved.place?.placeId === ids.school],
    ['a member cannot change the group camera', await refusalCode(setPlacedDevicePlace(pool, w.member, ids.camera, { placeId: null })) === 'not_device_owner'],
    ['a member cannot find the owner\'s node', await refusalCode(setPlacedDevicePlace(pool, w.member, ids.node, { placeId: null })) === 'device_not_found'],
    ['a stranger cannot find the camera', await refusalCode(setPlacedDevicePlace(pool, w.stranger, ids.camera, { placeId: null })) === 'device_not_found'],
    ['a member cannot enrol a camera to the group',
      await refusalCode(enrolPlacedDevice(pool, w.member, parseEnrolInput({ kind: 'camera', ref: 'lab-cam-x', groupId: w.groupId }, w.member))) === 'group_admin_required'],
    ['the member reads the camera\'s assigned place by reference', camera.basis === 'assigned' && camera.place?.placeId === ids.school],
    ['the camera is "at" the group place', await as(w.member, () => distanceBand(pool, { deviceId: ids.camera }, ids.school)) === 'at'],
    ['placeAt finds the group place for the member only',
      (await as(w.member, () => placeAt(pool, SCHOOL))).some((p) => p.placeId === ids.school) && (await as(w.stranger, () => placeAt(pool, SCHOOL))).length === 0],
  ];
}

/** Delete what the step created, then count what is left. */
async function cleanup(pool: ScenarioRunContext['ctx']['pool'], w: LabWorld): Promise<number> {
  for (const id of w.devices) await unenrolPlacedDevice(pool, w.admin, id);
  for (const id of w.places) await deleteLocationPlace(pool, w.admin, id);
  return withLocationOwnerSession(pool, w.admin, async (client, who) => {
    if (w.groupId) await client.query('DELETE FROM oshal_tenants WHERE tenant_id = $1', [w.groupId]);
    await client.query('DELETE FROM remote_task_journal_client_owners WHERE client_id = $1 AND owner_sub = $2', [w.clientId, who.sub]);
    const r = await client.query(`SELECT (SELECT count(*) FROM location_devices WHERE owner_sub = $1 OR device_ref = $2 OR tenant_id::text = $3)
      + (SELECT count(*) FROM location_places WHERE owner_sub = $1 OR tenant_id::text = $3)
      + (SELECT count(*) FROM oshal_tenants WHERE tenant_id::text = $3)
      + (SELECT count(*) FROM remote_task_journal_client_owners WHERE client_id = $2) AS n`, [who.sub, w.clientId, w.groupId || '']);
    return Number(r.rows[0].n);
  });
}

/**
 * @description Places, enrolment and the kernel reads for three synthetic people on the real database, with a full cleanup and a zero-row check.
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function placesLifecycleStep(runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(LIFECYCLE_LABEL);
  if (!runtime?.ctx?.pool) return result('gap', 'Needs the running server\'s database pool; run it from the Test Lab.');
  const tag = randomUUID();
  const person = (role: string): LocationPrincipal => ({ sub: `test-lab-location-l4-${role}-${tag}`, principalIssuer: PROBE_ISSUER });
  const w: LabWorld = { admin: person('admin'), member: person('member'), stranger: person('stranger'), clientId: `test-lab-node-${tag}`, groupId: '', places: [], devices: [] };
  let checks: Check[] = [];
  let failure = '';
  try {
    checks = await lifecycleChecks(runtime.ctx.pool, w, await buildWorld(runtime.ctx.pool, w));
  } catch (error) {
    logger.error({ op: 'lab-lifecycle', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab location places lifecycle could not run');
    failure = `The lifecycle could not run: ${(error as { code?: string }).code ?? (error as Error).name}.`;
  }
  let left = -1;
  try {
    left = await cleanup(runtime.ctx.pool, w);
  } catch (error) {
    logger.error({ op: 'lab-cleanup', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab location places cleanup failed');
  }
  if (left !== 0) return result('fail', `${failure} Cleanup incomplete: ${left < 0 ? 'the cleanup failed' : `${left} synthetic rows remain`}.`.trim());
  if (failure) return result('fail', `${failure} Synthetic rows were deleted.`);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Lifecycle failed: ${failed.join('; ')}. Synthetic rows were deleted.`, { failed });
  return result('pass', `${checks.length} checks hold: ${checks.map(([name]) => name).join('; ')}. Every synthetic device, place, group and binding was deleted and no row of theirs remains.`);
}

/** The ADR-169 L4 Test Lab card. */
export const LOCATION_PLACES_SCENARIOS: Scenario[] = [{
  id: 'location-places-devices',
  title: 'Location — places and devices at places (ADR-169 L4)',
  group: 'tool',
  description: 'Checks ADR-169 slice L4 on the running build. As the signed-in person, the places and devices lists carry no coordinate or address, and a camera with no group, a node the person does not own and a place for a group they do not administer are each refused without a write. Then three uniquely tagged synthetic people on the real database: an admin makes a group with a member, a place of their own and a group place, enrols their own synthetic node, a camera to the group and a TV with places and moves the TV; the member cannot change the camera or find the node, the stranger cannot find the camera, and the member reads the camera\'s place by reference through currentPlace, distanceBand and placeAt. Everything created is deleted and a zero-row check runs. No real person\'s location is read or written.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/location-place-reads-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/location-places-devices-postgres.spec.ts' },
    { level: 'browser', path: 'tests/unit/location-places-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-route-policy.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-rls-no-operator-guard.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-fleet-id-shape.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-location-places-registration.spec.ts' },
  ],
  steps: [
    { id: 'place-routes', app: APP, label: ROUTES_LABEL, run: async (cookie, _prior, runtime) => placeRoutesStep(cookie, runtime) },
    { id: 'places-lifecycle', app: APP, label: LIFECYCLE_LABEL, run: async (_cookie, _prior, runtime) => placesLifecycleStep(runtime) },
  ],
}];

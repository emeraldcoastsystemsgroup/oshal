/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6 over HTTP on localhost with MOCK_OIDC for the people and the REAL CLI-token middleware for the devices, over a private PostgreSQL whose tables are owned by the enforcing runtime role (FORCE row-level security is what holds), through the real /api/location and /api/join mounts. A group admin issues a drone's credential behind the step-up proof (a member cannot; a browser device cannot have one); the token is bound to the device and to no node, reporting turns on at the class. The drone posts a fix under that credential and it is stored as the device subject at exact precision, placed in the group place, and read by reference by a member through currentPlace, distanceBand and locatedDevice while a stranger gets nothing. Every refusal the L6 done-when names writes nothing: a browser session, the service secret, a node token for the same id (and /api/join/enroll refuses to mint one while an ordinary enrolment still works), a location credential minted by a different account for the same id, a credential whose account is a non-admin member, a credential bound to a different device, a malformed fix. Issuing again rotates (the earlier token dies), opting out by the other admin revokes the credential and the drone is refused, removing the record revokes it too. The account PAT and node token paths are unchanged by the new column. At the database, migration 178's device policies let a device subject write only rows naming its own device (another device's row is 42501) and read no observation and no device row. Synthetic identities and coordinates only.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createTenant } from '@/app/routes/connector-tenancy';
import { insertCliToken } from '@/app/routes/cli-token-routes';
import { LOCATION_DEVICE_SUBJECT_ISSUER } from '@/app/location-device-ingest';
import { LocationNotFoundError, currentPlace, distanceBand, locatedDevice } from '@/features/location';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { asSession, sqlState } from '../helpers/location-postgres-fixture';
import {
  FIXTURE_SERVICE_SECRET, MOCK_ISSUER, MOCK_SUB_HEADER, countRows, startLocationBrowserServer, type LocationBrowserServer,
} from '../helpers/location-browser-server';

const ADMIN = 'loc-l6-admin';
const ADMIN2 = 'loc-l6-second-admin';
const MEMBER = 'loc-l6-member';
const STRANGER = 'loc-l6-stranger';
const SCHOOL = { lat: -12.35, lon: -31.99 };
const NAVIGATE = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const COORDINATE_KEYS = /"(lat|lon|latitude|longitude|center|center_lat|center_lon|address)"/;
let fx: LocationBrowserServer;
const ids = { group: '', school: '', drone: '', otherDrone: '', browser: '' };
const tokens = { drone: '', other: '' };

type Reply = { status: number; json: Record<string, any> };

async function call(sub: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${fx.base}/api/location${path}`, {
    method, redirect: 'manual',
    headers: { ...(sub ? { [MOCK_SUB_HEADER]: sub } : {}), 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> };
}

/** A device's fix under a bearer credential: no mock person header, exactly as a drone node sends it. */
function post(deviceId: string, token: string, body: unknown = { lat: -12.350012, lon: -31.990034, altM: 42.25, observedAt: new Date().toISOString() }): Promise<Reply> {
  return call(null, 'POST', `/devices/${deviceId}/presence`, body, { authorization: `Bearer ${token}` });
}

function navigate(sub: string, path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${fx.base}/api/location${path}`, { method: 'GET', headers: { [MOCK_SUB_HEADER]: sub, ...NAVIGATE } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Open a challenge and prove it the way MOCK_OIDC does: a top-level navigation to its start. */
async function proof(sub: string, operation: string, params: unknown): Promise<Record<string, string>> {
  const opened = await call(sub, 'POST', '/step-up', { operation, params });
  expect(opened.status).toBe(201);
  expect((await navigate(sub, `/step-up/${opened.json.challengeId}/start`)).status).toBe(303);
  return { 'x-oshal-location-step-up': opened.json.challengeId };
}

async function issue(sub: string, deviceId: string, precisionClass = 'exact'): Promise<Reply> {
  return call(sub, 'POST', `/devices/${deviceId}/credential`, { precisionClass }, await proof(sub, 'approve-enrolment', { deviceId, precisionClass }));
}

const as = <T>(sub: string, fn: () => Promise<T>): Promise<T> =>
  runWithRequestIdentity({ sub, principalIssuer: MOCK_ISSUER, isOperator: false }, fn);

beforeAll(async () => {
  fx = await startLocationBrowserServer('location-device-ingest', [], { bearer: true });
  const admin = { sub: ADMIN, issuer: MOCK_ISSUER };
  ids.group = (await asSession(admin, () => createTenant(fx.runtime, { name: 'Household', createdBySub: ADMIN }))).tenant_id;
  await asSession(admin, () => addMember(fx.runtime, ids.group, MEMBER, ADMIN));
  await asSession(admin, () => addMember(fx.runtime, ids.group, ADMIN2, ADMIN, 'admin'));
  ids.school = (await call(ADMIN, 'POST', '/places', { name: 'School', center: SCHOOL, groupId: ids.group })).json.place.placeId;
  ids.drone = (await call(ADMIN, 'POST', '/devices', { kind: 'drone', ref: 'drone-1', groupId: ids.group })).json.device.deviceId;
  ids.otherDrone = (await call(ADMIN, 'POST', '/devices', { kind: 'drone', ref: 'drone-2', groupId: ids.group })).json.device.deviceId;
  const body = { deviceId: null, precisionClass: 'block' };
  ids.browser = (await call(ADMIN, 'POST', '/devices/browser/opt-in', body, await proof(ADMIN, 'opt-in', body))).json.device.deviceId;
}, 180_000);

afterAll(async () => { await fx?.close(); }, 60_000);

describe('issuing a drone\'s location credential', () => {
  it('needs the step-up proof and a group admin; the token is bound to the device and to no node', async () => {
    expect((await call(ADMIN, 'POST', `/devices/${ids.drone}/credential`, { precisionClass: 'exact' })).json.error).toBe('step_up_required');
    expect((await issue(MEMBER, ids.drone)).json.error).toBe('not_device_owner');
    expect((await issue(STRANGER, ids.drone)).json.error).toBe('device_not_found');
    expect((await issue(ADMIN, ids.browser)).json.error).toBe('credential_not_supported');
    expect(await countRows(fx, 'oshal_cli_tokens WHERE location_device_id IS NOT NULL')).toBe(0);
    const issued = await issue(ADMIN, ids.drone);
    expect(issued.status).toBe(201);
    expect(issued.json).toMatchObject({ deviceId: ids.drone, kind: 'drone', name: 'drone-1', precisionClass: 'exact', rotated: false });
    expect(issued.json.credential.token).toMatch(/^oshal_pat_[0-9a-f]{48}$/);
    tokens.drone = issued.json.credential.token;
    expect(await countRows(fx, 'oshal_cli_tokens WHERE id = $1 AND location_device_id = $2 AND node_client_id IS NULL AND user_sub = $3 AND revoked_at IS NULL',
      [issued.json.credential.id, ids.drone, ADMIN])).toBe(1);
    expect(await countRows(fx, 'location_devices WHERE device_id = $1 AND credential_id = $2 AND reporting_enabled AND precision_class = $3',
      [ids.drone, issued.json.credential.id, 'exact'])).toBe(1);
    tokens.other = (await issue(ADMIN2, ids.otherDrone)).json.credential.token;
  });
});

describe('the drone posts fixes under its credential', () => {
  it('stores the fix as the device subject at exact precision in the group place; the reply carries no coordinate', async () => {
    const res = await post(ids.drone, tokens.drone);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ deviceId: ids.drone, precisionClass: 'exact', place: { placeId: ids.school, name: 'School' } });
    expect(JSON.stringify(res.json)).not.toMatch(COORDINATE_KEYS);
    const rows = (await fx.db.pool.query(`SELECT owner_sub, principal_issuer, tenant_id, subject_ref, device_id, source, precision_class,
        lat, lon, alt_m, mock_location FROM location_observations`)).rows;
    expect(rows).toEqual([{ owner_sub: null, principal_issuer: null, tenant_id: ids.group, subject_ref: `device:${ids.drone}`, device_id: ids.drone,
      source: 'mavlink', precision_class: 'exact', lat: -12.35001, lon: -31.99003, alt_m: 42.3, mock_location: false }]);
    expect((await fx.db.pool.query('SELECT subject_ref, place_id, tenant_id FROM location_current')).rows)
      .toEqual([{ subject_ref: `device:${ids.drone}`, place_id: ids.school, tenant_id: ids.group }]);
    expect(await countRows(fx, 'location_devices WHERE device_id = $1 AND last_seen_at IS NOT NULL', [ids.drone])).toBe(1);
  });

  it('a member reads the drone by reference; a stranger gets nothing from the location reads', async () => {
    const seen = await as(MEMBER, () => currentPlace(fx.runtime, { deviceId: ids.drone }));
    expect(seen).toMatchObject({ basis: 'observed', place: { placeId: ids.school, label: 'other', name: 'School' } });
    expect(JSON.stringify(seen)).not.toMatch(COORDINATE_KEYS);
    expect(await as(MEMBER, () => distanceBand(fx.runtime, { deviceId: ids.drone }, ids.school))).toBe('at');
    expect(await as(MEMBER, () => locatedDevice(fx.runtime, 'drone', 'drone-1'))).toEqual({ deviceId: ids.drone, owner: 'group', groupId: ids.group, reporting: true });
    await expect(as(STRANGER, () => currentPlace(fx.runtime, { deviceId: ids.drone }))).rejects.toBeInstanceOf(LocationNotFoundError);
    expect(await as(STRANGER, () => locatedDevice(fx.runtime, 'drone', 'drone-1'))).toBeNull();
    expect(await as(STRANGER, () => distanceBand(fx.runtime, { deviceId: ids.drone }, ids.school).catch((e: Error) => e.name))).toBe('LocationNotFoundError');
  });

  it('at the database, a device subject writes only its own rows and reads no observation and no device row', async () => {
    const subject = (deviceId: string) => ({ sub: `device:${deviceId}`, issuer: LOCATION_DEVICE_SUBJECT_ISSUER });
    const insert = (asDevice: string, forDevice: string) => asSession(subject(asDevice), () => fx.runtime.query(`INSERT INTO location_observations
        (tenant_id, subject_ref, device_id, source, precision_class, lat, lon, observed_at, received_at)
      VALUES ($1, $2, $3, 'mavlink', 'exact', -12.35, -31.99, NOW(), NOW())`, [ids.group, `device:${forDevice}`, forDevice]));
    expect(await sqlState(insert(ids.drone, ids.otherDrone))).toBe('42501');
    expect(await sqlState(insert(ids.otherDrone, ids.drone))).toBe('42501');
    expect(await sqlState(insert(ids.drone, ids.drone))).toBe('resolved');
    const seen = await asSession(subject(ids.drone), () => fx.runtime.query('SELECT count(*)::int AS n FROM location_observations'));
    expect(seen.rows[0].n).toBe(0);
    const rows = await asSession(subject(ids.drone), () => fx.runtime.query('SELECT count(*)::int AS n FROM location_devices'));
    expect(rows.rows[0].n).toBe(0);
    await fx.db.pool.query('DELETE FROM location_observations WHERE device_id = $1 AND lat = -12.35 AND accuracy_m IS NULL AND alt_m IS NULL', [ids.drone]);
  });

  it('a simulated fix is stored with its mock flag, and a malformed fix writes nothing', async () => {
    const before = await countRows(fx, 'location_observations');
    expect((await post(ids.drone, tokens.drone, { lat: -12.3501, lon: -31.9901, mock: true })).status).toBe(201);
    expect(await countRows(fx, 'location_observations WHERE mock_location')).toBe(1);
    for (const body of [{ lat: 91, lon: 1 }, { lat: 1, lon: 1, altM: 'high' }, { lat: 1, lon: 1, mock: 'yes' }, { lat: 1, lon: 1, observedAt: 'yesterday' }]) {
      expect((await post(ids.drone, tokens.drone, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await countRows(fx, 'location_observations')).toBe(before + 1);
  });
});

describe('the ingest refuses everything but the device\'s own credential (writes nothing)', () => {
  let before = 0;
  beforeAll(async () => { before = await countRows(fx, 'location_observations'); });

  it('a browser session and the service secret', async () => {
    const asPerson = await call(ADMIN, 'POST', `/devices/${ids.drone}/presence`, { lat: 1, lon: 1 });
    expect(asPerson.status).toBe(401);
    expect(asPerson.json.error).toBe('device_credential_required');
    expect(process.env.SWARM_SERVICE_SECRET).toBe(FIXTURE_SERVICE_SECRET);
    const secret = await call(null, 'POST', `/devices/${ids.drone}/presence`, { lat: 1, lon: 1 },
      { 'x-service-secret': process.env.SWARM_SERVICE_SECRET ?? '', 'x-oshal-user-sub': ADMIN });
    expect(secret.status).toBe(401);
    expect(secret.json.error).toBe('service_secret_refused');
    expect(await countRows(fx, 'location_observations')).toBe(before);
  });

  it('a node-bound token for the same id, and /api/join/enroll refuses to mint one (an ordinary enrolment still works)', async () => {
    const node = await asSession({ sub: ADMIN, issuer: MOCK_ISSUER }, () =>
      insertCliToken(fx.runtime, { sub: ADMIN, principalIssuer: MOCK_ISSUER, nodeClientId: ids.drone }));
    const res = await post(ids.drone, node.token);
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('device_credential_required');
    const enrol = async (clientId: string) => {
      const r = await fetch(`${fx.base}/api/join/enroll`, { method: 'POST',
        headers: { [MOCK_SUB_HEADER]: ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ clientId }) });
      return { status: r.status, json: await r.json() as Record<string, any> };
    };
    const refused = await enrol(ids.drone);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('location_device_id');
    expect(await countRows(fx, 'oshal_cli_tokens WHERE node_client_id = $1', [ids.drone])).toBe(1);
    const fine = await enrol('loc-l6-laptop');
    expect(fine.status).toBe(201);
    expect(fine.json.enrollment.nodeClientId).toBe('loc-l6-laptop');
    expect(await countRows(fx, 'location_observations')).toBe(before);
  });

  it('a credential minted by a different account for the same id, and one whose account is a non-admin member', async () => {
    const strangers = await asSession({ sub: STRANGER, issuer: MOCK_ISSUER }, () =>
      insertCliToken(fx.runtime, { sub: STRANGER, principalIssuer: MOCK_ISSUER, locationDeviceId: ids.drone }));
    const mismatch = await post(ids.drone, strangers.token);
    expect(mismatch.status).toBe(404);
    expect(mismatch.json.error).toBe('device_not_found');
    const members = await asSession({ sub: MEMBER, issuer: MOCK_ISSUER }, () =>
      insertCliToken(fx.runtime, { sub: MEMBER, principalIssuer: MOCK_ISSUER, locationDeviceId: ids.drone }));
    const notRecorded = await post(ids.drone, members.token);
    expect(notRecorded.status).toBe(403);
    expect(notRecorded.json.error).toBe('credential_mismatch');
    const recorded = (await fx.db.pool.query('SELECT credential_id FROM location_devices WHERE device_id = $1', [ids.drone])).rows[0].credential_id;
    await fx.db.pool.query('UPDATE location_devices SET credential_id = $2 WHERE device_id = $1', [ids.drone, members.id]);
    try {
      const notOwner = await post(ids.drone, members.token);
      expect(notOwner.status).toBe(403);
      expect(notOwner.json.error).toBe('not_device_owner');
    } finally {
      await fx.db.pool.query('UPDATE location_devices SET credential_id = $2 WHERE device_id = $1', [ids.drone, recorded]);
    }
    expect(await countRows(fx, 'location_observations')).toBe(before);
  });

  it('a credential bound to a different device, and the drone\'s own credential on any other route', async () => {
    const foreign = await post(ids.drone, tokens.other);
    expect(foreign.status).toBe(401);
    expect(foreign.json.error).toBe('device_credential_required');
    const state = await call(null, 'GET', '/state', undefined, { authorization: `Bearer ${tokens.drone}` });
    expect(state.status).toBe(403);
    expect(state.json.error).toBe('browser_session_required');
    expect((await post(ids.drone, 'oshal_pat_' + '0'.repeat(48))).status).toBe(401);
    expect(await countRows(fx, 'location_observations')).toBe(before);
  });
});

describe('rotation, opting out and removal retire the credential', () => {
  it('issuing again rotates: the earlier token is revoked and the new one reports', async () => {
    const again = await issue(ADMIN2, ids.drone);
    expect(again.status).toBe(201);
    expect(again.json.rotated).toBe(true);
    expect((await post(ids.drone, tokens.drone)).status).toBe(401);
    tokens.drone = again.json.credential.token;
    expect((await post(ids.drone, tokens.drone)).status).toBe(201);
    expect(await countRows(fx, 'oshal_cli_tokens WHERE location_device_id = $1 AND user_sub = $2 AND revoked_at IS NULL', [ids.drone, ADMIN])).toBe(0);
    expect(await countRows(fx, 'oshal_cli_tokens WHERE location_device_id = $1 AND user_sub = $2 AND revoked_at IS NULL', [ids.drone, ADMIN2])).toBe(1);
  });

  it('a member cannot opt the drone out; the other admin can, which revokes the credential and clears the current row', async () => {
    expect((await call(MEMBER, 'POST', `/devices/${ids.drone}/opt-out`)).status).toBe(404);
    expect((await post(ids.drone, tokens.drone)).status).toBe(201);
    const out = await call(ADMIN, 'POST', `/devices/${ids.drone}/opt-out`);
    expect(out.status).toBe(200);
    expect(out.json.device.reportingEnabled).toBe(false);
    expect(out.json.currentCleared).toBe(1);
    // The recorded credential (the second admin's) is revoked; the two forged rows the refusal cases
    // seeded were never the recorded credential and stay as they were, still useless.
    expect(await countRows(fx, 'oshal_cli_tokens WHERE location_device_id = $1 AND user_sub = $2 AND revoked_at IS NULL', [ids.drone, ADMIN2])).toBe(0);
    expect(await countRows(fx, 'oshal_cli_tokens WHERE location_device_id = $1 AND revoked_at IS NULL AND user_sub IN ($2, $3)', [ids.drone, STRANGER, MEMBER])).toBe(2);
    expect(await countRows(fx, 'location_devices WHERE device_id = $1 AND credential_id IS NULL AND NOT reporting_enabled', [ids.drone])).toBe(1);
    expect((await post(ids.drone, tokens.drone)).status).toBe(401);
    expect(await countRows(fx, 'location_observations WHERE device_id = $1', [ids.drone])).toBeGreaterThan(0);
  });

  it('removing the record revokes the credential', async () => {
    expect((await post(ids.otherDrone, tokens.other)).status).toBe(201);
    expect((await call(ADMIN, 'DELETE', `/devices/${ids.otherDrone}`)).json.deleted).toBe(true);
    expect(await countRows(fx, 'oshal_cli_tokens WHERE location_device_id = $1 AND revoked_at IS NULL', [ids.otherDrone])).toBe(0);
    expect((await post(ids.otherDrone, tokens.other)).status).toBe(401);
  });
});

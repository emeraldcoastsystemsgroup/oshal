/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3 over HTTP on localhost with MOCK_OIDC and a private PostgreSQL (tables owned by the enforcing runtime role, so FORCE row-level security is what holds). A browser fix is stored for the signed-in person whatever owner, subject, issuer, source, precision or place the body names, minimised to the device's class, and placed against the person's own place, never another person's; a fix naming someone else's device is refused. The service secret is refused with 401 alongside a valid session and writes nothing. Without a spent proof nobody can opt in, raise a device's or the default precision, or accept a share, while lowering needs none; a proof is single use, bound to its parameters and to its person. Opting out clears the current row and stops ingest while the history stays; the purge removes the person's history and current row and nobody else's. The overview carries no coordinate.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createTenant } from '@/app/routes/connector-tenancy';
import { asSession } from '../helpers/location-postgres-fixture';
import {
  FIXTURE_SERVICE_SECRET, MOCK_ISSUER, MOCK_SUB_HEADER, countRows, seedOwnPlace, startLocationBrowserServer,
  type LocationBrowserServer,
} from '../helpers/location-browser-server';

const A = 'loc-person-a';
const B = 'loc-person-b';
const ADMIN = 'loc-group-admin';
const HOME = { name: 'Home', label: 'home', lat: -12.3461, lon: -31.9882, radiusM: 120 };
const NAVIGATE = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
let fx: LocationBrowserServer;
const ids = { homeA: '', homeB: '', group: '', groupPlace: '' };

async function call(sub: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${fx.base}/api/location${path}`, {
    method, redirect: 'manual',
    headers: { [MOCK_SUB_HEADER]: sub, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any>, location: res.headers.get('location') };
}

/**
 * A top-level document navigation, as a browser sends it. Node's fetch writes its own Sec-Fetch-Mode
 * (cors), which is exactly why a script's fetch can never pass the navigation check; a raw request
 * stands in for the browser here, and the Chromium spec proves the real navigation.
 */
function navigate(sub: string, path: string): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${fx.base}/api/location${path}`, { method: 'GET', headers: { [MOCK_SUB_HEADER]: sub, ...NAVIGATE } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, location: res.headers.location });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Open a challenge and prove it the way MOCK_OIDC does: a top-level navigation to its start. */
async function proof(sub: string, operation: string, params: unknown): Promise<Record<string, string>> {
  const opened = await call(sub, 'POST', '/step-up', { operation, params });
  expect(opened.status).toBe(201);
  expect((await call(sub, 'GET', `/step-up/${opened.json.challengeId}/start`)).json.error).toBe('navigation_required');
  const started = await navigate(sub, `/step-up/${opened.json.challengeId}/start`);
  expect(started.status).toBe(303);
  expect(started.location).toBe('/cockpit/tools/location.html?stepUpDone=1&ok=1');
  return { 'x-oshal-location-step-up': opened.json.challengeId };
}

async function optIn(sub: string, precisionClass = 'block'): Promise<string> {
  const body = { deviceId: null, precisionClass };
  const res = await call(sub, 'POST', '/devices/browser/opt-in', body, await proof(sub, 'opt-in', body));
  expect(res.status).toBe(201);
  return res.json.device.deviceId;
}

beforeAll(async () => {
  fx = await startLocationBrowserServer('location-browser-consent');
  ids.homeA = await seedOwnPlace(fx, A, HOME);
  ids.homeB = await seedOwnPlace(fx, B, { ...HOME, name: 'Their home', radiusM: 5000 });
  const who = { sub: ADMIN, issuer: MOCK_ISSUER };
  ids.group = (await asSession(who, () => createTenant(fx.runtime, { name: 'Household', createdBySub: ADMIN }))).tenant_id;
  await asSession(who, () => addMember(fx.runtime, ids.group, A, ADMIN));
  ids.groupPlace = (await asSession(who, () => fx.runtime.query(`INSERT INTO location_places
    (tenant_id, name, label, center_lat, center_lon, radius_m, created_by_sub) VALUES ($1, 'School', 'other', -12.35, -31.99, 150, $2)
    RETURNING place_id`, [ids.group, ADMIN]))).rows[0].place_id;
}, 180_000);

afterAll(async () => { await fx?.close(); }, 60_000);

describe('browser ingest: the owner is the session, never the body', () => {
  it('stores a minimised fix for the signed-in person and places it against their own place', async () => {
    const device = await optIn(A);
    const res = await call(A, 'POST', '/presence', {
      deviceId: device, lat: -12.346123, lon: -31.988234, accuracyM: 12.4, observedAt: new Date().toISOString(),
      ownerSub: B, owner_sub: B, sub: B, principalIssuer: 'https://evil.oshal.example.com', source: 'android',
      precisionClass: 'exact', placeId: ids.homeB, subjectRef: B, tenantId: ids.group,
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ deviceId: device, precisionClass: 'block', place: { placeId: ids.homeA, name: 'Home', label: 'home' } });
    const rows = (await fx.db.pool.query('SELECT owner_sub, principal_issuer, subject_ref, tenant_id, source, precision_class, lat, lon, accuracy_m FROM location_observations')).rows;
    expect(rows).toEqual([{ owner_sub: A, principal_issuer: MOCK_ISSUER, subject_ref: A, tenant_id: null, source: 'browser',
      precision_class: 'block', lat: -12.346, lon: -31.988, accuracy_m: 12 }]);
    const current = (await fx.db.pool.query('SELECT owner_sub, place_id FROM location_current')).rows;
    expect(current).toEqual([{ owner_sub: A, place_id: ids.homeA }]);
    expect(await countRows(fx, 'location_observations WHERE owner_sub = $1', [B])).toBe(0);
  });

  it('refuses a fix that names another person\'s device, and a malformed fix', async () => {
    const theirs = await optIn(B, 'city');
    expect((await call(A, 'POST', '/presence', { deviceId: theirs, lat: 1, lon: 1 })).json.error).toBe('device_not_found');
    expect((await call(A, 'POST', '/presence', { deviceId: theirs, lat: 91, lon: 1 })).status).toBe(400);
    expect(await countRows(fx, 'location_observations WHERE device_id = $1', [theirs])).toBe(0);
  });

  it('refuses the service secret with 401 even alongside a valid session, and writes nothing', async () => {
    const before = await countRows(fx, 'location_observations');
    const [device] = (await fx.db.pool.query("SELECT device_id FROM location_devices WHERE owner_sub = $1", [A])).rows;
    const res = await call(A, 'POST', '/presence', { deviceId: device.device_id, lat: -12.3461, lon: -31.9882 },
      { 'x-service-secret': process.env.SWARM_SERVICE_SECRET ?? '', 'x-oshal-user-sub': A });
    expect(process.env.SWARM_SERVICE_SECRET).toBe(FIXTURE_SERVICE_SECRET);
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('service_secret_refused');
    expect(await countRows(fx, 'location_observations')).toBe(before);
  });
});

describe('step-up: nothing that raises exposure happens without a fresh proof', () => {
  it('opt-in needs a proof, and a proof is single use and bound to its parameters and person', async () => {
    const devices = await countRows(fx, 'location_devices');
    const body = { deviceId: null, precisionClass: 'city' };
    expect((await call(A, 'POST', '/devices/browser/opt-in', body)).json.error).toBe('step_up_required');
    const forCity = await proof(A, 'opt-in', body);
    expect((await call(A, 'POST', '/devices/browser/opt-in', { deviceId: null, precisionClass: 'exact' }, forCity)).json.error).toBe('step_up_required');
    expect((await call(B, 'POST', '/devices/browser/opt-in', body, forCity)).json.error).toBe('step_up_required');
    expect((await call(A, 'POST', '/devices/browser/opt-in', body, forCity)).status).toBe(201);
    expect((await call(A, 'POST', '/devices/browser/opt-in', body, forCity)).json.error).toBe('step_up_required');
    expect(await countRows(fx, 'location_devices')).toBe(devices + 1);
  });

  it('raising a device\'s precision needs a proof; lowering does not', async () => {
    const device = await optIn(A, 'block');
    const path = `/devices/${device}/precision`;
    expect((await call(A, 'PUT', path, { precisionClass: 'exact' })).json.error).toBe('step_up_required');
    expect(await countRows(fx, "location_devices WHERE device_id = $1 AND precision_class = 'block'", [device])).toBe(1);
    expect((await call(A, 'PUT', path, { precisionClass: 'city' })).json).toMatchObject({ previous: 'block', next: 'city', raised: false });
    const raise = await proof(A, 'raise-precision', { scope: device, precisionClass: 'exact' });
    expect((await call(A, 'PUT', path, { precisionClass: 'exact' }, raise)).json).toMatchObject({ previous: 'city', next: 'exact', raised: true });
  });

  it('raising the default precision needs a proof; lowering does not', async () => {
    expect((await call(A, 'PUT', '/settings', { defaultPrecisionClass: 'exact' })).json.error).toBe('step_up_required');
    expect((await call(A, 'PUT', '/settings', { defaultPrecisionClass: 'city' })).json).toMatchObject({ previous: 'block', raised: false });
    const raise = await proof(A, 'raise-precision', { scope: 'default', precisionClass: 'block' });
    expect((await call(A, 'PUT', '/settings', { defaultPrecisionClass: 'block' }, raise)).json).toMatchObject({ previous: 'city', raised: true });
  });

});

describe('step-up: member shares', () => {
  it('accepting a member share needs a proof; revoking does not; who-can-see-me lists it', async () => {
    const body = { tenantId: ids.group, placeIds: [ids.groupPlace] };
    expect((await call(A, 'POST', '/shares', body)).json.error).toBe('step_up_required');
    expect(await countRows(fx, 'location_shares')).toBe(0);
    const accepted = await call(A, 'POST', '/shares', body, await proof(A, 'accept-share', body));
    expect(accepted.status).toBe(201);
    const shares = (await call(A, 'GET', '/state')).json.visibility.memberShares;
    expect(shares).toEqual([expect.objectContaining({ shareId: accepted.json.shareId, groupName: 'Household', active: true,
      places: [{ placeId: ids.groupPlace, name: 'School', label: 'other' }] })]);
    expect((await call(A, 'POST', `/shares/${accepted.json.shareId}/revoke`)).status).toBe(200);
    expect((await call(A, 'GET', '/state')).json.visibility.memberShares[0].active).toBe(false);
  });

  it('a person outside the group cannot accept a share with it even holding a proof', async () => {
    const body = { tenantId: ids.group, placeIds: [ids.groupPlace] };
    const res = await call(B, 'POST', '/shares', body, await proof(B, 'accept-share', body));
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('places_not_in_group');
  });
});

describe('opt-out and purge', () => {
  it('opting out clears the current row and stops ingest while the history stays; the purge then removes it', async () => {
    const device = (await fx.db.pool.query('SELECT device_id FROM location_current WHERE owner_sub = $1', [A])).rows[0].device_id;
    const history = await countRows(fx, 'location_observations WHERE owner_sub = $1', [A]);
    expect(history).toBeGreaterThan(0);
    const out = await call(A, 'POST', `/devices/${device}/opt-out`);
    expect(out.json).toMatchObject({ currentCleared: 1, device: { deviceId: device, reportingEnabled: false } });
    expect(await countRows(fx, 'location_current WHERE owner_sub = $1', [A])).toBe(0);
    expect(await countRows(fx, 'location_observations WHERE owner_sub = $1', [A])).toBe(history);
    const again = await call(A, 'POST', '/presence', { deviceId: device, lat: -12.3461, lon: -31.9882 });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('reporting_off');
    const bFix = await call(B, 'POST', '/presence', { deviceId: (await fx.db.pool.query('SELECT device_id FROM location_devices WHERE owner_sub = $1', [B])).rows[0].device_id, lat: 10, lon: 10 });
    expect(bFix.status).toBe(201);
    const purged = await call(A, 'POST', '/history/purge');
    expect(purged.json).toEqual({ observationCount: history, currentCount: 0 });
    expect(await countRows(fx, 'location_observations WHERE owner_sub = $1', [A])).toBe(0);
    expect(await countRows(fx, 'location_observations WHERE owner_sub = $1', [B])).toBe(1);
  });

  it('the overview carries no coordinate', async () => {
    const state = await call(B, 'GET', '/state');
    expect(state.json.current).toMatchObject({ precisionClass: 'city', place: null });
    const text = JSON.stringify(state.json);
    expect(text).not.toMatch(/"(lat|lon|latitude|longitude|center_lat|center_lon|centerLat|centerLon|radius_m|radiusM|address)"/);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4 over HTTP on localhost with MOCK_OIDC and a private PostgreSQL (tables owned by the enforcing runtime role, so FORCE row-level security is what holds), through the real /api/location mount. Places: a person creates their own, a group admin creates the group's, a member or a stranger cannot; the list names places by name, label and radius only; a member cannot change or delete a group place and a stranger cannot even find a person's place; malformed input is refused. Devices: a node is enrolled only by its ADR-114 owner (as theirs, or as the group's when they are its admin, never by a non-admin member); a camera or drone only by a group admin and only to that group; a TV and a hub device carry the enroller's own namespace. A node, a camera and a TV each show an assigned place that the owner changes and a non-owner cannot (a member of the camera's group sees it view-only; nobody else finds it), and a place from outside the device owner's reach is refused. At the database, migration 176's identity fence refuses a node without its owner's binding (even for an operator-stamped session), another person's TV namespace, a person-owned camera and any change of a device's kind or reference. Synthetic identities and coordinates only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createTenant } from '@/app/routes/connector-tenancy';
import { locationOwnerRefKey } from '@/app/location-devices';
import { asSession, inRolledBackTransaction, sqlState } from '../helpers/location-postgres-fixture';
import {
  MOCK_ISSUER, MOCK_SUB_HEADER, countRows, seedNodeBinding, startLocationBrowserServer, type LocationBrowserServer,
} from '../helpers/location-browser-server';

const OWNER = 'loc-l4-admin';
const MEMBER = 'loc-l4-member';
const STRANGER = 'loc-l4-stranger';
const HOME = { lat: -12.3461, lon: -31.9882 };
const COORDINATE_KEYS = /"(lat|lon|latitude|longitude|center|centerLat|center_lat|center_lon|address)"/;
let fx: LocationBrowserServer;
const ids = { group: '', otherGroup: '', home: '', school: '', strangerPlace: '', node: '', groupNode: '', camera: '', tv: '', hub: '' };

async function call(sub: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${fx.base}/api/location${path}`, {
    method, headers: { [MOCK_SUB_HEADER]: sub, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> };
}

beforeAll(async () => {
  fx = await startLocationBrowserServer('location-places-devices');
  const admin = { sub: OWNER, issuer: MOCK_ISSUER };
  ids.group = (await asSession(admin, () => createTenant(fx.runtime, { name: 'Household', createdBySub: OWNER }))).tenant_id;
  await asSession(admin, () => addMember(fx.runtime, ids.group, MEMBER, OWNER));
  ids.otherGroup = (await asSession({ sub: STRANGER, issuer: MOCK_ISSUER }, () => createTenant(fx.runtime, { name: 'Elsewhere', createdBySub: STRANGER }))).tenant_id;
  await asSession({ sub: STRANGER, issuer: MOCK_ISSUER }, () => addMember(fx.runtime, ids.otherGroup, OWNER, STRANGER));
  await seedNodeBinding(fx, 'node-owner-desk', OWNER);
  await seedNodeBinding(fx, 'node-owner-shed', OWNER);
  await seedNodeBinding(fx, 'node-member-laptop', MEMBER);
}, 180_000);

afterAll(async () => { await fx?.close(); }, 60_000);

describe('places: person and group circles, owners only', () => {
  it('a person creates their own place and a group admin the group\'s; neither list carries a coordinate or an address', async () => {
    const own = await call(OWNER, 'POST', '/places', { name: 'Home', label: 'home', center: HOME, address: 'Synthetic address 1', timezone: 'Atlantic/South_Georgia' });
    expect(own.status).toBe(201);
    expect(own.json.place).toMatchObject({ name: 'Home', label: 'home', radiusM: 100, hasAddress: true, group: null, editable: true });
    ids.home = own.json.place.placeId;
    const group = await call(OWNER, 'POST', '/places', { name: 'School', center: { lat: -12.35, lon: -31.99 }, groupId: ids.group });
    expect(group.status).toBe(201);
    expect(group.json.place).toMatchObject({ radiusM: 150, group: { groupId: ids.group, name: 'Household' }, editable: true });
    ids.school = group.json.place.placeId;
    ids.strangerPlace = (await call(STRANGER, 'POST', '/places', { name: 'Theirs', center: HOME })).json.place.placeId;
    const listed = await call(OWNER, 'GET', '/places');
    expect(listed.json.places.map((p: { name: string }) => p.name)).toEqual(['Home', 'School']);
    expect(listed.json.groups).toEqual(expect.arrayContaining([{ groupId: ids.group, name: 'Household', admin: true }]));
    expect(JSON.stringify(own.json) + JSON.stringify(listed.json)).not.toMatch(COORDINATE_KEYS);
    expect(await countRows(fx, 'location_places WHERE place_id = $1 AND center_lat = $2 AND address IS NOT NULL', [ids.home, HOME.lat])).toBe(1);
  });

  it('a member or a stranger cannot create a group place', async () => {
    const before = await countRows(fx, 'location_places');
    expect((await call(MEMBER, 'POST', '/places', { name: 'Park', center: HOME, groupId: ids.group })).json.error).toBe('group_admin_required');
    expect((await call(STRANGER, 'POST', '/places', { name: 'Park', center: HOME, groupId: ids.group })).json.error).toBe('group_admin_required');
    expect(await countRows(fx, 'location_places')).toBe(before);
  });

  it('a member sees a group place view-only and cannot change or delete it; a stranger cannot find a person\'s place', async () => {
    const seen = await call(MEMBER, 'GET', '/places');
    expect(seen.json.places).toEqual([expect.objectContaining({ placeId: ids.school, editable: false })]);
    expect((await call(MEMBER, 'PUT', `/places/${ids.school}`, { radiusM: 400 })).json.error).toBe('group_admin_required');
    expect((await call(MEMBER, 'DELETE', `/places/${ids.school}`)).json.error).toBe('group_admin_required');
    expect((await call(STRANGER, 'PUT', `/places/${ids.home}`, { radiusM: 400 })).status).toBe(404);
    expect((await call(STRANGER, 'DELETE', `/places/${ids.home}`)).status).toBe(404);
    expect((await call(OWNER, 'PUT', `/places/${ids.school}`, { radiusM: 200 })).json.place.radiusM).toBe(200);
    expect(await countRows(fx, 'location_places WHERE place_id = $1 AND radius_m = 200', [ids.school])).toBe(1);
  });

  it('refuses a malformed place', async () => {
    const bad = async (body: unknown) => (await call(OWNER, 'POST', '/places', body)).json.error;
    expect(await bad({ name: 'X', center: HOME, radiusM: 49 })).toBe('invalid_radius');
    expect(await bad({ name: 'X', center: HOME, label: 'secret' })).toBe('invalid_label');
    expect(await bad({ name: 'X', center: { lat: 91, lon: 0 } })).toBe('invalid_center');
    expect(await bad({ name: 'X', center: HOME, timezone: 'Not/AZone' })).toBe('invalid_timezone');
    expect(await bad({ center: HOME })).toBe('invalid_name');
    expect((await call(OWNER, 'PUT', `/places/${ids.home}`, { groupId: ids.group })).json.error).toBe('group_fixed');
  });
});

describe('enrolment: whose device it is', () => {
  it('only a node\'s ADR-114 owner enrols it, and only a group admin assigns it to the group', async () => {
    expect((await call(STRANGER, 'POST', '/devices', { kind: 'node', ref: 'node-owner-desk' })).json.error).toBe('node_not_found');
    expect((await call(MEMBER, 'POST', '/devices', { kind: 'node', ref: 'node-owner-desk' })).json.error).toBe('node_not_found');
    const refused = await call(MEMBER, 'POST', '/devices', { kind: 'node', ref: 'node-member-laptop', groupId: ids.group });
    expect(refused.json.error).toBe('group_admin_required');
    const node = await call(OWNER, 'POST', '/devices', { kind: 'node', ref: 'node-owner-desk', placeId: ids.home, room: 'Office' });
    expect(node.status).toBe(201);
    expect(node.json.device).toMatchObject({ kind: 'node', name: 'node-owner-desk', room: 'Office', place: { placeId: ids.home }, group: null, editable: true });
    ids.node = node.json.device.deviceId;
    const shared = await call(OWNER, 'POST', '/devices', { kind: 'node', ref: 'node-owner-shed', groupId: ids.group, placeId: ids.school });
    expect(shared.json.device).toMatchObject({ group: { groupId: ids.group }, place: { placeId: ids.school } });
    ids.groupNode = shared.json.device.deviceId;
    expect((await call(OWNER, 'POST', '/devices', { kind: 'node', ref: 'node-owner-desk' })).json.error).toBe('already_exists');
    expect(await countRows(fx, "location_devices WHERE device_kind = 'node'")).toBe(2);
  });

  it('a camera or drone is enrolled only by an admin of the group it goes to, never to a person', async () => {
    expect((await call(MEMBER, 'POST', '/devices', { kind: 'camera', ref: 'cam-porch', groupId: ids.group })).json.error).toBe('group_admin_required');
    expect((await call(MEMBER, 'POST', '/devices', { kind: 'drone', ref: 'drone-1', groupId: ids.group })).json.error).toBe('group_admin_required');
    expect((await call(OWNER, 'POST', '/devices', { kind: 'camera', ref: 'cam-porch', groupId: ids.otherGroup })).json.error).toBe('group_admin_required');
    expect((await call(OWNER, 'POST', '/devices', { kind: 'camera', ref: 'cam-porch' })).json.error).toBe('group_required');
    expect((await call(OWNER, 'POST', '/devices', { kind: 'camera', ref: 'bad id!', groupId: ids.group })).json.error).toBe('invalid_ref');
    const camera = await call(OWNER, 'POST', '/devices', { kind: 'camera', ref: 'cam-porch', groupId: ids.group, placeId: ids.school, room: 'Porch' });
    expect(camera.json.device).toMatchObject({ kind: 'camera', place: { placeId: ids.school }, room: 'Porch', group: { groupId: ids.group } });
    ids.camera = camera.json.device.deviceId;
    expect(await countRows(fx, "location_devices WHERE device_kind IN ('camera', 'drone')")).toBe(1);
  });

  it('a TV and a hub device carry the enroller\'s own namespace; a place outside the owner\'s reach is refused', async () => {
    const tv = await call(OWNER, 'POST', '/devices', { kind: 'tv', ref: 'Living room', placeId: ids.home });
    expect(tv.json.device).toMatchObject({ kind: 'tv', name: 'living-room', room: 'Living room', place: { placeId: ids.home } });
    ids.tv = tv.json.device.deviceId;
    const key = locationOwnerRefKey({ sub: OWNER, principalIssuer: MOCK_ISSUER });
    expect(await countRows(fx, 'location_devices WHERE device_id = $1 AND device_ref = $2', [ids.tv, `tv:${key}:living-room`])).toBe(1);
    const sameRoom = await call(STRANGER, 'POST', '/devices', { kind: 'tv', ref: 'Living room' });
    expect(sameRoom.status).toBe(201);
    ids.hub = (await call(OWNER, 'POST', '/devices', { kind: 'hub', ref: '4f1c2d9e-0000-4000-8000-000000000001' })).json.device.deviceId;
    expect((await call(OWNER, 'POST', '/devices', { kind: 'hub', ref: 'x', placeId: ids.strangerPlace })).json.error).toBe('place_not_assignable');
    expect((await call(OWNER, 'POST', '/devices', { kind: 'camera', ref: 'cam-yard', groupId: ids.group, placeId: ids.home })).json.error).toBe('place_not_assignable');
  });
});

describe('assigned place: the owner changes it, nobody else can', () => {
  it('the owner changes and clears a node\'s, a camera\'s and a TV\'s place', async () => {
    const cafe = (await call(OWNER, 'POST', '/places', { name: 'Cafe', center: { lat: -12.34, lon: -31.98 } })).json.place.placeId;
    for (const device of [ids.node, ids.tv]) {
      const moved = await call(OWNER, 'PUT', `/devices/${device}/place`, { placeId: cafe, room: 'Corner' });
      expect(moved.json.device).toMatchObject({ place: { placeId: cafe, name: 'Cafe' }, room: 'Corner' });
    }
    const camera = await call(OWNER, 'PUT', `/devices/${ids.camera}/place`, { placeId: ids.school, room: 'Gate' });
    expect(camera.json.device).toMatchObject({ place: { placeId: ids.school }, room: 'Gate' });
    expect((await call(OWNER, 'PUT', `/devices/${ids.camera}/place`, { placeId: cafe })).json.error).toBe('place_not_assignable');
    const cleared = await call(OWNER, 'PUT', `/devices/${ids.tv}/place`, { placeId: null, room: null });
    expect(cleared.json.device).toMatchObject({ place: null, room: null, placeAssignedAt: null });
    await call(OWNER, 'PUT', `/devices/${ids.tv}/place`, { placeId: ids.home });
  });

  it('a member sees the group camera view-only and cannot change it; nobody else finds any of the three', async () => {
    const seen = await call(MEMBER, 'GET', '/devices');
    expect(seen.json.devices.map((d: { deviceId: string; editable: boolean }) => [d.deviceId, d.editable]).sort())
      .toEqual([[ids.camera, false], [ids.groupNode, false]].sort());
    expect(seen.json.nodes).toEqual([{ clientId: 'node-member-laptop', enrolled: false }]);
    const before = (await fx.db.pool.query('SELECT device_id, place_id, room FROM location_devices ORDER BY device_id')).rows;
    expect((await call(MEMBER, 'PUT', `/devices/${ids.camera}/place`, { placeId: null })).json.error).toBe('not_device_owner');
    expect((await call(MEMBER, 'DELETE', `/devices/${ids.camera}`)).json.error).toBe('not_device_owner');
    for (const device of [ids.node, ids.tv]) expect((await call(MEMBER, 'PUT', `/devices/${device}/place`, { placeId: ids.school })).status).toBe(404);
    for (const device of [ids.node, ids.camera, ids.tv]) expect((await call(STRANGER, 'PUT', `/devices/${device}/place`, { placeId: null })).status).toBe(404);
    expect((await fx.db.pool.query('SELECT device_id, place_id, room FROM location_devices ORDER BY device_id')).rows).toEqual(before);
    expect(JSON.stringify(seen.json)).not.toMatch(COORDINATE_KEYS);
  });

  it('the owner removes a location record; the member cannot', async () => {
    expect((await call(OWNER, 'DELETE', `/devices/${ids.hub}`)).json).toEqual({ deviceId: ids.hub, deleted: true });
    expect(await countRows(fx, 'location_devices WHERE device_id = $1', [ids.hub])).toBe(0);
  });
});

describe('migration 176 identity fence, at the database', () => {
  const insertDevice = `INSERT INTO location_devices (device_kind, device_ref, owner_sub, principal_issuer, tenant_id) VALUES ($1, $2, $3, $4, $5)`;

  it('refuses a node without its owner\'s binding, even for an operator-stamped session, and SYSTEM', async () => {
    const who = { sub: STRANGER, issuer: MOCK_ISSUER, operator: true };
    expect(await inRolledBackTransaction(fx.runtime, who, (c) => sqlState(c.query(insertDevice, ['node', 'node-owner-desk-2', STRANGER, MOCK_ISSUER, null])))).toBe('42501');
    await seedNodeBinding(fx, 'node-owner-desk-2', OWNER);
    expect(await inRolledBackTransaction(fx.runtime, who, (c) => sqlState(c.query(insertDevice, ['node', 'node-owner-desk-2', STRANGER, MOCK_ISSUER, null])))).toBe('42501');
    expect(await inRolledBackTransaction(fx.runtime, { sub: OWNER, issuer: MOCK_ISSUER }, (c) => sqlState(c.query(insertDevice, ['node', 'node-owner-desk-2', OWNER, MOCK_ISSUER, null])))).toBe('resolved');
    expect(await inRolledBackTransaction(fx.runtime, { sub: '', issuer: null, operator: true }, (c) => sqlState(c.query(insertDevice, ['node', 'node-owner-desk-2', OWNER, MOCK_ISSUER, null])))).toBe('42501');
  });

  it('refuses another person\'s TV namespace, a person-owned camera, and a change of kind or reference', async () => {
    const theirKey = locationOwnerRefKey({ sub: OWNER, principalIssuer: MOCK_ISSUER });
    const stranger = { sub: STRANGER, issuer: MOCK_ISSUER };
    expect(await inRolledBackTransaction(fx.runtime, stranger, (c) => sqlState(c.query(insertDevice, ['tv', `tv:${theirKey}:den`, STRANGER, MOCK_ISSUER, null])))).toBe('42501');
    expect(await inRolledBackTransaction(fx.runtime, stranger, (c) => sqlState(c.query(insertDevice, ['camera', 'cam-mine', STRANGER, MOCK_ISSUER, null])))).toBe('23514');
    const owner = { sub: OWNER, issuer: MOCK_ISSUER };
    expect(await inRolledBackTransaction(fx.runtime, owner, (c) => sqlState(c.query("UPDATE location_devices SET device_ref = 'node-member-laptop' WHERE device_id = $1", [ids.node])))).toBe('42501');
    expect(await inRolledBackTransaction(fx.runtime, owner, (c) => sqlState(c.query("UPDATE location_devices SET device_kind = 'hub' WHERE device_id = $1", [ids.tv])))).toBe('42501');
  });
});

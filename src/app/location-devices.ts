/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4 (D1): enrolling an existing node, camera, drone, TV or smart-home hub device as a location_devices row, and setting or clearing its assigned place and room, from the Settings, Location tab. The row records who owns the device's LOCATION DATA and grants no control or execution right; canUseDevice and remote_task_journal_client_owners are untouched (ADR-114 is not amended). A node is enrolled only by its ADR-114 owner (the durable binding, checked here under the person's own row-level security and again by migration 176's identity fence), as the person's own or, when they are an admin of the group, as the group's. Cameras and drones have no owner record: only a group admin enrols one, and only to that group. A TV is named by the room its screen registers and a hub device by its id; both references carry the person's own namespace key, so nobody can claim another person's TV or hub device. The assigned place must be one the device's owner may use (their own or a group's place for a person's device, the same group's place for a group device). Only the owner, or a group admin for a group device, changes a device's place or room; everyone else is refused. Reporting stays off: a stationary device has an assigned place, not a track (D7), and a drone's credential arrives with L6.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The LOCATION_FLEET_ID_SHAPE doc names the spec that holds it equal to CAMERA_ID_RE and DRONE_ID_RE (tests/unit/location-fleet-id-shape.spec.ts, added in the same change).
 *
 * @module app/location-devices
 */

import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import { readLocationGroups, requireGroupAdmin, rethrowLocationWriteError, type LocationGroupView } from './location-places';
import { LocationRequestError, requireLocationId } from './location-request';

const log = createChildLogger({ module: 'location-devices' });

/** @description The kinds this tab enrols. Browsers opt in themselves (L3); phones enrol with a credential (L6/L9). */
export const LOCATION_PLACED_DEVICE_KINDS: readonly string[] = Object.freeze(['node', 'camera', 'drone', 'tv', 'hub']);

/** @description Kinds with no owner record: group-only (migration 176 CHECK). */
export const LOCATION_GROUP_ONLY_KINDS: readonly string[] = Object.freeze(['camera', 'drone']);

/**
 * @description The camera and drone fleet id shape. Equal to CAMERA_ID_RE and DRONE_ID_RE; it is
 * restated here so the location code does not import the drone slice (ADR-169 D3), and
 * tests/unit/location-fleet-id-shape.spec.ts fails if the three ever drift apart.
 */
export const LOCATION_FLEET_ID_SHAPE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** @description A hub device id: printable, no spaces (SmartThings ids are UUIDs). */
export const LOCATION_HUB_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** @description The longest room label a TV or a device's room may carry (the migration 175 CHECK is 80). */
const ROOM_MAX = 80;

/** @description One placed device as the Settings tab shows it. */
export interface LocationPlacedDeviceView {
  deviceId: string;
  kind: string;
  name: string;
  room: string | null;
  place: { placeId: string; name: string; label: string } | null;
  placeAssignedAt: string | null;
  group: { groupId: string; name: string | null } | null;
  editable: boolean;
}

/** @description A validated enrolment. */
export interface LocationEnrolInput {
  kind: string;
  ref: string;
  name: string;
  groupId: string | null;
  placeId: string | null;
  room: string | null;
}

type Row = Record<string, unknown>;

/**
 * @description The namespace key a person's TV and hub references carry. Must equal the SQL
 * location_owner_ref_key (migration 176): 16 hex characters of SHA-256 over issuer, newline, subject.
 * @param who - The person.
 * @returns The key.
 */
export function locationOwnerRefKey(who: LocationPrincipal): string {
  return crypto.createHash('sha256').update(`${who.principalIssuer}\n${who.sub}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * @description A room label as a reference segment: lower case, runs of other characters as one dash.
 * @param room - The label.
 * @returns The slug, or 'main' when nothing is left.
 */
export function locationRoomSlug(room: string): string {
  return room.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'main';
}

/**
 * @description The display name of a device from its stored reference (a namespaced TV or hub
 * reference shows only its own part).
 * @param kind - The device kind.
 * @param ref - The stored reference.
 * @returns The name.
 */
function nameFromRef(kind: string, ref: string): string {
  if (kind !== 'tv' && kind !== 'hub') return ref;
  return ref.split(':').slice(2).join(':') || ref;
}

/**
 * @description Whether text carries a control character (a label is one printable line).
 * @param text - The text.
 * @returns true when any code point is below U+0020 or is U+007F.
 */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * @description Read an optional room label.
 * @param value - The request value.
 * @returns null when absent or empty, else the trimmed label.
 * @throws {LocationRequestError} 400 invalid_room.
 */
export function optionalRoom(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > ROOM_MAX || hasControlCharacter(value)) {
    throw new LocationRequestError('invalid_room', 400, `room must be text of at most ${ROOM_MAX} characters.`);
  }
  return value.trim() || null;
}

/**
 * @description The stored reference for a kind, from the id the person names.
 * @param kind - The kind.
 * @param raw - The id or room the person gave.
 * @param who - The person (for the TV and hub namespace).
 * @returns The reference and the display name.
 * @throws {LocationRequestError} 400 invalid_ref.
 */
function referenceFor(kind: string, raw: unknown, who: LocationPrincipal): { ref: string; name: string } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const bad = (what: string): never => { throw new LocationRequestError('invalid_ref', 400, what); };
  if (kind === 'node') {
    if (!text || text.length > 200 || hasControlCharacter(text)) bad('A node is named by its client id.');
    return { ref: text, name: text };
  }
  if (kind === 'camera' || kind === 'drone') {
    if (!LOCATION_FLEET_ID_SHAPE.test(text)) bad(`A ${kind} id is 1 to 32 letters, digits, dashes or underscores.`);
    return { ref: text, name: text };
  }
  if (kind === 'hub') {
    if (!LOCATION_HUB_ID_SHAPE.test(text)) bad('A hub device is named by its device id.');
    return { ref: `hub:${locationOwnerRefKey(who)}:${text}`, name: text };
  }
  if (!text || text.length > 40) bad('A TV is named by the room its screen shows, up to 40 characters.');
  return { ref: `tv:${locationOwnerRefKey(who)}:${locationRoomSlug(text)}`, name: locationRoomSlug(text) };
}

/**
 * @description Validate an enrolment body for the signed-in person.
 * @param body - { kind, ref, groupId?, placeId?, room? }; for a TV, `ref` is the room its screen shows.
 * @param who - The person.
 * @returns The enrolment.
 * @throws {LocationRequestError} 400 for a bad kind, reference, id or room; 400 group_required for a camera or drone without a group.
 */
export function parseEnrolInput(body: unknown, who: LocationPrincipal): LocationEnrolInput {
  const input = (body && typeof body === 'object' ? body : {}) as Row;
  const kind = String(input.kind ?? '');
  if (!LOCATION_PLACED_DEVICE_KINDS.includes(kind)) {
    throw new LocationRequestError('invalid_kind', 400, 'kind must be node, camera, drone, tv or hub.');
  }
  const { ref, name } = referenceFor(kind, input.ref, who);
  const groupId = input.groupId === undefined || input.groupId === null || input.groupId === ''
    ? null : requireLocationId(input.groupId, 'invalid_group_id', 'groupId');
  if (LOCATION_GROUP_ONLY_KINDS.includes(kind) && !groupId) {
    throw new LocationRequestError('group_required', 400, `A ${kind} has no owner of its own: enrol it to a group you administer.`);
  }
  const placeId = input.placeId === undefined || input.placeId === null || input.placeId === ''
    ? null : requireLocationId(input.placeId, 'invalid_place_id', 'placeId');
  const room = optionalRoom(input.room) ?? (kind === 'tv' && typeof input.ref === 'string' ? optionalRoom(input.ref) : null);
  return { kind, ref, name, groupId, placeId, room };
}

const VIEW_SQL = `SELECT d.device_id, d.device_kind, d.device_ref, d.room, d.place_id, d.place_assigned_at, d.tenant_id,
    p.name AS place_name, p.label AS place_label, t.name AS group_name,
    location_row_writable(d.owner_sub, d.principal_issuer, d.tenant_id) AS editable
  FROM location_devices d
  LEFT JOIN location_places p ON p.place_id = d.place_id
  LEFT JOIN oshal_tenants t ON t.tenant_id = d.tenant_id
 WHERE d.device_kind = ANY($1::text[])`;

/**
 * @description Shape a device row for the page.
 * @param r - A row from {@link VIEW_SQL}.
 * @returns The view.
 */
function toPlacedView(r: Row): LocationPlacedDeviceView {
  const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  return {
    deviceId: String(r.device_id), kind: String(r.device_kind), name: nameFromRef(String(r.device_kind), String(r.device_ref)),
    room: r.room === null ? null : String(r.room),
    place: r.place_id && r.place_name ? { placeId: String(r.place_id), name: String(r.place_name), label: String(r.place_label) } : null,
    placeAssignedAt: iso(r.place_assigned_at),
    group: r.tenant_id ? { groupId: String(r.tenant_id), name: r.group_name === null ? null : String(r.group_name) } : null,
    editable: r.editable === true,
  };
}

/**
 * @description One placed device the person may read.
 * @param client - A client stamped as the person.
 * @param deviceId - The device.
 * @returns The view.
 * @throws {LocationRequestError} 404 device_not_found.
 */
async function readPlacedView(client: PoolClient, deviceId: string): Promise<LocationPlacedDeviceView> {
  const row = (await client.query(`${VIEW_SQL} AND d.device_id = $2`, [LOCATION_PLACED_DEVICE_KINDS, deviceId])).rows[0];
  if (!row) throw new LocationRequestError('device_not_found', 404, 'No such device of yours or your groups.');
  return toPlacedView(row);
}

/**
 * @description The person's placed devices and their groups', the nodes they own (to enrol), and their groups.
 * @param db - The pool.
 * @param principal - The person.
 * @returns Devices, candidate nodes and groups.
 */
export async function listPlacedDevices(db: LocationDb, principal: LocationPrincipal): Promise<{
  devices: LocationPlacedDeviceView[]; nodes: Array<{ clientId: string; enrolled: boolean }>; groups: LocationGroupView[];
}> {
  return withLocationOwnerSession(db, principal, async (client, who) => {
    const devices = (await client.query(`${VIEW_SQL} ORDER BY d.tenant_id NULLS FIRST, d.device_kind, d.device_ref`,
      [LOCATION_PLACED_DEVICE_KINDS])).rows.map(toPlacedView);
    const owned = (await client.query(`SELECT o.client_id,
        EXISTS (SELECT 1 FROM location_devices d WHERE d.device_kind = 'node' AND d.device_ref = o.client_id) AS enrolled
      FROM remote_task_journal_client_owners o WHERE o.owner_sub = $1 ORDER BY o.client_id`, [who.sub])).rows;
    return {
      devices,
      nodes: owned.map((r) => ({ clientId: String(r.client_id), enrolled: r.enrolled === true })),
      groups: await readLocationGroups(client, who),
    };
  });
}

/**
 * @description Refuse a place the device's owner may not use (their own or a group's place for a
 * person's device, the same group's place for a group device). Row-level security checks it again.
 * @param client - A client stamped as the person.
 * @param placeId - The place, or null for none.
 * @param owner - The device's owner columns.
 * @returns Nothing.
 * @throws {LocationRequestError} 400 place_not_assignable.
 */
async function requireAssignablePlace(client: PoolClient, placeId: string | null, owner: { sub: string | null; issuer: string | null; tenant: string | null }): Promise<void> {
  if (!placeId) return;
  const r = await client.query(`SELECT EXISTS (SELECT 1 FROM location_places WHERE place_id = $1)
      AND location_place_assignable($1, $2, $3, $4) AS ok`, [placeId, owner.sub, owner.issuer, owner.tenant]);
  if (r.rows[0]?.ok !== true) {
    throw new LocationRequestError('place_not_assignable', 400, 'That place is not one this device\'s owner can use.');
  }
}

/**
 * @description Refuse a node the person does not own under ADR-114, and hold the node's owner lock
 * (the registry's own advisory lock) so an owner change cannot interleave with the enrolment.
 * @param client - A client stamped as the person.
 * @param who - The person.
 * @param clientId - The node's client id.
 * @returns Nothing.
 * @throws {LocationRequestError} 404 node_not_found.
 */
async function requireOwnNode(client: PoolClient, who: LocationPrincipal, clientId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('remote-task-client:' || $1, 0))`, [clientId]);
  const r = await client.query('SELECT 1 FROM remote_task_journal_client_owners WHERE client_id = $1 AND owner_sub = $2', [clientId, who.sub]);
  if (!r.rows[0]) throw new LocationRequestError('node_not_found', 404, 'No node of yours has that id.');
}

/**
 * @description Enrol an existing device as a location_devices row (ADR-169 L4), with an optional
 * assigned place and room. The person's own row, or a group's when `groupId` names a group they administer.
 * @param db - The pool.
 * @param principal - The person.
 * @param input - A validated enrolment ({@link parseEnrolInput}).
 * @returns The enrolled device.
 * @throws {LocationRequestError} 403 group_admin_required, 404 node_not_found, 400 place_not_assignable, 409 already_exists.
 */
export async function enrolPlacedDevice(db: LocationDb, principal: LocationPrincipal, input: LocationEnrolInput): Promise<LocationPlacedDeviceView> {
  const device = await withLocationOwnerSession(db, principal, async (client, who) => {
    if (input.groupId) await requireGroupAdmin(client, input.groupId);
    if (input.kind === 'node') await requireOwnNode(client, who, input.ref);
    const owner = input.groupId ? { sub: null, issuer: null, tenant: input.groupId } : { sub: who.sub, issuer: who.principalIssuer, tenant: null };
    await requireAssignablePlace(client, input.placeId, owner);
    const inserted = await client.query(`INSERT INTO location_devices
        (device_kind, device_ref, owner_sub, principal_issuer, tenant_id, place_id, room, place_assigned_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6::uuid IS NULL THEN NULL ELSE NOW() END) RETURNING device_id`,
    [input.kind, input.ref, owner.sub, owner.issuer, owner.tenant, input.placeId, input.room]).catch(rethrowLocationWriteError);
    return readPlacedView(client, String(inserted.rows[0].device_id));
  });
  log.info({ op: 'device-enrol', outcome: device.group ? 'group' : 'person', deviceId: device.deviceId }, 'location device enrolled');
  return device;
}

/**
 * @description A placed device the person may change, with its owner columns.
 * @param client - A client stamped as the person.
 * @param deviceId - The device.
 * @returns The owner columns.
 * @throws {LocationRequestError} 404 device_not_found, 403 not_device_owner.
 */
async function writableDevice(client: PoolClient, deviceId: string): Promise<{ sub: string | null; issuer: string | null; tenant: string | null }> {
  const row = (await client.query(`SELECT owner_sub, principal_issuer, tenant_id,
      location_row_writable(owner_sub, principal_issuer, tenant_id) AS writable
    FROM location_devices WHERE device_id = $1 AND device_kind = ANY($2::text[])`, [deviceId, LOCATION_PLACED_DEVICE_KINDS])).rows[0];
  if (!row) throw new LocationRequestError('device_not_found', 404, 'No such device of yours or your groups.');
  if (row.writable !== true) throw new LocationRequestError('not_device_owner', 403, 'Only the device\'s owner, or an admin of its group, may change it.');
  return { sub: row.owner_sub ?? null, issuer: row.principal_issuer ?? null, tenant: row.tenant_id ? String(row.tenant_id) : null };
}

/**
 * @description Set or clear a placed device's assigned place and room. `since` moves only when the place changes.
 * @param db - The pool.
 * @param principal - The person.
 * @param deviceIdValue - The device.
 * @param body - { placeId: id | null, room: text | null }.
 * @returns The device after the change.
 * @throws {LocationRequestError} 404, 403 not_device_owner, 400 place_not_assignable.
 */
export async function setPlacedDevicePlace(db: LocationDb, principal: LocationPrincipal, deviceIdValue: unknown, body: unknown): Promise<LocationPlacedDeviceView> {
  const deviceId = requireLocationId(deviceIdValue);
  const input = (body && typeof body === 'object' ? body : {}) as Row;
  const placeId = input.placeId === undefined || input.placeId === null || input.placeId === ''
    ? null : requireLocationId(input.placeId, 'invalid_place_id', 'placeId');
  const room = optionalRoom(input.room);
  const device = await withLocationOwnerSession(db, principal, async (client) => {
    await requireAssignablePlace(client, placeId, await writableDevice(client, deviceId));
    await client.query(`UPDATE location_devices
        SET place_assigned_at = CASE WHEN place_id IS NOT DISTINCT FROM $2::uuid THEN place_assigned_at
                                     WHEN $2::uuid IS NULL THEN NULL ELSE NOW() END,
            place_id = $2, room = $3, updated_at = NOW()
      WHERE device_id = $1`, [deviceId, placeId, room]).catch(rethrowLocationWriteError);
    return readPlacedView(client, deviceId);
  });
  log.info({ op: 'device-place', outcome: device.place ? 'assigned' : 'cleared', deviceId, placeId }, 'location device place set');
  return device;
}

/**
 * @description Remove a placed device's location record. Its control and ownership elsewhere are untouched.
 * @param db - The pool.
 * @param principal - The person.
 * @param deviceIdValue - The device.
 * @returns What was removed.
 * @throws {LocationRequestError} 404, 403 not_device_owner.
 */
export async function unenrolPlacedDevice(db: LocationDb, principal: LocationPrincipal, deviceIdValue: unknown): Promise<{ deviceId: string; deleted: boolean }> {
  const deviceId = requireLocationId(deviceIdValue);
  const result = await withLocationOwnerSession(db, principal, async (client) => {
    await writableDevice(client, deviceId);
    const removed = await client.query('DELETE FROM location_devices WHERE device_id = $1', [deviceId]).catch(rethrowLocationWriteError);
    return { deviceId, deleted: (removed.rowCount ?? 0) === 1 };
  });
  log.info({ op: 'device-unenrol', outcome: result.deleted ? 'deleted' : 'none', deviceId }, 'location device unenrolled');
  return result;
}

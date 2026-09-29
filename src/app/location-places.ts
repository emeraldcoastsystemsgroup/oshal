/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4: a person's places, as the Settings, Location tab manages them. A place is a circle (centre plus radius, 50 m to 50 km) with a name, a label (home, work, grocery, other), an optional owner-typed address and an optional IANA time zone, owned by the person or by one of their groups. The list says which group a place belongs to and whether the caller may change it, and carries no centre and no address (only whether one is on file): the page shows places, not coordinates, and the address is operation-only (D3). Creating a group place, and changing or deleting one, needs the caller to be an admin of that group; a person's own places are theirs alone. Every statement runs in the person's own owner session (is_operator off), so row-level security decides, and the explicit admin check here only turns a refusal into a clear answer. Also the one mapping of a refused database write (row-level security or a fence, a duplicate, a failed CHECK) to a request refusal that the place and device services share.
 *
 * @module app/location-places
 */

import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { assertGeoPoint, type GeoPoint } from '@/shared/utils/geo';
import { withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import { LocationRequestError, requireLocationId } from './location-request';

const log = createChildLogger({ module: 'location-places' });

/** @description The labels a place may carry (the migration 175 CHECK). */
export const LOCATION_PLACE_LABELS: readonly string[] = Object.freeze(['home', 'work', 'grocery', 'other']);

/** @description Radius bounds, metres: the migration 175 CHECK (the 50 m trigger minimum of D4, and 50 km). */
export const LOCATION_PLACE_RADIUS_M = Object.freeze({ min: 50, max: 50_000 });

/** @description Default radii (D4/D6): 100 m for a person's place, 150 m for a group's. */
export const LOCATION_PLACE_DEFAULT_RADIUS_M = Object.freeze({ person: 100, group: 150 });

/** Decimal places a place centre is stored at: about 1 m, the finest class a fix can have. */
const CENTER_DECIMALS = 5;

/** @description A group the person belongs to. */
export interface LocationGroupView {
  groupId: string;
  name: string | null;
  admin: boolean;
}

/** @description One place as the Settings tab lists it: no centre, no address text. */
export interface LocationPlaceView {
  placeId: string;
  name: string;
  label: string;
  radiusM: number;
  hasAddress: boolean;
  timezone: string | null;
  group: { groupId: string; name: string | null } | null;
  editable: boolean;
  createdAt: string;
}

/** @description A validated place change. Absent fields are left as they are on an update. */
export interface LocationPlaceInput {
  name?: string;
  label?: string;
  radiusM?: number;
  center?: GeoPoint;
  address?: string | null;
  timezone?: string | null;
  groupId?: string | null;
}

type Row = Record<string, unknown>;

/**
 * @description Turn a refused database write into a request refusal. Row-level security and the
 * location fences answer 42501, a duplicate 23505, a failed CHECK 23514; anything else is rethrown.
 * @param error - What the statement threw.
 * @returns Never.
 * @throws {LocationRequestError} 403 forbidden, 409 already_exists or 400 invalid_value; or the original error.
 */
export function rethrowLocationWriteError(error: unknown): never {
  const code = (error as { code?: unknown })?.code;
  if (code === '42501') throw new LocationRequestError('forbidden', 403, 'That is not yours to change.');
  if (code === '23505') throw new LocationRequestError('already_exists', 409, 'That is already enrolled.');
  if (code === '23514') throw new LocationRequestError('invalid_value', 400, 'A value is out of range.');
  throw error;
}

/**
 * @description Read an optional text field.
 * @param value - The request value.
 * @param max - Maximum length.
 * @param field - The field name, for the message.
 * @returns undefined when absent, null when cleared, else the trimmed text.
 * @throws {LocationRequestError} 400 for a non-string or an over-long value.
 */
function optionalText(value: unknown, max: number, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new LocationRequestError(`invalid_${field}`, 400, `${field} must be text of at most ${max} characters.`);
  }
  return value.trim() || null;
}

/**
 * @description Read an IANA time zone, checked with the runtime's own zone database.
 * @param value - The request value.
 * @returns undefined, null, or the zone.
 * @throws {LocationRequestError} 400 invalid_timezone.
 */
function optionalTimezone(value: unknown): string | null | undefined {
  const zone = optionalText(value, 64, 'timezone');
  if (!zone) return zone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new LocationRequestError('invalid_timezone', 400, 'timezone must be an IANA time zone such as Europe/Paris.');
  }
  return zone;
}

/**
 * @description Read a place centre, rounded to about a metre.
 * @param value - { lat, lon }.
 * @returns The centre.
 * @throws {LocationRequestError} 400 invalid_center.
 */
function requireCenter(value: unknown): GeoPoint {
  const raw = (value && typeof value === 'object' ? value : {}) as { lat?: unknown; lon?: unknown };
  const point = { lat: raw.lat as number, lon: raw.lon as number };
  try {
    assertGeoPoint(point, 'center');
  } catch {
    throw new LocationRequestError('invalid_center', 400, 'center needs lat and lon as finite degrees in range.');
  }
  const round = (v: number): number => Math.round(v * 10 ** CENTER_DECIMALS) / 10 ** CENTER_DECIMALS;
  return { lat: round(point.lat), lon: round(point.lon) };
}

/**
 * @description Read the geometry and naming fields of a place.
 * @param input - The body.
 * @param out - The input being built.
 * @returns Nothing.
 * @throws {LocationRequestError} 400 for a bad name, label or radius.
 */
function readPlaceShape(input: Row, out: LocationPlaceInput): void {
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120) throw new LocationRequestError('invalid_name', 400, 'name must be 1 to 120 characters.');
    out.name = name;
  }
  if (input.label !== undefined) {
    if (!LOCATION_PLACE_LABELS.includes(String(input.label))) {
      throw new LocationRequestError('invalid_label', 400, 'label must be home, work, grocery or other.');
    }
    out.label = String(input.label);
  }
  if (input.radiusM !== undefined) {
    const r = input.radiusM;
    if (typeof r !== 'number' || !Number.isFinite(r) || r < LOCATION_PLACE_RADIUS_M.min || r > LOCATION_PLACE_RADIUS_M.max) {
      throw new LocationRequestError('invalid_radius', 400, `radiusM must be ${LOCATION_PLACE_RADIUS_M.min} to ${LOCATION_PLACE_RADIUS_M.max} metres.`);
    }
    out.radiusM = Math.round(r);
  }
  if (input.center !== undefined) out.center = requireCenter(input.center);
}

/**
 * @description Validate a place body. A new place needs a name and a centre; an update may name any subset.
 * @param body - The parsed JSON body.
 * @param mode - 'create' or 'update'.
 * @returns The validated input.
 * @throws {LocationRequestError} 400 for anything malformed; the message never echoes a value.
 */
export function parsePlaceInput(body: unknown, mode: 'create' | 'update'): LocationPlaceInput {
  const input = (body && typeof body === 'object' ? body : {}) as Row;
  const out: LocationPlaceInput = {};
  readPlaceShape(input, out);
  const address = optionalText(input.address, 500, 'address');
  if (address !== undefined) out.address = address;
  const timezone = optionalTimezone(input.timezone);
  if (timezone !== undefined) out.timezone = timezone;
  if (mode === 'create') {
    if (!out.name) throw new LocationRequestError('invalid_name', 400, 'name must be 1 to 120 characters.');
    if (!out.center) throw new LocationRequestError('invalid_center', 400, 'center needs lat and lon as finite degrees in range.');
    out.groupId = input.groupId === undefined || input.groupId === null ? null : requireLocationId(input.groupId, 'invalid_group_id', 'groupId');
  } else if (input.groupId !== undefined) {
    throw new LocationRequestError('group_fixed', 400, 'A place stays with its owner; create a new place instead.');
  }
  return out;
}

/**
 * @description The groups the person belongs to, with whether they are an admin there.
 * @param client - A client stamped as the person.
 * @param who - The person.
 * @returns The groups, by name.
 */
export async function readLocationGroups(client: PoolClient, who: LocationPrincipal): Promise<LocationGroupView[]> {
  const rows = (await client.query(`SELECT m.tenant_id, m.role, t.name FROM oshal_tenant_memberships m
      JOIN oshal_tenants t ON t.tenant_id = m.tenant_id WHERE m.user_sub = $1 ORDER BY t.name NULLS LAST, m.tenant_id`, [who.sub])).rows;
  return rows.map((r) => ({ groupId: String(r.tenant_id), name: r.name === null ? null : String(r.name), admin: r.role === 'admin' }));
}

/**
 * @description Refuse a group write by someone who is not that group's admin.
 * @param client - A client stamped as the person.
 * @param groupId - The group.
 * @returns Nothing.
 * @throws {LocationRequestError} 403 group_admin_required.
 */
export async function requireGroupAdmin(client: PoolClient, groupId: string): Promise<void> {
  const r = await client.query('SELECT oshal_is_tenant_admin($1) AS admin', [groupId]);
  if (r.rows[0]?.admin !== true) throw new LocationRequestError('group_admin_required', 403, 'Only an admin of that group may do that.');
}

const VIEW_SQL = `SELECT p.place_id, p.name, p.label, p.radius_m, p.address IS NOT NULL AS has_address, p.timezone,
    p.tenant_id, p.created_at, t.name AS group_name,
    (p.tenant_id IS NULL OR oshal_is_tenant_admin(p.tenant_id::text)) AS editable
  FROM location_places p LEFT JOIN oshal_tenants t ON t.tenant_id = p.tenant_id`;

/**
 * @description Shape a place row for the page.
 * @param r - A row from {@link VIEW_SQL}.
 * @returns The view.
 */
function toPlaceView(r: Row): LocationPlaceView {
  return {
    placeId: String(r.place_id), name: String(r.name), label: String(r.label), radiusM: Number(r.radius_m),
    hasAddress: r.has_address === true, timezone: r.timezone === null ? null : String(r.timezone),
    group: r.tenant_id ? { groupId: String(r.tenant_id), name: r.group_name === null ? null : String(r.group_name) } : null,
    editable: r.editable === true,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/**
 * @description One place the person may read, with whether they may change it.
 * @param client - A client stamped as the person.
 * @param placeId - The place.
 * @returns The view.
 * @throws {LocationRequestError} 404 place_not_found.
 */
async function readPlaceView(client: PoolClient, placeId: string): Promise<LocationPlaceView> {
  const row = (await client.query(`${VIEW_SQL} WHERE p.place_id = $1`, [placeId])).rows[0];
  if (!row) throw new LocationRequestError('place_not_found', 404, 'No such place of yours or your groups.');
  return toPlaceView(row);
}

/**
 * @description The person's places and their groups' places, and the groups themselves.
 * @param db - The pool.
 * @param principal - The person.
 * @returns Places (no centre, no address) and groups.
 */
export async function listLocationPlaces(db: LocationDb, principal: LocationPrincipal): Promise<{ places: LocationPlaceView[]; groups: LocationGroupView[] }> {
  return withLocationOwnerSession(db, principal, async (client, who) => ({
    places: (await client.query(`${VIEW_SQL} ORDER BY p.tenant_id NULLS FIRST, p.name, p.place_id`)).rows.map(toPlaceView),
    groups: await readLocationGroups(client, who),
  }));
}

/**
 * @description Create a place for the person, or for one of their groups when they are its admin.
 * @param db - The pool.
 * @param principal - The person.
 * @param input - A validated 'create' input.
 * @returns The new place.
 * @throws {LocationRequestError} 403 group_admin_required, or a mapped write refusal.
 */
export async function createLocationPlace(db: LocationDb, principal: LocationPrincipal, input: LocationPlaceInput): Promise<LocationPlaceView> {
  const center = input.center as GeoPoint;
  const place = await withLocationOwnerSession(db, principal, async (client, who) => {
    const group = input.groupId ?? null;
    if (group) await requireGroupAdmin(client, group);
    const radius = input.radiusM ?? (group ? LOCATION_PLACE_DEFAULT_RADIUS_M.group : LOCATION_PLACE_DEFAULT_RADIUS_M.person);
    const inserted = await client.query(`INSERT INTO location_places
        (owner_sub, principal_issuer, tenant_id, name, label, center_lat, center_lon, radius_m, address, timezone, created_by_sub)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING place_id`,
    [group ? null : who.sub, group ? null : who.principalIssuer, group, input.name, input.label ?? 'other',
      center.lat, center.lon, radius, input.address ?? null, input.timezone ?? null, who.sub]).catch(rethrowLocationWriteError);
    return readPlaceView(client, String(inserted.rows[0].place_id));
  });
  log.info({ op: 'place-create', outcome: place.group ? 'group' : 'person', placeId: place.placeId }, 'location place created');
  return place;
}

/**
 * @description The SET clause and parameters for the fields an update names.
 * @param input - A validated 'update' input.
 * @returns Clauses (from $2 on) and values.
 */
function updateClauses(input: LocationPlaceInput): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown): void => { values.push(value); sets.push(`${column} = $${values.length + 1}`); };
  if (input.name !== undefined) add('name', input.name);
  if (input.label !== undefined) add('label', input.label);
  if (input.radiusM !== undefined) add('radius_m', input.radiusM);
  if (input.center) { add('center_lat', input.center.lat); add('center_lon', input.center.lon); }
  if (input.address !== undefined) add('address', input.address);
  if (input.timezone !== undefined) add('timezone', input.timezone);
  return { sets, values };
}

/**
 * @description Change a place the person may change: their own, or a place of a group they administer.
 * @param db - The pool.
 * @param principal - The person.
 * @param placeIdValue - The place.
 * @param input - A validated 'update' input.
 * @returns The place after the change.
 * @throws {LocationRequestError} 404 place_not_found, 403 group_admin_required, 400 nothing_to_change.
 */
export async function updateLocationPlace(db: LocationDb, principal: LocationPrincipal, placeIdValue: unknown, input: LocationPlaceInput): Promise<LocationPlaceView> {
  const placeId = requireLocationId(placeIdValue, 'invalid_place_id', 'placeId');
  const { sets, values } = updateClauses(input);
  if (!sets.length) throw new LocationRequestError('nothing_to_change', 400, 'Name at least one field to change.');
  const place = await withLocationOwnerSession(db, principal, async (client) => {
    const before = await readPlaceView(client, placeId);
    if (!before.editable) throw new LocationRequestError('group_admin_required', 403, 'Only an admin of that group may do that.');
    await client.query(`UPDATE location_places SET ${sets.join(', ')}, updated_at = NOW() WHERE place_id = $1`, [placeId, ...values])
      .catch(rethrowLocationWriteError);
    return readPlaceView(client, placeId);
  });
  log.info({ op: 'place-update', outcome: 'ok', placeId, count: sets.length }, 'location place changed');
  return place;
}

/**
 * @description Delete a place the person may change. Devices and current rows that named it keep
 * their rows with no place (the foreign keys set it to null).
 * @param db - The pool.
 * @param principal - The person.
 * @param placeIdValue - The place.
 * @returns What was deleted.
 * @throws {LocationRequestError} 404 place_not_found, 403 group_admin_required.
 */
export async function deleteLocationPlace(db: LocationDb, principal: LocationPrincipal, placeIdValue: unknown): Promise<{ placeId: string; deleted: boolean }> {
  const placeId = requireLocationId(placeIdValue, 'invalid_place_id', 'placeId');
  const result = await withLocationOwnerSession(db, principal, async (client) => {
    const before = await readPlaceView(client, placeId);
    if (!before.editable) throw new LocationRequestError('group_admin_required', 403, 'Only an admin of that group may do that.');
    const removed = await client.query('DELETE FROM location_places WHERE place_id = $1', [placeId]).catch(rethrowLocationWriteError);
    return { placeId, deleted: (removed.rowCount ?? 0) === 1 };
  });
  log.info({ op: 'place-delete', outcome: result.deleted ? 'deleted' : 'none', placeId }, 'location place deleted');
  return result;
}

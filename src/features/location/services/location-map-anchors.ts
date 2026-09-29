/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L7 (D3 "Map anchors"): the two map operations of the location kernel skill. anchorMap records where a map was captured: the map by kind and reference (never its geometry), its geodetic origin minimised to the precision class its owner chose, its footprint, and the place it falls in, whether or not that is a saved place. mapsNear answers which maps the caller may read were captured within reach of a point, newest first, by reference only. The caller is ALWAYS the ambient request identity (the package route runs as the signed-in person), never an argument; SYSTEM and an identity without a verified issuer are refused. Every statement runs in withLocationOwnerSession as that person with the operator flag off, so row-level security (no operator branch, Q2) decides what exists. A group's map is anchored by an admin of that group and read by its members. The anchor grants nothing on the map it names: the map's own policies still decide who may open it. Neither operation returns or logs a coordinate.
 *
 * @module location/services/location-map-anchors
 */

import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  METRES_PER_DEGREE_LAT, assertGeoPoint, circleContains, haversineM, isLocationPrecisionClass, minimiseGeoPoint,
  precisionSlackM, type GeoPoint, type LocationPrecisionClass,
} from '@/shared/utils/geo';
import {
  LOCATION_ANCHOR_SOURCES, LOCATION_MAP_KINDS, LocationForbiddenError, LocationInputError, LocationNotFoundError,
  LocationPrecisionError,
  type LocationMapAnchorInput, type LocationMapAnchorResult, type LocationMapRef, type LocationPrincipal,
} from '../model/location-types';
import { withLocationOwnerSession, type LocationDb } from './location-owner-session';
import { callerLocationPrincipal } from './location-place-reads';

const log = createChildLogger({ module: 'location-map-anchors' });

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAP_REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** @description The smallest and largest footprint an anchor may carry, metres (the table's CHECK). */
export const LOCATION_MAP_FOOTPRINT_RANGE_M: Readonly<{ min: number; max: number }> = Object.freeze({ min: 1, max: 50_000 });

/** @description The smallest and largest reach mapsNear accepts, metres (the largest is the largest place radius). */
export const LOCATION_MAPS_NEAR_RADIUS_RANGE_M: Readonly<{ min: number; max: number }> = Object.freeze({ min: 1, max: 50_000 });

/** @description How many maps mapsNear returns when OSHAL_LOCATION_MAPS_NEAR_LIMIT is unset. */
export const LOCATION_MAPS_NEAR_DEFAULT_LIMIT = 50;

/** How far ahead of this server's clock a reported capture time may be. */
const CAPTURED_AT_FUTURE_SLACK_MS = 120_000;
const MAX_ACCURACY_M = 100_000;
const MAX_ALTITUDE_M = 100_000;
const MAPS_NEAR_LIMIT_CEILING = 200;

/** An anchor request after validation: nothing in it is trusted to name an owner. */
interface ParsedAnchor {
  mapKind: string;
  mapRef: string;
  point: GeoPoint;
  altM: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
  footprintRadiusM: number;
  source: string;
  capturedAt: Date;
  deviceId: string | null;
  placeId: string | null;
  groupId: string | null;
}

/** The owner columns an anchor row carries: a person's, or a group's. */
interface AnchorOwner {
  sub: string | null;
  issuer: string | null;
  tenant: string | null;
}

/**
 * @description The deployment's cap on how many maps one mapsNear call returns:
 * OSHAL_LOCATION_MAPS_NEAR_LIMIT, default 50, never above 200.
 * @returns The cap.
 */
export function locationMapsNearLimit(): number {
  const raw = Number(process.env.OSHAL_LOCATION_MAPS_NEAR_LIMIT);
  if (!Number.isFinite(raw) || raw < 1) return LOCATION_MAPS_NEAR_DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAPS_NEAR_LIMIT_CEILING);
}

/**
 * @description Refuse anything that is not a WGS-84 point.
 * @param point - The candidate.
 * @param what - Names the argument in the message (never the value).
 * @returns The point with only lat and lon.
 * @throws {LocationInputError} For a missing, non-finite or out-of-range coordinate.
 */
function requirePoint(point: unknown, what: string): GeoPoint {
  const candidate = (point && typeof point === 'object' ? point : {}) as { lat?: unknown; lon?: unknown };
  const clean = { lat: candidate.lat as number, lon: candidate.lon as number };
  try {
    assertGeoPoint(clean, what);
  } catch {
    throw new LocationInputError(`${what} needs lat and lon as finite degrees in range.`);
  }
  return clean;
}

/**
 * @description An optional id, lower-cased.
 * @param value - The candidate; null, undefined and '' mean "none".
 * @param what - What it names, for the message.
 * @returns The id, or null.
 * @throws {LocationInputError} For a value that is present and not an id.
 */
function optionalId(value: unknown, what: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !ID_SHAPE.test(value)) throw new LocationInputError(`${what} must be an id.`);
  return value.toLowerCase();
}

/**
 * @description An optional finite number inside a range.
 * @param value - The candidate; null and undefined mean "none".
 * @param what - What it names, for the message.
 * @param min - Smallest value accepted.
 * @param max - Largest value accepted.
 * @returns The number, or null.
 * @throws {LocationInputError} For a value that is present and not a number in range.
 */
function optionalNumber(value: unknown, what: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new LocationInputError(`${what} must be a number from ${min} to ${max}.`);
  }
  return value;
}

/**
 * @description When the map was captured.
 * @param value - An ISO time or a Date.
 * @param nowMs - The server clock.
 * @returns The time.
 * @throws {LocationInputError} For an unreadable time or one ahead of the server clock.
 */
function requireCapturedAt(value: unknown, nowMs: number): Date {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw new LocationInputError('capturedAt must be a time.');
  if (parsed.getTime() > nowMs + CAPTURED_AT_FUTURE_SLACK_MS) throw new LocationInputError('capturedAt is ahead of the server clock.');
  return parsed;
}

/**
 * @description Read an anchor request. Only the documented fields are read; none names an owner.
 * @param input - The request.
 * @param nowMs - The server clock.
 * @returns The validated request.
 * @throws {LocationInputError} For anything malformed; the message never echoes a value.
 */
function parseAnchor(input: LocationMapAnchorInput, nowMs: number): ParsedAnchor {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<LocationMapAnchorInput>;
  if (typeof raw.mapKind !== 'string' || !LOCATION_MAP_KINDS.includes(raw.mapKind)) throw new LocationInputError('mapKind must be a map kind.');
  if (typeof raw.mapRef !== 'string' || !MAP_REF_SHAPE.test(raw.mapRef)) throw new LocationInputError('mapRef must name a map.');
  if (typeof raw.source !== 'string' || !LOCATION_ANCHOR_SOURCES.includes(raw.source)) throw new LocationInputError('source must be an anchor source.');
  const anchor = (raw.anchor && typeof raw.anchor === 'object' ? raw.anchor : {}) as LocationMapAnchorInput['anchor'];
  const footprint = optionalNumber(raw.footprintRadiusM, 'footprintRadiusM', LOCATION_MAP_FOOTPRINT_RANGE_M.min, LOCATION_MAP_FOOTPRINT_RANGE_M.max);
  if (footprint === null) throw new LocationInputError('footprintRadiusM is required.');
  const heading = optionalNumber(anchor.headingDeg, 'headingDeg', 0, 360);
  return {
    mapKind: raw.mapKind,
    mapRef: raw.mapRef,
    point: requirePoint(anchor, 'anchor'),
    altM: optionalNumber(anchor.altM, 'altM', -MAX_ALTITUDE_M, MAX_ALTITUDE_M),
    headingDeg: heading === null ? null : (Math.round(heading * 10) / 10) % 360,
    accuracyM: optionalNumber(anchor.accuracyM, 'accuracyM', 0, MAX_ACCURACY_M),
    footprintRadiusM: Math.ceil(footprint),
    source: raw.source,
    capturedAt: requireCapturedAt(raw.capturedAt, nowMs),
    deviceId: optionalId(raw.deviceId, 'deviceId'),
    placeId: optionalId(raw.placeId, 'placeId'),
    groupId: optionalId(raw.groupId, 'groupId'),
  };
}

/**
 * @description Refuse an anchor the session may not write: a group it does not administer, a map
 * that is not the owner's, or a device outside the owner's scope. Row-level security refuses the
 * same things; checking first turns a policy error into a named refusal.
 * @param client - A client stamped as the caller.
 * @param a - The request.
 * @param owner - The anchor's owner columns.
 * @returns Nothing.
 * @throws {LocationForbiddenError} or {LocationNotFoundError}.
 */
async function requireWritable(client: PoolClient, a: ParsedAnchor, owner: AnchorOwner): Promise<void> {
  if (owner.tenant) {
    const admin = await client.query('SELECT oshal_is_tenant_admin($1) AS ok', [owner.tenant]);
    if (admin.rows[0]?.ok !== true) throw new LocationForbiddenError();
  }
  const map = await client.query('SELECT location_map_anchorable($1, $2, $3, $4::uuid) AS ok', [a.mapKind, a.mapRef, owner.sub, owner.tenant]);
  if (map.rows[0]?.ok !== true) throw new LocationNotFoundError('map');
  if (!a.deviceId) return;
  const device = await client.query(`SELECT 1 FROM location_devices WHERE device_id = $1
      AND tenant_id IS NOT DISTINCT FROM $2::uuid AND owner_sub IS NOT DISTINCT FROM $3 AND principal_issuer IS NOT DISTINCT FROM $4`,
  [a.deviceId, owner.tenant, owner.sub, owner.issuer]);
  if (!device.rows[0]) throw new LocationNotFoundError('device');
}

/**
 * @description The precision class the anchor is stored at: what its owner chose (migration 179's
 * location_map_anchor_class, the same function the write policy compares against).
 * @param client - A client stamped as the caller.
 * @param a - The request.
 * @param owner - The anchor's owner columns.
 * @returns exact, block or city.
 * @throws {LocationPrecisionError} When the owner's class is place-only, which stores no coordinates.
 */
async function anchorClass(client: PoolClient, a: ParsedAnchor, owner: AnchorOwner): Promise<LocationPrecisionClass> {
  const row = await client.query('SELECT location_map_anchor_class($1, $2, $3::uuid, $4::uuid) AS cls',
    [owner.sub, owner.issuer, owner.tenant, a.deviceId]);
  const cls = String(row.rows[0]?.cls ?? '');
  if (!isLocationPrecisionClass(cls) || cls === 'place-only') throw new LocationPrecisionError();
  return cls;
}

/**
 * @description The place the anchor is grouped under: the one the request names, when the owner may
 * use it, else the smallest place of the owner that contains the full-precision origin.
 * @param client - A client stamped as the caller (row-level security limits the places read).
 * @param a - The request.
 * @param owner - The anchor's owner columns.
 * @returns The place id, or null when the origin is outside every saved place.
 * @throws {LocationNotFoundError} When the named place is not the owner's to use.
 */
async function anchorPlace(client: PoolClient, a: ParsedAnchor, owner: AnchorOwner): Promise<string | null> {
  if (a.placeId) {
    const named = await client.query(`SELECT 1 FROM location_places
       WHERE place_id = $1 AND location_place_assignable(place_id, $2, $3, $4::uuid)`, [a.placeId, owner.sub, owner.issuer, owner.tenant]);
    if (!named.rows[0]) throw new LocationNotFoundError('place');
    return a.placeId;
  }
  const rows = await client.query(`SELECT place_id, center_lat, center_lon, radius_m FROM location_places
     WHERE location_place_assignable(place_id, $1, $2, $3::uuid) ORDER BY radius_m, place_id`, [owner.sub, owner.issuer, owner.tenant]);
  const inside = rows.rows.find((r) => circleContains(
    { center: { lat: Number(r.center_lat), lon: Number(r.center_lon) }, radiusM: Number(r.radius_m) }, a.point));
  return inside ? String(inside.place_id) : null;
}

const UPSERT_ANCHOR = `INSERT INTO location_map_anchors
    (owner_sub, principal_issuer, tenant_id, map_kind, map_ref, precision_class, origin_lat, origin_lon, origin_alt_m,
     heading_deg, footprint_radius_m, accuracy_m, anchor_source, captured_by_device_id, captured_at, place_id, created_by_sub)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  ON CONFLICT (map_kind, map_ref) DO UPDATE SET
    precision_class = EXCLUDED.precision_class, origin_lat = EXCLUDED.origin_lat, origin_lon = EXCLUDED.origin_lon,
    origin_alt_m = EXCLUDED.origin_alt_m, heading_deg = EXCLUDED.heading_deg, footprint_radius_m = EXCLUDED.footprint_radius_m,
    accuracy_m = EXCLUDED.accuracy_m, anchor_source = EXCLUDED.anchor_source,
    captured_by_device_id = EXCLUDED.captured_by_device_id, captured_at = EXCLUDED.captured_at, place_id = EXCLUDED.place_id,
    updated_at = NOW()
  RETURNING anchor_id, place_id`;

/**
 * @description Write the anchor as the caller: checked, minimised, placed, then upserted by map.
 * @param client - A client stamped as the caller.
 * @param who - The caller.
 * @param a - The validated request.
 * @returns The anchor id and its place id.
 * @throws {LocationForbiddenError}, {LocationNotFoundError} or {LocationPrecisionError}.
 */
async function writeAnchor(client: PoolClient, who: LocationPrincipal, a: ParsedAnchor): Promise<LocationMapAnchorResult> {
  const owner: AnchorOwner = a.groupId
    ? { sub: null, issuer: null, tenant: a.groupId }
    : { sub: who.sub, issuer: who.principalIssuer, tenant: null };
  await requireWritable(client, a, owner);
  const cls = await anchorClass(client, a, owner);
  const placeId = await anchorPlace(client, a, owner);
  const stored = minimiseGeoPoint(a.point, cls) as { lat: number; lon: number };
  const row = await client.query(UPSERT_ANCHOR, [
    owner.sub, owner.issuer, owner.tenant, a.mapKind, a.mapRef, cls, stored.lat, stored.lon,
    cls === 'exact' && a.altM !== null ? Math.round(a.altM) : null, a.headingDeg, a.footprintRadiusM,
    a.accuracyM === null ? null : Math.round(a.accuracyM), a.source, a.deviceId, a.capturedAt, placeId, who.sub,
  ]);
  return { anchorId: String(row.rows[0].anchor_id), placeId: row.rows[0].place_id ? String(row.rows[0].place_id) : null };
}

/**
 * @description anchorMap (ADR-169 D3): record where a map was captured. The anchor holds the map by
 * kind and reference, its origin minimised to the precision class its owner chose, its footprint
 * and the place it falls in (the one named, else the smallest of the owner's places that contains
 * the origin, else none). Anchoring a map again replaces its anchor. A group's map (`groupId`) is
 * anchored by an admin of that group.
 * @param db - The pool.
 * @param input - The map, its geodetic anchor and footprint.
 * @param nowMs - The server clock.
 * @returns The anchor id and the place id; never a coordinate.
 * @throws {LocationInputError} For malformed input; {LocationNotFoundError} for a map, device or
 * place that is not the owner's; {LocationForbiddenError} for a group the caller does not
 * administer; {LocationPrecisionError} when the owner's class stores no coordinates;
 * {LocationPrincipalError} without a signed-in caller with a verified issuer.
 */
export async function anchorMap(db: LocationDb, input: LocationMapAnchorInput, nowMs: number = Date.now()): Promise<LocationMapAnchorResult> {
  const started = Date.now();
  const parsed = parseAnchor(input, nowMs);
  const result = await withLocationOwnerSession(db, callerLocationPrincipal(), (client, who) => writeAnchor(client, who, parsed));
  log.info({ op: 'anchor-map', outcome: result.placeId ? 'at-place' : 'no-place', anchorId: result.anchorId,
    mapRef: parsed.mapRef, durationMs: Date.now() - started }, 'location map anchored');
  return result;
}

/**
 * @description The anchors within reach of a point among those the session may read, newest first.
 * The latitude band in SQL only narrows the rows; the great-circle test decides.
 * @param client - A client stamped as the caller.
 * @param where - The point.
 * @param reachM - The radius asked for.
 * @returns The map references.
 */
async function anchorsWithin(client: PoolClient, where: GeoPoint, reachM: number): Promise<LocationMapRef[]> {
  const widest = precisionSlackM({ lat: 0, lon: 0 }, 'city');
  const rows = await client.query(`SELECT map_kind, map_ref, captured_at, place_id, origin_lat, origin_lon, footprint_radius_m, precision_class
      FROM location_map_anchors
     WHERE abs(origin_lat - $1) * $2 <= $3 + footprint_radius_m
     ORDER BY captured_at DESC, anchor_id`, [where.lat, METRES_PER_DEGREE_LAT, reachM + widest]);
  return rows.rows.filter((r) => {
    const origin = { lat: Number(r.origin_lat), lon: Number(r.origin_lon) };
    const cls = String(r.precision_class);
    const slack = isLocationPrecisionClass(cls) ? precisionSlackM(origin, cls) : 0;
    return haversineM(where, origin) <= reachM + Number(r.footprint_radius_m) + slack;
  }).map((r) => ({
    mapKind: String(r.map_kind),
    mapRef: String(r.map_ref),
    capturedAt: new Date(r.captured_at).toISOString(),
    placeId: r.place_id ? String(r.place_id) : null,
  }));
}

/**
 * @description mapsNear (ADR-169 D3): the maps the caller may read (their own and their groups')
 * whose anchor lies within `radiusM` plus the map's footprint of a point, newest first. A map
 * anchored at a coarser precision class is matched with the rounding of that class allowed for.
 * @param db - The pool.
 * @param point - The point, { lat, lon } in degrees.
 * @param radiusM - The reach, metres (1 to 50 000).
 * @returns Map references (kind, reference, captured at, place id); never a coordinate or a distance.
 * @throws {LocationInputError} For a bad point or radius; {LocationPrincipalError} without a signed-in caller.
 */
export async function mapsNear(db: LocationDb, point: GeoPoint, radiusM: number): Promise<LocationMapRef[]> {
  const started = Date.now();
  const where = requirePoint(point, 'point');
  const reach = optionalNumber(radiusM, 'radiusM', LOCATION_MAPS_NEAR_RADIUS_RANGE_M.min, LOCATION_MAPS_NEAR_RADIUS_RANGE_M.max);
  if (reach === null) throw new LocationInputError('radiusM is required.');
  const found = await withLocationOwnerSession(db, callerLocationPrincipal(), (client) => anchorsWithin(client, where, reach));
  const maps = found.slice(0, locationMapsNearLimit());
  log.info({ op: 'maps-near', outcome: maps.length ? 'found' : 'none', count: maps.length, durationMs: Date.now() - started }, 'location mapsNear read');
  return maps;
}

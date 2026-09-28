/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4 (D3 "Kernel skill operations"): the four package-facing reads. placeAt answers which of the caller's places (their own and their groups') contain a point; currentPlace answers where the caller, or a device the caller may read, is (a place by reference, since when, how old the fix is); distanceBand answers how far that subject is from one of the caller's places as a band (at, <1 km, <10 km, farther, unknown); operationAddress hands server code the owner-typed address and centre of one of the caller's places, for a fixed-server provider operation or the owner's own page only. The caller is ALWAYS the ambient request identity (the package route runs as the signed-in person), never an argument, so a package cannot read as someone else by naming them; SYSTEM and an identity without a verified issuer are refused. Every statement runs in withLocationOwnerSession as that person with is_operator off, so row-level security (no operator branch, Q2) decides what exists: a place or device the caller may not read is "not found", exactly as one that does not exist. The model-safe reads return no coordinate, address or trail.
 *
 * @module location/services/location-place-reads
 */

import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getRequestIdentity } from '@/shared/services/database/request-identity';
import {
  assertGeoPoint, circleContains, distanceBand as bandBetween, type DistanceBand, type GeoCircle, type GeoPoint,
} from '@/shared/utils/geo';
import {
  LocationInputError, LocationNotFoundError, LocationPrincipalError,
  type LocationCurrentPlace, type LocationOperationAddress, type LocationPlaceRef, type LocationPrincipal, type LocationSubject,
} from '../model/location-types';
import { requireLocationPrincipal, withLocationOwnerSession, type LocationDb } from './location-owner-session';

const log = createChildLogger({ module: 'location-place-reads' });

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @description How old a subject's latest fix may be before distanceBand answers `unknown`, when
 * OSHAL_LOCATION_BAND_MAX_AGE_SEC is unset. Fifteen minutes is about how long a person walking
 * takes to cross the 1 km band, so an older fix can no longer place them in the right band.
 */
export const LOCATION_BAND_MAX_AGE_DEFAULT_SEC = 900;

/** A subject's position as the reads resolve it, in memory only. */
interface SubjectPosition {
  basis: LocationCurrentPlace['basis'];
  place: LocationPlaceRef | null;
  since: Date | null;
  receivedAt: Date | null;
  point: GeoPoint | null;
}

/** A place row as the reads select it. */
type PlaceRow = { place_id: unknown; name: unknown; label: unknown; center_lat: unknown; center_lon: unknown; radius_m: unknown };

const PLACE_COLUMNS = 'place_id, name, label, center_lat, center_lon, radius_m';

/**
 * @description The deployment's band freshness window: OSHAL_LOCATION_BAND_MAX_AGE_SEC, default 900 s.
 * @returns Milliseconds.
 */
export function locationBandMaxAgeMs(): number {
  const raw = Number(process.env.OSHAL_LOCATION_BAND_MAX_AGE_SEC);
  const seconds = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 86_400) : LOCATION_BAND_MAX_AGE_DEFAULT_SEC;
  return Math.round(seconds * 1000);
}

/**
 * @description The person a package-facing read acts for: the ambient request identity, which the
 * request middleware (or a package route running as the caller) established. Never an argument.
 * @returns The caller's subject and verified issuer.
 * @throws {LocationPrincipalError} With no identity, the SYSTEM identity, or no verified issuer.
 */
export function callerLocationPrincipal(): LocationPrincipal {
  const identity = getRequestIdentity();
  if (!identity || identity.system === true) throw new LocationPrincipalError();
  return requireLocationPrincipal({ sub: identity.sub ?? '', principalIssuer: identity.principalIssuer ?? '' });
}

/**
 * @description Refuse anything that is not a WGS-84 point.
 * @param point - The candidate.
 * @returns The point with only lat and lon.
 * @throws {LocationInputError} For a missing, non-finite or out-of-range coordinate.
 */
function requirePoint(point: unknown): GeoPoint {
  const candidate = (point && typeof point === 'object' ? point : {}) as { lat?: unknown; lon?: unknown };
  const clean = { lat: candidate.lat as number, lon: candidate.lon as number };
  try {
    assertGeoPoint(clean, 'point');
  } catch {
    throw new LocationInputError('A point needs lat and lon as finite degrees in range.');
  }
  return clean;
}

/**
 * @description Refuse anything that is not a location id.
 * @param value - The candidate id.
 * @param what - What it names, for the message.
 * @returns The id, lower-cased.
 * @throws {LocationInputError} For a malformed id.
 */
function requireId(value: unknown, what: 'placeId' | 'deviceId'): string {
  if (typeof value !== 'string' || !ID_SHAPE.test(value)) throw new LocationInputError(`${what} must be an id.`);
  return value.toLowerCase();
}

/**
 * @description Shape a place row as a reference.
 * @param row - A row with place_id, name and label.
 * @returns The reference.
 */
function refOf(row: { place_id: unknown; name: unknown; label: unknown }): LocationPlaceRef {
  return { placeId: String(row.place_id), name: String(row.name), label: String(row.label) };
}

/**
 * @description A place row's circle.
 * @param row - A row with the centre and radius.
 * @returns The circle.
 */
function circleOf(row: PlaceRow): GeoCircle {
  return { center: { lat: Number(row.center_lat), lon: Number(row.center_lon) }, radiusM: Number(row.radius_m) };
}

/**
 * @description One place the session may read, or null.
 * @param client - A client stamped as the caller.
 * @param placeId - The place.
 * @returns The row, or null when it does not exist or is not the caller's to read.
 */
async function readablePlace(client: PoolClient, placeId: string): Promise<(PlaceRow & { address: unknown; timezone: unknown }) | null> {
  const r = await client.query(`SELECT ${PLACE_COLUMNS}, address, timezone FROM location_places WHERE place_id = $1`, [placeId]);
  return r.rows[0] ?? null;
}

/**
 * @description The subject's latest fix, if it has a current row the caller may read.
 * @param client - A client stamped as the caller.
 * @param who - The caller.
 * @param subjectRef - The subject: the caller's own sub, or `device:<id>`.
 * @returns The observed position, or null.
 */
async function observedPosition(client: PoolClient, who: LocationPrincipal, subjectRef: string): Promise<SubjectPosition | null> {
  const self = subjectRef === who.sub;
  const r = await client.query(`SELECT c.place_id, c.place_since, c.received_at, c.lat, c.lon, p.name, p.label
      FROM location_current c LEFT JOIN location_places p ON p.place_id = c.place_id
     WHERE c.subject_ref = $1 ${self ? 'AND c.tenant_id IS NULL AND c.owner_sub = $1 AND c.principal_issuer = $2' : ''}
     ORDER BY c.received_at DESC LIMIT 1`, self ? [subjectRef, who.principalIssuer] : [subjectRef]);
  const row = r.rows[0];
  if (!row) return null;
  const receivedAt = new Date(row.received_at);
  return {
    basis: 'observed',
    place: row.place_id && row.name ? refOf(row) : null,
    since: row.place_since ? new Date(row.place_since) : receivedAt,
    receivedAt,
    point: row.lat === null || row.lon === null ? null : { lat: Number(row.lat), lon: Number(row.lon) },
  };
}

/**
 * @description A device the caller may read: its latest fix when it reports, else its assigned place.
 * @param client - A client stamped as the caller.
 * @param who - The caller.
 * @param deviceId - The device.
 * @returns Its position.
 * @throws {LocationNotFoundError} When the device does not exist or is not the caller's to read.
 */
async function devicePosition(client: PoolClient, who: LocationPrincipal, deviceId: string): Promise<SubjectPosition> {
  const r = await client.query(`SELECT d.place_id, d.place_assigned_at, p.name, p.label, p.center_lat, p.center_lon, p.radius_m
      FROM location_devices d LEFT JOIN location_places p ON p.place_id = d.place_id WHERE d.device_id = $1`, [deviceId]);
  const row = r.rows[0];
  if (!row) throw new LocationNotFoundError('device');
  const observed = await observedPosition(client, who, `device:${deviceId}`);
  if (observed) return observed;
  if (!row.place_id || !row.name) return { basis: 'none', place: null, since: null, receivedAt: null, point: null };
  return {
    basis: 'assigned',
    place: refOf(row),
    since: row.place_assigned_at ? new Date(row.place_assigned_at) : null,
    receivedAt: null,
    point: circleOf(row).center,
  };
}

/**
 * @description Resolve a subject the caller may read to its position.
 * @param client - A client stamped as the caller.
 * @param who - The caller.
 * @param subject - 'self' or { deviceId }.
 * @returns The position.
 * @throws {LocationInputError} For a malformed subject; {LocationNotFoundError} for a device the caller may not read.
 */
async function subjectPosition(client: PoolClient, who: LocationPrincipal, subject: LocationSubject): Promise<SubjectPosition> {
  if (subject === 'self') {
    return (await observedPosition(client, who, who.sub)) ?? { basis: 'none', place: null, since: null, receivedAt: null, point: null };
  }
  if (!subject || typeof subject !== 'object') throw new LocationInputError('subject must be "self" or { deviceId }.');
  return devicePosition(client, who, requireId(subject.deviceId, 'deviceId'));
}

/**
 * @description placeAt (ADR-169 D3): the caller's places (their own and their groups') that
 * contain a point, smallest first. An edge point counts as inside.
 * @param db - The pool.
 * @param point - The point, { lat, lon } in degrees.
 * @returns Place references, never geometry.
 * @throws {LocationInputError} For a bad point; {LocationPrincipalError} without a signed-in caller.
 */
export async function placeAt(db: LocationDb, point: GeoPoint): Promise<LocationPlaceRef[]> {
  const started = Date.now();
  const where = requirePoint(point);
  const rows = await withLocationOwnerSession(db, callerLocationPrincipal(), async (client) =>
    (await client.query(`SELECT ${PLACE_COLUMNS} FROM location_places`)).rows as PlaceRow[]);
  const inside = rows.map((row) => ({ row, circle: circleOf(row) })).filter(({ circle }) => circleContains(circle, where))
    .sort((a, b) => a.circle.radiusM - b.circle.radiusM || String(a.row.name).localeCompare(String(b.row.name)));
  log.info({ op: 'place-at', outcome: inside.length ? 'found' : 'none', count: inside.length, durationMs: Date.now() - started }, 'location placeAt read');
  return inside.map(({ row }) => refOf(row));
}

/**
 * @description currentPlace (ADR-169 D3): where the caller, or a device the caller may read, is.
 * @param db - The pool.
 * @param subject - 'self' (the default) or { deviceId }.
 * @param nowMs - The clock, for the age.
 * @returns The place by reference, since when, the fix's age and the basis; no coordinate.
 * @throws {LocationInputError}, {LocationNotFoundError} or {LocationPrincipalError}.
 */
export async function currentPlace(db: LocationDb, subject: LocationSubject = 'self', nowMs: number = Date.now()): Promise<LocationCurrentPlace> {
  const position = await withLocationOwnerSession(db, callerLocationPrincipal(), (client, who) => subjectPosition(client, who, subject));
  log.info({ op: 'current-place',
    outcome: position.basis === 'observed' ? 'observed' : position.basis === 'assigned' ? 'assigned' : 'none' }, 'location currentPlace read');
  return {
    place: position.place,
    since: position.since ? position.since.toISOString() : null,
    ageSeconds: position.receivedAt ? Math.max(0, Math.round((nowMs - position.receivedAt.getTime()) / 1000)) : null,
    basis: position.basis,
  };
}

/**
 * @description The band for a resolved position against one place.
 * @param position - The subject's position.
 * @param place - The place row.
 * @param nowMs - The clock.
 * @returns The band.
 */
function bandFor(position: SubjectPosition, place: PlaceRow, nowMs: number): DistanceBand {
  if (position.basis === 'none') return 'unknown';
  if (position.receivedAt && nowMs - position.receivedAt.getTime() > locationBandMaxAgeMs()) return 'unknown';
  if (position.place?.placeId === String(place.place_id)) return 'at';
  return position.point ? bandBetween(position.point, circleOf(place)) : 'unknown';
}

/**
 * @description distanceBand (ADR-169 D3): how far a subject the caller may read is from one of the
 * caller's places. `at` when its latest fix fell in the place or its stored position is inside it;
 * `unknown` with no position, a position stored at place-only precision elsewhere, or a fix older
 * than {@link locationBandMaxAgeMs}. A stationary device is placed at its assigned place's centre.
 * @param db - The pool.
 * @param subject - 'self' or { deviceId }.
 * @param placeId - The place.
 * @param nowMs - The clock.
 * @returns at, <1 km, <10 km, farther or unknown; never a distance or a coordinate.
 * @throws {LocationInputError}, {LocationNotFoundError} or {LocationPrincipalError}.
 */
export async function distanceBand(db: LocationDb, subject: LocationSubject, placeId: string, nowMs: number = Date.now()): Promise<DistanceBand> {
  const id = requireId(placeId, 'placeId');
  const band = await withLocationOwnerSession(db, callerLocationPrincipal(), async (client, who) => {
    const place = await readablePlace(client, id);
    if (!place) throw new LocationNotFoundError('place');
    return bandFor(await subjectPosition(client, who, subject), place, nowMs);
  });
  log.info({ op: 'distance-band', outcome: band === 'unknown' ? 'unknown' : 'known', placeId: id }, 'location distanceBand read');
  return band;
}

/**
 * @description operationAddress (ADR-169 D3): the owner-typed address and centre of one of the
 * caller's places. OPERATION-ONLY: server code may pass these into a fixed-server provider
 * operation or the owner's own page, never into a prompt. No /api/location route returns them.
 * @param db - The pool.
 * @param placeId - The place.
 * @returns Address (or null), centre and time zone.
 * @throws {LocationInputError}, {LocationNotFoundError} or {LocationPrincipalError}.
 */
export async function operationAddress(db: LocationDb, placeId: string): Promise<LocationOperationAddress> {
  const id = requireId(placeId, 'placeId');
  const place = await withLocationOwnerSession(db, callerLocationPrincipal(), async (client) => readablePlace(client, id));
  if (!place) throw new LocationNotFoundError('place');
  log.info({ op: 'operation-address', outcome: place.address ? 'address' : 'centre-only', placeId: id }, 'location operationAddress read');
  return {
    placeId: id,
    address: place.address === null || place.address === undefined ? null : String(place.address),
    center: { lat: Number(place.center_lat), lon: Number(place.center_lon) },
    timezone: place.timezone === null || place.timezone === undefined ? null : String(place.timezone),
  };
}

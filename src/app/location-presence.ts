/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3 (D3 "Browser ingest"): a browser fix from the signed-in person. The parser reads exactly deviceId, lat, lon, accuracyM and observedAt from the body and nothing else, so an owner, subject, issuer, source, precision or place a caller puts in the body never reaches a statement; the owner is the session principal the router passes in. The fix is accepted only for the person's own opted-in browser device, at most once per minimum interval per device. It is placed against the places the person can see (their own and their groups') at full precision in memory, then minimised to the device's precision class before anything is written (D3 "Precision minimisation"): the observation (history, kept until the owner purges it, Q4), the person's location_current row and the device's last_seen_at, in one transaction under the person's own identity.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4: the current row keeps place_since (migration 176), the time its place last changed, so currentPlace and the Settings tab can say "since". A fix in the same place (or in no place, again) keeps it; a fix in a different place moves it to this fix's receipt time.
 *
 * @module app/location-presence
 */

import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  assertGeoPoint, circleContains, isLocationPrecisionClass, minimiseGeoPoint, type GeoPoint, type LocationPrecisionClass,
} from '@/shared/utils/geo';
import { withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import type { LocationPlaceRef } from './location-overview';
import { LocationRequestError, requireLocationId } from './location-request';

const log = createChildLogger({ module: 'location-presence' });

/** @description The only body fields a browser fix is read from. Anything else is ignored. */
export const LOCATION_FIX_FIELDS: readonly string[] = Object.freeze(['deviceId', 'lat', 'lon', 'accuracyM', 'observedAt']);

/** @description How far ahead of this server's clock a client-reported observedAt may be. */
const OBSERVED_AT_FUTURE_SLACK_MS = 120_000;

/** @description The largest accuracy radius accepted, metres; a worse fix says nothing about a place. */
const MAX_ACCURACY_M = 100_000;

/** @description A parsed browser fix. `observedAt` is client-reported; timing decisions use the server's receipt time. */
export interface BrowserFixInput {
  deviceId: string;
  point: GeoPoint;
  accuracyM: number | null;
  observedAt: Date;
}

/** @description What the page is told about an accepted fix: never its coordinates. */
export interface LocationIngestResult {
  deviceId: string;
  place: LocationPlaceRef | null;
  precisionClass: string;
  receivedAt: string;
}

/** @description Ingest tunables. */
export interface LocationIngestOptions {
  /** Clock, epoch ms. */
  nowMs?: number;
  /** Minimum time between two accepted fixes from one device. */
  minIntervalMs?: number;
}

/**
 * @description Read a browser fix from a request body. Only {@link LOCATION_FIX_FIELDS} are read.
 * @param body - The parsed JSON body.
 * @param nowMs - The server clock.
 * @returns The fix.
 * @throws {LocationRequestError} 400 for anything malformed; the message never echoes a value.
 */
export function parseBrowserFix(body: unknown, nowMs: number = Date.now()): BrowserFixInput {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const deviceId = requireLocationId(input.deviceId);
  const point: GeoPoint = { lat: input.lat as number, lon: input.lon as number };
  try {
    assertGeoPoint(point, 'fix');
  } catch {
    throw new LocationRequestError('invalid_fix', 400, 'lat and lon must be finite degrees in range.');
  }
  let accuracyM: number | null = null;
  if (input.accuracyM !== undefined && input.accuracyM !== null) {
    const value = input.accuracyM;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_ACCURACY_M) {
      throw new LocationRequestError('invalid_accuracy', 400, `accuracyM must be a number of metres from 0 to ${MAX_ACCURACY_M}.`);
    }
    accuracyM = Math.round(value);
  }
  let observedAt = new Date(nowMs);
  if (input.observedAt !== undefined && input.observedAt !== null) {
    const parsed = typeof input.observedAt === 'string' ? new Date(input.observedAt) : new Date(Number.NaN);
    if (Number.isNaN(parsed.getTime())) throw new LocationRequestError('invalid_observed_at', 400, 'observedAt must be an ISO time.');
    if (parsed.getTime() > nowMs + OBSERVED_AT_FUTURE_SLACK_MS) {
      throw new LocationRequestError('observed_at_in_future', 400, 'observedAt is ahead of the server clock.');
    }
    observedAt = parsed;
  }
  return { deviceId, point, accuracyM, observedAt };
}

/**
 * @description The smallest place the person can see that contains the full-precision point.
 * @param client - A client stamped as the person (row-level security limits the places read).
 * @param point - The fix, full precision, in memory only.
 * @returns The place reference, or null.
 */
async function containingPlace(client: PoolClient, point: GeoPoint): Promise<LocationPlaceRef | null> {
  const rows = await client.query('SELECT place_id, name, label, center_lat, center_lon, radius_m FROM location_places');
  let best: { ref: LocationPlaceRef; radius: number } | null = null;
  for (const r of rows.rows) {
    const circle = { center: { lat: Number(r.center_lat), lon: Number(r.center_lon) }, radiusM: Number(r.radius_m) };
    if (!circleContains(circle, point)) continue;
    if (!best || circle.radiusM < best.radius) {
      best = { ref: { placeId: String(r.place_id), name: String(r.name), label: String(r.label) }, radius: circle.radiusM };
    }
  }
  return best?.ref ?? null;
}

/**
 * @description The person's own opted-in browser device, locked for this fix, with the rate check.
 * @param client - A client stamped as the person.
 * @param who - The person.
 * @param deviceId - The device the fix names.
 * @param nowMs - The clock.
 * @param minIntervalMs - The minimum interval between fixes.
 * @returns The device's precision class.
 * @throws {LocationRequestError} 404 not theirs, 409 reporting off, 429 too frequent.
 */
async function reportingDevice(client: PoolClient, who: LocationPrincipal, deviceId: string, nowMs: number, minIntervalMs: number): Promise<LocationPrecisionClass> {
  const row = (await client.query(`SELECT reporting_enabled, precision_class, last_seen_at FROM location_devices
     WHERE device_id = $1 AND device_kind = 'browser' AND tenant_id IS NULL AND owner_sub = $2 AND principal_issuer = $3
     FOR UPDATE`, [deviceId, who.sub, who.principalIssuer])).rows[0];
  if (!row) throw new LocationRequestError('device_not_found', 404, 'No such browser device of yours.');
  if (row.reporting_enabled !== true) {
    throw new LocationRequestError('reporting_off', 409, 'Location reporting is off for this browser. Turn it on in Settings, Location.');
  }
  const lastSeen = row.last_seen_at instanceof Date ? row.last_seen_at.getTime() : null;
  if (lastSeen !== null && nowMs - lastSeen < minIntervalMs) {
    throw new LocationRequestError('too_frequent', 429, 'This browser reported a moment ago; try again shortly.');
  }
  const cls = String(row.precision_class);
  if (!isLocationPrecisionClass(cls)) throw new LocationRequestError('device_misconfigured', 409, 'This device has no usable precision class.');
  return cls;
}

/**
 * @description Write the minimised fix: the observation, the person's current row and the device's last_seen_at.
 * @param client - A client stamped as the person.
 * @param who - The person.
 * @param fix - The fix.
 * @param cls - The device's precision class.
 * @param place - The containing place, if any.
 * @returns The server receipt time.
 */
async function writeFix(client: PoolClient, who: LocationPrincipal, fix: BrowserFixInput, cls: LocationPrecisionClass, place: LocationPlaceRef | null): Promise<Date> {
  const stored = minimiseGeoPoint(fix.point, cls);
  const values = [who.sub, who.principalIssuer, fix.deviceId, cls, stored?.lat ?? null, stored?.lon ?? null, fix.accuracyM, fix.observedAt];
  const inserted = await client.query(`INSERT INTO location_observations
      (owner_sub, principal_issuer, subject_ref, device_id, source, precision_class, lat, lon, accuracy_m, observed_at)
    VALUES ($1, $2, $1, $3, 'browser', $4, $5, $6, $7, $8) RETURNING received_at`, values);
  const receivedAt = inserted.rows[0].received_at as Date;
  const current = [...values, place?.placeId ?? null, receivedAt];
  const updated = await client.query(`UPDATE location_current
       SET device_id = $3, source = 'browser', precision_class = $4, lat = $5, lon = $6, alt_m = NULL, accuracy_m = $7,
           mock_location = false, place_id = $9, observed_at = $8, received_at = $10, updated_at = NOW(),
           place_since = CASE WHEN place_id IS NOT DISTINCT FROM $9::uuid AND place_since IS NOT NULL THEN place_since ELSE $10 END
     WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2 AND subject_ref = $1`, current);
  if (!updated.rowCount) {
    await client.query(`INSERT INTO location_current
        (owner_sub, principal_issuer, subject_ref, device_id, source, precision_class, lat, lon, accuracy_m, place_id, observed_at, received_at, place_since)
      VALUES ($1, $2, $1, $3, 'browser', $4, $5, $6, $7, $9, $8, $10, $10)`, current);
  }
  await client.query('UPDATE location_devices SET last_seen_at = $2 WHERE device_id = $1', [fix.deviceId, receivedAt]);
  return receivedAt;
}

/**
 * @description Ingest one browser fix for the signed-in person (ADR-169 D3). The principal comes
 * from the session; nothing in the fix names an owner.
 * @param db - The pool.
 * @param principal - The signed-in person.
 * @param fix - A parsed fix ({@link parseBrowserFix}).
 * @param options - Clock and minimum interval.
 * @returns The place the fix fell in (by reference) and the receipt time.
 * @throws {LocationRequestError} 404, 409 or 429 as {@link reportingDevice} decides.
 */
export async function ingestBrowserFix(
  db: LocationDb, principal: LocationPrincipal, fix: BrowserFixInput, options: LocationIngestOptions = {},
): Promise<LocationIngestResult> {
  const started = Date.now();
  const nowMs = options.nowMs ?? started;
  const result = await withLocationOwnerSession(db, principal, async (client, who) => {
    const cls = await reportingDevice(client, who, fix.deviceId, nowMs, options.minIntervalMs ?? 0);
    const place = await containingPlace(client, fix.point);
    const receivedAt = await writeFix(client, who, fix, cls, place);
    return { deviceId: fix.deviceId, place, precisionClass: cls, receivedAt: receivedAt.toISOString() };
  });
  log.info({ op: 'presence', outcome: result.place ? 'at-place' : 'no-place', deviceId: result.deviceId,
    durationMs: Date.now() - started }, 'location browser fix accepted');
  return result;
}

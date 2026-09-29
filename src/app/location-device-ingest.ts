/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6 (D3 "Location enrolment" and "Device identity"): the location credential and the device ingest. A group admin (or, for a person-owned device, its owner) issues a device's credential from Settings, Location behind the step-up proof: one oshal_cli_tokens row bound to the device (location_device_id, never node_client_id), minted in the same transaction that records its id in location_devices.credential_id and turns reporting on; issuing again rotates it (the previous credential is revoked through migration 178's definer function, whoever minted it). The ingest accepts a fix only under the exact credential the device row records: the token must be live, its id must equal credential_id, and its user must be the device's owner or a current admin of the owning group, so a token minted by a different account for the same id, a node token, an account token, a browser session and the service secret are each refused. The device identity is derived from the verified binding, never from the body. Before it writes, the ingest replaces the request's identity with the device subject 'device:<id>' (isOperator false) in process and in the transaction, so the observation and current rows are written as the device under the device policies of migration 178 and never under the minting admin's reach. Precision minimisation and the place lookup are the browser ingest's; a fix is placed against the places the device's owner may use. In this slice a device fix is stored and placed but not evaluated against rules (a device subject stays refused by createLocationRule until a later slice evaluates it).
 *
 * @module app/location-device-ingest
 */

import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { isLocationPrecisionClass, minimiseGeoPoint, type LocationPrecisionClass } from '@/shared/utils/geo';
import { withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import { insertCliToken, type CliTokenQueryable, type LocationTokenBinding } from './routes/cli-token-routes';
import { LOCATION_CREDENTIAL_KINDS } from './location-devices';
import type { LocationPlaceRef } from './location-overview';
import { rethrowLocationWriteError } from './location-places';
import { containingPlace, parseFixCore, type FixCore } from './location-presence';
import { LocationRequestError, requireLocationId, requirePrecisionClass } from './location-request';

const log = createChildLogger({ module: 'location-device-ingest' });

/** @description The issuer namespace a device subject is stamped with; no person signs in under it. */
export const LOCATION_DEVICE_SUBJECT_ISSUER = 'urn:oshal:location-device';

/** @description The observation source each credentialed kind reports (the migration 175 CHECK set). */
export const LOCATION_DEVICE_SOURCES: Readonly<Record<string, 'android' | 'mavlink' | 'hub'>> = Object.freeze({
  drone: 'mavlink',
  phone: 'android',
});

/** @description The altitude range a device fix may report, metres above ground. */
const ALT_RANGE_M = Object.freeze({ min: -1_000, max: 50_000 });

/** @description A parsed device fix. */
export interface DeviceFixInput extends FixCore {
  altM: number | null;
  /** The reporter flagged the fix as simulated (the sim drone engine, a mocked OS location). */
  mock: boolean;
}

/** @description What the device is told about an accepted fix: never its coordinates. */
export interface DeviceIngestResult {
  deviceId: string;
  place: LocationPlaceRef | null;
  precisionClass: string;
  receivedAt: string;
}

/** @description The token's user and binding, as the credential middleware verified them. */
export interface DeviceIngestCaller {
  binding: LocationTokenBinding;
  user: LocationPrincipal;
}

/** @description A verified device, read as the token's user. */
interface VerifiedDevice {
  kind: string;
  owner: { sub: string | null; issuer: string | null; tenant: string | null };
  precisionClass: LocationPrecisionClass;
}

/** @description What the credential mint answers: the plaintext token exactly once. */
export interface LocationDeviceCredential {
  deviceId: string;
  kind: string;
  name: string;
  precisionClass: LocationPrecisionClass;
  /** True when a previous credential was revoked by this mint. */
  rotated: boolean;
  credential: { id: string; token: string; createdAt: string };
}

type Row = Record<string, unknown>;

/**
 * @description The device subject a device's writes are stamped with.
 * @param deviceId - The location device id.
 * @returns `device:<id>`.
 */
export function deviceSubjectRef(deviceId: string): string {
  return `device:${deviceId}`;
}

/**
 * @description Read a device fix from a request body: lat, lon, altM, accuracyM, observedAt and mock.
 * Nothing else is read; the device is named by the verified binding, never by the body.
 * @param body - The parsed JSON body.
 * @param nowMs - The server clock.
 * @returns The fix.
 * @throws {LocationRequestError} 400 for anything malformed; the message never echoes a value.
 */
export function parseDeviceFix(body: unknown, nowMs: number = Date.now()): DeviceFixInput {
  const input = (body && typeof body === 'object' ? body : {}) as Row;
  const core = parseFixCore(input, nowMs);
  let altM: number | null = null;
  if (input.altM !== undefined && input.altM !== null) {
    const value = input.altM;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < ALT_RANGE_M.min || value > ALT_RANGE_M.max) {
      throw new LocationRequestError('invalid_altitude', 400, `altM must be a number of metres from ${ALT_RANGE_M.min} to ${ALT_RANGE_M.max}.`);
    }
    altM = Math.round(value * 10) / 10;
  }
  if (input.mock !== undefined && typeof input.mock !== 'boolean') {
    throw new LocationRequestError('invalid_mock_flag', 400, 'mock must be true or false.');
  }
  return { ...core, altM, mock: input.mock === true };
}

/**
 * @description Canonical parameters of an enrolment approval: the device and the class it will report at.
 * @param raw - The raw parameters (the challenge's or the route's).
 * @returns `{ deviceId, precisionClass }`.
 * @throws {LocationRequestError} 400 for a malformed id or class.
 */
export function normalizeEnrolmentApproval(raw: unknown): { deviceId: string; precisionClass: LocationPrecisionClass } {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Row;
  return { deviceId: requireLocationId(input.deviceId), precisionClass: requirePrecisionClass(input.precisionClass) };
}

/**
 * @description The device the credential names, verified as the token's user: the row exists for
 * them, its recorded credential is this token, they own it (or administer its group), it reports,
 * and it did not report a moment ago.
 * @param client - A client stamped as the token's user.
 * @param caller - The binding and the user.
 * @param nowMs - The clock.
 * @param minIntervalMs - The minimum interval between fixes.
 * @returns The verified device.
 * @throws {LocationRequestError} 404 device_not_found, 403 credential_mismatch or not_device_owner, 409 reporting_off, 429 too_frequent.
 */
async function verifyDeviceCredential(client: PoolClient, caller: DeviceIngestCaller, nowMs: number, minIntervalMs: number): Promise<VerifiedDevice> {
  const { binding, user } = caller;
  const row = (await client.query(`SELECT device_kind, owner_sub, principal_issuer, tenant_id, credential_id, reporting_enabled,
      precision_class, last_seen_at FROM location_devices WHERE device_id = $1`, [binding.deviceId])).rows[0] as Row | undefined;
  if (!row) throw new LocationRequestError('device_not_found', 404, 'No such device of yours or your groups.');
  if (row.credential_id !== binding.tokenId) {
    throw new LocationRequestError('credential_mismatch', 403, 'This credential is not the one recorded for the device.');
  }
  const tenant = row.tenant_id ? String(row.tenant_id) : null;
  const owns = tenant
    ? (await client.query('SELECT oshal_is_tenant_admin($1) AS admin', [tenant])).rows[0]?.admin === true
    : row.owner_sub === user.sub && row.principal_issuer === user.principalIssuer;
  if (!owns) throw new LocationRequestError('not_device_owner', 403, 'The credential\'s account does not own this device.');
  if (row.reporting_enabled !== true) throw new LocationRequestError('reporting_off', 409, 'Location reporting is off for this device.');
  const lastSeen = row.last_seen_at instanceof Date ? row.last_seen_at.getTime() : null;
  if (lastSeen !== null && nowMs - lastSeen < minIntervalMs) {
    throw new LocationRequestError('too_frequent', 429, 'This device reported a moment ago; try again shortly.');
  }
  const cls = String(row.precision_class);
  if (!isLocationPrecisionClass(cls)) throw new LocationRequestError('device_misconfigured', 409, 'This device has no usable precision class.');
  return {
    kind: String(row.device_kind), precisionClass: cls,
    owner: { sub: row.owner_sub === null ? null : String(row.owner_sub), issuer: row.principal_issuer === null ? null : String(row.principal_issuer), tenant },
  };
}

/**
 * @description Write the minimised device fix as the device subject: the observation, the device's
 * current row and its last_seen_at (through the definer touch).
 * @param client - A client stamped as the device subject.
 * @param deviceId - The device.
 * @param device - The verified device (owner columns and class).
 * @param fix - The fix.
 * @param place - The containing place, if any.
 * @param nowMs - The server clock: the receipt time written.
 * @returns The receipt time.
 */
async function writeDeviceFix(client: PoolClient, deviceId: string, device: VerifiedDevice, fix: DeviceFixInput, place: LocationPlaceRef | null, nowMs: number): Promise<Date> {
  const stored = minimiseGeoPoint(fix.point, device.precisionClass);
  const source = LOCATION_DEVICE_SOURCES[device.kind] ?? 'manual';
  const subject = deviceSubjectRef(deviceId);
  const receivedAt = new Date(nowMs);
  const values = [device.owner.sub, device.owner.issuer, device.owner.tenant, subject, deviceId, source, device.precisionClass,
    stored?.lat ?? null, stored?.lon ?? null, fix.altM, fix.accuracyM, fix.mock, fix.observedAt, receivedAt];
  await client.query(`INSERT INTO location_observations
      (owner_sub, principal_issuer, tenant_id, subject_ref, device_id, source, precision_class, lat, lon, alt_m, accuracy_m, mock_location, observed_at, received_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, values).catch(rethrowLocationWriteError);
  const placeId = place?.placeId ?? null;
  const updated = await client.query(`UPDATE location_current
       SET source = $3, precision_class = $4, lat = $5, lon = $6, alt_m = $7, accuracy_m = $8, mock_location = $9,
           place_id = $12, observed_at = $10, received_at = $11, updated_at = NOW(),
           place_since = CASE WHEN place_id IS NOT DISTINCT FROM $12::uuid AND place_since IS NOT NULL THEN place_since ELSE $11::timestamptz END
     WHERE subject_ref = $1 AND device_id = $2`,
  [subject, deviceId, source, device.precisionClass, stored?.lat ?? null, stored?.lon ?? null, fix.altM, fix.accuracyM, fix.mock,
    fix.observedAt, receivedAt, placeId]).catch(rethrowLocationWriteError);
  if (!updated.rowCount) {
    await client.query(`INSERT INTO location_current
        (owner_sub, principal_issuer, tenant_id, subject_ref, device_id, source, precision_class, lat, lon, alt_m, accuracy_m, mock_location, observed_at, received_at, place_id, place_since)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $14)`, [...values, placeId]).catch(rethrowLocationWriteError);
  }
  const touched = await client.query('SELECT location_device_touch($1, $2) AS touched', [deviceId, receivedAt]);
  if (touched.rows[0]?.touched !== true) throw new LocationRequestError('reporting_off', 409, 'Location reporting is off for this device.');
  return receivedAt;
}

/**
 * @description Ingest one fix from a device under its location credential (ADR-169 D3). The device
 * is verified as the token's user, then the fix is placed and written as the device subject.
 * @param db - The pool.
 * @param caller - The verified binding and the token's user.
 * @param fix - A parsed fix ({@link parseDeviceFix}).
 * @param options - Clock and the minimum interval between fixes.
 * @returns The place the fix fell in (by reference), the class and the receipt time.
 * @throws {LocationRequestError} As {@link verifyDeviceCredential} decides.
 */
export async function ingestDeviceFix(
  db: LocationDb, caller: DeviceIngestCaller, fix: DeviceFixInput, options: { nowMs?: number; minIntervalMs?: number } = {},
): Promise<DeviceIngestResult> {
  const started = Date.now();
  const nowMs = options.nowMs ?? started;
  const deviceId = caller.binding.deviceId;
  const device = await withLocationOwnerSession(db, caller.user, (client) => verifyDeviceCredential(client, caller, nowMs, options.minIntervalMs ?? 0));
  const subject: LocationPrincipal = { sub: deviceSubjectRef(deviceId), principalIssuer: LOCATION_DEVICE_SUBJECT_ISSUER };
  const result = await runWithRequestIdentity({ sub: subject.sub, principalIssuer: subject.principalIssuer, isOperator: false },
    () => withLocationOwnerSession(db, subject, async (client) => {
      const place = await containingPlace(client, fix.point);
      const receivedAt = await writeDeviceFix(client, deviceId, device, fix, place, nowMs);
      return { deviceId, place, precisionClass: device.precisionClass, receivedAt: receivedAt.toISOString() };
    }));
  log.info({ op: 'device-presence', outcome: result.place ? 'at-place' : 'no-place', deviceId, durationMs: Date.now() - started },
    'location device fix accepted');
  return result;
}

/**
 * @description Issue (or rotate) a device's location credential (ADR-169 D3 "Location enrolment").
 * The router admits this only with a spent step-up proof for exactly this device and class. One
 * transaction as the person: the device must be theirs to change (its owner, or an admin of its
 * group), of a kind that reports under a credential; the previous credential is revoked, the new
 * token is minted bound to the device, its id is recorded and reporting turns on at the class.
 * @param db - The pool.
 * @param principal - The signed-in person.
 * @param approval - The canonical parameters ({@link normalizeEnrolmentApproval}).
 * @returns The credential, its plaintext present exactly once.
 * @throws {LocationRequestError} 404 device_not_found, 403 not_device_owner, 400 credential_not_supported.
 */
export async function issueLocationDeviceCredential(
  db: LocationDb, principal: LocationPrincipal, approval: { deviceId: string; precisionClass: LocationPrecisionClass },
): Promise<LocationDeviceCredential> {
  const { deviceId, precisionClass } = approval;
  const issued = await withLocationOwnerSession(db, principal, async (client, who) => {
    // Serialise two admins issuing at once on an advisory lock rather than FOR UPDATE: a row lock
    // applies the UPDATE policy, which would turn a member's refusal from "not yours" into "not found".
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('location-device:' || $1, 0))`, [deviceId]);
    const row = (await client.query(`SELECT device_kind, device_ref, credential_id,
        location_row_writable(owner_sub, principal_issuer, tenant_id) AS writable
      FROM location_devices WHERE device_id = $1`, [deviceId])).rows[0] as Row | undefined;
    if (!row) throw new LocationRequestError('device_not_found', 404, 'No such device of yours or your groups.');
    if (row.writable !== true) throw new LocationRequestError('not_device_owner', 403, 'Only the device\'s owner, or an admin of its group, may issue its credential.');
    const kind = String(row.device_kind);
    if (!LOCATION_CREDENTIAL_KINDS.includes(kind)) {
      throw new LocationRequestError('credential_not_supported', 400, `A ${kind} does not report under a location credential.`);
    }
    const revoked = Number((await client.query('SELECT location_revoke_device_credential($1) AS n', [deviceId])).rows[0]?.n ?? 0);
    const minted = await insertCliToken(client as unknown as CliTokenQueryable, {
      sub: who.sub, principalIssuer: who.principalIssuer, label: `location ${kind} ${String(row.device_ref)}`, locationDeviceId: deviceId,
    });
    await client.query(`UPDATE location_devices SET credential_id = $2, reporting_enabled = true, precision_class = $3, updated_at = NOW()
      WHERE device_id = $1`, [deviceId, minted.id, precisionClass]).catch(rethrowLocationWriteError);
    return {
      deviceId, kind, name: String(row.device_ref), precisionClass, rotated: revoked > 0,
      credential: { id: minted.id, token: minted.token, createdAt: minted.createdAt },
    };
  });
  log.info({ op: 'credential', outcome: issued.rotated ? 'rotated' : 'issued', deviceId, credentialId: issued.credential.id },
    'location device credential issued');
  return issued;
}

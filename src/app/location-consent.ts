/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3 (D6 "Off by default"): a person's consent over their own location. Opting a browser in creates (or re-enables) a person-owned, carried `browser` device that reports at the precision class they chose; opting out stops its ingest and clears the location_current row it fed while its history stays until they purge it (Q4); a precision change that raises precision, of a device or of the person's default, is admitted only when the caller's step-up check says so, inside the same transaction that reads the class in force, so a concurrent change cannot turn a lowering into an unproven raise. Every statement runs under withLocationOwnerSession as the person, never as an operator; row-level security (no operator branch) is the enforcement and the explicit owner predicates only keep each statement to the rows it means.
 *
 * @module app/location-consent
 */

import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { LocationPrecisionClass } from '@/shared/utils/geo';
import { withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import { LocationRequestError, raisesLocationPrecision, requireLocationId, requirePrecisionClass } from './location-request';

const log = createChildLogger({ module: 'location-consent' });

/** @description The class a person's settings default to until they choose (ADR-169 D3: block for people). */
export const DEFAULT_LOCATION_PRECISION: LocationPrecisionClass = 'block';

/** @description One of the person's own located devices, as their settings page shows it. */
export interface LocationDeviceView {
  deviceId: string;
  kind: string;
  reportingEnabled: boolean;
  precisionClass: string;
  lastSeenAt: string | null;
  createdAt: string;
}

/** @description The outcome of a precision change. */
export interface LocationPrecisionChange {
  previous: string;
  next: LocationPrecisionClass;
  raised: boolean;
}

/**
 * @description Decides whether an exposure-raising change may go ahead. The router passes one that
 * spends the request's step-up proof; it returns false when the request carries none that fits.
 */
export type LocationRaiseAuthorizer = () => boolean;

const DEVICE_COLUMNS = `device_id, device_kind, reporting_enabled, precision_class, last_seen_at, created_at`;

/**
 * @description Shape a device row for the page.
 * @param row - A location_devices row with {@link DEVICE_COLUMNS}.
 * @returns The view.
 */
export function toDeviceView(row: Record<string, unknown>): LocationDeviceView {
  const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  return {
    deviceId: String(row.device_id),
    kind: String(row.device_kind),
    reportingEnabled: row.reporting_enabled === true,
    precisionClass: String(row.precision_class),
    lastSeenAt: iso(row.last_seen_at),
    createdAt: iso(row.created_at) ?? '',
  };
}

/**
 * @description Refuse a raise the authorizer does not admit.
 * @param raised - Whether the change raises precision.
 * @param authorize - The caller's step-up check.
 * @returns Nothing.
 * @throws {LocationRequestError} 403 step_up_required.
 */
function requireRaiseAuthorized(raised: boolean, authorize: LocationRaiseAuthorizer): void {
  if (raised && !authorize()) {
    throw new LocationRequestError('step_up_required', 403,
      'Raising location precision needs a fresh sign-in. Confirm it from Settings, Location.');
  }
}

/**
 * @description Change the person's default precision class. Lowering needs nothing; raising needs
 * the step-up (ADR-169 D3), checked against the class read in the same transaction.
 * @param db - The pool.
 * @param principal - The person.
 * @param nextValue - The class asked for.
 * @param authorize - The request's step-up check for a raise.
 * @returns What changed.
 * @throws {LocationRequestError} 400 for a bad class, 403 step_up_required for an unproven raise.
 */
export async function changeDefaultPrecision(
  db: LocationDb, principal: LocationPrincipal, nextValue: unknown, authorize: LocationRaiseAuthorizer,
): Promise<LocationPrecisionChange> {
  const next = requirePrecisionClass(nextValue);
  const change = await withLocationOwnerSession(db, principal, async (client, who) => {
    const row = await client.query(
      'SELECT default_precision_class FROM location_settings WHERE owner_sub = $1 AND principal_issuer = $2 FOR UPDATE',
      [who.sub, who.principalIssuer]);
    const previous = row.rows[0] ? String(row.rows[0].default_precision_class) : DEFAULT_LOCATION_PRECISION;
    const raised = raisesLocationPrecision(previous, next);
    requireRaiseAuthorized(raised, authorize);
    await client.query(`INSERT INTO location_settings (owner_sub, principal_issuer, default_precision_class)
      VALUES ($1, $2, $3) ON CONFLICT (owner_sub, principal_issuer)
      DO UPDATE SET default_precision_class = EXCLUDED.default_precision_class, updated_at = NOW()`,
    [who.sub, who.principalIssuer, next]);
    return { previous, next, raised };
  });
  log.info({ op: 'default-precision', outcome: change.raised ? 'raised' : 'lowered-or-same' }, 'location default precision changed');
  return change;
}

/**
 * @description Re-enable one of the person's own browser devices at a precision class.
 * @param client - A client stamped as the person.
 * @param who - The person.
 * @param deviceId - The device.
 * @param precisionClass - The class.
 * @returns The device row.
 * @throws {LocationRequestError} 404 when it is not the person's browser device.
 */
async function reenableBrowser(client: PoolClient, who: LocationPrincipal, deviceId: string, precisionClass: string): Promise<Record<string, unknown>> {
  const updated = await client.query(`UPDATE location_devices
       SET reporting_enabled = true, precision_class = $4, updated_at = NOW()
     WHERE device_id = $1 AND device_kind = 'browser' AND tenant_id IS NULL AND owner_sub = $2 AND principal_issuer = $3
     RETURNING ${DEVICE_COLUMNS}`, [deviceId, who.sub, who.principalIssuer, precisionClass]);
  if (!updated.rows[0]) throw new LocationRequestError('device_not_found', 404, 'No such browser device of yours.');
  return updated.rows[0];
}

/**
 * @description Opt a browser in (ADR-169 D6): create a person-owned, carried `browser` device that
 * reports at the chosen class, or re-enable one the person already has. The router admits this
 * only with a spent step-up proof for exactly these parameters.
 * @param db - The pool.
 * @param principal - The person.
 * @param input - `deviceId` to re-enable (or null for a new browser) and `precisionClass`.
 * @returns The device.
 * @throws {LocationRequestError} 400 for bad input, 404 for a device that is not theirs.
 */
export async function optInBrowserDevice(
  db: LocationDb, principal: LocationPrincipal, input: { deviceId: string | null; precisionClass: unknown },
): Promise<LocationDeviceView> {
  const precisionClass = requirePrecisionClass(input.precisionClass);
  const deviceId = input.deviceId === null ? null : requireLocationId(input.deviceId);
  const row = await withLocationOwnerSession(db, principal, async (client, who) => {
    if (deviceId) return reenableBrowser(client, who, deviceId, precisionClass);
    const created = await client.query(`INSERT INTO location_devices
        (device_kind, device_ref, owner_sub, principal_issuer, carried_by_sub, reporting_enabled, precision_class)
      VALUES ('browser', $1, $2, $3, $2, true, $4) RETURNING ${DEVICE_COLUMNS}`,
    [`browser:${crypto.randomUUID()}`, who.sub, who.principalIssuer, precisionClass]);
    return created.rows[0];
  });
  const view = toDeviceView(row);
  log.info({ op: 'opt-in', outcome: 'ok', deviceId: view.deviceId }, 'location browser device opted in');
  return view;
}

/**
 * @description Opt one of the person's own devices out (ADR-169 D6): reporting stops and the
 * location_current row that device fed is cleared. Its history stays until the person purges it.
 * @param db - The pool.
 * @param principal - The person.
 * @param deviceIdValue - The device.
 * @returns The device and how many current rows were cleared.
 * @throws {LocationRequestError} 404 when it is not the person's device.
 */
export async function optOutDevice(
  db: LocationDb, principal: LocationPrincipal, deviceIdValue: unknown,
): Promise<{ device: LocationDeviceView; currentCleared: number }> {
  const deviceId = requireLocationId(deviceIdValue);
  const result = await withLocationOwnerSession(db, principal, async (client, who) => {
    const updated = await client.query(`UPDATE location_devices SET reporting_enabled = false, updated_at = NOW()
       WHERE device_id = $1 AND tenant_id IS NULL AND owner_sub = $2 AND principal_issuer = $3
       RETURNING ${DEVICE_COLUMNS}`, [deviceId, who.sub, who.principalIssuer]);
    if (!updated.rows[0]) throw new LocationRequestError('device_not_found', 404, 'No such device of yours.');
    const cleared = await client.query(
      'DELETE FROM location_current WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2 AND device_id = $3',
      [who.sub, who.principalIssuer, deviceId]);
    return { device: toDeviceView(updated.rows[0]), currentCleared: cleared.rowCount ?? 0 };
  });
  const { currentCleared: count } = result;
  log.info({ op: 'opt-out', outcome: 'ok', deviceId, count }, 'location device opted out');
  return result;
}

/**
 * @description Change one of the person's own devices' precision class. Lowering needs nothing;
 * raising needs the step-up, checked against the class read in the same transaction.
 * @param db - The pool.
 * @param principal - The person.
 * @param deviceIdValue - The device.
 * @param nextValue - The class asked for.
 * @param authorize - The request's step-up check for a raise.
 * @returns What changed.
 * @throws {LocationRequestError} 400, 404, or 403 step_up_required for an unproven raise.
 */
export async function changeDevicePrecision(
  db: LocationDb, principal: LocationPrincipal, deviceIdValue: unknown, nextValue: unknown, authorize: LocationRaiseAuthorizer,
): Promise<LocationPrecisionChange> {
  const deviceId = requireLocationId(deviceIdValue);
  const next = requirePrecisionClass(nextValue);
  const change = await withLocationOwnerSession(db, principal, async (client, who) => {
    const row = await client.query(`SELECT precision_class FROM location_devices
       WHERE device_id = $1 AND tenant_id IS NULL AND owner_sub = $2 AND principal_issuer = $3 FOR UPDATE`,
    [deviceId, who.sub, who.principalIssuer]);
    if (!row.rows[0]) throw new LocationRequestError('device_not_found', 404, 'No such device of yours.');
    const previous = String(row.rows[0].precision_class);
    const raised = raisesLocationPrecision(previous, next);
    requireRaiseAuthorized(raised, authorize);
    await client.query(`UPDATE location_devices SET precision_class = $4, updated_at = NOW()
       WHERE device_id = $1 AND tenant_id IS NULL AND owner_sub = $2 AND principal_issuer = $3`,
    [deviceId, who.sub, who.principalIssuer, next]);
    return { previous, next, raised };
  });
  log.info({ op: 'device-precision', outcome: change.raised ? 'raised' : 'lowered-or-same', deviceId }, 'location device precision changed');
  return change;
}

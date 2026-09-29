/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6 (D5, D6): locatedDevice, the package-facing read a store surface uses to decide whether the caller may see a device's position. The drone package's /state, /fleet and /fleet/:id/state return live position and home to any authenticated caller today; with this read they return them only to a member of the group that owns the drone's location data (D6: "group members see group-device positions"). The caller is the ambient request identity, never an argument, exactly as the L4 reads work; row-level security answers the question (a device the caller may not read is simply not found), and the answer is ids only: the location device id and its owner shape, never a coordinate.
 *
 * @module location/services/location-device-reads
 */

import { createChildLogger } from '@/shared/logger';
import { LocationInputError } from '../model/location-types';
import { callerLocationPrincipal } from './location-place-reads';
import { withLocationOwnerSession, type LocationDb } from './location-owner-session';

const log = createChildLogger({ module: 'location-device-reads' });

/** @description The device kinds a package may look up by reference. */
export const LOCATION_LOOKUP_KINDS: readonly string[] = Object.freeze(['node', 'camera', 'drone', 'tv', 'hub', 'phone']);

/** @description A located device the caller may read: ids only. */
export interface LocationDeviceRef {
  /** The location device id (location_devices.device_id). */
  deviceId: string;
  /** Whose location data it is: a person's (the caller's own) or a group's. */
  owner: 'person' | 'group';
  /** The owning group, for a group device. */
  groupId: string | null;
  /** Whether the device reports (a credentialed device that has opted in). */
  reporting: boolean;
}

/**
 * @description locatedDevice (ADR-169 L6): the location record of a device the caller may read, by
 * kind and reference (a drone's fleet id, a camera's id, a node's client id), or null when there is
 * none or it is not the caller's to read. A package uses it to decide whether the caller may see
 * that device's position on its own surface. Ids only; never a coordinate.
 * @param db - The pool.
 * @param kind - The device kind ('drone', 'camera', 'node', 'tv', 'hub' or 'phone').
 * @param ref - The device reference as it was enrolled.
 * @returns The record, or null.
 * @throws {LocationInputError} For a kind outside {@link LOCATION_LOOKUP_KINDS} or a blank reference.
 * @throws {LocationPrincipalError} Without a signed-in caller with a verified issuer.
 */
export async function locatedDevice(db: LocationDb, kind: string, ref: string): Promise<LocationDeviceRef | null> {
  if (!LOCATION_LOOKUP_KINDS.includes(kind)) throw new LocationInputError('kind must be a located device kind.');
  const reference = typeof ref === 'string' ? ref.trim() : '';
  if (!reference || reference.length > 200) throw new LocationInputError('ref must name a device.');
  const who = callerLocationPrincipal();
  const row = await withLocationOwnerSession(db, who, async (client) => (await client.query(
    `SELECT device_id, tenant_id, reporting_enabled, credential_id
       FROM location_devices WHERE device_kind = $1 AND device_ref = $2`, [kind, reference])).rows[0]);
  const found = row
    ? {
      deviceId: String(row.device_id),
      owner: row.tenant_id ? 'group' as const : 'person' as const,
      groupId: row.tenant_id ? String(row.tenant_id) : null,
      reporting: row.reporting_enabled === true && row.credential_id !== null,
    }
    : null;
  log.debug({ op: 'located-device', outcome: found ? 'found' : 'none' }, 'located device read');
  return found;
}

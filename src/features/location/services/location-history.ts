/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2: the owner's purge and export over the location store (Q4: history is the person's own data, kept until they purge it). purgeOwnLocationHistory deletes the person's observations and current rows under their own identity; purgeGroupDeviceHistory lets an admin of a group purge one group-owned device's rows and refuses anyone else before touching a row; exportOwnLocationData reads every location row the person owns or that names them, for the /api/me takeout. Nothing here runs as SYSTEM or as an operator, and nothing deletes by age.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5: the owner's purge also deletes the person's evaluation history (rule state, share presence and fire rows they own as the subject), which D3 makes deletable only through this purge, and reports it as evaluationCount. Rules and shares are configuration, not history, and stay. The export adds the person's rules, rule state, fires, share presence and the restricted invitations addressed to them.
 *
 * @module location/services/location-history
 */

import type { PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  LocationForbiddenError,
  type LocationExport,
  type LocationPrincipal,
  type LocationPurgeResult,
} from '../model/location-types';
import { withLocationOwnerSession, type LocationDb } from './location-owner-session';

const log = createChildLogger({ module: 'location-history' });

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The evaluation history a person owns as a subject (ADR-169 D3: "a person deletes the state, share
 * presence and fire rows they own only through their purge").
 */
const EVALUATION_PURGES: readonly string[] = [
  'DELETE FROM location_rule_state WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2',
  'DELETE FROM location_share_presence WHERE owner_sub = $1 AND principal_issuer = $2',
  'DELETE FROM location_rule_fires WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2',
];

/**
 * @description Delete the session person's own observations and current rows. Both statements also
 * name the owner explicitly; row-level security (no operator branch) is what guarantees the
 * statement can reach no one else's rows.
 * @param client - A client stamped as the person by {@link withLocationOwnerSession}.
 * @param principal - The person.
 * @returns How many observation and current rows went.
 */
async function deleteOwnHistory(client: PoolClient, principal: LocationPrincipal): Promise<LocationPurgeResult> {
  const params = [principal.sub, principal.principalIssuer];
  const current = await client.query(
    'DELETE FROM location_current WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2', params);
  const observations = await client.query(
    'DELETE FROM location_observations WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2', params);
  let evaluationCount = 0;
  for (const sql of EVALUATION_PURGES) evaluationCount += (await client.query(sql, params)).rowCount ?? 0;
  return { observationCount: observations.rowCount ?? 0, currentCount: current.rowCount ?? 0, evaluationCount };
}

/**
 * @description The owner's purge (ADR-169 Q4): delete every observation and current row the person
 * owns, and the rule state, share presence and fire rows they own as a subject, now, under their own
 * identity. Places, devices, rules and shares are not history and stay.
 * @param db - The pool.
 * @param principal - The person purging their own history.
 * @returns The counts deleted.
 * @throws {LocationPrincipalError} When the principal lacks a subject or verified issuer.
 */
export async function purgeOwnLocationHistory(db: LocationDb, principal: LocationPrincipal): Promise<LocationPurgeResult> {
  const started = Date.now();
  const result = await withLocationOwnerSession(db, principal, deleteOwnHistory);
  const purgedCount = result.evaluationCount ?? 0;
  log.info({ op: 'purge-own', outcome: 'ok', observationCount: result.observationCount,
    purgedCount, durationMs: Date.now() - started }, 'location history purged by its owner');
  return result;
}

/**
 * @description A group admin's purge of one group-owned device's history and current row (ADR-169
 * D3: "a group admin purges a group-owned device's rows"). The admin check runs first so a member
 * who is not an admin is told no instead of being shown a zero count; the delete policy is the
 * enforcement either way.
 * @param db - The pool.
 * @param principal - The admin.
 * @param tenantId - The group that owns the device.
 * @param deviceId - The device whose rows go.
 * @returns The counts deleted.
 * @throws {LocationForbiddenError} When the principal is not an admin of the group.
 */
export async function purgeGroupDeviceHistory(
  db: LocationDb,
  principal: LocationPrincipal,
  tenantId: string,
  deviceId: string,
): Promise<LocationPurgeResult> {
  if (!UUID_SHAPE.test(tenantId) || !UUID_SHAPE.test(deviceId)) throw new LocationForbiddenError();
  const started = Date.now();
  const result = await withLocationOwnerSession(db, principal, async (client) => {
    const admin = await client.query('SELECT oshal_is_tenant_admin($1) AS ok', [tenantId]);
    if (admin.rows[0]?.ok !== true) throw new LocationForbiddenError();
    const subject = `device:${deviceId}`;
    const current = await client.query(
      'DELETE FROM location_current WHERE tenant_id = $1 AND subject_ref = $2', [tenantId, subject]);
    const observations = await client.query(
      'DELETE FROM location_observations WHERE tenant_id = $1 AND subject_ref = $2', [tenantId, subject]);
    return { observationCount: observations.rowCount ?? 0, currentCount: current.rowCount ?? 0 };
  });
  log.info({ op: 'purge-group-device', outcome: 'ok', tenantId, deviceId,
    observationCount: result.observationCount, durationMs: Date.now() - started }, 'group device history purged');
  return result;
}

/**
 * The export reads. 'owner' reads name the person as owner (subject and issuer); 'member' reads are
 * the two tenant-row tables that name the person as a member, keyed by subject like memberships.
 */
const EXPORT_READS: ReadonlyArray<readonly [string, 'owner' | 'member', string]> = [
  ['location_settings', 'owner', 'SELECT * FROM location_settings WHERE owner_sub = $1 AND principal_issuer = $2'],
  ['location_places', 'owner', 'SELECT * FROM location_places WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2 ORDER BY created_at'],
  ['location_devices', 'owner', 'SELECT * FROM location_devices WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2 ORDER BY created_at'],
  ['location_current', 'owner', 'SELECT * FROM location_current WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2'],
  ['location_observations', 'owner', 'SELECT * FROM location_observations WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2 ORDER BY received_at'],
  ['location_shares', 'owner', 'SELECT * FROM location_shares WHERE owner_sub = $1 AND principal_issuer = $2 ORDER BY created_at'],
  ['location_rules', 'owner', 'SELECT * FROM location_rules WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2 ORDER BY created_at'],
  ['location_rule_state', 'owner', 'SELECT * FROM location_rule_state WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2'],
  ['location_rule_fires', 'owner', 'SELECT * FROM location_rule_fires WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2 ORDER BY fired_at'],
  ['location_share_presence', 'owner', 'SELECT * FROM location_share_presence WHERE owner_sub = $1 AND principal_issuer = $2'],
  ['location_restricted_invites', 'owner', 'SELECT * FROM location_restricted_invites WHERE user_sub = $1 AND principal_issuer = $2 ORDER BY created_at'],
  ['location_member_restrictions', 'member', 'SELECT * FROM location_member_restrictions WHERE user_sub = $1 ORDER BY created_at'],
  ['location_guardian_shares', 'member', 'SELECT * FROM location_guardian_shares WHERE user_sub = $1 ORDER BY created_at'],
];

/**
 * @description The person's own location rows for takeout (ADR-169 D6), table by table, read under
 * their own identity. Includes the restriction and guardian shares that name them, which is what
 * their "who can see me" list is built from.
 * @param db - The pool.
 * @param principal - The person exporting.
 * @returns Rows keyed by table name.
 * @throws {LocationPrincipalError} When the principal lacks a subject or verified issuer.
 */
export async function exportOwnLocationData(db: LocationDb, principal: LocationPrincipal): Promise<LocationExport> {
  return withLocationOwnerSession(db, principal, async (client, who) => {
    const out: LocationExport = {};
    for (const [table, keyedBy, sql] of EXPORT_READS) {
      const params = keyedBy === 'owner' ? [who.sub, who.principalIssuer] : [who.sub];
      const rows = await client.query(sql, params);
      out[table] = rows.rows as Array<Record<string, unknown>>;
    }
    return out;
  });
}

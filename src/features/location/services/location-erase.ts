/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2 (D6 "Deletion and takeout"): the one location erase function both account-erasure routes call. In one transaction under the person's own identity it revokes the location device credentials they hold, then deletes every location row they own (current, observations, shares, devices, places, settings); after commit it runs every registered evaluator-state eraser so in-memory state about them goes too. Restrictions and guardian shares are tenant rows and go with the membership (the D3 cascade), never through this function. An eraser that throws is named in the result, never swallowed.
 *
 * @module location/services/location-erase
 */

import type { PoolClient } from 'pg';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import type { LocationEraseResult, LocationPrincipal } from '../model/location-types';
import { requireLocationPrincipal, withLocationOwnerSession, type LocationDb } from './location-owner-session';

const log = createChildLogger({ module: 'location-erase' });

/**
 * @description Something that holds in-memory location state about people (the L5 evaluator's
 * enter/exit hysteresis, for instance) and must drop one person's share of it on erasure.
 */
export type LocationStateEraser = (principal: LocationPrincipal) => void | Promise<void>;

const stateErasers = new Map<string, LocationStateEraser>();

/**
 * @description Register an in-memory state eraser under a stable name. Registering the same name
 * again replaces the earlier one, so a module that is reloaded never runs twice.
 * @param name - Stable, non-empty name reported when the eraser fails.
 * @param eraser - Drops everything held about one person.
 * @returns A function that unregisters it.
 */
export function registerLocationStateEraser(name: string, eraser: LocationStateEraser): () => void {
  const key = name.trim();
  if (!key) throw new Error('A location state eraser needs a name.');
  stateErasers.set(key, eraser);
  return () => {
    if (stateErasers.get(key) === eraser) stateErasers.delete(key);
  };
}

/** Person-row deletes in dependency order: current rows reference devices and places. */
const PERSON_DELETES: ReadonlyArray<readonly [string, string]> = [
  ['location_current', 'DELETE FROM location_current WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2'],
  ['location_observations', 'DELETE FROM location_observations WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2'],
  ['location_shares', 'DELETE FROM location_shares WHERE owner_sub = $1 AND principal_issuer = $2'],
  ['location_devices', 'DELETE FROM location_devices WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2'],
  ['location_places', 'DELETE FROM location_places WHERE tenant_id IS NULL AND owner_sub = $1 AND principal_issuer = $2'],
  ['location_settings', 'DELETE FROM location_settings WHERE owner_sub = $1 AND principal_issuer = $2'],
];

/**
 * Revoke every still-live CLI token the person holds that a location device row names as its
 * credential: their own devices, and group devices whose credential they minted. Runs before the
 * device rows go, because the device rows are what name the credentials.
 */
const REVOKE_CREDENTIALS = `UPDATE oshal_cli_tokens SET revoked_at = NOW()
  WHERE revoked_at IS NULL AND user_sub = $1 AND principal_issuer = $2
    AND id IN (SELECT credential_id FROM location_devices WHERE credential_id IS NOT NULL)`;

/**
 * @description The database half of the erase, on a client stamped as the person.
 * @param client - The stamped client.
 * @param who - The person.
 * @returns Revoked credential count and per-table delete counts.
 */
async function eraseRows(client: PoolClient, who: LocationPrincipal): Promise<Pick<LocationEraseResult, 'deleted' | 'credentialsRevoked'>> {
  const params = [who.sub, who.principalIssuer];
  const revoked = await client.query(REVOKE_CREDENTIALS, params);
  const deleted: Record<string, number> = {};
  for (const [table, sql] of PERSON_DELETES) {
    const result = await client.query(sql, params);
    deleted[table] = result.rowCount ?? 0;
  }
  return { deleted, credentialsRevoked: revoked.rowCount ?? 0 };
}

/**
 * @description Run every registered state eraser for one person. Each runs even when an earlier one
 * throws; failures are logged and named.
 * @param who - The person.
 * @returns How many ran cleanly, and the names of those that threw.
 */
async function runStateErasers(who: LocationPrincipal): Promise<Pick<LocationEraseResult, 'stateErasersRun' | 'stateErasersFailed'>> {
  let stateErasersRun = 0;
  const stateErasersFailed: string[] = [];
  for (const [name, eraser] of stateErasers) {
    try {
      await eraser(who);
      stateErasersRun += 1;
    } catch (error) {
      stateErasersFailed.push(name);
      log.error({ op: 'erase-state', outcome: 'failed', err: locationSafeError(error) }, 'location state eraser failed');
    }
  }
  return { stateErasersRun, stateErasersFailed };
}

/**
 * @description Erase one person's location data (ADR-169 D6): revoke their location device
 * credentials, delete every location row they own, and clear registered in-memory state about them.
 * Called by both `/api/me/delete-confirm` and `DELETE /api/privacy/me`.
 * @param db - The pool.
 * @param principal - The person being erased (subject and verified issuer).
 * @returns Per-table counts, credentials revoked and the state erasers' outcome.
 * @throws {LocationPrincipalError} When the principal lacks a subject or verified issuer.
 */
export async function eraseLocationData(db: LocationDb, principal: LocationPrincipal): Promise<LocationEraseResult> {
  const started = Date.now();
  const who = requireLocationPrincipal(principal);
  const rows = await withLocationOwnerSession(db, who, eraseRows);
  const state = await runStateErasers(who);
  const total = Object.values(rows.deleted).reduce((sum, n) => sum + n, 0);
  log.info({ op: 'erase', outcome: state.stateErasersFailed.length ? 'partial' : 'ok', total,
    durationMs: Date.now() - started }, 'location data erased');
  return { ...rows, ...state };
}

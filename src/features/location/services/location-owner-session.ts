/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2: every location storage operation runs in ONE transaction stamped, transaction-locally, as exactly the person it acts for and never as an operator. Location routes run with isOperator false (D3); stamping the GUCs here instead of trusting the ambient request identity means an operator-stamped or SYSTEM caller cannot widen what a purge, erase or export touches, and the row-level security in migration 175 (which has no operator branch) decides the rest.
 *
 * @module location/services/location-owner-session
 */

import type { Pool, PoolClient } from 'pg';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import { LocationPrincipalError, type LocationPrincipal } from '../model/location-types';

const log = createChildLogger({ module: 'location-owner-session' });

/** @description The part of a pg Pool the location store needs: a client for one transaction. */
export type LocationDb = Pick<Pool, 'connect'>;

/**
 * @description Refuse a principal without a subject or a verified issuer.
 * @param principal - The person the operation is for.
 * @returns The same principal, trimmed.
 * @throws {LocationPrincipalError} When either part is missing or blank.
 */
export function requireLocationPrincipal(principal: Partial<LocationPrincipal> | null | undefined): LocationPrincipal {
  const sub = typeof principal?.sub === 'string' ? principal.sub.trim() : '';
  const principalIssuer = typeof principal?.principalIssuer === 'string' ? principal.principalIssuer.trim() : '';
  if (!sub || !principalIssuer) throw new LocationPrincipalError();
  return { sub, principalIssuer };
}

/**
 * @description Roll back a failed transaction; a failing rollback is logged, and the original
 * error is what the caller sees.
 * @param client - The transaction's client.
 * @returns Nothing.
 */
async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    log.error({ op: 'rollback', outcome: 'failed', err: locationSafeError(error) }, 'location transaction rollback failed');
  }
}

/**
 * @description Run `work` in one transaction whose row-level-security identity is exactly the
 * principal, as a non-operator. The GUCs are set with `is_local = true`, so they end with the
 * transaction and a pooled connection never carries them to its next user.
 * @param db - A pool (plain or GUC-wrapped).
 * @param principal - The person the work is for.
 * @param work - The statements to run on the stamped client, given the validated principal.
 * @returns Whatever `work` returns, after COMMIT.
 * @throws {LocationPrincipalError} When the principal lacks a subject or issuer; any database error after ROLLBACK.
 */
export async function withLocationOwnerSession<T>(
  db: LocationDb,
  principal: LocationPrincipal,
  work: (client: PoolClient, who: LocationPrincipal) => Promise<T>,
): Promise<T> {
  const who = requireLocationPrincipal(principal);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('oshal.current_sub', $1, true), set_config('oshal.current_issuer', $2, true), "
        + "set_config('oshal.is_operator', 'off', true)",
      [who.sub, who.principalIssuer],
    );
    const result = await work(client, who);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    log.error({ op: 'owner-session', outcome: 'rolled-back', err: locationSafeError(error) }, 'location transaction failed');
    throw error;
  } finally {
    client.release();
  }
}

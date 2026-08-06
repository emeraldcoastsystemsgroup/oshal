/**
 * PostgreSQL-authoritative coordination for scarce physical nodes. A lease is identified by a
 * random capability, not its human-readable holder, so a stale or duplicated process cannot renew
 * or release a successor. Expiry is the crash-recovery path; explicit renewal is the liveness path.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Implement atomic acquire, exact-token renew/release, active reads, and one canonical render-node resource key for recap and video-pump coordination.
 *
 * @module app/node-resource-lease
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const logger = createChildLogger({ module: 'node-resource-lease' });
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 12 * 60 * 60_000;

/** @description One currently held durable node-resource lease. */
export interface NodeResourceLease {
  resourceKey: string;
  leaseId: string;
  holder: string;
  purpose: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  metadata: Record<string, unknown>;
}

/** @description Atomic acquisition result, including the incumbent on contention. */
export interface NodeResourceLeaseAcquisition {
  acquired: boolean;
  lease: NodeResourceLease;
}

interface LeaseRow {
  acquired?: boolean;
  resource_key: string;
  lease_id: string;
  holder: string;
  purpose: string;
  acquired_at: Date | string;
  heartbeat_at: Date | string;
  expires_at: Date | string;
  metadata: Record<string, unknown>;
}

/** @description Derive the one namespace both recap and video producers must use for a client. */
export function vidsNodeResourceKey(clientId: string): string {
  const normalized = clientId.trim();
  if (!normalized || normalized.length > 220) throw new TypeError('Render-node client id is invalid');
  return `vids-render-node:${normalized}`;
}

/** @description Convert milliseconds into the migration's exact bounded whole-second contract. */
function ttlSeconds(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new TypeError('Node resource lease TTL must be between 30 seconds and 12 hours');
  }
  return Math.ceil(ttlMs / 1000);
}

/** @description Validate a non-secret operational label before it reaches the shared table. */
function label(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f]/.test(normalized)) {
    throw new TypeError(`Node resource lease ${name} is invalid`);
  }
  return normalized;
}

/** @description Convert one PostgreSQL row without weakening its exact token or timestamps. */
function fromRow(row: LeaseRow): NodeResourceLease {
  return {
    resourceKey: row.resource_key,
    leaseId: row.lease_id,
    holder: row.holder,
    purpose: row.purpose,
    acquiredAt: new Date(row.acquired_at).toISOString(),
    heartbeatAt: new Date(row.heartbeat_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    metadata: row.metadata ?? {},
  };
}

/**
 * @description Atomically take an absent or expired resource. Contention returns the incumbent;
 * it never converts a duplicate holder label into authority.
 * @param pool GUC-wrapped application pool
 * @param input exact resource, holder, purpose, TTL, and non-secret audit metadata
 * @returns acquisition result with either the new lease or the active incumbent
 */
export async function acquireNodeResourceLease(
  pool: Pool,
  input: {
    resourceKey: string;
    holder: string;
    purpose: string;
    ttlMs: number;
    metadata?: Record<string, unknown>;
  },
): Promise<NodeResourceLeaseAcquisition> {
  const startedAt = Date.now();
  const resourceKey = label(input.resourceKey, 'resource key', 255);
  const holder = label(input.holder, 'holder', 255);
  const purpose = label(input.purpose, 'purpose', 120);
  const seconds = ttlSeconds(input.ttlMs);
  try {
    const result = await runWithSystemIdentity(() => pool.query<LeaseRow>(
      'SELECT * FROM oshal_acquire_node_resource_lease($1,$2,$3,$4,$5,$6::jsonb)',
      [resourceKey, randomUUID(), holder, purpose, seconds, JSON.stringify(input.metadata ?? {})],
    ));
    if (!result.rows[0]) throw new Error('Node resource lease acquisition returned no row');
    const acquired = Boolean(result.rows[0].acquired);
    logger.info({ resourceKey, holder, acquired, durationMs: Date.now() - startedAt }, 'node resource lease acquire complete');
    return { acquired, lease: fromRow(result.rows[0]) };
  } catch (error) {
    logger.error({ err: error, resourceKey, holder, durationMs: Date.now() - startedAt }, 'node resource lease acquire failed');
    throw error;
  }
}

/**
 * @description Extend only the exact unexpired capability. A null result means it expired, was
 * replaced, or the caller supplied a stale token.
 * @param pool GUC-wrapped application pool
 * @param lease exact lease capability to renew
 * @param ttlMs new bounded lifetime from the database clock
 * @returns renewed lease, or null when the compare-and-set did not match
 */
export async function renewNodeResourceLease(
  pool: Pool,
  lease: Pick<NodeResourceLease, 'resourceKey' | 'leaseId' | 'holder'>,
  ttlMs: number,
): Promise<NodeResourceLease | null> {
  const startedAt = Date.now();
  const seconds = ttlSeconds(ttlMs);
  try {
    const result = await runWithSystemIdentity(() => pool.query<LeaseRow>(
      'SELECT * FROM oshal_renew_node_resource_lease($1,$2,$3,$4)',
      [label(lease.resourceKey, 'resource key', 255), lease.leaseId, label(lease.holder, 'holder', 255), seconds],
    ));
    const renewed = result.rows[0] ? fromRow(result.rows[0]) : null;
    logger.info({ resourceKey: lease.resourceKey, renewed: Boolean(renewed), durationMs: Date.now() - startedAt }, 'node resource lease renew complete');
    return renewed;
  } catch (error) {
    logger.error({ err: error, resourceKey: lease.resourceKey, durationMs: Date.now() - startedAt }, 'node resource lease renew failed');
    throw error;
  }
}

/**
 * @description Delete only the exact capability. A stale token cannot release a replacement.
 * @param pool GUC-wrapped application pool
 * @param lease exact lease capability to release
 * @returns true only when this invocation removed the active row
 */
export async function releaseNodeResourceLease(
  pool: Pool,
  lease: Pick<NodeResourceLease, 'resourceKey' | 'leaseId' | 'holder'>,
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const result = await runWithSystemIdentity(() => pool.query<{ released: boolean }>(
      'SELECT oshal_release_node_resource_lease($1,$2,$3) AS released',
      [label(lease.resourceKey, 'resource key', 255), lease.leaseId, label(lease.holder, 'holder', 255)],
    ));
    const released = Boolean(result.rows[0]?.released);
    logger.info({ resourceKey: lease.resourceKey, released, durationMs: Date.now() - startedAt }, 'node resource lease release complete');
    return released;
  } catch (error) {
    logger.error({ err: error, resourceKey: lease.resourceKey, durationMs: Date.now() - startedAt }, 'node resource lease release failed');
    throw error;
  }
}

/**
 * @description Read the unexpired lease for a resource under explicit system identity.
 * @param pool GUC-wrapped application pool
 * @param resourceKey exact canonical resource key
 * @returns active lease, or null when the resource is free
 */
export async function getActiveNodeResourceLease(
  pool: Pool,
  resourceKey: string,
): Promise<NodeResourceLease | null> {
  const startedAt = Date.now();
  const normalized = label(resourceKey, 'resource key', 255);
  try {
    const result = await runWithSystemIdentity(() => pool.query<LeaseRow>(
      `SELECT resource_key, lease_id, holder, purpose, acquired_at, heartbeat_at, expires_at, metadata
         FROM oshal_node_resource_leases WHERE resource_key=$1 AND expires_at>NOW()`,
      [normalized],
    ));
    const lease = result.rows[0] ? fromRow(result.rows[0]) : null;
    logger.debug({ resourceKey: normalized, held: Boolean(lease), durationMs: Date.now() - startedAt }, 'node resource lease read complete');
    return lease;
  } catch (error) {
    logger.error({ err: error, resourceKey: normalized, durationMs: Date.now() - startedAt }, 'node resource lease read failed');
    throw error;
  }
}

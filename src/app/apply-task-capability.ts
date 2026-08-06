/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add PostgreSQL-authoritative, hashed,
 *   expiring, one-use Apply completion capabilities. Each grant binds the exact task, exact owner
 *   subject, ticket, posting, destination host, remote client, operation, and ticket generation;
 *   issuing a replacement revokes stale callbacks before the new grant becomes visible.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Let recovery atomically revoke only an unclaimed callback, so it cannot interrupt a processing completion after the worker submitted.
 *
 * @module app/apply-task-capability
 */

import { createHash, randomBytes } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const configuredTtlMs = Number(process.env.APPLY_TASK_CAPABILITY_TTL_MS || 45 * 60 * 1000);
const requestedTtlMs = Number.isFinite(configuredTtlMs) ? configuredTtlMs : 45 * 60 * 1000;
const CAPABILITY_TTL_MS = Math.min(2 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, requestedTtlMs));

/** Exact server-side facts attached to one Apply run. */
export interface ApplyCapabilityBinding {
  taskId: string;
  userSub: string;
  ticketId: string;
  settleTicket: boolean;
  postingId: number;
  clientId: string;
  targetHost: string;
}

/** Plaintext returned only to the trusted remote-client envelope preparation path. */
export interface IssuedApplyCapability {
  token: string;
  expiresAt: string;
  generation: number;
}

/** Reserved server-side claim. The token hash must never be serialized or logged. */
export interface ApplyCapabilityClaim extends ApplyCapabilityBinding {
  tokenHash: string;
  generation: number;
  expiresAt: string;
}

interface CapabilityRow {
  task_id: string;
  token_hash: string;
  owner_sub: string;
  ticket_id: string;
  settle_ticket: boolean;
  posting_id: string | number;
  client_id: string;
  target_host: string;
  generation: string | number;
  expires_at: Date | string;
}

/** @description SHA-256 digest persisted instead of the bearer capability itself. */
function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** @description Run an atomic capability mutation under explicit trusted-system RLS identity. */
async function transact<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  return runWithSystemIdentity(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await action(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

/** @description Reject malformed bindings before any durable grant is written. */
function assertBinding(binding: ApplyCapabilityBinding): void {
  if (!/^apply-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.taskId)) throw new Error('invalid apply task id');
  if (!binding.userSub || !binding.userSub.trim()) throw new Error('apply capability owner required');
  if (!binding.ticketId || !binding.ticketId.trim()) throw new Error('apply capability ticket required');
  if (typeof binding.settleTicket !== 'boolean') throw new Error('apply capability ticket mode required');
  if (!Number.isSafeInteger(binding.postingId) || binding.postingId <= 0) throw new Error('invalid apply posting id');
  if (!binding.clientId || !binding.clientId.trim()) throw new Error('apply capability client required');
  if (!binding.targetHost || !binding.targetHost.trim()) throw new Error('apply capability target host required');
}

/** @description Convert one trusted database row into the exact callback claim. */
function claimFromRow(row: CapabilityRow): ApplyCapabilityClaim {
  return {
    taskId: row.task_id, tokenHash: row.token_hash, userSub: row.owner_sub,
    ticketId: row.ticket_id, settleTicket: row.settle_ticket,
    postingId: Number(row.posting_id), clientId: row.client_id,
    targetHost: row.target_host, generation: Number(row.generation),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/**
 * @description Issue the current one-use completion capability for a ticket. An advisory transaction
 * lock serializes generations; all older live generations are revoked before the new row is inserted.
 */
export async function issueApplyCapability(pool: Pool, binding: ApplyCapabilityBinding): Promise<IssuedApplyCapability> {
  assertBinding(binding);
  const token = randomBytes(32).toString('base64url');
  const hash = tokenHash(token);
  const expiresAt = new Date(Date.now() + CAPABILITY_TTL_MS);
  return transact(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [binding.ticketId]);
    await client.query(
      `UPDATE apply_task_capabilities SET state='revoked', revoked_at=NOW(), processing_started_at=NULL, updated_at=NOW()
        WHERE ticket_id=$1 AND state IN ('active','processing')`, [binding.ticketId],
    );
    const next = await client.query<{ generation: string }>(
      'SELECT (COALESCE(MAX(generation), 0) + 1)::text AS generation FROM apply_task_capabilities WHERE ticket_id=$1',
      [binding.ticketId],
    );
    const generation = Number(next.rows[0]?.generation || 1);
    await insertCapability(client, binding, hash, generation, expiresAt);
    return { token, generation, expiresAt: expiresAt.toISOString() };
  });
}

/** @description Persist one already-validated capability row inside the issuer transaction. */
async function insertCapability(
  client: PoolClient,
  binding: ApplyCapabilityBinding,
  hash: string,
  generation: number,
  expiresAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO apply_task_capabilities
       (task_id, token_hash, owner_sub, ticket_id, settle_ticket, posting_id, client_id, target_host, generation, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [binding.taskId, hash, binding.userSub, binding.ticketId, binding.settleTicket,
      binding.postingId, binding.clientId, binding.targetHost.toLowerCase(), generation, expiresAt],
  );
}

/**
 * @description Atomically reserve a live capability for terminal processing. A crashed reservation
 * may be reclaimed after two minutes; normal concurrent or replayed callbacks receive null.
 */
export async function reserveApplyCapability(pool: Pool, token: string): Promise<ApplyCapabilityClaim | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const result = await runWithSystemIdentity(() => pool.query<CapabilityRow>(
    `UPDATE apply_task_capabilities
        SET state='processing', processing_started_at=NOW(), updated_at=NOW()
      WHERE token_hash=$1 AND expires_at > NOW()
        AND (state='active' OR (state='processing' AND processing_started_at < NOW() - INTERVAL '2 minutes'))
      RETURNING task_id, token_hash, owner_sub, ticket_id, settle_ticket, posting_id, client_id,
                target_host, generation, expires_at`,
    [tokenHash(token)],
  ));
  return result.rows[0] ? claimFromRow(result.rows[0]) : null;
}

/** @description Mark a successfully committed callback consumed so it can never replay. */
export async function consumeApplyCapability(pool: Pool, claim: ApplyCapabilityClaim): Promise<boolean> {
  const result = await runWithSystemIdentity(() => pool.query(
    `UPDATE apply_task_capabilities
        SET state='consumed', consumed_at=NOW(), processing_started_at=NULL, updated_at=NOW()
      WHERE task_id=$1 AND token_hash=$2 AND generation=$3 AND state='processing'`,
    [claim.taskId, claim.tokenHash, claim.generation],
  ));
  return (result.rowCount ?? 0) === 1;
}

/** @description Return a failed processing reservation to active for a bounded callback retry. */
export async function releaseApplyCapability(pool: Pool, claim: ApplyCapabilityClaim): Promise<void> {
  await runWithSystemIdentity(() => pool.query(
    `UPDATE apply_task_capabilities
        SET state='active', processing_started_at=NULL, updated_at=NOW()
      WHERE task_id=$1 AND token_hash=$2 AND generation=$3 AND state='processing' AND expires_at > NOW()`,
    [claim.taskId, claim.tokenHash, claim.generation],
  ));
}

/** @description Revoke a task capability after dispatch failure, timeout, or cancellation. */
export async function revokeApplyCapability(pool: Pool, taskId: string): Promise<void> {
  await runWithSystemIdentity(() => pool.query(
    `UPDATE apply_task_capabilities
        SET state='revoked', revoked_at=NOW(), processing_started_at=NULL, updated_at=NOW()
      WHERE task_id=$1 AND state IN ('active','processing')`,
    [taskId],
  ));
}

export type ApplyCapabilityRecoveryState = 'revoked' | 'processing' | 'terminal' | 'missing';

/**
 * @description Revoke an unclaimed callback before ambiguous-outcome recovery. A callback that
 * already reserved its capability wins the race and must finish; recovery may retry later.
 */
export async function revokeUnclaimedApplyCapability(
  pool: Pool,
  taskId: string,
): Promise<ApplyCapabilityRecoveryState> {
  return runWithSystemIdentity(async () => {
    const revoked = await pool.query(
      `UPDATE apply_task_capabilities
          SET state='revoked', revoked_at=NOW(), processing_started_at=NULL, updated_at=NOW()
        WHERE task_id=$1 AND state='active'
        RETURNING state`,
      [taskId],
    );
    if ((revoked.rowCount ?? 0) === 1) return 'revoked';
    const current = await pool.query<{ state: string }>(
      'SELECT state FROM apply_task_capabilities WHERE task_id=$1', [taskId],
    );
    if (!current.rows[0]) return 'missing';
    return current.rows[0].state === 'processing' ? 'processing' : 'terminal';
  });
}

/** @description Parse the exact x-oshal-callback-capability value used by trusted callbacks. */
export function readApplyCapabilityHeader(value: string | undefined): string | null {
  const token = String(value || '');
  return TOKEN_PATTERN.test(token) ? token : null;
}

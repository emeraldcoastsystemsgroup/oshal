/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Implement the PostgreSQL SEC-01 workload/delegation authority with hash-only registration, bounded overlapping rotation, broker-scoped forced RLS, immutable grant recording, revocation, and locked single-use consumption.
 */

import type { Pool, PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { DelegationTokenClaims } from '@/shared/types';
import {
  hashWorkloadCredential,
  normalizeWorkloadScopes,
  requireWorkloadId,
  requireWorkloadKeyId,
  workloadCredentialHashMatches,
} from './workload-credential';
import type {
  AuthenticateWorkloadCredentialInput,
  RecordUserDelegationInput,
  RegisterWorkloadIdentityInput,
  RotateWorkloadCredentialInput,
  WorkloadDelegationConsumeOutcome,
  WorkloadDelegationStore,
  WorkloadIdentityRecord,
  WorkloadKind,
  WorkloadStatus,
} from './workload-delegation-types';

const logger = createChildLogger({ module: 'postgres-workload-delegation-store' });
const MAX_CREDENTIAL_OVERLAP_MS = 24 * 60 * 60 * 1_000;

interface WorkloadIdentityRow {
  workload_id: string;
  workload_kind: WorkloadKind;
  credential_hash: string;
  allowed_scopes: string[];
  status: WorkloadStatus;
  expires_at: Date | string | null;
  current_key_id: string;
  rotated_at: Date | string | null;
  previous_credential_hash: string | null;
  previous_key_id: string | null;
  previous_valid_until: Date | string | null;
}

interface DelegationAuthorityRow extends WorkloadIdentityRow {
  jti: string;
  delegated_workload_id: string;
  user_sub: string;
  principal_issuer: string;
  ticket_id: string | null;
  run_id: string | null;
  route_method: string;
  route_path: string;
  body_sha256: string;
  scopes: string[];
  issued_at: Date | string;
  not_before: Date | string;
  delegation_expires_at: Date | string;
  revoked_at: Date | string | null;
  consumed_at: Date | string | null;
}

/** @description PostgreSQL-backed durable authority; it deliberately has no in-memory fallback. */
export class PostgresWorkloadDelegationStore implements WorkloadDelegationStore {
  /**
   * @description Creates a store over the control-plane pool. Migration 119 must already exist;
   * runtime DDL is forbidden because authorization schema changes belong to protected migrations.
   * @param pool - PostgreSQL pool used only through broker-marked transactions.
   */
  constructor(private readonly pool: Pool) {}

  /** @inheritdoc */
  async registerWorkload(input: RegisterWorkloadIdentityInput): Promise<WorkloadIdentityRecord> {
    return this.runLogged('register_workload', { workloadId: input.workloadId }, async (client) => {
      const values = normalizeRegistration(input);
      const result = await client.query<WorkloadIdentityRow>(REGISTER_WORKLOAD_SQL, values);
      if (!result.rows[0]) throw new Error('Workload identity already exists');
      return mapWorkload(result.rows[0]);
    });
  }

  /** @inheritdoc */
  async rotateWorkloadCredential(input: RotateWorkloadCredentialInput): Promise<boolean> {
    return this.runLogged('rotate_workload_credential', { workloadId: input.workloadId }, async (client) => {
      const values = normalizeRotation(input);
      const result = await client.query<{ workload_id: string }>(ROTATE_WORKLOAD_SQL, values);
      return Boolean(result.rows[0]);
    });
  }

  /** @inheritdoc */
  async authenticateWorkloadCredential(input: AuthenticateWorkloadCredentialInput): Promise<boolean> {
    return this.runLogged('authenticate_workload', { workloadId: input.workloadId }, async (client) => {
      const workloadId = requireWorkloadId(input.workloadId);
      const keyId = requireWorkloadKeyId(input.keyId);
      const scopes = normalizeWorkloadScopes(input.requiredScopes);
      const at = validDate(input.at ?? new Date(), 'authentication time');
      const row = (await selectWorkload(client, workloadId)).rows[0];
      return Boolean(row && workloadIsActive(row, at) && includesAll(row.allowed_scopes, scopes)
        && credentialMatches(row, keyId, input.credential, at));
    });
  }

  /** @inheritdoc */
  async canIssueForWorkload(
    workloadId: string,
    scopes: readonly string[],
    at = new Date(),
  ): Promise<boolean> {
    return this.runLogged('authorize_workload_issuance', { workloadId }, async (client) => {
      const normalizedId = requireWorkloadId(workloadId);
      const normalizedScopes = normalizeWorkloadScopes(scopes);
      const checkedAt = validDate(at, 'issuance time');
      const row = (await selectWorkload(client, normalizedId)).rows[0];
      return Boolean(row && workloadIsActive(row, checkedAt)
        && includesAll(row.allowed_scopes, normalizedScopes));
    });
  }

  /** @inheritdoc */
  async recordDelegation(input: RecordUserDelegationInput): Promise<void> {
    await this.runLogged('record_delegation', { workloadId: input.claims.azp }, async (client) => {
      const values = normalizeRecordedDelegation(input);
      const result = await client.query<{ jti: string }>(RECORD_DELEGATION_SQL, values);
      if (!result.rows[0]) throw new Error('Delegation identifier already exists');
    });
  }

  /** @inheritdoc */
  async consumeDelegation(
    claims: DelegationTokenClaims,
    at = new Date(),
  ): Promise<WorkloadDelegationConsumeOutcome> {
    return this.runLogged('consume_delegation', { workloadId: claims.azp }, async (client) => {
      const checkedAt = validDate(at, 'consumption time');
      const row = (await client.query<DelegationAuthorityRow>(LOCK_DELEGATION_SQL, [claims.jti])).rows[0];
      const outcome = classifyDelegation(row, claims, checkedAt);
      if (outcome !== 'authorized') return outcome;
      const consumed = await client.query<{ jti: string }>(CONSUME_DELEGATION_SQL, [claims.jti, checkedAt]);
      return consumed.rows[0] ? 'authorized' : 'replayed';
    });
  }

  /** @inheritdoc */
  async revokeDelegation(jti: string, revokedAt = new Date()): Promise<boolean> {
    return this.runLogged('revoke_delegation', {}, async (client) => {
      const identifier = requireJti(jti);
      const timestamp = validDate(revokedAt, 'revocation time');
      const result = await client.query<{ jti: string }>(REVOKE_DELEGATION_SQL, [identifier, timestamp]);
      return Boolean(result.rows[0]);
    });
  }

  private async runLogged<T>(
    operation: string,
    fields: Record<string, unknown>,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    logger.info({ operation, ...fields }, 'Workload delegation store operation entered');
    try {
      const result = await withDelegationBroker(this.pool, action);
      logger.info({ operation, ...fields, durationMs: Date.now() - startedAt }, 'Workload delegation store operation exited');
      return result;
    } catch (error) {
      logger.error({ err: error, operation, ...fields, durationMs: Date.now() - startedAt }, 'Workload delegation store operation failed');
      throw error;
    }
  }
}

function normalizeRegistration(input: RegisterWorkloadIdentityInput): unknown[] {
  const workloadId = requireWorkloadId(input.workloadId);
  const keyId = requireWorkloadKeyId(input.keyId);
  const scopes = normalizeWorkloadScopes(input.allowedScopes, 64);
  if (!['bot', 'node', 'controller', 'automation'].includes(input.workloadKind)) {
    throw new Error('Workload kind is invalid');
  }
  const expiresAt = input.expiresAt == null ? null : validDate(input.expiresAt, 'workload expiry');
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new Error('Workload expiry must be future');
  return [workloadId, input.workloadKind, hashWorkloadCredential(input.credential), scopes, expiresAt, keyId];
}

function normalizeRotation(input: RotateWorkloadCredentialInput): unknown[] {
  const workloadId = requireWorkloadId(input.workloadId);
  const currentKeyId = requireWorkloadKeyId(input.expectedCurrentKeyId);
  const nextKeyId = requireWorkloadKeyId(input.nextKeyId);
  if (currentKeyId === nextKeyId) throw new Error('Rotated credential requires a new key id');
  const rotatedAt = validDate(input.rotatedAt ?? new Date(), 'rotation time');
  const overlapUntil = validDate(input.previousValidUntil, 'previous credential expiry');
  const overlapMs = overlapUntil.getTime() - rotatedAt.getTime();
  if (overlapMs <= 0 || overlapMs > MAX_CREDENTIAL_OVERLAP_MS) {
    throw new Error('Credential overlap must be positive and no longer than 24 hours');
  }
  return [workloadId, currentKeyId, nextKeyId, hashWorkloadCredential(input.nextCredential), rotatedAt, overlapUntil];
}

function normalizeRecordedDelegation(input: RecordUserDelegationInput): unknown[] {
  const { claims } = input;
  const dispatchId = requireSingleDispatch(input.ticketId, input.runId);
  if (dispatchId !== claims.task_id) throw new Error('Delegation dispatch id does not match signed task');
  const scopes = normalizeWorkloadScopes(claims.scope);
  return [claims.jti, requireWorkloadId(claims.azp), claims.sub, claims.principal_iss,
    input.ticketId ?? null, input.runId ?? null, claims.method, claims.path, claims.body_sha256,
    scopes, epochDate(claims.iat), epochDate(claims.nbf), epochDate(claims.exp)];
}

function classifyDelegation(
  row: DelegationAuthorityRow | undefined,
  claims: DelegationTokenClaims,
  at: Date,
): WorkloadDelegationConsumeOutcome {
  if (!row) return 'not_found';
  if (row.revoked_at) return 'revoked';
  if (row.consumed_at) return 'replayed';
  if (at < asDate(row.not_before) || at >= asDate(row.delegation_expires_at)) return 'expired';
  if (!workloadIsActive(row, at)) return 'not_active';
  if (!sameDelegationBindings(row, claims)) return 'binding_mismatch';
  if (!includesAll(row.allowed_scopes, claims.scope)) return 'insufficient_scope';
  return 'authorized';
}

function sameDelegationBindings(row: DelegationAuthorityRow, claims: DelegationTokenClaims): boolean {
  return row.delegated_workload_id === claims.azp
    && row.user_sub === claims.sub
    && row.principal_issuer === claims.principal_iss
    && (row.ticket_id ?? row.run_id) === claims.task_id
    && row.route_method === claims.method
    && row.route_path === claims.path
    && row.body_sha256 === claims.body_sha256
    && sameScopes(row.scopes, claims.scope)
    && asDate(row.issued_at).getTime() === epochDate(claims.iat).getTime()
    && asDate(row.not_before).getTime() === epochDate(claims.nbf).getTime()
    && asDate(row.delegation_expires_at).getTime() === epochDate(claims.exp).getTime();
}

function credentialMatches(row: WorkloadIdentityRow, keyId: string, credential: string, at: Date): boolean {
  if (keyId === row.current_key_id) {
    return workloadCredentialHashMatches(credential, row.credential_hash);
  }
  return keyId === row.previous_key_id
    && row.previous_valid_until !== null
    && at < asDate(row.previous_valid_until)
    && row.previous_credential_hash !== null
    && workloadCredentialHashMatches(credential, row.previous_credential_hash);
}

function workloadIsActive(row: WorkloadIdentityRow, at: Date): boolean {
  return row.status === 'active' && (row.expires_at === null || at < asDate(row.expires_at));
}

function includesAll(allowed: readonly string[], required: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return required.every((scope) => allowedSet.has(scope));
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((scope, index) => scope === b[index]);
}

function requireSingleDispatch(ticketId?: string, runId?: string): string {
  const values = [ticketId, runId].filter((value): value is string => typeof value === 'string');
  if (values.length !== 1 || values[0].length === 0 || values[0].length > 256) {
    throw new Error('Exactly one bounded ticketId or runId is required');
  }
  return values[0];
}

function requireJti(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(value)) {
    throw new Error('Delegation identifier is invalid');
  }
  return value;
}

function epochDate(value: number): Date {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Delegation time is invalid');
  return new Date(value * 1_000);
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${label} is invalid`);
  return value;
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Stored delegation timestamp is invalid');
  return date;
}

function mapWorkload(row: WorkloadIdentityRow): WorkloadIdentityRecord {
  return {
    workloadId: row.workload_id,
    workloadKind: row.workload_kind,
    allowedScopes: [...row.allowed_scopes],
    status: row.status,
    expiresAt: row.expires_at === null ? null : asDate(row.expires_at),
    currentKeyId: row.current_key_id,
    rotatedAt: row.rotated_at === null ? null : asDate(row.rotated_at),
    previousKeyId: row.previous_key_id,
    previousValidUntil: row.previous_valid_until === null ? null : asDate(row.previous_valid_until),
  };
}

async function selectWorkload(client: PoolClient, workloadId: string) {
  return client.query<WorkloadIdentityRow>(`${WORKLOAD_COLUMNS} WHERE workload_id=$1`, [workloadId]);
}

async function withDelegationBroker<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('oshal.workload_delegation_broker', 'on', true)");
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) { logger.error({ err: rollbackError }, 'Workload delegation rollback failed'); }
    throw error;
  } finally {
    client.release();
  }
}

const WORKLOAD_COLUMNS = `SELECT workload_id, workload_kind, credential_hash, allowed_scopes,
  status, expires_at, current_key_id, rotated_at, previous_credential_hash,
  previous_key_id, previous_valid_until FROM oshal_workload_identities`;

const REGISTER_WORKLOAD_SQL = `INSERT INTO oshal_workload_identities
  (workload_id, workload_kind, credential_hash, allowed_scopes, expires_at, current_key_id)
  VALUES ($1,$2,$3,$4::text[],$5,$6) ON CONFLICT (workload_id) DO NOTHING
  RETURNING workload_id, workload_kind, credential_hash, allowed_scopes, status, expires_at,
    current_key_id, rotated_at, previous_credential_hash, previous_key_id, previous_valid_until`;

const ROTATE_WORKLOAD_SQL = `UPDATE oshal_workload_identities SET
  previous_credential_hash=credential_hash, previous_key_id=current_key_id,
  previous_valid_until=$6, credential_hash=$4, current_key_id=$3, rotated_at=$5, updated_at=$5
  WHERE workload_id=$1 AND current_key_id=$2 AND status <> 'revoked' RETURNING workload_id`;

const RECORD_DELEGATION_SQL = `INSERT INTO oshal_user_delegations
  (jti, workload_id, user_sub, principal_issuer, ticket_id, run_id, route_method, route_path,
   body_sha256, scopes, issued_at, not_before, expires_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13)
  ON CONFLICT (jti) DO NOTHING RETURNING jti`;

const LOCK_DELEGATION_SQL = `SELECT d.jti, d.workload_id AS delegated_workload_id, d.user_sub,
  d.principal_issuer, d.ticket_id, d.run_id, d.route_method, d.route_path, d.body_sha256,
  d.scopes, d.issued_at, d.not_before, d.expires_at AS delegation_expires_at,
  d.revoked_at, d.consumed_at, w.workload_id, w.workload_kind, w.credential_hash,
  w.allowed_scopes, w.status, w.expires_at, w.current_key_id, w.rotated_at,
  w.previous_credential_hash, w.previous_key_id, w.previous_valid_until
  FROM oshal_user_delegations d JOIN oshal_workload_identities w USING (workload_id)
  WHERE d.jti=$1 FOR UPDATE OF d, w`;

const CONSUME_DELEGATION_SQL = `UPDATE oshal_user_delegations SET consumed_at=$2
  WHERE jti=$1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING jti`;

const REVOKE_DELEGATION_SQL = `UPDATE oshal_user_delegations SET revoked_at=$2
  WHERE jti=$1 AND revoked_at IS NULL RETURNING jti`;

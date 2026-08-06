/**
 * PostgreSQL-authoritative state machine for one job-application attempt. The in-process
 * applyInFlight map is only a timer/projection cache; this ledger owns claim uniqueness, task and
 * worker binding, terminal ambiguity, and confirmation provenance across controller restarts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Implement Apply V2 durable run creation, exact claim binding, compare-and-set transitions, restart reads, and verified/unknown terminal outcomes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Bound undispatched claims to two minutes, replace that deadline when a worker is durably bound, and persist every manual application assertion in the same authoritative ledger.
 *
 * @module app/apply-run-ledger
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

export const ACTIVE_APPLY_RUN_STATES = [
  'claimed', 'queued_to_worker', 'acknowledged', 'running',
] as const;

/** A Career claim that never acquires a durable task/worker binding is safe to release quickly. */
export const APPLY_UNDISPATCHED_TIMEOUT_MS = 2 * 60_000;

export type ActiveApplyRunState = typeof ACTIVE_APPLY_RUN_STATES[number];
export type ApplyRunState = ActiveApplyRunState
  | 'submitted_verified'
  | 'manual_mark'
  | 'failed'
  | 'abandoned'
  | 'unknown_outcome';

export interface ApplyRunMetadata {
  trigger: 'authenticated-single-job' | 'career-auto-submit-setting' | 'assist-only' | 'manual';
  initiatedBySub: string;
  automationSettingsVersion: string;
  [key: string]: unknown;
}

export interface ApplyRunRecord {
  runId: string;
  ticketId: string;
  ownerSub: string;
  postingId: number;
  claimToken: string;
  taskId: string | null;
  workerClientId: string | null;
  state: ApplyRunState;
  claimedAt: string;
  dispatchedAt: string | null;
  acknowledgedAt: string | null;
  lastProgressAt: string | null;
  timeoutAt: string;
  finishedAt: string | null;
  result: Record<string, unknown> | null;
  failureCode: string | null;
  failureDetail: string | null;
  confirmationPath: string | null;
  confirmationSha256: string | null;
  metadata: ApplyRunMetadata;
}

interface ApplyRunRow {
  run_id: string;
  ticket_id: string;
  owner_sub: string;
  posting_id: string | number;
  claim_token: string;
  task_id: string | null;
  worker_client_id: string | null;
  state: ApplyRunState;
  claimed_at: Date | string;
  dispatched_at: Date | string | null;
  acknowledged_at: Date | string | null;
  last_progress_at: Date | string | null;
  timeout_at: Date | string;
  finished_at: Date | string | null;
  result: Record<string, unknown> | null;
  failure_code: string | null;
  failure_detail: string | null;
  confirmation_path: string | null;
  confirmation_sha256: string | null;
  metadata: ApplyRunMetadata;
}

const RETURNING_COLUMNS = `run_id, ticket_id, owner_sub, posting_id, claim_token, task_id,
  worker_client_id, state, claimed_at, dispatched_at, acknowledged_at, last_progress_at,
  timeout_at, finished_at, result, failure_code, failure_detail, confirmation_path,
  confirmation_sha256, metadata`;

/** @description Convert one database row without weakening exact owner or token values. */
function fromRow(row: ApplyRunRow): ApplyRunRecord {
  const iso = (value: Date | string | null): string | null => value === null
    ? null : new Date(value).toISOString();
  return {
    runId: row.run_id,
    ticketId: row.ticket_id,
    ownerSub: row.owner_sub,
    postingId: Number(row.posting_id),
    claimToken: row.claim_token,
    taskId: row.task_id,
    workerClientId: row.worker_client_id,
    state: row.state,
    claimedAt: iso(row.claimed_at) as string,
    dispatchedAt: iso(row.dispatched_at),
    acknowledgedAt: iso(row.acknowledged_at),
    lastProgressAt: iso(row.last_progress_at),
    timeoutAt: iso(row.timeout_at) as string,
    finishedAt: iso(row.finished_at),
    result: row.result,
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    confirmationPath: row.confirmation_path,
    confirmationSha256: row.confirmation_sha256,
    metadata: row.metadata,
  };
}

/** @description Validate the exact immutable binding before the first durable mutation. */
function assertCreateInput(input: {
  ticketId: string;
  ownerSub: string;
  postingId: number;
  timeoutAt: Date;
  metadata: ApplyRunMetadata;
}): void {
  if (!input.ticketId.trim()) throw new TypeError('Apply run ticket id is required');
  if (!input.ownerSub.trim()) throw new TypeError('Apply run owner is required');
  if (!Number.isSafeInteger(input.postingId) || input.postingId <= 0) {
    throw new TypeError('Apply run posting id must be a positive safe integer');
  }
  if (!Number.isFinite(input.timeoutAt.getTime()) || input.timeoutAt.getTime() <= Date.now()) {
    throw new TypeError('Apply run timeout must be in the future');
  }
  if (!input.metadata.trigger || input.metadata.initiatedBySub !== input.ownerSub ||
      !input.metadata.automationSettingsVersion) {
    throw new TypeError('Apply run automation metadata is incomplete or owner-mismatched');
  }
}

/**
 * @description Create the durable claim before touching the Career queue or remote worker. The
 * partial unique index makes a duplicate active owner/posting return null without racing.
 */
export async function createApplyRun(
  pool: Pool,
  input: {
    ticketId: string;
    ownerSub: string;
    postingId: number;
    timeoutAt: Date;
    metadata: ApplyRunMetadata;
  },
): Promise<ApplyRunRecord | null> {
  assertCreateInput(input);
  const runId = randomUUID();
  const claimToken = randomUUID();
  try {
    const result = await runWithSystemIdentity(() => pool.query<ApplyRunRow>(
      `INSERT INTO apply_runs
         (run_id, ticket_id, owner_sub, posting_id, claim_token, state, claimed_at, timeout_at, metadata)
       VALUES ($1,$2,$3,$4,$5,'claimed',NOW(),$6,$7::jsonb)
       RETURNING ${RETURNING_COLUMNS}`,
      [runId, input.ticketId, input.ownerSub, input.postingId, claimToken,
        input.timeoutAt, JSON.stringify(input.metadata)],
    ));
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  } catch (error) {
    const candidate = error as { code?: string; constraint?: string };
    if (candidate.code === '23505' &&
        candidate.constraint === 'uq_apply_runs_active_owner_posting') return null;
    throw error;
  }
}

/** @description Bind the exact task and worker immediately after the durable queue accepts them. */
export async function bindApplyRunDispatch(
  pool: Pool,
  runId: string,
  taskId: string,
  workerClientId: string,
  timeoutAt: Date,
): Promise<ApplyRunRecord | null> {
  if (!Number.isFinite(timeoutAt.getTime()) || timeoutAt.getTime() <= Date.now()) {
    throw new TypeError('Dispatched Apply run timeout must be in the future');
  }
  const result = await runWithSystemIdentity(() => pool.query<ApplyRunRow>(
    `UPDATE apply_runs
        SET state='queued_to_worker', task_id=$2, worker_client_id=$3,
            dispatched_at=NOW(), last_progress_at=NOW(), timeout_at=$4, updated_at=NOW()
      WHERE run_id=$1 AND state='claimed'
      RETURNING ${RETURNING_COLUMNS}`,
    [runId, taskId, workerClientId, timeoutAt],
  ));
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

const ALLOWED_TRANSITIONS: Readonly<Record<ApplyRunState, readonly ApplyRunState[]>> = {
  claimed: ['queued_to_worker', 'failed', 'abandoned'],
  queued_to_worker: ['acknowledged', 'running', 'failed', 'abandoned', 'unknown_outcome'],
  acknowledged: ['running', 'failed', 'abandoned', 'unknown_outcome'],
  running: ['submitted_verified', 'failed', 'unknown_outcome'],
  unknown_outcome: ['manual_mark'],
  submitted_verified: [],
  manual_mark: [],
  failed: [],
  abandoned: [],
};

export interface ApplyRunTransition {
  runId: string;
  from: readonly ApplyRunState[];
  to: ApplyRunState;
  result?: Record<string, unknown> | null;
  failureCode?: string | null;
  failureDetail?: string | null;
  confirmationPath?: string | null;
  confirmationSha256?: string | null;
}

/** @description Refuse illegal caller-declared edges before issuing the compare-and-set query. */
function assertTransition(input: ApplyRunTransition): void {
  if (!input.runId || input.from.length === 0) throw new TypeError('Apply run CAS binding is required');
  for (const state of input.from) {
    if (!ALLOWED_TRANSITIONS[state].includes(input.to)) {
      throw new TypeError(`Illegal Apply run transition ${state} -> ${input.to}`);
    }
  }
  if (input.to === 'submitted_verified' &&
      (!input.confirmationPath || !/^[0-9a-f]{64}$/.test(input.confirmationSha256 || ''))) {
    throw new TypeError('A verified Apply run requires a confirmation path and SHA-256');
  }
}

/** @description Compare-and-set one legal state edge; a lost race returns null. */
export async function transitionApplyRun(
  pool: Pool,
  input: ApplyRunTransition,
): Promise<ApplyRunRecord | null> {
  assertTransition(input);
  const terminal = !ACTIVE_APPLY_RUN_STATES.includes(input.to as ActiveApplyRunState);
  const result = await runWithSystemIdentity(() => pool.query<ApplyRunRow>(
    `UPDATE apply_runs
        SET state=$3,
            acknowledged_at=CASE WHEN $3 IN ('acknowledged','running') THEN COALESCE(acknowledged_at,NOW()) ELSE acknowledged_at END,
            last_progress_at=CASE WHEN $3 IN ('acknowledged','running') THEN NOW() ELSE last_progress_at END,
            finished_at=CASE WHEN $4::boolean THEN NOW() ELSE finished_at END,
            result=COALESCE($5::jsonb,result), failure_code=COALESCE($6,failure_code),
            failure_detail=COALESCE($7,failure_detail),
            confirmation_path=COALESCE($8,confirmation_path),
            confirmation_sha256=COALESCE($9,confirmation_sha256), updated_at=NOW()
      WHERE run_id=$1 AND state=ANY($2::text[])
      RETURNING ${RETURNING_COLUMNS}`,
    [input.runId, [...input.from], input.to, terminal,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.failureCode ?? null, input.failureDetail?.slice(0, 4000) ?? null,
      input.confirmationPath ?? null, input.confirmationSha256 ?? null],
  ));
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

/** @description Read the exact durable run bound to a trusted remote task. */
export async function getApplyRunByTask(pool: Pool, taskId: string): Promise<ApplyRunRecord | null> {
  const result = await runWithSystemIdentity(() => pool.query<ApplyRunRow>(
    `SELECT ${RETURNING_COLUMNS} FROM apply_runs WHERE task_id=$1`, [taskId],
  ));
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

/** @description Read every nonterminal run for restart rehydration and watchdog reconciliation. */
export async function listActiveApplyRuns(pool: Pool): Promise<ApplyRunRecord[]> {
  const result = await runWithSystemIdentity(() => pool.query<ApplyRunRow>(
    `SELECT ${RETURNING_COLUMNS} FROM apply_runs
      WHERE state=ANY($1::text[]) ORDER BY claimed_at ASC`,
    [[...ACTIVE_APPLY_RUN_STATES]],
  ));
  return result.rows.map(fromRow);
}

/** @description Read a bounded oldest-first set whose state-specific durable deadline has elapsed. */
export async function listExpiredApplyRuns(
  pool: Pool,
  limit = 100,
): Promise<ApplyRunRecord[]> {
  const boundedLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const result = await runWithSystemIdentity(() => pool.query<ApplyRunRow>(
    `SELECT ${RETURNING_COLUMNS} FROM apply_runs
      WHERE state=ANY($1::text[]) AND timeout_at<=NOW()
      ORDER BY timeout_at ASC LIMIT $2`,
    [[...ACTIVE_APPLY_RUN_STATES], boundedLimit],
  ));
  return result.rows.map(fromRow);
}

/**
 * @description Persist an authenticated manual status assertion without pretending that a browser
 * worker or retained confirmation produced it. A prior unknown outcome is reconciled in place; an
 * active automated run is rejected so a manual click cannot race a still-running submission.
 */
export async function recordManualApplyRun(
  pool: Pool,
  input: {
    ownerSub: string;
    postingId: number;
    ticketId: string;
    sourceRoute: string;
  },
): Promise<ApplyRunRecord> {
  if (!input.ownerSub.trim() || !input.ticketId.trim() || !input.sourceRoute.trim()) {
    throw new TypeError('Manual Apply run owner, ticket, and source route are required');
  }
  if (!Number.isSafeInteger(input.postingId) || input.postingId <= 0) {
    throw new TypeError('Manual Apply run posting id must be a positive safe integer');
  }

  const current = await runWithSystemIdentity(() => pool.query<ApplyRunRow>(
    `SELECT ${RETURNING_COLUMNS} FROM apply_runs
      WHERE owner_sub=$1 AND posting_id=$2
        AND state=ANY($3::text[])
      ORDER BY claimed_at DESC LIMIT 1`,
    [input.ownerSub, input.postingId, [...ACTIVE_APPLY_RUN_STATES, 'unknown_outcome']],
  ));
  const existing = current.rows[0] ? fromRow(current.rows[0]) : null;
  if (existing && existing.state !== 'unknown_outcome') {
    throw new Error('An automated Apply run is still active for this posting');
  }
  if (existing) {
    const reconciled = await transitionApplyRun(pool, {
      runId: existing.runId,
      from: ['unknown_outcome'],
      to: 'manual_mark',
      result: { sourceRoute: input.sourceRoute, assertedBySub: input.ownerSub },
    });
    if (!reconciled) throw new Error('Manual Apply reconciliation lost its compare-and-set');
    return reconciled;
  }

  const result = await runWithSystemIdentity(() => pool.query<ApplyRunRow>(
    `INSERT INTO apply_runs
       (run_id, ticket_id, owner_sub, posting_id, claim_token, state, claimed_at,
        timeout_at, finished_at, result, metadata)
     VALUES ($1,$2,$3,$4,$5,'manual_mark',NOW(),NOW(),NOW(),$6::jsonb,$7::jsonb)
     RETURNING ${RETURNING_COLUMNS}`,
    [randomUUID(), input.ticketId, input.ownerSub, input.postingId, randomUUID(),
      JSON.stringify({ sourceRoute: input.sourceRoute, assertedBySub: input.ownerSub }),
      JSON.stringify({
        trigger: 'manual',
        initiatedBySub: input.ownerSub,
        automationSettingsVersion: 'manual-mark-v1',
      })],
  ));
  if (!result.rows[0]) throw new Error('Manual Apply ledger insert returned no row');
  return fromRow(result.rows[0]);
}

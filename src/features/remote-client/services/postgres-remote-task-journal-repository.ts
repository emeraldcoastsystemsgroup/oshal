/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Implement the PostgreSQL-authoritative remote-task journal with transaction-serialized claims, first-writer terminal settlement, append-only events, crash-replayable outbox delivery, and guarded 30-day tombstone cleanup.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Reject terminal results whose correlation does not match the claimed task before any state, journal, or outbox mutation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Serialize owner binding, enqueue, claim, and owner transitions on one per-client advisory lock; every claim SQL predicate now binds both clientId and expectedOwnerSub.
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { ensureRemoteTaskJournalSchema } from '@/shared/services/database';
import type { A2ATaskEnvelope, A2ATaskResult } from '@/shared/types';
import {
  REMOTE_TASK_TOMBSTONE_DAYS,
  type BindRemoteClientOwnerInput,
  type BindRemoteClientOwnerOutcome,
  type ClaimRemoteTaskInput,
  type ClaimRemoteTaskOutcome,
  type DurableRemoteTaskRecord,
  type EnqueueRemoteTaskInput,
  type EnqueueRemoteTaskOutcome,
  type RemoteTaskJournalEvent,
  type RemoteTaskJournalEventType,
  type RemoteTaskJournalRepository,
  type RemoteTaskJournalStatus,
  type RemoteTaskOutboxPublisher,
  type RemoteTaskOutboxRecord,
  type RemoteTaskOutboxTopic,
  type SettleRemoteTaskInput,
  type SettleRemoteTaskOutcome,
  type TransitionRemoteClientOwnerInput,
  type TransitionRemoteClientOwnerOutcome,
} from './remote-task-journal-types';

const logger = createChildLogger({ module: 'postgres-remote-task-journal-repository' });

const TASK_COLUMNS = `task_id, client_id, owner_sub, correlation_id, envelope, status,
  claimed_by_client_id, claimed_at, settled_at, terminal_result,
  tombstone_expires_at, created_at, updated_at`;

interface RemoteTaskRow {
  task_id: string;
  client_id: string;
  owner_sub: string | null;
  correlation_id: string;
  envelope: A2ATaskEnvelope | string;
  status: RemoteTaskJournalStatus;
  claimed_by_client_id: string | null;
  claimed_at: Date | string | null;
  settled_at: Date | string | null;
  terminal_result: A2ATaskResult | string | null;
  tombstone_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DuplicateRemoteTaskRow extends RemoteTaskRow {
  same_request: boolean;
}

interface RemoteTaskEventRow {
  event_id: string | number;
  task_id: string;
  client_id: string;
  owner_sub: string | null;
  sequence_number: number;
  event_type: RemoteTaskJournalEventType;
  payload: Record<string, unknown> | string;
  created_at: Date | string;
}

interface RemoteTaskOutboxRow {
  outbox_id: string;
  task_id: string;
  client_id: string;
  owner_sub: string | null;
  event_id: string | number;
  topic: RemoteTaskOutboxTopic;
  payload: Record<string, unknown> | string;
  created_at: Date | string;
  delivered_at: Date | string | null;
}

interface RemoteClientOwnerRow {
  client_id: string;
  owner_sub: string | null;
}

type SchemaInitializer = (pool: Pool) => Promise<void>;

/**
 * @description PostgreSQL implementation of the durable remote-task lifecycle boundary.
 * It deliberately has no in-memory fallback: losing the database must stop task mutation
 * rather than split authority between a process heap and persisted state.
 */
export class PostgresRemoteTaskJournalRepository implements RemoteTaskJournalRepository {
  private initialization: Promise<void> | null = null;

  /**
   * @description Creates a repository over an explicit PostgreSQL pool.
   * @param pool - Control-plane database pool; required because fallback state is forbidden.
   * @param schemaInitializer - Injectable schema gate used by deterministic repository tests.
   */
  constructor(
    private readonly pool: Pool,
    private readonly schemaInitializer: SchemaInitializer = ensureRemoteTaskJournalSchema,
  ) {}

  /** @description Ensures schema readiness once per repository instance. @returns Completion promise. */
  async initialize(): Promise<void> {
    if (!this.initialization) {
      const startedAt = Date.now();
      logger.info('Initializing durable remote-task journal');
      this.initialization = this.schemaInitializer(this.pool).then(() => {
        logger.info({ durationMs: Date.now() - startedAt }, 'Durable remote-task journal initialized');
      }).catch((error) => {
        logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Durable remote-task journal initialization failed');
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  /**
   * @description Inserts a queued task, its first journal event, and dispatch outbox row atomically.
   * @param input - Fixed target, owner, and validated A2A envelope.
   * @returns Enqueued, idempotent duplicate, or conflicting task-id outcome.
   */
  async enqueue(input: EnqueueRemoteTaskInput): Promise<EnqueueRemoteTaskOutcome> {
    const startedAt = Date.now();
    logger.info({ taskId: input.task.taskId, clientId: input.clientId }, 'Enqueuing durable remote task');
    await this.initialize();
    const outcome = await withTransaction(this.pool, 'enqueue-task', (client) => this.enqueueTx(client, input));
    logger.info({ taskId: input.task.taskId, clientId: input.clientId, outcome: outcome.kind, durationMs: Date.now() - startedAt }, 'Durable remote task enqueue finished');
    return outcome;
  }

  /** @description Creates or verifies the durable client-owner binding under the client lock. */
  async bindClientOwner(input: BindRemoteClientOwnerInput): Promise<BindRemoteClientOwnerOutcome> {
    await this.initialize();
    return withTransaction(this.pool, 'bind-client-owner', (client) => this.bindClientOwnerTx(client, input));
  }

  /** @description Reassigns an owner only when no queued or claimed task can race the change. */
  async transitionClientOwner(
    input: TransitionRemoteClientOwnerInput,
  ): Promise<TransitionRemoteClientOwnerOutcome> {
    await this.initialize();
    return withTransaction(
      this.pool,
      'transition-client-owner',
      (client) => this.transitionClientOwnerTx(client, input),
    );
  }

  /**
   * @description Claims the oldest queued task after serializing all pollers for one client.
   * @param input - Authenticated target client and its expected durable owner.
   * @returns Claimed task, current active task, or empty outcome.
   */
  async claimNext(input: ClaimRemoteTaskInput): Promise<ClaimRemoteTaskOutcome> {
    const startedAt = Date.now();
    logger.info({ clientId: input.clientId }, 'Claiming next durable remote task');
    await this.initialize();
    const outcome = await withTransaction(this.pool, 'claim-task', (client) => this.claimNextTx(client, input));
    logger.info({ clientId: input.clientId, outcome: outcome.kind, taskId: outcome.task?.taskId, durationMs: Date.now() - startedAt }, 'Durable remote task claim finished');
    return outcome;
  }

  /**
   * @description Records the first terminal result without allowing later writes to replace it.
   * @param input - Claiming client and validated terminal result.
   * @returns Whether this call settled, repeated, conflicted, or lacked authority.
   */
  async settle(input: SettleRemoteTaskInput): Promise<SettleRemoteTaskOutcome> {
    assertSettlementIdentity(input);
    const startedAt = Date.now();
    logger.info({ taskId: input.result.taskId, clientId: input.clientId, status: input.result.status }, 'Settling durable remote task');
    await this.initialize();
    const outcome = await withTransaction(this.pool, 'settle-task', (client) => this.settleTx(client, input));
    logger.info({ taskId: input.result.taskId, clientId: input.clientId, outcome: outcome.kind, durationMs: Date.now() - startedAt }, 'Durable remote task settlement finished');
    return outcome;
  }

  /**
   * @description Reads the authoritative task projection, including any retained tombstone.
   * @param taskId - Stable task identifier.
   * @returns Task record or null.
   */
  async getTask(taskId: string): Promise<DurableRemoteTaskRecord | null> {
    const startedAt = Date.now();
    logger.info({ taskId }, 'Reading durable remote task');
    await this.initialize();
    const result = await this.pool.query<RemoteTaskRow>(
      `SELECT ${TASK_COLUMNS} FROM remote_task_journal_tasks WHERE task_id = $1`,
      [taskId],
    );
    const task = result.rows[0] ? mapTaskRow(result.rows[0]) : null;
    logger.info({ taskId, found: Boolean(task), durationMs: Date.now() - startedAt }, 'Durable remote task read finished');
    return task;
  }

  /**
   * @description Lists immutable lifecycle facts in task sequence order.
   * @param taskId - Stable task identifier.
   * @returns Ordered append-only event records.
   */
  async listEvents(taskId: string): Promise<RemoteTaskJournalEvent[]> {
    const startedAt = Date.now();
    logger.info({ taskId }, 'Listing durable remote-task events');
    await this.initialize();
    const result = await this.pool.query<RemoteTaskEventRow>(
      `SELECT event_id, task_id, client_id, owner_sub, sequence_number, event_type, payload, created_at
       FROM remote_task_journal_events WHERE task_id = $1 ORDER BY sequence_number`,
      [taskId],
    );
    const events = result.rows.map(mapEventRow);
    logger.info({ taskId, count: events.length, durationMs: Date.now() - startedAt }, 'Durable remote-task event listing finished');
    return events;
  }

  /**
   * @description Locks and publishes one undelivered outbox row, then marks only that row delivered.
   * @param publish - Side-effect publisher; must deduplicate by stable outboxId.
   * @returns True when a row was delivered, otherwise false.
   */
  async deliverNextOutbox(publish: RemoteTaskOutboxPublisher): Promise<boolean> {
    const startedAt = Date.now();
    logger.info('Delivering next durable remote-task outbox row');
    await this.initialize();
    const delivered = await withTransaction(this.pool, 'deliver-outbox', (client) => this.deliverNextOutboxTx(client, publish));
    logger.info({ delivered, durationMs: Date.now() - startedAt }, 'Durable remote-task outbox delivery finished');
    return delivered;
  }

  /**
   * @description Purges expired terminal aggregates only after every side effect is delivered.
   * @param limit - Bounded number of tombstones removed in one statement.
   * @returns Number of deleted task aggregates.
   */
  async purgeExpiredTombstones(limit = 100): Promise<number> {
    const normalizedLimit = normalizeLimit(limit);
    const startedAt = Date.now();
    logger.info({ limit: normalizedLimit }, 'Purging expired durable remote-task tombstones');
    await this.initialize();
    const result = await this.pool.query<{ task_id: string }>(PURGE_TOMBSTONES_SQL, [normalizedLimit]);
    const purged = result.rowCount ?? result.rows.length;
    logger.info({ purged, durationMs: Date.now() - startedAt }, 'Expired durable remote-task tombstone purge finished');
    return purged;
  }

  /** @description Executes the enqueue transaction after schema readiness is established. */
  private async enqueueTx(client: PoolClient, input: EnqueueRemoteTaskInput): Promise<EnqueueRemoteTaskOutcome> {
    await lockRemoteClient(client, input.clientId);
    await assertClientOwner(client, input.clientId, input.ownerSub);
    const inserted = await client.query<RemoteTaskRow>(INSERT_TASK_SQL, taskInsertParams(input));
    if (!inserted.rows[0]) {
      return this.resolveDuplicateEnqueue(client, input);
    }
    const task = mapTaskRow(inserted.rows[0]);
    const eventId = await appendEvent(client, task, 'task.queued', { correlationId: task.correlationId });
    await insertOutbox(client, task, eventId, 'remote-task.dispatch', dispatchPayload(task));
    return { kind: 'enqueued', task };
  }

  /** @description Creates or verifies a registration owner while holding the shared client lock. */
  private async bindClientOwnerTx(
    client: PoolClient,
    input: BindRemoteClientOwnerInput,
  ): Promise<BindRemoteClientOwnerOutcome> {
    await lockRemoteClient(client, input.clientId);
    const existing = await selectClientOwner(client, input.clientId);
    if (existing) return resolveExistingOwnerBinding(existing.owner_sub, input.assertedOwnerSub);
    const ownerSub = input.assertedOwnerSub ?? null;
    const inserted = await client.query<RemoteClientOwnerRow>(INSERT_CLIENT_OWNER_SQL, [input.clientId, ownerSub]);
    if (inserted.rows[0]) return { kind: 'bound', ownerSub: inserted.rows[0].owner_sub };
    return { kind: 'conflict', ownerSub: null };
  }

  /** @description Updates a binding only after proving all client work is terminal. */
  private async transitionClientOwnerTx(
    client: PoolClient,
    input: TransitionRemoteClientOwnerInput,
  ): Promise<TransitionRemoteClientOwnerOutcome> {
    await lockRemoteClient(client, input.clientId);
    const existing = await selectClientOwner(client, input.clientId);
    if (!existing) return { kind: 'not_found', ownerSub: null };
    if (!ownerMatches(existing.owner_sub, input.expectedOwnerSub)) {
      return { kind: 'conflict', ownerSub: existing.owner_sub };
    }
    if (ownerMatches(existing.owner_sub, input.nextOwnerSub)) {
      return { kind: 'unchanged', ownerSub: existing.owner_sub };
    }
    const active = await client.query(ACTIVE_CLIENT_TASK_SQL, [input.clientId]);
    if (active.rows[0]) return { kind: 'tasks_active', ownerSub: existing.owner_sub };
    const updated = await client.query<RemoteClientOwnerRow>(UPDATE_CLIENT_OWNER_SQL, [input.clientId, input.nextOwnerSub]);
    return { kind: 'updated', ownerSub: requireRow(updated.rows[0], input.clientId).owner_sub };
  }

  /** @description Distinguishes an exact enqueue retry from task-id payload or target reuse. */
  private async resolveDuplicateEnqueue(client: PoolClient, input: EnqueueRemoteTaskInput): Promise<EnqueueRemoteTaskOutcome> {
    const result = await client.query<DuplicateRemoteTaskRow>(DUPLICATE_TASK_SQL, [
      input.task.taskId,
      input.clientId,
      input.ownerSub,
      JSON.stringify(input.task),
    ]);
    const row = requireRow(result.rows[0], input.task.taskId);
    return { kind: row.same_request ? 'already_exists' : 'conflict', task: mapTaskRow(row) };
  }

  /** @description Executes a non-leased client claim under a transaction advisory lock. */
  private async claimNextTx(client: PoolClient, input: ClaimRemoteTaskInput): Promise<ClaimRemoteTaskOutcome> {
    await lockRemoteClient(client, input.clientId);
    const active = await client.query<RemoteTaskRow>(
      `SELECT ${TASK_COLUMNS} FROM remote_task_journal_tasks
       WHERE client_id = $1 AND owner_sub IS NOT DISTINCT FROM $2
         AND status = 'claimed' LIMIT 1 FOR UPDATE`,
      [input.clientId, input.expectedOwnerSub],
    );
    if (active.rows[0]) return { kind: 'client_busy', task: mapTaskRow(active.rows[0]) };
    const queued = await client.query<RemoteTaskRow>(SELECT_QUEUED_TASK_SQL, [input.clientId, input.expectedOwnerSub]);
    if (!queued.rows[0]) return { kind: 'empty', task: null };
    const claimed = await client.query<RemoteTaskRow>(CLAIM_TASK_SQL, [
      queued.rows[0].task_id,
      input.clientId,
      input.expectedOwnerSub,
    ]);
    const task = mapTaskRow(requireRow(claimed.rows[0], queued.rows[0].task_id));
    await appendEvent(client, task, 'task.claimed', { claimedByClientId: input.clientId });
    return { kind: 'claimed', task };
  }

  /** @description Executes first-writer settlement while holding the task row lock. */
  private async settleTx(client: PoolClient, input: SettleRemoteTaskInput): Promise<SettleRemoteTaskOutcome> {
    const currentResult = await client.query<RemoteTaskRow>(
      `SELECT ${TASK_COLUMNS} FROM remote_task_journal_tasks WHERE task_id = $1 FOR UPDATE`,
      [input.result.taskId],
    );
    if (!currentResult.rows[0]) return { kind: 'not_found', task: null };
    const current = mapTaskRow(currentResult.rows[0]);
    const rejection = settlementRejection(current, input);
    if (rejection) return rejection;
    const updated = await client.query<RemoteTaskRow>(SETTLE_TASK_SQL, settlementParams(input));
    const task = mapTaskRow(requireRow(updated.rows[0], input.result.taskId));
    const eventType = `task.${input.result.status}` as RemoteTaskJournalEventType;
    const eventId = await appendEvent(client, task, eventType, { result: input.result });
    await insertOutbox(client, task, eventId, 'remote-task.settlement', settlementPayload(task));
    return { kind: 'settled', task };
  }

  /** @description Publishes one row while its undelivered state remains locked in the transaction. */
  private async deliverNextOutboxTx(client: PoolClient, publish: RemoteTaskOutboxPublisher): Promise<boolean> {
    const result = await client.query<RemoteTaskOutboxRow>(SELECT_OUTBOX_SQL);
    if (!result.rows[0]) return false;
    const record = mapOutboxRow(result.rows[0]);
    await publish(record);
    const update = await client.query(
      `UPDATE remote_task_journal_outbox SET delivered_at = NOW()
       WHERE outbox_id = $1 AND delivered_at IS NULL`,
      [record.outboxId],
    );
    if (update.rowCount !== 1) throw new Error(`Outbox delivery lost its row lock: ${record.outboxId}`);
    return true;
  }
}

const INSERT_TASK_SQL = `
  INSERT INTO remote_task_journal_tasks (
    task_id, client_id, owner_sub, correlation_id, envelope, status
  ) VALUES ($1, $2, $3, $4, $5::jsonb, 'queued')
  ON CONFLICT (task_id) DO NOTHING
  RETURNING ${TASK_COLUMNS}
`;

const DUPLICATE_TASK_SQL = `
  SELECT ${TASK_COLUMNS},
    (client_id = $2 AND owner_sub IS NOT DISTINCT FROM $3 AND envelope = $4::jsonb) AS same_request
  FROM remote_task_journal_tasks WHERE task_id = $1 FOR UPDATE
`;

const INSERT_CLIENT_OWNER_SQL = `
  INSERT INTO remote_task_journal_client_owners (client_id, owner_sub)
  VALUES ($1, $2) ON CONFLICT (client_id) DO NOTHING
  RETURNING client_id, owner_sub
`;

const UPDATE_CLIENT_OWNER_SQL = `
  UPDATE remote_task_journal_client_owners
  SET owner_sub = $2, updated_at = NOW()
  WHERE client_id = $1
  RETURNING client_id, owner_sub
`;

const ACTIVE_CLIENT_TASK_SQL = `
  SELECT task_id FROM remote_task_journal_tasks
  WHERE client_id = $1 AND status IN ('queued', 'claimed') LIMIT 1 FOR UPDATE
`;

const SELECT_QUEUED_TASK_SQL = `
  SELECT ${TASK_COLUMNS} FROM remote_task_journal_tasks
  WHERE client_id = $1 AND owner_sub IS NOT DISTINCT FROM $2 AND status = 'queued'
  ORDER BY created_at, task_id LIMIT 1 FOR UPDATE SKIP LOCKED
`;

const CLAIM_TASK_SQL = `
  UPDATE remote_task_journal_tasks
  SET status = 'claimed', claimed_by_client_id = $2, claimed_at = NOW(), updated_at = NOW()
  WHERE task_id = $1 AND client_id = $2
    AND owner_sub IS NOT DISTINCT FROM $3 AND status = 'queued'
  RETURNING ${TASK_COLUMNS}
`;

const SETTLE_TASK_SQL = `
  UPDATE remote_task_journal_tasks
  SET status = $3, settled_at = NOW(), terminal_result = $4::jsonb,
      tombstone_expires_at = NOW() + ($5::integer * INTERVAL '1 day'), updated_at = NOW()
  WHERE task_id = $1 AND claimed_by_client_id = $2 AND status = 'claimed'
  RETURNING ${TASK_COLUMNS}
`;

const SELECT_OUTBOX_SQL = `
  SELECT outbox_id, task_id, client_id, owner_sub, event_id, topic, payload, created_at, delivered_at
  FROM remote_task_journal_outbox
  WHERE delivered_at IS NULL
  ORDER BY created_at, outbox_id
  LIMIT 1 FOR UPDATE SKIP LOCKED
`;

const PURGE_TOMBSTONES_SQL = `
  WITH expired AS (
    SELECT task.task_id FROM remote_task_journal_tasks task
    WHERE task.status IN ('completed', 'failed')
      AND task.tombstone_expires_at <= NOW()
      AND NOT EXISTS (
        SELECT 1 FROM remote_task_journal_outbox outbox
        WHERE outbox.task_id = task.task_id AND outbox.delivered_at IS NULL
      )
    ORDER BY task.tombstone_expires_at, task.task_id
    LIMIT $1 FOR UPDATE SKIP LOCKED
  )
  DELETE FROM remote_task_journal_tasks task USING expired
  WHERE task.task_id = expired.task_id RETURNING task.task_id
`;

/** @description Serializes registration, enqueue, claim, and owner changes for one client. */
async function lockRemoteClient(client: PoolClient, clientId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('remote-task-client:' || $1, 0))`,
    [clientId],
  );
}

/** @description Reads a durable owner row under lock, respecting the caller's RLS identity. */
async function selectClientOwner(client: PoolClient, clientId: string): Promise<RemoteClientOwnerRow | null> {
  const result = await client.query<RemoteClientOwnerRow>(
    `SELECT client_id, owner_sub FROM remote_task_journal_client_owners
     WHERE client_id = $1 FOR UPDATE`,
    [clientId],
  );
  return result.rows[0] ?? null;
}

/** @description Refuses task insertion when the presented owner is not the durable binding. */
async function assertClientOwner(client: PoolClient, clientId: string, ownerSub: string | null): Promise<void> {
  const binding = await selectClientOwner(client, clientId);
  if (!binding || !ownerMatches(binding.owner_sub, ownerSub)) {
    throw new Error(`Remote client owner binding mismatch: ${clientId}`);
  }
}

/** @description Resolves a registration refresh without permitting implicit reassignment. */
function resolveExistingOwnerBinding(
  durableOwnerSub: string | null,
  assertedOwnerSub: string | null | undefined,
): BindRemoteClientOwnerOutcome {
  if (assertedOwnerSub === undefined || ownerMatches(durableOwnerSub, assertedOwnerSub)) {
    return { kind: 'already_bound', ownerSub: durableOwnerSub };
  }
  return { kind: 'conflict', ownerSub: durableOwnerSub };
}

/** @description Compares nullable owner identities without truthiness coercion. */
function ownerMatches(left: string | null, right: string | null): boolean {
  return left === right;
}

/** @description Inserts the next immutable event while the parent task row is transaction-locked. */
async function appendEvent(
  client: PoolClient,
  task: DurableRemoteTaskRecord,
  eventType: RemoteTaskJournalEventType,
  payload: Record<string, unknown>,
): Promise<number> {
  const result = await client.query<{ event_id: string | number }>(
    `INSERT INTO remote_task_journal_events (
       task_id, client_id, owner_sub, sequence_number, event_type, payload
     ) SELECT $1, $2, $3, COALESCE(MAX(sequence_number), 0) + 1, $4, $5::jsonb
       FROM remote_task_journal_events WHERE task_id = $1 RETURNING event_id`,
    [task.taskId, task.clientId, task.ownerSub, eventType, JSON.stringify(payload)],
  );
  return Number(requireRow(result.rows[0], task.taskId).event_id);
}

/** @description Inserts a side effect in the same transaction as its source event. */
async function insertOutbox(
  client: PoolClient,
  task: DurableRemoteTaskRecord,
  eventId: number,
  topic: RemoteTaskOutboxTopic,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO remote_task_journal_outbox (
       outbox_id, task_id, event_id, client_id, owner_sub, topic, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [randomUUID(), task.taskId, eventId, task.clientId, task.ownerSub, topic, JSON.stringify(payload)],
  );
}

/** @description Runs an operation in one PostgreSQL transaction and never hides rollback failure. */
async function withTransaction<T>(pool: Pool, action: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError, action }, 'Durable remote-task transaction rollback failed');
    }
    logger.error({ err: error, action }, 'Durable remote-task transaction failed');
    throw error;
  } finally {
    client.release();
  }
}

/** @description Returns a terminal/idempotency rejection before any state mutation. */
function settlementRejection(
  current: DurableRemoteTaskRecord,
  input: SettleRemoteTaskInput,
): SettleRemoteTaskOutcome | null {
  if (current.correlationId !== input.result.correlationId) {
    return { kind: 'conflict', task: current };
  }
  if (current.status === 'completed' || current.status === 'failed') {
    const repeated = current.status === input.result.status
      && isDeepStrictEqual(current.terminalResult, input.result);
    return { kind: repeated ? 'already_settled' : 'conflict', task: current };
  }
  if (current.status !== 'claimed') return { kind: 'not_claimed', task: current };
  if (current.claimedByClientId !== input.clientId) return { kind: 'wrong_client', task: current };
  return null;
}

/** @description Rejects mismatched client assertions before opening a transaction. */
function assertSettlementIdentity(input: SettleRemoteTaskInput): void {
  if (input.clientId !== input.result.clientId) {
    throw new Error('Settlement clientId must match the result clientId');
  }
}

/** @description Produces positional parameters for a task insert. */
function taskInsertParams(input: EnqueueRemoteTaskInput): unknown[] {
  return [input.task.taskId, input.clientId, input.ownerSub, input.task.correlationId, JSON.stringify(input.task)];
}

/** @description Produces positional parameters for an accepted terminal update. */
function settlementParams(input: SettleRemoteTaskInput): unknown[] {
  return [
    input.result.taskId,
    input.clientId,
    input.result.status,
    JSON.stringify(input.result),
    REMOTE_TASK_TOMBSTONE_DAYS,
  ];
}

/** @description Builds the replay payload for a newly queued dispatch. */
function dispatchPayload(task: DurableRemoteTaskRecord): Record<string, unknown> {
  return { version: 1, taskId: task.taskId, clientId: task.clientId, envelope: task.envelope };
}

/** @description Builds the replay payload for an authoritative terminal result. */
function settlementPayload(task: DurableRemoteTaskRecord): Record<string, unknown> {
  return {
    version: 1,
    taskId: task.taskId,
    clientId: task.clientId,
    envelope: task.envelope,
    result: task.terminalResult,
  };
}

/** @description Maps a PostgreSQL task row to the durable domain record. */
function mapTaskRow(row: RemoteTaskRow): DurableRemoteTaskRecord {
  return {
    taskId: row.task_id,
    clientId: row.client_id,
    ownerSub: row.owner_sub,
    correlationId: row.correlation_id,
    envelope: parseJson<A2ATaskEnvelope>(row.envelope),
    status: row.status,
    claimedByClientId: row.claimed_by_client_id,
    claimedAt: optionalIso(row.claimed_at),
    settledAt: optionalIso(row.settled_at),
    terminalResult: row.terminal_result ? parseJson<A2ATaskResult>(row.terminal_result) : null,
    tombstoneExpiresAt: optionalIso(row.tombstone_expires_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** @description Maps a PostgreSQL journal row to its public append-only record. */
function mapEventRow(row: RemoteTaskEventRow): RemoteTaskJournalEvent {
  return {
    eventId: Number(row.event_id),
    taskId: row.task_id,
    clientId: row.client_id,
    ownerSub: row.owner_sub,
    sequenceNumber: row.sequence_number,
    eventType: row.event_type,
    payload: parseJson<Record<string, unknown>>(row.payload),
    createdAt: toIso(row.created_at),
  };
}

/** @description Maps a PostgreSQL outbox row to the publisher contract. */
function mapOutboxRow(row: RemoteTaskOutboxRow): RemoteTaskOutboxRecord {
  return {
    outboxId: row.outbox_id,
    taskId: row.task_id,
    clientId: row.client_id,
    ownerSub: row.owner_sub,
    eventId: Number(row.event_id),
    topic: row.topic,
    payload: parseJson<Record<string, unknown>>(row.payload),
    createdAt: toIso(row.created_at),
    deliveredAt: optionalIso(row.delivered_at),
  };
}

/** @description Parses JSONB values whether pg returned text or an already-decoded object. */
function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

/** @description Converts a required database timestamp to canonical ISO text. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** @description Converts a nullable database timestamp to canonical ISO text. */
function optionalIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** @description Requires a query result row whose absence would violate the transaction contract. */
function requireRow<T>(row: T | undefined, taskId: string): T {
  if (!row) throw new Error(`Durable remote task transaction returned no row: ${taskId}`);
  return row;
}

/** @description Bounds batch cleanup so retention cannot monopolize a database connection. */
function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Tombstone purge limit must be a positive integer');
  return Math.min(limit, 1000);
}

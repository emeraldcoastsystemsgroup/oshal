/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the validated durable-task application service and startup replay loop that publishes only undelivered outbox rows before retention cleanup.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalize every accepted envelope back to queued and fail closed when its userSub disagrees with the durable owner, preventing caller-supplied lifecycle or attribution drift.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add durable client-owner binding and owner-aware claims so API restart registration and polling cannot bypass the fixed task owner.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Stamp an omitted task userSub from the durable owner after rejecting mismatches, making replayed billing attribution authoritative rather than caller-optional.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Serialize outbox replay passes with a service-level single flight so a burst of settlements cannot pin every pool connection while publishers need the same pool for cost and work-item writes.
 */

import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { A2ATaskEnvelopeSchema, A2ATaskResultSchema } from '@/shared/types';
import type {
  BindRemoteClientOwnerOutcome,
  ClaimRemoteTaskOutcome,
  DurableRemoteTaskRecord,
  EnqueueRemoteTaskOutcome,
  RemoteTaskJournalEvent,
  RemoteTaskJournalRepository,
  RemoteTaskOutboxPublisher,
  SettleRemoteTaskOutcome,
  TransitionRemoteClientOwnerOutcome,
} from './remote-task-journal-types';

const logger = createChildLogger({ module: 'remote-task-journal-service' });

/** @description Result of boot-time journal recovery and bounded tombstone maintenance. */
export interface RemoteTaskJournalStartupResult {
  replayedOutboxRows: number;
  purgedTombstones: number;
}

/** @description Validated application boundary over the PostgreSQL-authoritative task journal. */
export class RemoteTaskJournalService {
  /** One publisher pass at a time prevents nested downstream queries from exhausting the shared pool. */
  private outboxReplayInFlight: Promise<number> | null = null;

  /**
   * @description Creates the service over a durable repository implementation.
   * @param repository - PostgreSQL-authoritative lifecycle and outbox boundary.
   */
  constructor(private readonly repository: RemoteTaskJournalRepository) {}

  /**
   * @description Initializes schema, replays undelivered side effects, then purges eligible tombstones.
   * @param publish - Outbox publisher that deduplicates by outboxId.
   * @param replayLimit - Safety bound for one startup pass.
   * @returns Replay and retention counts.
   */
  async start(
    publish: RemoteTaskOutboxPublisher,
    replayLimit = 1000,
  ): Promise<RemoteTaskJournalStartupResult> {
    const startedAt = Date.now();
    logger.info({ replayLimit }, 'Starting durable remote-task journal recovery');
    const result = await runWithSystemIdentity(async () => {
      await this.repository.initialize();
      const replayedOutboxRows = await this.replayPendingOutbox(publish, replayLimit);
      const purgedTombstones = await this.repository.purgeExpiredTombstones();
      return { replayedOutboxRows, purgedTombstones };
    });
    logger.info({ ...result, durationMs: Date.now() - startedAt }, 'Durable remote-task journal recovery finished');
    return result;
  }

  /**
   * @description Validates and durably enqueues one fixed-target task.
   * @param clientId - Target remote-client identity.
   * @param ownerSub - Owning OIDC subject, or null for trusted system work.
   * @param taskInput - Unknown A2A task payload from the caller boundary.
   * @returns Durable enqueue outcome.
   */
  async enqueue(clientId: string, ownerSub: string | null, taskInput: unknown): Promise<EnqueueRemoteTaskOutcome> {
    const normalizedClientId = requireIdentity(clientId, 'clientId');
    const normalizedOwnerSub = optionalIdentity(ownerSub, 'ownerSub');
    const parsedTask = parseQueuedTask(taskInput);
    assertOwnerConsistency(normalizedOwnerSub, parsedTask.userSub);
    const task = bindTaskOwner(parsedTask, normalizedOwnerSub);
    logger.info({ taskId: task.taskId, clientId: normalizedClientId }, 'Submitting durable remote task');
    const outcome = await this.repository.enqueue({ clientId: normalizedClientId, ownerSub: normalizedOwnerSub, task });
    logger.info({ taskId: task.taskId, clientId: normalizedClientId, outcome: outcome.kind }, 'Durable remote task submission finished');
    return outcome;
  }

  /**
   * @description Creates or verifies the durable owner binding used across API restarts.
   * @param clientId - Stable remote-client identity.
   * @param assertedOwnerSub - Presented owner, or undefined to retain an existing binding.
   * @returns The authoritative binding or a conflict result.
   */
  async bindClientOwner(
    clientId: string,
    assertedOwnerSub?: string | null,
  ): Promise<BindRemoteClientOwnerOutcome> {
    const normalizedOwner = assertedOwnerSub === undefined
      ? undefined
      : optionalIdentity(assertedOwnerSub, 'assertedOwnerSub');
    return this.repository.bindClientOwner({
      clientId: requireIdentity(clientId, 'clientId'),
      assertedOwnerSub: normalizedOwner,
    });
  }

  /**
   * @description Reassigns a durable owner only while no queued or claimed work exists.
   * @param clientId - Stable remote-client identity.
   * @param expectedOwnerSub - Owner observed before the transition.
   * @param nextOwnerSub - New owner or null for operator-only binding.
   * @returns Guarded transition outcome.
   */
  async transitionClientOwner(
    clientId: string,
    expectedOwnerSub: string | null,
    nextOwnerSub: string | null,
  ): Promise<TransitionRemoteClientOwnerOutcome> {
    return this.repository.transitionClientOwner({
      clientId: requireIdentity(clientId, 'clientId'),
      expectedOwnerSub: optionalIdentity(expectedOwnerSub, 'expectedOwnerSub'),
      nextOwnerSub: optionalIdentity(nextOwnerSub, 'nextOwnerSub'),
    });
  }

  /**
   * @description Claims at most one task for a client without leases or reassignment.
   * @param clientId - Authenticated polling client identity.
   * @param expectedOwnerSub - Owner bound to the authenticated client registration.
   * @returns Claim, busy, or empty outcome.
   */
  async claimNext(clientId: string, expectedOwnerSub: string | null): Promise<ClaimRemoteTaskOutcome> {
    const normalizedClientId = requireIdentity(clientId, 'clientId');
    const normalizedOwnerSub = optionalIdentity(expectedOwnerSub, 'expectedOwnerSub');
    logger.info({ clientId: normalizedClientId }, 'Submitting durable remote-task claim');
    const outcome = await this.repository.claimNext({
      clientId: normalizedClientId,
      expectedOwnerSub: normalizedOwnerSub,
    });
    logger.info({ clientId: normalizedClientId, outcome: outcome.kind, taskId: outcome.task?.taskId }, 'Durable remote-task claim finished');
    return outcome;
  }

  /**
   * @description Validates and attempts the first authoritative terminal settlement.
   * @param clientId - Authenticated client identity that owns the claim.
   * @param resultInput - Unknown A2A terminal result payload.
   * @returns Settlement or idempotent rejection outcome.
   */
  async settle(clientId: string, resultInput: unknown): Promise<SettleRemoteTaskOutcome> {
    const normalizedClientId = requireIdentity(clientId, 'clientId');
    const result = A2ATaskResultSchema.parse(resultInput);
    logger.info({ clientId: normalizedClientId, taskId: result.taskId, status: result.status }, 'Submitting durable remote-task settlement');
    const outcome = await this.repository.settle({ clientId: normalizedClientId, result });
    logger.info({ clientId: normalizedClientId, taskId: result.taskId, outcome: outcome.kind }, 'Durable remote-task settlement finished');
    return outcome;
  }

  /**
   * @description Reads the task projection retained by PostgreSQL.
   * @param taskId - Stable task identifier.
   * @returns Current task or terminal tombstone.
   */
  async getTask(taskId: string): Promise<DurableRemoteTaskRecord | null> {
    const normalizedTaskId = requireIdentity(taskId, 'taskId');
    logger.info({ taskId: normalizedTaskId }, 'Reading durable remote task through service');
    const task = await this.repository.getTask(normalizedTaskId);
    logger.info({ taskId: normalizedTaskId, found: Boolean(task) }, 'Durable remote-task service read finished');
    return task;
  }

  /**
   * @description Reads the immutable lifecycle history for one task.
   * @param taskId - Stable task identifier.
   * @returns Ordered journal facts.
   */
  async listEvents(taskId: string): Promise<RemoteTaskJournalEvent[]> {
    const normalizedTaskId = requireIdentity(taskId, 'taskId');
    logger.info({ taskId: normalizedTaskId }, 'Reading durable remote-task journal events through service');
    const events = await this.repository.listEvents(normalizedTaskId);
    logger.info({ taskId: normalizedTaskId, count: events.length }, 'Durable remote-task journal event read finished');
    return events;
  }

  /**
   * @description Delivers pending rows oldest-first and never queries delivered rows for replay.
   * @param publish - Idempotency-aware side-effect publisher.
   * @param limit - Maximum rows delivered in this pass.
   * @returns Number of outbox rows delivered.
   */
  async replayPendingOutbox(publish: RemoteTaskOutboxPublisher, limit = 1000): Promise<number> {
    const normalizedLimit = normalizeReplayLimit(limit);
    if (this.outboxReplayInFlight) return this.outboxReplayInFlight;
    const replay = this.replayPendingOutboxExclusive(publish, normalizedLimit);
    this.outboxReplayInFlight = replay;
    try {
      return await replay;
    } finally {
      if (this.outboxReplayInFlight === replay) this.outboxReplayInFlight = null;
    }
  }

  /** @description Performs one bounded pass while callers join through replayPendingOutbox. */
  private async replayPendingOutboxExclusive(
    publish: RemoteTaskOutboxPublisher,
    normalizedLimit: number,
  ): Promise<number> {
    logger.info({ limit: normalizedLimit }, 'Replaying pending durable remote-task outbox rows');
    let delivered = 0;
    while (delivered < normalizedLimit && await this.repository.deliverNextOutbox(publish)) {
      delivered += 1;
    }
    if (delivered === normalizedLimit) {
      logger.warn({ delivered, limit: normalizedLimit }, 'Durable remote-task outbox replay reached its safety bound');
    }
    logger.info({ delivered }, 'Pending durable remote-task outbox replay finished');
    return delivered;
  }
}

/** @description Requires a non-empty stable identity at the application boundary. */
function requireIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

/** @description Normalizes nullable ownership while rejecting ambiguous whitespace-only values. */
function optionalIdentity(value: string | null, field: string): string | null {
  return value === null ? null : requireIdentity(value, field);
}

/** @description Forces caller-supplied lifecycle state back to queued at the persistence boundary. */
function parseQueuedTask(taskInput: unknown) {
  const fields = taskInput && typeof taskInput === 'object' ? taskInput : {};
  return A2ATaskEnvelopeSchema.parse({ ...fields, status: 'queued' });
}

/** @description Prevents a task's billing/user assertion from disagreeing with its persisted owner. */
function assertOwnerConsistency(ownerSub: string | null, userSub: string | undefined): void {
  if (userSub !== undefined && userSub !== ownerSub) {
    throw new Error('Task userSub must match the durable ownerSub');
  }
}

/** @description Stores the authoritative owner on the replayed envelope even when the caller omitted it. */
function bindTaskOwner(
  task: ReturnType<typeof parseQueuedTask>,
  ownerSub: string | null,
): ReturnType<typeof parseQueuedTask> {
  return A2ATaskEnvelopeSchema.parse({ ...task, userSub: ownerSub ?? undefined });
}

/** @description Bounds a startup replay so a large backlog cannot block service boot forever. */
function normalizeReplayLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Outbox replay limit must be a positive integer');
  return Math.min(limit, 10000);
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Define the durable remote-task journal boundary: PostgreSQL-owned task state, immutable lifecycle events, first-writer terminal settlement, and an idempotency-keyed transactional outbox.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Document every repository operation at the persistence boundary, including publisher idempotency and retention safety obligations.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bind client ownership durably and require the expected owner on every claim so registration, dispatch, polling, and owner transitions cannot race across API restarts.
 */

import type { A2ATaskEnvelope, A2ATaskResult } from '@/shared/types';

/** @description Terminal rows remain authoritative tombstones for this many days. */
export const REMOTE_TASK_TOMBSTONE_DAYS = 30;

/** @description Durable lifecycle states for a remote task. */
export type RemoteTaskJournalStatus = 'queued' | 'claimed' | 'completed' | 'failed';

/** @description Append-only facts recorded while a remote task moves through its lifecycle. */
export type RemoteTaskJournalEventType = 'task.queued' | 'task.claimed' | 'task.completed' | 'task.failed';

/** @description Side-effect channels written atomically with the state change that created them. */
export type RemoteTaskOutboxTopic = 'remote-task.dispatch' | 'remote-task.settlement';

/** @description PostgreSQL projection for one durable remote task and its terminal tombstone. */
export interface DurableRemoteTaskRecord {
  taskId: string;
  clientId: string;
  ownerSub: string | null;
  correlationId: string;
  envelope: A2ATaskEnvelope;
  status: RemoteTaskJournalStatus;
  claimedByClientId: string | null;
  claimedAt: string | null;
  settledAt: string | null;
  terminalResult: A2ATaskResult | null;
  tombstoneExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** @description Input for inserting a task without permitting its target client to be reassigned later. */
export interface EnqueueRemoteTaskInput {
  clientId: string;
  ownerSub: string | null;
  task: A2ATaskEnvelope;
}

/** @description Result of an idempotent enqueue attempt. */
export interface EnqueueRemoteTaskOutcome {
  kind: 'enqueued' | 'already_exists' | 'conflict';
  task: DurableRemoteTaskRecord;
}

/** @description Identity supplied by an authenticated client while polling for work. */
export interface ClaimRemoteTaskInput {
  clientId: string;
  expectedOwnerSub: string | null;
}

/** @description Result of a one-at-a-time, non-leased client claim attempt. */
export interface ClaimRemoteTaskOutcome {
  kind: 'claimed' | 'empty' | 'client_busy';
  task: DurableRemoteTaskRecord | null;
}

/** @description Registration-time request to create or verify a durable client-owner binding. */
export interface BindRemoteClientOwnerInput {
  clientId: string;
  assertedOwnerSub?: string | null;
}

/** @description Registration-time owner resolution; conflicts never mutate the durable binding. */
export interface BindRemoteClientOwnerOutcome {
  kind: 'bound' | 'already_bound' | 'conflict';
  ownerSub: string | null;
}

/** @description Explicit owner reassignment guarded against concurrent dispatch and polling. */
export interface TransitionRemoteClientOwnerInput {
  clientId: string;
  expectedOwnerSub: string | null;
  nextOwnerSub: string | null;
}

/** @description Result of an owner transition serialized with enqueue and claim operations. */
export interface TransitionRemoteClientOwnerOutcome {
  kind: 'updated' | 'unchanged' | 'conflict' | 'tasks_active' | 'not_found';
  ownerSub: string | null;
}

/** @description Input for the first terminal settlement written by the client that claimed the task. */
export interface SettleRemoteTaskInput {
  clientId: string;
  result: A2ATaskResult;
}

/** @description Result of a terminal write; only `settled` means this call changed authoritative state. */
export interface SettleRemoteTaskOutcome {
  kind: 'settled' | 'already_settled' | 'conflict' | 'not_found' | 'not_claimed' | 'wrong_client';
  task: DurableRemoteTaskRecord | null;
}

/** @description One append-only state fact retained with its task tombstone. */
export interface RemoteTaskJournalEvent {
  eventId: number;
  taskId: string;
  clientId: string;
  ownerSub: string | null;
  sequenceNumber: number;
  eventType: RemoteTaskJournalEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** @description One transactional outbox row; `outboxId` is the consumer idempotency key. */
export interface RemoteTaskOutboxRecord {
  outboxId: string;
  taskId: string;
  clientId: string;
  ownerSub: string | null;
  eventId: number;
  topic: RemoteTaskOutboxTopic;
  payload: Record<string, unknown>;
  createdAt: string;
  deliveredAt: string | null;
}

/** @description Callback that publishes one outbox row using `outboxId` for downstream deduplication. */
export type RemoteTaskOutboxPublisher = (record: RemoteTaskOutboxRecord) => Promise<void>;

/** @description Persistence boundary whose implementations must keep PostgreSQL authoritative. */
export interface RemoteTaskJournalRepository {
  /** @description Verifies or creates the required schema. @returns Completion promise. */
  initialize(): Promise<void>;

  /** @description Atomically creates a task, event, and dispatch outbox row. @param input - Fixed-target task. @returns Enqueue outcome. */
  enqueue(input: EnqueueRemoteTaskInput): Promise<EnqueueRemoteTaskOutcome>;

  /** @description Creates or verifies the owner binding used after API restarts. @param input - Registration identity. @returns Binding outcome. */
  bindClientOwner(input: BindRemoteClientOwnerInput): Promise<BindRemoteClientOwnerOutcome>;

  /** @description Changes an owner only when no queued/claimed work exists. @param input - Expected and next owner. @returns Transition outcome. */
  transitionClientOwner(input: TransitionRemoteClientOwnerInput): Promise<TransitionRemoteClientOwnerOutcome>;

  /** @description Claims without a lease or reassignment. @param input - Polling client and expected owner. @returns Claim outcome. */
  claimNext(input: ClaimRemoteTaskInput): Promise<ClaimRemoteTaskOutcome>;

  /** @description Attempts the first authoritative terminal write. @param input - Client result. @returns Settlement outcome. */
  settle(input: SettleRemoteTaskInput): Promise<SettleRemoteTaskOutcome>;

  /** @description Reads a task or retained tombstone. @param taskId - Stable identifier. @returns Task or null. */
  getTask(taskId: string): Promise<DurableRemoteTaskRecord | null>;

  /** @description Reads append-only lifecycle facts. @param taskId - Stable identifier. @returns Ordered events. */
  listEvents(taskId: string): Promise<RemoteTaskJournalEvent[]>;

  /** @description Publishes one pending row under lock. @param publish - Idempotent publisher. @returns Whether a row was delivered. */
  deliverNextOutbox(publish: RemoteTaskOutboxPublisher): Promise<boolean>;

  /** @description Deletes eligible drained tombstones. @param limit - Batch bound. @returns Deleted aggregate count. */
  purgeExpiredTombstones(limit?: number): Promise<number>;
}

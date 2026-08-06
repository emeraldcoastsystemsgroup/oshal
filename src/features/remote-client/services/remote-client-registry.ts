/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added in-memory remote-client registry for control-plane task dispatch
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Device ownership binding: ownerSub survives owner-less re-registrations (a refresh must not silently unbind a device) and setOwner() supports operator reassignment (repo-audit 2026-07-05 device-ownership finding)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Typed RemoteClientNotFoundError replaces the bare Error from requireClient. This registry is in-memory, so an api restart drops every registration while the edge daemon keeps polling forever — the routes were mapping that to 400 Bad Request, which is both wrong (the request is fine; the server forgot) and unactionable, since the daemon could not tell it apart from a genuine malformed call. Observed live: 188 such errors in 24h from one orphaned client.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Make task enqueue at-most-once per (clientId, taskId) for the lifetime of this in-memory registry. Network clients retry a POST after a lost response; the registry returns the originally accepted envelope instead of queueing the same shell/click/file action twice, including after claim or completion. A same-id/different-payload retry is logged and remains non-executing.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Bound idempotency history per client without evicting queued, in-flight, or recently terminal task IDs. Expired terminal entries are pruned after a conservative retention window; when only protected entries fill the cap, new work is rejected instead of risking duplicate execution.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Deep-clone task envelopes and first terminal results at storage and return boundaries so caller mutation cannot rewrite the authoritative command or completion after acceptance.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Remove process-memory task authority: all task APIs are async PostgreSQL-journal proxies, startup fails closed, and registration/owner changes use the durable owner guard while presence and swarm-message queues remain in memory.
 */

import { createChildLogger } from '@/shared/logger';
import {
  A2AAgentCardSchema,
  type A2AAgentCard,
  type A2ATaskEnvelope,
  type A2ATaskResult,
  type RemoteClientHeartbeat,
  type RemoteClientRegistration,
  RemoteClientRegistrationSchema,
} from '@/shared/types';
import {
  RemoteClientSwarmMessageSchema,
  type RemoteClientSwarmMessage,
  type RemoteClientRecord,
  RemoteClientRecordSchema,
} from '../types';
import type { RemoteTaskOutboxPublisher } from './remote-task-journal-types';
import type { RemoteTaskJournalService } from './remote-task-journal-service';

const logger = createChildLogger({ module: 'remote-client-registry' });

interface InternalRemoteClientRecord extends RemoteClientRecord {
  swarmQueue: RemoteClientSwarmMessage[];
  heartbeat: RemoteClientHeartbeat | null;
}

/**
 * @description Raised while the durable journal is absent, starting, or failed.
 */
export class RemoteTaskJournalUnavailableError extends Error {
  readonly code = 'remote_task_journal_unavailable' as const;

  /** @description Creates a fail-closed task-authority error. */
  constructor(cause?: unknown) {
    super('Durable remote-task journal is not ready', { cause });
    this.name = 'RemoteTaskJournalUnavailableError';
  }
}

/** @description Raised when registration or explicit reassignment disagrees with durable ownership. */
export class RemoteClientOwnerConflictError extends Error {
  readonly code = 'remote_client_owner_conflict' as const;

  /** @description Creates an owner conflict without disclosing the other subject identifier. */
  constructor(clientId: string) {
    super(`Remote client owner binding conflicts with durable state: ${clientId}`);
    this.name = 'RemoteClientOwnerConflictError';
  }
}

/** @description Raised when queued/claimed tasks make an owner transition unsafe. */
export class RemoteClientOwnerTransitionBusyError extends Error {
  readonly code = 'remote_client_owner_tasks_active' as const;

  /** @description Creates a guarded-transition error. */
  constructor(clientId: string) {
    super(`Remote client owner cannot change while tasks are active: ${clientId}`);
    this.name = 'RemoteClientOwnerTransitionBusyError';
  }
}

/**
 * @description Raised when an operation names a clientId this registry has no record of.
 *
 * A distinct type rather than a bare Error because callers must be able to tell "this device is
 * not registered" apart from "this request was malformed" WITHOUT matching on message text. The
 * registry is in-memory, so every entry is lost on an api restart while the edge daemon keeps
 * polling — that is a routine, self-correcting condition (the client re-registers), not a client
 * error, and the route layer maps it to 404 + a machine-readable code on that basis.
 */
export class RemoteClientNotFoundError extends Error {
  /** Machine-readable discriminator sent to the daemon so it knows to re-register. */
  readonly code = 'remote_client_unregistered' as const;

  /** The clientId that had no registry entry. */
  readonly clientId: string;

  /**
   * @description Builds the error for a missing client.
   * @param clientId - The unregistered client identifier.
   */
  constructor(clientId: string) {
    super(`Remote client not found: ${clientId}`);
    this.name = 'RemoteClientNotFoundError';
    this.clientId = clientId;
  }
}

/**
 * @description Process-local presence and swarm-message registry for remote endpoint clients.
 * Task envelopes, claims, first-terminal settlement, ownership fencing, and replayable effects are
 * delegated exclusively to the configured PostgreSQL journal and fail closed until it is ready.
 */
export class RemoteClientRegistryService {
  private readonly clients = new Map<string, InternalRemoteClientRecord>();
  private taskJournal: RemoteTaskJournalService | null = null;
  private taskOutboxPublisher: RemoteTaskOutboxPublisher | null = null;
  private taskJournalReady = false;
  private taskJournalFailure: unknown = null;

  /**
   * @description Configures the only task authority and begins crash-replay recovery.
   * @param service - PostgreSQL-backed journal application service.
   * @param publisher - Idempotent transactional-outbox publisher.
   * @returns Startup promise; routes remain unavailable until it resolves.
   */
  configureTaskJournal(
    service: RemoteTaskJournalService,
    publisher: RemoteTaskOutboxPublisher,
  ): Promise<void> {
    this.taskJournal = service;
    this.taskOutboxPublisher = publisher;
    this.taskJournalReady = false;
    this.taskJournalFailure = null;
    const startup = service.start(publisher).then(() => {
      this.taskJournalReady = true;
    }).catch((error) => {
      this.taskJournalFailure = error;
      logger.error({ err: error }, 'Durable remote-task journal startup failed; task routes remain unavailable');
      throw error;
    });
    return startup;
  }

  /** @description Reports whether schema initialization and pending-outbox replay completed. */
  isTaskJournalReady(): boolean {
    return this.taskJournalReady;
  }

  /**
   * @description Registers or refreshes a remote client.
   */
  async register(registrationInput: unknown): Promise<RemoteClientRecord> {
    const registration = RemoteClientRegistrationSchema.parse(registrationInput);
    const ownerSub = await this.resolveRegistrationOwner(registration.clientId, registration.ownerSub);
    const now = new Date().toISOString();
    const existing = this.clients.get(registration.clientId);
    const resolvedAgentId = this.resolveAgentId(registration, existing);
    const normalizedRegistration = RemoteClientRegistrationSchema.parse({
      ...registration,
      agentId: resolvedAgentId,
      ownerSub: ownerSub ?? undefined,
    });
    const card = this.toAgentCard(normalizedRegistration, now);

    const record: InternalRemoteClientRecord = existing ?? {
      ...normalizedRegistration,
      taskQueueDepth: 0,
      status: 'online',
      healthy: true,
      lastSeenAt: now,
      registeredAt: now,
      lastHeartbeatAt: null,
      heartbeatCount: 0,
      mcpToolCount: 0,
      swarmQueue: [],
      heartbeat: null,
    };

    Object.assign(record, {
      ...normalizedRegistration,
      ...card,
      // Ownership is sticky: a re-registration that omits ownerSub keeps the
      // existing binding — a heartbeat-triggered refresh must never silently
      // unbind a device from its user (reassignment goes through setOwner()).
      ownerSub: normalizedRegistration.ownerSub ?? existing?.ownerSub,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeatAt: existing?.lastHeartbeatAt ?? now,
      lastSeenAt: existing?.lastHeartbeatAt ?? now,
      taskQueueDepth: existing?.taskQueueDepth ?? 0,
      mcpToolCount: normalizedRegistration.capabilities.length,
      healthy: true,
      status: 'online',
    });

    this.clients.set(normalizedRegistration.clientId, record);
    logger.info({ clientId: normalizedRegistration.clientId, mcpToolCount: record.mcpToolCount }, 'Remote client registered');
    return this.toPublicRecord(record);
  }

  /**
   * @description Records a heartbeat from a remote client.
   */
  recordHeartbeat(clientId: string, heartbeatInput: unknown): RemoteClientRecord {
    const heartbeat = heartbeatInput as RemoteClientHeartbeat;
    const record = this.requireClient(clientId);
    const acceptedAt = new Date().toISOString();

    record.heartbeat = heartbeat;
    record.heartbeatCount += 1;
    record.lastHeartbeatAt = acceptedAt;
    record.lastSeenAt = acceptedAt;
    record.healthy = heartbeat.status !== 'offline';
    record.status = heartbeat.status;
    record.mcpToolCount = heartbeat.toolCount ?? record.mcpToolCount;

    logger.debug(
      { clientId, heartbeatCount: record.heartbeatCount, status: heartbeat.status },
      'Remote client heartbeat recorded',
    );
    return this.toPublicRecord(record);
  }

  /**
   * @description Rebinds a device to a (new) owning user — the operator
   * reassignment path for the ownership model. Pass null to clear the binding
   * (device becomes operator-only for session callers, fail-closed).
   * @param clientId - The device to rebind.
   * @param ownerSub - The new owner's OIDC sub, or null to unbind.
   * @returns The updated public record.
   */
  async setOwner(clientId: string, ownerSub: string | null): Promise<RemoteClientRecord> {
    const record = this.requireClient(clientId);
    if (this.taskJournal) {
      const journal = this.requireTaskJournal();
      const outcome = await journal.transitionClientOwner(
        clientId,
        record.ownerSub ?? null,
        ownerSub,
      );
      if (outcome.kind === 'tasks_active') throw new RemoteClientOwnerTransitionBusyError(clientId);
      if (outcome.kind === 'conflict') throw new RemoteClientOwnerConflictError(clientId);
      if (outcome.kind === 'not_found') throw new RemoteClientNotFoundError(clientId);
    }
    record.ownerSub = ownerSub ?? undefined;
    logger.info({ clientId, hasOwner: Boolean(ownerSub) }, 'Remote client owner binding updated');
    return this.toPublicRecord(record);
  }

  /**
   * @description Returns all known clients.
   */
  listClients(): RemoteClientRecord[] {
    return Array.from(this.clients.values()).map((record) => this.toPublicRecord(record));
  }

  /**
   * @description Returns one client or null.
   */
  getClient(clientId: string): RemoteClientRecord | null {
    const record = this.clients.get(clientId);
    return record ? this.toPublicRecord(record) : null;
  }

  /**
   * @description Enqueues a task for a remote client.
   * @param clientId - Client whose queue owns the idempotency key.
   * @param taskInput - Untrusted task envelope input to validate and clone.
   * @returns An independent copy of the originally accepted envelope.
   */
  async enqueueTask(clientId: string, taskInput: unknown): Promise<A2ATaskEnvelope> {
    const record = this.requireClient(clientId);
    const outcome = await this.requireTaskJournal().enqueue(clientId, record.ownerSub ?? null, taskInput);
    if (outcome.kind === 'conflict') {
      throw new Error(`Remote task id conflicts with its durable envelope: ${outcome.task.taskId}`);
    }
    if (outcome.kind === 'enqueued') record.taskQueueDepth += 1;
    logger.info({ clientId, taskId: outcome.task.taskId, outcome: outcome.kind }, 'Durable remote client task accepted');
    return structuredClone(outcome.task.envelope);
  }

  /**
   * @description Claims the next task for a remote client.
   * @param clientId - Client whose FIFO queue should advance.
   * @returns An independent claimed envelope, or null when no work is queued.
   */
  async claimNextTask(clientId: string, expectedOwnerSub: string | null): Promise<A2ATaskEnvelope | null> {
    const record = this.requireClient(clientId);
    this.assertExpectedOwner(record, expectedOwnerSub);
    const outcome = await this.requireTaskJournal().claimNext(clientId, expectedOwnerSub);
    if (outcome.kind !== 'claimed' || !outcome.task) return null;
    record.taskQueueDepth = Math.max(0, record.taskQueueDepth - 1);
    record.activeTaskId = outcome.task.taskId;
    return { ...structuredClone(outcome.task.envelope), status: 'claimed' };
  }

  /**
   * @description Returns one in-flight task by task ID.
   * @param clientId - Client that owns the task.
   * @param taskId - Accepted task identity.
   * @returns An independent in-flight envelope, or null when it is not active.
   */
  async getInFlightTask(clientId: string, taskId: string): Promise<A2ATaskEnvelope | null> {
    const record = this.requireClient(clientId);
    const task = await this.requireTaskJournal().getTask(taskId);
    if (!task || task.clientId !== clientId || task.status !== 'claimed') return null;
    if (task.ownerSub !== (record.ownerSub ?? null)) return null;
    return structuredClone(task.envelope);
  }

  /**
   * @description Returns the stored completion result for a task, or null if it
   * is still queued/in-flight (or never existed). Lets a direct enqueuer poll for
   * a task's output over HTTP — swarm-dispatched results also ride the mesh.
   * @param clientId - Client that owns the task result.
   * @param taskId - Accepted task identity.
   * @returns An independent terminal result, or null while no result is stored.
   */
  async getCompletedResult(clientId: string, taskId: string): Promise<A2ATaskResult | null> {
    const record = this.requireClient(clientId);
    const task = await this.requireTaskJournal().getTask(taskId);
    if (!task || task.clientId !== clientId || task.ownerSub !== (record.ownerSub ?? null)) return null;
    return task.terminalResult ? structuredClone(task.terminalResult) : null;
  }

  /**
   * @description Marks a task as complete and stores the completion result.
   * @param clientId - Client reporting completion.
   * @param resultInput - Untrusted terminal result to validate and clone.
   * @returns An independent copy of the first authoritative terminal result.
   */
  async completeTask(clientId: string, resultInput: unknown): Promise<A2ATaskResult> {
    return this.settleTask(clientId, resultInput);
  }

  /**
   * @description Marks a task as failed with an error message.
   * @param clientId - Client reporting failure.
   * @param resultInput - Untrusted failure result to validate and clone.
   * @returns An independent copy of the first authoritative terminal result.
   */
  async failTask(clientId: string, resultInput: unknown): Promise<A2ATaskResult> {
    return this.settleTask(clientId, resultInput);
  }

  /**
   * @description Enqueues one inbound mesh message for the remote client.
   */
  enqueueSwarmMessage(clientId: string, messageInput: unknown): RemoteClientSwarmMessage {
    const record = this.requireClient(clientId);
    const message = RemoteClientSwarmMessageSchema.parse(messageInput);
    record.swarmQueue.push(message);
    logger.debug(
      { clientId, messageId: message.messageId, fromAgentId: message.fromAgentId, channel: message.channel },
      'Queued inbound swarm message for remote client',
    );
    return message;
  }

  /**
   * @description Claims one inbound mesh message for the remote client.
   */
  claimNextSwarmMessage(clientId: string): RemoteClientSwarmMessage | null {
    const record = this.requireClient(clientId);
    return record.swarmQueue.shift() ?? null;
  }

  /** @description Resolves restart-safe ownership before mutating process-local registration state. */
  private async resolveRegistrationOwner(
    clientId: string,
    assertedOwnerSub: string | undefined,
  ): Promise<string | null> {
    if (!this.taskJournal) return assertedOwnerSub ?? this.clients.get(clientId)?.ownerSub ?? null;
    const outcome = await this.requireTaskJournal().bindClientOwner(clientId, assertedOwnerSub);
    if (outcome.kind === 'conflict') throw new RemoteClientOwnerConflictError(clientId);
    return outcome.ownerSub;
  }

  /** @description Settles once, drains pending effects immediately, and preserves terminal HTTP success on drain failure. */
  private async settleTask(clientId: string, resultInput: unknown): Promise<A2ATaskResult> {
    const record = this.requireClient(clientId);
    const journal = this.requireTaskJournal();
    const outcome = await journal.settle(clientId, resultInput);
    if (!outcome.task?.terminalResult || !['settled', 'already_settled'].includes(outcome.kind)) {
      throw new Error(`Remote task settlement refused: ${outcome.kind}`);
    }
    if (record.activeTaskId === outcome.task.taskId) record.activeTaskId = undefined;
    await this.drainTaskOutbox(journal);
    return structuredClone(outcome.task.terminalResult);
  }

  /** @description Replays pending effects after settlement but leaves failed publication pending. */
  private async drainTaskOutbox(journal: RemoteTaskJournalService): Promise<void> {
    try {
      await journal.replayPendingOutbox(this.requireTaskPublisher());
    } catch (error) {
      logger.error({ err: error }, 'Immediate remote-task outbox drain failed; rows remain pending for replay');
    }
  }

  /** @description Requires the PostgreSQL journal to have completed startup recovery. */
  private requireTaskJournal(): RemoteTaskJournalService {
    if (!this.taskJournal || !this.taskJournalReady) {
      throw new RemoteTaskJournalUnavailableError(this.taskJournalFailure);
    }
    return this.taskJournal;
  }

  /** @description Requires the publisher paired with the configured durable journal. */
  private requireTaskPublisher(): RemoteTaskOutboxPublisher {
    if (!this.taskOutboxPublisher) throw new RemoteTaskJournalUnavailableError(this.taskJournalFailure);
    return this.taskOutboxPublisher;
  }

  /** @description Rejects stale in-memory owner assertions before querying the journal. */
  private assertExpectedOwner(record: InternalRemoteClientRecord, expectedOwnerSub: string | null): void {
    if ((record.ownerSub ?? null) !== expectedOwnerSub) {
      throw new RemoteClientOwnerConflictError(record.clientId);
    }
  }

  /**
   * @description Converts a client registration into an agent-card payload.
   */
  private toAgentCard(registration: RemoteClientRegistration, lastSeenAt: string): A2AAgentCard {
    return A2AAgentCardSchema.parse({
      agentId: registration.agentId ?? registration.clientId,
      name: registration.name,
      description: registration.description ?? '',
      transport: registration.transport,
      endpointUrl: registration.endpointUrl,
      tailnetHostname: registration.tailnetHostname,
      platform: registration.platform,
      capabilities: registration.capabilities,
      tags: registration.tags,
      mcpServerName: registration.mcpServerName,
      mcpServerCommand: registration.mcpServerCommand,
      mcpToolCount: registration.capabilities.length,
      healthy: true,
      lastSeenAt,
    });
  }

  /**
   * @description Returns a sanitized public record.
   */
  private toPublicRecord(record: InternalRemoteClientRecord): RemoteClientRecord {
    return RemoteClientRecordSchema.parse({
      ...record,
      taskQueueDepth: record.taskQueueDepth,
      mcpToolCount: record.mcpToolCount,
    });
  }

  /**
   * @description Ensures a client exists in the registry.
   */
  private requireClient(clientId: string): InternalRemoteClientRecord {
    const record = this.clients.get(clientId);
    if (!record) {
      throw new RemoteClientNotFoundError(clientId);
    }
    return record;
  }

  /**
   * @description Resolves a canonical agent ID for swarm membership.
   */
  private resolveAgentId(
    registration: RemoteClientRegistration,
    existing: InternalRemoteClientRecord | undefined,
  ): string {
    const current = existing?.agentId;
    if (typeof current === 'string' && current.trim().length > 0) {
      return current;
    }

    const requested = registration.agentId?.trim();
    if (requested && requested.length > 0) {
      return requested;
    }

    return registration.clientId;
  }
}

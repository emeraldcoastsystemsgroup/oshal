/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added in-memory remote-client registry for control-plane task dispatch
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Device ownership binding: ownerSub survives owner-less re-registrations (a refresh must not silently unbind a device) and setOwner() supports operator reassignment (repo-audit 2026-07-05 device-ownership finding)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Typed RemoteClientNotFoundError replaces the bare Error from requireClient. This registry is in-memory, so an api restart drops every registration while the edge daemon keeps polling forever — the routes were mapping that to 400 Bad Request, which is both wrong (the request is fine; the server forgot) and unactionable, since the daemon could not tell it apart from a genuine malformed call. Observed live: 188 such errors in 24h from one orphaned client.
 */

import { createChildLogger } from '@/shared/logger';
import {
  A2AAgentCardSchema,
  A2ATaskEnvelopeSchema,
  A2ATaskResultSchema,
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

const logger = createChildLogger({ module: 'remote-client-registry' });

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
 * @description In-memory registry for remote endpoint clients.
 */
export class RemoteClientRegistryService {
  private readonly clients = new Map<string, RemoteClientRecord & {
    queue: A2ATaskEnvelope[];
    inFlight: Map<string, A2ATaskEnvelope>;
    swarmQueue: RemoteClientSwarmMessage[];
    completed: A2ATaskResult[];
    heartbeat: RemoteClientHeartbeat | null;
  }>();

  /**
   * @description Registers or refreshes a remote client.
   */
  register(registrationInput: unknown): RemoteClientRecord {
    const registration = RemoteClientRegistrationSchema.parse(registrationInput);
    const now = new Date().toISOString();
    const existing = this.clients.get(registration.clientId);
    const resolvedAgentId = this.resolveAgentId(registration, existing);
    const normalizedRegistration = RemoteClientRegistrationSchema.parse({
      ...registration,
      agentId: resolvedAgentId,
    });
    const card = this.toAgentCard(normalizedRegistration, now);

    const record: RemoteClientRecord & {
      queue: A2ATaskEnvelope[];
      inFlight: Map<string, A2ATaskEnvelope>;
      swarmQueue: RemoteClientSwarmMessage[];
      completed: A2ATaskResult[];
      heartbeat: RemoteClientHeartbeat | null;
    } = existing ?? {
      ...normalizedRegistration,
      taskQueueDepth: 0,
      status: 'online',
      healthy: true,
      lastSeenAt: now,
      registeredAt: now,
      lastHeartbeatAt: null,
      heartbeatCount: 0,
      mcpToolCount: 0,
      queue: [],
      inFlight: new Map<string, A2ATaskEnvelope>(),
      swarmQueue: [],
      completed: [],
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
      taskQueueDepth: existing?.queue.length ?? 0,
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
  setOwner(clientId: string, ownerSub: string | null): RemoteClientRecord {
    const record = this.requireClient(clientId);
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
   */
  enqueueTask(clientId: string, taskInput: unknown): A2ATaskEnvelope {
    const record = this.requireClient(clientId);
    const task = A2ATaskEnvelopeSchema.parse({
      ...(typeof taskInput === 'object' && taskInput !== null ? taskInput : {}),
      status: 'queued',
    });
    record.queue.push(task);
    record.taskQueueDepth = record.queue.length;
    logger.info({ clientId, taskId: task.taskId, intent: task.intent }, 'Queued remote client task');
    return task;
  }

  /**
   * @description Claims the next task for a remote client.
   */
  claimNextTask(clientId: string): A2ATaskEnvelope | null {
    const record = this.requireClient(clientId);
    const task = record.queue.shift() ?? null;

    if (!task) {
      record.taskQueueDepth = 0;
      record.activeTaskId = undefined;
      return null;
    }

    const claimedTask = A2ATaskEnvelopeSchema.parse({
      ...task,
      status: 'claimed',
    });

    record.taskQueueDepth = record.queue.length;
    record.activeTaskId = claimedTask.taskId;
    record.inFlight.set(claimedTask.taskId, claimedTask);
    logger.info({ clientId, taskId: claimedTask.taskId, intent: claimedTask.intent }, 'Claimed remote client task');
    return claimedTask;
  }

  /**
   * @description Returns one in-flight task by task ID.
   */
  getInFlightTask(clientId: string, taskId: string): A2ATaskEnvelope | null {
    const record = this.requireClient(clientId);
    return record.inFlight.get(taskId) ?? null;
  }

  /**
   * @description Returns the stored completion result for a task, or null if it
   * is still queued/in-flight (or never existed). Lets a direct enqueuer poll for
   * a task's output over HTTP — swarm-dispatched results also ride the mesh.
   */
  getCompletedResult(clientId: string, taskId: string): A2ATaskResult | null {
    const record = this.requireClient(clientId);
    for (let i = record.completed.length - 1; i >= 0; i -= 1) {
      if (record.completed[i].taskId === taskId) {
        return record.completed[i];
      }
    }
    return null;
  }

  /**
   * @description Marks a task as complete and stores the completion result.
   */
  completeTask(clientId: string, resultInput: unknown): A2ATaskResult {
    const record = this.requireClient(clientId);
    const result = A2ATaskResultSchema.parse(resultInput);
    record.inFlight.delete(result.taskId);
    record.completed.push(result);
    if (record.activeTaskId === result.taskId) {
      record.activeTaskId = undefined;
    }
    logger.info({ clientId, taskId: result.taskId, status: result.status }, 'Remote client task completed');
    return result;
  }

  /**
   * @description Marks a task as failed with an error message.
   */
  failTask(clientId: string, resultInput: unknown): A2ATaskResult {
    const record = this.requireClient(clientId);
    const result = A2ATaskResultSchema.parse({
      ...(typeof resultInput === 'object' && resultInput !== null ? resultInput : {}),
      clientId,
      status: 'failed',
      completedAt: new Date().toISOString(),
    });
    record.inFlight.delete(result.taskId);
    record.completed.push(result);
    if (record.activeTaskId === result.taskId) {
      record.activeTaskId = undefined;
    }
    logger.warn({ clientId, taskId: result.taskId, error: result.error }, 'Remote client task failed');
    return result;
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
  private toPublicRecord(record: RemoteClientRecord & {
    queue: A2ATaskEnvelope[];
    inFlight: Map<string, A2ATaskEnvelope>;
    swarmQueue: RemoteClientSwarmMessage[];
    completed: A2ATaskResult[];
    heartbeat: RemoteClientHeartbeat | null;
  }): RemoteClientRecord {
    return RemoteClientRecordSchema.parse({
      ...record,
      taskQueueDepth: record.queue.length,
      mcpToolCount: record.mcpToolCount,
    });
  }

  /**
   * @description Ensures a client exists in the registry.
   */
  private requireClient(clientId: string): RemoteClientRecord & {
    queue: A2ATaskEnvelope[];
    inFlight: Map<string, A2ATaskEnvelope>;
    swarmQueue: RemoteClientSwarmMessage[];
    completed: A2ATaskResult[];
    heartbeat: RemoteClientHeartbeat | null;
  } {
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
    existing: (RemoteClientRecord & {
      queue: A2ATaskEnvelope[];
      inFlight: Map<string, A2ATaskEnvelope>;
      swarmQueue: RemoteClientSwarmMessage[];
      completed: A2ATaskResult[];
      heartbeat: RemoteClientHeartbeat | null;
    }) | undefined,
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

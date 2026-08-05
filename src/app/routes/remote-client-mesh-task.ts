/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Isolate the mesh-to-remote-task execution boundary with device-owner injection checks and validated embedded, swarm.exec, and explicit-intent conversions.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { A2ATaskEnvelopeSchema, type A2ATaskEnvelope } from '@/shared/types';
import type { MeshEnvelope } from '@/features/agent-management';
import { canUseDevice, type RemoteClientRegistryService } from '@/features/remote-client';

const logger = createChildLogger({ module: 'remote-client-mesh-task' });

/**
 * @description Decides whether a mesh sender may create executable work on a target device.
 * Device-to-device conversion is owner-scoped because the payload can contain arbitrary
 * danger-full-access commands. Non-device senders remain trusted platform/bot traffic.
 */
export function mayInjectRemoteTask(
  registry: RemoteClientRegistryService,
  fromAgentId: string,
  targetClientId: string,
): boolean {
  const clients = registry.listClients();
  const sender = clients.find((client) => (
    (client.agentId || client.clientId) === fromAgentId || client.clientId === fromAgentId
  ));
  if (!sender) return true;
  const target = clients.find((client) => client.clientId === targetClientId);
  if (!target || sender.clientId === target.clientId) return true;
  return canUseDevice({ sub: sender.ownerSub ?? null }, target);
}

/** @description Converts a mesh payload to one validated queued remote task, when executable. */
export function toRemoteTaskEnvelope(
  envelope: MeshEnvelope,
  remoteAgentId: string,
): A2ATaskEnvelope | null {
  const payload = toRecord(envelope.payload);
  if (!payload) return null;
  const embeddedTask = toRecord(payload.task);
  if (embeddedTask) {
    const parsed = parseEmbeddedTask(embeddedTask, envelope, remoteAgentId);
    if (parsed) return parsed;
  }
  const intent = readString(payload.intent);
  if (intent) return parseIntentTask(payload, intent, envelope, remoteAgentId);
  return parseSwarmExecutionTask(payload, envelope, remoteAgentId);
}

/** @description Validates a verbatim embedded task while fixing server-owned routing fields. */
function parseEmbeddedTask(
  task: Record<string, unknown>,
  envelope: MeshEnvelope,
  remoteAgentId: string,
): A2ATaskEnvelope | null {
  try {
    return A2ATaskEnvelopeSchema.parse({
      ...task,
      taskId: readString(task.taskId) ?? randomUUID(),
      correlationId: readString(task.correlationId) ?? envelope.correlationId,
      fromAgentId: readString(task.fromAgentId) ?? envelope.fromAgentId,
      toAgentId: readString(task.toAgentId) ?? remoteAgentId,
      createdAt: readString(task.createdAt) ?? new Date().toISOString(),
      status: 'queued',
    });
  } catch (error) {
    logger.warn(
      { err: error, correlationId: envelope.correlationId, fromAgentId: envelope.fromAgentId },
      'Ignored invalid embedded remote task payload',
    );
    return null;
  }
}

/** @description Converts an ordinary assembled swarm prompt into the node's swarm.exec tool call. */
function parseSwarmExecutionTask(
  payload: Record<string, unknown>,
  envelope: MeshEnvelope,
  remoteAgentId: string,
): A2ATaskEnvelope | null {
  const text = readString(payload.text);
  if (!text || readString(payload.type)) return null;
  try {
    const folder = readString(payload.workspaceFolderId) ?? readString(payload.workspaceTaskId);
    return A2ATaskEnvelopeSchema.parse({
      taskId: readString(payload.workspaceTaskId) ?? readString(payload.taskId) ?? randomUUID(),
      correlationId: readString(payload.correlationId)
        ?? readString(payload.externalId)
        ?? envelope.correlationId,
      fromAgentId: envelope.fromAgentId,
      toAgentId: remoteAgentId,
      intent: 'mcp.call-tool',
      input: { name: 'swarm.exec', arguments: { prompt: text } },
      workspacePath: folder || undefined,
      createdAt: new Date().toISOString(),
      status: 'queued',
    });
  } catch (error) {
    logger.warn({ err: error, correlationId: envelope.correlationId }, 'Ignored invalid remote swarm.exec envelope');
    return null;
  }
}

/** @description Converts an explicit mesh intent without trusting caller lifecycle state. */
function parseIntentTask(
  payload: Record<string, unknown>,
  intent: string,
  envelope: MeshEnvelope,
  remoteAgentId: string,
): A2ATaskEnvelope | null {
  try {
    return A2ATaskEnvelopeSchema.parse({
      taskId: readString(payload.taskId) ?? randomUUID(),
      correlationId: readString(payload.correlationId) ?? envelope.correlationId,
      fromAgentId: envelope.fromAgentId,
      toAgentId: remoteAgentId,
      intent,
      input: toRecord(payload.input) ?? {},
      artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [],
      workspacePath: readString(payload.workspacePath),
      replyTo: readString(payload.replyTo),
      createdAt: readString(payload.createdAt) ?? new Date().toISOString(),
      status: 'queued',
    });
  } catch (error) {
    logger.warn(
      { err: error, correlationId: envelope.correlationId, fromAgentId: envelope.fromAgentId, intent },
      'Ignored invalid mesh envelope for remote task conversion',
    );
    return null;
  }
}

/** @description Returns one object-like value without accepting arrays. */
function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** @description Returns one non-empty string. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

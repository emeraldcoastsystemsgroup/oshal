/**
 * Remote-client task-result landing. handleCompleteTask/handleFailTask in
 * remote-client-routes.ts forward each finished remote task to the mesh — but until
 * now ONLY as a targeted `agent.{requester}` reply that nothing on the controller
 * subscribed to, so swarm-dispatched desktop work finished into a void. This module
 * is both halves of the fix:
 *
 *   - buildRemoteTaskResultEnvelopes: the SENDER contract — the targeted reply
 *     (kept for back-compat with bot-node requesters) PLUS a landing event on the
 *     well-known MESH_CHANNELS.remoteTaskResult channel, correlation id guaranteed.
 *   - createRemoteTaskResultHandler / subscribeRemoteTaskResults: the api-side
 *     consumer (same XREADGROUP poll subscription every mesh consumer uses) that
 *     lands the result on the originating work item, mirroring the canonical
 *     work-item update path (setExecutionOutput + updateStatus) the swarm uses for
 *     bot-node execution results. Correlation contract: the remote task envelope's
 *     correlationId IS the originating ticket's external id (apply-dispatch et al.
 *     already dispatch with correlationId = ticketId; the mesh swarm.exec
 *     conversion now prefers payload.externalId).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — close the unconsumed remote-client.task-result loop: sender envelope builder (targeted reply + landing event, correlation id added when absent) and the controller-side subscriber that lands results on work_items via the canonical setExecutionOutput + updateStatus path.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wrap the mesh landing handler in runWithSystemIdentity: mesh poll callbacks run with NO AsyncLocalStorage identity, so under OSHAL_DB_GUC_STRICT=deny the work_items landing queries were the last DENIED identity-less site in the live audit ("DB access with NO request identity DENIED" @ WorkItemRepository.findByExternalIdAnyProvider). Same machine-trust boundary recordRemoteTaskCost already crosses under the sentinel (remote-client-routes.ts:498) — without it, remote task results silently vanish the day work_items gains an RLS policy.
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import {
  MESH_CHANNELS,
  type MeshCommunicationService,
  type MeshEnvelope,
  type MeshSubscription,
} from '@/features/agent-management';
import type { A2ATaskEnvelope, A2ATaskResult } from '@/shared/types';

const logger = createChildLogger({ module: 'remote-client-task-results' });

/** Work-item statuses still eligible to receive an execution result. */
const LANDABLE_STATUSES = new Set([
  'pending',
  'assigned',
  'executing',
  'in-review',
  'subtask-pending',
  'subtask-assigned',
  'subtask-executing',
]);

/** Serialized landing payloads above this size get their output truncated (25mb screenshots must not bloat work_items). */
const MAX_LANDED_OUTPUT_CHARS = 200_000;

/**
 * @description Narrow landing port over the work-item store — the canonical place
 * swarm execution results attach. WorkItemRepository satisfies it structurally.
 */
export interface RemoteTaskResultLandingRepository {
  findByExternalIdAnyProvider(externalId: string): Promise<Array<{ workItemId: string; status: string }>>;
  setExecutionOutput(workItemId: string, output: unknown): Promise<void>;
  updateStatus(
    workItemId: string,
    status: 'completed' | 'failed' | 'subtask-completed' | 'subtask-failed',
  ): Promise<void>;
}

/** Dependencies for the landing handler. */
export interface RemoteTaskResultHandlerDeps {
  workItemRepository: RemoteTaskResultLandingRepository;
}

/**
 * @description Builds the mesh envelopes a finished remote task emits: the
 * targeted reply to the original requester's direct channel (pre-existing
 * behaviour, kept so bot-node requesters still see it) plus the landing event on
 * the well-known remoteTaskResult channel the controller subscribes to. The
 * correlation id is guaranteed here at the sender: sourceTask.correlationId,
 * else the taskId, else a fresh UUID.
 * @param sourceTask - The originating remote task envelope (as dispatched).
 * @param result - The completion/failure result the node posted back.
 * @returns Envelopes to publish, in order.
 */
export function buildRemoteTaskResultEnvelopes(
  sourceTask: A2ATaskEnvelope,
  result: A2ATaskResult,
): MeshEnvelope[] {
  const correlationId = sourceTask.correlationId?.trim() || sourceTask.taskId?.trim() || randomUUID();
  const payload: Record<string, unknown> = {
    type: 'remote-client.task-result',
    taskId: sourceTask.taskId,
    intent: sourceTask.intent,
    correlationId,
    result,
  };
  return [
    {
      correlationId,
      fromAgentId: sourceTask.toAgentId,
      toAgentId: sourceTask.fromAgentId,
      channel: MESH_CHANNELS.agentDirect(sourceTask.fromAgentId),
      payload,
      messageType: 'reply',
    },
    {
      correlationId,
      fromAgentId: sourceTask.toAgentId,
      toAgentId: 'swarm-controller',
      channel: MESH_CHANNELS.remoteTaskResult,
      payload,
      messageType: 'event',
    },
  ];
}

/**
 * @description Bounds a landing payload so an oversized remote output (e.g. a
 * screen.capture PNG data URL) cannot bloat the work_items row: past the cap the
 * output field is replaced with a truncation marker plus a bounded head.
 * @param landing - The landing payload about to be stored.
 * @returns The payload, with output truncated when the serialized form is oversized.
 */
export function boundRemoteResultLanding(landing: Record<string, unknown>): Record<string, unknown> {
  try {
    if (JSON.stringify(landing).length <= MAX_LANDED_OUTPUT_CHARS) {
      return landing;
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to serialize remote task-result landing payload — storing truncation marker');
    return { ...landing, output: { truncated: true, note: 'output was not serializable' } };
  }
  const serializedOutput = ((): string => {
    try {
      return JSON.stringify(landing.output) ?? '';
    } catch {
      return '';
    }
  })();
  return {
    ...landing,
    output: {
      truncated: true,
      note: `remote-client output exceeded ${MAX_LANDED_OUTPUT_CHARS} serialized chars; head retained — fetch the full result from the node registry while it is held`,
      head: serializedOutput.slice(0, 4_000),
    },
  };
}

/**
 * @description Creates the mesh handler that lands one remote-client.task-result
 * envelope on its originating work item: finds the first still-active work item
 * whose external_id equals the envelope's correlation id, stores the result via
 * setExecutionOutput, and moves the item to completed/failed (subtask-aware) —
 * the same update path bot-node execution results take. Envelopes of any other
 * payload type, or with no matching active work item, are ignored safely.
 * @param deps - The work-item landing repository.
 * @returns An async mesh envelope handler.
 */
export function createRemoteTaskResultHandler(
  deps: RemoteTaskResultHandlerDeps,
): (envelope: MeshEnvelope) => Promise<void> {
  return async (envelope: MeshEnvelope): Promise<void> => {
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    if (payload.type !== 'remote-client.task-result') {
      return;
    }
    const correlationId = readString(payload.correlationId) ?? readString(envelope.correlationId);
    const taskId = readString(payload.taskId);
    if (!correlationId) {
      logger.warn({ taskId, fromAgentId: envelope.fromAgentId }, 'Remote task result has no correlation id — cannot land it');
      return;
    }

    const result = toRecord(payload.result);
    const succeeded = result?.status === 'completed';
    const startedAt = Date.now();
    try {
      const items = await deps.workItemRepository.findByExternalIdAnyProvider(correlationId);
      const target = items.find((item) => LANDABLE_STATUSES.has(item.status));
      if (!target) {
        logger.info(
          { correlationId, taskId, candidates: items.length },
          'No active work item for remote task result — nothing to land (direct enqueuers poll the registry instead)',
        );
        return;
      }

      await deps.workItemRepository.setExecutionOutput(
        target.workItemId,
        boundRemoteResultLanding({
          source: 'remote-client',
          taskId,
          intent: readString(payload.intent),
          correlationId,
          clientId: result ? readString(result.clientId) : undefined,
          status: succeeded ? 'completed' : 'failed',
          output: result?.output,
          error: result ? readString(result.error) : undefined,
          completedAt: result ? readString(result.completedAt) : undefined,
        }),
      );

      const isSubtask = target.status.startsWith('subtask-');
      const nextStatus = succeeded
        ? (isSubtask ? 'subtask-completed' : 'completed')
        : (isSubtask ? 'subtask-failed' : 'failed');
      await deps.workItemRepository.updateStatus(target.workItemId, nextStatus);
      logger.info(
        { correlationId, taskId, workItemId: target.workItemId, nextStatus, durationMs: Date.now() - startedAt },
        'Remote task result landed on originating work item',
      );
    } catch (error) {
      logger.error(
        { err: error, correlationId, taskId, durationMs: Date.now() - startedAt },
        'Failed to land remote task result on work item',
      );
    }
  };
}

/**
 * @description Subscribes the controller to the remoteTaskResult mesh channel
 * (the standard XREADGROUP poll subscription) with the landing handler. The
 * handler runs under the positive SYSTEM identity sentinel: mesh poll callbacks
 * carry no AsyncLocalStorage request identity, and under OSHAL_DB_GUC_STRICT=deny
 * an identity-less connection is stamped anonymous non-operator (zero rows) — the
 * sentinel marks this machine-trust landing path trusted on PURPOSE, mirroring
 * the recordRemoteTaskCost precedent in remote-client-routes.ts.
 * @param mesh - Mesh communication service (subscribe capability only).
 * @param deps - The work-item landing repository.
 * @returns The subscription handle.
 */
export function subscribeRemoteTaskResults(
  mesh: Pick<MeshCommunicationService, 'subscribe'>,
  deps: RemoteTaskResultHandlerDeps,
): MeshSubscription {
  const handler = createRemoteTaskResultHandler(deps);
  const subscription = mesh.subscribe(
    MESH_CHANNELS.remoteTaskResult,
    'controller-remote-task-results',
    async (envelope) => runWithSystemIdentity(() => handler(envelope)),
  );
  logger.info({ channel: MESH_CHANNELS.remoteTaskResult }, 'Remote task-result landing subscriber active');
  return subscription;
}

/**
 * @description Returns one non-empty trimmed string value.
 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * @description Converts unknown values into records when possible.
 */
function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Wire remote-client task HTTP operations and settlement side effects to the PostgreSQL-authoritative journal, with readiness gating, identity-preserving RLS access, immediate outbox draining, and outboxId-based cost deduplication.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Await strict idempotent work-item landing inside settlement outbox publication, so a transient database failure prevents delivered_at and is retried instead of being lost behind a mesh ACK.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fail settlement publication closed when the work-item landing repository is absent; direct enqueuers are represented by a configured repository returning no matching item, never by skipping the durability boundary.
 */

import type { Request, RequestHandler, Response, Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import {
  A2ATaskEnvelopeSchema,
  A2ATaskResultSchema,
  type A2ATaskEnvelope,
  type A2ATaskResult,
} from '@/shared/types';
import type { CostEvent } from '@/features/operational-intelligence';
import type { MeshCommunicationService } from '@/features/agent-management';
import {
  RemoteClientClaimResponseSchema,
  RemoteClientNotFoundError,
  RemoteClientOwnerConflictError,
  RemoteClientRegistryService,
  RemoteClientTaskCompletionSchema,
  RemoteClientTaskSchema,
  RemoteTaskJournalUnavailableError,
  type RemoteTaskOutboxPublisher,
  type RemoteTaskOutboxRecord,
} from '@/features/remote-client';
import {
  buildRemoteTaskResultEnvelopes,
  landRemoteTaskResultEnvelope,
  type RemoteTaskResultLandingRepository,
} from './remote-client-task-results';

const logger = createChildLogger({ module: 'remote-client-task-operations' });

/** @description Atomic downstream cost writer keyed by the durable outbox row. */
export type RecordRemoteTaskCostOnce = (outboxId: string, event: CostEvent) => Promise<boolean>;

/** @description Dependencies needed by task routes and their transactional-outbox publisher. */
export interface RemoteClientTaskOperationDependencies {
  registry: RemoteClientRegistryService;
  isMachineCaller: (req: Request) => boolean;
  meshCommunicationService?: MeshCommunicationService;
  workItemRepository?: RemoteTaskResultLandingRepository;
  recordCostOnce?: RecordRemoteTaskCostOnce;
}

/**
 * @description Mounts only the durable task lifecycle routes on an existing authenticated router.
 * @param router - Remote-client router after authentication and rate limiting.
 * @param requireDeviceAccess - Existing owner-or-operator authorization middleware.
 * @param deps - Registry, identity discriminator, and settlement side effects.
 */
export function registerRemoteClientTaskOperations(
  router: Router,
  requireDeviceAccess: RequestHandler,
  deps: RemoteClientTaskOperationDependencies,
): void {
  router.get('/:clientId/tasks/next', requireDeviceAccess, (req, res) => void handleClaim(req, res, deps));
  router.post('/:clientId/tasks', requireDeviceAccess, (req, res) => void handleEnqueue(req, res, deps));
  router.get('/:clientId/tasks/:taskId/result', requireDeviceAccess, (req, res) => void handleResult(req, res, deps));
  router.post('/:clientId/tasks/:taskId/complete', requireDeviceAccess, (req, res) => void handleSettle(req, res, deps, 'completed'));
  router.post('/:clientId/tasks/:taskId/fail', requireDeviceAccess, (req, res) => void handleSettle(req, res, deps, 'failed'));
}

/** @description Creates the crash-replayable publisher paired with the task journal. */
export function createRemoteTaskOutboxPublisher(
  deps: Pick<
    RemoteClientTaskOperationDependencies,
    'meshCommunicationService' | 'recordCostOnce' | 'workItemRepository'
  >,
): RemoteTaskOutboxPublisher {
  return async (record) => {
    if (record.topic === 'remote-task.dispatch') {
      logger.info({ outboxId: record.outboxId, taskId: record.taskId }, 'Acknowledged durable task dispatch event');
      return;
    }
    await publishSettlement(record, deps);
  };
}

/** @description Claims one owner-bound task without redelivering an already-active claim. */
async function handleClaim(
  req: Request,
  res: Response,
  deps: RemoteClientTaskOperationDependencies,
): Promise<void> {
  const clientId = normalizeParam(req.params.clientId);
  try {
    requireReady(deps.registry);
    const ownerSub = requireClientOwner(deps.registry, clientId);
    const task = await runTaskIdentity(req, deps, () => deps.registry.claimNextTask(clientId, ownerSub));
    const response = RemoteClientClaimResponseSchema.parse({ claimed: task !== null, task });
    if (!response.claimed) {
      res.status(204).end();
      return;
    }
    res.json(response);
  } catch (error) {
    respondTaskError(error, res, { clientId, operation: 'claim' });
  }
}

/** @description Durably accepts a fixed-owner task or returns its idempotent tombstone. */
async function handleEnqueue(
  req: Request,
  res: Response,
  deps: RemoteClientTaskOperationDependencies,
): Promise<void> {
  const clientId = normalizeParam(req.params.clientId);
  try {
    requireReady(deps.registry);
    const input = RemoteClientTaskSchema.parse(req.body);
    const task = await runTaskIdentity(req, deps, () => deps.registry.enqueueTask(clientId, input));
    res.status(201).json({ task });
  } catch (error) {
    respondTaskError(error, res, { clientId, operation: 'enqueue' });
  }
}

/** @description Reads a terminal tombstone without consulting process memory. */
async function handleResult(
  req: Request,
  res: Response,
  deps: RemoteClientTaskOperationDependencies,
): Promise<void> {
  const clientId = normalizeParam(req.params.clientId);
  const taskId = normalizeParam(req.params.taskId);
  try {
    requireReady(deps.registry);
    const result = await runTaskIdentity(req, deps, () => deps.registry.getCompletedResult(clientId, taskId));
    if (!result) {
      res.status(404).json({ error: 'No completed result for this task yet' });
      return;
    }
    res.json(A2ATaskResultSchema.parse(result));
  } catch (error) {
    respondTaskError(error, res, { clientId, taskId, operation: 'result' });
  }
}

/** @description Writes the first terminal result; publisher failures remain pending but do not rewrite HTTP success. */
async function handleSettle(
  req: Request,
  res: Response,
  deps: RemoteClientTaskOperationDependencies,
  status: 'completed' | 'failed',
): Promise<void> {
  const clientId = normalizeParam(req.params.clientId);
  const taskId = normalizeParam(req.params.taskId);
  try {
    requireReady(deps.registry);
    const input = RemoteClientTaskCompletionSchema.parse({
      ...req.body,
      clientId,
      taskId,
      status,
      completedAt: new Date().toISOString(),
    });
    const settle = status === 'completed' ? deps.registry.completeTask.bind(deps.registry) : deps.registry.failTask.bind(deps.registry);
    const result = await runTaskIdentity(req, deps, () => settle(clientId, input));
    res.json(A2ATaskResultSchema.parse(result));
  } catch (error) {
    respondTaskError(error, res, { clientId, taskId, operation: status });
  }
}

/** @description Reconstructs the settled task and performs idempotent cost then mesh effects. */
async function publishSettlement(
  record: RemoteTaskOutboxRecord,
  deps: Pick<
    RemoteClientTaskOperationDependencies,
    'meshCommunicationService' | 'recordCostOnce' | 'workItemRepository'
  >,
): Promise<void> {
  const sourceTask = A2ATaskEnvelopeSchema.parse(record.payload.envelope);
  const result = A2ATaskResultSchema.parse(record.payload.result);
  if (!deps.workItemRepository) {
    throw new Error('Durable remote-task work-item landing repository is not configured');
  }
  const costEvent = buildRemoteTaskCostEvent(sourceTask, result);
  if (costEvent) {
    if (!deps.recordCostOnce) throw new Error('Durable remote-task cost recorder is not configured');
    await deps.recordCostOnce(record.outboxId, costEvent);
  }
  const envelopes = buildRemoteTaskResultEnvelopes(sourceTask, result, record.outboxId);
  const landingEnvelope = envelopes[1];
  if (!landingEnvelope) throw new Error('Remote-task landing envelope was not constructed');
  await landRemoteTaskResultEnvelope(landingEnvelope, {
    workItemRepository: deps.workItemRepository,
  });
  if (deps.meshCommunicationService) {
    for (const envelope of envelopes) {
      await deps.meshCommunicationService.send(envelope);
    }
  }
  logger.info({ outboxId: record.outboxId, taskId: record.taskId }, 'Published durable task settlement effects');
}

/** @description Builds a leaf-node LLM cost event, excluding non-LLM desktop operations. */
export function buildRemoteTaskCostEvent(
  sourceTask: A2ATaskEnvelope | null,
  result: A2ATaskResult,
): CostEvent | null {
  const agentId = sourceTask?.fromAgentId;
  if (!agentId) return null;
  const output = toRecord(result.output) ?? {};
  const usage = toRecord(output.usage) ?? {};
  const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
  const totalCost = Number(output.cost ?? output.costUSD ?? 0) || 0;
  if (inputTokens === 0 && outputTokens === 0 && totalCost === 0) return null;
  return createCostEvent(sourceTask, result, output, { agentId, inputTokens, outputTokens, totalCost });
}

/** @description Assembles the cost record after usage presence has been proven. */
function createCostEvent(
  task: A2ATaskEnvelope,
  result: A2ATaskResult,
  output: Record<string, unknown>,
  usage: { agentId: string; inputTokens: number; outputTokens: number; totalCost: number },
): CostEvent {
  const correlationId = result.correlationId || task.correlationId || task.taskId;
  const args = toRecord(toRecord(task.input)?.arguments) ?? {};
  const providerId = String(output.provider || 'openai-codex');
  return {
    taskId: `${correlationId}::${usage.agentId}`,
    agentId: usage.agentId,
    providerId,
    modelId: String(args.model || providerId),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    inputCost: 0,
    outputCost: 0,
    totalCost: usage.totalCost,
    currency: 'USD',
    ticketExternalId: correlationId,
    ownerSub: task.userSub,
    requestCount: 1,
    estimated: false,
    durationMs: Number(output.durationMs) || undefined,
  };
}

/** @description Uses system identity only for the already-authorized shared-secret machine branch. */
function runTaskIdentity<T>(
  req: Request,
  deps: RemoteClientTaskOperationDependencies,
  operation: () => Promise<T>,
): Promise<T> {
  return deps.isMachineCaller(req) ? runWithSystemIdentity(operation) : operation();
}

/** @description Fails task routes closed until schema bootstrap and startup replay finish. */
function requireReady(registry: RemoteClientRegistryService): void {
  if (!registry.isTaskJournalReady()) throw new RemoteTaskJournalUnavailableError();
}

/** @description Returns the registration owner used by owner-aware claim SQL. */
function requireClientOwner(registry: RemoteClientRegistryService, clientId: string): string | null {
  const client = registry.getClient(clientId);
  if (!client) throw new RemoteClientNotFoundError(clientId);
  return client.ownerSub ?? null;
}

/** @description Maps durable authority failures without leaking owner identity. */
function respondTaskError(
  error: unknown,
  res: Response,
  fields: Record<string, unknown>,
): void {
  if (error instanceof RemoteTaskJournalUnavailableError) {
    res.status(503).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof RemoteClientNotFoundError) {
    res.status(404).json({ error: 'Remote client not found', code: error.code });
    return;
  }
  if (error instanceof RemoteClientOwnerConflictError) {
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
  logger.error({ err: error, ...fields }, 'Durable remote-client task operation failed');
  res.status(400).json({ error: error instanceof Error ? error.message : 'Remote task operation failed' });
}

/** @description Normalizes Express path parameters. */
function normalizeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/** @description Converts object-like values without accepting arrays. */
function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

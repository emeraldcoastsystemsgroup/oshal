/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from llm-execution-handler.ts, which had crossed 800 code lines: the token-capturing provider wrapper, the cost and metrics recorder types and helpers, the envelope owner/tenant readers and the ADR-027 ticket linker. Pure move; exported members gained full JSDoc, the lines still log under the llm-execution-handler module, and an unused private readOptionalString helper was dropped.
 */

import { createChildLogger } from '@/shared/logger';
import { LLMService, resolveUsageCost, type TokenUsage, type CostResult, type SendRequestOptions, type LLMResponse } from '@/features/llm-provider';
import type { TicketService } from '@/features/ticketing';
import { optionalExactUserSubject } from '@/shared/security/exact-user-subject';

// The module name these lines have always logged under, so a log search keeps finding them.
const logger = createChildLogger({ module: 'llm-execution-handler' });
/**
 * @description Proxy wrapper around LLMService that captures token usage from provider responses.
 * This is the bridge between the agent layer (which discards token data) and the cost tracking
 * layer (which needs real token counts). Does not modify provider or agent code.
 */
export class TokenCapturingProvider extends LLMService {
  lastUsage: TokenUsage | null = null;
  lastModel: string | null = null;
  private readonly delegate: LLMService;

  constructor(delegate: LLMService) {
    super(delegate.getProviderName(), {});
    this.delegate = delegate;
  }

  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    const response = await this.delegate.sendRequest(options);
    this.lastUsage = response.usage;
    this.lastModel = response.model;
    return response;
  }

  override calculateCost(usage: TokenUsage): CostResult {
    return this.delegate.calculateCost(usage);
  }
}

/**
 * @description Callback for recording cost events from LLM execution.
 */
export type CostRecordFn = (event: {
  taskId: string; agentId: string; providerId: string; modelId: string;
  inputTokens: number; outputTokens: number; inputCost: number;
  outputCost: number; totalCost: number; currency: string;
  ticketExternalId?: string;
  requestCount?: number;
  /** End-user (OIDC sub) for per-owner budget attribution (Phase 2). */
  ownerSub?: string;
  /** Measured wall-clock duration (ms) of the execution this event bills, when known
   *  (migration 090 observability). Omit rather than fabricate. */
  durationMs?: number;
}) => Promise<void>;

/**
 * @description Callback for recording agent execution events for metrics.
 */
export type MetricsRecordFn = (event: {
  agentId: string; ticketExternalId: string; swarmRunId: string;
  durationMs: number; outcome: 'completed' | 'failed' | 'escalated';
  retryCount: number; verificationAttempts: number;
}) => void;

/**
 * @description Records a cost event from LLM execution using real token counts
 * captured from the provider response via TokenCapturingProvider. The measured
 * execution duration rides along so the ledger row carries per-call latency
 * (migration 090) — the handler already timed the run for its own logging.
 * @param recordCost - The cost recorder; nothing is recorded without one.
 * @param taskId - Per-bot task id (`<ticket>::<agent>`).
 * @param agentId - The executing agent.
 * @param providerId - The provider the cost row names.
 * @param modelId - The model the cost row names when the response reports none.
 * @param ticketExternalId - The ticket the run belongs to.
 * @param capturingProvider - The provider wrapper that captured the usage.
 * @param ownerSub - The ticket owner for per-owner budget attribution.
 * @param durationMs - The measured execution duration.
 * @returns Resolves once the row is written or the failure is logged.
 */
export async function recordCostEvent(
  recordCost: CostRecordFn | undefined,
  taskId: string, agentId: string, providerId: string, modelId: string,
  ticketExternalId: string | undefined, capturingProvider: TokenCapturingProvider,
  ownerSub?: string, durationMs?: number,
): Promise<void> {
  if (!recordCost) return;
  try {
    const usage = capturingProvider.lastUsage;
    if (!usage) {
      logger.debug({ taskId }, 'No token usage captured — skipping cost recording');
      return;
    }
    const resolvedModelId = capturingProvider.lastModel?.trim() || modelId;
    const cost = resolveUsageCost({
      providerCost: capturingProvider.calculateCost(usage),
      usage,
      providerId,
      modelId: resolvedModelId,
    });
    // Read real API call count from the provider when available
    const delegate = (capturingProvider as unknown as { delegate: unknown }).delegate as { getLastSessionApiCalls?: () => number };
    const realRequestCount = typeof delegate?.getLastSessionApiCalls === 'function' ? delegate.getLastSessionApiCalls() : 0;

    await recordCost({
      taskId, agentId, providerId, modelId: resolvedModelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      inputCost: cost.inputCost,
      outputCost: cost.outputCost,
      totalCost: cost.totalCost,
      currency: cost.currency,
      ticketExternalId,
      requestCount: realRequestCount > 0 ? realRequestCount : 1,
      ownerSub,
      durationMs,
    });
  } catch (err) {
    logger.warn({ err, taskId }, 'Cost recording failed — non-blocking');
  }
}

/**
 * @description Reads the exact owner subject an envelope carries, from the payload or its original ticket.
 * @param payload - The envelope payload.
 * @param originalTicket - The original ticket carried in the payload, if any.
 * @returns The exact owner subject, or undefined when the envelope names none.
 */
export function resolveEnvelopeOwnerSub(
  payload: Record<string, unknown> | undefined,
  originalTicket: Record<string, unknown> | undefined,
): string | undefined {
  const candidates = [
    payload?.userSub, payload?.ownerSub, originalTicket?.ownerSub, originalTicket?.owner_sub,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) {
      return optionalExactUserSubject(candidate, 'swarm envelope ownerSub');
    }
  }
  return undefined;
}

/**
 * @description Reads the exact tenant id an envelope carries, refusing a malformed value.
 * @param payload - The envelope payload.
 * @param originalTicket - The original ticket carried in the payload, if any.
 * @returns The tenant id, or undefined when the envelope names none.
 */
export function resolveEnvelopeTenantId(
  payload: Record<string, unknown> | undefined,
  originalTicket: Record<string, unknown> | undefined,
): string | undefined {
  const candidate = payload?.tenantId ?? payload?.tenant_id
    ?? originalTicket?.tenantId ?? originalTicket?.tenant_id;
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512
    || /[\u0000-\u001f\u007f-\u009f]/.test(candidate)) {
    throw new TypeError('swarm envelope tenantId must be exact and control-free');
  }
  return candidate;
}

/**
 * @description Links a swarm bot's task to the parent ticket so cost rollup queries can find it.
 * Creates a ticket_task_links entry with role 'swarm-execution'. Non-blocking — failures are
 * logged but do not affect execution outcome.
 * @param ticketService - Optional ticket service for creating the link
 * @param ticketExternalId - External ticket ID from the envelope payload
 * @param taskId - Per-bot task ID used in chat_tasks
 * @param agentId - Agent ID for logging
 * @returns Resolves once the link is written or the failure is logged.
 */
export async function linkSwarmTaskToTicket(
  ticketService: TicketService | undefined,
  ticketExternalId: string | undefined,
  taskId: string,
  agentId: string,
): Promise<void> {
  if (!ticketService || !ticketExternalId) return;
  // Extract canonical ticket UUID from synthetic IDs:
  //   "verify:UUID" → UUID
  //   "review:UUID:r1" → UUID
  //   plain UUID → UUID
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let canonicalId = ticketExternalId;
  if (!uuidPattern.test(canonicalId)) {
    // Try to extract UUID from synthetic patterns like "verify:UUID" or "review:UUID:r1"
    const uuidMatch = canonicalId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (uuidMatch) {
      canonicalId = uuidMatch[1];
      logger.info({ ticketExternalId, canonicalId, taskId }, 'Extracted canonical ticket ID from synthetic external ID');
    } else {
      logger.debug({ ticketExternalId, taskId }, 'Skipping ticket link — cannot extract UUID from external ID');
      return;
    }
  }
  try {
    await ticketService.linkTask(canonicalId, taskId, 'swarm-execution');
    logger.info({ ticketExternalId, taskId, agentId }, 'Linked swarm task to ticket for cost rollup');
  } catch (err) {
    logger.warn({ err, ticketExternalId, taskId, agentId }, 'Failed to link swarm task to ticket — cost rollup may be incomplete');
  }
}

/**
 * @description Records an agent execution event for metrics tracking.
 * @param recordMetrics - The metrics recorder; nothing is recorded without one.
 * @param agentId - The executing agent.
 * @param ticketExternalId - The ticket the run belongs to.
 * @param swarmRunId - The run correlation id.
 * @param durationMs - The measured execution duration.
 * @param outcome - The execution outcome.
 * @returns Nothing; a recorder failure is logged and swallowed.
 */
export function recordMetricsEvent(
  recordMetrics: MetricsRecordFn | undefined,
  agentId: string, ticketExternalId: string, swarmRunId: string,
  durationMs: number, outcome: 'completed' | 'failed' = 'completed',
): void {
  if (!recordMetrics) return;
  try {
    recordMetrics({ agentId, ticketExternalId, swarmRunId, durationMs, outcome, retryCount: 0, verificationAttempts: 1 });
  } catch (err) {
    logger.warn({ err, agentId }, 'Metrics recording failed — non-blocking');
  }
}

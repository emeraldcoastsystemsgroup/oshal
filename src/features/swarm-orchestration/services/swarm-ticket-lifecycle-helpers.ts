/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted lifecycle helper functions from SwarmTicketProcessingService to bring it under the 1000-line governance cap. Includes swarm learnings storage, delivery metrics recording, output text extraction, and workspace task ID resolution.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Extracted buildProcessingResult() from processing service to maintain 1000-line cap after metrics wiring
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Session 19: Added enforceHandoverGate() — rejects ticket advancement when handovers missing, logs structured enforcement event
 */

import { createChildLogger } from '@/shared/logger';
import type { ExternalWorkItem } from '@/entities/ticket';
import type { WorkItemRepository } from '@/entities/work-item';
import type { SwarmMemoryService, CompletedWorkContext } from '@/features/agent-management';
import type { SwarmExecutionPolicyOutcome } from './swarm-execution-policy-runner';
import type { SwarmCyclePolicyService } from './swarm-cycle-policy';
import type { SwarmEscalationStore } from './swarm-escalation-store';
import type { TicketService } from '@/features/ticketing';
import type { IntakeProvider } from '@/shared/types';
import type { IntakeService } from '@/features/intake';
import type { SwarmProcessedTicketResult } from './swarm-run-store';
import type { SwarmProcessingResult } from './swarm-ticket-processing-service';

const logger = createChildLogger({ module: 'swarm-ticket-lifecycle-helpers' });

/**
 * @description Safely converts an unknown error to an Error instance.
 * @param err - Unknown throwable.
 * @returns Normalized Error.
 */
function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

// ---------------------------------------------------------------------------
// Swarm Learnings
// ---------------------------------------------------------------------------

/**
 * @description Dependencies for storing swarm learnings.
 */
export interface SwarmLearningsDeps {
  swarmMemoryService?: SwarmMemoryService;
  workItemRepository?: WorkItemRepository;
}

/**
 * @description Stores cross-ticket learnings in swarm memory after successful processing.
 * Non-blocking — failures are logged but do not affect the ticket result.
 * @param item - Processed ticket
 * @param outcome - Final execution outcome with verification and agent details
 * @param deps - Service dependencies
 */
export async function storeSwarmLearnings(
  item: ExternalWorkItem,
  outcome: SwarmExecutionPolicyOutcome,
  deps: SwarmLearningsDeps,
): Promise<void> {
  if (!deps.swarmMemoryService) return;
  if (outcome.verification.status !== 'passed') return;
  try {
    const executionOutput = extractOutputText(outcome, deps.workItemRepository);
    if (!executionOutput) return;
    const context: CompletedWorkContext = {
      workItemId: item.externalId,
      title: item.title,
      agentId: outcome.routing.winner.agentId,
      executionOutput,
      complexity: String(outcome.workUnits.length),
      hadVerificationFailures: outcome.executionAttempts > 1,
      hadEscalations: Boolean(outcome.escalation),
      categories: item.labels,
    };
    await deps.swarmMemoryService.extractAndStore(context);
    logger.info({ externalId: item.externalId }, 'Swarm learnings stored');
  } catch (error) {
    logger.warn({ err: toError(error), externalId: item.externalId }, 'Failed to store swarm learnings — continuing');
  }
}

// ---------------------------------------------------------------------------
// Delivery Metrics
// ---------------------------------------------------------------------------

/**
 * @description Callback type for recording delivery metrics.
 */
export type DeliveryMetricsRecorder = (event: {
  agentId: string;
  ticketExternalId: string;
  swarmRunId: string;
  durationMs: number;
  outcome: 'completed' | 'failed' | 'escalated';
  retryCount: number;
  verificationAttempts: number;
}) => void;

/**
 * @description Records delivery-phase metrics for the ticket. Captures whether
 * the agent succeeded at the full lifecycle, not just execution.
 * @param runId - Swarm run identifier
 * @param item - Ticket that completed delivery
 * @param outcome - Final execution outcome
 * @param recorder - Optional metrics recording callback
 */
export function recordTicketDeliveryMetrics(
  runId: string,
  item: ExternalWorkItem,
  outcome: SwarmExecutionPolicyOutcome,
  recorder?: DeliveryMetricsRecorder,
): void {
  if (!recorder) return;
  try {
    const deliveryOutcome = outcome.escalation
      ? 'escalated'
      : outcome.verification.status === 'passed'
        ? 'completed'
        : 'failed';
    recorder({
      agentId: outcome.routing.winner.agentId,
      ticketExternalId: item.externalId,
      swarmRunId: runId,
      durationMs: 0,
      outcome: deliveryOutcome,
      retryCount: outcome.executionAttempts - 1,
      verificationAttempts: outcome.executionAttempts,
    });
    logger.info(
      { externalId: item.externalId, agentId: outcome.routing.winner.agentId, outcome: deliveryOutcome },
      'Delivery metrics recorded',
    );
  } catch (error) {
    logger.warn({ err: toError(error), externalId: item.externalId }, 'Failed to record delivery metrics — continuing');
  }
}

// ---------------------------------------------------------------------------
// Output Text Extraction
// ---------------------------------------------------------------------------

/**
 * @description Extracts text output from the execution outcome work units.
 * @param outcome - Execution policy outcome
 * @param workItemRepository - Optional work item repository for enhanced extraction
 * @returns Combined output text or undefined if no output found
 */
export function extractOutputText(
  outcome: SwarmExecutionPolicyOutcome,
  workItemRepository?: WorkItemRepository,
): string | undefined {
  if (!workItemRepository) return outcome.verification.summary;
  const summaryParts = outcome.workUnits.map((u) => u.title).join('; ');
  const findings = outcome.verification.findings.join('\n');
  return [summaryParts, outcome.verification.summary, findings].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Workspace Task ID Resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Escalation Persistence
// ---------------------------------------------------------------------------

/**
 * @description Persists an escalation record when execution policy produces one.
 * @param runId - Parent swarm run identifier
 * @param externalId - External ticket identifier
 * @param outcome - Execution outcome containing escalation metadata
 * @param cyclePolicyService - Policy service for building escalation records
 * @param escalationStore - Store for persisting escalation records
 */
export async function persistEscalationRecord(
  runId: string,
  externalId: string,
  outcome: SwarmExecutionPolicyOutcome,
  cyclePolicyService: SwarmCyclePolicyService,
  escalationStore: SwarmEscalationStore,
): Promise<void> {
  if (!outcome.escalation) return;

  try {
    const record = cyclePolicyService.buildEscalationRecord(
      runId, externalId,
      {
        action: 'escalate',
        regressionTarget: 'build',
        retryClass: outcome.escalation.retryClass,
        reason: outcome.escalation.reason,
        escalationTarget: outcome.escalation.target,
        escalationSeverity: outcome.escalation.severity,
      },
      {
        verificationAttempt: outcome.executionAttempts,
        buildRegressionCount: outcome.buildRegressionCount,
        designRegressionCount: outcome.designRegressionCount,
      },
    );
    await escalationStore.save(record);
  } catch (error) {
    logger.error({ err: toError(error), runId, externalId }, 'Failed to persist swarm escalation record');
  }
}

// ---------------------------------------------------------------------------
// Execution Output Polling
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 600_000;

/**
 * @description Polls work items for execution completion and returns the output.
 * @param externalId - External ticket identifier
 * @param policy - Resolved run policy for timeout configuration
 * @param workItemRepository - Optional work item repository
 * @returns Execution output from completed work items, or undefined on timeout
 */
export async function awaitExecutionOutput(
  externalId: string,
  policy: { maxRunDurationMs?: number },
  workItemRepository?: WorkItemRepository,
): Promise<unknown> {
  if (!workItemRepository) return undefined;

  const maxWaitMs = Math.min(policy.maxRunDurationMs ?? MAX_WAIT_MS, MAX_WAIT_MS);
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const items = await workItemRepository.findByExternalIdAnyProvider(externalId);
    const completed = items.filter((wi) => wi.status === 'completed' && wi.executionOutput);
    if (completed.length > 0) {
      logger.info({ externalId, completedCount: completed.length }, 'Execution output available');
      return completed.length === 1 ? completed[0].executionOutput : completed.map((wi) => wi.executionOutput);
    }
    const failed = items.filter((wi) => wi.status === 'failed' && wi.executionOutput);
    if (failed.length > 0) {
      logger.warn({ externalId, failedCount: failed.length }, 'Execution failed before producing a completed work item');
      return failed.length === 1 ? failed[0].executionOutput : failed.map((wi) => wi.executionOutput);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  logger.warn({ externalId, maxWaitMs }, 'Timed out waiting for execution output');
  return undefined;
}

/**
 * @description Sleep for the given number of milliseconds.
 * @param ms - Milliseconds to sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Workspace Task ID Resolution
// ---------------------------------------------------------------------------

/**
 * @description Resolves the top-parent ticket UUID to use as the shared workspace key.
 * Root tickets use their own externalId. Child tickets inherit the highest ancestor ticketId.
 * @param item - External work item
 * @param ticketService - Optional ticket service for parent resolution
 * @returns The resolved workspace task ID
 */
export async function resolveWorkspaceTaskId(
  item: ExternalWorkItem,
  ticketService?: TicketService,
): Promise<string> {
  const rawPayload = item.rawPayload as Record<string, unknown> | undefined;
  const directParentId =
    typeof rawPayload?.parentTicketId === 'string' && rawPayload.parentTicketId.trim().length > 0
      ? rawPayload.parentTicketId
      : null;

  if (!directParentId || !ticketService) {
    return item.externalId;
  }

  let currentParentId: string | null = directParentId;
  let topParentId = directParentId;

  while (currentParentId) {
    const ticket = await ticketService.getTicket(currentParentId);
    if (!ticket) {
      break;
    }
    topParentId = ticket.ticketId;
    currentParentId = ticket.parentTicketId ?? null;
  }

  return topParentId;
}

// ---------------------------------------------------------------------------
// API Response Builder
// ---------------------------------------------------------------------------

/**
 * @description Builds API response payload from pull result and processed tickets.
 * Extracted from SwarmTicketProcessingService to maintain 1000-line governance cap.
 */
export function buildProcessingResult(
  runId: string,
  provider: IntakeProvider,
  intakeResult: Awaited<ReturnType<IntakeService['pull']>>,
  processed: SwarmProcessedTicketResult[],
): SwarmProcessingResult {
  return {
    runId,
    provider,
    source: intakeResult.source,
    nextCursor: intakeResult.nextCursor,
    effectiveCursor: intakeResult.effectiveCursor,
    pulledCount: intakeResult.items.length,
    processedCount: processed.length,
    processed,
  };
}

// ---------------------------------------------------------------------------
// Handover Enforcement Gate
// ---------------------------------------------------------------------------

/**
 * @description Structured outcome of the handover enforcement gate, telling the
 * processing service whether a phase's rounds all produced required developer
 * handovers and how many were missing so it can escalate or continue.
 */
export interface HandoverGateResult {
  passed: boolean;
  phase: number;
  missingHandovers: number;
  totalRounds: number;
}

/**
 * @description Checks whether all rounds in a phase dispatch result had valid handovers.
 * Returns a structured result that the processing service uses to decide whether to
 * escalate or continue. Logs enforcement events for operator visibility.
 *
 * @param ticketId - External ticket identifier
 * @param phaseResult - Result from multi-round dispatch containing handover flags
 * @param strict - When true, returns passed=false on any missing handover. Default true.
 * @returns Gate result indicating pass/fail and details
 */
export function enforceHandoverGate(
  ticketId: string,
  phaseResult: { phase: number; rounds: Array<{ handoverValidated: boolean; agentId: string; round: number }>; handoversEnforced: boolean },
  strict = true,
): HandoverGateResult {
  const totalRounds = phaseResult.rounds.length;
  const missingHandovers = phaseResult.rounds.filter((r) => !r.handoverValidated).length;
  const passed = strict ? phaseResult.handoversEnforced : missingHandovers === 0;

  if (!passed) {
    const failedAgents = phaseResult.rounds
      .filter((r) => !r.handoverValidated)
      .map((r) => ({ agentId: r.agentId, round: r.round }));
    logger.warn(
      { ticketId, phase: phaseResult.phase, missingHandovers, totalRounds, failedAgents, strict },
      'HANDOVER GATE FAILED — agents did not write required developer handovers. Ticket blocked from advancing.',
    );
  } else if (totalRounds > 0) {
    logger.info(
      { ticketId, phase: phaseResult.phase, totalRounds },
      'Handover gate passed — all rounds have valid developer handovers',
    );
  }

  return { passed, phase: phaseResult.phase, missingHandovers, totalRounds };
}
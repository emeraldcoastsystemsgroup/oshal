/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted execution, regression, and finalization lifecycle helpers from SwarmTicketProcessingService to restore file-governance compliance
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BF-NEW fix: testing/review regression returned true (continue) without re-running execution — now returns false (stop) and logs escalation-equivalent when no loop-back mechanism exists
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | TD-2: Real regression loop-back — executeTestingWithRegression/executeReviewWithRegression now return regression feedback string so processOneTicket can re-execute Phase 4. evaluateRegression is now async (Postgres-backed).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | WS4: Added recordRegressionHandoff() — durable JSONL record written to workspace .oshal/regression-trace.jsonl when testing or review regression is triggered. Added workspaceTaskId to executeTestingWithRegression args.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | P2: Phase 5 (testing) and Phase 7 (delivery) handover writes — RALFHandoverManager now writes handover files after testing verdict and delivery completion so all 7 phases produce artifacts.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Feedback-carrying build retry: dispatchExecution callback now threads the policy runner's optional retryFeedback into the mesh envelope payload so the executing bot's prompt names the previous attempt's verification miss (blind re-roll fix, docs/backlog/test-lab.md #2)
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExternalWorkItem } from '@/entities/ticket';
import type { WorkItemRepository } from '@/entities/work-item';
import type { MeshCommunicationService, RouteCandidate, RouteDecision, SwarmMemoryService } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';
import type { ConsensusReviewOutcome } from './consensus-review-service';
import type { PhaseRegressionService } from './phase-regression-service';
import type { QueueGovernanceService } from './queue-governance-service';
import { type SwarmCyclePolicy, SwarmCyclePolicyService } from './swarm-cycle-policy';
import type { SwarmEscalationStore } from './swarm-escalation-store';
import type { SwarmExecutionPolicyOutcome, SwarmExecutionPolicyRunner } from './swarm-execution-policy-runner';
import type { SwarmProcessingInput } from './swarm-ticket-processing-service';
import {
  storeSwarmLearnings as storeSwarmLearningsHelper,
  recordTicketDeliveryMetrics as recordDeliveryMetricsHelper,
  awaitExecutionOutput as awaitExecutionOutputHelper,
  persistEscalationRecord,
  type DeliveryMetricsRecorder,
} from './swarm-ticket-lifecycle-helpers';
import { type SwarmTicketCycle, TicketCycleStateMachine } from './ticket-cycle-state-machine';
import type { SwarmProcessedTicketResult } from './swarm-run-store';
import type { SwarmRoutingHandler } from './swarm-routing-handler';
import type { SwarmSubtaskHandler } from './swarm-subtask-handler';
import {
  buildExecutionEnvelope,
  buildVerificationFailureMessage,
  buildVerificationSummary,
  SwarmEscalationError,
  toError,
} from './swarm-ticket-processing-support';
import type { SwarmWritebackHandler } from './swarm-writeback-handler';
import type { RALFHandoverManager } from './ralf-handover-manager';
import type { DecomposedWorkUnit } from './ticket-decomposition-service';

const logger = createChildLogger({ module: 'swarm-execution-lifecycle-service' });

/**
 * @description Standard cycle execution result used by lifecycle callbacks.
 */
export interface CycleExecutionResult<T> {
  details: Record<string, unknown>;
  value: T;
}

/**
 * @description Bundle of work units and routing chosen for the current phase.
 */
export interface RoutedWorkUnitSet {
  workUnits: DecomposedWorkUnit[];
  routing: { winner: RouteCandidate; strategy: string };
}

/**
 * @description Callback shape for delegating phase execution back through the caller's lifecycle wrapper.
 */
export type ExecuteCycleFn = <T>(
  cycle: SwarmTicketCycle,
  operation: () => Promise<CycleExecutionResult<T>>,
) => Promise<T>;

/**
 * @description Result of a testing or review phase with regression support.
 * - `passed`: Phase succeeded, continue to next phase.
 * - `escalated`: Regression limit exceeded, ticket is escalated.
 * - `regress`: Phase failed but within regression budget — caller should re-execute Phase 4 with feedback.
 */
export interface TestingRegressionResult {
  outcome: 'passed' | 'escalated' | 'regress';
  feedback?: string;
  regressionCount?: number;
}

/**
 * @description Dependencies required by the execution lifecycle service.
 */
export interface SwarmExecutionLifecycleServiceDeps {
  executionPolicyRunner: SwarmExecutionPolicyRunner;
  meshService: MeshCommunicationService;
  routingHandler: SwarmRoutingHandler;
  subtaskHandler: SwarmSubtaskHandler;
  writebackHandler: SwarmWritebackHandler;
  cyclePolicyService: SwarmCyclePolicyService;
  escalationStore: SwarmEscalationStore;
  workItemRepository?: WorkItemRepository;
  swarmMemoryService?: SwarmMemoryService;
  recordDeliveryMetrics?: DeliveryMetricsRecorder;
  getRegressionService: () => PhaseRegressionService | undefined;
  getGovernanceService: () => QueueGovernanceService | undefined;
  handoverManager?: RALFHandoverManager;
  selectAgent: (
    item: Pick<ExternalWorkItem, 'externalId' | 'title' | 'body'>,
    input: SwarmProcessingInput,
    workUnits: DecomposedWorkUnit[],
    phaseContext?: {
      currentPhase?: number;
      ticketDepth?: number;
      complexity?: string;
      executorAgentId?: string;
      pmAssignedAgentId?: string;
      pmAssignedRole?: string;
    },
  ) => Promise<RouteDecision>;
}

/**
 * @description Encapsulates execution-phase retries, review/testing regressions, and final delivery bookkeeping.
 */
export class SwarmExecutionLifecycleService {
  constructor(private readonly deps: SwarmExecutionLifecycleServiceDeps) {}

  /**
   * @description Updates governance phase tracking when governance is enabled.
   * @param ticketId - External ticket identifier.
   * @param phase - Current phase name.
   * @param phaseIndex - Numeric phase index.
   * @returns Promise resolved once governance has been updated.
   */
  async updateGovernancePhase(ticketId: string, phase: string, phaseIndex: number): Promise<void> {
    const governanceService = this.deps.getGovernanceService();
    if (!governanceService) {
      return;
    }
    await governanceService.updateProcessingState(ticketId, phase, phaseIndex);
  }

  /**
   * @description Executes the bounded execution policy loop for the current ticket.
   * @param item - Ticket being processed.
   * @param input - Run-level processing input.
   * @param workUnits - Planned work units to execute.
   * @param routing - Selected execution routing.
   * @param runId - Parent swarm run identifier.
   * @param policy - Resolved run policy.
   * @param runStartedAt - Run start timestamp for guardrail calculations.
   * @param workspaceTaskId - Shared workspace identifier.
   * @returns Execution policy outcome plus lifecycle details.
   */
  async runExecutionPolicy(
    item: ExternalWorkItem,
    input: SwarmProcessingInput,
    workUnits: DecomposedWorkUnit[],
    routing: RouteDecision,
    runId: string,
    policy: SwarmCyclePolicy,
    runStartedAt: number,
    workspaceTaskId: string,
  ): Promise<CycleExecutionResult<SwarmExecutionPolicyOutcome>> {
    const outcome = await this.deps.executionPolicyRunner.run(
      item,
      input,
      workUnits,
      routing,
      policy,
      {
        dispatchExecution: async (nextRouting, nextWorkUnits, retryFeedback) => {
          const envelope = buildExecutionEnvelope(runId, nextRouting.winner.agentId, item.externalId, nextWorkUnits, workspaceTaskId);
          const payload = envelope.payload as Record<string, unknown>;
          payload.phase = 4;
          payload.round = 1;
          if (retryFeedback) {
            // Build-retry attempt: surface the previous attempt's verification
            // findings to the bot so the retry is corrective, not a blind re-roll.
            payload.retryFeedback = retryFeedback;
          }
          const itemRaw = (item as Record<string, unknown>).rawPayload as Record<string, unknown> | undefined;
          const itemRawMeta = itemRaw?.metadata as Record<string, unknown> | undefined;
          payload.ticketDepth = Number(itemRawMeta?.depth ?? 0);
          payload.agentId = nextRouting.winner.agentId;
          if (Array.isArray(itemRawMeta?.siblingTitles)) {
            payload.siblingTitles = itemRawMeta.siblingTitles;
          }
          await this.deps.meshService.send(envelope);
          return this.awaitExecutionOutput(item.externalId, policy);
        },
        reroute: (nextItem, nextInput, nextWorkUnits) => {
          const hasSpecialistCaps = Boolean(nextInput.requiredCapabilities?.length)
            && !nextInput.requiredCapabilities?.includes('orchestrate');
          return this.deps.selectAgent(nextItem, nextInput, nextWorkUnits, {
            currentPhase: 4,
            ticketDepth: hasSpecialistCaps ? 1 : 0,
            executorAgentId: routing.winner.agentId,
          });
        },
        dispatchSubtask: async (nextRouting, subtask) => {
          const envelope = buildExecutionEnvelope(runId, nextRouting.winner.agentId, subtask.unitId, [subtask], workspaceTaskId);
          await this.deps.meshService.send(envelope);
          const output = await this.awaitExecutionOutput(subtask.unitId, policy);
          await this.deps.subtaskHandler.persistSubtaskStatus(subtask.unitId, output ? 'subtask-completed' : 'subtask-failed', output);
          return output;
        },
      },
      runStartedAt,
      workspaceTaskId,
    );

    return {
      value: outcome,
      details: {
        toAgentId: outcome.routing.winner.agentId,
        workUnitCount: outcome.workUnits.length,
        executionAttempts: outcome.executionAttempts,
        buildRegressionCount: outcome.buildRegressionCount,
        designRegressionCount: outcome.designRegressionCount,
        policyDecisions: outcome.policyDecisions,
        retryClasses: outcome.retryClasses,
        guardrailTriggered: outcome.guardrailTriggered ?? null,
      },
    };
  }

  /**
   * @description Executes testing and applies regression governance when testing fails.
   * @param args - Testing execution arguments.
   * @returns True when processing should continue, false when escalation ended the ticket.
   */
  async executeTestingWithRegression(args: {
    runId: string;
    item: ExternalWorkItem;
    lifecycle: TicketCycleStateMachine;
    executionOutcome: SwarmExecutionPolicyOutcome;
    policy: SwarmCyclePolicy;
    executeCycle: ExecuteCycleFn;
    workspaceTaskId?: string;
  }): Promise<TestingRegressionResult> {
    const { runId, item, lifecycle, executionOutcome, policy, executeCycle, workspaceTaskId } = args;
    try {
      await executeCycle('testing', async () => ({
        value: undefined,
        details: {
          verificationStatus: executionOutcome.verification.status,
          findings: executionOutcome.verification.findings,
          executionAttempts: executionOutcome.executionAttempts,
        },
      }));
      this.writePhaseHandover({
        workspaceTaskId, agentId: 'task-manager', phase: 5, round: 1,
        summary: 'Testing PASSED',
        details: `Verification status: ${executionOutcome.verification.status}\nFindings: ${(executionOutcome.verification.findings || []).join('; ') || 'None'}`,
      });
      return { outcome: 'passed' };
    } catch (testingError) {
      const regressionService = this.deps.getRegressionService();
      if (!regressionService) {
        throw testingError;
      }

      const decision = await regressionService.evaluateRegression(
        item.externalId,
        'testing',
        executionOutcome.verification.summary ?? 'Testing failed',
        executionOutcome.verification.findings,
        executionOutcome.routing.winner.agentId,
      );

      if (decision.shouldEscalate) {
        logger.warn({ externalId: item.externalId, regressionCount: decision.regressionCount }, 'Testing regression limit exceeded — escalating');
        await this.deps.getGovernanceService()?.transitionState(item.externalId, 'escalated');
        return { outcome: 'escalated' };
      }

      if (!decision.shouldRegress) {
        throw testingError;
      }

      logger.info(
        { externalId: item.externalId, regressionTarget: decision.regressionTarget, regressionCount: decision.regressionCount },
        'Testing regression triggered — returning feedback for re-execution loop',
      );
      this.recordRegressionHandoff({
        ticketId: item.externalId, workspaceTaskId, sourcePhase: 5,
        sourceExternalId: `verify:${item.externalId}`, agentId: executionOutcome.routing.winner.agentId,
        findings: executionOutcome.verification.findings, feedback: decision.feedback ?? undefined,
        regressionCount: decision.regressionCount,
      });
      this.writePhaseHandover({
        workspaceTaskId, agentId: 'task-manager', phase: 5, round: decision.regressionCount ?? 1,
        summary: `Testing FAILED — regression #${decision.regressionCount ?? 1}`,
        details: `Target: ${decision.regressionTarget || 'execution'}\nFeedback: ${decision.feedback || 'N/A'}\nFindings: ${(executionOutcome.verification.findings || []).join('; ') || 'None'}`,
      });
      return { outcome: 'regress', feedback: decision.feedback ?? undefined, regressionCount: decision.regressionCount };
    }
  }

  /**
   * @description Executes review and applies regression governance when review fails.
   * @param args - Review execution arguments.
   * @returns True when processing should continue, false when escalation ended the ticket.
   */
  async executeReviewWithRegression(args: {
    item: ExternalWorkItem;
    lifecycle: TicketCycleStateMachine;
    executionOutcome: SwarmExecutionPolicyOutcome;
    workUnits: RoutedWorkUnitSet;
    policy: SwarmCyclePolicy;
    workspaceTaskId: string;
    executeCycle: ExecuteCycleFn;
  }): Promise<TestingRegressionResult> {
    const { item, lifecycle, executionOutcome, workUnits, policy, workspaceTaskId, executeCycle } = args;
    try {
      await executeCycle('review', async () => {
        const reviewOutcome = await this.deps.routingHandler.runConsensusReview(
          item,
          workUnits.workUnits,
          executionOutcome,
          workspaceTaskId,
        );
        return {
          value: reviewOutcome,
          details: {
            consensus: reviewOutcome.consensus,
            reviewerCount: reviewOutcome.reviewerCount,
            approvedCount: reviewOutcome.approvedCount,
            rejectedCount: reviewOutcome.rejectedCount,
            summary: reviewOutcome.summary,
          },
        };
      });
      return { outcome: 'passed' };
    } catch (reviewError) {
      const regressionService = this.deps.getRegressionService();
      if (!regressionService) {
        throw reviewError;
      }

      const decision = await regressionService.evaluateRegression(
        item.externalId,
        'review',
        toError(reviewError).message,
        [],
      );

      if (decision.shouldEscalate) {
        logger.warn({ externalId: item.externalId, regressionCount: decision.regressionCount }, 'Review regression limit exceeded — escalating');
        await this.deps.getGovernanceService()?.transitionState(item.externalId, 'escalated');
        return { outcome: 'escalated' };
      }

      if (!decision.shouldRegress) {
        throw reviewError;
      }

      logger.info(
        { externalId: item.externalId, regressionTarget: decision.regressionTarget, regressionCount: decision.regressionCount },
        'Review regression triggered — returning feedback for re-execution loop',
      );
      this.recordRegressionHandoff({
        ticketId: item.externalId, workspaceTaskId, sourcePhase: 6,
        sourceExternalId: `review:${item.externalId}:r${decision.regressionCount ?? 1}`,
        agentId: undefined, findings: [], feedback: decision.feedback ?? undefined,
        regressionCount: decision.regressionCount,
      });
      return { outcome: 'regress', feedback: decision.feedback ?? undefined, regressionCount: decision.regressionCount };
    }
  }

  /**
   * @description Finalizes a ticket after execution, delivery write-back, and learning persistence.
   * @param args - Finalization arguments.
   * @returns Final processed ticket result.
   */
  async finalizeTicketProcessing(args: {
    runId: string;
    item: ExternalWorkItem;
    lifecycle: TicketCycleStateMachine;
    executionOutcome: SwarmExecutionPolicyOutcome;
    policy: SwarmCyclePolicy;
    executeCycle: ExecuteCycleFn;
    workspaceTaskId?: string;
  }): Promise<SwarmProcessedTicketResult> {
    const { runId, item, lifecycle, executionOutcome, policy, executeCycle, workspaceTaskId } = args;
    if (executionOutcome.escalation) {
      await this.persistEscalation(runId, item.externalId, executionOutcome);
    }

    await this.executeDeliveryCycle(runId, item, lifecycle, executionOutcome, policy, executeCycle, workspaceTaskId);
    await this.deps.writebackHandler.emitLifecycleCompletionWritebackUpdate(
      runId,
      item,
      lifecycle.snapshot(),
      executionOutcome.routing.winner.agentId,
      executionOutcome.workUnits.length,
      policy,
    );

    await storeSwarmLearningsHelper(item, executionOutcome, {
      swarmMemoryService: this.deps.swarmMemoryService,
      workItemRepository: this.deps.workItemRepository,
    });
    recordDeliveryMetricsHelper(runId, item, executionOutcome, this.deps.recordDeliveryMetrics);

    const pmAssignments = (executionOutcome as unknown as Record<string, unknown>)._pmAgentAssignments as
      Array<{ subtaskTitle: string; suggestedRole: string; suggestedAgentId?: string }> | undefined;

    return {
      externalId: item.externalId,
      title: item.title,
      selectedAgentId: executionOutcome.routing.winner.agentId,
      selectedStrategy: executionOutcome.routing.strategy,
      workUnitCount: executionOutcome.workUnits.length,
      lifecycle: lifecycle.snapshot(),
      planningDecomposition: executionOutcome.workUnits.length > 1
        ? executionOutcome.workUnits.map((unit) => ({
            title: unit.title,
            description: unit.description,
            acceptanceCriteria: unit.acceptanceCriteria,
            workType: unit.workType ?? 'implementation',
            labels: unit.labels,
          }))
        : undefined,
      agentAssignments: pmAssignments,
    };
  }

  /**
   * @description Polls for execution output via the shared lifecycle helper.
   * @param externalId - Ticket or subtask external identifier.
   * @param policy - Resolved swarm policy.
   * @returns Execution output, or undefined when unavailable.
   */
  async awaitExecutionOutput(externalId: string, policy: SwarmCyclePolicy): Promise<unknown> {
    return awaitExecutionOutputHelper(externalId, policy, this.deps.workItemRepository);
  }

  /** @description Persists escalation metadata when execution policy escalates. */
  private async persistEscalation(
    runId: string,
    externalId: string,
    outcome: SwarmExecutionPolicyOutcome,
  ): Promise<void> {
    return persistEscalationRecord(runId, externalId, outcome, this.deps.cyclePolicyService, this.deps.escalationStore);
  }

  /**
   * @description Records a durable regression handoff to workspace .oshal/regression-trace.jsonl.
   * Called when testing or review regression is triggered so the trace analyzer (WS1) and
   * operator tooling can explain why a ticket re-entered Phase 4 execution.
   * Write failure is non-blocking — the regression loop continues regardless.
   */
  private recordRegressionHandoff(args: {
    ticketId: string;
    workspaceTaskId: string | undefined;
    sourcePhase: 5 | 6;
    sourceExternalId: string;
    agentId: string | undefined;
    findings: string[];
    feedback: string | undefined;
    regressionCount: number | undefined;
  }): void {
    const record = {
      ticketId: args.ticketId,
      workspaceTaskId: args.workspaceTaskId ?? null,
      sourcePhase: args.sourcePhase,
      sourceExternalId: args.sourceExternalId,
      agentId: args.agentId ?? null,
      findings: args.findings,
      feedback: args.feedback ?? null,
      regressionCount: args.regressionCount ?? 0,
      createdAt: new Date().toISOString(),
    };
    logger.info({ ...record, feedback: record.feedback?.substring(0, 200) }, 'Regression handoff recorded');
    if (!args.workspaceTaskId) return;
    try {
      const wsRoot = process.env.SHARED_WORKSPACE_ROOT
        || (fs.existsSync('/app/workspace') ? '/app/workspace' : path.resolve(process.cwd(), 'workspace-shared'));
      const oshalDir = path.join(wsRoot, args.workspaceTaskId, '.oshal');
      fs.mkdirSync(oshalDir, { recursive: true });
      fs.appendFileSync(path.join(oshalDir, 'regression-trace.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      logger.warn({ err, workspaceTaskId: args.workspaceTaskId }, 'Regression handoff file write failed — non-blocking');
    }
  }

  /** @description Executes the delivery cycle through the caller's lifecycle wrapper. */
  private async executeDeliveryCycle(
    runId: string,
    item: ExternalWorkItem,
    lifecycle: TicketCycleStateMachine,
    outcome: SwarmExecutionPolicyOutcome,
    policy: SwarmCyclePolicy,
    executeCycle: ExecuteCycleFn,
    workspaceTaskId?: string,
  ): Promise<void> {
    if (outcome.verification.status === 'passed') {
      await executeCycle('delivery', async () => ({
        value: undefined,
        details: buildVerificationSummary(outcome),
      }));
      this.writePhaseHandover({
        workspaceTaskId, agentId: outcome.routing.winner.agentId, phase: 7, round: 1,
        summary: 'Delivery COMPLETE — verification passed',
        details: `Agent: ${outcome.routing.winner.agentId}\nWork units: ${outcome.workUnits.length}\nExecution attempts: ${outcome.executionAttempts}`,
      });
      return;
    }

    this.writePhaseHandover({
      workspaceTaskId, agentId: outcome.routing.winner.agentId, phase: 7, round: 1,
      summary: `Delivery COMPLETE — verification ${outcome.verification.status}`,
      details: `Agent: ${outcome.routing.winner.agentId}\nVerification: ${outcome.verification.status}\nFindings: ${(outcome.verification.findings || []).join('; ') || 'None'}`,
    });
    await executeCycle('delivery', async () => {
      throw buildVerificationError(outcome);
    });
  }

  /**
   * @description Writes a phase handover file via the RALF handover manager.
   * Non-blocking — failure only logs a warning.
   */
  private writePhaseHandover(args: {
    workspaceTaskId: string | undefined;
    agentId: string;
    phase: number;
    round: number;
    summary: string;
    details: string;
  }): void {
    if (!args.workspaceTaskId || !this.deps.handoverManager) return;
    try {
      const content =
        `# Developer Handover — ${args.agentId}\n` +
        `**Phase:** ${args.phase} | **Round:** ${args.round}\n` +
        `**Timestamp:** ${new Date().toISOString()}\n` +
        `**Status:** ${args.summary}\n\n` +
        `## What I Did\n${args.details}\n\n` +
        `## Key Context for Next Agent\n- Phase ${args.phase} outcome: ${args.summary}\n`;
      this.deps.handoverManager.writeHandover(args.workspaceTaskId, args.agentId, args.phase, args.round, content);
      logger.info({ phase: args.phase, agentId: args.agentId, workspaceTaskId: args.workspaceTaskId }, 'Phase handover written');
    } catch (err) {
      logger.warn({ err, phase: args.phase }, 'Phase handover write failed — non-blocking');
    }
  }
}

/**
 * @description Converts a failed verification outcome into an error for lifecycle handling.
 * @param outcome - Final execution policy outcome.
 * @returns Error representing the verification failure.
 */
function buildVerificationError(outcome: SwarmExecutionPolicyOutcome): Error {
  if (!outcome.escalation) {
    return new Error(buildVerificationFailureMessage(outcome));
  }

  return new SwarmEscalationError(
    outcome.escalation.target,
    outcome.escalation.reason,
    buildVerificationFailureMessage(outcome),
  );
}
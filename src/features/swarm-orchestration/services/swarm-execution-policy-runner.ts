/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added execution policy runner for bounded verification regressions without recursive lifecycle mutation
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added explicit escalation outcome and retry backoff handling for execution policy flow
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added max-cycle and run-duration guardrails with retry class propagation to execution outcomes
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Updated dispatch callback to return execution output for real verification
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added SubtaskLifecycleService integration for per-subtask dispatch with state tracking
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Updated call sites for async SubtaskLifecycleService methods (store-backed persistence)
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Feedback-carrying build retry: retry_build now captures the verifier's summary+findings into state.retryFeedback and passes it to dispatchExecution so the re-attempt is corrective, not a blind re-roll (docs/backlog/test-lab.md #2); design regressions clear the feedback because the work units are re-planned
 */

import type { ExternalWorkItem } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import type { RouteDecision } from '@/features/agent-management';
import type { SwarmProcessingInput } from './swarm-ticket-processing-service';
import type { DecomposedWorkUnit, TicketDecompositionService } from './ticket-decomposition-service';
import type {
  SwarmCyclePolicy,
  SwarmEscalationTarget,
  SwarmRetryClass,
  SwarmEscalationSeverity,
  SwarmCyclePolicyService,
  SwarmVerificationAttemptState,
  SwarmVerificationPolicyDecision,
} from './swarm-cycle-policy';
import type { SwarmVerificationResult, SwarmVerificationService } from './swarm-verification-service';
import { sleep } from './swarm-ticket-processing-support';
import type { SubtaskLifecycleService } from './subtask-lifecycle-service';

const logger = createChildLogger({ module: 'swarm-execution-policy-runner' });

/**
 * @description Final execution outcome returned after bounded verification retries and regressions.
 */
export interface SwarmExecutionPolicyOutcome {
  workUnits: DecomposedWorkUnit[];
  routing: RouteDecision;
  verification: SwarmVerificationResult;
  executionAttempts: number;
  buildRegressionCount: number;
  designRegressionCount: number;
  policyDecisions: string[];
  retryClasses: SwarmRetryClass[];
  escalation?: {
    target: SwarmEscalationTarget;
    severity: SwarmEscalationSeverity;
    retryClass: SwarmRetryClass;
    reason: string;
  };
  guardrailTriggered?: 'max_cycles' | 'max_duration';
}

/**
 * @description Executes bounded verification retries and design/build regressions for one ticket.
 */
export class SwarmExecutionPolicyRunner {
  constructor(
    private readonly verificationService: SwarmVerificationService,
    private readonly cyclePolicyService: SwarmCyclePolicyService,
    private readonly decompositionService: TicketDecompositionService,
    private readonly subtaskLifecycleService?: SubtaskLifecycleService,
  ) {}

  /**
   * @description Filters work units to root-level (depth 0) items.
   * @param workUnits - All work units
   * @returns Only depth-0 work units
   */
  private filterRootUnits(workUnits: DecomposedWorkUnit[]): DecomposedWorkUnit[] {
    return filterRootUnitsHelper(workUnits);
  }

  /**
   * @description Filters work units to subtask (depth > 0) items.
   * @param workUnits - All work units
   * @returns Only subtask work units
   */
  private filterSubtaskUnits(workUnits: DecomposedWorkUnit[]): DecomposedWorkUnit[] {
    return filterSubtaskUnitsHelper(workUnits);
  }

  /**
   * @description Dispatches subtask work units one at a time through the subtask callback,
   * tracking state transitions via the lifecycle service.
   * @param subtasks - Subtask work units to dispatch
   * @param routing - Current routing decision
   * @param callbacks - Execution callbacks with subtask dispatch support
   */
  private async dispatchSubtasksSequentially(
    subtasks: DecomposedWorkUnit[],
    routing: RouteDecision,
    callbacks: SwarmExecutionPolicyCallbacks,
  ): Promise<void> {
    for (const subtask of subtasks) {
      try {
        await this.subtaskLifecycleService?.transitionSubtask(subtask.unitId, 'subtask-assigned');
        await this.subtaskLifecycleService?.transitionSubtask(subtask.unitId, 'subtask-executing');

        const output = await callbacks.dispatchSubtask!(routing, subtask);
        if (output) {
          await this.subtaskLifecycleService?.recordExecutionOutput(subtask.unitId, String(output));
        }
        await this.subtaskLifecycleService?.transitionSubtask(subtask.unitId, 'subtask-completed');
      } catch (error) {
        logger.error({ subtaskId: subtask.unitId, err: error }, 'Subtask dispatch failed in policy runner');
        await this.subtaskLifecycleService?.transitionSubtask(subtask.unitId, 'subtask-failed');
      }
    }
  }

  /**
   * @description Runs execution attempts until verification passes or policy escalation is required.
   * @param item - Ticket being processed
   * @param input - Processing input used for rerouting when design regression occurs
   * @param initialWorkUnits - Initial decomposition output
   * @param initialRouting - Initial routing decision
   * @param policy - Resolved run policy
   * @param callbacks - Callbacks for dispatching execution and rerouting on design regression
   * @returns Final execution outcome including verification and policy history
   */
  async run(
    item: ExternalWorkItem,
    input: SwarmProcessingInput,
    initialWorkUnits: DecomposedWorkUnit[],
    initialRouting: RouteDecision,
    policy: SwarmCyclePolicy,
    callbacks: SwarmExecutionPolicyCallbacks,
    runStartedAt?: number,
    workspaceTaskId?: string,
  ): Promise<SwarmExecutionPolicyOutcome> {
    const state = createPolicyRunState(initialWorkUnits, initialRouting);
    const effectiveRunStart = runStartedAt ?? Date.now();
    while (true) {
      const guardrail = checkGuardrails(state, policy, effectiveRunStart, this.cyclePolicyService);
      if (guardrail) {
        return finalizeGuardrailEscalation(state, guardrail, item.externalId, policy);
      }

      const rootUnits = this.filterRootUnits(state.workUnits);
      const subtaskUnits = this.filterSubtaskUnits(state.workUnits);

      const executionOutput = await callbacks.dispatchExecution(state.routing, rootUnits, state.retryFeedback);
      if (subtaskUnits.length > 0 && callbacks.dispatchSubtask) {
        await this.dispatchSubtasksSequentially(subtaskUnits, state.routing, callbacks);
      }

      state.executionAttempts += 1;
      state.verification = await this.verificationService.verify(item, state.workUnits, state.routing.winner.agentId, executionOutput, workspaceTaskId);
      if (state.verification.status === 'passed') {
        return finalizePolicyRun(state);
      }

      const decision = this.cyclePolicyService.decideVerificationFailure(state.verification, toAttemptState(state), policy);
      state.policyDecisions.push(decision.reason);
      state.retryClasses.push(decision.retryClass);
      logger.warn({ externalId: item.externalId, decision }, 'Swarm execution policy requested regression');
      if (decision.action === 'escalate') {
        state.escalation = {
          target: decision.escalationTarget,
          severity: decision.escalationSeverity,
          retryClass: decision.retryClass,
          reason: decision.reason,
        };
        return finalizePolicyRun(state);
      }

      await sleep(policy.verificationRetryDelayMs);
      await applyDecision(decision, state, item, input, callbacks, this.decompositionService);
    }
  }
}

/**
 * @description Callback bundle used by the policy runner to dispatch and reroute execution attempts.
 */
export interface SwarmExecutionPolicyCallbacks {
  /**
   * @description Dispatches one execution attempt to the selected agent.
   * @param routing - Current routing decision.
   * @param workUnits - Root-level work units to execute.
   * @param retryFeedback - Present ONLY on a build-retry attempt: the previous
   * attempt's verification summary + findings, so the agent can correct the exact
   * miss instead of blindly re-rolling. Absent on first attempts and after design
   * regressions (the plan changed, so old findings no longer apply).
   * @returns Execution output for verification, when available.
   */
  dispatchExecution(routing: RouteDecision, workUnits: DecomposedWorkUnit[], retryFeedback?: string): Promise<unknown>;
  reroute(item: ExternalWorkItem, input: SwarmProcessingInput, workUnits: DecomposedWorkUnit[]): RouteDecision | Promise<RouteDecision>;
  dispatchSubtask?(routing: RouteDecision, subtask: DecomposedWorkUnit): Promise<unknown>;
}

/**
 * @description Filters work units to root-level (depth 0) items only.
 * @param workUnits - All work units
 * @returns Root-level work units
 */
function filterRootUnitsHelper(workUnits: DecomposedWorkUnit[]): DecomposedWorkUnit[] {
  return workUnits.filter((u) => (u.depth ?? 0) === 0);
}

/**
 * @description Filters work units to subtask (depth > 0) items only.
 * @param workUnits - All work units
 * @returns Subtask work units
 */
function filterSubtaskUnitsHelper(workUnits: DecomposedWorkUnit[]): DecomposedWorkUnit[] {
  return workUnits.filter((u) => (u.depth ?? 0) > 0);
}

interface PolicyRunState {
  workUnits: DecomposedWorkUnit[];
  routing: RouteDecision;
  verification: SwarmVerificationResult;
  /** Verifier findings from the last failed attempt, carried into the next build-retry dispatch. */
  retryFeedback?: string;
  executionAttempts: number;
  buildRegressionCount: number;
  designRegressionCount: number;
  policyDecisions: string[];
  retryClasses: SwarmRetryClass[];
  escalation?: {
    target: SwarmEscalationTarget;
    severity: SwarmEscalationSeverity;
    retryClass: SwarmRetryClass;
    reason: string;
  };
  guardrailTriggered?: 'max_cycles' | 'max_duration';
}

/**
 * @description Creates mutable state used by one execution policy run.
 * @param workUnits - Initial work units
 * @param routing - Initial routing decision
 * @returns Mutable policy run state
 */
function createPolicyRunState(
  workUnits: DecomposedWorkUnit[],
  routing: RouteDecision,
): PolicyRunState {
  return {
    workUnits,
    routing,
    verification: {
      status: 'passed',
      summary: 'verification not run yet',
      findings: [],
    },
    retryFeedback: undefined,
    executionAttempts: 0,
    buildRegressionCount: 0,
    designRegressionCount: 0,
    policyDecisions: [],
    retryClasses: [],
    escalation: undefined,
    guardrailTriggered: undefined,
  };
}

/**
 * @description Converts mutable run state into the policy service attempt view.
 * @param state - Mutable policy run state
 * @returns Attempt state consumed by policy evaluation
 */
function toAttemptState(state: PolicyRunState): SwarmVerificationAttemptState {
  return {
    verificationAttempt: state.executionAttempts,
    buildRegressionCount: state.buildRegressionCount,
    designRegressionCount: state.designRegressionCount,
  };
}

/**
 * @description Applies one policy decision to mutable execution state.
 * @param decision - Policy decision after a failed verification
 * @param state - Mutable policy run state
 * @param item - Ticket being processed
 * @param input - Processing input used for rerouting
 * @param callbacks - Execution policy callbacks
 * @param decompositionService - Decomposition service used for design regressions
 * @returns Promise resolved after state mutation is complete
 */
async function applyDecision(
  decision: SwarmVerificationPolicyDecision,
  state: PolicyRunState,
  item: ExternalWorkItem,
  input: SwarmProcessingInput,
  callbacks: SwarmExecutionPolicyCallbacks,
  decompositionService: TicketDecompositionService,
): Promise<void> {
  if (decision.action === 'retry_build') {
    state.buildRegressionCount += 1;
    // Carry the verifier's exact findings into the re-dispatch so the agent can
    // correct the specific miss (e.g. 'deliverables-directory-empty') instead of
    // re-rolling the identical prompt (docs/backlog/test-lab.md recommendation #2).
    state.retryFeedback = buildRetryFeedback(state.verification);
    return;
  }

  state.designRegressionCount += 1;
  // Design regression re-plans the work units — the previous attempt's findings
  // describe a plan that no longer exists, so drop them.
  state.retryFeedback = undefined;
  state.workUnits = decompositionService.decompose(item);
  state.routing = await callbacks.reroute(item, input, state.workUnits);
}

/**
 * @description Condenses a failed verification result into a single feedback string
 * for the retry dispatch prompt. Kept short and factual: summary first, then the
 * structured findings the verifier produced (the prompt builder frames the imperative).
 * @param verification - The failed verification result from the previous attempt
 * @returns Feedback text for the next build-retry dispatch
 */
function buildRetryFeedback(verification: SwarmVerificationResult): string {
  const findings = (verification.findings ?? []).filter((f) => typeof f === 'string' && f.trim().length > 0);
  const segments = [verification.summary, ...findings].filter((s): s is string => Boolean(s && s.trim()));
  return segments.join(' | ');
}

/**
 * @description Freezes mutable execution state into the public outcome contract.
 * @param state - Mutable policy run state
 * @returns Immutable execution policy outcome
 */
function finalizePolicyRun(state: PolicyRunState): SwarmExecutionPolicyOutcome {
  return {
    workUnits: [...state.workUnits],
    routing: state.routing,
    verification: state.verification,
    executionAttempts: state.executionAttempts,
    buildRegressionCount: state.buildRegressionCount,
    designRegressionCount: state.designRegressionCount,
    policyDecisions: [...state.policyDecisions],
    retryClasses: [...state.retryClasses],
    escalation: state.escalation,
    guardrailTriggered: state.guardrailTriggered,
  };
}

/**
 * @description Checks whether any guardrail condition (max cycles or max duration) is exceeded.
 * @param state - Current policy run state
 * @param policy - Resolved run policy
 * @param runStartedAt - Epoch millisecond timestamp when the run started
 * @param policyService - Policy service for guardrail checks
 * @returns Guardrail type that was triggered, or null if none
 */
function checkGuardrails(
  state: PolicyRunState,
  policy: SwarmCyclePolicy,
  runStartedAt: number,
  policyService: SwarmCyclePolicyService,
): 'max_cycles' | 'max_duration' | null {
  const totalCycles = state.executionAttempts + state.buildRegressionCount + state.designRegressionCount;
  if (policyService.isCycleGuardrailExceeded(totalCycles, policy)) {
    return 'max_cycles';
  }

  if (policyService.isRunDurationExceeded(runStartedAt, policy)) {
    return 'max_duration';
  }

  return null;
}

/**
 * @description Finalizes the policy run with a guardrail-triggered escalation.
 * @param state - Current policy run state
 * @param guardrail - Guardrail type that triggered
 * @param externalId - External ticket identifier for logging
 * @param policy - Resolved run policy
 * @returns Execution outcome with guardrail escalation
 */
function finalizeGuardrailEscalation(
  state: PolicyRunState,
  guardrail: 'max_cycles' | 'max_duration',
  externalId: string,
  policy: SwarmCyclePolicy,
): SwarmExecutionPolicyOutcome {
  const reason = guardrail === 'max_cycles'
    ? `Max-cycle guardrail exceeded for ticket ${externalId} after ${state.executionAttempts} execution attempts.`
    : `Max-duration guardrail exceeded for ticket ${externalId} after ${state.executionAttempts} execution attempts.`;

  logger.warn({ externalId, guardrail, executionAttempts: state.executionAttempts }, reason);
  state.guardrailTriggered = guardrail;
  state.policyDecisions.push(reason);
  state.escalation = {
    target: policy.escalationTarget,
    severity: 'high',
    retryClass: 'deterministic',
    reason,
  };
  return finalizePolicyRun(state);
}

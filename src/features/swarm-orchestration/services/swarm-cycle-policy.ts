/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added bounded swarm retry and regression policy service for verification and write-back control
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added escalation routing and retry backoff controls for swarm policy decisions
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added max-cycle guardrails, retry classification, escalation severity, and persistent routing config
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added work-intent-aware retry reasons and smarter escalation routing for verification failures
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Idle-timeout directive (adversarial-review follow-up): maxRunDurationMs default + upper bound raised 30min→2h so a multi-round run's wall-clock cap sits above a single call's 60-min harness idle ceiling.
 */

import { createChildLogger } from '@/shared/logger';
import type { SwarmVerificationRegressionTarget, SwarmVerificationResult } from './swarm-verification-service';

const logger = createChildLogger({ module: 'swarm-cycle-policy-service' });

/**
 * @description Supported escalation routes once swarm policy decides automation must stop.
 */
export type SwarmEscalationTarget = 'human_review' | 'team_lead' | 'ops_channel';

/**
 * @description Classification of the failure that triggered a retry or escalation.
 */
export type SwarmRetryClass = 'transient' | 'deterministic' | 'timeout' | 'resource';

/**
 * @description Severity level attached to escalation records for triage prioritization.
 */
export type SwarmEscalationSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * @description Optional per-request policy overrides accepted by the swarm API.
 */
export interface SwarmCyclePolicyInput {
  maxVerificationAttempts?: number;
  maxBuildRegressions?: number;
  maxDesignRegressions?: number;
  maxWritebackAttempts?: number;
  maxTotalCycles?: number;
  maxRunDurationMs?: number;
  verificationRetryDelayMs?: number;
  writebackRetryDelayMs?: number;
  escalationTarget?: SwarmEscalationTarget;
  escalationSeverity?: SwarmEscalationSeverity;
}

/**
 * @description Concrete bounded retry policy used during one swarm processing run.
 */
export interface SwarmCyclePolicy {
  maxVerificationAttempts: number;
  maxBuildRegressions: number;
  maxDesignRegressions: number;
  maxWritebackAttempts: number;
  maxTotalCycles: number;
  maxRunDurationMs: number;
  verificationRetryDelayMs: number;
  writebackRetryDelayMs: number;
  escalationTarget: SwarmEscalationTarget;
  escalationSeverity: SwarmEscalationSeverity;
}

/**
 * @description Current verification retry state tracked within one execution flow.
 */
export interface SwarmVerificationAttemptState {
  verificationAttempt: number;
  buildRegressionCount: number;
  designRegressionCount: number;
}

/**
 * @description Decision returned by policy evaluation after a failed verification.
 */
export interface SwarmVerificationPolicyDecision {
  action: 'retry_build' | 'retry_design' | 'escalate';
  regressionTarget: SwarmVerificationRegressionTarget;
  retryClass: SwarmRetryClass;
  reason: string;
  escalationTarget: SwarmEscalationTarget;
  escalationSeverity: SwarmEscalationSeverity;
}

/**
 * @description Structured escalation record emitted when policy decides automation must stop.
 */
export interface SwarmEscalationRecord {
  runId: string;
  ticketExternalId: string;
  target: SwarmEscalationTarget;
  severity: SwarmEscalationSeverity;
  retryClass: SwarmRetryClass;
  reason: string;
  attemptState: SwarmVerificationAttemptState;
  createdAt: string;
}

/**
 * @description Evaluates bounded retry, regression, and write-back retry policy for swarm runs.
 */
export class SwarmCyclePolicyService {
  /**
   * @description Resolves optional request policy overrides into one concrete run policy.
   * @param input - Optional request-scoped policy overrides
   * @returns Resolved bounded policy
   */
  resolve(input?: SwarmCyclePolicyInput): SwarmCyclePolicy {
    const policy = {
      maxVerificationAttempts: normalizeBoundedNumber(input?.maxVerificationAttempts, 3, 1, 5),
      maxBuildRegressions: normalizeBoundedNumber(input?.maxBuildRegressions, 1, 0, 3),
      maxDesignRegressions: normalizeBoundedNumber(input?.maxDesignRegressions, 1, 0, 3),
      maxWritebackAttempts: normalizeBoundedNumber(input?.maxWritebackAttempts, 2, 1, 5),
      maxTotalCycles: normalizeBoundedNumber(input?.maxTotalCycles, 15, 5, 50),
      // Idle-timeout directive 2026-07-24: ceiling raised 30min→2h so a multi-round run's
      // wall-clock cap sits above a single call's 60-min harness idle ceiling.
      maxRunDurationMs: normalizeBoundedNumber(input?.maxRunDurationMs, 7_200_000, 10_000, 7_200_000),
      verificationRetryDelayMs: normalizeBoundedNumber(input?.verificationRetryDelayMs, 0, 0, 5000),
      writebackRetryDelayMs: normalizeBoundedNumber(input?.writebackRetryDelayMs, 0, 0, 5000),
      escalationTarget: normalizeEscalationTarget(input?.escalationTarget),
      escalationSeverity: normalizeEscalationSeverity(input?.escalationSeverity),
    };

    logger.info(policy, 'Resolved swarm cycle policy');
    return policy;
  }

  /**
   * @description Chooses the next action after a failed verification result.
   * @param result - Structured verification result
   * @param state - Current verification attempt state
   * @param policy - Resolved run policy
   * @returns Retry, regression, or escalation decision
   */
  decideVerificationFailure(
    result: SwarmVerificationResult,
    state: SwarmVerificationAttemptState,
    policy: SwarmCyclePolicy,
  ): SwarmVerificationPolicyDecision {
    const regressionTarget = result.regressionTarget ?? 'build';
    const retryClass = classifyRetryFailure(result);
    const routing = deriveFailureRouting(result, retryClass, policy);
    if (hasVerificationAttemptsRemaining(state, policy) && canRetryTarget(regressionTarget, state, policy)) {
      return buildRetryDecision(regressionTarget, state, retryClass, routing, result);
    }

    return {
      action: 'escalate',
      regressionTarget,
      retryClass,
      reason: buildFailureReason(result, regressionTarget, state.verificationAttempt, true),
      escalationTarget: routing.escalationTarget,
      escalationSeverity: routing.escalationSeverity,
    };
  }

  /**
   * @description Checks whether total cycle count exceeds the per-ticket guardrail.
   * @param totalCycles - Current total cycle count including regressions
   * @param policy - Resolved run policy
   * @returns True when total cycles exceed the max-cycle guardrail
   */
  isCycleGuardrailExceeded(totalCycles: number, policy: SwarmCyclePolicy): boolean {
    return totalCycles >= policy.maxTotalCycles;
  }

  /**
   * @description Checks whether the run has exceeded its maximum allowed duration.
   * @param runStartedAt - Epoch millisecond timestamp when the run started
   * @param policy - Resolved run policy
   * @returns True when the run duration exceeds the time guardrail
   */
  isRunDurationExceeded(runStartedAt: number, policy: SwarmCyclePolicy): boolean {
    return (Date.now() - runStartedAt) >= policy.maxRunDurationMs;
  }

  /**
   * @description Builds a structured escalation record for persistence.
   * @param runId - Parent swarm run identifier
   * @param ticketExternalId - External ticket identifier
   * @param decision - Policy decision that triggered escalation
   * @param state - Verification attempt state at escalation time
   * @returns Structured escalation record
   */
  buildEscalationRecord(
    runId: string,
    ticketExternalId: string,
    decision: SwarmVerificationPolicyDecision,
    state: SwarmVerificationAttemptState,
  ): SwarmEscalationRecord {
    return {
      runId,
      ticketExternalId,
      target: decision.escalationTarget,
      severity: decision.escalationSeverity,
      retryClass: decision.retryClass,
      reason: decision.reason,
      attemptState: { ...state },
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * @description Returns whether another write-back attempt should be made.
   * @param attempt - Current write-back attempt number
   * @param policy - Resolved run policy
   * @returns True when another write-back attempt is allowed
   */
  shouldRetryWriteback(attempt: number, policy: SwarmCyclePolicy): boolean {
    return attempt < policy.maxWritebackAttempts;
  }
}

/**
 * @description Returns whether another verification attempt is still allowed.
 * @param state - Current verification attempt state
 * @param policy - Resolved run policy
 * @returns True when overall verification attempts remain
 */
function hasVerificationAttemptsRemaining(
  state: SwarmVerificationAttemptState,
  policy: SwarmCyclePolicy,
): boolean {
  return state.verificationAttempt < policy.maxVerificationAttempts;
}

/**
 * @description Returns whether the selected regression target still has remaining budget.
 * @param regressionTarget - Verification-requested regression target
 * @param state - Current verification attempt state
 * @param policy - Resolved run policy
 * @returns True when the requested regression can still run
 */
function canRetryTarget(
  regressionTarget: SwarmVerificationRegressionTarget,
  state: SwarmVerificationAttemptState,
  policy: SwarmCyclePolicy,
): boolean {
  return regressionTarget === 'design'
    ? state.designRegressionCount < policy.maxDesignRegressions
    : state.buildRegressionCount < policy.maxBuildRegressions;
}

/**
 * @description Builds a retry decision for the requested regression target.
 * @param regressionTarget - Verification-requested regression target
 * @param state - Current verification attempt state
 * @returns Retry decision
 */
function buildRetryDecision(
  regressionTarget: SwarmVerificationRegressionTarget,
  state: SwarmVerificationAttemptState,
  retryClass: SwarmRetryClass,
  routing: FailureRouting,
  result: SwarmVerificationResult,
): SwarmVerificationPolicyDecision {
  const action = regressionTarget === 'design' ? 'retry_design' : 'retry_build';
  return {
    action,
    regressionTarget,
    retryClass,
    reason: buildFailureReason(result, regressionTarget, state.verificationAttempt, false),
    escalationTarget: routing.escalationTarget,
    escalationSeverity: routing.escalationSeverity,
  };
}

/**
 * @description Classifies the failure type from a verification result for retry strategy selection.
 * @param result - Structured verification result
 * @returns Retry class classification
 */
function classifyRetryFailure(result: SwarmVerificationResult): SwarmRetryClass {
  const summary = `${result.summary} ${stringifyFindings(result.findings)}`.toLowerCase();
  if (summary.includes('timeout') || summary.includes('timed out')) {
    return 'timeout';
  }

  if (summary.includes('resource') || summary.includes('capacity') || summary.includes('quota')) {
    return 'resource';
  }

  if (summary.includes('transient') || summary.includes('temporary') || summary.includes('network')) {
    return 'transient';
  }

  return 'deterministic';
}

interface FailureRouting {
  escalationTarget: SwarmEscalationTarget;
  escalationSeverity: SwarmEscalationSeverity;
}

/**
 * @description Derives escalation routing from retry class and work-intent-specific findings.
 * @param result - Verification result driving the decision.
 * @param retryClass - Classified failure kind.
 * @param policy - Resolved default policy.
 * @returns Escalation routing metadata.
 */
function deriveFailureRouting(
  result: SwarmVerificationResult,
  retryClass: SwarmRetryClass,
  policy: SwarmCyclePolicy,
): FailureRouting {
  if (retryClass === 'timeout' || retryClass === 'resource') {
    return { escalationTarget: 'ops_channel', escalationSeverity: 'high' };
  }

  const evidenceClass = detectMissingEvidenceClass(result.findings);
  if (evidenceClass === 'review' || evidenceClass === 'analysis') {
    return { escalationTarget: 'team_lead', escalationSeverity: 'high' };
  }
  if (evidenceClass === 'documentation') {
    return { escalationTarget: policy.escalationTarget, escalationSeverity: 'low' };
  }

  return {
    escalationTarget: policy.escalationTarget,
    escalationSeverity: policy.escalationSeverity,
  };
}

/**
 * @description Builds a human-readable reason that reflects the missing evidence class when known.
 * @param result - Verification result that triggered the decision.
 * @param regressionTarget - Regression target being requested.
 * @param attempt - Current verification attempt.
 * @param exhausted - True when policy budget is exhausted and escalation is occurring.
 * @returns Decision reason string.
 */
function buildFailureReason(
  result: SwarmVerificationResult,
  regressionTarget: SwarmVerificationRegressionTarget,
  attempt: number,
  exhausted: boolean,
): string {
  const evidenceClass = detectMissingEvidenceClass(result.findings);
  if (!evidenceClass) {
    return exhausted
      ? `Verification exhausted policy budget after attempt ${attempt}.`
      : `Verification requested ${regressionTarget} regression after attempt ${attempt}.`;
  }

  const action = exhausted ? 'exhausted policy budget' : `requested ${regressionTarget} regression`;
  return `Verification ${action} after attempt ${attempt} because ${evidenceClass} evidence is missing.`;
}

/**
 * @description Detects the first missing-evidence work-intent class from verification findings.
 * @param findings - Structured verification findings.
 * @returns Work-intent class when the verifier found missing evidence, otherwise null.
 */
function detectMissingEvidenceClass(findings: string[]): string | null {
  const match = findings
    .map((finding) => normalizeFindingText(finding))
    .find((finding) => finding.startsWith('missing-') && finding.includes('-evidence:'));
  if (!match) {
    return null;
  }

  return match.slice('missing-'.length, match.indexOf('-evidence:'));
}

/**
 * @description Normalizes findings into one comparable text blob for policy heuristics.
 * @param findings - Verification findings of mixed shapes.
 * @returns Concatenated normalized finding text.
 */
function stringifyFindings(findings: unknown[]): string {
  return findings.map((finding) => normalizeFindingText(finding)).join(' ');
}

/**
 * @description Converts one verification finding into comparable text without assuming a specific shape.
 * @param finding - Verification finding from tests or runtime.
 * @returns Normalized text form.
 */
function normalizeFindingText(finding: unknown): string {
  if (typeof finding === 'string') {
    return finding;
  }
  if (!finding || typeof finding !== 'object') {
    return String(finding ?? '');
  }
  if ('description' in finding && typeof finding.description === 'string') {
    return finding.description;
  }
  if ('type' in finding && typeof finding.type === 'string') {
    return finding.type;
  }
  return String(finding);
}

const VALID_ESCALATION_TARGETS: SwarmEscalationTarget[] = ['human_review', 'team_lead', 'ops_channel'];

/**
 * @description Normalises an optional escalation target string to a valid enum value.
 * @param value - Optional input string
 * @returns Valid escalation target or default
 */
function normalizeEscalationTarget(value?: SwarmEscalationTarget): SwarmEscalationTarget {
  if (value && VALID_ESCALATION_TARGETS.includes(value)) {
    return value;
  }

  return 'human_review';
}

const VALID_ESCALATION_SEVERITIES: SwarmEscalationSeverity[] = ['low', 'medium', 'high', 'critical'];

/**
 * @description Normalises an optional escalation severity string to a valid enum value.
 * @param value - Optional input string
 * @returns Valid escalation severity or default
 */
function normalizeEscalationSeverity(value?: SwarmEscalationSeverity): SwarmEscalationSeverity {
  if (value && VALID_ESCALATION_SEVERITIES.includes(value)) {
    return value;
  }

  return 'medium';
}

/**
 * @description Clamps an optional numeric override to the configured bounds.
 * @param value - Optional override value
 * @param fallback - Default value when override is absent or invalid
 * @param min - Minimum accepted value
 * @param max - Maximum accepted value
 * @returns Safe bounded number
 */
function normalizeBoundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}

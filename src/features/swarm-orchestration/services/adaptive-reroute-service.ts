/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | IMP-1: Adaptive reroute service — scored alternative selection with structured decision explanation
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentEligibilitySnapshot } from '@/features/agent-management';
import {
  classifyRoutingFailure,
  isReroutable,
  type ClassifiedRoutingFailure,
  type RoutingFailureType,
} from './routing-failure-classifier-service';

const logger = createChildLogger({ module: 'adaptive-reroute-service' });

/**
 * @description Structured routing decision with full explanation for auditability.
 */
export interface RoutingDecisionExplanation {
  requestedAgentId: string | null;
  requestedRole: string | null;
  decision: 'routed' | 'rerouted' | 'escalated';
  failureType: RoutingFailureType | null;
  failureDetails: string;
  chosenAgentId: string | null;
  chosenAgentName: string | null;
  rationale: string[];
  consideredCandidates: CandidateEvaluation[];
  nextAction: string;
  createdAt: string;
}

/**
 * @description Per-candidate evaluation included in the decision explanation.
 */
export interface CandidateEvaluation {
  agentId: string;
  agentName: string;
  eligible: boolean;
  score: number;
  rejectionReasons: string[];
}

/**
 * @description Input for an adaptive reroute attempt.
 */
export interface RerouteAttemptInput {
  requestedAgentId?: string;
  requestedRole?: string;
  error: unknown;
  phase?: number;
  ticketId: string;
  eligibleCandidates: AgentEligibilitySnapshot[];
  allCandidates: AgentEligibilitySnapshot[];
}

/**
 * @description Attempts to find an alternative route when the preferred route fails.
 * Returns a structured decision explanation regardless of outcome.
 * @param input - Reroute context with failure, candidates, and eligibility snapshots
 * @returns Decision explanation with chosen agent or escalation rationale
 */
export function attemptAdaptiveReroute(input: RerouteAttemptInput): RoutingDecisionExplanation {
  const failure = classifyRoutingFailure(input.error, {
    agentId: input.requestedAgentId,
    phase: input.phase,
    candidateCount: input.allCandidates.length,
  });

  const considered: CandidateEvaluation[] = input.allCandidates.map((c) => ({
    agentId: c.agentId,
    agentName: c.agentName,
    eligible: c.eligible,
    score: c.score,
    rejectionReasons: c.rejectionReasons,
  }));

  const rationale: string[] = [];
  rationale.push(`Primary route failed: ${failure.type} — ${failure.message}`);

  if (!isReroutable(failure)) {
    rationale.push(`Failure type "${failure.type}" is not reroutable`);
    rationale.push(`Suggested action: ${failure.suggestedAction}`);

    logger.warn(
      { ticketId: input.ticketId, failureType: failure.type, requestedAgent: input.requestedAgentId },
      'Non-reroutable failure — escalating to human',
    );

    return buildDecision('escalated', input, failure, null, rationale, considered,
      'Escalated to operator — failure is not recoverable by rerouting');
  }

  const eligible = input.eligibleCandidates
    .filter((c) => c.agentId !== input.requestedAgentId)
    .sort((a, b) => b.score - a.score);

  if (eligible.length === 0) {
    rationale.push('No eligible alternative agents available after filtering');
    rationale.push(`${input.allCandidates.length} total candidates evaluated, 0 eligible after exclusions`);

    logger.warn(
      { ticketId: input.ticketId, failureType: failure.type, totalCandidates: input.allCandidates.length },
      'No eligible alternatives — escalating to human',
    );

    return buildDecision('escalated', input, failure, null, rationale, considered,
      'Escalated to operator — no eligible alternative agents');
  }

  const chosen = eligible[0];
  rationale.push(`Selected alternative: ${chosen.agentName} (${chosen.agentId}) with score ${chosen.score.toFixed(2)}`);
  rationale.push(`${eligible.length} eligible alternatives evaluated`);

  if (eligible.length > 1) {
    rationale.push(`Runner-up: ${eligible[1].agentName} (score ${eligible[1].score.toFixed(2)})`);
  }

  logger.info(
    {
      ticketId: input.ticketId,
      failureType: failure.type,
      requestedAgent: input.requestedAgentId,
      chosenAgent: chosen.agentId,
      chosenScore: chosen.score,
      alternativeCount: eligible.length,
    },
    'Adaptive reroute succeeded — alternative agent selected',
  );

  return buildDecision('rerouted', input, failure, chosen, rationale, considered,
    `Rerouted to ${chosen.agentName} — original route failed with ${failure.type}`);
}

/**
 * @description Builds a successful routing decision (no failure).
 * @param agentId - Selected agent
 * @param agentName - Selected agent name
 * @param role - Requested role
 * @param ticketId - Ticket ID
 * @returns Decision explanation for a clean route
 */
export function buildSuccessfulRouteDecision(
  agentId: string, agentName: string, role: string | null, ticketId: string,
): RoutingDecisionExplanation {
  return {
    requestedAgentId: agentId,
    requestedRole: role,
    decision: 'routed',
    failureType: null,
    failureDetails: '',
    chosenAgentId: agentId,
    chosenAgentName: agentName,
    rationale: [`Direct route to ${agentName} succeeded`],
    consideredCandidates: [],
    nextAction: `Agent ${agentName} is processing the ticket`,
    createdAt: new Date().toISOString(),
  };
}

function buildDecision(
  decision: 'routed' | 'rerouted' | 'escalated',
  input: RerouteAttemptInput,
  failure: ClassifiedRoutingFailure,
  chosen: AgentEligibilitySnapshot | null,
  rationale: string[],
  considered: CandidateEvaluation[],
  nextAction: string,
): RoutingDecisionExplanation {
  return {
    requestedAgentId: input.requestedAgentId ?? null,
    requestedRole: input.requestedRole ?? null,
    decision,
    failureType: failure.type,
    failureDetails: failure.message,
    chosenAgentId: chosen?.agentId ?? null,
    chosenAgentName: chosen?.agentName ?? null,
    rationale,
    consideredCandidates: considered,
    nextAction,
    createdAt: new Date().toISOString(),
  };
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted swarm ticket processing support helpers to enforce the project file-size cap
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added shared swarm escalation error and retry sleep helper
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Made normalizeCandidates async with optional AgentProfileRepository for DB-sourced agent candidates
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added seeded routing metadata and factory-bot guardrails so generic tickets stop selecting agent-factory by default
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added runtime online-agent filtering and direct-channel execution envelopes for targeted swarm delivery
 */

import {
  MESH_CHANNELS,
  type AgentBid,
  type MeshEnvelope,
  type MeshTransport,
  type MeshSubscription,
  type ConsumedEnvelope,
  type RouteCandidate,
} from '@/features/agent-management';
import type { AgentProfileRepository } from '@/entities/agent';
import { createChildLogger } from '@/shared/logger';
import type { SwarmEscalationTarget } from './swarm-cycle-policy';
import type { SwarmExecutionPolicyOutcome } from './swarm-execution-policy-runner';
import type { DecomposedWorkUnit } from './ticket-decomposition-service';

const logger = createChildLogger({ module: 'swarm-ticket-processing-support' });

/**
 * @description In-memory mesh transport used to simulate inter-agent dispatch during local orchestration runs.
 */
export class InMemoryMeshTransport implements MeshTransport {
  async publish(envelope: MeshEnvelope): Promise<void> {
    logger.info(
      {
        correlationId: envelope.correlationId,
        fromAgentId: envelope.fromAgentId,
        toAgentId: envelope.toAgentId,
        channel: envelope.channel,
      },
      'Published mesh envelope via in-memory transport',
    );
  }

  async consume(): Promise<ConsumedEnvelope[]> {
    return [];
  }

  async ack(): Promise<void> {}

  subscribe(
    _channel: string,
    _consumerId: string,
    _handler: (envelope: MeshEnvelope, entryId: string) => Promise<void>,
  ): MeshSubscription {
    return { stop: () => {} };
  }
}

/** @description Async resolver returning canonical IDs for currently online swarm agents. */
export type SwarmOnlineAgentIdsResolver = () => Promise<string[]>;

/**
 * @description Normalizes route candidates from optional explicit candidates, bids, or the agents table.
 * @param candidates - Optional static candidate list
 * @param bids - Optional bid list that can seed candidate defaults
 * @param title - Ticket title for reason text generation
 * @param agentProfileRepository - Optional repository to query persisted agent definitions
 * @param resolveOnlineAgentIds - Optional runtime availability resolver for filtering to live workers
 * @returns Ranked candidate baseline for router input
 */
export async function normalizeCandidates(
  candidates: RouteCandidate[] | undefined,
  bids: AgentBid[] | undefined,
  title: string,
  agentProfileRepository?: AgentProfileRepository,
  resolveOnlineAgentIds?: SwarmOnlineAgentIdsResolver,
): Promise<RouteCandidate[]> {
  if (candidates && candidates.length > 0) {
    return filterCandidatesByRuntimeAvailability(candidates, resolveOnlineAgentIds, title);
  }

  if (bids && bids.length > 0) {
    return filterCandidatesByRuntimeAvailability(bids.map((bid) => ({
      agentId: bid.agentId,
      score: bid.confidence,
      reason: `Bid-derived candidate for ticket: ${title}`,
    })), resolveOnlineAgentIds, title);
  }

  if (agentProfileRepository) {
    try {
      const agents = await agentProfileRepository.listAgents();
      const active = agents.filter((a) => a.status === 'active');
      if (active.length > 0) {
        const agentCreationTask = isAgentCreationTask(title);
        return filterCandidatesByRuntimeAvailability(active.map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          score: resolveCandidateBaseScore(agent.name),
          reason: `DB-sourced agent "${agent.name}" for ticket: ${title}`,
          capabilities: agent.baseCapabilities ?? [],
          routingKeywords: agent.routingKeywords ?? [],
          selectorDescriptor: agent.selectorDescriptor ?? '',
        })).filter((candidate) => (
          agentCreationTask || candidate.agentId !== 'a0000000-0000-0000-0000-000000000007'
        )), resolveOnlineAgentIds, title);
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to query agents table for candidates; falling back to defaults');
    }
  }

  return filterCandidatesByRuntimeAvailability([
    {
      agentId: 'project-manager',
      score: 0.9,
      reason: `Default coordinator for ticket: ${title}`,
    },
    {
      agentId: 'developer',
      score: 0.7,
      reason: `Default implementer candidate for ticket: ${title}`,
    },
  ], resolveOnlineAgentIds, title);
}

/**
 * @description Detects whether the current ticket is actually asking to create or provision an agent.
 * @param title - Ticket title.
 * @returns True when agent-factory should stay eligible.
 */
function isAgentCreationTask(title: string): boolean {
  const normalized = title.toLowerCase();
  return [
    'agent',
    'bot',
    'persona',
    'factory',
    'provision',
    'create-agent',
    'new-agent',
    'specialist',
  ].some((keyword) => normalized.includes(keyword));
}

/**
 * @description Provides stable fallback ranking so ambiguous tickets prefer orchestrators or builders over specialist outliers.
 * @param agentName - Persisted agent name.
 * @returns Baseline routing score before competency boosts.
 */
function resolveCandidateBaseScore(agentName: string): number {
  switch (agentName) {
    case 'project-manager':
      return 0.95;
    case 'code-developer':
      return 0.9;
    case 'documentation-writer':
      return 0.8;
    case 'test-engineer':
      return 0.78;
    case 'code-reviewer':
      return 0.72;
    case 'task-manager':
      return 0.58;
    case 'agent-factory':
      return 0.2;
    default:
      return 0.68;
  }
}

/**
 * @description Builds a mesh execution envelope for the selected agent.
 * @param runId - Parent run identifier
 * @param toAgentId - Selected agent identifier
 * @param externalId - Provider ticket identifier
 * @param workUnits - Decomposed work units for execution
 * @returns Mesh envelope payload
 */
export function buildExecutionEnvelope(
  runId: string,
  toAgentId: string,
  externalId: string,
  workUnits: DecomposedWorkUnit[],
  workspaceTaskId?: string,
): MeshEnvelope {
  return {
    correlationId: `${runId}:${externalId}`,
    fromAgentId: 'swarm-controller',
    toAgentId,
    channel: MESH_CHANNELS.agentDirect(toAgentId),
    payload: {
      externalId,
      workUnits,
      workspaceTaskId,
    },
  };
}

async function filterCandidatesByRuntimeAvailability(
  candidates: RouteCandidate[],
  resolveOnlineAgentIds: SwarmOnlineAgentIdsResolver | undefined,
  title: string,
): Promise<RouteCandidate[]> {
  if (!resolveOnlineAgentIds || candidates.length === 0) {
    return candidates;
  }

  const onlineAgentIds = await resolveOnlineAgentIds();
  if (onlineAgentIds.length === 0) {
    logger.warn({ title }, 'Runtime registry reported no online agents; preserving unfiltered candidates');
    return candidates;
  }

  const onlineAgentIdSet = new Set(onlineAgentIds);
  const filteredCandidates = candidates.filter((candidate) => onlineAgentIdSet.has(candidate.agentId));
  if (filteredCandidates.length === 0) {
    throw new Error(`No online swarm agents matched the routing candidates for ticket "${title}"`);
  }

  logger.info(
    { title, candidateCount: candidates.length, onlineCandidateCount: filteredCandidates.length },
    'Filtered routing candidates to online swarm agents',
  );
  return filteredCandidates;
}

/**
 * @description Builds verification details from the final execution policy outcome.
 * @param outcome - Final execution policy outcome
 * @returns Verification summary payload
 */
export function buildVerificationSummary(outcome: SwarmExecutionPolicyOutcome): Record<string, unknown> {
  return {
    passed: true,
    selectedAgentId: outcome.routing.winner.agentId,
    verificationSummary: outcome.verification.summary,
    executionAttempts: outcome.executionAttempts,
    buildRegressionCount: outcome.buildRegressionCount,
    designRegressionCount: outcome.designRegressionCount,
    policyDecisions: outcome.policyDecisions,
    verificationChecks: [
      'work-unit-count-greater-than-zero',
      'agent-selection-completed',
      'mesh-dispatch-recorded',
      'bounded-verification-policy-passed',
    ],
  };
}

/**
 * @description Builds a readable verification failure message for escalated verify cycles.
 * @param outcome - Final execution policy outcome
 * @returns Failure message
 */
export function buildVerificationFailureMessage(outcome: SwarmExecutionPolicyOutcome): string {
  return [
    outcome.verification.summary,
    outcome.escalation ? `escalation:${outcome.escalation.target}` : '',
    ...outcome.verification.findings.map((finding) => `finding:${finding}`),
    ...outcome.policyDecisions.map((decision) => `policy:${decision}`),
  ].filter((part) => part.length > 0).join(' | ');
}

/**
 * @description Error used to preserve explicit escalation metadata across swarm verification failure paths.
 */
export class SwarmEscalationError extends Error {
  /**
   * @description Creates an escalation error with routing metadata for write-back and logging.
   * @param target - Explicit escalation target
   * @param reason - Human-readable escalation reason
   * @param message - Error message
   */
  constructor(
    readonly target: SwarmEscalationTarget,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SwarmEscalationError';
  }
}

/**
 * @description Sleeps for a bounded retry delay when policy backoff is configured.
 * @param durationMs - Delay in milliseconds
 * @returns Promise resolved once the delay elapses
 */
export async function sleep(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

/**
 * @description Normalizes unknown throwables to Error instances.
 * @param error - Unknown throwable
 * @returns Normalized Error instance
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === 'string' ? error : 'Unknown swarm processing error');
}

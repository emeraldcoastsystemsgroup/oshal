/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | IMP-1: Routing failure classifier — reusable taxonomy for routing, escalation, and operator guidance
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'routing-failure-classifier' });

/**
 * @description Canonical routing failure types used across routing, escalation, and cockpit surfaces.
 */
export type RoutingFailureType =
  | 'bot_unavailable'
  | 'runtime_channel_dead'
  | 'timeout'
  | 'capacity_exhausted'
  | 'missing_required_capability'
  | 'missing_required_tool_or_config'
  | 'policy_rejected'
  | 'identity_mismatch'
  | 'no_online_candidates'
  | 'all_candidates_rejected'
  | 'malformed_task_context'
  | 'unknown';

/**
 * @description Classified routing failure with evidence and recovery hints.
 */
export interface ClassifiedRoutingFailure {
  type: RoutingFailureType;
  message: string;
  reroutable: boolean;
  evidence: string[];
  suggestedAction: string;
}

/**
 * @description Classifies a routing or dispatch error into a structured failure with recovery hints.
 * @param error - The caught error or failure signal
 * @param context - Optional context about the routing attempt
 * @returns Classified failure with type, evidence, and suggested action
 */
export function classifyRoutingFailure(
  error: unknown,
  context?: { agentId?: string; phase?: number; candidateCount?: number },
): ClassifiedRoutingFailure {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  const lower = msg.toLowerCase();
  const evidence: string[] = [];

  if (context?.agentId) evidence.push(`target_agent=${context.agentId}`);
  if (context?.phase) evidence.push(`phase=${context.phase}`);
  if (context?.candidateCount !== undefined) evidence.push(`candidates=${context.candidateCount}`);

  if (lower.includes('no online swarm agents') || lower.includes('no online candidates')) {
    return {
      type: 'no_online_candidates',
      message: 'No online agents matched the routing candidates',
      reroutable: false,
      evidence: [...evidence, `error=${msg}`],
      suggestedAction: 'Check that bot containers are running and publishing heartbeats',
    };
  }

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline')) {
    return {
      type: 'timeout',
      message: `Agent dispatch timed out: ${msg}`,
      reroutable: true,
      evidence: [...evidence, `error=${msg}`],
      suggestedAction: 'Retry with a different agent or increase dispatch timeout',
    };
  }

  if (lower.includes('channel') && (lower.includes('dead') || lower.includes('no consumer'))) {
    return {
      type: 'runtime_channel_dead',
      message: `Target agent channel is dead or has no consumers: ${msg}`,
      reroutable: true,
      evidence: [...evidence, `error=${msg}`],
      suggestedAction: 'Route to an alternative agent with a live channel',
    };
  }

  if (lower.includes('not authenticated') || lower.includes('api key') || lower.includes('credential')) {
    return {
      type: 'missing_required_tool_or_config',
      message: `Agent missing required credentials: ${msg}`,
      reroutable: true,
      evidence: [...evidence, `error=${msg}`],
      suggestedAction: 'Route to an agent with valid provider credentials',
    };
  }

  if (lower.includes('capability') || lower.includes('not capable')) {
    return {
      type: 'missing_required_capability',
      message: `Agent lacks required capability: ${msg}`,
      reroutable: true,
      evidence: [...evidence, `error=${msg}`],
      suggestedAction: 'Route to an agent with matching capabilities',
    };
  }

  if (lower.includes('identity') || lower.includes('mismatch') || lower.includes('uuid')) {
    return {
      type: 'identity_mismatch',
      message: `Agent identity mismatch: ${msg}`,
      reroutable: true,
      evidence: [...evidence, `error=${msg}`],
      suggestedAction: 'Verify agent registry identity and retry',
    };
  }

  if (lower.includes('policy') || lower.includes('rejected') || lower.includes('excluded')) {
    return {
      type: 'policy_rejected',
      message: `Routing policy rejected this assignment: ${msg}`,
      reroutable: true,
      evidence: [...evidence, `error=${msg}`],
      suggestedAction: 'Review phase exclusion rules and retry with eligible agents',
    };
  }

  if (lower.includes('malformed') || lower.includes('parse') || lower.includes('decomposition')) {
    return {
      type: 'malformed_task_context',
      message: `Task context is malformed: ${msg}`,
      reroutable: false,
      evidence: [...evidence, `error=${msg}`],
      suggestedAction: 'Review ticket description and PM decomposition output',
    };
  }

  logger.warn({ error: msg, context }, 'Could not classify routing failure — returning unknown');
  return {
    type: 'unknown',
    message: msg || 'Unknown routing failure',
    reroutable: false,
    evidence: [...evidence, `error=${msg}`],
    suggestedAction: 'Inspect agent logs and retry manually',
  };
}

/**
 * @description Checks whether a classified failure is safe to attempt rerouting.
 * @param failure - Classified routing failure
 * @returns True if the system should try an alternative agent
 */
export function isReroutable(failure: ClassifiedRoutingFailure): boolean {
  return failure.reroutable;
}

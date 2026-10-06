/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081 privileged lane (general fix): the swarm (build) pipeline never selects or sends work to a privileged worker. The oshal-developer works in a push-capable clone of the platform for any unit it receives, so it is reached only through its own 'oshal-dev' workflow, which names it directly and whose owner the queue checks. Routing drops it from every candidate set (withoutPrivilegedWorkers), a PM assignment naming it is dropped so routing chooses (routablePmAssignment), and the unsigned mesh hop refuses it as the signed hop refuses any target off BUILD_EXECUTION_TARGETS (privilegedWorkerDispatchRefusal).
 */

import { createChildLogger } from '@/shared/logger';
import { isPrivilegedWorkerAgent } from '@/shared/middleware/superadmin';

const logger = createChildLogger({ module: 'swarm-privileged-worker-gate' });

/**
 * @description ADR-081: routing never chooses a privileged worker. The developer bot is reached only through its own
 * 'oshal-dev' workflow, which names it directly, so it is removed from every candidate set routing picks from: swarm
 * phase routing (whose PM-assignment step only matches a candidate), multi-round reviewers, specialist input and the
 * task call-out.
 * @param candidates - Routing candidates from any source.
 * @returns The candidates without privileged workers, in their original order.
 */
export function withoutPrivilegedWorkers<T extends { agentId: string }>(candidates: T[]): T[] {
  const kept = candidates.filter((candidate) => !isPrivilegedWorkerAgent(candidate.agentId));
  if (kept.length < candidates.length) {
    // Debug, not info: with the developer bot installed this runs on every routing decision.
    const removed = candidates.filter((candidate) => isPrivilegedWorkerAgent(candidate.agentId)).map((c) => c.agentId);
    logger.debug({ removed }, 'Privileged workers removed from routing candidates (ADR-081)');
  }
  return kept;
}

/**
 * @description ADR-081: a PM assignment never names a privileged worker for routing. Phase-4 routing takes the
 * assignment first, so one naming the developer bot is dropped (the role hint stays) and routing makes its own choice.
 * @param ticketId - The ticket being routed (for the log).
 * @param agentId - The PM-assigned agent, from the ticket's metadata or the planner's assignments.
 * @returns The agent id, or undefined when it names a privileged worker.
 */
export function routablePmAssignment(ticketId: string, agentId: string | undefined): string | undefined {
  if (!isPrivilegedWorkerAgent(agentId)) return agentId;
  logger.warn({ ticketId, agentId }, 'PM assignment names a privileged worker - dropped; routing chooses the agent (ADR-081)');
  return undefined;
}

/**
 * @description ADR-081: the unsigned mesh hop refuses a privileged worker the way the signed hop refuses any target
 * off BUILD_EXECUTION_TARGETS: a failure record the execution policy treats as a failed attempt, and nothing sent.
 * Routing never chooses one (withoutPrivilegedWorkers), so this is the last line, not the first.
 * @param ticketId - The ticket or unit being dispatched (for the log).
 * @param agentId - The dispatch target.
 * @returns The failure record, or null when the target is not privileged.
 */
export function privilegedWorkerDispatchRefusal(ticketId: string, agentId: string): { status: 'failed'; error: string } | null {
  if (!isPrivilegedWorkerAgent(agentId)) return null;
  logger.warn({ ticketId, agentId }, 'Build execution target is a privileged worker - refused before anything is sent');
  return { status: 'failed', error: `privileged_worker_not_dispatchable: ${agentId} is a privileged worker; the build lane never sends it work` };
}

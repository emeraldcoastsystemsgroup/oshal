/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Centralized legal GitHub close and reopen projections for webhook and REST reconciliation
 */

import type { OshalTicketState } from '@/entities/ticket';

const COMPLETE_FROM = new Set<OshalTicketState>([
  'approved',
  'in_process',
  'in_process_discovery',
  'in_process_design',
  'in_process_build',
  'in_process_deploy',
  'in_process_test',
  'in_process_release',
  'customer_action',
  'escalated',
]);

const BACKLOG_FROM = new Set<OshalTicketState>([
  'approved',
  'in_process',
  'complete',
  'escalated',
  'dead_letter',
  'paused',
  'cancelled',
]);

const CANCELLED_FROM = new Set<OshalTicketState>([
  'backlog',
  'approved',
  'in_process',
  'in_process_discovery',
  'in_process_design',
  'in_process_build',
  'in_process_deploy',
  'in_process_test',
  'in_process_release',
  'approval_required',
  'customer_action',
  'escalated',
  'dead_letter',
  'paused',
]);

/**
 * @description Provider lifecycle snapshot used to converge one GitHub issue.
 */
export interface GitHubTicketLifecycleSnapshot {
  state: 'open' | 'closed';
  stateReason?: string | null;
  action?: string | null;
}

/**
 * @description Resolves a legal internal transition for a GitHub close or reopen signal.
 * Webhooks supply an action; REST reconciliation infers reopen only from a persisted closed snapshot.
 * @param currentStatus - Current canonical internal ticket status
 * @param snapshot - Current GitHub issue lifecycle snapshot
 * @param previousProviderState - Previously persisted GitHub issue state for REST convergence
 * @returns Legal target status, or null when no transition should be applied
 */
export function resolveGitHubTicketLifecycleTarget(
  currentStatus: OshalTicketState,
  snapshot: GitHubTicketLifecycleSnapshot,
  previousProviderState?: 'open' | 'closed' | null,
): OshalTicketState | null {
  const action = snapshot.action?.trim().toLowerCase() || null;
  const isCloseSignal = action === null
    ? snapshot.state === 'closed'
    : action === 'closed';
  const isReopenSignal = action === null
    ? snapshot.state === 'open' && previousProviderState === 'closed'
    : action === 'reopened';

  if (isCloseSignal) {
    const stateReason = snapshot.stateReason?.trim().toLowerCase();
    if (stateReason && stateReason !== 'completed' && CANCELLED_FROM.has(currentStatus)) {
      return 'cancelled';
    }
    if (COMPLETE_FROM.has(currentStatus)) {
      return 'complete';
    }
    if (CANCELLED_FROM.has(currentStatus)) {
      return 'cancelled';
    }
    return null;
  }

  if (isReopenSignal && BACKLOG_FROM.has(currentStatus)) {
    return 'backlog';
  }
  return null;
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | IMP-2: Execution artifact scope contract — isolates context files and handovers per child/review ticket in shared workspaces
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'execution-artifact-scope-service' });

/**
 * @description Defines the artifact scope for an execution run within a shared workspace.
 * Ensures sibling child tickets and review rounds do not share context files or handovers.
 */
export interface ExecutionArtifactScope {
  workspaceTaskId: string;
  externalId: string;
  scopeId: string;
  scopeType: 'child-ticket' | 'review-ticket' | 'parent-ticket';
}

/**
 * @description Derives an execution artifact scope from the available ticket identifiers.
 * @param workspaceTaskId - Shared workspace folder ID (parent ticket ID)
 * @param externalId - Current ticket's external identifier
 * @param parentExternalId - Parent ticket's external ID (if this is a child ticket)
 * @param reviewRound - Review round number (if this is a review run)
 * @returns Scope contract for artifact path isolation
 */
export function deriveExecutionScope(
  workspaceTaskId: string,
  externalId: string,
  parentExternalId?: string | null,
  reviewRound?: number | null,
): ExecutionArtifactScope {
  if (reviewRound && reviewRound > 0) {
    const scopeId = sanitizeScopeId(`review-${externalId}-r${reviewRound}`);
    logger.info({ workspaceTaskId, externalId, scopeId, scopeType: 'review-ticket' }, 'Derived review-ticket scope');
    return { workspaceTaskId, externalId, scopeId, scopeType: 'review-ticket' };
  }

  if (parentExternalId && parentExternalId !== externalId) {
    const scopeId = sanitizeScopeId(externalId);
    logger.info({ workspaceTaskId, externalId, scopeId, scopeType: 'child-ticket' }, 'Derived child-ticket scope');
    return { workspaceTaskId, externalId, scopeId, scopeType: 'child-ticket' };
  }

  logger.info({ workspaceTaskId, externalId, scopeType: 'parent-ticket' }, 'Derived parent-ticket scope (unscoped)');
  return { workspaceTaskId, externalId, scopeId: '', scopeType: 'parent-ticket' };
}

/**
 * @description Resolves the context file name for a given scope and agent.
 * For parent tickets: `{agentId}-context.md` (backwards compatible)
 * For child/review tickets: `{scopeId}--{agentId}-context.md`
 * @param scope - Execution artifact scope
 * @param agentId - Agent identifier
 * @returns Context file name safe for filesystem use
 */
export function resolveScopedContextFileName(scope: ExecutionArtifactScope, agentId: string): string {
  if (scope.scopeType === 'parent-ticket' || !scope.scopeId) {
    return `${agentId}-context.md`;
  }
  return `${scope.scopeId}--${agentId}-context.md`;
}

/**
 * @description Resolves the handover file name for a given scope, agent, phase, and round.
 * For parent tickets: `{agentId}_PHASE_{n}_ROUND_{n}.md` (backwards compatible)
 * For child/review tickets: `{scopeId}--{agentId}_PHASE_{n}_ROUND_{n}.md`
 * @param scope - Execution artifact scope
 * @param agentId - Agent identifier
 * @param phase - Phase number
 * @param round - Round number
 * @returns Handover file name safe for filesystem use
 */
export function resolveScopedHandoverFileName(
  scope: ExecutionArtifactScope,
  agentId: string,
  phase: number,
  round: number,
): string {
  if (scope.scopeType === 'parent-ticket' || !scope.scopeId) {
    return `${agentId}_PHASE_${phase}_ROUND_${round}.md`;
  }
  return `${scope.scopeId}--${agentId}_PHASE_${phase}_ROUND_${round}.md`;
}

/**
 * @description Builds a handover filename prefix filter for reading scoped handovers.
 * Returns the prefix that scoped handover files should start with.
 * For parent tickets: empty string (read all handovers)
 * For child/review tickets: `{scopeId}--`
 * @param scope - Execution artifact scope
 * @returns Filename prefix filter
 */
export function resolveScopedHandoverPrefix(scope: ExecutionArtifactScope): string {
  if (scope.scopeType === 'parent-ticket' || !scope.scopeId) {
    return '';
  }
  return `${scope.scopeId}--`;
}

/**
 * @description Sanitizes a scope identifier for safe filesystem use.
 * Replaces colons and slashes with dashes, removes unsafe characters.
 * @param raw - Raw scope identifier (e.g., externalId or review ID)
 * @returns Filesystem-safe scope identifier
 */
/**
 * @description Derives a lightweight scope ID string from execution context.
 * Used by the llm-execution-handler to pass scope info through to the provider.
 * @param externalId - Current ticket external ID
 * @param parentOrWorkspaceId - Parent external ID or workspace task ID
 * @param reviewRound - Review round number (if this is a review run)
 * @returns Scope ID string, or empty string for parent/root tickets
 */
export function deriveExecutionScopeId(
  externalId: string,
  parentOrWorkspaceId: string | undefined,
  reviewRound?: number,
): string {
  if (reviewRound && reviewRound > 0) {
    return sanitizeScopeId(`review-${externalId}-r${reviewRound}`);
  }
  if (parentOrWorkspaceId && parentOrWorkspaceId !== externalId && externalId) {
    return sanitizeScopeId(externalId);
  }
  return '';
}

function sanitizeScopeId(raw: string): string {
  return raw
    .replace(/[:/\\]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(0, 128);
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-user task storage layout (ADR-060). Pure, unit-testable helpers that build a task's workspace path under its owner's namespace so a bot's files are written into the owning user's directory, not a shared flat root.
 */

import path from 'path';

/**
 * @description Sanitize an identifier (OIDC sub, task id) into a single safe
 * filesystem path segment. Mirrors ToolExecutorService.normalizeWorkspaceId.
 */
export function normalizeWorkspaceSegment(id: string): string {
  return id.trim().replaceAll(/[^a-zA-Z0-9-_]/g, '_');
}

/**
 * @description Build the per-user task workspace path (ADR-060):
 *   <root>/users/<ownerSub>/<taskId>   when the task has a resolvable owner
 *   <root>/_shared/<taskId>            when it does not (system/swarm tasks)
 * The owner segment is sanitized, so it is always a single, traversal-safe segment.
 */
export function userScopedWorkspacePath(
  root: string,
  ownerSub: string | null | undefined,
  taskId: string,
): string {
  const task = normalizeWorkspaceSegment(taskId);
  if (ownerSub && ownerSub.trim().length > 0) {
    return path.join(root, 'users', normalizeWorkspaceSegment(ownerSub), task);
  }
  return path.join(root, '_shared', task);
}

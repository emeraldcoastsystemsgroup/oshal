/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added shared logger factory for GitLab origin push helper modules
 */

import { createChildLogger } from '../../src/shared/logger';

/**
 * @description Creates a child logger scoped to the GitLab origin push helper.
 *
 * @param bindings - Additional logger bindings for component-specific context
 * @returns Child logger configured with shared GitLab origin push module context
 */
export function createGitLabOriginPushLogger(
  bindings: Record<string, unknown> = {},
) {
  return createChildLogger({ module: 'scripts/gitlab-origin-push', ...bindings });
}
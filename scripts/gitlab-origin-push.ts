/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of GitLab origin discovery and push helper script
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed helper into modular services to satisfy file size constraints
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Updated entrypoint messaging for provider-agnostic repository sync workflow
 */

import type { CliOptions, RunSummary } from './gitlab-origin-push-core';
import {
  createGitLabOriginPushLogger,
  GitLabOriginPushCliOptions,
  GitLabOriginPushService,
} from './gitlab-origin-push-core';

const logger = createGitLabOriginPushLogger({ component: 'GitLabOriginPushCliEntrypoint' });

/**
 * @description Convenience wrapper for running the provider-agnostic repository
 * sync workflow from application code.
 *
 * @param options - Partial runtime options for root path, depth, branch, and push behavior
 * @returns Summary of repository discovery and push actions
 */
export async function runGitLabOriginPush(
  options: Partial<CliOptions> = {},
): Promise<RunSummary> {
  const service = new GitLabOriginPushService();
  return service.run(options);
}

/**
 * @description CLI entry point for the repository sync helper.
 *
 * @returns Promise resolved when CLI execution finishes
 */
async function main(): Promise<void> {
  const options = GitLabOriginPushCliOptions.parse(process.argv.slice(2));

  if (options.showHelp) {
    logger.info(
      { usage: GitLabOriginPushCliOptions.buildUsageText() },
      'Repository sync helper usage',
    );
    return;
  }

  try {
    const summary = await runGitLabOriginPush(options);
    logger.info({ summary }, 'Repository sync summary');
  } catch (error) {
    logger.error({ err: error }, 'Repository sync helper failed');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
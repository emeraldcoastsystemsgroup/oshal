/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added orchestration service for GitLab origin discovery and push workflow
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Expanded orchestration for provider-agnostic repository bootstrap and sync
 */

import { GitLabOriginPushCliOptions } from './cli-options';
import type {
  CliOptions,
  OriginAnalysis,
  ProvisionedRepository,
  RepositoryCandidate,
  RepositoryResult,
  RepositorySyncConfig,
  RunSummary,
} from './contracts';
import { GitCommandService } from './git-command-service';
import { GitignoreService } from './gitignore-service';
import { GitLabTokenResolutionService } from './gitlab-token-resolution-service';
import { createGitLabOriginPushLogger } from './logger';
import { RepositoryDiscoveryService } from './repository-discovery-service';
import { RepositoryProvisioningService } from './repository-provisioning-service';

/**
 * @description Orchestrates repository discovery, bootstrap, provisioning, and
 * sync behavior for both existing repositories and new roots.
 */
export class GitLabOriginPushService {
  private readonly logger = createGitLabOriginPushLogger({
    component: 'GitLabOriginPushService',
  });

  private readonly discoveryService = new RepositoryDiscoveryService();

  private readonly gitCommandService = new GitCommandService();

  private readonly gitignoreService = new GitignoreService();

  private readonly provisioningService = new RepositoryProvisioningService();

  private readonly tokenResolutionService = new GitLabTokenResolutionService();

  /**
   * @description Runs the repository sync workflow using caller-provided or default options.
   *
   * @param options - Partial runtime options controlling discovery, bootstrap, and push behavior
   * @returns Summary of discovered repositories and resulting actions
   */
  public async run(options: Partial<CliOptions> = {}): Promise<RunSummary> {
    const startedAt = Date.now();
    const resolvedOptions = GitLabOriginPushCliOptions.resolve(options);
    const repositories = await this.selectRepositoryCandidates(resolvedOptions);
    const results = await this.inspectRepositories(repositories, resolvedOptions);
    const summary = this.buildSummary(resolvedOptions.rootDir, results);

    this.logger.info(
      {
        dryRunCount: summary.dryRunCount,
        durationMs: Date.now() - startedAt,
        failedCount: summary.failedCount,
        pushedCount: summary.pushedCount,
        repoCount: summary.repoCount,
        skippedCount: summary.skippedCount,
      },
      'Repository sync run completed',
    );

    return summary;
  }

  /**
   * @description Selects repository candidates from discovery and falls back to
   * the root directory when no repositories are found.
   *
   * @param options - Resolved runtime options for the run
   * @returns Repository candidates to inspect or bootstrap
   */
  private async selectRepositoryCandidates(
    options: CliOptions,
  ): Promise<RepositoryCandidate[]> {
    const repositories = await this.discoveryService.discoverRepositories(
      options.rootDir,
      options.maxDepth,
    );

    if (repositories.length > 0) {
      return repositories;
    }

    this.logger.info(
      { rootDir: options.rootDir },
      'No repositories discovered — treating root as bootstrap candidate',
    );

    return [{ relativePath: '.', repoPath: options.rootDir }];
  }

  /**
   * @description Inspects repositories sequentially and collects per-repository results.
   *
   * @param repositories - Repository candidates discovered under the scan root
   * @param options - Resolved runtime options for the current run
   * @returns Per-repository results in discovery order
   */
  private async inspectRepositories(
    repositories: RepositoryCandidate[],
    options: CliOptions,
  ): Promise<RepositoryResult[]> {
    const results: RepositoryResult[] = [];

    for (const repository of repositories) {
      results.push(await this.inspectRepository(repository, options));
    }

    return results;
  }

  /**
   * @description Inspects one repository candidate and routes it through either
   * bootstrap or existing-repository sync handling.
   *
   * @param repository - Repository candidate being inspected
   * @param options - Resolved runtime options for the run
   * @returns Result for the inspected repository
   */
  private async inspectRepository(
    repository: RepositoryCandidate,
    options: CliOptions,
  ): Promise<RepositoryResult> {
    this.logger.info({ repoPath: repository.repoPath }, 'Inspecting repository candidate');

    try {
      const isGitRepository = await this.gitCommandService.isGitRepository(repository.repoPath);
      const existingOriginUrl = isGitRepository
        ? await this.gitCommandService.getOriginUrl(
            repository.repoPath,
            options.remoteName,
          )
        : undefined;
      const syncConfig = await this.tokenResolutionService.resolveSyncConfig(
        options,
        repository.repoPath,
        options.rootDir,
        existingOriginUrl,
      );
      const branch = isGitRepository
        ? await this.gitCommandService.resolveBranch(
            repository.repoPath,
            options.branch,
            syncConfig.defaultBranch,
          )
        : syncConfig.defaultBranch;

      return isGitRepository
        ? this.syncExistingRepository(repository, syncConfig, branch, existingOriginUrl, options.push)
        : this.syncNewRepository(repository, syncConfig, branch, options.push);
    } catch (error) {
      this.logger.error({ err: error, repoPath: repository.repoPath }, 'Repository inspection failed');
      return {
        action: 'failed',
        hasOrigin: false,
        provider: 'unknown',
        reason: this.getErrorMessage(error),
        relativePath: repository.relativePath,
        repoPath: repository.repoPath,
      };
    }
  }

  /**
   * @description Synchronizes an existing Git repository, provisioning a remote
   * when needed and optionally pushing to the target.
   *
   * @param repository - Repository candidate being synchronized
   * @param syncConfig - Resolved repository sync configuration
   * @param branch - Branch that should be pushed
   * @param existingOriginUrl - Existing origin URL when already configured
   * @param pushEnabled - Whether the current run should perform a real push
   * @returns Repository sync result
   */
  private async syncExistingRepository(
    repository: RepositoryCandidate,
    syncConfig: RepositorySyncConfig,
    branch: string,
    existingOriginUrl: string | undefined,
    pushEnabled: boolean,
  ): Promise<RepositoryResult> {
    const provisionedRepository = await this.provisioningService.ensureRepository(
      syncConfig,
      existingOriginUrl,
      !pushEnabled,
    );
    const originAnalysis = this.gitCommandService.analyzeOrigin(
      provisionedRepository.originUrl,
      syncConfig.credentials,
    );

    if (!pushEnabled) {
      return this.buildRepositoryResult(
        repository,
        'dry-run',
        branch,
        syncConfig,
        provisionedRepository,
        originAnalysis,
        existingOriginUrl
          ? 'Dry run only — repository is ready to sync to its configured origin'
          : 'Dry run only — repository is ready to configure a remote and sync',
      );
    }

    await this.gitCommandService.setGitIdentity(
      repository.repoPath,
      syncConfig.userName,
      syncConfig.userEmail,
    );
    await this.commitPendingChanges(repository.repoPath, syncConfig.commitMessage);

    if (!existingOriginUrl) {
      await this.gitCommandService.ensureRemote(
        repository.repoPath,
        syncConfig.remoteName,
        provisionedRepository.originUrl,
      );
    }

    await this.gitCommandService.pushRepository(
      repository.repoPath,
      branch,
      originAnalysis.pushTarget ?? provisionedRepository.originUrl,
    );

    return this.buildRepositoryResult(
      repository,
      'pushed',
      branch,
      syncConfig,
      provisionedRepository,
      originAnalysis,
      existingOriginUrl
        ? 'Repository changes pushed to the configured origin'
        : 'Repository remote configured and pushed successfully',
    );
  }

  /**
   * @description Bootstraps a new repository by ensuring `.gitignore`,
   * initializing Git, provisioning a remote, and optionally pushing it.
   *
   * @param repository - Repository candidate being bootstrapped
   * @param syncConfig - Resolved repository sync configuration
   * @param branch - Branch that should be created and pushed
   * @param pushEnabled - Whether the current run should perform a real push
   * @returns Repository bootstrap result
   */
  private async syncNewRepository(
    repository: RepositoryCandidate,
    syncConfig: RepositorySyncConfig,
    branch: string,
    pushEnabled: boolean,
  ): Promise<RepositoryResult> {
    await this.gitignoreService.ensureStandardGitignore(repository.repoPath, !pushEnabled);
    const provisionedRepository = await this.provisioningService.ensureRepository(
      syncConfig,
      undefined,
      !pushEnabled,
    );
    const originAnalysis = this.gitCommandService.analyzeOrigin(
      provisionedRepository.originUrl,
      syncConfig.credentials,
    );

    if (!pushEnabled) {
      return this.buildRepositoryResult(
        repository,
        'dry-run',
        branch,
        syncConfig,
        provisionedRepository,
        originAnalysis,
        'Dry run only — repository will be initialized, committed, and synced',
      );
    }

    await this.gitCommandService.initializeRepository(repository.repoPath, branch);
    await this.gitCommandService.setGitIdentity(
      repository.repoPath,
      syncConfig.userName,
      syncConfig.userEmail,
    );
    await this.commitPendingChanges(repository.repoPath, syncConfig.commitMessage);
    await this.gitCommandService.ensureRemote(
      repository.repoPath,
      syncConfig.remoteName,
      provisionedRepository.originUrl,
    );
    await this.gitCommandService.pushRepository(
      repository.repoPath,
      branch,
      originAnalysis.pushTarget ?? provisionedRepository.originUrl,
    );

    return this.buildRepositoryResult(
      repository,
      'pushed',
      branch,
      syncConfig,
      provisionedRepository,
      originAnalysis,
      'Repository initialized, committed, and pushed successfully',
    );
  }

  /**
   * @description Stages repository changes and commits them when required.
   *
   * @param repoPath - Absolute repository path
   * @param commitMessage - Commit message to use
   * @returns Promise resolved when commit handling completes
   */
  private async commitPendingChanges(
    repoPath: string,
    commitMessage: string,
  ): Promise<void> {
    await this.gitCommandService.stageAllChanges(repoPath);
    const hasPendingChanges = await this.gitCommandService.hasPendingChanges(repoPath);
    const hasCommits = await this.gitCommandService.hasCommits(repoPath);

    if (hasPendingChanges || !hasCommits) {
      await this.gitCommandService.commitChanges(
        repoPath,
        commitMessage,
        !hasPendingChanges,
      );
    }
  }

  /**
   * @description Builds a standardized repository result object.
   *
   * @param repository - Repository candidate being summarized
   * @param action - Action outcome for the repository
   * @param branch - Branch associated with the repository operation
   * @param syncConfig - Resolved sync configuration for the repository
   * @param provisionedRepository - Remote provisioning metadata
   * @param originAnalysis - Analyzed origin metadata
   * @param reason - Human-readable result reason
   * @returns Standardized repository result
   */
  private buildRepositoryResult(
    repository: RepositoryCandidate,
    action: RepositoryResult['action'],
    branch: string,
    syncConfig: RepositorySyncConfig,
    provisionedRepository: ProvisionedRepository,
    originAnalysis: OriginAnalysis,
    reason: string,
  ): RepositoryResult {
    return {
      action,
      branch,
      hasOrigin: originAnalysis.hasOrigin,
      originUrl: originAnalysis.sanitizedOriginUrl,
      provider: syncConfig.provider,
      pushTarget: originAnalysis.sanitizedPushTarget,
      reason,
      relativePath: repository.relativePath,
      repoPath: repository.repoPath,
      repositoryUrl: provisionedRepository.webUrl,
      tokenSource: syncConfig.credentials.source,
    };
  }

  /**
   * @description Builds an aggregated run summary from per-repository results.
   *
   * @param rootDir - Root directory scanned during the run
   * @param results - Per-repository action results
   * @returns Aggregated run summary
   */
  private buildSummary(rootDir: string, results: RepositoryResult[]): RunSummary {
    return {
      dryRunCount: results.filter((result) => result.action === 'dry-run').length,
      failedCount: results.filter((result) => result.action === 'failed').length,
      pushedCount: results.filter((result) => result.action === 'pushed').length,
      repoCount: results.length,
      repos: results,
      scannedRoot: rootDir,
      skippedCount: results.filter((result) => result.action === 'skipped').length,
    };
  }

  /**
   * @description Converts unknown thrown values into readable error messages.
   *
   * @param error - Unknown error thrown during repository inspection
   * @returns Human-readable error message
   */
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Git command and remote analysis service for GitLab origin push helper
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Expanded Git command handling for generic repository bootstrap and provider-agnostic sync
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  OriginAnalysis,
  RepoProvider,
  RepositoryCredentials,
} from './contracts';
import { createGitLabOriginPushLogger } from './logger';

const execFileAsync = promisify(execFile);

/**
 * @description Service responsible for Git command execution, repository bootstrap,
 * remote analysis, and authenticated push target preparation.
 */
export class GitCommandService {
  private readonly logger = createGitLabOriginPushLogger({
    component: 'GitCommandService',
  });

  /**
   * @description Determines whether a path is already initialized as a Git repository.
   *
   * @param repoPath - Absolute repository path
   * @returns True when the directory contains Git metadata
   */
  public async isGitRepository(repoPath: string): Promise<boolean> {
    try {
      await fs.access(path.join(repoPath, '.git'));
      this.logger.info({ repoPath }, 'Detected Git repository');
      return true;
    } catch {
      this.logger.info({ repoPath }, 'Path is not a Git repository');
      return false;
    }
  }

  /**
   * @description Reads the configured remote URL for a repository when one exists.
   *
   * @param repoPath - Absolute repository path
   * @param remoteName - Git remote name to inspect
   * @returns Configured remote URL or undefined when the remote is missing
   */
  public async getOriginUrl(
    repoPath: string,
    remoteName: string,
  ): Promise<string | undefined> {
    const startedAt = Date.now();

    try {
      const output = await this.runGitCommand(repoPath, ['remote', 'get-url', remoteName]);
      const originUrl = output.trim();

      this.logger.info(
        {
          durationMs: Date.now() - startedAt,
          originUrl: this.sanitizeRemoteUrl(originUrl),
          repoPath,
        },
        'Resolved repository origin URL',
      );

      return originUrl;
    } catch (error) {
      if (this.isMissingRemoteError(error) || this.isNotGitRepositoryError(error)) {
        this.logger.info({ remoteName, repoPath }, 'Repository origin remote is not configured');
        return undefined;
      }

      throw error;
    }
  }

  /**
   * @description Resolves the branch that should be pushed for a repository,
   * falling back to a provided default for new repositories.
   *
   * @param repoPath - Absolute repository path
   * @param branchOverride - Optional branch override from CLI or caller
   * @param fallbackBranch - Default branch used for new repositories
   * @returns Branch name to use for the push operation
   */
  public async resolveBranch(
    repoPath: string,
    branchOverride: string | undefined,
    fallbackBranch: string,
  ): Promise<string> {
    if (branchOverride) {
      this.logger.info({ branchOverride, repoPath }, 'Using explicit branch override');
      return branchOverride;
    }

    const startedAt = Date.now();

    try {
      const branch = await this.runGitCommand(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const trimmedBranch = branch.trim();

      if (trimmedBranch === 'HEAD') {
        this.logger.info({ fallbackBranch, repoPath }, 'Detached HEAD detected, using fallback branch');
        return fallbackBranch;
      }

      this.logger.info(
        { branch: trimmedBranch, durationMs: Date.now() - startedAt, repoPath },
        'Resolved repository branch',
      );

      return trimmedBranch;
    } catch (error) {
      if (this.isNotGitRepositoryError(error)) {
        this.logger.info({ fallbackBranch, repoPath }, 'Using fallback branch for non-git path');
        return fallbackBranch;
      }

      throw error;
    }
  }

  /**
   * @description Initializes a new Git repository using the provided default branch.
   *
   * @param repoPath - Absolute repository path
   * @param branch - Initial branch name
   * @returns Promise resolved when initialization completes
   */
  public async initializeRepository(repoPath: string, branch: string): Promise<void> {
    await this.runGitCommand(repoPath, ['init', '--initial-branch', branch]);
  }

  /**
   * @description Configures repository-local Git identity when values are provided.
   *
   * @param repoPath - Absolute repository path
   * @param userName - Git user name to set
   * @param userEmail - Git user email to set
   * @returns Promise resolved when configuration completes
   */
  public async setGitIdentity(
    repoPath: string,
    userName?: string,
    userEmail?: string,
  ): Promise<void> {
    if (userName) {
      await this.runGitCommand(repoPath, ['config', 'user.name', userName]);
    }

    if (userEmail) {
      await this.runGitCommand(repoPath, ['config', 'user.email', userEmail]);
    }
  }

  /**
   * @description Stages all repository changes.
   *
   * @param repoPath - Absolute repository path
   * @returns Promise resolved when staging completes
   */
  public async stageAllChanges(repoPath: string): Promise<void> {
    await this.runGitCommand(repoPath, ['add', '-A']);
  }

  /**
   * @description Determines whether the working tree has staged or unstaged changes.
   *
   * @param repoPath - Absolute repository path
   * @returns True when pending changes exist
   */
  public async hasPendingChanges(repoPath: string): Promise<boolean> {
    const output = await this.runGitCommand(repoPath, ['status', '--porcelain']);
    const hasChanges = output.trim().length > 0;

    this.logger.info({ hasChanges, repoPath }, 'Checked repository working tree state');
    return hasChanges;
  }

  /**
   * @description Creates a commit with the provided message.
   *
   * @param repoPath - Absolute repository path
   * @param message - Commit message to use
   * @param allowEmpty - When true, allows an empty commit to establish history
   * @returns Promise resolved when commit completes
   */
  public async commitChanges(
    repoPath: string,
    message: string,
    allowEmpty = false,
  ): Promise<void> {
    const args = ['commit'];

    if (allowEmpty) {
      args.push('--allow-empty');
    }

    args.push('-m', message);
    await this.runGitCommand(repoPath, args);
  }

  /**
   * @description Determines whether a repository already has at least one commit.
   *
   * @param repoPath - Absolute repository path
   * @returns True when the repository has commit history
   */
  public async hasCommits(repoPath: string): Promise<boolean> {
    try {
      await this.runGitCommand(repoPath, ['rev-parse', '--verify', 'HEAD']);
      this.logger.info({ repoPath }, 'Repository has commit history');
      return true;
    } catch (error) {
      const message = this.getErrorMessage(error).toLowerCase();

      if (message.includes('needed a single revision') || message.includes('unknown revision')) {
        this.logger.info({ repoPath }, 'Repository has no commits yet');
        return false;
      }

      throw error;
    }
  }

  /**
   * @description Adds or updates the configured origin remote.
   *
   * @param repoPath - Absolute repository path
   * @param remoteName - Remote name to configure
   * @param originUrl - Remote URL to apply
   * @returns Promise resolved when the remote configuration is complete
   */
  public async ensureRemote(
    repoPath: string,
    remoteName: string,
    originUrl: string,
  ): Promise<void> {
    const currentOrigin = await this.getOriginUrl(repoPath, remoteName);

    if (currentOrigin) {
      await this.runGitCommand(repoPath, ['remote', 'set-url', remoteName, originUrl]);
      return;
    }

    await this.runGitCommand(repoPath, ['remote', 'add', remoteName, originUrl]);
  }

  /**
   * @description Analyzes a repository origin and optionally builds a tokenized
   * push target for supported providers.
   *
   * @param originUrl - Repository origin URL
   * @param credentials - Optional credentials used to build an authenticated push target
   * @returns Origin analysis metadata used by the orchestration service
   */
  public analyzeOrigin(
    originUrl: string | undefined,
    credentials?: RepositoryCredentials,
  ): OriginAnalysis {
    if (!originUrl) {
      return {
        hasOrigin: false,
        provider: 'unknown',
      };
    }

    const provider = this.detectProvider(originUrl);
    const pushTarget = this.buildPushTarget(originUrl, provider, credentials);
    const analysis = {
      hasOrigin: true,
      originUrl,
      provider,
      pushTarget,
      sanitizedOriginUrl: this.sanitizeRemoteUrl(originUrl),
      sanitizedPushTarget: pushTarget ? this.sanitizeRemoteUrl(pushTarget) : undefined,
    } satisfies OriginAnalysis;

    this.logger.info(
      {
        originUrl: analysis.sanitizedOriginUrl,
        provider: analysis.provider,
        pushTarget: analysis.sanitizedPushTarget,
      },
      'Analyzed repository origin',
    );

    return analysis;
  }

  /**
   * @description Builds a best-effort HTTPS origin URL from host, owner, and repo name.
   *
   * @param host - Repository host name
   * @param owner - Repository owner or namespace
   * @param repoName - Repository name
   * @returns Planned origin URL
   */
  public buildOriginUrl(host: string, owner: string | undefined, repoName: string): string {
    const normalizedPath = owner ? `${owner}/${repoName}` : repoName;
    return `https://${host}/${normalizedPath}.git`;
  }

  /**
   * @description Detects a repository provider from a remote URL.
   *
   * @param remoteUrl - Remote URL to inspect
   * @returns Detected repository provider
   */
  public detectProvider(remoteUrl: string): RepoProvider {
    const host = this.extractRemoteHost(remoteUrl)?.toLowerCase();

    if (!host) {
      return 'unknown';
    }

    if (host.includes('github')) {
      return 'github';
    }

    if (host.includes('gitlab')) {
      return 'gitlab';
    }

    return 'generic';
  }

  /**
   * @description Pushes a repository branch to the resolved target.
   *
   * @param repoPath - Absolute repository path
   * @param branch - Branch name to push
   * @param pushTarget - Remote URL or remote reference to push to
   * @returns Promise resolved when the push succeeds
   */
  public async pushRepository(
    repoPath: string,
    branch: string,
    pushTarget: string,
  ): Promise<void> {
    const startedAt = Date.now();

    this.logger.info(
      {
        branch,
        pushTarget: this.sanitizeRemoteUrl(pushTarget),
        repoPath,
      },
      'Starting repository push',
    );

    await this.runGitCommand(repoPath, ['push', pushTarget, branch]);

    this.logger.info(
      { branch, durationMs: Date.now() - startedAt, repoPath },
      'Repository push completed',
    );
  }

  /**
   * @description Executes a Git command with sanitized structured logging.
   *
   * @param repoPath - Absolute repository path
   * @param args - Git CLI arguments excluding `-C <repoPath>`
   * @returns Standard output produced by the command
   */
  private async runGitCommand(repoPath: string, args: string[]): Promise<string> {
    const startedAt = Date.now();

    this.logger.info(
      { args: args.map((arg) => this.sanitizeRemoteUrl(arg)), repoPath },
      'Running Git command',
    );

    try {
      const { stderr, stdout } = await execFileAsync('git', ['-C', repoPath, ...args]);

      this.logger.info(
        {
          durationMs: Date.now() - startedAt,
          hasStderr: Boolean(stderr.trim()),
          repoPath,
        },
        'Git command completed',
      );

      return stdout;
    } catch (error) {
      this.logger.error(
        { args: args.map((arg) => this.sanitizeRemoteUrl(arg)), err: error, repoPath },
        'Git command failed',
      );
      throw error;
    }
  }

  /**
   * @description Builds an effective push target for the remote, injecting a
   * token or password into HTTPS URLs when credentials are available.
   *
   * @param originUrl - Repository origin URL
   * @param provider - Detected repository provider
   * @param credentials - Optional repository credentials
   * @returns Push target URL or reference when one can be produced
   */
  private buildPushTarget(
    originUrl: string,
    provider: RepoProvider,
    credentials?: RepositoryCredentials,
  ): string {
    if (!credentials) {
      return originUrl;
    }

    const httpsUrl = this.convertGitRemoteToHttps(originUrl);

    if (!httpsUrl) {
      return originUrl;
    }

    const parsedUrl = new URL(httpsUrl);
    const username = this.resolveAuthUsername(provider, credentials);
    const password = this.resolveAuthPassword(credentials);

    if (!username || !password) {
      return originUrl;
    }

    parsedUrl.username = username;
    parsedUrl.password = password;
    return parsedUrl.toString();
  }

  /**
   * @description Converts SSH or SCP-style Git remotes to HTTPS for token injection.
   *
   * @param remoteUrl - Remote URL to normalize
   * @returns HTTPS URL when conversion succeeds
   */
  private convertGitRemoteToHttps(remoteUrl: string): string | undefined {
    if (remoteUrl.startsWith('http://') || remoteUrl.startsWith('https://')) {
      return remoteUrl;
    }

    const scpMatch = remoteUrl.match(/^[^@]+@([^:]+):(.+)$/);

    if (scpMatch?.[1] && scpMatch[2]) {
      return `https://${scpMatch[1]}/${scpMatch[2]}`;
    }

    if (!remoteUrl.startsWith('ssh://')) {
      return undefined;
    }

    const parsedUrl = new URL(remoteUrl);
    return `https://${parsedUrl.hostname}${parsedUrl.pathname}`;
  }

  /**
   * @description Resolves the username used for authenticated HTTPS pushes.
   *
   * @param provider - Repository provider associated with the remote
   * @param credentials - Resolved repository credentials
   * @returns Username to inject into the authenticated remote URL
   */
  private resolveAuthUsername(
    provider: RepoProvider,
    credentials: RepositoryCredentials,
  ): string | undefined {
    if (credentials.username) {
      return credentials.username;
    }

    if (!credentials.token) {
      return undefined;
    }

    if (provider === 'github') {
      return 'x-access-token';
    }

    if (provider === 'gitlab') {
      return 'oauth2';
    }

    return 'oauth2';
  }

  /**
   * @description Resolves the password used for authenticated HTTPS pushes.
   *
   * @param credentials - Resolved repository credentials
   * @returns Password or token to inject into the authenticated remote URL
   */
  private resolveAuthPassword(credentials: RepositoryCredentials): string | undefined {
    return credentials.password ?? credentials.token;
  }

  /**
   * @description Extracts the host component from common Git remote URL formats.
   *
   * @param remoteUrl - Remote URL to inspect
   * @returns Remote host when extraction succeeds
   */
  private extractRemoteHost(remoteUrl: string): string | undefined {
    const scpMatch = remoteUrl.match(/^[^@]+@([^:]+):.+$/);

    if (scpMatch?.[1]) {
      return scpMatch[1];
    }

    try {
      return new URL(remoteUrl).hostname;
    } catch {
      return undefined;
    }
  }

  /**
   * @description Determines whether a Git error indicates a missing remote.
   *
   * @param error - Unknown Git command error
   * @returns True when the remote does not exist
   */
  private isMissingRemoteError(error: unknown): boolean {
    return this.getErrorMessage(error).toLowerCase().includes('no such remote');
  }

  /**
   * @description Determines whether a Git error indicates a non-repository path.
   *
   * @param error - Unknown Git command error
   * @returns True when the path is not currently a Git repository
   */
  private isNotGitRepositoryError(error: unknown): boolean {
    return this.getErrorMessage(error).toLowerCase().includes('not a git repository');
  }

  /**
   * @description Sanitizes a remote URL by redacting embedded credentials.
   *
   * @param value - Raw URL or argument value
   * @returns Sanitized value safe for logs and summaries
   */
  private sanitizeRemoteUrl(value: string): string {
    return value.replace(/(https?:\/\/[^:/\s]+:)([^@/\s]+)(@)/g, '$1[REDACTED]$3');
  }

  /**
   * @description Converts unknown thrown values into readable error messages.
   *
   * @param error - Unknown error thrown during Git command execution
   * @returns Human-readable error message
   */
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
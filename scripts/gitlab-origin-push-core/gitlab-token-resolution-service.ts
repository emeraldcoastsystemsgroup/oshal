/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added GitLab token resolution service for origin push helper
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Expanded config and credential resolution for provider-agnostic repository sync
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Refactored sync config assembly into smaller helpers for function length compliance
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { ENV_FILE_NAMES } from './contracts';
import type {
  CliOptions,
  RepositoryCredentials,
  RepositorySyncConfig,
  RepoOwnerType,
  RepoProvider,
  RepoVisibility,
  TokenResolution,
} from './contracts';
import { createGitLabOriginPushLogger } from './logger';

/**
 * @description Service responsible for resolving repository sync configuration,
 * credentials, and token sources from origin URLs, environment variables, and
 * known `.env*` files.
 */
export class GitLabTokenResolutionService {
  private readonly logger = createGitLabOriginPushLogger({
    component: 'GitLabTokenResolutionService',
  });

  /**
   * @description Resolves the full repository sync configuration for a repository.
   *
   * @param options - CLI/runtime overrides for provider sync behavior
   * @param repoPath - Absolute repository path
   * @param rootDir - Scan root directory
   * @param originUrl - Existing origin URL, when present
   * @returns Resolved provider-agnostic repository sync configuration
   */
  public async resolveSyncConfig(
    options: Partial<CliOptions>,
    repoPath: string,
    rootDir: string,
    originUrl?: string,
  ): Promise<RepositorySyncConfig> {
    const startedAt = Date.now();
    const envConfig = await this.loadEnvironmentConfig(
      repoPath,
      rootDir,
      options.configEnvFile,
    );
    const provider = this.resolveProvider(options.provider, envConfig.values, originUrl);
    const host = this.resolveHost(options.host, envConfig.values, provider, originUrl);
    const repoName = this.resolveRepoName(options, envConfig.values, repoPath);
    const owner = this.resolveOwner(options.owner, envConfig.values);
    const ownerType = this.resolveOwnerType(options.ownerType, envConfig.values);
    const defaultBranch = this.resolveDefaultBranch(options.branch, envConfig.values);
    const visibility = this.resolveVisibility(options.visibility, envConfig.values, provider);
    const apiBaseUrl = this.resolveApiBaseUrl(options.apiBaseUrl, envConfig.values, provider, host);
    const description = this.resolveDescription(options.description, envConfig.values);
    const commitMessage = this.resolveCommitMessage(options.commitMessage, envConfig.values);
    const credentials = this.resolveCredentialsFromContext(
      envConfig.values,
      envConfig.source,
      originUrl,
    );
    const configuredOriginUrl = this.resolveOriginUrl(
      originUrl,
      options.originUrl,
      envConfig.values,
      provider,
      host,
      owner,
      repoName,
    );
    const resolvedConfig = {
      apiBaseUrl,
      commitMessage,
      configSource: envConfig.source,
      credentials,
      defaultBranch,
      description,
      host,
      originUrl: configuredOriginUrl,
      owner,
      ownerType,
      provider,
      remoteName: options.remoteName ?? 'origin',
      repoName,
      userEmail: this.readConfigValue(envConfig.values, ['GIT_USER_EMAIL', 'REPO_SYNC_GIT_USER_EMAIL']),
      userName: this.readConfigValue(envConfig.values, ['GIT_USER_NAME', 'REPO_SYNC_GIT_USER_NAME']),
      visibility,
    } satisfies RepositorySyncConfig;

    this.logger.info(
      {
        configSource: resolvedConfig.configSource,
        durationMs: Date.now() - startedAt,
        host: resolvedConfig.host,
        originUrl: this.sanitizeUrl(resolvedConfig.originUrl),
        provider: resolvedConfig.provider,
        repoName: resolvedConfig.repoName,
      },
      'Resolved repository sync configuration',
    );

    return resolvedConfig;
  }

  /**
   * @description Resolves the repository name from CLI options, env config, or path name.
   *
   * @param options - Partial runtime options
   * @param envMap - Parsed environment key-value pairs
   * @param repoPath - Absolute repository path
   * @returns Repository name to use for sync or provisioning
   */
  private resolveRepoName(
    options: Partial<CliOptions>,
    envMap: Record<string, string>,
    repoPath: string,
  ): string {
    return (
      options.repoName ||
      this.readConfigValue(envMap, ['REPO_SYNC_REPO_NAME', 'GIT_REPO_NAME']) ||
      path.basename(repoPath)
    );
  }

  /**
   * @description Resolves repository owner or namespace from CLI options or env config.
   *
   * @param optionOwner - Owner override from CLI
   * @param envMap - Parsed environment key-value pairs
   * @returns Repository owner or namespace when configured
   */
  private resolveOwner(
    optionOwner: string | undefined,
    envMap: Record<string, string>,
  ): string | undefined {
    return optionOwner || this.readConfigValue(envMap, ['REPO_SYNC_OWNER', 'GIT_REPO_OWNER']);
  }

  /**
   * @description Resolves the default branch for sync or bootstrap.
   *
   * @param optionBranch - Branch override from CLI
   * @param envMap - Parsed environment key-value pairs
   * @returns Default branch name
   */
  private resolveDefaultBranch(
    optionBranch: string | undefined,
    envMap: Record<string, string>,
  ): string {
    return (
      optionBranch ||
      this.readConfigValue(envMap, ['REPO_SYNC_BRANCH', 'GIT_DEFAULT_BRANCH']) ||
      'main'
    );
  }

  /**
   * @description Resolves the provider API base URL from CLI, env config, or defaults.
   *
   * @param optionApiBaseUrl - API base URL override from CLI
   * @param envMap - Parsed environment key-value pairs
   * @param provider - Resolved repository provider
   * @param host - Resolved repository host
   * @returns Provider API base URL when available
   */
  private resolveApiBaseUrl(
    optionApiBaseUrl: string | undefined,
    envMap: Record<string, string>,
    provider: RepoProvider,
    host: string | undefined,
  ): string | undefined {
    return (
      optionApiBaseUrl ||
      this.readConfigValue(envMap, ['REPO_SYNC_API_BASE_URL', 'GIT_API_BASE_URL']) ||
      this.buildDefaultApiBaseUrl(provider, host)
    );
  }

  /**
   * @description Resolves repository description from CLI or env config.
   *
   * @param optionDescription - Description override from CLI
   * @param envMap - Parsed environment key-value pairs
   * @returns Repository description when configured
   */
  private resolveDescription(
    optionDescription: string | undefined,
    envMap: Record<string, string>,
  ): string | undefined {
    return (
      optionDescription ||
      this.readConfigValue(envMap, ['REPO_SYNC_DESCRIPTION', 'GIT_REPO_DESCRIPTION'])
    );
  }

  /**
   * @description Resolves the commit message used during sync.
   *
   * @param optionCommitMessage - Commit message override from CLI
   * @param envMap - Parsed environment key-value pairs
   * @returns Commit message to use for auto-generated commits
   */
  private resolveCommitMessage(
    optionCommitMessage: string | undefined,
    envMap: Record<string, string>,
  ): string {
    return (
      optionCommitMessage ||
      this.readConfigValue(envMap, ['REPO_SYNC_COMMIT_MESSAGE', 'GIT_COMMIT_MESSAGE']) ||
      'chore: sync repository snapshot'
    );
  }

  /**
   * @description Resolves the remote origin URL for sync or provisioning.
   *
   * @param existingOriginUrl - Existing configured origin URL
   * @param optionOriginUrl - Origin override from CLI
   * @param envMap - Parsed environment key-value pairs
   * @param provider - Resolved repository provider
   * @param host - Resolved repository host
   * @param owner - Resolved owner or namespace
   * @param repoName - Resolved repository name
   * @returns Origin URL when one can be determined
   */
  private resolveOriginUrl(
    existingOriginUrl: string | undefined,
    optionOriginUrl: string | undefined,
    envMap: Record<string, string>,
    provider: RepoProvider,
    host: string | undefined,
    owner: string | undefined,
    repoName: string,
  ): string | undefined {
    return (
      existingOriginUrl ||
      optionOriginUrl ||
      this.readConfigValue(envMap, ['REPO_SYNC_ORIGIN_URL', 'GIT_ORIGIN_URL']) ||
      this.buildDefaultOriginUrl(provider, host, owner, repoName)
    );
  }

  /**
   * @description Resolves repository credentials and token sources from origin,
   * environment files, and runtime environment variables.
   *
   * @param repoPath - Absolute repository path
   * @param rootDir - Scan root directory
   * @param originUrl - Repository origin URL
   * @param configEnvFile - Explicit config file path when provided
   * @returns Repository credential metadata with source attribution
   */
  public async resolveCredentials(
    repoPath: string,
    rootDir: string,
    originUrl: string | undefined,
    configEnvFile?: string,
  ): Promise<RepositoryCredentials> {
    const envConfig = await this.loadEnvironmentConfig(repoPath, rootDir, configEnvFile);
    return this.resolveCredentialsFromContext(envConfig.values, envConfig.source, originUrl);
  }

  /**
   * @description Resolves the most appropriate GitLab token source for a repository.
   *
   * @param repoPath - Absolute repository path
   * @param rootDir - Scan root directory
   * @param originUrl - Repository origin URL
   * @returns Token resolution metadata with source attribution when available
   */
  public async resolveToken(
    repoPath: string,
    rootDir: string,
    originUrl: string,
    configEnvFile?: string,
  ): Promise<TokenResolution> {
    const startedAt = Date.now();
    this.logger.info({ repoPath, rootDir }, 'Starting GitLab token resolution');
    const credentials = await this.resolveCredentials(
      repoPath,
      rootDir,
      originUrl,
      configEnvFile,
    );
    return this.logResolution(
      { source: credentials.source, token: credentials.token },
      startedAt,
    );
  }

  /**
   * @description Logs a token resolution result without exposing credential values.
   *
   * @param resolution - Token resolution metadata to log
   * @param startedAt - Millisecond timestamp captured before resolution started
   * @returns Original resolution metadata
   */
  private logResolution(
    resolution: TokenResolution,
    startedAt: number,
  ): TokenResolution {
    this.logger.info(
      {
        durationMs: Date.now() - startedAt,
        hasToken: Boolean(resolution.token),
        tokenSource: resolution.source,
      },
      'Completed GitLab token resolution',
    );

    return resolution;
  }

  /**
   * @description Loads repository sync environment values from explicit, root,
   * and repository-local env files.
   *
   * @param repoPath - Absolute repository path
   * @param rootDir - Scan root directory
   * @param configEnvFile - Explicit env file path when provided
   * @returns Parsed environment values and a human-readable source description
   */
  private async loadEnvironmentConfig(
    repoPath: string,
    rootDir: string,
    configEnvFile?: string,
  ): Promise<{ source?: string; values: Record<string, string> }> {
    const values: Record<string, string> = {};
    const sources: string[] = [];
    const candidateFiles = this.buildEnvFileCandidates(repoPath, rootDir, configEnvFile);

    for (const candidateFile of candidateFiles) {
      const parsedEnv = await this.readEnvironmentFile(candidateFile);

      if (!parsedEnv) {
        continue;
      }

      Object.assign(values, parsedEnv);
      sources.push(candidateFile);
    }

    const source = sources.length > 0 ? sources.join(', ') : undefined;
    this.logger.info({ source }, 'Loaded environment configuration sources');
    return { source, values };
  }

  /**
   * @description Builds the ordered list of env file candidates to inspect.
   *
   * @param repoPath - Absolute repository path
   * @param rootDir - Scan root directory
   * @param configEnvFile - Explicit env file path when provided
   * @returns Ordered list of environment files to inspect
   */
  private buildEnvFileCandidates(
    repoPath: string,
    rootDir: string,
    configEnvFile?: string,
  ): string[] {
    const candidateFiles = new Set<string>();

    for (const fileName of ENV_FILE_NAMES) {
      candidateFiles.add(path.join(rootDir, fileName));

      if (path.resolve(repoPath) !== path.resolve(rootDir)) {
        candidateFiles.add(path.join(repoPath, fileName));
      }
    }

    if (configEnvFile) {
      candidateFiles.add(path.resolve(configEnvFile));
    }

    return Array.from(candidateFiles);
  }

  /**
   * @description Resolves provider from CLI options, env config, or existing origin URL.
   *
   * @param optionProvider - Provider override from CLI
   * @param envMap - Parsed env values
   * @param originUrl - Existing origin URL
   * @returns Resolved repository provider
   */
  private resolveProvider(
    optionProvider: RepoProvider | undefined,
    envMap: Record<string, string>,
    originUrl?: string,
  ): RepoProvider {
    const providerValue =
      optionProvider ||
      (this.readConfigValue(envMap, ['REPO_SYNC_PROVIDER', 'GIT_PROVIDER']) as RepoProvider | undefined);

    if (providerValue) {
      return providerValue;
    }

    return this.detectProviderFromUrl(originUrl);
  }

  /**
   * @description Resolves the provider host from CLI options, env config, or origin URL.
   *
   * @param optionHost - Host override from CLI
   * @param envMap - Parsed env values
   * @param provider - Resolved repository provider
   * @param originUrl - Existing origin URL
   * @returns Resolved host name when available
   */
  private resolveHost(
    optionHost: string | undefined,
    envMap: Record<string, string>,
    provider: RepoProvider,
    originUrl?: string,
  ): string | undefined {
    return (
      optionHost ||
      this.readConfigValue(envMap, ['REPO_SYNC_HOST', 'GIT_HOST']) ||
      this.extractHostFromUrl(originUrl) ||
      this.buildDefaultHost(provider)
    );
  }

  /**
   * @description Resolves owner type from CLI options or env config.
   *
   * @param optionOwnerType - Owner-type override from CLI
   * @param envMap - Parsed env values
   * @returns Resolved owner type
   */
  private resolveOwnerType(
    optionOwnerType: RepoOwnerType | undefined,
    envMap: Record<string, string>,
  ): RepoOwnerType {
    return (
      optionOwnerType ||
      (this.readConfigValue(envMap, [
        'REPO_SYNC_OWNER_TYPE',
        'GIT_REPO_OWNER_TYPE',
      ]) as RepoOwnerType | undefined) ||
      'user'
    );
  }

  /**
   * @description Resolves repository visibility from CLI options or env config.
   *
   * @param optionVisibility - Visibility override from CLI
   * @param envMap - Parsed env values
   * @param provider - Resolved repository provider
   * @returns Resolved visibility value
   */
  private resolveVisibility(
    optionVisibility: RepoVisibility | undefined,
    envMap: Record<string, string>,
    provider: RepoProvider,
  ): RepoVisibility {
    const configuredVisibility = optionVisibility ||
      (this.readConfigValue(envMap, [
        'REPO_SYNC_VISIBILITY',
        'GIT_REPO_VISIBILITY',
      ]) as RepoVisibility | undefined);

    if (configuredVisibility) {
      return configuredVisibility;
    }

    return provider === 'gitlab' ? 'private' : 'private';
  }

  /**
   * @description Builds a default HTTPS origin URL when host and repo identity are known.
   *
   * @param provider - Resolved repository provider
   * @param host - Repository host name
   * @param owner - Owner or namespace for the repository
   * @param repoName - Repository name
   * @returns Planned origin URL when enough information is available
   */
  private buildDefaultOriginUrl(
    provider: RepoProvider,
    host: string | undefined,
    owner: string | undefined,
    repoName: string,
  ): string | undefined {
    if (provider === 'unknown' || !host) {
      return undefined;
    }

    const normalizedPath = owner ? `${owner}/${repoName}` : repoName;
    return `https://${host}/${normalizedPath}.git`;
  }

  /**
   * @description Builds the default provider API base URL when one is not configured.
   *
   * @param provider - Resolved repository provider
   * @param host - Provider host name
   * @returns Default API base URL when supported
   */
  private buildDefaultApiBaseUrl(
    provider: RepoProvider,
    host: string | undefined,
  ): string | undefined {
    if (!host) {
      return undefined;
    }

    if (provider === 'github') {
      return 'https://api.github.com';
    }

    if (provider === 'gitlab') {
      return `https://${host}/api/v4`;
    }

    return undefined;
  }

  /**
   * @description Returns a default host for supported repository providers.
   *
   * @param provider - Resolved repository provider
   * @returns Default host name for the provider when known
   */
  private buildDefaultHost(provider: RepoProvider): string | undefined {
    if (provider === 'github') {
      return 'github.com';
    }

    if (provider === 'gitlab') {
      return 'gitlab.com';
    }

    return undefined;
  }

  /**
   * @description Resolves repository credentials from environment and origin context.
   *
   * @param envMap - Parsed env values
   * @param envSource - Source description for parsed env values
   * @param originUrl - Existing origin URL
   * @returns Resolved repository credentials
   */
  private resolveCredentialsFromContext(
    envMap: Record<string, string>,
    envSource: string | undefined,
    originUrl?: string,
  ): RepositoryCredentials {
    const originCredentials = this.extractCredentialsFromOriginUrl(originUrl);
    const envCredentials = this.extractCredentialsFromEnvMap(envMap);
    const processCredentials = this.extractCredentialsFromProcessEnv();
    const resolvedCredentials = {
      password: envCredentials.password || processCredentials.password || originCredentials.password,
      source: envCredentials.source || processCredentials.source || originCredentials.source,
      token: envCredentials.token || processCredentials.token || originCredentials.token,
      username: envCredentials.username || processCredentials.username || originCredentials.username,
    } satisfies RepositoryCredentials;

    if (envSource && (envCredentials.password || envCredentials.token || envCredentials.username)) {
      resolvedCredentials.source = envSource;
    }

    if (!resolvedCredentials.password && !resolvedCredentials.token && !resolvedCredentials.username) {
      resolvedCredentials.source = undefined;
    }

    this.logger.info(
      {
        hasPassword: Boolean(resolvedCredentials.password),
        hasToken: Boolean(resolvedCredentials.token),
        hasUsername: Boolean(resolvedCredentials.username),
        source: resolvedCredentials.source,
      },
      'Resolved repository credentials',
    );

    return resolvedCredentials;
  }

  /**
   * @description Extracts a token embedded directly in the remote origin URL.
   *
   * @param originUrl - Repository origin URL
   * @returns Token value when one is embedded in the URL
   */
  private extractTokenFromOriginUrl(originUrl: string): string | undefined {
    const glpatMatch = originUrl.match(/(glpat-[A-Za-z0-9_-]+)/);

    if (glpatMatch?.[1]) {
      return glpatMatch[1];
    }

    try {
      const parsedUrl = new URL(originUrl);
      return parsedUrl.password || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * @description Extracts any embedded username, password, or token from the origin URL.
   *
   * @param originUrl - Repository origin URL
   * @returns Credentials embedded directly in the origin URL
   */
  private extractCredentialsFromOriginUrl(
    originUrl?: string,
  ): RepositoryCredentials {
    if (!originUrl) {
      return {};
    }

    try {
      const parsedUrl = new URL(originUrl);
      return {
        password: parsedUrl.password || undefined,
        source: '.git/config origin URL',
        token: this.extractTokenFromOriginUrl(originUrl),
        username: parsedUrl.username || undefined,
      };
    } catch {
      return {
        source: '.git/config origin URL',
        token: this.extractTokenFromOriginUrl(originUrl),
      };
    }
  }

  /**
   * @description Reads known environment files from a directory and returns the
   * first GitLab token candidate found.
   *
   * @param directoryPath - Directory path whose environment files should be inspected
   * @returns Token resolution metadata when a token is found
   */
  private async readTokenFromEnvDirectory(
    directoryPath: string,
  ): Promise<TokenResolution> {
    for (const fileName of ENV_FILE_NAMES) {
      const filePath = path.join(directoryPath, fileName);
      const parsedEnv = await this.readEnvironmentFile(filePath);

      if (!parsedEnv) {
        continue;
      }

      const token = this.extractTokenFromEnvObject(parsedEnv);

      if (token) {
        return { source: filePath, token };
      }
    }

    return {};
  }

  /**
   * @description Extracts repository credentials from parsed environment values.
   *
   * @param envMap - Parsed environment key-value pairs
   * @returns Repository credentials derived from environment values
   */
  private extractCredentialsFromEnvMap(
    envMap: Record<string, string>,
  ): RepositoryCredentials {
    const credentials = {
      password: this.readConfigValue(envMap, [
        'REPO_SYNC_PASSWORD',
        'GIT_REPO_PASS',
        'GIT_PASSWORD',
        'GITHUB_PASSWORD',
        'GITLAB_PASSWORD',
      ]),
      token: this.readConfigValue(envMap, [
        'REPO_SYNC_TOKEN',
        'GIT_REPO_TOKEN',
        'GIT_TOKEN',
        'GITHUB_TOKEN',
        'GITLAB_TOKEN',
        'GLPAT',
        'GITLAB_PRIVATE_TOKEN',
        'CI_JOB_TOKEN',
      ]),
      username: this.readConfigValue(envMap, [
        'REPO_SYNC_USERNAME',
        'GIT_REPO_USER',
        'GIT_USERNAME',
        'GITHUB_USER',
        'GITLAB_USER',
      ]),
    } satisfies RepositoryCredentials;

    return {
      ...credentials,
      source:
        credentials.password || credentials.token || credentials.username
          ? 'environment file'
          : undefined,
    };
  }

  /**
   * @description Extracts repository credentials from process environment values.
   *
   * @returns Repository credentials derived from `process.env`
   */
  private extractCredentialsFromProcessEnv(): RepositoryCredentials {
    const credentials = {
      password: this.readConfigValue(process.env as Record<string, string>, [
        'REPO_SYNC_PASSWORD',
        'GIT_REPO_PASS',
        'GIT_PASSWORD',
        'GITHUB_PASSWORD',
        'GITLAB_PASSWORD',
      ]),
      token: this.readConfigValue(process.env as Record<string, string>, [
        'REPO_SYNC_TOKEN',
        'GIT_REPO_TOKEN',
        'GIT_TOKEN',
        'GITHUB_TOKEN',
        'GITLAB_TOKEN',
        'GLPAT',
        'GITLAB_PRIVATE_TOKEN',
        'CI_JOB_TOKEN',
      ]),
      username: this.readConfigValue(process.env as Record<string, string>, [
        'REPO_SYNC_USERNAME',
        'GIT_REPO_USER',
        'GIT_USERNAME',
        'GITHUB_USER',
        'GITLAB_USER',
      ]),
    } satisfies RepositoryCredentials;

    return {
      ...credentials,
      source:
        credentials.password || credentials.token || credentials.username
          ? 'process.env'
          : undefined,
    };
  }

  /**
   * @description Reads and parses a single environment file when it exists.
   *
   * @param filePath - Absolute path to the environment file
   * @returns Parsed environment map or undefined when the file does not exist
   */
  private async readEnvironmentFile(
    filePath: string,
  ): Promise<Record<string, string> | undefined> {
    try {
      this.logger.info({ filePath, operation: 'readFile' }, 'Reading environment file');
      const fileContents = await fs.readFile(filePath, 'utf8');
      this.logger.info({ filePath }, 'Read environment file for GitLab token discovery');
      return dotenv.parse(fileContents);
    } catch (error) {
      if (this.isMissingFileError(error)) {
        this.logger.info({ filePath }, 'Environment file not present');
        return undefined;
      }

      this.logger.error({ err: error, filePath }, 'Failed to read environment file');
      throw error;
    }
  }

  /**
   * @description Extracts a GitLab token candidate from parsed environment values.
   *
   * @param envMap - Parsed environment key-value pairs
   * @returns Token value when a supported key or GLPAT string is found
   */
  private extractTokenFromEnvObject(envMap: Record<string, string>): string | undefined {
    const preferredKeys = ['GITLAB_TOKEN', 'GLPAT', 'GITLAB_PRIVATE_TOKEN', 'CI_JOB_TOKEN'];

    for (const key of preferredKeys) {
      const value = envMap[key];

      if (value) {
        return value;
      }
    }

    for (const value of Object.values(envMap)) {
      const tokenMatch = value.match(/(glpat-[A-Za-z0-9_-]+)/);

      if (tokenMatch?.[1]) {
        return tokenMatch[1];
      }
    }

    return undefined;
  }

  /**
   * @description Reads the first available configuration value from a list of keys.
   *
   * @param envMap - Parsed environment key-value pairs
   * @param keys - Candidate keys to inspect in order
   * @returns First non-empty value found for the provided keys
   */
  private readConfigValue(
    envMap: Record<string, string>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = envMap[key];

      if (value) {
        return value;
      }
    }

    return undefined;
  }

  /**
   * @description Detects a repository provider from the origin URL.
   *
   * @param originUrl - Existing origin URL, when present
   * @returns Detected repository provider
   */
  private detectProviderFromUrl(originUrl?: string): RepoProvider {
    const host = this.extractHostFromUrl(originUrl)?.toLowerCase();

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
   * @description Extracts the host component from a remote URL.
   *
   * @param originUrl - Existing origin URL, when present
   * @returns Host name when extraction succeeds
   */
  private extractHostFromUrl(originUrl?: string): string | undefined {
    if (!originUrl) {
      return undefined;
    }

    const scpMatch = originUrl.match(/^[^@]+@([^:]+):.+$/);

    if (scpMatch?.[1]) {
      return scpMatch[1];
    }

    try {
      return new URL(originUrl).hostname;
    } catch {
      return undefined;
    }
  }

  /**
   * @description Sanitizes URLs for safe structured logging.
   *
   * @param value - Raw URL value
   * @returns Sanitized URL with credentials redacted
   */
  private sanitizeUrl(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    return value.replace(/(https?:\/\/[^:/\s]+:)([^@/\s]+)(@)/g, '$1[REDACTED]$3');
  }

  /**
   * @description Determines whether a file read failure was caused by a missing file.
   *
   * @param error - Unknown error thrown while reading a file
   * @returns True when the error indicates a missing file path
   */
  private isMissingFileError(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  }
}
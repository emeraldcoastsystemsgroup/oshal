/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added provider-agnostic remote repository provisioning service
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added basic-auth fallback support for provider API provisioning requests
 */

import type {
  ProvisionedRepository,
  RepositorySyncConfig,
  RepoVisibility,
} from './contracts';
import { createGitLabOriginPushLogger } from './logger';

/**
 * @description Service that provisions remote repositories for supported
 * providers or returns planned remote URLs in dry-run mode.
 */
export class RepositoryProvisioningService {
  private readonly logger = createGitLabOriginPushLogger({
    component: 'RepositoryProvisioningService',
  });

  /**
   * @description Ensures a remote repository exists for the provided config.
   * Existing origins are returned unchanged; new repositories are planned or
   * created depending on push mode.
   *
   * @param config - Resolved repository sync configuration
   * @param existingOriginUrl - Existing origin URL when already configured
   * @param dryRun - When true, no provider API calls are performed
   * @returns Remote repository provisioning result
   */
  public async ensureRepository(
    config: RepositorySyncConfig,
    existingOriginUrl: string | undefined,
    dryRun: boolean,
  ): Promise<ProvisionedRepository> {
    if (existingOriginUrl) {
      return {
        created: false,
        originUrl: existingOriginUrl,
        provider: config.provider,
        webUrl: this.toWebUrl(existingOriginUrl),
      };
    }

    if (!config.originUrl) {
      throw new Error('No origin URL is configured and the provider config is insufficient to create one');
    }

    if (dryRun || config.provider === 'generic' || config.provider === 'unknown') {
      return {
        created: false,
        originUrl: config.originUrl,
        provider: config.provider,
        webUrl: this.toWebUrl(config.originUrl),
      };
    }

    if (!this.hasApiCredentials(config)) {
      throw new Error(
        `Cannot create ${config.provider} repository without token or username/password credentials`,
      );
    }

    if (config.provider === 'github') {
      return this.createGithubRepository(config);
    }

    return this.createGitLabRepository(config);
  }

  /**
   * @description Creates a GitHub repository using the authenticated provider API.
   *
   * @param config - Resolved repository sync configuration
   * @returns Provisioned repository metadata
   */
  private async createGithubRepository(
    config: RepositorySyncConfig,
  ): Promise<ProvisionedRepository> {
    const endpoint = this.buildGithubCreateEndpoint(config);
    const responseBody = await this.performJsonRequest(endpoint, {
      body: JSON.stringify({
        description: config.description,
        name: config.repoName,
        private: config.visibility !== 'public',
      }),
      headers: {
        Accept: 'application/vnd.github+json',
        ...this.buildProviderAuthHeaders(config),
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      method: 'POST',
    });

    return {
      created: true,
      originUrl: responseBody.clone_url ?? config.originUrl ?? '',
      provider: 'github',
      webUrl: responseBody.html_url,
    };
  }

  /**
   * @description Creates a GitLab repository using the authenticated provider API.
   *
   * @param config - Resolved repository sync configuration
   * @returns Provisioned repository metadata
   */
  private async createGitLabRepository(
    config: RepositorySyncConfig,
  ): Promise<ProvisionedRepository> {
    const namespaceId = await this.resolveGitLabNamespaceId(config);
    const responseBody = await this.performJsonRequest(`${config.apiBaseUrl}/projects`, {
      body: JSON.stringify({
        description: config.description,
        name: config.repoName,
        namespace_id: namespaceId,
        path: config.repoName,
        visibility: this.mapGitLabVisibility(config.visibility),
      }),
      headers: {
        'Content-Type': 'application/json',
        ...this.buildProviderAuthHeaders(config),
      },
      method: 'POST',
    });

    return {
      created: true,
      originUrl: responseBody.http_url_to_repo ?? config.originUrl ?? '',
      provider: 'gitlab',
      webUrl: responseBody.web_url,
    };
  }

  /**
   * @description Builds the GitHub create-repository endpoint based on owner type.
   *
   * @param config - Resolved repository sync configuration
   * @returns GitHub API endpoint for repository creation
   */
  private buildGithubCreateEndpoint(config: RepositorySyncConfig): string {
    if (config.ownerType === 'org' && config.owner) {
      return `${config.apiBaseUrl}/orgs/${encodeURIComponent(config.owner)}/repos`;
    }

    return `${config.apiBaseUrl}/user/repos`;
  }

  /**
   * @description Resolves a GitLab namespace id when owner information is provided.
   *
   * @param config - Resolved repository sync configuration
   * @returns Namespace id or undefined when default user namespace should be used
   */
  private async resolveGitLabNamespaceId(
    config: RepositorySyncConfig,
  ): Promise<number | undefined> {
    if (!config.owner) {
      return undefined;
    }

    const namespaceResults = await this.performJsonRequest(
      `${config.apiBaseUrl}/namespaces?search=${encodeURIComponent(config.owner)}`,
      {
        headers: this.buildProviderAuthHeaders(config),
        method: 'GET',
      },
    );
    const namespace = Array.isArray(namespaceResults)
      ? namespaceResults.find((entry) => {
          return entry.path === config.owner || entry.full_path === config.owner;
        })
      : undefined;

    if (!namespace?.id) {
      throw new Error(`Unable to resolve GitLab namespace '${config.owner}'`);
    }

    return namespace.id as number;
  }

  /**
   * @description Executes a JSON HTTP request with structured logging.
   *
   * @param url - Target provider API URL
   * @param init - Fetch request options
   * @returns Parsed JSON response body
   */
  private async performJsonRequest(url: string, init: RequestInit): Promise<any> {
    const startedAt = Date.now();
    this.logger.info({ method: init.method, url }, 'Calling repository provider API');

    const response = await fetch(url, init);
    const responseText = await response.text();

    this.logger.info(
      { durationMs: Date.now() - startedAt, status: response.status, url },
      'Repository provider API responded',
    );

    if (!response.ok) {
      throw new Error(`Repository provider API failed (${response.status}): ${responseText}`);
    }

    return responseText ? JSON.parse(responseText) : {};
  }

  /**
   * @description Converts repository clone URLs into web URLs for reporting.
   *
   * @param originUrl - Repository clone URL
   * @returns Web URL for the repository when derivable
   */
  private toWebUrl(originUrl: string): string {
    const sanitizedUrl = originUrl.replace(/\.git$/, '');
    const scpMatch = sanitizedUrl.match(/^[^@]+@([^:]+):(.+)$/);

    if (scpMatch?.[1] && scpMatch[2]) {
      return `https://${scpMatch[1]}/${scpMatch[2]}`;
    }

    if (sanitizedUrl.startsWith('ssh://')) {
      const parsedUrl = new URL(sanitizedUrl);
      return `https://${parsedUrl.hostname}${parsedUrl.pathname}`;
    }

    return sanitizedUrl;
  }

  /**
   * @description Normalizes visibility values for GitLab provider requests.
   *
   * @param visibility - Repository visibility requested by configuration
   * @returns GitLab-compatible visibility string
   */
  private mapGitLabVisibility(visibility: RepoVisibility): RepoVisibility {
    return visibility === 'internal' ? 'internal' : visibility;
  }

  /**
   * @description Builds provider API authentication headers from token or
   * username/password credentials.
   *
   * @param config - Resolved repository sync configuration
   * @returns HTTP headers needed to authenticate provider API calls
   */
  private buildProviderAuthHeaders(config: RepositorySyncConfig): Record<string, string> {
    if (config.provider === 'gitlab' && config.credentials.token) {
      return { 'PRIVATE-TOKEN': config.credentials.token };
    }

    if (config.credentials.token) {
      return { Authorization: `Bearer ${config.credentials.token}` };
    }

    if (config.credentials.username && config.credentials.password) {
      const basicAuth = Buffer.from(
        `${config.credentials.username}:${config.credentials.password}`,
      ).toString('base64');
      return { Authorization: `Basic ${basicAuth}` };
    }

    throw new Error(
      `Cannot create ${config.provider} repository without token or username/password credentials`,
    );
  }

  /**
   * @description Determines whether the current config includes credentials that
   * can authenticate provider API calls.
   *
   * @param config - Resolved repository sync configuration
   * @returns True when token or username/password credentials are present
   */
  private hasApiCredentials(config: RepositorySyncConfig): boolean {
    return Boolean(
      config.credentials.token ||
        (config.credentials.username && config.credentials.password),
    );
  }
}
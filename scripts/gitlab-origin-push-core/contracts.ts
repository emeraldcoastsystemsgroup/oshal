/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added shared contracts for GitLab origin push helper services
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Expanded contracts for provider-agnostic repository sync and bootstrap workflows
 */

/**
 * @description Supported execution actions for repository handling results.
 */
export type PushAction = 'skipped' | 'dry-run' | 'pushed' | 'failed';

/**
 * @description Supported repository hosting providers for sync and provisioning.
 */
export type RepoProvider = 'github' | 'gitlab' | 'generic' | 'unknown';

/**
 * @description Supported visibility values for provider-backed repositories.
 */
export type RepoVisibility = 'private' | 'public' | 'internal';

/**
 * @description Supported owner types used by repository providers.
 */
export type RepoOwnerType = 'user' | 'org';

/**
 * @description Resolved runtime options for GitLab origin discovery and push execution.
 */
export interface CliOptions {
  apiBaseUrl?: string;
  branch?: string;
  commitMessage?: string;
  configEnvFile?: string;
  description?: string;
  host?: string;
  maxDepth: number;
  originUrl?: string;
  owner?: string;
  ownerType?: RepoOwnerType;
  provider?: RepoProvider;
  push: boolean;
  remoteName: string;
  repoName?: string;
  rootDir: string;
  showHelp: boolean;
  visibility?: RepoVisibility;
}

/**
 * @description Minimal repository metadata captured during filesystem discovery.
 */
export interface RepositoryCandidate {
  relativePath: string;
  repoPath: string;
}

/**
 * @description Per-repository execution outcome captured in the final summary.
 */
export interface RepositoryResult {
  action: PushAction;
  branch?: string;
  hasOrigin: boolean;
  originUrl?: string;
  provider: RepoProvider;
  pushTarget?: string;
  reason: string;
  relativePath: string;
  repoPath: string;
  repositoryUrl?: string;
  tokenSource?: string;
}

/**
 * @description Aggregated result returned after scanning and optionally pushing repositories.
 */
export interface RunSummary {
  dryRunCount: number;
  failedCount: number;
  pushedCount: number;
  repoCount: number;
  repos: RepositoryResult[];
  scannedRoot: string;
  skippedCount: number;
}

/**
 * @description Token resolution metadata including the source used to resolve credentials.
 */
export interface TokenResolution {
  source?: string;
  token?: string;
}

/**
 * @description Resolved credentials used for repository authentication and API access.
 */
export interface RepositoryCredentials {
  password?: string;
  source?: string;
  token?: string;
  username?: string;
}

/**
 * @description Resolved provider configuration used for repository sync and provisioning.
 */
export interface RepositorySyncConfig {
  apiBaseUrl?: string;
  commitMessage: string;
  configSource?: string;
  credentials: RepositoryCredentials;
  defaultBranch: string;
  description?: string;
  host?: string;
  originUrl?: string;
  owner?: string;
  ownerType: RepoOwnerType;
  provider: RepoProvider;
  remoteName: string;
  repoName: string;
  userName?: string;
  userEmail?: string;
  visibility: RepoVisibility;
}

/**
 * @description Remote repository provisioning details returned after create or dry-run planning.
 */
export interface ProvisionedRepository {
  created: boolean;
  originUrl: string;
  provider: RepoProvider;
  webUrl?: string;
}

/**
 * @description Analyzed origin metadata used to decide push and provisioning behavior.
 */
export interface OriginAnalysis {
  hasOrigin: boolean;
  originUrl?: string;
  provider: RepoProvider;
  pushTarget?: string;
  sanitizedOriginUrl?: string;
  sanitizedPushTarget?: string;
}

/**
 * @description Environment files searched for repository-sync credentials.
 *
 * ISOLATED ON PURPOSE: only DEDICATED sync files are scanned — NOT the application's main
 * `.env` / `.env.local` (which hold unrelated app secrets). A push run resolves its token from
 * its own siloed file (e.g. `.env.gitlab`) and never loads the broader app environment. Keep the
 * GitLab PAT in `.env.gitlab` (gitignored); it stays the single home for that credential.
 */
export const ENV_FILE_NAMES = [
  '.env.repo-sync',
  '.env.git-sync',
  '.env.gitlab',
  '.env.git',
];

/**
 * @description Standard `.gitignore` entries used when bootstrapping new repositories.
 */
export const STANDARD_GITIGNORE_ENTRIES = [
  '.env',
  '.env.*',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '.DS_Store',
  'output/',
  'playwright-report/',
  'test-results/',
  '.idea/',
  '.vscode/',
  '*.log',
];

/**
 * @description Directory names skipped during repository discovery to avoid unnecessary traversal.
 */
export const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'output',
  'playwright-report',
  'test-results',
]);
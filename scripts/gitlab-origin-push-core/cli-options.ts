/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added CLI option parsing and defaults for GitLab origin push helper
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Expanded CLI options for provider-agnostic repository sync and bootstrap
 */

import path from 'node:path';
import type {
  CliOptions,
  RepoOwnerType,
  RepoProvider,
  RepoVisibility,
} from './contracts';
import { createGitLabOriginPushLogger } from './logger';

/**
 * @description CLI option parser and resolver for the repository sync helper.
 */
export class GitLabOriginPushCliOptions {
  private static readonly logger = createGitLabOriginPushLogger({
    component: 'GitLabOriginPushCliOptions',
  });

  /**
   * @description Parses CLI arguments into resolved runtime options.
   *
   * @param argv - Raw CLI arguments after the script path
   * @returns Fully resolved runtime options
   */
  public static parse(argv: string[]): CliOptions {
    const startedAt = Date.now();
    const parsedOptions: Partial<CliOptions> = {};

    for (let index = 0; index < argv.length; index += 1) {
      const currentArg = argv[index];
      const nextArg = argv[index + 1];

      if (currentArg === '--help' || currentArg === '-h') {
        parsedOptions.showHelp = true;
      } else if (currentArg === '--push') {
        parsedOptions.push = true;
      } else if (currentArg === '--root' && nextArg) {
        parsedOptions.rootDir = nextArg;
        index += 1;
      } else if (currentArg === '--remote' && nextArg) {
        parsedOptions.remoteName = nextArg;
        index += 1;
      } else if (currentArg === '--branch' && nextArg) {
        parsedOptions.branch = nextArg;
        index += 1;
      } else if (currentArg === '--max-depth' && nextArg) {
        parsedOptions.maxDepth = Number.parseInt(nextArg, 10);
        index += 1;
      } else if (currentArg === '--provider' && nextArg) {
        parsedOptions.provider = this.parseProvider(nextArg);
        index += 1;
      } else if (currentArg === '--host' && nextArg) {
        parsedOptions.host = nextArg;
        index += 1;
      } else if (currentArg === '--owner' && nextArg) {
        parsedOptions.owner = nextArg;
        index += 1;
      } else if (currentArg === '--owner-type' && nextArg) {
        parsedOptions.ownerType = this.parseOwnerType(nextArg);
        index += 1;
      } else if (currentArg === '--repo-name' && nextArg) {
        parsedOptions.repoName = nextArg;
        index += 1;
      } else if (currentArg === '--origin-url' && nextArg) {
        parsedOptions.originUrl = nextArg;
        index += 1;
      } else if (currentArg === '--visibility' && nextArg) {
        parsedOptions.visibility = this.parseVisibility(nextArg);
        index += 1;
      } else if (currentArg === '--api-base-url' && nextArg) {
        parsedOptions.apiBaseUrl = nextArg;
        index += 1;
      } else if (currentArg === '--description' && nextArg) {
        parsedOptions.description = nextArg;
        index += 1;
      } else if (currentArg === '--config-env-file' && nextArg) {
        parsedOptions.configEnvFile = nextArg;
        index += 1;
      } else if (currentArg === '--commit-message' && nextArg) {
        parsedOptions.commitMessage = nextArg;
        index += 1;
      }
    }

    const resolvedOptions = this.resolve(parsedOptions);
    this.logger.info(
      {
        argv,
        durationMs: Date.now() - startedAt,
        resolvedOptions,
      },
      'Parsed CLI options',
    );

    return resolvedOptions;
  }

  /**
   * @description Resolves partial runtime options into a complete option set.
   *
   * @param options - Partial runtime options supplied by callers or CLI parsing
   * @returns Resolved runtime options with defaults applied
   */
  public static resolve(options: Partial<CliOptions> = {}): CliOptions {
    const resolvedOptions = {
      apiBaseUrl: options.apiBaseUrl,
      branch: options.branch,
      commitMessage: options.commitMessage,
      configEnvFile: options.configEnvFile,
      description: options.description,
      host: options.host,
      maxDepth: Math.max(0, options.maxDepth ?? 2),
      originUrl: options.originUrl,
      owner: options.owner,
      ownerType: options.ownerType,
      provider: options.provider,
      push: options.push ?? false,
      remoteName: options.remoteName ?? 'origin',
      repoName: options.repoName,
      rootDir: path.resolve(options.rootDir ?? process.cwd()),
      showHelp: options.showHelp ?? false,
      visibility: options.visibility,
    } satisfies CliOptions;

    this.logger.info({ resolvedOptions }, 'Resolved CLI options');
    return resolvedOptions;
  }

  /**
   * @description Builds usage text for the CLI helper.
   *
   * @returns Human-readable usage text for `--help`
   */
  public static buildUsageText(): string {
    const usageText = [
      'Usage: ts-node -r tsconfig-paths/register scripts/gitlab-origin-push.ts [options]',
      '',
      'Options:',
      '  --push                    Perform a real sync instead of dry-run reporting',
      '  --root <path>             Root directory to scan or bootstrap',
      '  --max-depth <n>           Maximum directory depth to scan (default: 2)',
      '  --remote <name>           Remote name to inspect and push (default: origin)',
      '  --branch <name>           Override the branch to push or create',
      '  --provider <name>         Provider for new repos: github | gitlab | generic',
      '  --host <host>             Hostname for the remote provider (for example github.com)',
      '  --owner <name>            Owner, user, or namespace for new repositories',
      '  --owner-type <type>       Owner type: user | org',
      '  --repo-name <name>        Repository name used when provisioning a new remote',
      '  --origin-url <url>        Explicit origin URL to use when no remote exists',
      '  --visibility <value>      Repository visibility: private | public | internal',
      '  --api-base-url <url>      Provider API base URL override',
      '  --description <text>      Repository description for provider-backed creation',
      '  --config-env-file <path>  Explicit env file containing repo sync configuration',
      '  --commit-message <text>   Commit message used when auto-committing local changes',
      '  --help, -h                Show this help message',
    ].join('\n');

    this.logger.info({ usageText }, 'Generated CLI usage text');
    return usageText;
  }

  /**
   * @description Normalizes and validates provider arguments.
   *
   * @param value - Raw provider CLI argument
   * @returns Validated repository provider
   */
  private static parseProvider(value: string): RepoProvider {
    const normalizedValue = value.toLowerCase() as RepoProvider;

    if (['github', 'gitlab', 'generic', 'unknown'].includes(normalizedValue)) {
      return normalizedValue;
    }

    throw new Error(`Unsupported provider '${value}'`);
  }

  /**
   * @description Normalizes and validates owner-type arguments.
   *
   * @param value - Raw owner-type CLI argument
   * @returns Validated owner type
   */
  private static parseOwnerType(value: string): RepoOwnerType {
    const normalizedValue = value.toLowerCase() as RepoOwnerType;

    if (normalizedValue === 'user' || normalizedValue === 'org') {
      return normalizedValue;
    }

    throw new Error(`Unsupported owner type '${value}'`);
  }

  /**
   * @description Normalizes and validates visibility arguments.
   *
   * @param value - Raw visibility CLI argument
   * @returns Validated repository visibility
   */
  private static parseVisibility(value: string): RepoVisibility {
    const normalizedValue = value.toLowerCase() as RepoVisibility;

    if (['private', 'public', 'internal'].includes(normalizedValue)) {
      return normalizedValue;
    }

    throw new Error(`Unsupported visibility '${value}'`);
  }
}
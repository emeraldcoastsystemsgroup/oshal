/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added GoogleWorkspaceCliIntegration for gogcli-backed Google Workspace bot execution
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced gog dependency with repo-native Google Workspace CLI backed by official Google APIs
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: isolate each Google Workspace child to its agent-owned home, OS/network runtime settings, and exact Google configuration; controller/database/session and unrelated provider credentials are no longer inherited.
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { createChildLogger } from '@/shared/logger';

const execFileAsync = promisify(execFileCallback);
const logger = createChildLogger({ module: 'google-workspace-cli-integration' });

const DEFAULT_TIMEOUT_MS = 120_000;
const GOOGLE_WORKSPACE_PROCESS_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
] as const;
const GOOGLE_WORKSPACE_ENDPOINT_ENV_KEYS = [
  'GOOGLE_OAUTH_AUTH_BASE_URL',
  'GOOGLE_OAUTH_TOKEN_URL',
  'GOOGLE_OAUTH_REVOKE_URL',
  'GOOGLE_GMAIL_API_BASE_URL',
  'GOOGLE_DRIVE_API_BASE_URL',
  'GOOGLE_DOCS_API_BASE_URL',
  'GOOGLE_SHEETS_API_BASE_URL',
  'GOOGLE_SLIDES_API_BASE_URL',
  'GOOGLE_CALENDAR_API_BASE_URL',
] as const;

/**
 * @description Configuration that binds the Google Workspace CLI integration to a specific
 * agent and its isolated home directory, and supplies the OAuth client / service-account
 * credentials and scope/account overrides used to authenticate CLI invocations. Optional
 * fields fall back to process environment variables when omitted.
 */
export interface GoogleWorkspaceCliConfig {
  agentId: string;
  homeDir: string;
  clientId?: string;
  clientSecret?: string;
  accountEmail?: string;
  defaultAccount?: string;
  serviceAccountJson?: string;
  serviceAccountSubject?: string;
  redirectPort?: string;
  scopes?: string;
}

/**
 * @description Describes a single Google Workspace CLI invocation. Callers may pass either a
 * pre-split argument array or a raw command string (which is tokenized), opt into JSON output
 * parsing, override the working directory, and set a custom execution timeout.
 */
export interface GoogleWorkspaceCliRequest {
  command?: string;
  args?: string[];
  json?: boolean;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Build one Google Workspace CLI child's least-privilege environment.
 *
 * The agent-specific home replaces ambient user-profile paths so OAuth profiles cannot escape
 * into the controller account. Only settings consumed by the repo-native Google CLI are admitted;
 * each explicit config value wins over the corresponding deployment default.
 */
export function buildGoogleWorkspaceCliProcessEnv(
  config: Readonly<GoogleWorkspaceCliConfig>,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GOOGLE_WORKSPACE_PROCESS_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of GOOGLE_WORKSPACE_ENDPOINT_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }

  const homeDir = path.resolve(config.homeDir);
  Object.assign(env, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    OSHAL_GOOGLE_WORKSPACE_HOME: homeDir,
    OSHAL_AGENT_ID: config.agentId,
  });

  const googleSettings: Record<string, string | undefined> = {
    GOOGLE_CLIENT_ID: config.clientId || parent.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: config.clientSecret || parent.GOOGLE_CLIENT_SECRET,
    GOOGLE_ACCOUNT_EMAIL: config.accountEmail || parent.GOOGLE_ACCOUNT_EMAIL,
    GOG_ACCOUNT: config.defaultAccount || parent.GOG_ACCOUNT,
    GOOGLE_SERVICE_ACCOUNT_JSON: config.serviceAccountJson || parent.GOOGLE_SERVICE_ACCOUNT_JSON,
    GOOGLE_SERVICE_ACCOUNT_SUBJECT: config.serviceAccountSubject || parent.GOOGLE_SERVICE_ACCOUNT_SUBJECT,
    GOOGLE_REDIRECT_PORT: config.redirectPort || parent.GOOGLE_REDIRECT_PORT,
    GOOGLE_SCOPES: config.scopes || parent.GOOGLE_SCOPES,
  };
  for (const [key, value] of Object.entries(googleSettings)) {
    if (value) env[key] = value;
  }
  return env;
}

/**
 * @description Wraps the repo-native Google Workspace CLI (scripts/google-workspace-cli.js)
 * so agents can run Google Workspace operations as child processes inside a per-agent home
 * directory with credentials injected via the environment. Provides a healthcheck plus a
 * generic execute entry point that resolves the binary, builds arguments and environment,
 * and optionally parses JSON output.
 */
export class GoogleWorkspaceCliIntegration {
  constructor(private readonly config: GoogleWorkspaceCliConfig) {}

  /**
   * @description Verifies the CLI is runnable for this agent by invoking the "version"
   * command; failures are logged as warnings rather than thrown so callers can probe
   * availability safely.
   * @returns Resolves to true when the version command succeeds, false if it errors.
   */
  async healthcheck(): Promise<boolean> {
    try {
      await this.execute({ args: ['version'], json: true });
      return true;
    } catch (error) {
      logger.warn({ err: error, agentId: this.config.agentId }, 'Google Workspace CLI healthcheck failed');
      return false;
    }
  }

  /**
   * @description Runs a single Google Workspace CLI command as a Node child process, applying
   * the request's arguments/command, JSON flag, working directory, and timeout, with the
   * agent's credentials and home directory supplied through the environment.
   * @param request The CLI invocation describing args/command, JSON parsing, cwd, and timeout.
   * @returns Resolves to the resolved command string, final argument list, trimmed stdout and
   * stderr, and the parsed JSON payload when JSON output was requested.
   */
  async execute(request: GoogleWorkspaceCliRequest): Promise<{
    command: string;
    args: string[];
    stdout: string;
    stderr: string;
    json?: unknown;
  }> {
    const binaryPath = this.resolveCliPath();
    const args = this.resolveArgs(request);
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const { stdout, stderr } = await execFileAsync(process.execPath, [binaryPath, ...args], {
      cwd: request.cwd || this.config.homeDir,
      env: this.buildEnvironment(),
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });

    const trimmedStdout = String(stdout || '').trim();
    const trimmedStderr = String(stderr || '').trim();

    return {
      command: `${process.execPath} ${binaryPath}`,
      args,
      stdout: trimmedStdout,
      stderr: trimmedStderr,
      json: request.json ? this.tryParseJson(trimmedStdout) : undefined,
    };
  }

  private resolveCliPath(): string {
    return path.resolve(process.cwd(), 'scripts', 'google-workspace-cli.js');
  }

  private resolveArgs(request: GoogleWorkspaceCliRequest): string[] {
    const baseArgs = Array.isArray(request.args) && request.args.length > 0
      ? [...request.args]
      : this.tokenize(request.command);

    if (request.json && !baseArgs.includes('--json')) {
      baseArgs.push('--json');
    }

    if (this.config.defaultAccount && !baseArgs.includes('--profile')) {
      baseArgs.unshift(this.config.defaultAccount);
      baseArgs.unshift('--profile');
    }

    if (baseArgs.length === 0) {
      throw new Error('Google Workspace CLI execution requires either "args" or "command".');
    }

    return baseArgs;
  }

  private buildEnvironment(): NodeJS.ProcessEnv {
    fs.mkdirSync(this.config.homeDir, { recursive: true });
    return buildGoogleWorkspaceCliProcessEnv(this.config);
  }

  private tokenize(command?: string): string[] {
    if (!command || command.trim().length === 0) {
      return [];
    }

    const tokens: string[] = [];
    let current = '';
    let quote: '"' | '\'' | null = null;

    for (let index = 0; index < command.length; index += 1) {
      const char = command[index];
      const previous = index > 0 ? command[index - 1] : '';

      if ((char === '"' || char === '\'') && previous !== '\\') {
        if (quote === char) {
          quote = null;
          continue;
        }
        if (!quote) {
          quote = char;
          continue;
        }
      }

      if (!quote && /\s/.test(char)) {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
        continue;
      }

      if (char === '\\' && previous !== '\\' && index + 1 < command.length) {
        const next = command[index + 1];
        if (next === '"' || next === '\'' || /\s/.test(next)) {
          current += next;
          index += 1;
          continue;
        }
      }

      current += char;
    }

    if (quote) {
      throw new Error('Google Workspace CLI command contains an unclosed quote.');
    }

    if (current.length > 0) {
      tokens.push(current);
    }

    return tokens;
  }

  private tryParseJson(value: string): unknown {
    if (!value) {
      return [];
    }

    try {
      return JSON.parse(value);
    } catch (_error) {
      return undefined;
    }
  }
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added GoogleWorkspaceCliIntegration for gogcli-backed Google Workspace bot execution
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced gog dependency with repo-native Google Workspace CLI backed by official Google APIs
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { createChildLogger } from '@/shared/logger';

const execFileAsync = promisify(execFileCallback);
const logger = createChildLogger({ module: 'google-workspace-cli-integration' });

const DEFAULT_TIMEOUT_MS = 120_000;

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
    const homeDir = this.config.homeDir;
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    const pathValue = process.env.PATH || '';

    fs.mkdirSync(homeDir, { recursive: true });

    return {
      ...process.env,
      PATH: pathValue,
      OSHAL_GOOGLE_WORKSPACE_HOME: homeDir,
      GOOGLE_CLIENT_ID: this.config.clientId || process.env.GOOGLE_CLIENT_ID || '',
      GOOGLE_CLIENT_SECRET: this.config.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '',
      GOOGLE_ACCOUNT_EMAIL: this.config.accountEmail || process.env.GOOGLE_ACCOUNT_EMAIL || '',
      GOG_ACCOUNT: this.config.defaultAccount || process.env.GOG_ACCOUNT || '',
      GOOGLE_SERVICE_ACCOUNT_JSON: this.config.serviceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
      GOOGLE_SERVICE_ACCOUNT_SUBJECT: this.config.serviceAccountSubject || process.env.GOOGLE_SERVICE_ACCOUNT_SUBJECT || '',
      GOOGLE_REDIRECT_PORT: this.config.redirectPort || process.env.GOOGLE_REDIRECT_PORT || '',
      GOOGLE_SCOPES: this.config.scopes || process.env.GOOGLE_SCOPES || '',
      PATH_EXTENDED: pathValue ? `${pathValue}${pathSeparator}${homeDir}` : homeDir,
    };
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

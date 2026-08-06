/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ClaudeCodeCliHarnessAdapter — HarnessAdapter implementation wrapping Anthropic Claude Code CLI subprocess
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add --allowedTools, --add-dir, --mcp-config so claude-code bots can read/write workspace and use MCP tools
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Parse is_error from stdout JSON even when claude exits non-zero, and strip ANTHROPIC_API_KEY when it is an expired OAuth token so file-based (.credentials.json) auth takes over
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: pass task.creds to applyUserScoping so the caller's provided short-lived tokens land as .oshal-cred-<provider> files in the workspace.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: remove connector-credential propagation into the model-visible CLI environment/workspace; preserve exact caller identity scoping only.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Idle-based timeouts (operator directive 2026-07-24, extends ADR-081): the absolute 10-min kill terminated actively-working runs. Default output format is now stream-json (+ --verbose, required by print mode) so silence is measurable, and the adapter opts into BaseCliHarnessAdapter idleReset — timeoutMs bounds SILENCE (default 600000, CLAUDE_CODE_INACTIVITY_TIMEOUT_MS) with a 60-min runaway ceiling (CLAUDE_CODE_MAX_DURATION_MS, falling back to CLAUDE_CODE_TIMEOUT_MS). Explicit json/text output keeps absolute semantics with the ceiling as the default bound. parseJsonOutput already parses line-wise NDJSON, so result extraction is unchanged.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Streaming crash guard (adversarial review): under stream-json, parseJsonOutput finding no final `type:"result"` event means the CLI crashed/was-killed mid-stream — it now throws instead of returning the raw partial stdout as a successful text result (silent garbage). Batch json keeps the raw-text fallback.
 */

import fs from 'fs';
import path from 'path';
import { assertAuditedAutonomousHarness, buildConversationAwarePrompt, type HarnessTask, type HarnessResult } from './harness-adapter';
import { BaseCliHarnessAdapter } from './base-cli-harness-adapter';
import type { TokenUsage } from './llm-service';

const DEFAULT_BINARY = 'claude';
const DEFAULT_MODEL = 'claude-opus-4-6';
// Under stream-json (the default) this bounds SILENCE — 10 min of no output = stuck.
// Under explicit json/text batch output it is unused (the ceiling is the bound).
const DEFAULT_INACTIVITY_TIMEOUT_MS = 600_000; // 10 min of full silence
// Runaway ceiling regardless of activity (operator directive 2026-07-24: long,
// busy runs must survive; only genuinely-stuck or runaway processes die).
const DEFAULT_MAX_DURATION_MS = 3_600_000; // 60 min
// Bash excluded: unreliable when running as root in Docker containers.
// Claude should use native Write/Edit tools for file operations.
const DEFAULT_ALLOWED_TOOLS = 'Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch';
const DEFAULT_MCP_CONFIG_PATH = '/app/config-seed/claude-code-mcp.json';
// stdio MCP bridge that exposes a bot's swarm-registered (agent_tools) framework/app
// tools to the Claude Code harness, which otherwise only sees Bash + static MCP servers.
const TOOLS_MCP_BRIDGE_PATH = process.env.OSHAL_TOOLS_MCP_PATH || '/app/scripts/oshal-tools-mcp.js';
const PER_TASK_MCP_FILE = '.oshal-mcp.json';

/**
 * @description Configuration for the Claude Code CLI harness adapter.
 */
export interface ClaudeCodeCliHarnessConfig {
  /** Path to the `claude` binary.  Default: 'claude' (assumes PATH). */
  binaryPath?: string;

  /** Model override (e.g. 'claude-opus-4-6', 'claude-sonnet-4-6').
   *  Default: CLAUDE_CODE_MODEL env or 'claude-opus-4-6'. */
  model?: string;

  /** Task workspace root.  Default: CLINE_WORKSPACE_ROOT or './workspace'. */
  workspaceRoot?: string;

  /** Primary timeout in ms. Under stream-json (default) this bounds SILENCE
   *  (idle-based, ADR-081); under explicit json/text it is the absolute duration
   *  bound. Default: 600000 silence / 3600000 absolute. */
  timeoutMs?: number;

  /**
   * Output format passed to `claude --output-format`.
   * Default: 'stream-json' (env CLAUDE_CODE_OUTPUT_FORMAT) — streaming makes
   * silence measurable so the idle timeout only kills genuinely-stuck runs,
   * while still capturing real token telemetry from the final result event.
   */
  outputFormat?: 'text' | 'json' | 'stream-json';

  /**
   * Comma-separated list of built-in tools Claude is allowed to use without
   * per-call permission prompts. Passed via `--allowedTools`.
   * Default: Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch
   * Set to empty string to disable all tools (text-only mode).
   */
  allowedTools?: string;

  /**
   * Extra env keys deleted from the spawned CLI's environment on top of the always-scrubbed
   * master/connector secrets. Set for controller-INLINE bots — see
   * services/controller-inline-scope.ts.
   */
  scrubEnvKeys?: readonly string[];

  /**
   * Path to a JSON MCP server config file passed via `--mcp-config`.
   * Default: CLAUDE_MCP_CONFIG env var, then /app/config-seed/claude-code-mcp.json.
   * Set to empty string to skip MCP entirely.
   */
  mcpConfigPath?: string;

  /**
   * Additional directories to expose to Claude via `--add-dir`.
   * The task workspace directory is always added automatically.
   */
  extraDirs?: string[];
}

// Claude Code CLI JSON output shape (when --output-format json is used)
interface ClaudeCodeJsonResult {
  type?: string;
  result?: string;
  session_id?: string;
  cost_usd?: number;
  total_cost?: number;
  /** Field name used by the stream-json final result event. */
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  is_error?: boolean;
  error?: string;
}

/**
 * @description HarnessAdapter that wraps the Anthropic Claude Code CLI (`claude`) subprocess.
 *
 * Launches `claude --print --output-format json --model <model> "<prompt>"` inside a
 * task-scoped workspace directory and parses the structured JSON response.
 *
 * With `--output-format json` the Claude Code CLI emits a JSON object with:
 * - `result` — the agent's text output
 * - `usage` — real token telemetry (input_tokens, output_tokens, cache_*)
 * - `cost_usd` — real dollar cost (when available)
 *
 * Authentication: reads from `ANTHROPIC_API_KEY` env var.
 * If running in the OSHAL swarm, credentials are seeded from secrets.json by config-seed.
 *
 * @example Claude Code CLI invocation
 * ```
 * claude --print --output-format json --model claude-opus-4-6 "Implement the feature in TASK.md"
 * ```
 */
export class ClaudeCodeCliHarnessAdapter extends BaseCliHarnessAdapter {
  readonly harnessType = 'claude-code' as const;

  private readonly binaryPath: string;
  private readonly model: string;
  private readonly workspaceRoot: string;
  private readonly outputFormat: string;
  private readonly allowedTools: string;
  private readonly mcpConfigPath: string;
  private readonly extraDirs: string[];

  constructor(config: ClaudeCodeCliHarnessConfig = {}) {
    // Resolve output mode first: it decides the timeout SEMANTICS (idle vs absolute).
    const outputFormat = config.outputFormat
      ?? (process.env.CLAUDE_CODE_OUTPUT_FORMAT as 'text' | 'json' | 'stream-json' | undefined)
      ?? 'stream-json';
    const streaming = outputFormat === 'stream-json';
    const envTimeoutMs = process.env.CLAUDE_CODE_TIMEOUT_MS ? parseInt(process.env.CLAUDE_CODE_TIMEOUT_MS, 10) : undefined;
    const envMaxDurationMs = process.env.CLAUDE_CODE_MAX_DURATION_MS ? parseInt(process.env.CLAUDE_CODE_MAX_DURATION_MS, 10) : undefined;
    // Streaming runaway ceiling: the dedicated backstop knob first, then the
    // historical absolute knob, then the 60-min default.
    const streamCeilingMs = envMaxDurationMs ?? envTimeoutMs ?? DEFAULT_MAX_DURATION_MS;
    // Batch absolute bound: the historical absolute knob keeps precedence.
    const batchAbsoluteMs = config.timeoutMs ?? envTimeoutMs ?? envMaxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    // 10-min silence bound — only meaningful under streaming (idleReset).
    const inactivityMs = config.timeoutMs
      ?? (process.env.CLAUDE_CODE_INACTIVITY_TIMEOUT_MS ? parseInt(process.env.CLAUDE_CODE_INACTIVITY_TIMEOUT_MS, 10) : undefined)
      ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    super(
      'claude-code-cli-harness-adapter',
      streaming ? inactivityMs : batchAbsoluteMs,
      streaming
        ? { idleReset: true, maxDurationMs: streamCeilingMs, extraSecretEnvKeys: config.scrubEnvKeys }
        : { extraSecretEnvKeys: config.scrubEnvKeys },
    );

    this.binaryPath = config.binaryPath
      ?? process.env.CLAUDE_CODE_CLI_PATH
      ?? process.env.CLAUDE_CLI_PATH
      ?? DEFAULT_BINARY;

    this.model = config.model
      ?? process.env.CLAUDE_CODE_MODEL
      ?? process.env.LLM_MODEL
      ?? DEFAULT_MODEL;

    this.workspaceRoot = config.workspaceRoot
      ?? process.env.CLINE_WORKSPACE_ROOT
      ?? process.env.CLAUDE_WORKSPACE_ROOT
      ?? './workspace';

    this.outputFormat = outputFormat;

    this.allowedTools = config.allowedTools
      ?? process.env.CLAUDE_ALLOWED_TOOLS
      ?? DEFAULT_ALLOWED_TOOLS;

    // Resolve MCP config path: explicit config → env var → default path (only if file exists)
    const mcpCandidate = config.mcpConfigPath
      ?? process.env.CLAUDE_MCP_CONFIG
      ?? DEFAULT_MCP_CONFIG_PATH;
    this.mcpConfigPath = mcpCandidate && fs.existsSync(mcpCandidate) ? mcpCandidate : '';

    this.extraDirs = config.extraDirs ?? [];

    this.logger.info({
      binaryPath: this.binaryPath,
      model: this.model,
      workspaceRoot: this.workspaceRoot,
      timeoutMs: this.defaultTimeoutMs,
      outputFormat: this.outputFormat,
      allowedTools: this.allowedTools,
      mcpConfigPath: this.mcpConfigPath || '(none)',
      extraDirs: this.extraDirs,
      scrubbedEnvKeys: config.scrubEnvKeys?.length ?? 0,
    }, 'ClaudeCodeCliHarnessAdapter initialized');
  }

  /**
   * @description Executes the Claude Code CLI for one task and returns the result.
   */
  async run(task: HarnessTask): Promise<HarnessResult> {
    assertAuditedAutonomousHarness(this.harnessType);
    const workspacePath = this.resolveWorkspacePath(task.taskId);
    fs.mkdirSync(workspacePath, { recursive: true });

    const model = task.model ?? this.model;
    // Per-task tool provisioning: bridge the bot's swarm-registered tools into Claude Code.
    const bridge = this.resolveToolBridge(task, workspacePath);
    const args = this.buildArgs(task, workspacePath, model, bridge);
    // The (potentially large) prompt goes on stdin, not argv — see buildArgs / E2BIG note.
    const promptInput = buildConversationAwarePrompt(task);
    const env = this.buildEnv(workspacePath);
    const releaseUserScoping = await this.acquireUserScopingLease(
      env, workspacePath, task.userSub,
    );

    this.logger.info({
      binaryPath: this.binaryPath,
      taskId: task.taskId,
      agentId: task.agentId,
      workspacePath,
      model,
      outputFormat: this.outputFormat,
    }, 'ClaudeCodeCliHarnessAdapter: spawning Claude Code CLI');

    // Spawn with CWD = workspaceRoot so claude's Write tool scope covers the entire shared workspace.
    // The task-specific subdirectory path is communicated via the prompt; task isolation is by convention.
    // Wipe the per-request cred/scoping files the instant the subprocess exits (success OR
    // throw) — they're only needed while the shelled tools run. Privileged-runtime hygiene.
    const { stdout, stderr, exitCode } = await (async () => {
      try { return await this.execCapturing(this.binaryPath, args, env, this.workspaceRoot, undefined, promptInput); }
      finally { releaseUserScoping(); this.wipeToolBridge(workspacePath); }
    })();

    if (stderr.trim()) {
      this.logger.warn({ stderr: stderr.slice(0, 500), taskId: task.taskId }, 'Claude Code CLI produced stderr output');
    }

    // claude --print emits JSON to stdout for both success and auth errors (is_error:true).
    // Only after parsing should we fall back to raising the exit code, so operators see the
    // real CLI message (e.g. "Invalid API key · Fix external API key") instead of a naked exit code.
    if (this.outputFormat === 'json' || this.outputFormat === 'stream-json') {
      try {
        return this.parseJsonOutput(stdout, model, task.taskId);
      } catch (parseErr) {
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(
            `ClaudeCodeCliHarnessAdapter: claude exited with code ${exitCode}. ${(parseErr as Error).message}. stderr: ${stderr.slice(0, 500)}`,
          );
        }
        throw parseErr;
      }
    }

    if (exitCode !== 0 && exitCode !== null) {
      throw new Error(
        `ClaudeCodeCliHarnessAdapter: claude exited with code ${exitCode}. stderr: ${stderr.slice(0, 500)}`,
      );
    }

    // Plain text output
    const text = stdout.trim();
    if (!text) {
      throw new Error(`ClaudeCodeCliHarnessAdapter: Claude Code CLI produced no output for task ${task.taskId ?? 'unknown'}`);
    }

    this.logger.info({
      taskId: task.taskId,
      outputLength: text.length,
    }, 'ClaudeCodeCliHarnessAdapter: task complete (text mode)');

    return {
      text,
      usage: this.estimateUsage(task.prompt, text),
      model,
      stopReason: 'end_turn',
    };
  }

  // healthCheck() is inherited from BaseCliHarnessAdapter — uses
  // healthCheckBinary() below to probe `<binaryPath> --version`.

  protected override healthCheckBinary(): string | null {
    return this.binaryPath;
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private resolveWorkspacePath(taskId?: string): string {
    if (!taskId) {
      return path.resolve(this.workspaceRoot, `claude-${Date.now()}`);
    }
    return path.resolve(this.workspaceRoot, taskId);
  }

  /**
   * @description Per-task tool provisioning. Bridges the bot's swarm-registered
   * (agent_tools) framework/app tools — e.g. `career_database` — into Claude Code
   * by writing a per-task MCP config that adds the `oshal-tools` stdio server
   * (scripts/oshal-tools-mcp.mjs), scoped to this bot + user via env, and extends
   * allowedTools with `mcp__oshal-tools`. Falls back to the static config when the
   * bot id, service secret, or bridge script isn't available (fail-open to today's
   * behaviour, never breaks the run).
   */
  private resolveToolBridge(task: HarnessTask, workspacePath: string): { mcpConfigPath: string; allowedTools: string } {
    const fallback = { mcpConfigPath: this.mcpConfigPath, allowedTools: this.allowedTools };
    const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
    if (!task.agentId || !secret || !fs.existsSync(TOOLS_MCP_BRIDGE_PATH)) {
      return fallback;
    }
    try {
      let base: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
      if (this.mcpConfigPath) {
        try { base = JSON.parse(fs.readFileSync(this.mcpConfigPath, 'utf-8')) as typeof base; } catch { base = {}; }
      }
      const servers: Record<string, unknown> = (base.mcpServers && typeof base.mcpServers === 'object')
        ? { ...(base.mcpServers as Record<string, unknown>) }
        : {};
      const apiBase = process.env.OSHAL_API_BASE || `http://localhost:${process.env.PORT || '5000'}`;
      servers['oshal-tools'] = {
        command: 'node',
        args: [TOOLS_MCP_BRIDGE_PATH],
        env: {
          OSHAL_API_BASE: apiBase,
          SWARM_SERVICE_SECRET: secret,
          OSHAL_AGENT_ID: task.agentId,
          OSHAL_USER_SUB: task.userSub || '',
          OSHAL_TASK_ID: task.taskId || '',
        },
      };
      const perTaskPath = path.join(workspacePath, PER_TASK_MCP_FILE);
      fs.writeFileSync(perTaskPath, JSON.stringify({ ...base, mcpServers: servers }, null, 2));
      const allowedTools = this.allowedTools ? `${this.allowedTools},mcp__oshal-tools` : 'mcp__oshal-tools';
      this.logger.info({ agentId: task.agentId, perTaskPath }, 'Claude Code tool bridge: oshal-tools MCP wired for bot');
      return { mcpConfigPath: perTaskPath, allowedTools };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'Claude Code tool bridge: per-task MCP build failed; using static config');
      return fallback;
    }
  }

  /** Remove the per-task MCP config (it carries the service secret) after the run. */
  private wipeToolBridge(workspacePath: string): void {
    try { fs.rmSync(path.join(workspacePath, PER_TASK_MCP_FILE), { force: true }); } catch { /* best-effort */ }
  }

  private buildArgs(
    task: HarnessTask,
    workspacePath: string,
    model: string,
    bridge: { mcpConfigPath: string; allowedTools: string },
  ): string[] {
    // Note: cwd is set via spawn options, NOT via a CLI flag (--cwd does not exist).
    // --dangerously-skip-permissions is blocked when running as root (Docker containers).
    // Use --allowedTools to pre-authorize specific tools so claude doesn't prompt for permission.
    // Use --bare to bypass keychain/OAuth reads and require ANTHROPIC_API_KEY directly (container-safe).
    // --bare is intentionally NOT used: it blocks keychain/OAuth reads, breaking containers
    // that authenticate via the ~/.claude OAuth session (mounted from host in local dev).
    // For CI/K8s with a real ANTHROPIC_API_KEY, --bare works; for local dev it breaks auth.
    // Without --bare: claude reads ~/.claude for OAuth (local dev) or ANTHROPIC_API_KEY (CI).
    const args = [
      '--print',
      '--output-format', this.outputFormat,
      '--model', model,
    ];

    // stream-json in print mode requires --verbose (the CLI rejects it otherwise).
    if (this.outputFormat === 'stream-json') {
      args.push('--verbose');
    }

    // Pre-authorize tools so claude can read/write files and run bash without interactive prompts.
    // bridge.allowedTools is the static set plus `mcp__oshal-tools` when the bot has registry tools.
    if (bridge.allowedTools) {
      args.push('--allowedTools', bridge.allowedTools);
    }

    // --add-dir tells claude to look for CLAUDE.md in these directories.
    // Write permissions are controlled by the spawn CWD (set to workspaceRoot below).
    args.push('--add-dir', this.workspaceRoot);
    args.push('--add-dir', workspacePath);

    // Expose any additional directories (e.g. shared workspace root)
    for (const dir of this.extraDirs) {
      if (dir) args.push('--add-dir', dir);
    }

    // Wire in MCP servers (fetch, google-search, oshal-tools, etc.) if a config file is present.
    // bridge.mcpConfigPath is the per-task merged config (base + oshal-tools) when applicable.
    if (bridge.mcpConfigPath) {
      args.push('--mcp-config', bridge.mcpConfigPath);
    }

    if (task.systemPrompt) {
      args.push('--system-prompt', task.systemPrompt);
    }

    // The prompt is delivered on STDIN (see run()), NOT as a positional argv. A large
    // conversation-aware prompt passed as an argument overflows the OS ARG_MAX and the spawn
    // fails with E2BIG; `claude --print` reads the prompt from stdin when no positional is given.
    return args;
  }

  private buildEnv(workspacePath: string): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> };

    // If ANTHROPIC_API_KEY looks like an OAuth access token (sk-ant-oat01-…) and we have
    // a valid ~/.claude/.credentials.json present, strip the env var so the CLI falls
    // through to file-based auth. OAuth tokens set as ANTHROPIC_API_KEY are treated as
    // permanent API keys by the CLI — but they actually expire in ~8h, which is the
    // single most common source of silent "Invalid API key" failures in long-running bots.
    const envKey = typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY : '';
    if (envKey.startsWith('sk-ant-oat01-') && this.hasValidCredentialsFile()) {
      this.logger.info({ taskId: workspacePath }, 'Stripping OAuth-style ANTHROPIC_API_KEY env var; using ~/.claude/.credentials.json instead');
      delete env.ANTHROPIC_API_KEY;
    } else {
      env.ANTHROPIC_API_KEY = envKey;
    }
    env.CLAUDE_WORKSPACE = workspacePath;

    // PWD must match the spawn CWD (workspaceRoot) so Write tool path validation
    // aligns with the actual process working directory. Setting PWD to a task
    // subdirectory caused claude to refuse writes to workspace-root-level paths.
    env.PWD = this.workspaceRoot;

    return env;
  }

  private hasValidCredentialsFile(): boolean {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) return false;
    const credsPath = path.join(homeDir, '.claude', '.credentials.json');
    if (!fs.existsSync(credsPath)) return false;
    try {
      const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf-8')) as Record<string, unknown>;
      const oauth = (parsed.claudeAiOauth && typeof parsed.claudeAiOauth === 'object')
        ? parsed.claudeAiOauth as Record<string, unknown>
        : null;
      if (!oauth) return false;
      const accessToken = typeof oauth.accessToken === 'string' ? oauth.accessToken : '';
      const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
      return accessToken.length > 0 && (expiresAt === 0 || Date.now() < expiresAt);
    } catch {
      return false;
    }
  }

  /**
   * @description Parses JSON output from Claude Code CLI (`--output-format json`).
   * Extracts text result and real token usage from the structured response.
   */
  private parseJsonOutput(stdout: string, model: string, taskId?: string): HarnessResult {
    // Claude Code CLI with --output-format json may emit multiple JSON objects
    // (one per stream event) — we want the last `result` type object
    const lines = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{'));
    let finalResult: ClaudeCodeJsonResult | null = null;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ClaudeCodeJsonResult;
        if (parsed.type === 'result' || parsed.result !== undefined) {
          finalResult = parsed;
        }
      } catch {
        // non-JSON line — skip
      }
    }

    // If no structured result found, treat the entire stdout as plain text — EXCEPT under
    // stream-json, where a completed run always ends with a `type:"result"` event. Its
    // absence there means the CLI crashed/was-killed mid-stream, so the raw-text fallback
    // would masquerade as success (silent garbage). Fail LOUDLY in streaming mode instead
    // (2026-07-24 idle-timeout review, mirrors the JS twin's streaming crash guard).
    if (!finalResult) {
      const text = stdout.trim();
      if (!text) {
        throw new Error(`ClaudeCodeCliHarnessAdapter: no output from Claude Code CLI for task ${taskId ?? 'unknown'}`);
      }
      if (this.outputFormat === 'stream-json') {
        throw new Error(
          `ClaudeCodeCliHarnessAdapter: stream-json output ended without a final result event ` +
          `for task ${taskId ?? 'unknown'} — the CLI crashed or was killed mid-stream ` +
          `(captured ${text.length} chars of partial output).`,
        );
      }
      this.logger.warn({ taskId }, 'ClaudeCodeCliHarnessAdapter: no JSON result found, using raw stdout as text');
      return {
        text,
        usage: { inputTokens: 0, outputTokens: 0 },
        model,
        stopReason: 'end_turn',
      };
    }

    if (finalResult.is_error) {
      // CLI packs its operator-facing message into `result` (e.g. "Invalid API key · Fix external API key",
      // "Not logged in · Please run /login"). Surface that verbatim so dashboards can show a real reason.
      const detail = finalResult.result || finalResult.error || 'unknown';
      throw new Error(`ClaudeCodeCliHarnessAdapter: Claude Code CLI reported error: ${detail}`);
    }

    const text = finalResult.result ?? '';
    if (!text) {
      throw new Error(`ClaudeCodeCliHarnessAdapter: Claude Code CLI JSON result has empty 'result' field`);
    }

    const rawUsage = finalResult.usage;
    const usage: TokenUsage = {
      inputTokens: rawUsage?.input_tokens ?? 0,
      outputTokens: rawUsage?.output_tokens ?? 0,
      cacheReadTokens: rawUsage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: rawUsage?.cache_creation_input_tokens ?? 0,
    };
    usage.totalTokens = usage.inputTokens + usage.outputTokens;

    this.logger.info({
      taskId,
      outputLength: text.length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: finalResult.cost_usd ?? finalResult.total_cost_usd ?? finalResult.total_cost,
    }, 'ClaudeCodeCliHarnessAdapter: task complete (json mode)');

    return {
      text,
      usage,
      model,
      stopReason: 'end_turn',
    };
  }

  // estimateUsage / execWithTimeout / execCapturing are inherited from
  // BaseCliHarnessAdapter — same shape across all CLI harnesses.
}

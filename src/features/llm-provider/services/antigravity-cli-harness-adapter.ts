/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — AntigravityCliHarnessAdapter wraps Google's Antigravity CLI (`agy`) as a registered harness beside `gemini-cli`, so both Google terminal agents are selectable configuration and either can be a fallback rung. Flags, auth and the JSON envelope are taken from the published headless documentation (antigravity.google/docs/cli/headless, /docs/cli/install) rather than inferred: `-p` for the prompt, `--output-format json`, `--model`, `--effort`, `--print-timeout`. The JSON envelope is a SINGLE object — conversation_id / status / response / error / duration_seconds / num_turns / usage — not the JSONL the gemini-cli adapter tolerates, and `status` is authoritative over the exit code, so a SUCCESS-shaped exit with status ERROR still fails. `--dangerously-skip-permissions` is deliberately never passed: it auto-approves every tool call, which is the opposite of this repo's fail-closed harness posture.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | blockingReason(): the musl wall, MEASURED rather than assumed. The installer asks for manifests/linux_amd64_musl.json (404) and the glibc artifact is a PIE against /lib64/ld-linux-x86-64.so.2 that fails to relocate under gcompat on node:20-alpine (__open, __lseek, __read, pvalloc: symbol not found), proven in a throwaway container. The harness is registered and selectable, and on a musl node it now refuses with that sentence instead of an ENOENT on a file that exists - the confusion the cline 3.x glibc build already cost this project once.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { assertAuditedAutonomousHarness, buildConversationAwarePrompt, type HarnessTask, type HarnessResult } from './harness-adapter';
import { BaseCliHarnessAdapter } from './base-cli-harness-adapter';
import type { TokenUsage } from './llm-service';

/** The installer drops the binary as `agy`, not `antigravity`. */
const DEFAULT_BINARY = 'agy';
/** `agy models` is the source of truth for this deployment; this is only the unset fallback. */
const DEFAULT_MODEL = 'gemini-3.8-flash';
/**
 * Absolute duration bound, matching the other CLI harnesses' operator-directed 60-minute ceiling
 * (2026-07-24: never hard-stop an actively-working run at a short wall clock). The CLI's own
 * `--print-timeout` defaults to five minutes, so it is always passed explicitly — otherwise a long
 * run dies inside the CLI before this bound is ever reached.
 */
const DEFAULT_TIMEOUT_MS = 3_600_000;

/** Terminal states the CLI reports in `status`. Only SUCCESS is a completed answer. */
const TERMINAL_FAILURE_STATES = new Set(['ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID']);
/** Non-terminal states: the run did not finish, which is a failure for a batch invocation. */
const NON_TERMINAL_STATES = new Set(['WAITING', 'RUNNING']);

/**
 * @description Configuration for the Antigravity CLI harness adapter.
 *
 * Install (container boot or host): `curl -fsSL https://antigravity.google/cli/install.sh | bash`,
 * which places `agy` at `~/.local/bin/agy`.
 *
 * Auth, and the part that silently fails if missed: the published documentation states that
 * "only setting a GEMINI_API_KEY environment variable on its own has no effect" — the CLI also
 * requires a settings file naming the provider. This adapter writes that file when it is absent
 * (see {@link ensureProviderSettings}) so a keyed container does not fail closed for a reason no
 * log line would explain.
 */
export interface AntigravityCliHarnessConfig {
  /** Path to the `agy` binary. Default: ANTIGRAVITY_CLI_PATH, else 'agy' (assumes PATH). */
  binaryPath?: string;

  /** Model override. Default: ANTIGRAVITY_MODEL, else GEMINI_MODEL, else {@link DEFAULT_MODEL}. */
  model?: string;

  /** Reasoning effort the CLI accepts: 'low' | 'medium' | 'high'. Omitted unless configured. */
  effort?: 'low' | 'medium' | 'high';

  /** Task workspace root. Default: ANTIGRAVITY_WORKSPACE_ROOT, else the shared workspace. */
  workspaceRoot?: string;

  /** Max execution time in ms. Default: ANTIGRAVITY_TIMEOUT_MS, else 3600000. */
  timeoutMs?: number;

  /** Output format. Default 'json'; 'text' skips parsing and returns stdout verbatim. */
  outputFormat?: 'text' | 'json';

  /** Where the provider settings file lives. Default: ~/.gemini/antigravity-cli/settings.json. */
  settingsPath?: string;
}

/** The single JSON object `--output-format json` emits. Field names are the CLI's, verbatim. */
interface AntigravityJsonResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * @description HarnessAdapter wrapping Google's Antigravity CLI (`agy`) subprocess.
 *
 * Spawns `agy -p "<prompt>" --output-format json --model <model> --print-timeout <n>m` inside the
 * task workspace and reads the single JSON envelope it returns.
 *
 * This is a sibling of {@link GeminiCliHarnessAdapter}, not a replacement: both are registered
 * CLI harnesses over the same Google key, and either can be selected or used as a fallback rung.
 * Unattended execution remains gated by `assertAuditedAutonomousHarness`, exactly as every other
 * CLI harness in this inventory.
 */
export class AntigravityCliHarnessAdapter extends BaseCliHarnessAdapter {
  readonly harnessType = 'antigravity-cli' as const;

  private readonly binaryPath: string;
  private readonly model: string;
  private readonly effort?: 'low' | 'medium' | 'high';
  private readonly workspaceRoot: string;
  private readonly outputFormat: 'text' | 'json';
  private readonly settingsPath: string;

  constructor(config: AntigravityCliHarnessConfig = {}) {
    const timeoutMs = config.timeoutMs
      ?? (process.env.ANTIGRAVITY_TIMEOUT_MS ? parseInt(process.env.ANTIGRAVITY_TIMEOUT_MS, 10) : undefined)
      ?? DEFAULT_TIMEOUT_MS;
    super('antigravity-cli-harness-adapter', timeoutMs);

    this.binaryPath = config.binaryPath
      ?? process.env.ANTIGRAVITY_CLI_PATH
      ?? DEFAULT_BINARY;

    this.model = config.model
      ?? process.env.ANTIGRAVITY_MODEL
      ?? process.env.GEMINI_MODEL
      ?? DEFAULT_MODEL;

    const configuredEffort = config.effort ?? (process.env.ANTIGRAVITY_EFFORT as AntigravityCliHarnessConfig['effort']);
    this.effort = configuredEffort === 'low' || configuredEffort === 'medium' || configuredEffort === 'high'
      ? configuredEffort
      : undefined;

    this.workspaceRoot = config.workspaceRoot
      ?? process.env.ANTIGRAVITY_WORKSPACE_ROOT
      ?? process.env.CLINE_WORKSPACE_ROOT
      ?? './workspace';

    this.outputFormat = config.outputFormat ?? 'json';

    this.settingsPath = config.settingsPath
      ?? process.env.ANTIGRAVITY_SETTINGS_PATH
      ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');

    this.logger.info({
      binaryPath: this.binaryPath,
      model: this.model,
      effort: this.effort ?? 'cli-default',
      workspaceRoot: this.workspaceRoot,
      timeoutMs: this.defaultTimeoutMs,
      outputFormat: this.outputFormat,
      settingsPath: this.settingsPath,
    }, 'AntigravityCliHarnessAdapter initialized');
  }

  protected override healthCheckBinary(): string | null {
    return this.binaryPath;
  }

  /**
   * @description Why this harness cannot run here, or null when nothing is known to block it.
   *
   * MEASURED 2026-09-18, not inferred. Google publishes no musl build of the Antigravity CLI: the
   * installer detects musl and requests `manifests/linux_amd64_musl.json`, which returns 404, and
   * the glibc artifact it would otherwise fetch is a dynamically-linked PIE against
   * `/lib64/ld-linux-x86-64.so.2` that fails to relocate on this image even with `gcompat`
   * installed (`__open`, `__lseek`, `__read`, `pvalloc`: symbol not found).
   *
   * This is stated here so selecting the harness on a musl node fails with the real cause instead
   * of an ENOENT on a file that exists — the exact confusion the cline 3.x glibc build already
   * cost this project once.
   *
   * @returns A human-readable blocking reason, or null.
   */
  blockingReason(): string | null {
    if (process.platform !== 'linux') return null;
    const musl = fs.existsSync('/lib/libc.musl-x86_64.so.1') || fs.existsSync('/lib/libc.musl-aarch64.so.1');
    if (!musl) return null;
    return 'Antigravity CLI ships no musl build (manifests/linux_amd64_musl.json is 404) and its glibc '
      + 'binary does not relocate under gcompat. Run this harness on a glibc-based node, or select '
      + 'gemini-cli, which is npm-installed and runs here.';
  }

  /**
   * @description Run one task through the Antigravity CLI.
   * @param task - The harness task (prompt, system prompt, ids, workspace hints).
   * @returns The parsed answer with token usage.
   */
  async run(task: HarnessTask): Promise<HarnessResult> {
    assertAuditedAutonomousHarness(this.harnessType);
    const blocked = this.blockingReason();
    if (blocked) {
      // Fail with the measured cause, immediately, rather than letting spawn report ENOENT on a
      // binary that is present but unrunnable.
      throw new Error(`AntigravityCliHarnessAdapter: ${blocked}`);
    }
    const workspacePath = this.resolveWorkspacePath(task.taskId);
    fs.mkdirSync(workspacePath, { recursive: true });
    this.ensureProviderSettings();

    const model = task.model ?? this.model;
    const args = this.buildArgs(task, model);
    const env = this.buildEnv(workspacePath);
    const releaseUserScoping = await this.acquireUserScopingLease(env, workspacePath, task.userSub);

    this.logger.info({
      binaryPath: this.binaryPath,
      taskId: task.taskId,
      agentId: task.agentId,
      workspacePath,
      model,
      outputFormat: this.outputFormat,
    }, 'AntigravityCliHarnessAdapter: spawning Antigravity CLI');

    const { stdout, stderr, exitCode } = await (async () => {
      try { return await this.execCapturing(this.binaryPath, args, env, this.workspaceRoot); }
      finally { releaseUserScoping(); }
    })();

    if (stderr.trim()) {
      this.logger.warn({ stderr: stderr.slice(0, 500), taskId: task.taskId }, 'Antigravity CLI produced stderr output');
    }

    if (this.outputFormat === 'json') {
      return this.parseJsonOutput(stdout, model, exitCode, stderr, task.taskId);
    }

    if (exitCode !== 0 && exitCode !== null) {
      throw new Error(
        `AntigravityCliHarnessAdapter: agy exited with code ${exitCode}. stderr: ${stderr.slice(0, 500)}`,
      );
    }

    const text = stdout.trim();
    if (!text) {
      throw new Error(`AntigravityCliHarnessAdapter: Antigravity CLI produced no output for task ${task.taskId ?? 'unknown'}`);
    }

    this.logger.info({ taskId: task.taskId, outputLength: text.length }, 'AntigravityCliHarnessAdapter: task complete (text mode)');
    return { text, usage: this.estimateUsage(task.prompt, text), model, stopReason: 'end_turn' };
  }

  // ── private helpers ───────────────────────────────────────────────────────

  private resolveWorkspacePath(taskId?: string): string {
    if (!taskId) return path.resolve(this.workspaceRoot, `antigravity-${Date.now()}`);
    return path.resolve(this.workspaceRoot, taskId);
  }

  /**
   * @description Write the provider settings file when it is absent.
   *
   * This exists because of one documented sentence: "Only setting a GEMINI_API_KEY environment
   * variable on its own has no effect." A container with a perfectly good key and no settings file
   * fails for a reason nothing in our logs would explain, so the adapter closes that gap itself and
   * says so. An EXISTING file is never rewritten — an operator's own configuration wins.
   */
  private ensureProviderSettings(): void {
    try {
      if (fs.existsSync(this.settingsPath)) return;
      fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
      fs.writeFileSync(this.settingsPath, `${JSON.stringify({ modelProvider: 'gemini' }, null, 2)}\n`, 'utf8');
      this.logger.info({ settingsPath: this.settingsPath }, 'AntigravityCliHarnessAdapter: wrote the provider settings file (GEMINI_API_KEY alone has no effect without it)');
    } catch (err) {
      // Not fatal on its own — the CLI may be configured another way — but it is the likeliest
      // cause of an otherwise inexplicable auth failure, so it is logged rather than swallowed.
      this.logger.warn(
        { err: (err as Error).message, settingsPath: this.settingsPath },
        'AntigravityCliHarnessAdapter: could not ensure the provider settings file; an API-key-only container may fail to authenticate',
      );
    }
  }

  /**
   * @description Build the headless argument vector.
   * @param task - The task being run.
   * @param model - The resolved model id.
   * @returns The args for `agy`.
   */
  private buildArgs(task: HarnessTask, model: string): string[] {
    // Documented headless form (antigravity.google/docs/cli/headless):
    //   agy -p "<prompt>" --output-format json --model <model> --print-timeout 10m
    //
    // - `-p` (aliases --print/--prompt) is the headless flag.
    // - `--output-format` accepts text | json | stream-json.
    // - `--print-timeout` defaults to 5m inside the CLI, so it is always passed: otherwise the
    //   CLI kills a long run well before this adapter's own ceiling.
    // - `--effort` is only passed when configured; the CLI's own default is otherwise respected.
    // - `--dangerously-skip-permissions` is NEVER passed. It auto-approves every tool call, which
    //   contradicts the fail-closed posture the audited-harness guard enforces above.
    const args: string[] = ['--model', model, '--print-timeout', this.printTimeoutArg()];

    if (this.outputFormat === 'json') args.push('--output-format', 'json');
    if (this.effort) args.push('--effort', this.effort);

    // There is no dedicated system-prompt flag in the headless form, so the system prompt is
    // composed into the single prompt value — the same shape the gemini-cli adapter uses.
    const userPrompt = buildConversationAwarePrompt(task);
    const composedPrompt = task.systemPrompt
      ? `## System instructions\n${task.systemPrompt}\n\n## Request\n${userPrompt}`
      : userPrompt;

    args.push('-p', composedPrompt);
    return args;
  }

  /** @description The CLI's `--print-timeout` value in whole minutes, floor 1. @returns e.g. '60m'. */
  private printTimeoutArg(): string {
    return `${Math.max(1, Math.round(this.defaultTimeoutMs / 60_000))}m`;
  }

  private buildEnv(workspacePath: string): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    // The CLI authenticates with GEMINI_API_KEY (same key as the gemini-cli harness), paired with
    // the settings file ensureProviderSettings writes. GOOGLE_GEMINI_BASE_URL overrides the
    // endpoint when a deployment fronts the API; both are passed through untouched.
    env.ANTIGRAVITY_WORKSPACE = workspacePath;
    env.PWD = this.workspaceRoot;
    return env;
  }

  /**
   * @description Parse the single JSON envelope. `status` is authoritative: a zero exit code with
   * status ERROR is still a failure, and a non-terminal status means the run never finished.
   * @param stdout - Raw stdout.
   * @param model - The model that ran.
   * @param exitCode - The process exit code.
   * @param stderr - Raw stderr, for the failure message.
   * @param taskId - The task id, for logging.
   * @returns The harness result.
   */
  private parseJsonOutput(
    stdout: string, model: string, exitCode: number | null, stderr: string, taskId?: string,
  ): HarnessResult {
    const raw = stdout.trim();
    let parsed: AntigravityJsonResult | null = null;
    try {
      parsed = JSON.parse(raw) as AntigravityJsonResult;
    } catch {
      // A single object is the documented shape; tolerate a trailing-line emission rather than
      // failing a good answer on a banner line.
      const candidate = raw.split('\n').reverse().find((line) => line.trim().startsWith('{'));
      if (candidate) {
        try { parsed = JSON.parse(candidate) as AntigravityJsonResult; } catch { parsed = null; }
      }
    }

    if (!parsed) {
      throw new Error(
        `AntigravityCliHarnessAdapter: could not parse the JSON envelope for task ${taskId ?? 'unknown'} `
        + `(exit ${exitCode ?? 'null'}). stderr: ${stderr.slice(0, 500)}`,
      );
    }

    const status = String(parsed.status ?? '').toUpperCase();
    if (TERMINAL_FAILURE_STATES.has(status)) {
      throw new Error(
        `AntigravityCliHarnessAdapter: Antigravity CLI reported status ${status}: ${parsed.error ?? 'no error detail'}`,
      );
    }
    if (NON_TERMINAL_STATES.has(status)) {
      throw new Error(
        `AntigravityCliHarnessAdapter: Antigravity CLI did not finish (status ${status}) for task ${taskId ?? 'unknown'}`,
      );
    }
    if (exitCode !== 0 && exitCode !== null) {
      throw new Error(
        `AntigravityCliHarnessAdapter: agy exited with code ${exitCode} (status ${status || 'absent'}). stderr: ${stderr.slice(0, 500)}`,
      );
    }

    const text = parsed.response ?? '';
    if (!text.trim()) {
      throw new Error(`AntigravityCliHarnessAdapter: Antigravity CLI returned an empty response for task ${taskId ?? 'unknown'}`);
    }

    const rawUsage = parsed.usage ?? {};
    const inputTokens = rawUsage.input_tokens ?? 0;
    const outputTokens = rawUsage.output_tokens ?? 0;
    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens: rawUsage.cache_read_tokens ?? 0,
      // The CLI reports its own total, which includes thinking tokens the two visible counts omit.
      totalTokens: rawUsage.total_tokens ?? inputTokens + outputTokens,
    };

    this.logger.info({
      taskId,
      conversationId: parsed.conversation_id,
      outputLength: text.length,
      numTurns: parsed.num_turns,
      durationSeconds: parsed.duration_seconds,
      inputTokens,
      outputTokens,
      thinkingTokens: rawUsage.thinking_tokens ?? 0,
    }, 'AntigravityCliHarnessAdapter: task complete (json mode)');

    return { text, usage, model, stopReason: 'end_turn' };
  }
}

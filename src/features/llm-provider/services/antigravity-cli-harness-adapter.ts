/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — AntigravityCliHarnessAdapter wraps Google's Antigravity CLI (`agy`) as a registered harness beside `gemini-cli`, so both Google terminal agents are selectable configuration api-side. Neither is a usable fallback RUNG: HARNESS_BY_ID gives both botNodeRuntime: null, and a rung resolves through resolveBotNodeSwitch, which answers null for an id that is neither a built runtime nor a ProviderRegistry provider id (the registry has "gemini", not "gemini-cli"). Flags, auth and the JSON envelope are taken from the published headless documentation (antigravity.google/docs/cli/headless, /docs/cli/install) rather than inferred: `-p` for the prompt, `--output-format json`, `--model`, `--effort`, `--print-timeout`. The JSON envelope is a SINGLE object — conversation_id / status / response / error / duration_seconds / num_turns / usage — not the JSONL the gemini-cli adapter tolerates, and `status` is authoritative over the exit code, so a SUCCESS-shaped exit with status ERROR still fails. `--dangerously-skip-permissions` is deliberately never passed: it auto-approves every tool call, which is the opposite of this repo's fail-closed harness posture.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | blockingReason(): the musl wall, MEASURED rather than assumed. The installer asks for manifests/linux_amd64_musl.json (404) and the glibc artifact is a PIE against /lib64/ld-linux-x86-64.so.2 that fails to relocate under gcompat on node:20-alpine (__open, __lseek, __read, pvalloc: symbol not found), proven in a throwaway container. The harness is registered and selectable, and on a musl node it now refuses with that sentence instead of an ENOENT on a file that exists - the confusion the cline 3.x glibc build already cost this project once.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | A non-numeric ANTIGRAVITY_TIMEOUT_MS produced NaN, not the default. `??` falls through on null and undefined only, and parseInt returns NaN for anything unparseable, so a typo in the env reached both the adapter ceiling and the CLI flag as the literal string "NaNm". Parsed and validated once: finite and positive, or the default. Also corrects the "usable as a fallback rung" claim in entry 1 - HARNESS_BY_ID gives this harness botNodeRuntime: null, so no bot node resolves it and no rung is built for it.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Do not create a config tree in a person's home directory uninvited. The default settings path is ~/.gemini/antigravity-cli/settings.json, which on a host run is the operator's REAL Gemini CLI configuration directory and in the shipped stack is inside a read-only bind mount - so the previous unconditional mkdirSync+writeFileSync both touched the operator's machine and could not work where it was aimed. The file is now written only when the deployment named the path (ANTIGRAVITY_SETTINGS_PATH or the constructor) or the directory already exists; otherwise it says what to set and returns. An existing file is still never rewritten.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | "status is authoritative" was implemented as a four-name DENYLIST, so it only held for the four statuses already known. Any status the vendor adds, renames or misspells reached the caller with exit 0 and was returned as the model's answer - the precise failure the guard was written to prevent, one unknown name away from firing. Inverted to an allowlist: SUCCESS completes, an absent status is tolerated because the text output mode emits none, and everything else throws carrying the raw status and parsed.error.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Bound the argv prompt, because this adapter reintroduces a failure mode the repo already fixed live. Linux caps a single argument at MAX_ARG_STRLEN (128 KiB) independently of ARG_MAX, and the Codex adapter passing a prompt as argv killed every Dungeon Master turn with spawn E2BIG once the conversation grew; both siblings now use stdin. Whether `agy -p` reads stdin when its value is omitted could NOT be tested here - the binary does not run on this image at all - so rather than assert an untested claim, the argv path stays with an explicit 96 KiB bound and a refusal that names the cause. Not truncated: a silently shortened prompt answers a different question than the one asked. Switching to stdin is the first thing to try on a glibc node.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | The measured musl cause reached NO surface. blockingReason() is consumed in run(), and run() is unreachable - assertAuditedAutonomousHarness throws first for every CLI harness by the fail-closed posture - so the diagnosis this adapter went and measured could never be shown to anyone, and the only message an operator saw was the generic unbrokered-CLI refusal, which says nothing about why THIS harness will not start. healthCheck() is not behind that guard, so it now reports false with the reason logged, and skips the pointless `agy --version` probe on a node where the binary is present and cannot relocate.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | CKR-17 step 2: the harness-specific override still wins, but the fallback beneath it resolves through resolveSharedWorkspaceRoot() instead of reading one variable and then defaulting to the RELATIVE "./workspace" - a relative default resolves against whatever cwd the process happens to have, which is not the shared mount under any compose file.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | blockingReason() delegates to antigravity-cli-availability. The musl diagnosis had exactly one reader - this adapter - and a surface deciding whether to OFFER an Antigravity brain needs the same answer without importing an execution-stack module onto the controller graph. The measurement and its wording are unchanged; they simply live where both callers can reach them.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { assertAuditedAutonomousHarness, buildConversationAwarePrompt, type HarnessTask, type HarnessResult } from './harness-adapter';
import { BaseCliHarnessAdapter } from './base-cli-harness-adapter';
import type { TokenUsage } from './llm-service';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import { antigravityMuslBlockingReason } from './antigravity-cli-availability';

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
/**
 * Largest prompt this adapter will hand to `agy` as an argv value.
 *
 * Linux caps a SINGLE argument at `MAX_ARG_STRLEN` = 32 pages = 128 KiB, independently of the
 * much larger total `ARG_MAX`. Exceeding it is `spawn E2BIG`, which this repo has already paid
 * for live: the Codex adapter passed the prompt as a positional argv and every Dungeon Master
 * turn died once the conversation grew (see codex-cli-harness-adapter change-log 8). Both
 * siblings now deliver the prompt on stdin.
 *
 * This adapter cannot yet do the same, and the reason is measured rather than assumed: `agy`
 * documents `-p <prompt>` as a flag that TAKES its value, and whether omitting the value makes it
 * read stdin could not be tested here — the binary does not run on this image at all (no musl
 * build; see blockingReason). So the argv path stays, with an explicit bound and a legible
 * refusal, and switching to stdin is the first thing to try once a glibc node exists.
 */
const MAX_ARGV_PROMPT_BYTES = 96 * 1024;

/**
 * Terminal failure states the CLI is documented to report, kept so each gets its own message.
 * They are NOT the gate: the gate is an allowlist in parseJsonOutput, because a denylist lets
 * an unknown status through as a successful answer.
 */
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
 * CLI harnesses over the same Google key. Either can be SELECTED; neither can be a fallback rung,
 * because both carry botNodeRuntime: null and therefore resolve to no runtime at a bot node.
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
  /** True when a deployment named the path, rather than it falling back to the user's home. */
  private readonly settingsPathIsDeclared: boolean;

  constructor(config: AntigravityCliHarnessConfig = {}) {
    // `??` catches null and undefined, NOT NaN - so a non-numeric ANTIGRAVITY_TIMEOUT_MS used to
    // survive as NaN all the way into `--print-timeout NaNm` and the adapter's own ceiling.
    // Validate instead of coalescing: anything that is not a finite positive number is not a
    // timeout, whether it arrived from the env or from a caller's config.
    const configured = config.timeoutMs ?? Number(process.env.ANTIGRAVITY_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
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
      ?? resolveSharedWorkspaceRoot();

    this.outputFormat = config.outputFormat ?? 'json';

    const declaredSettingsPath = config.settingsPath ?? process.env.ANTIGRAVITY_SETTINGS_PATH;
    this.settingsPathIsDeclared = Boolean(declaredSettingsPath);
    this.settingsPath = declaredSettingsPath
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
    // Delegated so the harness and the settings surface answer from ONE probe. A surface that has
    // to decide whether to OFFER this harness cannot import the adapter (it would pull the
    // execution stack onto the controller graph), and two copies of a measured fact is how one of
    // them goes stale.
    return antigravityMuslBlockingReason();
  }

  /**
   * @description Run one task through the Antigravity CLI.
   * @param task - The harness task (prompt, system prompt, ids, workspace hints).
   * @returns The parsed answer with token usage.
   */
  /**
   * @description Report this harness unhealthy, WITH the measured cause, when the node cannot run
   * the binary at all.
   *
   * `blockingReason()` is consumed in `run()` — which is unreachable: `assertAuditedAutonomousHarness`
   * throws first, for every CLI harness, by the fail-closed posture. So the musl diagnosis this
   * adapter went and measured appeared on no surface an operator could ever see, and the only
   * message they would get is the generic unbrokered-CLI refusal, which says nothing about why
   * THIS harness in particular will not start.
   *
   * The health check is not behind that guard, so it is where the cause belongs. Probing
   * `agy --version` on a musl node is also pointless: the binary is present and cannot relocate,
   * which is precisely the confusion that cost this project weeks on the cline 3.x glibc build.
   * @returns False with the reason logged when the node is blocked; otherwise the base probe.
   */
  async healthCheck(): Promise<boolean> {
    const blocked = this.blockingReason();
    if (blocked) {
      this.logger.warn(
        { harnessType: this.harnessType, binaryPath: this.binaryPath, blockingReason: blocked },
        `Antigravity CLI cannot run on this node: ${blocked}`,
      );
      return false;
    }
    return super.healthCheck();
  }

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
      // Never CREATE a configuration tree inside a person's home directory that they did not ask
      // for. The default path is the operator's real Gemini CLI config directory on a host run
      // (and a read-only bind mount in the shipped stack), so the adapter writes there only when
      // the directory already exists — otherwise a deployment must name the path explicitly via
      // ANTIGRAVITY_SETTINGS_PATH, which is what the compose stack does.
      const parent = path.dirname(this.settingsPath);
      if (!this.settingsPathIsDeclared && !fs.existsSync(parent)) {
        this.logger.info(
          { settingsPath: this.settingsPath },
          'AntigravityCliHarnessAdapter: not creating a provider settings file under the user home; set ANTIGRAVITY_SETTINGS_PATH to have one written',
        );
        return;
      }
      fs.mkdirSync(parent, { recursive: true });
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

    // Fail with the cause named, rather than as `spawn E2BIG` from deep inside the runtime.
    // Truncating instead would silently answer a different question than the one asked.
    const promptBytes = Buffer.byteLength(composedPrompt, 'utf8');
    if (promptBytes > MAX_ARGV_PROMPT_BYTES) {
      throw new Error(
        `AntigravityCliHarnessAdapter: prompt is ${promptBytes} bytes, over the ${MAX_ARGV_PROMPT_BYTES}-byte `
        + 'limit for a single argv value (Linux MAX_ARG_STRLEN is 128 KiB). This adapter passes the prompt '
        + 'via -p; the sibling Codex and Claude Code adapters deliver it on stdin for exactly this reason.',
      );
    }

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
    // An ALLOWLIST, not a denylist. The two sets above name the statuses we happen to know, and
    // the comment on them has always said "only SUCCESS is a completed answer" - but the code
    // tested membership of four failure names, so any status the vendor adds, renames or
    // misspells arrived here with exit 0 and was handed back AS THE MODEL'S ANSWER. That is the
    // exact shape this adapter's own guard was written to prevent, one name away.
    //
    // An ABSENT status is tolerated deliberately: the text output mode emits no envelope status,
    // and exit 0 with a body is the only signal available there.
    if (status && status !== 'SUCCESS') {
      throw new Error(
        `AntigravityCliHarnessAdapter: unrecognised Antigravity CLI status ${status} for task ${taskId ?? 'unknown'} `
        + `(exit ${exitCode ?? 'null'}): ${parsed.error ?? 'no error detail'}`,
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

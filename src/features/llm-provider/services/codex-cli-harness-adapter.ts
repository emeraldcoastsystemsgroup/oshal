/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CodexCliHarnessAdapter — HarnessAdapter implementation wrapping OpenAI Codex CLI subprocess
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched to `codex exec --json`, added ChatGPT OAuth auth.json bridge, and aligned sandbox handling with current CLI
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: pass task.creds to applyUserScoping so the caller's provided short-lived tokens land as .oshal-cred-<provider> files in the workspace.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Hardening-backlog #12: DEFAULT_SANDBOX_MODE danger-full-access → read-only (least-privilege fallback). The swarm opts into full access explicitly via CODEX_SANDBOX_MODE in compose, so the live deployment is unchanged; only an unconfigured run loses silent host-write.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081: idle-based timeout — `codex exec --json` streams JSONL, so the timer now bounds SILENCE (default 10 min, CODEX_INACTIVITY_TIMEOUT_MS) instead of total runtime, with a 2h max-duration backstop (CODEX_MAX_DURATION_MS). Fixes the 2026-07-06 incident where two actively-working dev runs were killed mid-typecheck at the absolute 600s cap.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Token-stranding fix: the CLI rotates its SINGLE-USE refresh_token in the per-task auth.json COPY and nothing wrote it back — one mid-run refresh bricked codex auth swarm-wide until a host re-login. Now snapshot the per-task auth.json and CAS-write-back a rotation to the shared source (codex-auth-write-back.ts) INSIDE the prime-gated closure, so the primer's fresh token is persisted before the gate opens.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review hardening: (1) the snapshot moved AFTER acquireUserScopingLease — pre-lease it baselines a stale chain for queued same-workspace runs, whose own rotation would then CAS-fail and re-strand the token; (2) gate waiters now RE-SEED an untouched per-task copy from the advanced source before spawning (reseedFromAdvancedSource) — they seeded pre-queue from the pre-rotation file, so without this the whole cold-start burst still died on the spent refresh token.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | E2BIG fix: the prompt was passed as a positional argv (`args.push(prompt)`), so a large conversation-aware prompt overflowed the OS ARG_MAX and the spawn died with `spawn E2BIG` — observed LIVE killing every Dungeon Master turn once the session context grew (invokeDungeonMaster → task-orchestrator → this adapter). Now delivered on STDIN (buildArgs drops the positional; execCodexLenient takes an `input` and forwards it to execCapturing) — `codex exec` reads its instructions from stdin when no positional PROMPT is given, mirroring the ClaudeCodeCliHarnessAdapter which piped stdin for the same reason.
 */

import fs from 'fs';
import path from 'path';
import { buildConversationAwarePrompt, type HarnessTask, type HarnessResult } from './harness-adapter';
import { BaseCliHarnessAdapter } from './base-cli-harness-adapter';
import { reseedFromAdvancedSource, snapshotCodexAuth, writeBackRotatedCodexAuth } from './codex-auth-write-back';
import type { TokenUsage } from './llm-service';

const DEFAULT_BINARY = 'codex';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-5.3-codex';
// Idle semantics (ADR-081): `codex exec --json` streams JSONL events continuously, so the
// timeout means MAX SILENCE, not total duration — 10 min with zero output = stuck. An
// actively-working run streams and is never killed until the max-duration backstop.
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min of SILENCE — see idleReset in the base adapter
const DEFAULT_MAX_DURATION_MS = 7_200_000; // 2h runaway backstop for still-streaming runs
// Hardening-backlog #12: default to the LEAST privilege. Full access is opt-in via
// CODEX_SANDBOX_MODE — the compose deployment sets it to danger-full-access explicitly
// for the swarm (docker-compose.oshal-local.yml), so this only changes the fallback for
// an unconfigured/fresh run, which should not silently get host-write access.
const DEFAULT_SANDBOX_MODE = 'read-only';
const APP_OPENAI_CODEX_CREDENTIALS_KEY = 'openAiCodexOauthCredentials';
const CLINE_OPENAI_CODEX_CREDENTIALS_KEY = 'openai-codex-oauth-credentials';

interface CodexJsonUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

interface CodexJsonEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
  };
  usage?: CodexJsonUsage;
}

interface CodexCredentialPayload {
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  refreshToken?: string;
  id_token?: string;
  idToken?: string;
  accountId?: string;
}

/**
 * @description Configuration for the Codex CLI harness adapter.
 */
export interface CodexCliHarnessConfig {
  /** Path to the `codex` binary.  Default: 'codex' (assumes PATH). */
  binaryPath?: string;

  /** Model override (e.g. 'gpt-5.3-codex').  Default: CODEX_MODEL env or repo default. */
  model?: string;

  /** Task workspace root.  Default: CLINE_WORKSPACE_ROOT or './workspace'. */
  workspaceRoot?: string;

  /** Max execution time in ms.  Default: 600000. */
  timeoutMs?: number;

  /**
   * Legacy config kept for backward compatibility with earlier Codex adapter wiring.
   * It is mapped to a sandbox mode when `sandboxMode` is not set.
   */
  approvalPolicy?: 'suggest' | 'auto-edit' | 'full-auto';

  /**
   * Codex sandbox mode used by `codex exec -s`.
   * Default: CODEX_SANDBOX_MODE env or `danger-full-access`.
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

/**
 * @description HarnessAdapter that wraps the OpenAI Codex CLI (`codex exec`) subprocess.
 *
 * The current CLI uses `codex exec --json` for non-interactive runs. This adapter:
 *   1. Creates a task-scoped workspace
 *   2. Seeds a writable Codex runtime home with ChatGPT OAuth auth.json
 *   3. Runs `codex exec --json`
 *   4. Parses JSONL events into HarnessResult + token usage
 */

// ── Boot-storm guard (module-level; shared across every CodexCliHarnessAdapter spawn) ──
// A ChatGPT-login auth.json carries a SINGLE-USE refresh_token. When the swarm fires many
// codex spawns at once (the content-topics prewarm at boot is the usual trigger), they all
// read the shared /root/.codex/auth.json and, if the access token needs refreshing, race to
// spend that one refresh_token — one wins and all the others die with
// "refresh token was already used. Please log out and sign in again." (a scary burst of ~20
// errors in the first ~90s, even though a single call works fine).
//
// Fix: serialize codex spawns ONLY until the first one returns. The CLI actually runs against
// a PER-TASK COPY of auth.json (see ensureRuntimeHome/buildEnv), so a refresh lands in that
// copy — the gated closure in run() therefore CAS-writes a rotation back to the shared source
// (codex-auth-write-back.ts) BEFORE the primer resolves, making the token genuinely fresh in
// the shared file by the time the gate opens. Waiters seeded their copies BEFORE queueing
// (from the pre-rotation source), so on release each one re-seeds its still-untouched copy
// from the advanced source (reseedFromAdvancedSource) before spawning. After that first
// success the gate opens permanently and concurrency is unrestricted — so this costs a few
// seconds on cold start and nothing in steady state. A spawn that THROWS (auth failure)
// leaves the gate closed so the next call retries serialized rather than storming. Escape
// hatch: CODEX_PRIME_GATE=off restores the old unrestricted behavior.
let codexTokenPrimed = false;
let codexPriming: Promise<void> | null = null;

async function withCodexPrimeGate<T>(spawn: () => Promise<T>): Promise<T> {
  // Cold start: exactly ONE spawn runs at a time until one proves the token (refreshing the
  // shared auth.json alone), then the gate opens and everyone else runs concurrently — they no
  // longer need to refresh, so there's no race to spend the single-use token.
  while (!codexTokenPrimed && process.env.CODEX_PRIME_GATE !== 'off') {
    if (codexPriming) {
      await codexPriming;   // another spawn is proving the token — wait, then re-check (it may have failed)
      continue;
    }
    let signalDone: () => void = () => {};
    codexPriming = new Promise<void>((resolve) => { signalDone = resolve; });
    try {
      const result = await spawn();
      codexTokenPrimed = true;   // token proven fresh in the shared file → open the gate for all
      return result;
    } catch (err) {
      codexPriming = null;       // failed → the next waiter becomes the primer (still serialized, no storm)
      throw err;
    } finally {
      signalDone();              // release waiters so they loop and re-check the gate
    }
  }
  return spawn();                // primed (or disabled) → unrestricted concurrency
}

export class CodexCliHarnessAdapter extends BaseCliHarnessAdapter {
  readonly harnessType = 'codex-cli' as const;

  private readonly binaryPath: string;
  private readonly model: string;
  private readonly workspaceRoot: string;
  private readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';

  constructor(config: CodexCliHarnessConfig = {}) {
    // Idle timeout (max silence). CODEX_INACTIVITY_TIMEOUT_MS is the explicit knob; the
    // legacy CODEX_TIMEOUT_MS still works as a fallback but now bounds SILENCE, not total
    // runtime (the JS bot-node path reads CODEX_TIMEOUT_MS separately with absolute
    // semantics — the env names are shared, the runtimes are not).
    const timeoutMs = config.timeoutMs
      ?? (process.env.CODEX_INACTIVITY_TIMEOUT_MS ? parseInt(process.env.CODEX_INACTIVITY_TIMEOUT_MS, 10) : undefined)
      ?? (process.env.CODEX_TIMEOUT_MS ? parseInt(process.env.CODEX_TIMEOUT_MS, 10) : undefined)
      ?? DEFAULT_TIMEOUT_MS;
    const maxDurationMs = process.env.CODEX_MAX_DURATION_MS
      ? parseInt(process.env.CODEX_MAX_DURATION_MS, 10)
      : DEFAULT_MAX_DURATION_MS;
    super('codex-cli-harness-adapter', timeoutMs, { idleReset: true, maxDurationMs });

    this.binaryPath = config.binaryPath
      ?? process.env.CODEX_CLI_PATH
      ?? DEFAULT_BINARY;

    this.model = config.model
      ?? process.env.CODEX_MODEL
      ?? process.env.LLM_MODEL
      ?? DEFAULT_MODEL;

    this.workspaceRoot = config.workspaceRoot
      ?? process.env.CLINE_WORKSPACE_ROOT
      ?? process.env.CODEX_WORKSPACE_ROOT
      ?? './workspace';

    this.sandboxMode = config.sandboxMode
      ?? (process.env.CODEX_SANDBOX_MODE as CodexCliHarnessConfig['sandboxMode'] | undefined)
      ?? this.mapApprovalPolicyToSandbox(config.approvalPolicy ?? process.env.CODEX_APPROVAL_POLICY)
      ?? DEFAULT_SANDBOX_MODE;

    this.logger.info({
      binaryPath: this.binaryPath,
      model: this.model,
      workspaceRoot: this.workspaceRoot,
      idleTimeoutMs: this.defaultTimeoutMs,
      maxDurationMs: this.maxDurationMs,
      sandboxMode: this.sandboxMode,
    }, 'CodexCliHarnessAdapter initialized (idle-based timeout — output activity resets the timer)');
  }

  /**
   * @description Executes the Codex CLI for one task and returns the result.
   */
  async run(task: HarnessTask): Promise<HarnessResult> {
    const workspacePath = this.resolveWorkspacePath(task.taskId);
    fs.mkdirSync(workspacePath, { recursive: true });

    if (task.systemPrompt) {
      fs.writeFileSync(
        path.join(workspacePath, 'CODEX_INSTRUCTIONS.md'),
        task.systemPrompt,
        'utf8',
      );
    }


    const prompt = this.buildPrompt(task);
    const runtimeHome = this.ensureRuntimeHome(workspacePath);
    const perTaskAuthPath = path.join(runtimeHome, '.codex', 'auth.json');
    const model = task.model ?? this.model;
    const args = this.buildArgs(workspacePath, model);
    const env = this.buildEnv(workspacePath, runtimeHome);
    const releaseUserScoping = await this.acquireUserScopingLease(
      env, workspacePath, task.userSub, task.creds,
    );
    // Pre-run snapshot of the per-task auth.json — taken AFTER the per-workspace lease so a
    // queued same-workspace run baselines the PREVIOUS run's rotation, not a stale chain
    // (snapshotting before the lease would CAS-fail this run's own rotation later). The CLI
    // rotates its single-use refresh token IN THIS COPY; after the run we compare against
    // this snapshot and CAS the rotation back to the shared source (codex-auth-write-back.ts).
    let authSnapshot = snapshotCodexAuth(perTaskAuthPath);

    try {
      this.logger.info({
        binaryPath: this.binaryPath,
        args: args.slice(0, 8),
        taskId: task.taskId,
        agentId: task.agentId,
        workspacePath,
        runtimeHome,
        model,
        sandboxMode: this.sandboxMode,
      }, 'CodexCliHarnessAdapter: spawning Codex CLI');

      // Serialize the cold-start spawn behind the boot-storm guard so a burst of concurrent
      // codex runs can't race the single-use ChatGPT refresh_token (see withCodexPrimeGate).
      const { stdout, stderr, code } = await withCodexPrimeGate(async () => {
        // A waiter released by the gate seeded its per-task copy BEFORE queueing, i.e. from
        // the pre-rotation source whose refresh token the primer just spent. Re-seed an
        // untouched copy from the (now fresh) source so the waiter spawns on the live chain
        // instead of dying with "refresh token was already used".
        authSnapshot = reseedFromAdvancedSource(
          perTaskAuthPath, this.resolveSourceAuthPath(), authSnapshot, this.logger,
        );
        try {
          // Prompt via STDIN, not argv (E2BIG fix — see buildArgs).
          return await this.execCodexLenient(this.binaryPath, args, env, workspacePath, undefined, prompt);
        } finally {
          // Inside the gated closure ON PURPOSE: the primer's rotation must reach the shared
          // source before the gate opens, so waiters' re-seed above finds the fresh chain.
          // Runs in finally because the CLI can refresh successfully and still fail the
          // turn (quota, sandbox).
          writeBackRotatedCodexAuth(
            perTaskAuthPath, this.resolveSourceAuthPath(), authSnapshot, this.logger,
          );
        }
      });

      if (stderr.trim()) {
        this.logger.warn({ stderr: stderr.slice(0, 500), taskId: task.taskId, code }, 'Codex CLI produced stderr output');
      }

      const parsed = this.parseJsonOutput(stdout, prompt, workspacePath, task.taskId, model);
      this.logger.info({
        taskId: task.taskId,
        outputLength: parsed.text.length,
        inputTokens: parsed.usage.inputTokens,
        outputTokens: parsed.usage.outputTokens,
        cacheReadTokens: parsed.usage.cacheReadTokens ?? 0,
        exitCode: code,
      }, 'CodexCliHarnessAdapter: task complete');

      return parsed;
    } finally {
      // Privileged-runtime hygiene: wipe the per-request cred/scoping files post-task.
      releaseUserScoping();
    }
  }

  // healthCheck() is inherited from BaseCliHarnessAdapter — uses
  // healthCheckBinary() below to probe `<binaryPath> --version`.

  protected override healthCheckBinary(): string | null {
    return this.binaryPath;
  }

  private resolveWorkspacePath(taskId?: string): string {
    if (!taskId) {
      return path.resolve(this.workspaceRoot, `codex-${Date.now()}`);
    }
    return path.resolve(this.workspaceRoot, taskId);
  }

  private buildPrompt(task: HarnessTask): string {
    const enrichedPrompt = buildConversationAwarePrompt(task);
    if (!task.systemPrompt) {
      return enrichedPrompt;
    }
    return `${task.systemPrompt}\n\n${enrichedPrompt}`;
  }

  private buildArgs(workspacePath: string, model: string): string[] {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s', this.sandboxMode,
      '-m', model,
      '-C', workspacePath,
    ];

    if (path.resolve(this.workspaceRoot) !== path.resolve(workspacePath)) {
      args.push('--add-dir', this.workspaceRoot);
    }

    // The prompt is delivered on STDIN (see run() → execCodexLenient input), NOT as a positional
    // argv. `codex exec` with no positional PROMPT reads its instructions from stdin, and a large
    // conversation-aware prompt as an argument overflows the OS ARG_MAX so the spawn fails with
    // E2BIG (observed live: the Dungeon Master's accumulated context killed every DM turn). Mirrors
    // the ClaudeCodeCliHarnessAdapter stdin delivery for the same reason.
    return args;
  }

  private buildEnv(workspacePath: string, runtimeHome: string): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> };

    env.OPENAI_API_KEY = env.OPENAI_API_KEY ?? env.CODEX_API_KEY ?? '';
    env.CODEX_WORKSPACE = workspacePath;
    env.HOME = runtimeHome;

    return env;
  }

  private ensureRuntimeHome(workspacePath: string): string {
    const runtimeHome = path.join(workspacePath, '.codex-home');
    const authDir = path.join(runtimeHome, '.codex');
    const authPath = path.join(authDir, 'auth.json');

    fs.mkdirSync(authDir, { recursive: true });

    if (fs.existsSync(authPath)) {
      return runtimeHome;
    }

    const sourceAuthPath = this.resolveSourceAuthPath();
    if (sourceAuthPath && fs.existsSync(sourceAuthPath)) {
      fs.copyFileSync(sourceAuthPath, authPath);
      this.logger.info({ authPath, sourceAuthPath }, 'Seeded Codex auth.json from mounted host credentials');
      return runtimeHome;
    }

    const credentialPayload = this.loadCredentialPayload();
    if (credentialPayload) {
      fs.writeFileSync(authPath, JSON.stringify(this.buildAuthFilePayload(credentialPayload), null, 2), 'utf8');
      this.logger.info({ authPath }, 'Seeded Codex auth.json from stored OpenAI Codex OAuth credentials');
    }

    return runtimeHome;
  }

  private resolveSourceAuthPath(): string | null {
    const explicit = process.env.CODEX_AUTH_SOURCE_PATH;
    if (explicit && explicit.trim().length > 0) {
      return explicit.trim();
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (!homeDir) {
      return null;
    }

    return path.join(homeDir, '.codex', 'auth.json');
  }

  private loadCredentialPayload(): CodexCredentialPayload | null {
    const secretsFiles = [
      path.join(process.env.CONFIG_OUTPUT_DIR || './output', 'secrets.json'),
      process.env.OPENAI_CODEX_SHARED_SEED_PATH || '/app/config-seed/secrets.json',
    ];

    for (const filePath of secretsFiles) {
      try {
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const blob = parsed[APP_OPENAI_CODEX_CREDENTIALS_KEY] ?? parsed[CLINE_OPENAI_CODEX_CREDENTIALS_KEY];
        if (typeof blob !== 'string' || blob.trim().length === 0) {
          continue;
        }
        const payload = JSON.parse(blob) as CodexCredentialPayload;
        const accessToken = payload.access_token || payload.accessToken;
        const refreshToken = payload.refresh_token || payload.refreshToken;
        const idToken = payload.id_token || payload.idToken;
        if (!accessToken || !refreshToken || !idToken) {
          continue;
        }
        return payload;
      } catch (error) {
        this.logger.warn({ err: error, filePath }, 'Failed to read OpenAI Codex credential seed');
      }
    }

    return null;
  }

  private buildAuthFilePayload(payload: CodexCredentialPayload): Record<string, unknown> {
    return {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: payload.access_token || payload.accessToken,
        refresh_token: payload.refresh_token || payload.refreshToken,
        id_token: payload.id_token || payload.idToken,
        account_id: payload.accountId,
      },
    };
  }

  private parseJsonOutput(
    stdout: string,
    prompt: string,
    workspacePath: string,
    taskId: string | undefined,
    model: string,
  ): HarnessResult {
    const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
    let text = '';
    let usage: CodexJsonUsage | null = null;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as CodexJsonEvent;
        if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message' && parsed.item.text) {
          text = parsed.item.text;
        }
        if (parsed.type === 'turn.completed' && parsed.usage) {
          usage = parsed.usage;
        }
      } catch {
        // Ignore malformed lines from mixed stdout.
      }
    }

    if (!text) {
      text = this.readTaskOutputFile(workspacePath);
    }

    if (!text) {
      throw new Error(`CodexCliHarnessAdapter: Codex CLI produced no output for task ${taskId ?? 'unknown'}`);
    }

    const normalizedUsage: TokenUsage = usage
      ? {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          cacheReadTokens: usage.cached_input_tokens ?? 0,
        }
      : this.estimateUsage(prompt, text);

    return {
      text,
      usage: normalizedUsage,
      model,
      stopReason: 'end_turn',
    };
  }

  /**
   * @description After Codex CLI completes, look for any .md or .txt task output
   * files written by the agent to the workspace.  Returns empty string if none found.
   */
  private readTaskOutputFile(workspacePath: string): string {
    const candidates = ['RESULT.md', 'OUTPUT.md', 'result.md', 'output.txt', 'TASK_RESULT.md'];
    for (const candidate of candidates) {
      const filePath = path.join(workspacePath, candidate);
      if (fs.existsSync(filePath)) {
        try {
          return fs.readFileSync(filePath, 'utf8').trim();
        } catch {
          // continue checking other candidates
        }
      }
    }
    return '';
  }

  // estimateUsage() is inherited from BaseCliHarnessAdapter.

  private mapApprovalPolicyToSandbox(
    approvalPolicy?: string,
  ): 'read-only' | 'workspace-write' | 'danger-full-access' | null {
    if (!approvalPolicy) {
      return null;
    }
    if (approvalPolicy === 'full-auto') {
      return 'danger-full-access';
    }
    if (approvalPolicy === 'auto-edit') {
      return 'workspace-write';
    }
    if (approvalPolicy === 'suggest') {
      return 'read-only';
    }
    return null;
  }

  /**
   * @description Codex-specific lenient exec: rejects only when the process
   * exited non-zero AND stdout was empty. The CLI sometimes returns non-zero
   * with usable JSONL output on stdout (sandbox warnings, partial completion),
   * so we let the parser decide whether the run was useful. Builds on the
   * base `execCapturing` for the actual subprocess plumbing.
   *
   * Distinct from the base's `execWithTimeout` (which throws on any non-zero
   * exit) — different semantics, hence different name.
   */
  private async execCodexLenient(
    binary: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
    timeoutMs?: number,
    input?: string,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await this.execCapturing(binary, args, env, cwd, timeoutMs, input);
    const normalizedCode = result.exitCode ?? 1;
    if (normalizedCode !== 0 && result.stdout.trim().length === 0) {
      throw new Error(
        `CodexCliHarnessAdapter: codex exited with code ${normalizedCode}. stderr: ${result.stderr.slice(0, 500)}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr, code: normalizedCode };
  }
}

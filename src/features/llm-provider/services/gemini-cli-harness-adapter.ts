/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GeminiCliHarnessAdapter wraps Google Gemini CLI subprocess (`@google/gemini-cli`)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: pass task.creds to applyUserScoping so the caller's provided short-lived tokens land as .oshal-cred-<provider> files in the workspace.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Default timeout 600000→3600000 (60-min ceiling, operator idle-timeout directive 2026-07-24): gemini output is batch (silent until final JSON) so idle semantics can't apply, but the duration bound must not kill long actively-working runs. GEMINI_TIMEOUT_MS overrides; adopt idleReset when a streaming output mode is verified.
 */

import fs from 'fs';
import path from 'path';
import { buildConversationAwarePrompt, type HarnessTask, type HarnessResult } from './harness-adapter';
import { BaseCliHarnessAdapter } from './base-cli-harness-adapter';
import type { TokenUsage } from './llm-service';

const DEFAULT_BINARY = 'gemini';
const DEFAULT_MODEL = 'gemini-2.5-pro';
// Absolute duration bound. Gemini runs batch output (silent until the final JSON),
// so idle semantics can't apply — the operator-directed 60-min ceiling is the bound
// (2026-07-24: never hard-stop actively-working runs at a short wall clock). Adopt
// idleReset if/when this adapter moves to a verified streaming output mode.
const DEFAULT_TIMEOUT_MS = 3_600_000;

/**
 * @description Configuration for the Gemini CLI harness adapter.
 *
 * Auth options (in priority order, mirroring Codex/Claude patterns):
 *   1. `GEMINI_API_KEY` env var — direct API key from Google AI Studio
 *   2. OAuth session at `~/.gemini/oauth_creds.json` from `gemini auth login`
 *      (mounted into containers from the host)
 *
 * Models commonly available:
 *   - gemini-2.5-pro       — high-quality reasoning
 *   - gemini-2.5-flash     — fast tier
 *   - gemini-2.0-flash     — cheap tier
 *
 * The CLI is open-source at github.com/google-gemini/gemini-cli and installed
 * via `npm install -g @google/gemini-cli`.
 */
export interface GeminiCliHarnessConfig {
  /** Path to the `gemini` binary. Default: 'gemini' (assumes PATH). */
  binaryPath?: string;

  /** Model override. Default: GEMINI_MODEL env or 'gemini-2.5-pro'. */
  model?: string;

  /** Task workspace root. Default: GEMINI_WORKSPACE_ROOT or './workspace'. */
  workspaceRoot?: string;

  /** Max execution time in ms. Default: 600000. */
  timeoutMs?: number;

  /**
   * Output format. The Gemini CLI's flag set is still settling; this adapter
   * reads JSON when present (looking for a final `{"result":"...","usage":{}}`
   * line) and falls back to plain text. Set to 'text' to skip JSON parsing
   * entirely.
   */
  outputFormat?: 'text' | 'json';
}

interface GeminiJsonResult {
  type?: string;
  result?: string;
  text?: string;
  response?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cached_content_token_count?: number;
    cachedContentTokenCount?: number;
  };
  is_error?: boolean;
  error?: string;
}

/**
 * @description HarnessAdapter wrapping the Google Gemini CLI subprocess.
 *
 * Spawns `gemini --model <model> --prompt "<prompt>"` (or its current flag
 * equivalents) inside the task workspace and parses the structured response.
 *
 * Auth: reads from `GEMINI_API_KEY` env var first; falls through to the OAuth
 * session at `~/.gemini/` written by `gemini auth login` on the host (mounted
 * into containers).
 */
export class GeminiCliHarnessAdapter extends BaseCliHarnessAdapter {
  readonly harnessType = 'gemini-cli' as const;

  private readonly binaryPath: string;
  private readonly model: string;
  private readonly workspaceRoot: string;
  private readonly outputFormat: 'text' | 'json';

  constructor(config: GeminiCliHarnessConfig = {}) {
    const timeoutMs = config.timeoutMs
      ?? (process.env.GEMINI_TIMEOUT_MS ? parseInt(process.env.GEMINI_TIMEOUT_MS, 10) : undefined)
      ?? DEFAULT_TIMEOUT_MS;
    super('gemini-cli-harness-adapter', timeoutMs);

    this.binaryPath = config.binaryPath
      ?? process.env.GEMINI_CLI_PATH
      ?? DEFAULT_BINARY;

    this.model = config.model
      ?? process.env.GEMINI_MODEL
      ?? process.env.LLM_MODEL
      ?? DEFAULT_MODEL;

    this.workspaceRoot = config.workspaceRoot
      ?? process.env.GEMINI_WORKSPACE_ROOT
      ?? process.env.CLINE_WORKSPACE_ROOT
      ?? './workspace';

    this.outputFormat = config.outputFormat ?? 'json';

    this.logger.info({
      binaryPath: this.binaryPath,
      model: this.model,
      workspaceRoot: this.workspaceRoot,
      timeoutMs: this.defaultTimeoutMs,
      outputFormat: this.outputFormat,
    }, 'GeminiCliHarnessAdapter initialized');
  }

  protected override healthCheckBinary(): string | null {
    return this.binaryPath;
  }

  async run(task: HarnessTask): Promise<HarnessResult> {
    const workspacePath = this.resolveWorkspacePath(task.taskId);
    fs.mkdirSync(workspacePath, { recursive: true });

    const model = task.model ?? this.model;
    const args = this.buildArgs(task, workspacePath, model);
    const env = this.buildEnv(workspacePath);
    const releaseUserScoping = await this.acquireUserScopingLease(
      env, workspacePath, task.userSub, task.creds,
    );

    this.logger.info({
      binaryPath: this.binaryPath,
      taskId: task.taskId,
      agentId: task.agentId,
      workspacePath,
      model,
      outputFormat: this.outputFormat,
    }, 'GeminiCliHarnessAdapter: spawning Gemini CLI');

    // Wipe the per-request cred/scoping files once the subprocess exits (success OR throw) —
    // they're only needed while the shelled tools run. Privileged-runtime hygiene.
    const { stdout, stderr, exitCode } = await (async () => {
      try { return await this.execCapturing(this.binaryPath, args, env, this.workspaceRoot); }
      finally { releaseUserScoping(); }
    })();

    if (stderr.trim()) {
      this.logger.warn({ stderr: stderr.slice(0, 500), taskId: task.taskId }, 'Gemini CLI produced stderr output');
    }

    if (this.outputFormat === 'json') {
      try {
        return this.parseJsonOutput(stdout, model, task.taskId);
      } catch (parseErr) {
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(
            `GeminiCliHarnessAdapter: gemini exited with code ${exitCode}. ${(parseErr as Error).message}. stderr: ${stderr.slice(0, 500)}`,
          );
        }
        // JSON parse failed but exit code says success — fall through to text path.
        this.logger.warn({ taskId: task.taskId, parseErr: (parseErr as Error).message }, 'JSON parse failed, falling back to plain text');
      }
    }

    if (exitCode !== 0 && exitCode !== null) {
      throw new Error(
        `GeminiCliHarnessAdapter: gemini exited with code ${exitCode}. stderr: ${stderr.slice(0, 500)}`,
      );
    }

    const text = stdout.trim();
    if (!text) {
      throw new Error(`GeminiCliHarnessAdapter: Gemini CLI produced no output for task ${task.taskId ?? 'unknown'}`);
    }

    this.logger.info({ taskId: task.taskId, outputLength: text.length }, 'GeminiCliHarnessAdapter: task complete (text mode)');

    return {
      text,
      usage: this.estimateUsage(task.prompt, text),
      model,
      stopReason: 'end_turn',
    };
  }

  // healthCheck() is inherited from BaseCliHarnessAdapter — uses
  // healthCheckBinary() above to probe `<binaryPath> --version`.

  // ── private helpers ───────────────────────────────────────────────────────

  private resolveWorkspacePath(taskId?: string): string {
    if (!taskId) {
      return path.resolve(this.workspaceRoot, `gemini-${Date.now()}`);
    }
    return path.resolve(this.workspaceRoot, taskId);
  }

  private buildArgs(task: HarnessTask, _workspacePath: string, model: string): string[] {
    // Verified against @google/gemini-cli v0.41.2:
    //   gemini --skip-trust -m <model> [-o json] -p "<prompt>"
    //
    // - `-p` / `--prompt` is the headless flag. Positional `query` argument
    //   exists but routes to interactive mode without `-p`.
    // - `--skip-trust` is required in non-interactive / containerized
    //   environments. Equivalent to GEMINI_CLI_TRUST_WORKSPACE=true.
    // - There is NO `--system` flag. System prompts are prepended to the
    //   user prompt by buildConversationAwarePrompt() below.
    // - Output formats: text (default), json, stream-json.
    const args: string[] = ['--skip-trust', '-m', model];

    if (this.outputFormat === 'json') {
      args.push('-o', 'json');
    }

    // Compose system + user prompts into one flag value since the CLI lacks
    // a dedicated --system arm.
    const userPrompt = buildConversationAwarePrompt(task);
    const composedPrompt = task.systemPrompt
      ? `## System instructions\n${task.systemPrompt}\n\n## Request\n${userPrompt}`
      : userPrompt;

    args.push('-p', composedPrompt);
    return args;
  }

  private buildEnv(workspacePath: string): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> };

    // GEMINI_API_KEY takes priority. If absent, the CLI falls through to
    // the OAuth session at ~/.gemini/ (mounted from host in containers).
    env.GEMINI_WORKSPACE = workspacePath;
    env.PWD = this.workspaceRoot;

    return env;
  }

  /**
   * @description Parse JSON output from Gemini CLI. Tolerant: supports several
   * key spellings the CLI has used across versions (`result` / `text` /
   * `response`; `input_tokens` / `inputTokens` / `promptTokenCount`).
   */
  private parseJsonOutput(stdout: string, model: string, taskId?: string): HarnessResult {
    const lines = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{'));
    let finalResult: GeminiJsonResult | null = null;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as GeminiJsonResult;
        if (parsed.type === 'result' || parsed.result !== undefined || parsed.text !== undefined || parsed.response !== undefined) {
          finalResult = parsed;
        }
      } catch {
        // non-JSON line — skip
      }
    }

    if (!finalResult) {
      // Try whole-stdout as one JSON object (some versions emit a single object, not JSONL).
      try {
        finalResult = JSON.parse(stdout.trim()) as GeminiJsonResult;
      } catch {
        const text = stdout.trim();
        if (!text) {
          throw new Error(`GeminiCliHarnessAdapter: no output from Gemini CLI for task ${taskId ?? 'unknown'}`);
        }
        this.logger.warn({ taskId }, 'GeminiCliHarnessAdapter: no JSON result found, using raw stdout as text');
        return {
          text,
          usage: { inputTokens: 0, outputTokens: 0 },
          model,
          stopReason: 'end_turn',
        };
      }
    }

    if (finalResult.is_error) {
      const detail = finalResult.error || finalResult.result || 'unknown';
      throw new Error(`GeminiCliHarnessAdapter: Gemini CLI reported error: ${detail}`);
    }

    const text = finalResult.result ?? finalResult.text ?? finalResult.response ?? '';
    if (!text) {
      throw new Error(`GeminiCliHarnessAdapter: Gemini CLI JSON result has empty content`);
    }

    const rawUsage = finalResult.usage ?? {};
    const inputTokens = rawUsage.input_tokens ?? rawUsage.inputTokens ?? rawUsage.promptTokenCount ?? 0;
    const outputTokens = rawUsage.output_tokens ?? rawUsage.outputTokens ?? rawUsage.candidatesTokenCount ?? 0;
    const cacheReadTokens = rawUsage.cached_content_token_count ?? rawUsage.cachedContentTokenCount ?? 0;

    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens,
    };

    this.logger.info({
      taskId,
      outputLength: text.length,
      inputTokens,
      outputTokens,
      cacheReadTokens,
    }, 'GeminiCliHarnessAdapter: task complete (json mode)');

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

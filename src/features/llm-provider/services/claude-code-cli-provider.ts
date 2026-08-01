/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ClaudeCodeCliProvider — harness provider wrapping the Claude Code CLI
 *                     |                           | Uses `claude -p --output-format json` for non-interactive calls
 *                     |                           | Auth handled via ANTHROPIC_API_KEY or Claude Code OAuth
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | config.extraEnv — per-provider env for the spawned CLI. Built for the world classify path: MAX_THINKING_TOKENS=0 there cut one measured 8-item haiku classify from 39.3s / 4,277 output tokens to 5.1s / 414 (the classification was in the FINAL 350 tokens all along; the rest was interleaved thinking a batch-JSON task doesn't need).
 */

import { spawn } from 'child_process';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'claude-code-cli-provider' });

const DEFAULT_TIMEOUT_MS = 120_000;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @description Optional construction settings for {@link ClaudeCodeCliProvider}, letting callers
 * override the CLI binary location, request timeout, target model, and permission mode without
 * touching environment variables.
 */
export interface ClaudeCodeCliProviderConfig {
  binaryPath?: string;
  timeoutMs?: number;
  model?: string;
  permissionMode?: 'default' | 'plan' | 'bypassPermissions';
  /** Extra env vars for the spawned CLI (e.g. MAX_THINKING_TOKENS=0 for batch-JSON tasks where
   *  interleaved thinking is pure latency). Merged over process.env; ANTHROPIC_API_KEY is still
   *  stripped afterwards — extraEnv cannot re-route auth off the OAuth session. */
  extraEnv?: Record<string, string>;
}

/**
 * @description Normalized result returned from a Claude Code CLI invocation, exposing the response
 * text alongside optional telemetry (token usage, resolved model, dollar cost, and session id) when
 * the CLI provides it in its JSON output.
 */
export interface ClaudeCodeCliResponse {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
  costUsd?: number;
  sessionId?: string;
}

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * @description Harness provider that wraps the Anthropic Claude Code CLI (`claude`).
 * Runs non-interactively with `--print` mode and JSON output format.
 * Auth handled via ANTHROPIC_API_KEY env var or Claude Code OAuth login.
 *
 * Usage:
 *   const provider = new ClaudeCodeCliProvider();
 *   const result = await provider.complete('what is 1+1?');
 *   console.log(result.text); // "2"
 */
export class ClaudeCodeCliProvider {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly model: string | null;
  private readonly permissionMode: string;
  private readonly extraEnv: Record<string, string>;

  constructor(config: ClaudeCodeCliProviderConfig = {}) {
    this.binary = config.binaryPath || process.env.CLAUDE_CODE_CLI_PATH || 'claude';
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.model = config.model || null;
    this.permissionMode = config.permissionMode || 'default';
    this.extraEnv = config.extraEnv || {};
    logger.info({ binary: this.binary, timeoutMs: this.timeoutMs, model: this.model }, 'ClaudeCodeCliProvider initialized');
  }

  /**
   * @description Sends a prompt to the Claude Code CLI and returns the text response.
   * @param prompt - The prompt to send
   * @param systemPrompt - Optional system-level instructions
   * @returns Response text and optional metadata
   */
  async complete(prompt: string, systemPrompt?: string): Promise<ClaudeCodeCliResponse> {
    return this.exec(prompt, systemPrompt);
  }

  /**
   * @description Low-level execution of `claude -p --output-format json`.
   */
  private exec(prompt: string, systemPrompt?: string): Promise<ClaudeCodeCliResponse> {
    return new Promise((resolve, reject) => {
      // Pipe the prompt via stdin to avoid shell escaping issues on Windows.
      // Build the command as a string so --tools "" is preserved correctly on Windows cmd.exe.
      const { writeFileSync } = require('fs') as typeof import('fs');
      const { tmpdir } = require('os') as typeof import('os');

      let cmd = `${this.binary} -p --output-format json --tools ""`;
      if (this.model) {
        cmd += ` --model ${this.model}`;
      }
      if (systemPrompt) {
        const sysFile = tmpdir() + '/claude-sys-prompt.txt';
        writeFileSync(sysFile, systemPrompt, 'utf8');
        // Wrap in double-quotes and escape backslashes for Windows cmd.exe
        const sysFileEscaped = sysFile.replace(/\\/g, '\\\\');
        cmd += ` --system-prompt-file "${sysFileEscaped}"`;
      }

      logger.info({ cmd: cmd.slice(0, 120) }, 'ClaudeCodeCliProvider: spawning');

      // Strip ANTHROPIC_API_KEY so the claude CLI uses its OAuth session instead of
      // an (possibly expired) API key from the environment. extraEnv merges BEFORE the
      // strip on purpose — a caller's env tweak must not re-route auth onto the key.
      const env = { ...process.env, ...this.extraEnv };
      delete env.ANTHROPIC_API_KEY;

      const child = spawn(cmd, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
        env,
      });

      // Write prompt to stdin and close it
      child.stdin?.write(prompt, 'utf8');
      child.stdin?.end();

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, this.timeoutMs);

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`ClaudeCodeCliProvider: spawn failed: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) { reject(new Error(`ClaudeCodeCliProvider: timed out after ${this.timeoutMs}ms`)); return; }
        if (code !== 0 && code !== null && stdout.length === 0) {
          reject(new Error(`ClaudeCodeCliProvider: exited ${code}: ${stderr.slice(0, 200)}`));
          return;
        }

        const parsed = this.parseOutput(stdout);
        if (parsed) {
          resolve(parsed);
        } else {
          // Fallback: treat raw stdout as text response
          const trimmed = stdout.trim();
          if (trimmed.length > 0) {
            resolve({ text: trimmed });
          } else {
            reject(new Error('ClaudeCodeCliProvider: empty output'));
          }
        }
      });
    });
  }

  /**
   * @description Parses JSON output from `claude -p --output-format json`.
   * Expected shape: { result: string, cost_usd: number, session_id: string, ... }
   * or: { type: "result", subtype: "success", result: "...", ... }
   */
  private parseOutput(raw: string): ClaudeCodeCliResponse | null {
    try {
      const data = JSON.parse(raw.trim()) as Record<string, unknown>;

      // Claude Code JSON output format
      const text = typeof data.result === 'string'
        ? data.result
        : typeof data.text === 'string'
          ? data.text
          : typeof data.content === 'string'
            ? data.content
            : null;

      if (!text) return null;

      return {
        text,
        model: typeof data.model === 'string' ? data.model : undefined,
        costUsd: typeof data.cost_usd === 'number' ? data.cost_usd : undefined,
        sessionId: typeof data.session_id === 'string' ? data.session_id : undefined,
        usage: data.usage && typeof data.usage === 'object'
          ? {
            inputTokens: (data.usage as Record<string, number>).input_tokens ?? 0,
            outputTokens: (data.usage as Record<string, number>).output_tokens ?? 0,
          }
          : undefined,
      };
    } catch {
      // Not valid JSON — might be plain text output
      return null;
    }
  }
}
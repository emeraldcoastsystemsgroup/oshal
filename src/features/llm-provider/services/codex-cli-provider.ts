/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CodexCliProvider — harness provider wrapping the OpenAI Codex CLI
 *                     |                           | Uses `codex exec --json --ephemeral` for non-interactive calls
 *                     |                           | OAuth token handled internally by the CLI
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'codex-cli-provider' });

const DEFAULT_TIMEOUT_MS = 30_000;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @description Configuration options for constructing a CodexHarnessProvider.
 * All fields are optional; omitted values fall back to environment variables
 * or built-in defaults (e.g. the `codex` binary on PATH, a 30s timeout, and
 * read-only sandbox mode).
 */
export interface CodexCliProviderConfig {
  binaryPath?: string;
  timeoutMs?: number;
  model?: string;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

/**
 * @description Result returned from a Codex CLI completion: the agent's text
 * reply plus optional token-usage metadata parsed from the turn-completed event.
 */
export interface CodexCliResponse {
  text: string;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

// ── Provider ──────────────────────────────────────────────────────────────────

/**
 * @description Harness provider that wraps the OpenAI Codex CLI (`codex exec`).
 * Runs non-interactively with JSONL output. The CLI handles OAuth
 * authentication internally — no API keys needed in the environment.
 *
 * Usage:
 *   const provider = new CodexCliProvider();
 *   const result = await provider.complete('what is 1+1?');
 *   console.log(result.text); // "2"
 */
export class CodexHarnessProvider {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly model: string | null;
  private readonly sandboxMode: string;

  constructor(config: CodexCliProviderConfig = {}) {
    this.binary = config.binaryPath || process.env.CODEX_CLI_PATH || 'codex';
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.model = config.model || null;
    this.sandboxMode = config.sandboxMode || 'read-only';
    logger.info({ binary: this.binary, timeoutMs: this.timeoutMs, model: this.model }, 'CodexCliProvider initialized');
  }

  /**
   * @description Sends a prompt to the Codex CLI and returns the agent's text response.
   * @param prompt - The prompt to send
   * @param systemPrompt - Optional system-level instructions (prepended to prompt)
   * @returns Response text and optional usage metadata
   */
  async complete(prompt: string, systemPrompt?: string): Promise<CodexCliResponse> {
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n${prompt}`
      : prompt;

    return this.exec(fullPrompt);
  }

  /**
   * Codex `exec` boots an in-process app-server that needs a WRITABLE HOME — the oshal-bot container root
   * is read-only, so a bare `codex exec` fails ("failed to initialize in-process app-server client: Read-only
   * file system"). Mirror the working CodexCliHarnessAdapter: a per-call temp workspace + `.codex-home`
   * seeded with auth.json (+ config.toml for service_tier=fast), run with `-C workspace` and `HOME=runtimeHome`.
   */
  private makeRuntime(): { workspace: string; home: string } {
    const root = process.env.CLINE_WORKSPACE_ROOT || os.tmpdir();
    fs.mkdirSync(root, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(root, 'codex-run-'));
    const home = path.join(workspace, '.codex-home');
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const srcAuth = process.env.CODEX_AUTH_SOURCE_PATH
      || path.join(process.env.HOME || process.env.USERPROFILE || '/root', '.codex', 'auth.json');
    try { if (fs.existsSync(srcAuth)) fs.copyFileSync(srcAuth, path.join(codexDir, 'auth.json')); } catch { /* best-effort */ }
    try { const cfg = path.join(path.dirname(srcAuth), 'config.toml'); if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(codexDir, 'config.toml')); } catch { /* best-effort */ }
    return { workspace, home };
  }

  /**
   * @description Low-level execution of `codex exec` with JSONL parsing.
   */
  private exec(prompt: string): Promise<CodexCliResponse> {
    return new Promise((resolve, reject) => {
      const { workspace, home } = this.makeRuntime();
      const cleanup = (): void => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort */ } };
      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-s', this.sandboxMode,
        '-C', workspace,
        // Keep classify FAST + cheap regardless of the global config.toml (which may be xhigh).
        '-c', 'model_reasoning_effort="low"',
      ];
      if (this.model) {
        args.push('-m', this.model);
      }
      args.push(prompt);

      logger.info({ binary: this.binary, argCount: args.length }, 'CodexCliProvider: spawning');

      // SECURITY: shell:false. The prompt is attacker-influenced (LLM/ticket content) and
      // is passed as a discrete argv element; shell:true would concatenate args into a single
      // shell string and let metacharacters in the prompt execute. Matches fast-intake-service.
      const child = spawn(this.binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        cwd: workspace,
        env: { ...process.env, HOME: home },
      });

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
        cleanup();
        reject(new Error(`CodexCliProvider: spawn failed: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        cleanup();
        if (timedOut) { reject(new Error(`CodexCliProvider: timed out after ${this.timeoutMs}ms`)); return; }
        if (code !== 0 && code !== null && stdout.length === 0) {
          reject(new Error(`CodexCliProvider: exited ${code}${stderr ? ' — ' + stderr.slice(0, 200) : ''}`));
          return;
        }

        const parsed = this.parseJsonlOutput(stdout);
        if (parsed) {
          resolve(parsed);
        } else {
          reject(new Error('CodexCliProvider: no agent_message in output'));
        }
      });
    });
  }

  /**
   * @description Parses JSONL output from codex exec.
   * Looks for: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
   * And usage: {"type":"turn.completed","usage":{...}}
   */
  private parseJsonlOutput(raw: string): CodexCliResponse | null {
    let text: string | null = null;
    let usage: CodexCliResponse['usage'] | undefined;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>;
        if (ev.type === 'item.completed') {
          const item = ev.item as Record<string, unknown> | undefined;
          if (item?.type === 'agent_message' && typeof item.text === 'string') {
            text = item.text;
          }
        }
        if (ev.type === 'turn.completed' && ev.usage) {
          const u = ev.usage as Record<string, number>;
          usage = {
            inputTokens: u.input_tokens ?? 0,
            cachedInputTokens: u.cached_input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
          };
        }
      } catch { /* skip non-JSON lines */ }
    }

    return text !== null ? { text, usage } : null;
  }
}
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Local CLI executors: run codex / claude on THIS machine with the user's real ~/. creds. Parse logic adapted from any-bot CodexCLIWrapper.js + ClaudeCodeCLIWrapper.js, but no temp-home copy — on a desktop the user's home is writable, so we run against it directly (the browser-popup login already dropped creds in ~/.).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: signed-in model CLIs receive only runtime and owner config paths, never the desktop node's unrelated environment credentials.
 */

import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildLocalNodeProcessEnv } from './process-environment';

/** Normalized result of a local CLI run. */
export interface ExecResult {
  success: boolean;
  text: string;
  costUSD: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
  exitCode: number | null;
  stderr: string;
}

/** A throwaway working directory so a task can't scribble on a real project. */
function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'oshal-node-task-'));
}

/**
 * @description Spawns a CLI, pipes the prompt over stdin (avoids E2BIG on big
 * prompts), enforces a hard timeout, and resolves the collected stdout/stderr.
 */
function spawnCollect(
  command: string,
  args: string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    // On Windows the agent CLIs (claude/codex/gemini) are .cmd shims; Node's spawn cannot
    // resolve/run a .cmd with shell:false (→ ENOENT), so use the shell there. POSIX keeps shell:false.
    const child = spawn(command, args, {
      cwd,
      env: buildLocalNodeProcessEnv(),
      shell: process.platform === 'win32',
    });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    try { child.stdin.write(prompt); child.stdin.end(); } catch { /* stdin may be closed */ }

    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr.slice(-2000), durationMs: Date.now() - start });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String((err as Error)?.message || err), durationMs: Date.now() - start });
    });
  });
}

/**
 * @description Runs `codex exec --json` locally and parses the JSONL stream for
 * the final agent_message text + token usage. Uses the machine's real codex auth
 * (~/.codex/auth.json) — no scoping, this is the user's own box.
 */
export async function runCodex(
  prompt: string,
  opts: { command?: string; model?: string; sandbox?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<ExecResult> {
  const command = opts.command || process.env.CODEX_CLI_PATH || 'codex';
  const model = opts.model || process.env.CODEX_MODEL || 'gpt-5.5';
  const sandbox = opts.sandbox || process.env.CODEX_SANDBOX_MODE || 'workspace-write';
  const timeoutMs = opts.timeoutMs || 600_000;
  // A mapped task workspace is reused + preserved; an ad-hoc run gets a throwaway dir.
  const cwd = opts.cwd || freshWorkspace();
  const ephemeral = !opts.cwd;
  try {
    const args = ['exec', '--json', '--skip-git-repo-check', '-s', sandbox, '-m', model, '-C', cwd];
    const { code, stdout, stderr, durationMs } = await spawnCollect(command, args, prompt, cwd, timeoutMs);
    const parsed = parseCodexJsonl(stdout);
    return {
      success: code === 0 && parsed.text.length > 0,
      text: parsed.text,
      costUSD: parsed.cost,
      usage: parsed.usage,
      durationMs,
      exitCode: code,
      stderr,
    };
  } finally {
    if (ephemeral) { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

/**
 * @description Runs `claude -p --output-format json` locally and parses the
 * structured result. Uses the machine's real Claude auth (~/.claude/.credentials.json).
 */
export async function runClaude(
  prompt: string,
  opts: { command?: string; model?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<ExecResult> {
  const command = opts.command || process.env.CLAUDE_CLI_PATH || 'claude';
  const model = opts.model || process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6';
  const timeoutMs = opts.timeoutMs || 600_000;
  const cwd = opts.cwd || freshWorkspace();
  const ephemeral = !opts.cwd;
  try {
    const args = [
      '-p',
      '--model', model,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
    ];
    const { code, stdout, stderr, durationMs } = await spawnCollect(command, args, prompt, cwd, timeoutMs);
    const parsed = parseClaudeJson(stdout);
    return {
      success: (code === 0 || parsed.text.length > 0) && parsed.text.length > 0,
      text: parsed.text,
      costUSD: parsed.cost,
      usage: parsed.usage,
      durationMs,
      exitCode: code,
      stderr,
    };
  } finally {
    if (ephemeral) { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

/** Parses `codex exec --json` JSONL: final agent_message text + usage. */
function parseCodexJsonl(stdout: string): { text: string; cost: number; usage: ExecResult['usage'] } {
  let text = '';
  let cost = 0;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(t); } catch { continue; }
    const item = ev.item as { type?: string; text?: string } | undefined;
    if (ev.type === 'item.completed' && item?.type === 'agent_message' && item.text) text = item.text;
    const turn = ev.turn as { usage?: Record<string, number> } | undefined;
    const u = (ev.usage as Record<string, number> | undefined) || turn?.usage;
    if (u) {
      usage.inputTokens = u.input_tokens || usage.inputTokens;
      usage.outputTokens = u.output_tokens || usage.outputTokens;
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    }
    if (typeof ev.total_cost_usd === 'number') cost = ev.total_cost_usd;
  }
  return { text, cost, usage };
}

/** Parses `claude -p --output-format json`: the final result object. */
function parseClaudeJson(stdout: string): { text: string; cost: number; usage: ExecResult['usage'] } {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const trimmed = String(stdout).trim();
  if (!trimmed) return { text: '', cost: 0, usage };
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const text = typeof obj.result === 'string' ? obj.result : '';
    const cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0;
    const u = obj.usage as Record<string, number> | undefined;
    if (u) {
      usage.inputTokens = u.input_tokens || 0;
      usage.outputTokens = u.output_tokens || 0;
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    }
    return { text, cost, usage };
  } catch {
    // Not JSON (e.g. an error banner) — surface the raw text so the swarm sees it.
    return { text: trimmed.slice(0, 4000), cost: 0, usage };
  }
}

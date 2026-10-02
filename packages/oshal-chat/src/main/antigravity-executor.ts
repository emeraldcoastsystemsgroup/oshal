/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Antigravity CLI executor for the OSHAL Node: run a prompt through `agy` on THIS machine with the person's own Antigravity sign-in (the swarm's fleet-default AI since 2026-09-22; the swarm's controller refuses to run any CLI unattended, so the node's chat turns are handed here). The prompt is passed as the `-p` argument (agy's stream-json stdin mode is for multi-turn NDJSON and needs stream-json output, which this one-shot executor does not parse): spawned without a shell so it arrives intact, and capped under the Windows command-line limit. The JSON envelope is judged with the swarm adapter's rule (status SUCCESS or absent, a non-empty response, exit 0). `--dangerously-skip-permissions` is never passed, and every run gets a throwaway working directory.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes: agy's print timeout is 8 minutes and the kill follows 45 seconds later, both inside the swarm's 10-minute wait, so the node reports agy's own outcome before the swarm gives up; the header no longer claims agy cannot read stdin (its stream-json stdin mode exists; this one-shot executor uses -p).
 */

import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import type { ExecResult } from './executors';
import { buildLocalNodeProcessEnv } from './process-environment';

/** Windows rejects a command line over 32,767 characters; the prompt stays well clear of it. */
export const MAX_ANTIGRAVITY_PROMPT_CHARS = 24_000;
/** agy's own print timeout. The swarm stops waiting for a node chat turn after 10 minutes, so the node's run ends first
 *  and agy's actual reason (or its late answer) is what gets reported, never only the swarm's generic timeout. */
export const PRINT_TIMEOUT_MINUTES = 8;
/** The hard kill after agy's own timeout, still inside the swarm's 10-minute wait. */
export const KILL_AFTER_MS = (PRINT_TIMEOUT_MINUTES * 60 + 45) * 1000;

/**
 * @description Where `agy` lives: an explicit path, ANTIGRAVITY_CLI_PATH, the Windows installer's default
 * (%LOCALAPPDATA%\agy\bin\agy.exe, which the installer does not put on PATH), else `agy` on PATH.
 * @param explicit A caller-supplied path, if any.
 * @param env The process environment (injectable for tests).
 * @param exists A file-existence check (injectable for tests).
 * @returns The command to spawn.
 */
export function resolveAntigravityCommand(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (explicit) return explicit;
  if (env.ANTIGRAVITY_CLI_PATH) return env.ANTIGRAVITY_CLI_PATH;
  if (env.LOCALAPPDATA) {
    const installed = join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (exists(installed)) return installed;
  }
  return 'agy';
}

/**
 * @description Whether this machine has an Antigravity CLI to run, so `swarm.exec` can pick it.
 * @param env The process environment (injectable for tests).
 * @param exists A file-existence check (injectable for tests).
 * @returns True when an explicit path or the installer's default binary exists.
 */
export function antigravityInstalled(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const command = resolveAntigravityCommand(undefined, env, exists);
  if (command !== 'agy') return exists(command);
  // Not installed in the Windows default and not named: look for agy on PATH (the macOS/Linux installers put it there).
  return String(env.PATH || env.Path || '').split(delimiter).filter(Boolean)
    .some((dir) => exists(join(dir, 'agy')) || exists(join(dir, 'agy.exe')));
}

/**
 * @description The headless `agy` argument vector.
 * @param prompt The full prompt.
 * @param model An Antigravity model id (for example gemini-3.8-flash-low), or undefined for the CLI default.
 * @returns The arguments for `agy`.
 */
export function buildAntigravityArgs(prompt: string, model?: string): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--print-timeout', `${PRINT_TIMEOUT_MINUTES}m`];
  if (model) args.push('--model', model);
  return args;
}

type AntigravityEnvelope = { status?: unknown; response?: unknown; error?: unknown; usage?: Record<string, unknown> };

/** Reads one JSON object out of stdout, tolerating a banner before or after it. */
function readEnvelope(stdout: string): AntigravityEnvelope | null {
  const trimmed = String(stdout || '').trim();
  try { return JSON.parse(trimmed) as AntigravityEnvelope; } catch { /* fall through to the object inside */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)) as AntigravityEnvelope; } catch { return null; }
}

/**
 * @description Judges agy's JSON envelope. Only status SUCCESS (or no status, as in text mode) with a zero exit
 * and a non-empty `response` is an answer, so an unknown or failure status can never pass as the model's reply.
 * @param stdout The CLI's stdout.
 * @param exitCode The process exit code.
 * @returns The answer text and usage, or the reason it is not an answer.
 */
export function parseAntigravityJson(
  stdout: string,
  exitCode: number | null,
): { text: string; usage: ExecResult['usage']; error?: string } {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const envelope = readEnvelope(stdout);
  if (!envelope || typeof envelope !== 'object') return { text: '', usage, error: 'Antigravity returned no JSON answer' };
  const status = String(envelope.status ?? '').toUpperCase();
  const detail = typeof envelope.error === 'string' && envelope.error ? `: ${envelope.error}` : '';
  if (status && status !== 'SUCCESS') return { text: '', usage, error: `Antigravity reported ${status}${detail}` };
  if (exitCode !== 0) return { text: '', usage, error: `Antigravity exited with code ${exitCode}` };
  const u = envelope.usage || {};
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  usage.inputTokens = count(u.input_tokens);
  usage.outputTokens = count(u.output_tokens);
  usage.totalTokens = count(u.total_tokens) || usage.inputTokens + usage.outputTokens;
  const text = typeof envelope.response === 'string' ? envelope.response.trim() : '';
  return text ? { text, usage } : { text: '', usage, error: 'Antigravity returned an empty response' };
}

/** Spawns agy directly, never through a shell, so the prompt argument is passed intact; collects its output. */
function spawnAntigravity(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { cwd, env: buildLocalNodeProcessEnv(), shell: false, windowsHide: true });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    try { child.stdin.end(); } catch { /* stdin may already be closed */ }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr: stderr.slice(-2000), durationMs: Date.now() - start }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String((err as Error)?.message || err), durationMs: Date.now() - start }); });
  });
}

/**
 * @description Runs a prompt through the Antigravity CLI on this machine, with the person's own sign-in, in a
 * throwaway working directory (or the mapped task folder when one is given).
 * @param prompt The prompt.
 * @param opts Optional command, model, timeout and working directory.
 * @returns The normalized result; a failure carries its reason in `stderr`.
 */
export async function runAntigravity(
  prompt: string,
  opts: { command?: string; model?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<ExecResult> {
  const none = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  if (prompt.length > MAX_ANTIGRAVITY_PROMPT_CHARS) {
    return { success: false, text: '', costUSD: 0, usage: none, durationMs: 0, exitCode: null,
      stderr: `The prompt is ${prompt.length} characters; Antigravity on this machine takes at most ${MAX_ANTIGRAVITY_PROMPT_CHARS}.` };
  }
  const command = resolveAntigravityCommand(opts.command);
  const model = opts.model || process.env.ANTIGRAVITY_MODEL || undefined;
  const cwd = opts.cwd || mkdtempSync(join(tmpdir(), 'oshal-node-task-'));
  const ephemeral = !opts.cwd;
  try {
    const run = await spawnAntigravity(command, buildAntigravityArgs(prompt, model), cwd, opts.timeoutMs || KILL_AFTER_MS);
    const parsed = parseAntigravityJson(run.stdout, run.code);
    const reason = parsed.error ? `${parsed.error}${run.stderr.trim() ? ` (${run.stderr.trim().slice(0, 300)})` : ''}` : run.stderr;
    return { success: !parsed.error, text: parsed.text, costUSD: 0, usage: parsed.usage, durationMs: run.durationMs, exitCode: run.code, stderr: reason };
  } finally {
    if (ephemeral) { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Lightweight codex exec wrapper for quick LLM questions — no workspace, no session, ~2-5s responses. Uses the same OAuth token from Codex login.
 */

import { spawn } from 'child_process';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'codex-quick-call' });

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @description Sends a prompt to `codex exec` and returns the agent's text response.
 * Uses the Codex CLI in non-interactive ephemeral mode — no workspace, no session config,
 * no MCP servers. The CLI handles OAuth authentication internally.
 *
 * Response time: ~2-5 seconds for simple prompts.
 *
 * @param prompt - The question or instruction for the LLM
 * @param timeoutMs - Max wait time (default 15s)
 * @returns Agent response text, or null on failure/timeout
 */
export async function codexQuickCall(prompt: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  try {
    const raw = await spawnCodexExec(prompt, timeoutMs);
    const text = extractAgentMessage(raw);
    if (!text) {
      logger.warn({ promptLength: prompt.length, rawLength: raw.length }, 'codex-quick-call: no agent message in output');
      return null;
    }
    return text;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'codex-quick-call: failed');
    return null;
  }
}

/**
 * @description Spawns `codex exec` and collects stdout.
 */
function spawnCodexExec(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const binary = process.env.CODEX_CLI_PATH || 'codex';
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', prompt];

    // SECURITY: shell:false. The prompt carries ticket title/body (attacker-controlled) as a
    // discrete argv element; shell:true would let metacharacters in it execute on the host.
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    child.stdin?.end();

    let stdout = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error(`codex exec timed out after ${timeoutMs}ms`)); return; }
      if (code !== 0 && code !== null && !stdout) { reject(new Error(`codex exec exited ${code}`)); return; }
      resolve(stdout);
    });
  });
}

/**
 * @description Extracts the agent message text from codex exec JSONL output.
 * Looks for {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 */
function extractAgentMessage(raw: string): string {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: string; item?: { type?: string; text?: string } };
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
        return event.item.text;
      }
    } catch { /* not JSON */ }
  }
  return '';
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Fast Intake Service — single-pass LLM extraction via Codex CLI
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched to `codex exec` (non-interactive) instead of `cline`
 *                     |                           | Response time: ~2-5 seconds instead of 35+ seconds
 *                     |                           | Uses OAuth token from Codex login internally
 */

import { spawn } from 'child_process';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'fast-intake-service' });

const INTAKE_TIMEOUT_MS = 30_000; // 30s — codex exec is fast (~2-5s)

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @description Normalized result of fast intake extraction, representing either a
 * ready-to-use work ticket or a request for clarification when the input is ambiguous.
 */
export interface FastIntakeResult {
  ticketId: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  status: string;
  needsClarification: boolean;
  clarificationQuestion?: string;
}

// ── Extraction prompt ─────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Extract work ticket fields from this user message and reply with ONLY a JSON object. No explanation, no markdown fences, just raw JSON.

Rules: title under 80 chars, priority defaults to medium, set needsClarification true only if truly ambiguous.

Format: {"title":"...","description":"...","priority":"medium","needsClarification":false,"clarificationQuestion":null}

User message:`;

// ── Codex CLI invocation ──────────────────────────────────────────────────────

/**
 * @description Runs `codex exec` non-interactively with JSONL output.
 * Uses the OAuth token from Codex login internally — no API keys needed.
 * Response time: ~2-5 seconds for simple extraction prompts.
 */
function runCodexExec(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const binary = process.env.CODEX_CLI_PATH || 'codex';
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s', 'read-only',
      prompt,
    ];

    logger.info(
      { binary, timeoutMs: INTAKE_TIMEOUT_MS },
      'FastIntake: spawning codex exec',
    );

    // shell:false (the default) is REQUIRED here — `args` includes the
    // user-supplied `prompt`, and shell:true would concatenate every arg
    // into a single shell command, letting metacharacters (;, |, &, `,
    // $()) execute as host shell commands before codex receives the
    // prompt. With shell:false, Node passes argv directly to the binary
    // and the prompt arrives as one literal argv element.
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // Close stdin immediately so codex doesn't wait for additional input
    child.stdin?.end();

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      logger.error({ timeoutMs: INTAKE_TIMEOUT_MS }, 'FastIntake: codex exec timed out');
    }, INTAKE_TIMEOUT_MS);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`FastIntake: failed to start codex: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`FastIntake: codex exec timed out after ${INTAKE_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0 && code !== null && stdout.length === 0) {
        logger.warn({ code, stderr: stderr.slice(0, 200) }, 'FastIntake: codex exec exited non-zero');
        reject(new Error(`FastIntake: codex exec exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * @description Extracts the agent message text from codex exec JSONL output.
 * Looks for {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 */
function extractAgentMessage(rawOutput: string): string {
  for (const line of rawOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
        return event.item.text;
      }
    } catch {
      // not JSON, skip
    }
  }
  return '';
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * @description Fast Intake Service — single-pass LLM extraction via `codex exec`.
 * Uses the Codex CLI in non-interactive mode for ~2-5 second responses.
 * The CLI handles OAuth authentication internally.
 */
export class FastIntakeService {
  /**
   * @description Extracts ticket fields from a user message using codex exec.
   * @param message - Natural language request from the user
   * @param previousQuestion - If follow-up to a clarification, include the prior question
   * @returns Extracted ticket fields or a clarification request
   */
  async extractTicket(
    message: string,
    previousQuestion?: string,
  ): Promise<FastIntakeResult> {
    const userMessage = previousQuestion
      ? `Original request was unclear. Clarification asked: "${previousQuestion}". User replied: "${message}"`
      : message;

    const prompt = `${EXTRACTION_PROMPT} "${userMessage}"`;

    try {
      logger.info({ messageLength: userMessage.length }, 'FastIntake: invoking codex exec');
      const startMs = Date.now();
      const rawOutput = await runCodexExec(prompt);
      const agentText = extractAgentMessage(rawOutput);
      const elapsed = Date.now() - startMs;
      logger.info({ elapsed, textLength: agentText.length }, 'FastIntake: codex exec response received');

      // Try to find JSON in the agent text
      const jsonMatch = agentText.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : agentText;

      const extracted = JSON.parse(jsonStr) as {
        title: string;
        description: string;
        priority: 'low' | 'medium' | 'high';
        needsClarification: boolean;
        clarificationQuestion?: string | null;
      };

      if (extracted.needsClarification) {
        return {
          ticketId: '',
          title: '',
          description: '',
          priority: 'medium',
          status: 'needs_clarification',
          needsClarification: true,
          clarificationQuestion: extracted.clarificationQuestion ?? 'Could you provide more detail?',
        };
      }

      return {
        ticketId: '',
        title: extracted.title || message.slice(0, 80),
        description: extracted.description || message,
        priority: extracted.priority || 'medium',
        status: 'extracted',
        needsClarification: false,
      };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'FastIntake: extraction failed — using raw message as ticket',
      );

      return {
        ticketId: '',
        title: message.slice(0, 80),
        description: message,
        priority: 'medium',
        status: 'extracted_fallback',
        needsClarification: false,
      };
    }
  }
}
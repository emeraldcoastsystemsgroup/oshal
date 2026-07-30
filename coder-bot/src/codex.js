/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Model access by shelling out to the operator's already-logged-in Codex CLI instead of holding an API key. Two reasons this shape is deliberate: (a) it carries NO credential of its own — auth is whatever the CLI already has, consistent with the repo's BYOK rule, so this tool can never leak a key it does not possess; (b) every call is `exec --json --ephemeral --skip-git-repo-check -s read-only`, which is the enforcement point for "this tool observes and advises, it does not act" — read-only sandbox means a prompt-injected instruction found in a screenshot cannot become a file write, and `--ephemeral` keeps screen content out of any persisted session. `spawn` is used with `shell: false` so a prompt is an argv element that no shell can reinterpret.
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = Number(process.env.CODER_BOT_CODEX_TIMEOUT_MS || 90_000);

/**
 * @description Locate the Codex CLI once and memoize the result.
 *
 * On Windows the npm-global `codex` is a `.cmd` shim; spawning it without a shell either fails or
 * would force `shell: true`, which is exactly what must not happen when a model-authored prompt is
 * on the command line. So the shim is resolved back to the package's `codex.js` and run under this
 * process's own Node binary, keeping `shell: false` viable. Resolution order is intentional:
 * an explicit `CODEX_CLI_PATH` always wins so the operator can pin a build, non-Windows falls
 * straight through to PATH, and bare `codex` remains the last resort so a missing CLI surfaces as a
 * spawn error the user can read rather than a silent no-op.
 *
 * @returns {{cmd: string, prefix: string[]}} Executable plus argv prefix to prepend to Codex args.
 */
function resolveCodex() {
  if (resolveCodex.cached) return resolveCodex.cached;
  const configured = process.env.CODEX_CLI_PATH;
  if (configured && fs.existsSync(configured)) {
    resolveCodex.cached = configured.endsWith('.js')
      ? { cmd: process.execPath, prefix: [configured] }
      : { cmd: configured, prefix: [] };
    return resolveCodex.cached;
  }
  if (process.platform !== 'win32') {
    resolveCodex.cached = { cmd: 'codex', prefix: [] };
    return resolveCodex.cached;
  }

  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  }
  const located = spawnSync('where', ['codex'], { encoding: 'utf8' });
  if (located.status === 0) {
    for (const shim of located.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      candidates.push(path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    }
  }
  const entry = candidates.find((candidate) => fs.existsSync(candidate));
  resolveCodex.cached = entry ? { cmd: process.execPath, prefix: [entry] } : { cmd: 'codex', prefix: [] };
  return resolveCodex.cached;
}

/**
 * @description Pull the assistant's answer out of a Codex JSONL transcript.
 *
 * `--json` interleaves lifecycle events, reasoning items, and human-readable diagnostics on the same
 * stream, and the CLI is free to add event types between versions. Rather than assume a position or
 * shape, this scans every parseable line and keeps the LAST completed `agent_message` — the final
 * word wins if the model revises — and ignores anything it cannot parse. That is what keeps this
 * tolerant of a CLI upgrade adding noise.
 *
 * @param {string} output Raw stdout from `codex exec --json`.
 * @returns {(string|null)} The answer text, or null when the transcript contains no agent message
 * (the caller turns that into an error rather than an empty answer).
 */
function extractMessage(output) {
  let answer = '';
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
        answer = event.item.text;
      }
    } catch {
      // Codex emits JSONL; ignore non-JSON diagnostic lines.
    }
  }
  return answer || null;
}

/**
 * @description Run one Codex CLI turn in a read-only ephemeral sandbox and resolve with its answer.
 *
 * Every model call in Coder Bot funnels through here so the sandbox flags cannot be forgotten at a
 * call site. The timeout is not optional politeness: the proactive monitor is a loop, and a hung CLI
 * would otherwise wedge it forever, so the child is killed and the failure reported. stderr is kept
 * to a trailing slice — enough to explain a failure, bounded so a chatty CLI cannot grow memory
 * across a long-running session.
 *
 * @param {string} prompt Prompt text, passed as a single argv element (never through a shell).
 * @param {object} [options] Call options.
 * @param {(string|null)} [options.image] Path to a screenshot to attach with `-i`.
 * @param {number} [options.timeoutMs] Override the `CODER_BOT_CODEX_TIMEOUT_MS` budget.
 * @returns {Promise<string>} The agent message text.
 * @throws {Error} On spawn failure, timeout, or a transcript with no agent message.
 */
function runCodex(prompt, { image = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', prompt];
    if (image) args.push('-i', image);
    const { cmd, prefix } = resolveCodex();
    const child = spawn(cmd, [...prefix, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2_000); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`Codex timed out after ${timeoutMs}ms`));
      const message = extractMessage(stdout);
      if (!message) return reject(new Error(stderr.trim() || `Codex returned no answer (exit ${code})`));
      resolve(message);
    });
  });
}

/**
 * @description Ask Codex a question and get prose back. The plain-text path, used for chat answers.
 * @param {string} prompt Prompt text.
 * @param {object} [options] Forwarded to the sandboxed runner (`image`, `timeoutMs`).
 * @returns {Promise<string>} The answer text.
 */
async function ask(prompt, options) {
  return runCodex(prompt, options);
}

/**
 * @description Ask Codex for one JSON object and parse it.
 *
 * The screen-guide and screen-control prompts need structured output because the caller acts on
 * individual fields (a confidence number is compared against a floor; an action name is checked
 * against an allowlist) — prose cannot be gated that way. Models still wrap JSON in a code fence or
 * a sentence of preamble despite instructions, so the fence is stripped and the outermost braces
 * extracted; unparseable output raises rather than degrading into a partial object, because a
 * half-read control decision is the one thing that must never reach the desktop.
 *
 * @param {string} prompt Prompt text; a JSON-only instruction is appended.
 * @param {object} [options] Forwarded to the sandboxed runner (`image`, `timeoutMs`).
 * @returns {Promise<object>} The parsed object.
 * @throws {Error} When no JSON object can be found or it fails to parse.
 */
async function askJson(prompt, options = {}) {
  const answer = await runCodex(`${prompt}\n\nReturn ONLY one JSON object. No prose or code fence.`, options);
  const cleaned = answer.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Codex did not return JSON');
  return JSON.parse(match[0]);
}

module.exports = { ask, askJson, extractMessage, resolveCodex };

'use strict';
/**
 * @description Packed-Codex call helper — the bot's brain.
 *
 * Wraps `codex exec --json` (non-interactive, ephemeral) and parses the JSONL
 * stream for the agent's final message — the same pattern as the framework's
 * codex-quick-call. shell:false so prompt content can never reach a shell.
 *
 * Two entry points:
 *   codexAsk(prompt, {addDirs})         → free text answer
 *   codexJson(prompt, {addDirs, image}) → best-effort JSON object from the answer
 *
 * Knowledge is supplied to Codex via --add-dir (the knowledge/ folder), so the
 * bot answers grounded in the preloaded runbooks without stuffing them all into
 * every prompt.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BINARY = process.env.CODEX_CLI_PATH || 'codex';
const DEFAULT_TIMEOUT_MS = Number(process.env.VIDS_CODEX_TIMEOUT_MS || 90_000);

/**
 * Resolve how to invoke codex as { cmd, prefixArgs }, kept injection-safe
 * (shell:false). On Windows the global `codex` is a .cmd shim Node's spawn can't
 * resolve, but the real entrypoint is `node .../@openai/codex/bin/codex.js` —
 * so we spawn node with that JS directly. On posix `codex` on PATH just works.
 */
function resolveCodex() {
  if (resolveCodex._cached) return resolveCodex._cached;
  let result;
  const env = process.env.CODEX_CLI_PATH;
  if (env && fs.existsSync(env)) {
    result = env.endsWith('.js') ? { cmd: process.execPath, prefixArgs: [env] } : { cmd: env, prefixArgs: [] };
  } else if (process.platform === 'win32') {
    const candidates = [];
    const appdata = process.env.APPDATA;
    if (appdata) candidates.push(path.join(appdata, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    // Derive from wherever the `codex` shim lives on PATH.
    const where = spawnSync('where', ['codex'], { encoding: 'utf8' });
    if (where.status === 0) {
      for (const line of where.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        candidates.push(path.join(path.dirname(line), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
      }
    }
    const js = candidates.find((p) => fs.existsSync(p));
    result = js ? { cmd: process.execPath, prefixArgs: [js] } : { cmd: 'codex', prefixArgs: [] };
  } else {
    result = { cmd: BINARY, prefixArgs: [] };
  }
  resolveCodex._cached = result;
  return result;
}

function spawnCodex(prompt, { addDirs = [], image = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only'];
    // Optional override so a broken/incompatible global config.toml service_tier
    // can't block the bot (e.g. an old `service_tier="priority"` the CLI rejects).
    if (process.env.VIDS_CODEX_SERVICE_TIER) args.push('-c', `service_tier=${process.env.VIDS_CODEX_SERVICE_TIER}`);
    for (const dir of addDirs) args.push('--add-dir', dir);
    // Prompt is a positional and MUST come before `-i`: `-i` is variadic and would
    // otherwise swallow the prompt as a second image file.
    args.push(prompt);
    if (image) args.push('-i', image);

    const { cmd, prefixArgs } = resolveCodex();
    const child = spawn(cmd, [...prefixArgs, ...args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    child.stdin && child.stdin.end();
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
      if (code !== 0 && code !== null && !stdout) return reject(new Error(`codex exec exited ${code}`));
      resolve(stdout);
    });
  });
}

function extractAgentMessage(raw) {
  let last = '';
  for (const line of String(raw).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && ev.item.text) {
        last = ev.item.text;
      }
    } catch {
      /* not JSON */
    }
  }
  return last;
}

/** Last failure reason, so callers can surface WHY instead of a generic miss. */
let lastError = null;
function getLastCodexError() {
  return lastError;
}

async function codexAsk(prompt, opts = {}) {
  try {
    const raw = await spawnCodex(prompt, opts);
    const text = extractAgentMessage(raw) || null;
    if (!text) lastError = 'codex returned no agent message';
    else lastError = null;
    return text;
  } catch (err) {
    lastError = String((err && err.message) || err); // e.g. ENOENT, timeout, exit code
    return null; // no fake — caller decides how to surface the miss
  }
}

/**
 * Vision call: show Codex an image and get a JSON object back. Used by the
 * computer-use loop to decide the next mouse action from a real screenshot.
 * (Codex `-i` is variadic, so the prompt MUST come before the image.)
 */
async function codexVision(imagePath, prompt, opts = {}) {
  const text = await codexAsk(`${prompt}\n\nRespond with ONLY one JSON object, no prose, no code fence.`, {
    ...opts,
    image: imagePath,
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
  });
  if (!text) return null;
  const m = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim().match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Ask for JSON; tolerate fenced/`json` wrappers. Returns object or null. */
async function codexJson(prompt, opts = {}) {
  const text = await codexAsk(`${prompt}\n\nRespond with ONLY a single JSON object, no prose, no code fence.`, opts);
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  // Grab the first {...} block if there's stray text.
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Whether codex is invokable (probed once via the same resolver spawn uses). */
function codexAvailable() {
  if (codexAvailable._cached != null) return codexAvailable._cached;
  const { cmd, prefixArgs } = resolveCodex();
  if (cmd === process.execPath) {
    // node + codex.js: presence of the js was already verified by the resolver.
    codexAvailable._cached = true;
  } else {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    codexAvailable._cached = probe.status === 0;
  }
  return codexAvailable._cached;
}

module.exports = { codexAsk, codexJson, codexVision, codexAvailable, getLastCodexError };

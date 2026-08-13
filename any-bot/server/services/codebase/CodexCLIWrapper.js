/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081 idle-based timeout (bot-node runtime parity with the TS adapter): `codex exec --json` streams JSONL, so the timer now bounds SILENCE (child output refreshes it; CODEX_INACTIVITY_TIMEOUT_MS, legacy CODEX_TIMEOUT_MS fallback) with a CODEX_MAX_DURATION_MS hard cap (default 2h). Fixes actively-working runs being SIGKILLed at the absolute 600s cap; kill reason now lands in stderr for honest escalation messages.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial CodexCLIWrapper — spawns `codex exec --json` for the bot-node codex provider. Mirrors ClaudeCodeCLIWrapper. Seeds a WRITABLE CODEX_HOME (the host ~/.codex is mounted :ro, which blocks codex's app-server writes) with auth.json + config.toml, runs with --skip-git-repo-check + a sandbox, and parses the JSONL events (item.completed text + turn.completed usage).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Token-stranding fix (parity with the TS adapter's codex-auth-write-back.ts): the CLI rotates its SINGLE-USE ChatGPT refresh_token in the per-workspace auth.json COPY and nothing wrote it back — one mid-run refresh left the shared source holding an already-spent token, bricking codex auth until a host re-login. Now snapshot auth.json before the spawn and CAS-write-back a rotation to authSourcePath after the run (only when the source still equals the snapshot; atomic tmp+rename; never throws). Also corrected the stale ":ro mount" comment — the local compose mounts ~/.codex :rw precisely so rotations can persist.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review hardening (parity with the TS twin): snapshot moved AFTER the workspace lease (pre-lease it baselines a stale chain for queued same-workspace runs, whose own rotation would then CAS-fail and re-strand the token); _reseedFromSource refreshes an untouched copy the source advanced past; _looksLikeAuth blocks torn/injected content from reaching the shared credential; a MISSING source (secrets-seeded container) is now created exclusively instead of warn-looping as "moved".
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Verifier round 2 (parity with codex-auth-write-back.ts): _reseedFromSource requires a valid-shaped source that is provably NEWER (last_refresh) — after a failed write-back the source holds the dead chain and "differs" alone would erase the only live copy; non-ENOENT source read errors return 'failed' honestly instead of 'source-moved'; missing-source create is tmp+linkSync (atomic AND exclusive, no torn source on crash). The unscoped-request lease bypass is fixed in user-scoping.js (lease now unconditional, TS parity).
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: default-deny unbrokered autonomous CLI execution before copying OAuth material or spawning danger-full-access Codex.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: isolate the live Codex availability probe from ambient process credentials.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Pin `-c model_reasoning_effort` on every spawn (CODEX_REASONING_EFFORT, default high). _ensureHome copies the HOST config.toml into the per-workspace home, so a host-side effort tuned for an interactive frontier model (ultra → gpt-5.6-sol-only) rode into fleet runs and 400'd every fresh workspace on gpt-5.5/gpt-5.4 — verified live. Pinning makes the fleet effort deterministic regardless of host config drift.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { acquireUserScoping } = require('./user-scoping');
const { buildCliDiagnosticEnv } = require('./cli-diagnostic-env');
const { assertCliToolBoundary } = require('../llm/assert-cli-tool-boundary');
const { captureProviderRecord, stripModelProviderRecordFences } = require('./provider-record-capture');

const MAX_DIAGNOSTIC_CHARS = 1200;
const MAX_EVENT_DIAGNOSTIC_CHARS = 800;

/**
 * Keep CLI diagnostics useful without relaying arbitrary, unbounded JSONL fields.
 * Only explicit error-message fields reach this function; ANSI/control bytes and
 * common credential shapes are removed before the bounded value leaves the bot.
 */
function sanitizeDiagnostic(value, maxChars = MAX_DIAGNOSTIC_CHARS) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function readFailureEventMessage(event) {
  if (!event || (event.type !== 'error' && event.type !== 'turn.failed')) return '';
  const raw = typeof event.message === 'string'
    ? event.message
    : typeof event.error === 'string'
      ? event.error
      : event.error && typeof event.error.message === 'string'
        ? event.error.message
        : '';
  return sanitizeDiagnostic(raw, MAX_EVENT_DIAGNOSTIC_CHARS);
}

function mergeDiagnostics(stderr, eventDiagnostics) {
  const stderrTail = sanitizeDiagnostic(String(stderr || '').slice(-MAX_DIAGNOSTIC_CHARS), 600);
  const jsonlFailure = sanitizeDiagnostic((eventDiagnostics || []).join('; '), MAX_EVENT_DIAGNOSTIC_CHARS);
  return [stderrTail, jsonlFailure].filter(Boolean).join('\n').slice(0, MAX_DIAGNOSTIC_CHARS);
}

/**
 * @description Thin wrapper around the OpenAI Codex CLI (`codex exec`) for the
 * bot-node runtime. Parallel to ClaudeCodeCLIWrapper.
 */
class CodexCLIWrapper {
  /**
   * @param {{codexCommand?: string, timeoutMs?: number, model?: string, reasoningEffort?: string, sandboxMode?: string, authSourcePath?: string, spawnImpl?: Function}} options
   */
  constructor(options = {}) {
    this.codexCommand = options.codexCommand || process.env.CODEX_CLI_PATH || 'codex';
    // Idle window (max SILENCE — output refreshes the timer). Legacy CODEX_TIMEOUT_MS kept as fallback.
    this.timeoutMs = options.timeoutMs || parseInt(process.env.CODEX_INACTIVITY_TIMEOUT_MS || process.env.CODEX_TIMEOUT_MS || '600000', 10);
    // Runaway backstop: absolute wall-clock cap for a run that never goes idle.
    this.maxDurationMs = parseInt(process.env.CODEX_MAX_DURATION_MS || '7200000', 10);
    this.model = options.model || process.env.CODEX_MODEL || 'gpt-5.5';
    // Pinned per spawn: _ensureHome copies the HOST config.toml, whose model_reasoning_effort
    // may be legal only for the host's interactive model (ultra → sol) and 400s the fleet
    // models (gpt-5.5/gpt-5.4 accept none|low|medium|high|xhigh).
    this.reasoningEffort = options.reasoningEffort || (process.env.CODEX_REASONING_EFFORT || '').trim() || 'high';
    this.sandboxMode = options.sandboxMode || process.env.CODEX_SANDBOX_MODE || 'danger-full-access';
    // Host OAuth source. We copy it into a writable per-workspace home for the run (codex's
    // app-server needs write access), and CAS-write a token rotation back here afterwards —
    // the local compose mounts ~/.codex :rw for exactly that write-back.
    this.authSourcePath = options.authSourcePath || process.env.CODEX_AUTH_SOURCE_PATH || '/root/.codex/auth.json';
    this.spawnImpl = options.spawnImpl || spawn;
  }

  /**
   * @description Seeds a WRITABLE codex home inside the workspace, copying the
   * host auth.json + config.toml. Returns the home dir to use as HOME/CODEX_HOME.
   * @param {string} workspaceDir
   * @returns {string} writable codex home directory (the `.codex` dir)
   */
  _ensureHome(workspaceDir) {
    const codexDir = path.join(workspaceDir, '.codex-home', '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const srcDir = path.dirname(this.authSourcePath);
    for (const f of ['auth.json', 'config.toml']) {
      const src = path.join(srcDir, f);
      const dest = path.join(codexDir, f);
      if (!fs.existsSync(dest) && fs.existsSync(src)) {
        try { fs.copyFileSync(src, dest); } catch { /* best effort */ }
      }
    }
    return codexDir;
  }

  /**
   * @description Reads the per-workspace auth.json as the pre-run snapshot (null when
   * absent/unreadable). Taken AFTER _ensureHome and BEFORE the spawn so _writeBackAuth
   * can detect a mid-run token rotation.
   * @param {string} codexDir - the writable per-workspace `.codex` dir
   * @returns {string|null}
   */
  _snapshotAuth(codexDir) {
    try {
      return fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * @description True when content parses as a plausible codex auth.json (ChatGPT-OAuth
   * tokens or a non-empty OPENAI_API_KEY). Guards the SHARED credential against torn writes
   * (SIGKILL mid-rotation) and workspace-injected garbage — the CAS is a concurrency guard,
   * not a content guard.
   * @param {string} content - candidate auth.json content
   * @returns {boolean}
   */
  _looksLikeAuth(content) {
    try {
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      const tokens = parsed.tokens;
      const hasOauth = !!tokens && typeof tokens === 'object'
        && (typeof tokens.access_token === 'string' || typeof tokens.refresh_token === 'string');
      const hasKey = typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0;
      return hasOauth || hasKey;
    } catch {
      return false;
    }
  }

  /**
   * @description Parses the `last_refresh` ISO timestamp out of auth.json content (both the
   * codex CLI and the seeders stamp it) — the honest "which chain is newer" signal.
   * @param {string} content - candidate auth.json content
   * @returns {number|null} epoch millis, or null when invalid/unstamped
   */
  _authLastRefreshMs(content) {
    try {
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.last_refresh !== 'string') return null;
      const ms = Date.parse(parsed.last_refresh);
      return Number.isNaN(ms) ? null : ms;
    } catch {
      return null;
    }
  }

  /**
   * @description Re-seeds an UNTOUCHED per-workspace auth.json copy from the source when the
   * source advanced while this task queued behind the workspace lease — another task's
   * write-back means the copy's single-use refresh token is already spent. Direction guards
   * (a wrong re-seed DESTROYS the only live chain): never overwrites a copy that rotated
   * past the snapshot; only re-seeds from a valid-shaped source whose `last_refresh` is
   * provably NEWER than the copy's — after a FAILED write-back the source holds the older
   * spent chain while the copy holds the only live one, and "source differs" alone would
   * erase it. Returns the snapshot the post-run CAS should use.
   * @param {string} codexDir - the writable per-workspace `.codex` dir
   * @param {string|null} snapshot - pre-spawn content from _snapshotAuth
   * @returns {string|null}
   */
  _reseedFromSource(codexDir, snapshot) {
    if (!this.authSourcePath) return snapshot;
    let sourceNow;
    try { sourceNow = fs.readFileSync(this.authSourcePath, 'utf8'); } catch { return snapshot; }
    if (sourceNow === snapshot) return snapshot;
    if (!this._looksLikeAuth(sourceNow)) return snapshot; // never seed garbage into the copy
    let currentCopy = null;
    try { currentCopy = fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'); } catch { /* missing copy is seedable */ }
    if (currentCopy !== snapshot) return snapshot; // copy already rotated — never clobber
    if (currentCopy !== null) {
      const sourceTs = this._authLastRefreshMs(sourceNow);
      if (sourceTs === null) return snapshot;
      const copyTs = this._authLastRefreshMs(currentCopy);
      if (copyTs !== null && sourceTs <= copyTs) return snapshot; // keep the copy when in doubt
    }
    try {
      fs.writeFileSync(path.join(codexDir, 'auth.json'), sourceNow, { encoding: 'utf8', mode: 0o600 });
      console.log('[CodexCLIWrapper] auth source advanced while queued — per-workspace copy re-seeded with the fresh chain');
      return sourceNow;
    } catch (err) {
      console.error('[CodexCLIWrapper] auth re-seed failed — spawning against the possibly-stale copy:', err && err.message ? err.message : err);
      return snapshot;
    }
  }

  /**
   * @description CAS-writes a token rotation back to the shared source. A ChatGPT-login
   * auth.json carries a SINGLE-USE refresh_token; the CLI rotates it in the per-workspace
   * COPY, so without this write-back the source keeps an already-spent token and every
   * later task dies with "refresh token was already used" once its access token expires.
   * Mirrors src/features/llm-provider/services/codex-auth-write-back.ts (the TS twin —
   * keep the CAS rules in sync): only write when the copy changed during THIS run, passes
   * the auth-shape guard, AND the source still equals the pre-run snapshot (a moved source
   * = host re-login or another writer won; clobbering it would destroy the newer chain). A
   * MISSING source (secrets-seeded container) is created exclusively instead of warn-looped.
   * Atomic tmp+rename; never throws into the task path.
   * @param {string} codexDir - the writable per-workspace `.codex` dir
   * @param {string|null} snapshot - pre-run content from _snapshotAuth/_reseedFromSource
   * @returns {'written'|'unchanged'|'source-moved'|'invalid'|'skipped'|'failed'}
   */
  _writeBackAuth(codexDir, snapshot) {
    if (!snapshot || !this.authSourcePath) return 'skipped';
    let current;
    try {
      current = fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8');
    } catch {
      return 'skipped';
    }
    if (current === snapshot) return 'unchanged';
    if (!this._looksLikeAuth(current)) {
      console.error('[CodexCLIWrapper] auth changed during the run but is not a valid auth shape (torn write or injected content) — NOT propagated to the shared source');
      return 'invalid';
    }
    let sourceNow = null;
    let sourceMissing = false;
    try {
      sourceNow = fs.readFileSync(this.authSourcePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        sourceMissing = true;
      } else {
        // EACCES/EIO etc. — NOT "the source moved"; report honestly.
        console.error('[CodexCLIWrapper] auth write-back could not READ the source file — rotation not propagated:', err && err.message ? err.message : err);
        return 'failed';
      }
    }
    if (sourceMissing) {
      // Secrets-seeded container: persist the rotated chain as the new source so later
      // tasks seed it from the file. Atomic-and-exclusive: tmp + hard-link (link fails
      // EEXIST if a concurrent creator won; a crash can only leave a tmp, never a torn
      // source that would block future creates).
      const createTmp = path.join(path.dirname(this.authSourcePath), `.auth.json.create-${process.pid}-${Date.now()}.tmp`);
      try {
        fs.mkdirSync(path.dirname(this.authSourcePath), { recursive: true });
        fs.writeFileSync(createTmp, current, { encoding: 'utf8', mode: 0o600 });
        fs.linkSync(createTmp, this.authSourcePath);
        console.log('[CodexCLIWrapper] auth rotated and no source file existed — rotated token persisted as the new shared source:', this.authSourcePath);
        return 'written';
      } catch (err) {
        console.error('[CodexCLIWrapper] auth write-back could not create the missing source file:', err && err.message ? err.message : err);
        return 'failed';
      } finally {
        try { fs.unlinkSync(createTmp); } catch { /* tmp may not exist */ }
      }
    }
    if (sourceNow !== snapshot) {
      console.error('[CodexCLIWrapper] auth rotated during the run but the source changed since seeding — write-back skipped to protect the newer credential:', this.authSourcePath);
      return 'source-moved';
    }
    const tmpPath = path.join(path.dirname(this.authSourcePath), `.auth.json.writeback-${process.pid}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmpPath, current, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, this.authSourcePath);
      console.log('[CodexCLIWrapper] codex auth rotated during the run — rotated token written back to', this.authSourcePath);
      return 'written';
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
      console.error('[CodexCLIWrapper] auth write-back FAILED — rotated single-use refresh token lives only in the per-workspace copy (read-only source mount?):', err && err.message ? err.message : err);
      return 'failed';
    }
  }

  /**
   * @description Runs `codex exec` over a task description in a workspace.
   * @param {string} taskDescription - prompt (piped via stdin to avoid E2BIG)
   * @param {string} workspaceDir - working directory
   * @param {{model?: string, reasoningEffort?: string, sandboxMode?: string, timeout?: number}} [options]
   * @returns {Promise<{success: boolean, text: string, result: string, providerRecords: object[], costUSD: number, usage: object, durationMs: number, exitCode: number, stderr: string}>}
   */
  async executeTask(taskDescription, workspaceDir, options = {}) {
    assertCliToolBoundary(options, 'openai-codex');
    const model = options.model || this.model;
    const sandbox = options.sandboxMode || this.sandboxMode;
    fs.mkdirSync(workspaceDir, { recursive: true });
    // Per-request user scoping for shelled-out tools (oshal-gmail.js) — env + cwd file.
    const codexHome = this._ensureHome(workspaceDir);
    const home = path.dirname(codexHome); // {workspace}/.codex-home

    const args = ['exec', '--json', '--skip-git-repo-check', '-s', sandbox, '-m', model,
      '-c', `model_reasoning_effort=${options.reasoningEffort || this.reasoningEffort}`, '-C', workspaceDir];
    const start = Date.now();
    const userScope = await acquireUserScoping(workspaceDir, options.extraEnv);
    const scopeEnv = userScope.env;
    // Pre-run snapshot AFTER the workspace lease, so a queued same-workspace run baselines
    // the previous run's rotation (pre-lease it would CAS-fail its own rotation later). Then
    // re-seed a copy the shared source has advanced past — another task's write-back means
    // the copy's single-use refresh token is already spent. The .finally below CAS-writes a
    // mid-run rotation back to the shared source (token-stranding fix).
    const authSnapshot = this._reseedFromSource(codexHome, this._snapshotAuth(codexHome));

    return new Promise((resolve) => {
      const child = this.spawnImpl(this.codexCommand, args, {
        cwd: workspaceDir,
        // extraEnv carries per-request scoping (e.g. OSHAL_USER_SUB) so shelled-out
        // tools like oshal-gmail.js act ONLY for the requesting user. Per-spawn, not
        // global process.env, so concurrent requests can't read each other's identity.
        env: { ...process.env, HOME: home, CODEX_HOME: codexHome, ...scopeEnv },
      });
      let stdout = '', stderr = '';
      let killReason = '';
      const idleMs = options.timeout || this.timeoutMs;
      // Idle semantics (ADR-081): codex streams JSONL, so any output means the run is
      // alive — refresh the timer. Only a silent-stuck child dies at idleMs; a chatty
      // runaway is bounded by the separate max-duration cap.
      const timer = setTimeout(() => {
        killReason = `idle timeout: no output for ${idleMs}ms`;
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }, idleMs);
      const durationTimer = setTimeout(() => {
        killReason = `exceeded max duration ${this.maxDurationMs}ms (still streaming — raise CODEX_MAX_DURATION_MS if legitimate)`;
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }, this.maxDurationMs);
      child.stdout.on('data', (d) => { stdout += d.toString(); timer.refresh(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); timer.refresh(); });
      // Pass the prompt in the end() call itself. Codex CLI 0.87+ can observe EOF between
      // separate write()/end() calls on fast pipes and fail the turn before reading input.
      try { child.stdin.end(taskDescription); } catch { /* noop */ }

      child.on('close', (code) => {
        clearTimeout(timer);
        clearTimeout(durationTimer);
        if (killReason) stderr = `${killReason}\n${stderr}`;
        const parsed = this._parse(stdout);
        resolve({
          success: code === 0 && parsed.text.length > 0,
          text: parsed.text,
          result: parsed.text,
          providerRecords: parsed.providerRecords,
          costUSD: parsed.cost,
          usage: parsed.usage,
          durationMs: Date.now() - start,
          exitCode: code,
          // Codex reports quota/auth/turn failures in stdout JSONL while stderr may
          // contain only "Reading prompt from stdin...". Surface the typed error
          // messages, still sanitized and capped at the existing 1200-char boundary.
          stderr: mergeDiagnostics(stderr, parsed.errorMessages),
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        clearTimeout(durationTimer);
        resolve({ success: false, text: '', result: '', providerRecords: [], costUSD: 0, usage: {}, durationMs: Date.now() - start, exitCode: -1, stderr: String(err && err.message || err) });
      });
    }).finally(() => {
      // Write-back BEFORE releasing the scope lease: a rotated single-use refresh token
      // must reach the shared source even when the run failed (the CLI can refresh
      // successfully and still fail the turn on quota/sandbox).
      this._writeBackAuth(codexHome, authSnapshot);
      userScope.release();
    });
  }

  /**
   * @description Parses `codex exec --json` JSONL output: the final agent_message
   * text (item.completed) + token usage (turn.completed). Codex may not emit a
   * dollar cost on a ChatGPT-account login — default 0.
   * @param {string} stdout
   * @returns {{text: string, providerRecords: object[], errorMessages: string[], cost: number, usage: object}}
   */
  _parse(stdout) {
    let text = '';
    let cost = 0;
    const providerRecords = [];
    const errorMessages = [];
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    for (const line of String(stdout).split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      const failureMessage = readFailureEventMessage(ev);
      if (failureMessage) errorMessages.push(failureMessage);
      if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && ev.item.text) {
        text = ev.item.text;
      }
      if (ev.type === 'item.completed' && ev.item && ev.item.type === 'command_execution'
        && Number(ev.item.exit_code) === 0) {
        const record = captureProviderRecord(
          ev.item.command,
          ev.item.aggregated_output || ev.item.output || '',
        );
        if (record) providerRecords.push(record);
      }
      const u = ev.usage || (ev.turn && ev.turn.usage);
      if (u) {
        usage.inputTokens = u.input_tokens || usage.inputTokens;
        usage.outputTokens = u.output_tokens || usage.outputTokens;
        usage.cacheReadTokens = u.cached_input_tokens || usage.cacheReadTokens;
        usage.totalTokens = usage.inputTokens + usage.outputTokens;
      }
      if (typeof ev.total_cost_usd === 'number') cost = ev.total_cost_usd;
    }
    const uniqueRecords = [...new Map(providerRecords.map((record) => [record.sourceRef, record])).values()];
    const uniqueErrors = [...new Set(errorMessages)].slice(-4);
    return {
      text: stripModelProviderRecordFences(text),
      providerRecords: uniqueRecords,
      errorMessages: uniqueErrors,
      cost,
      usage,
    };
  }

  /** @description Returns true if the codex binary is on PATH. */
  async isAvailable() {
    return new Promise((resolve) => {
      try {
        const child = this.spawnImpl(this.codexCommand, ['--version'], {
          env: buildCliDiagnosticEnv(),
        });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      } catch { resolve(false); }
    });
  }

  /** @description Auth check — the binary exists and an auth source is present. */
  async testConnection() {
    return (await this.isAvailable()) && fs.existsSync(this.authSourcePath);
  }
}

module.exports = CodexCLIWrapper;

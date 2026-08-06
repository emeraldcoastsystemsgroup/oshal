/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Idle-based timeouts (operator directive 2026-07-24, extends ADR-081): executeTask hard-stopped actively-working runs at the wall clock (compose set 600s — the "stops at 10 minutes" report) because batch json is silent until the final object, making silence unmeasurable. executeTask now defaults to stream-json (+ --verbose, required by print mode) so the activity tracker sees every event; defaults become 3600s runaway ceiling + 600s silence threshold. _parseJsonResult already normalized NDJSON, so result extraction is unchanged. streaming:false remains an explicit batch opt-out.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Streaming crash guard (adversarial review): a stream-json run that ends with NO final `type:"result"` event means the CLI crashed/was-killed mid-stream — _parseJsonResult tags returns with resultEventFound, and executeTask now REJECTS such a streaming run instead of resolving the raw-text fallback as success (which silently returned garbage). Batch json is unaffected. Also: killOnInactivity is disarmed for explicit batch runs (silence is only measurable under streaming).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: default-deny unbrokered autonomous CLI execution before credential setup or process spawn.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: isolate live version and authentication probes from ambient process credentials.
 */

/**
 * Claude Code CLI Wrapper
 * Wraps the official Claude Code CLI for programmatic task execution
 * Provides direct access to Anthropic's Claude API via the `claude` binary
 * 
 * Key differences from ClineCLIWrapper:
 * - Uses `claude` binary (not `cline`)
 * - Uses `-p` flag for non-interactive (print) mode
 * - Uses `--output-format json` or `--output-format stream-json`
 * - Uses `--dangerously-skip-permissions` for auto-approve
 * - Uses `--no-session-persistence` to avoid disk usage
 * - Auth via ~/.claude/ (OAuth tokens) or ANTHROPIC_API_KEY env var
 * - Returns structured JSON with total_cost_usd, usage, modelUsage
 * 
 * PHASE_10: Claude Code CLI as Default LLM Provider
 */

const { spawn } = require('child_process');
const { acquireUserScoping } = require('./user-scoping');
const { buildCliDiagnosticEnv } = require('./cli-diagnostic-env');
const { assertCliToolBoundary } = require('../llm/assert-cli-tool-boundary');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

function tail(text, max = 1000) {
  return String(text || '').slice(-max);
}

function createCliExecutionError(message, diagnostics = {}) {
  const error = new Error(message);
  Object.assign(error, diagnostics);
  return error;
}

/**
 * @description Programmatic adapter around the official `claude` CLI binary so the
 * harness can drive Anthropic's Claude as a first-class LLM provider without an
 * interactive terminal. It exists to make CLI execution reliable and observable in
 * server/container contexts: it resolves the correct binary and Node.js paths,
 * adapts permission flags to root vs. non-root runtimes, streams prompts via stdin
 * to avoid the CLI hanging on large arguments, enforces hard and inactivity
 * timeouts, and normalizes the CLI's JSON/NDJSON output into a stable result shape
 * (text, cost, token usage, session metadata). This is the default LLM provider
 * wrapper introduced in PHASE_10.
 */
class ClaudeCodeCLIWrapper {
  /**
   * @description Configure the wrapper for a given runtime by capturing the claude
   * binary location, default model, and timeout policy, then resolving the
   * environment-specific binary search paths (~/.local/bin and the active Node.js
   * install) up front so every later spawn uses a consistent, correct PATH.
   * @param {Object} [options] - Overrides for command, model, and timeout behavior.
   * @param {string} [options.claudeCommand] - Path/name of the claude binary to invoke.
   * @param {number} [options.timeout] - Hard timeout in seconds for a task run.
   * @param {number} [options.inactivityTimeout] - Seconds of silence before a run is treated as stalled.
   * @param {number} [options.inactivityCheckIntervalMs] - Monitor interval override, mainly for fast regression tests.
   * @param {string} [options.model] - Default Claude model identifier to use.
   */
  constructor(options = {}) {
    this.claudeCommand = options.claudeCommand || process.env.CLAUDE_CLI_PATH || 'claude';
    // Operator directive 2026-07-24: never hard-stop actively-working runs at a short
    // wall clock. The ceiling is a 60-min runaway backstop; "stuck" is decided by
    // SILENCE (10 min of no output while streaming), not duration.
    this.defaultTimeout = options.timeout || 3600; // 60-min runaway ceiling
    this.defaultInactivityTimeout = options.inactivityTimeout || 600; // 10 minutes of full silence = stuck
    this.defaultKillOnInactivity = options.killOnInactivity === true;
    this.defaultInactivityCheckIntervalMs = options.inactivityCheckIntervalMs || 10000;
    this.defaultModel = options.model || process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-5-20250929';

    // Build PATH: ~/.local/bin > nvm node > system PATH
    const homeDir = process.env.HOME || '/root';
    this.homeDir = homeDir;
    this.localBinPath = `${homeDir}/.local/bin`;
    this.nodePath = this._detectNodePath();

    logger.info(`[ClaudeCodeCLI] Initialized (command: ${this.claudeCommand}, model: ${this.defaultModel}, timeout: ${this.defaultTimeout}s)`);
  }

  /**
   * Detect the correct Node.js binary path for the current environment
   */
  _detectNodePath() {
    // Check common Docker/Linux paths first
    if (fs.existsSync('/usr/local/bin/node')) {
      return '/usr/local/bin';
    }
    // Check nvm path (macOS/Linux dev)
    const nvmPath = `${this.homeDir}/.nvm/versions/node`;
    if (fs.existsSync(nvmPath)) {
      try {
        const versions = fs.readdirSync(nvmPath);
        if (versions.length > 0) {
          const latest = versions.sort().pop();
          return `${nvmPath}/${latest}/bin`;
        }
      } catch (e) { /* ignore */ }
    }
    return '/usr/local/bin';
  }

  /**
   * Get the PATH string with all required directories
   */
  getEnhancedPath() {
    return `${this.localBinPath}:${this.nodePath}:${process.env.PATH}`;
  }

  /**
   * Build CLI arguments for claude invocation
   * @param {string} task - The task/prompt to send
   * @param {Object} options - Additional options
   * @returns {string[]} CLI argument array
   * @private
   */
  _buildArgs(task, options = {}) {
    const model = options.model || this.defaultModel;
    const outputFormat = options.streaming ? 'stream-json' : 'json';

    const args = [
      '-p',                              // Print mode (non-interactive)
      '--model', model,                  // Model selection
      '--output-format', outputFormat,   // JSON or stream-json output
    ];

    // stream-json in print mode requires --verbose (the CLI rejects it otherwise).
    // Streaming is what makes silence measurable: every message/tool event refreshes
    // the activity tracker, so the inactivity circuit breaker only fires on a run
    // that is GENUINELY producing nothing — not on a long, busy one.
    if (outputFormat === 'stream-json') {
      args.push('--verbose');
    }

    // Permission handling for root container execution:
    // - claude CLI rejects `--dangerously-skip-permissions` when uid=0 ("cannot be used with root/sudo privileges")
    // - claude CLI rejects `-y` ("unknown option")
    // So in root containers we cannot bypass permission prompts at the CLI layer.
    // Workaround: claude in -p mode WITHOUT a permission flag still answers prompts —
    // it just returns "please approve" instead of writing files. The bot-node-server
    // then captures the response text and writes it to the workspace as a deliverable
    // (see bot-node-execution-handler — DELIVERABLE-from-RESPONSE behaviour).
    //
    // For non-root operators, --dangerously-skip-permissions still works.
    const isRoot = (process.getuid && process.getuid() === 0) || process.env.USER === 'root';
    if (!isRoot) {
      args.push('--dangerously-skip-permissions');
      logger.info('[ClaudeCodeCLI] Non-root — using --dangerously-skip-permissions');
    } else {
      // Root containers can't use --dangerously-skip-permissions (claude rejects it at uid=0).
      // But --permission-mode acceptEdits + a permissions allow-list ARE honored as root, and
      // auto-approve file writes/edits + tool use WITHOUT the interactive "Allow?" dialog. Without
      // this, claude in -p mode returns a "please click Allow" prompt and never writes the file,
      // so build tickets escalate with zero deliverables. (Claude Code ≥2.1 supports both flags.)
      args.push('--permission-mode', 'acceptEdits');
      args.push('--settings', JSON.stringify({ permissions: { allow: ['Bash', 'Write', 'Edit', 'MultiEdit', 'Read', 'Glob', 'Grep', 'LS', 'NotebookEdit'] } }));
      logger.info('[ClaudeCodeCLI] Root container — using --permission-mode acceptEdits + permissions allow-list so file writes are auto-approved (no dialog)');
    }

    args.push('--no-session-persistence');  // Don't persist session to disk

    // Handle turn limits - allow unlimited turns unless explicitly specified
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
      logger.info(`[ClaudeCodeCLI] Using specified max turns: ${options.maxTurns}`);
    }
    // No default turn limits - let operations run to completion

    // Add system prompt if provided
    if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    }

    // PHASE_10 FIX: Pass the task via stdin instead of as a CLI argument.
    // Large prompts (14KB+) cause the Claude CLI to hang silently when passed
    // as positional arguments. Piping via stdin works reliably at any size.
    // The task is written to proc.stdin in executeTask()/executeTaskStreaming().
    // Do NOT append task to args here.

    return args;
  }

  /**
   * Parse JSON result from claude CLI output
   * @param {string} stdout - Raw stdout from claude process
   * @returns {Object} Parsed result object
   * @private
   */
  _parseJsonResult(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { success: false, error: 'Empty output from claude CLI' };
    }

    try {
      const parsed = JSON.parse(trimmed);

      // Claude CLI JSON output format:
      // { type: "result", subtype: "success", result: "...", total_cost_usd: ..., usage: {...}, modelUsage: {...} }
      if (parsed.type === 'result') {
        return {
          success: parsed.subtype === 'success' && !parsed.is_error,
          result: parsed.result || '',
          costUSD: parsed.total_cost_usd || 0,
          durationMs: parsed.duration_ms || 0,
          durationApiMs: parsed.duration_api_ms || 0,
          numTurns: parsed.num_turns || 1,
          sessionId: parsed.session_id || null,
          usage: {
            inputTokens: parsed.usage?.input_tokens || 0,
            outputTokens: parsed.usage?.output_tokens || 0,
            cacheCreationTokens: parsed.usage?.cache_creation_input_tokens || 0,
            cacheReadTokens: parsed.usage?.cache_read_input_tokens || 0,
          },
          modelUsage: parsed.modelUsage || {},
          raw: parsed,
          resultEventFound: true,
        };
      }

      // Fallback: treat as generic JSON (a single non-result object — NOT a completed
      // stream; resultEventFound stays false so a streaming caller can reject).
      return {
        success: true,
        resultEventFound: false,
        result: parsed.result || JSON.stringify(parsed),
        costUSD: parsed.total_cost_usd || 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        raw: parsed,
      };
    } catch (parseErr) {
      // Not valid JSON — might be multiple JSON objects (NDJSON)
      // Try parsing the last line as JSON
      const lines = trimmed.split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const lastParsed = JSON.parse(lines[i]);
          if (lastParsed.type === 'result') {
            return {
              success: lastParsed.subtype === 'success' && !lastParsed.is_error,
              result: lastParsed.result || '',
              costUSD: lastParsed.total_cost_usd || 0,
              durationMs: lastParsed.duration_ms || 0,
              numTurns: lastParsed.num_turns || 1,
              usage: {
                inputTokens: lastParsed.usage?.input_tokens || 0,
                outputTokens: lastParsed.usage?.output_tokens || 0,
                cacheCreationTokens: lastParsed.usage?.cache_creation_input_tokens || 0,
                cacheReadTokens: lastParsed.usage?.cache_read_input_tokens || 0,
              },
              modelUsage: lastParsed.modelUsage || {},
              raw: lastParsed,
              resultEventFound: true,
            };
          }
        } catch (e) { /* not JSON, try next line */ }
      }

      // Last resort: return raw text. resultEventFound:false — under stream-json this means
      // the stream ended WITHOUT a final result event (crash/kill/truncation), which the
      // caller must treat as a failure, not a successful raw-text response.
      logger.warn(`[ClaudeCodeCLI] Could not parse JSON output, returning raw text (${trimmed.length} chars)`);
      return {
        success: true,
        resultEventFound: false,
        result: trimmed,
        costUSD: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        raw: trimmed,
      };
    }
  }

  /**
   * Parse a single NDJSON line from stream-json output
   * @param {string} line - Single NDJSON line
   * @returns {Object|null} Parsed event or null
   * @private
   */
  _parseStreamLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed);
    } catch (e) {
      logger.debug(`[ClaudeCodeCLI] Non-JSON stream line: ${trimmed.substring(0, 200)}`);
      return null;
    }
  }

  /**
   * Create an activity tracker for monitoring Claude process liveness.
   * @param {number} inactivityTimeoutMs - Ms of silence before considered stalled
   * @returns {object} Activity tracker
   * @private
   */
  _createActivityTracker(inactivityTimeoutMs) {
    const tracker = {
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      totalMessages: 0,
      toolUseCount: 0,
      thinkingCount: 0,
      completionCount: 0,
      errorCount: 0,
      stderrLines: 0,
      inactivityTimeoutMs,
      warningEmitted: false,

      touch(messageType = null) {
        this.lastActivityTime = Date.now();
        this.totalMessages++;
        if (messageType === 'tool_use') this.toolUseCount++;
        else if (messageType === 'thinking') this.thinkingCount++;
        else if (messageType === 'result') this.completionCount++;
        else if (messageType === 'error') this.errorCount++;
      },

      touchStderr() {
        this.lastActivityTime = Date.now();
        this.stderrLines++;
      },

      silenceDuration() {
        return Date.now() - this.lastActivityTime;
      },

      elapsed() {
        return Date.now() - this.startTime;
      },

      isStalled() {
        return this.silenceDuration() >= this.inactivityTimeoutMs;
      },

      shouldWarn() {
        const warningThreshold = this.inactivityTimeoutMs * 0.67;
        if (!this.warningEmitted && this.silenceDuration() >= warningThreshold) {
          this.warningEmitted = true;
          return true;
        }
        return false;
      },

      resetWarning() {
        this.warningEmitted = false;
      },

      getStats() {
        return {
          elapsedMs: this.elapsed(),
          elapsedFormatted: `${Math.round(this.elapsed() / 1000)}s`,
          silenceMs: this.silenceDuration(),
          silenceFormatted: `${Math.round(this.silenceDuration() / 1000)}s`,
          totalMessages: this.totalMessages,
          toolUseCount: this.toolUseCount,
          thinkingCount: this.thinkingCount,
          completionCount: this.completionCount,
          errorCount: this.errorCount,
          stderrLines: this.stderrLines,
          isStalled: this.isStalled(),
        };
      },
    };
    return tracker;
  }

  /**
   * Execute a task using Claude Code CLI (batch mode — waits for completion)
   * Uses --output-format json for structured response
   * 
   * @param {string} taskDescription - The task/prompt to execute
   * @param {string} workspaceDir - Working directory for the task
   * @param {object} options - Additional options
   * @returns {Promise<object>} Task result with response, cost, usage
   */
  async executeTask(taskDescription, workspaceDir, options = {}) {
    assertCliToolBoundary(options, 'claude-code');
    const hardTimeoutSec = options.timeout || this.defaultTimeout;
    const inactivityTimeoutSec = options.inactivityTimeout || this.defaultInactivityTimeout;
    const configuredKillOnInactivity = options.killOnInactivity === undefined
      ? this.defaultKillOnInactivity
      : options.killOnInactivity === true;
    const inactivityCheckIntervalMs = options.inactivityCheckIntervalMs || this.defaultInactivityCheckIntervalMs;
    const hardTimeoutMs = hardTimeoutSec * 1000;
    const inactivityTimeoutMs = inactivityTimeoutSec * 1000;
    // Per-request user scoping for shelled-out tools (oshal-gmail.js) — env + cwd file.
    // Streaming defaults ON (operator directive 2026-07-24): stream-json makes the
    // activity tracker real (batch json is silent until the final object, so silence
    // could never distinguish stuck from working). _parseJsonResult already normalizes
    // NDJSON, so the final-result extraction is unchanged. Pass streaming:false to
    // explicitly opt a call back into batch mode.
    const isStreaming = options.streaming !== false;
    // Idle-kill requires MEASURABLE idleness: a batch run is legitimately silent until
    // its final JSON, so the kill flag is disarmed there regardless of config — batch
    // stays warn-only and the hard ceiling owns termination (ADR-081 honesty rule).
    const killOnInactivity = configuredKillOnInactivity && isStreaming;
    const args = this._buildArgs(taskDescription, {
      model: options.model || this.defaultModel,
      streaming: isStreaming,
      systemPrompt: options.systemPrompt,
      maxTurns: options.maxTurns,
      autoApprove: options.autoApprove,
      source: options.source,
    });

    logger.info(`[ClaudeCodeCLI] Executing task in ${workspaceDir}`);
    logger.info(`[ClaudeCodeCLI] Task: ${taskDescription.substring(0, 150)}... (${taskDescription.length} chars)`);
    logger.info(`[ClaudeCodeCLI] Running: ${this.claudeCommand} ${args.map(a => a.length > 100 ? a.substring(0, 100) + '...' : a).join(' ')}`);
    logger.info(`[ClaudeCodeCLI] Timeout: hard=${hardTimeoutSec}s, inactivity=${inactivityTimeoutSec}s, inactivityMode=${killOnInactivity ? 'kill' : 'warn-only'}`);
    const userScope = await acquireUserScoping(workspaceDir, options.extraEnv);
    const scopeEnv = userScope.env;

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let stalledOut = false;
      let inactivityObserved = false;

      const activity = this._createActivityTracker(inactivityTimeoutMs);

      const proc = spawn(this.claudeCommand, args, {
        cwd: workspaceDir,
        env: {
          ...process.env,
          PATH: this.getEnhancedPath(),
          ...scopeEnv,
        },
        shell: false, // No shell — claude binary handles args directly
      });

      // PHASE_10 FIX: Pipe prompt via stdin instead of CLI argument.
      // Large prompts (14KB+) hang when passed as positional args.
      proc.stdin.write(taskDescription);
      proc.stdin.end();
      logger.info(`[ClaudeCodeCLI] Wrote ${taskDescription.length} chars to stdin`);

      // === HARD TIMEOUT ===
      const hardTimer = setTimeout(() => {
        timedOut = true;
        const stats = activity.getStats();
        logger.warn(`[ClaudeCodeCLI] HARD TIMEOUT after ${hardTimeoutSec}s. Messages: ${stats.totalMessages}, silence: ${stats.silenceFormatted}`);
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
      }, hardTimeoutMs);

      // === INACTIVITY MONITOR ===
      const inactivityChecker = setInterval(() => {
        if (activity.shouldWarn()) {
          const stats = activity.getStats();
          logger.warn(`[ClaudeCodeCLI] INACTIVITY WARNING — no output for ${stats.silenceFormatted} (threshold: ${inactivityTimeoutSec}s)`);
        }
        if (activity.isStalled()) {
          const stats = activity.getStats();
          if (!killOnInactivity) {
            if (!inactivityObserved) {
              inactivityObserved = true;
              logger.warn(`[ClaudeCodeCLI] INACTIVITY OBSERVED - no output for ${stats.silenceFormatted}; process remains alive and hard timeout owns termination.`);
            }
            return;
          }
          stalledOut = true;
          logger.error(`[ClaudeCodeCLI] INACTIVITY CIRCUIT BREAKER — no output for ${stats.silenceFormatted}. Killing process.`);
          proc.kill('SIGTERM');
          setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
        }
      }, inactivityCheckIntervalMs);

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        activity.touch();
        activity.resetWarning();
        // Log progress (truncated)
        if (chunk.trim()) {
          logger.debug(`[ClaudeCodeCLI] stdout: ${chunk.trim().substring(0, 300)}`);
        }
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        activity.touchStderr();
        activity.resetWarning();
        logger.warn(`[ClaudeCodeCLI] stderr: ${chunk.trim().substring(0, 500)}`);
      });

      proc.on('error', (err) => {
        clearTimeout(hardTimer);
        clearInterval(inactivityChecker);
        logger.error(`[ClaudeCodeCLI] Process spawn error: ${err.message}`);
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        clearTimeout(hardTimer);
        clearInterval(inactivityChecker);
        const activityStats = activity.getStats();
        logger.info(`[ClaudeCodeCLI] Process exited: code=${code}, signal=${signal}, timedOut=${timedOut}, stalledOut=${stalledOut}`);
        logger.info(`[ClaudeCodeCLI] Activity: elapsed=${activityStats.elapsedFormatted}, silence=${activityStats.silenceFormatted}, messages=${activityStats.totalMessages}, inactivityObserved=${inactivityObserved}`);

        if (stalledOut) {
          reject(new Error(
            `Claude CLI stalled — no output for ${inactivityTimeoutSec}s. ` +
            `Elapsed: ${activityStats.elapsedFormatted}\n` +
            `stderr: ${stderr.substring(0, 500)}`
          ));
          return;
        }

        if (timedOut) {
          reject(new Error(
            `Claude CLI hard timeout after ${hardTimeoutSec}s.\n` +
            `stderr: ${stderr.substring(0, 500)}`
          ));
          return;
        }

        if (code === 0 || stdout.trim()) {
          // Parse the JSON result
          const parsed = this._parseJsonResult(stdout);

          // Streaming crash guard (2026-07-24 idle-timeout review): under stream-json a
          // completed run ALWAYS ends with a `type:"result"` event. Its absence means the
          // CLI died/was-killed mid-stream — the raw-text fallback must NOT masquerade as a
          // successful response (silent garbage). Fail LOUDLY instead. (Batch json legitimately
          // has no result-event stream, so this only applies when streaming.)
          if (isStreaming && !parsed.resultEventFound) {
            reject(new Error(
              `Claude CLI (stream-json) ended without a final result event ` +
              `(exit code=${code}) — the process crashed or was killed mid-stream. ` +
              `Captured ${stdout.length} chars of partial output.\n` +
              `stderr: ${stderr.substring(0, 500)}`
            ));
            return;
          }

          resolve({
            success: parsed.success,
            text: parsed.result,
            result: parsed.result,
            costUSD: parsed.costUSD,
            durationMs: parsed.durationMs || activityStats.elapsedMs,
            numTurns: parsed.numTurns,
            sessionId: parsed.sessionId,
            usage: parsed.usage,
            modelUsage: parsed.modelUsage,
            exitCode: code,
            stderr: stderr,
            activityStats,
            inactivityObserved,
            raw: parsed.raw,
          });
        } else {
          // Non-zero exit with no stdout
          logger.error(`[ClaudeCodeCLI] Task failed with code ${code}`);
          logger.error(`[ClaudeCodeCLI] stderr: ${stderr}`);
          reject(new Error(
            `Claude CLI exited with code ${code}\n` +
            `stderr: ${stderr}\n` +
            `stdout: ${stdout.substring(0, 500)}`
          ));
        }
      });
    }).finally(userScope.release);
  }

  /**
   * Execute a task with streaming output (stream-json format)
   * Each NDJSON line is passed to onEvent callback
   * 
   * @param {string} taskDescription - The task/prompt
   * @param {string} workspaceDir - Working directory
   * @param {object} options - Options including onEvent callback
   * @returns {Promise<object>} Final result
   */
  async executeTaskStreaming(taskDescription, workspaceDir, options = {}) {
    assertCliToolBoundary(options, 'claude-code');
    const { onEvent } = options;
    const hardTimeoutSec = options.timeout || this.defaultTimeout;
    const inactivityTimeoutSec = options.inactivityTimeout || this.defaultInactivityTimeout;
    const killOnInactivity = options.killOnInactivity === undefined
      ? this.defaultKillOnInactivity
      : options.killOnInactivity === true;
    const inactivityCheckIntervalMs = options.inactivityCheckIntervalMs || this.defaultInactivityCheckIntervalMs;
    const hardTimeoutMs = hardTimeoutSec * 1000;
    const inactivityTimeoutMs = inactivityTimeoutSec * 1000;
    const args = this._buildArgs(taskDescription, {
      model: options.model || this.defaultModel,
      streaming: true,
      systemPrompt: options.systemPrompt,
      maxTurns: options.maxTurns,
      autoApprove: options.autoApprove,
      source: options.source,
    });

    logger.info(`[ClaudeCodeCLI] Streaming task in ${workspaceDir}`);
    logger.info(`[ClaudeCodeCLI] Streaming timeout: hard=${hardTimeoutSec}s, inactivity=${inactivityTimeoutSec}s, inactivityMode=${killOnInactivity ? 'kill' : 'warn-only'}`);
    const userScope = await acquireUserScoping(workspaceDir, options.extraEnv);
    const scopeEnv = userScope.env;

    return new Promise((resolve, reject) => {
      const events = [];
      let stderr = '';
      let lineBuffer = '';
      let timedOut = false;
      let stalledOut = false;
      let inactivityObserved = false;
      let finalResult = null;

      const activity = this._createActivityTracker(inactivityTimeoutMs);

      const proc = spawn(this.claudeCommand, args, {
        cwd: workspaceDir,
        env: { ...process.env, PATH: this.getEnhancedPath(), ...scopeEnv },
        shell: false,
      });

      // PHASE_10 FIX: Pipe prompt via stdin (same as executeTask)
      proc.stdin.write(taskDescription);
      proc.stdin.end();

      const hardTimer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
      }, hardTimeoutMs);

      const inactivityChecker = setInterval(() => {
        if (activity.shouldWarn()) {
          const stats = activity.getStats();
          logger.warn(`[ClaudeCodeCLI] STREAM INACTIVITY WARNING - no output for ${stats.silenceFormatted} (threshold: ${inactivityTimeoutSec}s)`);
        }
        if (activity.isStalled()) {
          const stats = activity.getStats();
          if (!killOnInactivity) {
            if (!inactivityObserved) {
              inactivityObserved = true;
              logger.warn(`[ClaudeCodeCLI] STREAM INACTIVITY OBSERVED - no output for ${stats.silenceFormatted}; process remains alive and hard timeout owns termination.`);
            }
            return;
          }
          stalledOut = true;
          proc.kill('SIGTERM');
          setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
        }
      }, inactivityCheckIntervalMs);

      proc.stdout.on('data', (chunk) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          const parsed = this._parseStreamLine(line);
          if (parsed) {
            events.push(parsed);
            activity.touch(parsed.type || null);
            activity.resetWarning();

            // Track the final result event
            if (parsed.type === 'result') {
              finalResult = parsed;
            }

            if (typeof onEvent === 'function') {
              try { onEvent(parsed); } catch (e) { /* ignore callback errors */ }
            }
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        activity.touchStderr();
        activity.resetWarning();
      });

      proc.on('error', (err) => {
        clearTimeout(hardTimer);
        clearInterval(inactivityChecker);
        reject(err);
      });

      proc.on('close', (code) => {
        clearTimeout(hardTimer);
        clearInterval(inactivityChecker);
        // Flush remaining buffer
        if (lineBuffer.trim()) {
          const parsed = this._parseStreamLine(lineBuffer);
          if (parsed) {
            events.push(parsed);
            if (parsed.type === 'result') finalResult = parsed;
            if (typeof onEvent === 'function') {
              try { onEvent(parsed); } catch (e) { /* ignore */ }
            }
          }
        }

        const activityStats = activity.getStats();

        if (stalledOut || timedOut) {
          reject(new Error(`Claude CLI ${stalledOut ? 'stalled' : 'timed out'}. stderr: ${stderr.substring(0, 500)}`));
          return;
        }

        resolve({
          success: code === 0 && !!finalResult,
          events,
          finalResult: finalResult ? {
            result: finalResult.result || '',
            costUSD: finalResult.total_cost_usd || 0,
            usage: finalResult.usage || {},
            modelUsage: finalResult.modelUsage || {},
          } : null,
          exitCode: code,
          stderr,
          activityStats,
          inactivityObserved,
        });
      });
    }).finally(userScope.release);
  }

  /**
   * Check if Claude CLI is installed and available.
   * Uses `--version` flag which is fast and local (no network).
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      return await new Promise((resolve) => {
        const proc = spawn(this.claudeCommand, ['--version'], {
          env: buildCliDiagnosticEnv({ path: this.getEnhancedPath() }),
          shell: false,
        });

        let stdout = '';
        let resolved = false;

        const hardTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            try { proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
            resolve(false);
          }
        }, 8000);

        proc.stdout.on('data', (data) => { stdout += data.toString(); });

        proc.on('close', (code) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(hardTimeout);
            resolve(code === 0 && stdout.trim().length > 0);
          }
        });

        proc.on('error', () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(hardTimeout);
            resolve(false);
          }
        });
      });
    } catch (e) {
      return false;
    }
  }

  /**
   * Get Claude CLI version.
   * @returns {Promise<string|null>}
   */
  async getVersion() {
    try {
      return await new Promise((resolve) => {
        const proc = spawn(this.claudeCommand, ['--version'], {
          env: buildCliDiagnosticEnv({ path: this.getEnhancedPath() }),
          shell: false,
        });

        let stdout = '';
        let resolved = false;

        const hardTimeout = setTimeout(() => {
          if (!resolved) { resolved = true; try { proc.kill('SIGTERM'); } catch (e) {} resolve(null); }
        }, 8000);

        proc.stdout.on('data', (data) => { stdout += data.toString(); });

        proc.on('close', (code) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(hardTimeout);
            if (code === 0) {
              const trimmed = stdout.trim();
              const match = trimmed.match(/(\d+\.\d+\.\d+)/);
              resolve(match ? match[1] : trimmed || null);
            } else {
              resolve(null);
            }
          }
        });

        proc.on('error', () => {
          if (!resolved) { resolved = true; clearTimeout(hardTimeout); resolve(null); }
        });
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * Get Claude CLI authentication status.
   * Runs `claude auth status` and parses the JSON output.
   * @returns {Promise<{loggedIn: boolean, authMethod: string|null, email: string|null}|null>}
   */
  async getAuthStatus() {
    try {
      return await new Promise((resolve) => {
        const proc = spawn(this.claudeCommand, ['auth', 'status'], {
          env: buildCliDiagnosticEnv({ path: this.getEnhancedPath() }),
          shell: false,
        });

        let stdout = '';
        let stderr = '';
        let resolved = false;

        const hardTimeout = setTimeout(() => {
          if (!resolved) { resolved = true; try { proc.kill('SIGTERM'); } catch (e) {} resolve(null); }
        }, 10000);

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(hardTimeout);
            // Try to parse JSON from stdout or stderr
            const combined = stdout + stderr;
            try {
              const parsed = JSON.parse(combined.trim());
              resolve({
                loggedIn: parsed.loggedIn === true,
                authMethod: parsed.authMethod || null,
                email: parsed.email || null,
                apiProvider: parsed.apiProvider || null,
              });
            } catch (e) {
              // Check for text indicators
              if (combined.includes('loggedIn') && combined.includes('true')) {
                resolve({ loggedIn: true, authMethod: 'unknown', email: null });
              } else {
                resolve({ loggedIn: false, authMethod: null, email: null });
              }
            }
          }
        });

        proc.on('error', () => {
          if (!resolved) { resolved = true; clearTimeout(hardTimeout); resolve(null); }
        });
      });
    } catch (e) {
      return null;
    }
  }
}

module.exports = ClaudeCodeCLIWrapper;

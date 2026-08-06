/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: default-deny unbrokered autonomous CLI execution before credential setup or process spawn.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: keep live version probes credential-free and guard internal execution helpers against direct invocation.
 */

/**
 * Cline CLI Wrapper
 * Wraps the official Cline CLI for programmatic task execution
 * Provides codebase awareness and autonomous coding capabilities
 * 
 * CIRCUIT BREAKER: Two-tier timeout system
 * - Inactivity timeout: Kills process if no stdout/stderr output for N seconds (default: 180s / 3 min)
 *   Resets on every line of output, so a hard-working Cline can run indefinitely.
 * - Hard timeout: Absolute wall-clock max (default: 3600s / 1 hour) as safety net.
 * - Activity tracking: Counts messages, tool_use events, and tracks last activity timestamp.
 * 
 * Note: MCP servers are configured via ~/.cline/mcp_settings.json by setup-cline-auth.sh
 * Cline CLI automatically loads MCP configuration from this location at runtime.
 */

const { spawn } = require('child_process');
const { acquireUserScoping } = require('./user-scoping');
const { buildCliDiagnosticEnv } = require('./cli-diagnostic-env');
const { assertCliToolBoundary } = require('../llm/assert-cli-tool-boundary');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const FrontDoorClient = require('../FrontDoorClient');

/**
 * Resolve the access token Cline should pass to Claude.
 *   1. ANTHROPIC_API_KEY env (explicit override)
 *   2. claude-code OAuth file at /root/.claude/.credentials.json
 *      (the host's ~/.claude/.credentials.json mounted in by compose)
 * Returns '' when neither is available.
 */
function resolveClaudeAccessToken() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const oauthPath = '/root/.claude/.credentials.json';
  try {
    if (!fs.existsSync(oauthPath)) return '';
    const raw = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
    const tok = raw && raw.claudeAiOauth && raw.claudeAiOauth.accessToken;
    return typeof tok === 'string' ? tok : '';
  } catch (_e) {
    return '';
  }
}

class ClineCLIWrapper {
  constructor(options = {}) {
    this.clineCommand = options.clineCommand || 'cline';
    this.defaultTimeout = options.timeout || 3600; // 1 hour hard max — safety net only, inactivity timeout does the real work
    this.defaultInactivityTimeout = options.inactivityTimeout || 180; // 3 minutes of silence = stalled
    this.defaultKillOnInactivity = options.killOnInactivity === true
      || String(process.env.CLINE_KILL_ON_INACTIVITY || '').trim().toLowerCase() === 'true';
    
    // ⭐ PHASE_00_SESSION_05 FIX (Bug #3): Concurrency control to prevent memory explosion
    // Limits max concurrent ClineCLI processes to prevent runaway ticket loop from spawning
    // hundreds of child processes that consume 7GB+ RAM and 800%+ CPU
    this.maxConcurrentProcesses = options.maxConcurrentProcesses || 5;
    this.activeProcesses = 0; // Current number of running ClineCLI processes
    this.queuedRequests = []; // Queue of pending requests waiting for slot
    
    // Build PATH: patched cline wrapper (~/.local/bin) > nvm node > system PATH
    const homeDir = process.env.HOME || '/root';
    this.homeDir = homeDir;
    
    // ⭐ PHASE_54 SESSION_11 FIX: REVERTED isolated HOME approach.
    // The isolated HOME (~/.cline-any-bot/) breaks the `claude` binary's auth:
    //   "Configuration file not found at ~/.cline-any-bot/.claude.json"
    //   "Authentication required - no valid credentials found"
    // Even though .claude.json is copied, the claude binary uses os.homedir() internally
    // and cannot authenticate when HOME is redirected.
    // 
    // NEW STRATEGY: Use the REAL HOME directory. The _ensureModelConfig() safety net
    // runs before every spawn and force-writes correct provider/model config.
    // This protects against VSCode extension config drift.
    this.clineConfigDir = homeDir;
    // Seed config files immediately so they exist before first spawn
    try {
      this._ensureModelConfig();
    } catch (err) {
      logger.warn(`[ClineCLI] Initial config seeding failed (will retry before spawn): ${err.message}`);
    }
    this.localBinPath = `${homeDir}/.local/bin`;
    // Auto-detect node path: use NODE_PATH_OVERRIDE if set, else detect environment
    this.nodePath = process.env.NODE_PATH_OVERRIDE || this._detectNodePath();
    
    // ⭐ PHASE_43 SESSION_06 FIX: Disable Front Door API for ClineProvider
    // Front Door causes infinite recursion: ClineProvider → Front Door → AgenticController → ClineProvider → ...
    // LLMRouter can use Front Door because it uses BedrockProvider (no recursion)
    // ClineProvider should use direct spawn for tickets (no conversation history needed)
    this.useFrontDoorAPI = false; // DISABLED - causes infinite recursion
    this.frontDoorClient = new FrontDoorClient(options.frontDoorUrl, this.defaultTimeout * 1000);
    
    logger.info('[ClineCLI] Using direct spawn (Front Door disabled - prevents infinite recursion)');
  }

  // _ensureIsolatedConfigDir() REMOVED in SESSION_11.
  // Isolated HOME broke claude binary auth. Using real HOME with _ensureModelConfig() safety net.

  /**
   * Detect the correct Node.js binary path for the current environment
   * In Docker (Alpine), node is at /usr/local/bin
   * On macOS with nvm, it's at ~/.nvm/versions/node/vXX/bin
   * @returns {string} Path to directory containing node binary
   */
  _detectNodePath() {
    const fs = require('fs');
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
          // Use the most recent version
          const latest = versions.sort().pop();
          return `${nvmPath}/${latest}/bin`;
        }
      } catch (e) { /* ignore */ }
    }
    // Fallback: just use what's in PATH already
    return '/usr/local/bin';
  }

  /**
   * Get the PATH string with all required directories
   */
  getEnhancedPath() {
    return `${this.localBinPath}:${this.nodePath}:${process.env.PATH}`;
  }

  /**
   * Acquire a concurrency slot for executing a ClineCLI process.
   * If all slots are taken, queues the request and waits for a slot to free up.
   * 
   * ⭐ PHASE_00_SESSION_05 FIX (Bug #3): Semaphore-based concurrency control
   * 
   * @returns {Promise<void>} Resolves when a slot is acquired
   * @private
   */
  async _acquireConcurrencySlot() {
    if (this.activeProcesses < this.maxConcurrentProcesses) {
      // Slot available - take it immediately
      this.activeProcesses++;
      logger.info(`[ClineCLI] 🟢 Concurrency slot acquired (${this.activeProcesses}/${this.maxConcurrentProcesses} active, ${this.queuedRequests.length} queued)`);
      return Promise.resolve();
    }

    // All slots taken - queue this request
    logger.warn(`[ClineCLI] 🟡 All concurrency slots full (${this.activeProcesses}/${this.maxConcurrentProcesses}). Queueing request... (queue depth: ${this.queuedRequests.length})`);
    
    return new Promise((resolve) => {
      this.queuedRequests.push(resolve);
    });
  }

  /**
   * Release a concurrency slot after ClineCLI process completes.
   * If there are queued requests, grants the slot to the next request in queue.
   * 
   * ⭐ PHASE_00_SESSION_05 FIX (Bug #3): Semaphore-based concurrency control
   * 
   * @private
   */
  _releaseConcurrencySlot() {
    this.activeProcesses--;

    if (this.queuedRequests.length > 0) {
      // Grant slot to next queued request
      const nextRequest = this.queuedRequests.shift();
      this.activeProcesses++;
      logger.info(`[ClineCLI] 🟢 Concurrency slot released and granted to queued request (${this.activeProcesses}/${this.maxConcurrentProcesses} active, ${this.queuedRequests.length} queued)`);
      nextRequest(); // Resolve the queued promise
    } else {
      // No queued requests - slot is now free
      logger.info(`[ClineCLI] 🟢 Concurrency slot released (${this.activeProcesses}/${this.maxConcurrentProcesses} active, ${this.queuedRequests.length} queued)`);
    }
  }

  /**
   * Create an activity tracker for monitoring Cline process liveness.
   * Tracks last output timestamp, message counts, and provides
   * inactivity detection.
   * 
   * @param {number} inactivityTimeoutMs - Ms of silence before considered stalled
   * @returns {object} Activity tracker with touch(), getStats(), and isStalled() methods
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

      /** Record activity — call on every stdout/stderr line */
      touch(messageType = null) {
        this.lastActivityTime = Date.now();
        this.totalMessages++;
        if (messageType === 'tool_use') this.toolUseCount++;
        else if (messageType === 'thinking') this.thinkingCount++;
        else if (messageType === 'completion_result') this.completionCount++;
        else if (messageType === 'error') this.errorCount++;
      },

      /** Record stderr activity */
      touchStderr() {
        this.lastActivityTime = Date.now();
        this.stderrLines++;
      },

      /** How long since last output (ms) */
      silenceDuration() {
        return Date.now() - this.lastActivityTime;
      },

      /** Total elapsed time (ms) */
      elapsed() {
        return Date.now() - this.startTime;
      },

      /** Is the process considered stalled? */
      isStalled() {
        return this.silenceDuration() >= this.inactivityTimeoutMs;
      },

      /** Should we emit a warning? (at 2/3 of inactivity timeout) */
      shouldWarn() {
        const warningThreshold = this.inactivityTimeoutMs * 0.67;
        if (!this.warningEmitted && this.silenceDuration() >= warningThreshold) {
          this.warningEmitted = true;
          return true;
        }
        return false;
      },

      /** Reset warning flag (after activity resumes) */
      resetWarning() {
        this.warningEmitted = false;
      },

      /** Get a stats snapshot */
      getStats() {
        // ⭐ PHASE_35: Estimate cost from activity metrics
        // Cline CLI doesn't expose token counts, so estimate from message/tool counts
        // Claude 3.5 Sonnet pricing: $3/M input, $15/M output
        const estimatedInputTokens = this.totalMessages * 500; // ~500 tokens per message (prompt)
        const estimatedOutputTokens = (this.toolUseCount * 200) + (this.totalMessages * 300); // tools + responses
        const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
        const estimatedCost = (estimatedInputTokens / 1_000_000) * 3.0 + (estimatedOutputTokens / 1_000_000) * 15.0;
        
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
          // ⭐ PHASE_35: Estimated cost data
          inputTokens: estimatedInputTokens,
          outputTokens: estimatedOutputTokens,
          totalTokens: estimatedTotalTokens,
          estimatedCost: parseFloat(estimatedCost.toFixed(4)),
          costEstimated: true, // Flag to indicate this is estimated, not real
        };
      },
    };

    return tracker;
  }

  /**
   * Execute a task using Cline CLI with real-time streaming.
   * Spawns cline --json --yolo and calls onMessage(parsedJSON) for each NDJSON line.
   * Returns a promise that resolves when the process exits.
   *
   * CIRCUIT BREAKER: Two-tier timeout
   * - Inactivity timeout: Resets on every output line. Kills if no output for inactivityTimeout seconds.
   * - Hard timeout: Absolute wall-clock max. Kills regardless of activity.
   *
   * ⭐ PHASE_00_SESSION_05: Wrapped with concurrency control to prevent memory explosion
   *
   * @param {string} taskDescription - The task to execute
   * @param {string} workspaceDir - Working directory for the task
   * @param {object} options - Additional options
   * @param {Function} options.onMessage - Callback invoked with each parsed JSON object from stdout
   * @param {Function} [options.onError] - Callback invoked on stderr lines
   * @param {Function} [options.onExit] - Callback invoked with result when process exits
   * @param {Function} [options.onActivityStats] - Callback invoked periodically with activity stats
   * @param {number} [options.timeout] - Hard timeout in seconds (default: 1200)
   * @param {number} [options.inactivityTimeout] - Inactivity timeout in seconds (default: 180)
   * @param {string} [options.model] - Model to use
   * @returns {Promise<{success: boolean, messages: Array, exitCode: number, activityStats: object}>}
   */
  async executeTaskStreaming(taskDescription, workspaceDir, options = {}) {
    assertCliToolBoundary(options, 'cline-cli');
    const userScope = await acquireUserScoping(workspaceDir, options.extraEnv);
    let slotAcquired = false;
    // ⭐ PHASE_00_SESSION_05: Acquire concurrency slot before spawning
    try {
      await this._acquireConcurrencySlot();
      slotAcquired = true;
      return await this._executeTaskStreamingInternal(taskDescription, workspaceDir, {
        ...options,
        _userScopeEnv: userScope.env,
      });
    } finally {
      // ⭐ PHASE_00_SESSION_05: Always release slot, even on error
      if (slotAcquired) this._releaseConcurrencySlot();
      userScope.release();
    }
  }

  /**
   * Internal implementation of executeTaskStreaming (after concurrency slot acquired)
   * @private
   */
  async _executeTaskStreamingInternal(taskDescription, workspaceDir, options = {}) {
    assertCliToolBoundary(options, 'cline-cli');
    const { onMessage, onError, onExit, onActivityStats } = options;
    const hardTimeoutSec = options.timeout || this.defaultTimeout;
    const inactivityTimeoutSec = options.inactivityTimeout || this.defaultInactivityTimeout;
    const killOnInactivity = options.killOnInactivity === undefined
      ? this.defaultKillOnInactivity
      : options.killOnInactivity === true;
    const hardTimeoutMs = hardTimeoutSec * 1000;
    const inactivityTimeoutMs = inactivityTimeoutSec * 1000;

    // Shell-escape the task description to prevent word splitting
    const escapedTask = taskDescription.replace(/'/g, "'\\''");
    
    // YOLO auto-approve (-y) rules:
    // - Ticket/queue/scheduled task mode (source=plane, source=queue, or no source): use -y
    // - Chat/dashboard mode (source=dashboard): NO -y flag — user is present and approves
    // ⭐ PHASE_02_SESSION_07 FIX: Enforce -y flag regardless of source to prevent UI Cockpit (port 5000)
    // from hanging when falling back to Cline CLI without interactive terminal approval.
    const isDashboardChat = options.source === 'dashboard';
    const args = [
      '--json',          // JSON output for parsing
      '-y',              // YOLO auto-approve mode for autonomous background tasks
      '--act',           // Act mode (execution, not planning)
      '-c', workspaceDir, // Working directory
      '--timeout', String(hardTimeoutSec),
      `'${escapedTask}'` // The task prompt (shell-quoted)
    ];
    if (isDashboardChat) {
      logger.info('[ClineCLI] Dashboard mode detected - enforcing -y flag to prevent TTY stall');
    }

    // ⭐ PHASE_05 FIX (UPDATED): GovCloud guard for -m flag
    // Only skip -m in GovCloud when using Bedrock provider (not claude-code)
    // claude-code provider uses the claude binary which handles its own model selection
    const streamRegion = process.env.AWS_REGION || '';
    const streamProvider = process.env.LLM_PROVIDER || 'cline-cli';
    const isClaudeCodeProvider = streamProvider === 'claude-code';
    if (options.model && (isClaudeCodeProvider || !streamRegion.startsWith('us-gov-'))) {
      args.unshift('-m', options.model);
      logger.info(`[ClineCLI] Using model (via -m flag): ${options.model}`);
    } else if (options.model) {
      logger.info(`[ClineCLI] GovCloud+Bedrock: skipping -m flag (CLI uses globalState config). Requested model: ${options.model}`);
    }

    // Ensure globalState.json has correct model config before spawning
    this._ensureModelConfig();

    logger.info(`ClineCLI: Streaming task in ${workspaceDir}`);
    logger.info(`ClineCLI: Task: ${taskDescription.substring(0, 100)}... (${taskDescription.length} chars)`);
    logger.info(`ClineCLI: Hard timeout: ${hardTimeoutSec}s, Inactivity timeout: ${inactivityTimeoutSec}s`);
    logger.info(`ClineCLI: Running: cline ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const messages = [];
      let stderrBuffer = '';
      let lineBuffer = '';
      let timedOut = false;
      let stalledOut = false;
      let inactivityObserved = false;

      // Activity tracker — the heart of the circuit breaker
      const activity = this._createActivityTracker(inactivityTimeoutMs);

      const spawnEnv = {
        ...process.env,
        PATH: this.getEnhancedPath(),
        CLAUDE_CODE_SESSION_ACCESS_TOKEN: resolveClaudeAccessToken(),
        // ⭐ PHASE_54 SESSION_11: Use REAL HOME (not isolated).
        // _ensureModelConfig() force-writes correct config before each spawn.
        HOME: this.homeDir,
        // Per-request user scoping for shelled-out tools (oshal-gmail.js) — env + cwd file.
        ...(options._userScopeEnv || {}),
      };
      logger.info(`[ClineCLI] Streaming spawn with HOME=${spawnEnv.HOME}`);
      logger.info(`[ClineCLI] Streaming spawn with CLAUDE_CODE_SESSION_ACCESS_TOKEN: ${spawnEnv.CLAUDE_CODE_SESSION_ACCESS_TOKEN ? 'SET' : 'NOT SET'}`);

      const proc = spawn(this.clineCommand, args, {
        cwd: workspaceDir,
        env: spawnEnv,
        shell: true,
      });

      // === HARD TIMEOUT: absolute wall-clock safety net ===
      const hardTimer = setTimeout(() => {
        timedOut = true;
        const stats = activity.getStats();
        logger.warn(`ClineCLI: HARD TIMEOUT after ${hardTimeoutSec}s. Stats: messages=${stats.totalMessages}, tools=${stats.toolUseCount}, silence=${stats.silenceFormatted}`);
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      }, hardTimeoutMs);

      // === INACTIVITY MONITOR: checks every 10 seconds for silence ===
      const inactivityChecker = setInterval(() => {
        const stats = activity.getStats();

        // Emit activity stats callback if provided
        if (typeof onActivityStats === 'function') {
          try { onActivityStats(stats); } catch (e) { /* ignore */ }
        }

        // Warning at ~2/3 of inactivity threshold
        if (activity.shouldWarn()) {
          logger.warn(`ClineCLI: INACTIVITY WARNING — no output for ${stats.silenceFormatted} (threshold: ${inactivityTimeoutSec}s). Messages so far: ${stats.totalMessages}, tools: ${stats.toolUseCount}`);
        }

        // Stall detection — kill the process
        if (activity.isStalled()) {
          if (!killOnInactivity) {
            if (!inactivityObserved) {
              inactivityObserved = true;
              logger.warn(`ClineCLI: INACTIVITY OBSERVED - no output for ${stats.silenceFormatted}; process remains alive and hard timeout owns termination.`);
            }
            return;
          }
          stalledOut = true;
          logger.error(`ClineCLI: INACTIVITY CIRCUIT BREAKER — no output for ${stats.silenceFormatted}. Killing process. Total messages: ${stats.totalMessages}, tools: ${stats.toolUseCount}, elapsed: ${stats.elapsedFormatted}`);
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 5000);
        }
      }, 10000); // Check every 10 seconds

      // Parse NDJSON from stdout line-by-line
      proc.stdout.on('data', (chunk) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        // Keep the last (possibly incomplete) line in the buffer
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);
            messages.push(parsed);

            // Track activity with message type awareness
            activity.touch(parsed.type || null);
            activity.resetWarning(); // Got output, reset warning flag

            if (typeof onMessage === 'function') {
              try {
                onMessage(parsed);
              } catch (cbErr) {
                logger.error(`ClineCLI: onMessage callback error: ${cbErr.message}`);
              }
            }
          } catch (parseErr) {
            // Non-JSON line from cline — still counts as activity
            activity.touch();
            activity.resetWarning();
            logger.debug(`ClineCLI: Non-JSON stdout line: ${trimmed.substring(0, 200)}`);
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrBuffer += text;
        // stderr also counts as activity — Cline is still doing something
        activity.touchStderr();
        activity.resetWarning();

        // Log stderr at warn level for better visibility of errors
        logger.warn(`ClineCLI: stderr: ${text.trim().substring(0, 500)}`);

        if (typeof onError === 'function') {
          try {
            onError(text);
          } catch (cbErr) {
            logger.error(`ClineCLI: onError callback error: ${cbErr.message}`);
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(hardTimer);
        clearInterval(inactivityChecker);
        logger.error(`ClineCLI: Process spawn error: ${err.message}`);
        reject(err);
      });

      proc.on('close', (code, signal) => {
        clearTimeout(hardTimer);
        clearInterval(inactivityChecker);

        // Flush any remaining data in lineBuffer
        if (lineBuffer.trim()) {
          try {
            const parsed = JSON.parse(lineBuffer.trim());
            messages.push(parsed);
            activity.touch(parsed.type || null);
            if (typeof onMessage === 'function') {
              try { onMessage(parsed); } catch (e) { /* ignore */ }
            }
          } catch (e) {
            logger.debug(`ClineCLI: Final non-JSON line: ${lineBuffer.trim().substring(0, 200)}`);
          }
        }

        const activityStats = activity.getStats();
        const result = {
          success: code === 0 && !timedOut && !stalledOut,
          messages,
          exitCode: code,
          signal,
          timedOut,
          stalledOut,
          inactivityObserved,
          stderr: stderrBuffer,
          raw: messages.map(m => JSON.stringify(m)).join('\n'),
          activityStats,
        };

        logger.info(`ClineCLI: Streaming task finished: code=${code}, signal=${signal}, messages=${messages.length}, timedOut=${timedOut}, stalledOut=${stalledOut}`);
        logger.info(`ClineCLI: Activity stats: elapsed=${activityStats.elapsedFormatted}, messages=${activityStats.totalMessages}, tools=${activityStats.toolUseCount}, thinking=${activityStats.thinkingCount}`);

        if (typeof onExit === 'function') {
          try { onExit(result); } catch (e) { /* ignore */ }
        }

        resolve(result);
      });
    });
  }

  /**
   * Execute a task using Front Door API (batch mode — waits for completion)
   * Routes through /api/tasks/:taskId/messages → AgenticController with persona injection
   * 
   * PHASE_39 Issue #039: Replaces Cline CLI spawning with HTTP call to any-bot's front door.
   * This ensures persona is injected via AgenticController (lines 73-76) for queue manager tasks.
   * 
   * CIRCUIT BREAKER: Timeout applied to HTTP request.
   * 
   * ⭐ PHASE_00_SESSION_05: Wrapped with concurrency control to prevent memory explosion
   * 
   * @param {string} taskDescription - The task to execute
   * @param {string} workspaceDir - Working directory for the task
   * @param {object} options - Additional options (timeout, inactivityTimeout, model)
   * @returns {Promise<object>} Task result
   */
  async executeTask(taskDescription, workspaceDir, options = {}) {
    assertCliToolBoundary(options, 'cline-cli');
    const userScope = await acquireUserScoping(workspaceDir, options.extraEnv);
    let slotAcquired = false;
    // ⭐ PHASE_00_SESSION_05: Acquire concurrency slot before spawning
    try {
      await this._acquireConcurrencySlot();
      slotAcquired = true;
      return await this._executeTaskInternal(taskDescription, workspaceDir, {
        ...options,
        _userScopeEnv: userScope.env,
      });
    } finally {
      // ⭐ PHASE_00_SESSION_05: Always release slot, even on error
      if (slotAcquired) this._releaseConcurrencySlot();
      userScope.release();
    }
  }

  /**
   * Internal implementation of executeTask (after concurrency slot acquired)
   * @private
   */
  async _executeTaskInternal(taskDescription, workspaceDir, options = {}) {
    assertCliToolBoundary(options, 'cline-cli');
    const hardTimeoutSec = options.timeout || this.defaultTimeout;
    
    logger.info(`ClineCLI: Executing task in ${workspaceDir}`);
    logger.info(`ClineCLI: Task: ${taskDescription.substring(0, 100)}...`);
    logger.info(`ClineCLI: Timeout: ${hardTimeoutSec}s`);
    
    // ⭐ PHASE_39: Use Front Door API instead of spawning Cline CLI
    if (this.useFrontDoorAPI) {
      return await this._executeViaFrontDoor(taskDescription, workspaceDir, options);
    }
    
    // ⭐ RETRY LOGIC: Cline CLI's claude-code provider occasionally returns
    // "Invalid API Response: empty or unparsable" on transient API failures.
    // The claude binary works fine (auth OK, model OK) but sometimes the API
    // returns an empty response. Retry up to 3 times with progressive backoff.
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        logger.warn(`[ClineCLI] Using LEGACY spawn mode (USE_FRONT_DOOR_API=false)${attempt > 0 ? ` [RETRY ${attempt}/${maxRetries}]` : ''}`);
        const result = await this._executeViaSpawn(taskDescription, workspaceDir, options);
        return result;
      } catch (err) {
        const isTransientApiError = err.message && (
          err.message.includes('Invalid API Response') ||
          err.message.includes('empty or unparsable') ||
          err.message.includes('provider returned an empty')
        );
        
        if (isTransientApiError && attempt < maxRetries) {
          // Progressive backoff: 2s, 4s, 10s
          const delayMs = attempt === 2 ? 10000 : 2000 * (attempt + 1);
          logger.warn(`[ClineCLI] ⚠️ Transient API failure (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message.substring(0, 200)}`);
          logger.warn(`[ClineCLI] Retrying in ${delayMs / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        
        // Exhausted all retries or non-transient error
        if (attempt >= maxRetries && isTransientApiError) {
          logger.error(`[ClineCLI] ❌ Exhausted ${maxRetries} retries for transient API failure`);
          // Throw user-friendly error message
          throw new Error(
            `The AI service experienced intermittent connection issues and could not complete this request after ${maxRetries + 1} attempts. ` +
            `This is typically a temporary issue with the AI provider. Please try your request again in a few moments. ` +
            `Original error: ${err.message}`
          );
        }
        throw err;
      }
    }
  }

  /**
   * Execute task via Front Door API (NEW - PHASE_39)
   * @private
   */
  async _executeViaFrontDoor(taskDescription, workspaceDir, options) {
    const startTime = Date.now();
    
    try {
      logger.info('[ClineCLI] Routing through Front Door API (persona injection enabled)');
      
      // 1. Create task via front door
      const taskResult = await this.frontDoorClient.createTask(
        `Queue Manager Task: ${taskDescription.substring(0, 100)}`,
        'act'
      );
      
      const taskId = taskResult.task.id;
      logger.info(`[ClineCLI] Task created via front door: ${taskId}`);
      
      // 2. Send message through front door (this routes through AgenticController with persona)
      // Pass source from options to enable proper dashboard vs ticket detection
      const messageResult = await this.frontDoorClient.sendMessage(
        taskId,
        taskDescription,
        {
          autoApprove: {
            use_mcp_tool: true,
            execute_command: true,
            write_to_file: true,
            read_file: true,
          },
          agenticMode: true,
          source: options.source || 'cline-cli-wrapper', // Pass source for context detection
        }
      );
      
      // 3. Extract response and metrics
      const responseText = this.frontDoorClient.extractResponse(messageResult);
      const metrics = this.frontDoorClient.extractMetrics(messageResult);
      
      const elapsed = Date.now() - startTime;
      
      logger.info(`[ClineCLI] Front door execution complete: ${elapsed}ms, ${metrics.turns} turns, ${metrics.totalTokens} tokens`);
      
      // 4. Return in same format as legacy spawn mode for compatibility
      return {
        success: messageResult.success,
        result: messageResult.result?.result,
        text: responseText,
        raw: JSON.stringify(messageResult),
        activityStats: {
          elapsedMs: elapsed,
          elapsedFormatted: `${Math.round(elapsed / 1000)}s`,
          totalMessages: metrics.turns,
          toolUseCount: 0, // Not tracked in front door mode
          thinkingCount: 0,
          completionCount: 1,
          errorCount: messageResult.success ? 0 : 1,
          // Real metrics from AgenticController (not estimated)
          inputTokens: metrics.totalTokens * 0.4, // Rough estimate
          outputTokens: metrics.totalTokens * 0.6,
          totalTokens: metrics.totalTokens,
          estimatedCost: metrics.totalCost,
          costEstimated: false, // Real cost from Bedrock
        },
      };
    } catch (error) {
      logger.error(`[ClineCLI] Front door execution failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute task via legacy Cline CLI spawn (LEGACY - for rollback)
   * @private
   */
  async _executeViaSpawn(taskDescription, workspaceDir, options) {
    assertCliToolBoundary(options, 'cline-cli');
    const hardTimeoutSec = options.timeout || this.defaultTimeout;
    const inactivityTimeoutSec = options.inactivityTimeout || this.defaultInactivityTimeout;
    const killOnInactivity = options.killOnInactivity === undefined
      ? this.defaultKillOnInactivity
      : options.killOnInactivity === true;
    const hardTimeoutMs = hardTimeoutSec * 1000;
    const inactivityTimeoutMs = inactivityTimeoutSec * 1000;

    return new Promise((resolve, reject) => {
      // ⭐ PHASE_52 Issue #052 FIX: Use stdin for large prompts (>56KB)
      // Passing 56K prompts as CLI arguments causes truncation and exit code 1
      // Cline CLI doesn't support --prompt-file, so we pipe via stdin instead
      // NOTE: Threshold raised from 10KB to 56KB - small prompts (conversation history)
      // must use CLI args to preserve globalState model ID (GovCloud fix)
      const useStdin = taskDescription.length > 56000;
      let args;
      
      // ⭐ SESSION_06 FIX: Make -y (YOLO auto-approve) conditional on source.
      // Dashboard chat (source=dashboard): NO -y flag — user is present and should approve.
      // All other sources (ticket, queue, scheduled, etc.): keep -y for unattended execution.
      // ⭐ SESSION_06 REVERT: Always use -y for Cline CLI.
      // The working dashboard at port 3010 uses -y for ALL messages and works fine.
      // Removing -y caused stalls because Cline waits for tool approval that never comes.
      // Dashboard vs ticket distinction is handled by PROVIDER ROUTING (Bedrock vs ClineCLI),
      // not by toggling the -y flag.
      // ⭐ PHASE_02_SESSION_07 FIX: Enforce -y flag regardless of source to prevent UI Cockpit (port 5000)
      // from hanging when falling back to Cline CLI without interactive terminal approval.

      if (useStdin) {
        // Large prompt: pipe via stdin (no prompt argument)
        logger.info(`[ClineCLI] Large prompt (${taskDescription.length} chars) → using stdin`);
        args = [
          '--json',
          '-y',
          '--act',
          '-c', workspaceDir,
          '--timeout', String(hardTimeoutSec)
          // No prompt argument - will be piped via stdin
        ];
      } else {
        // Small prompt: use CLI argument (traditional method)
        const escapedTask = taskDescription.replace(/'/g, "'\\''");
        args = [
          '--json',
          '-y',
          '--act',
          '-c', workspaceDir,
          '--timeout', String(hardTimeoutSec),
          `'${escapedTask}'`
        ];
      }

      // ⭐ PHASE_55 FIX (UPDATED): GovCloud guard for -m flag
      // Only skip -m in GovCloud when using Bedrock provider (not claude-code).
      // claude-code provider uses the claude binary which handles its own model selection.
      const region = process.env.AWS_REGION || '';
      const llmProvider = process.env.LLM_PROVIDER || 'cline-cli';
      const isUsingClaudeCode = llmProvider === 'claude-code';
      const passedModel = options.model || '';
      
      if (passedModel && (isUsingClaudeCode || !region.startsWith('us-gov-'))) {
        // claude-code or non-GovCloud: safe to pass -m flag
        args.unshift('-m', passedModel);
        logger.info(`[ClineCLI] Using model (via -m flag): ${passedModel}`);
      } else if (passedModel) {
        // GovCloud+Bedrock: skip -m flag, let CLI use globalState config
        logger.info(`[ClineCLI] GovCloud+Bedrock: skipping -m flag (CLI uses globalState config). Requested model: ${passedModel}`);
      }

      // Note: API key is configured via globalState.json by _ensureModelConfig()
      // Cline CLI v2.4.2 does NOT support --api-key flag
      logger.info(`ClineCLI: Running: cline ${args.join(' ')}${useStdin ? ' (stdin)' : ''}`);

      // Ensure globalState.json has correct model config before spawning
      this._ensureModelConfig();

      // Activity tracker for batch mode
      const activity = this._createActivityTracker(inactivityTimeoutMs);

      const spawnEnv = {
        ...process.env,
        PATH: this.getEnhancedPath(),
        CLAUDE_CODE_SESSION_ACCESS_TOKEN: resolveClaudeAccessToken(),
        // ⭐ PHASE_54 SESSION_11: Use REAL HOME (not isolated).
        // _ensureModelConfig() force-writes correct config before each spawn.
        HOME: this.homeDir,
        // Per-request user scoping for shelled-out tools (oshal-gmail.js) — env + cwd file.
        ...(options._userScopeEnv || {}),
      };

      // ⭐ DIAGNOSTIC LOGGING: Full spawn environment dump so we know EXACTLY what's being used
      const tokenVal = spawnEnv.CLAUDE_CODE_SESSION_ACCESS_TOKEN || '';
      logger.info(`[ClineCLI] ═══ SPAWN DIAGNOSTICS (batch) ═══`);
      logger.info(`[ClineCLI]   HOME=${spawnEnv.HOME}`);
      logger.info(`[ClineCLI]   cwd=${workspaceDir}`);
      logger.info(`[ClineCLI]   cwd exists=${fs.existsSync(workspaceDir)}`);
      logger.info(`[ClineCLI]   ANTHROPIC_API_KEY: ${tokenVal ? `SET (${tokenVal.length} chars, starts: ${tokenVal.substring(0, 15)}...)` : 'NOT SET'}`);
      logger.info(`[ClineCLI]   LLM_PROVIDER=${process.env.LLM_PROVIDER || '(not set)'}`);
      logger.info(`[ClineCLI]   AWS_REGION=${process.env.AWS_REGION || '(not set)'}`);
      logger.info(`[ClineCLI]   AGENT_ID=${process.env.AGENT_ID || '(not set)'}`);
      logger.info(`[ClineCLI]   PATH (first 200)=${spawnEnv.PATH.substring(0, 200)}`);
      // Log config file states
      try {
        const gsCheck = `${this.homeDir}/.cline/data/globalState.json`;
        const cfgCheck = `${this.homeDir}/.cline/config.json`;
        const claudeCheck = `${this.homeDir}/.claude.json`;
        logger.info(`[ClineCLI]   globalState.json exists=${fs.existsSync(gsCheck)}`);
        logger.info(`[ClineCLI]   config.json exists=${fs.existsSync(cfgCheck)}`);
        logger.info(`[ClineCLI]   .claude.json exists=${fs.existsSync(claudeCheck)}`);
        if (fs.existsSync(cfgCheck)) {
          const cfgContent = JSON.parse(fs.readFileSync(cfgCheck, 'utf8'));
          logger.info(`[ClineCLI]   config.json: provider=${cfgContent.provider}, model=${cfgContent.model}`);
        }
        if (fs.existsSync(gsCheck)) {
          const gsContent = JSON.parse(fs.readFileSync(gsCheck, 'utf8'));
          logger.info(`[ClineCLI]   globalState: actProvider=${gsContent.actModeApiProvider}, actModel=${gsContent.actModeApiModelId}`);
        }
      } catch (diagErr) {
        logger.warn(`[ClineCLI]   Config diagnostics failed: ${diagErr.message}`);
      }
      logger.info(`[ClineCLI] ═══ END SPAWN DIAGNOSTICS ═══`);

      const cline = spawn(this.clineCommand, args, {
        cwd: workspaceDir,
        env: spawnEnv,
        shell: true, // Use shell for better compatibility
      });
      
      // ⭐ If using stdin, write the prompt to stdin and close it
      if (useStdin) {
        try {
          cline.stdin.write(taskDescription);
          cline.stdin.end();
          logger.info(`[ClineCLI] Wrote ${taskDescription.length} chars to stdin`);
        } catch (stdinErr) {
          logger.error(`[ClineCLI] Failed to write to stdin: ${stdinErr.message}`);
          // Process will fail, but let it fail naturally
        }
      }

      let stdout = '';
      let stderr = '';
      let lastJsonMessage = null;
      const allMessages = []; // Collect all JSON messages so _extractResponseText can pick say:text
      let timedOut = false;
      let stalledOut = false;
      let inactivityObserved = false;

      // === HARD TIMEOUT ===
      const hardTimer = setTimeout(() => {
        timedOut = true;
        const stats = activity.getStats();
        logger.warn(`ClineCLI: HARD TIMEOUT (batch) after ${hardTimeoutSec}s. Messages: ${stats.totalMessages}, silence: ${stats.silenceFormatted}`);
        cline.kill('SIGTERM');
        setTimeout(() => {
          if (!cline.killed) cline.kill('SIGKILL');
        }, 5000);
      }, hardTimeoutMs);

      // === INACTIVITY MONITOR ===
      const inactivityChecker = setInterval(() => {
        if (activity.shouldWarn()) {
          const stats = activity.getStats();
          logger.warn(`ClineCLI: INACTIVITY WARNING (batch) — no output for ${stats.silenceFormatted}`);
        }

        if (activity.isStalled()) {
          const stats = activity.getStats();
          if (!killOnInactivity) {
            if (!inactivityObserved) {
              inactivityObserved = true;
              logger.warn(`ClineCLI: INACTIVITY OBSERVED (batch) - no output for ${stats.silenceFormatted}; process remains alive and hard timeout owns termination.`);
            }
            return;
          }
          stalledOut = true;
          logger.error(`ClineCLI: INACTIVITY CIRCUIT BREAKER (batch) — no output for ${stats.silenceFormatted}. Killing. Messages: ${stats.totalMessages}, elapsed: ${stats.elapsedFormatted}`);
          cline.kill('SIGTERM');
          setTimeout(() => {
            if (!cline.killed) cline.kill('SIGKILL');
          }, 5000);
        }
      }, 10000);

      cline.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;

        // Try to parse JSON messages as they arrive
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const json = JSON.parse(line);
              lastJsonMessage = json;
              allMessages.push(json); // ⭐ Collect ALL messages so _extractResponseText prefers say:text
              activity.touch(json.type || null);
              activity.resetWarning();
              // ⭐ DIAGNOSTIC: Log error_retry messages in FULL (no truncation) — these contain the actual failure reason
              if (json.say === 'error_retry' || json.say === 'error' || json.type === 'error') {
                logger.error(`ClineCLI: ⚠️ ERROR MESSAGE (FULL): ${JSON.stringify(json)}`);
              } else {
                logger.info(`ClineCLI: ${json.type || 'message'}: ${JSON.stringify(json).substring(0, 500)}`);
              }
            } catch (e) {
              // Not JSON, just log as text — still activity
              activity.touch();
              activity.resetWarning();
              logger.info(`ClineCLI: ${line.substring(0, 500)}`);
            }
          }
        }
      });

      cline.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        activity.touchStderr();
        activity.resetWarning();
        // ⭐ DIAGNOSTIC: Log full stderr — it often contains the actual error
        logger.warn(`ClineCLI stderr (${chunk.length} chars): ${chunk.substring(0, 2000)}`);
      });

      cline.on('error', (error) => {
        clearTimeout(hardTimer);
        clearInterval(inactivityChecker);
        logger.error(`ClineCLI: Failed to spawn: ${error.message}`);
        reject(new Error(`Failed to spawn Cline CLI: ${error.message}`));
      });

      cline.on('close', (code) => {
        clearTimeout(hardTimer);
        clearInterval(inactivityChecker);

        const activityStats = activity.getStats();
        logger.info(`ClineCLI: Process exited with code ${code}, timedOut=${timedOut}, stalledOut=${stalledOut}`);
        logger.info(`ClineCLI: Activity stats: elapsed=${activityStats.elapsedFormatted}, messages=${activityStats.totalMessages}, tools=${activityStats.toolUseCount}`);

        if (stalledOut) {
          logger.error(`ClineCLI: STALL DUMP — full stderr (${stderr.length} chars): ${stderr.substring(0, 5000)}`);
          logger.error(`ClineCLI: STALL DUMP — last 5 messages: ${JSON.stringify(allMessages.slice(-5))}`);
          reject(new Error(
            `Cline CLI stalled — no output for ${inactivityTimeoutSec}s. ` +
            `Total messages before stall: ${activityStats.totalMessages}, ` +
            `tools used: ${activityStats.toolUseCount}, ` +
            `elapsed: ${activityStats.elapsedFormatted}\n` +
            `stderr: ${stderr.substring(0, 2000)}`
          ));
          return;
        }

        if (timedOut) {
          logger.error(`ClineCLI: TIMEOUT DUMP — full stderr (${stderr.length} chars): ${stderr.substring(0, 5000)}`);
          logger.error(`ClineCLI: TIMEOUT DUMP — last 5 messages: ${JSON.stringify(allMessages.slice(-5))}`);
          reject(new Error(
            `Cline CLI hard timeout after ${hardTimeoutSec}s. ` +
            `Total messages: ${activityStats.totalMessages}, ` +
            `tools used: ${activityStats.toolUseCount}\n` +
            `stderr: ${stderr.substring(0, 2000)}`
          ));
          return;
        }

        if (code === 0) {
          // Success - parse result
          // ⭐ SESSION_06: Include allMessages so _extractResponseText prefers say:text over completion_result
          try {
            if (lastJsonMessage) {
              resolve({
                success: true,
                result: lastJsonMessage,
                text: lastJsonMessage.text || JSON.stringify(lastJsonMessage),
                messages: allMessages, // Full message array — _extractResponseText picks say:text
                raw: stdout,
                activityStats,
                inactivityObserved,
              });
            } else {
              resolve({
                success: true,
                text: stdout.trim(),
                messages: allMessages,
                raw: stdout,
                activityStats,
                inactivityObserved,
              });
            }
          } catch (e) {
            logger.error(`ClineCLI: Failed to parse result: ${e.message}`);
            resolve({
              success: true,
              text: stdout.trim(),
              messages: allMessages,
              raw: stdout,
              activityStats,
              inactivityObserved,
            });
          }
        } else {
          // Error — log EVERYTHING for diagnostics
          logger.error(`ClineCLI: ❌ Task failed with code ${code}`);
          logger.error(`ClineCLI: ❌ Full stderr (${stderr.length} chars): ${stderr.substring(0, 5000)}`);
          logger.error(`ClineCLI: ❌ Last 5 messages: ${JSON.stringify(allMessages.slice(-5))}`);
          logger.error(`ClineCLI: ❌ Total stdout lines: ${stdout.split('\n').length}, total messages parsed: ${allMessages.length}`);
          
          reject(new Error(
            `Cline CLI exited with code ${code}\n` +
            `stderr: ${stderr}\n` +
            `stdout (last 2000): ${stdout.substring(Math.max(0, stdout.length - 2000))}`
          ));
        }
      });
    });
  }

  /**
   * Ensure Cline CLI globalState.json AND config.json have the correct model configuration.
   * Uses Anthropic API (Claude Code) via ANTHROPIC_API_KEY environment variable.
   * The CLI may overwrite these files during execution, so we re-inject our config
   * before each spawn to prevent model drift.
   * 
   * ⭐ PHASE_54 FIX: Write BOTH config files
   * - globalState.json: Full Cline state with Anthropic provider
   * - config.json: Simple config with provider, model, apiKey
   * - Force filesystem sync after write
   * - Verify write succeeded by reading back
   * 
   * @private
   */
  _ensureModelConfig() {
    try {
      // ⭐ PHASE_54 SESSION_11: Write to REAL ~/.cline/ (not isolated dir).
      // _ensureModelConfig() runs before every spawn to counteract any VSCode extension drift.
      const gsPath = `${this.homeDir}/.cline/data/globalState.json`;
      const configPath = `${this.homeDir}/.cline/config.json`;
      
      // Ensure directories exist (idempotent)
      const gsDir = path.dirname(gsPath);
      if (!fs.existsSync(gsDir)) {
        fs.mkdirSync(gsDir, { recursive: true });
        logger.info(`[ClineCLI] Created config data dir: ${gsDir}`);
      }

      // ⭐ ARCHITECTURE: Cline CLI → Claude Code provider → Claude Code CLI → Anthropic API
      // Use 'claude-code' provider which spawns the `claude` binary.
      // Auth precedence (sandbox-first):
      //   1. ANTHROPIC_API_KEY env (if explicitly set in container env)
      //   2. claude-code OAuth file mounted at /root/.claude/.credentials.json
      //      (host's ~/.claude/.credentials.json mounted via compose)
      // The `claude` binary itself reads the OAuth file directly — we just need to
      // confirm at least one auth source exists before spawning, instead of failing
      // hard on missing API key (the sandbox does not carry one).
      const model = 'claude-sonnet-4-5-20250929';
      const apiKey = process.env.ANTHROPIC_API_KEY || '';
      const oauthFilePath = '/root/.claude/.credentials.json';
      let hasOauthFile = false;
      try { hasOauthFile = fs.existsSync(oauthFilePath); } catch (_e) { hasOauthFile = false; }

      if (!apiKey && !hasOauthFile) {
        logger.warn('[ClineCLI] WARNING: neither ANTHROPIC_API_KEY nor claude-code OAuth file (/root/.claude/.credentials.json) is available — Cline CLI will fail.');
      } else if (!apiKey && hasOauthFile) {
        logger.info('[ClineCLI] Using claude-code OAuth file (no ANTHROPIC_API_KEY in env — expected in sandbox)');
      }

      // ⭐ SESSION_11: Removed mock .claude.json creation — it caused auth failures.
      // The real ~/.claude.json is managed by `claude` CLI login / refresh-claude-token.sh.

      // === 1. Update globalState.json (create if missing) ===
      let data = {};
      if (fs.existsSync(gsPath)) {
        try {
          data = JSON.parse(fs.readFileSync(gsPath, 'utf8'));
        } catch (e) {
          logger.warn(`[ClineCLI] Failed to parse existing globalState.json, starting fresh: ${e.message}`);
        }
      } else {
        logger.info(`[ClineCLI] globalState.json not found in isolated dir — creating fresh`);
      }
      let changed = false;

      // Use claude-code provider
      const requiredFields = {
        'actModeApiProvider': 'claude-code',
        'planModeApiProvider': 'claude-code',
        'actModeApiModelId': model,
        'planModeApiModelId': model,
        'yoloModeToggled': true,
        'autoApprovalSettings': {
          version: 3,
          enabled: true,
          maxRequests: 20,
          actions: {
            readFiles: true,
            readFilesExternally: false,
            editFiles: true,
            editFilesExternally: false,
            executeSafeCommands: true,
            executeAllCommands: true,
            useBrowser: false,
            useMcp: true,
          },
          enableNotifications: false,
        },
      };

      for (const [key, value] of Object.entries(requiredFields)) {
        if (JSON.stringify(data[key]) !== JSON.stringify(value)) {
          data[key] = value;
          changed = true;
        }
      }

      // Remove any stale Bedrock-specific fields that might confuse the CLI
      const bedrockFields = ['awsAccessKey', 'awsSecretKey', 'awsRegion', 'awsBedrockEndpoint', 'awsAuthentication', 'awsUseCrossRegionInference', 'region'];
      for (const field of bedrockFields) {
        if (data[field] !== undefined) {
          delete data[field];
          changed = true;
        }
      }

      if (changed) {
        // Write with explicit file descriptor to force sync
        const fd = fs.openSync(gsPath, 'w');
        const jsonStr = JSON.stringify(data, null, 2);
        fs.writeSync(fd, jsonStr);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        
        // Verify write succeeded
        const verifyData = JSON.parse(fs.readFileSync(gsPath, 'utf8'));
        if (verifyData.actModeApiProvider !== 'claude-code') {
          throw new Error(`Write verification failed: expected claude-code, got ${verifyData.actModeApiProvider}`);
        }
        
        logger.info(`[ClineCLI] Updated globalState.json: provider=claude-code, model=${model}`);
      } else {
        logger.debug(`[ClineCLI] globalState.json model config OK: claude-code/${model}`);
      }

      // === 2. Update config.json (Cline CLI also reads this for provider/model) ===
      const configData = {
        provider: 'claude-code',
        model: model
      };

      // Always write config.json to ensure it's in sync
      const configFd = fs.openSync(configPath, 'w');
      const configStr = JSON.stringify(configData, null, 2);
      fs.writeSync(configFd, configStr);
      fs.fsyncSync(configFd);
      fs.closeSync(configFd);

      // Verify write succeeded
      const verifyConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (verifyConfig.provider !== 'claude-code') {
        throw new Error(`config.json write verification failed: provider=${verifyConfig.provider}`);
      }

      logger.info(`[ClineCLI] Updated config.json: provider=claude-code, model=${model}`);
    } catch (err) {
      logger.error(`[ClineCLI] Failed to ensure model config: ${err.message}`);
      throw err;
    }
  }

  /**
   * Check if Cline CLI is installed and available.
   * 
   * ⭐ PHASE_61 Defect #3 FIX: Use `--version` flag (not `version` subcommand).
   * `cline history`, `cline config`, `cline task --help` all timeout at 60s in GovCloud
   * because they try to connect to a network endpoint that is unreachable.
   * `--version` is a pure local flag that exits immediately without network I/O.
   * 
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const result = await new Promise((resolve) => {
        // ⭐ PHASE_61: Use --version (local flag, no network) instead of 'version' subcommand
        // Hard 8s timeout — if cline doesn't respond in 8s, it's not usable
        const cline = spawn(this.clineCommand, ['--version'], {
          env: buildCliDiagnosticEnv({ path: this.getEnhancedPath() }),
          shell: true,
        });

        let stdout = '';
        let resolved = false;

        const hardTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            logger.warn('[ClineCLI] isAvailable() timed out after 8s — cline may be trying to reach network');
            try { cline.kill('SIGTERM'); } catch (e) { /* ignore */ }
            resolve(false);
          }
        }, 8000);

        cline.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        cline.on('close', (code) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(hardTimeout);
            // --version outputs something like "3.x.x" or "Cline CLI version 3.x.x"
            resolve(code === 0 && stdout.trim().length > 0);
          }
        });

        cline.on('error', () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(hardTimeout);
            resolve(false);
          }
        });
      });

      return result;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get Cline CLI version.
   * 
   * ⭐ PHASE_61 Defect #3 FIX: Use `--version` flag (not `version` subcommand).
   * Same reasoning as isAvailable() — `version` subcommand may hit network in GovCloud.
   * 
   * @returns {Promise<string|null>}
   */
  async getVersion() {
    try {
      const result = await new Promise((resolve) => {
        // ⭐ PHASE_61: Use --version (local flag, no network)
        const cline = spawn(this.clineCommand, ['--version'], {
          env: buildCliDiagnosticEnv({ path: this.getEnhancedPath() }),
          shell: true,
        });

        let stdout = '';
        let resolved = false;

        const hardTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            try { cline.kill('SIGTERM'); } catch (e) { /* ignore */ }
            resolve(null);
          }
        }, 8000);

        cline.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        cline.on('close', (code) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(hardTimeout);
            if (code === 0) {
              // Output is typically just "3.x.x" or "Cline CLI version: 3.x.x"
              const trimmed = stdout.trim();
              const match = trimmed.match(/(\d+\.\d+\.\d+)/);
              resolve(match ? match[1] : trimmed || null);
            } else {
              resolve(null);
            }
          }
        });

        cline.on('error', () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(hardTimeout);
            resolve(null);
          }
        });
      });

      return result;
    } catch (e) {
      return null;
    }
  }
}

module.exports = ClineCLIWrapper;

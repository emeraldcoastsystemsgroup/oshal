/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Idle-based timeouts (operator directive 2026-07-24, extends ADR-081): overall timeout default 300s→3600s (runaway ceiling, not the working bound), inactivity 180s→600s, killOnInactivity default false→true — sound now that the wrapper streams stream-json so silence genuinely means stalled. Env knobs unchanged (CLAUDE_CODE_TIMEOUT_*, CLAUDE_CODE_INACTIVITY_TIMEOUT_*, CLAUDE_CODE_KILL_ON_INACTIVITY).
 */

/**
 * Claude Code CLI Provider
 * Implements LLM provider interface using Claude Code CLI (`claude` binary) as backend
 * 
 * Key differences from ClineProvider:
 * - Uses `claude` binary (not `cline`)
 * - Gets REAL cost/token data from Claude CLI JSON output (not estimates)
 * - Auth via ~/.claude/ (OAuth tokens) or ANTHROPIC_API_KEY env var
 * - Default model: sonnet (claude-sonnet-4-5)
 * 
 * From AgenticController's perspective, this is identical to ClineProvider/BedrockProvider:
 * - Accept messages array
 * - Return response with content, usage, cost
 * - Support tools via options
 * 
 * PHASE_10: Claude Code CLI as Default LLM Provider
 */

const ClaudeCodeCLIWrapper = require('../codebase/ClaudeCodeCLIWrapper');
const logger = require('../../utils/logger');
const { formatProviderFailure, isProviderRecoverableRuntimeFailure, isProviderRuntimeBanner } = require('./providerFailureClassifier');

/**
 * @description LLM provider that backs the agent's chat/generation interface with
 * the local Claude Code CLI (`claude` binary) instead of a hosted API. It exists so
 * the swarm can run against an OAuth/`~/.claude/`-authenticated CLI, surface the CLI's
 * real per-turn cost/token data rather than estimates, and remain drop-in compatible
 * with the other providers (BedrockProvider/ClineProvider) consumed by AgenticController.
 */
class ClaudeCodeProvider {
  /**
   * @description Builds the provider's effective configuration (timeouts, model,
   * CLI path, optional rate limiting) by layering caller-supplied config over
   * environment-variable defaults, primes rate-limit bookkeeping when enabled, and
   * constructs the underlying ClaudeCodeCLIWrapper used to invoke the CLI.
   * @param {Object} [config={}] - Optional overrides for the provider's defaults.
   * @param {number} [config.timeout] - Overall task timeout in seconds.
   * @param {number} [config.inactivityTimeout] - Max seconds of silence before aborting.
   * @param {string} [config.model] - Claude model alias/id to run.
   * @param {string} [config.claudeCommand] - Path or name of the `claude` binary.
   * @param {string|null} [config.systemPrompt] - Default system prompt for the provider.
   */
  constructor(config = {}) {
    // Operator directive 2026-07-24 (extends ADR-081): the overall timeout is a
    // 60-min runaway CEILING, not the working bound — "stuck" is decided by 10 min
    // of full silence, which the wrapper's stream-json default makes measurable.
    const timeout = parseDurationSeconds(
      config.timeout,
      process.env.CLAUDE_CODE_TIMEOUT_MS,
      process.env.CLAUDE_CODE_TIMEOUT_SECONDS,
      3600,
    );
    const inactivityTimeout = parseDurationSeconds(
      config.inactivityTimeout,
      process.env.CLAUDE_CODE_INACTIVITY_TIMEOUT_MS,
      process.env.CLAUDE_CODE_INACTIVITY_TIMEOUT_SECONDS,
      600,
    );

    this.config = {
      timeout,
      inactivityTimeout,
      // Default ON: with the wrapper streaming stream-json, silence is a real stall
      // signal, so a fully-idle run dies at the inactivity threshold instead of
      // burning the whole ceiling. CLAUDE_CODE_KILL_ON_INACTIVITY=false opts out.
      killOnInactivity: parseBoolean(config.killOnInactivity, process.env.CLAUDE_CODE_KILL_ON_INACTIVITY, true),
      model: config.model || process.env.CLAUDE_CODE_MODEL || 'sonnet',
      claudeCommand: config.claudeCommand || process.env.CLAUDE_CLI_PATH || 'claude',
      systemPrompt: config.systemPrompt || null,
      rateLimit: {
        enabled: process.env.CLAUDE_RATE_LIMIT_ENABLED === 'true',
        requestsPerMinute: parseInt(process.env.CLAUDE_RATE_LIMIT_RPM) || 60,
        burstLimit: parseInt(process.env.CLAUDE_RATE_LIMIT_BURST) || 10,
      },
    };

    // Initialize rate limiting if enabled
    if (this.config.rateLimit.enabled) {
      this.requestTimes = [];
      logger.info(`ClaudeCodeProvider: Rate limiting enabled (${this.config.rateLimit.requestsPerMinute} RPM, burst: ${this.config.rateLimit.burstLimit})`);
    }

    this.wrapper = new ClaudeCodeCLIWrapper({
      claudeCommand: this.config.claudeCommand,
      timeout: this.config.timeout,
      inactivityTimeout: this.config.inactivityTimeout,
      killOnInactivity: this.config.killOnInactivity,
      model: this.config.model,
    });

    logger.info(`ClaudeCodeProvider initialized (timeout: ${this.config.timeout}s, inactivity: ${this.config.inactivityTimeout}s, killOnInactivity: ${this.config.killOnInactivity}, model: ${this.config.model}, command: ${this.config.claudeCommand})`);
  }

  /**
   * Generate response using Claude Code CLI
   * Implements same interface as BedrockProvider.generateResponse() / ClineProvider.generateResponse()
   * 
   * @param {Array} messages - Conversation history [{role, content}]
   * @param {Object} options - Generation options
   * @param {string} options.systemPrompt - System prompt
   * @param {Array} options.tools - Available tools (Claude CLI has its own tools)
   * @param {number} options.maxTokens - Max tokens (accepted for interface compat)
   * @param {number} options.temperature - Temperature (accepted for interface compat)
   * @param {string} options.agentId - Dynamic agent ID for persona loading
   * @returns {Promise<Object>} Response matching BedrockProvider format
   */
  async generateResponse(messages, options = {}) {
    const startTime = Date.now();

    // Apply rate limiting if enabled
    if (this.config.rateLimit.enabled) {
      await this._enforceRateLimit();
    }

    // Model-gateway pre-flight (budgets/quotas/cost-aware routing). One gate for
    // ALL bot LLM traffic — the controller. Fail-open; no-op until OSHAL_LLM_BUDGETS
    // is enabled. BEFORE the try so a hard deny propagates.
    const { gateLlmCall } = require('./llmGate');
    const gate = await gateLlmCall(this.config.model, messages, options);
    if (!gate.allowed) {
      throw new Error(`LLM call denied by model gateway (${gate.reason})`);
    }
    const gatedModel = gate.model || this.config.model;

    try {
      const dynamicAgentId = options.agentId || null;

      if (dynamicAgentId) {
        logger.info(`🎭 ClaudeCodeProvider: Using dynamic persona: ${dynamicAgentId}`);
      }

      // Convert messages to task description — same pattern as ClineProvider
      const taskDescription = await this._messagesToTask(messages, options, dynamicAgentId);

      const workspaceDir = options.workspaceDir || '/app/workspace';

      logger.info(`ClaudeCodeProvider: Executing task in ${workspaceDir}`);
      logger.debug(`ClaudeCodeProvider: Task description: ${taskDescription.substring(0, 200)}...`);

      // When running as root with inline prompt, the persona is already embedded
      // in the task description — do NOT also pass the system prompt, as this
      // creates a massive combined CLI argument that causes the process to hang.
      const isRoot = (process.getuid && process.getuid() === 0) || process.env.USER === 'root';
      const effectiveSystemPrompt = isRoot ? undefined : options.systemPrompt;

      let result;
      try {
        result = await this.wrapper.executeTask(taskDescription, workspaceDir, {
          timeout: this.config.timeout,
          inactivityTimeout: this.config.inactivityTimeout,
          killOnInactivity: this.config.killOnInactivity,
          model: gatedModel, // gateway may downshift under budget pressure
          systemPrompt: effectiveSystemPrompt,
          maxTurns: options.maxTurns,
          extraEnv: options.extraEnv, // per-request user scoping (OSHAL_USER_SUB)
          // The bot-node-server runs claude CLI fully headless — there is no
          // interactive operator to approve tool use. Pass autoApprove so the
          // wrapper appends `-y` (root) or `--dangerously-skip-permissions`
          // (non-root). Without this the CLI blocks on file-write permission
          // prompts and returns "please approve" without producing artifacts.
          autoApprove: options.autoApprove !== undefined ? options.autoApprove : true,
          source: options.source,
        });
      } catch (cliError) {
        logger.warn(`ClaudeCodeProvider: Claude CLI execution error: ${cliError.message}`);

        if (isProviderRecoverableRuntimeFailure(cliError)) {
          throw cliError;
        }

        const errorResponse = `Claude Code CLI encountered an error: ${cliError.message}\n\n` +
          `This may be due to:\n` +
          `- Authentication issue (check ~/.claude/ or ANTHROPIC_API_KEY)\n` +
          `- Timeout or stall\n` +
          `- Network connectivity\n\n` +
          `Please try a different approach or fall back to Bedrock provider.`;

        return {
          content: errorResponse,
          contentBlocks: [{ type: 'text', text: errorResponse }],
          stopReason: 'end_turn',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheCreationTokens: 0,
            cacheReads: 0,
          },
          cost: 0,
          latency: Date.now() - startTime,
          model: gatedModel,
          provider: 'claude-code',
          claudeCodeError: cliError.message,
        };
      }

      const latency = Date.now() - startTime;
      const responseText = this._extractResponseText(result);

      // On the SUCCESS path only match narrow runtime/stall banners (exit 0 but the
      // CLI emitted an error banner). Do NOT run the broad throttle/auth classifier
      // here — it matches valid answers that merely mention 429/quota/unauthorized and
      // would discard a correct, paid-for generation. Genuine throttle/auth failures
      // arrive via the !result.success branch below (which checks stderr).
      if (isProviderRuntimeBanner(responseText)) {
        throw new Error(`Claude Code CLI returned provider failure text: ${formatProviderFailure(responseText)}`);
      }

      if (!result.success) {
        const failureText = `${responseText || ''}\n${result.stderr || ''}`;
        if (isProviderRecoverableRuntimeFailure(failureText)) {
          throw new Error(`Claude Code CLI task failed: ${formatProviderFailure(failureText)}`);
        }

        const failureResponse = `Claude Code CLI task failed: ${responseText}\n\n` +
          `Stderr: ${result.stderr || 'N/A'}\n\n` +
          `Please try a different approach.`;

        return {
          content: failureResponse,
          contentBlocks: [{ type: 'text', text: failureResponse }],
          stopReason: 'end_turn',
          usage: {
            inputTokens: result.usage?.inputTokens || 0,
            outputTokens: result.usage?.outputTokens || 0,
            totalTokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
            cacheCreationTokens: result.usage?.cacheCreationTokens || 0,
            cacheReads: result.usage?.cacheReadTokens || 0,
          },
          cost: result.costUSD || 0,
          latency,
          model: gatedModel,
          provider: 'claude-code',
          claudeCodeMetadata: {
            numTurns: result.numTurns || 0,
            failed: true,
            costReal: true, // Real cost from Claude CLI, not estimated
          },
        };
      }

      // Success — build response in BedrockProvider-compatible format
      const response = {
        content: responseText,
        contentBlocks: [{ type: 'text', text: responseText }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: result.usage?.inputTokens || 0,
          outputTokens: result.usage?.outputTokens || 0,
          totalTokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
          cacheCreationTokens: result.usage?.cacheCreationTokens || 0,
          cacheReads: result.usage?.cacheReadTokens || 0,
        },
        cost: result.costUSD || 0,
        latency,
        model: gatedModel,
        provider: 'claude-code',
        claudeCodeMetadata: {
          numTurns: result.numTurns || 1,
          durationMs: result.durationMs || latency,
          sessionId: result.sessionId || null,
          costReal: true, // Real cost from Claude CLI JSON output
          modelUsage: result.modelUsage || {},
        },
      };

      logger.info(`ClaudeCodeProvider: Task completed in ${latency}ms, ` +
        `input=${response.usage.inputTokens} output=${response.usage.outputTokens} tokens, ` +
        `$${response.cost.toFixed(4)} (real cost), ${result.numTurns || 1} turns`);

      return response;

    } catch (error) {
      logger.error(`ClaudeCodeProvider: Unexpected error: ${error.message}`);

      if (isProviderRecoverableRuntimeFailure(error)) {
        throw error;
      }

      const errorResponse = `Unexpected error in Claude Code provider: ${error.message}\n\n` +
        `Please try using Bedrock provider instead.`;

      return {
        content: errorResponse,
        contentBlocks: [{ type: 'text', text: errorResponse }],
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheCreationTokens: 0, cacheReads: 0 },
        cost: 0,
        latency: Date.now() - startTime,
        model: gatedModel,
        provider: 'claude-code',
        error: error.message,
      };
    }
  }

  /**
   * Convert messages to task description for Claude Code CLI
   * Same pattern as ClineProvider._messagesToTask():
   * - Write persona + current message to agent-specific context file
   * - Return minimal task instruction referencing the file
   * 
   * @param {Array} messages - Message history (only last message used)
   * @param {Object} options - Options including systemPrompt, workspaceDir
   * @param {string} agentId - Dynamic agent ID for persona loading
   * @returns {Promise<string>} Minimal task instruction for Claude CLI
   * @private
   */
  async _messagesToTask(messages, options = {}, agentId = null) {
    const fs = require('fs');
    const path = require('path');

    const workspaceDir = options.workspaceDir || '/app/workspace';

    // PHASE_11 FIX: Include recent conversation history for context continuity
    // This fixes the "approval cycle amnesia" where the bot forgets what was
    // pending approval when the user says "approved"
    const MAX_HISTORY_MESSAGES = 10; // Keep last N messages for context
    const recentMessages = messages.slice(-MAX_HISTORY_MESSAGES);
    
    // Build conversation history string
    let conversationHistory = '';
    if (recentMessages.length > 1) {
      conversationHistory = '## Recent Conversation History\n\n';
      for (let i = 0; i < recentMessages.length - 1; i++) {
        const msg = recentMessages[i];
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const content = (typeof msg.content === 'string')
          ? msg.content
          : JSON.stringify(msg.content);
        // Truncate very long messages to save context window
        const truncatedContent = content.length > 2000 
          ? content.substring(0, 2000) + '... [truncated]'
          : content;
        conversationHistory += `**${role}:** ${truncatedContent}\n\n`;
      }
      conversationHistory += '---\n\n';
      logger.info(`[ClaudeCodeProvider] Including ${recentMessages.length - 1} prior messages for context continuity`);
    }

    // Extract current message (last in array)
    const currentMessage = messages[messages.length - 1];
    const currentContent = (typeof currentMessage.content === 'string')
      ? currentMessage.content
      : JSON.stringify(currentMessage.content);

    const effectiveAgentId = agentId || process.env.AGENT_ID || 'project-manager';

    if (agentId && agentId !== process.env.AGENT_ID) {
      logger.info(`[ClaudeCodeProvider] 🎭 Loading persona for dynamic agent: ${agentId} (container default: ${process.env.AGENT_ID})`);
    }

    // Load FULL persona from YAML file — same logic as ClineProvider
    let personaContent = '';

    try {
      const yaml = require('js-yaml');
      const personaFile = process.env.BOT_PERSONA_FILE;

      const fallbackPaths = [
        personaFile,
        `/app/bot-configs/${effectiveAgentId}.yaml`,
        `/app/ai-lab/bot-personas/${effectiveAgentId}.yaml`,
      ].filter(Boolean);

      for (const p of fallbackPaths) {
        if (p && fs.existsSync(p)) {
          const parsed = yaml.load(fs.readFileSync(p, 'utf8'));
          if (parsed && parsed.perspective) {
            const parts = [];
            parts.push(`# YOUR IDENTITY AND ROLE`);
            parts.push(`You are **${parsed.name || effectiveAgentId}** — ${parsed.role || 'AI assistant'}.`);
            parts.push('');
            parts.push(parsed.perspective);
            parts.push('');
            if (parsed.capabilities && parsed.capabilities.length > 0) {
              parts.push('## YOUR CAPABILITIES');
              parsed.capabilities.forEach(cap => parts.push(`- ${cap}`));
              parts.push('');
            }
            parts.push('---');
            parts.push('');
            personaContent = parts.join('\n');
            logger.info(`[ClaudeCodeProvider] ✅ Loaded FULL persona for ${effectiveAgentId} from: ${p} (${personaContent.length} chars)`);
            break;
          }
        }
      }
    } catch (yamlErr) {
      logger.warn(`[ClaudeCodeProvider] Failed to load persona YAML for ${effectiveAgentId}: ${yamlErr.message}`);
    }

    if (!personaContent && options.systemPrompt) {
      personaContent = options.systemPrompt;
      logger.warn('[ClaudeCodeProvider] No persona YAML found — using systemPrompt from AgenticController');
    }

    if (!personaContent) {
      personaContent = 'You are a helpful AI assistant. Respond clearly and concisely.';
      logger.warn('[ClaudeCodeProvider] No persona found — using generic identity');
    }

    // PHASE_10 FIX: Pass full context directly in the prompt instead of writing
    // to a file. When running as root (Docker), --dangerously-skip-permissions
    // is blocked, so Claude CLI cannot auto-approve tool use (e.g. reading files).
    // Passing everything inline avoids tool use entirely for simple chat.
    const isRoot = (process.getuid && process.getuid() === 0) || process.env.USER === 'root';

    if (!isRoot) {
      // Non-root: can use file-based approach with --dangerously-skip-permissions
      const contextFileName = `${effectiveAgentId}-context.md`;
      try {
        if (!fs.existsSync(workspaceDir)) {
          fs.mkdirSync(workspaceDir, { recursive: true });
        }
        const contextFilePath = path.join(workspaceDir, contextFileName);
        // Include conversation history for context continuity
        const contextFileContent = `${personaContent}\n\n${conversationHistory}## Current Task\n\n${currentContent}\n`;
        fs.writeFileSync(contextFilePath, contextFileContent, 'utf8');
        logger.info(`[ClaudeCodeProvider] ✅ Wrote persona + task to ${contextFilePath} (${contextFileContent.length} chars, historyMsgs=${recentMessages.length - 1})`);
        return `Read ${contextFileName} first for your identity and context, then respond to the Current Task section.`;
      } catch (writeErr) {
        logger.warn(`[ClaudeCodeProvider] Failed to write context file, falling back to inline: ${writeErr.message}`);
      }
    }

    // Root / fallback: pass everything inline (no tool use required)
    // Include conversation history for context continuity
    const inlinePrompt = `${personaContent}\n\n${conversationHistory}## Current Task\n\n${currentContent}`;
    logger.info(`[ClaudeCodeProvider] Using inline prompt (${inlinePrompt.length} chars, root=${isRoot}, historyMsgs=${recentMessages.length - 1})`);
    return inlinePrompt;
  }

  /**
   * Enforce rate limiting if enabled
   * @private
   */
  async _enforceRateLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Clean old requests
    this.requestTimes = this.requestTimes.filter(time => time > oneMinuteAgo);
    
    // Check rate limits
    const recentRequests = this.requestTimes.length;
    
    if (recentRequests >= this.config.rateLimit.requestsPerMinute) {
      const oldestRequest = this.requestTimes[0];
      const waitTime = 60000 - (now - oldestRequest) + 100; // Add 100ms buffer
      
      logger.warn(`[ClaudeCodeProvider] Rate limit reached (${recentRequests}/${this.config.rateLimit.requestsPerMinute} RPM), waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this._enforceRateLimit(); // Recursive check after waiting
    }
    
    // Check burst limit (requests in last 10 seconds)
    const tenSecondsAgo = now - 10000;
    const burstRequests = this.requestTimes.filter(time => time > tenSecondsAgo).length;
    
    if (burstRequests >= this.config.rateLimit.burstLimit) {
      const waitTime = 2000; // Wait 2 seconds for burst limit
      logger.warn(`[ClaudeCodeProvider] Burst limit reached (${burstRequests}/${this.config.rateLimit.burstLimit}), waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Record this request
    this.requestTimes.push(now);
  }

  /**
   * Extract response text from Claude Code CLI result
   * @param {Object} result - Result from ClaudeCodeCLIWrapper.executeTask()
   * @returns {string}
   * @private
   */
  _extractResponseText(result) {
    // Claude CLI JSON output puts the response in result.text or result.result
    if (result.text && typeof result.text === 'string') {
      return result.text;
    }
    if (result.result && typeof result.result === 'string') {
      return result.result;
    }
    if (result.result && typeof result.result === 'object') {
      return result.result.text || result.result.result || JSON.stringify(result.result);
    }
    return JSON.stringify(result, null, 2);
  }

  /**
   * Test connection to Claude Code CLI
   * Verifies CLI is available AND authenticated
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      const available = await this.wrapper.isAvailable();
      if (!available) {
        logger.warn('ClaudeCodeProvider: Claude CLI not available');
        return false;
      }

      const version = await this.wrapper.getVersion();
      logger.info(`ClaudeCodeProvider: Claude CLI available (version: ${version || 'unknown'})`);

      // Also check auth status
      const authStatus = await this.wrapper.getAuthStatus();
      if (authStatus) {
        if (authStatus.loggedIn) {
          logger.info(`ClaudeCodeProvider: Authenticated (method: ${authStatus.authMethod}, email: ${authStatus.email || 'N/A'})`);
        } else {
          logger.warn('ClaudeCodeProvider: Claude CLI available but NOT authenticated');
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error(`ClaudeCodeProvider: Connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get model/provider info
   * @returns {Object}
   */
  getModelInfo() {
    return {
      provider: 'claude-code',
      model: this.config.model,
      timeout: this.config.timeout,
      inactivityTimeout: this.config.inactivityTimeout,
      claudeCommand: this.config.claudeCommand,
    };
  }

  /**
   * Get provider info (used by health/status endpoints)
   * @returns {Object}
   */
  getProviderInfo() {
    return {
      name: 'claude-code',
      displayName: 'Claude Code CLI',
      description: 'Anthropic Claude via official Claude Code CLI',
      model: this.config.model,
      authMethod: 'OAuth (~/.claude/) or ANTHROPIC_API_KEY',
      costTracking: 'real', // Real costs from CLI, not estimates
    };
  }
}

function parseDurationSeconds(configValue, msEnvValue, secondsEnvValue, fallbackSeconds) {
  const explicit = parsePositiveNumber(configValue);
  if (explicit != null) {
    return explicit > 10_000 ? Math.ceil(explicit / 1000) : Math.ceil(explicit);
  }
  const ms = parsePositiveNumber(msEnvValue);
  if (ms != null) {
    return Math.ceil(ms / 1000);
  }
  const seconds = parsePositiveNumber(secondsEnvValue);
  if (seconds != null) {
    return Math.ceil(seconds);
  }
  return fallbackSeconds;
}

function parsePositiveNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(configValue, envValue, fallback) {
  if (typeof configValue === 'boolean') return configValue;
  if (typeof configValue === 'string' && configValue.trim()) {
    return ['1', 'true', 'yes', 'on'].includes(configValue.trim().toLowerCase());
  }
  if (typeof envValue === 'string' && envValue.trim()) {
    return ['1', 'true', 'yes', 'on'].includes(envValue.trim().toLowerCase());
  }
  return fallback;
}

module.exports = ClaudeCodeProvider;

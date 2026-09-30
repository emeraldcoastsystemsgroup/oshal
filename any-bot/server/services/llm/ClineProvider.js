/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: deny constrained execution before autonomous Cline CLI can bypass server tool authorization.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The model Cline drives is the BACKING provider's model, resolved per call, not the fleet default it was constructed with. startup-core-services hands this provider `config.llm.defaultModel` - the PRIMARY harness's model (LLM_MODEL=gpt-5.5 on the Codex fleet) - and generateResponse passed it straight to `-m`. On 2026-09-17, with the Cline binary fixed and global-config.json naming gemini/gemini-3.8-flash on every container, the first failed-over ticket still died: `models/gpt-5.5 is not found for API version v1beta` (provider gemini, -m gpt-5.5, measured in the general-bot log at 23:16:33Z). The wrapper already resolves the backing provider AND model through one precedence chain (CLINE_API_* -> global-config.json -> env file); this file now asks it before gating and before spawning, so the model gate, the -m flag and the cost row all name the model that actually ran. A deployment whose chain names no model keeps today's constructor default.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Protected zero-tool direct reasoning now bypasses Cline's autonomous CLI loop without bypassing the bot's configured provider authority. A trusted internal marker selects one Gemini OpenAI-compatible request with no declared tools, an in-memory persona and fail-closed tool/empty-response handling; unsupported backing providers or absent hosted credentials never fall back to the CLI. Ordinary Cline calls retain the existing context-file and agent-loop path.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Make "single shot" true at the transport boundary: the Gemini adapter disables OpenAI SDK retries, caps its request timeout at the existing 300-second Cline ceiling, and reports zero/unknown cost instead of applying GPT prices. The normalized Cline result also keeps cost zero defensively.
 */

/**
 * Cline CLI Provider
 * Implements LLM provider interface using Cline CLI as the backend
 * 
 * Key difference from BedrockProvider:
 * - BedrockProvider: 1 turn per call (single LLM request/response)
 * - ClineProvider: N turns per call (Cline does full agentic loop internally)
 * 
 * From AgenticController's perspective, both are just LLM providers that:
 * - Accept messages array
 * - Return response with content, usage, cost
 * - Support tools via options
 * 
 * The magic: Cline CLI does its own multi-turn loop internally, then returns
 * the final result. AgenticController sees this as a single "smart" LLM call.
 */

const ClineCLIWrapper = require('../codebase/ClineCLIWrapper');
const OpenAIProvider = require('./OpenAIProvider');
const logger = require('../../utils/logger');
const { formatProviderFailure, isProviderRecoverableRuntimeFailure, isProviderRuntimeBanner } = require('./providerFailureClassifier');
const { assertCliToolBoundary } = require('./assert-cli-tool-boundary');

const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const MAX_SINGLE_SHOT_TIMEOUT_MS = 300_000;
const MIN_SINGLE_SHOT_TIMEOUT_MS = 1_000;

/** @returns {string} First non-empty secret/config value without logging it. */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** @returns {number} A finite non-negative metric value, otherwise zero. */
function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** @returns {number} Cline's seconds timeout as a positive SDK timeout, capped at five minutes. */
function boundedSingleShotTimeoutMs(timeoutSeconds) {
  const milliseconds = Math.trunc(Number(timeoutSeconds) * 1000);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return MAX_SINGLE_SHOT_TIMEOUT_MS;
  return Math.min(MAX_SINGLE_SHOT_TIMEOUT_MS, Math.max(MIN_SINGLE_SHOT_TIMEOUT_MS, milliseconds));
}

/** @returns {Error & {code:string}} A stable fail-closed error for the protected direct lane. */
function directReasoningError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @description LLM provider that fronts the Cline CLI so the rest of the
 * system can treat an entire agentic loop as a single "smart" LLM call. The
 * intent is to keep AgenticController provider-agnostic: this class adapts
 * Cline's internal multi-turn behavior to the same request/response/usage/cost
 * shape produced by BedrockProvider, while transparently handling persona
 * injection, workspace setup, and CLI failures (returned as continuable text
 * rather than hard errors).
 */
class ClineProvider {
  /**
   * @description Configure the provider and instantiate the underlying CLI
   * wrapper. Resolves a default model id appropriate for GovCloud (where the
   * model is largely informational since the CLI reads globalState.json) and
   * sets timeouts/inactivity limits so a stalled agentic loop cannot hang the
   * caller indefinitely.
   * @param {Object} [config={}] - Optional overrides for provider behavior.
   * @param {number} [config.timeout] - Overall task timeout in seconds.
   * @param {number} [config.inactivityTimeout] - Max seconds of CLI silence before aborting.
   * @param {string} [config.model] - Model id to report/use (overrides env-derived default).
   * @param {string} [config.clineCommand] - Path to the Cline CLI executable.
   */
  constructor(config = {}) {
    // ⭐ PHASE_55 FIX: Determine correct model ID for GovCloud
    // If LLM_MODEL is not set but we're in GovCloud, use the GovCloud inference profile
    // This ensures the -m flag passed to Cline CLI has the correct us-gov. prefix
    // ⭐ PHASE_05 SESSION_02 FIX: Default to Claude 3.7 Sonnet (confirmed available in GovCloud)
    // Claude 3.5 Sonnet v2 does NOT exist in GovCloud. Claude 3.7 is the correct replacement.
    // In GovCloud, the CLI uses globalState.json (no -m flag), so the model ID here is informational
    // for logging and non-GovCloud fallback only.
    const defaultModel = process.env.LLM_MODEL || 'anthropic.claude-3-7-sonnet-20250219-v1:0';

    this.config = {
      timeout: config.timeout || 300, // 5 minutes default
      inactivityTimeout: config.inactivityTimeout || 180, // 3 minutes silence
      model: config.model || defaultModel,
      clineCommand: config.clineCommand || process.env.HOME + '/.local/bin/cline',
    };

    // Use ClineCLIWrapper which handles large prompts properly (avoids E2BIG)
    // Wrapper uses direct spawn (Front Door disabled) for consistent pattern
    this.wrapper = new ClineCLIWrapper({
      clineCommand: this.config.clineCommand,
      timeout: this.config.timeout,
      inactivityTimeout: this.config.inactivityTimeout,
    });

    logger.info(`ClineProvider initialized (timeout: ${this.config.timeout}s, model: ${this.config.model})`);
  }

  /**
   * Generate response using Cline CLI
   * Implements same interface as BedrockProvider.generateResponse()
   *
   * @param {Array} messages - Conversation history [{role, content}]
   * @param {Object} options - Generation options
   * @param {string} options.systemPrompt - System prompt (injected into task description)
   * @param {Array} options.tools - Available tools (Cline has its own tools, but we pass for context)
   * @param {number} options.maxTokens - Max tokens (not used by Cline, but accepted for interface compatibility)
   * @param {number} options.temperature - Temperature (not used by Cline, but accepted for interface compatibility)
   * @param {string} options.agentId - Dynamic agent ID for persona loading (PHASE_58)
   * @returns {Promise<Object>} Response object matching BedrockProvider format
   */
  async generateResponse(messages, options = {}) {
    const singleShotToolless = options.singleShotToolless === true;
    if (singleShotToolless) this._assertSingleShotToollessBoundary(options);
    else assertCliToolBoundary(options, 'cline-cli');
    const startTime = Date.now();

    // Model-gateway pre-flight (budgets/quotas/cost-aware routing). One gate for
    // ALL bot LLM traffic — the controller. Fail-open; no-op until OSHAL_LLM_BUDGETS
    // is enabled on the controller. Runs BEFORE the try so a hard deny propagates
    // (not swallowed into an error-text response).
    const { gateLlmCall } = require('./llmGate');
    const callModel = this._resolveCallModel();
    const gate = await gateLlmCall(callModel, messages, options);
    if (!gate.allowed) {
      throw new Error(`LLM call denied by model gateway (${gate.reason})`);
    }
    const gatedModel = gate.model || callModel;

    // This branch deliberately sits OUTSIDE the legacy catch below. Missing hosted credentials,
    // an unsupported backing provider, an attempted tool call or an empty answer is a hard
    // protected-execution failure; converting any of those into assistant text would make the
    // package believe its CRM operation succeeded. It must never fall through to Cline CLI.
    if (singleShotToolless) {
      return this._generateSingleShotToolless(messages, options, gatedModel, startTime);
    }

    try {
      // ⭐ PHASE_58: Extract dynamic agentId for persona loading
      const dynamicAgentId = options.agentId || null;
      
      if (dynamicAgentId) {
        logger.info(`🎭 ClineProvider: Using dynamic persona: ${dynamicAgentId}`);
      }

      // Convert messages to task description for Cline CLI
      // ⭐ PHASE_54: Now async to support in-memory prompt assembly
      // ⭐ PHASE_58: Pass agentId to _messagesToTask for persona loading
      const taskDescription = await this._messagesToTask(messages, options, dynamicAgentId);

      // Determine workspace directory
      // Cline needs a working directory — use WORKSPACE_DIR env or /app/workspace as default
      const workspaceDir = options.workspaceDir || process.env.WORKSPACE_DIR || '/app/workspace';

      logger.info(`ClineProvider: Executing task in ${workspaceDir}`);
      logger.debug(`ClineProvider: Task description: ${taskDescription.substring(0, 200)}...`);

      // Execute via ClineCLIWrapper (handles large prompts, avoids E2BIG)
      // PHASE_43: Pass source parameter to enable Front Door API routing with proper persona injection
      let result;
      try {
        result = await this.wrapper.executeTask(taskDescription, workspaceDir, {
          timeout: this.config.timeout,
          inactivityTimeout: this.config.inactivityTimeout,
          model: gatedModel, // gateway may downshift under budget pressure
          source: options.source || 'cline-provider', // Pass source for dashboard vs ticket detection
          extraEnv: options.extraEnv, // per-request user scoping (OSHAL_USER_SUB)
        });
      } catch (clineError) {
        // Cline CLI execution failed - return error as text response
        // AgenticController will feed this back to LLM for retry/alternative approach
        logger.warn(`ClineProvider: Cline CLI execution error: ${clineError.message}`);

        if (isProviderRecoverableRuntimeFailure(clineError)) {
          throw clineError;
        }
        
        const errorResponse = `Cline CLI encountered an error: ${clineError.message}\n\n` +
          `This may be due to:\n` +
          `- Invalid tool usage (e.g., trying to read a directory as a file)\n` +
          `- Timeout or stall\n` +
          `- Missing dependencies\n\n` +
          `Please try a different approach or use alternative tools.`;
        
        return {
          content: errorResponse,
          contentBlocks: [{ type: 'text', text: errorResponse }],
          stopReason: 'end_turn', // NOT 'error' - let AgenticController continue
          usage: {
            inputTokens: 100, // Estimate for error handling
            outputTokens: 50,
            totalTokens: 150,
            cacheCreationTokens: 0,
            cacheReads: 0,
          },
          cost: 0.0005, // Minimal cost for error
          latency: Date.now() - startTime,
          model: gatedModel,
          provider: 'cline-cli',
          clineError: clineError.message,
        };
      }

      const latency = Date.now() - startTime;

      // Extract final text response from Cline result
      const responseText = this._extractResponseText(result);

      // Success path: match only narrow runtime/stall banners, never the broad
      // throttle/auth keywords (they routinely appear in valid answers). Genuine
      // throttle/auth failures come through the !result.success branch below.
      if (isProviderRuntimeBanner(responseText)) {
        throw new Error(`Cline CLI returned provider failure text: ${formatProviderFailure(responseText)}`);
      }

      // Check if Cline failed internally (success: false)
      if (!result.success) {
        const failureText = `${responseText || ''}\n${result.stderr || ''}`;
        if (isProviderRecoverableRuntimeFailure(failureText)) {
          throw new Error(`Cline CLI task failed: ${formatProviderFailure(failureText)}`);
        }

        // Cline ran but failed - return failure as text so LLM can retry
        const failureResponse = `Cline CLI task failed: ${responseText}\n\n` +
          `Stderr: ${result.stderr || 'N/A'}\n\n` +
          `Please try a different approach.`;
        
        return {
          content: failureResponse,
          contentBlocks: [{ type: 'text', text: failureResponse }],
          stopReason: 'end_turn', // Let AgenticController continue
          usage: {
            inputTokens: result.activityStats?.inputTokens || 100,
            outputTokens: result.activityStats?.outputTokens || 50,
            totalTokens: result.activityStats?.totalTokens || 150,
            cacheCreationTokens: 0,
            cacheReads: 0,
          },
          cost: result.activityStats?.estimatedCost || 0.001,
          latency,
          model: gatedModel,
          provider: 'cline-cli',
          clineMetadata: {
            turns: result.activityStats?.totalMessages || 0,
            toolsUsed: result.activityStats?.toolUseCount || 0,
            failed: true,
          },
        };
      }

      // Success - build response in BedrockProvider format
      const response = {
        content: responseText,
        contentBlocks: [{ type: 'text', text: responseText }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: result.activityStats?.inputTokens || 0,
          outputTokens: result.activityStats?.outputTokens || 0,
          totalTokens: result.activityStats?.totalTokens || 0,
          cacheCreationTokens: 0,
          cacheReads: 0,
        },
        cost: result.activityStats?.estimatedCost || 0,
        latency,
        model: gatedModel,
        provider: 'cline-cli',
        // Include Cline-specific metadata
        clineMetadata: {
          turns: result.activityStats?.totalMessages || 0,
          toolsUsed: result.activityStats?.toolUseCount || 0,
          thinkingBlocks: result.activityStats?.thinkingCount || 0,
          costEstimated: result.activityStats?.costEstimated !== false,
        },
      };

      logger.info(`ClineProvider: Task completed in ${latency}ms, ${response.usage.totalTokens} tokens (estimated), $${response.cost.toFixed(4)}`);

      return response;

    } catch (error) {
      // Outer catch for unexpected errors (shouldn't happen, but safety net)
      logger.error(`ClineProvider: Unexpected error: ${error.message}`);

      if (isProviderRecoverableRuntimeFailure(error)) {
        throw error;
      }
      
      const errorResponse = `Unexpected error in Cline CLI provider: ${error.message}\n\n` +
        `Please try using Bedrock provider instead or use alternative tools.`;
      
      return {
        content: errorResponse,
        contentBlocks: [{ type: 'text', text: errorResponse }],
        stopReason: 'end_turn', // Let AgenticController continue
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
        provider: 'cline-cli',
        error: error.message,
      };
    }
  }

  /**
   * @description Require the exact deny-all provider boundary established by TaskController before
   * honoring the internal protected single-shot marker. The marker chooses a transport; it is not
   * itself tool authority, so a malformed/inconsistent call fails before any hosted request.
   * @param {Object} options - Direct-provider options from TaskController.
   * @private
   */
  _assertSingleShotToollessBoundary(options) {
    if (options.protectedSingleShotVerified !== true
      || options.source !== 'swarm-dispatch'
      || typeof options.agentId !== 'string'
      || !options.agentId.trim()
      || options.enforceToolBoundary !== true
      || !Array.isArray(options.tools)
      || options.tools.length !== 0) {
      throw directReasoningError(
        'DIRECT_REASONING_BOUNDARY_INVALID',
        'Protected single-shot reasoning requires verified protected provenance, trusted runtime identity, and an enforced empty tool boundary.',
      );
    }
  }

  /**
   * @description Execute one hosted completion against the API provider that the configured Cline
   * runtime fronts. This is deliberately not OpenAIProvider.generateResponse(): that method may
   * add a recovery leg after an unsolicited tool call, while this contract permits exactly one
   * provider request and rejects every tool-call shape.
   * @param {Array} messages - Direct-path messages; only the current message is used, matching the
   * ordinary Cline context-file path's stateless behavior.
   * @param {Object} options - Trusted direct-provider options.
   * @param {string} gatedModel - Exact configured model after the model-gateway decision.
   * @param {number} startTime - Request start timestamp for latency reporting.
   * @returns {Promise<Object>} Standard provider result with Cline runtime identity.
   * @private
   */
  async _generateSingleShotToolless(messages, options, gatedModel, startTime) {
    let backing;
    try {
      backing = this.wrapper._resolveBackingProvider();
    } catch (error) {
      throw directReasoningError(
        'DIRECT_REASONING_UNAVAILABLE',
        `Configured Cline backing provider could not be resolved for protected direct reasoning: ${error.message}`,
      );
    }

    const backingProvider = typeof backing?.provider === 'string'
      ? backing.provider.trim().toLowerCase()
      : '';
    if (backingProvider !== 'gemini') {
      throw directReasoningError(
        'DIRECT_REASONING_UNAVAILABLE',
        `Configured Cline backing provider '${backingProvider || 'unknown'}' has no protected single-shot adapter.`,
      );
    }

    const apiKey = firstNonEmpty(process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY);
    if (!apiKey) {
      throw directReasoningError(
        'DIRECT_REASONING_UNAVAILABLE',
        'Configured Gemini backing provider has no GEMINI_API_KEY or GOOGLE_API_KEY for protected direct reasoning.',
      );
    }

    const currentMessage = Array.isArray(messages) ? messages[messages.length - 1] : null;
    const currentContent = typeof currentMessage?.content === 'string'
      ? currentMessage.content
      : currentMessage?.content === undefined ? '' : JSON.stringify(currentMessage.content);
    if (typeof currentContent !== 'string' || !currentContent.trim()) {
      throw directReasoningError('DIRECT_REASONING_UNAVAILABLE', 'Protected direct reasoning received no current task text.');
    }

    const { personaContent } = this._loadPersonaContent(options, options.agentId || null);
    const systemPrompt = [
      personaContent,
      '## PROTECTED DIRECT REASONING MODE',
      'Return exactly one final textual answer using only the facts in the Current Task.',
      'No tools are available. Do not request, name, invoke, or simulate file, command, browser, MCP, or other tools.',
    ].join('\n\n');
    const directProvider = this._createSingleShotProvider({
      apiKey,
      model: gatedModel,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      requestTimeoutMs: boundedSingleShotTimeoutMs(this.config.timeout),
    });
    const result = await directProvider.sendRequest({
      // OpenAIProvider.sendRequest consumes the legacy any-bot message shape, not { role, content }.
      messages: [{ type: 'user', text: currentContent }],
      systemPrompt,
      tools: [],
      stream: false,
    });
    const blocks = Array.isArray(result?.content) ? result.content : [];
    if (blocks.some((block) => block?.type === 'tool_use')) {
      throw directReasoningError(
        'DIRECT_REASONING_UNSAFE_RESPONSE',
        'Protected direct reasoning attempted a tool call; the response was rejected without a continuation.',
      );
    }
    const responseText = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!responseText) {
      throw directReasoningError(
        'EMPTY_FINAL_ANSWER',
        'Protected direct reasoning returned no final text; no retry or CLI fallback was attempted.',
      );
    }

    const inputTokens = nonNegativeNumber(result?.usage?.inputTokens);
    const outputTokens = nonNegativeNumber(result?.usage?.outputTokens);
    return {
      content: responseText,
      contentBlocks: [{ type: 'text', text: responseText }],
      stopReason: result.stopReason || 'end_turn',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheCreationTokens: 0,
        cacheReads: nonNegativeNumber(result?.usage?.cacheReads),
      },
      // Gemini pricing is not OpenAI pricing. Until a Gemini price table owns this lane, zero is
      // the downstream contract for unknown cost rather than a fabricated GPT estimate.
      cost: 0,
      latency: Date.now() - startTime,
      model: gatedModel,
      provider: 'cline-cli',
      apiProvider: backingProvider,
      clineMetadata: { turns: 1, toolsUsed: 0, protectedSingleShot: true, costEstimated: false },
    };
  }

  /**
   * @description Construct the one hosted adapter supported by the protected Cline direct lane.
   * Kept behind a narrow method so unit coverage can replace the transport without network access.
   * @param {{apiKey:string,model:string,maxTokens?:number,temperature?:number,requestTimeoutMs:number}} config - Request config.
   * @returns {OpenAIProvider} Gemini's OpenAI-compatible adapter.
   * @private
   */
  _createSingleShotProvider(config) {
    return new OpenAIProvider({
      ...config,
      baseUrl: GEMINI_OPENAI_BASE_URL,
      maxRetries: 0,
      costMode: 'unknown',
      // sendRequest never consults this seam, and protected one-shot inference must not create a
      // provider-side preamble resource as a hidden second request.
      invariantPromptCache: null,
    });
  }

  /**
   * @description The model Cline actually drives on THIS call. This provider is constructed with
   * the fleet default (`config.llm.defaultModel`, i.e. the PRIMARY harness's LLM_MODEL), but the
   * Cline CLI runs against its own backing provider, which the wrapper resolves per call from
   * CLINE_API_PROVIDER/CLINE_API_MODEL, then the persisted global-config.json, then the env file.
   * Handing the primary's model to a different backing provider is how the 2026-09-17 failover
   * asked Gemini for `gpt-5.5` and lost every ticket. The resolved backing model wins when the
   * chain names one; the constructor model stays the fallback for a deployment that names none,
   * so a box with no Cline configuration behaves exactly as before.
   * @returns {string} The model id to gate, pass as `-m`, and report on the cost row.
   * @private
   */
  _resolveCallModel() {
    try {
      const backing = this.wrapper._resolveBackingProvider();
      if (backing && backing.model) {
        if (backing.model !== this.config.model) {
          logger.info(`[ClineProvider] Backing provider ${backing.provider} names model ${backing.model}; not passing the fleet default ${this.config.model} to it`);
        }
        return backing.model;
      }
    } catch (err) {
      logger.warn(`[ClineProvider] Backing provider unresolved (${err.message}); using constructor model ${this.config.model}`);
    }
    return this.config.model;
  }

  /**
   * @description Resolve the full configured bot persona in memory. Both the autonomous CLI path
   * and protected hosted path consume this one loader; only the former writes the result into a
   * workspace context file.
   * @param {Object} options - Provider options, including the existing systemPrompt fallback.
   * @param {string|null} agentId - Trusted runtime agent identity when supplied.
   * @returns {{personaContent:string,effectiveAgentId:string}} Persona text and resolved identity.
   * @private
   */
  _loadPersonaContent(options = {}, agentId = null) {
    const fs = require('fs');
    const effectiveAgentId = agentId || process.env.AGENT_ID || 'project-manager';

    if (agentId && agentId !== process.env.AGENT_ID) {
      logger.info(`[ClineProvider] 🎭 Loading persona for dynamic agent: ${agentId} (container default: ${process.env.AGENT_ID})`);
    }

    // Always prefer the full YAML perspective. The generic AgenticController system prompt does
    // not contain the bot's complete role, capabilities or operating perspective.
    let personaContent = '';
    try {
      const yaml = require('js-yaml');
      const fallbackPaths = [
        process.env.BOT_PERSONA_FILE,
        `/app/bot-configs/${effectiveAgentId}.yaml`,
        `/app/ai-lab/bot-personas/${effectiveAgentId}.yaml`,
      ].filter(Boolean);

      for (const personaPath of fallbackPaths) {
        if (personaPath && fs.existsSync(personaPath)) {
          const parsed = yaml.load(fs.readFileSync(personaPath, 'utf8'));
          if (parsed && parsed.perspective) {
            const parts = [
              '# YOUR IDENTITY AND ROLE',
              `You are **${parsed.name || effectiveAgentId}** — ${parsed.role || 'AI assistant'}.`,
              '',
              parsed.perspective,
              '',
            ];
            if (parsed.capabilities && parsed.capabilities.length > 0) {
              parts.push('## YOUR CAPABILITIES');
              parsed.capabilities.forEach((capability) => parts.push(`- ${capability}`));
              parts.push('');
            }
            parts.push('---', '');
            personaContent = parts.join('\n');
            logger.info(`[ClineProvider] ✅ Loaded FULL persona for ${effectiveAgentId} from: ${personaPath} (${personaContent.length} chars)`);
            break;
          }
        }
      }
    } catch (yamlErr) {
      logger.warn(`[ClineProvider] Failed to load persona YAML for ${effectiveAgentId}: ${yamlErr.message}`);
    }

    if (!personaContent && options.systemPrompt) {
      personaContent = options.systemPrompt;
      logger.warn('[ClineProvider] No persona YAML found — using systemPrompt from AgenticController');
    }
    if (!personaContent) {
      personaContent = 'You are a helpful AI assistant. Respond clearly and concisely.';
      logger.warn('[ClineProvider] No persona found — using generic identity');
    }
    return { personaContent, effectiveAgentId };
  }

  /**
   * Convert Anthropic message format to Cline CLI task description
   *
   * ⭐ PHASE_56 FIX: Workspace README approach
   * Instead of passing persona + conversation history as CLI text (which causes
   * Cline CLI's ink React renderer to crash with key collisions), we:
   * 1. Write persona + current message to {workspaceDir}/README.md
   * 2. Return a minimal task instruction (~60 chars) that tells Cline to read the file
   *
   * This solves ALL three problems:
   * - No React key collision (tiny prompt, no history)
   * - Persona injected via file (Cline reads it naturally)
   * - Stateless calls (no conversation history passed)
   *
   * ⭐ PHASE_58: Accept agentId parameter for dynamic persona loading
   *
   * @param {Array} messages - Message history (only last message used)
   * @param {Object} options - Options including systemPrompt, workspaceDir
   * @param {string} agentId - Dynamic agent ID for persona loading (overrides process.env.AGENT_ID)
   * @returns {Promise<string>} Minimal task instruction for Cline CLI
   * @private
   */
  async _messagesToTask(messages, options = {}, agentId = null) {
    const fs = require('fs');
    const path = require('path');

    // Get workspace directory — must exist before Cline CLI runs
    const workspaceDir = options.workspaceDir || process.env.WORKSPACE_DIR || '/app/workspace';

    // Extract ONLY the current message (last in array) — no conversation history
    const currentMessage = messages[messages.length - 1];
    const currentContent = (typeof currentMessage.content === 'string')
      ? currentMessage.content
      : JSON.stringify(currentMessage.content);

    const { personaContent, effectiveAgentId } = this._loadPersonaContent(options, agentId);

    // ⭐ PHASE_63 FIX: Write persona + task to agent-specific context file
    // Previously wrote to README.md — but all bots share the same workspace folder
    // for a ticket, so they were stomping on each other's identity files.
    // Now each bot writes to {agentId}-context.md so they don't conflict.
    // e.g., rca-specialist writes rca-specialist-context.md
    //       email-bot writes email-bot-context.md
    // Each bot reads its OWN file, so identity is always correct.
    const contextFileName = `${effectiveAgentId}-context.md`;
    
    try {
      // Ensure workspace directory exists
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }

      const contextFilePath = path.join(workspaceDir, contextFileName);
      const contextFileContent = `${personaContent}\n\n## Current Task\n\n${currentContent}\n`;
      fs.writeFileSync(contextFilePath, contextFileContent, 'utf8');
      logger.info(`[ClineProvider] ✅ Wrote persona + task to ${contextFilePath} (${contextFileContent.length} chars)`);
    } catch (writeErr) {
      logger.error(`[ClineProvider] Failed to write agent context file: ${writeErr.message}`);
      // Fallback: pass content directly (may cause issues but better than nothing)
      return `${personaContent}\n\n## Current Task\n\n${currentContent}`;
    }

    // Return minimal task instruction referencing the agent-specific context file
    // This keeps the CLI prompt tiny (~80 chars) — no React key collision possible
    // Each bot reads its own file, so identity is always correct even in shared workspaces
    return `Read ${contextFileName} first for your identity and context, then respond to the Current Task section.`;
  }

  /**
   * Extract response text from Cline CLI result
   * 
   * @param {Object} result - Result from ClineCLIWrapper.executeTask()
   * @returns {string} Response text
   * @private
   */
  _extractResponseText(result) {
    // Check for explicit text field
    if (result.text) {
      return result.text;
    }

    // Check for result object with text
    if (result.result && typeof result.result === 'object') {
      if (result.result.text) {
        return result.result.text;
      }
      if (result.result.result) {
        return result.result.result;
      }
    }

    // Check for messages array (streaming result)
    if (result.messages && Array.isArray(result.messages)) {
      // Find completion_result message
      const completion = result.messages.find(m => m.say === 'completion_result' || m.type === 'completion_result');
      if (completion && completion.text) {
        return completion.text;
      }

      // Fallback: concatenate all text messages
      const textMessages = result.messages
        .filter(m => m.say === 'text' || m.type === 'text')
        .map(m => m.text)
        .filter(Boolean);
      
      if (textMessages.length > 0) {
        return textMessages.join('\n\n');
      }
    }

    // Last resort: stringify the result
    return JSON.stringify(result, null, 2);
  }

  /**
   * Test connection to Cline CLI
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      const available = await this.wrapper.isAvailable();
      if (available) {
        const version = await this.wrapper.getVersion();
        logger.info(`ClineProvider: Cline CLI available (version: ${version || 'unknown'})`);
      }
      return available;
    } catch (error) {
      logger.error(`ClineProvider: Connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get model info
   * @returns {Object} Model information
   */
  getModelInfo() {
    return {
      provider: 'cline-cli',
      model: this.config.model,
      timeout: this.config.timeout,
      inactivityTimeout: this.config.inactivityTimeout,
    };
  }
}

module.exports = ClineProvider;

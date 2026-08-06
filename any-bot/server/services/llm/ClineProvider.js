/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: deny constrained execution before autonomous Cline CLI can bypass server tool authorization.
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
const logger = require('../../utils/logger');
const { formatProviderFailure, isProviderRecoverableRuntimeFailure, isProviderRuntimeBanner } = require('./providerFailureClassifier');
const { assertCliToolBoundary } = require('./assert-cli-tool-boundary');

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
    assertCliToolBoundary(options, 'cline-cli');
    const startTime = Date.now();

    // Model-gateway pre-flight (budgets/quotas/cost-aware routing). One gate for
    // ALL bot LLM traffic — the controller. Fail-open; no-op until OSHAL_LLM_BUDGETS
    // is enabled on the controller. Runs BEFORE the try so a hard deny propagates
    // (not swallowed into an error-text response).
    const { gateLlmCall } = require('./llmGate');
    const gate = await gateLlmCall(this.config.model, messages, options);
    if (!gate.allowed) {
      throw new Error(`LLM call denied by model gateway (${gate.reason})`);
    }
    const gatedModel = gate.model || this.config.model;

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

    // ⭐ PHASE_58: Use dynamic agentId if provided, otherwise fall back to container default
    const effectiveAgentId = agentId || process.env.AGENT_ID || 'project-manager';
    
    if (agentId && agentId !== process.env.AGENT_ID) {
      logger.info(`[ClineProvider] 🎭 Loading persona for dynamic agent: ${agentId} (container default: ${process.env.AGENT_ID})`);
    }

    // ⭐ PHASE_56 FIX: Always load FULL persona from YAML file first.
    // The systemPrompt passed from AgenticController is the minimal/generic ClineSystemPrompt
    // which does NOT contain the full job description, team roster, Plane system knowledge, etc.
    // We MUST use the full persona YAML perspective field for the bot to know its actual job.
    let personaContent = '';
    
    // Step 1: Try to load FULL persona from YAML file (preferred — has complete job description)
    try {
      const yaml = require('js-yaml');
      const personaFile = process.env.BOT_PERSONA_FILE;
      
      // ⭐ PHASE_58: Build fallback paths using effectiveAgentId (not just process.env.AGENT_ID)
      const fallbackPaths = [
        personaFile,
        `/app/bot-configs/${effectiveAgentId}.yaml`,
        `/app/ai-lab/bot-personas/${effectiveAgentId}.yaml`,
      ].filter(Boolean);

      for (const p of fallbackPaths) {
        if (p && fs.existsSync(p)) {
          const parsed = yaml.load(fs.readFileSync(p, 'utf8'));
          if (parsed && parsed.perspective) {
            // Build FULL persona content with complete job description
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
            logger.info(`[ClineProvider] ✅ Loaded FULL persona for ${effectiveAgentId} from: ${p} (${personaContent.length} chars)`);
            break;
          }
        }
      }
    } catch (yamlErr) {
      logger.warn(`[ClineProvider] Failed to load persona YAML for ${effectiveAgentId}: ${yamlErr.message}`);
    }

    // Step 2: If no YAML found, fall back to systemPrompt from AgenticController
    if (!personaContent && options.systemPrompt) {
      personaContent = options.systemPrompt;
      logger.warn('[ClineProvider] No persona YAML found — using systemPrompt from AgenticController');
    }

    // Step 3: Last resort generic identity
    if (!personaContent) {
      personaContent = 'You are a helpful AI assistant. Respond clearly and concisely.';
      logger.warn('[ClineProvider] No persona found — using generic identity');
    }

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

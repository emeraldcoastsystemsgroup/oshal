/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * AWS Bedrock Provider
 * Interfaces with Claude via AWS Bedrock
 */

const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const logger = require('../../utils/logger');

/**
 * @description LLM provider that talks to Anthropic Claude models hosted on AWS
 * Bedrock. Exists so the rest of the harness can request completions through a
 * single, swappable interface without knowing about Bedrock request shapes,
 * cross-region inference profiles, extended-thinking constraints, prompt
 * caching, throttling/retry handling, or cost accounting — all of which are
 * encapsulated here.
 */
class BedrockProvider {
  /**
   * @description Builds the provider's effective configuration by layering
   * explicit overrides over environment variables and sane defaults, then
   * constructs the Bedrock runtime client. Credentials are only passed
   * explicitly when both key and secret are present; otherwise the default AWS
   * credential chain (IAM role, profile, etc.) is used so the harness can run
   * in environments where credentials are ambient.
   * @param {Object} [config={}] - Optional configuration overrides.
   * @param {string} [config.region] - AWS region for the Bedrock client.
   * @param {string} [config.accessKeyId] - Explicit AWS access key id.
   * @param {string} [config.secretAccessKey] - Explicit AWS secret access key.
   * @param {string} [config.model] - Base Claude model id to invoke.
   * @param {number} [config.maxTokens] - Default max output tokens.
   * @param {number} [config.temperature] - Default sampling temperature.
   * @param {boolean} [config.useCrossRegionInference] - Whether to add a
   *   cross-region inference profile prefix to the model id.
   */
  constructor(config = {}) {
    this.config = {
      region: config.region || process.env.AWS_REGION || 'us-east-1',
      accessKeyId: config.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY,
      model: config.model || process.env.LLM_MODEL || 'anthropic.claude-3-7-sonnet-20250219-v1:0',
      maxTokens: config.maxTokens || 4096,
      temperature: config.temperature || 0.7,
      useCrossRegionInference: config.useCrossRegionInference !== undefined ? config.useCrossRegionInference : (process.env.LLM_USE_CROSS_REGION !== 'false'), // Default true unless explicitly false
    };

    // Initialize Bedrock client - use default credential chain if credentials not provided
    const clientConfig = {
      region: this.config.region,
    };
    
    // Only specify credentials if both are provided, otherwise use default AWS credential chain
    if (this.config.accessKeyId && this.config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      };
    }
    
    this.client = new BedrockRuntimeClient(clientConfig);

    logger.info(`BedrockProvider initialized (region: ${this.config.region}, model: ${this.getModelId()}, crossRegion: ${this.config.useCrossRegionInference})`);
  }

  /**
   * Get model ID with cross-region inference profile prefix (like Cline)
   */
  getModelId() {
    const baseModel = this.config.model;
    
    // Check if model already has inference profile prefix
    // This includes both standard prefixes (us., eu., etc.) and gov cloud prefixes (us-gov., etc.)
    if (baseModel.match(/^(us|us-gov|eu|eu-west|apac|jp|global)\./)) {
      return baseModel; // Already has prefix, don't add another
    }
    
    if (!this.config.useCrossRegionInference) {
      return baseModel;
    }
    
    // Add region prefix for cross-region inference
    const region = this.config.region || 'us-east-1';
    
    // ⭐ PHASE_05 FIX: GovCloud doesn't support cross-region inference profiles for Claude 3.7
    if (region.startsWith('us-gov-')) {
      return baseModel;
    }
    
    const regionPrefix = region.slice(0, 3); // us-, eu-, ap-
    
    switch (regionPrefix) {
      case 'us-':
        return `us.${baseModel}`;
      case 'eu-':
        return `eu.${baseModel}`;
      case 'ap-':
        // Special case for Japan
        if (region.startsWith('ap-northeast-1')) {
          return `jp.${baseModel}`;
        }
        return `apac.${baseModel}`;
      default:
        logger.warn(`Unknown region prefix: ${regionPrefix}, using base model`);
        return baseModel;
    }
  }

  /**
   * @description Core entry point: sends a conversation to Claude on Bedrock and
   * returns the assistant's reply along with usage, cost, and latency metadata.
   * Centralizes the harness's hard-won operational policies — enforcing the
   * extended-thinking token/temperature constraints (unless a caller opts into a
   * cheaper "fast mode" for simple routing/JSON calls), applying ephemeral
   * prompt caching to the system prompt and tools, parsing the multi-block
   * thinking+text response, and transparently retrying throttling errors with
   * exponential backoff so transient rate limits don't surface as failures.
   * @param {Array<{role: string, content: string}>} messages - Conversation
   *   history; empty/whitespace-only messages are dropped before sending.
   * @param {Object} [options={}] - Per-call overrides.
   * @param {boolean} [options.disableExtendedThinking] - Enable fast mode
   *   (no extended thinking) for quick, low-latency calls.
   * @param {number} [options.maxTokens] - Override max output tokens.
   * @param {number} [options.temperature] - Override temperature (fast mode only).
   * @param {string} [options.systemPrompt] - System prompt sent with caching.
   * @param {Array<Object>} [options.tools] - Tool definitions sent with caching.
   * @returns {Promise<Object>} Resolves with { content, contentBlocks,
   *   stopReason, usage, cost, latency, model, provider }; rejects with an Error
   *   tagged isRateLimit/isTransient for upstream backoff decisions.
   */
  async generateResponse(messages, options = {}) {
    const maxRetries = 5;
    const baseDelay = 3000; // 3 seconds
    let lastError;
    let wasRateLimited = false;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Fast mode: disable extended thinking for quick routing/evaluation calls
        // Extended thinking adds 5-15s overhead — unnecessary for simple JSON responses
        const fastMode = options.disableExtendedThinking === true;
        
        let maxTokens, temperature;
        if (fastMode) {
          // Fast mode: use caller's maxTokens directly, allow caller's temperature
          maxTokens = options.maxTokens || this.config.maxTokens;
          temperature = options.temperature !== undefined ? options.temperature : this.config.temperature;
          logger.debug(`Bedrock FAST MODE: maxTokens=${maxTokens}, temp=${temperature}, no extended thinking`);
        } else {
          // Extended thinking requires max_tokens > thinking.budget_tokens
          // Using 10K thinking budget, so max_tokens must be at least 10001
          // ALWAYS enforce minimum of 12000 even if caller passes lower maxTokens
          maxTokens = Math.max(options.maxTokens || this.config.maxTokens, 12000);
          // Extended thinking requires temperature=1 (Claude constraint)
          temperature = 1.0;  // Must be 1 when thinking is enabled
        }

        // Format messages for Claude - filter out empty content
        const formattedMessages = messages
          .filter(msg => msg.content && msg.content.trim().length > 0)
          .map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content,
          }));
        
        // Validate we have at least one message
        if (formattedMessages.length === 0) {
          throw new Error('No valid messages with content to send to Bedrock');
        }

        // Prepare request body for Bedrock
        const requestBody = {
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: maxTokens,
          temperature: temperature,
          messages: formattedMessages,
        };

        // Only enable extended thinking when NOT in fast mode
        if (!fastMode) {
          // Enable extended thinking for Claude 3.7+ (maxes out internal reasoning)
          requestBody.thinking = {
            type: "enabled",
            budget_tokens: 10000  // Max thinking budget for deep reasoning
          };
        }

        // Add system prompt with prompt caching support
        if (options.systemPrompt) {
          requestBody.system = [
            {
              type: "text",
              text: options.systemPrompt,
              cache_control: { type: "ephemeral" }
            }
          ];
        }

        // Add tools with prompt caching support
        if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
          requestBody.tools = options.tools.map((tool, index) => {
            // Get schema and ensure it has required "type" field
            let schema = tool.inputSchema || tool.input_schema || {};
            
            // Ensure schema has type field (Bedrock requirement)
            if (!schema.type) {
              schema = {
                type: 'object',
                properties: schema.properties || {},
                required: schema.required || []
              };
            }
            
            const toolDef = {
              name: tool.name,
              description: tool.description || '',
              input_schema: schema
            };
            
            if (index === options.tools.length - 1) {
              toolDef.cache_control = { type: "ephemeral" };
            }
            
            return toolDef;
          });
          logger.debug(`Including ${requestBody.tools.length} tools in Bedrock request (with prompt caching)`);
        }

        const command = new InvokeModelCommand({
          modelId: this.getModelId(),
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(requestBody),
        });

        const startTime = Date.now();
        const response = await this.client.send(command);
        const latency = Date.now() - startTime;

        // Parse response
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));

        // DEBUG: Log response structure to diagnose extended thinking format
        logger.info(`DEBUG - Response has ${responseBody.content?.length || 0} content blocks`);
        if (responseBody.content && Array.isArray(responseBody.content)) {
          responseBody.content.forEach((block, i) => {
            logger.info(`DEBUG - Block ${i}: type="${block.type}", hasText=${!!block.text}, textLen=${block.text?.length || 0}, preview="${(block.text || '').substring(0, 80)}"`);
          });
        }

        // Extract content - with extended thinking, response has multiple blocks
        // Claude 3.7 with thinking returns: [{type: "thinking", text: "..."}, {type: "text", text: "..."}]
        // We want the "text" block, not the "thinking" block
        let content = '';
        if (responseBody.content && Array.isArray(responseBody.content)) {
          // Look for text block (type: "text")
          const textBlock = responseBody.content.find(block => block.type === 'text');
          if (textBlock) {
            content = textBlock.text || '';
            logger.info(`DEBUG - Extracted from text block: "${content.substring(0, 100)}"`);
          }
          // Fallback: check for thinking blocks (Claude Sonnet 4.5 extended thinking)
          // Thinking blocks use {type: "thinking", thinking: "..."} not {type: "text", text: "..."}
          if (!content && responseBody.content.length > 0) {
            // Try first block's text property
            content = responseBody.content[0]?.text || '';
            
            // If still empty, extract from thinking block as last resort
            if (!content) {
              const thinkingBlock = responseBody.content.find(block => block.type === 'thinking');
              if (thinkingBlock && thinkingBlock.thinking) {
                logger.info(`DEBUG - Extracting from thinking block (${thinkingBlock.thinking.length} chars) - model returned only thinking, no text block`);
                content = thinkingBlock.thinking;
              }
            }
            
            if (content) {
              logger.info(`DEBUG - Fallback extraction: "${content.substring(0, 100)}"`);
            }
          }
        }
        
        if (!content) {
          logger.warn(`DEBUG - NO CONTENT EXTRACTED! Response body: ${JSON.stringify(responseBody).substring(0, 500)}`);
        }
        
        const stopReason = responseBody.stop_reason;

        // Calculate tokens including cache metrics
        const usage = {
          inputTokens: responseBody.usage?.input_tokens || 0,
          outputTokens: responseBody.usage?.output_tokens || 0,
          totalTokens: (responseBody.usage?.input_tokens || 0) + (responseBody.usage?.output_tokens || 0),
          cacheCreationTokens: responseBody.usage?.cache_creation_input_tokens || 0,
          cacheReads: responseBody.usage?.cache_read_input_tokens || 0,
        };

        // Calculate cost with prompt caching pricing
        const inputCostPer1k = 0.003;
        const outputCostPer1k = 0.015;
        const cacheWriteCostPer1k = 0.00375;
        const cacheReadCostPer1k = 0.0003;
        
        const baseCost = (usage.inputTokens / 1000) * inputCostPer1k;
        const outputCost = (usage.outputTokens / 1000) * outputCostPer1k;
        const cacheWriteCost = (usage.cacheCreationTokens / 1000) * cacheWriteCostPer1k;
        const cacheReadCost = (usage.cacheReads / 1000) * cacheReadCostPer1k;
        const cost = baseCost + outputCost + cacheWriteCost + cacheReadCost;
        
        const cacheInfo = usage.cacheReads > 0 ? ` (cache: ${usage.cacheReads} tokens read)` : '';
        logger.info(`Bedrock API call: ${latency}ms, ${usage.totalTokens} tokens, $${cost.toFixed(4)}${cacheInfo}`);

        return {
          content,
          contentBlocks: responseBody.content || [],  // Return raw blocks for tool detection
          stopReason,
          usage,
          cost,
          latency,
          model: this.config.model,
          provider: 'bedrock',
        };
      } catch (error) {
        lastError = error;
        const isRateLimitError = error.message && (
          error.message.includes('Too many connections') ||
          error.message.includes('Too many tokens') ||
          error.message.includes('too many tokens') ||
          error.message.includes('ThrottlingException') ||
          error.message.includes('TooManyRequestsException') ||
          error.message.includes('please wait') ||
          error.message.includes('rate') ||
          error.name === 'ThrottlingException' ||
          error.name === 'TooManyRequestsException' ||
          error.$metadata?.httpStatusCode === 429
        );
        
        if (isRateLimitError) {
          wasRateLimited = true;
          if (attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt); // 3s, 6s, 12s, 24s, 48s
            logger.warn(`Bedrock rate limit hit (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        
        // If out of retries or non-rate-limit error, throw with classification
        if (attempt === maxRetries || !isRateLimitError) {
          logger.error(`Bedrock API error after ${attempt + 1} attempts: ${error.message}`);
          const wrappedError = new Error(`Bedrock API failed: ${error.message}`);
          wrappedError.isRateLimit = wasRateLimited || isRateLimitError;
          wrappedError.isTransient = isRateLimitError;
          throw wrappedError;
        }
      }
    }
    
    // Should never reach here, but just in case
    const fallbackError = new Error(`Bedrock API failed: ${lastError?.message || 'Unknown error'}`);
    fallbackError.isRateLimit = wasRateLimited;
    fallbackError.isTransient = wasRateLimited;
    throw fallbackError;
  }

  /**
   * @description Lightweight health check used to confirm credentials, region,
   * and model access are wired up correctly before relying on the provider for
   * real work. Issues a minimal completion and reports success/failure instead
   * of throwing, so callers can gracefully degrade.
   * @returns {Promise<boolean>} True if the test completion succeeded, false otherwise.
   */
  async testConnection() {
    try {
      const testMessages = [{ role: 'user', content: 'Hi' }];
      await this.generateResponse(testMessages, { maxTokens: 10 });
      return true;
    } catch (error) {
      logger.error(`Bedrock connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * @description Exposes the provider's resolved identity and limits so callers
   * (logging, UI, telemetry) can report which model/region is in use without
   * reaching into private config.
   * @returns {{provider: string, model: string, region: string, maxTokens: number}}
   *   Descriptor of the active provider configuration.
   */
  getModelInfo() {
    return {
      provider: 'bedrock',
      model: this.config.model,
      region: this.config.region,
      maxTokens: this.config.maxTokens,
    };
  }
}

module.exports = BedrockProvider;

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | OpenAI-COMPATIBLE: constructor honors config.baseUrl (drives any chat-completions gateway — a user's BYO endpoint, LiteLLM, LM Studio, Ollama, Groq, …); added generateResponse() matching the BedrockProvider/Cline contract so TaskController can drive a BYO-LLM connection with no special-casing.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bound OpenRouter reasoning to a low, non-disclosed budget for interactive completions, normalized multipart text, and fail explicitly when a gateway returns reasoning tokens without a final answer.
 */

/**
 * OpenAI Provider
 * Implements LLMService for OpenAI's GPT models
 */

const OpenAI = require('openai');
const LLMService = require('./LLMService');
const logger = require('../../utils/logger');

/**
 * @description Concrete LLMService implementation that adapts OpenAI's
 * Chat Completions API to the harness's provider-agnostic interface, so the
 * rest of the system can request completions, stream tokens, and invoke tools
 * without knowing which vendor is behind them. Normalizes OpenAI's response
 * and function-calling shapes into the common content/usage/cost contract.
 */
class OpenAIProvider extends LLMService {
  /**
   * @description Initializes the provider with caller-supplied credentials and
   * generation settings, validating the config and constructing the OpenAI
   * client up front so per-request setup stays cheap. Falls back to sensible
   * defaults when model/limits are omitted.
   * @param {Object} config - Provider configuration.
   * @param {string} config.apiKey - OpenAI API key used to authenticate requests.
   * @param {string} [config.model] - Model id to target; defaults to 'gpt-4-turbo-preview'.
   * @param {number} [config.maxTokens] - Max completion tokens; defaults to 4096.
   * @param {number} [config.temperature] - Sampling temperature; defaults to 0.7.
   */
  constructor(config) {
    super('openai', config);
    
    this.validateConfig();
    
    // baseUrl makes this provider OpenAI-COMPATIBLE rather than OpenAI-only: any
    // gateway that speaks the chat-completions API (a user's Bring-Your-Own-LLM
    // endpoint, LiteLLM, LM Studio, Ollama, Together, Groq, …) is driven by passing
    // its base URL here. Omit it and the SDK defaults to api.openai.com.
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.baseUrl = config.baseUrl || null;
    this.endpointLabel = safeEndpointLabel(this.baseUrl);

    this.model = config.model || 'gpt-4-turbo-preview';
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature !== undefined ? config.temperature : 0.7;
  }

  /**
   * @description Single-shot completion matching the BedrockProvider/ClineProvider
   * generateResponse() contract, so TaskController can drive an OpenAI-compatible
   * endpoint (incl. a per-user BYO-LLM connection) with no special-casing. Returns
   * the same { content, contentBlocks, stopReason, usage, cost, latency, model,
   * provider } shape the other providers return.
   * @param {Array<{role:string,content:string}>} messages - conversation turns
   * @param {Object} [options] - { systemPrompt, maxTokens, temperature }
   * @returns {Promise<Object>} the standard generateResponse result object
   */
  async generateResponse(messages, options = {}) {
    const startTime = Date.now();
    const formatted = (messages || [])
      .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    if (options.systemPrompt) formatted.unshift({ role: 'system', content: String(options.systemPrompt) });
    if (formatted.length === 0) throw new Error('No valid messages with content to send to the LLM endpoint');

    const request = {
      model: this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature !== undefined ? options.temperature : this.temperature,
      messages: formatted,
      // OpenRouter reasoning models can otherwise spend the provider's entire free-tier output
      // allowance on hidden reasoning and return an empty final message. Keep a bounded reasoning
      // budget while excluding chain-of-thought from the application response. OpenRouter documents
      // this unified request field for its OpenAI-compatible chat endpoint.
      ...(isOpenRouterBaseUrl(this.baseUrl) ? {
        reasoning: { effort: options.reasoningEffort || 'low', exclude: true },
      } : {}),
    };
    const completion = await this.client.chat.completions.create(request);

    const choice = completion.choices?.[0];
    const content = normalizeTextContent(choice?.message?.content);
    const stopReason = choice?.finish_reason || 'stop';
    const usage = {
      inputTokens: completion.usage?.prompt_tokens || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      totalTokens: completion.usage?.total_tokens
        || ((completion.usage?.prompt_tokens || 0) + (completion.usage?.completion_tokens || 0)),
      cacheCreationTokens: 0,
      cacheReads: 0,
    };
    // The BYO endpoint owns the user's billing; we report tokens but not a $cost we
    // cannot know (their per-token price is theirs, not ours). cost stays 0 here.
    const latency = Date.now() - startTime;
    logger.info(`OpenAI-compatible call (${this.model} @ ${this.endpointLabel}): ${latency}ms, ${usage.totalTokens} tokens`);

    if (!content) {
      const reasoning = choice?.message?.reasoning || choice?.message?.reasoning_content;
      logger.warn('OpenAI-compatible endpoint returned no final answer', {
        model: this.model,
        endpoint: this.endpointLabel,
        stopReason,
        outputTokens: usage.outputTokens,
        hadReasoning: Boolean(reasoning || choice?.message?.reasoning_details?.length),
      });
      const error = new Error('OpenAI-compatible endpoint returned no final answer');
      error.code = 'EMPTY_FINAL_ANSWER';
      throw error;
    }

    return {
      content,
      contentBlocks: content ? [{ type: 'text', text: content }] : [],
      stopReason,
      usage,
      cost: 0,
      latency,
      model: this.model,
      provider: this.baseUrl ? 'byo-llm' : 'openai',
    };
  }

  /**
   * Get provider name
   */
  get providerName() {
    return this.provider;
  }

  /**
   * Send request to GPT
   */
  async sendRequest(options) {
    const {
      messages,
      tools = [],
      stream = false,
      onChunk = null,
      systemPrompt = null,
    } = options;

    this.requestCount++;

    // Format messages for OpenAI
    const formattedMessages = this.formatMessagesForOpenAI(messages, systemPrompt);
    
    // Format tools for OpenAI (function calling)
    const formattedTools = tools.length > 0 ? this.formatFunctions(tools) : undefined;

    // Build request parameters
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: formattedMessages,
    };

    // Add tools if provided
    if (formattedTools) {
      params.tools = formattedTools;
      params.tool_choice = 'auto';
    }

    // Add streaming
    if (stream) {
      params.stream = true;
    }

    try {
      logger.info(`Sending request to OpenAI (${this.model})`);
      logger.debug(`Messages: ${formattedMessages.length}, Tools: ${formattedTools ? formattedTools.length : 0}`);

      if (stream) {
        return await this.handleStreaming(params, onChunk);
      } else {
        return await this.handleNonStreaming(params);
      }
    } catch (err) {
      logger.error(`OpenAI API error: ${err.message}`);
      throw new Error(`LLM request failed: ${err.message}`);
    }
  }

  /**
   * Handle non-streaming response
   */
  async handleNonStreaming(params) {
    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];

    // Extract content and function calls
    const content = [];
    
    if (choice.message.content) {
      content.push({
        type: 'text',
        text: choice.message.content,
      });
    }

    if (choice.message.tool_calls) {
      choice.message.tool_calls.forEach((toolCall) => {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments),
        });
      });
    }

    // Calculate cost
    const cost = this.calculateCost(
      response.usage.prompt_tokens,
      response.usage.completion_tokens
    );

    logger.info(`OpenAI response: ${response.usage.completion_tokens} tokens, $${cost.toFixed(6)}`);

    return {
      content,
      stopReason: choice.finish_reason,
      usage: {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        cacheWrites: 0, // OpenAI doesn't expose cache stats
        cacheReads: 0,
        cost,
      },
      model: response.model,
    };
  }

  /**
   * Handle streaming response
   */
  async handleStreaming(params, onChunk) {
    const stream = await this.client.chat.completions.create(params);

    let fullText = '';
    const toolCalls = new Map();
    let usage = null;
    let finishReason = null;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      
      if (!delta) continue;

      // Handle text content
      if (delta.content) {
        fullText += delta.content;
        if (onChunk) {
          onChunk(delta.content);
        }
      }

      // Handle tool calls
      if (delta.tool_calls) {
        delta.tool_calls.forEach((toolCall) => {
          const index = toolCall.index;
          
          if (!toolCalls.has(index)) {
            toolCalls.set(index, {
              id: toolCall.id || '',
              name: toolCall.function?.name || '',
              arguments: '',
            });
          }
          
          const existing = toolCalls.get(index);
          if (toolCall.id) existing.id = toolCall.id;
          if (toolCall.function?.name) existing.name = toolCall.function.name;
          if (toolCall.function?.arguments) existing.arguments += toolCall.function.arguments;
        });
      }

      // Capture finish reason
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }

      // Capture usage (if available - OpenAI may provide at end)
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    // Build content array
    const content = [];
    
    if (fullText) {
      content.push({
        type: 'text',
        text: fullText,
      });
    }

    // Add parsed tool calls
    for (const [_, toolCall] of toolCalls) {
      try {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: JSON.parse(toolCall.arguments),
        });
      } catch (err) {
        logger.error(`Failed to parse tool arguments: ${err.message}`);
      }
    }

    // Estimate usage if not provided (OpenAI streaming may not always include it)
    if (!usage) {
      const estimatedInput = Math.ceil(fullText.length / 4); // Rough estimate
      const estimatedOutput = Math.ceil(fullText.length / 4);
      usage = {
        prompt_tokens: estimatedInput,
        completion_tokens: estimatedOutput,
        total_tokens: estimatedInput + estimatedOutput,
      };
      logger.warn('OpenAI usage not provided in stream, using estimates');
    }

    const cost = this.calculateCost(usage.prompt_tokens, usage.completion_tokens);

    logger.info(`OpenAI streaming complete: ${usage.completion_tokens} tokens, $${cost.toFixed(6)}`);

    return {
      content,
      stopReason: finishReason || 'stop',
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        cacheWrites: 0,
        cacheReads: 0,
        cost,
      },
      model: this.model,
    };
  }

  /**
   * Format messages for OpenAI's format
   */
  formatMessagesForOpenAI(messages, systemPrompt = null) {
    const formatted = [];
    
    // Add system prompt if provided
    if (systemPrompt) {
      formatted.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    messages.forEach((msg) => {
      // Skip task messages (use as system prompt)
      if (msg.type === 'task') {
        return;
      }

      // Determine role
      let role = 'user';
      if (msg.say === 'say' && msg.type !== 'task') {
        role = msg.images || msg.files ? 'user' : 'assistant';
      }

      formatted.push({
        role,
        content: msg.text || '',
      });
    });

    return formatted;
  }

  /**
   * Format tools for OpenAI function calling
   */
  formatFunctions(tools) {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema || {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    }));
  }

  /**
   * Calculate cost for OpenAI models
   * Pricing as of Nov 2025
   */
  calculateCost(tokensIn, tokensOut) {
    // GPT-4 Turbo pricing (per million tokens)
    let inputPrice, outputPrice;
    
    if (this.model.includes('gpt-4')) {
      inputPrice = 10.0;
      outputPrice = 30.0;
    } else if (this.model.includes('gpt-3.5')) {
      inputPrice = 0.5;
      outputPrice = 1.5;
    } else {
      // Default to GPT-4 pricing
      inputPrice = 10.0;
      outputPrice = 30.0;
    }

    const inputCost = (tokensIn / 1000000) * inputPrice;
    const outputCost = (tokensOut / 1000000) * outputPrice;

    return inputCost + outputCost;
  }
}

/** @description True only for OpenRouter's hosted OpenAI-compatible API. */
function isOpenRouterBaseUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/** @description Normalizes string or multipart OpenAI-compatible final content without exposing reasoning. */
function normalizeTextContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' || part.type === 'output_text') return String(part.text || part.content || '');
      return '';
    })
    .join('')
    .trim();
}

/** @description Privacy-safe endpoint label for logs; strips path, query, and user-info. */
function safeEndpointLabel(baseUrl) {
  if (!baseUrl) return 'api.openai.com';
  try { return new URL(baseUrl).hostname.toLowerCase() || 'compatible-endpoint'; }
  catch { return 'compatible-endpoint'; }
}

module.exports = OpenAIProvider;

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Anthropic Provider
 * Implements LLMService for Anthropic's Claude models
 */

const Anthropic = require('@anthropic-ai/sdk');
const LLMService = require('./LLMService');
const logger = require('../../utils/logger');

/**
 * @description Concrete {@link LLMService} implementation that adapts the
 * application's provider-agnostic LLM contract to the Anthropic Claude
 * Messages API. It exists so the rest of the system can drive Claude through
 * the same interface as other providers, while this class owns the
 * Anthropic-specific concerns: request shaping, message/role normalization to
 * satisfy Anthropic's alternation requirements, streaming event handling, and
 * token-usage cost accounting.
 * @extends LLMService
 */
class AnthropicProvider extends LLMService {
  /**
   * @description Initializes the provider, validates required configuration,
   * and constructs the underlying Anthropic SDK client. Defaults are applied
   * for model, token ceiling, and temperature so callers can supply only an
   * API key and still get a working provider.
   * @param {object} config - Provider configuration.
   * @param {string} config.apiKey - Anthropic API key used to authenticate SDK calls.
   * @param {string} [config.model] - Claude model id; defaults to claude-3-5-sonnet-20241022.
   * @param {number} [config.maxTokens] - Maximum tokens to generate per response; defaults to 4096.
   * @param {number} [config.temperature] - Sampling temperature; defaults to 0.7 when not provided.
   */
  constructor(config) {
    super('anthropic', config);
    
    this.validateConfig();
    
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });

    this.model = config.model || 'claude-3-5-sonnet-20241022';
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature !== undefined ? config.temperature : 0.7;
  }

  /**
   * Send request to Claude
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

    // Format messages for Anthropic
    const formattedMessages = this.formatMessagesForAnthropic(messages);
    
    // Format tools for Anthropic
    const formattedTools = tools.length > 0 ? this.formatTools(tools) : undefined;

    // Build request parameters
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: formattedMessages,
    };

    // Add system prompt if provided
    if (systemPrompt) {
      params.system = systemPrompt;
    }

    // Add tools if provided
    if (formattedTools) {
      params.tools = formattedTools;
    }

    // Add streaming
    if (stream) {
      params.stream = true;
    }

    try {
      logger.info(`Sending request to Claude (${this.model})`);
      logger.debug(`Messages: ${formattedMessages.length}, Tools: ${formattedTools ? formattedTools.length : 0}`);

      if (stream) {
        return await this.handleStreaming(params, onChunk);
      } else {
        return await this.handleNonStreaming(params);
      }
    } catch (err) {
      logger.error(`Anthropic API error: ${err.message}`);
      throw new Error(`LLM request failed: ${err.message}`);
    }
  }

  /**
   * Handle non-streaming response
   */
  async handleNonStreaming(params) {
    const response = await this.client.messages.create(params);

    // Calculate cost
    const cost = this.calculateCost(
      response.usage.input_tokens,
      response.usage.output_tokens,
      response.usage.cache_creation_input_tokens || 0,
      response.usage.cache_read_input_tokens || 0
    );

    logger.info(`Claude response: ${response.usage.output_tokens} tokens, $${cost.toFixed(6)}`);

    return {
      content: response.content,
      stopReason: response.stop_reason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheWrites: response.usage.cache_creation_input_tokens || 0,
        cacheReads: response.usage.cache_read_input_tokens || 0,
        cost,
      },
      model: response.model,
    };
  }

  /**
   * Handle streaming response
   */
  async handleStreaming(params, onChunk) {
    const stream = await this.client.messages.create(params);

    let fullText = '';
    let currentToolUse = null;
    const toolCalls = [];
    let usage = null;

    for await (const event of stream) {
      if (event.type === 'message_start') {
        usage = event.message.usage;
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          currentToolUse = {
            id: event.content_block.id,
            name: event.content_block.name,
            input: '',
          };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          const text = event.delta.text;
          fullText += text;
          if (onChunk) {
            onChunk(text);
          }
        } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
          currentToolUse.input += event.delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolUse) {
          try {
            currentToolUse.input = JSON.parse(currentToolUse.input);
            toolCalls.push(currentToolUse);
          } catch (err) {
            logger.error(`Failed to parse tool input: ${err.message}`);
          }
          currentToolUse = null;
        }
      } else if (event.type === 'message_delta') {
        if (event.usage) {
          usage = {
            ...usage,
            output_tokens: event.usage.output_tokens,
          };
        }
      }
    }

    // Calculate cost
    const cost = this.calculateCost(
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_creation_input_tokens || 0,
      usage.cache_read_input_tokens || 0
    );

    logger.info(`Claude streaming complete: ${usage.output_tokens} tokens, $${cost.toFixed(6)}`);

    return {
      content: [
        ...(fullText ? [{ type: 'text', text: fullText }] : []),
        ...toolCalls.map((tool) => ({
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: tool.input,
        })),
      ],
      stopReason: 'end_turn',
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheWrites: usage.cache_creation_input_tokens || 0,
        cacheReads: usage.cache_read_input_tokens || 0,
        cost,
      },
      model: this.model,
    };
  }

  /**
   * Format messages for Anthropic's format
   */
  formatMessagesForAnthropic(messages) {
    const formatted = [];
    
    messages.forEach((msg) => {
      // Skip task messages in conversation (use as system prompt instead)
      if (msg.type === 'task') {
        return;
      }

      // Determine role - Anthropic uses 'user' and 'assistant'
      let role = 'user';
      if (msg.say === 'say' && msg.type !== 'task') {
        // Need to infer from context - for now, assume user messages have images/files
        role = msg.images || msg.files ? 'user' : 'assistant';
      }

      formatted.push({
        role,
        content: msg.text || '',
      });
    });

    // Ensure alternating roles (Anthropic requirement)
    return this.ensureAlternatingRoles(formatted);
  }

  /**
   * Ensure roles alternate between user and assistant
   * Anthropic requires this
   */
  ensureAlternatingRoles(messages) {
    const result = [];
    let lastRole = null;

    messages.forEach((msg) => {
      if (msg.role === lastRole) {
        // Same role as previous - merge into last message
        if (result.length > 0) {
          result[result.length - 1].content += '\n' + msg.content;
        } else {
          result.push(msg);
        }
      } else {
        result.push(msg);
        lastRole = msg.role;
      }
    });

    // Ensure first message is from user
    if (result.length > 0 && result[0].role !== 'user') {
      result.unshift({
        role: 'user',
        content: 'Begin task',
      });
    }

    return result;
  }

  /**
   * Calculate cost for Claude models
   * Pricing as of Nov 2025
   */
  calculateCost(tokensIn, tokensOut, cacheWrites = 0, cacheReads = 0) {
    // Claude 3.5 Sonnet pricing (per million tokens)
    const inputPrice = 3.0;
    const outputPrice = 15.0;
    const cacheWritePrice = 3.75;
    const cacheReadPrice = 0.30;

    const inputCost = (tokensIn / 1000000) * inputPrice;
    const outputCost = (tokensOut / 1000000) * outputPrice;
    const cacheCost = (cacheWrites / 1000000) * cacheWritePrice;
    const cacheReadCost = (cacheReads / 1000000) * cacheReadPrice;

    return inputCost + outputCost + cacheCost + cacheReadCost;
  }
}

module.exports = AnthropicProvider;

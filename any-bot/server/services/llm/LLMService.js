/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * LLM Service Base Class
 * Abstract base for all LLM providers
 */

const logger = require('../../utils/logger');
const { createApiRequestStartedMessage, createApiRequestFinishedMessage } = require('../../utils/messageTypes');

/**
 * @description Abstract base class that defines the common contract every
 * concrete LLM provider must satisfy. It centralizes provider-agnostic
 * concerns -- message/tool formatting, cost accounting, configuration
 * validation, request bookkeeping, and connection testing -- so that
 * individual providers only need to implement the actual transport
 * (`sendRequest`) and override pricing where it differs from the defaults.
 */
class LLMService {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.requestCount = 0;
  }

  /**
   * Send a request to the LLM
   * @param {Object} options - Request options
   * @param {Array} options.messages - Conversation messages
   * @param {Array} options.tools - Available tools
   * @param {boolean} options.stream - Enable streaming
   * @param {Function} options.onChunk - Streaming callback
   * @returns {Promise} Response from LLM
   */
  async sendRequest(options) {
    throw new Error('sendRequest must be implemented by provider');
  }

  /**
   * Format messages for the LLM provider
   * @param {Array} messages - Message array
   * @returns {Array} Formatted messages
   */
  formatMessages(messages) {
    return messages.map((msg) => ({
      role: this.getRole(msg.type),
      content: msg.text || '',
    }));
  }

  /**
   * Get role from message type
   */
  getRole(messageType) {
    if (messageType === 'task' || messageType === 'say') {
      return 'user'; // Simplified - both user and assistant use 'say'
    }
    return 'assistant';
  }

  /**
   * Format tools for the LLM provider
   * @param {Array} tools - Tool definitions
   * @returns {Array} Formatted tools
   */
  formatTools(tools) {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.inputSchema || {
        type: 'object',
        properties: {},
      },
    }));
  }

  /**
   * Create API tracking messages
   */
  createApiMessages(model, tokensIn, tokensOut, cost, cacheWrites = 0, cacheReads = 0) {
    return {
      started: createApiRequestStartedMessage(model, tokensIn),
      finished: createApiRequestFinishedMessage(model, tokensIn, tokensOut, cost, cacheWrites, cacheReads),
    };
  }

  /**
   * Calculate cost based on tokens
   * Override in provider for accurate pricing
   */
  calculateCost(tokensIn, tokensOut, cacheWrites = 0, cacheReads = 0) {
    // Default pricing (override in provider)
    const inputCost = (tokensIn / 1000000) * 3.0;
    const outputCost = (tokensOut / 1000000) * 15.0;
    const cacheCost = (cacheWrites / 1000000) * 3.75;
    const cacheReadCost = (cacheReads / 1000000) * 0.30;

    return inputCost + outputCost + cacheCost + cacheReadCost;
  }

  /**
   * Get provider name
   */
  getProviderName() {
    return this.provider;
  }

  /**
   * Get model name
   */
  getModelName() {
    return this.config.model || 'unknown';
  }

  /**
   * Validate configuration
   */
  validateConfig() {
    if (!this.config.apiKey) {
      throw new Error('API key is required');
    }
    if (!this.config.model) {
      throw new Error('Model is required');
    }
    return true;
  }

  /**
   * Test connection to LLM provider
   */
  async testConnection() {
    try {
      const response = await this.sendRequest({
        messages: [{ type: 'say', text: 'Test connection' }],
        tools: [],
        stream: false,
      });

      return {
        success: true,
        provider: this.provider,
        model: this.config.model,
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
      };
    }
  }
}

module.exports = LLMService;

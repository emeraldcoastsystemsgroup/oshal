/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Prompt Manager
 * Manages system prompts, tool descriptions, and conversation history formatting
 */

const logger = require('../../utils/logger');
const { getClineSystemPrompt } = require('./ClineSystemPrompt');

/**
 * @description Central assembler for the LLM request payload. It exists to keep
 * prompt construction logic in one place so callers do not hand-build system
 * prompts, tool schemas, and conversation history independently (which would
 * drift). It composes the Cline base system prompt with optional custom
 * instructions and tool descriptions, normalizes raw message objects into
 * role/content pairs, and trims history to stay within a token budget so
 * requests do not overflow the model context window.
 * @param {Object} [config={}] Optional overrides for prompt-building behavior.
 * @param {number} [config.maxConversationTokens] Token ceiling used when
 *   optimizing conversation history; defaults to 100000.
 * @param {string|null} [config.systemPromptTemplate] Reserved system prompt
 *   template override; null means use the default Cline prompt.
 * @param {boolean} [config.includeToolDescriptions] When not explicitly false,
 *   tool descriptions are appended to the system prompt by default.
 */
class PromptManager {
  constructor(config = {}) {
    this.config = {
      maxConversationTokens: config.maxConversationTokens || 100000,
      systemPromptTemplate: config.systemPromptTemplate || null,
      includeToolDescriptions: config.includeToolDescriptions !== false,
    };
  }

  /**
   * Get system prompt with task context
   */
  getSystemPrompt(options = {}) {
    const {
      includeToolDescriptions = this.config.includeToolDescriptions,
      tools = [],
      customInstructions = null,
      taskDescription = '',
      taskId = '',
      currentDateTime = new Date().toISOString(),
    } = options;

    // Use ClineSystemPrompt module with task context
    let prompt = getClineSystemPrompt(taskDescription, taskId, currentDateTime);

    // Add custom instructions if provided
    if (customInstructions) {
      prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
    }

    // Add tool descriptions if requested
    if (includeToolDescriptions && tools.length > 0) {
      prompt += '\n\n' + this.formatToolDescriptions(tools);
    }

    return prompt;
  }

  /**
   * Format tool descriptions for prompt
   */
  formatToolDescriptions(tools) {
    if (!tools || tools.length === 0) {
      return '';
    }

    const descriptions = tools.map((tool) => {
      const params = tool.inputSchema?.properties || {};
      const required = tool.inputSchema?.required || [];
      
      const paramsList = Object.entries(params).map(([name, schema]) => {
        const isRequired = required.includes(name);
        return `  - ${name}${isRequired ? ' (required)' : ''}: ${schema.description || 'No description'}`;
      }).join('\n');

      return `## ${tool.name}
${tool.description || 'No description available'}

Parameters:
${paramsList || '  No parameters'}`;
    }).join('\n\n');

    return `AVAILABLE TOOLS:\n\n${descriptions}`;
  }

  /**
   * Format conversation history for prompt
   */
  formatConversationHistory(messages) {
    if (!messages || messages.length === 0) {
      return [];
    }

    const formatted = [];

    messages.forEach((msg) => {
      // Determine role
      let role = 'user';
      let content = msg.text || '';

      if (msg.type === 'say') {
        // Infer role from context
        role = msg.images || msg.files ? 'user' : 'assistant';
      } else if (msg.type === 'task') {
        role = 'user';
        content = `Task: ${content}`;
      } else if (msg.type === 'tool_result') {
        role = 'user'; // Tool results come back as user messages
        content = `Tool result: ${content}`;
      }

      formatted.push({
        role,
        content: content.trim(),
      });
    });

    return formatted;
  }

  /**
   * Optimize conversation history to fit token budget
   */
  optimizeHistory(messages, maxTokens = null) {
    const limit = maxTokens || this.config.maxConversationTokens;
    
    if (!messages || messages.length === 0) {
      return [];
    }

    // Estimate tokens (rough: 1 token ≈ 4 characters)
    let estimatedTokens = 0;
    const optimized = [];

    // Keep recent messages, remove older ones if over budget
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgText = msg.text || '';
      const msgTokens = Math.ceil(msgText.length / 4);

      if (estimatedTokens + msgTokens > limit) {
        // Budget exceeded - add summary of older messages if needed
        if (i > 0) {
          optimized.unshift({
            role: 'user',
            content: `[${i + 1} earlier messages omitted to save tokens]`,
          });
        }
        break;
      }

      estimatedTokens += msgTokens;
      optimized.unshift(msg);
    }

    return optimized;
  }

  /**
   * Build complete prompt with system + history + tools
   */
  buildCompletePrompt(options = {}) {
    const {
      messages = [],
      tools = [],
      customInstructions = null,
      optimizeTokens = true,
    } = options;

    // Get system prompt
    const systemPrompt = this.getSystemPrompt({
      includeToolDescriptions: true,
      tools,
      customInstructions,
    });

    // Format and optimize conversation history
    let conversationHistory = this.formatConversationHistory(messages);
    
    if (optimizeTokens) {
      conversationHistory = this.optimizeHistory(conversationHistory);
    }

    return {
      systemPrompt,
      messages: conversationHistory,
      tools,
    };
  }

  /**
   * Create prompt for tool execution
   */
  createToolExecutionPrompt(toolName, input, context = '') {
    return `Execute tool: ${toolName}

Input:
${JSON.stringify(input, null, 2)}

${context ? `Context: ${context}` : ''}`;
  }

  /**
   * Create prompt for task completion
   */
  createCompletionPrompt(taskText, result) {
    return `Task: ${taskText}

Result: ${result}

Please confirm the task has been completed successfully.`;
  }

  /**
   * Update system prompt
   */
  setSystemPrompt(prompt) {
    this.systemPrompt = prompt;
    logger.info('System prompt updated');
  }

  /**
   * Get prompt statistics
   */
  getPromptStats(prompt) {
    const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    const characters = text.length;
    const estimatedTokens = Math.ceil(characters / 4);
    const lines = text.split('\n').length;

    return {
      characters,
      estimatedTokens,
      lines,
      size: `${(characters / 1024).toFixed(2)} KB`,
    };
  }
}

module.exports = PromptManager;

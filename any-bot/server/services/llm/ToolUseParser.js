/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Tool Use Parser
 * Parses tool use from Claude's XML-formatted responses
 */

const logger = require('../../utils/logger');

/**
 * @description Stateless utility for interpreting an LLM's XML-style tool-call
 * convention. The model is prompted to emit tool invocations as XML tags (e.g.
 * <execute_command>...</execute_command>) rather than relying on a native
 * function-calling API, so this class centralizes detecting, extracting, and
 * stripping those tags. Exposed as static helpers because parsing is pure text
 * transformation with no per-instance state, keeping callers free of bookkeeping.
 */
class ToolUseParser {
  /**
   * Parse tool use from response text
   * Looks for XML-style tool tags like <execute_command>...</execute_command>
   */
  static parseToolUse(responseText) {
    if (!responseText || typeof responseText !== 'string') {
      return null;
    }

    // Try to extract tool use from XML tags (allow hyphens in tool names)
    const toolPattern = /<([\w-]+)>([\s\S]*?)<\/\1>/g;
    const matches = Array.from(responseText.matchAll(toolPattern));

    if (matches.length === 0) {
      return null;
    }

    // Get the first tool (only one tool per turn)
    const [fullMatch, toolName, innerContent] = matches[0];

    // Extract parameters from the inner content
    const parameters = this.extractParameters(innerContent);

    logger.info(`Parsed tool use: ${toolName} with ${Object.keys(parameters).length} parameters`);

    return {
      type: 'tool_use',
      id: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: toolName,
      input: parameters,
      rawMatch: fullMatch,
    };
  }

  /**
   * Extract parameters from XML content
   */
  static extractParameters(content) {
    const parameters = {};
    const paramPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
    const matches = Array.from(content.matchAll(paramPattern));

    for (const [, paramName, paramValue] of matches) {
      // Clean up the parameter value
      let cleanValue = paramValue.trim();
      
      // Try to parse boolean values
      if (cleanValue === 'true') {
        parameters[paramName] = true;
      } else if (cleanValue === 'false') {
        parameters[paramName] = false;
      } else if (!isNaN(cleanValue) && cleanValue !== '') {
        // Try to parse numbers
        parameters[paramName] = Number(cleanValue);
      } else {
        parameters[paramName] = cleanValue;
      }
    }

    return parameters;
  }

  /**
   * Check if response contains tool use
   */
  static hasToolUse(responseText) {
    if (!responseText || typeof responseText !== 'string') {
      return false;
    }

    // Check for ANY XML-style tag (including MCP tools with hyphens)
    const toolPattern = /<([\w-]+)>/;
    return toolPattern.test(responseText);
  }

  /**
   * Extract thinking/reasoning text (before tool use)
   */
  static extractThinking(responseText) {
    if (!responseText || typeof responseText !== 'string') {
      return '';
    }

    // Extract text before the first tool tag (allow hyphens)
    const toolPattern = /<([\w-]+)>/;
    const match = responseText.match(toolPattern);

    if (!match) {
      return responseText.trim();
    }

    const thinkingText = responseText.substring(0, match.index).trim();
    return thinkingText;
  }

  /**
   * Remove tool use from response text (to get clean text response)
   */
  static removeToolUse(responseText) {
    if (!responseText || typeof responseText !== 'string') {
      return responseText;
    }

    // Remove tool XML tags (allow hyphens)
    const toolPattern = /<([\w-]+)>[\s\S]*?<\/\1>/g;
    return responseText.replace(toolPattern, '').trim();
  }
}

module.exports = ToolUseParser;

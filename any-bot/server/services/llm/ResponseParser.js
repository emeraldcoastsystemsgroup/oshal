/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Response Parser
 * Parses LLM responses and extracts structured content
 */

const logger = require('../../utils/logger');

/**
 * @description Stateless utility for turning raw LLM API responses into the
 * shapes the rest of the application consumes. Centralizing the content-block
 * walking, thinking-block extraction, and JSON recovery here keeps callers from
 * re-implementing brittle parsing logic and gives one place to harden against
 * malformed or partial provider responses. All members are static because the
 * parser holds no state and is meant to be used as a namespaced helper.
 */
class ResponseParser {
  /**
   * Parse LLM response content
   */
  static parseResponse(response) {
    if (!response || !response.content) {
      return { text: '', toolCalls: [], thinking: null };
    }

    let text = '';
    const toolCalls = [];
    let thinking = null;

    response.content.forEach((block) => {
      if (block.type === 'text') {
        // Check for thinking blocks
        const thinkingMatch = block.text.match(/<thinking>([\s\S]*?)<\/thinking>/);
        if (thinkingMatch) {
          thinking = thinkingMatch[1].trim();
          // Remove thinking from main text
          text += block.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
        } else {
          text += block.text;
        }
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    });

    return {
      text: text.trim(),
      toolCalls,
      thinking,
    };
  }

  /**
   * Extract tool calls from content
   */
  static extractToolCalls(content) {
    if (!content || !Array.isArray(content)) {
      return [];
    }

    return content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: block.input,
      }));
  }

  /**
   * Extract text content only
   */
  static extractText(content) {
    if (!content || !Array.isArray(content)) {
      return '';
    }

    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  /**
   * Validate response structure
   */
  static validateResponse(response) {
    const errors = [];

    if (!response) {
      errors.push('Response is null or undefined');
      return { valid: false, errors };
    }

    if (!response.content) {
      errors.push('Response missing content field');
    }

    if (!response.usage) {
      errors.push('Response missing usage field');
    }

    if (response.content && !Array.isArray(response.content)) {
      errors.push('Content must be an array');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Parse thinking blocks from text
   */
  static parseThinking(text) {
    if (!text || typeof text !== 'string') {
      return null;
    }

    const matches = text.match(/<thinking>([\s\S]*?)<\/thinking>/g);
    if (!matches) {
      return null;
    }

    return matches.map((match) => {
      return match.replace(/<\/?thinking>/g, '').trim();
    });
  }

  /**
   * Remove thinking blocks from text
   */
  static removeThinking(text) {
    if (!text || typeof text !== 'string') {
      return text;
    }

    return text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
  }

  /**
   * Parse structured output (JSON)
   */
  static parseStructuredOutput(text) {
    if (!text || typeof text !== 'string') {
      return null;
    }

    // Try to find JSON in code blocks
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (err) {
        logger.warn('Failed to parse JSON from code block');
      }
    }

    // Try to parse entire text as JSON
    try {
      return JSON.parse(text);
    } catch (err) {
      return null;
    }
  }
}

module.exports = ResponseParser;

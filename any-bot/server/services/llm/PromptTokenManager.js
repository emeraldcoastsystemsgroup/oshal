/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PromptTokenManager — Minimal Safety Net for Bedrock 200K Token Limit
 *
 * Issue #011: PM Bot Prompt Token Overflow
 * 
 * This is a SAFETY NET only — not a budget system.
 * If conversation history somehow exceeds safe limits, truncate oldest messages.
 * The bot's persona already knows where to find context (DEVELOPER_HANDOVER.md, etc.)
 * 
 * Created: 2026-02-24 — PHASE_11 Issue #011
 */

const logger = require('../../utils/logger');

const BEDROCK_MAX_TOKENS = 200000;
const SAFE_HISTORY_LIMIT = 120000; // Leave ~80K for system prompt + tools + response

/**
 * @description Static safety-net utility that guards against exceeding the
 * Bedrock 200K context window. It is intentionally a last-resort guardrail
 * rather than a budgeting system: it estimates token usage with a cheap
 * heuristic and, only when conversation history would overflow the safe limit,
 * drops the oldest messages so a request can still succeed instead of being
 * rejected by the model. The exposed BEDROCK_MAX_TOKENS / SAFE_HISTORY_LIMIT
 * constants document the headroom reserved for the system prompt, tools, and
 * the model's response.
 */
class PromptTokenManager {
  /**
   * Rough token estimate (~4 chars per token)
   */
  static estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.8);
  }

  /**
   * Estimate tokens for a messages array
   */
  static estimateMessagesTokens(messages) {
    if (!messages || messages.length === 0) return 0;
    return messages.reduce((total, msg) => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      return total + PromptTokenManager.estimateTokens(content) + 4;
    }, 0);
  }

  /**
   * Safety net: if history exceeds limit, keep only the most recent messages.
   * Returns the original array if within limits.
   */
  static safetyTruncate(messages, maxTokens = SAFE_HISTORY_LIMIT) {
    if (!messages || messages.length === 0) return messages;

    const totalTokens = PromptTokenManager.estimateMessagesTokens(messages);
    if (totalTokens <= maxTokens) return messages;

    logger.warn(`[PromptTokenManager] SAFETY NET: History ${totalTokens} tokens > ${maxTokens} limit — truncating`);

    // Keep most recent messages that fit
    const result = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = typeof messages[i].content === 'string' ? messages[i].content : JSON.stringify(messages[i].content || '');
      const tokens = PromptTokenManager.estimateTokens(content) + 4;
      if (used + tokens > maxTokens) break;
      result.unshift(messages[i]);
      used += tokens;
    }

    const dropped = messages.length - result.length;
    logger.warn(`[PromptTokenManager] Kept ${result.length} messages (~${used} tokens), dropped ${dropped} oldest`);
    return result;
  }
}

PromptTokenManager.BEDROCK_MAX_TOKENS = BEDROCK_MAX_TOKENS;
PromptTokenManager.SAFE_HISTORY_LIMIT = SAFE_HISTORY_LIMIT;

module.exports = PromptTokenManager;

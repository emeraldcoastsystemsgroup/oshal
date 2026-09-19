/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: add bounded JSON fencing for tool/prior-agent data and exact allowlist checks for swarm-dispatched tools.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The allowlist primitive failed OPEN and its own docstring described the hole word for word: normalizeAllowedTools returned null for any non-array and isDispatchToolAllowed read null as unrestricted, so an omitted or malformed field granted every advertised tool. SEC-05 closed the HTTP carrier (requireDispatchAuthorityList, two call sites), not the primitive beneath it, and the sibling scope primitive already denied a malformed value - so the pair disagreed on the same input. Now absence is never authority: a non-array yields the empty set, and the predicate requires an actual Set plus an exact member. Latent rather than live when fixed - no reachable path obtained an unrestricted set, because the three field-omitting callers live in the legacy Express app that bot-entrypoint.sh refuses with exit 78, and the live bot-node caller passes explicit arrays - so this is defence in depth, not an open hole being closed.
 */

const DEFAULT_MAX_CONTENT_CHARS = 24000;
const MAX_SOURCE_CHARS = 128;

/**
 * @description Serializes untrusted runtime data without allowing tag or JSON breakout.
 * @param {string} source - Server-selected content origin label.
 * @param {unknown} value - Untrusted tool, page, or prior-agent content.
 * @param {number} [maxChars] - Maximum serialized content characters retained.
 * @returns {string} A bounded data-only prompt record.
 */
function wrapUntrustedContent(source, value, maxChars = DEFAULT_MAX_CONTENT_CHARS) {
  const serialized = serializeContent(value);
  const boundedMax = Number.isInteger(maxChars) && maxChars > 0
    ? Math.min(maxChars, DEFAULT_MAX_CONTENT_CHARS)
    : DEFAULT_MAX_CONTENT_CHARS;
  const record = {
    source: normalizeSource(source),
    content: serialized.slice(0, boundedMax),
    truncated: serialized.length > boundedMax,
  };
  return `<UNTRUSTED_CONTENT>${safePromptJson(record)}</UNTRUSTED_CONTENT>`;
}

/**
 * @description Converts a server allowlist to an exact set, failing CLOSED on anything that is not
 * an array. Absence is not authority: a caller that omits the field, or supplies a malformed one,
 * gets the empty set and therefore no tools. Authority is granted by an explicit list only.
 *
 * This used to return null for a non-array, and {@link isDispatchToolAllowed} read null as
 * "unrestricted" - so an omitted field granted every advertised tool. SEC-05 closed the HTTP
 * carrier (`requireDispatchAuthorityList`) but not the primitive underneath it. The scope
 * primitive already failed closed on a malformed value, so the two also disagreed.
 * @param {unknown} value - Request-scoped allowed tool names.
 * @returns {Set<string>} Exact allowlist; empty denies every tool, including completion.
 */
function normalizeAllowedTools(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((name) =>
    typeof name === 'string'
      && name.length > 0
      && name.length <= 256
      && !/[\u0000-\u001f\u007f]/.test(name)));
}

/**
 * @description Enforces a server-derived tool allowlist without case or whitespace aliases.
 * There is no unrestricted value: a missing or non-Set allowlist denies, so a caller cannot
 * obtain authority by failing to supply one.
 * @param {Set<string>|null} allowedTools - Normalized request allowlist.
 * @param {unknown} toolName - Model-requested tool name.
 * @returns {boolean} True only when the name is exactly allowlisted.
 */
function isDispatchToolAllowed(allowedTools, toolName) {
  return allowedTools instanceof Set
    && typeof toolName === 'string'
    && allowedTools.has(toolName);
}

/**
 * @description Converts persisted conversation records into bounded data-only context. Callers
 * exclude the current request so its server containment and final authority binding stay intact.
 * @param {unknown} messages - Persisted task messages.
 * @param {number} [limit] - Maximum recent records retained.
 * @returns {Array<{role: string, content: string}>} Provider conversation records.
 */
function containPriorMessages(messages, limit = 10) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(message => message && message.type === 'say' && typeof message.text === 'string')
    .slice(-Math.max(0, Math.min(Number(limit) || 10, 20)))
    .map(message => ({
      role: 'user',
      content: wrapUntrustedContent(
        message.say === 'say' ? 'prior-user-message' : 'prior-agent-output',
        message.text,
      ),
    }));
}

function serializeContent(value) {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : String(value ?? '');
  } catch {
    return '[unserializable untrusted content]';
  }
}

function normalizeSource(value) {
  const source = String(value ?? 'runtime-data')
    .replace(/[\u0000-\u001f\u007f]/g, '-')
    .slice(0, MAX_SOURCE_CHARS);
  return source || 'runtime-data';
}

function safePromptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

module.exports = {
  containPriorMessages,
  isDispatchToolAllowed,
  normalizeAllowedTools,
  wrapUntrustedContent,
};

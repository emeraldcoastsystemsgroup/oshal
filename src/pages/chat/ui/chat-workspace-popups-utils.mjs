/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted shared utility helpers for workspace popup flows
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Rebound embedded cockpit chat requests to the cockpit-selected bot so native chat config/history/tool surfaces follow the active target bot
 */

const DEFAULT_CHAT_AGENT_ID = '00000000-0000-4000-8000-000000000032';

/**
 * @description Executes a JSON HTTP request with standard credentials and error handling.
 * @param {string} url Request URL.
 * @param {RequestInit & { headers?: Record<string, string> }} options Fetch options.
 * @returns {Promise<any>} Parsed JSON payload.
 */
export function requestJson(url, options = {}) {
  const resolvedUrl = rewriteEmbeddedCockpitUrl(url);
  return fetch(resolvedUrl, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  }).then(async (response) => {
    let payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      console.warn('[chat-workspace-popups] JSON parse failed', { url: resolvedUrl, status: response.status });
      payload = null;
    }

    if (!response.ok) {
      const errorText = payload?.error || payload?.message || `${response.status} ${response.statusText}`;
      throw new Error(errorText);
    }

    return payload;
  });
}

/**
 * @description Rebind default chat-agent API URLs to the cockpit-selected bot when
 * the native `/chat` workspace is running inside the cockpit right rail.
 * @param {string} url Candidate request URL.
 * @returns {string} Rewritten URL when cockpit-selected bot context is active.
 */
function rewriteEmbeddedCockpitUrl(url) {
  const selectedAgentId = getEmbeddedCockpitAgentId();
  if (!selectedAgentId || selectedAgentId === DEFAULT_CHAT_AGENT_ID) {
    return url;
  }

  let rewrittenUrl = url.replace(
    `/api/agents/${DEFAULT_CHAT_AGENT_ID}/`,
    `/api/agents/${encodeURIComponent(selectedAgentId)}/`,
  );

  rewrittenUrl = rewrittenUrl.replace(
    `agentId=${encodeURIComponent(DEFAULT_CHAT_AGENT_ID)}`,
    `agentId=${encodeURIComponent(selectedAgentId)}`,
  );

  return rewrittenUrl;
}

/**
 * @description Resolve the cockpit-selected bot id from embed-mode DOM/global state.
 * @returns {string} Selected cockpit bot id or the default chat agent id when embed mode is inactive.
 */
function getEmbeddedCockpitAgentId() {
  const rootValue = readString(document.documentElement?.dataset?.cockpitAgentId);
  if (rootValue) {
    return rootValue;
  }

  const globalValue = readString(window.__oshalCockpitEmbedContext?.agentId);
  return globalValue;
}

/**
 * @description Formats a date-time value for human-readable history output.
 * @param {string} value Date value.
 * @returns {string} Formatted date-time string.
 */
export function formatDateTime(value) {
  if (!value) {
    return 'unknown';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

/**
 * @description Converts an optional number array to CSV string.
 * @param {unknown} value Candidate numeric array.
 * @param {number[]} fallback Fallback values.
 * @returns {string} CSV representation.
 */
export function joinNumberArray(value, fallback) {
  const list = Array.isArray(value) ? value : fallback;
  return list.map((item) => String(asInt(item))).join(',');
}

/**
 * @description Parses a CSV list of integers with fallback behavior.
 * @param {unknown} value CSV value.
 * @param {number[]} fallback Fallback array.
 * @returns {number[]} Parsed integer array.
 */
export function parseNumberCsv(value, fallback) {
  const raw = readString(value);
  if (!raw) {
    return fallback;
  }

  const parsed = raw
    .split(',')
    .map((item) => asInt(item.trim()))
    .filter((item) => item > 0);

  return parsed.length > 0 ? parsed : fallback;
}

/**
 * @description Safely reads a plain object value.
 * @param {unknown} value Candidate value.
 * @returns {Record<string, any>} Object or empty object.
 */
export function readRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * @description Safely trims string values.
 * @param {unknown} value Candidate value.
 * @returns {string} Trimmed string or empty string.
 */
export function readString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

/**
 * @description Parses integer values with default zero.
 * @param {unknown} value Candidate value.
 * @returns {number} Parsed integer.
 */
export function asInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @description Parses float values with default zero.
 * @param {unknown} value Candidate value.
 * @returns {number} Parsed float.
 */
export function asFloat(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @description Escapes HTML entities.
 * @param {string} value Input text.
 * @returns {string} Escaped text.
 */
export function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

/**
 * @description Converts unknown errors to display text.
 * @param {unknown} error Error object.
 * @returns {string} Error message.
 */
export function toMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

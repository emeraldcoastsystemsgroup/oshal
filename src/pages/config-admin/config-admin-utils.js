/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CM-6: Extracted HTTP helpers, DOM utilities, and agent ID resolution from config-admin.js (1277 → <1000 decomposition)
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('config-admin-utils');

const COCKPIT_SELECTED_AGENT_STORAGE_KEY = 'oshal-cockpit-selected-agent-id';

// ── HTTP Helpers ────────────────────────────────────────────────────────────

/**
 * @description Read JSON from the mounted OSHAL API and throw on error responses.
 */
export async function fetchJson(url) {
  const startedAt = Date.now();
  logger.debug('Config admin request started', { url, method: 'GET' });
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    logger.warn('Config admin request failed', {
      url, method: 'GET', status: response.status,
      durationMs: Date.now() - startedAt, errorMessage,
    });
    throw new Error(errorMessage);
  }
  const payload = await response.json();
  logger.info('Config admin request completed', {
    url, method: 'GET', status: response.status, durationMs: Date.now() - startedAt,
  });
  return payload;
}

/**
 * @description Post JSON to the mounted OSHAL API and throw on error responses.
 */
export async function postJson(url, payload) {
  const startedAt = Date.now();
  logger.debug('Config admin request started', { url, method: 'POST' });
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    logger.warn('Config admin request failed', {
      url, method: 'POST', status: response.status,
      durationMs: Date.now() - startedAt, errorMessage,
    });
    throw new Error(errorMessage);
  }
  const result = await response.json();
  logger.info('Config admin request completed', {
    url, method: 'POST', status: response.status, durationMs: Date.now() - startedAt,
  });
  return result;
}

/**
 * @description Put JSON to the mounted OSHAL API and throw on error responses.
 */
export async function putJson(url, payload) {
  const startedAt = Date.now();
  logger.debug('Config admin request started', { url, method: 'PUT' });
  const response = await fetch(url, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    logger.warn('Config admin request failed', {
      url, method: 'PUT', status: response.status,
      durationMs: Date.now() - startedAt, errorMessage,
    });
    throw new Error(errorMessage);
  }
  const result = await response.json();
  logger.info('Config admin request completed', {
    url, method: 'PUT', status: response.status, durationMs: Date.now() - startedAt,
  });
  return result;
}

/**
 * @description Generic JSON request with configurable method and headers.
 */
export async function requestJson(url, options = {}) {
  const method = options.method || 'GET';
  const startedAt = Date.now();
  logger.debug('Config admin request started', { url, method });
  const response = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await parseResponseJson(response);
  if (!response.ok) {
    const errorMessage = readString(payload?.error) || `${response.status} ${response.statusText}`;
    logger.warn('Config admin request failed', {
      url, method, status: response.status,
      durationMs: Date.now() - startedAt, errorMessage,
    });
    throw new Error(errorMessage);
  }
  logger.info('Config admin request completed', {
    url, method, status: response.status, durationMs: Date.now() - startedAt,
  });
  return payload;
}

/**
 * @description Parse the best available backend error message from a failed response.
 */
async function readErrorMessage(response) {
  const fallback = response.statusText || 'Request failed';
  try {
    const body = await response.json();
    return body.error || fallback;
  } catch (_error) {
    return fallback;
  }
}

/**
 * @description Safely parse a JSON response body, returning null on failure.
 */
async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    logger.warn('Config admin response parsing failed', {
      status: response.status, error: serializeUiError(error),
    });
    return null;
  }
}

// ── Agent ID Resolution ─────────────────────────────────────────────────────

/**
 * @description Resolve the selected agent id when the current selection is stale or missing.
 */
export function resolveSelectedAgentId(selectedAgentId, agents) {
  if (!selectedAgentId) {
    return '';
  }
  return agents.some((agent) => getAgentId(agent) === selectedAgentId) ? selectedAgentId : '';
}

/**
 * @description Resolve the initial selected agent, including bot-scoped defaults.
 */
export function resolveInitialSelectedAgentId(selectedAgentId, viewScope, agents) {
  const resolved = resolveSelectedAgentId(selectedAgentId, agents);
  if (resolved) {
    return resolved;
  }
  const cockpitSelectedAgentId = resolveSelectedAgentId(readSelectedAgentIdFromStorage(), agents);
  if (cockpitSelectedAgentId) {
    return cockpitSelectedAgentId;
  }
  return '';
}

/**
 * @description Find the currently selected lightweight agent record.
 */
export function findSelectedAgent(agents, selectedAgentId) {
  return agents.find((agent) => getAgentId(agent) === selectedAgentId) || null;
}

/**
 * @description Read the canonical agent id from summary or profile shapes.
 */
export function getAgentId(agent) {
  return readString(agent?.agentId || agent?.agent_id);
}

/**
 * @description Read the best available agent display name from summary or profile shapes.
 */
export function readAgentName(agent) {
  return readString(agent?.name) || getAgentId(agent);
}

// ── URL & Storage ───────────────────────────────────────────────────────────

/**
 * @description Read the selected agent id from the current URL query string.
 */
export function readSelectedAgentIdFromUrl() {
  const url = new URL(window.location.href);
  return readString(url.searchParams.get('agentId'));
}

/**
 * @description Read the preferred config surface scope from query string.
 */
export function readScopeFromUrl() {
  const url = new URL(window.location.href);
  return readString(url.searchParams.get('scope')) === 'agent' ? 'agent' : 'all';
}

/**
 * @description Read the cockpit-selected agent id persisted by the right-rail selector.
 */
export function readSelectedAgentIdFromStorage() {
  try {
    return readString(window.localStorage.getItem(COCKPIT_SELECTED_AGENT_STORAGE_KEY));
  } catch (_error) {
    return '';
  }
}

/**
 * @description Persist the selected agent id in the current URL without a navigation.
 */
export function writeSelectedAgentIdToUrl(agentId) {
  const url = new URL(window.location.href);
  if (agentId) {
    url.searchParams.set('agentId', agentId);
  } else {
    url.searchParams.delete('agentId');
  }
  window.history.replaceState({}, '', url.toString());
}

// ── DOM Utilities ───────────────────────────────────────────────────────────

/**
 * @description Normalize optional string-like values.
 */
export function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @description Safely cast a value to a plain object.
 */
export function readRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * @description Extract an error message from an Error or unknown value.
 */
export function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @description Promise-based delay for polling loops.
 */
export function delay(durationMs) {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

/**
 * @description Count array items safely for dashboard metrics.
 */
export function countItems(value) {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * @description Update a text node by id when the element exists.
 */
export function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = String(value);
  }
}

/**
 * @description Set inline status text and tone on a service runtime status element.
 */
export function setInlineStatus(element, message, tone) {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  element.textContent = message;
  element.dataset.tone = tone;
}

/**
 * @description Escape user-visible HTML strings before rendering.
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @description Escape attribute values before injecting them into HTML attributes.
 */
export function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

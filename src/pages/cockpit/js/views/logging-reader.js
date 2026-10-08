/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Preserve refused log reads and expose trace filters and bounded history honestly.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Add safe method durations without retaining filter text or request bodies.
 */

import { createUiLogger } from '../../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-logging-reader');
const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const PATHS = new Set(['/api/v1/logs/query', '/api/v1/logs/modules', '/api/admin/logging']);

/** @description Escape record fields before rendering them as HTML.
 * @param {unknown} value A field from an admitted response.
 * @returns {string} Inert HTML text.
 */
export function escapeLoggingHtml(value) {
  const started = performance.now();
  logger.debug('escapeLoggingHtml.entry');
  const result = String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  logger.debug('escapeLoggingHtml.exit', { durationMs: performance.now() - started, characters: result.length });
  return result;
}

/** @description Keep a returned severity out of CSS and attribute injection paths.
 * @param {unknown} value The backend severity.
 * @returns {string} A supported CSS severity.
 */
export function loggingLevel(value) {
  const started = performance.now();
  logger.debug('loggingLevel.entry');
  const level = String(value ?? 'info').toLowerCase();
  const result = LEVELS.has(level) ? level : 'info';
  logger.debug('loggingLevel.exit', { durationMs: performance.now() - started });
  return result;
}

/** @description Read logs without replacing access or transport failures with empty history.
 * @param {string} endpoint The same-origin logging endpoint.
 * @param {object} options Optional fetch options for an explicit administrator update.
 * @returns {Promise<object>} The successful JSON response.
 */
export async function loggingRequest(endpoint, options = {}) {
  const started = performance.now();
  // Only fixed route/method labels reach diagnostics, never the URL query or body.
  const candidate = endpoint.split('?')[0];
  const path = PATHS.has(candidate) ? candidate : 'other';
  const method = options.method === 'PUT' ? 'PUT' : options.method == null ? 'GET' : 'other';
  let status = 0;
  logger.debug('loggingRequest.entry', { path, method });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, { ...options, credentials: 'same-origin', signal: controller.signal });
    status = response.status;
    if (!response.ok) {
      // Response bodies may contain operational details; browser diagnostics use only status.
      const messages = { 401: 'Sign in to read logs.', 403: 'Administrator access is required.',
        404: 'This logging endpoint is unavailable.', 409: 'Logging settings changed. Reload this screen before applying.',
        503: 'Logging storage is unavailable.' };
      const error = new Error(messages[response.status] || `Logging request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    logger.error('logging-request-failed', { err: new Error('Logging request failed'), path, method, status });
    throw error;
  } finally {
    clearTimeout(timer);
    logger.debug('loggingRequest.exit', { path, method, status, durationMs: performance.now() - started });
  }
}

/** @description Encode diagnostic filters so identifiers and search text stay query values.
 * @param {object} filters Current log filters.
 * @param {string|null} since Earliest timestamp.
 * @returns {URLSearchParams} The finite query contract.
 */
export function loggingQuery(filters, since) {
  const started = performance.now();
  logger.debug('loggingQuery.entry', { searchCharacters: typeof filters.search === 'string' ? filters.search.length : 0 });
  const params = new URLSearchParams({ limit: '500' });
  for (const key of ['ticketId', 'traceId', 'level', 'module', 'search']) {
    if (filters[key]) params.set(key, filters[key]);
  }
  if (since) params.set('since', since);
  logger.debug('loggingQuery.exit', { durationMs: performance.now() - started, filterCount: params.size - 1 });
  return params;
}

/** @description Distinguish the available diagnostic window from complete durable history.
 * @param {object} meta Backend query and buffer metadata.
 * @param {string} source The returned source marker.
 * @returns {string} A factual viewer status.
 */
export function loggingStatus(meta, source) {
  const started = performance.now();
  logger.debug('loggingStatus.entry');
  const parts = [`${Number(meta.total) || 0} matching entries`];
  if (meta.hasMore) parts.push('result limit reached');
  if (source === 'native-kernel-observer') {
    parts.push('Native kernel');
    parts.push('recent memory buffer · resets on restart');
    if (Number(meta.evicted) > 0) parts.push(`${Number(meta.evicted)} older entries evicted`);
    if (Number(meta.droppedOversize) > 0) parts.push(`${Number(meta.droppedOversize)} oversized entries omitted`);
  } else if (source) parts.push(String(source));
  const result = parts.join(' · ');
  logger.debug('loggingStatus.exit', { durationMs: performance.now() - started });
  return result;
}

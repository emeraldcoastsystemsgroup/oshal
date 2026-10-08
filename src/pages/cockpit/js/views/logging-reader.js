/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Preserve refused log reads and expose trace filters and bounded history honestly.
 */

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** @description Escape record fields before rendering them as HTML.
 * @param {unknown} value A field from an admitted response.
 * @returns {string} Inert HTML text.
 */
export function escapeLoggingHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

/** @description Keep a returned severity out of CSS and attribute injection paths.
 * @param {unknown} value The backend severity.
 * @returns {string} A supported CSS severity.
 */
export function loggingLevel(value) {
  const level = String(value ?? 'info').toLowerCase();
  return LEVELS.has(level) ? level : 'info';
}

/** @description Read logs without replacing access or transport failures with empty history.
 * @param {string} endpoint The same-origin logging endpoint.
 * @param {object} options Optional fetch options for an explicit administrator update.
 * @returns {Promise<object>} The successful JSON response.
 */
export async function loggingRequest(endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, { ...options, credentials: 'same-origin', signal: controller.signal });
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
  } finally {
    clearTimeout(timer);
  }
}

/** @description Encode diagnostic filters so identifiers and search text stay query values.
 * @param {object} filters Current log filters.
 * @param {string|null} since Earliest timestamp.
 * @returns {URLSearchParams} The finite query contract.
 */
export function loggingQuery(filters, since) {
  const params = new URLSearchParams({ limit: '500' });
  for (const key of ['ticketId', 'traceId', 'level', 'module', 'search']) {
    if (filters[key]) params.set(key, filters[key]);
  }
  if (since) params.set('since', since);
  return params;
}

/** @description Distinguish the available diagnostic window from complete durable history.
 * @param {object} meta Backend query and buffer metadata.
 * @param {string} source The returned source marker.
 * @returns {string} A factual viewer status.
 */
export function loggingStatus(meta, source) {
  const parts = [`${Number(meta.total) || 0} matching entries`];
  if (meta.hasMore) parts.push('result limit reached');
  if (source === 'native-kernel-observer') {
    parts.push('Native kernel');
    parts.push('recent memory buffer · resets on restart');
    if (Number(meta.evicted) > 0) parts.push(`${Number(meta.evicted)} older entries evicted`);
    if (Number(meta.droppedOversize) > 0) parts.push(`${Number(meta.droppedOversize)} oversized entries omitted`);
  } else if (source) parts.push(String(source));
  return parts.join(' · ');
}

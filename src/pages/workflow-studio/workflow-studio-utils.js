/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from workflow-studio.js (1000-line cap decomposition): canvas constants + pure helpers (field-group markup, inspector value parsing, JSON fetch, HTML escaping, clamp/clone/id) shared by the studio modules
 */

/** @description Node card width in world (unscaled canvas) pixels; used to center newly added nodes. */
export const NODE_WIDTH = 184;

/** @description Node card height in world (unscaled canvas) pixels; used to center newly added nodes. */
export const NODE_HEIGHT = 96;

/** @description Maximum node x position (world pixels) a node can be dragged or placed to. */
export const MAX_X = 2180;

/** @description Maximum node y position (world pixels) a node can be dragged or placed to. */
export const MAX_Y = 980;

/**
 * @description Monochrome glyph per stage type (colored by the node's accent in CSS) —
 * n8n-style icon-forward nodes rendered in each canvas node card's head.
 */
export const NODE_ICONS = {
  'start': '▶', 'intake-source': '↧', 'planner': '☰', 'route-agent': '⇄', 'ai-decision': '◆',
  'logic-gate': '⎇', 'execute-agent': '▣', 'parallel-split': '⋔', 'parallel-join': '⋕',
  'approval-gate': '‖', 'verify-output': '✓', 'review': '◎', 'deliver': '→', 'escalate': '▲',
  'agent-cluster': '⧉',
};

/**
 * @description Builds the labelled form-control markup for one inspector field (text, textarea,
 * select, boolean, or number input) with the current value pre-filled.
 * @param {{key: string, label: string, input?: string, placeholder?: string, helpText?: string}} field - Field descriptor from the node catalog (or a synthetic title/description/label field).
 * @param {*} value - Current field value to render into the control.
 * @param {Array<{value: string, label: string}>} [options=[]] - Options for select inputs.
 * @returns {string} HTML markup for the field group.
 */
export function buildFieldGroup(field, value, options = []) {
  const inputType = field.input || 'text';
  const fieldValue = formatFieldValue(value, inputType);
  const normalizedOptions = inputType === 'select'
    ? buildSelectOptions(options, fieldValue)
    : options;
  let control = '';

  if (inputType === 'textarea') {
    control = `<textarea rows="4" data-field-key="${field.key}" data-field-input="${inputType}" placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(fieldValue)}</textarea>`;
  } else if (inputType === 'select') {
    control = `
      <select data-field-key="${field.key}" data-field-input="${inputType}">
        ${normalizedOptions.map((option) => `
          <option value="${escapeHtml(option.value)}" ${option.value === fieldValue ? 'selected' : ''}>${escapeHtml(option.label)}</option>
        `).join('')}
      </select>
    `;
  } else if (inputType === 'boolean') {
    control = `
      <select data-field-key="${field.key}" data-field-input="${inputType}">
        <option value="true" ${fieldValue === 'true' ? 'selected' : ''}>true</option>
        <option value="false" ${fieldValue !== 'true' ? 'selected' : ''}>false</option>
      </select>
    `;
  } else {
    const htmlType = inputType === 'number' ? 'number' : 'text';
    control = `<input type="${htmlType}" data-field-key="${field.key}" data-field-input="${inputType}" value="${escapeHtml(fieldValue)}" placeholder="${escapeHtml(field.placeholder || '')}">`;
  }

  return `
    <div class="field-group">
      <label>${escapeHtml(field.label)}</label>
      ${control}
      ${field.helpText ? `<span class="field-help">${escapeHtml(field.helpText)}</span>` : ''}
    </div>
  `;
}

function formatFieldValue(value, inputType) {
  if (value === undefined || value === null) {
    return inputType === 'boolean' ? 'false' : '';
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value);
}

function buildSelectOptions(options, currentValue) {
  const normalized = Array.isArray(options) ? [...options] : [];
  if (currentValue && !normalized.some((option) => option.value === currentValue)) {
    normalized.unshift({ value: currentValue, label: currentValue });
  }
  if (normalized.length === 0) {
    normalized.push({ value: '', label: 'No options available' });
  }
  return normalized;
}

/**
 * @description Reads a typed value out of an inspector form control: numbers parse to finite
 * numbers (else 0), booleans parse 'true'/'false', tags split a comma list, everything else
 * returns the raw string.
 * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} target - The form control that changed.
 * @param {string} inputType - The declared field input type ('number' | 'boolean' | 'tags' | other).
 * @returns {number|boolean|string[]|string} The parsed field value.
 */
export function readInspectorValue(target, inputType) {
  if (inputType === 'number') {
    const parsed = Number(target.value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (inputType === 'boolean') {
    return target.value === 'true';
  }
  if (inputType === 'tags') {
    return target.value
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
  return target.value;
}

/**
 * @description Fetches a URL expecting a JSON payload; throws a human-readable Error (using the
 * payload's `error` field when present) on any non-OK response.
 * @param {string} url - Request URL.
 * @param {RequestInit} [options={}] - Fetch options (method, headers, body).
 * @returns {Promise<Object>} The parsed JSON payload.
 */
export async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

/**
 * @description Extracts a display message from a thrown value.
 * @param {*} error - The caught value.
 * @returns {string} The Error's message, or 'Unknown error' for non-Error throws.
 */
export function readErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

/**
 * @description Formats a timestamp for the version panel using the browser locale.
 * @param {string|number|Date} value - Timestamp value to format.
 * @returns {string} Locale-formatted date-time, or 'unknown time' when unparseable.
 */
export function formatRelativeTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown time';
  }
  return parsed.toLocaleString();
}

/**
 * @description Escapes a value for safe interpolation into HTML markup.
 * @param {*} value - Value to stringify and escape.
 * @returns {string} HTML-escaped string.
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
 * @description Clamps a number into the inclusive [min, max] range.
 * @param {number} value - Value to clamp.
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {number} The clamped value.
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * @description Deep-clones a JSON-serializable value (used for catalog default configs).
 * @param {*} value - JSON-safe value to clone.
 * @returns {*} A structural copy of the value.
 */
export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @description Creates a prefixed unique id for new nodes/edges.
 * @param {string} prefix - Id prefix (e.g. 'node' or 'edge').
 * @returns {string} `${prefix}_${uuid}`.
 */
export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Track B S5: Schema-driven per-agent runtime config panel — load/render/save via /api/swarm/agents/:agentId/config
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('agent-runtime-config');

// ── Schema field type renderers ───────────────────────────────────────────────

/**
 * @description Render an HTML input appropriate for a ConfigField type.
 * @param {object} field - ConfigField definition
 * @param {unknown} value - Current persisted value
 * @returns {string} HTML string for the field row
 */
function renderSchemaField(field, value) {
  const id = `rcf-${field.name}`;
  const current = value !== undefined && value !== null ? String(value) : '';
  const label = field.label || field.name;
  const hint = field.description ? `<span class="field-copy">${escapeHtml(field.description)}</span>` : '';

  if (field.type === 'select' && Array.isArray(field.options)) {
    const opts = field.options.map((o) => {
      const optVal = typeof o === 'string' ? o : o.value;
      const optLabel = typeof o === 'string' ? o : (o.label || o.value);
      return `<option value="${escapeHtmlAttribute(optVal)}"${current === optVal ? ' selected' : ''}>${escapeHtml(optLabel)}</option>`;
    }).join('');
    return `<label class="field"><span>${escapeHtml(label)}</span><select name="${escapeHtmlAttribute(field.name)}" id="${id}">${opts}</select>${hint}</label>`;
  }

  if (field.type === 'boolean') {
    const checked = current === 'true' ? ' checked' : '';
    return `<label class="field checkbox-row"><input type="checkbox" name="${escapeHtmlAttribute(field.name)}" id="${id}" value="true"${checked}><span>${escapeHtml(label)}</span>${hint}</label>`;
  }

  if (field.type === 'textarea') {
    return `<label class="field field-wide"><span>${escapeHtml(label)}</span><textarea name="${escapeHtmlAttribute(field.name)}" id="${id}" placeholder="${escapeHtmlAttribute(field.placeholder || '')}">${escapeHtml(current)}</textarea>${hint}</label>`;
  }

  const inputType = field.type === 'password'
    ? 'password'
    : field.type === 'url'
      ? 'url'
      : field.type === 'number'
        ? 'number'
        : 'text';
  return `<label class="field"><span>${escapeHtml(label)}</span><input type="${inputType}" name="${escapeHtmlAttribute(field.name)}" id="${id}" value="${escapeHtmlAttribute(current)}" placeholder="${escapeHtmlAttribute(field.placeholder || '')}">${hint}</label>`;
}

function renderConfigGuide(configGuide) {
  if (!configGuide) {
    return '';
  }

  const title = configGuide.title || 'Agent Setup Guide';
  const summary = configGuide.summary
    ? `<p class="agent-runtime-guide-summary">${escapeHtml(configGuide.summary)}</p>`
    : '';
  const pathMarkup = configGuide.docPath
    ? `<p class="agent-runtime-guide-path">${escapeHtml(configGuide.docPath)}</p>`
    : '';
  const contentMarkup = configGuide.content
    ? `<pre class="agent-runtime-guide-content">${escapeHtml(configGuide.content)}</pre>`
    : '<p class="field-copy">No local guide content was loaded for this agent yet.</p>';

  return `
    <section class="agent-runtime-guide" data-testid="agent-runtime-guide">
      <div class="panel-eyebrow">Local Setup Guide</div>
      <h3>${escapeHtml(title)}</h3>
      ${summary}
      ${pathMarkup}
      ${contentMarkup}
    </section>
  `;
}

/**
 * @description Render the schema-driven config form for an agent.
 * @param {object|null} config - AgentConfig from the API, or null for empty state
 * @returns {string} HTML string
 */
export function renderRuntimeConfigSection(config) {
  const guideMarkup = renderConfigGuide(config?.configGuide);
  const hasSchema = Boolean(config?.schema && config.schema.length > 0);

  if (!config) {
    return `
      ${guideMarkup}
      <div class="empty-state" data-testid="runtime-config-empty">No runtime config payload is registered for this agent yet.</div>
    `;
  }

  if (!hasSchema) {
    return `
      ${guideMarkup}
      <div class="empty-state" data-testid="runtime-config-empty">No runtime config schema defined for this agent.</div>
    `;
  }

  const fields = config.schema.map((field) => renderSchemaField(field, config.values?.[field.name])).join('');

  return `
    ${guideMarkup}
    <form id="agentRuntimeConfigForm" data-testid="agent-runtime-config-form">
      <div class="panel-eyebrow">Runtime Config</div>
      ${fields}
      <div class="agent-config-actions">
        <button type="submit">Save Runtime Config</button>
      </div>
    </form>
  `;
}

// ── API helpers ───────────────────────────────────────────────────────────────

/**
 * @description Load agent runtime config schema + values from the API.
 * @param {string} agentId
 * @returns {Promise<object|null>} Config or null if none exists
 */
export async function loadAgentRuntimeConfig(agentId) {
  const res = await fetch(`/api/swarm/agents/${encodeURIComponent(agentId)}/config`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load runtime config: ${res.statusText}`);
  return res.json();
}

/**
 * @description Save agent runtime config values by reading from a form container.
 * @param {string} agentId
 * @param {HTMLElement} formEl - Form element containing named inputs
 * @returns {Promise<object>} Updated config
 */
export async function saveAgentRuntimeConfig(agentId, formEl) {
  const values = {};
  new FormData(formEl).forEach((val, key) => {
    values[key] = val;
  });
  // Handle unchecked checkboxes (FormData omits them)
  formEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    if (!cb.checked) values[cb.name] = 'false';
  });

  const res = await fetch(`/api/swarm/agents/${encodeURIComponent(agentId)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error(`Failed to save runtime config: ${res.statusText}`);
  return res.json();
}

// ── Standalone page bootstrap (used when this file is the entry point) ────────

/**
 * @description Minimal standalone runtime config page initializer.
 * Reads agentId from the URL query string, loads config, and renders the form.
 */
export async function initStandaloneRuntimeConfigPage() {
  const params = new URLSearchParams(window.location.search);
  const agentId = params.get('agentId');
  const container = document.getElementById('runtimeConfigContainer');
  const statusEl = document.getElementById('runtimeConfigStatus');

  if (!agentId || !container) {
    logger.warn('agentId or container missing — standalone page cannot initialize');
    return;
  }

  function setStatus(msg, tone = 'info') {
    if (statusEl) { statusEl.textContent = msg; statusEl.dataset.tone = tone; }
  }

  setStatus('Loading runtime config…');
  try {
    const config = await loadAgentRuntimeConfig(agentId);
    container.innerHTML = renderRuntimeConfigSection(config);
    setStatus(config ? 'Runtime config loaded.' : 'No schema defined — expand this agent\'s capabilities first.', config ? 'success' : 'info');

    const form = container.querySelector('#agentRuntimeConfigForm');
    if (form) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        setStatus('Saving…');
        try {
          await saveAgentRuntimeConfig(agentId, form);
          setStatus('Runtime config saved.', 'success');
        } catch (err) {
          logger.error('Save failed', { error: serializeUiError(err) });
          setStatus(`Save failed: ${err.message}`, 'error');
        }
      });
    }
  } catch (err) {
    logger.error('Failed to load runtime config', { agentId, error: serializeUiError(err) });
    setStatus(`Failed to load: ${err.message}`, 'error');
    container.innerHTML = '<div class="empty-state">Failed to load runtime config. Check the console for details.</div>';
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeHtmlAttribute(str) { return escapeHtml(str); }

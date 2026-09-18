/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The fleet-default switch control ("a bot's LLM provider is a row in a table"; operator acceptance 2026-09-17: moving the whole fleet back to Codex is ONE write from the cockpit). Renders the one reserved row beside the per-bot provider select: a provider select over the SAME /api/providers list the per-bot control uses, a model input, Save (PUT /api/agents/provider-switch/fleet-default) and Clear (DELETE). The API's refusal text (unknown id + the accepted ids) is shown verbatim; the browser never re-derives the catalog. A non-operator or a box without Postgres sees the panel disabled with the API's own reason.
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';
import { escapeHtml, escapeHtmlAttribute, readString, requestJson } from './config-admin-utils.js';

const logger = createUiLogger('config-admin-fleet-default');
const ENDPOINT = '/api/agents/provider-switch';

/**
 * @description Load the fleet-default row and the snapshot status into app.state.fleetDefault.
 * A refusal (non-operator, no pool) is kept as the panel's reason, never thrown.
 * @param {object} app - The config-admin app.
 * @returns {Promise<void>}
 */
export async function loadFleetDefault(app) {
  try {
    const body = await requestJson(ENDPOINT);
    app.state.fleetDefault = { row: body.fleetDefault || null, snapshot: body.snapshot || null, accepted: body.accepted || [], error: null };
  } catch (error) {
    logger.warn('Fleet default unavailable', serializeUiError(error));
    app.state.fleetDefault = { row: null, snapshot: null, accepted: [], error: error?.message || String(error) };
  }
}

function renderOptions(providers, selectedValue) {
  const known = Array.isArray(providers) ? providers : [];
  const options = known.map((provider) => {
    const label = readString(provider.displayName || provider.name || provider.id);
    return `<option value="${escapeHtmlAttribute(provider.id)}"${provider.id === selectedValue ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  });
  if (selectedValue && !known.some((provider) => provider.id === selectedValue)) {
    options.unshift(`<option value="${escapeHtmlAttribute(selectedValue)}" selected>${escapeHtml(selectedValue)}</option>`);
  }
  return `<option value=""${selectedValue ? '' : ' selected'}>(no fleet default — registry literal)</option>${options.join('')}`;
}

/**
 * @description Render the fleet-default panel from state.
 * @param {object} app - The config-admin app.
 * @returns {void}
 */
export function renderFleetDefaultPanel(app) {
  const host = app.elements.fleetDefaultPanel;
  if (!host) return;
  const state = app.state.fleetDefault || { row: null, snapshot: null, accepted: [], error: 'Not loaded' };
  const row = state.row;
  const disabled = state.error ? ' disabled' : '';
  const status = state.error
    ? `Fleet default unavailable: ${state.error}`
    : row
      ? `Fleet default: ${row.providerId}${row.modelId ? ` / ${row.modelId}` : ''} (set by ${row.updatedBy || 'operator'}${row.updatedAt ? ` at ${row.updatedAt}` : ''}). Every registry LLM bot without its own row runs on it.`
      : 'No fleet default set: bots without their own row run on the registry literal.';
  const snapshot = state.snapshot
    ? ` Snapshot: ${state.snapshot.rowCount} row(s), loaded ${state.snapshot.loadedAt || 'never'}${state.snapshot.lastError ? `, last error: ${state.snapshot.lastError}` : ''}.`
    : '';
  host.innerHTML = `
    <form id="fleetDefaultForm" class="config-form" data-fleet-source="${escapeHtmlAttribute(row ? 'fleet-default' : 'registry')}">
      <label class="field"><span>Fleet default provider</span>
        <select id="fleetDefaultProviderInput" aria-describedby="fleetDefaultStatus"${disabled}>${renderOptions(app.state.providers, row ? row.providerId : '')}</select>
      </label>
      <label class="field"><span>Fleet default model</span>
        <input id="fleetDefaultModelInput" type="text" value="${escapeHtmlAttribute(row?.modelId || '')}" placeholder="harness default"${disabled}>
      </label>
      <span id="fleetDefaultStatus" class="field-copy field-wide">${escapeHtml(status + snapshot)}</span>
      <div class="agent-config-actions field-wide">
        <button id="saveFleetDefaultButton" type="submit"${disabled}>Save Fleet Default</button>
        <button id="clearFleetDefaultButton" type="button"${disabled || (row ? '' : ' disabled')}>Clear Fleet Default</button>
      </div>
    </form>`;
}

/**
 * @description Save the fleet default: ONE write. The API validates the id; its reason is shown verbatim.
 * @param {object} app - The config-admin app.
 * @returns {Promise<void>}
 */
export async function saveFleetDefault(app) {
  const host = app.elements.fleetDefaultPanel;
  const providerId = readString(host?.querySelector('#fleetDefaultProviderInput')?.value);
  const modelId = readString(host?.querySelector('#fleetDefaultModelInput')?.value);
  if (!providerId) {
    app.setStatus('Choose a provider for the fleet default, or clear it.', 'error');
    return;
  }
  app.setStatus(`Switching the fleet default to ${providerId}...`, 'info');
  try {
    const body = await requestJson(`${ENDPOINT}/fleet-default`, {
      method: 'PUT',
      body: JSON.stringify({ providerId, ...(modelId ? { modelId } : {}) }),
    });
    app.state.fleetDefault = { ...app.state.fleetDefault, row: body.fleetDefault || null, snapshot: body.snapshot || null, error: null };
    await refreshAgentsAfterSwitch(app);
    app.setStatus(`Fleet default is now ${body.fleetDefault?.providerId}${body.fleetDefault?.modelId ? ` / ${body.fleetDefault.modelId}` : ''} — the next dispatch to an idle bot runs on it.`, 'success');
  } catch (error) {
    logger.error('Fleet default write failed', serializeUiError(error));
    app.setStatus(`Fleet default not changed: ${error?.message || error}`, 'error');
  }
}

/**
 * @description Clear the fleet default so bots without their own row fall back to the registry literal.
 * @param {object} app - The config-admin app.
 * @returns {Promise<void>}
 */
export async function clearFleetDefault(app) {
  app.setStatus('Clearing the fleet default...', 'info');
  try {
    const body = await requestJson(`${ENDPOINT}/fleet-default`, { method: 'DELETE' });
    app.state.fleetDefault = { ...app.state.fleetDefault, row: null, snapshot: body.snapshot || null, error: null };
    await refreshAgentsAfterSwitch(app);
    app.setStatus('Fleet default cleared — bots without their own row run on the registry literal.', 'success');
  } catch (error) {
    logger.error('Fleet default clear failed', serializeUiError(error));
    app.setStatus(`Fleet default not cleared: ${error?.message || error}`, 'error');
  }
}

/** Re-read /api/agents so every bot's reported providerSource reflects the new rung, then re-render. */
async function refreshAgentsAfterSwitch(app) {
  try {
    const agents = await requestJson('/api/agents');
    app.state.agents = Array.isArray(agents.agents) ? agents.agents : app.state.agents;
  } catch (error) {
    logger.warn('Agent list refresh after fleet switch failed', serializeUiError(error));
  }
  app.render();
}

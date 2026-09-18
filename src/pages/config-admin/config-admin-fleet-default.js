/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The fleet-default switch control ("a bot's LLM provider is a row in a table"; operator acceptance 2026-09-17: moving the whole fleet back to Codex is ONE write from the cockpit). Renders the one reserved row beside the per-bot provider select: a provider select over the SAME /api/providers list the per-bot control uses, a model input, Save (PUT /api/agents/provider-switch/fleet-default) and Clear (DELETE). The API's refusal text (unknown id + the accepted ids) is shown verbatim; the browser never re-derives the catalog. A non-operator or a box without Postgres sees the panel disabled with the API's own reason.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The FALLBACK ORDER is settable here (operator, 2026-09-18: "we better have a configuration that is setable in the ux and we better have a env that corialtes as well"). An ordered comma-separated control beside the provider it falls back FROM, suggesting ids from the same /api/providers list the selects use - never a hardcoded list. The box always shows the stored chain, so what is in it IS the intent, including an empty box, which stores [] ("no failover, surface the failure") rather than being guessed as "unchanged". The panel states the chain in words, so it can never imply a failover that is not configured, and names the per-node env override.
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
      ? `Fleet default: ${row.providerId}${row.modelId ? ` / ${row.modelId}` : ''} (set by ${row.updatedBy || 'operator'}${row.updatedAt ? ` at ${row.updatedAt}` : ''}). Every registry LLM bot without its own row runs on it. ${describeChain(row)}`
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
      <label class="field field-wide"><span>Fallback order</span>
        <input id="fleetDefaultFallbackInput" type="text" list="fleetDefaultProviderIds"
               value="${escapeHtmlAttribute(chainText(row))}"
               placeholder="e.g. claude-code, openrouter, anthropic \u2014 as many as you want, tried in this order"${disabled}>
      </label>
      <datalist id="fleetDefaultProviderIds">${renderDatalist(app.state.providers)}</datalist>
      <span class="field-copy field-wide">Comma-separated provider ids, tried left to right when the
        fleet default fails in a way the failure classifier calls eligible (throttle, quota, auth,
        runtime stall). Leave it empty for no failover \u2014 a failure then surfaces instead of
        silently spending on another vendor. Per-node override: <code>OSHAL_PROVIDER_FALLBACK_ORDER</code>.</span>
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
  // The control always shows the stored chain, so what is in the box IS the intent — including an
  // empty box, which is the deliberate "no failover" the API stores as []. Never guessed.
  const fallbackOrder = parseChain(readString(host?.querySelector('#fleetDefaultFallbackInput')?.value));
  if (!providerId) {
    app.setStatus('Choose a provider for the fleet default, or clear it.', 'error');
    return;
  }
  app.setStatus(`Switching the fleet default to ${providerId}...`, 'info');
  try {
    const body = await requestJson(`${ENDPOINT}/fleet-default`, {
      method: 'PUT',
      body: JSON.stringify({ providerId, ...(modelId ? { modelId } : {}), fallbackOrder }),
    });
    app.state.fleetDefault = { ...app.state.fleetDefault, row: body.fleetDefault || null, snapshot: body.snapshot || null, error: null };
    await refreshAgentsAfterSwitch(app);
    app.setStatus(`Fleet default is now ${body.fleetDefault?.providerId}${body.fleetDefault?.modelId ? ` / ${body.fleetDefault.modelId}` : ''}. ${describeChain(body.fleetDefault)} The next dispatch to an idle bot runs on it.`, 'success');
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

/**
 * @description The stored chain as the administrator typed it, for the control's value.
 * @param {object|null} row - The fleet-default row, or null when none is set.
 * @returns {string} Comma-separated ids, or '' when the row carries no chain.
 */
function chainText(row) {
  return Array.isArray(row?.fallbackOrder) ? row.fallbackOrder.join(', ') : '';
}

/**
 * @description One sentence naming the current chain, so the panel never implies a failover that
 * is not configured. An empty chain is stated as such rather than left blank.
 * @param {object|null} row - The fleet-default row.
 * @returns {string} A human sentence.
 */
function describeChain(row) {
  if (!Array.isArray(row?.fallbackOrder)) return 'No fallback order set for the fleet.';
  if (row.fallbackOrder.length === 0) return 'Fallback: none — a failover-eligible failure surfaces.';
  return `Fallback order: ${row.fallbackOrder.join(' \u2192 ')}.`;
}

/**
 * @description Split what the administrator typed into an ordered id list. Order is preserved
 * exactly; the API validates every entry and refuses the whole write with its own reason.
 * @param {string} value - The raw control value.
 * @returns {string[]} Ordered provider ids; [] means no failover, deliberately.
 */
function parseChain(value) {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * @description Datalist options over the SAME provider list the selects use, so the chain control
 * suggests only ids this deployment can run. Never a hardcoded list.
 * @param {Array<object>} providers - The /api/providers rows.
 * @returns {string} The option markup.
 */
function renderDatalist(providers) {
  return (Array.isArray(providers) ? providers : [])
    .map((provider) => `<option value="${escapeHtmlAttribute(provider?.id || '')}"></option>`)
    .join('');
}

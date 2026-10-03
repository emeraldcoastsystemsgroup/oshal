/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b: the config-admin card for the capability swarm defaults and provider prices. One form per capability (text to speech, speech to text, image, video) over GET /api/capability-providers: a select of every registered provider labelled with who pays and, when it cannot be used now, the missing piece the API names (the browser never re-derives availability); a voice box for text to speech (the API keeps a voice only beside a provider that lists it); Save is ONE write (PUT /swarm/:capability) that the next call follows with no restart, and Clear returns the capability to the provider the config or selector names. Each provider row carries its unit price (USD per character, audio second, image or video second) and quota label, saved with PUT /offers/:capability/:providerId; spend is priced at that rate from the next call; an empty box clears the price, and a box that does not hold a number is refused in place rather than sent. The API's refusal text is shown verbatim. A non-operator or a box without Postgres sees the panel unavailable with the API's own reason.
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';
import { escapeHtml, escapeHtmlAttribute, readString, requestJson } from './config-admin-utils.js';

const logger = createUiLogger('config-admin-capability-providers');
const ENDPOINT = '/api/capability-providers';
const TITLES = Object.freeze({ tts: 'Text to speech', stt: 'Speech to text', image: 'Images', video: 'Video' });
const PAYERS = Object.freeze({ free: 'free', 'swarm-paid': 'swarm pays', 'user-paid': 'caller pays' });

/**
 * @description Load the capability listing into app.state.capabilityProviders. A refusal (non-operator,
 * no pool) is kept as the panel's reason, never thrown.
 * @param {object} app - The config-admin app.
 * @returns {Promise<void>}
 */
export async function loadCapabilityProviders(app) {
  try {
    const body = await requestJson(ENDPOINT);
    app.state.capabilityProviders = { sections: Array.isArray(body.capabilities) ? body.capabilities : [], snapshot: body.snapshot || null, error: null };
  } catch (error) {
    logger.warn('Capability providers unavailable', serializeUiError(error));
    app.state.capabilityProviders = { sections: [], snapshot: null, error: error?.message || String(error) };
  }
}

/**
 * @description One provider's option label: its name, who pays, and why it cannot be used now.
 * @param {object} provider - A provider from the listing.
 * @returns {string} The label.
 */
export function providerLabel(provider) {
  const payer = PAYERS[provider.costClass] || 'no cost class';
  const reason = provider.available ? '' : ` — not usable now: ${readString(provider.detail) || provider.missing || 'unavailable'}`;
  return `${readString(provider.displayName) || provider.providerId} (${payer})${reason}`;
}

/**
 * @description The sentence that says what the swarm default is and where it came from.
 * @param {object} section - One capability section.
 * @returns {string} The sentence.
 */
export function defaultSentence(section) {
  const d = section.swarmDefault || {};
  if (!d.providerId) return `No swarm default: ${readString(d.reason) || 'nothing names one'}.`;
  const row = d.row;
  const voice = d.voice ? ` with voice ${d.voice}` : '';
  if (d.source === 'row' && row) return `Swarm default: ${d.providerId}${voice} (set by ${row.updatedBy || 'operator'}${row.updatedAt ? ` at ${row.updatedAt}` : ''}).`;
  return `Swarm default: ${d.providerId}${voice}, from ${d.source} (no row written).`;
}

/** @description The select of providers, the row's provider selected, or the "no row" entry. */
function providerSelect(section) {
  const selected = section.swarmDefault && section.swarmDefault.source === 'row' ? section.swarmDefault.providerId : '';
  const options = (section.providers || []).map((p) => `<option value="${escapeHtmlAttribute(p.providerId)}"${p.providerId === selected ? ' selected' : ''}>${escapeHtml(providerLabel(p))}</option>`);
  return `<select data-capability-provider aria-label="${escapeHtmlAttribute(TITLES[section.capability] || section.capability)} swarm default"><option value=""${selected ? '' : ' selected'}>(no row — the config or selector decides)</option>${options.join('')}</select>`;
}

/** @description One provider's price row. */
function priceRow(section, provider) {
  const offer = provider.offer || {};
  const unit = readString(section.priceUnit).replace(/s$/, '') || 'unit';
  return `<tr data-capability-offer="${escapeHtmlAttribute(provider.providerId)}">
      <td>${escapeHtml(readString(provider.displayName) || provider.providerId)}</td>
      <td>${escapeHtml(PAYERS[provider.costClass] || 'no cost class')}</td>
      <td>${provider.available ? 'yes' : escapeHtml(`no — ${readString(provider.detail) || provider.missing || ''}`)}</td>
      <td><input data-offer-price type="number" min="0" step="any" value="${offer.unitPriceUsd ?? ''}" aria-label="USD per ${escapeHtmlAttribute(unit)} for ${escapeHtmlAttribute(provider.providerId)}" placeholder="USD per ${escapeHtmlAttribute(unit)}"></td>
      <td><input data-offer-label type="text" maxlength="120" value="${escapeHtmlAttribute(offer.quotaLabel || '')}" placeholder="e.g. shared free tier"></td>
      <td><button type="button" data-capability-offer-save="${escapeHtmlAttribute(provider.providerId)}">Save price</button></td>
    </tr>`;
}

/**
 * @description The markup of one capability's form.
 * @param {object} section - One capability section from the listing.
 * @returns {string} The markup.
 */
export function capabilitySectionMarkup(section) {
  const cap = section.capability;
  const voice = cap === 'tts'
    ? `<label class="field"><span>Voice</span><input data-capability-voice type="text" value="${escapeHtmlAttribute(section.swarmDefault?.source === 'row' ? section.swarmDefault.voice || '' : '')}" placeholder="the provider's own default voice"></label>`
    : '';
  const prices = (section.providers || []).map((p) => priceRow(section, p)).join('');
  return `<form class="config-form" data-capability-form="${escapeHtmlAttribute(cap)}">
    <h3 class="field-wide">${escapeHtml(TITLES[cap] || cap)}</h3>
    <label class="field"><span>Swarm default</span>${providerSelect(section)}</label>${voice}
    <span class="field-copy field-wide" data-capability-status>${escapeHtml(defaultSentence(section))}</span>
    <div class="agent-config-actions field-wide">
      <button type="submit">Save ${escapeHtml(TITLES[cap] || cap)} default</button>
      <button type="button" data-capability-clear="${escapeHtmlAttribute(cap)}"${section.swarmDefault?.source === 'row' ? '' : ' disabled'}>Clear</button>
    </div>
    <table class="field-wide"><thead><tr><th>Provider</th><th>Who pays</th><th>Usable now</th><th>Unit price (USD per ${escapeHtml(readString(section.priceUnit).replace(/s$/, '') || 'unit')})</th><th>Quota label</th><th></th></tr></thead><tbody>${prices}</tbody></table>
  </form>`;
}

/**
 * @description Render the capability panel from state.
 * @param {object} app - The config-admin app.
 * @returns {void}
 */
export function renderCapabilityProvidersPanel(app) {
  const host = app.elements.capabilityProvidersPanel;
  if (!host) return;
  const state = app.state.capabilityProviders || { sections: [], error: 'Not loaded' };
  if (state.error) {
    host.innerHTML = `<div class="empty-state">Capability providers unavailable: ${escapeHtml(state.error)}</div>`;
    return;
  }
  host.innerHTML = state.sections.map(capabilitySectionMarkup).join('');
}

/** @description Re-read the listing and re-render after a write. */
async function reload(app) {
  await loadCapabilityProviders(app);
  renderCapabilityProvidersPanel(app);
}

/**
 * @description Save one capability's swarm default: ONE write; the API validates and its reason is shown verbatim.
 * @param {object} app - The config-admin app.
 * @param {string} capability - tts, stt, image or video.
 * @returns {Promise<void>}
 */
export async function saveCapabilityDefault(app, capability) {
  const form = app.elements.capabilityProvidersPanel?.querySelector(`[data-capability-form="${capability}"]`);
  const providerId = readString(form?.querySelector('[data-capability-provider]')?.value);
  const voice = readString(form?.querySelector('[data-capability-voice]')?.value);
  if (!providerId) {
    app.setStatus(`Choose a provider for the ${TITLES[capability] || capability} swarm default, or use Clear.`, 'error');
    return;
  }
  try {
    const body = await requestJson(`${ENDPOINT}/swarm/${encodeURIComponent(capability)}`, { method: 'PUT', body: JSON.stringify({ providerId, ...(voice ? { voice } : {}) }) });
    const usable = body.availability && body.availability.available === false ? ` It is not usable right now: ${body.availability.detail}` : '';
    app.setStatus(`${TITLES[capability] || capability} swarm default is now ${providerId} — the next call uses it, no restart.${usable}`, usable ? 'error' : 'success');
    await reload(app);
  } catch (error) {
    logger.error('Capability default write failed', serializeUiError(error));
    app.setStatus(`${TITLES[capability] || capability} swarm default not changed: ${error?.message || error}`, 'error');
  }
}

/**
 * @description Clear one capability's swarm row, so the config or selector decides again.
 * @param {object} app - The config-admin app.
 * @param {string} capability - The capability.
 * @returns {Promise<void>}
 */
export async function clearCapabilityDefault(app, capability) {
  try {
    await requestJson(`${ENDPOINT}/swarm/${encodeURIComponent(capability)}`, { method: 'DELETE' });
    app.setStatus(`${TITLES[capability] || capability} swarm default cleared — the config or selector decides again.`, 'success');
    await reload(app);
  } catch (error) {
    logger.error('Capability default clear failed', serializeUiError(error));
    app.setStatus(`${TITLES[capability] || capability} swarm default not cleared: ${error?.message || error}`, 'error');
  }
}

/**
 * @description Save one provider's unit price and quota label. An empty price clears it.
 * @param {object} app - The config-admin app.
 * @param {string} capability - The capability.
 * @param {string} providerId - The provider.
 * @returns {Promise<void>}
 */
export async function saveCapabilityOffer(app, capability, providerId) {
  const form = app.elements.capabilityProvidersPanel?.querySelector(`[data-capability-form="${capability}"]`);
  const row = form?.querySelector(`[data-capability-offer="${providerId}"]`);
  const priceText = readString(row?.querySelector('[data-offer-price]')?.value).trim();
  const label = readString(row?.querySelector('[data-offer-label]')?.value).trim();
  const unitPriceUsd = priceText === '' ? null : Number(priceText);
  if (unitPriceUsd !== null && !Number.isFinite(unitPriceUsd)) {
    // JSON would turn NaN into null, which clears the price: refuse in place instead.
    app.setStatus(`${providerId} price not saved: "${priceText}" is not a number of USD per unit.`, 'error');
    return;
  }
  try {
    await requestJson(`${ENDPOINT}/offers/${encodeURIComponent(capability)}/${encodeURIComponent(providerId)}`, {
      method: 'PUT', body: JSON.stringify({ unitPriceUsd, quotaLabel: label || null }),
    });
    app.setStatus(`${providerId}: ${unitPriceUsd === null ? 'no price — calls are recorded at zero' : `USD ${unitPriceUsd} per unit from the next call`}.`, 'success');
    await reload(app);
  } catch (error) {
    logger.error('Capability offer write failed', serializeUiError(error));
    app.setStatus(`${providerId} price not saved: ${error?.message || error}`, 'error');
  }
}

/**
 * @description Wire the panel's form submits and buttons (event delegation on the panel host).
 * @param {object} app - The config-admin app.
 * @returns {void}
 */
export function bindCapabilityProvidersPanel(app) {
  const host = app.elements.capabilityProvidersPanel;
  if (!host) return;
  host.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-capability-form]');
    if (!form) return;
    event.preventDefault();
    await saveCapabilityDefault(app, form.dataset.capabilityForm);
  });
  host.addEventListener('click', async (event) => {
    const clear = event.target.closest('[data-capability-clear]');
    if (clear) { event.preventDefault(); await clearCapabilityDefault(app, clear.dataset.capabilityClear); return; }
    const save = event.target.closest('[data-capability-offer-save]');
    if (save) {
      event.preventDefault();
      await saveCapabilityOffer(app, save.closest('[data-capability-form]')?.dataset.capabilityForm, save.dataset.capabilityOfferSave);
    }
  });
}

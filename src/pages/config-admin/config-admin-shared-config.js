/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CM-6: Extracted shared config form rendering and save from config-admin.js (1277 → <1000 decomposition)
 */

import { escapeHtml, readString } from './config-admin-utils.js';

// ── Shared Config Form ──────────────────────────────────────────────────────

/**
 * @description Populate provider dropdowns using the live provider registry.
 */
export function renderProviderOptions(select, providers, selectedValue) {
  select.innerHTML = providers.map((provider) => {
    const selected = provider.id === selectedValue ? ' selected' : '';
    const label = readString(provider.displayName || provider.name || provider.id);
    return `<option value="${escapeHtml(provider.id)}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');

  if (!selectedValue && providers[0]) {
    select.value = providers[0].id;
  }
}

/**
 * @description Populate shared config form fields from loaded state.
 */
export function renderSharedConfigForm(elements, config) {
  renderProviderOptions(elements.planProviderSelect, [], config.planModeApiProvider);
  renderProviderOptions(elements.actProviderSelect, [], config.actModeApiProvider);
  elements.planeUrlInput.value = readString(config.planeUrl);
  elements.redisUrlInput.value = readString(config.redisUrl);
  elements.gitRepoUrlInput.value = readString(config.gitRepoUrl);
  elements.codeServerWorkspaceRootInput.value = readString(config.codeServerWorkspaceRoot);
  elements.apiKeyInput.value = readString(config.apiKey);
}

/**
 * @description Build the shared config payload from the page form controls.
 */
export function buildSharedConfigPayload(elements) {
  return {
    actModeApiProvider: elements.actProviderSelect.value,
    apiKey: elements.apiKeyInput.value,
    codeServerWorkspaceRoot: elements.codeServerWorkspaceRootInput.value,
    gitRepoUrl: elements.gitRepoUrlInput.value,
    planeUrl: elements.planeUrlInput.value,
    planModeApiProvider: elements.planProviderSelect.value,
    redisUrl: elements.redisUrlInput.value,
  };
}

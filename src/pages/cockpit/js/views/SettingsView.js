/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Remapped cockpit settings to mounted OSHAL config/provider endpoints and removed dead legacy settings requests
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wired Session 69 toast handling for bot-tool interactions and removed the remaining settings-save console warning
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added Session 70 config ownership explainer backed by /api/config/ownership and normalized /api/config response handling
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Corrected provider labels to prefer displayName so config/admin surfaces render readable provider names consistently
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added richer bot-settings profile management and deep links into the native per-bot /config experience
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added stable test ids for the split bot-settings edit and open-config actions
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Updated bot settings deep links to open /config in agent-scoped mode for selected-bot-first workflows
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added provider-driven model selection and OpenAI Codex OAuth controls to global cockpit settings with persisted plan/act model wiring
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Reframed Global Settings as a shared swarm runtime surface with live RAG/Presentron/Search MCP config and health visibility
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed global-tab and bot-tab controllers out of SettingsView to bring the file back under the governance cap
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Hardening-backlog #13: the model-selector last-resort fallback no longer hardcodes the codex-only `gpt-5.3-codex` (which fails under a non-codex provider lacking codex auth); falls back to '' (no explicit model → backend uses the provider's own default). The per-provider catalogs keep codex models correctly scoped under openai-codex.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the retired Presentron + deprecated Google Search MCP config loads and health probes from Global Settings; RAG remains the only shared service-runtime surface
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Added a first-class "Knowledge" (RAG) settings tab (SettingsKnowledgeTab): ingestion tool + permission-aware visibility, replacing the flaky embedded-chat RAG popup. Data-driven tab bar honors a one-shot deep-link tab hint so the cockpit header RAG icon lands directly on Knowledge
 */

import { ApiClient } from '../api-client.js';
import { createUiLogger, serializeUiError } from '../../../shared/ui-debug.js';
import { SettingsGlobalTab } from './SettingsGlobalTab.js';
import { SettingsBotsTab } from './SettingsBotsTab.js';
import { SettingsKnowledgeTab } from './SettingsKnowledgeTab.js';

const logger = createUiLogger('cockpit-settings-view');

// Tabs the settings shell renders; also the allow-list for the deep-link tab hint.
const SETTINGS_TABS = [
  ['global', 'Global Settings'],
  ['bots', 'Bot Settings'],
  ['knowledge', 'Knowledge'],
  ['connections', 'Connections'],
];

/**
 * @description Cockpit settings view backed by mounted OSHAL configuration and provider routes.
 */
export class SettingsView {
  /**
   * @description Create the settings view for the cockpit ribbon.
   *
   * @param {HTMLElement|string} container - Target container element or its id.
   * @param {object} options - Optional callbacks for theme updates and toasts.
   * @returns {void}
   */
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.api = new ApiClient();
    // A header handoff can request a specific tab (e.g. the RAG icon → Knowledge) via a one-shot
    // sessionStorage hint; otherwise default to Global.
    this.currentTab = readPendingSettingsTab() || 'global';
    this.settings = {};
    this.agents = [];
    this.providers = [];
    this.configOwnership = null;
    this.ragServiceConfig = {};
    this.serviceHealth = SettingsGlobalTab.createDefaultServiceHealthState();
    this.onThemeChange = options.onThemeChange || null;
    this.showToast = options.onToast || (() => {});
    this.openAiCodexAuthState = createPendingOpenAiCodexAuthState();
    this.openAiCodexAuthPollToken = 0;
    logger.info('Created cockpit settings view', {
      hasContainer: Boolean(this.container),
    });
  }

  /**
   * @description Render the settings shell, load data, and show the active tab.
   *
   * @returns {Promise<void>}
   */
  async render() {
    if (!this.container) {
      return;
    }

    logger.info('Rendering cockpit settings view', {
      currentTab: this.currentTab,
    });

    const tabButtons = SETTINGS_TABS
      .map(([id, label]) => `<button class="settings-tab${this.currentTab === id ? ' active' : ''}" data-tab="${id}">${label}</button>`)
      .join('');
    this.container.innerHTML = `
      <div class="settings-view">
        <div class="settings-tabs">${tabButtons}</div>
        <div class="settings-content" id="settingsBody"></div>
      </div>`;

    this.bindTabButtons();
    await this._loadData();
    this._renderTab();
  }

  /**
   * @description Load the mounted shared config, agent list, provider catalog, and service-runtime state used by the settings screen.
   *
   * @returns {Promise<void>}
   */
  async _loadData() {
    logger.debug('Loading cockpit settings view data');
    const results = await Promise.allSettled([
      this.api.getSafe('/api/config', {}),
      this.api.getAgents(),
      this.api.getSafe('/api/providers', []),
      this.api.getSafe('/api/config/ownership', null),
      this.api.getSafe('/api/config/rag', { config: {} }),
      this.loadServiceHealth(),
    ]);

    this.settings = readConfigResult(results[0], {});
    this.agents = readAgentsResult(results[1]);
    this.providers = readConfigResult(results[2], []);
    this.configOwnership = readOwnershipResult(results[3]);
    this.ragServiceConfig = readConfigResult(results[4], {});
    this.serviceHealth = readServiceHealthResult(results[5]);
    logger.info('Loaded cockpit settings view data', {
      agentCount: this.agents.length,
      providerCount: this.providers.length,
      hasConfigOwnership: Boolean(this.configOwnership),
    });
  }

  /**
   * @description Render the currently selected settings tab.
   *
   * @returns {void}
   */
  _renderTab() {
    const body = this.container?.querySelector('#settingsBody');
    if (!body) {
      return;
    }

    logger.debug('Rendering cockpit settings tab', {
      currentTab: this.currentTab,
    });
    if (this.currentTab === 'global') {
      new SettingsGlobalTab(this, body).render();
      return;
    }

    if (this.currentTab === 'knowledge') {
      // The first-class RAG surface: ingestion tool + permission-aware visibility (swarm/bot/private).
      new SettingsKnowledgeTab(this, body).render();
      return;
    }

    if (this.currentTab === 'connections') {
      // Connect external accounts (Google, Facebook) + bot LLM access (Claude
      // Code). Embeds the connectors hub so config lives in one Settings home;
      // Claude Code here propagates to every bot (the OSHAL→bot config loop).
      body.innerHTML = '<iframe src="/utilities" title="Connections" style="width:100%;height:72vh;border:none;border-radius:8px;"></iframe>';
      return;
    }

    new SettingsBotsTab(this, body).render();
  }

  /**
   * @description Resolve the currently selected shared provider id from persisted config or provider catalog fallback.
   *
   * @returns {string} Selected provider id.
   */
  _resolveSelectedProviderId() {
    const configuredProvider = this.settings.actModeApiProvider || this.settings.planModeApiProvider;
    if (configuredProvider && typeof configuredProvider === 'string' && configuredProvider !== 'auto') {
      return configuredProvider;
    }
    // When provider is 'auto' or missing, fall back to LLM_PROVIDER env (exposed via settings)
    // rather than picking the first catalog entry — keeps UI consistent with runtime behavior.
    const envProvider = this.settings.llmProvider;
    if (envProvider && typeof envProvider === 'string') {
      return envProvider;
    }
    if (this.providers[0]?.id) {
      return this.providers[0].id;
    }
    return 'openai-codex';
  }

  /**
   * @description Resolve the currently selected shared model id for one provider.
   *
   * @param {string} providerId - Provider to resolve against.
   * @returns {string} Selected model id.
   */
  _resolveSelectedModelId(providerId) {
    const configuredModel = this.settings.actModeApiModelId || this.settings.planModeApiModelId || this.settings.apiModelId;
    if (configuredModel && typeof configuredModel === 'string' && configuredModel !== 'auto') {
      return configuredModel;
    }
    // When model is 'auto' or missing, fall back to LLM_MODEL env (exposed via settings)
    const envModel = this.settings.llmModel;
    if (envModel && typeof envModel === 'string') {
      return envModel;
    }
    const providerMeta = this._resolveProviderMetadata(providerId);
    return providerMeta?.defaultModelId || providerMeta?.models?.[0]?.id || '';
  }

  /**
   * @description Find provider metadata for one provider id.
   *
   * @param {string} providerId - Provider to search for.
   * @returns {object|undefined} Matching provider metadata, if present.
   */
  _resolveProviderMetadata(providerId) {
    return this.providers.find((item) => item.id === providerId);
  }

  /**
   * @description Render the provider-specific model options for the model selector.
   *
   * @param {string} providerId - Provider currently selected.
   * @param {string} selectedModelId - Model that should appear selected.
   * @returns {string} HTML option markup for the model selector.
   */
  _renderProviderModelOptions(providerId, selectedModelId) {
    const providerMeta = this._resolveProviderMetadata(providerId);
    const models = Array.isArray(providerMeta?.models) ? providerMeta.models : [];
    if (!models.length) {
      const fallbackValue = selectedModelId || providerMeta?.defaultModelId || '';
      return `<option value="${escapeHtmlAttribute(fallbackValue)}" selected>${escapeHtml(fallbackValue)}</option>`;
    }

    const preferredModelId = selectedModelId || providerMeta?.defaultModelId || models[0]?.id || '';
    return models.map((model) => renderModelOption(model, preferredModelId)).join('');
  }

  /**
   * @description Read the selected provider id from the current tab body.
   *
   * @param {HTMLElement} body - Active tab body element.
   * @param {string} fallbackProviderId - Provider to use if the selector is missing.
   * @returns {string} Selected provider id.
   */
  _readSelectedProviderFromBody(body, fallbackProviderId) {
    return body.querySelector('#settingsProvider')?.value || fallbackProviderId;
  }

  /**
   * @description Read the selected model id from the current tab body.
   *
   * @param {HTMLElement} body - Active tab body element.
   * @param {string} providerId - Provider used to resolve the fallback model.
   * @returns {string} Selected model id.
   */
  _readSelectedModelFromBody(body, providerId) {
    const modelSelect = body.querySelector('#settingsModel');
    if (modelSelect?.value) {
      return modelSelect.value;
    }
    return this._resolveSelectedModelId(providerId);
  }

  /**
   * @description Re-render the model selector when the provider changes.
   *
   * @param {HTMLElement} body - Active tab body element.
   * @param {string} providerId - Newly selected provider id.
   * @returns {void}
   */
  _updateModelSelectionForProvider(body, providerId) {
    const modelSelect = body.querySelector('#settingsModel');
    if (!modelSelect) {
      return;
    }
    const nextModelId = this._resolveSelectedModelId(providerId);
    modelSelect.innerHTML = this._renderProviderModelOptions(providerId, nextModelId);
  }

  /**
   * @description Apply the current OpenAI Codex OAuth state to the visible auth controls.
   *
   * @param {HTMLElement} body - Active tab body element.
   * @returns {void}
   */
  _applyOpenAiCodexAuthState(body) {
    const infoNode = body.querySelector('#settingsOpenAiCodexAuthInfo');
    const statusNode = body.querySelector('#settingsOpenAiCodexAuthStatus');
    const signInButton = body.querySelector('#settingsOpenAiCodexSignInBtn');
    const signOutButton = body.querySelector('#settingsOpenAiCodexSignOutBtn');
    if (!infoNode || !statusNode || !signInButton || !signOutButton) {
      return;
    }

    infoNode.textContent = this.openAiCodexAuthState.infoText;
    statusNode.textContent = this.openAiCodexAuthState.label;
    statusNode.dataset.tone = this.openAiCodexAuthState.tone;
    signInButton.hidden = !this.openAiCodexAuthState.canSignIn;
    signOutButton.hidden = !this.openAiCodexAuthState.canSignOut;
  }

  /**
   * @description Refresh the OpenAI Codex OAuth status badge based on the selected provider.
   *
   * @param {HTMLElement} body - Active tab body element.
   * @param {boolean} suppressToast - When true, status failures do not toast the user.
   * @returns {Promise<void>}
   */
  async _refreshOpenAiCodexAuthStatus(body, suppressToast = false) {
    const selectedProviderId = this._readSelectedProviderFromBody(body, this._resolveSelectedProviderId());
    logger.debug('Refreshing cockpit OpenAI Codex auth status', {
      providerId: selectedProviderId,
      suppressToast,
    });
    if (selectedProviderId !== 'openai-codex') {
      this.openAiCodexAuthState = createUnsupportedOpenAiCodexAuthState(selectedProviderId);
      this._applyOpenAiCodexAuthState(body);
      return;
    }

    this.openAiCodexAuthState = createPendingOpenAiCodexAuthState();
    this._applyOpenAiCodexAuthState(body);
    try {
      const payload = await this.api.get('/api/openai-codex/oauth/status');
      this.openAiCodexAuthState = createResolvedOpenAiCodexAuthState(payload);
      logger.info('Refreshed cockpit OpenAI Codex auth status', {
        authenticated: this.openAiCodexAuthState.authenticated,
      });
    } catch (error) {
      logger.error('Failed to refresh cockpit OpenAI Codex auth status', {
        error: serializeUiError(error),
      });
      this.openAiCodexAuthState = createOpenAiCodexAuthErrorState(error);
      if (!suppressToast) {
        this.showToast(`Failed to read OpenAI Codex auth status: ${error.message}`, 'error');
      }
    }
    this._applyOpenAiCodexAuthState(body);
  }

  /**
   * @description Start the OpenAI Codex OAuth sign-in flow from cockpit settings.
   *
   * @param {HTMLElement} body - Active tab body element.
   * @returns {Promise<void>}
   */
  async _startOpenAiCodexAuthFlow(body) {
    const selectedProviderId = this._readSelectedProviderFromBody(body, this._resolveSelectedProviderId());
    if (selectedProviderId !== 'openai-codex') {
      this.showToast('Select OpenAI Codex as provider before starting OAuth sign-in.', 'info');
      return;
    }

    const pollToken = ++this.openAiCodexAuthPollToken;
    logger.info('Starting cockpit OpenAI Codex auth flow');
    try {
      const result = await this.api.get('/api/openai-codex/oauth/start');
      await openOAuthPopupOrRedirect(result?.authUrl);
      this.showToast('OpenAI Codex sign-in started', 'info');
      this.openAiCodexAuthState = createPendingOpenAiCodexAuthState('Waiting for OAuth completion...', 'Waiting for sign-in to finish...');
      this._applyOpenAiCodexAuthState(body);
      await this._pollOpenAiCodexAuthStatus(body, pollToken);
    } catch (error) {
      logger.error('Failed to start cockpit OpenAI Codex auth flow', {
        error: serializeUiError(error),
      });
      this.openAiCodexAuthState = createOpenAiCodexAuthErrorState(error);
      this._applyOpenAiCodexAuthState(body);
      this.showToast(`Failed to start OpenAI Codex sign-in: ${error.message}`, 'error');
    }
  }

  /**
   * @description Poll for completion of the OpenAI Codex OAuth callback.
   *
   * @param {HTMLElement} body - Active tab body element.
   * @param {number} pollToken - Token that invalidates stale poll loops.
   * @returns {Promise<void>}
   */
  async _pollOpenAiCodexAuthStatus(body, pollToken) {
    const pollStart = Date.now();
    logger.debug('Polling cockpit OpenAI Codex auth status', {
      pollToken,
    });
    while (Date.now() - pollStart < 180000) {
      await delay(2000);
      if (this.openAiCodexAuthPollToken !== pollToken) {
        return;
      }
      await this._refreshOpenAiCodexAuthStatus(body, true);
      if (this.openAiCodexAuthState.authenticated) {
        logger.info('Cockpit OpenAI Codex auth flow completed', {
          pollToken,
        });
        this.showToast('OpenAI Codex sign-in complete', 'success');
        return;
      }
    }

    if (this.openAiCodexAuthPollToken === pollToken) {
      logger.warn('Cockpit OpenAI Codex auth flow timed out', {
        pollToken,
      });
      this.showToast('OpenAI Codex sign-in timed out', 'error');
    }
  }

  /**
   * @description Remove the saved OpenAI Codex OAuth credentials for the active OSHAL session.
   *
   * @param {HTMLElement} body - Active tab body element.
   * @returns {Promise<void>}
   */
  async _signOutOpenAiCodexAuth(body) {
    const selectedProviderId = this._readSelectedProviderFromBody(body, this._resolveSelectedProviderId());
    if (selectedProviderId !== 'openai-codex') {
      this.showToast('Select OpenAI Codex as provider to sign out OAuth credentials.', 'info');
      return;
    }

    logger.info('Signing out cockpit OpenAI Codex auth');
    try {
      await postEmptyJson('/api/openai-codex/oauth/signout');
      this.showToast('OpenAI Codex credentials removed', 'success');
      await this._refreshOpenAiCodexAuthStatus(body, true);
    } catch (error) {
      logger.error('Failed to sign out cockpit OpenAI Codex auth', {
        error: serializeUiError(error),
      });
      this.openAiCodexAuthState = createOpenAiCodexAuthErrorState(error);
      this._applyOpenAiCodexAuthState(body);
      this.showToast(`Failed to sign out OpenAI Codex credentials: ${error.message}`, 'error');
    }
  }

  /**
   * @description Refresh the visible cost cards after limits or spend totals change.
   *
   * @returns {void}
   */
  _updateCostDisplay() {
    const costStatus = this.api.getCostStatus();
    logger.debug('Updating cockpit settings cost display', {
      dailySpent: costStatus.dailySpent,
      bucketSpent: costStatus.bucketSpent,
    });
    updateCostCard('costDailySpent', costStatus.dailySpent, costStatus.dailyLimit);
    updateCostCard('costBucketSpent', costStatus.bucketSpent, costStatus.bucketLimit);
  }

  /**
   * @description Clean up listeners and DOM state owned by the settings view.
   *
   * @returns {void}
   */
  destroy() {
    logger.info('Destroying cockpit settings view');
    if (this.costUpdateHandler) {
      window.removeEventListener('cost-updated', this.costUpdateHandler);
    }
    if (this.container) {
      this.container.innerHTML = '';
    }
  }

  /**
   * @description Load live service health for the shared runtime dependencies.
   *
   * @returns {Promise<object>} Health state for shared runtime dependencies.
   */
  async loadServiceHealth() {
    logger.debug('Loading cockpit shared service health');
    const [ragRes] = await Promise.all([
      this.api.getSafe('/api/rag/health', { chromadb: 'unknown' }),
    ]);

    const serviceHealth = {
      rag: createServiceHealthEntry(
        ragRes?.chromadb || 'unknown',
        ragRes?.chromadb === 'connected' ? 'Vector store is reachable for shared swarm knowledge.' : 'Vector store is not reachable from the current runtime.',
        'GET /api/rag/health',
      ),
    };
    logger.info('Loaded cockpit shared service health', {
      ragStatus: serviceHealth.rag.status,
    });
    return serviceHealth;
  }

  // Bind the shell-level tab buttons once after the container renders.
  bindTabButtons() {
    this.container.querySelectorAll('.settings-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        logger.info('Switching cockpit settings tab', {
          from: this.currentTab,
          to: tab.dataset.tab,
        });
        this.container.querySelectorAll('.settings-tab').forEach((item) => item.classList.remove('active'));
        tab.classList.add('active');
        this.currentTab = tab.dataset.tab;
        this._renderTab();
      });
    });
  }
}

// Read (and consume) the one-shot deep-link tab hint set by a header handoff. Only a known tab id
// is honored; anything else falls through to the default. Cleared immediately so a later plain
// Settings open lands on Global.
function readPendingSettingsTab() {
  try {
    const value = sessionStorage.getItem('cockpit-settings-tab');
    if (value) {
      sessionStorage.removeItem('cockpit-settings-tab');
    }
    return SETTINGS_TABS.some(([id]) => id === value) ? value : '';
  } catch (error) {
    return '';
  }
}

// Normalize a settled config result to a config object or fallback.
function readConfigResult(result, fallback) {
  if (result.status !== 'fulfilled' || !result.value) {
    return fallback;
  }
  return result.value.config || result.value;
}

// Normalize a settled agent list result to an array of agents.
function readAgentsResult(result) {
  if (result.status !== 'fulfilled' || !result.value) {
    return [];
  }
  return result.value.agents || result.value || [];
}

// Normalize a settled ownership result to the ownership contract or null.
function readOwnershipResult(result) {
  if (result.status !== 'fulfilled' || !result.value) {
    return null;
  }
  return result.value.ownership || result.value;
}

// Normalize a settled service-health result to a usable health model.
function readServiceHealthResult(result) {
  return result.status === 'fulfilled' && result.value
    ? result.value
    : SettingsGlobalTab.createDefaultServiceHealthState();
}

// Render one model option for the provider-driven selector.
function renderModelOption(model, preferredModelId) {
  const modelId = model.id || '';
  const modelLabel = model.name || model.id || 'Unnamed Model';
  const selected = modelId === preferredModelId ? ' selected' : '';
  return `<option value="${escapeHtmlAttribute(modelId)}"${selected}>${escapeHtml(modelLabel)}</option>`;
}

// Build a resolved OpenAI Codex auth state from the status payload.
function createResolvedOpenAiCodexAuthState(payload) {
  const authenticated = !!payload?.authenticated;
  const emailSuffix = payload?.email ? ` as ${payload.email}` : '';
  return {
    authenticated,
    canSignIn: !authenticated,
    canSignOut: authenticated,
    infoText: 'OpenAI Codex OAuth credentials are scoped to your authenticated OSHAL session and synced into runtime on callback.',
    label: authenticated ? `Signed in${emailSuffix}` : 'Not signed in',
    tone: authenticated ? 'success' : 'info',
  };
}

// Open the OAuth popup when possible, otherwise redirect the top window.
async function openOAuthPopupOrRedirect(authUrl, windowName = 'openai-codex-auth') {
  if (!authUrl) {
    return;
  }
  const popup = window.open(authUrl, windowName, 'width=620,height=780');
  if (!popup) {
    window.location.assign(authUrl);
  }
}

// POST an empty JSON body to one route and throw on non-OK results.
async function postEmptyJson(endpoint) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
}

// Update one cost card value and limit label.
function updateCostCard(valueId, spent, limit) {
  const valueNode = document.getElementById(valueId);
  if (!valueNode) {
    return;
  }
  const card = valueNode.closest('.cost-status-card');
  const limitNode = card?.querySelector('.cost-status-limit');
  valueNode.textContent = `$${spent.toFixed(4)}`;
  if (limitNode) {
    limitNode.textContent = limit ? `of $${limit.toFixed(2)} limit` : 'No limit set';
  }
}

// Create a stable pending OpenAI Codex OAuth state.
function createPendingOpenAiCodexAuthState(
  infoText = 'Select OpenAI Codex as provider to manage OAuth sign-in from cockpit.',
  label = 'Checking authentication...',
) {
  return {
    authenticated: false,
    canSignIn: false,
    canSignOut: false,
    infoText,
    label,
    tone: 'info',
  };
}

// Build an unsupported state when provider selection is not OpenAI Codex.
function createUnsupportedOpenAiCodexAuthState(providerId) {
  const providerLabel = providerId || 'the selected provider';
  return {
    authenticated: false,
    canSignIn: false,
    canSignOut: false,
    infoText: `OpenAI Codex OAuth controls are only active when provider is set to openai-codex. Current provider: ${providerLabel}.`,
    label: 'OpenAI Codex auth inactive for this provider',
    tone: 'muted',
  };
}

// Build an error state for OpenAI Codex OAuth failures.
function createOpenAiCodexAuthErrorState(error) {
  return {
    authenticated: false,
    canSignIn: true,
    canSignOut: false,
    infoText: 'OpenAI Codex OAuth status failed. Retry sign-in after confirming provider selection.',
    label: error instanceof Error ? error.message : String(error),
    tone: 'error',
  };
}

// Delay helper used while polling OAuth callback completion.
function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

// Create a service-health entry for one runtime dependency.
function createServiceHealthEntry(status, detail, target) {
  return {
    status,
    statusLabel: status === 'connected' ? 'Connected' : status === 'unreachable' ? 'Unreachable' : 'Unknown',
    statusTone: status === 'connected' ? 'success' : status === 'unreachable' ? 'error' : 'muted',
    detail,
    target,
  };
}

// Escape HTML before rendering text into an attribute.
function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Escape HTML before rendering text into element content.
function escapeHtml(value) {
  return escapeHtmlAttribute(value);
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added OSHAL-native config admin browser logic for shared config, ownership guidance, and agent route summaries
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Corrected provider option labels to prefer displayName and support functional config save-reload validation
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added native per-bot config loading, profile saves, and tool auth updates with agent-focused /config deep links
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added bot-scoped config view mode so /config links can open directly into per-agent settings context
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added try/catch error handling to all async methods to prevent permanent UI freezes on API failures
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added shared Presentron runtime config and health controls so service-backed workspaces can hand off to one canonical config screen
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added shared code-server workspace-root config so swarm operators can align code-server mount paths like /usr/workspace with cockpit artifact handoff
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Fixed buildClaudeCodeAuthState: show Sign In button even when authenticated via api_key so users can upgrade to OAuth without signing out first
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Sign In always visible for claude-code: PKCE OAuth does not require CLI availability, removed available gate from canSignIn
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Rebased per-bot config theme choices onto the shared cockpit theme catalog so Config Admin matches cockpit and swarm workspace options
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | CM-6: Decomposed 1277-line file into orchestrator + 4 modules; added RAG + Google Search MCP service runtime sections
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Removed the retired Presentron + deprecated Google Search MCP service-runtime sections (wiring, state, load, render); RAG runtime config retained
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';
import {
  fetchJson, postJson, requestJson,
  readString, readRecord, readSelectedAgentIdFromUrl, readScopeFromUrl,
  resolveSelectedAgentId, resolveInitialSelectedAgentId,
  toErrorMessage, setText, countItems,
} from './config-admin-utils.js';
import { renderProviderOptions, buildSharedConfigPayload } from './config-admin-shared-config.js';
import {
  renderRagRuntimeForm, saveRagRuntimeConfig, testRagRuntimeConnection, updateRagTierVisibility,
} from './config-admin-service-runtimes.js';
import { loadAgentRuntimeConfig, saveAgentRuntimeConfig } from './agent-runtime-config.js';
import {
  createPendingAuthState, renderModelOptionMarkup,
  loadSelectedAgentDetails, saveSelectedAgentProfile, applyBulkTemplate,
  updateSelectedToolAuthMode, renderSelectedAgentPanelMarkup,
  renderSelectedAgentAuthState, refreshSelectedAgentAuthStatus,
  startSelectedAgentAuth, signOutSelectedAgentAuth,
  renderAgentCards, renderOwnershipCards,
} from './config-admin-agent-panel.js';

const logger = createUiLogger('config-admin');

class ConfigAdminApp {
  constructor() {
    this.state = {
      ownership: null,
      config: {},
      ragConfig: {},
      providers: [],
      agents: [],
      selectedAgentId: readSelectedAgentIdFromUrl(),
      viewScope: readScopeFromUrl(),
      selectedAgentAuth: createPendingAuthState(),
      selectedAgentProfile: null,
      selectedAgentTools: [],
      selectedAgentRuntimeConfig: null,
    };

    this.elements = {
      actProviderSelect: document.getElementById('actProviderSelect'),
      agentConfigHeading: document.getElementById('agentConfigHeading'),
      agentList: document.getElementById('agentList'),
      apiKeyInput: document.getElementById('apiKeyInput'),
      codeServerWorkspaceRootInput: document.getElementById('codeServerWorkspaceRootInput'),
      gitRepoUrlInput: document.getElementById('gitRepoUrlInput'),
      ownershipGrid: document.getElementById('ownershipGrid'),
      planeUrlInput: document.getElementById('planeUrlInput'),
      planProviderSelect: document.getElementById('planProviderSelect'),
      // RAG
      ragConfigEndpointInput: document.getElementById('ragConfigEndpointInput'),
      ragConfigDefaultCollectionInput: document.getElementById('ragConfigDefaultCollectionInput'),
      ragConfigEmbeddingProviderInput: document.getElementById('ragConfigEmbeddingProviderInput'),
      ragConfigEmbeddingModelInput: document.getElementById('ragConfigEmbeddingModelInput'),
      ragConfigChunkStrategySelect: document.getElementById('ragConfigChunkStrategySelect'),
      ragConfigChunkSizeInput: document.getElementById('ragConfigChunkSizeInput'),
      ragConfigChunkOverlapInput: document.getElementById('ragConfigChunkOverlapInput'),
      ragConfigTierSizesInput: document.getElementById('ragConfigTierSizesInput'),
      ragConfigTierOverlapsInput: document.getElementById('ragConfigTierOverlapsInput'),
      ragTierFieldsWrap: document.getElementById('ragTierFieldsWrap'),
      ragTierOverlapsWrap: document.getElementById('ragTierOverlapsWrap'),
      ragRuntimeForm: document.getElementById('ragRuntimeForm'),
      ragRuntimeStatus: document.getElementById('ragRuntimeStatus'),
      testRagRuntimeBtn: document.getElementById('testRagRuntimeBtn'),
      // General
      redisUrlInput: document.getElementById('redisUrlInput'),
      refreshButton: document.getElementById('refreshButton'),
      selectedAgentPanel: document.getElementById('selectedAgentPanel'),
      sharedConfigForm: document.getElementById('sharedConfigForm'),
      statusBanner: document.getElementById('statusBanner'),
    };
  }

  async init() {
    logger.info('Initializing config admin', {
      viewScope: this.state.viewScope,
      selectedAgentId: this.state.selectedAgentId || null,
    });
    this.bindEvents();
    document.body.dataset.scope = this.state.viewScope;
    await this.loadAll();
    const selectedAgentId = resolveInitialSelectedAgentId(
      this.state.selectedAgentId, this.state.viewScope, this.state.agents,
    );
    if (selectedAgentId) {
      await loadSelectedAgentDetails(this, selectedAgentId);
    }
    if (this.state.viewScope === 'agent') {
      this.focusAgentConfigSection();
    }
  }

  bindEvents() {
    this.elements.refreshButton.addEventListener('click', async () => {
      await this.loadAll();
      if (this.state.selectedAgentId) {
        await loadSelectedAgentDetails(this, this.state.selectedAgentId);
      }
    });

    // Shared config
    this.elements.sharedConfigForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await this.saveSharedConfig();
    });

    // Service runtimes
    this.elements.ragRuntimeForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await saveRagRuntimeConfig(this.elements, this.state, (m, t) => this.setStatus(m, t));
    });
    this.elements.testRagRuntimeBtn?.addEventListener('click', async () => {
      await testRagRuntimeConnection(this.elements, (m, t) => this.setStatus(m, t));
    });
    this.elements.ragConfigChunkStrategySelect?.addEventListener('change', () => {
      updateRagTierVisibility(this.elements);
    });

    // Agent panel
    this.elements.agentList.addEventListener('click', async (event) => {
      const trigger = event.target.closest('[data-agent-config-id]');
      if (!trigger) { return; }
      await loadSelectedAgentDetails(this, trigger.dataset.agentConfigId);
    });

    this.elements.selectedAgentPanel.addEventListener('submit', async (event) => {
      if (event.target.matches('#agentProfileForm')) {
        event.preventDefault();
        await saveSelectedAgentProfile(this);
        return;
      }
      if (event.target.matches('#agentRuntimeConfigForm')) {
        event.preventDefault();
        await this.saveSelectedAgentRuntimeConfig(event.target);
      }
    });

    this.elements.selectedAgentPanel.addEventListener('change', async (event) => {
      const select = event.target.closest('.tool-auth-select');
      if (select) {
        await updateSelectedToolAuthMode(this, select.dataset.toolId, select.value);
        return;
      }
      if (event.target.matches('#agentProviderInput')) {
        const modelSelect = this.elements.selectedAgentPanel.querySelector('#agentModelInput');
        if (modelSelect) {
          modelSelect.innerHTML = renderModelOptionMarkup(this.state.providers, event.target.value, '');
        }
        this.state.selectedAgentAuth = createPendingAuthState();
        renderSelectedAgentAuthState(this);
        await refreshSelectedAgentAuthStatus(this);
      }
    });

    this.elements.selectedAgentPanel.addEventListener('click', async (event) => {
      const authButton = event.target.closest('[data-provider-auth-action]');
      if (authButton) {
        if (authButton.dataset.providerAuthAction === 'signin') {
          await startSelectedAgentAuth(this);
          return;
        }
        if (authButton.dataset.providerAuthAction === 'signout') {
          await signOutSelectedAgentAuth(this);
          return;
        }
      }
      const bulkButton = event.target.closest('[data-bulk-profile-mode]');
      if (!bulkButton) { return; }
      await applyBulkTemplate(this, bulkButton.dataset.bulkProfileMode);
    });
  }

  async loadAll() {
    const startedAt = Date.now();
    this.setStatus('Loading config ownership and admin data...', 'info');
    logger.info('Loading config admin state', {
      selectedAgentId: this.state.selectedAgentId || null,
      viewScope: this.state.viewScope,
    });
    try {
      const [ownership, config, ragConfig, providers, agents] = await Promise.all([
        fetchJson('/api/config/ownership'),
        fetchJson('/api/config'),
        requestJson('/api/config/rag').catch(() => ({ config: {} })),
        fetchJson('/api/providers'),
        fetchJson('/api/agents'),
      ]);

      this.state.ownership = ownership.ownership || ownership;
      this.state.config = config.config || config;
      this.state.ragConfig = readRecord(ragConfig?.config);
      this.state.providers = Array.isArray(providers) ? providers : [];
      this.state.agents = Array.isArray(agents.agents) ? agents.agents : [];
      this.state.selectedAgentId = resolveSelectedAgentId(this.state.selectedAgentId, this.state.agents);

      this.render();
      this.setStatus('Config admin loaded from mounted OSHAL APIs.', 'success');
      logger.info('Loaded config admin state', {
        durationMs: Date.now() - startedAt,
        providerCount: this.state.providers.length,
        agentCount: this.state.agents.length,
        selectedAgentId: this.state.selectedAgentId || null,
      });
    } catch (error) {
      logger.error('Failed to load config admin state', {
        durationMs: Date.now() - startedAt,
        error: serializeUiError(error),
      });
      this.setStatus(`Failed to load config admin data: ${toErrorMessage(error)}. Click Refresh to retry.`, 'error');
    }
  }

  render() {
    this.renderMetrics();
    this.renderSharedConfigForm();
    renderRagRuntimeForm(this.elements, this.state.ragConfig);
    renderOwnershipCards(this.elements, this.state.ownership);
    renderAgentCards(this.elements, this.state.agents);
    renderSelectedAgentPanelMarkup(this);
    renderSelectedAgentAuthState(this);
  }

  renderMetrics() {
    setText('metricSharedRoutes', countItems(this.state.ownership?.globalConfig?.routes));
    setText('metricProviders', this.state.providers.length);
    setText('metricAgents', this.state.agents.length);
    setText('metricLegacyRoutes', countItems(this.state.ownership?.legacyCompatibility?.routes));
  }

  renderSharedConfigForm() {
    renderProviderOptions(this.elements.planProviderSelect, this.state.providers, this.state.config.planModeApiProvider);
    renderProviderOptions(this.elements.actProviderSelect, this.state.providers, this.state.config.actModeApiProvider);
    this.elements.planeUrlInput.value = readString(this.state.config.planeUrl);
    this.elements.redisUrlInput.value = readString(this.state.config.redisUrl);
    this.elements.gitRepoUrlInput.value = readString(this.state.config.gitRepoUrl);
    this.elements.codeServerWorkspaceRootInput.value = readString(this.state.config.codeServerWorkspaceRoot);
    this.elements.apiKeyInput.value = readString(this.state.config.apiKey);
  }

  async saveSharedConfig() {
    const payload = buildSharedConfigPayload(this.elements);
    this.setStatus('Saving shared OSHAL config...', 'info');
    try {
      await postJson('/api/config', payload);
      this.state.config = { ...this.state.config, ...payload };
      this.setStatus('Shared OSHAL config saved.', 'success');
    } catch (error) {
      this.setStatus(`Failed to save shared config: ${toErrorMessage(error)}`, 'error');
    }
  }

  async saveSelectedAgentRuntimeConfig(formEl) {
    if (!this.state.selectedAgentId) {
      return;
    }

    this.setStatus('Saving bot runtime config...', 'info');
    try {
      await saveAgentRuntimeConfig(this.state.selectedAgentId, formEl);
      this.state.selectedAgentRuntimeConfig = await loadAgentRuntimeConfig(this.state.selectedAgentId);
      renderSelectedAgentPanelMarkup(this);
      renderSelectedAgentAuthState(this);
      this.setStatus('Bot runtime config saved.', 'success');
    } catch (error) {
      this.setStatus(`Failed to save bot runtime config: ${toErrorMessage(error)}`, 'error');
    }
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }

  focusAgentConfigSection() {
    const section = document.getElementById('agentConfigSection');
    section?.scrollIntoView({ block: 'start' });
  }
}

const app = new ConfigAdminApp();
app.init().catch((error) => {
  logger.error('Config admin bootstrap failed', { error: serializeUiError(error) });
  const banner = document.getElementById('statusBanner');
  if (banner) {
    banner.textContent = `Config admin failed to load: ${error.message}`;
    banner.dataset.tone = 'error';
  }
});

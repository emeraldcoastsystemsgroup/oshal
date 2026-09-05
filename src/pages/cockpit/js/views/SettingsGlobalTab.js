/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit settings global-tab rendering and shared runtime save/health logic from SettingsView to restore file-governance compliance
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added shared code-server workspace-root controls so swarm operators can configure code-server mount paths like /usr/workspace without environment-only edits
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed the retired Presentron + deprecated Google Search MCP service-runtime inputs, save requests, collect helpers, and health cards; the shared service-runtimes section now covers RAG only
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added the operator-only "Manage swarm apps" link (→ /applications) — the replacement entry for the retired cockpit header apps-grid button; revealed via the dev-console super-admin probe
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added the "Add a computer (remote node)" link (→ /api/join/, the join surface that mints enrollment + join codes) beside Manage swarm apps, revealed by the same probe — the surface existed since 07-08 but nothing in the cockpit linked to it, so adding a node meant knowing the URL by heart
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added the "Get oshal on your devices" link (→ /cockpit/tools/devices.html) beside it, shown to everyone: the operator-gated join surface is the advanced path, and a basic user who came to Settings looking for "how do I put this on my desktop" found nothing.
 */

import { createUiLogger, serializeUiError } from '../../../shared/ui-debug.js';
import { COCKPIT_THEMES } from '../theme-manager.js';

const logger = createUiLogger('cockpit-settings-global-tab');

/**
 * @description Controller that renders and binds the cockpit settings global tab, including shared swarm runtime, integrations, service runtimes, and operator preferences.
 */
export class SettingsGlobalTab {
  /**
   * @description Create the initial unknown-state service-health model before live probes complete.
   *
   * @returns {object} Service-health state for the shared RAG runtime.
   */
  static createDefaultServiceHealthState() {
    return {
      rag: createServiceHealthEntry('unknown', 'RAG runtime not yet checked.', 'No health probe has been run yet.'),
    };
  }

  /**
   * @description Create a global-tab controller bound to one SettingsView instance and target body element.
   *
   * @param {object} view - Parent settings view that owns shared state and helper methods.
   * @param {HTMLElement} body - Settings body element where the global tab should render.
   * @returns {void}
   */
  constructor(view, body) {
    this.view = view;
    this.body = body;
    logger.info('Created cockpit settings global tab', {
      hasBody: Boolean(this.body),
    });
  }

  /**
   * @description Render the global settings tab and attach all interaction handlers.
   *
   * @returns {void}
   */
  render() {
    logger.info('Rendering cockpit settings global tab');
    this.body.innerHTML = this.buildMarkup();
    this.bindEvents();
  }

  // Build the full markup for the global settings tab from smaller section renderers.
  buildMarkup() {
    return [
      renderConfigOwnershipSection(this.view.configOwnership),
      this.renderRuntimeIntroSection(),
      this.renderCostControlsSection(),
      this.renderProviderSection(),
      this.renderOpenAiCodexSection(),
      this.renderIntegrationsSection(),
      this.renderServiceRuntimesSection(),
      this.renderOperatorPreferencesSection(),
      this.renderSaveRow(),
    ].join('');
  }

  // Render the short intro that frames the page as a shared swarm runtime surface.
  renderRuntimeIntroSection() {
    return `
      <div class="setting-section">
        <div class="setting-section-title">Swarm Runtime</div>
        <div class="setting-section-desc">Set the shared provider, model, and runtime key used by the swarm-wide operator surfaces.</div>
      </div>`;
  }

  // Render the cockpit-local cost controls section.
  renderCostControlsSection() {
    const costStatus = this.view.api.getCostStatus();
    return `
      <div class="setting-section">
        <div class="setting-section-title"><i class="ph ph-currency-dollar"></i> Cost Controls</div>
        <div class="setting-section-desc">Set spending limits to control AI swarm costs</div>
        <div class="cost-status-grid">
          ${this.renderCostStatusCard('Daily Spent', 'costDailySpent', costStatus.dailySpent, costStatus.dailyLimit)}
          ${this.renderCostStatusCard('Bucket Spent', 'costBucketSpent', costStatus.bucketSpent, costStatus.bucketLimit)}
        </div>
        <div class="setting-field">
          <label>Daily Spending Limit ($)</label>
          <input type="number" id="costDailyLimit" value="${costStatus.dailyLimit || ''}" placeholder="e.g., 20" min="0" step="0.01">
          <span class="field-hint">Maximum amount to spend per day. Resets at midnight. Leave empty for no limit.</span>
        </div>
        <div class="setting-field">
          <label>Bucket Spending Limit ($)</label>
          <input type="number" id="costBucketLimit" value="${costStatus.bucketLimit || ''}" placeholder="e.g., 100" min="0" step="0.01">
          <span class="field-hint">Total budget amount. Runs until exhausted. Reset manually when refilling budget.</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="settings-save-btn" id="costSaveLimitsBtn" style="background:var(--accent-primary);">
            <i class="ph ph-floppy-disk"></i> Save Limits
          </button>
          <button class="settings-cancel-btn" id="costResetBucketBtn">
            <i class="ph ph-arrow-counter-clockwise"></i> Reset Bucket to $0
          </button>
        </div>
      </div>`;
  }

  // Render one cost-status card.
  renderCostStatusCard(label, valueId, spent, limit) {
    const limitLabel = limit ? `of $${limit.toFixed(2)} limit` : 'No limit set';
    return `
      <div class="cost-status-card">
        <div class="cost-status-label">${label}</div>
        <div class="cost-status-value" id="${valueId}">$${spent.toFixed(4)}</div>
        <div class="cost-status-limit">${limitLabel}</div>
      </div>`;
  }

  // Render the shared provider and model controls.
  renderProviderSection() {
    const settings = this.view.settings;
    const provider = this.view._resolveSelectedProviderId();
    const selectedModel = this.view._resolveSelectedModelId(provider);
    const options = this.view.providers.map((item) => `
      <option value="${item.id}"${provider === item.id ? ' selected' : ''}>${item.displayName || item.name || item.id}</option>
    `).join('');

    return `
      <div class="setting-section">
        <div class="setting-section-title">Provider And Model</div>
        <div class="setting-section-desc">These values write to the shared OSHAL config for both plan and act modes.</div>
        <div class="setting-field">
          <label>Agent Provider</label>
          <select id="settingsProvider">${options}</select>
          <span class="field-hint">This writes the selected provider into the shared OSHAL configuration document for both plan and act modes.</span>
        </div>
        <div class="setting-field">
          <label>Agent Model</label>
          <select id="settingsModel">${this.view._renderProviderModelOptions(provider, selectedModel)}</select>
          <span class="field-hint">This writes the selected model into both <code>actModeApiModelId</code> and <code>planModeApiModelId</code> so runtime sync uses the same provider/model pair.</span>
        </div>
        <div class="setting-field">
          <label>Shared API Key</label>
          <input type="password" id="settingsApiKey" value="${settings.apiKey || ''}" placeholder="Enter shared runtime API key...">
          <span class="field-hint">Stored in the shared OSHAL secrets envelope and reused by operator surfaces that rely on the common provider runtime.</span>
        </div>
      </div>`;
  }

  // Render the OpenAI Codex authentication block.
  renderOpenAiCodexSection() {
    return `
      <div class="setting-section" data-testid="settings-openai-codex-auth">
        <div class="setting-section-title">OpenAI Codex Authentication</div>
        <div class="setting-section-desc" id="settingsOpenAiCodexAuthInfo">Select OpenAI Codex as the provider to manage OAuth sign-in from cockpit.</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span id="settingsOpenAiCodexAuthStatus" class="auth-status-badge" data-tone="info">Checking authentication...</span>
          <button class="settings-save-btn" id="settingsOpenAiCodexSignInBtn" type="button" hidden>
            <i class="ph ph-sign-in"></i> Sign In
          </button>
          <button class="settings-cancel-btn" id="settingsOpenAiCodexSignOutBtn" type="button" hidden>
            <i class="ph ph-sign-out"></i> Sign Out
          </button>
        </div>
      </div>`;
  }

  // Render the shared external integration section.
  renderIntegrationsSection() {
    const settings = this.view.settings;
    return `
      <div class="setting-section">
        <div class="setting-section-title">Swarm Integrations</div>
        <div class="setting-section-desc">Configure shared infrastructure and external locations used across the swarm.</div>
        <div class="setting-field">
          <label>Git Repository URL</label>
          <input type="url" id="settingsGitUrl" value="${settings.gitRepoUrl || ''}" placeholder="https://github.com/...">
          <span class="field-hint">Point this at the shared GitHub or GitLab repository root the swarm should reference by default.</span>
        </div>
        <div class="setting-field">
          <label>Git Token</label>
          <input type="password" id="settingsGitToken" value="${settings.gitToken || ''}" placeholder="Personal access token">
          <span class="field-hint">Used for shared repository access when runtime workflows need authenticated Git operations.</span>
        </div>
        <div class="setting-field">
          <label>Plane Workspace URL</label>
          <input type="url" id="settingsPlaneUrl" value="${settings.planeUrl || ''}" placeholder="http://localhost:80">
          <span class="field-hint">Shared ticket/project system location for cockpit and swarm handoff flows.</span>
        </div>
        <div class="setting-field">
          <label>Redis Connection</label>
          <input type="text" id="settingsRedis" value="${settings.redisUrl || ''}" placeholder="redis://localhost:6379">
          <span class="field-hint">Canonical embedded Redis mesh URL for runtime availability, queues, and direct agent dispatch.</span>
        </div>
      </div>`;
  }

  // Render the shared service-runtime section plus health cards.
  renderServiceRuntimesSection() {
    const rag = this.view.ragServiceConfig;

    return `
      <div class="setting-section">
        <div class="setting-section-title">Shared Service Runtimes</div>
        <div class="setting-section-desc">These settings control the global endpoints behind the header tools and shared operator integrations.</div>
        ${renderServiceHealthGrid(this.view.serviceHealth)}
        ${renderInputField('RAG Service Endpoint', 'settingsRagEndpoint', rag.endpoint || '', 'http://chromadb:8000', 'url')}
        ${renderInputField('Default Swarm Collection', 'settingsRagDefaultCollection', rag.defaultCollection || '', 'default', 'text', 'This is the shared swarm-memory default collection the cockpit header should start in.')}
        ${renderInputField('RAG Embedding Provider', 'settingsRagEmbeddingProvider', rag.embeddingProviderId || '', 'openai')}
        ${renderInputField('RAG Embedding Model', 'settingsRagEmbeddingModel', rag.embeddingModelId || '', 'text-embedding-3-large')}
        ${renderInputField('Code Server Workspace Root', 'settingsCodeServerWorkspaceRoot', this.view.settings.codeServerWorkspaceRoot || '', '/usr/workspace', 'text', 'Set the shared workspace mount path exposed inside code-server. Use this when code-server sees swarm workspaces at a different absolute path than the OSHAL host.')}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <button class="settings-cancel-btn" id="settingsRefreshRuntimeBtn" type="button">
            <i class="ph ph-arrows-clockwise"></i> Refresh Runtime Status
          </button>
          <a class="settings-cancel-btn" href="/config/#ragRuntimeSection" target="_top" rel="noreferrer">
            <i class="ph ph-sliders-horizontal"></i> Open Full Config Admin
          </a>
          <a class="settings-cancel-btn" id="settingsManageAppsLink" href="/applications" target="_top" rel="noreferrer" hidden>
            <i class="ph ph-squares-four"></i> Manage swarm apps
          </a>
          <a class="settings-cancel-btn" id="settingsAddComputerLink" href="/api/join/" target="_blank" rel="noreferrer" hidden>
            <i class="ph ph-laptop"></i> Add a computer (remote node)
          </a>
          <a class="settings-cancel-btn" id="settingsDevicesLink" href="/cockpit/tools/devices.html" target="_blank" rel="noreferrer">
            <i class="ph ph-devices"></i> Get oshal on your devices
          </a>
        </div>
      </div>`;
  }

  // Render cockpit-local operator preferences.
  renderOperatorPreferencesSection() {
    const settings = this.view.settings;
    const themeButtons = COCKPIT_THEMES
      .map((theme) => renderThemeButton(theme, document.documentElement.dataset.theme === theme))
      .join('');

    return `
      <div class="setting-section">
        <div class="setting-section-title">Operator Preferences</div>
        <div class="setting-section-desc">Cockpit-local display and approval preferences for this operator session.</div>
        <div class="setting-section-title" style="font-size:14px;">Theme</div>
        <div class="setting-section-desc">Choose the cockpit theme used for this operator surface.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap" id="settingsThemePicker">${themeButtons}</div>
        <div style="height:12px;"></div>
        <div class="setting-section-title" style="font-size:14px;">Auto-Approve</div>
        <div class="setting-section-desc">Automatically approve tool execution</div>
        ${renderToggle('Safe commands (ls, cat, etc.)', 'settingsAutoSafe', settings.autoApproveSafe)}
        ${renderToggle('File reads', 'settingsAutoRead', settings.autoApproveRead)}
        ${renderToggle('File writes', 'settingsAutoWrite', settings.autoApproveWrite)}
      </div>`;
  }

  // Render the shared save button row.
  renderSaveRow() {
    return `
      <div class="settings-save-row">
        <button class="settings-save-btn" id="settingsSaveBtn"><i class="ph ph-floppy-disk"></i> Save Settings</button>
      </div>`;
  }

  // Attach all global-tab interaction handlers.
  bindEvents() {
    this.bindThemePicker();
    this.bindCostControls();
    this.bindProviderControls();
    this.bindRuntimeRefresh();
    this.bindSave();
    this.revealOperatorLinks();
    this.view._updateModelSelectionForProvider(this.body, this.view._resolveSelectedProviderId());
    void this.view._refreshOpenAiCodexAuthStatus(this.body, true);
  }

  // Reveal operator-only admin links (the swarm-apps console at /applications and the add-a-computer
  // join surface at /api/join/) for super-admins — the same dev-console probe the retired cockpit
  // header apps button used. Both surfaces self-gate server-side regardless; this is cosmetic.
  revealOperatorLinks() {
    fetch('/api/dev-console/access', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.superAdmin) return;
        this.body.querySelector('#settingsManageAppsLink')?.removeAttribute('hidden');
        this.body.querySelector('#settingsAddComputerLink')?.removeAttribute('hidden');
      })
      .catch(() => {});
  }

  // Bind theme selection buttons.
  bindThemePicker() {
    this.body.querySelectorAll('#settingsThemePicker button').forEach((button) => {
      button.addEventListener('click', () => {
        const theme = button.dataset.theme;
        logger.info('Updating cockpit theme preference', {
          theme,
        });
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('cockpit-theme', theme);
        this.body.querySelectorAll('#settingsThemePicker button').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        if (this.view.onThemeChange) {
          this.view.onThemeChange(theme);
        }
      });
    });
  }

  // Bind local cost-control actions.
  bindCostControls() {
    this.body.querySelector('#costSaveLimitsBtn')?.addEventListener('click', () => this.handleSaveCostLimits());
    this.body.querySelector('#costResetBucketBtn')?.addEventListener('click', () => this.handleResetBucket());
    this.view.costUpdateHandler = () => this.view._updateCostDisplay();
    window.addEventListener('cost-updated', this.view.costUpdateHandler);
  }

  // Persist cockpit-local cost limits.
  handleSaveCostLimits() {
    const dailyLimit = this.body.querySelector('#costDailyLimit')?.value;
    const bucketLimit = this.body.querySelector('#costBucketLimit')?.value;
    logger.info('Saving cockpit cost limits', {
      dailyLimit: dailyLimit || null,
      bucketLimit: bucketLimit || null,
    });
    this.view.api.setCostLimits(dailyLimit ? parseFloat(dailyLimit) : null, bucketLimit ? parseFloat(bucketLimit) : null);
    this.view._updateCostDisplay();
    flashButtonState(this.body.querySelector('#costSaveLimitsBtn'), '<i class="ph ph-check"></i> Saved!');
  }

  // Reset the local cockpit budget bucket after user confirmation.
  handleResetBucket() {
    if (!window.confirm('Reset bucket spending to $0? This will clear the bucket counter but not daily spending.')) {
      logger.debug('Canceled cockpit bucket reset');
      return;
    }
    logger.info('Resetting cockpit cost bucket');
    this.view.api.resetBucket();
    this.view._updateCostDisplay();
  }

  // Bind provider/model and OAuth controls.
  bindProviderControls() {
    const provider = this.view._resolveSelectedProviderId();
    this.body.querySelector('#settingsProvider')?.addEventListener('change', () => {
      const selectedProviderId = this.view._readSelectedProviderFromBody(this.body, provider);
      logger.info('Updating cockpit settings provider selection', {
        providerId: selectedProviderId,
      });
      this.view._updateModelSelectionForProvider(this.body, selectedProviderId);
      void this.view._refreshOpenAiCodexAuthStatus(this.body, true);
    });
    this.body.querySelector('#settingsOpenAiCodexSignInBtn')?.addEventListener('click', async () => {
      await this.view._startOpenAiCodexAuthFlow(this.body);
    });
    this.body.querySelector('#settingsOpenAiCodexSignOutBtn')?.addEventListener('click', async () => {
      await this.view._signOutOpenAiCodexAuth(this.body);
    });
  }

  // Bind the runtime-health refresh action.
  bindRuntimeRefresh() {
    this.body.querySelector('#settingsRefreshRuntimeBtn')?.addEventListener('click', async () => {
      const refreshButton = this.body.querySelector('#settingsRefreshRuntimeBtn');
      if (refreshButton) {
        refreshButton.disabled = true;
      }
      logger.info('Refreshing cockpit runtime status');
      try {
        this.view.serviceHealth = await loadServiceHealth(this.view.api);
        this.replaceServiceHealthGrid();
        logger.info('Refreshed cockpit runtime status');
        this.view.showToast('Service runtime status refreshed', 'success');
      } catch (error) {
        logger.error('Failed to refresh cockpit runtime status', {
          error: serializeUiError(error),
        });
        this.view.showToast(`Failed to refresh runtime status: ${error.message}`, 'error');
      } finally {
        if (refreshButton) {
          refreshButton.disabled = false;
        }
      }
    });
  }

  // Bind the shared settings save action.
  bindSave() {
    this.body.querySelector('#settingsSaveBtn')?.addEventListener('click', async () => {
      logger.info('Saving cockpit global settings');
      try {
        await Promise.all(this.buildSaveRequests());
        this.refreshViewStateFromForm();
        this.view.serviceHealth = await loadServiceHealth(this.view.api);
        this.replaceServiceHealthGrid();
        void this.view._refreshOpenAiCodexAuthStatus(this.body, true);
        logger.info('Saved cockpit global settings');
        this.view.showToast('Settings saved', 'success');
      } catch (error) {
        logger.error('Failed to save cockpit global settings', {
          error: serializeUiError(error),
        });
        this.view.showToast(`Settings save failed: ${error.message}`, 'error');
      }
    });
  }

  // Build all save requests for shared config and service runtimes.
  buildSaveRequests() {
    return [
      saveCockpitSettings(this.collectCockpitPayload()),
      saveServiceConfig('/api/config/rag', this.collectRagPayload()),
    ];
  }

  // Collect the shared cockpit config payload.
  collectCockpitPayload() {
    const provider = this.view._readSelectedProviderFromBody(this.body, this.view._resolveSelectedProviderId());
    const model = this.view._readSelectedModelFromBody(this.body, provider);
    return {
      gitRepoUrl: this.body.querySelector('#settingsGitUrl')?.value,
      gitToken: this.body.querySelector('#settingsGitToken')?.value,
      planeUrl: this.body.querySelector('#settingsPlaneUrl')?.value,
      redisUrl: this.body.querySelector('#settingsRedis')?.value,
      codeServerWorkspaceRoot: this.body.querySelector('#settingsCodeServerWorkspaceRoot')?.value,
      apiKey: this.body.querySelector('#settingsApiKey')?.value,
      actModeApiProvider: provider,
      planModeApiProvider: provider,
      actModeApiModelId: model,
      planModeApiModelId: model,
      autoApproveSafe: this.body.querySelector('#settingsAutoSafe')?.checked,
      autoApproveRead: this.body.querySelector('#settingsAutoRead')?.checked,
      autoApproveWrite: this.body.querySelector('#settingsAutoWrite')?.checked,
    };
  }

  // Collect the shared RAG runtime payload.
  collectRagPayload() {
    return {
      endpoint: this.body.querySelector('#settingsRagEndpoint')?.value?.trim() || '',
      defaultCollection: this.body.querySelector('#settingsRagDefaultCollection')?.value?.trim() || '',
      embeddingProviderId: this.body.querySelector('#settingsRagEmbeddingProvider')?.value?.trim() || '',
      embeddingModelId: this.body.querySelector('#settingsRagEmbeddingModel')?.value?.trim() || '',
    };
  }

  // Sync the parent SettingsView state from the just-saved form values.
  refreshViewStateFromForm() {
    this.view.settings = { ...this.view.settings, ...this.collectCockpitPayload() };
    this.view.ragServiceConfig = { ...this.view.ragServiceConfig, ...this.collectRagPayload() };
  }

  // Replace only the live service-health grid after a refresh or save.
  replaceServiceHealthGrid() {
    const runtimeGrid = this.body.querySelector('#settingsServiceHealthGrid');
    if (runtimeGrid) {
      runtimeGrid.outerHTML = renderServiceHealthGrid(this.view.serviceHealth);
    }
  }
}

// Render a consistent input field with optional helper text.
function renderInputField(label, id, value, placeholder, type = 'text', hint = '') {
  const hintMarkup = hint ? `<span class="field-hint">${hint}</span>` : '';
  return `
    <div class="setting-field">
      <label>${label}</label>
      <input type="${type}" id="${id}" value="${escapeHtmlAttribute(value)}" placeholder="${escapeHtmlAttribute(placeholder)}">
      ${hintMarkup}
    </div>`;
}

// Render a cockpit theme button with the right icon and active state.
function renderThemeButton(theme, active) {
  const icons = {
    midnight: 'ph-moon',
    daylight: 'ph-sun',
    ocean: 'ph-waves',
    sakura: 'ph-flower-lotus',
    forest: 'ph-tree-evergreen',
    gray: 'ph-squares-four',
    black: 'ph-circle-half-tilt',
    'light-blue': 'ph-drop',
    aurora: 'ph-star-four',
    graphite: 'ph-diamond',
    amber: 'ph-fire',
  };
  const label = theme
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
  const activeClass = active ? ' active' : '';
  return `<button class="td-action-btn${activeClass}" data-theme="${theme}" style="min-width:90px"><i class="ph ${icons[theme]}"></i> ${label}</button>`;
}

// Render a standard toggle row for operator preferences.
function renderToggle(label, id, checked) {
  return `
    <div class="setting-toggle">
      <div><div class="setting-toggle-label">${label}</div></div>
      <label class="toggle-switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>`;
}

// Swap a button into a temporary success state before restoring its original label.
function flashButtonState(button, replacementMarkup) {
  if (!button) {
    return;
  }
  const originalMarkup = button.innerHTML;
  button.innerHTML = replacementMarkup;
  window.setTimeout(() => {
    button.innerHTML = originalMarkup;
  }, 2000);
}

// Render the Session 70 ownership guidance from the backend contract.
function renderConfigOwnershipSection(ownership) {
  if (!ownership) {
    return '';
  }

  const sections = [
    createOwnershipSection('Global OSHAL Config', ownership.globalConfig),
    createOwnershipSection('Per-Agent Profile', ownership.perAgentProfile),
    createOwnershipSection('Per-Agent Tools', ownership.perAgentTools),
  ];

  return `
    <div class="setting-section" data-testid="config-ownership-section">
      <div class="setting-section-title">Config Ownership</div>
      <div class="setting-section-desc">OSHAL owns one shared config surface plus narrower per-agent contracts. Legacy per-port <code>/config</code> pages are compatibility only.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
        ${sections.map((section) => renderOwnershipCard(section)).join('')}
      </div>
      <div style="margin-top:12px;font-size:13px;opacity:0.82;">Guidance:${renderOwnershipGuidance(ownership.legacyCompatibility?.guidance || [])}</div>
    </div>`;
}

// Normalize one ownership section for rendering.
function createOwnershipSection(label, section) {
  return {
    label,
    routeBase: section?.routeBase,
    summary: section?.summary,
    examples: section?.examples || [],
  };
}

// Render one ownership card.
function renderOwnershipCard(section) {
  return `
    <div style="padding:12px;border:1px solid var(--border-color, rgba(255,255,255,0.12));border-radius:12px;background:rgba(255,255,255,0.02);">
      <div style="font-weight:600;margin-bottom:8px;">${section.label}</div>
      <div style="margin-bottom:8px;"><code>${section.routeBase}</code></div>
      <div style="font-size:13px;opacity:0.88;line-height:1.45;">${section.summary}</div>
      <div style="font-size:12px;opacity:0.72;margin-top:8px;">Examples: ${section.examples.join(', ')}</div>
    </div>`;
}

// Format ownership guidance as an inline bullet-style block.
function renderOwnershipGuidance(items) {
  if (!items.length) {
    return ' Use the mounted OSHAL APIs rather than legacy per-port pages.';
  }
  return items.map((item) => `<span style="display:block;margin-top:4px;">- ${item}</span>`).join('');
}

// Render live runtime-health cards for shared service dependencies.
function renderServiceHealthGrid(serviceHealth) {
  const cards = [
    createServiceHealthCard('settingsRagHealthCard', 'RAG Runtime', serviceHealth.rag),
  ];

  return `
    <div id="settingsServiceHealthGrid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px;">
      ${cards.map((card) => renderServiceHealthCard(card)).join('')}
    </div>`;
}

// Create a normalized service-health card model.
function createServiceHealthCard(id, label, entry) {
  return {
    id,
    label,
    detail: entry.detail,
    statusLabel: entry.statusLabel,
    statusTone: entry.statusTone,
    target: entry.target,
  };
}

// Render one service-health card.
function renderServiceHealthCard(card) {
  return `
    <div id="${card.id}" style="padding:12px;border:1px solid var(--border-color, rgba(255,255,255,0.12));border-radius:12px;background:rgba(255,255,255,0.02);">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
        <strong>${card.label}</strong>
        <span class="auth-status-badge" data-tone="${card.statusTone}">${card.statusLabel}</span>
      </div>
      <div style="margin-top:8px;font-size:13px;opacity:0.86;line-height:1.45;">${card.detail}</div>
      <div style="margin-top:8px;font-size:12px;opacity:0.72;word-break:break-word;">${card.target}</div>
    </div>`;
}

// Load live service runtime health from the mounted OSHAL routes.
async function loadServiceHealth(api) {
  const [ragRes] = await Promise.all([
    api.getSafe('/api/rag/health', { chromadb: 'unknown' }),
  ]);

  return {
    rag: createServiceHealthEntry(
      ragRes?.chromadb || 'unknown',
      ragRes?.chromadb === 'connected' ? 'Vector store is reachable for shared swarm knowledge.' : 'Vector store is not reachable from the current runtime.',
      'GET /api/rag/health',
    ),
  };
}

// Create a consistent service-health entry for UI rendering.
function createServiceHealthEntry(status, detail, target) {
  return {
    status,
    statusLabel: status === 'connected' ? 'Connected' : status === 'unreachable' ? 'Unreachable' : 'Unknown',
    statusTone: status === 'connected' ? 'success' : status === 'unreachable' ? 'error' : 'muted',
    detail,
    target,
  };
}

// Persist the shared cockpit settings document.
async function saveCockpitSettings(payload) {
  const response = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

// Persist one shared service-runtime payload through the mounted OSHAL config surface.
async function saveServiceConfig(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

// Escape HTML before rendering values into element content or attributes.
function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

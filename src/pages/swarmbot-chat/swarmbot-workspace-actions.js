/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added dedicated RAG and Presentron action handlers for the swarm-bot workspace
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added switch-framework action handlers for in-rail tool auth-mode updates
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Completed quick-settings, history, and advanced-config action wiring for the dedicated swarm-bot workspace
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Corrected quick-settings profile write payload shape to the canonical agent-profile contract
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added optional shared RAG workspace delegation so swarm chat and cockpit can reuse one knowledge modal
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added optional shared Presentron workspace delegation so swarm chat stops carrying a second presentation modal
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Retired the Presentron workspace controller (studio backend is gone); the toolbar presentation button now opens the office-suite AI Office surface (?app=presentations)
 */

import { createUiLogger } from '../shared/ui-debug.js';

const logger = createUiLogger('swarmbot-workspace-actions');
const COCKPIT_LOAD_TASK_EVENT = 'oshal-cockpit-load-task';

/**
 * @description Controller for switch-framework and RAG actions inside the dedicated swarm-bot workspace.
 * Keeps tool-oriented modal logic outside the main chat controller so the right rail can grow
 * without turning back into a single oversized file.
 */
export class SwarmBotWorkspaceActions {
  /**
   * @description Create the workspace-action controller.
   * @param {object} deps - Runtime dependencies.
   * @param {Record<string, HTMLElement | null>} deps.elements - Bound DOM elements.
   * @param {(url: string, options?: Record<string, unknown>) => Promise<any>} deps.requestJson - JSON request helper.
   * @param {(message: string, tone: string) => void} deps.setStatus - Shared status-strip setter.
   * @param {() => string} deps.getAgentId - Selected bot identifier getter.
   * @param {() => string} deps.getTaskId - Active task identifier getter.
   * @param {() => void} [deps.openAdvancedConfig] - Optional callback that opens advanced config.
   * @param {(profile: Record<string, unknown>) => void} [deps.onProfileUpdated] - Optional callback invoked after profile updates.
   */
  constructor(deps) {
    this.elements = deps.elements;
    this.requestJson = deps.requestJson;
    this.setStatus = deps.setStatus;
    this.getAgentId = deps.getAgentId;
   this.getTaskId = deps.getTaskId;
    this.openAdvancedConfig = typeof deps.openAdvancedConfig === 'function' ? deps.openAdvancedConfig : () => {};
   this.onProfileUpdated = typeof deps.onProfileUpdated === 'function' ? deps.onProfileUpdated : () => {};
    this.ragWorkspace = deps.ragWorkspace || null;
    logger.info('Created swarmbot workspace actions controller', {
      hasSharedRagWorkspace: Boolean(this.ragWorkspace),
    });
  }

  /**
   * @description Bind click/change handlers for RAG and toolbar controls.
   */
  bindEvents() {
    logger.info('Binding swarmbot workspace action events');
    this.elements.openSettingsBtn?.addEventListener('click', () => void this.openQuickSettingsModal());
    this.elements.closeQuickSettingsBtn?.addEventListener('click', () => this.closeQuickSettingsModal());
    this.elements.saveQuickSettingsBtn?.addEventListener('click', () => void this.saveQuickSettings());
    this.elements.configureAllUnsetQuickSettingsBtn?.addEventListener('click', () => void this.applyBulkQuickSettings('unset'));
    this.elements.configureAllQuickSettingsBtn?.addEventListener('click', () => void this.applyBulkQuickSettings('all'));
    this.elements.openAdvancedConfigBtn?.addEventListener('click', () => this.openAdvancedConfigFromQuickSettings());
    this.elements.openHistoryBtn?.addEventListener('click', () => void this.openHistoryModal());
    this.elements.closeHistoryBtn?.addEventListener('click', () => this.closeHistoryModal());
    this.elements.openToolsBtn?.addEventListener('click', () => void this.openToolsModal());
    this.elements.closeSwitchFrameworkBtn?.addEventListener('click', () => this.closeToolsModal());
    this.elements.refreshSwitchFrameworkBtn?.addEventListener('click', () => void this.refreshToolModes());
    this.elements.switchFrameworkList?.addEventListener('change', (event) => {
      void this.handleToolModeChange(event);
    });
    if (!this.ragWorkspace) {
      this.elements.openRagBtn?.addEventListener('click', () => void this.openRagModal());
      this.elements.closeRagBtn?.addEventListener('click', () => this.closeRagModal());
      this.elements.ragUploadBtn?.addEventListener('click', () => this.elements.ragFileInput?.click());
      this.elements.ragSearchBtn?.addEventListener('click', () => void this.searchRag());
      this.elements.ragHealthBtn?.addEventListener('click', () => void this.checkRagHealth());
      this.elements.ragFileInput?.addEventListener('change', () => void this.uploadRagFiles());
      document.querySelector('[data-close-rag]')?.addEventListener('click', () => this.closeRagModal());
    }
    this.elements.openAiOfficeBtn?.addEventListener('click', () => openAiOffice());
    this.elements.closeToolsConfigBtn?.addEventListener('click', () => this.closeConfigModal());
    document.querySelector('[data-close-history]')?.addEventListener('click', () => this.closeHistoryModal());
    document.querySelector('[data-close-quick-settings]')?.addEventListener('click', () => this.closeQuickSettingsModal());
    document.querySelector('[data-close-config]')?.addEventListener('click', () => this.closeConfigModal());
    document.querySelector('[data-close-switch-framework]')?.addEventListener('click', () => this.closeToolsModal());
  }

  /**
   * @description Execute one cockpit workspace action inside the dedicated swarm-bot workspace.
   * @param {string} action - Requested cockpit action id.
   * @returns {boolean} True when the action was handled by this controller.
   */
  handleWorkspaceAction(action) {
    logger.info('Handling swarmbot workspace action', {
      action: action || null,
    });
    if (action === 'settings') {
      void this.openQuickSettingsModal();
      return true;
    }

    if (action === 'history') {
      void this.openHistoryModal();
      return true;
    }

    if (action === 'tools') {
      void this.openToolsModal();
      return true;
    }

    if (action === 'rag') {
      if (this.ragWorkspace?.open) {
        this.ragWorkspace.open();
        return true;
      }
      void this.openRagModal();
      return true;
    }

    if (action === 'presentron') {
      // Legacy action id — the Presentron studio is retired; open AI Office instead.
      openAiOffice();
      return true;
    }

    return false;
  }

  /**
   * @description Close both workspace action modals.
   */
  closeAll() {
    this.closeHistoryModal();
    this.closeConfigModal();
    this.closeQuickSettingsModal();
    this.closeToolsModal();
    if (this.ragWorkspace?.close) {
      this.ragWorkspace.close();
    } else {
      this.closeRagModal();
    }
  }

  /**
   * @description Open quick-settings modal and load selected-bot profile fields.
   */
  async openQuickSettingsModal() {
    this.closeHistoryModal();
    this.closeToolsModal();
    this.closeRagModal();
    this.elements.quickSettingsModal.hidden = false;
    this.setQuickSettingsStatus('Loading bot settings...', 'info');

    const agentId = readString(this.getAgentId());
    if (!agentId) {
      this.setQuickSettingsStatus('No selected bot available for settings.', 'error');
      return;
    }

    try {
      const [payload, providersPayload] = await Promise.all([
        this.requestJson(`/api/agents/${encodeURIComponent(agentId)}/profile`),
        this.requestJson('/api/providers').catch(() => []),
      ]);
      const providers = Array.isArray(providersPayload) ? providersPayload : [];
      this.applyQuickSettingsProviderOptions(providers, payload?.profile || {});
      this.applyQuickSettingsProfile(payload?.profile || {});
      this.setQuickSettingsStatus('Settings ready.', 'success');
    } catch (error) {
      this.setQuickSettingsStatus(`Failed to load bot settings: ${toErrorMessage(error)}`, 'error');
    }
  }

  /**
   * @description Hide quick-settings modal.
   */
  closeQuickSettingsModal() {
    this.elements.quickSettingsModal.hidden = true;
  }

  /**
   * @description Persist quick-settings form data through the per-agent profile API.
   */
  async saveQuickSettings() {
    const agentId = readString(this.getAgentId());
    if (!agentId) {
      this.setQuickSettingsStatus('No selected bot available for settings save.', 'error');
      return;
    }

    const profilePatch = this.readQuickSettingsDraft();
    this.setQuickSettingsStatus('Saving bot settings...', 'info');
    try {
      const payload = await this.requestJson(`/api/agents/${encodeURIComponent(agentId)}/profile`, {
        method: 'PUT',
        body: JSON.stringify({ profile: profilePatch }),
      });
      const nextProfile = payload?.profile || profilePatch;
      this.applyQuickSettingsProfile(nextProfile);
      this.onProfileUpdated(nextProfile);
      this.setQuickSettingsStatus('Bot settings saved.', 'success');
    } catch (error) {
      this.setQuickSettingsStatus(`Failed to save bot settings: ${toErrorMessage(error)}`, 'error');
    }
  }

  /**
   * @description Apply the current quick-settings form as a bulk template to the swarm.
   * @param {'all' | 'unset'} mode - Bulk config mode.
   */
  async applyBulkQuickSettings(mode) {
    const agentId = readString(this.getAgentId());
    if (!agentId) {
      this.setQuickSettingsStatus('No selected bot available for bulk configuration.', 'error');
      return;
    }

    const profile = this.readQuickSettingsBulkDraft();
    if (Object.keys(profile).length === 0) {
      this.setQuickSettingsStatus('Set provider, model, status, project URL, selector skills, or theme before running bulk configure.', 'error');
      return;
    }

    const endpoint = mode === 'unset'
      ? '/api/agents/bulk/configure-all-unset'
      : '/api/agents/bulk/configure-all';
    const modeLabel = mode === 'unset' ? 'unset-only' : 'overwrite';
    this.setQuickSettingsStatus(`Running ${modeLabel} bulk configure...`, 'info');

    try {
      const payload = await this.requestJson(endpoint, {
        method: 'POST',
        body: JSON.stringify({ profile }),
      });
      const result = payload?.result || {};
      const updatedAgents = Array.isArray(result.updatedAgents) ? result.updatedAgents : [];
      const updatedCount = updatedAgents.length;
      const skippedCount = Array.isArray(result.skippedAgents) ? result.skippedAgents.length : 0;

      if (updatedCount > 0 && updatedAgents.includes(agentId)) {
        const refreshed = await this.requestJson(`/api/agents/${encodeURIComponent(agentId)}/profile`);
        const nextProfile = refreshed?.profile || {};
        this.applyQuickSettingsProfile(nextProfile);
        this.onProfileUpdated(nextProfile);
      }

      this.setQuickSettingsStatus(`Bulk configure complete: updated ${updatedCount} bot(s), skipped ${skippedCount}.`, 'success');
      this.setStatus(`Bulk swarm settings applied in ${modeLabel} mode.`, 'success');
    } catch (error) {
      this.setQuickSettingsStatus(`Bulk configure failed: ${toErrorMessage(error)}`, 'error');
    }
  }

  /**
   * @description Close quick settings and open full advanced config workspace.
   */
  openAdvancedConfigFromQuickSettings() {
    this.closeQuickSettingsModal();
    this.openAdvancedConfig();
    this.setStatus('Opened advanced config workspace for selected bot.', 'info');
  }

  /**
   * @description Open selected-bot history modal and populate recent tasks.
   */
  async openHistoryModal() {
    this.closeQuickSettingsModal();
    this.closeToolsModal();
    this.closeRagModal();
    this.elements.historyModal.hidden = false;
    this.elements.historyList.innerHTML = '<div class="empty-state">Loading bot history...</div>';

    const agentId = readString(this.getAgentId());
    if (!agentId) {
      this.elements.historyList.innerHTML = '<div class="empty-state">No selected bot available for history.</div>';
      this.setStatus('No selected bot available for history.', 'error');
      return;
    }

    try {
      const payload = await this.requestJson(`/api/tasks?agentId=${encodeURIComponent(agentId)}&limit=150`);
      const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
      this.renderHistory(tasks);
      this.setStatus(`History ready (${tasks.length} task${tasks.length === 1 ? '' : 's'}).`, 'success');
    } catch (error) {
      this.elements.historyList.innerHTML = `<div class="empty-state">Failed to load history: ${escapeHtml(toErrorMessage(error))}</div>`;
      this.setStatus(`Failed to load bot history: ${toErrorMessage(error)}`, 'error');
    }
  }

  /**
   * @description Hide selected-bot history modal.
   */
  closeHistoryModal() {
    this.elements.historyModal.hidden = true;
  }

  /**
   * @description Open switch-framework modal and load selected-bot tool rows.
   */
  async openToolsModal() {
    this.closeQuickSettingsModal();
    this.closeHistoryModal();
    this.closeRagModal();
    this.elements.switchFrameworkModal.hidden = false;
    await this.refreshToolModes();
  }

  /**
   * @description Hide switch-framework modal.
   */
  closeToolsModal() {
    this.elements.switchFrameworkModal.hidden = true;
  }

  /**
   * @description Load selected-bot tools into the switch-framework list.
   */
  async refreshToolModes() {
    const agentId = readString(this.getAgentId());
    if (!agentId) {
      this.setSwitchFrameworkStatus('No selected bot available for switch-framework controls.', 'error');
      return;
    }

    this.setSwitchFrameworkStatus('Loading switch-framework controls...', 'info');
    try {
      const payload = await this.requestJson(`/api/agents/${encodeURIComponent(agentId)}/tools`);
      const tools = Array.isArray(payload?.tools) ? payload.tools : [];
      this.renderToolModes(tools);
      this.setSwitchFrameworkStatus(`Switch-framework ready (${tools.length} tools).`, 'success');
    } catch (error) {
      this.setSwitchFrameworkStatus(`Failed to load tool controls: ${toErrorMessage(error)}`, 'error');
    }
  }

  /**
   * @description Handle one switch-framework auth-mode change event.
   * @param {Event} event - Change event from tool mode select.
   */
  async handleToolModeChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !target.matches('[data-tool-id]')) {
      return;
    }

    const toolId = readString(target.dataset.toolId);
    const toolLabel = readString(target.dataset.toolName) || toolId;
    const authMode = readString(target.value) || 'off';
    if (!toolId) {
      return;
    }

    this.setSwitchFrameworkStatus(`Updating ${toolLabel} to ${authMode}...`, 'info');
    const agentId = readString(this.getAgentId());
    try {
      await this.requestJson(`/api/agents/${encodeURIComponent(agentId)}/tools/${encodeURIComponent(toolId)}`, {
        method: 'PUT',
        body: JSON.stringify({ authMode }),
      });
      this.setSwitchFrameworkStatus(`Updated ${toolLabel} to ${authMode}.`, 'success');
      await this.refreshToolModes();
    } catch (error) {
      this.setSwitchFrameworkStatus(`Failed to update ${toolLabel}: ${toErrorMessage(error)}`, 'error');
    }
  }

  /**
   * @description Open RAG modal and load collection hints.
   */
  async openRagModal() {
    if (this.ragWorkspace?.open) {
      this.closeToolsModal();
      this.closeQuickSettingsModal();
      this.closeHistoryModal();
      this.ragWorkspace.open();
      return;
    }

    this.closeToolsModal();
    this.closeQuickSettingsModal();
    this.closeHistoryModal();
    this.elements.ragModal.hidden = false;
    this.setRagStatus('Loading RAG collections...', 'info');
    try {
      const payload = await this.requestJson('/api/rag/collections');
      this.renderRagCollections(Array.isArray(payload?.collections) ? payload.collections : []);
      this.setRagStatus('RAG workspace ready.', 'success');
    } catch (error) {
      this.setRagStatus(`Failed to load collections: ${toErrorMessage(error)}`, 'error');
    }
  }

  /**
   * @description Hide RAG modal.
   */
  closeRagModal() {
    if (this.ragWorkspace?.close) {
      this.ragWorkspace.close();
      return;
    }
    this.elements.ragModal.hidden = true;
  }

  /**
   * @description Upload selected files into the chosen RAG collection for the active bot/task.
   */
  async uploadRagFiles() {
    const files = this.elements.ragFileInput?.files;
    if (!files || files.length === 0) {
      return;
    }

    const formData = new FormData();
    for (const file of Array.from(files)) {
      formData.append('files', file);
    }
    formData.append('collection', this.readCollectionName());
    formData.append('agentId', this.getAgentId());
    formData.append('taskId', this.getTaskId());
    this.setRagStatus('Uploading knowledge files...', 'info');
    try {
      const response = await fetch('/api/rag/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const payload = await parseResponseJson(response);
      if (!response.ok) {
        throw new Error(readString(payload?.error) || `${response.status} ${response.statusText}`);
      }
      this.setRagStatus(`Uploaded ${readNumber(payload?.count, 0)} document(s).`, 'success');
      this.elements.ragFileInput.value = '';
    } catch (error) {
      this.setRagStatus(`Upload failed: ${toErrorMessage(error)}`, 'error');
    }
  }

  /**
   * @description Search RAG using current query/collection values and render matches.
   */
  async searchRag() {
    const query = readString(this.elements.ragSearchInput?.value);
    if (!query) {
      this.setRagStatus('Enter a search query first.', 'error');
      return;
    }

    const collection = this.readCollectionName();
    const url = `/api/rag/search?q=${encodeURIComponent(query)}&collection=${encodeURIComponent(collection)}&topK=5`;
    this.setRagStatus('Searching knowledge base...', 'info');
    try {
      const payload = await this.requestJson(url);
      const results = Array.isArray(payload?.results) ? payload.results : [];
      this.renderRagResults(results);
      this.setRagStatus(`Found ${results.length} result(s).`, 'success');
    } catch (error) {
      this.setRagStatus(`Search failed: ${toErrorMessage(error)}`, 'error');
    }
  }

  /**
   * @description Probe RAG service health endpoint.
   */
  async checkRagHealth() {
    this.setRagStatus('Checking RAG service health...', 'info');
    try {
      const payload = await this.requestJson('/api/rag/health');
      this.setRagStatus(`RAG health: ${readString(payload?.chromadb) || 'unknown'}.`, 'success');
    } catch (error) {
      this.setRagStatus(`Health check failed: ${toErrorMessage(error)}`, 'error');
    }
  }

  /**
   * @description Render collection options into the collection datalist.
   * @param {unknown[]} collections - RAG collection names.
   */
  renderRagCollections(collections) {
    this.elements.ragCollectionsList.innerHTML = collections
      .map((collection) => readString(collection))
      .filter((collection) => collection.length > 0)
      .map((collection) => `<option value="${escapeHtml(collection)}"></option>`)
      .join('');
  }

  /**
   * @description Render RAG search results into the workspace list.
   * @param {Record<string, unknown>[]} results - RAG result objects.
   */
  renderRagResults(results) {
    if (!results.length) {
      this.elements.ragResults.innerHTML = '<div class="empty-state">No matching RAG results.</div>';
      return;
    }

    this.elements.ragResults.innerHTML = results.map((entry) => {
      const text = readString(entry?.text || entry?.document || '');
      const score = readNumber(entry?.score, null);
      const source = readString(entry?.metadata?.source || entry?.metadata?.fileName || 'unknown source');
      return `
        <article class="workspace-result-item">
          <strong>${escapeHtml(source)}</strong>
          <span>${score === null ? 'score: n/a' : `score: ${score}`}</span>
          <p>${escapeHtml(text || '(no excerpt)')}</p>
        </article>
      `;
    }).join('');
  }

  /**
   * @description Render switch-framework tool rows.
   * @param {Record<string, unknown>[]} tools - Tool rows from the per-agent tool API.
   */
  renderToolModes(tools) {
    if (!tools.length) {
      this.elements.switchFrameworkList.innerHTML = '<div class="empty-state">No tools are registered for this bot.</div>';
      return;
    }

    this.elements.switchFrameworkList.innerHTML = tools.map((tool) => {
      const toolId = readString(tool?.id || tool?.toolId || '');
      const name = readString(tool?.displayName || tool?.name || toolId || 'Unnamed Tool');
      const authMode = readString(tool?.authMode || 'off');
      const installed = readBoolean(tool?.installed);
      return `
        <article class="tool-switch-row">
          <div class="tool-switch-head">
            <strong>${escapeHtml(name)}</strong>
            <code>${escapeHtml(toolId || 'unknown')}</code>
          </div>
          <div class="tool-switch-controls">
            <select data-tool-id="${escapeHtml(toolId)}" data-tool-name="${escapeHtml(name)}">
              ${renderAuthModeOptions(authMode)}
            </select>
            <span class="tool-switch-state">${installed ? 'Installed' : 'Not installed'}</span>
          </div>
        </article>
      `;
    }).join('');
  }

  /**
   * @description Update local RAG status message and shared workspace strip.
   * @param {string} message - Status text.
   * @param {string} tone - Visual tone.
   */
  setRagStatus(message, tone) {
    this.elements.ragStatus.textContent = message;
    this.elements.ragStatus.dataset.tone = tone;
    this.setStatus(message, tone);
  }

  /**
   * @description Update switch-framework status row and shared status strip.
   * @param {string} message - Status text.
   * @param {string} tone - Visual tone.
   */
  setSwitchFrameworkStatus(message, tone) {
    this.elements.switchFrameworkStatus.textContent = message;
    this.elements.switchFrameworkStatus.dataset.tone = tone;
    this.setStatus(message, tone);
  }

  /**
   * @description Update quick-settings status row and shared status strip.
   * @param {string} message - Status text.
   * @param {string} tone - Visual tone.
   */
  setQuickSettingsStatus(message, tone) {
    this.elements.quickSettingsStatus.textContent = message;
    this.elements.quickSettingsStatus.dataset.tone = tone;
    this.setStatus(message, tone);
  }

  /**
   * @description Render selected-bot task history rows with load-task handlers.
   * @param {Record<string, unknown>[]} tasks - Recent task list.
   */
  renderHistory(tasks) {
    if (!tasks.length) {
      this.elements.historyList.innerHTML = '<div class="empty-state">No task history exists for this bot yet.</div>';
      return;
    }

    this.elements.historyList.innerHTML = tasks.map((task) => `
      <div class="history-item">
        <div>
          <strong>${escapeHtml(readString(task.title) || readString(task.taskId) || 'Untitled task')}</strong>
          <span>${escapeHtml(readString(task.status) || 'unknown')} · ${escapeHtml(readString(task.updatedAt) || 'no timestamp')}</span>
        </div>
        <button type="button" data-load-task-id="${escapeHtml(readString(task.taskId))}">Load Conversation</button>
      </div>
    `).join('');

    this.elements.historyList.querySelectorAll('[data-load-task-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const taskId = readString(button.getAttribute('data-load-task-id'));
        this.navigateToTask(taskId);
      });
    });
  }

  /**
   * @description Navigate to selected history task while preserving cockpit embed behavior.
   * @param {string} taskId - Task identifier to load.
   */
  navigateToTask(taskId) {
    if (!taskId) {
      return;
    }

    if (isEmbedded()) {
      window.parent.postMessage({ type: COCKPIT_LOAD_TASK_EVENT, taskId }, window.location.origin);
      return;
    }

    const params = new URLSearchParams(window.location.search);
    params.set('taskId', taskId);
    window.location.search = `?${params.toString()}`;
  }

  /**
   * @description Hide advanced config modal and clear embedded iframe source.
   */
  closeConfigModal() {
    this.elements.toolsConfigModal.hidden = true;
    this.elements.toolsConfigFrame.setAttribute('src', 'about:blank');
  }

  /**
   * @description Populate quick-settings fields from selected-bot profile values.
   * @param {Record<string, unknown>} profile - Selected-bot profile.
   */
  applyQuickSettingsProfile(profile) {
    const name = readString(profile?.name);
    const projectUrl = readString(profile?.projectUrl);
    const providerId = readString(profile?.providerId) || 'anthropic';
    const status = readString(profile?.status) || 'active';
    const modelId = readString(profile?.modelId);
    const skills = readString(profile?.selectorSkillsText);
    const themePreference = readString(profile?.themePreference) || 'midnight';
    this.elements.quickSettingsNameInput.value = name;
    this.elements.quickSettingsProjectUrlInput.value = projectUrl;
    this.elements.quickSettingsProviderSelect.value = providerId;
    this.elements.quickSettingsStatusSelect.value = status;
    this.elements.quickSettingsModelInput.value = modelId;
    this.elements.quickSettingsSkillsInput.value = skills;
    this.elements.quickSettingsThemeSelect.value = themePreference;
    this.elements.quickSettingsExcludeBulkInput.checked = readBoolean(profile?.excludeFromBulkConfig);
    this.elements.quickSettingsRuntimeInput.value = `${providerId} · ${modelId || 'provider default'}`;
  }

  /**
   * @description Render provider options for quick settings with a fallback to the selected profile.
   * @param {Array<Record<string, unknown>>} providers - Provider summaries from the API.
   * @param {Record<string, unknown>} profile - Selected-bot profile.
   */
  applyQuickSettingsProviderOptions(providers, profile) {
    const select = this.elements.quickSettingsProviderSelect;
    if (!select) {
      return;
    }

    this._cachedProviders = Array.isArray(providers) ? providers : [];
    const selectedValue = readString(profile?.providerId) || 'anthropic';
    const normalizedProviders = this._cachedProviders;
    if (normalizedProviders.length === 0) {
      select.innerHTML = `<option value="${escapeHtml(selectedValue)}">${escapeHtml(selectedValue)}</option>`;
      select.value = selectedValue;
      return;
    }

    select.innerHTML = normalizedProviders.map((provider) => {
      const providerId = readString(provider?.id);
      const label = readString(provider?.displayName || provider?.name || providerId);
      const selected = providerId === selectedValue ? ' selected' : '';
      return `<option value="${escapeHtml(providerId)}"${selected}>${escapeHtml(label || providerId)}</option>`;
    }).join('');

    if (!select.value) {
      select.value = selectedValue;
    }

    // Populate model dropdown for the selected provider
    this._populateModelDropdown(selectedValue, readString(profile?.modelId));

    // Wire provider change to update model dropdown
    select.addEventListener('change', () => {
      this._populateModelDropdown(select.value, '');
    });
  }

  /**
   * @description Populate the model dropdown from the cached provider registry.
   * @param {string} providerId - Selected provider identifier.
   * @param {string} selectedModelId - Currently selected model identifier.
   */
  _populateModelDropdown(providerId, selectedModelId) {
    const modelSelect = this.elements.quickSettingsModelInput;
    if (!modelSelect || modelSelect.tagName !== 'SELECT') {
      return;
    }

    const providers = this._cachedProviders || [];
    const providerMeta = providers.find((p) => readString(p?.id) === providerId);
    const models = Array.isArray(providerMeta?.models) ? providerMeta.models : [];

    if (models.length === 0) {
      const fallback = selectedModelId || providerMeta?.defaultModelId || '';
      modelSelect.innerHTML = fallback
        ? `<option value="${escapeHtml(fallback)}" selected>${escapeHtml(fallback)}</option>`
        : '<option value="">No models available</option>';
      return;
    }

    const preferredModelId = selectedModelId || providerMeta?.defaultModelId || models[0]?.id || '';
    modelSelect.innerHTML = models.map((model) => {
      const modelId = readString(model?.id);
      const modelLabel = readString(model?.name || model?.id) || 'Unnamed Model';
      const selected = modelId === preferredModelId ? ' selected' : '';
      return `<option value="${escapeHtml(modelId)}"${selected}>${escapeHtml(modelLabel)}</option>`;
    }).join('');
  }

  /**
   * @description Collect editable quick-settings fields for profile patch requests.
   * @returns {Record<string, string>} Profile patch payload.
   */
  readQuickSettingsDraft() {
    return {
      name: readString(this.elements.quickSettingsNameInput.value),
      status: readString(this.elements.quickSettingsStatusSelect.value) || 'active',
      providerId: readString(this.elements.quickSettingsProviderSelect.value) || 'anthropic',
      modelId: readString(this.elements.quickSettingsModelInput.value),
      projectUrl: readString(this.elements.quickSettingsProjectUrlInput.value),
      selectorSkillsText: readString(this.elements.quickSettingsSkillsInput.value),
      themePreference: readString(this.elements.quickSettingsThemeSelect.value) || 'midnight',
      excludeFromBulkConfig: this.elements.quickSettingsExcludeBulkInput.checked === true,
    };
  }

  /**
   * @description Build a bulk-config template from the quick-settings modal, omitting blank fields.
   * @returns {Record<string, string>} Bulk template payload.
   */
  readQuickSettingsBulkDraft() {
    const payload = {
      status: readString(this.elements.quickSettingsStatusSelect.value),
      providerId: readString(this.elements.quickSettingsProviderSelect.value),
      modelId: readString(this.elements.quickSettingsModelInput.value),
      projectUrl: readString(this.elements.quickSettingsProjectUrlInput.value),
      selectorSkillsText: readString(this.elements.quickSettingsSkillsInput.value),
      themePreference: readString(this.elements.quickSettingsThemeSelect.value),
    };

    return Object.fromEntries(Object.entries(payload).filter(([, value]) => readString(value).length > 0));
  }

  /**
   * @description Read current collection name from the RAG collection field.
   * @returns {string} Collection name with default fallback.
   */
  readCollectionName() {
    return readString(this.elements.ragCollectionInput?.value) || 'default';
  }
}

/**
 * @description Normalize unknown values into trimmed text.
 * @param {unknown} value - Unknown text candidate.
 * @returns {string} Trimmed string or empty string.
 */
function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @description Convert unknown values into numbers with fallback support.
 * @param {unknown} value - Unknown number candidate.
 * @param {number | null} fallback - Fallback number.
 * @returns {number | null} Parsed number.
 */
function readNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number.parseFloat(readString(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @description Normalize unknown values into booleans for UI state.
 * @param {unknown} value - Unknown boolean candidate.
 * @returns {boolean} True when the value indicates enabled/installed state.
 */
function readBoolean(value) {
  return value === true || readString(value) === 'true';
}

/**
 * @description Convert unknown errors into safe UI messages.
 * @param {unknown} error - Unknown error payload.
 * @returns {string} Human-readable error string.
 */
function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @description Parse JSON payloads from fetch responses without throwing.
 * @param {Response} response - Fetch response.
 * @returns {Promise<Record<string, unknown> | null>} Parsed object payload.
 */
async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

/**
 * @description Escape untrusted text for safe HTML rendering.
 * @param {string} value - Potentially untrusted text.
 * @returns {string} HTML-safe string.
 */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @description Render auth mode options for tool controls.
 * @param {string} selectedValue - Current auth mode.
 * @returns {string} Option markup.
 */
function renderAuthModeOptions(selectedValue) {
  return ['auto', 'ask', 'off']
    .map((mode) => `<option value="${mode}"${mode === selectedValue ? ' selected' : ''}>${mode}</option>`)
    .join('');
}

/**
 * @description Determine whether the workspace is hosted inside cockpit embed mode.
 * @returns {boolean} True when embedded.
 */
function isEmbedded() {
  return document.documentElement.getAttribute('data-embedded') === 'cockpit';
}

/**
 * @description Navigate to the office-suite AI Office surface (the presentation/document/
 * spreadsheet engine) via the canonical ?app= deep link. Breaks out of the cockpit embed
 * frame when hosted inside it.
 * @returns {void}
 */
function openAiOffice() {
  const target = '/cockpit?app=presentations';
  try {
    if (window.top && window.top !== window) {
      window.top.location.href = target;
      return;
    }
  } catch (error) {
    // Cross-origin top window can't be navigated directly; fall back to this frame.
  }
  window.location.href = target;
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted standalone chat config controller from chat-standalone.html, added header theme cycle toggle, and modularized tool auth rendering
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Unified theme control to one top-level icon toggle and removed duplicate modal theme selectors
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Refreshed config modal state when external tool-setting saves fire oshal:tool-config-changed so validation uses current endpoint and credential data
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Expanded supported cockpit themes to include gray, black, and light-blue across chat and embedded API config
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Synced Presentron runtime side effects from tool-row config so required endpoint fields are declared and saved from the same tool contract
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Extracted persistence helpers from the modal controller to get back under the 800-line governance trigger
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Applied embedded API panel config payloads directly to the chat footer summary so provider/model selections appear after refresh without an extra save
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Expanded the theme registry with aurora, graphite, and amber premium glass themes
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Switched standalone chat agent-profile reads/writes to dedicated /api/agents/:agentId/profile persistence
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Extracted hardcoded provider model-catalog overrides into a dedicated chat asset module so the monolithic modal owns less provider inventory policy directly
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Added claude-code to the no-manual-fields exemption in getRenderableProviderConfigKeys so the UI shows only the Sign In button instead of a CLI path text input
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Removed claude-code from getRenderableProviderConfigKeys exemption so anthropicApiKey and claudeCodePath fields render in the chat config modal
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Added PKCE code-submission UI to auth flow: code entry field appears after Sign In popup opens, submitProviderAuthCode posts to /submit-code endpoint
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Removed manual code-entry UI — OAuth now auto-completes via server-side PKCE callback with frontend polling (no copy/paste required)
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed at the 1000-code-line cap (the file had reached 1850): shared state moved to chat-config-modal-state.mjs, the API runtime + provider OAuth section to chat-config-api-runtime.mjs, the Redis scheduler CRUD to chat-config-scheduler.mjs, and agent-profile/avatar handling to chat-config-agent-profile.mjs. Every body moved verbatim; this file keeps the theme cycle, the tool/MCP sections, the load/save orchestration, and the bootstrap.
 */

import { ChatApp } from '/dist/chat-ui.js';
import {
  formatThemeLabel,
  generateTaskId,
  mergeCachedApiConfigPreview,
  resolveTheme,
} from '/chat-assets/chat-config-ui-utils.mjs';
import {
  DEFAULT_CHAT_AGENT_ID,
  SUPPORTED_THEMES,
  clearModalStatus,
  elements,
  getActiveAgentId,
  getActiveProviderSelection,
  getChatAgentConfig,
  getProviderLabel,
  readNonEmptyString,
  renderApiRuntimeSummary,
  renderProviderStatus,
  setModalStatus,
  uiState,
} from '/chat-assets/chat-config-modal-state.mjs';
import {
  bindApiRuntimeEvents,
  renderApiRuntimeEditor,
  saveApiRuntimeConfiguration,
} from '/chat-assets/chat-config-api-runtime.mjs';
import {
  bindSchedulerEvents,
  buildSchedulerReport,
  ensureSchedulerToolModeLoaded,
  getFilteredSchedules,
  getSelectedSchedulerToolMode,
  renderScheduleEditor,
  renderScheduledJobs,
  renderSchedulerReport,
  seedSchedulerToolModeCache,
  syncScheduleEditorState,
  syncSchedulerAgentFilter,
} from '/chat-assets/chat-config-scheduler.mjs';
import {
  bindAgentProfileInputs,
  buildNextChatProfilePayload,
  renderAgentProfile,
  resetPendingAvatarState,
  uploadPendingAvatarIfNeeded,
} from '/chat-assets/chat-config-agent-profile.mjs';
import {
  getToolAuthFields,
  normalizeToolConfig,
  setConfigValue,
} from '/chat-assets/chat-tool-config-auth.mjs';
import { summarizeMcpServer } from '/chat-assets/chat-mcp-render-utils.mjs';
import {
  buildToolSwitchCard,
  collectToolActivationErrors,
  getEffectiveAuthMode,
  getEffectiveToolConfig,
  getEnabledAgentTools,
  getGeneratedSkills,
  sortToolsByName,
} from '/chat-assets/chat-tool-switch-utils.mjs';
import {
  persistChatAndMcpConfig,
  persistToolConfigUpdates,
  persistToolModeUpdates,
  validateToolActivationState,
} from '/chat-assets/chat-config-persistence.mjs';
import {
  escapeHtml,
  requestJson,
} from '/chat-assets/chat-workspace-popups-utils.mjs';

    function applyTheme(theme) {
      const nextTheme = resolveTheme(theme, SUPPORTED_THEMES);
      uiState.theme = nextTheme;
      document.documentElement.setAttribute('data-theme', nextTheme);
      localStorage.setItem('cockpit-theme', nextTheme);
      if (elements.themeCycleBtn) {
        elements.themeCycleBtn.dataset.theme = nextTheme;
        elements.themeCycleBtn.title = `Theme: ${formatThemeLabel(nextTheme)} (click to cycle)`;
        elements.themeCycleBtn.setAttribute('aria-label', `Theme: ${formatThemeLabel(nextTheme)}. Click to cycle theme.`);
      }
    }

    function cycleTheme() {
      const currentIndex = SUPPORTED_THEMES.indexOf(uiState.theme);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % SUPPORTED_THEMES.length : 0;
      const nextTheme = SUPPORTED_THEMES[nextIndex];
      applyTheme(nextTheme);
      renderProviderStatus();
      void persistThemePreference();
    }

    async function persistThemePreference() {
      try {
        await requestJson(`/api/agents/${getActiveAgentId()}/profile`, {
          method: 'PUT',
          body: JSON.stringify({
            profile: {
              themePreference: uiState.theme,
            },
          }),
        });
      } catch (error) {
        console.error('Failed to persist theme preference:', error);
      }
    }

    function renderGeneratedSkills() {
      const skills = getGeneratedSkills(uiState.agentTools, uiState.pendingToolModes);
      if (skills.length === 0) {
        elements.generatedSkills.innerHTML = '<span class="chip chip-muted">No Layer-1 tool skills enabled yet</span>';
        return;
      }

      elements.generatedSkills.innerHTML = skills.map((skill) => `<span class="chip">${escapeHtml(skill)}</span>`).join('');
    }

    function renderBotStats() {
      const enabledTools = getEnabledAgentTools(uiState.agentTools, uiState.pendingToolModes);
      const mcpServerCount = Object.keys(uiState.mcpConfig?.mcpServers || {}).length;
      const installedCount = enabledTools.filter((tool) => tool.installed).length;
      const selection = getActiveProviderSelection();
      const stats = [
        { value: enabledTools.length, label: 'Enabled Tools' },
        { value: installedCount, label: 'Installed' },
        { value: mcpServerCount, label: 'MCP Servers' },
        { value: getProviderLabel(selection.provider), label: 'Provider' },
      ];

      elements.botStats.innerHTML = stats.map((stat) => `
        <div class="stat-card">
          <strong>${escapeHtml(String(stat.value))}</strong>
          <span>${escapeHtml(stat.label)}</span>
        </div>
      `).join('');
    }

    function renderMcpServers() {
      const servers = Object.entries(uiState.mcpConfig?.mcpServers || {});
      if (servers.length === 0) {
        elements.mcpServerList.innerHTML = '<div class="muted-empty">No MCP servers configured yet.</div>';
        return;
      }

      elements.mcpServerList.innerHTML = servers.map(([name, config]) => {
        const envCount = config && typeof config.env === 'object' && !Array.isArray(config.env)
          ? Object.keys(config.env).length
          : 0;
        return `
          <div class="mcp-server-card">
            <div class="mcp-server-header">
              <div>
                <strong>${escapeHtml(name)}</strong>
                <span>${escapeHtml(summarizeMcpServer(config || {}, readNonEmptyString))}</span>
              </div>
              <span class="status-pill">${envCount} env</span>
            </div>
          </div>
        `;
      }).join('');
    }

    function renderToolSwitches() {
      if (!Array.isArray(uiState.agentTools) || uiState.agentTools.length === 0) {
        elements.toolSwitchList.innerHTML = '<div class="muted-empty">Tool registry is empty or still bootstrapping.</div>';
        return;
      }

      const tools = sortToolsByName(uiState.agentTools);
      const agentConfig = getChatAgentConfig();
      elements.toolSwitchList.innerHTML = tools.map((tool) => buildToolSwitchCard({
        tool,
        effectiveAuthMode: getEffectiveAuthMode(tool, uiState.pendingToolModes),
        toolConfig: getEffectiveToolConfig(tool, uiState.pendingToolConfigs),
        agentConfig,
        escapeHtml,
        getToolAuthFields,
      })).join('');
    }

    function renderMcpEditor() {
      elements.mcpJsonEditor.value = JSON.stringify(uiState.mcpConfig || { mcpServers: {} }, null, 2);
      elements.mcpEditorWrap.classList.toggle('hidden', !uiState.mcpEditorOpen);
      elements.toggleMcpEditorBtn.textContent = uiState.mcpEditorOpen ? 'Hide JSON' : 'Configure JSON';
    }

    function renderAllConfigViews() {
      renderProviderStatus();
      renderApiRuntimeSummary();
      renderApiRuntimeEditor();
      renderAgentProfile();
      renderGeneratedSkills();
      renderBotStats();
      renderSchedulerReport();
      renderScheduleEditor();
      renderScheduledJobs();
      renderMcpServers();
      renderToolSwitches();
      renderMcpEditor();
    }

    async function loadConfigState() {
      const [configResult, profileResult, providersResult, toolsResult, mcpResult, agentsResult, schedulerStatusResult, schedulesResult] = await Promise.allSettled([
        requestJson('/api/config'),
        requestJson(`/api/agents/${DEFAULT_CHAT_AGENT_ID}/profile`),
        requestJson('/api/providers'),
        requestJson(`/api/agents/${DEFAULT_CHAT_AGENT_ID}/tools`),
        requestJson('/api/config/mcp'),
        requestJson('/api/agents'),
        requestJson('/api/v1/agent/scheduler/status'),
        requestJson('/api/v1/agent/schedules'),
      ]);

      if (configResult.status === 'fulfilled') {
        uiState.config = mergeCachedApiConfigPreview(configResult.value?.config || {});
      }
      if (profileResult.status === 'fulfilled') {
        uiState.agentProfile = profileResult.value?.profile && typeof profileResult.value.profile === 'object'
          ? profileResult.value.profile
          : null;
      }
      const persistedTheme = readNonEmptyString(uiState.agentProfile?.themePreference)
        || readNonEmptyString(uiState.config?.chatAgentConfig?.themePreference);
      if (persistedTheme) {
        applyTheme(persistedTheme);
      }
      if (providersResult.status === 'fulfilled') {
        uiState.providers = Array.isArray(providersResult.value) ? providersResult.value : [];
      }
      uiState.providerMap = new Map(uiState.providers.map((provider) => [provider.id, provider]));
      uiState.agentTools = toolsResult.status === 'fulfilled' && Array.isArray(toolsResult.value?.tools)
        ? toolsResult.value.tools
        : [];
      uiState.pendingToolModes.clear();
      uiState.pendingToolConfigs.clear();
      resetPendingAvatarState();
      uiState.mcpConfig = mcpResult.status === 'fulfilled' && mcpResult.value?.config && typeof mcpResult.value.config === 'object'
        ? mcpResult.value.config
        : { mcpServers: {} };
      uiState.schedulerAgents = agentsResult.status === 'fulfilled' && Array.isArray(agentsResult.value?.agents)
        ? agentsResult.value.agents
        : [];
      uiState.schedulerStatus = schedulerStatusResult.status === 'fulfilled' ? schedulerStatusResult.value : null;
      uiState.schedulerSchedules = schedulesResult.status === 'fulfilled' && Array.isArray(schedulesResult.value?.schedules)
        ? schedulesResult.value.schedules
        : [];
      seedSchedulerToolModeCache();
      syncSchedulerAgentFilter();
      syncScheduleEditorState();
      await ensureSchedulerToolModeLoaded(uiState.schedulerAgentFilter);
      uiState.schedulerReport = buildSchedulerReport(
        uiState.schedulerStatus,
        getFilteredSchedules(),
        getSelectedSchedulerToolMode(),
      );

      if (configResult.status === 'rejected' || providersResult.status === 'rejected') {
        throw new Error(
          configResult.status === 'rejected'
            ? configResult.reason?.message || 'Failed to load chat configuration'
            : providersResult.reason?.message || 'Failed to load provider catalog',
        );
      }

      renderAllConfigViews();
    }

    async function refreshConfigState(showErrors = false) {
      try {
        await loadConfigState();
      } catch (error) {
        console.error('Failed to refresh tools configuration state:', error);
        if (showErrors) {
          setModalStatus(`Failed to refresh configuration: ${error.message}`, 'error');
        }
        renderProviderStatus();
      }
    }

    function openConfigModal() {
      elements.modal.hidden = false;
      clearModalStatus();
      setActiveConfigSection(uiState.activeConfigSection || 'api');
      void refreshConfigState(true);
    }

    function closeConfigModal() {
      elements.modal.hidden = true;
      clearModalStatus();
      void refreshConfigState(false);
    }

    function setActiveConfigSection(sectionId) {
      const nextSection = readNonEmptyString(sectionId) || 'api';
      uiState.activeConfigSection = nextSection;

      document.querySelectorAll('[data-config-section]').forEach((button) => {
        const isActive = button.getAttribute('data-config-section') === nextSection;
        button.classList.toggle('active', isActive);
      });

      document.querySelectorAll('[data-config-panel]').forEach((panel) => {
        panel.hidden = panel.getAttribute('data-config-panel') !== nextSection;
      });

      elements.saveToolsConfigBtn.textContent = nextSection === 'api' ? 'Save API Config' : 'Save';
    }

    function updatePendingToolMode(toolId, authMode) {
      uiState.pendingToolModes.set(toolId, authMode);
      const tool = uiState.agentTools.find((entry) => entry.toolId === toolId);
      if (readNonEmptyString(tool?.tool?.name || tool?.name) === 'agent-scheduler') {
        uiState.schedulerAgentToolModes.set(getActiveAgentId(), authMode);
      }
      renderGeneratedSkills();
      renderBotStats();
      renderSchedulerReport();
      renderToolSwitches();
    }

    function parseConfigInputValue(path, target) {
      if (target instanceof HTMLInputElement && target.type === 'checkbox') {
        return target.checked;
      }

      const rawValue = target.value;
      if (path === 'auth.oauth2.scopes') {
        return rawValue
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
      }

      return rawValue;
    }

    function updatePendingToolConfig(toolId, path, value) {
      const tool = uiState.agentTools.find((entry) => entry.toolId === toolId);
      if (!tool) {
        return;
      }

      const currentConfig = getEffectiveToolConfig(tool, uiState.pendingToolConfigs);
      const nextConfig = setConfigValue(currentConfig, path, value);
      uiState.pendingToolConfigs.set(toolId, nextConfig);
      if (path === 'auth.type' || path === 'auth.enabled') {
        renderToolSwitches();
      }
    }

    function applyMcpJsonEditor() {
      try {
        const parsed = JSON.parse(elements.mcpJsonEditor.value || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('MCP config must be a JSON object');
        }
        uiState.mcpConfig = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
          ? parsed
          : { mcpServers: {} };
        uiState.mcpEditorOpen = false;
        renderMcpServers();
        renderMcpEditor();
        renderBotStats();
        setModalStatus('Applied MCP JSON locally. Save to persist it.', 'info');
      } catch (error) {
        setModalStatus(`Invalid MCP JSON: ${error.message}`, 'error');
      }
    }

    async function saveConfiguration() {
      clearModalStatus();
      setModalStatus('Saving configuration...', 'info');

      try {
        validateToolActivationState({
          agentTools: uiState.agentTools,
          pendingToolModes: uiState.pendingToolModes,
          pendingToolConfigs: uiState.pendingToolConfigs,
          agentConfig: getChatAgentConfig(),
          collectToolActivationErrors,
          setActiveConfigSection,
        });
        const uploadedAvatarUrl = await uploadPendingAvatarIfNeeded();
        await persistChatAndMcpConfig({
          agentId: getActiveAgentId(),
          agentProfile: buildNextChatProfilePayload(uploadedAvatarUrl),
          mcpConfig: uiState.mcpConfig,
          requestJson,
        });
        await persistToolConfigUpdates({
          agentId: getActiveAgentId(),
          agentTools: uiState.agentTools,
          pendingToolConfigs: uiState.pendingToolConfigs,
          requestJson,
        });
        await persistToolModeUpdates({
          agentId: getActiveAgentId(),
          agentTools: uiState.agentTools,
          pendingToolModes: uiState.pendingToolModes,
          requestJson,
        });
        uiState.pendingToolModes.clear();
        uiState.pendingToolConfigs.clear();
        resetPendingAvatarState();
        await refreshConfigState(false);
        document.dispatchEvent(new CustomEvent('oshal:tool-config-changed'));
        setModalStatus('Saved agent, MCP, tool switch, and tool auth configuration.', 'success');
      } catch (error) {
        console.error('Failed to save configuration:', error);
        setModalStatus(`Save failed: ${error.message}`, 'error');
      }
    }

    function saveActiveConfigSection() {
      if (uiState.activeConfigSection === 'api') {
        void saveApiRuntimeConfiguration();
        return;
      }

      void saveConfiguration();
    }

    function reloadApiRuntimeConfig() {
      clearModalStatus();
      setModalStatus('Reloading saved API runtime configuration...', 'info');
      void refreshConfigState(true);
    }

    function bindConfigEvents() {
      bindModalActions();
      bindApiRuntimeEvents();
      bindSectionNavigation();
      bindAgentProfileInputs();
      bindMcpEditorEvents();
      bindToolSwitchEvents();
      bindThemeEvents();
      bindSchedulerEvents();
      bindKeyboardEvents();
      // Presentron and other workspace popups can persist tool settings outside the tool list.
      // Refresh the modal state so subsequent validation uses the latest saved config.
      document.addEventListener('oshal:tool-config-changed', () => { void refreshConfigState(false); });
    }

    function bindModalActions() {
      document.getElementById('openToolsConfigBtn').addEventListener('click', openConfigModal);
      document.getElementById('closeToolsConfigBtn').addEventListener('click', closeConfigModal);
      document.getElementById('saveToolsConfigBtn').addEventListener('click', saveActiveConfigSection);
      elements.reloadApiConfigBtn?.addEventListener('click', reloadApiRuntimeConfig);
      document.querySelectorAll('[data-close-modal]').forEach((element) => {
        element.addEventListener('click', closeConfigModal);
      });
    }

    function bindSectionNavigation() {
      document.querySelectorAll('[data-config-section]').forEach((button) => {
        button.addEventListener('click', () => {
          setActiveConfigSection(button.getAttribute('data-config-section'));
        });
      });
    }

    function bindMcpEditorEvents() {
      elements.toggleMcpEditorBtn.addEventListener('click', () => {
        uiState.mcpEditorOpen = !uiState.mcpEditorOpen;
        renderMcpEditor();
      });
      document.getElementById('cancelMcpEditorBtn').addEventListener('click', () => {
        uiState.mcpEditorOpen = false;
        renderMcpEditor();
      });
      document.getElementById('applyMcpEditorBtn').addEventListener('click', applyMcpJsonEditor);
    }

    function bindToolSwitchEvents() {
      elements.toolSwitchList.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const toolId = target.dataset.toolId;
        const authMode = target.dataset.authMode;
        if (!toolId || !authMode) {
          return;
        }
        updatePendingToolMode(toolId, authMode);
      });

      const toolConfigHandler = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
          return;
        }
        const toolId = target.dataset.toolId;
        const path = target.dataset.configPath;
        if (!toolId || !path) {
          return;
        }
        const value = parseConfigInputValue(path, target);
        updatePendingToolConfig(toolId, path, value);
      };

      elements.toolSwitchList.addEventListener('change', toolConfigHandler);
      elements.toolSwitchList.addEventListener('input', toolConfigHandler);
    }

    function bindThemeEvents() {
      if (elements.themeCycleBtn) {
        elements.themeCycleBtn.addEventListener('click', cycleTheme);
      }
    }

    function bindKeyboardEvents() {
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !elements.modal.hidden) {
          closeConfigModal();
        }
      });
    }

    function handleTaskUpdate(detail) {
      if (!detail || typeof detail !== 'object') {
        return;
      }
      const nextStatus = detail.task?.status || detail.status;
      if (typeof nextStatus === 'string' && nextStatus.trim().length > 0) {
        uiState.taskStatus = nextStatus;
        renderProviderStatus();
        renderBotStats();
      }
    }

    const requestedTaskId = readNonEmptyString(new URLSearchParams(window.location.search).get('taskId'));
    const taskId = requestedTaskId || generateTaskId();
    uiState.taskId = taskId;
    document.getElementById('taskId').textContent = `Task: ${taskId}`;

    uiState.theme = resolveTheme(localStorage.getItem('cockpit-theme') || document.documentElement.getAttribute('data-theme') || 'midnight', SUPPORTED_THEMES);
    applyTheme(uiState.theme);

    bindConfigEvents();
    void refreshConfigState(false);

    document.addEventListener('oshal-stream:task_update', (event) => handleTaskUpdate(event.detail));
    document.addEventListener('oshal-stream:message', (event) => {
      const detail = event.detail;
      if (detail?.waitingForInput) {
        uiState.taskStatus = 'waiting_for_input';
        renderProviderStatus();
      }
    });

    const chatApp = new ChatApp(taskId);
    chatApp.initialize();

    window.clearChat = () => chatApp.clearChat();
    window.addEventListener('focus', () => { void refreshConfigState(false); });

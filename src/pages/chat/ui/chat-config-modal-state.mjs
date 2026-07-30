/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the chat config modal shared state (uiState, the resolved DOM element map, the agent/provider selectors, and the status + summary renderers) out of chat-config-modal.mjs, which had grown to 1850 code lines — 1.85x the 1000-code-line cap. This module is the single owner of the mutable modal state the api-runtime, scheduler, and agent-profile modules all read and write.
 */

// Bodies below were MOVED verbatim out of chat-config-modal.mjs, including their original
// four-space indentation: the source file kept that indentation at module top level (a leftover
// from an IIFE removed long ago), and re-indenting would rewrite whitespace inside the HTML
// template literals. Exports are declared in one `export { ... }` list at the end so no moved
// line changed at all.

import { resolveTheme } from '/chat-assets/chat-config-ui-utils.mjs';
import { escapeHtml, readString } from '/chat-assets/chat-workspace-popups-utils.mjs';

/**
 * @description Agent id the standalone chat surface configures when no profile has been
 * persisted yet. Every scheduler and profile write is scoped to this id by default.
 * @type {string}
 */
const DEFAULT_CHAT_AGENT_ID = '00000000-0000-4000-8000-000000000032';

/**
 * @description Display name used before a profile name exists, branded from window.__BRAND when
 * the host page injected one.
 * @type {string}
 */
const DEFAULT_CHAT_AGENT_NAME = (typeof window !== 'undefined' && window.__BRAND?.displayName ? window.__BRAND.displayName + ' Chat Agent' : 'Chat Agent');

/**
 * @description Cockpit themes the chat surface can cycle through, in cycle order.
 * @type {string[]}
 */
const SUPPORTED_THEMES = ['midnight', 'daylight', 'ocean', 'sakura', 'forest', 'gray', 'black', 'light-blue', 'aurora', 'graphite', 'amber'];

/**
 * @description Sentinel value for the scheduler bot filter meaning "every bot", kept distinct from
 * an empty selection so a cleared filter and an explicit all-bots choice behave the same.
 * @type {string}
 */
const ALL_AGENTS_FILTER = 'all';

/**
 * @description The one mutable state object for the config modal. It is exported by reference on
 * purpose: the extracted feature modules mutate the same object the renderers read, which is exactly
 * how the single-file version behaved. Do not replace it — mutate its fields.
 * @type {object}
 */
const uiState = {
  taskId: '',
  config: {},
  agentProfile: null,
  providers: [],
  providerMap: new Map(),
  agentTools: [],
  pendingToolModes: new Map(),
  pendingToolConfigs: new Map(),
  mcpConfig: { mcpServers: {} },
  taskStatus: 'idle',
  mcpEditorOpen: false,
  activeConfigSection: 'api',
  theme: 'midnight',
  pendingAvatarFile: null,
  pendingAvatarPreviewUrl: '',
  avatarRemoved: false,
  schedulerReport: null,
  schedulerAgents: [],
  schedulerSchedules: [],
  schedulerStatus: null,
  schedulerAgentFilter: ALL_AGENTS_FILTER,
  schedulerAgentToolModes: new Map(),
  scheduleEditorMode: 'create',
  editingScheduleId: '',
  providerAuthStates: new Map(),
};

/**
 * @description Trim-and-coerce reader used everywhere a DOM value or API field may be missing.
 * Aliased rather than re-exported so the extracted modules keep the original call sites verbatim.
 * @type {(value: unknown) => string}
 */
const readNonEmptyString = readString;

/**
 * @description Resolved DOM handles for the whole modal, looked up once at module evaluation.
 * chat-config-modal.mjs is loaded as a deferred module script, so the document is parsed by the time
 * this runs — the same guarantee the single-file version relied on.
 * @type {Record<string, HTMLElement|null>}
 */
const elements = {
  providerStatus: document.getElementById('providerStatus'),
  agentSummary: document.getElementById('agentSummary'),
  providerSummary: document.getElementById('providerSummary'),
  modelSummary: document.getElementById('modelSummary'),
  taskStatusSummary: document.getElementById('taskStatusSummary'),
  apiRuntimeSummary: document.getElementById('apiRuntimeSummary'),
  agentNameInput: document.getElementById('agentNameInput'),
  agentAvatarFileInput: document.getElementById('agentAvatarFileInput'),
  agentAvatarFileStatus: document.getElementById('agentAvatarFileStatus'),
  clearAgentAvatarBtn: document.getElementById('clearAgentAvatarBtn'),
  projectUrlInput: document.getElementById('projectUrlInput'),
  selectorSkillsInput: document.getElementById('selectorSkillsInput'),
  generatedSkills: document.getElementById('generatedSkills'),
  botStats: document.getElementById('botStats'),
  agentAvatarPreview: document.getElementById('agentAvatarPreview'),
  agentDisplayName: document.getElementById('agentDisplayName'),
  schedulerReportCards: document.getElementById('schedulerReportCards'),
  schedulerReportSummary: document.getElementById('schedulerReportSummary'),
  refreshSchedulerReportBtn: document.getElementById('refreshSchedulerReportBtn'),
  schedulerAgentFilter: document.getElementById('schedulerAgentFilter'),
  scheduledJobList: document.getElementById('scheduledJobList'),
  resetScheduleEditorBtn: document.getElementById('resetScheduleEditorBtn'),
  cancelScheduleEditBtn: document.getElementById('cancelScheduleEditBtn'),
  saveScheduleBtn: document.getElementById('saveScheduleBtn'),
  scheduleTaskTypeInput: document.getElementById('scheduleTaskTypeInput'),
  scheduleTargetAgentSelect: document.getElementById('scheduleTargetAgentSelect'),
  scheduleCronInput: document.getElementById('scheduleCronInput'),
  schedulePromptInput: document.getElementById('schedulePromptInput'),
  scheduleActionInput: document.getElementById('scheduleActionInput'),
  scheduleWorkspaceSlugInput: document.getElementById('scheduleWorkspaceSlugInput'),
  schedulerEditorSummary: document.getElementById('schedulerEditorSummary'),
  modalModePill: document.getElementById('modalModePill'),
  modalProviderPill: document.getElementById('modalProviderPill'),
  apiPlanProviderSelect: document.getElementById('apiPlanProviderSelect'),
  apiPlanModelSelect: document.getElementById('apiPlanModelSelect'),
  apiPlanProviderInfo: document.getElementById('apiPlanProviderInfo'),
  apiActProviderSelect: document.getElementById('apiActProviderSelect'),
  apiActModelSelect: document.getElementById('apiActModelSelect'),
  apiActProviderInfo: document.getElementById('apiActProviderInfo'),
  apiModePlanBtn: document.getElementById('apiModePlanBtn'),
  apiModeActBtn: document.getElementById('apiModeActBtn'),
  apiMaxTokensInput: document.getElementById('apiMaxTokensInput'),
  apiTemperatureInput: document.getElementById('apiTemperatureInput'),
  apiProviderFields: document.getElementById('apiProviderFields'),
  reloadApiConfigBtn: document.getElementById('reloadApiConfigBtn'),
  mcpServerList: document.getElementById('mcpServerList'),
  mcpJsonEditor: document.getElementById('mcpJsonEditor'),
  mcpEditorWrap: document.getElementById('mcpEditorWrap'),
  toolSwitchList: document.getElementById('toolSwitchList'),
  modal: document.getElementById('toolsConfigModal'),
  modalStatus: document.getElementById('modalStatus'),
  toggleMcpEditorBtn: document.getElementById('toggleMcpEditorBtn'),
  saveToolsConfigBtn: document.getElementById('saveToolsConfigBtn'),
  themeCycleBtn: document.getElementById('themeCycleBtn'),
};

/**
 * @description Current runtime mode, defaulting to plan for anything that is not exactly act.
 * @returns {string} Either "act" or "plan".
 */
    function getMode() {
      return uiState.config?.mode === 'act' ? 'act' : 'plan';
    }

/**
 * @description Human-readable provider name for a provider id, or a "not configured" placeholder.
 * @param {string} providerId - Provider id from the config or a select element.
 * @returns {string} Provider display name, the raw id, or "not configured".
 */
    function getProviderLabel(providerId) {
      const id = readNonEmptyString(providerId);
      if (!id) {
        return 'not configured';
      }

      return uiState.providerMap.get(id)?.displayName || id;
    }

/**
 * @description Provider + model pair for the mode that is actually live, so summaries never show
 * the inactive mode.
 * @returns {{provider: string, model: string}} The live selection.
 */
    function getActiveProviderSelection() {
      const mode = getMode();
      return {
        provider: readNonEmptyString(mode === 'act' ? uiState.config.actModeApiProvider : uiState.config.planModeApiProvider),
        model: readNonEmptyString(mode === 'act' ? uiState.config.actModeApiModelId : uiState.config.planModeApiModelId),
      };
    }

/**
 * @description Effective chat agent profile: unsaved form input wins over the persisted profile so
 * validation and summaries reflect what the operator is looking at.
 * @returns {object} Agent id, name, project URL, selector skills, avatar URL, theme preference.
 */
    function getChatAgentConfig() {
      const draftName = readNonEmptyString(elements.agentNameInput?.value);
      const draftProjectUrl = readNonEmptyString(elements.projectUrlInput?.value);
      const draftSelectorSkillsText = readNonEmptyString(elements.selectorSkillsInput?.value);
      const persistedProfile = uiState.agentProfile && typeof uiState.agentProfile === 'object' ? uiState.agentProfile : {};
      const avatarUrl = getCurrentAvatarValue();
      if (draftName || draftProjectUrl || draftSelectorSkillsText || avatarUrl) {
        return {
          agentId: getActiveAgentId(),
          name: draftName || readNonEmptyString(persistedProfile.name) || DEFAULT_CHAT_AGENT_NAME,
          projectUrl: draftProjectUrl,
          selectorSkillsText: draftSelectorSkillsText,
          avatarUrl,
          themePreference: uiState.theme,
        };
      }

      return {
        agentId: getActiveAgentId(),
        name: readNonEmptyString(persistedProfile.name) || DEFAULT_CHAT_AGENT_NAME,
        projectUrl: readNonEmptyString(persistedProfile.projectUrl),
        selectorSkillsText: readNonEmptyString(persistedProfile.selectorSkillsText),
        avatarUrl: readNonEmptyString(persistedProfile.avatarUrl),
        themePreference: resolveTheme(readNonEmptyString(persistedProfile.themePreference) || uiState.theme, SUPPORTED_THEMES),
      };
    }

/**
 * @description Avatar URL that should be shown right now, honoring a pending upload and a pending
 * removal before falling back to the persisted profile.
 * @returns {string} Avatar URL, or empty when the avatar is being removed.
 */
    function getCurrentAvatarValue() {
      if (uiState.avatarRemoved) {
        return '';
      }
      return uiState.pendingAvatarPreviewUrl || readNonEmptyString(uiState.agentProfile?.avatarUrl);
    }

/**
 * @description Agent id every write targets — the persisted profile id when one exists.
 * @returns {string} The active agent id.
 */
    function getActiveAgentId() {
      const persistedAgentId = readNonEmptyString(uiState.agentProfile?.agentId);
      return persistedAgentId || DEFAULT_CHAT_AGENT_ID;
    }

/**
 * @description Write the modal status line. An empty message clears it, which is what makes the
 * tone attribute a reliable signal for "did anything report an error".
 * @param {string} message - Status text, or empty to clear.
 * @param {string} [tone] - Tone attribute value (info/success/error).
 * @returns {void}
 */
    function setModalStatus(message, tone = 'info') {
      if (!message) {
        elements.modalStatus.textContent = '';
        elements.modalStatus.removeAttribute('data-tone');
        return;
      }

      elements.modalStatus.textContent = message;
      elements.modalStatus.setAttribute('data-tone', tone);
    }

/**
 * @description Clear the modal status line.
 * @returns {void}
 */
    function clearModalStatus() {
      setModalStatus('');
    }

/**
 * @description Re-render the provider/agent/model/status header pills from current state.
 * @returns {void}
 */
    function renderProviderStatus() {
      const agentConfig = getChatAgentConfig();
      const selection = getActiveProviderSelection();
      const providerName = getProviderLabel(selection.provider);
      const modelName = selection.model || 'not configured';
      const mode = getMode();

      elements.providerStatus.textContent = `Provider: ${mode} · ${providerName}${selection.model ? ` (${selection.model})` : ''}`;
      elements.agentSummary.innerHTML = `<span class="codicon codicon-hubot"></span>Agent: ${escapeHtml(agentConfig.name)}`;
      elements.providerSummary.innerHTML = `<span class="codicon codicon-plug"></span>Provider: ${escapeHtml(providerName)}`;
      elements.modelSummary.innerHTML = `<span class="codicon codicon-symbol-parameter"></span>Model: ${escapeHtml(modelName)}`;
      elements.taskStatusSummary.innerHTML = `<span class="codicon codicon-clock"></span>Status: ${escapeHtml(uiState.taskStatus)}`;
      elements.modalModePill.textContent = `Mode: ${mode}`;
      elements.modalProviderPill.textContent = `Provider: ${providerName}`;
    }

/**
 * @description Re-render the API runtime summary cards (mode, plan, act, advanced) from current
 * state.
 * @returns {void}
 */
    function renderApiRuntimeSummary() {
      const mode = getMode();
      const planProvider = getProviderLabel(uiState.config?.planModeApiProvider);
      const actProvider = getProviderLabel(uiState.config?.actModeApiProvider);
      const planModel = readNonEmptyString(uiState.config?.planModeApiModelId) || 'not configured';
      const actModel = readNonEmptyString(uiState.config?.actModeApiModelId) || 'not configured';
      const maxTokens = uiState.config?.maxTokens ?? 'default';
      const temperature = uiState.config?.temperature ?? 'default';

      elements.apiRuntimeSummary.innerHTML = [
        {
          label: 'Mode',
          value: mode,
          detail: mode === 'act' ? 'Act is live' : 'Plan is live',
        },
        {
          label: 'Plan',
          value: 'plan',
          detail: `${planProvider} · ${planModel}`,
        },
        {
          label: 'Act',
          value: 'act',
          detail: `${actProvider} · ${actModel}`,
        },
        {
          label: 'Advanced',
          value: 'controls',
          detail: `${maxTokens} tokens · temp ${temperature}`,
        },
      ].map((item) => `
        <div class="api-summary-card">
          <strong>${escapeHtml(item.label)}</strong>
          <span><span class="status-pill">${escapeHtml(item.value)}</span> ${escapeHtml(item.detail)}</span>
        </div>
      `).join('');
    }

export {
  ALL_AGENTS_FILTER,
  DEFAULT_CHAT_AGENT_ID,
  DEFAULT_CHAT_AGENT_NAME,
  SUPPORTED_THEMES,
  clearModalStatus,
  elements,
  getActiveAgentId,
  getActiveProviderSelection,
  getChatAgentConfig,
  getCurrentAvatarValue,
  getMode,
  getProviderLabel,
  readNonEmptyString,
  renderApiRuntimeSummary,
  renderProviderStatus,
  setModalStatus,
  uiState,
};

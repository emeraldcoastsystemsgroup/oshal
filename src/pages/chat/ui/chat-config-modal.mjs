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
 */

import { ChatApp } from '/dist/chat-ui.js';
import {
  formatThemeLabel,
  generateTaskId,
  mergeCachedApiConfigPreview,
  resolveTheme,
} from '/chat-assets/chat-config-ui-utils.mjs';
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
  readString,
} from '/chat-assets/chat-workspace-popups-utils.mjs';
import { API_PROVIDER_MODEL_OVERRIDES } from '/chat-assets/chat-provider-model-overrides.mjs';

const DEFAULT_CHAT_AGENT_ID = '00000000-0000-4000-8000-000000000032';
const DEFAULT_CHAT_AGENT_NAME = (typeof window !== 'undefined' && window.__BRAND?.displayName ? window.__BRAND.displayName + ' Chat Agent' : 'Chat Agent');
const SUPPORTED_THEMES = ['midnight', 'daylight', 'ocean', 'sakura', 'forest', 'gray', 'black', 'light-blue', 'aurora', 'graphite', 'amber'];
const ALL_AGENTS_FILTER = 'all';

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

const readNonEmptyString = readString;
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

function hasLegacySchedulerEditor() {
  return Boolean(
    elements.scheduleTaskTypeInput
    && elements.scheduleTargetAgentSelect
    && elements.scheduleCronInput
    && elements.schedulePromptInput
    && elements.scheduleActionInput
    && elements.scheduleWorkspaceSlugInput
    && elements.schedulerEditorSummary
    && elements.saveScheduleBtn
    && elements.cancelScheduleEditBtn,
  );
}

    const API_PROVIDER_AUTH_CONFIG = {
      'openai-codex': {
        statusEndpoint: '/api/openai-codex/oauth/status',
        startEndpoint: '/api/openai-codex/oauth/start',
        signOutEndpoint: '/api/openai-codex/oauth/signout',
        title: 'OpenAI Codex Authentication',
        signInLabel: 'Sign In',
        signOutLabel: 'Sign Out',
        infoText: 'OpenAI Codex uses ChatGPT/OpenAI account OAuth sign-in. No manual API key is required.',
      },
      'claude-code': {
        statusEndpoint: '/api/claude-code/auth/status',
        startEndpoint: '/api/claude-code/auth/start',
        signOutEndpoint: '/api/claude-code/auth/signout',
        title: 'Claude Code Authentication',
        signInLabel: 'Sign In',
        signOutLabel: 'Sign Out',
        infoText: 'Claude Code uses Claude CLI auth. Sign in with your Claude account or CLI-managed session.',
      },
    };

    const API_BOOLEAN_CONFIG_KEYS = new Set([
      'awsUseCrossRegionInference',
      'awsUseGlobalInference',
      'awsBedrockUsePromptCache',
      'awsUseProfile',
      'ocaUsePromptCache',
    ]);

    const API_CONFIG_LABEL_OVERRIDES = {
      anthropicApiKey: 'Anthropic API Key',
      asksageApiKey: 'AskSage API Key',
      awsAccessKey: 'AWS Access Key',
      awsAuthentication: 'AWS Authentication Method',
      awsBedrockApiKey: 'AWS Bedrock API Key',
      awsBedrockEndpoint: 'AWS Bedrock Endpoint',
      awsProfile: 'AWS Profile',
      awsRegion: 'AWS Region',
      awsSecretKey: 'AWS Secret Key',
      awsSessionToken: 'AWS Session Token',
      cerebrasApiKey: 'Cerebras API Key',
      claudeCodePath: 'Claude Code CLI Path',
      clineAccountId: 'Cline Account ID',
      clineApiKey: 'Cline API Key',
      deepSeekApiKey: 'DeepSeek API Key',
      difyApiKey: 'Dify API Key',
      difyBaseUrl: 'Dify Base URL',
      difyWorkflowId: 'Dify Workflow ID',
      fireworksApiKey: 'Fireworks API Key',
      geminiApiKey: 'Gemini API Key',
      hicapApiKey: 'HiCap API Key',
      hicapBaseUrl: 'HiCap Base URL',
      hicapModelId: 'HiCap Model ID',
      huggingFaceApiKey: 'Hugging Face API Key',
      huaweiCloudMaasApiKey: 'Huawei Cloud API Key',
      huaweiCloudMaasModelId: 'Huawei Cloud Model ID',
      lmStudioBaseUrl: 'LM Studio Base URL',
      lmStudioModelId: 'LM Studio Model ID',
      moonshotApiKey: 'Moonshot API Key',
      nebiusApiKey: 'Nebius API Key',
      nousResearchApiKey: 'Nous Research API Key',
      ocaApiKey: 'OCA API Key',
      ocaBaseUrl: 'OCA Base URL',
      ocaModelId: 'OCA Model ID',
      ollamaApiKey: 'Ollama API Key',
      ollamaApiOptionsCtxNum: 'Ollama Context Size',
      ollamaBaseUrl: 'Ollama Base URL',
      ollamaModelId: 'Ollama Model ID',
      openAiApiKey: 'OpenAI API Key',
      openRouterApiKey: 'OpenRouter API Key',
      qwenApiKey: 'Qwen API Key',
      qwenCodeApiKey: 'Qwen Code API Key',
      requestyApiKey: 'Requesty API Key',
      requestyBaseUrl: 'Requesty Base URL',
      requestyModelId: 'Requesty Model ID',
      sambanovaApiKey: 'SambaNova API Key',
      vercelAiGatewayApiKey: 'Vercel AI Gateway API Key',
      vercelAiGatewayBaseUrl: 'Vercel AI Gateway Base URL',
      vercelAiGatewayModelId: 'Vercel AI Gateway Model ID',
      vercelAiGatewayProviderId: 'Vercel AI Gateway Provider ID',
      vertexProjectId: 'Google Cloud Project ID',
      vertexRegion: 'Vertex Region',
      xaiApiKey: 'xAI API Key',
      zaiApiKey: 'Z AI API Key',
    };

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

    function getProviderById(providerId) {
      return uiState.providerMap.get(readNonEmptyString(providerId)) || null;
    }

    function getProviderDescription(providerId) {
      const normalized = readNonEmptyString(providerId);
      return API_PROVIDER_AUTH_CONFIG[normalized]?.infoText
        || readNonEmptyString(getProviderById(normalized)?.description);
    }

    function getProviderModels(providerId) {
      const normalized = readNonEmptyString(providerId);
      if (!normalized) {
        return [];
      }
      if (Array.isArray(API_PROVIDER_MODEL_OVERRIDES[normalized])) {
        return API_PROVIDER_MODEL_OVERRIDES[normalized];
      }
      return Array.isArray(getProviderById(normalized)?.models) ? getProviderById(normalized).models : [];
    }

    function getRenderableProviderConfigKeys(providerId) {
      const normalized = readNonEmptyString(providerId);
      if (!normalized) {
        return [];
      }
      if (normalized === 'openai-codex') {
        return [];
      }
      return Array.isArray(getProviderById(normalized)?.configKeys) ? getProviderById(normalized).configKeys : [];
    }

    function isSecretConfigKey(key) {
      const normalized = readNonEmptyString(key).toLowerCase();
      return ['apikey', 'secret', 'token', 'password', 'clientsecret', 'accesskey', 'secretkey', 'credentials'].some((part) => normalized.includes(part));
    }

    function isBooleanConfigKey(key) {
      const normalized = readNonEmptyString(key);
      return API_BOOLEAN_CONFIG_KEYS.has(normalized) || /^(is|has|use|enable)[A-Z]/.test(normalized);
    }

    function isNumericConfigKey(key) {
      return /(max|temperature|timeout|budget|ctx|count|num|version)$/i.test(readNonEmptyString(key));
    }

    function formatConfigKeyLabel(key) {
      const normalized = readNonEmptyString(key);
      if (!normalized) {
        return '';
      }
      if (API_CONFIG_LABEL_OVERRIDES[normalized]) {
        return API_CONFIG_LABEL_OVERRIDES[normalized];
      }
      return normalized
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\bApi\b/g, 'API')
        .replace(/\bAws\b/g, 'AWS')
        .replace(/\bUrl\b/g, 'URL')
        .replace(/\bOauth\b/g, 'OAuth')
        .replace(/\bId\b/g, 'ID')
        .replace(/\bCli\b/g, 'CLI')
        .replace(/\bJson\b/g, 'JSON')
        .replace(/\bAi\b/g, 'AI')
        .replace(/\bMcp\b/g, 'MCP')
        .replace(/\bLm\b/g, 'LM')
        .replace(/\bVs\b/g, 'VS')
        .replace(/\bCode\b/g, 'Code')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function buildProviderOptionMarkup(selectedProviderId) {
      const selectedId = readNonEmptyString(selectedProviderId);
      const options = ['<option value="">Select provider...</option>'];
      uiState.providers.forEach((provider) => {
        const providerId = readNonEmptyString(provider.id);
        const selected = providerId === selectedId ? ' selected' : '';
        options.push(`<option value="${escapeHtml(providerId)}"${selected}>${escapeHtml(provider.displayName || providerId)}</option>`);
      });
      return options.join('');
    }

    function buildModelOptionMarkup(providerId, selectedModelId) {
      const normalizedProviderId = readNonEmptyString(providerId);
      const normalizedModelId = readNonEmptyString(selectedModelId);
      if (!normalizedProviderId) {
        return '<option value="">Select provider first...</option>';
      }
      const models = getProviderModels(normalizedProviderId);
      if (models.length === 0) {
        return '<option value="">No models available</option>';
      }
      const options = ['<option value="">Select model...</option>'];
      models.forEach((model) => {
        const modelId = readNonEmptyString(model.id);
        const selected = modelId === normalizedModelId ? ' selected' : '';
        options.push(`<option value="${escapeHtml(modelId)}"${selected}>${escapeHtml(model.name || modelId)}</option>`);
      });
      return options.join('');
    }

    function ensureValidModeModel(mode) {
      const providerKey = mode === 'act' ? 'actModeApiProvider' : 'planModeApiProvider';
      const modelKey = mode === 'act' ? 'actModeApiModelId' : 'planModeApiModelId';
      const providerId = readNonEmptyString(uiState.config?.[providerKey]);
      const currentModelId = readNonEmptyString(uiState.config?.[modelKey]);
      const models = getProviderModels(providerId);
      if (!providerId) {
        uiState.config[modelKey] = '';
        return;
      }
      if (models.length === 0) {
        uiState.config[modelKey] = '';
        return;
      }
      if (models.some((model) => readNonEmptyString(model.id) === currentModelId)) {
        return;
      }
      uiState.config[modelKey] = readNonEmptyString(models[0]?.id);
    }

    function renderApiRuntimeModeToggle() {
      const mode = getMode();
      elements.apiModePlanBtn?.classList.toggle('active', mode === 'plan');
      elements.apiModeActBtn?.classList.toggle('active', mode === 'act');
    }

    function renderApiProviderFields() {
      if (!elements.apiProviderFields) {
        return;
      }

      const selectedProviderIds = [
        readNonEmptyString(uiState.config?.planModeApiProvider),
        readNonEmptyString(uiState.config?.actModeApiProvider),
      ].filter(Boolean);
      const uniqueProviderIds = Array.from(new Set(selectedProviderIds));

      if (uniqueProviderIds.length === 0) {
        elements.apiProviderFields.innerHTML = '<div class="muted-empty">Select a provider in plan or act mode to configure provider-specific fields.</div>';
        return;
      }

      elements.apiProviderFields.innerHTML = uniqueProviderIds.map((providerId) => {
        const provider = getProviderById(providerId);
        if (!provider) {
          return '';
        }
        const authConfig = API_PROVIDER_AUTH_CONFIG[providerId];
        const authState = uiState.providerAuthStates.get(providerId);
        const configKeys = getRenderableProviderConfigKeys(providerId);
        const providerTags = [];
        if (readNonEmptyString(uiState.config?.planModeApiProvider) === providerId) {
          providerTags.push('<span class="status-pill">plan</span>');
        }
        if (readNonEmptyString(uiState.config?.actModeApiProvider) === providerId) {
          providerTags.push('<span class="status-pill">act</span>');
        }

        if (authConfig && !authState?.loaded && !authState?.loading) {
          queueMicrotask(() => { void refreshProviderAuthStatus(providerId, false); });
        }

        const authMarkup = authConfig ? `
          <div class="config-field">
            <span class="config-label">${escapeHtml(authConfig.title)}</span>
            <div class="api-provider-auth-row">
              <button class="btn-sm" type="button" data-provider-auth-action="signin" data-provider-id="${escapeHtml(providerId)}"${authState?.authenticated ? ' hidden' : ''}>${escapeHtml(authConfig.signInLabel)}</button>
              <button class="btn-sm" type="button" data-provider-auth-action="signout" data-provider-id="${escapeHtml(providerId)}"${authState?.authenticated ? '' : ' hidden'}>${escapeHtml(authConfig.signOutLabel)}</button>
              <span class="api-provider-auth-status${authState?.authenticated ? '' : ''}" data-tone="${escapeHtml(authState?.tone || 'info')}">${escapeHtml(authState?.label || 'Checking authentication...')}</span>
            </div>
          </div>
        ` : '';

        const fieldMarkup = configKeys.length
          ? `<div class="config-form-grid">${configKeys.map((key) => {
            const value = uiState.config?.[key];
            if (isBooleanConfigKey(key)) {
              return `
                <label class="config-field">
                  <span class="config-label">${escapeHtml(formatConfigKeyLabel(key))}</span>
                  <input class="config-input" type="checkbox" data-api-config-key="${escapeHtml(key)}"${value ? ' checked' : ''}>
                </label>
              `;
            }
            const inputType = isSecretConfigKey(key) ? 'password' : (isNumericConfigKey(key) ? 'number' : 'text');
            return `
              <label class="config-field">
                <span class="config-label">${escapeHtml(formatConfigKeyLabel(key))}</span>
                <input
                  class="config-input"
                  type="${inputType}"
                  data-api-config-key="${escapeHtml(key)}"
                  value="${escapeHtml(value === undefined || value === null ? '' : String(value))}"
                >
              </label>
            `;
          }).join('')}</div>`
          : '<div class="muted-empty">No manual provider fields required for this provider.</div>';

        return `
          <article class="api-provider-config-card" data-provider-id="${escapeHtml(providerId)}">
            <div>
              <h4>${escapeHtml(provider.displayName || providerId)}</h4>
              <div class="api-provider-config-meta">${providerTags.join('')}</div>
            </div>
            <div class="api-provider-config-description">${escapeHtml(getProviderDescription(providerId) || 'No provider details available.')}</div>
            ${authMarkup}
            ${fieldMarkup}
          </article>
        `;
      }).join('');
    }

    function renderApiRuntimeEditor() {
      if (!elements.apiPlanProviderSelect || !elements.apiActProviderSelect) {
        return;
      }

      ensureValidModeModel('plan');
      ensureValidModeModel('act');

      elements.apiPlanProviderSelect.innerHTML = buildProviderOptionMarkup(uiState.config?.planModeApiProvider);
      elements.apiActProviderSelect.innerHTML = buildProviderOptionMarkup(uiState.config?.actModeApiProvider);
      elements.apiPlanModelSelect.innerHTML = buildModelOptionMarkup(uiState.config?.planModeApiProvider, uiState.config?.planModeApiModelId);
      elements.apiActModelSelect.innerHTML = buildModelOptionMarkup(uiState.config?.actModeApiProvider, uiState.config?.actModeApiModelId);
      elements.apiPlanProviderInfo.textContent = getProviderDescription(uiState.config?.planModeApiProvider) || '';
      elements.apiActProviderInfo.textContent = getProviderDescription(uiState.config?.actModeApiProvider) || '';
      elements.apiMaxTokensInput.value = uiState.config?.maxTokens === undefined || uiState.config?.maxTokens === null ? '8192' : String(uiState.config.maxTokens);
      elements.apiTemperatureInput.value = uiState.config?.temperature === undefined || uiState.config?.temperature === null ? '0.7' : String(uiState.config.temperature);
      renderApiRuntimeModeToggle();
      renderApiProviderFields();
    }

    function cacheApiConfigPreview() {
      try {
        localStorage.setItem('clineApiConfig', JSON.stringify({
          mode: getMode(),
          planModeApiProvider: readNonEmptyString(uiState.config?.planModeApiProvider),
          planModeApiModelId: readNonEmptyString(uiState.config?.planModeApiModelId),
          actModeApiProvider: readNonEmptyString(uiState.config?.actModeApiProvider),
          actModeApiModelId: readNonEmptyString(uiState.config?.actModeApiModelId),
          maxTokens: uiState.config?.maxTokens,
          temperature: uiState.config?.temperature,
        }));
      } catch (error) {
        console.warn('Failed to cache API config preview', error);
      }
    }

    function sanitizeApiConfigForSave(config) {
      const nextConfig = {};
      Object.entries(config || {}).forEach(([key, value]) => {
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (trimmed.length > 0) {
            nextConfig[key] = trimmed;
          }
          return;
        }
        if (typeof value === 'number') {
          if (Number.isFinite(value)) {
            nextConfig[key] = value;
          }
          return;
        }
        if (typeof value === 'boolean') {
          nextConfig[key] = value;
          return;
        }
        if (value && typeof value === 'object') {
          nextConfig[key] = value;
        }
      });
      return nextConfig;
    }

    function updateApiConfigValue(key, value) {
      if (value === '' || value === null || value === undefined) {
        delete uiState.config[key];
      } else {
        uiState.config[key] = value;
      }
      cacheApiConfigPreview();
      renderProviderStatus();
      renderApiRuntimeSummary();
    }

    async function saveApiRuntimeConfiguration() {
      clearModalStatus();
      setModalStatus('Saving API runtime configuration...', 'info');
      try {
        const payload = sanitizeApiConfigForSave({
          ...uiState.config,
          mode: getMode(),
          maxTokens: Number(elements.apiMaxTokensInput?.value || uiState.config?.maxTokens || 8192),
          temperature: Number(elements.apiTemperatureInput?.value || uiState.config?.temperature || 0.7),
        });
        const response = await requestJson('/api/config', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        uiState.config = mergeCachedApiConfigPreview(payload);
        renderApiRuntimeEditor();
        renderProviderStatus();
        renderApiRuntimeSummary();
        setModalStatus(response?.success ? 'Saved API runtime configuration.' : 'Saved API runtime configuration.', 'success');
      } catch (error) {
        console.error('Failed to save API runtime configuration:', error);
        setModalStatus(`Failed to save API runtime configuration: ${error.message}`, 'error');
      }
    }

    function normalizeProviderAuthState(providerId, payload) {
      if (providerId === 'openai-codex') {
        const authenticated = !!payload?.authenticated;
        return {
          loaded: true,
          loading: false,
          authenticated,
          tone: authenticated ? 'success' : 'info',
          label: authenticated ? `Signed in${payload?.email ? ` as ${payload.email}` : ''}` : 'Not signed in',
        };
      }
      if (providerId === 'claude-code') {
        const available = payload?.available !== false;
        const authenticated = !!payload?.authenticated;
        return {
          loaded: true,
          loading: false,
          authenticated,
          tone: authenticated ? 'success' : (available ? 'info' : 'error'),
          label: !available
            ? 'Claude CLI unavailable'
            : (authenticated
              ? `Signed in${payload?.email ? ` as ${payload.email}` : ''}${payload?.authMethod ? ` via ${payload.authMethod}` : ''}`
              : 'Not signed in'),
        };
      }
      return {
        loaded: true,
        loading: false,
        authenticated: false,
        tone: 'info',
        label: 'Authentication status unavailable',
      };
    }

    async function refreshProviderAuthStatus(providerId, showErrors = true) {
      const authConfig = API_PROVIDER_AUTH_CONFIG[providerId];
      if (!authConfig) {
        return null;
      }
      uiState.providerAuthStates.set(providerId, { loaded: false, loading: true, authenticated: false, tone: 'info', label: 'Checking authentication...' });
      renderApiProviderFields();
      try {
        const payload = await requestJson(authConfig.statusEndpoint);
        const normalized = normalizeProviderAuthState(providerId, payload);
        uiState.providerAuthStates.set(providerId, normalized);
        renderApiProviderFields();
        return normalized;
      } catch (error) {
        console.error(`Failed to load ${providerId} auth status:`, error);
        const fallback = { loaded: true, loading: false, authenticated: false, tone: 'error', label: 'Unable to read auth status' };
        uiState.providerAuthStates.set(providerId, fallback);
        renderApiProviderFields();
        if (showErrors) {
          setModalStatus(`Failed to read ${getProviderLabel(providerId)} auth status: ${error.message}`, 'error');
        }
        return fallback;
      }
    }

    async function pollProviderAuthStatus(providerId) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 180000) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const status = await refreshProviderAuthStatus(providerId, false);
        if (status?.authenticated) {
          setModalStatus(`${getProviderLabel(providerId)} sign-in complete.`, 'success');
          return;
        }
      }
      setModalStatus(`${getProviderLabel(providerId)} sign-in timed out.`, 'error');
    }

    async function startProviderAuth(providerId) {
      const authConfig = API_PROVIDER_AUTH_CONFIG[providerId];
      if (!authConfig) {
        return;
      }
      try {
        const startResult = await requestJson(authConfig.startEndpoint);
        if (startResult?.authUrl) {
          const popup = window.open(startResult.authUrl, `${providerId}-auth`, 'width=620,height=780');
          if (!popup) {
            window.location.href = startResult.authUrl;
            return;
          }
        }
        setModalStatus(`${getProviderLabel(providerId)} sign-in started.`, 'info');
        void pollProviderAuthStatus(providerId);
      } catch (error) {
        console.error(`Failed to start ${providerId} auth:`, error);
        setModalStatus(`Failed to start ${getProviderLabel(providerId)} sign-in: ${error.message}`, 'error');
      }
    }


    async function signOutProviderAuth(providerId) {
      const authConfig = API_PROVIDER_AUTH_CONFIG[providerId];
      if (!authConfig) {
        return;
      }
      try {
        await requestJson(authConfig.signOutEndpoint, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await refreshProviderAuthStatus(providerId, false);
        setModalStatus(`${getProviderLabel(providerId)} credentials removed.`, 'success');
      } catch (error) {
        console.error(`Failed to sign out ${providerId}:`, error);
        setModalStatus(`Failed to sign out ${getProviderLabel(providerId)}: ${error.message}`, 'error');
      }
    }
    function getMode() {
      return uiState.config?.mode === 'act' ? 'act' : 'plan';
    }

    function getProviderLabel(providerId) {
      const id = readNonEmptyString(providerId);
      if (!id) {
        return 'not configured';
      }

      return uiState.providerMap.get(id)?.displayName || id;
    }

    function getActiveProviderSelection() {
      const mode = getMode();
      return {
        provider: readNonEmptyString(mode === 'act' ? uiState.config.actModeApiProvider : uiState.config.planModeApiProvider),
        model: readNonEmptyString(mode === 'act' ? uiState.config.actModeApiModelId : uiState.config.planModeApiModelId),
      };
    }

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

    function getCurrentAvatarValue() {
      if (uiState.avatarRemoved) {
        return '';
      }
      return uiState.pendingAvatarPreviewUrl || readNonEmptyString(uiState.agentProfile?.avatarUrl);
    }

    function getActiveAgentId() {
      const persistedAgentId = readNonEmptyString(uiState.agentProfile?.agentId);
      return persistedAgentId || DEFAULT_CHAT_AGENT_ID;
    }

    function setModalStatus(message, tone = 'info') {
      if (!message) {
        elements.modalStatus.textContent = '';
        elements.modalStatus.removeAttribute('data-tone');
        return;
      }

      elements.modalStatus.textContent = message;
      elements.modalStatus.setAttribute('data-tone', tone);
    }

    function clearModalStatus() {
      setModalStatus('');
    }

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

    function renderAgentProfile() {
      const agentConfig = getChatAgentConfig();
      elements.agentNameInput.value = agentConfig.name;
      if (elements.agentAvatarFileInput) {
        elements.agentAvatarFileInput.value = '';
      }
      elements.projectUrlInput.value = agentConfig.projectUrl;
      elements.selectorSkillsInput.value = agentConfig.selectorSkillsText;
      elements.agentDisplayName.textContent = agentConfig.name;
      renderAvatarPreview(getCurrentAvatarValue());
      renderAvatarFileStatus();
    }

    function renderAvatarPreview(avatarUrl) {
      const resolvedUrl = readNonEmptyString(avatarUrl);
      if (resolvedUrl) {
        elements.agentAvatarPreview.innerHTML = `<img src="${escapeHtml(resolvedUrl)}" alt="Agent avatar">`;
      } else {
        elements.agentAvatarPreview.innerHTML = '<span class="codicon codicon-hubot"></span>';
      }
    }

    function renderAvatarFileStatus() {
      if (!elements.agentAvatarFileStatus) {
        return;
      }

      if (uiState.avatarRemoved) {
        elements.agentAvatarFileStatus.textContent = 'Picture will be removed from the bot profile when you save.';
        return;
      }

      if (uiState.pendingAvatarFile) {
        elements.agentAvatarFileStatus.textContent = `${uiState.pendingAvatarFile.name} selected. Saving uploads it into the database for this bot.`;
        return;
      }

      if (readNonEmptyString(uiState.agentProfile?.avatarUrl)) {
        elements.agentAvatarFileStatus.textContent = 'Current picture is stored in the bot profile record.';
        return;
      }

      elements.agentAvatarFileStatus.textContent = 'Upload an image and it will be stored in the bot profile record.';
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

    function renderSchedulerReport() {
      if (!elements.schedulerReportCards || !elements.schedulerReportSummary) {
        return;
      }

      renderSchedulerAgentSelectors();
      const filteredSchedules = getFilteredSchedules();
      const report = buildSchedulerReport(
        uiState.schedulerStatus,
        filteredSchedules,
        getSelectedSchedulerToolMode(),
      );
      uiState.schedulerReport = report;

      if (!report || report.error) {
        elements.schedulerReportCards.innerHTML = '<div class="muted-empty">Redis scheduler report is not available yet.</div>';
        elements.schedulerReportSummary.textContent = report?.error || 'Refresh the report after the scheduler and Redis are running.';
        return;
      }

      const cards = [
        { value: report.redisHealthy ? 'healthy' : 'down', label: 'Redis' },
        { value: report.isRunning ? 'running' : 'stopped', label: 'Runner' },
        { value: String(report.totalSchedules), label: report.scopeCountLabel },
        { value: report.nextRunLabel, label: 'Next Run' },
      ];

      elements.schedulerReportCards.innerHTML = cards.map((stat) => `
        <div class="stat-card">
          <strong>${escapeHtml(stat.value)}</strong>
          <span>${escapeHtml(stat.label)}</span>
        </div>
      `).join('');

      elements.schedulerReportSummary.textContent = report.summary;
    }

    function getSchedulerToolMode(toolList = uiState.agentTools, pendingToolModes = uiState.pendingToolModes) {
      const schedulerTool = Array.isArray(toolList)
        ? toolList.find((tool) => readNonEmptyString(tool?.tool?.name || tool?.name) === 'agent-scheduler')
        : null;
      return schedulerTool ? getEffectiveAuthMode(schedulerTool, pendingToolModes) : 'off';
    }

    function getSchedulerAgentOptions() {
      const options = new Map();
      uiState.schedulerAgents.forEach((agent) => {
        const agentId = readNonEmptyString(agent?.agentId);
        if (!agentId) {
          return;
        }
        options.set(agentId, {
          agentId,
          name: readNonEmptyString(agent?.name) || agentId,
        });
      });

      uiState.schedulerSchedules.forEach((schedule) => {
        const agentId = getScheduleTargetAgentId(schedule);
        if (!agentId || options.has(agentId)) {
          return;
        }
        options.set(agentId, { agentId, name: agentId });
      });

      if (!options.has(getActiveAgentId())) {
        options.set(getActiveAgentId(), {
          agentId: getActiveAgentId(),
          name: readNonEmptyString(uiState.agentProfile?.name) || DEFAULT_CHAT_AGENT_NAME,
        });
      }

      return Array.from(options.values()).sort((left, right) => left.name.localeCompare(right.name));
    }

    function getScheduleTargetAgentId(schedule) {
      return readNonEmptyString(schedule?.taskData?.targetAgent) || DEFAULT_CHAT_AGENT_ID;
    }

    function getSchedulerAgentName(agentId) {
      const entry = getSchedulerAgentOptions().find((agent) => agent.agentId === agentId);
      return entry?.name || agentId || 'Unknown bot';
    }

    function getFilteredSchedules() {
      const selectedAgentId = readNonEmptyString(uiState.schedulerAgentFilter);
      const schedules = Array.isArray(uiState.schedulerSchedules) ? uiState.schedulerSchedules : [];
      if (!selectedAgentId || selectedAgentId === ALL_AGENTS_FILTER) {
        return schedules;
      }
      return schedules.filter((schedule) => getScheduleTargetAgentId(schedule) === selectedAgentId);
    }

    function getSelectedSchedulerToolMode() {
      const selectedAgentId = readNonEmptyString(uiState.schedulerAgentFilter);
      if (!selectedAgentId || selectedAgentId === ALL_AGENTS_FILTER) {
        return '';
      }
      return readNonEmptyString(uiState.schedulerAgentToolModes.get(selectedAgentId));
    }

    function renderSchedulerAgentSelectors() {
      const agentOptions = getSchedulerAgentOptions();

      if (elements.schedulerAgentFilter) {
        const filterValue = readNonEmptyString(uiState.schedulerAgentFilter) || ALL_AGENTS_FILTER;
        elements.schedulerAgentFilter.innerHTML = [
          `<option value="${ALL_AGENTS_FILTER}">All Bots</option>`,
          ...agentOptions.map((agent) => `<option value="${escapeHtml(agent.agentId)}">${escapeHtml(agent.name)}</option>`),
        ].join('');
        elements.schedulerAgentFilter.value = agentOptions.some((agent) => agent.agentId === filterValue)
          ? filterValue
          : ALL_AGENTS_FILTER;
        uiState.schedulerAgentFilter = elements.schedulerAgentFilter.value;
      }

      if (elements.scheduleTargetAgentSelect) {
        const currentValue = readNonEmptyString(elements.scheduleTargetAgentSelect.value);
        const defaultValue = uiState.scheduleEditorMode === 'edit' ? currentValue : getDefaultScheduleTargetAgentId();
        const desiredValue = currentValue || defaultValue;
        elements.scheduleTargetAgentSelect.innerHTML = [
          '<option value="">Select bot</option>',
          ...agentOptions.map((agent) => `<option value="${escapeHtml(agent.agentId)}">${escapeHtml(agent.name)}</option>`),
        ].join('');
        elements.scheduleTargetAgentSelect.value = agentOptions.some((agent) => agent.agentId === desiredValue)
          ? desiredValue
          : (agentOptions.some((agent) => agent.agentId === defaultValue) ? defaultValue : '');
      }
    }

    function getDefaultScheduleTargetAgentId() {
      const filterAgentId = readNonEmptyString(uiState.schedulerAgentFilter);
      if (filterAgentId && filterAgentId !== ALL_AGENTS_FILTER) {
        return filterAgentId;
      }
      return getActiveAgentId();
    }

    function renderScheduleEditor() {
      if (!hasLegacySchedulerEditor()) {
        return;
      }
      renderSchedulerAgentSelectors();
      const isEditing = uiState.scheduleEditorMode === 'edit';
      elements.scheduleTaskTypeInput.disabled = isEditing;
      elements.saveScheduleBtn.textContent = isEditing ? 'Update Job' : 'Create Job';
      elements.cancelScheduleEditBtn.hidden = !isEditing;
      const selectedAgentName = getSchedulerAgentName(readNonEmptyString(elements.scheduleTargetAgentSelect.value) || getDefaultScheduleTargetAgentId());
      elements.schedulerEditorSummary.textContent = isEditing
        ? `Editing ${uiState.editingScheduleId}. Job ids stay stable, so this form updates cron, target bot, and task payload in place for ${selectedAgentName}.`
        : `Create a Redis cron job for ${selectedAgentName}. The job id becomes the persistent schedule key, so keep it stable and descriptive.`;
    }

    function renderScheduledJobs() {
      if (!elements.scheduledJobList) {
        return;
      }

      const schedules = getFilteredSchedules();
      if (schedules.length === 0) {
        elements.scheduledJobList.innerHTML = '<div class="muted-empty">No scheduled jobs exist for the current scope.</div>';
        return;
      }

      elements.scheduledJobList.innerHTML = schedules.map((schedule) => {
        const targetAgentId = getScheduleTargetAgentId(schedule);
        const prompt = readNonEmptyString(schedule?.taskData?.prompt);
        const action = readNonEmptyString(schedule?.taskData?.action);
        const workspaceSlug = readNonEmptyString(schedule?.taskData?.workspaceSlug);
        const nextRun = formatScheduleDate(schedule?.nextRunAt);
        const lastRun = formatScheduleDate(schedule?.lastRunAt);
        return `
          <article class="scheduler-job-card" data-schedule-id="${escapeHtml(schedule.id)}">
            <div class="scheduler-job-header">
              <div class="scheduler-job-title">
                <strong>${escapeHtml(schedule.taskType || schedule.id)}</strong>
                <span class="scheduler-job-subtitle">${escapeHtml(getSchedulerAgentName(targetAgentId))} · ${escapeHtml(targetAgentId)}</span>
              </div>
              <span class="status-pill">${escapeHtml(readNonEmptyString(schedule.status) || 'unknown')}</span>
            </div>
            <div class="scheduler-job-meta">
              <span class="scheduler-job-metrics">Cron ${escapeHtml(readNonEmptyString(schedule.cron) || 'n/a')}</span>
              <span class="scheduler-job-metrics">Next ${escapeHtml(nextRun)}</span>
              <span class="scheduler-job-metrics">Last ${escapeHtml(lastRun)}</span>
              <span class="scheduler-job-metrics">Runs ${escapeHtml(String(schedule.executionCount ?? 0))}</span>
            </div>
            <div class="chip-list">
              ${action ? `<span class="chip">Action: ${escapeHtml(action)}</span>` : ''}
              ${workspaceSlug ? `<span class="chip">Workspace: ${escapeHtml(workspaceSlug)}</span>` : ''}
            </div>
            <div class="scheduler-job-prompt">${escapeHtml(truncateText(prompt || 'No prompt stored.', 280))}</div>
            <div class="scheduler-job-footer">
              <span class="scheduler-job-metrics">Updated ${escapeHtml(formatScheduleDate(schedule?.updatedAt))}</span>
              <div class="scheduler-job-actions">
                <button class="btn-sm" type="button" data-schedule-action="edit" data-schedule-id="${escapeHtml(schedule.id)}">Edit</button>
                <button class="btn-sm" type="button" data-schedule-action="${schedule.status === 'paused' ? 'resume' : 'pause'}" data-schedule-id="${escapeHtml(schedule.id)}">${schedule.status === 'paused' ? 'Resume' : 'Pause'}</button>
                <button class="btn-sm" type="button" data-schedule-action="trigger" data-schedule-id="${escapeHtml(schedule.id)}">Run Now</button>
                <button class="btn-sm" type="button" data-schedule-action="delete" data-schedule-id="${escapeHtml(schedule.id)}">Delete</button>
              </div>
            </div>
          </article>
        `;
      }).join('');
    }

    function formatScheduleDate(value) {
      const rawValue = readNonEmptyString(value);
      if (!rawValue) {
        return 'not recorded';
      }
      const date = new Date(rawValue);
      return Number.isNaN(date.getTime()) ? rawValue : date.toLocaleString();
    }

    function truncateText(value, limit) {
      if (value.length <= limit) {
        return value;
      }
      return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
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

    function buildSchedulerReport(statusPayload, schedules, schedulerToolMode = '') {
      const nextRunValue = (Array.isArray(schedules) ? schedules : [])
        .map((schedule) => readNonEmptyString(schedule?.nextRunAt || schedule?.nextRun))
        .filter((value) => value.length > 0)
        .sort()[0];
      const botsInScope = new Set((Array.isArray(schedules) ? schedules : []).map((schedule) => getScheduleTargetAgentId(schedule)));
      const selectedAgentId = readNonEmptyString(uiState.schedulerAgentFilter);
      const scopeLabel = selectedAgentId && selectedAgentId !== ALL_AGENTS_FILTER
        ? getSchedulerAgentName(selectedAgentId)
        : 'All bots';
      const totalSchedules = Array.isArray(schedules) ? schedules.length : 0;
      const activeSchedules = Array.isArray(schedules)
        ? schedules.filter((schedule) => readNonEmptyString(schedule?.status) === 'active').length
        : 0;
      const pausedSchedules = Array.isArray(schedules)
        ? schedules.filter((schedule) => readNonEmptyString(schedule?.status) === 'paused').length
        : 0;
      const toolModeSentence = selectedAgentId && selectedAgentId !== ALL_AGENTS_FILTER
        ? `Agent Scheduler tool: ${schedulerToolMode || 'unknown'}.`
        : 'Agent Scheduler tool mode is per bot; choose one bot to inspect its toggle state.';

      return {
        redisHealthy: Boolean(statusPayload?.redisHealthy),
        isRunning: Boolean(statusPayload?.isRunning),
        pollIntervalMs: Number(statusPayload?.pollIntervalMs || 0),
        totalSchedules,
        activeSchedules,
        pausedSchedules,
        nextRunLabel: nextRunValue ? new Date(nextRunValue).toLocaleString() : 'none queued',
        scopeCountLabel: selectedAgentId && selectedAgentId !== ALL_AGENTS_FILTER ? 'Jobs' : 'Schedules',
        summary: [
          `Scope: ${scopeLabel}.`,
          `${totalSchedules} jobs in scope across ${botsInScope.size || 0} bots.`,
          `Active ${activeSchedules}, paused ${pausedSchedules}.`,
          `Poll interval ${Number(statusPayload?.pollIntervalMs || 0)} ms.`,
          toolModeSentence,
        ].join(' '),
        error: statusPayload || Array.isArray(schedules)
          ? ''
          : 'Redis scheduler endpoints did not return a report payload.',
      };
    }

    function seedSchedulerToolModeCache() {
      uiState.schedulerAgentToolModes.set(getActiveAgentId(), getSchedulerToolMode(uiState.agentTools, uiState.pendingToolModes));
    }

    function syncSchedulerAgentFilter() {
      const selectedAgentId = readNonEmptyString(uiState.schedulerAgentFilter);
      if (!selectedAgentId || selectedAgentId === ALL_AGENTS_FILTER) {
        uiState.schedulerAgentFilter = ALL_AGENTS_FILTER;
        return;
      }

      const validAgentIds = new Set(getSchedulerAgentOptions().map((agent) => agent.agentId));
      if (!validAgentIds.has(selectedAgentId)) {
        uiState.schedulerAgentFilter = ALL_AGENTS_FILTER;
      }
    }

    async function ensureSchedulerToolModeLoaded(agentId) {
      const targetAgentId = readNonEmptyString(agentId);
      if (!targetAgentId || targetAgentId === ALL_AGENTS_FILTER || uiState.schedulerAgentToolModes.has(targetAgentId)) {
        return;
      }

      const payload = await requestJson(`/api/agents/${targetAgentId}/tools`);
      const tools = Array.isArray(payload?.tools) ? payload.tools : [];
      uiState.schedulerAgentToolModes.set(targetAgentId, getSchedulerToolMode(tools, new Map()));
    }

    async function refreshSchedulerState(showErrors = false) {
      try {
        const [agentsPayload, statusPayload, schedulesPayload] = await Promise.all([
          requestJson('/api/agents'),
          requestJson('/api/v1/agent/scheduler/status'),
          requestJson('/api/v1/agent/schedules'),
        ]);
        uiState.schedulerAgents = Array.isArray(agentsPayload?.agents) ? agentsPayload.agents : [];
        uiState.schedulerStatus = statusPayload;
        uiState.schedulerSchedules = Array.isArray(schedulesPayload?.schedules) ? schedulesPayload.schedules : [];
        syncSchedulerAgentFilter();
        syncScheduleEditorState();
        await ensureSchedulerToolModeLoaded(uiState.schedulerAgentFilter);
        renderSchedulerReport();
        renderScheduleEditor();
        renderScheduledJobs();
      } catch (error) {
        console.error('Failed to refresh scheduler state:', error);
        if (showErrors) {
          setModalStatus(`Failed to refresh scheduler state: ${error.message}`, 'error');
        }
      }
    }

    function syncScheduleEditorState() {
      if (uiState.scheduleEditorMode !== 'edit' || !uiState.editingScheduleId) {
        return;
      }

      const existing = uiState.schedulerSchedules.find((schedule) => readNonEmptyString(schedule?.id) === uiState.editingScheduleId);
      if (!existing) {
        resetScheduleEditor();
        return;
      }

      populateScheduleEditor(existing);
    }

    function resetScheduleEditor() {
      uiState.scheduleEditorMode = 'create';
      uiState.editingScheduleId = '';
      if (!hasLegacySchedulerEditor()) {
        return;
      }
      elements.scheduleTaskTypeInput.value = '';
      elements.scheduleCronInput.value = '';
      elements.schedulePromptInput.value = '';
      elements.scheduleActionInput.value = '';
      elements.scheduleWorkspaceSlugInput.value = '';
      renderSchedulerAgentSelectors();
      const defaultTarget = getDefaultScheduleTargetAgentId();
      if (defaultTarget) {
        elements.scheduleTargetAgentSelect.value = defaultTarget;
      }
      renderScheduleEditor();
    }

    function populateScheduleEditor(schedule) {
      uiState.scheduleEditorMode = 'edit';
      uiState.editingScheduleId = readNonEmptyString(schedule?.id);
      if (!hasLegacySchedulerEditor()) {
        return;
      }
      elements.scheduleTaskTypeInput.value = readNonEmptyString(schedule?.taskType || schedule?.id);
      elements.scheduleCronInput.value = readNonEmptyString(schedule?.cron);
      elements.schedulePromptInput.value = readNonEmptyString(schedule?.taskData?.prompt);
      elements.scheduleActionInput.value = readNonEmptyString(schedule?.taskData?.action);
      elements.scheduleWorkspaceSlugInput.value = readNonEmptyString(schedule?.taskData?.workspaceSlug);
      renderSchedulerAgentSelectors();
      elements.scheduleTargetAgentSelect.value = getScheduleTargetAgentId(schedule);
      renderScheduleEditor();
    }

    function readScheduleDraft() {
      return {
        taskType: readNonEmptyString(elements.scheduleTaskTypeInput?.value),
        targetAgent: readNonEmptyString(elements.scheduleTargetAgentSelect?.value),
        schedule: readNonEmptyString(elements.scheduleCronInput?.value),
        prompt: readNonEmptyString(elements.schedulePromptInput?.value),
        action: readNonEmptyString(elements.scheduleActionInput?.value),
        workspaceSlug: readNonEmptyString(elements.scheduleWorkspaceSlugInput?.value),
      };
    }

    function validateScheduleDraft(draft) {
      if (!draft.taskType) {
        return 'Job id is required.';
      }
      if (!draft.targetAgent) {
        return 'Target bot is required.';
      }
      if (!draft.schedule) {
        return 'Cron expression is required.';
      }
      if (!draft.prompt) {
        return 'Prompt is required.';
      }
      return '';
    }

    async function saveScheduleDefinition() {
      const draft = readScheduleDraft();
      const validationError = validateScheduleDraft(draft);
      if (validationError) {
        setModalStatus(validationError, 'error');
        return;
      }

      const taskData = {
        prompt: draft.prompt,
        targetAgent: draft.targetAgent,
      };
      if (draft.action) {
        taskData.action = draft.action;
      }
      if (draft.workspaceSlug) {
        taskData.workspaceSlug = draft.workspaceSlug;
      }

      try {
        setModalStatus(uiState.scheduleEditorMode === 'edit' ? 'Updating scheduled job...' : 'Creating scheduled job...', 'info');
        if (uiState.scheduleEditorMode === 'edit' && uiState.editingScheduleId) {
          await requestJson(`/api/v1/agent/schedules/${encodeURIComponent(uiState.editingScheduleId)}`, {
            method: 'PUT',
            body: JSON.stringify({
              pattern: draft.schedule,
              taskData,
            }),
          });
          setModalStatus(`Updated scheduled job ${uiState.editingScheduleId}.`, 'success');
        } else {
          await requestJson('/api/v1/agent/schedule-task', {
            method: 'POST',
            body: JSON.stringify({
              taskType: draft.taskType,
              schedule: draft.schedule,
              taskData,
            }),
          });
          setModalStatus(`Created scheduled job ${draft.taskType}.`, 'success');
        }
        await refreshSchedulerState(true);
        resetScheduleEditor();
      } catch (error) {
        console.error('Failed to save scheduled job:', error);
        setModalStatus(`Scheduled job save failed: ${error.message}`, 'error');
      }
    }

    async function handleScheduleAction(action, scheduleId) {
      const normalizedAction = readNonEmptyString(action);
      const normalizedScheduleId = readNonEmptyString(scheduleId);
      if (!normalizedAction || !normalizedScheduleId) {
        return;
      }

      if (normalizedAction === 'edit') {
        const schedule = uiState.schedulerSchedules.find((entry) => readNonEmptyString(entry?.id) === normalizedScheduleId);
        if (!schedule) {
          setModalStatus(`Scheduled job ${normalizedScheduleId} no longer exists.`, 'error');
          return;
        }
        populateScheduleEditor(schedule);
        return;
      }

      const actionMap = {
        pause: { method: 'POST', url: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}/pause`, message: `Paused ${normalizedScheduleId}.` },
        resume: { method: 'POST', url: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}/resume`, message: `Resumed ${normalizedScheduleId}.` },
        trigger: { method: 'POST', url: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}/trigger`, message: `Triggered ${normalizedScheduleId}.` },
        delete: { method: 'DELETE', url: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}`, message: `Deleted ${normalizedScheduleId}.` },
      };
      const requestConfig = actionMap[normalizedAction];
      if (!requestConfig) {
        return;
      }

      try {
        const progressLabel = {
          pause: 'Pausing',
          resume: 'Resuming',
          trigger: 'Running',
          delete: 'Deleting',
        }[normalizedAction] || 'Updating';
        setModalStatus(`${progressLabel} scheduled job...`, 'info');
        await requestJson(requestConfig.url, { method: requestConfig.method });
        setModalStatus(requestConfig.message, 'success');
        await refreshSchedulerState(true);
        if (uiState.editingScheduleId === normalizedScheduleId && normalizedAction === 'delete') {
          resetScheduleEditor();
        }
      } catch (error) {
        console.error('Failed to execute scheduled job action:', error);
        setModalStatus(`Scheduled job action failed: ${error.message}`, 'error');
      }
    }

    function resetPendingAvatarState() {
      uiState.pendingAvatarFile = null;
      uiState.pendingAvatarPreviewUrl = '';
      uiState.avatarRemoved = false;
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

    function buildNextChatProfilePayload(uploadedAvatarUrl = '') {
      const payload = {
        name: readNonEmptyString(elements.agentNameInput.value) || DEFAULT_CHAT_AGENT_NAME,
        projectUrl: readNonEmptyString(elements.projectUrlInput.value),
        selectorSkillsText: readNonEmptyString(elements.selectorSkillsInput.value),
        themePreference: uiState.theme,
      };

      if (readNonEmptyString(uploadedAvatarUrl)) {
        payload.avatarUrl = readNonEmptyString(uploadedAvatarUrl);
      } else if (uiState.avatarRemoved) {
        payload.avatarUrl = '';
      }

      return payload;
    }

    async function uploadPendingAvatarIfNeeded() {
      if (!uiState.pendingAvatarFile) {
        return '';
      }

      const formData = new FormData();
      formData.append('avatar', uiState.pendingAvatarFile);

      const response = await fetch(`/api/agents/${getActiveAgentId()}/profile/avatar`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || payload?.message || `${response.status} ${response.statusText}`);
      }

      if (payload?.profile && typeof payload.profile === 'object') {
        uiState.agentProfile = payload.profile;
      }

      return readNonEmptyString(payload?.profile?.avatarUrl);
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

    function bindApiRuntimeEvents() {
      elements.apiPlanProviderSelect?.addEventListener('change', () => {
        updateApiConfigValue('planModeApiProvider', readNonEmptyString(elements.apiPlanProviderSelect.value));
        ensureValidModeModel('plan');
        renderApiRuntimeEditor();
        renderProviderStatus();
        renderApiRuntimeSummary();
      });
      elements.apiActProviderSelect?.addEventListener('change', () => {
        updateApiConfigValue('actModeApiProvider', readNonEmptyString(elements.apiActProviderSelect.value));
        ensureValidModeModel('act');
        renderApiRuntimeEditor();
        renderProviderStatus();
        renderApiRuntimeSummary();
      });
      elements.apiPlanModelSelect?.addEventListener('change', () => {
        updateApiConfigValue('planModeApiModelId', readNonEmptyString(elements.apiPlanModelSelect.value));
      });
      elements.apiActModelSelect?.addEventListener('change', () => {
        updateApiConfigValue('actModeApiModelId', readNonEmptyString(elements.apiActModelSelect.value));
      });
      elements.apiModePlanBtn?.addEventListener('click', () => {
        updateApiConfigValue('mode', 'plan');
        renderApiRuntimeModeToggle();
      });
      elements.apiModeActBtn?.addEventListener('click', () => {
        updateApiConfigValue('mode', 'act');
        renderApiRuntimeModeToggle();
      });
      elements.apiMaxTokensInput?.addEventListener('input', () => {
        const value = Number(elements.apiMaxTokensInput.value);
        updateApiConfigValue('maxTokens', Number.isFinite(value) ? value : 8192);
      });
      elements.apiTemperatureInput?.addEventListener('input', () => {
        const value = Number(elements.apiTemperatureInput.value);
        updateApiConfigValue('temperature', Number.isFinite(value) ? value : 0.7);
      });
      elements.apiProviderFields?.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
          return;
        }
        const key = readNonEmptyString(target.dataset.apiConfigKey);
        if (!key) {
          return;
        }
        const value = target.type === 'checkbox' ? target.checked : target.value;
        updateApiConfigValue(key, value);
      });
      elements.apiProviderFields?.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
          return;
        }
        const key = readNonEmptyString(target.dataset.apiConfigKey);
        if (!key) {
          return;
        }
        const value = target.type === 'checkbox' ? target.checked : target.value;
        updateApiConfigValue(key, value);
      });
      elements.apiProviderFields?.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const button = target.closest('[data-provider-auth-action]');
        if (!(button instanceof HTMLElement)) {
          return;
        }
        const providerId = readNonEmptyString(button.dataset.providerId);
        const action = readNonEmptyString(button.dataset.providerAuthAction);
        if (!providerId || !action) {
          return;
        }
        if (action === 'signin') {
          void startProviderAuth(providerId);
        } else if (action === 'signout') {
          void signOutProviderAuth(providerId);
        }
      });
    }

    function bindSectionNavigation() {
      document.querySelectorAll('[data-config-section]').forEach((button) => {
        button.addEventListener('click', () => {
          setActiveConfigSection(button.getAttribute('data-config-section'));
        });
      });
    }

    function bindAgentProfileInputs() {
      elements.agentNameInput.addEventListener('input', () => {
        elements.agentDisplayName.textContent = readNonEmptyString(elements.agentNameInput.value) || DEFAULT_CHAT_AGENT_NAME;
        renderProviderStatus();
      });
      elements.projectUrlInput.addEventListener('input', renderProviderStatus);
      elements.selectorSkillsInput.addEventListener('input', renderProviderStatus);
      elements.agentAvatarFileInput?.addEventListener('change', async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
          return;
        }

        const file = target.files?.[0];
        if (!file) {
          return;
        }

        uiState.pendingAvatarFile = file;
        uiState.pendingAvatarPreviewUrl = await readFileAsDataUrl(file);
        uiState.avatarRemoved = false;
        renderAgentProfile();
      });
      elements.clearAgentAvatarBtn?.addEventListener('click', () => {
        resetPendingAvatarState();
        uiState.avatarRemoved = true;
        renderAgentProfile();
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

    function bindSchedulerEvents() {
      elements.refreshSchedulerReportBtn?.addEventListener('click', async () => {
        setModalStatus('Refreshing Redis scheduler report...', 'info');
        await refreshSchedulerState(true);
        if (!elements.modalStatus.getAttribute('data-tone') || elements.modalStatus.getAttribute('data-tone') === 'info') {
          setModalStatus('Redis scheduler state refreshed.', 'success');
        }
      });
      elements.schedulerAgentFilter?.addEventListener('change', async () => {
        uiState.schedulerAgentFilter = readNonEmptyString(elements.schedulerAgentFilter.value) || ALL_AGENTS_FILTER;
        try {
          await ensureSchedulerToolModeLoaded(uiState.schedulerAgentFilter);
        } catch (error) {
          console.error('Failed to load selected bot scheduler mode:', error);
          setModalStatus(`Failed to inspect selected bot: ${error.message}`, 'error');
        }
        if (uiState.scheduleEditorMode !== 'edit') {
          renderSchedulerAgentSelectors();
          if (elements.scheduleTargetAgentSelect) {
            elements.scheduleTargetAgentSelect.value = getDefaultScheduleTargetAgentId();
          }
        }
        renderSchedulerReport();
        renderScheduleEditor();
        renderScheduledJobs();
      });
      elements.resetScheduleEditorBtn?.addEventListener('click', () => {
        resetScheduleEditor();
        clearModalStatus();
      });
      elements.cancelScheduleEditBtn?.addEventListener('click', () => {
        resetScheduleEditor();
        clearModalStatus();
      });
      elements.saveScheduleBtn?.addEventListener('click', () => { void saveScheduleDefinition(); });
      document.querySelectorAll('[data-cron-preset]').forEach((button) => {
        button.addEventListener('click', () => {
          if (elements.scheduleCronInput) {
            elements.scheduleCronInput.value = readNonEmptyString(button.getAttribute('data-cron-preset'));
          }
        });
      });
      elements.scheduledJobList?.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const button = target.closest('[data-schedule-action]');
        if (!(button instanceof HTMLElement)) {
          return;
        }
        void handleScheduleAction(button.dataset.scheduleAction, button.dataset.scheduleId);
      });
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

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error || new Error('Failed to read avatar file'));
        reader.readAsDataURL(file);
      });
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

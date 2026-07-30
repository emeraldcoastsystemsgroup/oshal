/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the API runtime section of the chat config modal — the provider catalog readers, the config-key label/type policy, the provider field + runtime editor renderers, the save path, and the provider OAuth sign-in/sign-out/poll flow — out of chat-config-modal.mjs to bring that file back under the 1000-code-line cap.
 */

// Bodies below were MOVED verbatim out of chat-config-modal.mjs, including their original
// four-space indentation: the source file kept that indentation at module top level (a leftover
// from an IIFE removed long ago), and re-indenting would rewrite whitespace inside the HTML
// template literals. Exports are declared in one `export { ... }` list at the end so no moved
// line changed at all.

import { mergeCachedApiConfigPreview } from '/chat-assets/chat-config-ui-utils.mjs';
import { API_PROVIDER_MODEL_OVERRIDES } from '/chat-assets/chat-provider-model-overrides.mjs';
import { escapeHtml, requestJson } from '/chat-assets/chat-workspace-popups-utils.mjs';
import {
  clearModalStatus,
  elements,
  getMode,
  getProviderLabel,
  readNonEmptyString,
  renderApiRuntimeSummary,
  renderProviderStatus,
  setModalStatus,
  uiState,
} from '/chat-assets/chat-config-modal-state.mjs';

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

/**
 * @description Re-render the whole API runtime editor: revalidate each mode's model against its
 * provider, refill the provider/model selects, restate the advanced inputs, then redraw the
 * provider-specific field cards.
 * @returns {void}
 */
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

/**
 * @description Persist the API runtime configuration to /api/config, then re-render from the saved
 * payload so the modal shows what the server accepted rather than the local draft.
 * @returns {Promise<void>} Resolves once the save attempt has been reported in the status line.
 */
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

/**
 * @description Bind every API-runtime control: provider/model selects, the plan/act toggle, the
 * advanced inputs, the provider-specific field inputs, and the provider auth buttons.
 * @returns {void}
 */
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

export {
  bindApiRuntimeEvents,
  renderApiRuntimeEditor,
  saveApiRuntimeConfiguration,
};

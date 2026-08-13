/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Synced the legacy OpenAI Codex OAuth model selector patch to current upstream Cline model IDs
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added OpenAI Codex OAuth UI patch to replace API-key prompts with sign-in/sign-out controls and live auth status
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Model list refreshed for the codex fleet default: gpt-5.5 first (verified live on the ChatGPT login), gpt-5.4 as the $20-plan economy pick, gpt-5.6-sol marked interactive-only, stale 5.1/5.2 entries dropped, 5.3-codex labeled API-key-only
 */

(function applyOpenAiCodexOauthPatch() {
  'use strict';

  const OPENAI_CODEX_PROVIDER = 'openai-codex';
  const OPENAI_CODEX_STATUS_ENDPOINT = '/api/openai-codex/oauth/status';
  const OPENAI_CODEX_START_ENDPOINT = '/api/openai-codex/oauth/start';
  const OPENAI_CODEX_SIGNOUT_ENDPOINT = '/api/openai-codex/oauth/signout';
  const OPENAI_CODEX_MODELS = [
    { id: 'gpt-5.5', name: 'GPT-5.5 (fleet default)' },
    { id: 'gpt-5.4', name: 'GPT-5.4 (half the burn — $20-plan pick)' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (frontier — interactive use, heavy limit burn)' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex (API-key login only)' },
  ];

  const originalRenderProviderConfigFields = window.renderProviderConfigFields;
  const originalHandleProviderChange = window.handleProviderChange;

  if (typeof originalRenderProviderConfigFields !== 'function' || typeof originalHandleProviderChange !== 'function') {
    return;
  }

  patchOpenAiCodexProviderConfig();
  patchProviderChangeHandler();
  patchProviderConfigRenderer();
  void refreshOpenAiCodexStatus();

  /**
   * @description Ensures OpenAI Codex provider no longer exposes API key fields in the legacy UI config object.
   */
  function patchOpenAiCodexProviderConfig() {
    if (!window.PROVIDER_CONFIG || !window.PROVIDER_CONFIG[OPENAI_CODEX_PROVIDER]) {
      return;
    }

    window.PROVIDER_CONFIG[OPENAI_CODEX_PROVIDER].settings = [];
    window.PROVIDER_CONFIG[OPENAI_CODEX_PROVIDER].secrets = [];
  }

  /**
   * @description Wraps provider-change flow to override OpenAI Codex model options and provider info text.
   */
  function patchProviderChangeHandler() {
    window.handleProviderChange = function patchedHandleProviderChange(mode, provider) {
      originalHandleProviderChange(mode, provider);

      if (provider !== OPENAI_CODEX_PROVIDER) {
        return;
      }

      replaceOpenAiCodexModels(mode);
      replaceOpenAiCodexProviderInfo(mode);
    };
  }

  /**
   * @description Wraps provider-config rendering to inject OAuth controls when OpenAI Codex is selected.
   */
  function patchProviderConfigRenderer() {
    window.renderProviderConfigFields = function patchedRenderProviderConfigFields(mode, provider) {
      originalRenderProviderConfigFields(mode, provider);

      if (provider !== OPENAI_CODEX_PROVIDER) {
        return;
      }

      const container = document.getElementById(mode + '-provider-config');
      if (!container) {
        return;
      }

      injectOpenAiCodexOAuthControls(container);
      void refreshOpenAiCodexStatus();
    };
  }

  /**
   * @description Replaces legacy OpenAI Codex model list with current Codex subscription model options.
   * @param mode - Active configuration mode (`plan` or `act`)
   */
  function replaceOpenAiCodexModels(mode) {
    const modelSelect = document.getElementById(mode + '-model');
    if (!modelSelect) {
      return;
    }

    modelSelect.innerHTML = '<option value="">Select model...</option>';

    OPENAI_CODEX_MODELS.forEach(function addModel(model) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      modelSelect.appendChild(option);
    });
  }

  /**
   * @description Updates provider hint text to explain OAuth behavior for OpenAI Codex.
   * @param mode - Active configuration mode (`plan` or `act`)
   */
  function replaceOpenAiCodexProviderInfo(mode) {
    const providerInfo = document.getElementById(mode + '-provider-info');

    if (!providerInfo) {
      return;
    }

    providerInfo.textContent = 'OpenAI Codex uses ChatGPT/OpenAI account OAuth sign-in. No manual API key is required.';
  }

  /**
   * @description Injects OpenAI Codex OAuth controls into the provider configuration panel.
   * @param container - Mode-specific provider config container element
   */
  function injectOpenAiCodexOAuthControls(container) {
    container.innerHTML = `
      <div class="form-group" data-openai-codex-controls="true">
        <label>OpenAI Codex Authentication</label>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button type="button" data-openai-codex-signin="true">Sign in to OpenAI Codex</button>
          <button type="button" class="secondary" data-openai-codex-signout="true" style="display:none;">Sign out</button>
          <span data-openai-codex-status="true" style="font-size:12px; color:#858585;">Checking authentication...</span>
        </div>
      </div>
    `;

    const signInButton = container.querySelector('[data-openai-codex-signin]');
    const signOutButton = container.querySelector('[data-openai-codex-signout]');

    if (signInButton) {
      signInButton.addEventListener('click', onSignInClicked);
    }

    if (signOutButton) {
      signOutButton.addEventListener('click', onSignOutClicked);
    }
  }

  /**
   * @description Starts the OpenAI Codex OAuth flow and polls authentication state until completion.
   * @returns Promise that resolves after auth success or timeout/error handling
   */
  async function onSignInClicked() {
    try {
      const startResult = await fetchJson(OPENAI_CODEX_START_ENDPOINT, { method: 'GET' });
      if (!startResult.success || !startResult.authUrl) {
        throw new Error(startResult.error || 'Failed to start OpenAI Codex sign-in');
      }

      const popup = window.open(startResult.authUrl, 'openai-codex-oauth', 'width=620,height=780');
      if (!popup) {
        window.location.href = startResult.authUrl;
      }

      writeOutput('OpenAI Codex sign-in opened. Complete login in the popup window.', 'info');
      await pollForOpenAiCodexAuthentication();
    } catch (error) {
      writeOutput('OpenAI Codex sign-in failed: ' + toErrorMessage(error), 'error');
    }
  }

  /**
   * @description Signs out OpenAI Codex credentials from the backend and refreshes local auth status UI.
   * @returns Promise that resolves after sign-out status refresh
   */
  async function onSignOutClicked() {
    try {
      const signOutResult = await fetchJson(OPENAI_CODEX_SIGNOUT_ENDPOINT, { method: 'POST' });
      if (!signOutResult.success) {
        throw new Error(signOutResult.error || 'Failed to sign out OpenAI Codex');
      }

      await refreshOpenAiCodexStatus();
      writeOutput('OpenAI Codex credentials removed.', 'success');
    } catch (error) {
      writeOutput('OpenAI Codex sign-out failed: ' + toErrorMessage(error), 'error');
    }
  }

  /**
   * @description Polls OAuth status until authentication succeeds or timeout is reached.
   * @returns Promise that resolves when polling loop exits
   */
  async function pollForOpenAiCodexAuthentication() {
    const startedAt = Date.now();
    const timeoutMs = 180000;

    while (Date.now() - startedAt < timeoutMs) {
      await delay(2000);
      const status = await refreshOpenAiCodexStatus();
      if (status.authenticated) {
        writeOutput('OpenAI Codex sign-in complete.', 'success');
        return;
      }
    }

    writeOutput('OpenAI Codex sign-in timed out. Please try again.', 'error');
  }

  /**
   * @description Fetches and applies the latest OpenAI Codex authentication status to all active UI controls.
   * @returns Promise resolving to the normalized status payload
   */
  async function refreshOpenAiCodexStatus() {
    try {
      const statusResult = await fetchJson(OPENAI_CODEX_STATUS_ENDPOINT, { method: 'GET' });
      const normalized = {
        authenticated: !!statusResult.authenticated,
        email: statusResult.email || null,
      };
      applyOpenAiCodexStatus(normalized);
      return normalized;
    } catch (error) {
      const fallback = { authenticated: false, email: null };
      applyOpenAiCodexStatus(fallback);
      writeOutput('Unable to read OpenAI Codex auth status: ' + toErrorMessage(error), 'error');
      return fallback;
    }
  }

  /**
   * @description Updates sign-in/sign-out buttons and status labels for all rendered OpenAI Codex provider panels.
   * @param status - Current authentication state returned by backend status endpoint
   */
  function applyOpenAiCodexStatus(status) {
    const statusText = status.authenticated
      ? 'Signed in' + (status.email ? ' as ' + status.email : '')
      : 'Not signed in';
    const statusColor = status.authenticated ? '#4ec9b0' : '#858585';

    document.querySelectorAll('[data-openai-codex-status]').forEach(function updateStatusNode(node) {
      node.textContent = statusText;
      node.style.color = statusColor;
    });

    document.querySelectorAll('[data-openai-codex-signin]').forEach(function updateSignInButton(node) {
      node.style.display = status.authenticated ? 'none' : '';
    });

    document.querySelectorAll('[data-openai-codex-signout]').forEach(function updateSignOutButton(node) {
      node.style.display = status.authenticated ? '' : 'none';
    });
  }

  /**
   * @description Executes a JSON fetch request using existing auth headers from ui-logic helpers.
   * @param url - Request URL
   * @param options - Fetch options such as method/body
   * @returns Promise resolving to parsed JSON response
   */
  async function fetchJson(url, options) {
    const requestOptions = { ...options, headers: buildRequestHeaders(options && options.headers) };
    const response = await fetch(url, requestOptions);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || ('Request failed with status ' + response.status));
    }
    return payload;
  }

  /**
   * @description Builds request headers using legacy ui-logic `buildHeaders` helper when available.
   * @param extraHeaders - Optional extra headers to merge into auth/context headers
   * @returns Header object for authenticated UI requests
   */
  function buildRequestHeaders(extraHeaders) {
    if (typeof window.buildHeaders === 'function') {
      return window.buildHeaders(extraHeaders);
    }
    return extraHeaders || {};
  }

  /**
   * @description Writes status messages through legacy ui-logic output helper when available.
   * @param message - Status message to display
   * @param type - Message type (`info`, `success`, or `error`)
   */
  function writeOutput(message, type) {
    if (typeof window.logOutput === 'function') {
      window.logOutput(message, type);
    }
  }

  /**
   * @description Converts unknown errors into stable user-facing messages.
   * @param error - Unknown error value from failed async operations
   * @returns Human-readable message string
   */
  function toErrorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  /**
   * @description Asynchronous timeout helper used by polling flow.
   * @param ms - Delay duration in milliseconds
   * @returns Promise resolved after delay elapses
   */
  function delay(ms) {
    return new Promise(function resolveAfterDelay(resolve) {
      setTimeout(resolve, ms);
    });
  }
})();

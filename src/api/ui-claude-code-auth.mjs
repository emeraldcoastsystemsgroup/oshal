/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Claude Code auth UI patch with sign-in/sign-out controls and live status polling
 */

(function applyClaudeCodeAuthPatch() {
  'use strict';

  const CLAUDE_CODE_PROVIDER = 'claude-code';
  const STATUS_ENDPOINT = '/api/claude-code/auth/status';
  const START_ENDPOINT = '/api/claude-code/auth/start';
  const SIGNOUT_ENDPOINT = '/api/claude-code/auth/signout';
  const SUBMIT_CODE_ENDPOINT = '/api/claude-code/auth/submit-code';

  const originalRenderProviderConfigFields = window.renderProviderConfigFields;
  const originalHandleProviderChange = window.handleProviderChange;

  if (typeof originalRenderProviderConfigFields !== 'function' || typeof originalHandleProviderChange !== 'function') {
    return;
  }

  patchProviderInfoText();
  patchProviderChangeHandler();
  patchProviderConfigRenderer();

  /**
   * @description Updates provider info text to describe Claude Code login behavior.
   */
  function patchProviderInfoText() {
    if (!window.PROVIDER_INFO) {
      return;
    }

    window.PROVIDER_INFO[CLAUDE_CODE_PROVIDER] = 'Claude Code - Sign in with Claude account (or API key) via Claude CLI auth.';
  }

  /**
   * @description Wraps provider change handler so selected Claude Code provider refreshes auth status.
   */
  function patchProviderChangeHandler() {
    window.handleProviderChange = function patchedHandleProviderChange(mode, provider) {
      originalHandleProviderChange(mode, provider);

      if (provider !== CLAUDE_CODE_PROVIDER) {
        return;
      }

      void refreshClaudeCodeStatus();
    };
  }

  /**
   * @description Wraps provider config renderer and injects Claude auth controls when Claude Code is selected.
   */
  function patchProviderConfigRenderer() {
    window.renderProviderConfigFields = function patchedRenderProviderConfigFields(mode, provider) {
      originalRenderProviderConfigFields(mode, provider);

      if (provider !== CLAUDE_CODE_PROVIDER) {
        return;
      }

      const container = document.getElementById(mode + '-provider-config');
      if (!container) {
        return;
      }

      prependClaudeCodeAuthControls(container);
      void refreshClaudeCodeStatus();
    };
  }

  /**
   * @description Injects Claude Code login controls before existing provider-specific config fields.
   * @param container - Provider config container element for current mode
   */
  function prependClaudeCodeAuthControls(container) {
    if (container.querySelector('[data-claude-code-auth-controls]')) {
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'form-group';
    wrapper.setAttribute('data-claude-code-auth-controls', 'true');
    wrapper.innerHTML = `
      <label>Claude Code Authentication</label>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <button type="button" data-claude-code-signin>Sign in to Claude Code</button>
        <button type="button" class="secondary" data-claude-code-signout style="display:none;">Sign out</button>
        <span data-claude-code-status style="font-size:12px; color:#858585;">Checking authentication...</span>
      </div>
      <div data-claude-code-code-entry style="display:none; margin-top:8px;">
        <label style="font-size:12px; color:#858585;">Paste the auth code from the browser popup:</label>
        <div style="display:flex; gap:8px; align-items:center; margin-top:4px;">
          <input type="text" data-claude-code-code-input placeholder="Paste auth code here..." style="flex:1; font-family:monospace; font-size:13px;" />
          <button type="button" data-claude-code-submit-code>Submit Code</button>
        </div>
      </div>
    `;

    const signInButton = wrapper.querySelector('[data-claude-code-signin]');
    const signOutButton = wrapper.querySelector('[data-claude-code-signout]');

    const submitCodeButton = wrapper.querySelector('[data-claude-code-submit-code]');

    if (signInButton) {
      signInButton.addEventListener('click', onSignInClicked);
    }

    if (signOutButton) {
      signOutButton.addEventListener('click', onSignOutClicked);
    }

    if (submitCodeButton) {
      submitCodeButton.addEventListener('click', onSubmitCodeClicked);
    }

    container.prepend(wrapper);
  }

  /**
   * @description Starts Claude Code login flow and opens provider URL when returned by backend.
   * @returns Promise that resolves once polling completes or times out
   */
  async function onSignInClicked() {
    try {
      const startResult = await fetchJson(START_ENDPOINT, { method: 'GET' });

      if (!startResult.success) {
        throw new Error(startResult.error || 'Failed to start Claude Code sign-in');
      }

      if (startResult.authUrl) {
        const popup = window.open(startResult.authUrl, 'claude-code-auth', 'width=620,height=780');
        if (!popup) {
          window.location.href = startResult.authUrl;
        }
      }

      // Show the code entry field for pasting the auth code from the popup.
      // The popup opens Anthropic's auth page which displays a code after login.
      showCodeEntry();
      writeOutput('Claude Code sign-in started. After authenticating in the browser popup, copy the code shown and paste it below.', 'info');
    } catch (error) {
      writeOutput('Claude Code sign-in failed: ' + toErrorMessage(error), 'error');
    }
  }

  /**
   * @description Signs out Claude Code authentication and refreshes UI status.
   * @returns Promise that resolves after backend sign-out and status refresh
   */
  async function onSignOutClicked() {
    try {
      const signOutResult = await fetchJson(SIGNOUT_ENDPOINT, { method: 'POST' });
      if (!signOutResult.success) {
        throw new Error(signOutResult.error || 'Failed to sign out Claude Code');
      }

      await refreshClaudeCodeStatus();
      writeOutput('Claude Code credentials removed.', 'success');
    } catch (error) {
      writeOutput('Claude Code sign-out failed: ' + toErrorMessage(error), 'error');
    }
  }

  /**
   * @description Polls Claude Code auth status until authenticated or timeout.
   */
  /**
   * @description Shows the code entry field for pasting the auth code from the browser popup.
   */
  function showCodeEntry() {
    document.querySelectorAll('[data-claude-code-code-entry]').forEach(function showEntry(node) {
      node.style.display = '';
    });
  }

  /**
   * @description Hides the code entry field.
   */
  function hideCodeEntry() {
    document.querySelectorAll('[data-claude-code-code-entry]').forEach(function hideEntry(node) {
      node.style.display = 'none';
    });
    document.querySelectorAll('[data-claude-code-code-input]').forEach(function clearInput(node) {
      node.value = '';
    });
  }

  /**
   * @description Submits the auth code from the input field to the backend.
   */
  async function onSubmitCodeClicked() {
    const input = document.querySelector('[data-claude-code-code-input]');
    const code = input && input.value && input.value.trim();
    if (!code) {
      writeOutput('Please paste the auth code first.', 'error');
      return;
    }

    try {
      writeOutput('Submitting auth code...', 'info');
      const result = await fetchJson(SUBMIT_CODE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
      });

      if (result.authenticated) {
        hideCodeEntry();
        writeOutput('Claude Code sign-in complete!', 'success');
        await refreshClaudeCodeStatus();
      } else {
        writeOutput('Auth code submitted but authentication not confirmed. Check status.', 'info');
        await refreshClaudeCodeStatus();
      }
    } catch (error) {
      writeOutput('Failed to submit auth code: ' + toErrorMessage(error), 'error');
    }
  }

  async function pollForClaudeCodeAuthentication() {
    const timeoutMs = 180000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      await delay(2000);
      const status = await refreshClaudeCodeStatus();
      if (status.authenticated) {
        writeOutput('Claude Code sign-in complete.', 'success');
        return;
      }
    }

    writeOutput('Claude Code sign-in timed out. Please try again.', 'error');
  }

  /**
   * @description Fetches latest Claude Code auth status and updates control state.
   * @returns Normalized status payload
   */
  async function refreshClaudeCodeStatus() {
    try {
      const statusResult = await fetchJson(STATUS_ENDPOINT, { method: 'GET' });
      const normalized = {
        available: statusResult.available !== false,
        authenticated: !!statusResult.authenticated,
        email: statusResult.email || null,
        authMethod: statusResult.authMethod || null,
      };
      applyClaudeCodeStatus(normalized);
      return normalized;
    } catch (error) {
      writeOutput('Unable to read Claude Code auth status: ' + toErrorMessage(error), 'error');
      const fallback = { available: false, authenticated: false, email: null, authMethod: null };
      applyClaudeCodeStatus(fallback);
      return fallback;
    }
  }

  /**
   * @description Updates sign-in/sign-out controls for all rendered Claude Code provider panels.
   * @param status - Current Claude Code auth status
   */
  function applyClaudeCodeStatus(status) {
    const statusText = computeStatusText(status);
    const statusColor = status.authenticated ? '#4ec9b0' : (status.available ? '#858585' : '#f87171');

    document.querySelectorAll('[data-claude-code-status]').forEach(function updateStatusNode(node) {
      node.textContent = statusText;
      node.style.color = statusColor;
    });

    document.querySelectorAll('[data-claude-code-signin]').forEach(function updateSignInButton(node) {
      node.style.display = status.authenticated ? 'none' : '';
      node.disabled = !status.available;
    });

    document.querySelectorAll('[data-claude-code-signout]').forEach(function updateSignOutButton(node) {
      node.style.display = status.authenticated ? '' : 'none';
      node.disabled = !status.available;
    });
  }

  /**
   * @description Computes concise status label text for Claude Code auth controls.
   * @param status - Current Claude Code auth status
   * @returns User-visible status text
   */
  function computeStatusText(status) {
    if (!status.available) {
      return 'Claude CLI unavailable';
    }

    if (!status.authenticated) {
      return 'Not signed in';
    }

    const authDescriptor = status.authMethod ? ' via ' + status.authMethod : '';
    const emailDescriptor = status.email ? ' as ' + status.email : '';
    return 'Signed in' + emailDescriptor + authDescriptor;
  }

  /**
   * @description Executes JSON fetch requests using ui-logic auth header helper when available.
   * @param url - Request URL
   * @param options - Fetch options object
   * @returns Parsed JSON response payload
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
   * @description Builds request headers, reusing ui-logic helpers when present.
   * @param extraHeaders - Optional additional headers
   * @returns Header object for authenticated requests
   */
  function buildRequestHeaders(extraHeaders) {
    if (typeof window.buildHeaders === 'function') {
      return window.buildHeaders(extraHeaders);
    }

    return extraHeaders || {};
  }

  /**
   * @description Writes UI output messages through shared ui-logic logger when available.
   * @param message - Text message to display
   * @param type - UI message type
   */
  function writeOutput(message, type) {
    if (typeof window.logOutput === 'function') {
      window.logOutput(message, type);
    }
  }

  /**
   * @description Converts unknown errors into stable message strings.
   * @param error - Unknown error object
   * @returns Human-readable error text
   */
  function toErrorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  /**
   * @description Asynchronous delay helper used by auth polling loop.
   * @param ms - Delay in milliseconds
   * @returns Promise resolved after delay
   */
  function delay(ms) {
    return new Promise(function resolveAfterDelay(resolve) {
      setTimeout(resolve, ms);
    });
  }
})();

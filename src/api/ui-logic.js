/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of UI logic with provider config
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added provider-specific configuration fields and models
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added authentication helpers (getAuthHeaders, buildHeaders,
 *              |         | toggleAuthKeyVisibility, initAuth) and integrated auth
 *              |         | headers into all fetch() calls
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Updated getAuthHeaders to prefer OIDC access token for
 *              |         | per-user config storage support
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added parent-window notifications so embedded /ui sessions
 *              |         | can refresh the standalone chat modal after save/load/clear
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted provider catalogs (PROVIDER_CONFIG/PROVIDER_DISPLAY_NAMES -> ui-provider-fields.js; PROVIDER_MODELS/PROVIDER_INFO -> ui-provider-models.js) to satisfy the 1000-code-line cap; GET /ui-logic.js serves the three files concatenated - zero behavior change
 */

/**
 * @description UI Logic for Cline API Configuration.
 * Handles all interactions, model selection, and configuration management.
 * Provider catalog data lives in ui-provider-fields.js and ui-provider-models.js;
 * the GET /ui-logic.js route (src/app/server.ts) serves those files concatenated
 * ahead of this one, so pages keep a single <script src="ui-logic.js"> tag.
 * @module ui-logic
 */

// =============================================================================
// AUTHENTICATION HELPERS
// =============================================================================

/**
 * @description Returns the Authorization header object. Prefers the OIDC
 * access token (from localStorage, set by /auth/callback) for per-user
 * config isolation. Falls back to the API key input for legacy Bearer auth.
 *
 * @returns {Object} Header object with Authorization key, or empty object
 */
function getAuthHeaders() {
  // Prefer OIDC access token for per-user config support
  const oidcToken = localStorage.getItem('oshal_access_token');
  const oidcExpiry = parseInt(localStorage.getItem('oshal_token_expiry') || '0', 10);

  if (oidcToken && oidcExpiry > Date.now()) {
    return { 'Authorization': 'Bearer ' + oidcToken };
  }

  // Fall back to API key auth
  const input = document.getElementById('auth-api-key');
  const key = input ? input.value.trim() : '';
  if (key) {
    localStorage.setItem('authApiKey', key);
    return { 'Authorization': 'Bearer ' + key };
  }
  return {};
}

/**
 * @description Builds a complete headers object merging auth and content-type.
 * @param {Object} [extra] - Additional headers to merge (e.g., Content-Type)
 * @returns {Object} Merged headers object with auth and extra headers
 */
function buildHeaders(extra) {
  return { ...getAuthHeaders(), ...(extra || {}) };
}

/**
 * @description Notify a same-origin parent window when this config UI is hosted
 * inside an embedded frame.
 * @param {string} eventType - Short event name describing the action
 * @param {Object} [payload] - Optional structured payload
 * @returns {void}
 */
function notifyConfigHost(eventType, payload) {
  if (window.parent === window) {
    return;
  }

  window.parent.postMessage(
    {
      source: 'oshal-api-config',
      eventType,
      payload: payload || null,
    },
    window.location.origin,
  );
}

/**
 * @description Toggles visibility of the auth API key input field
 * between password and text types, updating the toggle button icon.
 * @returns {void}
 */
function toggleAuthKeyVisibility() {
  const input = document.getElementById('auth-api-key');
  const btn = document.getElementById('auth-toggle-btn');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🔒';
  } else {
    input.type = 'password';
    btn.textContent = '👁️';
  }
}

/**
 * @description Initializes the auth section from localStorage on page load.
 * Restores saved API key and attaches input event listener for live updates.
 * @returns {void}
 */
function initAuth() {
  const saved = localStorage.getItem('authApiKey');
  const input = document.getElementById('auth-api-key');
  const status = document.getElementById('auth-status');
  if (saved && input) {
    input.value = saved;
    status.textContent = 'Key loaded from storage';
    status.style.color = '#4ec9b0';
  }
  if (input) {
    input.addEventListener('input', function() {
      const val = this.value.trim();
      if (val) {
        localStorage.setItem('authApiKey', val);
        status.textContent = 'Key set';
        status.style.color = '#4ec9b0';
      } else {
        localStorage.removeItem('authApiKey');
        status.textContent = 'Not set';
        status.style.color = '#858585';
      }
    });
  }
}

// Current configuration state
let currentConfig = {
  mode: 'plan',
  planModeApiProvider: '',
  planModeApiModelId: '',
  actModeApiProvider: '',
  actModeApiModelId: '',
  maxTokens: 8192,
  temperature: 0.7,
};

// Initialize UI
document.addEventListener('DOMContentLoaded', function() {
  console.log('PROVIDER_CONFIG keys:', Object.keys(PROVIDER_CONFIG));
  initAuth();
  initializeUI();
  loadConfigurationFromLocalStorage();
});

function initializeUI() {
  // Mode toggle
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const mode = this.dataset.mode;
      switchMode(mode);
    });
  });

  // Provider change listeners
  document.getElementById('plan-provider').addEventListener('change', function() {
    handleProviderChange('plan', this.value);
  });

  document.getElementById('act-provider').addEventListener('change', function() {
    handleProviderChange('act', this.value);
  });

  // Render initial (empty) provider config sections
  renderProviderConfigFields('plan', '');
  renderProviderConfigFields('act', '');

  logOutput('UI initialized. Ready to configure API settings.');
}

function switchMode(mode) {
  currentConfig.mode = mode;
  
  // Update button states
  document.querySelectorAll('.mode-btn').forEach(btn => {
    if (btn.dataset.mode === mode) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Update section visibility
  if (mode === 'plan') {
    document.getElementById('plan-config').classList.add('active');
    document.getElementById('act-config').classList.remove('active');
  } else {
    document.getElementById('plan-config').classList.remove('active');
    document.getElementById('act-config').classList.add('active');
  }

  logOutput(`Switched to ${mode.toUpperCase()} mode`);
}

function handleProviderChange(mode, provider) {
  const modelSelect = document.getElementById(`${mode}-model`);
  const providerInfo = document.getElementById(`${mode}-provider-info`);

  // Update provider info
  if (provider && PROVIDER_INFO[provider]) {
    providerInfo.textContent = PROVIDER_INFO[provider];
  } else {
    providerInfo.textContent = '';
  }

  // Update model dropdown
  modelSelect.innerHTML = '<option value="">Select model...</option>';
  
  if (provider && PROVIDER_MODELS[provider]) {
    PROVIDER_MODELS[provider].forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      modelSelect.appendChild(option);
    });
  }

  // Update current config
  if (mode === 'plan') {
    currentConfig.planModeApiProvider = provider;
    currentConfig.planModeApiModelId = '';
  } else {
    currentConfig.actModeApiProvider = provider;
    currentConfig.actModeApiModelId = '';
  }

  // Render provider-specific config fields
  renderProviderConfigFields(mode, provider);

  logOutput(`Selected provider: ${provider || 'none'} for ${mode} mode`);
}

/**
 * @description Render provider-specific configuration fields (settings + secrets)
 * into the provider-config container for the given mode.
 * @param {string} mode - The mode ('plan' or 'act')
 * @param {string} provider - The provider key (e.g., 'anthropic', 'openai')
 * @returns {void}
 */
function renderProviderConfigFields(mode, provider) {
  const container = document.getElementById(`${mode}-provider-config`);
  if (!container) return;

  container.innerHTML = '';

  if (!provider || !PROVIDER_CONFIG[provider]) {
    return;
  }

  const config = PROVIDER_CONFIG[provider];
  const allFields = [
    ...(config.settings || []),
    ...(config.secrets || []),
  ];

  if (allFields.length === 0) return;

  allFields.forEach(field => {
    const formGroup = document.createElement('div');
    formGroup.className = 'form-group';

    if (field.type === 'checkbox') {
      formGroup.innerHTML = `
        <label class="checkbox-label">
          <input type="checkbox" id="${mode}-${field.key}" data-config-key="${field.key}" />
          <span>${field.label}</span>
        </label>
      `;
    } else {
      const inputType = field.type === 'number' ? 'number' : (field.type === 'password' ? 'password' : 'text');
      formGroup.innerHTML = `
        <label for="${mode}-${field.key}">${field.label}</label>
        <input type="${inputType}" id="${mode}-${field.key}" data-config-key="${field.key}" placeholder="${field.placeholder || ''}" />
      `;
    }

    container.appendChild(formGroup);
  });
}

function gatherConfigFromForm() {
  const config = {
    mode: currentConfig.mode,
    
    // Plan mode
    planModeApiProvider: document.getElementById('plan-provider').value,
    planModeApiModelId: document.getElementById('plan-model').value,
    
    // Act mode
    actModeApiProvider: document.getElementById('act-provider').value,
    actModeApiModelId: document.getElementById('act-model').value,
    
    // Advanced settings
    maxTokens: parseInt(document.getElementById('max-tokens').value) || 8192,
    temperature: parseFloat(document.getElementById('temperature').value) || 0.7,
  };

  // Gather provider-specific config fields from both modes
  ['plan', 'act'].forEach(mode => {
    const container = document.getElementById(`${mode}-provider-config`);
    if (!container) return;

    container.querySelectorAll('[data-config-key]').forEach(input => {
      const key = input.dataset.configKey;
      const prefixedKey = `${mode}_${key}`;
      if (input.type === 'checkbox') {
        config[prefixedKey] = input.checked;
      } else {
        const value = input.value.trim();
        if (value) {
          config[prefixedKey] = value;
        }
      }
    });
  });

  return config;
}

async function saveConfiguration() {
  try {
    const config = gatherConfigFromForm();

    // Save to localStorage (always, as a cache)
    localStorage.setItem('clineApiConfig', JSON.stringify(config));

    // Save to filesystem via API server
    await saveToFilesystem(config);

    // Display the configuration
    const output = {
      message: '✅ Configuration saved successfully!',
      timestamp: new Date().toISOString(),
      config: {
        mode: config.mode,
        planMode: {
          provider: config.planModeApiProvider,
          model: config.planModeApiModelId,
        },
        actMode: {
          provider: config.actModeApiProvider,
          model: config.actModeApiModelId,
        },
        settings: {
          maxTokens: config.maxTokens,
          temperature: config.temperature,
        },
        providerFieldsConfigured: Object.keys(config).filter(k => k.startsWith('plan_') || k.startsWith('act_')).length,
      },
    };

    logOutput(JSON.stringify(output, null, 2), 'success');
    notifyConfigHost('config-saved', { config });
    
    console.log('Configuration to save:', config);
  } catch (error) {
    logOutput(`Error saving configuration: ${error.message}`, 'error');
  }
}

/**
 * @description Save configuration to the filesystem via the API server.
 * Falls back gracefully if the API server is not running.
 * @param {Object} config - The configuration object gathered from the form
 * @returns {Promise<void>}
 */
async function saveToFilesystem(config) {
  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(config),
    });
    const result = await response.json();
    if (result.success) {
      const fileList = (result.files || []).map(f => f.split('/').pop()).join(', ');
      logOutput(`💾 Filesystem: Saved to ${result.mode} mode files: ${fileList}`, 'success');
    } else {
      logOutput(`⚠️ Filesystem save warning: ${result.error}`, 'error');
    }
  } catch (err) {
    console.warn('API server not available, config saved to localStorage only:', err.message);
    logOutput('⚠️ API server not available — saved to localStorage only. Run "npm start" for filesystem persistence.', 'error');
  }
}

/**
 * @description Load configuration from the filesystem via the API server.
 * @returns {Promise<Object|null>} The loaded configuration or null if unavailable
 */
async function loadFromFilesystem() {
  try {
    const response = await fetch('/api/config', { headers: buildHeaders() });
    const result = await response.json();
    if (result.success && result.config && Object.keys(result.config).length > 0) {
      return result.config;
    }
  } catch (err) {
    console.warn('API server not available for loading:', err.message);
  }
  return null;
}

/**
 * @description Fetch server status (write mode, output dir, file states).
 * @returns {Promise<Object|null>} The server status object or null if unavailable
 */
async function fetchServerStatus() {
  try {
    const response = await fetch('/api/status', { headers: buildHeaders() });
    const result = await response.json();
    if (result.success) {
      return result;
    }
  } catch (err) {
    console.warn('Could not fetch server status:', err.message);
  }
  return null;
}

function loadConfiguration() {
  try {
    const saved = localStorage.getItem('clineApiConfig');
    if (!saved) {
      logOutput('No saved configuration found.', 'error');
      return;
    }

    const config = JSON.parse(saved);

    // Load mode
    if (config.mode) {
      switchMode(config.mode);
    }

    // Load plan mode
    if (config.planModeApiProvider) {
      document.getElementById('plan-provider').value = config.planModeApiProvider;
      handleProviderChange('plan', config.planModeApiProvider);
      if (config.planModeApiModelId) {
        setTimeout(() => {
          document.getElementById('plan-model').value = config.planModeApiModelId;
        }, 100);
      }
    }

    // Load act mode
    if (config.actModeApiProvider) {
      document.getElementById('act-provider').value = config.actModeApiProvider;
      handleProviderChange('act', config.actModeApiProvider);
      if (config.actModeApiModelId) {
        setTimeout(() => {
          document.getElementById('act-model').value = config.actModeApiModelId;
        }, 100);
      }
    }

    // Load advanced settings
    if (config.maxTokens) {
      document.getElementById('max-tokens').value = config.maxTokens;
    }
    if (config.temperature !== undefined) {
      document.getElementById('temperature').value = config.temperature;
    }

    // Load provider-specific fields
    setTimeout(() => {
      ['plan', 'act'].forEach(mode => {
        Object.keys(config).forEach(key => {
          if (key.startsWith(`${mode}_`)) {
            const fieldKey = key.substring(mode.length + 1);
            const input = document.getElementById(`${mode}-${fieldKey}`);
            if (input) {
              if (input.type === 'checkbox') {
                input.checked = config[key];
              } else {
                input.value = config[key];
              }
            }
          }
        });
      });
    }, 200);

    logOutput('✅ Configuration loaded successfully!', 'success');
    notifyConfigHost('config-loaded', { config });
  } catch (error) {
    logOutput(`Error loading configuration: ${error.message}`, 'error');
  }
}

function loadConfigurationFromLocalStorage() {
  // Auto-load on startup
  const saved = localStorage.getItem('clineApiConfig');
  if (saved) {
    setTimeout(() => {
      loadConfiguration();
    }, 500);
  }
}

function clearConfiguration() {
  if (confirm('Are you sure you want to clear all configuration?')) {
    // Clear form
    document.querySelectorAll('select').forEach(select => select.value = '');
    document.querySelectorAll('input[type="password"], input[type="text"]').forEach(input => input.value = '');
    document.querySelectorAll('input[type="checkbox"]').forEach(input => input.checked = false);
    document.getElementById('max-tokens').value = '8192';
    document.getElementById('temperature').value = '0.7';

    // Clear provider config containers
    ['plan', 'act'].forEach(mode => {
      const container = document.getElementById(`${mode}-provider-config`);
      if (container) container.innerHTML = '';
    });

    // Clear localStorage
    localStorage.removeItem('clineApiConfig');

    // Clear filesystem via API
    clearFilesystem();

    // Reset state
    currentConfig = {
      mode: 'plan',
      planModeApiProvider: '',
      planModeApiModelId: '',
      actModeApiProvider: '',
      actModeApiModelId: '',
      maxTokens: 8192,
      temperature: 0.7,
    };

    logOutput('Configuration cleared.', 'success');
    notifyConfigHost('config-cleared');
  }
}

/**
 * @description Clear configuration files from the filesystem via API.
 * @returns {Promise<void>}
 */
async function clearFilesystem() {
  try {
    const response = await fetch('/api/config', { method: 'DELETE', headers: buildHeaders() });
    const result = await response.json();
    if (result.success) {
      logOutput('💾 Filesystem: Configuration files deleted.', 'success');
    }
  } catch (err) {
    console.warn('API server not available for clearing:', err.message);
  }
}

function logOutput(message, type = 'info') {
  const output = document.getElementById('output');
  const timestamp = new Date().toLocaleTimeString();
  const className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';
  const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : '📝';
  
  output.innerHTML = `<pre class="${className}">[${timestamp}] ${prefix} ${message}</pre>`;
}
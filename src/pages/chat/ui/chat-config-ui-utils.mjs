/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted standalone chat config modal theme and task-id helpers from the oversized modal controller
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added hyphen-aware theme label formatting for expanded gray, black, and light-blue theme catalog
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added local cached API-config preview merge so chat footer summaries can reflect selected provider/model before a server save
 */

/**
 * @description Generates a task identifier for standalone chat sessions.
 * @returns {string} UUID when available, otherwise a timestamp/random fallback.
 */
export function generateTaskId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  const randomPart = Math.random().toString(36).substring(2, 10);
  return `${Date.now()}-${randomPart}`;
}

/**
 * @description Resolves a theme id against the supported theme catalog.
 * @param {string} theme Candidate theme id.
 * @param {string[]} supportedThemes Supported theme ids.
 * @returns {string} Valid theme id.
 */
export function resolveTheme(theme, supportedThemes) {
  return supportedThemes.includes(theme) ? theme : 'midnight';
}

/**
 * @description Formats a theme id into a user-facing label.
 * @param {string} themeId Theme id.
 * @returns {string} Capitalized label.
 */
export function formatThemeLabel(themeId) {
  return themeId
    .split('-')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

/**
 * @description Builds the embedded API config iframe source for the selected theme.
 * @param {string} theme Theme id.
 * @param {(theme: string, supportedThemes: string[]) => string} resolveThemeFn Theme resolution helper.
 * @param {string[]} supportedThemes Supported theme ids.
 * @returns {string} iframe src path.
 */
export function getApiConfigFrameSrc(theme, resolveThemeFn, supportedThemes) {
  return `/ui?embed=1&theme=${encodeURIComponent(resolveThemeFn(theme, supportedThemes))}&hideTheme=1`;
}

/**
 * @description Merges server config with any cached `/ui` form selection preview from localStorage.
 * This keeps the chat footer summary aligned with the embedded provider picker after refresh.
 *
 * @param {Record<string, unknown>} config Persisted server config.
 * @returns {Record<string, unknown>} Config with missing provider/model fields filled from cached preview.
 */
export function mergeCachedApiConfigPreview(config) {
  const cached = readCachedApiConfig();
  const nextConfig = isRecord(config) ? { ...config } : {};

  ['mode', 'planModeApiProvider', 'planModeApiModelId', 'actModeApiProvider', 'actModeApiModelId', 'provider', 'model'].forEach((key) => {
    if (!readString(nextConfig[key]) && readString(cached[key])) {
      nextConfig[key] = cached[key];
    }
  });

  return nextConfig;
}

function readCachedApiConfig() {
  try {
    const raw = localStorage.getItem('clineApiConfig');
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    console.warn('[chat-config-ui-utils] Failed to parse cached API config preview', error);
    return {};
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

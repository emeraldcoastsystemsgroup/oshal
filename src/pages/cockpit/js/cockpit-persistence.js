/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit local persistence and lightweight DOM helper functions from app.js to reduce shell-file size and centralize storage behavior
 */

const COCKPIT_SELECTED_AGENT_STORAGE_KEY = 'oshal-cockpit-selected-agent-id';
const COCKPIT_QUICK_SETTINGS_STORAGE_KEY = 'oshal-cockpit-quick-settings';
const COCKPIT_WORKSPACE_FOCUS_WIDE_KEY = 'oshal-cockpit-workspace-focus-wide';
const COCKPIT_WORKSPACE_FOCUS_CUSTOM_WIDTH_KEY = 'oshal-cockpit-workspace-focus-custom-width';

/**
 * @description Read the currently selected cockpit bot label for chat-context sync.
 *
 * @returns {string} Selected option label or empty string when no selector is mounted.
 */
export function getSelectedBotLabel() {
  const select = document.getElementById('botSelector');
  if (!(select instanceof HTMLSelectElement)) {
    return '';
  }

  const selectedOption = select.selectedOptions?.[0];
  return selectedOption?.textContent?.trim() || '';
}

/**
 * @description Bind one cockpit workspace action button to a click handler when it exists.
 *
 * @param {string} id - DOM id of the cockpit-side workspace action button.
 * @param {() => void} handler - Click handler.
 * @returns {void}
 */
export function bindWorkspaceActionButton(id, handler) {
  document.getElementById(id)?.addEventListener('click', handler);
}

/**
 * @description Read the preferred selected agent id from query parameters or local storage.
 *
 * @returns {string} Preferred agent id or empty string.
 */
export function readPreferredSelectedAgentId() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = (params.get('agentId') || '').trim();
  if (fromQuery) {
    return fromQuery;
  }

  try {
    return (window.localStorage.getItem(COCKPIT_SELECTED_AGENT_STORAGE_KEY) || '').trim();
  } catch (error) {
    logCockpitStorageWarning('read-selected-agent-id', error);
    return '';
  }
}

/**
 * @description Read persisted lightweight cockpit quick settings for the right rail and header handoffs.
 *
 * @returns {{ autoApprove: boolean }} Persisted quick-setting state with safe defaults.
 */
export function readPersistedQuickSettings() {
  try {
    const raw = window.localStorage.getItem(COCKPIT_QUICK_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { autoApprove: false };
    }

    const parsed = JSON.parse(raw);
    return {
      autoApprove: parsed?.autoApprove === true,
    };
  } catch (error) {
    logCockpitStorageWarning('read-quick-settings', error);
    return { autoApprove: false };
  }
}

/**
 * @description Persist lightweight cockpit quick settings used by the right-rail runtime.
 *
 * @param {{ autoApprove?: boolean }} settings - Quick-setting payload to persist.
 * @returns {void}
 */
export function persistQuickSettings(settings) {
  const payload = {
    autoApprove: settings?.autoApprove === true,
  };

  try {
    window.localStorage.setItem(COCKPIT_QUICK_SETTINGS_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    logCockpitStorageWarning('persist-quick-settings', error);
  }
}

/**
 * @description Read the preferred workspace-focus width mode.
 *
 * @returns {boolean} True when operators previously widened the workspace-focus stage.
 */
export function readWorkspaceFocusWidePreference() {
  try {
    return window.localStorage.getItem(COCKPIT_WORKSPACE_FOCUS_WIDE_KEY) === 'true';
  } catch (error) {
    logCockpitStorageWarning('read-workspace-focus-width', error);
    return false;
  }
}

/**
 * @description Read the preferred drag-resized workspace-focus width.
 *
 * @returns {number | null} Saved pixel width or null when no custom width is stored.
 */
export function readWorkspaceFocusCustomWidthPreference() {
  try {
    const raw = window.localStorage.getItem(COCKPIT_WORKSPACE_FOCUS_CUSTOM_WIDTH_KEY);
    const value = Number.parseInt(raw || '', 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (error) {
    logCockpitStorageWarning('read-workspace-focus-custom-width', error);
    return null;
  }
}

/**
 * @description Persist the preferred workspace-focus width mode.
 *
 * @param {boolean} isWide - Whether workspace focus should reopen in wider mode.
 * @returns {void}
 */
export function persistWorkspaceFocusWidePreference(isWide) {
  try {
    window.localStorage.setItem(COCKPIT_WORKSPACE_FOCUS_WIDE_KEY, String(isWide === true));
  } catch (error) {
    logCockpitStorageWarning('persist-workspace-focus-width', error);
  }
}

/**
 * @description Persist the preferred drag-resized workspace-focus width.
 *
 * @param {number | null} width - Saved width in pixels or null to clear the custom width.
 * @returns {void}
 */
export function persistWorkspaceFocusCustomWidthPreference(width) {
  try {
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
      window.localStorage.setItem(COCKPIT_WORKSPACE_FOCUS_CUSTOM_WIDTH_KEY, String(Math.round(width)));
      return;
    }

    window.localStorage.removeItem(COCKPIT_WORKSPACE_FOCUS_CUSTOM_WIDTH_KEY);
  } catch (error) {
    logCockpitStorageWarning('persist-workspace-focus-custom-width', error);
  }
}

/**
 * @description Clamp a workspace-focus width to the current viewport.
 *
 * @param {number} width - Candidate width in pixels.
 * @param {number} viewportWidth - Current viewport width in pixels.
 * @returns {number} Width constrained to a usable cockpit range.
 */
export function clampWorkspaceFocusWidth(width, viewportWidth) {
  const maxWidth = Math.max(520, Math.round(viewportWidth - 24));
  const minWidth = Math.min(maxWidth, Math.max(520, Math.round(viewportWidth * 0.45)));
  return Math.min(Math.max(Math.round(width), minWidth), maxWidth);
}

/**
 * @description Derive the operator-facing workspace-focus toggle label.
 *
 * @param {boolean} isWide - Whether the preset stage is widened.
 * @param {number | null} customWidth - Persisted drag-resized width when present.
 * @returns {string} Button label for the workspace-focus width toggle.
 */
export function getWorkspaceFocusToggleLabel(isWide, customWidth) {
  if (typeof customWidth === 'number' && Number.isFinite(customWidth)) {
    return 'Reset Width';
  }

  return isWide ? 'Standard' : 'Wider';
}

/**
 * @description Derive the operator-facing workspace-focus toggle tooltip.
 *
 * @param {boolean} isWide - Whether the preset stage is widened.
 * @param {number | null} customWidth - Persisted drag-resized width when present.
 * @returns {string} Button tooltip for the workspace-focus width toggle.
 */
export function getWorkspaceFocusToggleTitle(isWide, customWidth) {
  if (typeof customWidth === 'number' && Number.isFinite(customWidth)) {
    return 'Reset the drag-resized workspace focus width';
  }

  return isWide
    ? 'Use the standard workspace-focus stage width'
    : 'Use the wider workspace-focus stage width';
}

/**
 * @description Convert a theme id into a readable operator-facing label.
 *
 * @param {string} theme - Theme id stored in the cockpit theme manager.
 * @returns {string} Human-readable label for toast/status use.
 */
export function formatThemeLabel(theme) {
  return String(theme || 'midnight')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * @description Persist the currently selected cockpit agent so reloads keep the same bot context.
 *
 * @param {string} agentId - Selected cockpit agent id.
 * @returns {void}
 */
export function persistSelectedAgentId(agentId) {
  const nextAgentId = typeof agentId === 'string' ? agentId.trim() : '';
  if (!nextAgentId) {
    return;
  }

  try {
    window.localStorage.setItem(COCKPIT_SELECTED_AGENT_STORAGE_KEY, nextAgentId);
  } catch (error) {
    logCockpitStorageWarning('persist-selected-agent-id', error);
  }
}

/**
 * @description Select one option from the bot selector with graceful fallback.
 *
 * @param {HTMLSelectElement} select - Bot selector element.
 * @param {string} preferredAgentId - Preferred selected agent id.
 * @returns {string} Resolved selected value.
 */
export function selectAgentOption(select, preferredAgentId) {
  const preferred = typeof preferredAgentId === 'string' ? preferredAgentId.trim() : '';
  const options = Array.from(select.options);
  if (!options.length) {
    return '';
  }

  if (preferred && options.some((option) => option.value === preferred)) {
    return preferred;
  }

  return options[0]?.value || '';
}

// Emit a structured warning when cockpit local UI persistence cannot be read or written.
function logCockpitStorageWarning(action, error) {
  const message = error instanceof Error ? error.message : String(error || 'unknown storage error');
  console.warn(JSON.stringify({
    level: 'warn',
    component: 'cockpit-app',
    action,
    event: 'local_storage_failure',
    message,
  }));
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added a lightweight cockpit embed bridge so the native /chat workspace can reflect cockpit-selected bot context without touching the oversized chat modal controller
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Rebound embedded chat agent/profile/tool requests to the cockpit-selected bot so settings and framework controls follow the active target bot
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Cleared stale embedded profile drafts and persisted cockpit-selected bot context into shared DOM/global state so bot switches update the real config workspace instead of only the footer label
 */

import { createUiLogger } from '../../shared/ui-debug.js';

const logger = createUiLogger('chat-cockpit-embed');
const COCKPIT_CONTEXT_EVENT = 'oshal-cockpit-context';
const COCKPIT_WORKSPACE_ACTION_EVENT = 'oshal-cockpit-workspace-action';
const DEFAULT_CHAT_AGENT_ID = '00000000-0000-4000-8000-000000000032';

let cockpitContext = readCockpitContextFromUrl();

const elements = {
  cockpitContextSummary: document.getElementById('cockpitContextSummary'),
};

/**
 * @description Initialize cockpit-specific context rendering for the embedded native chat workspace.
 */
function initializeCockpitEmbedBridge() {
  if (!isCockpitEmbedded()) {
    logger.debug('Skipping cockpit embed bridge because page is not embedded');
    return;
  }

  logger.info('Initializing cockpit embed bridge', {
    agentId: cockpitContext.agentId || null,
    agentLabel: cockpitContext.agentLabel || null,
  });
  installCockpitAgentFetchBridge();
  applyCockpitContext(cockpitContext);
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) {
      return;
    }

    if (!event.data) {
      return;
    }

    if (event.data.type === COCKPIT_CONTEXT_EVENT) {
      const previousAgentId = asNonEmptyString(cockpitContext.agentId);
      cockpitContext = {
        agentId: asNonEmptyString(event.data.agentId),
        agentLabel: asNonEmptyString(event.data.agentLabel),
      };
      logger.info('Received cockpit context update', {
        previousAgentId: previousAgentId || null,
        nextAgentId: cockpitContext.agentId || null,
      });
      applyCockpitContext(cockpitContext);
      if (previousAgentId !== cockpitContext.agentId) {
        resetAgentProfileDraftInputs();
      }
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new CustomEvent('oshal:tool-config-changed'));
      return;
    }

    if (event.data.type === COCKPIT_WORKSPACE_ACTION_EVENT) {
      logger.info('Received cockpit workspace action', {
        action: asNonEmptyString(event.data.action) || null,
      });
      runWorkspaceAction(asNonEmptyString(event.data.action));
    }
  });
}

/**
 * @description Detect whether the current chat route is embedded inside cockpit.
 * @returns {boolean} True when the current route is running in cockpit embed mode.
 */
function isCockpitEmbedded() {
  return document.documentElement.getAttribute('data-embedded') === 'cockpit';
}

/**
 * @description Read cockpit-selected bot context from the current URL.
 * @returns {{agentId: string, agentLabel: string}} Embedded cockpit context payload.
 */
function readCockpitContextFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return {
    agentId: asNonEmptyString(params.get('agentId')),
    agentLabel: asNonEmptyString(params.get('agentLabel')),
  };
}

/**
 * @description Render the current cockpit-selected bot context inside the native chat footer.
 * @param {{agentId?: string, agentLabel?: string}} context - Cockpit-selected bot context.
 */
function applyCockpitContext(context) {
  persistCockpitContext(context);

  if (!elements.cockpitContextSummary) {
    return;
  }

  const label = resolveCockpitLabel(context);
  elements.cockpitContextSummary.hidden = false;
  elements.cockpitContextSummary.innerHTML = `<span class="codicon codicon-person"></span>${escapeHtml(label)}`;
}

/**
 * @description Clear stale agent-profile draft inputs so the next embedded modal refresh
 * renders the newly selected cockpit bot instead of preserving the prior bot's draft text.
 */
function resetAgentProfileDraftInputs() {
  clearInputValue('#agentNameInput');
  clearInputValue('#projectUrlInput');
  clearInputValue('#selectorSkillsInput');
}

/**
 * @description Persist cockpit-selected bot context into shared DOM/global state so
 * the embedded native chat modules can resolve the active bot without direct imports.
 * @param {{agentId?: string, agentLabel?: string}} context - Cockpit-selected bot context.
 */
function persistCockpitContext(context) {
  const root = document.documentElement;
  const nextAgentId = asNonEmptyString(context?.agentId);
  const nextAgentLabel = asNonEmptyString(context?.agentLabel);

  root.dataset.cockpitAgentId = nextAgentId;
  root.dataset.cockpitAgentLabel = nextAgentLabel;
  window.__oshalCockpitEmbedContext = {
    agentId: nextAgentId,
    agentLabel: nextAgentLabel,
  };
}

/**
 * @description Rebind embedded chat agent-scoped API calls to the cockpit-selected bot.
 * This avoids editing the oversized chat modal controller while still letting
 * the embedded chat settings/tools surface follow the active cockpit target bot.
 */
function installCockpitAgentFetchBridge() {
  const originalFetch = window.fetch.bind(window);
  const bridgedFetch = (input, init) => originalFetch(rewriteAgentScopedRequest(input), init);
  window.fetch = bridgedFetch;
  globalThis.fetch = bridgedFetch;
}

/**
 * @description Rewrite agent-scoped API requests from the default chat agent to the cockpit-selected bot.
 * @param {RequestInfo | URL} input - Original fetch input.
 * @returns {RequestInfo | URL} Rewritten fetch input when a cockpit-selected bot is active.
 */
function rewriteAgentScopedRequest(input) {
  const selectedAgentId = asNonEmptyString(cockpitContext.agentId);
  if (!selectedAgentId || selectedAgentId === 'assistant') {
    return input;
  }

  if (typeof input === 'string') {
    return rewriteAgentScopedUrl(input, selectedAgentId);
  }

  if (input instanceof URL) {
    return new URL(rewriteAgentScopedUrl(input.toString(), selectedAgentId));
  }

  if (input instanceof Request) {
    const rewrittenUrl = rewriteAgentScopedUrl(input.url, selectedAgentId);
    if (rewrittenUrl === input.url) {
      return input;
    }

    return new Request(rewrittenUrl, input);
  }

  return input;
}

/**
 * @description Swap the default chat agent id in known agent-scoped routes for the cockpit-selected bot id.
 * @param {string} urlValue - Original URL value.
 * @param {string} selectedAgentId - Cockpit-selected bot id.
 * @returns {string} Rewritten URL.
 */
function rewriteAgentScopedUrl(urlValue, selectedAgentId) {
  return urlValue.replace(
    `/api/agents/${DEFAULT_CHAT_AGENT_ID}/`,
    `/api/agents/${encodeURIComponent(selectedAgentId)}/`,
  );
}

/**
 * @description Execute one cockpit workspace action from inside the embedded native chat frame.
 * @param {string} action - Requested cockpit workspace action.
 */
function runWorkspaceAction(action) {
  if (action === 'settings') {
    clickElement('#openToolsConfigBtn');
    return;
  }

  if (action === 'tools') {
    clickElement('#openToolsConfigBtn');
    window.setTimeout(() => clickElement('[data-config-section="tools"]'), 50);
    return;
  }

  if (action === 'history') {
    clickElement('#openHistoryModalBtn');
    return;
  }

  if (action === 'rag') {
    if (clickElement('#openRagModalBtn')) {
      return;
    }
    clickElement('#openToolsConfigBtn');
    window.setTimeout(() => clickElement('[data-config-section="tools"]'), 50);
    return;
  }

}

/**
 * @description Click one DOM element inside the embedded native chat frame when it exists.
 * @param {string} selector - Target selector in the native chat DOM.
 * @returns {boolean} True when the element existed and received a click event.
 */
function clickElement(selector) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
}

/**
 * @description Clear one text-like input when it exists inside the embedded native chat DOM.
 * @param {string} selector - Input selector to clear.
 */
function clearInputValue(selector) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return;
  }

  element.value = '';
}

/**
 * @description Build a human-readable cockpit context label without claiming the runtime agent changed.
 * @param {{agentId?: string, agentLabel?: string}} context - Cockpit-selected bot context.
 * @returns {string} Human-readable cockpit selection label.
 */
function resolveCockpitLabel(context) {
  const selectedLabel = asNonEmptyString(context.agentLabel);
  const selectedId = asNonEmptyString(context.agentId);
  const selection = selectedLabel || selectedId || 'Personal Assistant';
  return `Cockpit selection: ${selection}`;
}

/**
 * @description Normalize possibly-empty strings into useful display text.
 * @param {unknown} value - Unknown value to normalize.
 * @returns {string} Trimmed string or empty string.
 */
function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

/**
 * @description Escape text before writing it into the cockpit-context summary element.
 * @param {string} value - Raw display text.
 * @returns {string} HTML-escaped display text.
 */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

initializeCockpitEmbedBridge();

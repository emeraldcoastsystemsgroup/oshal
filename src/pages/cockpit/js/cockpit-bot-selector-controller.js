/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit live-bot selector orchestration from app.js to enforce file and function governance while preserving runtime-registry filtering behavior
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | setAllowedAgentIds() — when a swarm app is focused, narrow the selector to only that app's declared bots so the chat shows the app's own swarm, not the whole fleet. Falls back to the full live list if the allow-list would leave the selector empty (app bot offline), so the operator is never stranded.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Replaced setAllowedAgentIds(live-filter) with setAppBots([{agentId,name}]) — render the focused app's OWN declared bots directly (no live-heartbeat dependency). App chat bots run inline on chat (like codex-packer) so they need not be Redis-live to be selectable; this stops every app from collapsing back to the comms bot when its dedicated inline bot has no container heartbeat.
 */

import {
  getSelectedBotLabel,
  persistSelectedAgentId,
  readPreferredSelectedAgentId,
  selectAgentOption,
} from './cockpit-persistence.js';

/**
 * @description Manage cockpit bot-selector hydration against the live swarm registry,
 * persisted selection restoration, and operator-triggered refresh behavior.
 */
export class CockpitBotSelectorController {
  /**
   * @description Create a bot-selector controller with the runtime API client and
   * shell callbacks needed to keep the embedded rail aligned with the selected bot.
   *
   * @param {{
   *   api: { getLiveAgents: () => Promise<Array<Record<string, unknown>>> },
   *   showToast: (message: string, type?: string) => void,
   *   onSelectionChange?: (agentId: string) => void,
   * }} options - Runtime collaborators for selector hydration.
   * @returns {void}
   */
  constructor(options) {
    this.api = options.api;
    this.showToast = options.showToast;
    this.onSelectionChange = options.onSelectionChange;
    /** When non-empty, the selector renders EXACTLY these bots (the focused app's
     *  own declared bots, {agentId,name}) instead of the live swarm fleet. App
     *  bots run inline on chat, so they need not be Redis-live to be selectable.
     *  Empty = show the full live fleet (framework default cockpit). */
    this.appBots = [];
  }

  /**
   * @description Pin the selector to a focused app's own bots. Pass the app's
   * declared bots [{agentId, name}]; pass an empty array (or nothing) to clear the
   * pin and return to the live-fleet behavior.
   * @param {Array<{agentId:string,name:string}>} bots - The app's declared bots.
   * @returns {void}
   */
  setAppBots(bots) {
    this.appBots = Array.isArray(bots)
      ? bots
          .map((b) => ({ agentId: String(b?.agentId || '').trim(), name: String(b?.name || b?.agentId || '').trim() }))
          .filter((b) => b.agentId)
      : [];
  }

  /**
   * @description Bind cockpit selector focus and change behavior once the shell DOM exists.
   *
   * @returns {void}
   */
  bindSelectorEvents() {
    const botSelector = document.getElementById('botSelector');
    if (!(botSelector instanceof HTMLSelectElement)) {
      return;
    }

    botSelector.addEventListener('focus', () => {
      void this.loadBots({ preserveCurrentSelection: true, suppressOfflineToast: true });
    });
    botSelector.addEventListener('change', () => {
      this.applySelectedAgentId(botSelector.value || '');
    });
  }

  /**
   * @description Load live-selectable bots into the cockpit selector and keep the
   * embedded rail pointed at the surviving selected bot when runtime availability changes.
   *
   * @param {{ preserveCurrentSelection?: boolean, suppressOfflineToast?: boolean }} [options] - Hydration options.
   * @returns {Promise<void>} Resolves when selector state is refreshed.
   */
  async loadBots(options = {}) {
    // App focused: render its own declared bots directly (they execute inline on
    // chat, so they need not be in the live heartbeat list). No network fetch.
    if (this.appBots.length) {
      this.hydrateSelector(this.appBots, options);
      return;
    }
    try {
      const agents = await this.api.getLiveAgents();
      this.hydrateSelector(agents, options);
    } catch (error) {
      this.logWarning('load-bots', error, {
        message: 'Failed to hydrate cockpit bot selector from the live swarm registry',
      });
      this.restorePersistedSelection();
    }
  }

  /**
   * @description Apply one explicit selected bot id when a cockpit action wants to
   * move the embedded rail onto a specific live bot lane.
   *
   * @param {string} agentId - Preferred agent id to select when present in the dropdown.
   * @returns {string} Selected agent id that remains active after the request.
   */
  selectAgent(agentId) {
    const select = document.getElementById('botSelector');
    if (!(select instanceof HTMLSelectElement)) {
      return '';
    }

    const preferredAgentId = typeof agentId === 'string' ? agentId.trim() : '';
    const hasPreferredOption = Array.from(select.options).some((option) => option.value === preferredAgentId);
    if (!preferredAgentId || !hasPreferredOption) {
      return (select.value || '').trim();
    }

    select.value = preferredAgentId;
    return this.applySelectedAgentId(preferredAgentId);
  }

  /**
   * @description Persist one selected agent id and notify the cockpit rail controller.
   *
   * @param {string} agentId - Selected cockpit agent id.
   * @returns {string} Normalized selected agent id.
   */
  applySelectedAgentId(agentId) {
    const nextAgentId = typeof agentId === 'string' ? agentId.trim() : '';
    if (nextAgentId) {
      persistSelectedAgentId(nextAgentId);
    }
    this.onSelectionChange?.(nextAgentId);
    return nextAgentId;
  }

  // Hydrate the selector options and restore the preferred live bot when possible.
  hydrateSelector(agents, options = {}) {
    const select = document.getElementById('botSelector');
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }

    const currentAgentId = options.preserveCurrentSelection ? (select.value || '').trim() : '';
    const preferredAgentId = currentAgentId || readPreferredSelectedAgentId();
    const seenAgentIds = new Set();
    select.innerHTML = '';

    agents.forEach((agent) => {
      const agentId = String(agent?.agentId || agent?.agent_id || '').trim();
      const label = String(agent?.name || agent?.agentName || agentId).trim();
      if (!agentId || seenAgentIds.has(agentId)) {
        return;
      }

      const option = document.createElement('option');
      option.value = agentId;
      option.textContent = label;
      select.appendChild(option);
      seenAgentIds.add(agentId);
    });

    if (!seenAgentIds.size) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Choose a bot';
      select.appendChild(option);
    }

    const selectedAgentId = selectAgentOption(select, preferredAgentId);
    select.value = selectedAgentId;
    this.maybeShowOfflineToast(preferredAgentId, selectedAgentId, options.suppressOfflineToast === true);
    this.applySelectedAgentId(selectedAgentId);
  }

  // Restore the last persisted selector state when the live-registry fetch fails.
  restorePersistedSelection() {
    const select = document.getElementById('botSelector');
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }

    const selectedAgentId = selectAgentOption(select, readPreferredSelectedAgentId());
    select.value = selectedAgentId;
    this.applySelectedAgentId(selectedAgentId);
  }

  // Surface an operator-facing notice when the previous selection is no longer live.
  maybeShowOfflineToast(preferredAgentId, selectedAgentId, suppressOfflineToast) {
    if (suppressOfflineToast || !preferredAgentId || !selectedAgentId || preferredAgentId === selectedAgentId) {
      return;
    }

    const selectedLabel = getSelectedBotLabel();
    this.showToast(`Previously selected bot is not live. Switched to ${selectedLabel || selectedAgentId}.`, 'info');
  }

  // Emit structured selector warnings so runtime hydration failures are traceable.
  logWarning(action, error, context = {}) {
    console.warn(JSON.stringify({
      level: 'warn',
      component: 'cockpit-bot-selector-controller',
      action,
      error: error instanceof Error ? error.message : String(error),
      ...context,
    }));
  }
}
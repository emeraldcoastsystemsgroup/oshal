/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added a cockpit controller that embeds the real OSHAL chat workspace in the right rail instead of the legacy placeholder shell
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added cockpit-to-iframe context sync so the embedded native chat surface can reflect the currently selected cockpit bot
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added cockpit-level workspace action routing so settings, switch framework, history, RAG, and Presentron are reachable directly from the right rail
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added cockpit-owned embedded history restore handling so conversation loads stay inside the right rail with selected-bot context preserved
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Rebound bot switches to bot-scoped embedded chat sessions so changing the cockpit selector reloads the rail onto the selected bot instead of preserving the prior task
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Switched cockpit to a dedicated /swarmbot/chat workspace so swarm-enabled bots use a bot-scoped rail UI instead of the standalone chat app
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Hardened cockpit workspace-action delivery retries so the first heavy-tool launch does not race the embedded swarm workspace bootstrap
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Avoided redundant iframe reload when the embedded swarmbot workspace reports its first generated task id during bootstrap
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Synced cockpit theme changes into the embedded swarmbot frame so the right rail stays visually aligned with the shell
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Added an explicit enable gate so immersive apps never boot or mutate a hidden chat workspace.
 */

const COCKPIT_NATIVE_CHAT_TASK_KEY = 'cockpit-native-chat-taskId';
const COCKPIT_CONTEXT_EVENT = 'oshal-cockpit-context';
const COCKPIT_WORKSPACE_ACTION_EVENT = 'oshal-cockpit-workspace-action';
const COCKPIT_WORKSPACE_ACTION_ACK_EVENT = 'oshal-cockpit-workspace-action-ack';
const COCKPIT_WORKSPACE_READY_EVENT = 'oshal-cockpit-workspace-ready';
const COCKPIT_LOAD_TASK_EVENT = 'oshal-cockpit-load-task';
const COCKPIT_THEME_EVENT = 'oshal-cockpit-theme';

/**
 * @description Controller for the cockpit right-side embedded swarm bot workspace.
 * Reuses the dedicated `/swarmbot/chat` page in an iframe and keeps lightweight
 * cockpit-level navigation state for restoring task history and opening fresh sessions.
 */
export class CockpitEmbeddedChatPanelController {
  /**
   * @description Create an embedded native chat controller for the cockpit rail.
   * @param {object} deps - Runtime dependencies from the cockpit root shell.
   * @param {() => string} deps.getSelectedAgentId - Lazy getter for the current cockpit bot selector value.
   * @param {() => string} deps.getSelectedAgentLabel - Lazy getter for the current cockpit bot selector label.
   * @param {() => string} [deps.getCurrentTheme] - Lazy getter for the current cockpit theme id.
   * @param {string} [deps.frameId] - DOM id of the embedded chat iframe.
   */
  constructor(deps) {
    this.getSelectedAgentId = deps.getSelectedAgentId;
    this.getSelectedAgentLabel = deps.getSelectedAgentLabel;
    this.getCurrentTheme = deps.getCurrentTheme;
    this.frameId = deps.frameId || 'chatWorkspaceFrame';
    this.currentTaskId = null;
    this.currentAgentId = '';
    this.enabled = true;
    this.pendingWorkspaceAction = null;
    this._handleWindowMessage = this._handleWindowMessage.bind(this);
    this._bindFrameLoadSync();
    this._bindWindowMessageSync();
  }

  /**
 * @description Signal that this controller is backed by the real swarm bot workspace.
   * @returns {boolean} Always true for the embedded native chat controller.
   */
  supportsNativeWorkspace() {
    return true;
  }

  /**
   * @description Signal that the cockpit right rail should stay visible on load.
   * @returns {boolean} Always true so humans can immediately use the real chat workspace.
   */
  prefersVisibleOnLoad() {
    return true;
  }

  /**
   * @description Enable or suspend the embedded workspace. Suspension unloads
   * the frame and blocks every later navigation until the shell enables it.
   * @param {boolean} enabled - Whether chat navigation is allowed.
   * @returns {boolean} The normalized enabled state.
   */
  setEnabled(enabled) {
    this.enabled = enabled === true;
    const frame = this._getFrame();
    if (!this.enabled && frame?.getAttribute('src') !== 'about:blank') {
      frame.setAttribute('src', 'about:blank');
    }
    return this.enabled;
  }

  /**
   * @description Restore the last selected cockpit chat task into the embedded workspace.
   * @returns {Promise<void>} Resolves after the iframe src has been updated.
   */
  async restoreSession() {
    if (!this.enabled) return;
    const selectedAgentId = this.getSelectedAgentId();
    this.currentAgentId = selectedAgentId;
    const savedTaskId = readSavedNativeChatTaskId(selectedAgentId);
    if (savedTaskId) {
      await this.loadTask(savedTaskId);
      return;
    }

    this.newChat();
  }

  /**
   * @description Load one historical task into the embedded native chat workspace.
   * @param {string} taskId - Persisted task identifier.
   * @returns {Promise<void>} Resolves after the iframe src has been updated.
   */
  async loadTask(taskId) {
    this.currentTaskId = taskId;
    saveNativeChatTaskId(this.getSelectedAgentId(), taskId);
    this._navigate({ taskId });
  }

  /**
   * @description Reset the embedded chat workspace to a fresh task session.
   */
  newChat() {
    this.currentTaskId = null;
    clearSavedNativeChatTaskId(this.getSelectedAgentId());
    this._navigate({ freshNonce: Date.now().toString(36) });
  }

  /**
 * @description Focus the embedded swarm bot iframe for keyboard interaction.
   */
  focus() {
    this._getFrame()?.focus();
  }

  /**
   * @description Update the selected agent id used for deep links and future chat reloads.
   * @param {string} agentId - Currently selected cockpit agent identifier.
   */
  setSelectedAgentId(agentId) {
    const frame = this._getFrame();
    if (!frame) {
      return;
    }

    const nextAgentId = typeof agentId === 'string' ? agentId.trim() : '';
    const previousAgentId = this.currentAgentId;
    this.currentAgentId = nextAgentId;
    frame.dataset.selectedAgentId = nextAgentId;
    frame.dataset.selectedAgentLabel = this.getSelectedAgentLabel();

    if (!this.enabled) return;

    if (previousAgentId && previousAgentId !== nextAgentId) {
      this._restoreSelectedAgentWorkspace();
      return;
    }

    this._postContext(frame);
    this._postTheme(frame);
  }

  /**
   * @description Restore the selected bot's last cockpit chat session or start a fresh one
   * when the operator changes the bot selector in the cockpit shell.
   */
  _restoreSelectedAgentWorkspace() {
    const savedTaskId = readSavedNativeChatTaskId(this.currentAgentId);
    if (savedTaskId) {
      void this.loadTask(savedTaskId);
      return;
    }

    this.newChat();
  }

  /**
 * @description Build and navigate the embedded iframe to the correct swarm bot route.
   * @param {object} options - Navigation options for the embedded workspace.
   * @param {string} [options.taskId] - Historical task id to hydrate in the native chat workspace.
   * @param {string} [options.freshNonce] - Cache-busting fresh-session nonce.
   */
  _navigate(options = {}) {
    if (!this.enabled) return;
    const frame = this._getFrame();
    if (!frame) {
      return;
    }

    const params = new URLSearchParams();
    params.set('embed', 'cockpit');

    if (options.taskId) {
      params.set('taskId', options.taskId);
    }

    const selectedAgentId = this.getSelectedAgentId();
    if (selectedAgentId) {
      params.set('agentId', selectedAgentId);
    }

    const selectedAgentLabel = this.getSelectedAgentLabel();
    if (selectedAgentLabel) {
      params.set('agentLabel', selectedAgentLabel);
    }

    const currentTheme = readNonEmptyString(this.getCurrentTheme?.());
    if (currentTheme) {
      params.set('theme', currentTheme);
    }

    if (options.freshNonce) {
      params.set('fresh', options.freshNonce);
    }

    const nextSrc = `/swarmbot/chat?${params.toString()}`;
    frame.setAttribute('src', nextSrc);
  }

  /**
 * @description Resolve the embedded swarm bot iframe from the current DOM.
 * @returns {HTMLIFrameElement | null} Embedded swarm bot iframe when mounted.
   */
  _getFrame() {
    const frame = document.getElementById(this.frameId);
    return frame instanceof HTMLIFrameElement ? frame : null;
  }

  /**
 * @description Sync cockpit-selected bot context into the embedded swarm bot frame after each load.
   */
  _bindFrameLoadSync() {
    const frame = this._getFrame();
    if (!frame) {
      return;
    }

    frame.addEventListener('load', () => {
      this._postContext(frame);
      this._postTheme(frame);
      if (this.pendingWorkspaceAction) {
        this._dispatchWorkspaceAction(frame, this.pendingWorkspaceAction);
      }
    });
  }

  /**
 * @description Listen for embedded swarm bot requests that should be promoted to cockpit-owned navigation state.
   */
  _bindWindowMessageSync() {
    window.addEventListener('message', this._handleWindowMessage);
  }

  /**
 * @description Handle postMessage events emitted from the embedded swarm bot frame.
   * @param {MessageEvent} event - Browser message event.
   */
  _handleWindowMessage(event) {
    if (event.origin !== window.location.origin || !event.data) {
      return;
    }

    if (event.data.type !== COCKPIT_LOAD_TASK_EVENT) {
      if (event.data.type === COCKPIT_WORKSPACE_ACTION_ACK_EVENT) {
        const acknowledgedAction = typeof event.data.action === 'string' ? event.data.action.trim() : '';
        if (!this.pendingWorkspaceAction || !acknowledgedAction || acknowledgedAction === this.pendingWorkspaceAction) {
          this.pendingWorkspaceAction = null;
        }
      } else if (event.data.type === COCKPIT_WORKSPACE_READY_EVENT && this.pendingWorkspaceAction) {
        const frame = this._getFrame();
        if (frame) {
          this._dispatchWorkspaceAction(frame, this.pendingWorkspaceAction);
        }
      }
      return;
    }

    const taskId = typeof event.data.taskId === 'string' ? event.data.taskId.trim() : '';
    if (!taskId) {
      return;
    }

    const isInitialBootstrapTask = !this.currentTaskId;
    this.currentTaskId = taskId;
    saveNativeChatTaskId(this.getSelectedAgentId(), taskId);

    if (isInitialBootstrapTask) {
      return;
    }

    void this.loadTask(taskId);
  }

  /**
 * @description Post the current cockpit-selected bot context into the embedded swarm bot frame.
 * @param {HTMLIFrameElement} frame - Embedded swarm bot iframe.
   */
  _postContext(frame) {
    frame.contentWindow?.postMessage(
      {
        type: COCKPIT_CONTEXT_EVENT,
        agentId: this.getSelectedAgentId(),
        agentLabel: this.getSelectedAgentLabel(),
      },
      window.location.origin,
    );
  }

  /**
 * @description Post the current cockpit theme into the embedded swarm bot frame.
 * @param {HTMLIFrameElement} frame - Embedded swarm bot iframe.
   */
  _postTheme(frame) {
    const theme = readNonEmptyString(this.getCurrentTheme?.());
    if (!theme) {
      return;
    }

    frame.contentWindow?.postMessage(
      {
        type: COCKPIT_THEME_EVENT,
        theme,
      },
      window.location.origin,
    );
  }

  /**
 * @description Open one swarm bot workspace action from the cockpit shell.
   * @param {'settings'|'tools'|'history'|'rag'} action - Workspace action to trigger inside the embedded native chat frame.
   */
  openWorkspaceAction(action) {
    const frame = this._getFrame();
    if (!frame) {
      return;
    }

    const normalizedAction = typeof action === 'string' ? action.trim() : '';
    if (!normalizedAction) {
      return;
    }

    this.pendingWorkspaceAction = normalizedAction;
    this._dispatchWorkspaceAction(frame, normalizedAction);
  }

  /**
 * @description Push one cockpit theme update into the embedded swarm bot frame immediately.
 * @param {string} theme - Cockpit theme identifier.
   */
  syncTheme(theme) {
    const frame = this._getFrame();
    if (!frame) {
      return;
    }

    const nextTheme = readNonEmptyString(theme) || readNonEmptyString(this.getCurrentTheme?.());
    if (!nextTheme) {
      return;
    }

    frame.contentWindow?.postMessage(
      {
        type: COCKPIT_THEME_EVENT,
        theme: nextTheme,
      },
      window.location.origin,
    );
  }

  /**
 * @description Dispatch a cockpit workspace action into the embedded frame with short retries
 * so actions triggered during iframe reloads are not dropped.
 * @param {HTMLIFrameElement} frame - Embedded swarm bot iframe.
 * @param {string} action - Workspace action to dispatch.
   */
  _dispatchWorkspaceAction(frame, action) {
    const payload = { type: COCKPIT_WORKSPACE_ACTION_EVENT, action };
    scheduleWorkspaceActionPosts(frame, payload, () => this.pendingWorkspaceAction === action);
  }
}

/**
 * @description Post one cockpit workspace action repeatedly while the embedded workspace is still acknowledging bootstrap.
 * @param {HTMLIFrameElement} frame - Embedded swarm bot iframe.
 * @param {{ type: string, action: string }} payload - Workspace action postMessage payload.
 * @param {() => boolean} shouldContinue - Predicate that stays true while the action is still pending.
 */
function scheduleWorkspaceActionPosts(frame, payload, shouldContinue) {
  const retryScheduleMs = [0, 120, 320, 700, 1200];
  retryScheduleMs.forEach((delayMs) => {
    window.setTimeout(() => {
      if (!shouldContinue()) {
        return;
      }

      frame.contentWindow?.postMessage(payload, window.location.origin);
    }, delayMs);
  });
}

/**
 * @description Persist the active embedded cockpit chat task id for later restoration.
 * @param {string} taskId - Active task identifier.
 */
function saveNativeChatTaskId(agentId, taskId) {
  try {
    sessionStorage.setItem(buildNativeChatTaskStorageKey(agentId), taskId);
  } catch (error) {
    console.warn('[CockpitEmbeddedChatPanelController] Failed to persist task id', error);
  }
}

/**
 * @description Read the saved embedded cockpit chat task id from session storage.
 * @returns {string | null} Persisted task identifier when one exists.
 */
function readSavedNativeChatTaskId(agentId) {
  try {
    return sessionStorage.getItem(buildNativeChatTaskStorageKey(agentId));
  } catch (error) {
    console.warn('[CockpitEmbeddedChatPanelController] Failed to read saved task id', error);
    return null;
  }
}

/**
 * @description Clear the embedded cockpit chat task id from session storage.
 */
function clearSavedNativeChatTaskId(agentId) {
  try {
    sessionStorage.removeItem(buildNativeChatTaskStorageKey(agentId));
  } catch (error) {
    console.warn('[CockpitEmbeddedChatPanelController] Failed to clear saved task id', error);
  }
}

/**
 * @description Build a bot-scoped session-storage key for the embedded cockpit rail.
 * @param {string} agentId - Selected cockpit bot identifier.
 * @returns {string} Stable per-bot storage key.
 */
function buildNativeChatTaskStorageKey(agentId) {
  const normalizedAgentId = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'default';
  return `${COCKPIT_NATIVE_CHAT_TASK_KEY}:${normalizedAgentId}`;
}

function readNonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @description Click a button inside the embedded native chat frame when it exists.
 * @param {Document} documentRef - Embedded chat document.
 * @param {string} selector - Button selector inside the embedded chat DOM.
 * @returns {boolean} True when a matching element was found and clicked.
 */

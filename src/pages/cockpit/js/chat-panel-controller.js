/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit right-rail chat session, message send/load, and rendering behavior from app.js for Session 74 chat consolidation
 */

const DASHBOARD_TASK_KEY = 'cockpit-dashboard-taskId';

/**
 * @description Controller for the cockpit right-side chat panel.
 * Owns task session storage, send/load/new-chat behavior, and message rendering
 * so cockpit can consolidate toward the native chat model without keeping all
 * chat logic embedded in the root app shell.
 */
export class CockpitChatPanelController {
  /**
   * @description Create a right-rail chat controller with the runtime dependencies it needs.
   * @param {object} deps - Runtime dependencies supplied by the cockpit root.
   * @param {import('./api-client.js').ApiClient} deps.api - Cockpit API client.
   * @param {unknown} deps.messageRenderer - Legacy message renderer instance used by the cockpit panel.
   * @param {() => any} deps.getStreamingClient - Lazy getter for the active streaming client.
   * @param {() => boolean} deps.getAutoApprove - Lazy getter for the current auto-approve setting.
   * @param {() => boolean} deps.getTestMode - Lazy getter for the current test-mode flag.
   */
  constructor(deps) {
    this.api = deps.api;
    this.messageRenderer = deps.messageRenderer || null;
    this.getStreamingClient = deps.getStreamingClient;
    this.getAutoApprove = deps.getAutoApprove;
    this.getTestMode = deps.getTestMode;
    this.currentTaskId = null;
    this.currentTask = null;
    this.isProcessing = false;
    this.renderedMessageTimestamps = new Set();
  }

  /**
   * @description Restore the previously selected cockpit task when one was saved in session storage.
   * @returns {Promise<void>}
   */
  async restoreSession() {
    const savedTaskId = loadDashboardTaskId();
    if (!savedTaskId) {
      return;
    }

    try {
      await this.loadTask(savedTaskId);
    } catch (error) {
      console.warn('[CockpitChatPanelController] Failed to restore saved task', error);
      clearDashboardTaskId();
    }
  }

  /**
   * @description Send the current right-rail message through the OSHAL task/message APIs.
   * @param {object} options - Runtime send options.
   * @param {string} options.targetBot - Selected bot id from the cockpit chat toolbar.
   * @returns {Promise<void>}
   */
  async sendMessage(options = {}) {
    if (this.isProcessing) {
      return;
    }

    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    const text = input?.value.trim();
    if (!text || !input || !sendBtn) {
      return;
    }

    const streamingClient = this.getStreamingClient();
    if (streamingClient) {
      streamingClient.resetTaskMetrics();
    }

    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;

    const welcome = document.querySelector('.chat-welcome');
    if (welcome) {
      welcome.remove();
    }

    this.addRenderedMessage({ ts: String(Date.now()), type: 'say', say: 'user_feedback', text });
    this.showTypingIndicator();
    this.isProcessing = true;

    try {
      if (!this.currentTaskId) {
        clearDashboardTaskId();
        const selectedAgentId = options.targetBot || 'assistant';
        const taskData = await this.api.createTask(text, 'act', {
          agentId: selectedAgentId !== 'assistant' ? selectedAgentId : undefined,
          source: 'dashboard',
          targetBot: selectedAgentId,
        });
        this.currentTask = taskData.task || null;
        this.currentTaskId = this.currentTask?.id || taskData.taskId || taskData.id || null;
        if (this.currentTaskId) {
          saveDashboardTaskId(this.currentTaskId);
        }
        if (streamingClient) {
          streamingClient.currentTaskId = this.currentTaskId;
        }
      }

      await this.api.sendMessage(this.currentTaskId, text, {
        autoApprove: this.getAutoApprove(),
        source: 'dashboard',
        targetBot: options.targetBot || 'assistant',
      });
      this.markIdle();
    } catch (error) {
      this.addRenderedMessage({
        ts: String(Date.now()),
        type: 'say',
        say: 'error',
        text: `Error: ${error.message}`,
      });
      this.markIdle();
    }
  }

  /**
   * @description Load one existing task and render its historical messages into the right rail.
   * @param {string} taskId - Task identifier to load.
   * @returns {Promise<void>}
   */
  async loadTask(taskId) {
    const data = await this.api.getTask(taskId);
    if (!data.success || !data.task) {
      this._clearTaskState();
      this.newChat();
      return;
    }

    const container = document.getElementById('chatMessages');
    if (container) {
      container.innerHTML = '';
    }

    this.currentTask = data.task;
    this.currentTaskId = taskId;
    saveDashboardTaskId(taskId);

    const streamingClient = this.getStreamingClient();
    if (streamingClient) {
      streamingClient.currentTaskId = taskId;
    }

    if (data.task.messages?.length) {
      this.renderedMessageTimestamps.clear();
      for (const message of data.task.messages) {
        this.renderHistoricalMessage(message);
      }
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }

  /**
   * @description Start a fresh cockpit chat session and restore the welcome state.
   */
  newChat() {
    this._clearTaskState();
    this.isProcessing = false;
    const streamingClient = this.getStreamingClient();
    if (streamingClient) {
      streamingClient.resetTaskMetrics();
    }

    const container = document.getElementById('chatMessages');
    if (!container) {
      return;
    }

    container.innerHTML = buildWelcomeMarkup();
    container.querySelectorAll('.quick-action').forEach((button) => {
      button.addEventListener('click', () => {
        const input = document.getElementById('chatInput');
        const sendBtn = document.getElementById('sendBtn');
        if (input) {
          input.value = button.dataset.msg || '';
        }
        if (sendBtn) {
          sendBtn.disabled = false;
        }
        this.sendMessage({
          targetBot: document.getElementById('botSelector')?.value || 'assistant',
        });
      });
    });
  }

  /**
   * @description Render one streaming or historical message into the cockpit right rail.
   * @param {object} message - Message payload in the cockpit/message-renderer shape.
   * @param {object} [options] - Render options.
   * @param {boolean} [options.testMode] - Whether to label the assistant as the mock bot.
   */
  addRenderedMessage(message, options = {}) {
    const container = document.getElementById('chatMessages');
    if (!container) {
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'chat-message bot rendered-message';

    const sender = document.createElement('span');
    sender.className = 'msg-sender';
    const isUser = message.say === 'user_feedback';
    sender.innerHTML = isUser
      ? 'You'
      : (options.testMode || this.getTestMode()
        ? '<i class="ph ph-flask"></i> Mock Bot'
        : '<i class="ph ph-robot"></i> Assistant');
    wrapper.appendChild(sender);

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble rendered-bubble';

    if (this.messageRenderer) {
      const rendered = this.messageRenderer.render(message, {
        isLast: false,
        isExpanded: false,
        onToggleExpand: (id, expanded) => {
          this.messageRenderer.setExpanded(id, expanded);
        },
      });
      if (rendered) {
        bubble.appendChild(rendered);
      }
    } else {
      bubble.textContent = message.text || '';
    }

    wrapper.appendChild(bubble);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  /**
   * @description Show the right-rail typing indicator while a request is in flight.
   */
  showTypingIndicator() {
    const container = document.getElementById('chatMessages');
    if (!container) {
      return;
    }

    const indicator = document.createElement('div');
    indicator.className = 'chat-message bot';
    indicator.id = 'typingIndicator';
    indicator.innerHTML = `<span class="msg-sender"><i class="ph ph-robot"></i> Assistant</span><div class="typing-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
    container.appendChild(indicator);
    container.scrollTop = container.scrollHeight;
  }

  /**
   * @description Remove the right-rail typing indicator when a response resolves.
   */
  hideTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
      indicator.remove();
    }
  }

  /**
   * @description Mark the right-rail chat request cycle as complete and clear transient UI state.
   */
  markIdle() {
    this.hideTypingIndicator();
    this.isProcessing = false;
  }

  /**
   * @description Reset the current task state and sync the streaming client with the cleared task selection.
   */
  _clearTaskState() {
    clearDashboardTaskId();
    this.currentTaskId = null;
    this.currentTask = null;
    this.renderedMessageTimestamps.clear();
    const streamingClient = this.getStreamingClient();
    if (streamingClient) {
      streamingClient.currentTaskId = null;
    }
  }

  /**
   * @description Render one persisted task message into the cockpit right rail.
   * @param {object} message - Persisted task message payload.
   */
  renderHistoricalMessage(message) {
    if (!this.messageRenderer) {
      return;
    }

    const container = document.getElementById('chatMessages');
    if (!container) {
      return;
    }

    const rendered = this.messageRenderer.render(message, {
      isExpanded: false,
      onToggleExpand: () => {},
    });
    if (rendered) {
      container.appendChild(rendered);
    }
  }
}

/**
 * @description Build the welcome-state markup for a fresh cockpit chat session.
 * @returns {string} Welcome-state HTML.
 */
function buildWelcomeMarkup() {
  return `<div class="chat-welcome">
    <div class="welcome-icon"><i class="ph ph-robot"></i></div>
    <h3>Hi! I'm your AI assistant.</h3>
    <p>Tell me what you'd like to build, fix, or explore.</p>
    <div class="quick-actions">
      <button class="quick-action" data-msg="What tickets are currently in progress?"><i class="ph ph-list-checks"></i> Active tickets</button>
      <button class="quick-action" data-msg="Show me the cost summary for today"><i class="ph ph-currency-dollar"></i> Today's costs</button>
      <button class="quick-action" data-msg="Which bots are available right now?"><i class="ph ph-robot"></i> Available bots</button>
    </div>
  </div>`;
}

/**
 * @description Save the active cockpit task id to session storage.
 * @param {string} taskId - Task identifier to persist.
 */
function saveDashboardTaskId(taskId) {
  try {
    sessionStorage.setItem(DASHBOARD_TASK_KEY, taskId);
  } catch (error) {
    console.warn('[CockpitChatPanelController] Failed to persist task id', error);
  }
}

/**
 * @description Read the saved cockpit task id from session storage.
 * @returns {string|null} Persisted task id or null.
 */
function loadDashboardTaskId() {
  try {
    return sessionStorage.getItem(DASHBOARD_TASK_KEY);
  } catch (error) {
    console.warn('[CockpitChatPanelController] Failed to read saved task id', error);
    return null;
  }
}

/**
 * @description Clear the saved cockpit task id from session storage.
 */
function clearDashboardTaskId() {
  try {
    sessionStorage.removeItem(DASHBOARD_TASK_KEY);
  } catch (error) {
    console.warn('[CockpitChatPanelController] Failed to clear saved task id', error);
  }
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * CockpitStreamingClient
 * 
 * Connects the Cockpit UI to the backend via SSE/WebSocket and routes
 * streaming events through MessageRenderer for rich Liquid Glass rendering.
 * 
 * Adapts the event format from RealTimeStreamingClient to MessageRenderer's
 * expected message objects.
 */

class CockpitStreamingClient {
  /**
   * @description Initialize a streaming client instance for the Cockpit UI,
   * establishing identity (service endpoint, session id), connection state,
   * reconnect policy, and the callback hooks the UI uses to receive routed
   * streaming events. Construction does not open a connection; call connect().
   * @param {string} [serviceUrl] - Base URL of the backend service; defaults to
   *   the current page origin when omitted.
   * @param {string} [sessionId] - Stable session identifier; defaults to a
   *   timestamp-derived id so each client gets a unique stream scope.
   */
  constructor(serviceUrl, sessionId) {
    this.serviceUrl = serviceUrl || window.location.origin;
    this.sessionId = sessionId || `cockpit_${Date.now()}`;
    this.eventSource = null;
    this.socket = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.currentTaskId = null;

    // Callbacks
    this.onMessage = null;       // (message) => void — structured message for MessageRenderer
    this.onStatus = null;        // (status) => void — 'connected' | 'disconnected' | 'failed'
    this.onTaskCreated = null;   // (taskId) => void
    this.onTaskCompleted = null; // (taskId) => void

    this._tsCounter = Date.now();
  }

  _ts() {
    return String(this._tsCounter++);
  }

  // ─── Connection ──────────────────────────────────────────────

  /**
   * @description Open the live event stream so the Cockpit UI starts receiving
   * backend updates. Acts as the single public entry point for connecting and
   * is idempotent: a no-op if already connected, so callers can invoke it
   * safely without tracking state themselves.
   */
  connect() {
    if (this.isConnected) return;

    // Try WebSocket first (Socket.IO), fall back to SSE
    this._connectSSE();
  }

  _connectSSE() {
    try {
      const url = `${this.serviceUrl}/streaming?sessionId=${this.sessionId}`;
      console.log('🌊 Cockpit SSE connecting:', url);

      this.eventSource = new EventSource(url);

      this.eventSource.onopen = () => {
        console.log('✅ Cockpit SSE connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        if (this.onStatus) this.onStatus('connected');
      };

      this.eventSource.addEventListener('streaming-event', (event) => {
        try {
          const data = JSON.parse(event.data);
          this._handleEvent(data);
        } catch (e) {
          console.error('❌ Failed to parse SSE event:', e);
        }
      });

      this.eventSource.addEventListener('connection', () => {});
      this.eventSource.addEventListener('heartbeat', () => {});

      this.eventSource.onerror = () => {
        console.warn('❌ Cockpit SSE error');
        this.isConnected = false;
        if (this.onStatus) this.onStatus('disconnected');

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(this.reconnectAttempts * 2000, 10000);
          console.log(`🔄 Reconnecting in ${delay}ms...`);
          setTimeout(() => {
            this.disconnect();
            this.connect();
          }, delay);
        } else {
          if (this.onStatus) this.onStatus('failed');
        }
      };
    } catch (e) {
      console.error('❌ SSE connection failed:', e);
      if (this.onStatus) this.onStatus('failed');
    }
  }

  /**
   * @description Tear down the active stream and mark the client offline so the
   * UI can reflect a disconnected state. Used both for deliberate shutdown and
   * as part of the reconnect cycle to release the prior EventSource before a
   * fresh connection is opened.
   */
  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.isConnected = false;
    if (this.onStatus) this.onStatus('disconnected');
  }

  /**
   * Reset per-task metrics counters.
   * Called by app.js at the start of each new message/chat to zero out
   * token and cost tracking for the upcoming task.
   */
  resetTaskMetrics() {
    this._taskTokensIn = 0;
    this._taskTokensOut = 0;
    this._taskCost = 0;
    this._taskTurns = 0;
  }

  // ─── Send Message ────────────────────────────────────────────

  /**
   * @description Submit user input into the conversation. Bridges the two
   * backend interaction shapes for the UI: if no task is in progress it starts
   * one, otherwise it appends a message to the current task. Any immediate
   * (non-streamed) reply is normalized out of the backend's variably-nested
   * response and surfaced to the renderer; failures are reported as an error
   * message so the UI never silently swallows a send.
   * @param {string} text - The user-authored message to send.
   * @param {string} [mode='plan'] - Interaction mode hint for the request.
   * @returns {Promise<Object>} The backend's JSON response for the create or
   *   post-message call.
   */
  async sendMessage(text, mode = 'plan') {
    try {
      // If we don't have a current task, create one instead
      if (!this.currentTaskId) {
        return await this.createTask(text);
      }

      // We have a current task, post a message to it
      const response = await fetch(`${this.serviceUrl}/api/tasks/${this.currentTaskId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, source: 'dashboard' })
      });

      const result = await response.json();
      
      // If there's an immediate response (non-streaming), render it
      // Note: the backend returns double/triple nested results sometimes, check carefully
      let content = result.response;
      if (!content && result.result && result.result.result) {
        content = typeof result.result.result === 'string' ? result.result.result : result.result.result.result;
      } else if (!content && result.result && typeof result.result === 'string') {
        content = result.result;
      }

      if (content) {
        this._emit({ ts: this._ts(), type: 'say', say: 'text', text: content });
      }

      return result;
    } catch (e) {
      console.error('❌ Send failed:', e);
      this._emit({ ts: this._ts(), type: 'say', say: 'error', text: `Failed to send message: ${e.message}` });
      throw e;
    }
  }

  /**
   * Create a task via the REST API (for cockpit's existing task-based flow)
   */
  async createTask(text) {
    try {
      const response = await fetch(`${this.serviceUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, source: 'dashboard' })
      });

      const result = await response.json();
      this.currentTaskId = result.taskId || result.task_id || result.id || (result.task ? result.task.id : null);
      if (this.onTaskCreated) this.onTaskCreated(this.currentTaskId);
      return result;
    } catch (e) {
      console.error('❌ Create task failed:', e);
      throw e;
    }
  }

  // ─── Event Handling → MessageRenderer format ─────────────────

  _handleEvent(event) {
    const taskId = event.taskId || event.sessionId || this.sessionId;

    // Filter to current task if set
    if (this.currentTaskId && taskId !== this.currentTaskId && taskId !== this.sessionId) {
      return;
    }

    switch (event.type) {
      case 'api_req_started':
        this._emit({
          ts: this._ts(),
          type: 'say',
          say: 'api_req_started',
          text: JSON.stringify({
            cost: event.cost || 0,
            request: event.request || `Turn ${event.turn || 1}`
          })
        });
        break;

      case 'api_req_finished':
        // Emit a text marker so MessageRenderer marks pending API requests as complete
        // (handled internally by markPendingApiRequestsComplete)
        this._emit({
          ts: this._ts(),
          type: 'say',
          say: 'text',
          text: '' // Empty text triggers API completion in MessageRenderer
        });
        break;

      case 'reasoning':
        this._emit({
          ts: this._ts(),
          type: 'say',
          say: 'reasoning',
          text: event.text || ''
        });
        break;

      case 'tool_use':
        this._emit({
          ts: this._ts(),
          type: 'say',
          say: 'tool',
          text: JSON.stringify({
            tool: event.tool || 'unknown',
            path: event.input?.path || '',
            content: event.input?.content || '',
            regex: event.input?.regex || '',
            command: event.input?.command || ''
          })
        });
        break;

      case 'tool_result':
        // Tool results update the existing tool card
        // MessageRenderer handles this via sequence
        break;

      case 'text':
      case 'llm-response':
        this._emit({
          ts: this._ts(),
          type: 'say',
          say: 'text',
          text: event.text || event.content || event.fullResponse || ''
        });
        break;

      case 'completion_result':
      case 'task-completion':
        this._emit({
          ts: this._ts(),
          type: 'say',
          say: 'completion_result',
          text: event.text || event.result || 'Task completed.'
        });
        if (this.onTaskCompleted) this.onTaskCompleted(taskId);
        break;

      case 'error':
        this._emit({
          ts: this._ts(),
          type: 'say',
          say: 'error',
          text: event.text || event.message || 'Unknown error'
        });
        break;

      case 'thinking-process':
        this._emit({
          ts: this._ts(),
          type: 'say',
          say: 'reasoning',
          text: `${event.step}: ${event.details}`
        });
        break;

      case 'task-progress':
        // Show as text notification
        this._emit({
          ts: this._ts(),
          type: 'say',
          say: 'text',
          text: `📋 Progress: ${event.completedCount}/${event.total} (${event.progressPercent}%)`
        });
        break;

      // Silent events
      case 'heartbeat':
      case 'connection':
      case 'task_update':
      case 'message':
      case 'llm_processing':
        break;

      default:
        console.log('🔍 Unknown cockpit event:', event.type);
    }
  }

  _emit(message) {
    if (this.onMessage) {
      this.onMessage(message);
    }
  }
}

// Export for browser
if (typeof window !== 'undefined') {
  window.CockpitStreamingClient = CockpitStreamingClient;
}

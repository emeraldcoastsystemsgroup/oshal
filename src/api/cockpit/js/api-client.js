/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * API Client with Cost Controls
 * Manages all backend API calls with spend tracking and limits
 */

/**
 * @description Client-side gateway for all cockpit backend API calls that also
 * enforces user-configured spend guardrails. It exists so the UI can centralize
 * cost accounting (daily and per-"bucket" limits persisted in localStorage) and
 * block requests that would exceed those limits before money is spent.
 */
class ApiClient {
  /**
   * @description Initializes the client against the current page origin and seeds
   * the in-memory cost tracker, then rehydrates any previously saved limits and
   * spend so guardrails survive page reloads.
   */
  constructor() {
    this.baseURL = window.location.origin;
    this.costTracker = {
      dailySpent: 0,
      dailyLimit: null, // Set via UI
      bucketSpent: 0,
      bucketLimit: null, // Set via UI
      lastReset: this.getTodayDateString(),
      transactions: []
    };
    
    // Load saved limits and spent amounts
    this.loadCostSettings();
  }

  /**
   * @description Provides the current UTC calendar day as a stable key so daily
   * spend can be reset and transactions filtered when the day rolls over.
   * @returns {string} Today's date in YYYY-MM-DD form.
   */
  getTodayDateString() {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * @description Restores persisted cost limits and spend from localStorage,
   * rolling daily totals back to zero and pruning stale transactions when a new
   * day has started, so guardrails stay accurate across sessions. Failures are
   * swallowed so a corrupt store never breaks the cockpit.
   */
  loadCostSettings() {
    try {
      const saved = localStorage.getItem('cockpit-cost-tracker');
      if (saved) {
        const data = JSON.parse(saved);
        
        // Reset daily if it's a new day
        if (data.lastReset !== this.getTodayDateString()) {
          data.dailySpent = 0;
          data.lastReset = this.getTodayDateString();
          data.transactions = data.transactions.filter(t => {
            const txDate = new Date(t.timestamp).toISOString().split('T')[0];
            return txDate === this.getTodayDateString();
          });
        }
        
        this.costTracker = { ...this.costTracker, ...data };
      }
    } catch (e) {
      console.warn('Failed to load cost settings:', e);
    }
  }

  /**
   * @description Persists the current cost tracker to localStorage so configured
   * limits and accumulated spend survive reloads. Failures are swallowed to keep
   * a write error (e.g. storage full) from interrupting the user.
   */
  saveCostSettings() {
    try {
      localStorage.setItem('cockpit-cost-tracker', JSON.stringify(this.costTracker));
    } catch (e) {
      console.warn('Failed to save cost settings:', e);
    }
  }

  /**
   * @description Applies the user's spend guardrails, treating empty/falsy input
   * as "no limit" so the UI can clear a cap, and persists the change immediately.
   * @param {number|string} dailyLimit - Maximum spend allowed per day, or falsy for no daily cap.
   * @param {number|string} bucketLimit - Maximum spend allowed per bucket, or falsy for no bucket cap.
   */
  setCostLimits(dailyLimit, bucketLimit) {
    this.costTracker.dailyLimit = dailyLimit ? parseFloat(dailyLimit) : null;
    this.costTracker.bucketLimit = bucketLimit ? parseFloat(bucketLimit) : null;
    this.saveCostSettings();
  }

  /**
   * @description Clears the running "bucket" spend back to zero so the user can
   * start a fresh spending allotment without affecting the daily total, then persists it.
   */
  resetBucket() {
    this.costTracker.bucketSpent = 0;
    this.saveCostSettings();
  }

  /**
   * @description Books an incurred charge against both the daily and bucket totals,
   * appends an auditable transaction record, persists the new state, and notifies
   * the UI via a 'cost-updated' event so spend indicators refresh in real time.
   * @param {number|string} amount - The cost incurred; non-numeric values are treated as 0.
   * @param {Object} [metadata={}] - Extra context (e.g. taskId, tokens, requests) stored with the transaction.
   */
  recordCost(amount, metadata = {}) {
    const cost = parseFloat(amount) || 0;
    this.costTracker.dailySpent += cost;
    this.costTracker.bucketSpent += cost;
    this.costTracker.transactions.push({
      amount: cost,
      timestamp: new Date().toISOString(),
      ...metadata
    });
    this.saveCostSettings();
    
    // Dispatch event for UI updates
    window.dispatchEvent(new CustomEvent('cost-updated', { 
      detail: this.getCostStatus() 
    }));
  }

  /**
   * @description Gatekeeper consulted before any billable call: decides whether a
   * new request is permitted under the configured caps and supplies a human-readable
   * reason when it is not, so callers can fail fast instead of spending over budget.
   * @returns {{allowed: boolean, reason?: string, status: Object}} Whether the call may proceed, why not, and the current cost status snapshot.
   */
  checkCostLimit() {
    const status = this.getCostStatus();
    
    if (status.dailyLimitReached || status.bucketLimitReached) {
      return {
        allowed: false,
        reason: status.dailyLimitReached 
          ? `Daily limit reached ($${this.costTracker.dailyLimit})` 
          : `Bucket limit reached ($${this.costTracker.bucketLimit})`,
        status
      };
    }
    
    return { allowed: true, status };
  }

  /**
   * @description Produces a derived, read-only snapshot of spend versus limits
   * (remaining amounts, limit-reached flags, and recent transactions) intended
   * for binding to the cost UI and for limit checks, without exposing the
   * mutable tracker directly.
   * @returns {Object} Current daily/bucket spend, limits, remaining, reached flags, and the last 10 transactions.
   */
  getCostStatus() {
    return {
      dailySpent: this.costTracker.dailySpent,
      dailyLimit: this.costTracker.dailyLimit,
      dailyRemaining: this.costTracker.dailyLimit 
        ? this.costTracker.dailyLimit - this.costTracker.dailySpent 
        : null,
      dailyLimitReached: this.costTracker.dailyLimit 
        ? this.costTracker.dailySpent >= this.costTracker.dailyLimit 
        : false,
      bucketSpent: this.costTracker.bucketSpent,
      bucketLimit: this.costTracker.bucketLimit,
      bucketRemaining: this.costTracker.bucketLimit 
        ? this.costTracker.bucketLimit - this.costTracker.bucketSpent 
        : null,
      bucketLimitReached: this.costTracker.bucketLimit 
        ? this.costTracker.bucketSpent >= this.costTracker.bucketLimit 
        : false,
      recentTransactions: this.costTracker.transactions.slice(-10)
    };
  }

  // API Methods with cost tracking
  /**
   * @description Performs a forgiving GET that never throws, returning a caller-
   * supplied fallback on any non-OK response or network/parse error. Used for
   * non-critical reads where the dashboard should degrade gracefully rather than break.
   * @param {string} endpoint - Path appended to the base URL to fetch.
   * @param {*} defaultValue - Value returned when the request fails or is not OK.
   * @returns {Promise<*>} The parsed JSON response, or defaultValue on failure.
   */
  async getSafe(endpoint, defaultValue) {
    try {
      const res = await fetch(this.baseURL + endpoint);
      if (!res.ok) return defaultValue;
      return await res.json();
    } catch {
      return defaultValue;
    }
  }

  // Generic GET method for endpoints where defaultValue is not appropriate
  /**
   * @description Performs a strict GET that surfaces failures as exceptions, for
   * critical reads where a silent fallback would hide a real problem from the caller.
   * @param {string} endpoint - Path appended to the base URL to fetch.
   * @returns {Promise<*>} The parsed JSON response.
   * @throws {Error} When the response is not OK, with the server-provided error or status text.
   */
  async get(endpoint) {
    const res = await fetch(this.baseURL + endpoint);
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || res.statusText);
    }
    return await res.json();
  }

  /**
   * @description Loads the roster of agents for display, degrading to an empty
   * list so the UI stays usable when the agents endpoint is unavailable.
   * @returns {Promise<Object>} The agents payload, or { agents: [] } on failure.
   */
  async getAgents() {
    return this.getSafe('/api/agents', { agents: [] });
  }

  /**
   * @description Loads the task list for display, degrading to an empty list so
   * the UI stays usable when the tasks endpoint is unavailable.
   * @returns {Promise<Object>} The tasks payload, or { tasks: [] } on failure.
   */
  async getTasks() {
    return this.getSafe('/api/tasks', { tasks: [] });
  }

  /**
   * @description Polls backend health for status indicators, defaulting to an
   * 'unknown' status so a failed probe is shown as indeterminate rather than crashing the UI.
   * @returns {Promise<Object>} The health payload, or { status: 'unknown' } on failure.
   */
  async getHealth() {
    return this.getSafe('/api/health', { status: 'unknown' });
  }

  /**
   * @description Generic JSON PUT helper for updating a resource, raising an error
   * on failure so callers can surface a meaningful message instead of proceeding silently.
   * @param {string} endpoint - Path appended to the base URL to update.
   * @param {Object} data - Payload serialized as the JSON request body.
   * @returns {Promise<*>} The parsed JSON response.
   * @throws {Error} When the response is not OK, with the server-provided error or status text.
   */
  async put(endpoint, data) {
    const res = await fetch(this.baseURL + endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || res.statusText);
    }
    
    return await res.json();
  }

  /**
   * @description Creates a new task, but first consults the spend guardrails and
   * aborts before any network call if a cost limit has been reached, so tasks
   * cannot be started over budget.
   * @param {string} text - The task description/prompt to create.
   * @param {string} [mode='act'] - Execution mode for the task.
   * @returns {Promise<Object>} The created task as returned by the server.
   * @throws {Error} When a cost limit blocks creation, or when the response is not OK.
   */
  async createTask(text, mode = 'act') {
    // Check cost limit before creating task
    const limitCheck = this.checkCostLimit();
    if (!limitCheck.allowed) {
      throw new Error(limitCheck.reason);
    }

    const res = await fetch(`${this.baseURL}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode })
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || res.statusText);
    }

    const data = await res.json();
    return data;
  }

  /**
   * @description Sends a user message into an existing task, enforcing spend
   * guardrails up front and, on success, recording any reported API cost so the
   * conversation's spend is reflected in the tracker. Options default to an
   * auto-approving, agentic dashboard interaction.
   * @param {string} taskId - Identifier of the task to message.
   * @param {string} text - The message body to send.
   * @param {Object} [options={}] - Optional images, files, autoApprove flag, source, and targetBot overrides.
   * @returns {Promise<Object>} The server response, which may include apiMetrics used for cost tracking.
   * @throws {Error} When a cost limit blocks the send, or when the response is not OK.
   */
  async sendMessage(taskId, text, options = {}) {
    // Check cost limit
    const limitCheck = this.checkCostLimit();
    if (!limitCheck.allowed) {
      throw new Error(limitCheck.reason);
    }

    const res = await fetch(`${this.baseURL}/api/tasks/${taskId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        images: options.images || [],
        files: options.files || [],
        autoApprove: options.autoApprove !== false,
        agenticMode: true,
        source: options.source || 'dashboard',
        targetBot: options.targetBot || 'assistant'
      })
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || res.statusText);
    }

    const data = await res.json();
    
    // Track cost if provided
    if (data.apiMetrics && data.apiMetrics.totalCost) {
      this.recordCost(data.apiMetrics.totalCost, {
        taskId,
        tokens: data.apiMetrics.totalTokens,
        requests: data.apiMetrics.requestCount
      });
    }

    return data;
  }

  /**
   * @description Loads a single task's full detail, treating absence/failure as a
   * hard error since callers requesting a specific task need it to exist.
   * @param {string} taskId - Identifier of the task to load.
   * @returns {Promise<Object>} The task detail payload.
   * @throws {Error} When the task cannot be loaded.
   */
  async getTask(taskId) {
    const res = await fetch(`${this.baseURL}/api/tasks/${taskId}`);
    if (!res.ok) throw new Error('Failed to load task');
    return await res.json();
  }

  // ─── Plane Ticket Explorer Methods ──────────────────────────────────

  /**
   * @description Loads the parent/child ticket tree for the explorer, optionally
   * scoped to one project, degrading to an empty unsuccessful result so the view
   * renders cleanly when the data is unavailable.
   * @param {string} [projectId] - Optional project to scope the hierarchy to; omitted means all projects.
   * @returns {Promise<Object>} The hierarchy payload, or { success: false, data: [], total: 0 } on failure.
   */
  async getTicketHierarchy(projectId) {
    const params = projectId ? `?projectId=${projectId}` : '';
    return this.getSafe(`/api/v1/tickets/hierarchy${params}`, { success: false, data: [], total: 0 });
  }

  /**
   * @description Loads the activity/history feed for a ticket, using the strict
   * GET so an error is surfaced rather than masked, since an empty feed and a
   * failed fetch must be distinguishable here.
   * @param {string} ticketId - Identifier of the ticket whose activity to load.
   * @returns {Promise<*>} The activity payload.
   * @throws {Error} When the request is not OK.
   */
  async getTicketActivity(ticketId) {
    return this.get(`/api/v1/tickets/${ticketId}/activity`);
  }

  /**
   * @description Transitions a ticket to a new workflow state, raising on failure
   * so the UI can avoid optimistically showing a state change that did not persist.
   * @param {string} ticketId - Identifier of the ticket to update.
   * @param {string} state - The new status to set for the ticket.
   * @returns {Promise<*>} The updated ticket payload.
   * @throws {Error} When the response is not OK, with the server-provided error or status text.
   */
  async updateTicketState(ticketId, state) {
    const res = await fetch(`${this.baseURL}/api/tickets/${ticketId}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: state })
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || res.statusText);
    }
    return await res.json();
  }

  /**
   * @description Sends a chat message scoped to a specific ticket, enforcing spend
   * guardrails before the call so ticket conversations also respect cost limits.
   * @param {string} ticketId - Identifier of the ticket to chat on.
   * @param {string} message - The chat message to send.
   * @param {Object} [options={}] - Additional fields merged into the request body.
   * @returns {Promise<*>} The chat response payload.
   * @throws {Error} When a cost limit blocks the call, or when the response is not OK.
   */
  async chatOnTicket(ticketId, message, options = {}) {
    const limitCheck = this.checkCostLimit();
    if (!limitCheck.allowed) {
      throw new Error(limitCheck.reason);
    }

    const res = await fetch(`${this.baseURL}/api/tickets/${ticketId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, ...options })
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || res.statusText);
    }
    return await res.json();
  }

  /**
   * @description Loads the file tree of a ticket's workspace for the explorer,
   * degrading to a non-existent/empty workspace so the file view renders safely
   * when there is nothing to show or the fetch fails.
   * @param {string} ticketId - Identifier of the ticket whose workspace files to load.
   * @returns {Promise<Object>} The workspace file tree, or a { success: false, data: { children: [], exists: false } } fallback.
   */
  async getWorkspaceFiles(ticketId) {
    return this.getSafe(`/api/v1/workspace/${ticketId}/files`, { success: false, data: { children: [], exists: false } });
  }

  /**
   * @description Loads the list of projects used to scope the explorer, degrading
   * to an empty unsuccessful result so project selectors render without error.
   * @returns {Promise<Object>} The projects payload, or { success: false, data: [] } on failure.
   */
  async getProjects() {
    return this.getSafe('/api/v1/projects', { success: false, data: [] });
  }

  /**
   * @description Loads aggregate metrics for dashboards, optionally scoped to a
   * project, degrading to a null data result so summary widgets can show an empty
   * state instead of breaking when metrics are unavailable.
   * @param {string} [projectId] - Optional project to scope the metrics to; omitted means all projects.
   * @returns {Promise<Object>} The metrics summary, or { success: false, data: null } on failure.
   */
  async getMetricsSummary(projectId) {
    const params = projectId ? `?projectId=${projectId}` : '';
    return this.getSafe(`/api/v1/metrics/summary${params}`, { success: false, data: null });
  }

  /**
   * @description Generic DELETE helper for removing a resource, raising on failure
   * so the caller does not assume a deletion succeeded when it did not.
   * @param {string} endpoint - Path appended to the base URL identifying the resource to delete.
   * @returns {Promise<*>} The parsed JSON response.
   * @throws {Error} When the response is not OK, with the server-provided error or status text.
   */
  async delete(endpoint) {
    const res = await fetch(`${this.baseURL}${endpoint}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || res.statusText);
    }
    return await res.json();
  }
}

// Expose on window FIRST for non-module script contexts
if (typeof window !== 'undefined') {
  window.ApiClient = ApiClient;
}

// ES6 Module Export (for import statements in app.js, views, etc.)
// Note: The VM414 SyntaxError in Chrome DevTools is benign — this file
// is correctly loaded as an ES module by app.js. The VM error comes from
// Chrome's internal evaluation context, not from actual script loading.
export { ApiClient };

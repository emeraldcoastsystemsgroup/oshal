/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Corrected cockpit agent-tool auth route usage and normalized file header governance for Session 69 stabilization
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added per-agent profile read/write helpers for native bot-config flows in cockpit and config admin
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added generic post and task-delete helpers plus real cost-series aggregation for cockpit button-audit and dashboard de-mocking
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added per-agent tool lookup helper so cockpit usability flows can respect live switch-framework capability gates
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Preserved workspace-file error intent so the ticket artifacts tab can distinguish backend failure from a legitimate empty workspace
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added project CRUD helpers (create, rename, archive) for explicit project management UX
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added createTicket method for direct ticket creation from cockpit toolbar
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added live swarm-registry agent filtering so cockpit bot selectors stop offering undeployed persisted profiles like devops-bot
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Replaced cockpit API client silent catches with structured warning logs and shared response-error parsing to satisfy governance during bot-selector hardening
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Kept cockpit selectors on the registry roster even when swarm heartbeats are offline so standalone hosts stop falling back to stale persisted bots like devops-bot
 */

/**
 * @description Cockpit API client with spend tracking and convenience wrappers for OSHAL routes.
 */
class ApiClient {
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

  getTodayDateString() {
    return new Date().toISOString().split('T')[0];
  }

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
      this.logWarning('load-cost-settings', e);
    }
  }

  saveCostSettings() {
    try {
      localStorage.setItem('cockpit-cost-tracker', JSON.stringify(this.costTracker));
    } catch (e) {
      this.logWarning('save-cost-settings', e);
    }
  }

  setCostLimits(dailyLimit, bucketLimit) {
    this.costTracker.dailyLimit = dailyLimit ? parseFloat(dailyLimit) : null;
    this.costTracker.bucketLimit = bucketLimit ? parseFloat(bucketLimit) : null;
    this.saveCostSettings();
  }

  resetBucket() {
    this.costTracker.bucketSpent = 0;
    this.saveCostSettings();
  }

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

  async throwResponseError(response, action) {
    const error = await this.readErrorPayload(response, action);
    throw new Error(error.error || response.statusText);
  }

  async readErrorPayload(response, action) {
    try {
      return await response.json();
    } catch (error) {
      this.logWarning(action, error, {
        event: 'parse-error-payload-failed',
        status: response.status,
        statusText: response.statusText,
      });
      return { error: response.statusText };
    }
  }

  logWarning(action, error, context = {}) {
    console.warn(JSON.stringify({
      level: 'warn',
      component: 'cockpit-api-client',
      action,
      error: error instanceof Error ? error.message : String(error),
      ...context,
    }));
  }

  // API Methods with cost tracking
  async getSafe(endpoint, defaultValue, timeoutMs = 8000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(this.baseURL + endpoint, controller ? { signal: controller.signal } : undefined);
      if (!res.ok) return defaultValue;
      return await res.json();
    } catch (error) {
      this.logWarning('get-safe', error, { endpoint });
      return defaultValue;
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  // Generic GET method for endpoints where defaultValue is not appropriate
  async get(endpoint) {
    const res = await fetch(this.baseURL + endpoint);
    if (!res.ok) {
      await this.throwResponseError(res, 'get');
    }
    return await res.json();
  }

  async getAgents() {
    return this.getSafe('/api/agents', { agents: [] });
  }

  /**
   * @description Load the live swarm bot registry used for runtime-aware cockpit selectors.
   * @returns {Promise<{ bots: Array<Record<string, unknown>> }>} Live runtime bot registry payload.
   */
  async getBotRegistry() {
    return this.getSafe('/api/swarm/bots/registry', { bots: [] });
  }

  /**
   * @description Resolve the set of currently live cockpit-selectable agents by intersecting
   * persisted agent profiles with the swarm bot registry. Falls back to persisted agents only
   * when the registry is unavailable so the cockpit still boots in degraded local modes, but
   * stays on the registry roster when the swarm exists and simply reports zero live heartbeats.
   * @returns {Promise<Array<Record<string, unknown>>>} Live-selectable agent rows.
   */
  async getLiveAgents() {
    const [agentsPayload, registryPayload] = await Promise.all([
      this.getAgents(),
      this.getBotRegistry(),
    ]);
    const persistedAgents = Array.isArray(agentsPayload?.agents) ? agentsPayload.agents : [];
    const registryBots = Array.isArray(registryPayload?.bots) ? registryPayload.bots.filter(Boolean) : [];

    if (!registryBots.length) {
      return persistedAgents;
    }

    const liveBots = registryBots.filter((bot) => bot.online !== false);
    const projectedBots = liveBots.length ? liveBots : registryBots;

    const persistedById = new Map(
      persistedAgents.map((agent) => {
        const agentId = String(agent?.agentId || agent?.agent_id || '').trim();
        return [agentId, agent];
      }).filter(([agentId]) => agentId),
    );

    return projectedBots.map((bot) => {
      const agentId = String(bot?.agentId || '').trim();
      const persisted = persistedById.get(agentId) || {};
      return {
        ...persisted,
        ...bot,
        agentId,
        agent_id: agentId,
        name: bot?.name || persisted?.name || agentId,
      };
    });
  }

  async getAgentTools(agentId) {
    return this.getSafe(`/api/agents/${encodeURIComponent(agentId)}/tools`, { tools: [] });
  }

  async getTasks() {
    return this.getSafe('/api/tasks', { tasks: [] });
  }

  async getHealth() {
    return this.getSafe('/api/health', { status: 'unknown' });
  }

  async put(endpoint, data) {
    const res = await fetch(this.baseURL + endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    if (!res.ok) {
      await this.throwResponseError(res, 'put');
    }
    
    return await res.json();
  }

  async post(endpoint, data) {
    const res = await fetch(this.baseURL + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!res.ok) {
      await this.throwResponseError(res, 'post');
    }

    return await res.json();
  }

  async createTask(text, mode = 'act', options = {}) {
    // Check cost limit before creating task
    const limitCheck = this.checkCostLimit();
    if (!limitCheck.allowed) {
      throw new Error(limitCheck.reason);
    }

    const res = await fetch(`${this.baseURL}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: text,
        text,
        mode,
        processingMode: 'agentic',
        agentId: options.agentId || undefined,
        metadata: {
          source: options.source || 'dashboard',
          targetBot: options.targetBot || undefined,
        },
      })
    });

    if (!res.ok) {
      await this.throwResponseError(res, 'create-task');
    }

    const data = await res.json();
    return data;
  }

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
      await this.throwResponseError(res, 'send-message');
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

  async getTask(taskId) {
    const res = await fetch(`${this.baseURL}/api/tasks/${taskId}`);
    if (!res.ok) throw new Error('Failed to load task');
    return await res.json();
  }

  async deleteTask(taskId) {
    const res = await fetch(`${this.baseURL}/api/tasks/${taskId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'delete-task');
    }
    return true;
  }

  getCostTransactions() {
    return Array.isArray(this.costTracker.transactions) ? [...this.costTracker.transactions] : [];
  }

  getDailyCostSeries(hours = 24) {
    const bucketCount = Number.isInteger(hours) && hours > 0 ? hours : 24;
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const series = Array.from({ length: bucketCount }, (_unused, index) => ({
      hour: index,
      label: `${String(index).padStart(2, '0')}:00`,
      amount: 0
    }));

    this.getCostTransactions().forEach((transaction) => {
      const timestamp = new Date(transaction.timestamp || '');
      if (Number.isNaN(timestamp.getTime())) return;
      if (timestamp < startOfDay) return;
      const bucketIndex = timestamp.getHours();
      if (!series[bucketIndex]) return;
      series[bucketIndex].amount += Number(transaction.amount || 0);
    });

    return series;
  }

  // ─── Plane Ticket Explorer Methods ──────────────────────────────────

  /**
   * @description Create a new ticket directly.
   * @param {{ title: string; description?: string; projectId?: string; projectName?: string; priority?: string }} payload
   * @returns {Promise<{ticket: object}>}
   */
  async createTicket(payload) {
    return this.post('/api/v1/tickets', payload);
  }

  async getTicketHierarchy(projectId, ticketType) {
    const parts = [];
    if (projectId) parts.push(`projectId=${encodeURIComponent(projectId)}`);
    if (ticketType) parts.push(`type=${encodeURIComponent(ticketType)}`);
    const params = parts.length ? `?${parts.join('&')}` : '';
    return this.getSafe(`/api/v1/tickets/hierarchy${params}`, { success: false, data: [], total: 0 });
  }

  async getTicketActivity(ticketId) {
    return this.get(`/api/v1/tickets/${ticketId}/activity`);
  }

  async getTicketEscalations(ticketLookupId) {
    const query = encodeURIComponent(ticketLookupId);
    return this.getSafe(`/api/swarm/escalations?ticketExternalId=${query}&limit=5`, {
      success: false,
      escalations: [],
      count: 0,
    });
  }

  async updateTicketState(ticketId, state) {
    const res = await fetch(`${this.baseURL}/api/tickets/${ticketId}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: state })
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'update-ticket-state');
    }
    return await res.json();
  }

  async moveTicketProject(ticketId, payload) {
    const res = await fetch(`${this.baseURL}/api/tickets/${ticketId}/project`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'move-ticket-project');
    }
    return await res.json();
  }

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
      await this.throwResponseError(res, 'chat-on-ticket');
    }
    return await res.json();
  }

  async replyOnTicket(ticketId, message) {
    const res = await fetch(`${this.baseURL}/api/v1/tickets/${ticketId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, intent: 'update' })
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'reply-on-ticket');
    }
    return await res.json();
  }

  async getWorkspaceFiles(ticketId) {
    try {
      return await this.get(`/api/v1/workspace/${ticketId}/files`);
    } catch (error) {
      this.logWarning('get-workspace-files', error, { ticketId });
      return {
        success: false,
        data: { children: [], exists: false },
        __error: true,
        error: error instanceof Error ? error.message : String(error || 'Workspace inventory unavailable'),
      };
    }
  }

  async getProjects() {
    return this.get('/api/v1/projects');
  }

  async createProject(name) {
    return this.post('/api/v1/projects', { name });
  }

  async renameProject(projectId, name) {
    return this.patch(`/api/v1/projects/${encodeURIComponent(projectId)}`, { name });
  }

  async archiveProject(projectId) {
    return this.delete(`/api/v1/projects/${encodeURIComponent(projectId)}`);
  }

  async getMetricsSummary(projectId) {
    const params = projectId ? `?projectId=${projectId}` : '';
    return this.getSafe(`/api/v1/metrics/summary${params}`, { success: false, data: null });
  }

  async delete(endpoint) {
    const res = await fetch(`${this.baseURL}${endpoint}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'delete');
    }
    return await res.json();
  }

  // ─── Tool Registry Methods ──────────────────────────────────────────────

  async getTools() {
    return this.getSafe('/api/tools', { tools: [] });
  }

  async getTool(toolId) {
    return this.getSafe(`/api/tools/${toolId}`, { tool: null });
  }

  async createTool(toolData) {
    const res = await fetch(`${this.baseURL}/api/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toolData)
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'create-tool');
    }
    return await res.json();
  }

  async updateTool(toolId, toolData) {
    const res = await fetch(`${this.baseURL}/api/tools/${toolId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toolData)
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'update-tool');
    }
    return await res.json();
  }

  async deleteTool(toolId) {
    const res = await fetch(`${this.baseURL}/api/tools/${toolId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'delete-tool');
    }
    return await res.json();
  }

  // ─── Tool Approval Methods ──────────────────────────────────────────────

  async approveTool(toolId, approved) {
    const res = await fetch(`${this.baseURL}/api/tools/${toolId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved })
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'approve-tool');
    }
    return await res.json();
  }

  // ─── Agent Tool Config Methods ──────────────────────────────────────────

  async getAgentTools(agentId) {
    return this.getSafe(`/api/agents/${agentId}/tools`, { tools: [] });
  }

  async getAgentProfile(agentId) {
    return this.get(`/api/agents/${agentId}/profile`);
  }

  async updateAgentProfile(agentId, profile) {
    return this.put(`/api/agents/${agentId}/profile`, { profile });
  }

  async setAgentToolAuthMode(agentId, toolId, authMode) {
    const res = await fetch(`${this.baseURL}/api/agents/${agentId}/tools/${toolId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authMode })
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'set-agent-tool-auth-mode');
    }
    return await res.json();
  }

  // ─── Tool Installation/Verification Methods ─────────────────────────────

  async verifyTool(toolId) {
    const res = await fetch(`${this.baseURL}/api/tools/verify/${toolId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      await this.throwResponseError(res, 'verify-tool');
    }
    return await res.json();
  }

  async getToolVerificationStatus(toolId) {
    return this.getSafe(`/api/tools/verify/${toolId}/status`, { status: null });
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

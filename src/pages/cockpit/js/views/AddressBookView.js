/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added native per-bot config entry links from cockpit bot profile cards
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated bot config links to open in agent-scoped /config mode for selected-bot-first workflows
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Tightened address book button flows with real status handling and bot-scoped activity navigation for the cockpit usability audit
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Bot name as primary display with UUID subtitle, read-only properties (role/port/container/heartbeat), Open Bot links to localhost:port, registry-based health, no CRUD
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Card/list view toggle, scroll fix (min-height:0), full backstory + all capabilities visible, expandable list-row detail panel
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Made bot cards fully clickable → navigates to /swarmbot/chat workspace. Changed Open Bot from localhost:port to swarmbot-chat. Added Settings action button.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | P3: Added active/inactive toggle per bot card wired to PATCH /api/agents/:agentId/status
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Icon-only action buttons, compacted card layout (props→chips, removed vitals)
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Use getAgents() instead of getLiveAgents() so all 49 seed+live bots appear
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Default toggle to OFF for bots without online status; only online bots start active
 */

import { ApiClient } from '../api-client.js';

/**
 * @description Bot directory view that surfaces cockpit actions for messaging,
 * ticket creation, configuration, and activity drill-in.
 * Supports card grid mode and compact list mode with expandable detail rows.
 */
export class AddressBookView {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.api = new ApiClient();
    this.agents = [];
    this.health = {};
    this.searchQuery = '';
    this.viewMode = 'card'; // 'card' | 'list'
    this.onMessageBot = options.onMessageBot || null;
    this.onCreateTicket = options.onCreateTicket || null;
    this.onViewActivity = options.onViewActivity || null;
  }

  async render() {
    if (!this.container) return;
    this.container.innerHTML = this._renderShell();
    this._bindEvents();
    await this._loadData();
  }

  _renderShell() {
    // Scroll approach: the outer view is the scroller (overflow-y:auto, position:absolute fills parent).
    // Toolbar is sticky so it stays visible while cards scroll under it.
    // This avoids nested flex height chain issues entirely.
    const viewStyle = 'position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;background:var(--bg-secondary);border-radius:var(--radius-md)';
    const toolbarStyle = 'position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border-color);background:var(--bg-secondary);flex-wrap:wrap';
    return `<div class="addressbook-view" style="${viewStyle}">
      <div class="ab-toolbar" style="${toolbarStyle}">
        <input class="ab-search" placeholder="Search bots by name, role, specialty..." id="abSearch">
        <select class="ab-filter-select" id="abFilter">
          <option value="all">All Bots</option>
          <option value="online">Online</option>
          <option value="degraded">Degraded</option>
          <option value="offline">Offline</option>
          <option value="unknown">Unknown</option>
        </select>
        <div class="ab-view-toggle" style="display:flex;gap:2px;border:1px solid var(--glass-border);border-radius:var(--radius-sm);overflow:hidden;flex-shrink:0">
          <button class="ab-view-btn active" id="abViewCard" title="Card view" style="padding:5px 10px;background:var(--accent-primary);border:none;color:#fff;font-size:13px;cursor:pointer;display:flex;align-items:center"><i class="ph ph-squares-four"></i></button>
          <button class="ab-view-btn" id="abViewList" title="List view" style="padding:5px 10px;background:transparent;border:none;color:var(--text-muted);font-size:13px;cursor:pointer;display:flex;align-items:center"><i class="ph ph-list"></i></button>
        </div>
        <button class="ab-create-btn" id="abCreateAgent" title="Create new agent" style="padding:5px 12px;border:1px solid var(--accent-primary);border-radius:var(--radius-sm);background:rgba(99,102,241,0.15);color:var(--accent-primary);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:4px;flex-shrink:0"><i class="ph ph-plus"></i> Agent</button>
        <span class="ab-count" id="abCount" style="font-size:var(--font-size-xs);color:var(--text-muted);white-space:nowrap">-- bots</span>
      </div>
      <div class="ab-grid" id="abGrid">
        <div class="dash-loading"><i class="ph ph-spinner-gap ph-spin" style="font-size:24px"></i> Loading agents...</div>
      </div>
    </div>`;
  }

  _bindEvents() {
    const search = this.container.querySelector('#abSearch');
    if (search) {
      let debounce;
      search.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          this.searchQuery = search.value.trim().toLowerCase();
          this._renderGrid();
        }, 200);
      });
    }

    this.container.querySelector('#abFilter')?.addEventListener('change', () => this._renderGrid());

    this.container.querySelector('#abViewCard')?.addEventListener('click', () => {
      this.viewMode = 'card';
      this._updateViewToggle();
      this._renderGrid();
    });

    this.container.querySelector('#abViewList')?.addEventListener('click', () => {
      this.viewMode = 'list';
      this._updateViewToggle();
      this._renderGrid();
    });

    this.container.querySelector('#abCreateAgent')?.addEventListener('click', () => this._showCreateAgentDialog());
  }

  _showCreateAgentDialog() {
    const backdrop = document.createElement('div');
    backdrop.className = 'delete-confirm-backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'cal-schedule-dialog';
    dialog.innerHTML = `<div class="cal-schedule-dialog-header">
      <h3><i class="ph ph-robot"></i> Create Agent</h3>
      <button class="cal-day-detail-close" id="factoryClose"><i class="ph ph-x"></i></button>
    </div>
    <div class="cal-schedule-dialog-body">
      <div class="cal-form-group"><label>Name</label><input type="text" id="factoryName" placeholder="e.g. security-auditor, ml-engineer"></div>
      <div class="cal-form-group"><label>Role</label><input type="text" id="factoryRole" placeholder="e.g. Security Specialist, ML Engineer"></div>
      <div class="cal-form-group"><label>Capabilities (comma-separated)</label><input type="text" id="factoryCaps" placeholder="security, auditing, compliance"></div>
      <div class="cal-form-group"><label>Routing Keywords (comma-separated)</label><input type="text" id="factoryKeywords" placeholder="security, audit, vulnerability, penetration"></div>
      <div class="cal-form-group"><label>Selector Description</label><textarea id="factorySelector" placeholder="Select this bot for security audits, vulnerability scanning, compliance checks..."></textarea></div>
      <div class="cal-form-group"><label>System Prompt</label><textarea id="factoryPrompt" rows="5" placeholder="You are a Senior Security Specialist. Your job is to..."></textarea></div>
    </div>
    <div class="cal-schedule-dialog-footer">
      <button class="cal-dialog-btn secondary" id="factoryCancel">Cancel</button>
      <button class="cal-dialog-btn primary" id="factoryCreate"><i class="ph ph-check"></i> Create</button>
    </div>`;

    document.body.appendChild(backdrop);
    document.body.appendChild(dialog);

    const close = () => { backdrop.remove(); dialog.remove(); };
    backdrop.addEventListener('click', close);
    dialog.querySelector('#factoryClose')?.addEventListener('click', close);
    dialog.querySelector('#factoryCancel')?.addEventListener('click', close);
    dialog.querySelector('#factoryCreate')?.addEventListener('click', async () => {
      await this._createAgent(dialog, close);
    });
  }

  async _createAgent(dialog, close) {
    const name = dialog.querySelector('#factoryName')?.value?.trim();
    const role = dialog.querySelector('#factoryRole')?.value?.trim();
    const caps = dialog.querySelector('#factoryCaps')?.value?.trim();
    const keywords = dialog.querySelector('#factoryKeywords')?.value?.trim();
    const selector = dialog.querySelector('#factorySelector')?.value?.trim();
    const prompt = dialog.querySelector('#factoryPrompt')?.value?.trim();

    if (!name || !role || !prompt) {
      this._showToast('Name, role, and system prompt are required', 'error');
      return;
    }

    const payload = {
      name: name.toLowerCase().replace(/\s+/g, '-'),
      role,
      systemPrompt: prompt,
      topology: 'localhost',
      capabilities: caps ? caps.split(',').map((c) => c.trim()).filter(Boolean) : [name],
      routingKeywords: keywords ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : [name],
      selectorDescriptor: selector || `Select this bot for ${role} tasks.`,
    };

    try {
      const result = await this.api.post('/api/swarm/agents', payload);
      close();
      this._showToast(`Agent "${name}" created`, 'success');
      await this._loadData();
    } catch (err) {
      this._showToast(`Failed: ${err.message || err}`, 'error');
    }
  }

  _showToast(message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  _updateViewToggle() {
    const cardBtn = this.container.querySelector('#abViewCard');
    const listBtn = this.container.querySelector('#abViewList');
    if (cardBtn) { cardBtn.style.background = this.viewMode === 'card' ? 'var(--accent-primary)' : 'transparent'; cardBtn.style.color = this.viewMode === 'card' ? '#fff' : 'var(--text-muted)'; }
    if (listBtn) { listBtn.style.background = this.viewMode === 'list' ? 'var(--accent-primary)' : 'transparent'; listBtn.style.color = this.viewMode === 'list' ? '#fff' : 'var(--text-muted)'; }
  }

  async _loadData() {
    const [agentsResult, registryResult] = await Promise.allSettled([
      this.api.getAgents(),
      this.api.getBotRegistry(),
    ]);

    const agentsPayload = agentsResult.status === 'fulfilled' ? agentsResult.value : {};
    const allAgents = Array.isArray(agentsPayload?.agents) ? agentsPayload.agents : (Array.isArray(agentsPayload) ? agentsPayload : []);
    const registry = registryResult.status === 'fulfilled' ? registryResult.value : {};
    const registryBots = Array.isArray(registry?.bots) ? registry.bots : [];
    this.health = this._buildHealthFromRegistry(registry);
    this.agents = this._mergeRegistryIntoAgents(allAgents, registryBots);
    this._renderGrid();
  }

  _mergeRegistryIntoAgents(agents, registryBots) {
    const registryByAgentId = new Map();
    const registryByName = new Map();
    for (const bot of registryBots) {
      if (bot?.agentId) registryByAgentId.set(bot.agentId, bot);
      if (bot?.name) registryByName.set(bot.name, bot);
    }
    return agents.map((agent) => {
      const id = agent.agentId || agent.agent_id || agent.name || '';
      const reg = registryByAgentId.get(id) || registryByName.get(agent.name) || {};
      return {
        ...agent,
        port: agent.port ?? reg.port ?? null,
        container: agent.container ?? reg.container ?? null,
        capabilities: agent.capabilities || reg.capabilities || [],
        lastHeartbeatAt: agent.lastHeartbeatAt ?? reg.lastHeartbeatAt ?? null,
        online: agent.online ?? reg.online ?? false,
      };
    });
  }

  _buildHealthFromRegistry(registry) {
    const bots = Array.isArray(registry?.bots) ? registry.bots : [];
    const agents = {};
    for (const bot of bots) {
      const id = bot?.agentId || bot?.name || '';
      if (!id) continue;
      agents[id] = { status: bot.online ? 'online' : 'offline' };
      if (bot.name && bot.name !== id) agents[bot.name] = agents[id];
    }
    return { agents };
  }

  _renderGrid() {
    const grid = this.container.querySelector('#abGrid');
    const count = this.container.querySelector('#abCount');
    if (!grid) return;

    const bots = this._filterBots();
    if (count) count.textContent = `${bots.length} bot${bots.length !== 1 ? 's' : ''}`;

    if (!bots.length) {
      grid.className = 'ab-grid';
      grid.innerHTML = '<div class="ticket-detail-empty" style="grid-column:1/-1"><i class="ph ph-users" style="font-size:48px;opacity:0.3"></i><span>No bots found</span></div>';
      return;
    }

    if (this.viewMode === 'list') {
      grid.className = 'ab-grid list-mode';
      grid.style.cssText = 'padding:8px 14px;display:flex;flex-direction:column;gap:4px';
      grid.innerHTML = bots.map((bot) => this._renderListRow(bot)).join('');
      this._bindListRows(grid);
    } else {
      grid.className = 'ab-grid';
      grid.style.cssText = 'padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px;align-content:start';
      grid.innerHTML = bots.map((bot) => this._renderBotCard(bot)).join('');
      this._bindActionButtons(grid);
    }
  }

  _filterBots() {
    const filter = this.container.querySelector('#abFilter')?.value || 'all';
    return this.agents
      .filter((bot) => filter === 'all' || this._resolveBotStatus(bot).status === filter)
      .filter((bot) => this._matchesSearch(bot));
  }

  _matchesSearch(bot) {
    if (!this.searchQuery) return true;
    const text = [bot.agent_id, bot.agentId, bot.name, bot.role, bot.specialty, bot.description]
      .map((v) => this._readString(v).toLowerCase()).join(' ');
    return text.includes(this.searchQuery);
  }

  // ── CARD MODE ────────────────────────────────────────────

  _renderBotCard(bot) {
    const { botId, displayName, role, backstory, capabilities, status, port, botUrl, heartbeat, container } = this._resolveBotMeta(bot);
    const workspaceUrl = this._buildWorkspaceUrl(botId, displayName);

    return `<div class="ab-card" data-bot-id="${botId}" style="cursor:pointer" title="Open ${displayName} workspace">
      <div class="ab-card-header">
        <div class="ab-avatar">
          ${displayName.charAt(0).toUpperCase()}
          <span class="ab-status-indicator ${status.status}"></span>
        </div>
        <div class="ab-card-info">
          <div class="ab-name">${displayName}</div>
          <div class="ab-bot-id">${botId !== (bot.name || botId) ? botId : ''}</div>
        </div>
      </div>
      ${backstory ? `<div class="ab-backstory">${backstory}</div>` : ''}
      ${capabilities.length ? `<div class="ab-tags">${capabilities.map((tag) => `<span class="ab-tag">${tag}</span>`).join('')}</div>` : ''}
      <div class="ab-props">
        <div class="ab-prop"><span class="ab-prop-label">Role</span><span class="ab-prop-value">${role}</span></div>
        <div class="ab-prop"><span class="ab-prop-label">Port</span><span class="ab-prop-value">${port ?? '--'}</span></div>
        <div class="ab-prop"><span class="ab-prop-label">Container</span><span class="ab-prop-value">${container}</span></div>
        <div class="ab-prop"><span class="ab-prop-label">Heartbeat</span><span class="ab-prop-value">${heartbeat}</span></div>
      </div>
      <div class="ab-vitals">
        <div class="ab-vital"><span class="ab-vital-value">${status.symbol}</span><span class="ab-vital-label">${status.label}</span></div>
      </div>
      <div class="ab-toggle-row">
        <label class="ab-toggle-switch">
          <input type="checkbox" ${status.status === 'online' ? 'checked' : ''} data-toggle-bot="${botId}">
          <span class="ab-toggle-track"></span>
        </label>
        <span class="ab-toggle-label">${status.status === 'online' ? '▶ Active' : '⏸ Inactive'}</span>
      </div>
      ${this._renderActionButtons(botId, botUrl)}
    </div>`;
  }

  // ── LIST MODE ────────────────────────────────────────────

  _renderListRow(bot) {
    const { botId, displayName, role, backstory, capabilities, status, port, botUrl, heartbeat, container } = this._resolveBotMeta(bot);

    const tagsHtml = capabilities.length
      ? `<div class="ab-detail-tags">${capabilities.map((t) => `<span class="ab-tag">${t}</span>`).join('')}</div>`
      : '';

    return `<div class="ab-list-row" data-bot-id="${botId}">
      <div class="ab-list-summary">
        <span class="ab-list-dot ${status.status}"></span>
        <span class="ab-list-name">${displayName}</span>
        <span class="ab-list-role">${role}</span>
        <div class="ab-list-meta">
          <span class="ab-list-meta-item"><i class="ph ph-plug"></i>${port ?? '--'}</span>
          <span class="ab-list-meta-item"><i class="ph ph-heartbeat"></i>${heartbeat}</span>
          <span class="ab-list-meta-item"><i class="ph ph-cube"></i>${container}</span>
        </div>
        <i class="ph ph-caret-right ab-list-chevron"></i>
      </div>
      <div class="ab-list-detail">
        ${backstory ? `<div class="ab-detail-backstory">${backstory}</div>` : ''}
        <div class="ab-detail-props">
          <div class="ab-detail-prop"><span class="ab-detail-prop-label">Agent ID</span><span class="ab-detail-prop-value">${botId}</span></div>
          <div class="ab-detail-prop"><span class="ab-detail-prop-label">Role</span><span class="ab-detail-prop-value">${role}</span></div>
          <div class="ab-detail-prop"><span class="ab-detail-prop-label">Port</span><span class="ab-detail-prop-value">${port ?? '--'}</span></div>
          <div class="ab-detail-prop"><span class="ab-detail-prop-label">Container</span><span class="ab-detail-prop-value">${container}</span></div>
          <div class="ab-detail-prop"><span class="ab-detail-prop-label">Status</span><span class="ab-detail-prop-value">${status.label}</span></div>
          <div class="ab-detail-prop"><span class="ab-detail-prop-label">Last Heartbeat</span><span class="ab-detail-prop-value">${heartbeat}</span></div>
        </div>
        ${tagsHtml}
        ${this._renderActionButtons(botId, botUrl)}
      </div>
    </div>`;
  }

  _bindListRows(grid) {
    grid.querySelectorAll('.ab-list-summary').forEach((summary) => {
      summary.addEventListener('click', (event) => {
        if (event.target.closest('.ab-action-btn')) return;
        const row = summary.closest('.ab-list-row');
        row?.classList.toggle('expanded');
      });
    });
    this._bindActionButtons(grid);
    this._bindToggleSwitches(grid);
  }

  /**
   * @description Toggle bot active/inactive status via PATCH API.
   * @param agentId - Bot agent identifier.
   * @param active - Whether bot should be active.
   */
  async _toggleBotStatus(agentId, active) {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: active ? 'active' : 'inactive' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        this._logError('toggleBotStatus', err, { agentId, active });
      }
      await this._loadData();
    } catch (err) {
      this._logError('toggleBotStatus', err, { agentId });
    }
  }

  /**
   * @description Binds toggle switch change events to _toggleBotStatus.
   */
  _bindToggleSwitches(grid) {
    grid.querySelectorAll('[data-toggle-bot]').forEach((input) => {
      input.addEventListener('change', (event) => {
        event.stopPropagation();
        this._toggleBotStatus(input.dataset.toggleBot, input.checked);
      });
      // Prevent card click when toggling
      input.addEventListener('click', (event) => event.stopPropagation());
    });
  }

  // ── SHARED ───────────────────────────────────────────────

  _resolveBotMeta(bot) {
    const botId = bot.agent_id || bot.agentId || bot.name || '';
    const botName = bot.name || botId;
    const displayName = botName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const role = bot.role || bot.specialty || bot.description || 'AI Agent';
    const backstory = bot.backstory || '';
    const capabilities = bot.capabilities || bot.keywords || bot.tags || [];
    const status = this._resolveBotStatus(bot);
    const port = bot.port || null;
    const botUrl = port ? `http://localhost:${port}` : '';
    const heartbeat = bot.lastHeartbeatAt ? this._formatHeartbeat(bot.lastHeartbeatAt) : '--';
    const container = bot.container || '--';
    return { botId, displayName, role, backstory, capabilities, status, port, botUrl, heartbeat, container };
  }

  _renderActionButtons(botId, botUrl) {
    const workspaceUrl = this._buildWorkspaceUrl(botId);
    return `<div class="ab-actions">
      <a class="ab-action-btn primary" href="${workspaceUrl}" title="Open Workspace"><i class="ph ph-chats-circle"></i></a>
      <button class="ab-action-btn" data-action="message" data-bot="${botId}" title="Message"><i class="ph ph-paper-plane-tilt"></i></button>
      <button class="ab-action-btn" data-action="settings" data-bot="${botId}" title="Settings"><i class="ph ph-gear"></i></button>
      <button class="ab-action-btn" data-action="ticket" data-bot="${botId}" title="Ticket"><i class="ph ph-note-pencil"></i></button>
      <button class="ab-action-btn" data-action="activity" data-bot="${botId}" title="Activity"><i class="ph ph-chart-line"></i></button>
    </div>`;
  }

  _bindActionButtons(grid) {
    grid.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const { action, bot: botId } = button.dataset;
        if (action === 'message' && this.onMessageBot) this.onMessageBot(botId);
        if (action === 'ticket' && this.onCreateTicket) this.onCreateTicket(botId);
        if (action === 'settings') this._openBotSettings(botId);
        if (action === 'activity') this._handleActivity(botId);
      });
    });

    // Make whole card clickable in card mode
    grid.querySelectorAll('.ab-card[data-bot-id]').forEach((card) => {
      card.addEventListener('click', (event) => {
        if (event.target.closest('.ab-action-btn') || event.target.closest('a') || event.target.closest('button')) return;
        const botId = card.dataset.botId;
        if (botId) window.location.assign(this._buildWorkspaceUrl(botId));
      });
    });
  }

  /**
   * @description Builds a /swarmbot/chat URL for the given bot that loads the full persona.
   * @param botId - Agent ID or bot name
   * @param label - Optional display label
   * @returns URL string
   */
  _buildWorkspaceUrl(botId, label) {
    const url = new URL('/swarmbot/chat', window.location.origin);
    url.searchParams.set('agentId', botId);
    if (label) url.searchParams.set('agentLabel', label);
    return url.toString();
  }

  /**
   * @description Opens the bot-scoped config page for the given agent.
   * @param botId - Agent ID
   */
  _openBotSettings(botId) {
    const url = new URL('/config/', window.location.origin);
    url.searchParams.set('agentId', botId);
    window.location.assign(url.toString());
  }

  _formatHeartbeat(isoString) {
    try {
      const delta = Date.now() - new Date(isoString).getTime();
      if (delta < 60000) return 'just now';
      if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`;
      if (delta < 86400000) return `${Math.floor(delta / 3600000)}h ago`;
      return `${Math.floor(delta / 86400000)}d ago`;
    } catch {
      return '--';
    }
  }

  _resolveBotStatus(bot) {
    const agentId = bot.agent_id || bot.agentId || bot.name;
    const healthMap = this.health.agents || this.health.services || {};
    const state = this._readString(healthMap[agentId]?.status).toLowerCase();
    if (state === 'healthy' || state === 'online') return { status: 'online', label: 'Online', symbol: '✓' };
    if (state === 'degraded') return { status: 'degraded', label: 'Degraded', symbol: '!' };
    if (state === 'offline') return { status: 'offline', label: 'Offline', symbol: '✗' };
    return { status: 'unknown', label: 'Unknown', symbol: '?' };
  }

  _handleActivity(botId) {
    if (this.onViewActivity) this.onViewActivity(botId);
    this._focusCalendarFilter(botId, 0);
  }

  _focusCalendarFilter(botId, attempt) {
    const filter = document.getElementById('calBotFilter');
    if (filter && Array.from(filter.options).some((opt) => opt.value === botId)) {
      filter.value = botId;
      filter.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (attempt >= 10) return;
    window.setTimeout(() => this._focusCalendarFilter(botId, attempt + 1), 150);
  }

  destroy() {
    if (this.container) this.container.innerHTML = '';
  }

  _logError(action, error, context = {}) {
    console.error(JSON.stringify({
      level: 'error', module: 'cockpit-addressbook-view', action, ...context,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));
  }

  _readString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }
}

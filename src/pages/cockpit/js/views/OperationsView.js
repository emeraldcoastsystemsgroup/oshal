/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Consolidated Operations view — replaces 6 iframe engineering screens with one native glass-themed panel. Principle of one: single ops surface for pipeline, agents, work items, cost, and health.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Agent cards show lastActivity/successRate/tokens; Cost tab adds per-model breakdown; Work tab adds run duration; Overview adds routing failures KPI.
 */

import { ApiClient } from '../api-client.js';
import { createUiLogger } from '../../../shared/ui-debug.js';
import { formatCost } from '../utils/formatters.js';

const logger = createUiLogger('cockpit-operations-view');

/**
 * @description Single consolidated Operations panel for the cockpit that replaces the legacy
 * iframe engineering screens. Renders a tabbed glass-themed surface (Overview, Agents, Work Items,
 * Cost) over swarm metrics, agent registry/telemetry, work items, runs, and quartermaster activity,
 * polling the API on an interval so the operator has one live view of pipeline, fleet, cost, and health.
 */
export class OperationsView {
  /**
   * @description Resolves the host element and initializes view state (API client, cached data,
   * the default active tab, and the refresh timer handle) without performing any rendering yet.
   * @param {string|HTMLElement} container - The container element, or the id of the element, that hosts the view.
   */
  constructor(container) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.api = new ApiClient();
    this.data = {};
    this.activeTab = 'overview';
    this.refreshTimer = null;
  }

  /**
   * @description Paints the shell markup, wires up tab/refresh navigation, loads the initial data,
   * and starts a 30-second auto-refresh loop so the panel stays current while open.
   * @returns {Promise<void>} Resolves once the initial data load and render complete.
   */
  async render() {
    if (!this.container) return;
    this.container.innerHTML = this._shell();
    this._bindNav();
    await this._loadAndRender();
    this.refreshTimer = setInterval(() => this._loadAndRender(), 30000);
  }

  /**
   * @description Tears the view down by stopping the auto-refresh interval and clearing the
   * container markup, preventing background polling and leftover DOM after the view is dismissed.
   * @returns {void}
   */
  destroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.container) this.container.innerHTML = '';
  }

  _shell() {
    return `<div class="ops-view">
      <div class="ops-header">
        <div class="ops-title"><i class="ph ph-gauge"></i> Operations</div>
        <div class="ops-nav">
          <button class="ops-tab active" data-tab="overview">Overview</button>
          <button class="ops-tab" data-tab="agents">Agents</button>
          <button class="ops-tab" data-tab="work">Work Items</button>
          <button class="ops-tab" data-tab="cost">Cost</button>
        </div>
        <button class="ops-refresh" id="opsRefresh"><i class="ph ph-arrow-clockwise"></i></button>
      </div>
      <div class="ops-body" id="opsBody"><div class="ops-loading"><i class="ph ph-spinner-gap ph-spin"></i></div></div>
    </div>`;
  }

  _bindNav() {
    this.container.querySelectorAll('.ops-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.container.querySelectorAll('.ops-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeTab = btn.dataset.tab;
        this._renderBody();
      });
    });
    this.container.querySelector('#opsRefresh')?.addEventListener('click', () => this._loadAndRender());
  }

  async _loadAndRender() {
    const [metrics, agents, registry, workItems, runs, qmActivity, queueHealth] = await Promise.allSettled([
      this.api.getSafe('/api/v1/metrics/summary', {}),
      this.api.getSafe('/api/v1/metrics/agents', { agents: [] }),
      this.api.getSafe('/api/swarm/bots/registry', { bots: [] }),
      this.api.getSafe('/api/swarm/work-items', { items: [] }),
      this.api.getSafe('/api/swarm/runs', { runs: [] }),
      this.api.getSafe('/api/qm/activity', {}),
      this.api.getSafe('/api/v1/metrics/queue-health?scope=all', { success: false, data: null }),
    ]);
    this.data = {
      metrics: this._settled(metrics, {}),
      agents: this._settled(agents, { agents: [] }),
      registry: this._settled(registry, { bots: [] }),
      workItems: this._settled(workItems, { items: [] }),
      runs: this._settled(runs, { runs: [] }),
      qmActivity: this._settled(qmActivity, {}),
      queueHealth: this._settled(queueHealth, { success: false, data: null }),
    };
    this._renderBody();
  }

  _settled(r, fallback) { return r.status === 'fulfilled' && r.value ? r.value : fallback; }
  _m() { return this.data.metrics?.data || this.data.metrics || {}; }
  _q() { return this.data.queueHealth?.data || this.data.queueHealth || null; }

  // Build merged agent list: registry has harness/api/model, agents API has cost/tokens/activity
  _mergedAgents() {
    const regBots = this.data.registry?.bots || [];
    const agentMetrics = this.data.agents?.agents || [];
    const metricsById = new Map(agentMetrics.map((a) => [a.agentId, a]));
    const metricsByName = new Map(agentMetrics.map((a) => [a.name, a]));

    return regBots.map((bot) => {
      const m = metricsById.get(bot.agentId) || metricsByName.get(bot.name) || {};
      const tel = bot.telemetry || {};
      return {
        ...bot,
        totalCost: m.totalCost || tel.totalCost || 0,
        totalRequests: m.totalRequests || tel.totalRequests || 0,
        totalInputTokens: m.totalInputTokens || tel.totalInputTokens || 0,
        totalOutputTokens: m.totalOutputTokens || tel.totalOutputTokens || 0,
        successRate: m.successRate || 0,
        lastActivityAt: m.lastActivityAt || tel.updatedAt || null,
        latestModel: tel.latestModel || m.latestModel || null,
      };
    });
  }

  _renderBody() {
    const body = this.container.querySelector('#opsBody');
    if (!body) return;
    switch (this.activeTab) {
      case 'overview': body.innerHTML = this._renderOverview(); break;
      case 'agents':   body.innerHTML = this._renderAgents();   break;
      case 'work':     body.innerHTML = this._renderWorkItems(); break;
      case 'cost':     body.innerHTML = this._renderCost();     break;
    }
  }

  // ── OVERVIEW TAB ─────────────────────────────────────────────────

  _renderOverview() {
    const m = this._m();
    const health = m.swarmHealth || {};
    const agents = m.agents || {};
    const qm = this.data.qmActivity || {};
    const queue = this._q();
    const routingFailures = Array.isArray(qm.routingFailures) ? qm.routingFailures.length : 0;
    const agentList = this.data.agents?.agents || [];
    const totalCost = agentList.reduce((s, a) => s + (a.totalCost || 0), 0) || (m.estimatedTotalCost || 0);
    return `
      ${this._renderKPIStrip(m, health, agents, totalCost, routingFailures, queue)}
      <div class="ops-grid-2">
        ${this._renderPipelineFlow(m)}
        ${this._renderHealthRing(health)}
      </div>
      ${this._renderQueueHealth(queue)}
      ${this._renderRecentWork()}
    `;
  }

  _renderKPIStrip(m, health, agents, totalCost, routingFailures, queue) {
    const queueStatus = typeof queue?.status === 'string' ? queue.status : 'unknown';
    const queueColor = _queueStatusColor(queueStatus);
    const kpis = [
      { label: 'Online',    value: agents.online ?? health.healthy ?? 0, icon: 'ph-robot',          accent: '#34d399' },
      { label: 'Busy',      value: agents.busy ?? 0,                     icon: 'ph-lightning',       accent: '#fbbf24' },
      { label: 'Offline',   value: health.offline ?? 0,                  icon: 'ph-power',           accent: '#ef4444' },
      { label: 'Tickets',   value: m.total ?? 0,                         icon: 'ph-ticket',          accent: '#60a5fa' },
      { label: 'Escalated', value: m.escalations ?? 0,                   icon: 'ph-warning-circle',  accent: '#f97316' },
      { label: 'Queue',     value: queueStatus,                          icon: 'ph-list-checks',     accent: queueColor },
      { label: 'Total Cost',value: formatCost(totalCost),                icon: 'ph-currency-dollar', accent: '#a78bfa' },
      ...(routingFailures > 0
        ? [{ label: 'Routing Fails', value: routingFailures, icon: 'ph-x-circle', accent: '#ef4444' }]
        : []),
    ];
    return `<div class="ops-kpi-strip">${kpis.map((k) => `
      <div class="ops-kpi">
        <div class="ops-kpi-icon" style="color:${k.accent}"><i class="ph ${k.icon}"></i></div>
        <div class="ops-kpi-value">${k.value}</div>
        <div class="ops-kpi-label">${k.label}</div>
      </div>`).join('')}
    </div>`;
  }

  _renderQueueHealth(queue) {
    if (!queue || !queue.generatedAt) {
      return `<div class="ops-card ops-queue-card">
        <div class="ops-card-title">Queue Health</div>
        <div class="ops-empty">Queue health unavailable</div>
      </div>`;
    }
    const status = queue.status || 'unknown';
    const totals = queue.totals || {};
    const work = queue.workItems || {};
    const blockers = Array.isArray(queue.recentBlockers) ? queue.recentBlockers.slice(0, 6) : [];
    const actions = Array.isArray(queue.actions) ? queue.actions.slice(0, 4) : [];
    const byStatus = work.byStatus || {};
    const workPairs = Object.entries(byStatus).slice(0, 8);
    return `<div class="ops-card ops-queue-card ops-queue-card--${status}">
      <div class="ops-queue-head">
        <div>
          <div class="ops-card-title">Queue Health</div>
          <div class="ops-queue-generated">${this._relTime(queue.generatedAt)}</div>
        </div>
        <span class="ops-queue-status" style="--queue-color:${_queueStatusColor(status)}">${status}</span>
      </div>
      <div class="ops-queue-stats">
        ${this._queueStat('Backlog', totals.backlog ?? 0, totals.staleBacklog ?? 0)}
        ${this._queueStat('Approved', totals.approved ?? 0, totals.staleApproved ?? 0)}
        ${this._queueStat('In Process', totals.inProcess ?? 0, totals.staleInProcess ?? 0)}
        ${this._queueStat('Build Open', totals.buildOpen ?? 0, totals.buildEscalated ?? 0)}
        ${this._queueStat('Provider Stalls', totals.providerRuntimeStalled ?? 0, totals.providerRuntimeStalled ?? 0)}
        ${this._queueStat('Unassigned Esc', totals.unassignedEscalated ?? 0, totals.unassignedEscalated ?? 0)}
        ${this._queueStat('Routing Failed', work.routingFailed ?? 0, work.routingFailed ?? 0, `hist ${work.historicalRoutingFailed ?? 0}`)}
      </div>
      ${workPairs.length ? `<div class="ops-work-statuses">${workPairs.map(([name, value]) => `
        <span class="ops-work-status"><b>${value}</b>${name.replace(/_/g, ' ')}</span>
      `).join('')}</div>` : ''}
      ${blockers.length ? `<div class="ops-queue-blockers">
        ${blockers.map((b) => `<div class="ops-queue-blocker">
          <span>${this._statusBadge(b.status)}</span>
          <span class="ops-queue-blocker-title">${this._escape(b.title || b.ticketId || 'Untitled')}</span>
          <span class="ops-queue-blocker-meta">${_fmtAge(b.ageMinutes)} - ${(b.reason || 'blocked').replace(/_/g, ' ')}</span>
        </div>`).join('')}
      </div>` : '<div class="ops-empty ops-empty--compact">No queue blockers in the scanned window</div>'}
      ${actions.length ? `<div class="ops-queue-actions">${actions.map((action) => `
        <div class="ops-queue-action"><i class="ph ph-arrow-right"></i><span>${this._escape(action)}</span></div>
      `).join('')}</div>` : ''}
    </div>`;
  }

  _queueStat(label, value, flagged, hint = '') {
    const color = flagged > 0 ? '#ef4444' : '#34d399';
    return `<div class="ops-queue-stat">
      <span class="ops-queue-stat-value" style="color:${color}">${value}</span>
      <span class="ops-queue-stat-label">${label}</span>
      ${flagged > 0 ? `<span class="ops-queue-stat-flag">${flagged} flagged</span>` : ''}
      ${hint ? `<span class="ops-queue-stat-flag">${this._escape(hint)}</span>` : ''}
    </div>`;
  }

  _renderPipelineFlow(m) {
    const stages = [
      { label: 'Backlog',     count: m.backlog     ?? 0, color: '#6b7280' },
      { label: 'In Progress', count: m.inProgress  ?? 0, color: '#60a5fa' },
      { label: 'In Review',   count: m.inReview    ?? 0, color: '#a78bfa' },
      { label: 'Escalated',   count: m.escalations ?? 0, color: '#f97316' },
      { label: 'Complete',    count: m.done        ?? 0, color: '#34d399' },
    ];
    const max = Math.max(...stages.map((s) => s.count), 1);
    return `<div class="ops-card">
      <div class="ops-card-title">Pipeline Flow</div>
      <div class="ops-pipeline">${stages.map((s) => {
        const pct = Math.round((s.count / max) * 100);
        return `<div class="ops-pipeline-stage">
          <div class="ops-pipeline-bar" style="width:${Math.max(pct, 4)}%;background:${s.color}"></div>
          <div class="ops-pipeline-label">${s.label}</div>
          <div class="ops-pipeline-count" style="color:${s.color}">${s.count}</div>
        </div>`;
      }).join('')}</div>
    </div>`;
  }

  _renderHealthRing(health) {
    const total = (health.healthy || 0) + (health.degraded || 0) + (health.offline || 0);
    const pct = total > 0 ? Math.round(((health.healthy || 0) / total) * 100) : 0;
    return `<div class="ops-card ops-health-card">
      <div class="ops-card-title">Swarm Health</div>
      <div class="ops-health-ring">
        <svg viewBox="0 0 120 120" class="ops-ring-svg">
          <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="10"/>
          <circle cx="60" cy="60" r="50" fill="none" stroke="#34d399" stroke-width="10"
            stroke-dasharray="${pct * 3.14} ${(100 - pct) * 3.14}"
            stroke-dashoffset="0" stroke-linecap="round" transform="rotate(-90 60 60)"/>
          <text x="60" y="56" text-anchor="middle" fill="white" font-size="28" font-weight="700">${pct}%</text>
          <text x="60" y="74" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="11">healthy</text>
        </svg>
      </div>
      <div class="ops-health-legend">
        <span><i class="ph ph-circle-fill" style="color:#34d399"></i> ${health.healthy ?? 0} online</span>
        <span><i class="ph ph-circle-fill" style="color:#fbbf24"></i> ${health.degraded ?? 0} degraded</span>
        <span><i class="ph ph-circle-fill" style="color:#ef4444"></i> ${health.offline ?? 0} offline</span>
      </div>
    </div>`;
  }

  _renderRecentWork() {
    const raw = this.data.workItems;
    const items = (Array.isArray(raw) ? raw : (raw?.items || raw?.workItems || [])).slice(0, 8);
    if (items.length === 0) return '<div class="ops-card"><div class="ops-card-title">Recent Work</div><div class="ops-empty">No recent work items</div></div>';
    return `<div class="ops-card">
      <div class="ops-card-title">Recent Work Items</div>
      <table class="ops-table"><thead><tr>
        <th>Status</th><th>Ticket</th><th>Agent</th><th>Updated</th>
      </tr></thead><tbody>${items.map((w) => `<tr>
        <td>${this._statusBadge(w.status)}</td>
        <td class="ops-mono">${(w.externalId || w.external_id || '').slice(0, 20)}</td>
        <td>${this._agentName(w.assignedAgentId || w.assigned_agent_id)}</td>
        <td>${this._relTime(w.updatedAt || w.updated_at)}</td>
      </tr>`).join('')}</tbody></table>
    </div>`;
  }

  // ── AGENTS TAB ───────────────────────────────────────────────────

  _renderAgents() {
    const bots = this._mergedAgents();
    if (bots.length === 0) return '<div class="ops-card"><div class="ops-empty">No bots registered</div></div>';

    // Sort: online first, then by last activity
    const sorted = [...bots].sort((a, b) => {
      if (a.online !== b.online) return b.online ? 1 : -1;
      return (new Date(b.lastActivityAt || 0).getTime()) - (new Date(a.lastActivityAt || 0).getTime());
    });

    return `<div class="ops-card">
      <div class="ops-card-title">Agent Fleet (${bots.length})</div>
      <div class="ops-agent-grid">${sorted.map((b) => this._renderAgentCard(b)).join('')}</div>
    </div>`;
  }

  _renderAgentCard(bot) {
    const status = bot.dbStatus === 'inactive' ? 'disabled' : (bot.online ? 'online' : 'offline');
    const colors = { online: '#34d399', offline: '#ef4444', disabled: '#6b7280' };
    const harness = bot.harnessType || 'cline';
    const api = bot.apiType || 'openai-codex';
    const model = bot.latestModel || '—';
    const tokens = (bot.totalInputTokens || 0) + (bot.totalOutputTokens || 0);
    const successPct = bot.successRate > 0 ? Math.round(bot.successRate * 100) : null;
    const successColor = successPct === null ? '#6b7280' : (successPct >= 90 ? '#34d399' : successPct >= 70 ? '#fbbf24' : '#ef4444');

    return `<div class="ops-agent-card ${status}">
      <div class="ops-agent-header">
        <span class="ops-agent-dot" style="background:${colors[status]}"></span>
        <span class="ops-agent-name">${bot.name}</span>
        <span class="ops-agent-status">${status}</span>
      </div>
      <div class="ops-agent-meta">
        <span title="Harness"><i class="ph ph-gear"></i> ${harness}</span>
        <span title="API provider"><i class="ph ph-cloud"></i> ${api}</span>
        <span title="Last model used"><i class="ph ph-cpu"></i> ${model}</span>
      </div>
      <div class="ops-agent-meta">
        <span title="Total requests"><i class="ph ph-lightning"></i> ${bot.totalRequests || 0} req</span>
        <span title="Total cost"><i class="ph ph-currency-dollar"></i> ${formatCost(bot.totalCost || 0)}</span>
        ${tokens > 0 ? `<span title="Total tokens"><i class="ph ph-text-aa"></i> ${_fmtTokens(tokens)}</span>` : ''}
      </div>
      <div class="ops-agent-meta">
        ${successPct !== null ? `<span title="Success rate" style="color:${successColor}"><i class="ph ph-check-circle"></i> ${successPct}%</span>` : ''}
        ${bot.lastActivityAt ? `<span title="Last active"><i class="ph ph-clock"></i> ${this._relTime(bot.lastActivityAt)}</span>` : ''}
      </div>
    </div>`;
  }

  // ── WORK ITEMS TAB ───────────────────────────────────────────────

  _renderWorkItems() {
    const rawWI = this.data.workItems;
    const items = Array.isArray(rawWI) ? rawWI : (rawWI?.items || rawWI?.workItems || []);
    const rawRuns = this.data.runs;
    const runs = Array.isArray(rawRuns) ? rawRuns : (rawRuns?.runs || []);
    return `
      ${this._renderWorkTable(items)}
      ${this._renderRunsTable(runs)}
    `;
  }

  _renderWorkTable(items) {
    if (items.length === 0) return '<div class="ops-card"><div class="ops-card-title">Work Items</div><div class="ops-empty">No work items</div></div>';
    return `<div class="ops-card">
      <div class="ops-card-title">Work Items (${items.length})</div>
      <table class="ops-table"><thead><tr>
        <th>Status</th><th>External ID</th><th>Agent</th><th>Phase</th><th>Updated</th>
      </tr></thead><tbody>${items.slice(0, 25).map((w) => `<tr>
        <td>${this._statusBadge(w.status)}</td>
        <td class="ops-mono">${(w.externalId || w.external_id || '').slice(0, 24)}</td>
        <td>${this._agentName(w.assignedAgentId || w.assigned_agent_id)}</td>
        <td>${w.phase || '—'}</td>
        <td>${this._relTime(w.updatedAt || w.updated_at)}</td>
      </tr>`).join('')}</tbody></table>
    </div>`;
  }

  _renderRunsTable(runs) {
    if (runs.length === 0) return '';
    return `<div class="ops-card">
      <div class="ops-card-title">Recent Runs (${runs.length})</div>
      <table class="ops-table"><thead><tr>
        <th>Status</th><th>Run ID</th><th>Tickets</th><th>Duration</th><th>Started</th>
      </tr></thead><tbody>${runs.slice(0, 10).map((r) => {
        const duration = _runDuration(r.startedAt || r.started_at, r.completedAt || r.completed_at);
        return `<tr>
          <td>${this._statusBadge(r.status)}</td>
          <td class="ops-mono" title="${r.runId || r.run_id || ''}">${(r.runId || r.run_id || '').slice(0, 12)}</td>
          <td>${r.processedCount ?? r.processed_count ?? r.itemCount ?? '—'}</td>
          <td>${duration}</td>
          <td>${this._relTime(r.startedAt || r.started_at)}</td>
        </tr>`;
      }).join('')}</tbody></table>
    </div>`;
  }

  // ── COST TAB ─────────────────────────────────────────────────────

  _renderCost() {
    const agentList = this.data.agents?.agents || [];
    const m = this._m();
    const costSeries = m.costSeries || [];
    const agentTotal = agentList.reduce((s, a) => s + (a.totalCost || 0), 0);
    return `
      ${this._renderCostSummary(m, agentTotal)}
      ${this._renderCostByModel()}
      ${this._renderCostByAgent(agentList)}
      ${this._renderCostTimeline(costSeries)}
    `;
  }

  _renderCostSummary(m, agentTotal) {
    const totalSpend = agentTotal > 0 ? agentTotal : (m.estimatedTotalCost || 0);
    const agentList = this.data.agents?.agents || [];
    const totalTokens = agentList.reduce((s, a) => s + (a.totalInputTokens || 0) + (a.totalOutputTokens || 0), 0);
    const totalRequests = agentList.reduce((s, a) => s + (a.totalRequests || 0), 0);
    return `<div class="ops-kpi-strip">
      <div class="ops-kpi">
        <div class="ops-kpi-icon" style="color:#a78bfa"><i class="ph ph-currency-dollar"></i></div>
        <div class="ops-kpi-value">${formatCost(totalSpend)}</div>
        <div class="ops-kpi-label">Total Spend</div>
      </div>
      <div class="ops-kpi">
        <div class="ops-kpi-icon" style="color:#60a5fa"><i class="ph ph-ticket"></i></div>
        <div class="ops-kpi-value">${m.total ?? 0}</div>
        <div class="ops-kpi-label">Tickets</div>
      </div>
      <div class="ops-kpi">
        <div class="ops-kpi-icon" style="color:#34d399"><i class="ph ph-check-circle"></i></div>
        <div class="ops-kpi-value">${m.done ?? 0}</div>
        <div class="ops-kpi-label">Completed</div>
      </div>
      <div class="ops-kpi">
        <div class="ops-kpi-icon" style="color:#fbbf24"><i class="ph ph-text-aa"></i></div>
        <div class="ops-kpi-value">${_fmtTokens(totalTokens)}</div>
        <div class="ops-kpi-label">Total Tokens</div>
      </div>
      <div class="ops-kpi">
        <div class="ops-kpi-icon" style="color:#38bdf8"><i class="ph ph-lightning"></i></div>
        <div class="ops-kpi-value">${totalRequests}</div>
        <div class="ops-kpi-label">API Requests</div>
      </div>
    </div>`;
  }

  // Per-model cost breakdown — proves cross-API cost rollup
  _renderCostByModel() {
    const qm = this.data.qmActivity || {};
    const modelUsage = qm.modelUsage || {};
    const entries = Object.values(modelUsage)
      .filter((m) => (m.totalCost || 0) > 0 || (m.totalTokens || 0) > 0)
      .sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0));

    if (entries.length === 0) {
      // Fallback: derive model breakdown from agent telemetry
      return this._renderCostByModelFromTelemetry();
    }

    const maxCost = Math.max(...entries.map((e) => e.totalCost || 0), 0.001);
    return `<div class="ops-card">
      <div class="ops-card-title">Cost by Model — Cross-API Breakdown</div>
      <div class="ops-cost-bars">${entries.map((e) => {
        const pct = Math.round(((e.totalCost || 0) / maxCost) * 100);
        const model = e.modelId || '—';
        const provider = _inferProvider(model);
        return `<div class="ops-cost-row">
          <div class="ops-cost-name-col">
            <span class="ops-cost-name">${model}</span>
            <span class="ops-cost-sub">${provider} · ${e.requestCount || 0} req · ${_fmtTokens(e.totalTokens || 0)} tok</span>
          </div>
          <div class="ops-cost-bar-wrap"><div class="ops-cost-bar ops-cost-bar--model" style="width:${Math.max(pct, 3)}%;background:${_modelColor(model)}"></div></div>
          <span class="ops-cost-amount">${formatCost(e.totalCost || 0)}</span>
        </div>`;
      }).join('')}</div>
    </div>`;
  }

  _renderCostByModelFromTelemetry() {
    // Aggregate usage_by_model across all registry bots from their telemetry
    const regBots = this.data.registry?.bots || [];
    const modelMap = new Map();
    for (const bot of regBots) {
      const ubm = bot.telemetry?.usageByModel || {};
      for (const [modelId, stats] of Object.entries(ubm)) {
        const existing = modelMap.get(modelId) || { modelId, totalCost: 0, totalTokens: 0, requestCount: 0 };
        existing.totalCost += stats.totalCost || 0;
        existing.totalTokens += (stats.totalTokens || 0) || ((stats.inputTokens || 0) + (stats.outputTokens || 0));
        existing.requestCount += stats.requestCount || 0;
        modelMap.set(modelId, existing);
      }
    }
    const entries = [...modelMap.values()].filter((e) => e.totalCost > 0 || e.totalTokens > 0)
      .sort((a, b) => b.totalCost - a.totalCost);

    if (entries.length === 0) {
      return '<div class="ops-card"><div class="ops-card-title">Cost by Model</div><div class="ops-empty">No model cost data yet — run a swarm ticket to populate</div></div>';
    }

    const maxCost = Math.max(...entries.map((e) => e.totalCost || 0), 0.001);
    return `<div class="ops-card">
      <div class="ops-card-title">Cost by Model — Cross-API Breakdown</div>
      <div class="ops-cost-bars">${entries.map((e) => {
        const pct = Math.round(((e.totalCost || 0) / maxCost) * 100);
        const provider = _inferProvider(e.modelId);
        return `<div class="ops-cost-row">
          <div class="ops-cost-name-col">
            <span class="ops-cost-name">${e.modelId}</span>
            <span class="ops-cost-sub">${provider} · ${e.requestCount} req · ${_fmtTokens(e.totalTokens)} tok</span>
          </div>
          <div class="ops-cost-bar-wrap"><div class="ops-cost-bar ops-cost-bar--model" style="width:${Math.max(pct, 3)}%;background:${_modelColor(e.modelId)}"></div></div>
          <span class="ops-cost-amount">${formatCost(e.totalCost)}</span>
        </div>`;
      }).join('')}</div>
    </div>`;
  }

  _renderCostByAgent(agents) {
    const withCost = agents.filter((a) => (a.totalCost || 0) > 0).sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0));
    if (withCost.length === 0) return '<div class="ops-card"><div class="ops-card-title">Cost by Agent</div><div class="ops-empty">No cost data yet</div></div>';
    const max = Math.max(...withCost.map((a) => a.totalCost || 0), 0.01);
    return `<div class="ops-card">
      <div class="ops-card-title">Cost by Agent</div>
      <div class="ops-cost-bars">${withCost.slice(0, 10).map((a) => {
        const pct = Math.round(((a.totalCost || 0) / max) * 100);
        const tokens = (a.totalInputTokens || 0) + (a.totalOutputTokens || 0);
        return `<div class="ops-cost-row">
          <div class="ops-cost-name-col">
            <span class="ops-cost-name">${this._agentName(a.agentId)}</span>
            ${tokens > 0 ? `<span class="ops-cost-sub">${_fmtTokens(tokens)} tok · ${a.totalRequests || 0} req</span>` : ''}
          </div>
          <div class="ops-cost-bar-wrap"><div class="ops-cost-bar" style="width:${Math.max(pct, 3)}%"></div></div>
          <span class="ops-cost-amount">${formatCost(a.totalCost || 0)}</span>
        </div>`;
      }).join('')}</div>
    </div>`;
  }

  _renderCostTimeline(series) {
    if (!series.length) return '';
    const max = Math.max(...series.map((s) => s.amount || 0), 0.001);
    return `<div class="ops-card">
      <div class="ops-card-title">Spend by Hour (24h)</div>
      <div class="ops-timeline">${series.map((s) => {
        const h = Math.max(Math.round(((s.amount || 0) / max) * 60), 2);
        return `<div class="ops-timeline-bar" title="${s.label}: ${formatCost(s.amount || 0)}" style="height:${h}px"></div>`;
      }).join('')}</div>
      <div class="ops-timeline-labels">
        <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
      </div>
    </div>`;
  }

  // ── HELPERS ──────────────────────────────────────────────────────

  _statusBadge(status) {
    const colors = {
      completed: '#34d399', complete: '#34d399', done: '#34d399',
      failed: '#ef4444', escalated: '#f97316', routing_failed: '#f97316',
      executing: '#60a5fa', assigned: '#60a5fa', pending: '#6b7280',
      'in_progress': '#60a5fa', 'in-progress': '#60a5fa',
      'subtask-completed': '#34d399', 'subtask-failed': '#ef4444',
    };
    const color = colors[status] || '#6b7280';
    return `<span class="ops-badge" style="--badge-color:${color}">${(status || 'unknown').replace(/_/g, ' ')}</span>`;
  }

  _agentName(id) {
    if (!id) return '—';
    const bot = (this.data.registry?.bots || []).find((b) => b.agentId === id || b.name === id);
    return bot?.name || id.slice(0, 16);
  }

  _relTime(ts) {
    if (!ts) return '—';
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  _escape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

// ── Module-level helpers (not methods) ───────────────────────────

function _fmtTokens(n) {
  if (!n || n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function _runDuration(startedAt, completedAt) {
  if (!startedAt) return '—';
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (ms < 0) return '—';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function _inferProvider(modelId) {
  if (!modelId) return '—';
  const m = modelId.toLowerCase();
  if (m.includes('claude')) return 'Anthropic';
  if (m.includes('gpt') || m.includes('openai') || m.includes('codex')) return 'OpenAI';
  return 'Unknown';
}

function _modelColor(modelId) {
  if (!modelId) return '#6b7280';
  const m = modelId.toLowerCase();
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) return '#f59e0b';
  if (m.includes('gpt-4')) return '#60a5fa';
  if (m.includes('gpt')) return '#38bdf8';
  return '#a78bfa';
}

function _queueStatusColor(status) {
  if (status === 'healthy') return '#34d399';
  if (status === 'degraded') return '#fbbf24';
  if (status === 'blocked') return '#ef4444';
  return '#6b7280';
}

function _fmtAge(minutes) {
  const value = Number(minutes || 0);
  if (value < 60) return `${value}m`;
  if (value < 1440) return `${Math.floor(value / 60)}h ${value % 60}m`;
  return `${Math.floor(value / 1440)}d ${Math.floor((value % 1440) / 60)}h`;
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Removed dead queue metrics fetch and derived dashboard queue data from mounted OSHAL summary routes
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced cockpit dashboard mock chart data with real cost-tracker series and zero-state health rendering for the UI button audit
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Fixed falsy-zero bugs (|| → ??), backend now returns full status breakdown (backlog/inProgress/inReview/customerAction/done/escalations), corrected card labels
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Wired Bot Performance to /api/v1/metrics/agents (DB-backed work_items), Spending to server costSeries, Swarm Health to server swarmHealth
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Fixed dashboard zero-state logic so bot performance can fall back to telemetry activity and swarm health honors explicit zero/degraded counts
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Session 20: Added Swarm Pipeline panel — fetches GET /metrics/swarm, renders completion rates, phase failure heatmap, agent leaderboard, and recent ticket timeline
 */

import { ApiClient } from '../api-client.js';
import { createUiLogger } from '../../../shared/ui-debug.js';
import { formatCost } from '../utils/formatters.js';

const logger = createUiLogger('cockpit-dashboard-view');

/**
 * @description Cockpit dashboard view backed by mounted OSHAL metrics, health routes,
 * and locally tracked real cost transactions for operator situational awareness.
 */
export class DashboardView {
  constructor(container) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.api = new ApiClient();
    this.metrics = {};
    this.agentMetrics = [];
    this.queueMetrics = {};
    this.healthData = {};
    this.costSeries = [];
    this.swarmPipeline = null;
    logger.info('Created cockpit dashboard view', {
      hasContainer: Boolean(this.container),
    });
  }

  async render() {
    if (!this.container) return;
    logger.info('Rendering cockpit dashboard view');
    this.container.innerHTML = `<div class="dashboard-view">
      <div class="dash-toolbar">
        <span class="dash-title"><i class="ph ph-chart-line-up"></i> Dashboard</span>
        <button class="dash-refresh-btn" id="dashRefresh"><i class="ph ph-arrow-clockwise"></i> Refresh</button>
      </div>
      <div class="dash-content" id="dashContent">
        <div class="dash-loading"><i class="ph ph-spinner-gap ph-spin" style="font-size:24px"></i> Loading metrics...</div>
      </div>
    </div>`;

    this.container.querySelector('#dashRefresh')?.addEventListener('click', () => this._refresh());
    await this._loadAndRender();
  }

  async _refresh() {
    const button = this.container.querySelector('#dashRefresh');
    logger.info('Refreshing cockpit dashboard view');
    if (button) button.classList.add('spinning');
    await this._loadAndRender();
    if (button) button.classList.remove('spinning');
  }

  async _loadAndRender() {
    logger.debug('Loading cockpit dashboard data');
    const [metricsResult, agentResult, healthResult, swarmResult] = await Promise.allSettled([
      this.api.getSafe('/api/v1/metrics/summary', {}),
      this.api.getSafe('/api/v1/metrics/agents', { agents: [] }),
      this.api.getSafe('/api/health', {}),
      this.api.getSafe('/api/v1/metrics/swarm', {}),
    ]);

    this.metrics = this._readSettled(metricsResult, {});
    this.agentMetrics = this._readSettled(agentResult, []).agents || this._readSettled(agentResult, []);
    this.healthData = this._readSettled(healthResult, {});
    const swarmRaw = this._readSettled(swarmResult, {});
    this.swarmPipeline = swarmRaw?.data ?? null;
    this.queueMetrics = deriveQueueMetrics(this.metrics);
    // Prefer server-side cost series (DB-backed) over client localStorage
    const serverCostSeries = this._metricsData().costSeries;
    this.costSeries = Array.isArray(serverCostSeries) && serverCostSeries.length > 0
      ? serverCostSeries
      : this.api.getDailyCostSeries(24);
    logger.debug('Loaded cockpit dashboard data', {
      agentCount: Array.isArray(this.agentMetrics) ? this.agentMetrics.length : 0,
      costPointCount: Array.isArray(this.costSeries) ? this.costSeries.length : 0,
      hasHealthData: Boolean(this.healthData && Object.keys(this.healthData).length),
    });
    this._renderDashboard();
  }

  _readSettled(result, fallback) {
    return result.status === 'fulfilled' && result.value ? result.value : fallback;
  }

  _renderDashboard() {
    const content = this.container.querySelector('#dashContent');
    if (!content) return;

    logger.debug('Rendering cockpit dashboard charts and metrics');
    content.innerHTML = `${this._renderMetricCards()}${this._renderSwarmPipelinePanel()}${this._renderChartsGrid()}`;
    requestAnimationFrame(() => {
      this._drawSpendingChart();
      this._drawBotPerformance();
      this._drawDonutChart();
      this._drawFunnel();
      this._drawQueueBars();
    });
  }

  _renderMetricCards() {
    const data = this._metricsData();
    const cards = [
      ['cases', 'ph-ticket', this._displayValue(data.total ?? data.totalTickets), 'Total Tickets'],
      ['review', 'ph-eye', this._displayValue(data.customerAction), 'Client Review'],
      ['escalations', 'ph-warning-circle', this._displayValue(data.escalations), 'Escalations'],
      ['approvals', 'ph-seal-check', this._displayValue(data.queue ?? data.queueDepth), 'Queue Depth'],
      ['completed', 'ph-check-circle', this._displayValue(data.done), 'Completed'],
      ['agents', 'ph-robot', this._formatAgentCount(data.agents), 'Online Bots'],
    ];

    return `<div class="dash-metric-row">
      ${cards.map(([klass, icon, value, label]) => `<div class="dash-metric-card">
        <div class="dash-metric-icon ${klass}"><i class="ph ${icon}"></i></div>
        <div class="dash-metric-value">${value}</div>
        <div class="dash-metric-label">${label}</div>
      </div>`).join('')}
    </div>`;
  }

  _renderChartsGrid() {
    const totalCost = this._metricsData().estimatedTotalCost || this._metricsData().totalCost || 0;
    return `<div class="dash-charts-grid">
      <div class="dash-chart-card full-width">
        <div class="dash-chart-header">
          <div>
            <div class="dash-chart-title">Spending Over Time</div>
            <div class="dash-chart-subtitle">Total: ${formatCost(totalCost)}</div>
          </div>
        </div>
        <div class="dash-chart-canvas-wrap"><canvas id="dashSpendingChart"></canvas></div>
      </div>
      <div class="dash-chart-card">
        <div class="dash-chart-header"><div class="dash-chart-title">Bot Performance</div></div>
        <div id="dashBotPerf"></div>
      </div>
      <div class="dash-chart-card">
        <div class="dash-chart-header"><div class="dash-chart-title">Recently Active</div></div>
        <div id="dashRecentActivity">${this._renderRecentActivity()}</div>
      </div>
      <div class="dash-chart-card">
        <div class="dash-chart-header"><div class="dash-chart-title">Swarm Health</div></div>
        <div class="dash-chart-canvas-wrap" style="height:180px"><canvas id="dashDonutChart"></canvas></div>
        <div class="dash-donut-legend" id="dashDonutLegend"></div>
      </div>
      <div class="dash-chart-card">
        <div class="dash-chart-header"><div class="dash-chart-title">Case Breakdown</div></div>
        <div id="dashFunnel"></div>
      </div>
      <div class="dash-chart-card">
        <div class="dash-chart-header"><div class="dash-chart-title">Queue Status</div></div>
        <div id="dashQueueBars"></div>
      </div>
    </div>`;
  }

  _drawSpendingChart() {
    const canvas = this.container.querySelector('#dashSpendingChart');
    if (!canvas) return;

    const chart = this._prepareCanvas(canvas);
    if (!chart) return;

    const amounts = this.costSeries.map((point) => Number(point.amount || 0));
    const max = Math.max(...amounts, 0);
    this._drawGrid(chart);
    if (!max) return this._drawZeroLine(chart, 'No recorded cost transactions today');
    this._drawYAxis(chart, max);
    this._drawSeries(chart, amounts, max);
  }

  _prepareCanvas(canvas) {
    const context = canvas.getContext('2d');
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!context || !rect?.width || !rect?.height) return null;

    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    context.scale(2, 2);
    return { ctx: context, width: rect.width, height: rect.height, padX: 40, padY: 20 };
  }

  _drawGrid(chart) {
    const { ctx, width, height, padX, padY } = chart;
    const plotWidth = width - padX - 10;
    const plotHeight = height - padY * 2;

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let index = 0; index <= 4; index += 1) {
      const y = padY + plotHeight * (index / 4);
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(padX + plotWidth, y);
      ctx.stroke();
    }
  }

  _drawZeroLine(chart, message) {
    const { ctx, width, height, padX, padY } = chart;
    const y = height - padY;
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(width - 10, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(message, width / 2, height / 2);
  }

  _drawYAxis(chart, max) {
    const { ctx, height, padX, padY } = chart;
    const plotHeight = height - padY * 2;

    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (let index = 0; index <= 4; index += 1) {
      const y = padY + plotHeight * (index / 4);
      const value = max * (1 - index / 4);
      ctx.fillText(`$${value.toFixed(2)}`, padX - 6, y + 3);
    }
  }

  _drawSeries(chart, amounts, max) {
    const points = this._buildSeriesPoints(chart, amounts, max);
    this._drawArea(chart.ctx, points, chart.height, chart.padY);
    this._drawLine(chart.ctx, points);
    this._drawDots(chart.ctx, points);
  }

  _buildSeriesPoints(chart, amounts, max) {
    const plotWidth = chart.width - chart.padX - 10;
    const plotHeight = chart.height - chart.padY * 2;
    return amounts.map((amount, index) => ({
      x: chart.padX + (index / Math.max(amounts.length - 1, 1)) * plotWidth,
      y: chart.padY + plotHeight - (amount / max) * plotHeight,
    }));
  }

  _drawArea(ctx, points, height, padY) {
    const gradient = ctx.createLinearGradient(0, padY, 0, height - padY);
    gradient.addColorStop(0, 'rgba(99, 102, 241, 0.3)');
    gradient.addColorStop(1, 'rgba(99, 102, 241, 0)');

    ctx.beginPath();
    ctx.moveTo(points[0].x, height - padY);
    points.forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.lineTo(points[points.length - 1].x, height - padY);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  _drawLine(ctx, points) {
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  _drawDots(ctx, points) {
    points.forEach((point) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#6366f1';
      ctx.fill();
    });
  }

  _drawBotPerformance() {
    const container = this.container.querySelector('#dashBotPerf');
    if (!container) return;

    const bots = this._topPerformingBots();
    if (!bots.length) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:12px">No bot performance data</p>';
      return;
    }

    const max = Math.max(...bots.map((bot) => this._botPerformanceValue(bot)), 1);
    container.innerHTML = `<div class="dash-bar-labels">
      ${bots.map((bot) => this._renderBotPerformanceRow(bot, max)).join('')}
    </div>`;
  }

  _topPerformingBots() {
    const agents = Array.isArray(this.agentMetrics) ? this.agentMetrics : [];
    return agents
      .map((bot) => ({
        ...bot,
        performanceValue: this._botPerformanceValue(bot),
      }))
      .sort((left, right) => {
        if (right.performanceValue !== left.performanceValue) {
          return right.performanceValue - left.performanceValue;
        }
        if (Number(right.online) !== Number(left.online)) {
          return Number(right.online) - Number(left.online);
        }
        return this._readTimestamp(right.lastActivityAt) - this._readTimestamp(left.lastActivityAt);
      })
      .slice(0, 8);
  }

  _renderBotPerformanceRow(bot, max) {
    const value = this._botPerformanceValue(bot);
    const width = (value / max) * 100;
    return `<div class="dash-bar-item">
      <span class="dash-bar-name">${bot.agentId || bot.name || ''}</span>
      <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${width}%"></div></div>
      <span class="dash-bar-value">${value}</span>
    </div>`;
  }

  /**
   * Most-recently-active agents (by lastActivityAt), with cost — surfaces light/inline
   * agents like the Jarvis assistant that never make the top-8 Bot Performance cut, so
   * every run shows as swarm activity. Pure HTML (no canvas).
   */
  _renderRecentActivity() {
    const agents = (Array.isArray(this.agentMetrics) ? this.agentMetrics : [])
      .filter((a) => this._readTimestamp(a.lastActivityAt) > 0)
      .sort((a, b) => this._readTimestamp(b.lastActivityAt) - this._readTimestamp(a.lastActivityAt))
      .slice(0, 8);
    if (!agents.length) return '<p style="color:var(--text-muted);font-size:12px">No recent agent activity</p>';
    return `<div class="dash-bar-labels">${agents.map((a) => {
      const name = a.name || a.agentId || '?';
      const cost = formatCost(Number(a.totalCost || 0));
      const when = this._timeAgo(a.lastActivityAt);
      const dot = a.online ? '#34d399' : '#5c5c78';
      return `<div class="dash-bar-item" style="display:flex;align-items:center;gap:8px">
        <span class="dash-legend-dot" style="background:${dot};flex:none"></span>
        <span class="dash-bar-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span>
        <span style="color:var(--text-muted);font-size:11px;white-space:nowrap">${cost}</span>
        <span style="color:var(--text-muted);font-size:11px;white-space:nowrap">${when}</span>
      </div>`;
    }).join('')}</div>`;
  }

  _drawDonutChart() {
    const canvas = this.container.querySelector('#dashDonutChart');
    const legend = this.container.querySelector('#dashDonutLegend');
    if (!canvas || !legend) return;

    const chart = this._prepareCanvas(canvas);
    if (!chart) return;

    const segments = this._healthSegments();
    this._drawDonutSegments(chart, segments);
    this._drawDonutCenter(chart, segments);
    legend.innerHTML = segments.map((segment) => `<div class="dash-legend-item">
      <span class="dash-legend-dot" style="background:${segment.color}"></span>
      ${segment.label}: ${segment.value}
    </div>`).join('');
  }

  _healthSegments() {
    // Prefer server-side swarmHealth from metrics summary (DB + Redis backed)
    const serverHealth = this._metricsData().swarmHealth;
    const hasServerHealth = serverHealth && ['healthy', 'degraded', 'offline']
      .some((key) => Number.isFinite(Number(serverHealth[key])));
    if (hasServerHealth) {
      return [
        { label: 'Online', value: serverHealth.healthy ?? 0, color: '#34d399' },
        { label: 'Degraded', value: serverHealth.degraded ?? 0, color: '#fbbf24' },
        { label: 'Offline', value: serverHealth.offline ?? 0, color: '#f87171' },
      ];
    }
    // Fallback: derive from /api/health agent status map
    const agents = this.healthData.agents || this.healthData.services || {};
    let healthy = 0;
    let degraded = 0;
    let offline = 0;

    Object.values(agents).forEach((agent) => {
      const status = (agent?.status || 'unknown').toLowerCase();
      if (status === 'healthy' || status === 'online') healthy += 1;
      else if (status === 'degraded') degraded += 1;
      else offline += 1;
    });

    return [
      { label: 'Healthy', value: healthy, color: '#34d399' },
      { label: 'Degraded', value: degraded, color: '#fbbf24' },
      { label: 'Offline', value: offline, color: '#f87171' },
    ];
  }

  _drawDonutSegments(chart, segments) {
    const total = segments.reduce((sum, segment) => sum + segment.value, 0);
    const radius = Math.min(chart.width, chart.height) / 2 - 20;
    const innerRadius = radius * 0.6;
    let startAngle = -Math.PI / 2;

    if (!total) return this._drawEmptyRing(chart.ctx, chart.width / 2, chart.height / 2, radius, innerRadius);

    segments.forEach((segment) => {
      const sliceAngle = (segment.value / total) * Math.PI * 2;
      chart.ctx.beginPath();
      chart.ctx.arc(chart.width / 2, chart.height / 2, radius, startAngle, startAngle + sliceAngle);
      chart.ctx.arc(chart.width / 2, chart.height / 2, innerRadius, startAngle + sliceAngle, startAngle, true);
      chart.ctx.closePath();
      chart.ctx.fillStyle = segment.color;
      chart.ctx.fill();
      startAngle += sliceAngle;
    });
  }

  _drawEmptyRing(ctx, cx, cy, radius, innerRadius) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.arc(cx, cy, innerRadius, Math.PI * 2, 0, true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();
  }

  _drawDonutCenter(chart, segments) {
    const total = segments.reduce((sum, segment) => sum + segment.value, 0);
    chart.ctx.fillStyle = 'rgba(255,255,255,0.9)';
    chart.ctx.font = 'bold 24px sans-serif';
    chart.ctx.textAlign = 'center';
    chart.ctx.textBaseline = 'middle';
    chart.ctx.fillText(String(total), chart.width / 2, chart.height / 2 - 6);
    chart.ctx.font = '11px sans-serif';
    chart.ctx.fillStyle = 'rgba(255,255,255,0.5)';
    chart.ctx.fillText(total ? 'agents' : 'no data', chart.width / 2, chart.height / 2 + 12);
  }

  _drawFunnel() {
    const container = this.container.querySelector('#dashFunnel');
    if (!container) return;

    const data = this._metricsData();
    const steps = [
      { label: 'Backlog', count: data.backlog ?? data.todo ?? 0, color: '#6b7280' },
      { label: 'In Progress', count: data.inProgress ?? 0, color: '#60a5fa' },
      { label: 'In Review', count: data.inReview ?? 0, color: '#a78bfa' },
      { label: 'Customer Action', count: data.customerAction ?? 0, color: '#fbbf24' },
      { label: 'Done', count: data.done ?? 0, color: '#34d399' },
    ];
    const maxCount = Math.max(...steps.map((step) => step.count), 1);

    container.innerHTML = `<div class="dash-funnel">
      ${steps.map((step) => this._renderFunnelStep(step, maxCount)).join('')}
    </div>`;
  }

  _renderFunnelStep(step, maxCount) {
    const width = Math.max(10, (step.count / maxCount) * 100);
    return `<div class="dash-funnel-step">
      <span class="dash-funnel-label">${step.label}</span>
      <div class="dash-funnel-bar" style="width:${width}%;background:${step.color}">${step.count || ''}</div>
      <span class="dash-funnel-count">${step.count}</span>
    </div>`;
  }

  _drawQueueBars() {
    const container = this.container.querySelector('#dashQueueBars');
    if (!container) return;

    const queue = this.queueMetrics.queue || this.queueMetrics;
    const items = [
      { label: 'Waiting', value: queue.waiting || queue.pending || 0, color: '#60a5fa' },
      { label: 'Active', value: queue.active || queue.processing || 0, color: '#fbbf24' },
      { label: 'Completed', value: queue.completed || queue.done || 0, color: '#34d399' },
      { label: 'Failed', value: queue.failed || 0, color: '#f87171' },
    ];
    const max = Math.max(...items.map((item) => item.value), 1);

    container.innerHTML = `<div class="dash-bar-labels">
      ${items.map((item) => this._renderQueueRow(item, max)).join('')}
    </div>`;
  }

  _renderQueueRow(item, max) {
    return `<div class="dash-bar-item">
      <span class="dash-bar-name">${item.label}</span>
      <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${(item.value / max) * 100}%;background:${item.color}"></div></div>
      <span class="dash-bar-value">${item.value}</span>
    </div>`;
  }

  // ── Swarm Pipeline Panel ──

  _renderSwarmPipelinePanel() {
    if (!this.swarmPipeline) {
      return `<div class="dash-pipeline-panel">
        <div class="dash-chart-header"><div class="dash-chart-title"><i class="ph ph-git-branch"></i> Swarm Pipeline</div></div>
        <p class="dash-pipeline-empty">No pipeline data — submit a ticket to generate metrics</p>
      </div>`;
    }

    const agg = this.swarmPipeline.aggregated || {};
    const recent = this.swarmPipeline.recentTickets || [];
    return `<div class="dash-pipeline-panel">
      <div class="dash-chart-header">
        <div class="dash-chart-title"><i class="ph ph-git-branch"></i> Swarm Pipeline</div>
        <span class="dash-pipeline-ts">${agg.collectedAt ? new Date(agg.collectedAt).toLocaleTimeString() : ''}</span>
      </div>
      ${this._renderPipelineKPIs(agg)}
      <div class="dash-pipeline-grid">
        ${this._renderPhaseCompletion(agg)}
        ${this._renderPhaseFailures(agg)}
        ${this._renderPipelineAgents(agg)}
        ${this._renderRecentTickets(recent)}
      </div>
    </div>`;
  }

  _renderPipelineKPIs(agg) {
    const successRate = agg.totalRuns ? ((agg.completedRuns / agg.totalRuns) * 100).toFixed(0) : '--';
    const avgDuration = agg.averageDurationMs ? this._formatDuration(agg.averageDurationMs) : '--';
    const kpis = [
      ['ph-stack', agg.totalRuns ?? 0, 'Total Runs'],
      ['ph-check-circle', agg.completedRuns ?? 0, 'Completed'],
      ['ph-x-circle', agg.failedRuns ?? 0, 'Failed'],
      ['ph-arrow-u-up-right', agg.escalatedRuns ?? 0, 'Escalated'],
      ['ph-percent', successRate, 'Success Rate'],
      ['ph-timer', avgDuration, 'Avg Duration'],
    ];
    return `<div class="dash-pipeline-kpis">
      ${kpis.map(([icon, value, label]) => `<div class="dash-pipeline-kpi">
        <i class="ph ${icon}"></i>
        <span class="dash-pipeline-kpi-value">${value}</span>
        <span class="dash-pipeline-kpi-label">${label}</span>
      </div>`).join('')}
    </div>`;
  }

  _renderPhaseCompletion(agg) {
    const rates = agg.phaseCompletionRates || {};
    const phases = Object.entries(rates);
    if (!phases.length) return '';
    return `<div class="dash-pipeline-section">
      <div class="dash-pipeline-section-title">Phase Completion</div>
      <div class="dash-bar-labels">
        ${phases.map(([phase, rate]) => {
          const pct = (rate * 100).toFixed(0);
          const color = rate >= 0.8 ? '#34d399' : rate >= 0.5 ? '#fbbf24' : '#f87171';
          return `<div class="dash-bar-item">
            <span class="dash-bar-name">${phase}</span>
            <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${pct}%;background:${color}"></div></div>
            <span class="dash-bar-value">${pct}%</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  _renderPhaseFailures(agg) {
    const failures = agg.topFailurePhases || [];
    if (!failures.length) return '';
    const max = Math.max(...failures.map((f) => f.failureCount), 1);
    return `<div class="dash-pipeline-section">
      <div class="dash-pipeline-section-title">Failure Hotspots</div>
      <div class="dash-bar-labels">
        ${failures.map((f) => `<div class="dash-bar-item">
          <span class="dash-bar-name">${f.phase}</span>
          <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${(f.failureCount / max) * 100}%;background:#f87171"></div></div>
          <span class="dash-bar-value">${f.failureCount}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }

  _renderPipelineAgents(agg) {
    const agents = agg.agentPerformance || [];
    if (!agents.length) return '';
    const sorted = [...agents].sort((a, b) => b.ticketsHandled - a.ticketsHandled).slice(0, 6);
    const max = Math.max(...sorted.map((a) => a.ticketsHandled), 1);
    return `<div class="dash-pipeline-section">
      <div class="dash-pipeline-section-title">Agent Leaderboard</div>
      <div class="dash-bar-labels">
        ${sorted.map((a) => {
          const rate = a.ticketsHandled ? ((a.completedCount / a.ticketsHandled) * 100).toFixed(0) : '0';
          return `<div class="dash-bar-item">
            <span class="dash-bar-name" title="${a.agentId}">${this._shortAgentName(a.agentId)}</span>
            <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${(a.ticketsHandled / max) * 100}%;background:var(--accent-gradient)"></div></div>
            <span class="dash-bar-value">${a.ticketsHandled} <small style="opacity:0.6">(${rate}%)</small></span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  _renderRecentTickets(tickets) {
    if (!tickets.length) return '';
    return `<div class="dash-pipeline-section dash-pipeline-section-wide">
      <div class="dash-pipeline-section-title">Recent Pipeline Activity</div>
      <div class="dash-pipeline-timeline">
        ${tickets.slice(0, 10).map((t) => {
          const outcomeClass = t.outcome === 'completed' ? 'success' : t.outcome === 'escalated' ? 'warning' : 'error';
          const duration = t.totalDurationMs ? this._formatDuration(t.totalDurationMs) : '--';
          const when = t.completedAt ? this._timeAgo(t.completedAt) : '';
          return `<div class="dash-pipeline-ticket">
            <span class="dash-pipeline-dot ${outcomeClass}"></span>
            <span class="dash-pipeline-ticket-id" title="${t.ticketId}">${this._truncateId(t.ticketId)}</span>
            <span class="dash-pipeline-ticket-meta">${this._shortAgentName(t.agentId)} · ${duration} · C${t.complexity ?? '?'}</span>
            <span class="dash-pipeline-ticket-outcome ${outcomeClass}">${t.outcome}</span>
            <span class="dash-pipeline-ticket-when">${when}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  _formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  _timeAgo(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  _shortAgentName(agentId) {
    if (!agentId) return '?';
    if (agentId.includes('-bot')) return agentId.replace(/-bot$/, '');
    if (agentId.length > 12) return agentId.slice(0, 8) + '...';
    return agentId;
  }

  _truncateId(id) {
    if (!id) return '?';
    return id.length > 16 ? id.slice(0, 14) + '...' : id;
  }

  destroy() {
    logger.info('Destroying cockpit dashboard view');
    if (this.container) this.container.innerHTML = '';
  }

  _metricsData() {
    return this.metrics.data || this.metrics || {};
  }

  _displayValue(value) {
    return value != null ? value : '--';
  }

  _formatAgentCount(agents) {
    if (!agents || typeof agents !== 'object') return this._displayValue(agents);
    const total = agents.total ?? 0;
    if (agents.busy != null) return `${total} <small style="opacity:0.7">(${agents.busy} busy)</small>`;
    return String(total);
  }

  _botPerformanceValue(bot) {
    return Math.max(
      Number(bot.totalEvents ?? 0) || 0,
      Number(bot.totalRequests ?? 0) || 0,
      Number(bot.tasksCompleted ?? 0) || 0,
    );
  }

  _readTimestamp(value) {
    if (!value) {
      return 0;
    }
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
}

function deriveQueueMetrics(metricsResponse) {
  const data = metricsResponse?.data ?? metricsResponse ?? {};
  return {
    queue: {
      waiting: data.backlog ?? data.queue ?? data.queueDepth ?? 0,
      active: data.inProgress ?? 0,
      completed: data.done ?? 0,
      failed: data.failed ?? 0,
    },
  };
}

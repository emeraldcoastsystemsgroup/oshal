/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added native health dashboard browser logic for runtime, agent, run, scheduler, and log visibility
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('health-dashboard');

class HealthDashboardApp {
  constructor() {
    this.state = createInitialState();
    this.elements = {
      agentTableBody: document.getElementById('agentTableBody'),
      logList: document.getElementById('logList'),
      refreshButton: document.getElementById('refreshButton'),
      runTableBody: document.getElementById('runTableBody'),
      runtimeSummary: document.getElementById('runtimeSummary'),
      statusBanner: document.getElementById('statusBanner'),
    };
  }

  async init() {
    logger.info('Initializing health dashboard');
    this.bindEvents();
    await this.refresh();
  }

  bindEvents() {
    this.elements.refreshButton.addEventListener('click', async () => {
      await this.refresh();
    });
  }

  async refresh() {
    const startedAt = Date.now();
    this.setStatus('Loading runtime health...', 'info');
    logger.info('Refreshing health dashboard');
    const requests = [
      requestJson('/api/health'),
      requestJson('/api/v1/metrics/summary'),
      requestJson('/api/v1/metrics/agents'),
      requestJson('/api/swarm/runs?limit=8'),
      requestJson('/api/logs?limit=8&includeMessages=false'),
      requestJson('/api/v1/agent/scheduler/status'),
    ];

    const results = await Promise.allSettled(requests);
    this.state = buildHealthState(results);
    this.render();
    this.setStatus(buildStatusMessage(this.state), this.state.failedCount > 0 ? 'warning' : 'success');
    logger.info('Health dashboard refresh complete', {
      durationMs: Date.now() - startedAt,
      failedCount: this.state.failedCount,
      agentCount: this.state.agents.length,
      runCount: this.state.runs.length,
      logCount: this.state.logs.length,
    });
  }

  render() {
    renderMetrics(this.state);
    this.elements.runtimeSummary.innerHTML = renderRuntimeSummary(this.state);
    this.elements.agentTableBody.innerHTML = renderAgentRows(this.state.agents);
    this.elements.runTableBody.innerHTML = renderRunRows(this.state.runs);
    this.elements.logList.innerHTML = renderLogEntries(this.state.logs);
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }
}

// Create the empty dashboard state used before the first refresh.
function createInitialState() {
  return {
    failedCount: 0,
    health: { status: 'unknown', uptime: 0, timestamp: '' },
    logs: [],
    metrics: { active: 0, agents: 0, cost: 0, total: 0 },
    refreshedAt: '',
    runs: [],
    scheduler: { isRunning: false, pollIntervalMs: 0, redisHealthy: false },
    agents: [],
  };
}

// Normalize Promise.allSettled results into one renderable dashboard state.
function buildHealthState(results) {
  return {
    failedCount: countRejected(results),
    health: settledValue(results[0], { status: 'unknown', uptime: 0, timestamp: '' }, normalizeHealth),
    metrics: settledValue(results[1], { active: 0, agents: 0, cost: 0, total: 0 }, normalizeMetrics),
    agents: settledValue(results[2], [], normalizeAgents),
    runs: settledValue(results[3], [], normalizeRuns),
    logs: settledValue(results[4], [], normalizeLogs),
    scheduler: settledValue(results[5], { isRunning: false, pollIntervalMs: 0, redisHealthy: false }, normalizeScheduler),
    refreshedAt: new Date().toISOString(),
  };
}

// Read one fulfilled Promise result or return a fallback when the request failed.
function settledValue(result, fallback, normalizer) {
  if (!result || result.status !== 'fulfilled') {
    return fallback;
  }

  try {
    return normalizer(result.value);
  } catch (error) {
    logger.warn('Health dashboard payload normalization failed', {
      error: serializeUiError(error),
    });
    return fallback;
  }
}

// Count failed async data sources from the settled request array.
function countRejected(results) {
  return results.filter((result) => result.status === 'rejected').length;
}

// Normalize the `/api/health` payload for dashboard rendering.
function normalizeHealth(payload) {
  return {
    status: readString(payload?.status) || 'unknown',
    uptime: numberValue(payload?.uptime),
    timestamp: readString(payload?.timestamp),
  };
}

// Normalize the metrics summary payload for dashboard rendering.
function normalizeMetrics(payload) {
  const data = payload?.data || payload || {};
  return {
    active: numberValue(data.active ?? data.inProgress),
    agents: numberValue(data.agents?.total),
    cost: numberValue(data.estimatedTotalCost),
    total: numberValue(data.total),
  };
}

// Normalize the agent metrics payload for dashboard rendering.
function normalizeAgents(payload) {
  const agents = Array.isArray(payload?.agents) ? payload.agents : [];
  return agents.map((agent) => ({
    agentId: readString(agent.agentId || agent.name),
    tasksActive: numberValue(agent.tasksActive),
    tasksCompleted: numberValue(agent.tasksCompleted),
    totalCost: numberValue(agent.totalCost),
  }));
}

// Normalize the recent swarm runs payload for dashboard rendering.
function normalizeRuns(payload) {
  const runs = Array.isArray(payload?.runs) ? payload.runs : [];
  return runs.map((run) => ({
    count: numberValue(run.itemCount ?? run.processedCount),
    runId: readString(run.runId || run.id),
    status: readString(run.status) || 'unknown',
    updatedAt: readString(run.updatedAt || run.startedAt || run.createdAt),
  }));
}

// Normalize the debug log payload for dashboard rendering.
function normalizeLogs(payload) {
  const entries = Array.isArray(payload) ? payload : [];
  return entries.map((entry) => ({
    level: readString(entry.level) || 'info',
    message: readString(entry.message) || 'No message provided',
    timestamp: readString(entry.timestamp),
  }));
}

// Normalize the scheduler status payload for dashboard rendering.
function normalizeScheduler(payload) {
  return {
    isRunning: payload?.isRunning === true,
    lastDispatchCompletedAt: readString(payload?.lastDispatchCompletedAt),
    pollIntervalMs: numberValue(payload?.pollIntervalMs),
    redisHealthy: payload?.redisHealthy === true,
  };
}

// Render top-line health metrics into the metric cards.
function renderMetrics(state) {
  setText('metricApiHealth', state.health.status === 'ok' ? 'Healthy' : 'Degraded');
  setText('metricActiveTasks', state.metrics.active);
  setText('metricAgents', state.metrics.agents);
  setText('metricScheduler', state.scheduler.redisHealthy ? 'Ready' : 'Offline');
}

// Render the runtime summary card grid.
function renderRuntimeSummary(state) {
  const cards = [
    renderSummaryCard('API Timestamp', formatDateTime(state.health.timestamp)),
    renderSummaryCard('Uptime', formatDuration(state.health.uptime)),
    renderSummaryCard('Tracked Tasks', state.metrics.total),
    renderSummaryCard('Estimated Cost', formatCurrency(state.metrics.cost)),
    renderSummaryCard('Scheduler Poll', formatPollInterval(state.scheduler.pollIntervalMs)),
    renderSummaryCard('Last Dispatch', formatDateTime(state.scheduler.lastDispatchCompletedAt)),
  ];
  return cards.join('');
}

// Render one summary card inside the runtime summary grid.
function renderSummaryCard(label, value) {
  return `<article class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value || '—'))}</strong></article>`;
}

// Render agent metrics rows or an empty-state row when no data exists.
function renderAgentRows(agents) {
  if (!agents.length) {
    return renderEmptyRow('No agent metrics are available yet.', 4);
  }

  return agents.map((agent) => `
    <tr>
      <td><strong>${escapeHtml(agent.agentId || 'Unknown agent')}</strong></td>
      <td>${escapeHtml(String(agent.tasksCompleted))}</td>
      <td>${escapeHtml(String(agent.tasksActive))}</td>
      <td>${escapeHtml(formatCurrency(agent.totalCost))}</td>
    </tr>
  `).join('');
}

// Render recent run rows or an empty-state row when no data exists.
function renderRunRows(runs) {
  if (!runs.length) {
    return renderEmptyRow('No swarm runs are available yet.', 4);
  }

  return runs.map((run) => `
    <tr>
      <td class="mono">${escapeHtml(truncate(run.runId, 18))}</td>
      <td>${escapeHtml(run.status)}</td>
      <td>${escapeHtml(String(run.count))}</td>
      <td>${escapeHtml(formatDateTime(run.updatedAt))}</td>
    </tr>
  `).join('');
}

// Render recent log entries or an empty-state list item when no data exists.
function renderLogEntries(logs) {
  if (!logs.length) {
    return '<li class="empty-state">No recent operational logs are available yet.</li>';
  }

  return logs.map((entry) => `
    <li class="log-entry">
      <div class="log-meta">
        <span>${escapeHtml(entry.level.toUpperCase())}</span>
        <span>${escapeHtml(formatDateTime(entry.timestamp))}</span>
      </div>
      <div class="log-message">${escapeHtml(entry.message)}</div>
    </li>
  `).join('');
}

// Render one full-width empty-state table row.
function renderEmptyRow(message, colspan) {
  return `<tr><td colspan="${colspan}"><div class="empty-state">${escapeHtml(message)}</div></td></tr>`;
}

// Perform one authenticated JSON request for the dashboard page.
async function requestJson(url) {
  const startedAt = Date.now();
  logger.debug('Health dashboard request started', { url });
  const response = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    logger.warn('Health dashboard request failed', {
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
    throw new Error(errorMessage);
  }
  const payload = await response.json();
  logger.info('Health dashboard request completed', {
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return payload;
}

// Read the most useful error message from a failed fetch response.
async function readErrorMessage(response) {
  const fallback = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    return readString(body.error) || fallback;
  } catch (_error) {
    return fallback;
  }
}

// Build the status-banner copy after one refresh cycle completes.
function buildStatusMessage(state) {
  const refreshedAt = formatDateTime(state.refreshedAt);
  if (state.failedCount === 0) {
    return `Runtime health refreshed successfully at ${refreshedAt}.`;
  }
  return `Runtime health refreshed with ${state.failedCount} degraded data source(s) at ${refreshedAt}.`;
}

// Safely set text content on one DOM element by id.
function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = String(value);
  }
}

// Format one numeric cost value as USD text.
function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(numberValue(value));
}

// Format one ISO timestamp for operator display.
function formatDateTime(value) {
  if (!readString(value)) {
    return '—';
  }
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// Format uptime seconds as a short hours/minutes string.
function formatDuration(seconds) {
  if (!Number.isFinite(numberValue(seconds)) || numberValue(seconds) <= 0) {
    return '—';
  }
  const totalSeconds = Math.floor(numberValue(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

// Format a scheduler polling interval in milliseconds.
function formatPollInterval(value) {
  const milliseconds = numberValue(value);
  if (milliseconds <= 0) {
    return '—';
  }
  return `${Math.round(milliseconds / 1000)}s`;
}

// Truncate long identifiers for compact table rendering.
function truncate(value, length) {
  const text = readString(value);
  if (text.length <= length) {
    return text;
  }
  return `${text.slice(0, length - 3)}...`;
}

// Coerce unknown numeric-like values into numbers with a safe fallback.
function numberValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

// Normalize optional string-like values from API payloads.
function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Escape HTML before injecting dynamic text into page markup.
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const app = new HealthDashboardApp();
app.init().catch((error) => {
  logger.error('Health dashboard bootstrap failed', {
    error: serializeUiError(error),
  });
  const banner = document.getElementById('statusBanner');
  if (banner) {
    banner.textContent = `Health dashboard failed to load: ${error.message}`;
    banner.dataset.tone = 'error';
  }
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added native Redis diagnostics browser logic for scheduler, schedule, work-item, and run visibility
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Request schedules with ?scope=all so operator diagnostics still show every user's schedules after per-user scoping landed
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('redis-visibility');

class RedisVisibilityApp {
  constructor() {
    this.state = createInitialState();
    this.elements = {
      redisSummary: document.getElementById('redisSummary'),
      refreshButton: document.getElementById('refreshButton'),
      runList: document.getElementById('runList'),
      scheduleTableBody: document.getElementById('scheduleTableBody'),
      statusBanner: document.getElementById('statusBanner'),
      workItemTableBody: document.getElementById('workItemTableBody'),
    };
  }

  async init() {
    logger.info('Initializing Redis visibility page');
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
    this.setStatus('Loading Redis-backed runtime diagnostics...', 'info');
    logger.info('Refreshing Redis visibility page');
    const requests = [
      requestJson('/api/v1/agent/scheduler/status'),
      // Operator diagnostics: show all users' schedules (?scope=all overrides per-user scoping).
      requestJson('/api/v1/agent/schedules?scope=all'),
      requestJson('/api/swarm/work-items?limit=12'),
      requestJson('/api/swarm/runs?limit=8'),
    ];

    const results = await Promise.allSettled(requests);
    this.state = buildRedisState(results);
    this.render();
    this.setStatus(buildStatusMessage(this.state), this.state.failedCount > 0 ? 'warning' : 'success');
    logger.info('Redis visibility refresh complete', {
      durationMs: Date.now() - startedAt,
      failedCount: this.state.failedCount,
      scheduleCount: this.state.schedules.length,
      workItemCount: this.state.workItems.length,
      runCount: this.state.runs.length,
    });
  }

  render() {
    renderMetrics(this.state);
    this.elements.redisSummary.innerHTML = renderSummaryCards(this.state);
    this.elements.scheduleTableBody.innerHTML = renderScheduleRows(this.state.schedules);
    this.elements.workItemTableBody.innerHTML = renderWorkItemRows(this.state.workItems);
    this.elements.runList.innerHTML = renderRunEntries(this.state.runs);
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }
}

// Create the empty Redis diagnostics state used before the first refresh.
function createInitialState() {
  return {
    failedCount: 0,
    refreshedAt: '',
    runs: [],
    schedules: [],
    scheduler: { isRunning: false, pollIntervalMs: 0, redisHealthy: false },
    workItems: [],
  };
}

// Normalize Promise.allSettled results into one renderable Redis diagnostics state.
function buildRedisState(results) {
  return {
    failedCount: countRejected(results),
    refreshedAt: new Date().toISOString(),
    runs: settledValue(results[3], [], normalizeRuns),
    schedules: settledValue(results[1], [], normalizeSchedules),
    scheduler: settledValue(results[0], { isRunning: false, pollIntervalMs: 0, redisHealthy: false }, normalizeScheduler),
    workItems: settledValue(results[2], [], normalizeWorkItems),
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
    logger.warn('Redis visibility payload normalization failed', {
      error: serializeUiError(error),
    });
    return fallback;
  }
}

// Count failed async data sources from the settled request array.
function countRejected(results) {
  return results.filter((result) => result.status === 'rejected').length;
}

// Normalize the scheduler status payload for Redis diagnostics rendering.
function normalizeScheduler(payload) {
  return {
    isRunning: payload?.isRunning === true,
    lastDispatchCompletedAt: readString(payload?.lastDispatchCompletedAt),
    pollIntervalMs: numberValue(payload?.pollIntervalMs),
    redisHealthy: payload?.redisHealthy === true,
  };
}

// Normalize the schedules payload for Redis diagnostics rendering.
function normalizeSchedules(payload) {
  const schedules = Array.isArray(payload?.schedules) ? payload.schedules : [];
  return schedules.map((schedule) => ({
    name: readString(schedule.name || schedule.taskType || schedule.id),
    nextRunAt: readString(schedule.nextRunAt),
    scheduleText: readString(schedule.schedule || schedule.pattern),
    status: readString(schedule.status) || 'unknown',
    targetAgent: readString(schedule.taskData?.targetAgent),
  }));
}

// Normalize the work-item payload for Redis diagnostics rendering.
function normalizeWorkItems(payload) {
  const workItems = Array.isArray(payload?.workItems) ? payload.workItems : [];
  return workItems.map((item) => ({
    assignedAgentId: readString(item.assignedAgentId),
    status: readString(item.status) || 'unknown',
    title: readString(item.title) || 'Untitled work item',
    updatedAt: readString(item.updatedAt),
  }));
}

// Normalize the recent swarm runs payload for Redis diagnostics rendering.
function normalizeRuns(payload) {
  const runs = Array.isArray(payload?.runs) ? payload.runs : [];
  return runs.map((run) => ({
    count: numberValue(run.itemCount ?? run.processedCount),
    runId: readString(run.runId || run.id),
    status: readString(run.status) || 'unknown',
    updatedAt: readString(run.updatedAt || run.startedAt || run.createdAt),
  }));
}

// Render top-line Redis diagnostics metrics into the metric cards.
function renderMetrics(state) {
  const activeSchedules = state.schedules.filter((schedule) => schedule.status === 'active').length;
  const activeWorkItems = state.workItems.filter((item) => !['completed', 'failed', 'escalated'].includes(item.status)).length;
  setText('metricRedisStatus', state.scheduler.redisHealthy ? 'Connected' : 'Unavailable');
  setText('metricScheduleCount', `${activeSchedules}/${state.schedules.length}`);
  setText('metricWorkItems', activeWorkItems);
  setText('metricRuns', state.runs.length);
}

// Render the Redis summary card grid.
function renderSummaryCards(state) {
  const cards = [
    renderSummaryCard('Scheduler Running', state.scheduler.isRunning ? 'Yes' : 'No'),
    renderSummaryCard('Poll Interval', formatPollInterval(state.scheduler.pollIntervalMs)),
    renderSummaryCard('Last Dispatch', formatDateTime(state.scheduler.lastDispatchCompletedAt)),
    renderSummaryCard('Visible Schedules', state.schedules.length),
    renderSummaryCard('Visible Work Items', state.workItems.length),
    renderSummaryCard('Recent Runs', state.runs.length),
  ];
  return cards.join('');
}

// Render one summary card inside the Redis summary grid.
function renderSummaryCard(label, value) {
  return `<article class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value || '—'))}</strong></article>`;
}

// Render schedule rows or an empty-state row when no data exists.
function renderScheduleRows(schedules) {
  if (!schedules.length) {
    return renderEmptyRow('No schedules are available yet.', 4);
  }

  return schedules.map((schedule) => `
    <tr>
      <td>
        <strong>${escapeHtml(schedule.name)}</strong>
        <div class="mono">${escapeHtml(schedule.scheduleText || 'No schedule string')}</div>
      </td>
      <td>${escapeHtml(schedule.status)}</td>
      <td>${escapeHtml(formatDateTime(schedule.nextRunAt))}</td>
      <td>${escapeHtml(schedule.targetAgent || 'Default agent')}</td>
    </tr>
  `).join('');
}

// Render work-item rows or an empty-state row when no data exists.
function renderWorkItemRows(workItems) {
  if (!workItems.length) {
    return renderEmptyRow('No swarm work items are available yet.', 4);
  }

  return workItems.map((item) => `
    <tr>
      <td><strong>${escapeHtml(item.title)}</strong></td>
      <td>${escapeHtml(item.status)}</td>
      <td>${escapeHtml(item.assignedAgentId || 'Unassigned')}</td>
      <td>${escapeHtml(formatDateTime(item.updatedAt))}</td>
    </tr>
  `).join('');
}

// Render recent run entries or an empty-state list item when no data exists.
function renderRunEntries(runs) {
  if (!runs.length) {
    return '<li class="empty-state">No recent swarm runs are available yet.</li>';
  }

  return runs.map((run) => `
    <li class="run-entry">
      <span class="mono">${escapeHtml(truncate(run.runId, 18))}</span>
      <strong>${escapeHtml(run.status)}</strong>
      <span>${escapeHtml(String(run.count))} work item(s) · ${escapeHtml(formatDateTime(run.updatedAt))}</span>
    </li>
  `).join('');
}

// Render one full-width empty-state table row.
function renderEmptyRow(message, colspan) {
  return `<tr><td colspan="${colspan}"><div class="empty-state">${escapeHtml(message)}</div></td></tr>`;
}

// Perform one authenticated JSON request for the Redis diagnostics page.
async function requestJson(url) {
  const startedAt = Date.now();
  logger.debug('Redis visibility request started', { url });
  const response = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    logger.warn('Redis visibility request failed', {
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
    throw new Error(errorMessage);
  }
  const payload = await response.json();
  logger.info('Redis visibility request completed', {
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
    return `Redis diagnostics refreshed successfully at ${refreshedAt}.`;
  }
  return `Redis diagnostics refreshed with ${state.failedCount} degraded data source(s) at ${refreshedAt}.`;
}

// Safely set text content on one DOM element by id.
function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = String(value);
  }
}

// Format one ISO timestamp for operator display.
function formatDateTime(value) {
  if (!readString(value)) {
    return '—';
  }
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// Format a scheduler polling interval in milliseconds.
function formatPollInterval(value) {
  const milliseconds = numberValue(value);
  if (milliseconds <= 0) {
    return '—';
  }
  return `${Math.round(milliseconds / 1000)}s`;
}

// Truncate long identifiers for compact list rendering.
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

const app = new RedisVisibilityApp();
app.init().catch((error) => {
  logger.error('Redis visibility bootstrap failed', {
    error: serializeUiError(error),
  });
  const banner = document.getElementById('statusBanner');
  if (banner) {
    banner.textContent = `Redis diagnostics failed to load: ${error.message}`;
    banner.dataset.tone = 'error';
  }
});

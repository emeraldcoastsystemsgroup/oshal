/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added native queue-dashboard controller for refresh button usability, live status messaging, and real-data rendering
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added ticket fetching and rendering to display active tickets in queue dashboard
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Request schedules with ?scope=all so the operator dashboard still shows every user's schedules after per-user scoping landed
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('queue-dashboard');

class QueueDashboardApp {
  constructor() {
    this.state = createInitialState();
    this.elements = {
      refreshButton: document.getElementById('refreshButton'),
      runsTable: document.getElementById('runsTable'),
      schedulesTable: document.getElementById('schedulesTable'),
      statRuns: document.getElementById('statRuns'),
      statScheduler: document.getElementById('statScheduler'),
      statSchedules: document.getElementById('statSchedules'),
      statTickets: document.getElementById('statTickets'),
      statWorkItems: document.getElementById('statWorkItems'),
      statusBanner: document.getElementById('statusBanner'),
      ticketsTable: document.getElementById('ticketsTable'),
      workItemsTable: document.getElementById('workItemsTable'),
    };
  }

  async init() {
    logger.info('Initializing queue dashboard');
    this.bindEvents();
    await this.refresh();
    window.setInterval(() => {
      void this.refresh();
    }, 30000);
  }

  bindEvents() {
    this.elements.refreshButton.addEventListener('click', async () => {
      await this.refresh();
    });
  }

  async refresh() {
    const startedAt = Date.now();
    this.setStatus('Loading queue dashboard...', 'info');
    logger.info('Refreshing queue dashboard');
    const requests = [
      requestJson('/api/v1/agent/scheduler/status'),
      // Operator dashboard: show all users' schedules (?scope=all overrides per-user scoping).
      requestJson('/api/v1/agent/schedules?scope=all'),
      requestJson('/api/swarm/work-items?limit=12'),
      requestJson('/api/swarm/runs?limit=8'),
      requestJson('/api/tickets/active?limit=50'),
    ];

    const results = await Promise.allSettled(requests);
    this.state = buildQueueState(results);
    this.render();
    const tone = this.state.failedCount === 0 ? 'success' : 'warning';
    this.setStatus(buildStatusMessage(this.state), tone);
    logger.info('Queue dashboard refresh complete', {
      durationMs: Date.now() - startedAt,
      failedCount: this.state.failedCount,
      ticketCount: this.state.tickets.length,
      scheduleCount: this.state.schedules.length,
      workItemCount: this.state.workItems.length,
      runCount: this.state.runs.length,
    });
  }

  render() {
    this.elements.statScheduler.textContent = this.state.scheduler.running ? 'Active' : 'Idle';
    this.elements.statTickets.textContent = String(this.state.tickets.length);
    this.elements.statSchedules.textContent = String(this.state.schedules.length);
    this.elements.statWorkItems.textContent = String(this.state.workItems.length);
    this.elements.statRuns.textContent = String(this.state.runs.length);
    this.elements.ticketsTable.innerHTML = renderTicketsTable(this.state.tickets);
    this.elements.schedulesTable.innerHTML = renderSchedulesTable(this.state.schedules);
    this.elements.workItemsTable.innerHTML = renderWorkItemsTable(this.state.workItems);
    this.elements.runsTable.innerHTML = renderRunsTable(this.state.runs);
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }
}

function createInitialState() {
  return {
    failedCount: 0,
    refreshedAt: '',
    runs: [],
    schedules: [],
    scheduler: { running: false },
    tickets: [],
    workItems: [],
  };
}

function buildQueueState(results) {
  return {
    failedCount: countRejected(results),
    refreshedAt: new Date().toISOString(),
    runs: readSettled(results[3], [], normalizeRuns),
    schedules: readSettled(results[1], [], normalizeSchedules),
    scheduler: readSettled(results[0], { running: false }, normalizeScheduler),
    tickets: readSettled(results[4], [], normalizeTickets),
    workItems: readSettled(results[2], [], normalizeWorkItems),
  };
}

function readSettled(result, fallback, normalizer) {
  if (!result || result.status !== 'fulfilled') {
    return fallback;
  }
  try {
    return normalizer(result.value);
  } catch (error) {
    logger.warn('Queue dashboard payload normalization failed', {
      error: serializeUiError(error),
    });
    return fallback;
  }
}

function countRejected(results) {
  return results.filter((result) => result.status === 'rejected').length;
}

function normalizeScheduler(payload) {
  return {
    running: payload?.isRunning === true || payload?.enabled === true,
  };
}

function normalizeSchedules(payload) {
  const schedules = Array.isArray(payload?.schedules) ? payload.schedules : payload;
  const list = Array.isArray(schedules) ? schedules : [];
  return list.map((schedule) => ({
    agentId: readString(schedule.agentId || schedule.agent_id || schedule.targetAgent),
    interval: readString(schedule.interval || schedule.cron || schedule.schedule),
    nextRunAt: readString(schedule.nextRunAt || schedule.nextRun || schedule.next_run),
    status: readString(schedule.status) || 'active',
    type: readString(schedule.type || schedule.taskType || schedule.task_type || 'schedule'),
  }));
}

function normalizeWorkItems(payload) {
  const items = Array.isArray(payload?.workItems) ? payload.workItems : payload?.items;
  const list = Array.isArray(items) ? items : [];
  return list.map((item) => ({
    agentId: readString(item.agentId || item.agent_id || item.assignedAgentId),
    createdAt: readString(item.createdAt || item.created_at),
    id: readString(item.id || item.work_item_id),
    status: readString(item.status) || 'unknown',
    type: readString(item.type || item.work_type),
  }));
}

function normalizeRuns(payload) {
  const runs = Array.isArray(payload?.runs) ? payload.runs : [];
  return runs.map((run) => ({
    duration: numberValue(run.duration),
    runId: readString(run.runId || run.id),
    startedAt: readString(run.startedAt || run.started_at),
    status: readString(run.status) || 'unknown',
    ticketId: readString(run.ticketId || run.ticket_id),
  }));
}

function normalizeTickets(payload) {
  const tickets = Array.isArray(payload?.tickets) ? payload.tickets : [];
  return tickets.map((ticket) => ({
    assignee: readString(ticket?.assignee_detail?.display_name) || 'unassigned',
    id: readString(ticket?.id),
    name: readString(ticket?.name) || 'Untitled ticket',
    priority: readString(ticket?.priority) || 'medium',
    sequenceId: numberValue(ticket?.sequence_id),
    stateGroup: readString(ticket?.state_detail?.group) || 'started',
    stateName: readString(ticket?.state_detail?.name) || 'Unknown',
    updatedAt: readString(ticket?.updated_at),
  }));
}

function renderTicketsTable(tickets) {
  if (!tickets.length) {
    return renderEmptyState('No ticket data is available.');
  }

  const rows = tickets.map((ticket) => `
    <tr>
      <td><strong>#${escapeHtml(String(ticket.sequenceId || '—'))}</strong></td>
      <td>${escapeHtml(ticket.name)}</td>
      <td>${renderStatusBadge(ticket.stateGroup)}</td>
      <td>${escapeHtml(ticket.stateName)}</td>
      <td>${escapeHtml(ticket.assignee)}</td>
      <td>${escapeHtml(ticket.priority)}</td>
      <td>${escapeHtml(formatDateTime(ticket.updatedAt))}</td>
    </tr>
  `).join('');

  return renderTable(['#', 'Name', 'Group', 'State', 'Assignee', 'Priority', 'Updated'], rows);
}

function renderSchedulesTable(schedules) {
  if (!schedules.length) {
    return renderEmptyState('No schedule data is available.');
  }

  const rows = schedules.map((schedule) => `
    <tr>
      <td>${escapeHtml(schedule.agentId || '—')}</td>
      <td>${escapeHtml(schedule.type || 'schedule')}</td>
      <td>${escapeHtml(schedule.interval || '—')}</td>
      <td>${escapeHtml(formatDateTime(schedule.nextRunAt))}</td>
      <td>${renderStatusBadge(schedule.status)}</td>
    </tr>
  `).join('');

  return renderTable(['Agent', 'Type', 'Interval', 'Next Run', 'Status'], rows);
}

function renderWorkItemsTable(workItems) {
  if (!workItems.length) {
    return renderEmptyState('No work-item data is available.');
  }

  const rows = workItems.map((item) => `
    <tr>
      <td class="mono">${escapeHtml(truncate(item.id, 10))}</td>
      <td>${escapeHtml(item.type || '—')}</td>
      <td>${renderStatusBadge(item.status)}</td>
      <td>${escapeHtml(item.agentId || '—')}</td>
      <td>${escapeHtml(formatDateTime(item.createdAt))}</td>
    </tr>
  `).join('');

  return renderTable(['ID', 'Type', 'Status', 'Agent', 'Created'], rows);
}

function renderRunsTable(runs) {
  if (!runs.length) {
    return renderEmptyState('No run data is available.');
  }

  const rows = runs.map((run) => `
    <tr>
      <td class="mono">${escapeHtml(truncate(run.runId, 10))}</td>
      <td class="mono">${escapeHtml(truncate(run.ticketId, 10))}</td>
      <td>${renderStatusBadge(run.status)}</td>
      <td>${escapeHtml(formatDateTime(run.startedAt))}</td>
      <td>${escapeHtml(run.duration > 0 ? `${run.duration}s` : '—')}</td>
    </tr>
  `).join('');

  return renderTable(['Run ID', 'Ticket', 'Status', 'Started', 'Duration'], rows);
}

function renderTable(headers, bodyRows) {
  return `
    <table>
      <thead>
        <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>
  `;
}

function renderEmptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function renderStatusBadge(status) {
  const lowered = readString(status).toLowerCase();
  const className = resolveStatusClass(lowered);
  const label = lowered || 'unknown';
  return `<span class="status-badge ${className}">${escapeHtml(label)}</span>`;
}

function resolveStatusClass(status) {
  if (['completed', 'success', 'succeeded', 'active', 'running'].includes(status)) {
    return 'status-active';
  }
  if (['failed', 'error'].includes(status)) {
    return 'status-error';
  }
  return 'status-idle';
}

function buildStatusMessage(state) {
  const refreshedAt = formatDateTime(state.refreshedAt);
  if (state.failedCount === 0) {
    return `Queue dashboard refreshed successfully at ${refreshedAt}.`;
  }
  return `Queue dashboard refreshed with ${state.failedCount} degraded source(s) at ${refreshedAt}.`;
}

async function requestJson(url) {
  const startedAt = Date.now();
  logger.debug('Queue dashboard request started', { url });
  const response = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    logger.warn('Queue dashboard request failed', {
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
    throw new Error(errorMessage);
  }

  const payload = await response.json();
  logger.info('Queue dashboard request completed', {
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return payload;
}

async function readErrorMessage(response) {
  const fallback = `${response.status} ${response.statusText}`;
  const bodyText = await response.text();
  if (!bodyText.trim()) {
    return fallback;
  }
  return fallback;
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(value, size) {
  const text = readString(value);
  if (!text || text.length <= size) {
    return text || '—';
  }
  return `${text.slice(0, size)}…`;
}

function formatDateTime(value) {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new QueueDashboardApp();
  window.__queueDashboard = app;
  void app.init().catch((error) => {
    logger.error('Queue dashboard bootstrap failed', {
      error: serializeUiError(error),
    });
  });
});

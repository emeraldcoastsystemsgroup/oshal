/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added user dashboard logic with polling metrics, ticket charts, and live activity SSE updates
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Reconnect activity SSE when primary ticket changes
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('user-dashboard');

class UserDashboardApp {
  constructor() {
    this.state = createInitialState();
    this.elements = {
      refreshButton: document.getElementById('refreshButton'),
      statusBanner: document.getElementById('statusBanner'),
      ticketChart: document.getElementById('ticketChart'),
      ticketChartCaption: document.getElementById('ticketChartCaption'),
      throughputChart: document.getElementById('throughputChart'),
      throughputCaption: document.getElementById('throughputCaption'),
      activityFeed: document.getElementById('activityFeed'),
      activityCaption: document.getElementById('activityCaption'),
    };
    this.pollingIntervalId = null;
    this.activityStream = null;
  }

  async init() {
    logger.info('Initializing user dashboard');
    this.bindEvents();
    await this.refresh();
    this.startPolling();
    this.connectActivityStream();
  }

  bindEvents() {
    this.elements.refreshButton.addEventListener('click', async () => {
      await this.refresh();
    });
  }

  async refresh() {
    const startedAt = Date.now();
    this.setStatus('Loading user dashboard...', 'info');
    logger.info('Refreshing user dashboard');

    const requests = [
      requestJson('/api/user'),
      requestJson('/api/v1/metrics/summary'),
      requestJson('/api/v1/tickets/hierarchy'),
      requestJson('/api/v1/metrics/agents'),
    ];

    const results = await Promise.allSettled(requests);
    const previousTicketId = this.state.primaryTicketId;
    this.state = buildDashboardState(results, this.state);
    this.render();

    if (previousTicketId !== this.state.primaryTicketId) {
      this.connectActivityStream();
    }

    const tone = this.state.failedCount > 0 ? 'warning' : 'success';
    this.setStatus(buildStatusMessage(this.state), tone);
    logger.info('User dashboard refresh complete', {
      durationMs: Date.now() - startedAt,
      failedCount: this.state.failedCount,
      ticketCount: this.state.tickets.length,
      activityCount: this.state.activityFeed.length,
    });
  }

  render() {
    renderMetrics(this.state);
    this.elements.ticketChart.innerHTML = renderTicketChart(this.state.tickets);
    this.elements.ticketChartCaption.textContent = buildTicketCaption(this.state.tickets);
    this.elements.throughputChart.innerHTML = renderThroughputChart(this.state.metrics);
    this.elements.throughputCaption.textContent = buildThroughputCaption(this.state.metrics);
    this.elements.activityFeed.innerHTML = renderActivityFeed(this.state.activityFeed);
    this.elements.activityCaption.textContent = this.state.activityFeed.length
      ? `Updated ${formatDateTime(this.state.activityUpdatedAt)}.`
      : 'Waiting for activity updates...';
  }

  startPolling() {
    this.stopPolling();
    this.pollingIntervalId = window.setInterval(() => {
      void this.refresh();
    }, 45000);
  }

  stopPolling() {
    if (this.pollingIntervalId) {
      window.clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
  }

  connectActivityStream() {
    this.disconnectActivityStream();
    if (!this.state.primaryTicketId) {
      this.elements.activityCaption.textContent = 'No active tickets yet.';
      return;
    }

    const url = `/api/v1/tickets/${encodeURIComponent(this.state.primaryTicketId)}/activity/stream`;
    this.activityStream = new EventSource(url, { withCredentials: true });
    logger.info('Connecting to ticket activity stream', { url });

    this.activityStream.addEventListener('connected', () => {
      logger.info('User dashboard activity stream connected', { ticketId: this.state.primaryTicketId });
      this.elements.activityCaption.textContent = 'Live updates connected.';
    });

    this.activityStream.addEventListener('ticket-activity', (event) => {
      try {
        const payload = JSON.parse(event.data);
        this.handleActivityEntry(payload, 'live');
      } catch (error) {
        logger.warn('Failed to parse activity SSE payload', { error: serializeUiError(error) });
      }
    });

    this.activityStream.onerror = () => {
      this.elements.activityCaption.textContent = 'Live updates reconnecting...';
    };
  }

  disconnectActivityStream() {
    if (this.activityStream) {
      this.activityStream.close();
      this.activityStream = null;
    }
  }

  handleActivityEntry(entry, source) {
    const normalized = normalizeActivityEntry(entry);
    if (!normalized) {
      return;
    }
    const nextFeed = [normalized, ...this.state.activityFeed].slice(0, 12);
    this.state = {
      ...this.state,
      activityFeed: nextFeed,
      activityUpdatedAt: new Date().toISOString(),
    };
    this.elements.activityFeed.innerHTML = renderActivityFeed(this.state.activityFeed);
    this.elements.activityCaption.textContent = `${source === 'live' ? 'Live' : 'Polled'} update ${formatDateTime(this.state.activityUpdatedAt)}.`;
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }
}

function createInitialState() {
  return {
    failedCount: 0,
    metrics: { active: 0, queue: 0, done: 0, cost: 0, agents: 0, total: 0, avgProcessingTimeFormatted: '' },
    tickets: [],
    activityFeed: [],
    activityUpdatedAt: '',
    primaryTicketId: '',
    user: null,
  };
}

function buildDashboardState(results, previousState) {
  const user = settledValue(results[0], previousState.user, (payload) => payload?.user ?? null);
  const metrics = settledValue(results[1], previousState.metrics, normalizeMetricsSummary);
  const tickets = settledValue(results[2], [], flattenTicketHierarchy);
  const agents = settledValue(results[3], [], normalizeAgents);
  const ticketCounts = countTicketGroups(tickets);
  const activityFeed = previousState.activityFeed.length
    ? previousState.activityFeed
    : buildActivityFeed(tickets).slice(0, 6);

  return {
    failedCount: countRejected(results),
    metrics: {
      ...metrics,
      active: ticketCounts.started,
      queue: ticketCounts.unstarted,
      done: ticketCounts.done + ticketCounts.cancelled,
      agents: agents.length,
    },
    tickets,
    activityFeed,
    activityUpdatedAt: previousState.activityUpdatedAt || new Date().toISOString(),
    primaryTicketId: selectPrimaryTicketId(tickets) || previousState.primaryTicketId,
    user,
  };
}

function settledValue(result, fallback, normalizer) {
  if (!result || result.status !== 'fulfilled') {
    return fallback;
  }

  try {
    return normalizer(result.value);
  } catch (error) {
    logger.warn('User dashboard payload normalization failed', {
      error: serializeUiError(error),
    });
    return fallback;
  }
}

function countRejected(results) {
  return results.filter((result) => result.status === 'rejected').length;
}

function normalizeMetricsSummary(payload) {
  const data = payload?.data || payload || {};
  return {
    active: numberValue(data.active ?? data.inProgress),
    queue: numberValue(data.queue),
    done: numberValue(data.done),
    cost: numberValue(data.estimatedTotalCost),
    total: numberValue(data.total),
    avgProcessingTimeFormatted: readString(data.avgProcessingTimeFormatted),
    agents: numberValue(data.agents?.total),
  };
}

function normalizeAgents(payload) {
  return Array.isArray(payload?.agents) ? payload.agents : [];
}

function flattenTicketHierarchy(payload) {
  const tickets = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : payload?.tickets || [];
  const flat = [];
  const visit = (ticket) => {
    if (!ticket) return;
    flat.push({
      id: readString(ticket.id),
      name: readString(ticket.name) || 'Untitled ticket',
      state: readString(ticket.state) || 'unknown',
      projectIdentifier: readString(ticket.project_identifier) || 'TASK',
      sequenceId: readString(ticket.sequence_id) || '0000',
      updatedAt: readString(ticket.updated_at || ticket.updatedAt),
    });
    (ticket.children || []).forEach(visit);
  };
  (Array.isArray(payload?.data) ? payload.data : payload?.data || tickets || []).forEach(visit);
  return flat;
}

function countTicketGroups(tickets) {
  return tickets.reduce((counts, ticket) => {
    const state = ticket.state || 'unknown';
    if (state === 'done') {
      counts.done += 1;
    } else if (state === 'cancelled') {
      counts.cancelled += 1;
    } else if (state === 'backlog' || state === 'queued' || state === 'unstarted') {
      counts.unstarted += 1;
    } else {
      counts.started += 1;
    }
    return counts;
  }, { unstarted: 0, started: 0, done: 0, cancelled: 0 });
}

function selectPrimaryTicketId(tickets) {
  const sorted = [...tickets].filter((ticket) => ticket.id).sort((a, b) => {
    return asEpoch(b.updatedAt) - asEpoch(a.updatedAt);
  });
  return sorted[0]?.id || '';
}

function buildActivityFeed(tickets) {
  return tickets
    .filter((ticket) => ticket.id)
    .sort((a, b) => asEpoch(b.updatedAt) - asEpoch(a.updatedAt))
    .slice(0, 8)
    .map((ticket) => ({
      title: `${ticket.projectIdentifier}-${ticket.sequenceId} · ${ticket.name}`,
      detail: `Ticket moved to ${ticket.state}.`,
      timestamp: ticket.updatedAt || new Date().toISOString(),
      source: 'snapshot',
    }));
}

function normalizeActivityEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  return {
    title: readString(entry.title) || readString(entry.type) || 'Activity update',
    detail: readString(entry.summary) || readString(entry.detail) || 'Ticket activity updated.',
    timestamp: readString(entry.timestamp) || new Date().toISOString(),
    source: readString(entry.source) || 'live',
  };
}

function renderMetrics(state) {
  setText('metricActive', state.metrics.active);
  setText('metricQueue', state.metrics.queue);
  setText('metricAgents', state.metrics.agents);
  setText('metricCost', formatCurrency(state.metrics.cost));
}

function renderTicketChart(tickets) {
  const counts = countTicketGroups(tickets);
  const total = counts.unstarted + counts.started + counts.done + counts.cancelled;
  if (total === 0) {
    return '<div class="empty-state">No tickets available for the current user.</div>';
  }

  return [
    buildChartRow('Queued', counts.unstarted, total),
    buildChartRow('Active', counts.started, total),
    buildChartRow('Done', counts.done, total),
    buildChartRow('Cancelled', counts.cancelled, total),
  ].join('');
}

function renderThroughputChart(metrics) {
  const total = Math.max(metrics.total, metrics.active + metrics.queue + metrics.done);
  if (total === 0) {
    return '<div class="empty-state">No throughput data available yet.</div>';
  }

  return [
    buildChartRow('In Progress', metrics.active, total),
    buildChartRow('Queued', metrics.queue, total),
    buildChartRow('Completed', metrics.done, total),
  ].join('');
}

function buildTicketCaption(tickets) {
  if (!tickets.length) {
    return 'No tickets tracked yet.';
  }
  const counts = countTicketGroups(tickets);
  return `${counts.started} active · ${counts.unstarted} queued · ${counts.done} done`;
}

function buildThroughputCaption(metrics) {
  if (!metrics.total) {
    return 'No throughput summary available.';
  }
  const avg = metrics.avgProcessingTimeFormatted || '—';
  return `${metrics.total} total tasks tracked · Avg processing ${avg}`;
}

function buildChartRow(label, value, total) {
  const percentage = total > 0 ? Math.round((value / total) * 100) : 0;
  return `
    <div class="chart-row">
      <span class="chart-label">${escapeHtml(label)}</span>
      <div class="chart-track">
        <div class="chart-fill" style="width: ${percentage}%"></div>
      </div>
      <span class="chart-value">${escapeHtml(String(value))}</span>
    </div>
  `;
}

function renderActivityFeed(feed) {
  if (!feed.length) {
    return '<li class="empty-state">No recent activity yet.</li>';
  }

  return feed.map((entry) => `
    <li class="activity-item">
      <strong>${escapeHtml(entry.title)}</strong>
      <span>${escapeHtml(entry.detail)}</span>
      <span class="activity-meta">${escapeHtml(formatDateTime(entry.timestamp))}</span>
    </li>
  `).join('');
}

async function requestJson(url) {
  const startedAt = Date.now();
  logger.debug('User dashboard request started', { url });
  const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    logger.warn('User dashboard request failed', {
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
    throw new Error(errorMessage);
  }
  const payload = await response.json();
  logger.info('User dashboard request completed', {
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return payload;
}

async function readErrorMessage(response) {
  const fallback = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    return readString(body?.error) || fallback;
  } catch (_error) {
    return fallback;
  }
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = String(value);
  }
}

function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(numberValue(value));
}

function formatDateTime(value) {
  if (!readString(value)) {
    return '—';
  }
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function asEpoch(value) {
  if (!readString(value)) {
    return 0;
  }
  const epoch = new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : 0;
}

function numberValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildStatusMessage(state) {
  const refreshedAt = formatDateTime(new Date().toISOString());
  if (state.failedCount === 0) {
    return `User dashboard refreshed successfully at ${refreshedAt}.`;
  }
  return `User dashboard refreshed with ${state.failedCount} degraded source(s) at ${refreshedAt}.`;
}

const app = new UserDashboardApp();
app.init().catch((error) => {
  logger.error('User dashboard bootstrap failed', {
    error: serializeUiError(error),
  });
  const banner = document.getElementById('statusBanner');
  if (banner) {
    banner.textContent = `User dashboard failed to load: ${error.message}`;
    banner.dataset.tone = 'error';
  }
});
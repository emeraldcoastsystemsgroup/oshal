/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added native queue manager admin browser logic with real process-flow telemetry
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BF-030: Show bot name alongside UUID in agent load table
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added estimated cost, token, and model-usage rollups to the queue admin flow and swarm agent tables
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('queue-manager-admin');

class QueueManagerAdminApp {
  constructor() {
    this.state = createInitialState();
    this.elements = {
      agentTableBody: document.getElementById('agentTableBody'),
      dispatchTableBody: document.getElementById('dispatchTableBody'),
      flowGrid: document.getElementById('flowGrid'),
      modelTableBody: document.getElementById('modelTableBody'),
      projectTableBody: document.getElementById('projectTableBody'),
      refreshButton: document.getElementById('refreshButton'),
      runList: document.getElementById('runList'),
      statusBanner: document.getElementById('statusBanner'),
      ticketTableBody: document.getElementById('ticketTableBody'),
    };
  }

  async init() {
    logger.info('Initializing queue manager admin');
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
    this.setStatus('Loading queue manager flow...', 'info');
    logger.info('Refreshing queue manager admin');
    const requests = [
      requestJson('/api/qm/activity'),
      requestJson('/api/v1/agent/scheduler/status'),
      requestJson('/api/swarm/work-items?limit=25'),
      requestJson('/api/swarm/runs?limit=12'),
      requestJson('/api/tickets/active?limit=50'),
    ];

    const results = await Promise.allSettled(requests);
    this.state = buildQueueAdminState(results);
    this.render();

    const tone = this.state.failedCount > 0 ? 'warning' : 'success';
    this.setStatus(buildStatusMessage(this.state), tone);
    logger.info('Queue manager admin refresh complete', {
      durationMs: Date.now() - startedAt,
      failedCount: this.state.failedCount,
      dispatchCount: this.state.activity.dispatches.length,
      workItemCount: this.state.workItems.length,
      runCount: this.state.runs.length,
    });
  }

  render() {
    renderMetrics(this.state);
    this.elements.flowGrid.innerHTML = renderFlowCards(this.state);
    this.elements.agentTableBody.innerHTML = renderAgentRows(this.state.activity);
    this.elements.dispatchTableBody.innerHTML = renderDispatchRows(this.state.activity);
    this.elements.modelTableBody.innerHTML = renderModelRows(this.state.activity);
    this.elements.projectTableBody.innerHTML = renderProjectRows(this.state.activity);
    this.elements.runList.innerHTML = renderRunEntries(this.state.runs);
    this.elements.ticketTableBody.innerHTML = renderTicketRows(this.state.activity);
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }
}

// Create the empty queue-admin state used before the first refresh.
function createInitialState() {
  return {
    activity: {
      agentTicketMappings: {},
      agents: [],
      dispatches: [],
      modelUsage: [],
      projectUsage: [],
      ticketUsage: [],
      ticketPhases: {},
    },
    failedCount: 0,
    refreshedAt: '',
    runs: [],
    scheduler: {
      isRunning: false,
      pollIntervalMs: 0,
      redisHealthy: false,
    },
    tickets: [],
    workItems: [],
  };
}

// Normalize Promise.allSettled results into one renderable queue-admin state.
function buildQueueAdminState(results) {
  return {
    activity: settledValue(results[0], createInitialState().activity, normalizeQmActivity),
    failedCount: countRejected(results),
    refreshedAt: new Date().toISOString(),
    runs: settledValue(results[3], [], normalizeRuns),
    scheduler: settledValue(results[1], createInitialState().scheduler, normalizeScheduler),
    tickets: settledValue(results[4], [], normalizeTickets),
    workItems: settledValue(results[2], [], normalizeWorkItems),
  };
}

// Read one fulfilled Promise result or return fallback when a source failed.
function settledValue(result, fallback, normalizer) {
  if (!result || result.status !== 'fulfilled') {
    return fallback;
  }

  try {
    return normalizer(result.value);
  } catch (error) {
    logger.warn('Queue manager admin payload normalization failed', {
      error: serializeUiError(error),
    });
    return fallback;
  }
}

// Count failed async data sources from the settled array.
function countRejected(results) {
  return results.filter((result) => result.status === 'rejected').length;
}

// Normalize scheduler health payload.
function normalizeScheduler(payload) {
  return {
    isRunning: payload?.isRunning === true,
    pollIntervalMs: numberValue(payload?.pollIntervalMs),
    redisHealthy: payload?.redisHealthy === true,
  };
}

// Normalize queue-manager activity payload.
function normalizeQmActivity(payload) {
  const rawAgents = asRecord(payload?.agents);
  const rawDispatches = asRecord(payload?.dispatches);
  const rawModelUsage = asRecord(payload?.modelUsage);
  const rawProjectUsage = asRecord(payload?.projectUsage);
  const rawTicketUsage = asRecord(payload?.ticketUsage);

  const agents = Object.entries(rawAgents).map(([agentId, details]) => ({
    agentId,
    agentName: readString(details?.agent_name) || '',
    currentLoad: numberValue(details?.current_load),
    latestModel: readString(details?.latest_model),
    maxConcurrent: numberValue(details?.max_concurrent),
    status: readString(details?.status) || 'unknown',
    totalCost: numberValue(details?.total_cost),
    totalRequests: numberValue(details?.total_requests),
    totalTokens: numberValue(details?.total_tokens),
    usageByModel: asRecord(details?.usage_by_model),
  }));

  const dispatches = Object.entries(rawDispatches).map(([dispatchId, details]) => ({
    dispatchId,
    agentId: readString(details?.agentId),
    modelId: readString(details?.modelId),
    status: readString(details?.status) || 'unknown',
    ticketId: readString(details?.ticketId),
    totalCost: numberValue(details?.totalCost),
    totalTokens: numberValue(details?.totalTokens),
    updatedAt: readString(details?.updatedAt),
  }));

  const modelUsage = Object.entries(rawModelUsage)
    .map(([modelId, details]) => ({
      modelId,
      agentCount: numberValue(details?.agentCount),
      agents: Array.isArray(details?.agents) ? details.agents.map((entry) => readString(entry)).filter(Boolean) : [],
      requestCount: numberValue(details?.requestCount),
      totalCost: numberValue(details?.totalCost),
      totalTokens: numberValue(details?.totalTokens),
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens);

  const projectUsage = Object.entries(rawProjectUsage)
    .map(([projectId, details]) => ({
      projectId,
      projectName: readString(details?.projectName),
      requestCount: numberValue(details?.requestCount),
      taskCount: numberValue(details?.taskCount),
      ticketCount: numberValue(details?.ticketCount),
      tickets: Array.isArray(details?.tickets) ? details.tickets.map((entry) => readString(entry)).filter(Boolean) : [],
      totalCost: numberValue(details?.totalCost),
      totalTokens: numberValue(details?.totalTokens),
      usageByModel: asRecord(details?.usageByModel),
    }))
    .sort((left, right) => right.totalCost - left.totalCost || right.totalTokens - left.totalTokens);

  const ticketUsage = Object.entries(rawTicketUsage)
    .map(([ticketId, details]) => ({
      ticketId,
      agentId: readString(details?.agentId),
      modelId: readString(details?.modelId),
      projectId: readString(details?.projectId),
      projectName: readString(details?.projectName),
      requestCount: numberValue(details?.requestCount),
      taskCount: numberValue(details?.taskCount),
      totalCost: numberValue(details?.totalCost),
      totalTokens: numberValue(details?.totalTokens),
      updatedAt: readString(details?.updatedAt),
      usageByModel: asRecord(details?.usageByModel),
    }))
    .sort((left, right) => right.totalCost - left.totalCost || right.totalTokens - left.totalTokens);

  return {
    agentTicketMappings: asRecord(payload?.agentTicketMappings),
    agents,
    dispatches,
    modelUsage,
    projectUsage,
    ticketUsage,
    ticketPhases: asRecord(payload?.ticketPhases),
  };
}

// Normalize work-item payload for queue-flow calculations.
function normalizeWorkItems(payload) {
  const items = Array.isArray(payload?.workItems) ? payload.workItems : [];
  return items.map((item) => ({
    status: readString(item.status),
    workItemId: readString(item.workItemId || item.id),
  }));
}

// Normalize swarm-run payload for run-loop visibility.
function normalizeRuns(payload) {
  const runs = Array.isArray(payload?.runs) ? payload.runs : [];
  return runs.map((run) => ({
    runId: readString(run.runId || run.id),
    status: readString(run.status) || 'unknown',
    updatedAt: readString(run.updatedAt || run.startedAt || run.createdAt),
  }));
}

// Normalize legacy ticket list payload for stage-group metrics.
function normalizeTickets(payload) {
  const tickets = Array.isArray(payload?.tickets) ? payload.tickets : [];
  return tickets.map((ticket) => ({
    group: readString(ticket?.state_detail?.group),
    id: readString(ticket?.id),
  }));
}

// Render top-line metric cards.
function renderMetrics(state) {
  const ticketGroups = countTicketGroups(state.tickets);
  const dispatchCount = state.activity.dispatches.length;
  const runCount = state.runs.filter((run) => !isTerminalStatus(run.status)).length;
  const totalCost = state.activity.agents.reduce((sum, agent) => sum + numberValue(agent.totalCost), 0);
  const totalTokens = state.activity.agents.reduce((sum, agent) => sum + numberValue(agent.totalTokens), 0);
  const modelCount = state.activity.modelUsage.length;

  setText('metricScheduler', state.scheduler.redisHealthy ? 'Ready' : 'Degraded');
  setText('metricTickets', ticketGroups.started + ticketGroups.unstarted);
  setText('metricDispatches', dispatchCount);
  setText('metricRuns', runCount);
  setText('metricCost', formatCurrency(totalCost));
  setText('metricTokens', formatTokenCount(totalTokens));
  setText('metricModels', modelCount);
}

// Render process-flow cards showing queue lifecycle stages.
function renderFlowCards(state) {
  const cards = buildFlowSnapshot(state);
  return cards.map((card) => `
    <article class="flow-card">
      <div class="stage">${escapeHtml(card.stage)}</div>
      <div class="count">${escapeHtml(String(card.count))}</div>
      <div class="hint">${escapeHtml(card.hint)}</div>
    </article>
  `).join('');
}

// Build the queue process-flow stage snapshot from live state.
function buildFlowSnapshot(state) {
  const ticketGroups = countTicketGroups(state.tickets);
  const activeWorkItems = state.workItems.filter((item) => !isTerminalStatus(item.status)).length;
  const activeRuns = state.runs.filter((run) => !isTerminalStatus(run.status)).length;

  return [
    {
      stage: 'Intake',
      count: ticketGroups.unstarted,
      hint: 'Approved/backlog tickets waiting for dispatch.',
    },
    {
      stage: 'Dispatch',
      count: state.activity.dispatches.length,
      hint: 'Ticket dispatch entries currently tracked.',
    },
    {
      stage: 'Execution',
      count: activeWorkItems,
      hint: 'Non-terminal swarm work items in progress.',
    },
    {
      stage: 'Run Loop',
      count: activeRuns,
      hint: 'Swarm runs still processing or awaiting completion.',
    },
    {
      stage: 'Closed',
      count: ticketGroups.done + ticketGroups.cancelled,
      hint: 'Tickets that reached done or cancelled state.',
    },
  ];
}

// Render queue-agent load rows or an empty-state row.
function renderAgentRows(activity) {
  if (!activity.agents.length) {
    return renderEmptyRow('No queue-agent telemetry is available yet.', 7);
  }

  return activity.agents.map((agent) => {
    const mappedTickets = Array.isArray(activity.agentTicketMappings?.[agent.agentId])
      ? activity.agentTicketMappings[agent.agentId].length
      : 0;

    const label = agent.agentName || agent.agentId || 'unknown';
    return `
      <tr>
        <td>
          <strong>${escapeHtml(label)}</strong>
          <div class="row-subtext mono">${escapeHtml(agent.agentId || 'unknown')}</div>
        </td>
        <td>${escapeHtml(agent.status || 'unknown')}</td>
        <td>${escapeHtml(formatLoad(agent.currentLoad, agent.maxConcurrent))}</td>
        <td>${escapeHtml(String(mappedTickets))}</td>
        <td>${escapeHtml(agent.latestModel || topUsageModel(agent.usageByModel) || '—')}</td>
        <td>${escapeHtml(formatTokenCount(agent.totalTokens))}</td>
        <td>${escapeHtml(formatCurrency(agent.totalCost))}</td>
      </tr>
    `;
  }).join('');
}

// Render active dispatch rows or an empty-state row.
function renderDispatchRows(activity) {
  if (!activity.dispatches.length) {
    return renderEmptyRow('No active dispatch records are available.', 7);
  }

  return activity.dispatches.map((dispatch) => `
    <tr>
      <td class="mono">${escapeHtml(truncate(dispatch.ticketId || dispatch.dispatchId, 18))}</td>
      <td>${escapeHtml(dispatch.agentId || 'unassigned')}</td>
      <td>${escapeHtml(dispatch.modelId || '—')}</td>
      <td>${escapeHtml(formatTokenCount(dispatch.totalTokens))}</td>
      <td>${escapeHtml(formatCurrency(dispatch.totalCost))}</td>
      <td>${escapeHtml(dispatch.status || 'unknown')}</td>
      <td>${escapeHtml(formatDateTime(dispatch.updatedAt))}</td>
    </tr>
  `).join('');
}

// Render aggregated model usage rows or an empty-state row.
function renderModelRows(activity) {
  if (!activity.modelUsage.length) {
    return renderEmptyRow('No model telemetry has been recorded for the swarm yet.', 5);
  }

  return activity.modelUsage.map((entry) => `
    <tr>
      <td>${escapeHtml(entry.modelId || 'unknown')}</td>
      <td>${escapeHtml(String(entry.requestCount))}</td>
      <td>${escapeHtml(formatTokenCount(entry.totalTokens))}</td>
      <td>${escapeHtml(formatCurrency(entry.totalCost))}</td>
      <td title="${escapeHtml(entry.agents.join(', ') || 'No agents recorded')}">${escapeHtml(String(entry.agentCount))}</td>
    </tr>
  `).join('');
}

// Render aggregated project usage rows or an empty-state row.
function renderProjectRows(activity) {
  if (!activity.projectUsage.length) {
    return renderEmptyRow('No project usage has been recorded for the swarm yet.', 6);
  }

  return activity.projectUsage.map((entry) => `
    <tr>
      <td>
        <strong>${escapeHtml(entry.projectName || entry.projectId || 'unknown')}</strong>
        <div class="row-subtext mono">${escapeHtml(entry.projectId || 'unknown')}</div>
      </td>
      <td>${escapeHtml(String(entry.ticketCount || entry.tickets.length))}</td>
      <td>${escapeHtml(String(entry.requestCount))}</td>
      <td>${escapeHtml(formatTokenCount(entry.totalTokens))}</td>
      <td>${escapeHtml(formatCurrency(entry.totalCost))}</td>
      <td>${escapeHtml(topUsageModel(entry.usageByModel) || '—')}</td>
    </tr>
  `).join('');
}

// Render aggregated ticket usage rows or an empty-state row.
function renderTicketRows(activity) {
  if (!activity.ticketUsage.length) {
    return renderEmptyRow('No ticket usage has been recorded for the swarm yet.', 8);
  }

  return activity.ticketUsage.map((entry) => `
    <tr>
      <td class="mono">${escapeHtml(truncate(entry.ticketId, 18) || 'unknown')}</td>
      <td>
        <strong>${escapeHtml(entry.projectName || entry.projectId || 'unknown')}</strong>
        <div class="row-subtext mono">${escapeHtml(entry.projectId || 'unknown')}</div>
      </td>
      <td>${escapeHtml(entry.agentId || 'unassigned')}</td>
      <td>${escapeHtml(entry.modelId || topUsageModel(entry.usageByModel) || '—')}</td>
      <td>${escapeHtml(String(entry.requestCount))}</td>
      <td>${escapeHtml(formatTokenCount(entry.totalTokens))}</td>
      <td>${escapeHtml(formatCurrency(entry.totalCost))}</td>
      <td>${escapeHtml(formatDateTime(entry.updatedAt))}</td>
    </tr>
  `).join('');
}

// Render recent swarm-run entries or an empty-state item.
function renderRunEntries(runs) {
  if (!runs.length) {
    return '<li class="empty-state">No recent swarm runs are available for queue correlation.</li>';
  }

  return runs.map((run) => `
    <li class="run-entry">
      <span class="mono">${escapeHtml(truncate(run.runId, 24))}</span>
      <strong>${escapeHtml(run.status)}</strong>
      <span>${escapeHtml(formatDateTime(run.updatedAt))}</span>
    </li>
  `).join('');
}

// Render one full-width empty-state table row.
function renderEmptyRow(message, colspan) {
  return `<tr><td colspan="${colspan}"><div class="empty-state">${escapeHtml(message)}</div></td></tr>`;
}

// Build status-banner copy after one refresh completes.
function buildStatusMessage(state) {
  const refreshedAt = formatDateTime(state.refreshedAt);
  if (state.failedCount === 0) {
    return `Queue manager flow refreshed successfully at ${refreshedAt}.`;
  }

  return `Queue manager flow refreshed with ${state.failedCount} degraded source(s) at ${refreshedAt}.`;
}

// Perform one authenticated JSON request for queue-admin telemetry.
async function requestJson(url) {
  const startedAt = Date.now();
  logger.debug('Queue manager admin request started', { url });
  const response = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    logger.warn('Queue manager admin request failed', {
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
    throw new Error(errorMessage);
  }

  const payload = await response.json();
  logger.info('Queue manager admin request completed', {
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return payload;
}

// Read the most useful error message from a failed response.
async function readErrorMessage(response) {
  const fallback = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    return readString(body.error) || fallback;
  } catch (_error) {
    return fallback;
  }
}

// Safely set text content on one element by id.
function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = String(value);
  }
}

// Count tickets by legacy group for flow-stage calculations.
function countTicketGroups(tickets) {
  return tickets.reduce(
    (acc, ticket) => {
      const group = readString(ticket.group);
      if (group === 'done') {
        acc.done += 1;
      } else if (group === 'cancelled') {
        acc.cancelled += 1;
      } else if (group === 'unstarted') {
        acc.unstarted += 1;
      } else {
        acc.started += 1;
      }
      return acc;
    },
    { cancelled: 0, done: 0, started: 0, unstarted: 0 },
  );
}

// Format one current/max load string.
function formatLoad(currentLoad, maxConcurrent) {
  if (maxConcurrent <= 0) {
    return String(currentLoad);
  }
  return `${currentLoad}/${maxConcurrent}`;
}

// Format token totals with locale separators and compact fallback.
function formatTokenCount(totalTokens) {
  const count = numberValue(totalTokens);
  return count > 0 ? count.toLocaleString() : '0';
}

// Format estimated cost as USD for operator readability.
function formatCurrency(amount) {
  return `$${numberValue(amount).toFixed(6)}`;
}

// Pick the highest-token model from a usage-by-model map.
function topUsageModel(usageByModel) {
  const ranked = Object.entries(asRecord(usageByModel)).sort((left, right) =>
    numberValue(right[1]?.totalTokens) - numberValue(left[1]?.totalTokens),
  );
  return ranked[0]?.[0] || '';
}

// Detect terminal queue/run/work-item statuses.
function isTerminalStatus(status) {
  return ['completed', 'complete', 'failed', 'cancelled', 'done'].includes(readString(status));
}

// Format one ISO timestamp for operator display.
function formatDateTime(value) {
  if (!readString(value)) {
    return '—';
  }
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// Truncate long IDs for compact table/list rendering.
function truncate(value, length) {
  const text = readString(value);
  if (text.length <= length) {
    return text;
  }
  return `${text.slice(0, Math.max(0, length - 3))}...`;
}

// Coerce unknown numeric-like values into numbers with fallback.
function numberValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

// Normalize optional string-like values.
function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Normalize optional object values into record-like maps.
function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

// Escape HTML before injecting dynamic text into markup.
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const app = new QueueManagerAdminApp();
app.init().catch((error) => {
  logger.error('Queue manager admin bootstrap failed', {
    error: serializeUiError(error),
  });
  const banner = document.getElementById('statusBanner');
  if (banner) {
    banner.textContent = `Queue manager admin failed to load: ${error.message}`;
    banner.dataset.tone = 'error';
  }
});

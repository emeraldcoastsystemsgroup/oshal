/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added native ops dashboard browser logic for runtime health, dispatch flow, and operator attention telemetry
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('ops-dashboard');

class OpsDashboardApp {
  constructor() {
    this.state = createInitialState();
    this.elements = {
      agentTableBody: document.getElementById('agentTableBody'),
      attentionList: document.getElementById('attentionList'),
      flowGrid: document.getElementById('flowGrid'),
      nodeTableBody: document.getElementById('nodeTableBody'),
      refreshButton: document.getElementById('refreshButton'),
      statusBanner: document.getElementById('statusBanner'),
    };
  }

  async init() {
    logger.info('Initializing ops dashboard');
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
    this.setStatus('Loading ops process flow...', 'info');
    logger.info('Refreshing ops dashboard');
    const requests = [
      requestJson('/api/health'),
      requestJson('/api/v1/agent/scheduler/status'),
      requestJson('/api/tickets/active?limit=120'),
      requestJson('/api/swarm/work-items?limit=50'),
      requestJson('/api/swarm/runs?limit=20'),
      requestJson('/api/mesh/channels'),
      requestJson('/api/qm/activity'),
      requestJson('/api/health-dashboard/registry'),
    ];

    const results = await Promise.allSettled(requests);
    this.state = buildOpsState(results);
    this.render();

    const tone = this.state.failedCount > 0 ? 'warning' : 'success';
    this.setStatus(buildStatusMessage(this.state), tone);
    logger.info('Ops dashboard refresh complete', {
      durationMs: Date.now() - startedAt,
      failedCount: this.state.failedCount,
      ticketCount: this.state.tickets.length,
      workItemCount: this.state.workItems.length,
      runCount: this.state.runs.length,
    });
  }

  render() {
    renderMetrics(this.state);
    this.elements.flowGrid.innerHTML = renderFlowCards(this.state);
    this.elements.nodeTableBody.innerHTML = renderNodeRows(this.state.nodes);
    this.elements.agentTableBody.innerHTML = renderAgentRows(this.state.activity);
    this.elements.attentionList.innerHTML = renderAttentionItems(this.state);
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }
}

// Create the empty ops-dashboard state used before first refresh.
function createInitialState() {
  return {
    activity: {
      agentTicketMappings: {},
      agents: [],
      dispatches: [],
    },
    channels: [],
    failedCount: 0,
    health: {
      status: 'unknown',
      uptime: 0,
    },
    nodes: [],
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

// Normalize Promise.allSettled results into one renderable ops-dashboard state.
function buildOpsState(results) {
  return {
    activity: settledValue(results[6], createInitialState().activity, normalizeActivity),
    channels: settledValue(results[5], [], normalizeChannels),
    failedCount: countRejected(results),
    health: settledValue(results[0], createInitialState().health, normalizeHealth),
    nodes: settledValue(results[7], [], normalizeNodes),
    refreshedAt: new Date().toISOString(),
    runs: settledValue(results[4], [], normalizeRuns),
    scheduler: settledValue(results[1], createInitialState().scheduler, normalizeScheduler),
    tickets: settledValue(results[2], [], normalizeTickets),
    workItems: settledValue(results[3], [], normalizeWorkItems),
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
    logger.warn('Ops dashboard payload normalization failed', {
      error: serializeUiError(error),
    });
    return fallback;
  }
}

// Count failed async data sources from settled request results.
function countRejected(results) {
  return results.filter((result) => result.status === 'rejected').length;
}

// Normalize API health payload from `/api/health`.
function normalizeHealth(payload) {
  return {
    status: readString(payload?.status) || 'unknown',
    uptime: numberValue(payload?.uptime),
  };
}

// Normalize scheduler status payload.
function normalizeScheduler(payload) {
  return {
    isRunning: payload?.isRunning === true,
    pollIntervalMs: numberValue(payload?.pollIntervalMs),
    redisHealthy: payload?.redisHealthy === true,
  };
}

// Normalize ticket payload from `/api/tickets/active`.
function normalizeTickets(payload) {
  const tickets = Array.isArray(payload?.tickets) ? payload.tickets : [];
  return tickets.map((ticket) => ({
    assignee: readString(ticket?.assignee_detail?.display_name),
    id: readString(ticket?.id),
    name: readString(ticket?.name) || 'Untitled ticket',
    stateGroup: readString(ticket?.state_detail?.group) || 'started',
    stateName: readString(ticket?.state_detail?.name) || 'Unknown',
    updatedAt: readString(ticket?.updated_at),
  }));
}

// Normalize work-item payload from `/api/swarm/work-items`.
function normalizeWorkItems(payload) {
  const items = Array.isArray(payload?.workItems) ? payload.workItems : [];
  return items.map((item) => ({
    assignedAgentId: readString(item.assignedAgentId),
    status: readString(item.status) || 'unknown',
    ticketId: readString(item.ticketId || item?.metadata?.ticketId),
  }));
}

// Normalize run payload from `/api/swarm/runs`.
function normalizeRuns(payload) {
  const runs = Array.isArray(payload?.runs) ? payload.runs : [];
  return runs.map((run) => ({
    runId: readString(run.runId || run.id),
    status: readString(run.status) || 'unknown',
    updatedAt: readString(run.updatedAt || run.startedAt || run.createdAt),
  }));
}

// Normalize mesh-channel payload from `/api/mesh/channels`.
function normalizeChannels(payload) {
  const channels = Array.isArray(payload?.channels) ? payload.channels : [];
  return channels.map((channel) => ({
    members: Array.isArray(channel.members) ? channel.members.map((member) => readString(member)).filter(Boolean) : [],
    scope: readString(channel.scope) || 'adhoc',
    status: readString(channel.status) || 'unknown',
    ticketId: readString(channel.ticket_id),
  }));
}

// Normalize queue-manager activity payload from `/api/qm/activity`.
function normalizeActivity(payload) {
  const rawAgents = asRecord(payload?.agents);
  const rawDispatches = asRecord(payload?.dispatches);
  const rawMappings = asRecord(payload?.agentTicketMappings);

  const agents = Object.entries(rawAgents).map(([agentId, details]) => ({
    agentId,
    currentLoad: numberValue(details?.current_load),
    maxConcurrent: numberValue(details?.max_concurrent),
    status: readString(details?.status) || 'unknown',
  }));

  const dispatches = Object.entries(rawDispatches).map(([, details]) => ({
    agentId: readString(details?.agentId),
    status: readString(details?.status) || 'unknown',
    ticketId: readString(details?.ticketId),
    updatedAt: readString(details?.updatedAt),
  }));

  return {
    agentTicketMappings: rawMappings,
    agents,
    dispatches,
  };
}

// Normalize health registry payload from `/api/health-dashboard/registry`.
function normalizeNodes(payload) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  return nodes.map((node) => ({
    category: readString(node.category) || 'service',
    links: Array.isArray(node.links) ? node.links : [],
    name: readString(node.name) || 'unknown',
    source: readString(node.source) || 'runtime',
    status: readString(node.status) || 'unknown',
    type: readString(node.type) || 'service',
  }));
}

// Render top-line metrics for ops dashboard.
function renderMetrics(state) {
  const ticketGroups = countTicketGroups(state.tickets);
  const activeRuns = countNonTerminalRuns(state.runs);

  setText('metricApi', state.health.status === 'ok' ? 'Healthy' : 'Degraded');
  setText('metricScheduler', state.scheduler.redisHealthy ? 'Ready' : 'Degraded');
  setText('metricTickets', ticketGroups.started);
  setText('metricRuns', activeRuns);
}

// Render lifecycle cards that summarize operational flow.
function renderFlowCards(state) {
  const snapshot = buildFlowSnapshot(state);
  return snapshot.map((card) => `
    <article class="flow-card">
      <div class="stage">${escapeHtml(card.stage)}</div>
      <div class="count">${escapeHtml(String(card.count))}</div>
      <div class="hint">${escapeHtml(card.hint)}</div>
    </article>
  `).join('');
}

// Build process-flow snapshot from live tickets, dispatches, work items, and channels.
function buildFlowSnapshot(state) {
  const ticketGroups = countTicketGroups(state.tickets);
  const activeWorkItems = state.workItems.filter((item) => !isTerminalStatus(item.status)).length;
  const activeRuns = countNonTerminalRuns(state.runs);
  const activeChannels = state.channels.filter((channel) => channel.status === 'active').length;

  return [
    { stage: 'Intake', count: ticketGroups.unstarted, hint: 'Queued/approved tickets waiting for active execution.' },
    { stage: 'Routing', count: ticketGroups.started, hint: 'Tickets currently in started states and under coordination.' },
    { stage: 'Dispatch', count: state.activity.dispatches.length, hint: 'Queue-manager dispatch records currently active.' },
    { stage: 'Execution', count: activeWorkItems + activeRuns, hint: 'Non-terminal work items and runs still processing.' },
    { stage: 'Mesh', count: activeChannels, hint: 'Active mesh channels carrying cross-agent collaboration.' },
    { stage: 'Closed', count: ticketGroups.done + ticketGroups.cancelled, hint: 'Tickets completed or cancelled in current snapshot.' },
  ];
}

// Render runtime-node rows or one empty-state row.
function renderNodeRows(nodes) {
  if (!nodes.length) {
    return renderEmptyRow('No runtime-node registry entries are available yet.', 5);
  }

  return nodes.map((node) => `
    <tr>
      <td><strong>${escapeHtml(node.name)}</strong><div class="mono">${escapeHtml(node.type)}</div></td>
      <td>${escapeHtml(node.category)}</td>
      <td>${renderStatusBadge(node.status)}</td>
      <td>${escapeHtml(node.source)}</td>
      <td>${escapeHtml(buildNodeLinkSummary(node.links))}</td>
    </tr>
  `).join('');
}

// Build a compact readable node-link summary.
function buildNodeLinkSummary(links) {
  if (!Array.isArray(links) || links.length === 0) {
    return 'No links';
  }
  const first = links[0];
  if (links.length === 1) {
    return readString(first?.label) || '1 link';
  }
  return `${readString(first?.label) || 'Link'} +${links.length - 1}`;
}

// Render per-agent queue load rows or one empty-state row.
function renderAgentRows(activity) {
  if (!activity.agents.length) {
    return renderEmptyRow('No queue-agent load entries are available yet.', 5);
  }

  const dispatchCounts = buildAgentDispatchCounts(activity.dispatches);
  return activity.agents.map((agent) => {
    const mappedTickets = Array.isArray(activity.agentTicketMappings?.[agent.agentId])
      ? activity.agentTicketMappings[agent.agentId].length
      : 0;

    return `
      <tr>
        <td><strong>${escapeHtml(agent.agentId)}</strong></td>
        <td>${renderStatusBadge(agent.status)}</td>
        <td>${escapeHtml(formatLoad(agent.currentLoad, agent.maxConcurrent))}</td>
        <td>${escapeHtml(String(mappedTickets))}</td>
        <td>${escapeHtml(String(dispatchCounts.get(agent.agentId) || 0))}</td>
      </tr>
    `;
  }).join('');
}

// Count active dispatch records by agent id.
function buildAgentDispatchCounts(dispatches) {
  const counts = new Map();
  dispatches.forEach((dispatch) => {
    const agentId = readString(dispatch.agentId);
    if (!agentId) {
      return;
    }
    counts.set(agentId, (counts.get(agentId) || 0) + 1);
  });
  return counts;
}

// Render ops attention rows or one healthy-state item.
function renderAttentionItems(state) {
  const items = buildAttentionItems(state);
  if (!items.length) {
    return '<li class="empty-state">No operator attention items detected in current telemetry.</li>';
  }

  return items.map((item) => `
    <li class="attention-item">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.detail)}</span>
    </li>
  `).join('');
}

// Build actionable attention items from scheduler, dispatch, and run coverage signals.
function buildAttentionItems(state) {
  const items = [];
  const ticketGroups = countTicketGroups(state.tickets);
  const startedTickets = state.tickets.filter((ticket) => ticket.stateGroup === 'started');

  if (state.health.status !== 'ok') {
    items.push({ title: 'API Health Degraded', detail: 'The control-plane health endpoint is not reporting an OK status.' });
  }

  if (!state.scheduler.redisHealthy) {
    items.push({ title: 'Scheduler Redis Degraded', detail: 'Scheduler status reports Redis unhealthy; queue polling may be delayed.' });
  }

  if (ticketGroups.started > 0 && state.activity.dispatches.length === 0) {
    items.push({ title: 'Missing Dispatch Coverage', detail: `${ticketGroups.started} started ticket(s) are active but no dispatch records are visible.` });
  }

  items.push(...buildUncoveredTicketItems(startedTickets, state.activity.dispatches));
  items.push(...buildRunLagItems(state.runs));

  return items.slice(0, 8);
}

// Build attention rows for started tickets without dispatch linkage.
function buildUncoveredTicketItems(startedTickets, dispatches) {
  const dispatchedTicketIds = new Set(dispatches.map((dispatch) => dispatch.ticketId).filter(Boolean));
  const uncoveredTickets = startedTickets.filter((ticket) => ticket.id && !dispatchedTicketIds.has(ticket.id));

  return uncoveredTickets.slice(0, 4).map((ticket) => ({
    title: `Uncovered Ticket: ${truncate(ticket.id, 18)}`,
    detail: `${ticket.name} (${ticket.stateName}) assigned to ${ticket.assignee || 'unassigned'} has no active dispatch row.`,
  }));
}

// Build attention rows for runs that appear stale while still non-terminal.
function buildRunLagItems(runs) {
  const thirtyMinutesMs = 30 * 60 * 1000;
  const now = Date.now();

  return runs
    .filter((run) => !isTerminalStatus(run.status))
    .filter((run) => {
      const updatedAtMs = asEpoch(run.updatedAt);
      return updatedAtMs > 0 && now - updatedAtMs >= thirtyMinutesMs;
    })
    .slice(0, 3)
    .map((run) => ({
      title: `Stale Run: ${truncate(run.runId, 18)}`,
      detail: `Run status is ${run.status} and appears stale since ${formatDateTime(run.updatedAt)}.`,
    }));
}

// Count tickets by legacy-compatible lifecycle group.
function countTicketGroups(tickets) {
  return tickets.reduce((counts, ticket) => {
    const group = ticket.stateGroup;
    if (group === 'done') {
      counts.done += 1;
    } else if (group === 'cancelled') {
      counts.cancelled += 1;
    } else if (group === 'unstarted') {
      counts.unstarted += 1;
    } else {
      counts.started += 1;
    }
    return counts;
  }, { unstarted: 0, started: 0, done: 0, cancelled: 0 });
}

// Count runs that are still in progress.
function countNonTerminalRuns(runs) {
  return runs.filter((run) => !isTerminalStatus(run.status)).length;
}

// Render one status badge with simple severity mapping.
function renderStatusBadge(status) {
  const normalized = readString(status) || 'unknown';
  if (normalized === 'ok' || normalized === 'active' || normalized === 'healthy' || normalized === 'ready') {
    return `<span class="badge ok">${escapeHtml(normalized)}</span>`;
  }
  if (normalized === 'unknown' || normalized === 'idle' || normalized === 'configured') {
    return `<span class="badge muted">${escapeHtml(normalized)}</span>`;
  }
  if (normalized === 'degraded' || normalized === 'warning') {
    return `<span class="badge warn">${escapeHtml(normalized)}</span>`;
  }
  return `<span class="badge error">${escapeHtml(normalized)}</span>`;
}

// Render one full-width empty-state table row.
function renderEmptyRow(message, colspan) {
  return `<tr><td colspan="${colspan}"><div class="empty-state">${escapeHtml(message)}</div></td></tr>`;
}

// Format one queue-load pair for the dispatch coverage table.
function formatLoad(currentLoad, maxConcurrent) {
  if (maxConcurrent <= 0) {
    return String(currentLoad);
  }
  return `${currentLoad}/${maxConcurrent}`;
}

// Perform one authenticated JSON request for the ops dashboard.
async function requestJson(url) {
  const startedAt = Date.now();
  logger.debug('Ops dashboard request started', { url });
  const response = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    logger.warn('Ops dashboard request failed', {
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
    throw new Error(errorMessage);
  }
  const payload = await response.json();
  logger.info('Ops dashboard request completed', {
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return payload;
}

// Read the best available error text from a failed HTTP response.
async function readErrorMessage(response) {
  const fallback = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    return readString(body?.error) || fallback;
  } catch (_error) {
    return fallback;
  }
}

// Build status-banner text after one refresh cycle.
function buildStatusMessage(state) {
  const refreshedAt = formatDateTime(state.refreshedAt);
  const dispatchCount = state.activity.dispatches.length;
  const activeRuns = countNonTerminalRuns(state.runs);

  if (state.failedCount === 0) {
    return `Ops flow refreshed successfully at ${refreshedAt} (${dispatchCount} dispatches, ${activeRuns} active runs).`;
  }

  return `Ops flow refreshed with ${state.failedCount} degraded source(s) at ${refreshedAt}.`;
}

// Safely set text content on a DOM element by id.
function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = String(value);
  }
}

// Read one object-like value as a record map.
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Convert unknown values to positive finite numbers.
function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// Convert unknown text values into clean strings.
function readString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

// Convert one date-like value into epoch milliseconds.
function asEpoch(value) {
  if (!readString(value)) {
    return 0;
  }
  const epoch = new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : 0;
}

// Determine whether one status should be treated as terminal.
function isTerminalStatus(status) {
  return ['completed', 'failed', 'cancelled', 'escalated', 'done', 'dissolved'].includes(status);
}

// Format one timestamp for operator display.
function formatDateTime(value) {
  if (!readString(value)) {
    return '—';
  }
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// Clamp long labels for compact table and card display.
function truncate(value, maxLength) {
  if (!readString(value)) {
    return '';
  }
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

// Escape text for HTML-safe interpolation.
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const app = new OpsDashboardApp();
void app.init().catch((error) => {
  logger.error('Ops dashboard bootstrap failed', {
    error: serializeUiError(error),
  });
});

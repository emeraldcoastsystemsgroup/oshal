/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added native mesh dashboard browser logic for real channel lifecycle, participant load, and ticket linkage telemetry
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('mesh-dashboard');

class MeshDashboardApp {
  constructor() {
    this.state = createInitialState();
    this.elements = {
      channelTableBody: document.getElementById('channelTableBody'),
      flowGrid: document.getElementById('flowGrid'),
      linkageList: document.getElementById('linkageList'),
      participantTableBody: document.getElementById('participantTableBody'),
      refreshButton: document.getElementById('refreshButton'),
      statusBanner: document.getElementById('statusBanner'),
    };
  }

  async init() {
    logger.info('Initializing mesh dashboard');
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
    this.setStatus('Loading mesh process flow...', 'info');
    logger.info('Refreshing mesh dashboard');
    const requests = [
      requestJson('/api/mesh/channels'),
      requestJson('/api/tickets/active?limit=100'),
      requestJson('/api/swarm/work-items?limit=40'),
      requestJson('/api/v1/agent/scheduler/status'),
      requestJson('/api/swarm/runs?limit=12'),
    ];

    const results = await Promise.allSettled(requests);
    this.state = buildMeshState(results);
    this.render();

    const tone = this.state.failedCount > 0 ? 'warning' : 'success';
    this.setStatus(buildStatusMessage(this.state), tone);
    logger.info('Mesh dashboard refresh complete', {
      durationMs: Date.now() - startedAt,
      failedCount: this.state.failedCount,
      channelCount: this.state.channels.length,
      workItemCount: this.state.workItems.length,
      runCount: this.state.runs.length,
    });
  }

  render() {
    renderMetrics(this.state);
    this.elements.flowGrid.innerHTML = renderFlowCards(this.state);
    this.elements.channelTableBody.innerHTML = renderChannelRows(this.state.channels, this.state.tickets);
    this.elements.participantTableBody.innerHTML = renderParticipantRows(this.state.channels, this.state.workItems);
    this.elements.linkageList.innerHTML = renderLinkageItems(this.state);
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }
}

// Create the empty mesh-dashboard state used before the first refresh.
function createInitialState() {
  return {
    channels: [],
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

// Normalize Promise.allSettled results into one renderable mesh-dashboard state.
function buildMeshState(results) {
  return {
    channels: settledValue(results[0], [], normalizeChannels),
    failedCount: countRejected(results),
    refreshedAt: new Date().toISOString(),
    runs: settledValue(results[4], [], normalizeRuns),
    scheduler: settledValue(results[3], createInitialState().scheduler, normalizeScheduler),
    tickets: settledValue(results[1], [], normalizeTickets),
    workItems: settledValue(results[2], [], normalizeWorkItems),
  };
}

// Read one fulfilled Promise result or return fallback when a source fails.
function settledValue(result, fallback, normalizer) {
  if (!result || result.status !== 'fulfilled') {
    return fallback;
  }
  try {
    return normalizer(result.value);
  } catch (error) {
    logger.warn('Mesh dashboard payload normalization failed', {
      error: serializeUiError(error),
    });
    return fallback;
  }
}

// Count failed async data sources from the settled request array.
function countRejected(results) {
  return results.filter((result) => result.status === 'rejected').length;
}

// Normalize mesh channel payload from `/api/mesh/channels`.
function normalizeChannels(payload) {
  const channels = Array.isArray(payload?.channels) ? payload.channels : [];
  const normalized = channels.map((channel) => ({
    createdAt: readString(channel.created_at),
    members: Array.isArray(channel.members) ? channel.members.map((member) => readString(member)).filter(Boolean) : [],
    meshId: readString(channel.mesh_id),
    messageCount: numberValue(channel.message_count),
    scope: readString(channel.scope) || 'adhoc',
    status: readString(channel.status) || 'unknown',
    ticketId: readString(channel.ticket_id),
    topic: readString(channel.topic) || 'Untitled mesh channel',
  }));

  return normalized.sort((left, right) => asEpoch(right.createdAt) - asEpoch(left.createdAt));
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
    title: readString(item.title) || 'Untitled work item',
  }));
}

// Normalize scheduler status payload.
function normalizeScheduler(payload) {
  return {
    isRunning: payload?.isRunning === true,
    pollIntervalMs: numberValue(payload?.pollIntervalMs),
    redisHealthy: payload?.redisHealthy === true,
  };
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

// Render top-line metric cards.
function renderMetrics(state) {
  const activeChannels = state.channels.filter((channel) => channel.status === 'active').length;
  const uniqueParticipants = collectUniqueParticipants(state.channels).size;
  const ticketLinked = state.channels.filter((channel) => channel.scope === 'ticket' && channel.ticketId).length;
  const coverage = computeTicketCoverage(state);

  setText('metricActiveChannels', activeChannels);
  setText('metricParticipants', uniqueParticipants);
  setText('metricTicketLinked', ticketLinked);
  setText('metricCoverage', `${coverage}%`);
}

// Render channel lifecycle cards showing current mesh process flow.
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

// Build the flow-card snapshot from live channel and ticket state.
function buildFlowSnapshot(state) {
  const activeChannels = state.channels.filter((channel) => channel.status === 'active');
  const dissolvedChannels = state.channels.filter((channel) => channel.status === 'dissolved').length;
  const unstartedTickets = state.tickets.filter((ticket) => ticket.stateGroup === 'unstarted').length;
  const startedTicketIds = new Set(
    state.tickets
      .filter((ticket) => ticket.stateGroup === 'started')
      .map((ticket) => ticket.id)
      .filter(Boolean),
  );
  const linkedStartedTickets = countLinkedStartedTickets(activeChannels, startedTicketIds);
  const attentionChannels = activeChannels.filter((channel) => channel.messageCount === 0).length;
  const uncoveredStartedTickets = Math.max(startedTicketIds.size - linkedStartedTickets, 0);

  return [
    { stage: 'Intake', count: unstartedTickets, hint: 'Tickets approved or queued before mesh collaboration starts.' },
    { stage: 'Active Mesh', count: activeChannels.length, hint: 'Live channels currently coordinating work across agents.' },
    { stage: 'Ticket Linked', count: linkedStartedTickets, hint: 'In-process tickets with at least one active ticket channel.' },
    { stage: 'Attention', count: attentionChannels + uncoveredStartedTickets, hint: 'Channels with no messages plus started tickets without mesh links.' },
    { stage: 'Dissolved', count: dissolvedChannels, hint: 'Closed channels retained for process traceability.' },
  ];
}

// Render mesh-channel table rows or one empty-state row.
function renderChannelRows(channels, tickets) {
  if (!channels.length) {
    return renderEmptyRow('No mesh channels are available yet.', 7);
  }

  const ticketLookup = buildTicketLookup(tickets);
  return channels.map((channel) => {
    const ticketLabel = readTicketLabel(channel.ticketId, ticketLookup);
    return `
      <tr>
        <td><strong>${escapeHtml(truncate(channel.topic, 48))}</strong><div class="mono">${escapeHtml(truncate(channel.meshId || 'unknown', 20))}</div></td>
        <td>${escapeHtml(channel.scope)}</td>
        <td>${renderStatusBadge(channel.status)}</td>
        <td>${escapeHtml(channel.members.join(', ') || '—')}</td>
        <td>${escapeHtml(String(channel.messageCount))}</td>
        <td class="mono">${escapeHtml(ticketLabel)}</td>
        <td>${escapeHtml(formatDateTime(channel.createdAt))}</td>
      </tr>
    `;
  }).join('');
}

// Render participant workload rows or one empty-state row.
function renderParticipantRows(channels, workItems) {
  const rows = buildParticipantLoad(channels, workItems);
  if (!rows.length) {
    return renderEmptyRow('No participant activity is available yet.', 4);
  }

  return rows.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.participant)}</strong></td>
      <td>${escapeHtml(String(row.channelCount))}</td>
      <td>${escapeHtml(String(row.ticketChannelCount))}</td>
      <td>${escapeHtml(String(row.activeWorkItems))}</td>
    </tr>
  `).join('');
}

// Render ticket-linkage coverage list entries or one empty-state item.
function renderLinkageItems(state) {
  const items = buildLinkageItems(state);
  if (!items.length) {
    return '<li class="empty-state">No ticket-linkage telemetry is available yet.</li>';
  }

  return items.map((item) => `
    <li class="linkage-item">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.detail)}</span>
    </li>
  `).join('');
}

// Build ticket-linkage summary and uncovered-ticket rows.
function buildLinkageItems(state) {
  const items = [];
  const startedTickets = state.tickets.filter((ticket) => ticket.stateGroup === 'started');
  const startedTicketIds = new Set(startedTickets.map((ticket) => ticket.id).filter(Boolean));
  const activeTicketChannels = state.channels.filter((channel) => channel.scope === 'ticket' && channel.status === 'active');
  const linkedIds = new Set(activeTicketChannels.map((channel) => channel.ticketId).filter(Boolean));
  const uncoveredTickets = startedTickets.filter((ticket) => ticket.id && !linkedIds.has(ticket.id));

  items.push({
    title: 'Started Ticket Coverage',
    detail: `${linkedIds.size}/${startedTicketIds.size} started ticket(s) currently linked to active mesh channels.`,
  });

  items.push({
    title: 'Scheduler and Run Loop',
    detail: `${state.scheduler.redisHealthy ? 'Scheduler ready' : 'Scheduler degraded'} with ${countNonTerminalRuns(state.runs)} non-terminal run(s) visible.`,
  });

  return [...items, ...buildUncoveredTicketItems(uncoveredTickets)];
}

// Build linkage-list rows for started tickets lacking active ticket channels.
function buildUncoveredTicketItems(uncoveredTickets) {
  if (!uncoveredTickets.length) {
    return [{ title: 'Coverage Gaps', detail: 'No started tickets are currently missing mesh-channel linkage.' }];
  }

  return uncoveredTickets.slice(0, 6).map((ticket) => ({
    title: `Missing Channel: ${ticket.id || 'unknown ticket'}`,
    detail: `${ticket.name} (${ticket.stateName}) assigned to ${ticket.assignee || 'unassigned'} — update: ${formatDateTime(ticket.updatedAt)}.`,
  }));
}

// Build participant-load rows from channels and active work items.
function buildParticipantLoad(channels, workItems) {
  const rowByParticipant = new Map();

  channels.forEach((channel) => {
    channel.members.forEach((participant) => {
      const row = ensureParticipantRow(rowByParticipant, participant);
      row.channelCount += 1;
      if (channel.scope === 'ticket') {
        row.ticketChannelCount += 1;
      }
    });
  });

  workItems.forEach((item) => {
    if (isTerminalStatus(item.status)) {
      return;
    }
    const row = ensureParticipantRow(rowByParticipant, item.assignedAgentId || 'unassigned');
    row.activeWorkItems += 1;
  });

  return [...rowByParticipant.values()].sort((left, right) => right.channelCount - left.channelCount);
}

// Initialize participant-load row shape if this participant was not seen before.
function ensureParticipantRow(rowByParticipant, participant) {
  const key = participant || 'unknown';
  if (!rowByParticipant.has(key)) {
    rowByParticipant.set(key, {
      activeWorkItems: 0,
      channelCount: 0,
      participant: key,
      ticketChannelCount: 0,
    });
  }
  return rowByParticipant.get(key);
}

// Count started tickets that currently have at least one active ticket channel.
function countLinkedStartedTickets(activeChannels, startedTicketIds) {
  const linkedIds = new Set(
    activeChannels
      .filter((channel) => channel.scope === 'ticket')
      .map((channel) => channel.ticketId)
      .filter(Boolean),
  );

  let count = 0;
  startedTicketIds.forEach((ticketId) => {
    if (linkedIds.has(ticketId)) {
      count += 1;
    }
  });
  return count;
}

// Compute started-ticket coverage percentage using active ticket channels.
function computeTicketCoverage(state) {
  const startedTicketIds = new Set(
    state.tickets
      .filter((ticket) => ticket.stateGroup === 'started')
      .map((ticket) => ticket.id)
      .filter(Boolean),
  );

  if (startedTicketIds.size === 0) {
    return 100;
  }

  const linkedCount = countLinkedStartedTickets(
    state.channels.filter((channel) => channel.status === 'active'),
    startedTicketIds,
  );
  return Math.round((linkedCount / startedTicketIds.size) * 100);
}

// Count runs that are still in progress.
function countNonTerminalRuns(runs) {
  return runs.filter((run) => !isTerminalStatus(run.status)).length;
}

// Build a quick id->ticket lookup for channel row rendering.
function buildTicketLookup(tickets) {
  return new Map(tickets.filter((ticket) => ticket.id).map((ticket) => [ticket.id, ticket]));
}

// Build channel ticket label with state when ticket metadata exists.
function readTicketLabel(ticketId, ticketLookup) {
  if (!ticketId) {
    return '—';
  }

  const ticket = ticketLookup.get(ticketId);
  if (!ticket) {
    return truncate(ticketId, 18);
  }
  return `${truncate(ticketId, 18)} (${ticket.stateGroup})`;
}

// Collect unique participant ids from channel member lists.
function collectUniqueParticipants(channels) {
  const participants = new Set();
  channels.forEach((channel) => {
    channel.members.forEach((member) => {
      participants.add(member);
    });
  });
  return participants;
}

// Render a status badge for channel-state and flow-state cells.
function renderStatusBadge(status) {
  if (status === 'active') {
    return '<span class="badge ok">active</span>';
  }
  if (status === 'dissolved') {
    return '<span class="badge muted">dissolved</span>';
  }
  return `<span class="badge warn">${escapeHtml(status || 'unknown')}</span>`;
}

// Render one full-width empty-state table row.
function renderEmptyRow(message, colspan) {
  return `<tr><td colspan="${colspan}"><div class="empty-state">${escapeHtml(message)}</div></td></tr>`;
}

// Perform one authenticated JSON request for the mesh dashboard.
async function requestJson(url) {
  const startedAt = Date.now();
  logger.debug('Mesh dashboard request started', { url });
  const response = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    logger.warn('Mesh dashboard request failed', {
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
    throw new Error(errorMessage);
  }
  const payload = await response.json();
  logger.info('Mesh dashboard request completed', {
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return payload;
}

// Read the strongest available error message from a failed response.
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
  const activeChannels = state.channels.filter((channel) => channel.status === 'active').length;
  const linkedTickets = state.channels.filter((channel) => channel.scope === 'ticket' && channel.ticketId).length;
  const refreshedAt = formatDateTime(state.refreshedAt);

  if (state.failedCount === 0) {
    return `Mesh flow refreshed successfully at ${refreshedAt} (${activeChannels} active channels, ${linkedTickets} ticket-linked channels).`;
  }

  return `Mesh flow refreshed with ${state.failedCount} degraded source(s) at ${refreshedAt} (${activeChannels} active channels visible).`;
}

// Safely set text content on one DOM element by id.
function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = String(value);
  }
}

// Convert one value to a positive finite number for dashboard metrics.
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

// Convert one date-like string to epoch milliseconds for sorting.
function asEpoch(value) {
  if (!readString(value)) {
    return 0;
  }
  const epoch = new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : 0;
}

// Format one ISO timestamp for operator display.
function formatDateTime(value) {
  if (!readString(value)) {
    return '—';
  }
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// Clamp long labels for compact table cells.
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

// Determine whether one status should be treated as terminal.
function isTerminalStatus(status) {
  return ['completed', 'failed', 'cancelled', 'escalated', 'dissolved', 'done'].includes(status);
}

const app = new MeshDashboardApp();
void app.init().catch((error) => {
  logger.error('Mesh dashboard bootstrap failed', {
    error: serializeUiError(error),
  });
});

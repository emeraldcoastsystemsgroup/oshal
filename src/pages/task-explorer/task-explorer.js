/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added OSHAL-native task explorer browser logic for hierarchy, activity, and workspace inspection
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | CM-3: Added search/filter/sort/group-by toolbar, enriched tree rows with state colors and phase badges, Process + Cost tabs
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('task-explorer');

class TaskExplorerApp {
  constructor() {
    this.state = {
      activeTab: 'activity',
      expandedIds: new Set(),
      projects: [],
      selectedProjectId: '',
      selectedTicketId: '',
      ticketById: new Map(),
      rawTickets: [],
      searchQuery: '',
      statusFilter: 'all',
      agentFilter: 'all',
      sortKey: 'date-desc',
      groupBy: 'none',
      uniqueAgents: [],
    };

    this.elements = {
      activityPanel: document.getElementById('activityPanel'),
      costPanel: document.getElementById('costPanel'),
      filesPanel: document.getElementById('filesPanel'),
      processPanel: document.getElementById('processPanel'),
      projectSelect: document.getElementById('projectSelect'),
      refreshButton: document.getElementById('refreshButton'),
      resizeHandle: document.getElementById('resizeHandle'),
      tabs: Array.from(document.querySelectorAll('.tab')),
      toolbarSearch: document.getElementById('toolbarSearch'),
      toolbarStatusFilter: document.getElementById('toolbarStatusFilter'),
      toolbarAgentFilter: document.getElementById('toolbarAgentFilter'),
      toolbarSort: document.getElementById('toolbarSort'),
      toolbarGroupBy: document.getElementById('toolbarGroupBy'),
      treeContent: document.getElementById('treeContent'),
      treePanel: document.getElementById('treePanel'),
      treeSubtitle: document.getElementById('treeSubtitle'),
    };
  }

  async init() {
    logger.info('Initializing task explorer');
    this.bindEvents();
    await this.refreshAll();
  }

  bindEvents() {
    this.elements.projectSelect.addEventListener('change', async () => {
      this.state.selectedProjectId = this.elements.projectSelect.value;
      this.state.selectedTicketId = '';
      await Promise.all([this.loadHierarchy(), this.loadMetrics()]);
    });

    this.elements.refreshButton.addEventListener('click', async () => {
      await this.refreshAll();
    });

    this.elements.tabs.forEach((tabButton) => {
      tabButton.addEventListener('click', () => this.switchTab(tabButton.dataset.tab || 'activity'));
    });

    this.elements.treeContent.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-ticket-id]');
      if (!button) {
        return;
      }

      if (button.dataset.action === 'toggle') {
        this.toggleExpanded(button.dataset.ticketId);
        return;
      }

      await this.selectTicket(button.dataset.ticketId);
    });

    this.attachResizeHandle();
    this.bindToolbar();
  }

  bindToolbar() {
    let debounce;
    this.elements.toolbarSearch?.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.state.searchQuery = (this.elements.toolbarSearch.value || '').trim().toLowerCase();
        this.applyFilters();
      }, 200);
    });
    this.elements.toolbarStatusFilter?.addEventListener('change', () => {
      this.state.statusFilter = this.elements.toolbarStatusFilter.value;
      this.applyFilters();
    });
    this.elements.toolbarAgentFilter?.addEventListener('change', () => {
      this.state.agentFilter = this.elements.toolbarAgentFilter.value;
      this.applyFilters();
    });
    this.elements.toolbarSort?.addEventListener('change', () => {
      this.state.sortKey = this.elements.toolbarSort.value;
      this.applyFilters();
    });
    this.elements.toolbarGroupBy?.addEventListener('change', () => {
      this.state.groupBy = this.elements.toolbarGroupBy.value;
      this.applyFilters();
    });
  }

  applyFilters() {
    const filtered = this.getFiltered();
    this.renderFilteredTree(filtered);
    this.computeFilteredMetrics(filtered);
  }

  getFiltered() {
    let list = this.state.rawTickets.map((t) => normTicket(t));

    if (this.state.statusFilter !== 'all') {
      const f = this.state.statusFilter.toLowerCase();
      list = list.filter((t) => {
        const state = (t.stateGroup || t.state || '').toLowerCase();
        if (f === 'active') return state !== 'complete' && state !== 'cancelled' && state !== 'done';
        return state === f || (t.state || '').toLowerCase() === f;
      });
    }

    if (this.state.agentFilter !== 'all') {
      list = list.filter((t) => (t.assignee || '') === this.state.agentFilter);
    }

    if (this.state.searchQuery) {
      const q = this.state.searchQuery;
      list = list.filter((t) =>
        (t.name || '').toLowerCase().includes(q) ||
        (t.sequenceId || '').toLowerCase().includes(q) ||
        (t.assignee || '').toLowerCase().includes(q) ||
        (t.project || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q)
      );
    }

    const [field, dir] = (this.state.sortKey || 'date-desc').split('-');
    list.sort((a, b) => {
      let cmp = 0;
      if (field === 'cost') cmp = (a.cost || 0) - (b.cost || 0);
      else if (field === 'name') cmp = (a.name || '').localeCompare(b.name || '');
      else if (field === 'status') cmp = (a.state || '').localeCompare(b.state || '');
      else cmp = new Date(a.updatedAt || a.createdAt || 0).getTime() - new Date(b.updatedAt || b.createdAt || 0).getTime();
      return dir === 'desc' ? -cmp : cmp;
    });

    return list;
  }

  renderFilteredTree(filtered) {
    if (!filtered.length) {
      this.renderEmpty(this.elements.treeContent, 'No tickets match the current filters.');
      return;
    }

    if (this.state.groupBy !== 'none') {
      const groups = groupTickets(filtered, this.state.groupBy);
      const markup = Object.entries(groups).map(([label, items]) =>
        renderTreeGroup(label, items, this.state)
      ).join('');
      this.elements.treeContent.innerHTML = markup;
      return;
    }

    const grouped = splitTreeGroups(filtered);
    const markup = [
      renderTreeGroup('Programs', grouped.withChildren, this.state),
      renderTreeGroup('Standalone', grouped.withoutChildren, this.state),
    ].join('');
    this.elements.treeContent.innerHTML = markup;
  }

  computeFilteredMetrics(filtered) {
    const queue = filtered.filter((t) => ['backlog', 'approved'].includes((t.stateGroup || t.state || '').toLowerCase())).length;
    const inProgress = filtered.filter((t) => (t.stateGroup || t.state || '').toLowerCase().includes('in_process') || (t.state || '').toLowerCase() === 'in progress').length;
    const review = filtered.filter((t) => ['customer_action', 'approval_required'].includes((t.stateGroup || t.state || '').toLowerCase()) || (t.state || '').toLowerCase() === 'in review').length;
    const done = filtered.filter((t) => ['complete', 'done'].includes((t.stateGroup || t.state || '').toLowerCase())).length;
    const agents = new Set(filtered.map((t) => t.assignee).filter(Boolean));
    const busyAgents = new Set(filtered.filter((t) => (t.stateGroup || t.state || '').toLowerCase().includes('in_process')).map((t) => t.assignee).filter(Boolean));
    const totalCost = filtered.reduce((sum, t) => sum + (t.cost || 0), 0);
    setText('metricQueue', queue);
    setText('metricInProgress', inProgress);
    setText('metricReview', review);
    setText('metricDone', done);
    setText('metricAgents', `${busyAgents.size}/${agents.size}`);
    setText('metricCost', formatCurrency(totalCost));
  }

  async refreshAll() {
    const startedAt = Date.now();
    logger.info('Refreshing task explorer', {
      selectedProjectId: this.state.selectedProjectId || null,
    });
    await this.loadProjects();
    await Promise.all([this.loadHierarchy(), this.loadMetrics()]);
    logger.info('Task explorer refresh complete', {
      durationMs: Date.now() - startedAt,
      projectCount: this.state.projects.length,
      selectedProjectId: this.state.selectedProjectId || null,
      ticketCount: this.state.ticketById.size,
    });
  }

  async loadProjects() {
    logger.debug('Loading task explorer projects');
    this.setProjectLoadingState();
    const response = await fetchJson('/api/v1/projects');
    this.state.projects = response.data || [];
    this.renderProjectOptions();
    logger.info('Loaded task explorer projects', {
      projectCount: this.state.projects.length,
    });
  }

  async loadHierarchy() {
    logger.debug('Loading task explorer hierarchy', {
      projectId: this.state.selectedProjectId || null,
    });
    this.renderLoading(this.elements.treeContent, 'Loading ticket hierarchy...');
    const query = this.state.selectedProjectId ? `?projectId=${encodeURIComponent(this.state.selectedProjectId)}` : '';
    const response = await fetchJson(`/api/v1/tickets/hierarchy${query}`);
    const tickets = response.data || response.tickets || [];
    this.state.rawTickets = tickets;
    this.state.ticketById = buildTicketIndex(tickets);
    this.updateTreeSubtitle(response);
    this.populateAgentFilter(tickets);
    this.applyFilters();
    logger.info('Loaded task explorer hierarchy', {
      projectId: this.state.selectedProjectId || null,
      ticketCount: this.state.ticketById.size,
    });

    if (this.state.selectedTicketId && this.state.ticketById.has(this.state.selectedTicketId)) {
      await this.selectTicket(this.state.selectedTicketId);
    }
  }

  populateAgentFilter(tickets) {
    const agents = new Set();
    const collect = (items) => {
      items.forEach((t) => {
        const assignee = t.assignee || t.assignedAgentId || '';
        if (assignee) agents.add(assignee);
        if (Array.isArray(t.children)) collect(t.children);
      });
    };
    collect(tickets);
    this.state.uniqueAgents = [...agents].sort();
    if (this.elements.toolbarAgentFilter) {
      this.elements.toolbarAgentFilter.innerHTML = '<option value="all">All Agents</option>' +
        this.state.uniqueAgents.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
    }
  }

  async loadMetrics() {
    logger.debug('Loading task explorer metrics', {
      projectId: this.state.selectedProjectId || null,
    });
    const query = this.state.selectedProjectId ? `?projectId=${encodeURIComponent(this.state.selectedProjectId)}` : '';
    const response = await fetchJson(`/api/v1/metrics/summary${query}`);
    const data = response.data || {};
    setText('metricQueue', numberValue(data.queue));
    setText('metricInProgress', numberValue(data.inProgress));
    setText('metricReview', numberValue(data.review));
    setText('metricDone', numberValue(data.done));
    setText('metricAgents', `${numberValue(data.agents?.busy)}/${numberValue(data.agents?.total)}`);
    setText('metricDuration', data.avgProcessingTimeFormatted || '—');
    setText('metricCost', formatCurrency(data.estimatedTotalCost || 0));
    logger.info('Loaded task explorer metrics', {
      projectId: this.state.selectedProjectId || null,
      queue: numberValue(data.queue),
      inProgress: numberValue(data.inProgress),
    });
  }

  renderProjectOptions() {
    if (!this.state.projects.length) {
      this.elements.projectSelect.innerHTML = '<option value="">No projects available</option>';
      return;
    }

    if (!this.state.selectedProjectId) {
      this.state.selectedProjectId = this.state.projects[0].id;
    }

    this.elements.projectSelect.innerHTML = this.state.projects.map((project) => (
      `<option value="${escapeHtml(project.id)}">${escapeHtml(project.identifier)} · ${escapeHtml(project.name)} (${project.ticketCount})</option>`
    )).join('');
    this.elements.projectSelect.value = this.state.selectedProjectId;
  }

  renderTree(tickets) {
    if (!tickets.length) {
      this.renderEmpty(this.elements.treeContent, 'No tickets found for the selected project.');
      return;
    }

    const grouped = splitTreeGroups(tickets);
    const markup = [
      renderTreeGroup('Programs', grouped.withChildren, this.state),
      renderTreeGroup('Standalone', grouped.withoutChildren, this.state),
    ].join('');
    this.elements.treeContent.innerHTML = markup;
  }

  async selectTicket(ticketId) {
    logger.info('Selecting task explorer ticket', { ticketId });
    this.state.selectedTicketId = ticketId;
    this.applyFilters();
    await Promise.all([
      this.loadActivity(ticketId),
      this.loadWorkspace(ticketId),
      this.loadProcessHistory(ticketId),
    ]);
  }

  async loadActivity(ticketId) {
    this.renderLoading(this.elements.activityPanel, 'Loading activity...');
    const response = await fetchJson(`/api/v1/tickets/${encodeURIComponent(ticketId)}/activity`);
    this.state.lastActivityData = response.data;
    this.elements.activityPanel.innerHTML = renderActivityMarkup(response.data);
    this.renderCostTab(response.data);
  }

  async loadProcessHistory(ticketId) {
    this.renderLoading(this.elements.processPanel, 'Loading status history...');
    try {
      const response = await fetchJson(`/api/v1/explorer/tickets/${encodeURIComponent(ticketId)}/status-history`);
      this.elements.processPanel.innerHTML = renderProcessMarkup(response.data || []);
    } catch (_error) {
      this.elements.processPanel.innerHTML = '<div class="empty-state"><strong>Status history is not available for this ticket.</strong></div>';
    }
  }

  renderCostTab(activityData) {
    if (!this.elements.costPanel) return;
    if (!activityData || !activityData.cost) {
      this.elements.costPanel.innerHTML = '<div class="empty-state"><strong>No cost data available.</strong></div>';
      return;
    }
    this.elements.costPanel.innerHTML = renderCostMarkup(activityData);
  }

  async loadWorkspace(ticketId) {
    this.renderLoading(this.elements.filesPanel, 'Loading workspace...');
    const rootTicketId = findRootTicketId(ticketId, this.state.ticketById);
    const response = await fetchJson(`/api/v1/workspace/${encodeURIComponent(rootTicketId)}/files`);
    if (!response.data?.exists || !(response.data.children || []).length) {
      await this.loadWorkspaceFallback();
      return;
    }

    this.elements.filesPanel.innerHTML = renderWorkspaceMarkup(response.data, rootTicketId);
    this.bindWorkspaceInteractions();
  }

  async loadWorkspaceFallback() {
    const response = await fetchJson('/api/v1/workspace/browse');
    this.elements.filesPanel.innerHTML = renderWorkspaceFallbackMarkup(response.data);
    this.bindWorkspaceInteractions();
  }

  async openWorkspaceFolder(folderName) {
    this.renderLoading(this.elements.filesPanel, 'Loading workspace folder...');
    const response = await fetchJson(`/api/v1/workspace/${encodeURIComponent(folderName)}/files`);
    this.elements.filesPanel.innerHTML = renderWorkspaceMarkup(response.data, folderName, true);
    this.bindWorkspaceInteractions();
  }

  async openWorkspaceFile(ticketId, relativePath) {
    const viewer = this.elements.filesPanel.querySelector('[data-role="file-viewer"]');
    if (!viewer) {
      return;
    }

    viewer.innerHTML = '<div class="breadcrumb">Loading file preview...</div>';
    const response = await fetchJson(`/api/v1/workspace/${encodeURIComponent(ticketId)}/files/${encodePath(relativePath)}`);
    viewer.innerHTML = renderFileViewerMarkup(response.data);
  }

  bindWorkspaceInteractions() {
    this.elements.filesPanel.querySelectorAll('[data-open-folder]').forEach((button) => {
      button.addEventListener('click', async () => this.openWorkspaceFolder(button.dataset.openFolder));
    });

    this.elements.filesPanel.querySelectorAll('[data-open-file]').forEach((button) => {
      button.addEventListener('click', async () => {
        await this.openWorkspaceFile(button.dataset.ticketId, button.dataset.openFile);
      });
    });

    const backButton = this.elements.filesPanel.querySelector('[data-workspace-back]');
    if (backButton) {
      backButton.addEventListener('click', async () => this.loadWorkspaceFallback());
    }
  }

  switchTab(tabId) {
    this.state.activeTab = tabId;
    this.elements.tabs.forEach((tabButton) => {
      tabButton.classList.toggle('active', tabButton.dataset.tab === tabId);
    });

    this.elements.activityPanel.classList.toggle('hidden', tabId !== 'activity');
    this.elements.filesPanel.classList.toggle('hidden', tabId !== 'files');
  }

  toggleExpanded(ticketId) {
    if (this.state.expandedIds.has(ticketId)) {
      this.state.expandedIds.delete(ticketId);
    } else {
      this.state.expandedIds.add(ticketId);
    }

    this.renderTree(Array.from(getRootTickets(this.state.ticketById).values()));
  }

  updateTreeSubtitle(response) {
    const identifier = response.projectIdentifier || 'TASK';
    const workspaceSlug = response.workspaceSlug || 'local workspace';
    this.elements.treeSubtitle.textContent = `${identifier} · ${workspaceSlug}`;
  }

  setProjectLoadingState() {
    this.elements.projectSelect.innerHTML = '<option value="">Loading projects...</option>';
  }

  renderLoading(target, message) {
    target.innerHTML = `<div class="empty-state"><strong>${escapeHtml(message)}</strong></div>`;
  }

  renderEmpty(target, message) {
    target.innerHTML = `<div class="empty-state"><strong>${escapeHtml(message)}</strong></div>`;
  }

  attachResizeHandle() {
    const handle = this.elements.resizeHandle;
    const panel = this.elements.treePanel;
    let startWidth = 0;
    let startX = 0;

    handle.addEventListener('mousedown', (event) => {
      startWidth = panel.getBoundingClientRect().width;
      startX = event.clientX;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      event.preventDefault();
    });

    const onMouseMove = (event) => {
      const nextWidth = Math.min(480, Math.max(280, startWidth + event.clientX - startX));
      panel.style.width = `${nextWidth}px`;
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }
}

function renderTreeGroup(title, tickets, state) {
  if (!tickets.length) {
    return '';
  }

  return [
    `<p class="tree-group-title">${escapeHtml(title)}</p>`,
    tickets.map((ticket) => renderTreeRow(ticket, state)).join(''),
  ].join('');
}

function renderTreeRow(ticket, state, depth = 0) {
  const hasChildren = (ticket.children || []).length > 0;
  const isExpanded = state.expandedIds.has(ticket.id);
  const isSelected = state.selectedTicketId === ticket.id;
  const indent = 14 + (depth * 18);
  const stateClass = getStateClass(ticket.stateGroup || ticket.state);
  const phaseHtml = ticket.executionPhase ? `<span class="phase-badge">${escapeHtml(ticket.executionPhase)}</span>` : '';
  const agentHtml = (ticket.assignee || ticket.assignedAgentId) ? `<span class="agent-badge">${escapeHtml(ticket.assignee || ticket.assignedAgentId)}</span>` : '';
  const rowMarkup = `
    <div style="padding-left:${indent}px">
      <button class="tree-row ${hasChildren ? 'is-parent' : ''} ${isSelected ? 'is-selected' : ''}" type="button" data-ticket-id="${escapeHtml(ticket.id)}">
        <span class="toggle">${hasChildren ? (isExpanded ? '▾' : '▸') : '·'}</span>
        <span class="state-dot ${stateClass}"></span>
        <span class="tree-label">
          <strong>${escapeHtml(ticket.name)}</strong>
          <span class="tree-meta">${escapeHtml(ticket.project_identifier || ticket.project || '')}-${escapeHtml(ticket.sequenceId)} · ${escapeHtml(humanizeState(ticket.stateGroup || ticket.state))}${phaseHtml}${agentHtml}</span>
        </span>
        <span class="tree-pill">${(ticket.children || []).length}</span>
      </button>
      ${hasChildren ? `<button class="hidden" type="button" data-action="toggle" data-ticket-id="${escapeHtml(ticket.id)}"></button>` : ''}
    </div>`;

  if (!hasChildren || !isExpanded) {
    return rowMarkup;
  }

  return rowMarkup + ticket.children.map((child) => renderTreeRow(child, state, depth + 1)).join('');
}

function renderActivityMarkup(data) {
  const ticket = data.ticket || {};
  const timeline = data.timeline || [];
  const stats = data.activityStats || {};
  return `
    <div class="section-grid">
      <section class="section-card ticket-title">
        <span class="ticket-id">${escapeHtml(ticket.project_identifier || 'TASK')}-${escapeHtml(ticket.sequence_id || '0000')}</span>
        <h2>${escapeHtml(ticket.name || 'Untitled ticket')}</h2>
        <p>${escapeHtml(ticket.description_stripped || 'No ticket description recorded yet.')}</p>
      </section>
      <section class="detail-grid">
        ${renderDetailItem('State', ticket.state || 'backlog')}
        ${renderDetailItem('Priority', ticket.priority || 'none')}
        ${renderDetailItem('Created', formatDateTime(ticket.created_at))}
        ${renderDetailItem('Updated', formatDateTime(ticket.updated_at))}
      </section>
      <section class="stat-strip">
        ${renderStat('Messages', numberValue(stats.totalMessages))}
        ${renderStat('Tool Calls', numberValue(stats.toolUseCount))}
        ${renderStat('Subtasks', numberValue(stats.subtaskCount))}
        ${renderStat('Cost', formatCurrency(stats.aggregatedCost || 0))}
      </section>
      <section class="section-card">
        <h3>Timeline</h3>
        <div class="timeline">
          ${timeline.length ? timeline.map(renderTimelineEntry).join('') : '<p>No activity recorded yet.</p>'}
        </div>
      </section>
    </div>`;
}

function renderWorkspaceMarkup(data, ticketId, showBackButton = false) {
  const items = (data.children || []).map((entry) => renderWorkspaceEntry(entry, ticketId)).join('');
  return `
    <div class="workspace-shell">
      <section class="section-card workspace-header">
        <div>
          <p class="breadcrumb">Workspace</p>
          <strong>${escapeHtml(data.path || 'workspace')}</strong>
        </div>
        ${showBackButton ? '<button data-workspace-back type="button">Browse all workspaces</button>' : ''}
      </section>
      <section class="workspace-list">
        ${items || '<div class="section-card"><p>No workspace files found.</p></div>'}
      </section>
      <section class="file-viewer" data-role="file-viewer">
        <div class="breadcrumb">Select a file to preview its contents.</div>
      </section>
    </div>`;
}

function renderWorkspaceFallbackMarkup(data) {
  const items = (data.workspaces || []).map((workspace) => `
    <button class="workspace-item" type="button" data-open-folder="${escapeHtml(workspace.path)}">
      <span>
        <strong>${escapeHtml(workspace.name)}</strong>
        <small>${escapeHtml(formatDateTime(workspace.modified))}</small>
      </span>
      <span class="tree-pill">${workspace.fileCount} files</span>
    </button>
  `).join('');

  return `
    <div class="workspace-shell">
      <section class="section-card workspace-header">
        <div>
          <p class="breadcrumb">Workspace Browser</p>
          <strong>${escapeHtml(data.basePath || 'workspace')}</strong>
        </div>
      </section>
      <section class="workspace-list">
        ${items || '<div class="section-card"><p>No workspaces available.</p></div>'}
      </section>
      <section class="file-viewer" data-role="file-viewer">
        <div class="breadcrumb">Pick a workspace folder to inspect it.</div>
      </section>
    </div>`;
}

function renderWorkspaceEntry(entry, ticketId, depth = 0) {
  const indent = 12 + (depth * 18);
  if (entry.type === 'directory') {
    const children = (entry.children || []).map((child) => renderWorkspaceEntry(child, ticketId, depth + 1)).join('');
    return `
      <div>
        <div class="workspace-item" style="padding-left:${indent}px">
          <span>
            <strong>${escapeHtml(entry.name)}</strong>
            <small>${escapeHtml(entry.path)}</small>
          </span>
          <span class="tree-pill">dir</span>
        </div>
        ${children}
      </div>`;
  }

  return `
    <button class="workspace-item is-file" type="button" style="padding-left:${indent}px" data-open-file="${escapeHtml(entry.path)}" data-ticket-id="${escapeHtml(ticketId)}">
      <span>
        <strong>${escapeHtml(entry.name)}</strong>
        <small>${escapeHtml(entry.path)}</small>
      </span>
      <span>${escapeHtml(entry.sizeFormatted || '')}</span>
      <span class="tree-pill">${escapeHtml(entry.extension || 'file')}</span>
    </button>`;
}

function renderFileViewerMarkup(data) {
  const suffix = data.truncated ? ' Preview truncated to 256 KB.' : '';
  return `
    <div class="breadcrumb">${escapeHtml(data.path || 'file')} · ${escapeHtml(data.language || 'text')} · ${escapeHtml(formatBytes(data.size || 0))}${suffix}</div>
    <pre>${escapeHtml(data.content || '')}</pre>`;
}

function renderDetailItem(label, value) {
  return `<article class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function renderStat(label, value) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></article>`;
}

function renderTimelineEntry(entry) {
  return `
    <article class="timeline-entry">
      <div class="timeline-time">${escapeHtml(formatDateTime(entry.timestamp))}</div>
      <div>
        <strong>${escapeHtml(entry.type || 'event')}</strong>
        <p>${escapeHtml(entry.summary || 'No summary')}</p>
      </div>
    </article>`;
}

function splitTreeGroups(tickets) {
  return {
    withChildren: tickets.filter((ticket) => (ticket.children || []).length > 0),
    withoutChildren: tickets.filter((ticket) => !(ticket.children || []).length),
  };
}

function buildTicketIndex(tickets, index = new Map()) {
  tickets.forEach((ticket) => {
    index.set(ticket.id, ticket);
    buildTicketIndex(ticket.children || [], index);
  });
  return index;
}

function getRootTickets(ticketById) {
  const roots = new Map();
  ticketById.forEach((ticket) => {
    if (!ticket.parentId || !ticketById.has(ticket.parentId)) {
      roots.set(ticket.id, ticket);
    }
  });
  return roots;
}

function findRootTicketId(ticketId, ticketById) {
  let currentTicket = ticketById.get(ticketId);
  while (currentTicket?.parentId && ticketById.has(currentTicket.parentId)) {
    currentTicket = ticketById.get(currentTicket.parentId);
  }
  return currentTicket?.id || ticketId;
}

async function fetchJson(url) {
  const startedAt = Date.now();
  logger.debug('Task explorer request started', { url });
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    const errorMessage = payload.error || `Request failed for ${url}`;
    logger.warn('Task explorer request failed', {
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
    throw new Error(errorMessage);
  }
  logger.info('Task explorer request completed', {
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return payload;
}

function encodePath(relativePath) {
  return relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(value) {
  if (!value) {
    return '—';
  }
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function numberValue(value) {
  return Number(value || 0);
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = String(value);
  }
}

// ── Ticket Normalization ─────────────────────────────────────────────────────

function normTicket(t) {
  return {
    id: t.id || t.ticketId || '',
    name: t.name || t.title || 'Untitled',
    sequenceId: t.sequenceId || t.sequence_id || (t.id || '').substring(0, 8),
    state: t.state || t.status || 'backlog',
    stateGroup: t.stateGroup || '',
    executionPhase: t.executionPhase || null,
    assignee: t.assignee || t.assignedAgentId || '',
    cost: t.actualCost || t.estimatedCost || 0,
    createdAt: t.created_at || t.createdAt || '',
    updatedAt: t.updated_at || t.updatedAt || '',
    priority: t.priority || 'none',
    project: t.project || t.folder || '',
    projectId: t.projectId || '',
    description: t.description || '',
    parentId: t.parentId || t.parent_id || null,
    children: t.children || [],
    labels: t.labels || [],
  };
}

function groupTickets(tickets, groupKey) {
  const groups = {};
  tickets.forEach((t) => {
    let key;
    if (groupKey === 'status') {
      key = humanizeState(t.stateGroup || t.state) || 'Unknown';
    } else if (groupKey === 'project') {
      key = t.project || 'Unassigned';
    } else {
      key = t.assignee || 'Unassigned';
    }
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });
  return groups;
}

function getStateClass(state) {
  const s = (state || '').toLowerCase();
  if (s.includes('in_process') || s === 'in progress') return 'in-progress';
  if (s === 'customer_action' || s === 'approval_required' || s === 'in review' || s === 'review') return 'in-review';
  if (s === 'complete' || s === 'done' || s === 'completed') return 'done';
  if (s === 'escalated') return 'escalated';
  if (s === 'approved') return 'approved';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'paused') return 'paused';
  return 'backlog';
}

function humanizeState(state) {
  return (state || '')
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

// ── Process Tab Renderer ────────────────────────────────────────────────────

function renderProcessMarkup(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return '<div class="empty-state"><strong>No status transitions recorded for this ticket.</strong></div>';
  }

  const entries = history.map((entry) => `
    <article class="timeline-entry">
      <div class="timeline-time">${escapeHtml(formatDateTime(entry.changedAt || entry.createdAt))}</div>
      <div>
        <strong>${escapeHtml(humanizeState(entry.fromStatus || 'created'))} &rarr; ${escapeHtml(humanizeState(entry.toStatus))}</strong>
        <p>Changed by ${escapeHtml(entry.changedByLabel || entry.changedBy || 'system')}</p>
      </div>
    </article>`).join('');

  return `
    <div class="activity-feed">
      <div class="section-card">
        <strong>Status History</strong>
        <p>${history.length} transition${history.length !== 1 ? 's' : ''} recorded</p>
      </div>
      <div class="timeline">${entries}</div>
    </div>`;
}

// ── Cost Tab Renderer ───────────────────────────────────────────────────────

function renderCostMarkup(activityData) {
  const cost = activityData?.cost || {};
  const stats = activityData?.activityStats || {};
  const totalTokens = numberValue(cost.totalTokens);
  const estimatedCost = numberValue(cost.estimatedCost);
  const totalRequests = numberValue(stats.totalMessages);

  const summaryCards = `
    <div class="cost-summary-grid">
      ${renderStat('Total Tokens', totalTokens.toLocaleString())}
      ${renderStat('Estimated Cost', formatCurrency(estimatedCost))}
      ${renderStat('Messages', totalRequests)}
      ${renderStat('Subtask Cost', formatCurrency(numberValue(stats.subtaskCost)))}
      ${renderStat('Aggregated Cost', formatCurrency(numberValue(stats.aggregatedCost)))}
    </div>`;

  const contributingBots = activityData?.contributingBots;
  let botTable = '';
  if (Array.isArray(contributingBots) && contributingBots.length > 0) {
    const rows = contributingBots.map((bot) => `
      <tr>
        <td>${escapeHtml(bot.agentName || bot.agentId || 'unknown')}</td>
        <td>${numberValue(bot.totalRequests).toLocaleString()}</td>
        <td>${numberValue(bot.totalTokens).toLocaleString()}</td>
        <td>${formatCurrency(numberValue(bot.totalCost))}</td>
      </tr>`).join('');
    botTable = `
      <div class="section-card" style="margin-top:16px">
        <strong>Cost by Bot</strong>
        <table class="cost-table">
          <thead><tr><th>Bot</th><th>Requests</th><th>Tokens</th><th>Est. Cost</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  return `<div class="activity-feed">${summaryCards}${botTable}</div>`;
}

const app = new TaskExplorerApp();
app.init().catch((error) => {
  logger.error('Task explorer bootstrap failed', {
    error: serializeUiError(error),
  });
  const treeContent = document.getElementById('treeContent');
  if (treeContent) {
    treeContent.innerHTML = `<div class="empty-state"><strong>${escapeHtml(error.message || 'Task explorer failed to load.')}</strong></div>`;
  }
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Hardened cockpit ticket-surface operator flows with focused reply/status/delete feedback, code-server bridge normalization, and extracted tab rendering helpers
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added view-switch ticket selection hydration so calendar and other cockpit surfaces can open a real ticket detail directly
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Normalized the ticket-toolbar status filter to the real lifecycle vocabulary so list filtering matches the detail workflow model
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Removed the fragile trailing slash from generated /code workspace links so ticket artifact handoff matches the authenticated bridge route
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Normalized ticket list and child-row state rendering so raw legacy values like Todo no longer disagree with the detail pane lifecycle labels
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Improved ticket filter/search behavior so child matches surface the parent row and filtered-out selections do not leave stale detail panes behind
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Cleared stale ticket detail when search or project filters produce an empty result set so the right pane never shows hidden work
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Normalized ticket artifact code-server links onto shared workspace paths so cockpit no longer leaks host-local absolute paths into swarm code-server URLs
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Restored parent-child expansion inside grouped ticket views so grouped status/date modes keep hierarchy drill-in instead of flattening subtasks into dead badges
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Made the ticket cost tab distinguish missing telemetry from real zero-cost work so empty cost states stop pretending they are measured totals
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Restored project grouping in the toolbar and added parent-ticket drill-in context so child-ticket detail stays connected to its root work item
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Added durable escalation lookup for escalated ticket detail so cockpit can show exact reason text, guided next steps, and a dedicated de-escalation action
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Hydrated child detail with hierarchy fallback metadata so project-grouped subtask drill-in still knows its parent when activity payloads omit parent linkage
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Added explicit child-ticket action and workspace guidance so subtasks explain parent-managed delete/workspace behavior instead of quietly omitting controls
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Normalized ticket tab empty and error states so feed/description/artifacts/cost all use the same operator-facing guidance language and structure
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Added actionable ticket failure states with retry controls so detail and artifact backend outages no longer collapse into dead-end placeholders
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed detail/tab helpers and added root-ticket project reassignment controls so tickets can move from Default into a named project without breaking the tree
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Added explicit project management UX with create/rename/archive modal accessible from the ticket toolbar
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Added Create Ticket button to toolbar with modal form for direct ticket creation without requiring Chat panel
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Completed modal extraction and restored TicketView syntax so the cockpit ticket surface can boot without browser parse failures
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Repaired the extracted TicketView footer methods and class closure so cockpit ticket rendering parses correctly again
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Normalized escalated ticket detail inputs so activity payload external ids and raw statuses drive de-escalation guidance and durable escalation lookups correctly
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Default the status filter to "active" (hide closed) so the general cockpit no longer opens onto a wall of complete/cancelled tickets; "active" now excludes BOTH complete and cancelled; sync the dropdown to the default and add a Cancelled filter option so closed work stays reachable on demand
 */

import { ApiClient } from '../api-client.js';
import { formatCost, timeAgo, getStatusClass, getStatusLabel, truncate } from '../utils/formatters.js';
import {
  buildActionableEmptyState,
  buildActionableNotice,
  buildStateOptions,
  buildDetailEmptyState,
  buildInlineEmptyState,
  extractErrorMessage,
  getTicketStateGroup,
  normalizeWorkflowState,
  stateLabel,
  ticketMatchesSearch,
} from './ticket-view-helpers.js';
import { renderTicketDetail, renderTicketTab } from './ticket-view-detail-renderer.js';
import { openCreateTicketModal, openProjectManagerModal } from './TicketModals.js';

/**
 * @description Cockpit ticket workbench with list filtering, detail tabs, and ticket-action flows.
 */
export class TicketView {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.api = new ApiClient();
    this.tickets = [];
    this.selectedId = null;
    this.sortField = 'date';
    this.sortDir = 'desc';
    this.searchQuery = '';
    this.statusFilter = options.defaultStatusFilter || 'active'; // default hides closed (complete + cancelled) noise
    this.typeFilter = 'all';
    this.groupBy = 'none'; // none, date, project, state
    this.onChatWithBot = options.onChatWithBot || null;
    this.expandedParents = new Set();
    this.expandedGroups = new Set();
    this.projects = [];
    this.projectFilter = 'all';
    this.showToast = options.onToast || ((message, type) => this._showToast(message, type));
    this.initialSelectedTicketId = typeof options.initialSelectedTicketId === 'string'
      ? options.initialSelectedTicketId.trim()
      : '';

    /** @type {EventSource|null} */
    this._activitySSE = null;
  }

  async render() {
    if (!this.container) return;
    this.container.innerHTML = `<div class="ticket-view">
      <div class="ticket-list-pane">
        <div class="ticket-list-toolbar">
          <input class="search-input" placeholder="Search tickets..." id="tvSearch">
          <select class="filter-btn" id="tvStatusFilter" style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--radius-sm);padding:6px 8px;color:var(--text-primary);font-size:11px;font-family:var(--font-family);cursor:pointer">
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="backlog">Backlog</option>
            <option value="approved">Approved</option>
            <option value="in progress">In Progress</option>
            <option value="approval_required">Approval Required</option>
            <option value="customer_action">Customer Action</option>
            <option value="escalated">Escalated</option>
            <option value="complete">Complete</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select class="filter-btn" id="tvProjectFilter" style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--radius-sm);padding:6px 8px;color:var(--text-primary);font-size:11px;font-family:var(--font-family);cursor:pointer">
            <option value="all">All Projects</option>
          </select>
          <select class="filter-btn" id="tvTypeFilter" style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--radius-sm);padding:6px 8px;color:var(--text-primary);font-size:11px;font-family:var(--font-family);cursor:pointer">
            <option value="all">All Types</option>
            <option value="build">Build</option>
            <option value="incident">Incident</option>
            <option value="intelligent-processing">Intelligent Processing</option>
          </select>
          <button class="filter-btn" id="tvCreateTicket" style="background:var(--accent-primary);border:1px solid var(--accent-primary);border-radius:var(--radius-sm);padding:6px 8px;color:#fff;font-size:11px;font-family:var(--font-family);cursor:pointer" title="Create Ticket">
            <i class="ph ph-plus"></i>
          </button>
          <button class="filter-btn" id="tvManageProjects" style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--radius-sm);padding:6px 8px;color:var(--text-primary);font-size:11px;font-family:var(--font-family);cursor:pointer" title="Manage Projects">
            <i class="ph ph-folder-plus"></i>
          </button>
          <select class="filter-btn" id="tvGroupBy" style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--radius-sm);padding:6px 8px;color:var(--text-primary);font-size:11px;font-family:var(--font-family);cursor:pointer">
            <option value="none">No Grouping</option>
            <option value="date">Group by Date</option>
            <option value="state">Group by Status</option>
            <option value="project">Group by Project</option>
          </select>
        </div>
        <div class="ticket-list-header" id="tvListHeader">
          <span data-sort="status">⬤</span>
          <span data-sort="name">Subject <span class="sort-indicator">▼</span></span>
          <span data-sort="cost">Cost</span>
          <span data-sort="date">Date</span>
        </div>
        <div class="ticket-list-scroll" id="tvListScroll"></div>
      </div>
      <div class="ticket-resize-handle" id="tvResizeHandle"></div>
      <div class="ticket-detail-pane" id="tvDetailPane">
        <div class="ticket-detail-empty">
          <i class="ph ph-envelope-open"></i>
          <span>Select a ticket to view details</span>
        </div>
      </div>
    </div>`;
    this._bindEvents();
    await this.loadTickets();
    if (this.initialSelectedTicketId) {
      await this.focusTicket(this.initialSelectedTicketId);
      this.initialSelectedTicketId = '';
    }
  }

  /**
   * @description Focus one ticket row and load its detail pane.
   * @param {string} ticketId - Ticket identifier to select.
   * @returns {Promise<void>}
   */
  async focusTicket(ticketId) {
    const nextTicketId = typeof ticketId === 'string' ? ticketId.trim() : '';
    if (!nextTicketId) {
      return;
    }
    await this._selectTicket(nextTicketId);
  }

  _bindEvents() {
    const search = this.container.querySelector('#tvSearch');
    if (search) {
      let debounce;
      search.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          this.searchQuery = search.value.trim().toLowerCase();
          this._renderList();
        }, 200);
      });
    }

    // Status filter — sync the dropdown to the active default, then listen for changes.
    const statusSel = this.container.querySelector('#tvStatusFilter');
    if (statusSel) {
      statusSel.value = this.statusFilter;
      statusSel.addEventListener('change', (e) => {
        this.statusFilter = e.target.value;
        this._renderList();
      });
    }

    // Group by
    this.container.querySelector('#tvGroupBy')?.addEventListener('change', (e) => {
      this.groupBy = e.target.value;
      this.expandedGroups.clear();
      this._renderList();
    });

    // Project filter
    this.container.querySelector('#tvProjectFilter')?.addEventListener('change', (e) => {
      this.projectFilter = e.target.value;
      this.loadTickets();
    });

    // Type filter — incident vs build vs education.
    // URL `?app=` (manifest-resolved ticketType) still wins over this dropdown.
    this.container.querySelector('#tvTypeFilter')?.addEventListener('change', (e) => {
      this.typeFilter = e.target.value;
      this.loadTickets();
    });

    // Create ticket
    this.container.querySelector('#tvCreateTicket')?.addEventListener('click', () => {
      this._openCreateTicketModal();
    });

    // Manage projects
    this.container.querySelector('#tvManageProjects')?.addEventListener('click', () => {
      this._openProjectManagerModal();
    });

    // Column sort
    this.container.querySelector('#tvListHeader')?.addEventListener('click', (e) => {
      const col = e.target.closest('span[data-sort]');
      if (!col) return;
      const field = col.dataset.sort;
      if (this.sortField === field) {
        this.sortDir = this.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        this.sortField = field;
        this.sortDir = 'desc';
      }
      this._renderList();
    });

    // Resize handle between list and detail panes
    const resizeHandle = this.container.querySelector('#tvResizeHandle');
    const listPane = this.container.querySelector('.ticket-list-pane');
    if (resizeHandle && listPane) {
      let dragging = false;
      resizeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const containerRect = this.container.querySelector('.ticket-view')?.getBoundingClientRect();
        if (!containerRect) return;
        const newWidth = Math.max(240, Math.min(e.clientX - containerRect.left, containerRect.width - 300));
        listPane.style.width = `${newWidth}px`;
        listPane.style.flex = 'none';
      });
      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    }
  }

  async loadTickets() {
    // The queue filter lists ONLY the apps that are currently loaded (an app IS a
    // queue). Loaded apps come from the active swarm-app set; each app's queueId is
    // its name. This keeps the board scoped to the taskbar's loaded tools.
    try {
      const appsResp = await this.api.getSafe('/api/swarm/apps?status=active', { apps: [] });
      const loadedApps = (appsResp?.apps || []).filter((a) => a && a.queueId);
      this.projects = loadedApps.map((a) => ({ id: a.queueId, name: a.displayName || a.name }));
      const projSelect = this.container?.querySelector('#tvProjectFilter');
      if (projSelect) {
        projSelect.innerHTML = '<option value="all">All Queues</option>' +
          this.projects.map(p => `<option value="${p.id}"${p.id === this.projectFilter ? ' selected' : ''}>${p.name}</option>`).join('');
      }
    } catch (error) {
      this._logWarning('load-queue-filter-failed', error);
    }

    // Load tickets (optionally filtered by project + ticketType).
    // Manifest-driven `?app=<name>` URL param takes precedence over the
    // dropdown so launching the cockpit from a swarm-app context still
    // pre-filters to that app's ticketType.
    try {
      const projectId = this.projectFilter !== 'all' ? this.projectFilter : null;
      const manifestTicketType = await this._resolveActiveTicketType();
      const ticketType = manifestTicketType
        || (this.typeFilter !== 'all' ? this.typeFilter : null);
      // Remember the active app/process so the detail view can show only the
      // sub-screens that apply to it (e.g. RCA & Remediation only for incidents).
      this._activeTicketType = ticketType || '';
      const resp = await this.api.getTicketHierarchy(projectId, ticketType);
      this.tickets = resp.data || resp.tickets || resp.hierarchy || [];
    } catch (error) {
      this._logWarning('load-ticket-hierarchy-failed', error);
      try {
        const data = await this.api.getTasks();
        const tasks = data.tasks || [];
        this.tickets = tasks.map(t => ({
          id: t.id,
          sequenceId: t.id.replace('task_', '').substring(0, 6),
          name: t.text || 'Untitled task',
          state: t.status === 'completed' ? 'Done' : t.status === 'running' ? 'In Progress' : 'Backlog',
          cost: t.apiMetrics?.totalCost || 0,
          createdAt: t.ts ? new Date(t.ts).toISOString() : null,
          children: []
        }));
      } catch (fallbackError) {
        this._logWarning('load-task-fallback-failed', fallbackError);
        this.tickets = [];
      }
    }
    this._renderList();
  }

  /**
   * @description Resolve the ticketType to filter by, from the active swarm-app manifest.
   * Reads ?app= or ?profile= from the URL, looks up the manifest, returns its ticketType.
   * Returns null when no app is focused — caller then fetches unfiltered tickets.
   */
  async _resolveActiveTicketType() {
    try {
      const params = new URLSearchParams(window.location.search);
      const appName = params.get('app') || params.get('profile');
      if (!appName) return null;
      const resp = await this.api.getSafe(`/api/swarm/apps/${encodeURIComponent(appName)}`, null);
      return resp?.app?.manifest?.ticketType || null;
    } catch {
      return null;
    }
  }

  /** Normalize a ticket's fields for consistent access */
  _norm(t) {
    const source = t && typeof t === 'object' ? t : {};
    const rawStatus = source.rawStatus || source.raw_status || source.statusRaw || source.status_raw || '';
    const normalizedState = String(rawStatus || '').trim().toLowerCase() === 'escalated'
      ? 'escalated'
      : (source.state || source.state_name || source.status || 'Backlog');
    return {
      id: source.id || source.ticketId || '',
      externalId: source.externalId || source.external_id || source.ticketExternalId || source.ticket_external_id || '',
      name: source.name || source.title || 'Untitled',
      ticketType: source.ticketType || source.ticket_type || source.type || '',
      sequenceId: source.sequenceId || source.sequence_id || source.identifier || (source.id || source.ticketId || '').substring(0, 8),
      state: normalizedState,
      rawStatus,
      assignee: source.assignee_name || source.assignee || '',
      cost: source.cost || source.totalCost || source.actualCost || source.estimatedCost || source.metadata?.cost || 0,
      createdAt: source.createdAt || source.created_at || '',
      updatedAt: source.updatedAt || source.updated_at || '',
      priority: source.priority || 'none',
      children: source.children || [],
      childCount: source.childCount || (source.children || []).length,
      parentId: source.parentId || source.parent_id || null,
      project: source.project_name || source.project || '',
      projectId: source.projectId || source.project_id || '',
      projectIdentifier: source.projectIdentifier || source.project_identifier || '',
      workspaceSlug: source.workspaceSlug || source.workspace_slug || '',
      stateColor: source.stateColor || '',
      description: source.description || source.description_stripped || '',
      workspaceTaskId: source.workspaceTaskId || source.workspace_task_id || source.linkedTaskId || source.linked_task_id || '',
      workspacePath: source.workspacePath || source.workspace_path || '',
      escalation: source.escalation || source.latestEscalation || null,
    };
  }

  _getFiltered() {
    let list = this.tickets.map(t => this._norm(t));

    // Status filter
    if (this.statusFilter === 'active') {
      // "Active" = not closed: hide both complete and cancelled tickets.
      const closed = new Set(['complete', 'cancelled']);
      list = list.filter((ticket) => !closed.has(this._getTicketStateGroup(ticket.state)));
    } else if (this.statusFilter !== 'all') {
      list = list.filter((ticket) => this._getTicketStateGroup(ticket.state) === this.statusFilter.toLowerCase());
    }

    // Search
    if (this.searchQuery) {
      const q = this.searchQuery;
      list = list.filter((ticket) => this._ticketMatchesSearch(ticket, q));
    }

    // Sort
    list.sort((a, b) => {
      let cmp = 0;
      if (this.sortField === 'cost') cmp = a.cost - b.cost;
      else if (this.sortField === 'name') cmp = a.name.localeCompare(b.name);
      else if (this.sortField === 'status') cmp = this._stateLabel(a.state).localeCompare(this._stateLabel(b.state));
      else cmp = new Date(a.updatedAt || a.createdAt || 0).getTime() - new Date(b.updatedAt || b.createdAt || 0).getTime();
      return this.sortDir === 'desc' ? -cmp : cmp;
    });

    return list.slice(0, 500);
  }

  _renderList() {
    const scroll = this.container.querySelector('#tvListScroll');
    if (!scroll) return;
    const tickets = this._getFiltered();

    if (!tickets.length) {
      this._syncSelectionAfterRender([]);
      // First-run vs filtered-empty: if the raw set is empty there are genuinely no
      // tickets (no filter could change that), so guide the user to make their first
      // one instead of telling them to "change filters" on an empty board.
      if (!this.tickets.length) {
        scroll.innerHTML = this._buildActionableEmptyState('ticket', 'No tickets yet', 'Tickets are how work happens in OSHAL. Create one and a bot picks it up, or just ask Jarvis and it opens a ticket for you.', 'tvEmptyCreate', 'Create your first ticket');
        scroll.querySelector('#tvEmptyCreate')?.addEventListener('click', () => this._openCreateTicketModal());
      } else {
        scroll.innerHTML = this._buildDetailEmptyState('ticket', 'No tickets found', 'Try changing the search, project, or status filters.');
      }
      return;
    }

    let html = '';

    if (this.groupBy !== 'none') {
      const groups = this._groupTickets(tickets);
      const groupKeys = Object.keys(groups);
      groupKeys.forEach(key => {
        const groupTickets = groups[key];
        const expanded = this.expandedGroups.has(key);
        html += `<div class="ticket-row" data-group="${key}" style="background:var(--glass-bg);font-weight:600;cursor:pointer;border-bottom:1px solid var(--border-color)">
          <div style="display:flex;align-items:center;gap:4px;justify-content:center">
            <span class="expand-chevron${expanded ? ' expanded' : ''}" style="font-size:10px">▶</span>
          </div>
          <div class="ticket-subject">
            <div class="ticket-subject-title" style="font-size:12px">${key} <span class="subtask-badge">${groupTickets.length}</span></div>
          </div>
          <div></div>
          <div></div>
        </div>`;
        if (expanded) {
          html += this._renderTicketRows(groupTickets);
        }
      });
    } else {
      html += this._renderTicketRows(tickets);
    }

    scroll.innerHTML = html;
    this._syncSelectionAfterRender(tickets);

    // Bind clicks
    scroll.querySelectorAll('.ticket-row').forEach(row => {
      row.addEventListener('click', (e) => {
        const groupKey = row.dataset.group;
        if (groupKey) {
          // Toggle group
          if (this.expandedGroups.has(groupKey)) this.expandedGroups.delete(groupKey);
          else this.expandedGroups.add(groupKey);
          this._renderList();
          return;
        }
        const chevron = e.target.closest('.expand-chevron');
        if (chevron) {
          e.stopPropagation();
          this._toggleChildren(row.dataset.id);
          return;
        }
        if (row.dataset.id) this._selectTicket(row.dataset.id);
      });
    });
  }

  _groupTickets(tickets) {
    const groups = {};
    tickets.forEach(t => {
      let key;
      if (this.groupBy === 'date') {
        const d = t.createdAt || t.updatedAt;
        key = d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No Date';
      } else if (this.groupBy === 'state') {
        key = this._stateLabel(t.state) || 'Unknown';
      } else {
        key = t.project || 'Unassigned Project';
      }
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    });
    return groups;
  }

  _renderTicketRows(tickets) {
    let html = '';
    tickets.forEach((ticket) => {
      const hasChildren = ticket.childCount > 0 && ticket.children.length > 0;
      const expanded = this.expandedParents.has(ticket.id);
      html += this._rowHTML(ticket, hasChildren, expanded);
      if (hasChildren && expanded) {
        html += `<div class="ticket-children-rows expanded" data-parent="${ticket.id}">`;
        ticket.children.forEach((child) => {
          html += this._rowHTML(this._norm(child));
        });
        html += '</div>';
      }
    });
    return html;
  }

  _normalizeWorkflowState(state) {
    return normalizeWorkflowState(state);
  }

  _buildStateOptions(currentState) {
    return buildStateOptions(currentState);
  }

  _getTicketStateGroup(state) {
    return getTicketStateGroup(state);
  }

  _ticketMatchesSearch(ticket, query) {
    return ticketMatchesSearch(ticket, query, (row) => this._norm(row));
  }

  _stateLabel(state) {
    return stateLabel(state);
  }

  _syncSelectionAfterRender(visibleTickets) {
    if (!this.selectedId) {
      return;
    }

    const visibleIds = new Set();
    visibleTickets.forEach((ticket) => {
      visibleIds.add(ticket.id);
      (ticket.children || []).forEach((childRow) => {
        const child = this._norm(childRow);
        if (child.id) {
          visibleIds.add(child.id);
        }
      });
    });

    if (visibleIds.has(this.selectedId)) {
      return;
    }

    this.selectedId = null;
    const pane = this.container.querySelector('#tvDetailPane');
    if (pane) {
      pane.innerHTML = `<div class="ticket-detail-empty">
        <i class="ph ph-funnel"></i>
        <span>Current selection is outside the active filters</span>
      </div>`;
    }
  }

  _rowHTML(ticket, hasChildren = false, expanded = false) {
    const state = this._normalizeWorkflowState(ticket.state);
    const cls = getStatusClass(state);
    const selected = ticket.id === this.selectedId ? ' selected' : '';
    const date = ticket.updatedAt || ticket.createdAt || '';
    const dateStr = date ? timeAgo(date) : '--';

    return `<div class="ticket-row${selected}" data-id="${ticket.id}">
      <div style="display:flex;align-items:center;gap:4px;justify-content:center">
        ${hasChildren ? `<span class="expand-chevron${expanded ? ' expanded' : ''}" style="font-size:10px">▶</span>` : ''}
        <span class="ticket-status-dot ${cls}"></span>
      </div>
      <div class="ticket-subject">
        <div class="ticket-subject-title">${truncate(ticket.name, 60)}${ticket.childCount > 0 ? `<span class="subtask-badge">${ticket.childCount} subtasks</span>` : ''}</div>
        <div class="ticket-subject-meta">${ticket.assignee || 'unassigned'} · #${ticket.sequenceId} · ${this._stateLabel(state)}</div>
      </div>
      <div class="ticket-cost-cell" title="${ticket.cost > 0 ? 'Total cost' : 'No cost metrics available'}">${ticket.cost > 0 ? formatCost(ticket.cost) : '<span style="color:var(--text-muted)">--</span>'}</div>
      <div class="ticket-date-cell">${dateStr}</div>
    </div>`;
  }

  _toggleChildren(parentId) {
    if (this.expandedParents.has(parentId)) this.expandedParents.delete(parentId);
    else this.expandedParents.add(parentId);
    this._renderList();
  }

  _connectActivitySSE(ticketId) {
    this._disconnectActivitySSE();
    try {
      const url = `${this.api.baseURL}/api/v1/tickets/${encodeURIComponent(ticketId)}/activity/stream`;
      this._activitySSE = new EventSource(url);

      this._activitySSE.addEventListener('ticket-activity', (event) => {
        try {
          const entry = JSON.parse(event.data);
          this._appendActivityEntry(entry);
        } catch (e) {
          console.warn('Failed to parse ticket activity SSE event:', e);
        }
      });

      this._activitySSE.addEventListener('connected', () => {
        console.log(`🔴 Live activity feed connected for ticket ${ticketId}`);
        const dot = this.container?.querySelector('#tvLiveDot');
        if (dot) { dot.style.background = '#22c55e'; dot.title = 'Live feed connected'; }
      });

      this._activitySSE.onerror = () => {
        const dot = this.container?.querySelector('#tvLiveDot');
        if (dot) { dot.style.background = '#f59e0b'; dot.title = 'Reconnecting…'; }
      };
    } catch (e) {
      console.warn('Failed to connect ticket activity SSE:', e);
    }
  }

  _disconnectActivitySSE() {
    if (this._activitySSE) {
      this._activitySSE.close();
      this._activitySSE = null;
    }
  }

  _appendActivityEntry(entry) {
    const feed = this.container?.querySelector('.td-feed');
    if (!feed) return;

    const isUser = entry.type === 'user' || entry.role === 'user';
    const icon = isUser ? 'ph-user' : 'ph-robot';
    const color = isUser ? 'var(--accent-secondary, #3b82f6)' : 'var(--accent-primary, #10b981)';
    const text = entry.summary || entry.text || entry.comment || '';
    const actor = isUser ? 'You' : (entry.actor || 'Bot');
    const ts = entry.timestamp || '';
    const timeStr = ts ? 'just now' : '';

    let rendered = text;
    try {
      if (typeof window !== 'undefined' && window.marked && typeof window.marked.parse === 'function') {
        rendered = window.marked.parse(text);
      }
    } catch { /* fallback */ }

    const entryDiv = document.createElement('div');
    entryDiv.className = 'td-feed-entry';
    entryDiv.style.cssText = 'display:flex;gap:10px;margin-bottom:14px;animation:fadeIn 0.3s ease';
    entryDiv.innerHTML = `
      <div style="flex-shrink:0;width:28px;height:28px;border-radius:50%;background:${color}20;display:flex;align-items:center;justify-content:center">
        <i class="ph ${icon}" style="color:${color};font-size:14px"></i>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px">${actor} · ${timeStr}</div>
        <div style="font-size:12px;line-height:1.5;word-wrap:break-word;overflow-wrap:break-word">${rendered}</div>
      </div>`;

    // Pulse the live dot on new entry
    const dot = this.container?.querySelector('#tvLiveDot');
    if (dot) {
      dot.style.background = '#22c55e';
      dot.style.boxShadow = '0 0 0 3px #22c55e40';
      setTimeout(() => { dot.style.boxShadow = ''; }, 600);
    }

    // Insert at the top of the feed (newest first)
    const firstEntry = feed.querySelector('.td-feed-entry');
    if (firstEntry) {
      feed.insertBefore(entryDiv, firstEntry);
    } else {
      feed.prepend(entryDiv);
    }
  }

  async _selectTicket(ticketId) {
    this.selectedId = ticketId;
    this.container.querySelectorAll('.ticket-row').forEach(r => {
      r.classList.toggle('selected', r.dataset.id === ticketId);
    });

    const pane = this.container.querySelector('#tvDetailPane');
    if (!pane) return;
    pane.innerHTML = '<div class="dash-loading"><i class="ph ph-spinner-gap ph-spin" style="font-size:24px;margin-right:8px"></i> Loading...</div>';

    try {
      const resp = await this.api.getTicketActivity(ticketId);
      const payload = resp.data || resp;
      const ticket = payload.ticket || payload;
      if (!ticket || typeof ticket !== 'object' || (!ticket.id && !ticket.ticketId)) {
        throw new Error('Ticket payload missing ticket object');
      }
      const normalizedTicket = this._norm(ticket);
      if (this._normalizeWorkflowState(normalizedTicket.rawStatus || normalizedTicket.state) === 'escalated') {
        normalizedTicket.escalation = await this._loadTicketEscalation(normalizedTicket);
      }
      const timeline = payload.timeline || [];
      const costData = payload.cost || {};
      await this._renderDetail(normalizedTicket, timeline, costData);

      // Connect SSE for real-time updates on this ticket
      this._connectActivitySSE(ticketId);
    } catch (error) {
      this._logWarning('load-ticket-detail-failed', error, { ticketId });
      const t = this._findTicket(ticketId);
      if (t) {
        await this._renderDetail(t, [], {}, {
          degradedNotice: this._buildActionableNotice(
            'warning',
            'Live activity is unavailable right now.',
            'Showing the hierarchy snapshot while the activity service catches up.',
            'tvRetryDetailBtn',
            'Retry detail'
          ),
        });
      } else {
        pane.innerHTML = this._buildActionableEmptyState(
          'warning',
          'Could not load ticket details',
          'Try selecting the ticket again while activity sync catches up.',
          'tvRetryDetailBtn',
          'Retry detail'
        );
        pane.querySelector('#tvRetryDetailBtn')?.addEventListener('click', () => {
          void this._selectTicket(ticketId);
        });
      }
    }
  }

  _findTicket(id) {
    for (const t of this.tickets) {
      if (t.id === id) return this._norm(t);
      for (const c of (t.children || [])) {
        if (c.id === id) return this._norm(c);
      }
    }
    return null;
  }

  _findParentTicket(parentId) {
    if (!parentId) {
      return null;
    }
    return this._findTicket(parentId);
  }

  async _renderDetail(ticket, timeline, costData, options = {}) {
    await renderTicketDetail(this, ticket, timeline, costData, options);
  }

  async _renderTab(tab, ticket, timeline, costData) {
    await renderTicketTab(this, tab, ticket, timeline, costData);
  }

  _setActiveTab(tab, ticket, timeline, costData) {
    const pane = this.container.querySelector('#tvDetailPane');
    pane?.querySelectorAll('.td-tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tab);
    });
    void this._renderTab(tab, ticket, timeline, costData);
  }

  async _moveRootTicketToProject(ticket, controls = {}) {
    const payload = this._buildProjectMovePayload(ticket, controls.customName, controls.selectedProjectId, controls.select);
    if (!payload) {
      this.showToast('Choose an existing project or enter a new project name', 'info');
      return;
    }

    this._setProjectMoveControlState(controls, true);
    try {
      const result = await this.api.moveTicketProject(ticket.id, payload);
      if (controls.input instanceof HTMLInputElement) {
        controls.input.value = '';
      }
      this.projectFilter = result?.project?.projectId || 'all';
      await this.loadTickets();
      await this.focusTicket(ticket.id);
      this.showToast(`Project updated to ${result?.project?.projectName || 'Default'}`, 'success');
    } catch (error) {
      this._logWarning('move-ticket-project-failed', error, { ticketId: ticket.id, payload });
      this.showToast(`Project move failed: ${this._errorMessage(error)}`, 'error');
    } finally {
      this._setProjectMoveControlState(controls, false);
    }
  }

  _focusReplyComposer() {
    const replyArea = this.container.querySelector('#tvFeedReply');
    if (replyArea instanceof HTMLTextAreaElement) {
      replyArea.focus();
      replyArea.setSelectionRange(replyArea.value.length, replyArea.value.length);
    }
  }

  _updateStatusPill(pane, state) {
    const pill = pane.querySelector('.status-pill');
    if (pill) {
      pill.className = `status-pill ${getStatusClass(state.toLowerCase())}`;
      pill.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:var(--radius-pill)';
      pill.textContent = getStatusLabel(state.toLowerCase());
    }
  }

  _syncTicketRecord(ticketId, mutate) {
    for (const ticket of this.tickets) {
      if (ticket.id === ticketId) {
        mutate(ticket);
        return true;
      }
      for (const child of (ticket.children || [])) {
        if (child.id === ticketId) {
          mutate(child);
          return true;
        }
      }
    }
    return false;
  }

  _refreshTicketListSelection() {
    this._renderList();
    this.container.querySelectorAll('.ticket-row').forEach((row) => {
      row.classList.toggle('selected', row.dataset.id === this.selectedId);
    });
  }

  _showToast(message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toast.style.cssText = `background:${type === 'error' ? '#c0392b' : type === 'success' ? '#1f8f5a' : 'rgba(31, 41, 55, 0.96)'};color:#fff;padding:10px 18px;border-radius:8px;margin-top:8px;font-size:14px`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  _buildProjectMovePayload(ticket, customName, selectedProjectId, selectElement) {
    const trimmedCustomName = String(customName || '').trim();
    if (trimmedCustomName) {
      return { projectName: trimmedCustomName };
    }

    const nextProjectId = String(selectedProjectId || '').trim();
    if (!nextProjectId || nextProjectId === String(ticket.projectId || '').trim()) {
      return null;
    }

    const selectedOption = selectElement instanceof HTMLSelectElement
      ? selectElement.selectedOptions?.[0]
      : null;
    return {
      projectId: nextProjectId,
      projectName: selectedOption?.textContent?.trim() || undefined,
    };
  }

  _setProjectMoveControlState(controls, disabled) {
    if (controls.button instanceof HTMLButtonElement) {
      controls.button.disabled = disabled;
    }
    if (controls.input instanceof HTMLInputElement) {
      controls.input.disabled = disabled;
    }
    if (controls.select instanceof HTMLSelectElement) {
      controls.select.disabled = disabled;
    }
  }

  _buildInlineEmptyState(icon, title, detail) { return buildInlineEmptyState(icon, title, detail); }
  _buildDetailEmptyState(icon, title, detail = '') { return buildDetailEmptyState(icon, title, detail); }
  _buildActionableEmptyState(icon, title, detail, buttonId, buttonLabel) { return buildActionableEmptyState(icon, title, detail, buttonId, buttonLabel); }
  _buildActionableNotice(icon, title, detail, buttonId, buttonLabel) { return buildActionableNotice(icon, title, detail, buttonId, buttonLabel); }
  _errorMessage(error) { return extractErrorMessage(error); }

  async _loadTicketEscalation(ticket) {
    const lookupIds = [...new Set([
      String(ticket?.externalId || '').trim(),
      String(ticket?.id || '').trim(),
    ].filter(Boolean))];

    for (const lookupId of lookupIds) {
      try {
        const response = await this.api.getTicketEscalations(lookupId);
        const payload = response?.data || response || {};
        const escalations = Array.isArray(payload.escalations) ? payload.escalations : [];
        if (escalations.length > 0) {
          return { ...escalations[0], lookupId };
        }
      } catch (error) {
        this._logWarning('load-ticket-escalation-failed', error, { ticketId: ticket?.id, lookupId });
      }
    }

    return null;
  }

  _logWarning(event, error, extra = {}) {
    const payload = {
      level: 'warn',
      module: 'cockpit-ticket-view',
      event,
      error: this._errorMessage(error),
      ...extra,
    };
    console.warn(JSON.stringify(payload));
  }

  _confirmDelete(ticket) {
    const backdrop = document.createElement('div');
    backdrop.className = 'delete-confirm-backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'delete-confirm-dialog';
    dialog.innerHTML = `
      <h3><i class="ph ph-warning"></i> Delete Ticket</h3>
      <p>Delete <strong>#${ticket.sequenceId}: ${truncate(ticket.name, 40)}</strong>${ticket.childCount ? ` and all ${ticket.childCount} subtasks` : ''}?<br>This cannot be undone.</p>
      <div class="delete-confirm-actions">
        <button class="cancel-btn">Cancel</button>
        <button class="confirm-delete-btn">Delete</button>
      </div>`;
    document.body.appendChild(backdrop);
    document.body.appendChild(dialog);

    const close = () => { backdrop.remove(); dialog.remove(); };
    backdrop.addEventListener('click', close);
    dialog.querySelector('.cancel-btn').addEventListener('click', close);
    dialog.querySelector('.confirm-delete-btn').addEventListener('click', async () => {
      close();
      this.selectedId = null;
      if (typeof ticket.onDelete === 'function') {
        await ticket.onDelete();
        return;
      }

      try {
        await this.api.delete(`/api/v1/tickets/${encodeURIComponent(ticket.id)}`);
        await this.loadTickets();
        const pane = this.container.querySelector('#tvDetailPane');
        if (pane) {
          pane.innerHTML = '<div class="ticket-detail-empty"><i class="ph ph-envelope-open"></i><span>Ticket deleted</span></div>';
        }
        this.showToast('Ticket deleted', 'success');
      } catch (e) {
        this._logWarning('delete-ticket-fallback-failed', e, { ticketId: ticket.id });
        this.showToast(`Delete failed: ${this._errorMessage(e)}`, 'error');
      }
    });
  }

  /** @description Opens the extracted create-ticket modal and refreshes the ticket list on success. */
  _openCreateTicketModal() {
    openCreateTicketModal(() => { void this.loadTickets(); });
  }

  /** @description Opens the extracted project-manager modal and refreshes the ticket list on success. */
  _openProjectManagerModal() {
    openProjectManagerModal(() => { void this.loadTickets(); });
  }
}

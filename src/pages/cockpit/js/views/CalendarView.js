/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Hardened cockpit calendar schedule actions with live API feedback, bot-filter usability, and real-data day detail behavior for the button audit
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Corrected cockpit calendar schedule payload and rendering to the real legacy-compatible scheduling contract (`taskType`, `schedule`, `taskData`)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added live scheduler-capability gating so schedule creation explains when no bots currently expose the Agent Scheduler tool
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Wired calendar ticket drill-ins into the ticket workbench and upgraded bot-facing labels from raw ids to operator-friendly captions
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Normalized calendar bot alias matching and work-item-backed assignee filtering so Address Book handoff and ticket events stay visible in the cockpit calendar
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Session 20: Redesigned schedule dialog as Outlook-style meeting form — date/time/recurrence pickers, auto-generated cron, meeting cards in day detail
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Scoped calendar to the active app's queue — schedules (?taskType) and tickets (?type) now filter to the focused ?app= manifest's ticketType
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Fix the create path, dead since the Outlook redesign: _hasEnabledSchedulerTool matched the tool UUID against the string "agent-scheduler" (never true → create button permanently disabled) — now matches the tool NAME and requires AUTO (the mode the runtime dispatch gate requires). Also fix the date→cron off-by-one: `new Date("YYYY-MM-DD")` parsed UTC then read local, shifting the day back one in negative-UTC zones ("Tuesday" → Monday); _localDate builds from parts. And mark a "once" recurrence as a real one-shot (once:true) with the browser's timezone, so it fires at the user's clock and pauses after firing instead of recurring annually.
 */

import { ApiClient } from '../api-client.js';
import { timeAgo, truncate } from '../utils/formatters.js';

/**
 * @description Monthly cockpit calendar showing live schedule and ticket activity with
 * schedule creation, trigger, delete, and drill-in actions.
 */
export class CalendarView {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.api = new ApiClient();
    this.currentDate = new Date();
    this.selectedDate = null;
    this.schedules = [];
    this.tickets = [];
    this.agents = [];
    this.agentIdentityIndex = new Map();
    this.schedulerReadyAgents = [];
    this.botFilter = 'all';
    this.onNavigateToTicket = options.onNavigateToTicket || null;
    this.showToast = options.onToast || ((message, type) => this._showToast(message, type));
  }

  async render() {
    if (!this.container) return;
    this.container.innerHTML = '<div class="calendar-view" id="calViewRoot"></div>';
    await this._loadData();
    this._renderFull();
  }

  async _loadData() {
    // Scope both data sources to the focused app's queue so the calendar shows
    // this view's events only (e.g. ?app=home → home-control). Null when no app
    // is focused → unscoped framework-default calendar.
    const queue = await this._resolveActiveQueue();
    const scheduleUrl = queue
      ? `/api/v1/agent/schedules?taskType=${encodeURIComponent(queue)}`
      : '/api/v1/agent/schedules';
    const ticketUrl = queue
      ? `/api/v1/tickets/hierarchy?type=${encodeURIComponent(queue)}`
      : '/api/v1/tickets/hierarchy';
    const [scheduleResult, ticketResult, agentResult] = await Promise.allSettled([
      this.api.getSafe(scheduleUrl, { schedules: [] }),
      this.api.getSafe(ticketUrl, { data: [] }),
      this.api.getAgents(),
    ]);

    this.schedules = this._readCollection(scheduleResult, 'schedules');
    this.tickets = this._readCollection(ticketResult, 'tickets');
    this.agents = this._readCollection(agentResult, 'agents');

    // When NOT focused on a single app, scope the framework-default calendar to the
    // queues of the LOADED apps (the taskbar's tools) — so it shows only loaded-tool
    // tasks, not the entire fleet. A focused ?app= view is already single-queue above.
    if (!queue) {
      const loaded = await this._resolveLoadedQueueIds();
      if (loaded && loaded.size) {
        this.schedules = this.schedules.filter((s) => loaded.has(s.queue));
        this.tickets = this.tickets.filter((t) => loaded.has(t.queueId));
      }
    }

    this._rebuildAgentIdentityIndex();
    await this._loadSchedulerReadyAgents();
  }

  /**
   * @description Resolves the set of queue ids for the currently LOADED apps
   * (active swarm-apps). An app IS a queue (queueId === name). Used to scope the
   * framework-default calendar to loaded tools only.
   * @returns {Promise<Set<string>>} Loaded app queue ids (empty on failure).
   */
  async _resolveLoadedQueueIds() {
    try {
      const resp = await this.api.getSafe('/api/swarm/apps?status=active', { apps: [] });
      return new Set((resp?.apps || []).map((a) => a && a.queueId).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  /**
   * @description Resolve the active app's queue (ticketType) for filtering.
   * Reads ?app= / ?profile= from the URL and returns the manifest's ticketType,
   * which is also the schedule taskType for that app (e.g. home → home-control).
   * Returns null when no app is focused — the calendar then loads unscoped.
   * @returns {Promise<string|null>} The active queue name, or null.
   */
  async _resolveActiveQueue() {
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

  _readCollection(result, label) {
    if (result.status === 'fulfilled') {
      const value = result.value || {};
      if (label === 'schedules') return value.schedules || value.data || [];
      if (label === 'tickets') return value.data || value.tickets || [];
      if (label === 'agents') return value.agents || value || [];
    }

    this._logError('load-data', result.reason || new Error(`Failed to load ${label}`), { label });
    return [];
  }

  async _loadSchedulerReadyAgents() {
    const toolResults = await Promise.allSettled(
      this.agents.map((agent) => this.api.getAgentTools(this._agentIdentifier(agent))),
    );

    this.schedulerReadyAgents = this.agents.filter((agent, index) => {
      const result = toolResults[index];
      if (result.status !== 'fulfilled') {
        this._logError('load-agent-tools', result.reason || new Error('Failed to load agent tools'), {
          agentId: this._agentIdentifier(agent),
        });
        return false;
      }
      return this._hasEnabledSchedulerTool(result.value);
    });
  }

  _hasEnabledSchedulerTool(payload) {
    const tools = payload.tools || payload || [];
    // Match on the tool NAME, not `toolId`/`id` — those are UUIDs, so the old comparison against the
    // string 'agent-scheduler' never matched and the create path was permanently disabled. The name
    // lives on `tool.name` (and, in the nested shape, `tool.tool.name`).
    const scheduler = tools.find((tool) => {
      const name = tool && (tool.name || (tool.tool && tool.tool.name));
      return name === 'agent-scheduler';
    });
    if (!scheduler) return false;
    // Enablement is an auth MODE, not a boolean. The runtime dispatch gate requires exactly AUTO
    // (an ASK grant is not sufficient there), so a bot is only "scheduler-ready" for the calendar
    // when it is AUTO — otherwise the user could create a schedule the runner then refuses to fire.
    const mode = scheduler.authMode || (scheduler.tool && scheduler.tool.authMode) || 'off';
    return mode === 'auto';
  }

  _renderFull() {
    const root = this.container.querySelector('#calViewRoot');
    if (!root) return;

    root.innerHTML = `${this._renderToolbar()}<div class="cal-grid-container">
      ${this._renderWeekdayHeader()}
      <div class="cal-grid" id="calGrid"></div>
      <div id="calDayDetail"></div>
    </div>`;

    this._syncBotFilterSelection();
    this._renderGrid();
    this._bindEvents();
  }

  _renderToolbar() {
    const monthName = this.currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });
    return `<div class="cal-toolbar">
      <div class="cal-nav">
        <button class="cal-nav-btn" id="calPrev"><i class="ph ph-caret-left"></i></button>
        <span class="cal-month-label">${monthName}</span>
        <button class="cal-nav-btn" id="calNext"><i class="ph ph-caret-right"></i></button>
      </div>
      <div class="cal-filters">
        <select class="cal-bot-filter" id="calBotFilter">
          <option value="all">All Bots</option>
          ${this.agents.map((agent) => this._renderAgentOption(agent)).join('')}
        </select>
        <button class="cal-add-btn" id="calAddSchedule"><i class="ph ph-plus"></i> Schedule</button>
      </div>
    </div>`;
  }

  _renderWeekdayHeader() {
    return `<div class="cal-weekday-header">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<div class="cal-weekday">${day}</div>`).join('')}
    </div>`;
  }

  _syncBotFilterSelection() {
    const filter = this.container.querySelector('#calBotFilter');
    if (!filter) return;

    const hasSelectedBot = this.botFilter === 'all'
      || Array.from(filter.options).some((option) => option.value === this.botFilter);

    if (!hasSelectedBot) {
      this.botFilter = 'all';
    }

    filter.value = this.botFilter;
  }

  _renderGrid() {
    const grid = this.container.querySelector('#calGrid');
    if (!grid) return;

    const year = this.currentDate.getFullYear();
    const month = this.currentDate.getMonth();
    const leading = this._renderLeadingPadding(year, month);
    const current = this._renderCurrentMonthDays(year, month);
    const trailing = this._renderTrailingPadding(year, month);

    grid.innerHTML = `${leading}${current}${trailing}`;
    this._bindDayClicks(grid);
  }

  _renderLeadingPadding(year, month) {
    const firstDay = new Date(year, month, 1).getDay();
    const previousMonthDays = new Date(year, month, 0).getDate();
    return Array.from({ length: firstDay }, (_unused, index) => previousMonthDays - firstDay + index + 1)
      .map((day) => `<div class="cal-day other-month"><div class="cal-day-number">${day}</div></div>`)
      .join('');
  }

  _renderCurrentMonthDays(year, month) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: daysInMonth }, (_unused, index) => index + 1)
      .map((day) => this._renderDayCell(year, month, day))
      .join('');
  }

  _renderTrailingPadding(year, month) {
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const totalCells = firstDay + daysInMonth;
    const trailingCount = (7 - (totalCells % 7)) % 7;

    return Array.from({ length: trailingCount }, (_unused, index) => index + 1)
      .map((day) => `<div class="cal-day other-month"><div class="cal-day-number">${day}</div></div>`)
      .join('');
  }

  _renderDayCell(year, month, day) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const todayClass = dateStr === this._todayStr() ? ' today' : '';
    const selectedClass = this.selectedDate === dateStr ? ' selected' : '';
    const events = this._getEventsForDate(dateStr);

    return `<div class="cal-day${todayClass}${selectedClass}" data-date="${dateStr}">
      <div class="cal-day-number">${day}</div>
      <div class="cal-events">
        ${events.slice(0, 3).map((event) => this._renderEventDot(event)).join('')}
        ${events.length > 3 ? `<div class="cal-more-events">+${events.length - 3} more</div>` : ''}
      </div>
    </div>`;
  }

  _renderEventDot(event) {
    return `<div class="cal-event-dot" title="${event.name}">
      <span class="dot ${event.type}"></span>
      <span>${truncate(event.name, 12)}</span>
    </div>`;
  }

  _bindDayClicks(grid) {
    grid.querySelectorAll('.cal-day:not(.other-month)').forEach((day) => {
      day.addEventListener('click', () => {
        const date = day.dataset.date;
        this.selectedDate = this.selectedDate === date ? null : date;
        grid.querySelectorAll('.cal-day').forEach((candidate) => candidate.classList.remove('selected'));
        if (!this.selectedDate) return this._clearDayDetail();
        day.classList.add('selected');
        this._showDayDetail(date);
      });
    });
  }

  _clearDayDetail() {
    const detail = this.container.querySelector('#calDayDetail');
    if (detail) detail.innerHTML = '';
  }

  _getEventsForDate(dateStr) {
    const scheduleEvents = this.schedules
      .filter((schedule) => this._scheduleOccursOnDate(schedule, dateStr))
      .map((schedule) => this._toScheduleEvent(schedule));
    const ticketEvents = this.tickets
      .filter((ticket) => this._ticketOccursOnDate(ticket, dateStr))
      .map((ticket) => this._toTicketEvent(ticket));
    return [...scheduleEvents, ...ticketEvents];
  }

  _scheduleOccursOnDate(schedule, dateStr) {
    const created = this._readDatePrefix(schedule.createdAt || schedule.created_at);
    const scheduleBot = this._readScheduleBotCandidate(schedule);
    const activeToday = schedule.status === 'active' && dateStr === this._todayStr();
    if (!this._matchesBotFilter(scheduleBot)) return false;
    return created === dateStr || activeToday;
  }

  _ticketOccursOnDate(ticket, dateStr) {
    const created = this._readDatePrefix(ticket.created_at || ticket.createdAt);
    const updated = this._readDatePrefix(ticket.updated_at || ticket.updatedAt);
    if (!this._matchesBotFilter(this._readTicketBotCandidate(ticket))) return false;
    return created === dateStr || updated === dateStr;
  }

  _matchesBotFilter(candidate) {
    if (this.botFilter === 'all') {
      return true;
    }

    const selectedAliases = this._resolveAgentAliases(this.botFilter);
    const candidateAliases = this._resolveAgentAliases(candidate);
    if (!selectedAliases.size || !candidateAliases.size) {
      return false;
    }

    return Array.from(candidateAliases).some((alias) => selectedAliases.has(alias));
  }

  _toScheduleEvent(schedule) {
    return {
      id: schedule.id,
      name: schedule.taskData?.prompt || schedule.taskDescription || schedule.name || schedule.taskType || 'Scheduled Task',
      type: 'schedule',
      data: schedule,
    };
  }

  _toTicketEvent(ticket) {
    const state = this._readString(ticket.state_name || ticket.state).toLowerCase();
    let type = 'active';
    if (state.includes('done') || state.includes('delivered')) type = 'completed';
    if (state.includes('cancelled') || state.includes('fail')) type = 'failed';
    return {
      id: ticket.id || ticket.ticketId,
      name: ticket.name || ticket.title || 'Untitled ticket',
      type,
      data: ticket,
    };
  }

  _todayStr() {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }

  _showDayDetail(dateStr) {
    const detail = this.container.querySelector('#calDayDetail');
    if (!detail) return;

    const events = this._getEventsForDate(dateStr);
    detail.innerHTML = this._renderDayDetail(dateStr, events);
    this._bindDayDetailActions(detail, dateStr);
  }

  _renderDayDetail(dateStr, events) {
    const formatted = new Date(`${dateStr}T12:00:00`).toLocaleDateString('default', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

    return `<div class="cal-day-detail">
      <div class="cal-day-detail-header">
        <div class="cal-day-detail-title">${formatted}</div>
        <button class="cal-day-detail-close" id="calCloseDetail"><i class="ph ph-x"></i></button>
      </div>
      ${events.length ? events.map((event) => this._renderDayEvent(event)).join('') : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No events on this date</p>'}
    </div>`;
  }

  _renderDayEvent(event) {
    const actionButtons = event.type === 'schedule'
      ? `<button class="cal-event-action-btn" title="Trigger now" data-action="trigger" data-id="${event.id}"><i class="ph ph-play"></i></button>
         <button class="cal-event-action-btn danger" title="Delete" data-action="delete-schedule" data-id="${event.id}"><i class="ph ph-trash"></i></button>`
      : event.data?.ticketId || event.data?.id
        ? `<button class="cal-event-action-btn" title="Open ticket" data-action="open-ticket" data-id="${event.data.ticketId || event.data.id}"><i class="ph ph-arrow-square-out"></i></button>`
        : '';

    if (event.type === 'schedule') {
      return this._renderScheduleMeetingCard(event, actionButtons);
    }

    const icon = event.type === 'completed' ? 'ph-check-circle'
      : event.type === 'failed' ? 'ph-x-circle' : 'ph-spinner-gap';

    return `<div class="cal-event-item" data-event-id="${event.id}" data-event-type="${event.type}">
      <div class="cal-event-icon ${event.type}"><i class="ph ${icon}"></i></div>
      <div class="cal-event-info">
        <div class="cal-event-name">${event.name}</div>
        <div class="cal-event-time">${timeAgo(event.data.updated_at || event.data.created_at)}</div>
      </div>
      <div class="cal-event-actions">${actionButtons}</div>
    </div>`;
  }

  _renderScheduleMeetingCard(event, actionButtons) {
    const data = event.data || {};
    const taskData = data.taskData || {};
    const title = taskData.title || taskData.prompt || event.name;
    const time = taskData.scheduledTime || this._cronToTimeLabel(data.cron || data.schedule);
    const recurrence = this._recurrenceLabel(taskData.recurrence, data.cron || data.schedule);
    const botName = this._resolveAgentDisplayName(taskData.targetAgent || data.agentId);
    const cronExpr = data.cron || data.schedule || '';

    return `<div class="cal-meeting-card" data-event-id="${event.id}" data-event-type="schedule">
      <div class="cal-meeting-stripe"></div>
      <div class="cal-meeting-body">
        <div class="cal-meeting-header">
          <div class="cal-meeting-title">${title}</div>
          <div class="cal-event-actions">${actionButtons}</div>
        </div>
        <div class="cal-meeting-meta">
          <span><i class="ph ph-clock"></i> ${time}</span>
          <span><i class="ph ph-repeat"></i> ${recurrence}</span>
          <span><i class="ph ph-robot"></i> ${botName}</span>
        </div>
        ${taskData.prompt && taskData.prompt !== title ? `<div class="cal-meeting-desc">${truncate(taskData.prompt, 120)}</div>` : ''}
        <div class="cal-meeting-cron" title="Cron expression"><i class="ph ph-terminal"></i> ${cronExpr}</div>
      </div>
    </div>`;
  }

  _cronToTimeLabel(cron) {
    if (!cron) return '';
    const parts = cron.split(/\s+/);
    if (parts.length < 2) return cron;
    const min = parts[0].padStart(2, '0');
    const hr = parts[1].padStart(2, '0');
    if (isNaN(Number(hr)) || isNaN(Number(min))) return cron;
    const hour12 = Number(hr) % 12 || 12;
    const ampm = Number(hr) >= 12 ? 'PM' : 'AM';
    return `${hour12}:${min} ${ampm}`;
  }

  _recurrenceLabel(recurrence, cron) {
    if (recurrence === 'once') return 'One-time';
    if (recurrence === 'daily') return 'Daily';
    if (recurrence === 'weekdays') return 'Weekdays';
    if (recurrence === 'weekly') return 'Weekly';
    if (recurrence === 'monthly') return 'Monthly';
    if (!cron) return 'Recurring';
    const parts = cron.split(/\s+/);
    if (parts[4] === '1-5') return 'Weekdays';
    if (parts[2] !== '*' && parts[3] !== '*') return 'One-time';
    if (parts[4] !== '*') return 'Weekly';
    if (parts[2] !== '*') return 'Monthly';
    return 'Daily';
  }

  _resolveAgentDisplayName(agentId) {
    if (!agentId) return 'Any bot';
    const agent = this.agents.find((a) =>
      (a.agentId || a.agent_id || a.name) === agentId
      || (a.name) === agentId,
    );
    return agent ? (agent.displayName || agent.name || agentId) : agentId;
  }

  _bindDayDetailActions(detail, dateStr) {
    detail.querySelector('#calCloseDetail')?.addEventListener('click', () => {
      this.selectedDate = null;
      this.container.querySelectorAll('.cal-day').forEach((day) => day.classList.remove('selected'));
      this._clearDayDetail();
    });

    detail.querySelectorAll('.cal-event-action-btn').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        await this._handleDayAction(dateStr, button.dataset.action, button.dataset.id);
      });
    });
  }

  async _handleDayAction(dateStr, action, id) {
    if (action === 'open-ticket') {
      if (this.onNavigateToTicket) {
        this.onNavigateToTicket(id);
        return;
      }
      this.showToast('Ticket handoff is unavailable right now', 'error');
      return;
    }

    try {
      if (action === 'trigger') await this._triggerSchedule(id);
      if (action === 'delete-schedule') await this._deleteSchedule(id, dateStr);
    } catch (error) {
      this._logError('day-action', error, { action, id, dateStr });
      this.showToast(`Calendar action failed: ${this._errorMessage(error)}`, 'error');
    }
  }

  async _triggerSchedule(id) {
    await this.api.post(`/api/v1/agent/schedules/${encodeURIComponent(id)}/trigger`, {});
    this.showToast('Schedule triggered', 'success');
  }

  async _deleteSchedule(id, dateStr) {
    await this.api.delete(`/api/v1/agent/schedules/${encodeURIComponent(id)}`);
    this.schedules = this.schedules.filter((schedule) => schedule.id !== id);
    this._renderGrid();
    this._showDayDetail(dateStr);
    this.showToast('Schedule deleted', 'success');
  }

  _bindEvents() {
    this.container.querySelector('#calPrev')?.addEventListener('click', () => this._shiftMonth(-1));
    this.container.querySelector('#calNext')?.addEventListener('click', () => this._shiftMonth(1));
    this.container.querySelector('#calBotFilter')?.addEventListener('change', (event) => {
      this.botFilter = event.target.value;
      this._renderGrid();
      if (this.selectedDate) this._showDayDetail(this.selectedDate);
    });
    this.container.querySelector('#calAddSchedule')?.addEventListener('click', () => this._showScheduleDialog());
  }

  _shiftMonth(offset) {
    this.currentDate.setMonth(this.currentDate.getMonth() + offset);
    this.selectedDate = null;
    this._renderFull();
  }

  _showScheduleDialog() {
    const backdrop = document.createElement('div');
    const dialog = document.createElement('div');

    backdrop.className = 'delete-confirm-backdrop';
    dialog.className = 'cal-schedule-dialog';
    dialog.innerHTML = this._renderScheduleDialog();
    document.body.appendChild(backdrop);
    document.body.appendChild(dialog);

    const close = () => {
      backdrop.remove();
      dialog.remove();
    };

    backdrop.addEventListener('click', close);
    dialog.querySelector('#calDialogClose')?.addEventListener('click', close);
    dialog.querySelector('#schedCancel')?.addEventListener('click', close);
    dialog.querySelector('#schedCreate')?.addEventListener('click', async () => {
      await this._createSchedule(dialog, close);
    });
    this._bindScheduleDialogEvents(dialog);
  }

  _renderScheduleDialog() {
    const schedulerAgents = this.schedulerReadyAgents.length ? this.schedulerReadyAgents : this.agents;
    const canCreateSchedules = this.schedulerReadyAgents.length > 0;
    const today = new Date();
    const dateDefault = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const timeDefault = `${String(today.getHours()).padStart(2, '0')}:${String(Math.ceil(today.getMinutes() / 15) * 15 % 60).padStart(2, '0')}`;

    return `<div class="cal-schedule-dialog-header">
      <h3><i class="ph ph-calendar-plus"></i> New Meeting</h3>
      <button class="cal-day-detail-close" id="calDialogClose"><i class="ph ph-x"></i></button>
    </div>
    <div class="cal-schedule-dialog-body">
      <div class="cal-form-group">
        <label>Title</label>
        <input type="text" id="schedTitle" placeholder="e.g. Daily standup report, Weekly code review...">
      </div>
      <div class="cal-form-row">
        <div class="cal-form-group cal-form-half">
          <label>Date</label>
          <input type="date" id="schedDate" value="${dateDefault}">
        </div>
        <div class="cal-form-group cal-form-half">
          <label>Time</label>
          <input type="time" id="schedTime" value="${timeDefault}" step="900">
        </div>
      </div>
      <div class="cal-form-group">
        <label>Recurrence</label>
        <select id="schedRecurrence">
          <option value="once">Once (one-time task)</option>
          <option value="daily">Every day</option>
          <option value="weekdays" selected>Weekdays (Mon\u2013Fri)</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="custom">Custom cron...</option>
        </select>
      </div>
      <div class="cal-form-group" id="schedCronGroup" style="display:none">
        <label>Cron Expression</label>
        <input type="text" id="schedCron" placeholder="0 9 * * 1-5">
        <span style="font-size:11px;color:var(--text-muted)">Format: minute hour day-of-month month day-of-week</span>
      </div>
      <div class="cal-form-group">
        <label>Assign To</label>
        <select id="schedBot" ${canCreateSchedules ? '' : 'disabled'}>
          ${schedulerAgents.map((agent) => this._renderAgentOption(agent)).join('')}
        </select>
        ${canCreateSchedules ? '' : '<span style="font-size:12px;color:var(--text-muted)">No bots have Agent Scheduler enabled. Turn it on in Switch Framework first.</span>'}
      </div>
      <div class="cal-form-group">
        <label>Description</label>
        <textarea id="schedDesc" placeholder="What should this bot do? Be specific \u2014 this becomes the prompt."></textarea>
      </div>
      <div class="cal-meeting-preview" id="schedPreview">
        <div class="cal-meeting-preview-label">Generated Schedule</div>
        <code id="schedCronPreview">0 ${timeDefault.split(':')[0]} * * 1-5</code>
      </div>
    </div>
    <div class="cal-schedule-dialog-footer">
      <button class="cal-dialog-btn secondary" id="schedCancel">Cancel</button>
      <button class="cal-dialog-btn primary" id="schedCreate" ${canCreateSchedules ? '' : 'disabled'}><i class="ph ph-check"></i> Create</button>
    </div>`;
  }

  _bindScheduleDialogEvents(dialog) {
    const recurrenceSelect = dialog.querySelector('#schedRecurrence');
    const cronGroup = dialog.querySelector('#schedCronGroup');
    const dateInput = dialog.querySelector('#schedDate');
    const timeInput = dialog.querySelector('#schedTime');
    const cronPreview = dialog.querySelector('#schedCronPreview');

    const updatePreview = () => {
      const cron = this._buildCronFromDialog(dialog);
      if (cronPreview) cronPreview.textContent = cron;
    };

    recurrenceSelect?.addEventListener('change', () => {
      cronGroup.style.display = recurrenceSelect.value === 'custom' ? '' : 'none';
      updatePreview();
    });
    dateInput?.addEventListener('change', updatePreview);
    timeInput?.addEventListener('change', updatePreview);
    dialog.querySelector('#schedCron')?.addEventListener('input', updatePreview);
    updatePreview();
  }

  _buildCronFromDialog(dialog) {
    const recurrence = dialog.querySelector('#schedRecurrence')?.value || 'weekdays';
    if (recurrence === 'custom') {
      return dialog.querySelector('#schedCron')?.value?.trim() || '* * * * *';
    }
    const time = dialog.querySelector('#schedTime')?.value || '09:00';
    const date = dialog.querySelector('#schedDate')?.value || '';
    const [hour, minute] = time.split(':').map(Number);
    const min = minute || 0;
    const hr = hour || 9;

    if (recurrence === 'once' && date) {
      const d = this._localDate(date);
      return `${min} ${hr} ${d.getDate()} ${d.getMonth() + 1} *`;
    }
    if (recurrence === 'daily') return `${min} ${hr} * * *`;
    if (recurrence === 'weekdays') return `${min} ${hr} * * 1-5`;
    if (recurrence === 'weekly') {
      const d = date ? this._localDate(date) : new Date();
      return `${min} ${hr} * * ${d.getDay()}`;
    }
    if (recurrence === 'monthly') {
      const d = date ? this._localDate(date) : new Date();
      return `${min} ${hr} ${d.getDate()} * *`;
    }
    return `${min} ${hr} * * 1-5`;
  }

  /**
   * @description Parses a `<input type="date">` value ("YYYY-MM-DD") as a LOCAL calendar date.
   * `new Date("2026-08-11")` parses as UTC midnight, and then getDate()/getDay()/getMonth() read in
   * local time — so in any negative-UTC-offset zone the day shifts back one ("Tuesday" -> Monday).
   * Building from the parts avoids the round-trip entirely.
   * @param {string} value - A "YYYY-MM-DD" date input value.
   * @returns {Date} A Date at local midnight on that calendar day.
   */
  _localDate(value) {
    const [y, m, d] = String(value).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  async _createSchedule(dialog, close) {
    if (!this.schedulerReadyAgents.length) {
      this.showToast('Enable Agent Scheduler for at least one bot before creating a schedule', 'info');
      return;
    }

    const bot = dialog.querySelector('#schedBot')?.value;
    const title = dialog.querySelector('#schedTitle')?.value?.trim();
    const desc = dialog.querySelector('#schedDesc')?.value?.trim();
    const cron = this._buildCronFromDialog(dialog);

    if (!title && !desc) {
      this.showToast('Give this meeting a title or description', 'error');
      return;
    }

    const prompt = desc ? `${title ? title + ': ' : ''}${desc}` : title;

    try {
      await this.api.post('/api/v1/agent/schedule-task', {
        taskType: this._buildTaskType(bot, title || desc),
        schedule: cron,
        // A "once" recurrence is a genuine one-shot: mark it so the runner pauses it after it fires
        // instead of letting the year-less cron recur annually. The browser's own timezone is the
        // user's actual zone, so "9:00" on the calendar fires at their 9:00, not the container's.
        once: (dialog.querySelector('#schedRecurrence')?.value || 'once') === 'once',
        timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || undefined,
        taskData: {
          prompt,
          targetAgent: bot,
          title: title || desc,
          recurrence: dialog.querySelector('#schedRecurrence')?.value || 'once',
          scheduledDate: dialog.querySelector('#schedDate')?.value || '',
          scheduledTime: dialog.querySelector('#schedTime')?.value || '',
        },
      });
      close();
      await this._loadData();
      this.selectedDate = this._todayStr();
      this._renderFull();
      this._showDayDetail(this.selectedDate);
      this.showToast('Schedule created', 'success');
    } catch (error) {
      this._logError('create-schedule', error, { bot, cronExpression: cron });
      this.showToast(`Schedule creation failed: ${this._errorMessage(error)}`, 'error');
    }
  }

  destroy() {
    if (this.container) this.container.innerHTML = '';
  }

  /** @description Reads all available identifiers for a schedule bot candidate. */
  _readScheduleBotCandidate(schedule) {
    return {
      agentId: schedule.taskData?.targetAgent || schedule.agentId || schedule.agent_id || schedule.botId || null,
      agentName: schedule.agentName || schedule.name || null,
    };
  }

  /** @description Reads all available identifiers for a ticket assignee candidate. */
  _readTicketBotCandidate(ticket) {
    return {
      agentId: ticket.assignedAgentId || ticket.agentId || ticket.agent_id || null,
      agentName: ticket.assignee_name || ticket.assigneeName || ticket.assignee || null,
    };
  }

  /** @description Rebuilds a lookup that maps agent ids, names, and aliases to one another. */
  _rebuildAgentIdentityIndex() {
    const index = new Map();

    this.agents.forEach((agent) => {
      const aliases = this._readAgentAliases(agent);
      aliases.forEach((alias) => {
        if (!index.has(alias)) {
          index.set(alias, new Set());
        }
        aliases.forEach((value) => index.get(alias).add(value));
      });
    });

    this.agentIdentityIndex = index;
  }

  /** @description Returns normalized aliases for an agent row used by the calendar filter. */
  _readAgentAliases(agent) {
    const rawAliases = [
      agent?.agentId,
      agent?.agent_id,
      agent?.name,
      agent?.displayName,
      agent?.agentName,
      ...(Array.isArray(agent?.aliases) ? agent.aliases : []),
    ];

    return Array.from(new Set(
      rawAliases
        .map((value) => this._normalizeAgentIdentity(value))
        .filter(Boolean),
    ));
  }

  /** @description Resolves all known aliases for a selected filter value or event candidate. */
  _resolveAgentAliases(candidate) {
    const aliases = new Set();
    const values = this._readCandidateValues(candidate);

    values.forEach((value) => {
      aliases.add(value);
      const relatedAliases = this.agentIdentityIndex.get(value);
      if (!relatedAliases) return;
      relatedAliases.forEach((alias) => aliases.add(alias));
    });

    return aliases;
  }

  /** @description Normalizes the string values used for calendar bot matching. */
  _normalizeAgentIdentity(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  /** @description Collects normalized filterable values from a scalar or object candidate. */
  _readCandidateValues(candidate) {
    if (!candidate || typeof candidate !== 'object') {
      const normalized = this._normalizeAgentIdentity(candidate);
      return normalized ? [normalized] : [];
    }

    const objectCandidate = candidate;
    const rawValues = [
      objectCandidate.agentId,
      objectCandidate.agent_id,
      objectCandidate.agentName,
      objectCandidate.assignee,
      objectCandidate.assignee_name,
      objectCandidate.name,
      ...(Array.isArray(objectCandidate.aliases) ? objectCandidate.aliases : []),
    ];

    return Array.from(new Set(
      rawValues
        .map((value) => this._normalizeAgentIdentity(value))
        .filter(Boolean),
    ));
  }

  _agentIdentifier(agent) {
    return agent.agent_id || agent.agentId || agent.name || 'unknown-agent';
  }

  _agentLabel(agent) {
    const id = this._agentIdentifier(agent);
    const label = this._readString(
      agent.displayName || agent.agentName || agent.name || agent.label || agent.role || '',
    );
    if (!label || label === id) {
      return id;
    }
    return `${label} (${id})`;
  }

  _renderAgentOption(agent) {
    const id = this._agentIdentifier(agent);
    return `<option value="${id}">${this._agentLabel(agent)}</option>`;
  }

  _buildTaskType(botId, description) {
    const seed = `${botId || 'bot'}-${description || 'scheduled-task'}-${Date.now()}`;
    return seed.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || `scheduled-task-${Date.now()}`;
  }

  _readDatePrefix(value) {
    const dateValue = this._readString(value);
    if (!dateValue) return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(dateValue)) return dateValue.slice(0, 10);
    const normalized = new Date(dateValue);
    if (Number.isNaN(normalized.getTime())) return '';
    return normalized.toISOString().slice(0, 10);
  }

  _showToast(message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  _logError(action, error, context = {}) {
    const payload = {
      level: 'error',
      module: 'cockpit-calendar-view',
      action,
      ...context,
      message: this._errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    console.error(JSON.stringify(payload));
  }

  _errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  _readString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }
}

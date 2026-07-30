/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the Redis scheduler CRUD of the chat config modal — the report, the bot selectors, the job editor, the job list, draft validation, save, the per-job actions, and their event bindings — out of chat-config-modal.mjs to bring that file back under the 1000-code-line cap. It is a self-contained feature: the modal only calls its renderers and its load/sync entry points.
 */

// Bodies below were MOVED verbatim out of chat-config-modal.mjs, including their original
// four-space indentation: the source file kept that indentation at module top level (a leftover
// from an IIFE removed long ago), and re-indenting would rewrite whitespace inside the HTML
// template literals. Exports are declared in one `export { ... }` list at the end so no moved
// line changed at all.

import { getEffectiveAuthMode } from '/chat-assets/chat-tool-switch-utils.mjs';
import { escapeHtml, requestJson } from '/chat-assets/chat-workspace-popups-utils.mjs';
import {
  ALL_AGENTS_FILTER,
  DEFAULT_CHAT_AGENT_ID,
  DEFAULT_CHAT_AGENT_NAME,
  clearModalStatus,
  elements,
  getActiveAgentId,
  readNonEmptyString,
  setModalStatus,
  uiState,
} from '/chat-assets/chat-config-modal-state.mjs';

function hasLegacySchedulerEditor() {
  return Boolean(
    elements.scheduleTaskTypeInput
    && elements.scheduleTargetAgentSelect
    && elements.scheduleCronInput
    && elements.schedulePromptInput
    && elements.scheduleActionInput
    && elements.scheduleWorkspaceSlugInput
    && elements.schedulerEditorSummary
    && elements.saveScheduleBtn
    && elements.cancelScheduleEditBtn,
  );
}

/**
 * @description Re-render the scheduler report cards and summary for the current bot scope.
 * @returns {void}
 */
    function renderSchedulerReport() {
      if (!elements.schedulerReportCards || !elements.schedulerReportSummary) {
        return;
      }

      renderSchedulerAgentSelectors();
      const filteredSchedules = getFilteredSchedules();
      const report = buildSchedulerReport(
        uiState.schedulerStatus,
        filteredSchedules,
        getSelectedSchedulerToolMode(),
      );
      uiState.schedulerReport = report;

      if (!report || report.error) {
        elements.schedulerReportCards.innerHTML = '<div class="muted-empty">Redis scheduler report is not available yet.</div>';
        elements.schedulerReportSummary.textContent = report?.error || 'Refresh the report after the scheduler and Redis are running.';
        return;
      }

      const cards = [
        { value: report.redisHealthy ? 'healthy' : 'down', label: 'Redis' },
        { value: report.isRunning ? 'running' : 'stopped', label: 'Runner' },
        { value: String(report.totalSchedules), label: report.scopeCountLabel },
        { value: report.nextRunLabel, label: 'Next Run' },
      ];

      elements.schedulerReportCards.innerHTML = cards.map((stat) => `
        <div class="stat-card">
          <strong>${escapeHtml(stat.value)}</strong>
          <span>${escapeHtml(stat.label)}</span>
        </div>
      `).join('');

      elements.schedulerReportSummary.textContent = report.summary;
    }

    function getSchedulerToolMode(toolList = uiState.agentTools, pendingToolModes = uiState.pendingToolModes) {
      const schedulerTool = Array.isArray(toolList)
        ? toolList.find((tool) => readNonEmptyString(tool?.tool?.name || tool?.name) === 'agent-scheduler')
        : null;
      return schedulerTool ? getEffectiveAuthMode(schedulerTool, pendingToolModes) : 'off';
    }

    function getSchedulerAgentOptions() {
      const options = new Map();
      uiState.schedulerAgents.forEach((agent) => {
        const agentId = readNonEmptyString(agent?.agentId);
        if (!agentId) {
          return;
        }
        options.set(agentId, {
          agentId,
          name: readNonEmptyString(agent?.name) || agentId,
        });
      });

      uiState.schedulerSchedules.forEach((schedule) => {
        const agentId = getScheduleTargetAgentId(schedule);
        if (!agentId || options.has(agentId)) {
          return;
        }
        options.set(agentId, { agentId, name: agentId });
      });

      if (!options.has(getActiveAgentId())) {
        options.set(getActiveAgentId(), {
          agentId: getActiveAgentId(),
          name: readNonEmptyString(uiState.agentProfile?.name) || DEFAULT_CHAT_AGENT_NAME,
        });
      }

      return Array.from(options.values()).sort((left, right) => left.name.localeCompare(right.name));
    }

    function getScheduleTargetAgentId(schedule) {
      return readNonEmptyString(schedule?.taskData?.targetAgent) || DEFAULT_CHAT_AGENT_ID;
    }

    function getSchedulerAgentName(agentId) {
      const entry = getSchedulerAgentOptions().find((agent) => agent.agentId === agentId);
      return entry?.name || agentId || 'Unknown bot';
    }

/**
 * @description Schedules visible under the current bot filter. The all-bots sentinel returns every
 * schedule rather than filtering on an empty id.
 * @returns {object[]} The in-scope schedules.
 */
    function getFilteredSchedules() {
      const selectedAgentId = readNonEmptyString(uiState.schedulerAgentFilter);
      const schedules = Array.isArray(uiState.schedulerSchedules) ? uiState.schedulerSchedules : [];
      if (!selectedAgentId || selectedAgentId === ALL_AGENTS_FILTER) {
        return schedules;
      }
      return schedules.filter((schedule) => getScheduleTargetAgentId(schedule) === selectedAgentId);
    }

/**
 * @description Agent-scheduler tool mode for the selected bot, or empty when the filter spans every
 * bot — the tool toggle is per bot, so there is no single answer for "all".
 * @returns {string} The cached tool mode, or empty.
 */
    function getSelectedSchedulerToolMode() {
      const selectedAgentId = readNonEmptyString(uiState.schedulerAgentFilter);
      if (!selectedAgentId || selectedAgentId === ALL_AGENTS_FILTER) {
        return '';
      }
      return readNonEmptyString(uiState.schedulerAgentToolModes.get(selectedAgentId));
    }

    function renderSchedulerAgentSelectors() {
      const agentOptions = getSchedulerAgentOptions();

      if (elements.schedulerAgentFilter) {
        const filterValue = readNonEmptyString(uiState.schedulerAgentFilter) || ALL_AGENTS_FILTER;
        elements.schedulerAgentFilter.innerHTML = [
          `<option value="${ALL_AGENTS_FILTER}">All Bots</option>`,
          ...agentOptions.map((agent) => `<option value="${escapeHtml(agent.agentId)}">${escapeHtml(agent.name)}</option>`),
        ].join('');
        elements.schedulerAgentFilter.value = agentOptions.some((agent) => agent.agentId === filterValue)
          ? filterValue
          : ALL_AGENTS_FILTER;
        uiState.schedulerAgentFilter = elements.schedulerAgentFilter.value;
      }

      if (elements.scheduleTargetAgentSelect) {
        const currentValue = readNonEmptyString(elements.scheduleTargetAgentSelect.value);
        const defaultValue = uiState.scheduleEditorMode === 'edit' ? currentValue : getDefaultScheduleTargetAgentId();
        const desiredValue = currentValue || defaultValue;
        elements.scheduleTargetAgentSelect.innerHTML = [
          '<option value="">Select bot</option>',
          ...agentOptions.map((agent) => `<option value="${escapeHtml(agent.agentId)}">${escapeHtml(agent.name)}</option>`),
        ].join('');
        elements.scheduleTargetAgentSelect.value = agentOptions.some((agent) => agent.agentId === desiredValue)
          ? desiredValue
          : (agentOptions.some((agent) => agent.agentId === defaultValue) ? defaultValue : '');
      }
    }

    function getDefaultScheduleTargetAgentId() {
      const filterAgentId = readNonEmptyString(uiState.schedulerAgentFilter);
      if (filterAgentId && filterAgentId !== ALL_AGENTS_FILTER) {
        return filterAgentId;
      }
      return getActiveAgentId();
    }

/**
 * @description Re-render the legacy schedule editor chrome (disabled job id while editing, button
 * labels, and the explanatory summary). No-ops when the surface has no editor markup.
 * @returns {void}
 */
    function renderScheduleEditor() {
      if (!hasLegacySchedulerEditor()) {
        return;
      }
      renderSchedulerAgentSelectors();
      const isEditing = uiState.scheduleEditorMode === 'edit';
      elements.scheduleTaskTypeInput.disabled = isEditing;
      elements.saveScheduleBtn.textContent = isEditing ? 'Update Job' : 'Create Job';
      elements.cancelScheduleEditBtn.hidden = !isEditing;
      const selectedAgentName = getSchedulerAgentName(readNonEmptyString(elements.scheduleTargetAgentSelect.value) || getDefaultScheduleTargetAgentId());
      elements.schedulerEditorSummary.textContent = isEditing
        ? `Editing ${uiState.editingScheduleId}. Job ids stay stable, so this form updates cron, target bot, and task payload in place for ${selectedAgentName}.`
        : `Create a Redis cron job for ${selectedAgentName}. The job id becomes the persistent schedule key, so keep it stable and descriptive.`;
    }

/**
 * @description Re-render the scheduled job cards for the current scope.
 * @returns {void}
 */
    function renderScheduledJobs() {
      if (!elements.scheduledJobList) {
        return;
      }

      const schedules = getFilteredSchedules();
      if (schedules.length === 0) {
        elements.scheduledJobList.innerHTML = '<div class="muted-empty">No scheduled jobs exist for the current scope.</div>';
        return;
      }

      elements.scheduledJobList.innerHTML = schedules.map((schedule) => {
        const targetAgentId = getScheduleTargetAgentId(schedule);
        const prompt = readNonEmptyString(schedule?.taskData?.prompt);
        const action = readNonEmptyString(schedule?.taskData?.action);
        const workspaceSlug = readNonEmptyString(schedule?.taskData?.workspaceSlug);
        const nextRun = formatScheduleDate(schedule?.nextRunAt);
        const lastRun = formatScheduleDate(schedule?.lastRunAt);
        return `
          <article class="scheduler-job-card" data-schedule-id="${escapeHtml(schedule.id)}">
            <div class="scheduler-job-header">
              <div class="scheduler-job-title">
                <strong>${escapeHtml(schedule.taskType || schedule.id)}</strong>
                <span class="scheduler-job-subtitle">${escapeHtml(getSchedulerAgentName(targetAgentId))} · ${escapeHtml(targetAgentId)}</span>
              </div>
              <span class="status-pill">${escapeHtml(readNonEmptyString(schedule.status) || 'unknown')}</span>
            </div>
            <div class="scheduler-job-meta">
              <span class="scheduler-job-metrics">Cron ${escapeHtml(readNonEmptyString(schedule.cron) || 'n/a')}</span>
              <span class="scheduler-job-metrics">Next ${escapeHtml(nextRun)}</span>
              <span class="scheduler-job-metrics">Last ${escapeHtml(lastRun)}</span>
              <span class="scheduler-job-metrics">Runs ${escapeHtml(String(schedule.executionCount ?? 0))}</span>
            </div>
            <div class="chip-list">
              ${action ? `<span class="chip">Action: ${escapeHtml(action)}</span>` : ''}
              ${workspaceSlug ? `<span class="chip">Workspace: ${escapeHtml(workspaceSlug)}</span>` : ''}
            </div>
            <div class="scheduler-job-prompt">${escapeHtml(truncateText(prompt || 'No prompt stored.', 280))}</div>
            <div class="scheduler-job-footer">
              <span class="scheduler-job-metrics">Updated ${escapeHtml(formatScheduleDate(schedule?.updatedAt))}</span>
              <div class="scheduler-job-actions">
                <button class="btn-sm" type="button" data-schedule-action="edit" data-schedule-id="${escapeHtml(schedule.id)}">Edit</button>
                <button class="btn-sm" type="button" data-schedule-action="${schedule.status === 'paused' ? 'resume' : 'pause'}" data-schedule-id="${escapeHtml(schedule.id)}">${schedule.status === 'paused' ? 'Resume' : 'Pause'}</button>
                <button class="btn-sm" type="button" data-schedule-action="trigger" data-schedule-id="${escapeHtml(schedule.id)}">Run Now</button>
                <button class="btn-sm" type="button" data-schedule-action="delete" data-schedule-id="${escapeHtml(schedule.id)}">Delete</button>
              </div>
            </div>
          </article>
        `;
      }).join('');
    }

    function formatScheduleDate(value) {
      const rawValue = readNonEmptyString(value);
      if (!rawValue) {
        return 'not recorded';
      }
      const date = new Date(rawValue);
      return Number.isNaN(date.getTime()) ? rawValue : date.toLocaleString();
    }

    function truncateText(value, limit) {
      if (value.length <= limit) {
        return value;
      }
      return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
    }

/**
 * @description Build the scheduler report view model from the raw status payload and the in-scope
 * schedules. Pure, so the caller decides when to recompute.
 * @param {object} statusPayload - /api/v1/agent/scheduler/status response, possibly null.
 * @param {object[]} schedules - The in-scope schedules.
 * @param {string} [schedulerToolMode] - Agent-scheduler tool mode for a single-bot scope.
 * @returns {object} Report view model, with `error` set when no usable payload arrived.
 */
    function buildSchedulerReport(statusPayload, schedules, schedulerToolMode = '') {
      const nextRunValue = (Array.isArray(schedules) ? schedules : [])
        .map((schedule) => readNonEmptyString(schedule?.nextRunAt || schedule?.nextRun))
        .filter((value) => value.length > 0)
        .sort()[0];
      const botsInScope = new Set((Array.isArray(schedules) ? schedules : []).map((schedule) => getScheduleTargetAgentId(schedule)));
      const selectedAgentId = readNonEmptyString(uiState.schedulerAgentFilter);
      const scopeLabel = selectedAgentId && selectedAgentId !== ALL_AGENTS_FILTER
        ? getSchedulerAgentName(selectedAgentId)
        : 'All bots';
      const totalSchedules = Array.isArray(schedules) ? schedules.length : 0;
      const activeSchedules = Array.isArray(schedules)
        ? schedules.filter((schedule) => readNonEmptyString(schedule?.status) === 'active').length
        : 0;
      const pausedSchedules = Array.isArray(schedules)
        ? schedules.filter((schedule) => readNonEmptyString(schedule?.status) === 'paused').length
        : 0;
      const toolModeSentence = selectedAgentId && selectedAgentId !== ALL_AGENTS_FILTER
        ? `Agent Scheduler tool: ${schedulerToolMode || 'unknown'}.`
        : 'Agent Scheduler tool mode is per bot; choose one bot to inspect its toggle state.';

      return {
        redisHealthy: Boolean(statusPayload?.redisHealthy),
        isRunning: Boolean(statusPayload?.isRunning),
        pollIntervalMs: Number(statusPayload?.pollIntervalMs || 0),
        totalSchedules,
        activeSchedules,
        pausedSchedules,
        nextRunLabel: nextRunValue ? new Date(nextRunValue).toLocaleString() : 'none queued',
        scopeCountLabel: selectedAgentId && selectedAgentId !== ALL_AGENTS_FILTER ? 'Jobs' : 'Schedules',
        summary: [
          `Scope: ${scopeLabel}.`,
          `${totalSchedules} jobs in scope across ${botsInScope.size || 0} bots.`,
          `Active ${activeSchedules}, paused ${pausedSchedules}.`,
          `Poll interval ${Number(statusPayload?.pollIntervalMs || 0)} ms.`,
          toolModeSentence,
        ].join(' '),
        error: statusPayload || Array.isArray(schedules)
          ? ''
          : 'Redis scheduler endpoints did not return a report payload.',
      };
    }

/**
 * @description Seed the per-bot tool-mode cache with the active bot, so the report can state the
 * toggle state without an extra round trip.
 * @returns {void}
 */
    function seedSchedulerToolModeCache() {
      uiState.schedulerAgentToolModes.set(getActiveAgentId(), getSchedulerToolMode(uiState.agentTools, uiState.pendingToolModes));
    }

/**
 * @description Reset the bot filter to all-bots when it names a bot that no longer exists.
 * @returns {void}
 */
    function syncSchedulerAgentFilter() {
      const selectedAgentId = readNonEmptyString(uiState.schedulerAgentFilter);
      if (!selectedAgentId || selectedAgentId === ALL_AGENTS_FILTER) {
        uiState.schedulerAgentFilter = ALL_AGENTS_FILTER;
        return;
      }

      const validAgentIds = new Set(getSchedulerAgentOptions().map((agent) => agent.agentId));
      if (!validAgentIds.has(selectedAgentId)) {
        uiState.schedulerAgentFilter = ALL_AGENTS_FILTER;
      }
    }

/**
 * @description Load and cache the agent-scheduler tool mode for one bot, skipping the fetch when the
 * scope is all-bots or the answer is already cached.
 * @param {string} agentId - Bot to inspect.
 * @returns {Promise<void>} Resolves once the cache holds a mode for that bot.
 */
    async function ensureSchedulerToolModeLoaded(agentId) {
      const targetAgentId = readNonEmptyString(agentId);
      if (!targetAgentId || targetAgentId === ALL_AGENTS_FILTER || uiState.schedulerAgentToolModes.has(targetAgentId)) {
        return;
      }

      const payload = await requestJson(`/api/agents/${targetAgentId}/tools`);
      const tools = Array.isArray(payload?.tools) ? payload.tools : [];
      uiState.schedulerAgentToolModes.set(targetAgentId, getSchedulerToolMode(tools, new Map()));
    }

    async function refreshSchedulerState(showErrors = false) {
      try {
        const [agentsPayload, statusPayload, schedulesPayload] = await Promise.all([
          requestJson('/api/agents'),
          requestJson('/api/v1/agent/scheduler/status'),
          requestJson('/api/v1/agent/schedules'),
        ]);
        uiState.schedulerAgents = Array.isArray(agentsPayload?.agents) ? agentsPayload.agents : [];
        uiState.schedulerStatus = statusPayload;
        uiState.schedulerSchedules = Array.isArray(schedulesPayload?.schedules) ? schedulesPayload.schedules : [];
        syncSchedulerAgentFilter();
        syncScheduleEditorState();
        await ensureSchedulerToolModeLoaded(uiState.schedulerAgentFilter);
        renderSchedulerReport();
        renderScheduleEditor();
        renderScheduledJobs();
      } catch (error) {
        console.error('Failed to refresh scheduler state:', error);
        if (showErrors) {
          setModalStatus(`Failed to refresh scheduler state: ${error.message}`, 'error');
        }
      }
    }

/**
 * @description Keep an open edit form pointed at a schedule that still exists, resetting the editor
 * when the schedule was deleted underneath it.
 * @returns {void}
 */
    function syncScheduleEditorState() {
      if (uiState.scheduleEditorMode !== 'edit' || !uiState.editingScheduleId) {
        return;
      }

      const existing = uiState.schedulerSchedules.find((schedule) => readNonEmptyString(schedule?.id) === uiState.editingScheduleId);
      if (!existing) {
        resetScheduleEditor();
        return;
      }

      populateScheduleEditor(existing);
    }

    function resetScheduleEditor() {
      uiState.scheduleEditorMode = 'create';
      uiState.editingScheduleId = '';
      if (!hasLegacySchedulerEditor()) {
        return;
      }
      elements.scheduleTaskTypeInput.value = '';
      elements.scheduleCronInput.value = '';
      elements.schedulePromptInput.value = '';
      elements.scheduleActionInput.value = '';
      elements.scheduleWorkspaceSlugInput.value = '';
      renderSchedulerAgentSelectors();
      const defaultTarget = getDefaultScheduleTargetAgentId();
      if (defaultTarget) {
        elements.scheduleTargetAgentSelect.value = defaultTarget;
      }
      renderScheduleEditor();
    }

    function populateScheduleEditor(schedule) {
      uiState.scheduleEditorMode = 'edit';
      uiState.editingScheduleId = readNonEmptyString(schedule?.id);
      if (!hasLegacySchedulerEditor()) {
        return;
      }
      elements.scheduleTaskTypeInput.value = readNonEmptyString(schedule?.taskType || schedule?.id);
      elements.scheduleCronInput.value = readNonEmptyString(schedule?.cron);
      elements.schedulePromptInput.value = readNonEmptyString(schedule?.taskData?.prompt);
      elements.scheduleActionInput.value = readNonEmptyString(schedule?.taskData?.action);
      elements.scheduleWorkspaceSlugInput.value = readNonEmptyString(schedule?.taskData?.workspaceSlug);
      renderSchedulerAgentSelectors();
      elements.scheduleTargetAgentSelect.value = getScheduleTargetAgentId(schedule);
      renderScheduleEditor();
    }

    function readScheduleDraft() {
      return {
        taskType: readNonEmptyString(elements.scheduleTaskTypeInput?.value),
        targetAgent: readNonEmptyString(elements.scheduleTargetAgentSelect?.value),
        schedule: readNonEmptyString(elements.scheduleCronInput?.value),
        prompt: readNonEmptyString(elements.schedulePromptInput?.value),
        action: readNonEmptyString(elements.scheduleActionInput?.value),
        workspaceSlug: readNonEmptyString(elements.scheduleWorkspaceSlugInput?.value),
      };
    }

    function validateScheduleDraft(draft) {
      if (!draft.taskType) {
        return 'Job id is required.';
      }
      if (!draft.targetAgent) {
        return 'Target bot is required.';
      }
      if (!draft.schedule) {
        return 'Cron expression is required.';
      }
      if (!draft.prompt) {
        return 'Prompt is required.';
      }
      return '';
    }

    async function saveScheduleDefinition() {
      const draft = readScheduleDraft();
      const validationError = validateScheduleDraft(draft);
      if (validationError) {
        setModalStatus(validationError, 'error');
        return;
      }

      const taskData = {
        prompt: draft.prompt,
        targetAgent: draft.targetAgent,
      };
      if (draft.action) {
        taskData.action = draft.action;
      }
      if (draft.workspaceSlug) {
        taskData.workspaceSlug = draft.workspaceSlug;
      }

      try {
        setModalStatus(uiState.scheduleEditorMode === 'edit' ? 'Updating scheduled job...' : 'Creating scheduled job...', 'info');
        if (uiState.scheduleEditorMode === 'edit' && uiState.editingScheduleId) {
          await requestJson(`/api/v1/agent/schedules/${encodeURIComponent(uiState.editingScheduleId)}`, {
            method: 'PUT',
            body: JSON.stringify({
              pattern: draft.schedule,
              taskData,
            }),
          });
          setModalStatus(`Updated scheduled job ${uiState.editingScheduleId}.`, 'success');
        } else {
          await requestJson('/api/v1/agent/schedule-task', {
            method: 'POST',
            body: JSON.stringify({
              taskType: draft.taskType,
              schedule: draft.schedule,
              taskData,
            }),
          });
          setModalStatus(`Created scheduled job ${draft.taskType}.`, 'success');
        }
        await refreshSchedulerState(true);
        resetScheduleEditor();
      } catch (error) {
        console.error('Failed to save scheduled job:', error);
        setModalStatus(`Scheduled job save failed: ${error.message}`, 'error');
      }
    }

    async function handleScheduleAction(action, scheduleId) {
      const normalizedAction = readNonEmptyString(action);
      const normalizedScheduleId = readNonEmptyString(scheduleId);
      if (!normalizedAction || !normalizedScheduleId) {
        return;
      }

      if (normalizedAction === 'edit') {
        const schedule = uiState.schedulerSchedules.find((entry) => readNonEmptyString(entry?.id) === normalizedScheduleId);
        if (!schedule) {
          setModalStatus(`Scheduled job ${normalizedScheduleId} no longer exists.`, 'error');
          return;
        }
        populateScheduleEditor(schedule);
        return;
      }

      const actionMap = {
        pause: { method: 'POST', url: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}/pause`, message: `Paused ${normalizedScheduleId}.` },
        resume: { method: 'POST', url: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}/resume`, message: `Resumed ${normalizedScheduleId}.` },
        trigger: { method: 'POST', url: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}/trigger`, message: `Triggered ${normalizedScheduleId}.` },
        delete: { method: 'DELETE', url: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}`, message: `Deleted ${normalizedScheduleId}.` },
      };
      const requestConfig = actionMap[normalizedAction];
      if (!requestConfig) {
        return;
      }

      try {
        const progressLabel = {
          pause: 'Pausing',
          resume: 'Resuming',
          trigger: 'Running',
          delete: 'Deleting',
        }[normalizedAction] || 'Updating';
        setModalStatus(`${progressLabel} scheduled job...`, 'info');
        await requestJson(requestConfig.url, { method: requestConfig.method });
        setModalStatus(requestConfig.message, 'success');
        await refreshSchedulerState(true);
        if (uiState.editingScheduleId === normalizedScheduleId && normalizedAction === 'delete') {
          resetScheduleEditor();
        }
      } catch (error) {
        console.error('Failed to execute scheduled job action:', error);
        setModalStatus(`Scheduled job action failed: ${error.message}`, 'error');
      }
    }

/**
 * @description Bind the scheduler controls: report refresh, bot filter, editor reset/cancel/save, the
 * cron presets, and the per-job action buttons.
 * @returns {void}
 */
    function bindSchedulerEvents() {
      elements.refreshSchedulerReportBtn?.addEventListener('click', async () => {
        setModalStatus('Refreshing Redis scheduler report...', 'info');
        await refreshSchedulerState(true);
        if (!elements.modalStatus.getAttribute('data-tone') || elements.modalStatus.getAttribute('data-tone') === 'info') {
          setModalStatus('Redis scheduler state refreshed.', 'success');
        }
      });
      elements.schedulerAgentFilter?.addEventListener('change', async () => {
        uiState.schedulerAgentFilter = readNonEmptyString(elements.schedulerAgentFilter.value) || ALL_AGENTS_FILTER;
        try {
          await ensureSchedulerToolModeLoaded(uiState.schedulerAgentFilter);
        } catch (error) {
          console.error('Failed to load selected bot scheduler mode:', error);
          setModalStatus(`Failed to inspect selected bot: ${error.message}`, 'error');
        }
        if (uiState.scheduleEditorMode !== 'edit') {
          renderSchedulerAgentSelectors();
          if (elements.scheduleTargetAgentSelect) {
            elements.scheduleTargetAgentSelect.value = getDefaultScheduleTargetAgentId();
          }
        }
        renderSchedulerReport();
        renderScheduleEditor();
        renderScheduledJobs();
      });
      elements.resetScheduleEditorBtn?.addEventListener('click', () => {
        resetScheduleEditor();
        clearModalStatus();
      });
      elements.cancelScheduleEditBtn?.addEventListener('click', () => {
        resetScheduleEditor();
        clearModalStatus();
      });
      elements.saveScheduleBtn?.addEventListener('click', () => { void saveScheduleDefinition(); });
      document.querySelectorAll('[data-cron-preset]').forEach((button) => {
        button.addEventListener('click', () => {
          if (elements.scheduleCronInput) {
            elements.scheduleCronInput.value = readNonEmptyString(button.getAttribute('data-cron-preset'));
          }
        });
      });
      elements.scheduledJobList?.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const button = target.closest('[data-schedule-action]');
        if (!(button instanceof HTMLElement)) {
          return;
        }
        void handleScheduleAction(button.dataset.scheduleAction, button.dataset.scheduleId);
      });
    }

export {
  bindSchedulerEvents,
  buildSchedulerReport,
  ensureSchedulerToolModeLoaded,
  getFilteredSchedules,
  getSelectedSchedulerToolMode,
  renderScheduleEditor,
  renderScheduledJobs,
  renderSchedulerReport,
  seedSchedulerToolModeCache,
  syncScheduleEditorState,
  syncSchedulerAgentFilter,
};

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added standalone chat Redis jobs popup for active-bot scheduler operations
 */

import {
  escapeHtml,
  readString,
  requestJson,
  toMessage,
} from '/chat-assets/chat-workspace-popups-utils.mjs';
import { createUiLogger } from '../../shared/ui-debug.js';

const logger = createUiLogger('chat-redis-scheduler-popup');

const REDIS_JOBS_POPUP_CSS = `
  .redis-jobs-note {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
    padding: 12px 14px;
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    background: linear-gradient(145deg, var(--glass-bg-heavy), var(--glass-bg));
    box-shadow: var(--card-shadow);
  }
  .redis-jobs-note strong { display: block; color: var(--text-primary); font-size: 13px; }
  .redis-jobs-note span { color: var(--text-dim); font-size: 12px; }
  .redis-jobs-story {
    margin-bottom: 12px;
    padding: 12px 14px;
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    background: linear-gradient(145deg, var(--glass-bg-heavy), var(--glass-bg));
    display: grid;
    gap: 10px;
    box-shadow: var(--card-shadow);
  }
  .redis-jobs-story strong { color: var(--text-primary); font-size: 13px; }
  .redis-jobs-story-list {
    display: grid;
    gap: 8px;
  }
  .redis-jobs-story-row {
    display: grid;
    gap: 3px;
  }
  .redis-jobs-story-row label {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .06em;
  }
  .redis-jobs-story-row span {
    color: var(--text-primary);
    font-size: 13px;
    line-height: 1.45;
  }
  .redis-jobs-contract {
    margin-top: 2px;
    padding: 10px 12px 0;
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    background: var(--glass-bg);
  }
  .redis-jobs-contract strong { color: var(--text-primary); font-size: 13px; }
  .redis-jobs-contract span { color: var(--text-dim); font-size: 12px; }
  .redis-jobs-contract summary {
    cursor: pointer;
    color: var(--text-dim);
    font-size: 12px;
    margin-bottom: 10px;
  }
  .redis-jobs-contract pre {
    margin: 0;
    padding: 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-primary) 24%, var(--glass-bg-heavy));
    color: var(--text-primary);
    font-size: 12px;
    line-height: 1.45;
    overflow: auto;
  }
  .redis-jobs-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(120px, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }
  .redis-jobs-stat {
    border: 1px solid var(--glass-border);
    border-radius: 10px;
    background: linear-gradient(145deg, var(--glass-bg-heavy), var(--glass-bg));
    padding: 10px 12px;
    display: grid;
    gap: 4px;
    box-shadow: var(--card-shadow);
  }
  .redis-jobs-stat strong { color: var(--text-primary); font-size: 16px; }
  .redis-jobs-stat span { color: var(--text-dim); font-size: 12px; }
  .redis-jobs-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(220px, 1fr));
    gap: 12px;
    margin-top: 12px;
  }
  .redis-jobs-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .redis-jobs-field-wide { grid-column: 1 / -1; }
  .redis-jobs-field label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: var(--text-dim);
  }
  .redis-jobs-field input,
  .redis-jobs-field textarea {
    background: color-mix(in srgb, var(--bg-primary) 28%, var(--glass-bg-heavy));
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13px;
  }
  .redis-jobs-field textarea { min-height: 96px; resize: vertical; }
  .redis-jobs-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
  }
  .redis-jobs-action-group {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .redis-jobs-preset-list {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .redis-jobs-preset-btn {
    border: 1px solid color-mix(in srgb, var(--accent-primary) 28%, var(--glass-border));
    background: color-mix(in srgb, var(--accent-primary) 12%, var(--glass-bg));
    color: var(--text-primary);
    border-radius: 999px;
    padding: 6px 10px;
    font-size: 11px;
    cursor: pointer;
  }
  .redis-jobs-preset-btn:hover {
    background: color-mix(in srgb, var(--accent-primary) 20%, var(--glass-bg-heavy));
    border-color: color-mix(in srgb, var(--accent-primary) 42%, var(--border-color-hover));
  }
  .redis-jobs-editor-summary {
    margin-top: 10px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .redis-jobs-list {
    display: grid;
    gap: 10px;
    margin-top: 14px;
    min-height: 140px;
    max-height: 320px;
    flex-shrink: 0;
    overflow-y: auto;
  }
  .redis-jobs-card {
    border: 1px solid var(--glass-border);
    border-radius: 10px;
    padding: 12px;
    background: linear-gradient(145deg, var(--glass-bg-heavy), var(--glass-bg));
    display: grid;
    gap: 10px;
    box-shadow: var(--card-shadow);
  }
  .redis-jobs-card-header,
  .redis-jobs-card-meta,
  .redis-jobs-card-footer {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .redis-jobs-card strong { color: var(--text-primary); }
  .redis-jobs-card p,
  .redis-jobs-card span { color: var(--text-dim); font-size: 12px; margin: 0; }
  .redis-jobs-card-prompt {
    white-space: pre-wrap;
    line-height: 1.45;
    color: var(--text-primary);
    font-size: 12px;
  }
  @media (max-width: 960px) {
    .redis-jobs-note,
    .redis-jobs-actions { flex-direction: column; align-items: stretch; }
    .redis-jobs-grid,
    .redis-jobs-summary { grid-template-columns: 1fr; }
    .redis-jobs-field-wide { grid-column: auto; }
  }
`;

const REDIS_JOBS_POPUP_HTML = `
  <div class="config-modal-backdrop" data-close-for="redisJobsModal"></div>
  <div class="config-modal-dialog" role="dialog" aria-modal="true">
    <div class="config-modal-header">
      <div class="config-modal-title">
        <strong><span class="codicon codicon-calendar"></span>Redis Jobs</strong>
        <span>Manage scheduled jobs for the active bot without opening the full tools cockpit.</span>
      </div>
      <div class="config-modal-actions">
        <button class="btn-sm" type="button" data-close-for="redisJobsModal">Close</button>
      </div>
    </div>
    <div class="service-status" id="redisJobsStatus"></div>
    <div class="redis-jobs-note">
      <div>
        <strong>Scheduler activation still lives in Core Bot Settings</strong>
        <span>The Tools section keeps the Switch Framework toggle. This popup is the operational view for jobs owned by the active bot.</span>
      </div>
      <button class="mini-btn" type="button" id="openRedisJobsSettingsBtn">Core Bot Settings</button>
    </div>
    <div class="redis-jobs-story">
      <strong>What this event will do</strong>
      <div class="redis-jobs-story-list">
        <div class="redis-jobs-story-row">
          <label>Bot</label>
          <span id="redisJobsStoryBot"></span>
        </div>
        <div class="redis-jobs-story-row">
          <label>Job</label>
          <span id="redisJobsStoryJob"></span>
        </div>
        <div class="redis-jobs-story-row">
          <label>What it does</label>
          <span id="redisJobsStoryPrompt"></span>
        </div>
        <div class="redis-jobs-story-row">
          <label>When it runs</label>
          <span id="redisJobsStoryWhen"></span>
        </div>
      </div>
      <details class="redis-jobs-contract">
        <summary>Show raw scheduler payload</summary>
        <pre id="redisJobsPayloadPreview"></pre>
      </details>
    </div>
    <div class="redis-jobs-summary" id="redisJobsSummary"></div>
    <div class="redis-jobs-grid">
      <div class="redis-jobs-field">
        <label>Job Code</label>
        <input id="redisJobIdInput" type="text" placeholder="hourly_platform_report" />
      </div>
      <div class="redis-jobs-field">
        <label>When should it run</label>
        <input id="redisJobCronInput" type="text" placeholder="0 * * * *" />
        <div class="redis-jobs-preset-list">
          <button class="redis-jobs-preset-btn" type="button" data-redis-cron-preset="*/30 * * * *">Every 30 min</button>
          <button class="redis-jobs-preset-btn" type="button" data-redis-cron-preset="0 * * * *">Hourly</button>
          <button class="redis-jobs-preset-btn" type="button" data-redis-cron-preset="0 */6 * * *">Every 6h</button>
          <button class="redis-jobs-preset-btn" type="button" data-redis-cron-preset="0 9 * * 1-5">Weekdays 9am</button>
        </div>
      </div>
      <div class="redis-jobs-field redis-jobs-field-wide">
        <label>What should the bot do</label>
        <textarea id="redisJobPromptInput" placeholder="Describe the work this bot should perform when the schedule fires."></textarea>
      </div>
      <div class="redis-jobs-field">
        <label>Job Name</label>
        <input id="redisJobActionInput" type="text" placeholder="hourly_report" />
      </div>
      <div class="redis-jobs-field">
        <label>Workspace Slug</label>
        <input id="redisJobWorkspaceSlugInput" type="text" placeholder="devopscloud-00" />
      </div>
    </div>
    <div class="redis-jobs-editor-summary" id="redisJobsEditorSummary"></div>
    <div class="redis-jobs-actions">
      <div class="redis-jobs-action-group">
        <button class="mini-btn" type="button" id="refreshRedisJobsBtn">Refresh Jobs</button>
        <button class="mini-btn" type="button" id="resetRedisJobEditorBtn">New Job</button>
      </div>
      <div class="redis-jobs-action-group">
        <button class="mini-btn" type="button" id="cancelRedisJobEditBtn" hidden>Cancel Edit</button>
        <button class="mini-btn" type="button" id="saveRedisJobBtn">Create Job</button>
      </div>
    </div>
    <div class="redis-jobs-list" id="redisJobsList"></div>
  </div>
`;

const ALL_ACTIVE_BOT_FALLBACK_NAME = 'Active Bot';
const popupState = {
  defaultAgentId: '',
  activeBotName: ALL_ACTIVE_BOT_FALLBACK_NAME,
  schedulerStatus: null,
  schedules: [],
  editorMode: 'create',
  editingScheduleId: '',
};

/**
 * @description Initializes the standalone chat Redis jobs popup for scheduler operations.
 * @param {object} options Runtime callbacks and identifiers.
 * @param {string} options.defaultAgentId Active bot identifier.
 * @param {(modalId: string) => void} options.closeModal Hide sibling modals callback.
 * @param {() => void} options.openCoreBotSettings Opens the tools/settings cockpit at the tools section.
 * @returns {void}
 */
export function initializeChatRedisSchedulerPopup(options) {
  popupState.defaultAgentId = options.defaultAgentId;
  logger.info('Initializing Redis scheduler popup', {
    defaultAgentId: options.defaultAgentId || null,
  });
  injectStyles();
  ensureWorkspaceModal();
  bindWorkspaceOpen(options);
  bindWorkspaceClose();
  bindEscapeKey();
  bindWorkspaceActions(options);
}

function injectStyles() {
  if (document.getElementById('chatRedisJobsPopupStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'chatRedisJobsPopupStyle';
  style.textContent = REDIS_JOBS_POPUP_CSS;
  document.head.appendChild(style);
}

function ensureWorkspaceModal() {
  if (document.getElementById('redisJobsModal')) {
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'redisJobsModal';
  modal.className = 'config-modal';
  modal.hidden = true;
  modal.innerHTML = REDIS_JOBS_POPUP_HTML;
  document.body.appendChild(modal);
}

function bindWorkspaceOpen(options) {
  const button = document.getElementById('openRedisJobsModalBtn');
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  button.addEventListener('click', async () => {
    options.closeModal('historyModal');
    options.closeModal('ragModal');
    const modal = document.getElementById('redisJobsModal');
    if (modal) {
      modal.hidden = false;
    }
    setStatus('redisJobsStatus', 'Loading Redis jobs for the active bot...', 'info');
    await loadRedisJobsWorkspace();
  });
}

function bindWorkspaceClose() {
  document.querySelectorAll('[data-close-for="redisJobsModal"]').forEach((node) => {
    node.addEventListener('click', () => {
      const modal = document.getElementById('redisJobsModal');
      if (modal) {
        modal.hidden = true;
      }
    });
  });
}

function bindEscapeKey() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    const modal = document.getElementById('redisJobsModal');
    if (modal) {
      modal.hidden = true;
    }
  });
}

function bindWorkspaceActions(options) {
  bindClick('openRedisJobsSettingsBtn', () => options.openCoreBotSettings());
  bindClick('refreshRedisJobsBtn', () => { void loadRedisJobsWorkspace(true); });
  bindClick('resetRedisJobEditorBtn', () => {
    resetRedisJobEditor();
    setStatus('redisJobsStatus', 'Ready to create a new Redis job.', 'success');
  });
  bindClick('cancelRedisJobEditBtn', () => {
    resetRedisJobEditor();
    setStatus('redisJobsStatus', 'Edit cancelled.', 'success');
  });
  bindClick('saveRedisJobBtn', () => { void saveRedisJobDefinition(); });

  ['redisJobIdInput', 'redisJobCronInput', 'redisJobPromptInput', 'redisJobActionInput', 'redisJobWorkspaceSlugInput'].forEach((id) => {
    const node = document.getElementById(id);
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      node.addEventListener('input', () => {
        renderRedisPayloadPreview();
      });
    }
  });

  document.querySelectorAll('[data-redis-cron-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      setInputValue('redisJobCronInput', readString(button.getAttribute('data-redis-cron-preset')));
    });
  });

  const jobsList = document.getElementById('redisJobsList');
  if (jobsList instanceof HTMLElement) {
    jobsList.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest('[data-redis-job-action]');
      if (!(button instanceof HTMLElement)) {
        return;
      }
      void handleRedisJobAction(button.dataset.redisJobAction, button.dataset.scheduleId);
    });
  }
}

function bindClick(id, handler) {
  const node = document.getElementById(id);
  if (node instanceof HTMLButtonElement) {
    node.addEventListener('click', handler);
  }
}

async function loadRedisJobsWorkspace(showSuccess = false) {
  logger.info('Loading Redis scheduler workspace', {
    defaultAgentId: popupState.defaultAgentId || null,
    showSuccess,
  });
  try {
    const [profilePayload, statusPayload, schedulesPayload] = await Promise.all([
      requestJson(`/api/agents/${encodeURIComponent(popupState.defaultAgentId)}/profile`),
      requestJson('/api/v1/agent/scheduler/status'),
      requestJson('/api/v1/agent/schedules'),
    ]);

    popupState.activeBotName = readString(profilePayload?.profile?.name) || ALL_ACTIVE_BOT_FALLBACK_NAME;
    popupState.schedulerStatus = statusPayload;
    popupState.schedules = (Array.isArray(schedulesPayload?.schedules) ? schedulesPayload.schedules : [])
      .filter((schedule) => getScheduleTargetAgentId(schedule) === popupState.defaultAgentId);

    syncRedisJobEditorState();
    renderRedisJobsSummary();
    renderRedisJobEditor();
    renderRedisPayloadPreview();
    renderRedisJobsList();
    setStatus('redisJobsStatus', showSuccess ? 'Redis jobs refreshed.' : 'Redis jobs loaded.', 'success');
    logger.info('Loaded Redis scheduler workspace', {
      scheduleCount: popupState.schedules.length,
      activeBotName: popupState.activeBotName || null,
    });
  } catch (error) {
    logger.warn('Failed to load Redis scheduler workspace', {
      error: toMessage(error),
    });
    renderRedisJobsSummary();
    renderRedisJobsList([]);
    setStatus('redisJobsStatus', `Redis jobs load failed: ${toMessage(error)}`, 'error');
  }
}

function renderRedisJobsSummary() {
  const summary = document.getElementById('redisJobsSummary');
  if (!(summary instanceof HTMLElement)) {
    return;
  }

  const status = popupState.schedulerStatus && typeof popupState.schedulerStatus === 'object' ? popupState.schedulerStatus : {};
  const activeCount = popupState.schedules.filter((schedule) => readString(schedule?.status) === 'active').length;
  const nextRun = popupState.schedules
    .map((schedule) => readString(schedule?.nextRunAt || schedule?.nextRun))
    .filter((value) => value.length > 0)
    .sort()[0];

  const stats = [
    { value: popupState.activeBotName, label: 'Bot' },
    { value: status.redisHealthy ? 'healthy' : 'down', label: 'Redis' },
    { value: status.isRunning ? 'running' : 'stopped', label: 'Runner' },
    { value: String(popupState.schedules.length), label: 'Jobs' },
    { value: String(activeCount), label: 'Active' },
    { value: nextRun ? formatDate(nextRun) : 'none queued', label: 'Next Run' },
  ];

  summary.innerHTML = stats.map((stat) => `
    <div class="redis-jobs-stat">
      <strong>${escapeHtml(stat.value)}</strong>
      <span>${escapeHtml(stat.label)}</span>
    </div>
  `).join('');
}

function renderRedisJobEditor() {
  const summary = document.getElementById('redisJobsEditorSummary');
  const idInput = document.getElementById('redisJobIdInput');
  const saveButton = document.getElementById('saveRedisJobBtn');
  const cancelButton = document.getElementById('cancelRedisJobEditBtn');
  if (!(summary instanceof HTMLElement) || !(idInput instanceof HTMLInputElement) || !(saveButton instanceof HTMLButtonElement) || !(cancelButton instanceof HTMLButtonElement)) {
    return;
  }

  const editing = popupState.editorMode === 'edit';
  idInput.disabled = editing;
  saveButton.textContent = editing ? 'Update Job' : 'Create Job';
  cancelButton.hidden = !editing;
  summary.textContent = editing
    ? `Editing ${popupState.editingScheduleId} for ${popupState.activeBotName}. Keep the job code stable and adjust the instructions or timing as needed.`
    : `Create an event for ${popupState.activeBotName}. The job code is the durable key the scheduler will keep in Redis.`;
}

function renderRedisPayloadPreview() {
  const preview = document.getElementById('redisJobsPayloadPreview');
  if (!(preview instanceof HTMLElement)) {
    return;
  }

  const draft = readRedisJobDraft();
  const taskData = {
    prompt: draft.prompt || 'Describe the work this bot should run.',
    targetAgent: popupState.defaultAgentId,
  };
  if (draft.action) {
    taskData.action = draft.action;
  }
  if (draft.workspaceSlug) {
    taskData.workspaceSlug = draft.workspaceSlug;
  }

  const payload = popupState.editorMode === 'edit' && popupState.editingScheduleId
    ? {
      pattern: draft.schedule || '0 * * * *',
      taskData,
    }
    : {
      taskType: draft.taskType || 'hourly_platform_report',
      schedule: draft.schedule || '0 * * * *',
      taskData,
    };

  preview.textContent = JSON.stringify(payload, null, 2);
}

function renderRedisStoryPreview() {
  setText('redisJobsStoryBot', popupState.activeBotName || ALL_ACTIVE_BOT_FALLBACK_NAME);

  const draft = readRedisJobDraft();
  const jobCode = draft.taskType || popupState.editingScheduleId || 'hourly_platform_report';
  const jobName = draft.action || humanizeIdentifier(jobCode);
  const editingSchedule = popupState.schedules.find((schedule) => readString(schedule?.id) === popupState.editingScheduleId);
  const nextRun = readString(editingSchedule?.nextRunAt || editingSchedule?.nextRun);
  const whenText = describeCronRule(draft.schedule || readString(editingSchedule?.cron), nextRun);

  setText('redisJobsStoryJob', `${jobName} (${jobCode})`);
  setText('redisJobsStoryPrompt', draft.prompt || 'Describe the work this bot should perform when the event fires.');
  setText('redisJobsStoryWhen', whenText);
}

function renderRedisJobsList(overrideList) {
  const list = document.getElementById('redisJobsList');
  if (!(list instanceof HTMLElement)) {
    return;
  }

  const schedules = Array.isArray(overrideList) ? overrideList : popupState.schedules;
  if (!Array.isArray(schedules) || schedules.length === 0) {
    list.innerHTML = '<div class="muted-empty">No Redis jobs exist for this bot yet.</div>';
    return;
  }

  list.innerHTML = schedules.map((schedule) => {
    const prompt = readString(schedule?.taskData?.prompt) || 'No prompt stored.';
    const action = readString(schedule?.taskData?.action);
    const workspaceSlug = readString(schedule?.taskData?.workspaceSlug);
    const status = readString(schedule?.status) || 'unknown';
    const isPaused = status === 'paused';
    const taskType = readString(schedule?.taskType || schedule?.id);
    const jobName = action || humanizeIdentifier(taskType);
    const cron = readString(schedule?.cron);
    return `
      <article class="redis-jobs-card" data-schedule-id="${escapeHtml(schedule.id)}">
        <div class="redis-jobs-card-header">
          <div>
            <strong>${escapeHtml(jobName)}</strong>
            <p>${escapeHtml(popupState.activeBotName)} · code ${escapeHtml(taskType)}</p>
          </div>
          <span class="status-pill">${escapeHtml(status)}</span>
        </div>
        <div class="redis-jobs-card-meta">
          <span>${escapeHtml(describeCronRule(cron, readString(schedule?.nextRunAt || schedule?.nextRun), true))}</span>
          <span>Next ${escapeHtml(formatDate(readString(schedule?.nextRunAt || schedule?.nextRun)))}</span>
          <span>Last ${escapeHtml(formatDate(readString(schedule?.lastRunAt)))}</span>
          <span>Runs ${escapeHtml(String(schedule?.executionCount ?? 0))}</span>
        </div>
        <div class="chip-list">
          <span class="chip">Code: ${escapeHtml(taskType)}</span>
          <span class="chip">Rule: ${escapeHtml(cron || 'n/a')}</span>
          ${workspaceSlug ? `<span class="chip">Workspace: ${escapeHtml(workspaceSlug)}</span>` : ''}
        </div>
        <div class="redis-jobs-card-prompt">${escapeHtml(truncateText(prompt, 280))}</div>
        <div class="redis-jobs-card-footer">
          <span>Updated ${escapeHtml(formatDate(readString(schedule?.updatedAt)))}</span>
          <div class="redis-jobs-action-group">
            <button class="btn-sm" type="button" data-redis-job-action="edit" data-schedule-id="${escapeHtml(schedule.id)}">Edit</button>
            <button class="btn-sm" type="button" data-redis-job-action="${isPaused ? 'resume' : 'pause'}" data-schedule-id="${escapeHtml(schedule.id)}">${isPaused ? 'Resume' : 'Pause'}</button>
            <button class="btn-sm" type="button" data-redis-job-action="trigger" data-schedule-id="${escapeHtml(schedule.id)}">Run Now</button>
            <button class="btn-sm" type="button" data-redis-job-action="delete" data-schedule-id="${escapeHtml(schedule.id)}">Delete</button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function syncRedisJobEditorState() {
  if (popupState.editorMode !== 'edit' || !popupState.editingScheduleId) {
    return;
  }

  const schedule = popupState.schedules.find((entry) => readString(entry?.id) === popupState.editingScheduleId);
  if (!schedule) {
    resetRedisJobEditor();
    return;
  }

  populateRedisJobEditor(schedule);
}

function resetRedisJobEditor() {
  popupState.editorMode = 'create';
  popupState.editingScheduleId = '';
  setInputValue('redisJobIdInput', '');
  setInputValue('redisJobCronInput', '');
  setInputValue('redisJobPromptInput', '');
  setInputValue('redisJobActionInput', '');
  setInputValue('redisJobWorkspaceSlugInput', '');
  renderRedisJobEditor();
  renderRedisStoryPreview();
  renderRedisPayloadPreview();
}

function populateRedisJobEditor(schedule) {
  popupState.editorMode = 'edit';
  popupState.editingScheduleId = readString(schedule?.id);
  setInputValue('redisJobIdInput', readString(schedule?.taskType || schedule?.id));
  setInputValue('redisJobCronInput', readString(schedule?.cron));
  setInputValue('redisJobPromptInput', readString(schedule?.taskData?.prompt));
  setInputValue('redisJobActionInput', readString(schedule?.taskData?.action));
  setInputValue('redisJobWorkspaceSlugInput', readString(schedule?.taskData?.workspaceSlug));
  renderRedisJobEditor();
  renderRedisStoryPreview();
  renderRedisPayloadPreview();
}

function readRedisJobDraft() {
  return {
    taskType: readInputValue('redisJobIdInput'),
    schedule: readInputValue('redisJobCronInput'),
    prompt: readInputValue('redisJobPromptInput'),
    action: readInputValue('redisJobActionInput'),
    workspaceSlug: readInputValue('redisJobWorkspaceSlugInput'),
  };
}

function validateRedisJobDraft(draft) {
  if (!draft.taskType) {
    return 'Job code is required.';
  }
  if (!draft.schedule) {
    return 'Choose when the job should run.';
  }
  if (!draft.prompt) {
    return 'Describe what the bot should do.';
  }
  return '';
}

async function saveRedisJobDefinition() {
  const draft = readRedisJobDraft();
  const validationError = validateRedisJobDraft(draft);
  if (validationError) {
    setStatus('redisJobsStatus', validationError, 'error');
    return;
  }

  const taskData = {
    prompt: draft.prompt,
    targetAgent: popupState.defaultAgentId,
  };
  if (draft.action) {
    taskData.action = draft.action;
  }
  if (draft.workspaceSlug) {
    taskData.workspaceSlug = draft.workspaceSlug;
  }

  try {
    setStatus('redisJobsStatus', popupState.editorMode === 'edit' ? 'Updating Redis job...' : 'Creating Redis job...', 'info');
    if (popupState.editorMode === 'edit' && popupState.editingScheduleId) {
      await requestJson(`/api/v1/agent/schedules/${encodeURIComponent(popupState.editingScheduleId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          pattern: draft.schedule,
          taskData,
        }),
      });
      await loadRedisJobsWorkspace();
      setStatus('redisJobsStatus', `Updated Redis job ${popupState.editingScheduleId}.`, 'success');
    } else {
      await requestJson('/api/v1/agent/schedule-task', {
        method: 'POST',
        body: JSON.stringify({
          taskType: draft.taskType,
          schedule: draft.schedule,
          taskData,
        }),
      });
      await loadRedisJobsWorkspace();
      setStatus('redisJobsStatus', `Created Redis job ${draft.taskType}.`, 'success');
    }
    resetRedisJobEditor();
  } catch (error) {
    setStatus('redisJobsStatus', `Redis job save failed: ${toMessage(error)}`, 'error');
  }
}

async function handleRedisJobAction(action, scheduleId) {
  const normalizedAction = readString(action);
  const normalizedScheduleId = readString(scheduleId);
  if (!normalizedAction || !normalizedScheduleId) {
    return;
  }

  if (normalizedAction === 'edit') {
    const schedule = popupState.schedules.find((entry) => readString(entry?.id) === normalizedScheduleId);
    if (schedule) {
      populateRedisJobEditor(schedule);
      setStatus('redisJobsStatus', `Editing Redis job ${normalizedScheduleId}.`, 'info');
    }
    return;
  }

  const endpoint = {
    pause: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}/pause`,
    resume: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}/resume`,
    trigger: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}/trigger`,
    delete: `/api/v1/agent/schedules/${encodeURIComponent(normalizedScheduleId)}`,
  }[normalizedAction];

  if (!endpoint) {
    return;
  }

  const method = normalizedAction === 'delete' ? 'DELETE' : 'POST';
  try {
    setStatus('redisJobsStatus', `${capitalize(normalizedAction)} Redis job ${normalizedScheduleId}...`, 'info');
    await requestJson(endpoint, { method });
    await loadRedisJobsWorkspace();
    if (normalizedAction === 'delete' && popupState.editingScheduleId === normalizedScheduleId) {
      resetRedisJobEditor();
    }
    setStatus('redisJobsStatus', `${capitalize(normalizedAction)}d Redis job ${normalizedScheduleId}.`, 'success');
  } catch (error) {
    setStatus('redisJobsStatus', `Redis job action failed: ${toMessage(error)}`, 'error');
  }
}

function getScheduleTargetAgentId(schedule) {
  return readString(schedule?.taskData?.targetAgent) || popupState.defaultAgentId;
}

function readInputValue(id) {
  const node = document.getElementById(id);
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    return node.value.trim();
  }
  return '';
}

function setInputValue(id, value) {
  const node = document.getElementById(id);
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    node.value = value;
  }
}

function setStatus(id, message, tone) {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement)) {
    return;
  }
  node.textContent = message || '';
  if (tone) {
    node.setAttribute('data-tone', tone);
  } else {
    node.removeAttribute('data-tone');
  }
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node instanceof HTMLElement) {
    node.textContent = value || '';
  }
}

function formatDate(value) {
  if (!value) {
    return 'not recorded';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function truncateText(value, limit) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function capitalize(value) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : '';
}

function humanizeIdentifier(value) {
  const normalized = readString(value);
  if (!normalized) {
    return 'Unnamed Job';
  }
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function describeCronRule(value, nextRun = '', short = false) {
  const cron = readString(value);
  if (!cron) {
    return 'Choose a run time for this event.';
  }

  const everyMinutes = cron.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyMinutes) {
    const count = Number(everyMinutes[1]);
    return short ? `Every ${count} minutes` : `Runs every ${count} minutes.`;
  }

  if (cron === '0 * * * *') {
    return short ? 'Every hour' : 'Runs every hour.';
  }

  const everyHours = cron.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (everyHours) {
    const count = Number(everyHours[1]);
    return short ? `Every ${count} hours` : `Runs every ${count} hours.`;
  }

  const daily = cron.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (daily) {
    const time = formatTimeOfDay(daily[2], daily[1]);
    return short ? `Every day at ${time}` : `Runs every day at ${time}.`;
  }

  const weekly = cron.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([0-6,-]+)$/);
  if (weekly) {
    const time = formatTimeOfDay(weekly[2], weekly[1]);
    const dayLabel = describeDayOfWeekField(weekly[3]);
    const base = `${dayLabel} at ${time}`;
    return short ? base : `Runs ${base}.${nextRun ? ` Next run ${formatDate(nextRun)}.` : ''}`;
  }

  return short
    ? `Custom rule ${cron}`
    : `Runs using the custom rule ${cron}.${nextRun ? ` Next run ${formatDate(nextRun)}.` : ''}`;
}

function formatTimeOfDay(hourValue, minuteValue) {
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return `${hourValue}:${minuteValue}`;
  }

  const normalizedHour = ((hour % 24) + 24) % 24;
  const suffix = normalizedHour >= 12 ? 'PM' : 'AM';
  const twelveHour = normalizedHour % 12 || 12;
  return `${twelveHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function describeDayOfWeekField(value) {
  const normalized = readString(value);
  if (normalized === '1-5') {
    return 'every weekday';
  }

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayIndexes = normalized.split(',').map((segment) => Number(segment)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (dayIndexes.length === 1) {
    return `every ${dayNames[dayIndexes[0]]}`;
  }
  if (dayIndexes.length > 1) {
    return `on ${dayIndexes.map((day) => dayNames[day]).join(', ')}`;
  }
  return `on schedule ${normalized}`;
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted standalone chat history popup controller with persisted usage analytics and delete/reload actions
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Routed embedded cockpit history restores back through the cockpit rail so task loads keep embed mode and selected-bot context intact
 */

import {
  asFloat,
  asInt,
  escapeHtml,
  formatDateTime,
  readRecord,
  readString,
  requestJson,
  toMessage,
} from '/chat-assets/chat-workspace-popups-utils.mjs';
import { createUiLogger } from '../../shared/ui-debug.js';

const logger = createUiLogger('chat-history-popup');

const HISTORY_POPUP_CSS = `
  .history-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px; }
  .history-summary { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; margin-bottom: 10px; }
  .history-stat {
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    padding: 10px 12px;
    background: linear-gradient(145deg, var(--glass-bg-heavy), var(--glass-bg));
    box-shadow: var(--card-shadow);
  }
  .history-stat-label { display: block; color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
  .history-stat-value { color: var(--text-primary); font-size: 15px; font-weight: 600; }
  .history-list { max-height: min(62vh, 580px); overflow: auto; display: grid; gap: 10px; }
  .history-item {
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    padding: 12px;
    background: linear-gradient(145deg, var(--glass-bg-heavy), var(--glass-bg));
    box-shadow: var(--card-shadow);
  }
  .history-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
  .history-title { font-weight: 600; color: var(--text-primary); }
  .history-id { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; color: var(--text-dim); font-size: 11px; }
  .history-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--text-dim); margin-bottom: 10px; }
  .history-breakdown { display: grid; grid-template-columns: repeat(4, minmax(110px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .history-breakdown-item {
    border-radius: 10px;
    background: var(--glass-bg);
    padding: 8px 10px;
  }
  .history-breakdown-item strong { display: block; color: var(--text-primary); font-size: 13px; }
  .history-breakdown-item span { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  .history-models { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .history-model-chip {
    border: 1px solid color-mix(in srgb, var(--accent-primary) 28%, var(--glass-border));
    border-radius: 999px;
    padding: 4px 8px;
    background: color-mix(in srgb, var(--accent-primary) 12%, var(--glass-bg));
    color: var(--text-primary);
    font-size: 11px;
  }
  .history-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .history-empty { color: var(--text-dim); font-size: 12px; padding: 16px; border: 1px dashed color-mix(in srgb, var(--accent-primary) 28%, var(--glass-border)); border-radius: 10px; text-align: center; }
  @media (max-width: 960px) {
    .history-summary, .history-breakdown { grid-template-columns: 1fr 1fr; }
  }
`;
const COCKPIT_LOAD_TASK_EVENT = 'oshal-cockpit-load-task';

/**
 * @description Initializes the standalone chat conversation-history popup.
 * Adds durable task analytics, reload/delete actions, and task restore navigation.
 *
 * @param options - Runtime dependencies needed to wire the popup into the chat shell
 * @param options.defaultAgentId - Agent scope used for task-history queries
 * @param options.historyLimit - Maximum tasks to fetch into the modal
 * @param options.closeModal - Callback for hiding sibling workspace modals before history opens
 * @returns Void after wiring the popup
 */
export function initializeChatHistoryPopup(options) {
  logger.info('Initializing chat history popup', {
    defaultAgentId: options.defaultAgentId,
    historyLimit: options.historyLimit,
  });
  injectHistoryStyles();
  ensureHistoryModal();
  bindHistoryOpen(options);
  bindHistoryClose();
  bindHistoryActions(options);
}

function injectHistoryStyles() {
  if (document.getElementById('chatHistoryPopupStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'chatHistoryPopupStyle';
  style.textContent = HISTORY_POPUP_CSS;
  document.head.appendChild(style);
}

function ensureHistoryModal() {
  if (document.getElementById('historyModal')) {
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'historyModal';
  modal.className = 'config-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="config-modal-backdrop" data-close-for="historyModal"></div>
    <div class="config-modal-dialog" role="dialog" aria-modal="true">
      <div class="config-modal-header">
        <div class="config-modal-title">
          <strong><span class="codicon codicon-gear"></span>Conversation History</strong>
          <span>Review durable chat history, usage totals, and restore or remove conversations.</span>
        </div>
        <div class="config-modal-actions">
          <button class="btn-sm" type="button" data-close-for="historyModal">Close</button>
        </div>
      </div>
      <div class="service-status" id="historyStatus"></div>
      <div class="history-toolbar">
        <span class="status-pill">Agent-scoped task history</span>
        <button class="mini-btn" type="button" id="refreshHistoryBtn">Refresh</button>
      </div>
      <div class="history-summary" id="historySummary"></div>
      <div class="history-list" id="historyList"></div>
    </div>
  `;
  document.body.appendChild(modal);
}

function bindHistoryOpen(options) {
  const button = document.getElementById('openHistoryModalBtn');
  if (!button) {
    return;
  }

  button.addEventListener('click', () => {
    options.closeModal('ragModal');
    const modal = document.getElementById('historyModal');
    if (modal) {
      modal.hidden = false;
    }
    void loadHistory(options.defaultAgentId, options.historyLimit);
  });
}

function bindHistoryClose() {
  document.querySelectorAll('[data-close-for="historyModal"]').forEach((node) => {
    node.addEventListener('click', () => {
      const modal = document.getElementById('historyModal');
      if (modal) {
        modal.hidden = true;
      }
    });
  });
}

function bindHistoryActions(options) {
  const refresh = document.getElementById('refreshHistoryBtn');
  const list = document.getElementById('historyList');

  if (refresh) {
    refresh.addEventListener('click', () => {
      void loadHistory(options.defaultAgentId, options.historyLimit);
    });
  }

  if (!list) {
    return;
  }

  list.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const loadButton = target.closest('[data-load-task-id]');
    if (loadButton) {
      navigateToTask(loadButton.getAttribute('data-load-task-id'));
      return;
    }
    const deleteButton = target.closest('[data-delete-task-id]');
    if (deleteButton) {
      void deleteConversation(deleteButton.getAttribute('data-delete-task-id'), options.defaultAgentId, options.historyLimit);
    }
  });
}

async function loadHistory(defaultAgentId, historyLimit) {
  logger.info('Loading chat history', {
    defaultAgentId,
    historyLimit,
  });
  setStatus('historyStatus', 'Loading conversation history...', 'info');
  const list = document.getElementById('historyList');
  if (!list) {
    return;
  }

  try {
    const response = await requestJson(`/api/tasks?agentId=${encodeURIComponent(defaultAgentId)}&limit=${historyLimit}`);
    const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
    renderHistory(tasks);
    setStatus('historyStatus', `Loaded ${tasks.length} conversations.`, 'success');
    logger.info('Loaded chat history', {
      defaultAgentId,
      count: tasks.length,
    });
  } catch (error) {
    logger.warn('Failed to load chat history', {
      error: toMessage(error),
    });
    renderHistory([]);
    setStatus('historyStatus', `History load failed: ${toMessage(error)}`, 'error');
  }
}

function renderHistory(tasks) {
  const list = document.getElementById('historyList');
  const summary = document.getElementById('historySummary');
  if (!list || !summary) {
    return;
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    summary.innerHTML = '';
    list.innerHTML = '<div class="history-empty">No conversation history yet for this agent.</div>';
    return;
  }

  summary.innerHTML = buildHistorySummary(tasks);
  list.innerHTML = tasks.map((task) => buildHistoryCard(task)).join('');
}

function buildHistorySummary(tasks) {
  const totals = tasks.reduce((accumulator, task) => {
    accumulator.totalCost += asFloat(task.totalCost);
    accumulator.totalTokens += readTaskTotalTokens(task);
    accumulator.totalMessages += asInt(task.messageCount);
    return accumulator;
  }, { totalCost: 0, totalTokens: 0, totalMessages: 0 });

  return [
    buildHistoryStat('Conversations', String(tasks.length)),
    buildHistoryStat('Messages', totals.totalMessages.toLocaleString()),
    buildHistoryStat('Tokens', totals.totalTokens.toLocaleString()),
    buildHistoryStat('Cost', formatCostValue(totals.totalCost, 'USD')),
  ].join('');
}

function buildHistoryCard(task) {
  const taskId = readString(task.taskId) || 'unknown-task';
  const inputTokens = asInt(task.totalInputTokens);
  const outputTokens = asInt(task.totalOutputTokens);
  const currency = readString(task.costCurrency) || 'USD';

  return `
    <article class="history-item">
      <div class="history-head">
        <div>
          <div class="history-title">${escapeHtml(readString(task.title) || 'Untitled Conversation')}</div>
          <div class="history-id">${escapeHtml(taskId)}</div>
        </div>
        <span class="status-pill">${escapeHtml(readString(task.status) || 'unknown')}</span>
      </div>
      <div class="history-meta">
        <span>Updated: ${escapeHtml(formatDateTime(readString(task.updatedAt)))}</span>
        <span>Input: ${inputTokens.toLocaleString()} tok</span>
        <span>Output: ${outputTokens.toLocaleString()} tok</span>
        <span>Cost: ${escapeHtml(formatCostValue(asFloat(task.totalCost), currency))}</span>
      </div>
      <div class="history-breakdown">
        ${buildHistoryBreakdownItem('Messages', asInt(task.messageCount).toLocaleString())}
        ${buildHistoryBreakdownItem('Turns', asInt(task.turnCount).toLocaleString())}
        ${buildHistoryBreakdownItem('Requests', asInt(task.totalRequests).toLocaleString())}
        ${buildHistoryBreakdownItem('Total Tokens', readTaskTotalTokens(task).toLocaleString())}
      </div>
      <div class="history-models">${buildUsageModelSummary(task.usageByModel)}</div>
      <div class="history-actions">
        <button class="mini-btn" type="button" data-load-task-id="${escapeHtml(taskId)}">Load Conversation</button>
        <button class="mini-btn" type="button" data-delete-task-id="${escapeHtml(taskId)}">Delete</button>
      </div>
    </article>
  `;
}

function buildHistoryStat(label, value) {
  return `<div class="history-stat"><span class="history-stat-label">${escapeHtml(label)}</span><span class="history-stat-value">${escapeHtml(value)}</span></div>`;
}

function buildHistoryBreakdownItem(label, value) {
  return `<div class="history-breakdown-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function buildUsageModelSummary(usageByModel) {
  const usageRecord = readRecord(usageByModel);
  const chips = Object.entries(usageRecord)
    .slice(0, 4)
    .map(([model, stats]) => {
      const totalTokens = asInt(stats?.totalTokens);
      const requestCount = asInt(stats?.requestCount);
      return `<span class="history-model-chip">${escapeHtml(model)} · ${totalTokens.toLocaleString()} tok · ${requestCount.toLocaleString()} req</span>`;
    });

  return chips.length > 0 ? chips.join('') : '<span class="history-model-chip">No model telemetry yet</span>';
}

function navigateToTask(taskId) {
  if (!taskId) {
    return;
  }

  if (isCockpitEmbedded()) {
    window.parent?.postMessage(
      { type: COCKPIT_LOAD_TASK_EVENT, taskId },
      window.location.origin,
    );
    return;
  }

  window.location.href = buildStandaloneTaskUrl(taskId);
}

async function deleteConversation(taskId, defaultAgentId, historyLimit) {
  if (!taskId || !window.confirm(`Delete conversation ${taskId}?`)) {
    return;
  }

  setStatus('historyStatus', 'Deleting conversation...', 'info');

  try {
    await requestJson(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    await loadHistory(defaultAgentId, historyLimit);
    setStatus('historyStatus', 'Conversation deleted.', 'success');
  } catch (error) {
    setStatus('historyStatus', `Delete failed: ${toMessage(error)}`, 'error');
  }
}

function readTaskTotalTokens(task) {
  return asInt(task.totalTokens) || asInt(task.totalInputTokens) + asInt(task.totalOutputTokens);
}

function formatCostValue(totalCost, currency) {
  const prefix = currency === 'USD' ? '$' : `${currency} `;
  return `${prefix}${totalCost.toFixed(6)}`;
}

function setStatus(statusId, message, tone) {
  const node = document.getElementById(statusId);
  if (!node) {
    return;
  }
  node.textContent = message || '';
  if (tone) {
    node.setAttribute('data-tone', tone);
    return;
  }
  node.removeAttribute('data-tone');
}

/**
 * @description Detect whether the history popup is running inside the cockpit-embedded chat route.
 * @returns {boolean} True when the active chat page is mounted inside `/cockpit/`.
 */
function isCockpitEmbedded() {
  return document.documentElement.getAttribute('data-embedded') === 'cockpit';
}

/**
 * @description Build the standalone chat route for one historical task.
 * @param {string} taskId - Persisted task identifier.
 * @returns {string} Standalone chat route that restores the requested task.
 */
function buildStandaloneTaskUrl(taskId) {
  return `/chat?taskId=${encodeURIComponent(taskId)}`;
}

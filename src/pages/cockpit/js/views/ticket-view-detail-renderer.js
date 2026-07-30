/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit ticket detail and tab rendering so the main ticket view can stay under the file cap while adding root-ticket project reassignment controls
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added subtask source badges to feed entries so rolled-up child activity shows provenance in the timeline
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added collapsible subtask grouping in the activity feed so rolled-up child entries are organized by source ticket instead of mixed flat
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Process tracker: added Process tab with status history timeline fetched from GET /api/v1/tickets/:id/history
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added escalated-ticket reason panels, Redis/routing remediation hints, and dedicated de-escalation actions to the cockpit detail surface
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cost tab and escalation panel rendering helpers, then added contributing-bot badges and a Cost by Bot table to the cockpit ticket detail surface
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Moved feed-entry rendering to a dedicated module so task result replies can promote output-folder links without growing the ticket detail renderer past the file cap.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | De-brand: the RCA tab fetched a retired legacy incidents-compare endpoint (a 404 since those routes were archived). Rewrote renderRcaTab to an honest, backend-free panel pointing to the incident workspace deliverables/ folder, and deleted the now-orphaned helpers (buildRcaDeliverablesMarkup, buildRcaAlarmTable, buildOshalDeliverablesSection, bindRcaActions, escapeAttr). A real in-cockpit deliverables view returns with the ADR-069 operations rebuild.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Fixed the detail pane's universal render crash: timeAgo() is used at three sites but was missing from the formatters import, so every ticket detail render threw ReferenceError and stuck on "Loading...". Guarded by the un-quarantined ticket-activity-rollup + ticket-cost-rollup-by-bot e2e specs.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Dispatch the new Run Trace sub-screen to ticket-view-trace-renderer.js (its own module — this file is already inside the 800-line warn band), so the embeddable /api/trace/:ticketId.html waterfall shows on the ticket the operator has open instead of only in the standalone paste-an-id tool.
 */

import { formatCost, getStatusClass, getStatusLabel, timeAgo, truncate } from '../utils/formatters.js';
import { createUiLogger, serializeUiError } from '../../../shared/ui-debug.js';
import {
  buildCodeServerWorkspacePath,
  buildInfoNote,
  buildInlineEmptyState,
  buildStateOptions,
  joinWorkspacePath,
  normalizeWorkflowState,
  resolveWorkspaceDisplayPath,
  stateLabel,
} from './ticket-view-helpers.js';
import { renderCostTab } from './ticket-view-cost-renderer.js';
import { renderTraceTab } from './ticket-view-trace-renderer.js';
import { buildEscalationPanelMarkup } from './ticket-view-escalation-panel.js';
import { resolveDetailTabs } from './ticket-detail-tabs.js';
import { buildFeedEntriesHtml } from './ticket-result-feed-entry.js';

const logger = createUiLogger('cockpit-ticket-view-detail-renderer');

/**
 * @description Renders one ticket detail pane and wires all active controls.
 * @param view - Active TicketView instance.
 * @param ticket - Normalized ticket detail object.
 * @param timeline - Ticket activity timeline.
 * @param costData - Ticket cost telemetry payload.
 * @param options - Optional degraded-state rendering flags.
 * @returns Promise resolving once the initial tab has rendered.
 */
export async function renderTicketDetail(view, ticket, timeline, costData, options = {}) {
  const pane = view.container.querySelector('#tvDetailPane');
  if (!pane) return;

  const hydratedTicket = hydrateTicket(view, ticket);
  const parentTicket = view._findParentTicket(hydratedTicket.parentId);
  const state = normalizeWorkflowState(hydratedTicket.state);
  logger.info('Rendering cockpit ticket detail', {
    ticketId: hydratedTicket.id,
    state,
    timelineCount: Array.isArray(timeline) ? timeline.length : 0,
  });

  pane.innerHTML = buildDetailMarkup(view, hydratedTicket, state, parentTicket, costData, options);
  hydratedTicket.state = state;

  await renderTicketTab(view, 'feed', hydratedTicket, timeline, costData);
  bindDetailInteractions(view, pane, hydratedTicket, timeline, costData, parentTicket);
}

/**
 * @description Renders one active ticket detail tab.
 * @param view - Active TicketView instance.
 * @param tab - Active tab key.
 * @param ticket - Normalized ticket detail object.
 * @param timeline - Ticket activity timeline.
 * @param costData - Ticket cost telemetry payload.
 * @returns Promise resolving after the tab content is rendered.
 */
export async function renderTicketTab(view, tab, ticket, timeline, costData) {
  const body = view.container.querySelector('#tvDetailBody');
  if (!body) return;

  logger.debug('Rendering cockpit ticket detail tab', {
    ticketId: ticket.id,
    tab,
  });

  if (tab === 'feed') {
    renderFeedTab(view, body, ticket, timeline);
    return;
  }
  if (tab === 'description') {
    renderDescriptionTab(view, body, ticket);
    return;
  }
  if (tab === 'artifacts') {
    await renderArtifactsTab(view, body, ticket);
    return;
  }
  if (tab === 'process') {
    await renderProcessTab(view, body, ticket, timeline);
    return;
  }
  if (tab === 'rca') {
    await renderRcaTab(view, body, ticket);
    return;
  }
  if (tab === 'trace') {
    await renderTraceTab(body, ticket);
    return;
  }
  renderCostTab(body, ticket, costData);
}

function hydrateTicket(view, ticket) {
  const listTicket = view._findTicket(ticket.id);
  if (!ticket.ticketType) {
    ticket.ticketType = ticket.ticket_type || ticket.type
      || listTicket?.ticketType || listTicket?.ticket_type || listTicket?.type || '';
  }
  if (listTicket?.description && !ticket.description) {
    ticket.description = listTicket.description;
  }
  if (listTicket?.parentId && !ticket.parentId) {
    ticket.parentId = listTicket.parentId;
  }
  if (listTicket?.projectId && !ticket.projectId) {
    ticket.projectId = listTicket.projectId;
  }
  if (listTicket?.projectIdentifier && !ticket.projectIdentifier) {
    ticket.projectIdentifier = listTicket.projectIdentifier;
  }
  if (listTicket?.workspaceSlug && !ticket.workspaceSlug) {
    ticket.workspaceSlug = listTicket.workspaceSlug;
  }
  if (listTicket?.project && !ticket.project) {
    ticket.project = listTicket.project;
  }
  return ticket;
}

function buildDetailMarkup(view, ticket, state, parentTicket, costData, options) {
  const isRoot = !ticket.parentId;
  const escalationPanel = state === 'escalated' ? buildEscalationPanelMarkup(ticket) : '';
  const contributingBotsMarkup = buildContributingBotsMarkup(costData);
  const projectControls = isRoot
    ? buildRootProjectControls(view, ticket)
    : buildInfoNote('folder-open', `Project ${ticket.project || 'Default'} is inherited from the root ticket${parentTicket ? ` #${parentTicket.sequenceId}` : ''}.`, 'data-ticket-project-note');

  return `
    <div class="td-header">
      <div class="td-header-row">
        <span class="td-id">#${ticket.sequenceId}</span>
        <span class="status-pill ${getStatusClass(state)}" style="font-size:11px;padding:2px 8px;border-radius:var(--radius-pill)">${getStatusLabel(state)}</span>
      </div>
      <div class="td-title">${ticket.name}</div>
      <div class="td-meta-row">
        <span class="td-meta-item"><i class="ph ph-user"></i> ${ticket.assignee || 'unassigned'}</span>
        <span class="td-meta-item"><i class="ph ph-clock"></i> Created ${timeAgo(ticket.createdAt)}</span>
        <span class="td-meta-item"><i class="ph ph-clock-clockwise"></i> Updated ${timeAgo(ticket.updatedAt)}</span>
        <span class="td-meta-item"><i class="ph ph-currency-dollar"></i> ${formatCost(readCostNumber(costData.totalCost || costData.estimatedCost || ticket.cost))}</span>
      </div>
      ${contributingBotsMarkup}
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
        ${projectControls}
        ${parentTicket ? `<button class="td-action-btn" id="tvParentTicketBtn" style="align-self:flex-start"><i class="ph ph-arrow-bend-up-left"></i> Parent Ticket #${parentTicket.sequenceId}: ${truncate(parentTicket.name, 42)}</button>` : ''}
        ${escalationPanel}
      </div>
      ${options.degradedNotice || ''}
    </div>
    <div class="td-actions">
      ${buildActionSelectMarkup(state)}
      <button class="td-action-btn" id="tvRespondBtn"><i class="ph ph-chat-circle"></i> Respond</button>
      ${isRoot ? `<button class="td-action-btn danger" id="tvDeleteBtn"><i class="ph ph-trash"></i> Delete</button>` : ''}
    </div>
    ${isRoot ? '' : `<div id="tvChildActionNote" style="display:flex;align-items:center;gap:8px;padding:10px 12px;margin-top:12px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:rgba(255,255,255,0.02);color:var(--text-muted);font-size:12px"><i class="ph ph-info"></i><span>Subtask deletion and shared workspace management stay anchored to the parent ticket${parentTicket ? ` #${parentTicket.sequenceId}` : ''}.</span></div>`}
    <div class="td-tabs">
      ${buildDetailTabsMarkup(view, ticket)}
    </div>
    <div class="td-body" id="tvDetailBody"></div>`;
}

/**
 * @description Build the detail sub-screen (tab) buttons for a ticket, showing only the screens that
 * apply to its process. Process is taken from the ticket's own type, falling back to the active
 * swarm-app's ticketType (the `?app=` context the list view resolved). The first visible tab is active.
 * @param view - Active TicketView instance (carries `_activeTicketType` from the app context).
 * @param ticket - Normalized ticket detail object.
 * @returns HTML string of `.td-tab` buttons.
 */
function buildDetailTabsMarkup(view, ticket) {
  const ticketType = ticket.ticketType || view?._activeTicketType || '';
  return resolveDetailTabs(ticketType)
    .map((tab, index) => `<button class="td-tab${index === 0 ? ' active' : ''}" data-tab="${tab.key}">${tab.iconHtml || ''}${tab.label}${tab.extraHtml || ''}</button>`)
    .join('');
}

function buildRootProjectControls(view, ticket) {
  const projects = dedupeProjects(view.projects || [], ticket);
  const currentProjectId = String(ticket.projectId || '').trim()
    || String(ticket.project || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const options = projects
    .map((project) => `<option value="${project.id}"${project.id === currentProjectId ? ' selected' : ''}>${project.name}</option>`)
    .join('');

  return `<div id="tvProjectControls" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
    <span class="td-meta-item" id="tvProjectBadge"><i class="ph ph-folder"></i> Project: ${ticket.project || 'Default'}</span>
    <select class="td-state-select" id="tvProjectMoveSelect" style="min-width:180px">${options}</select>
    <input id="tvProjectCustomName" type="text" placeholder="New project name" style="min-width:180px;padding:8px 10px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:var(--glass-bg);color:var(--text-primary);font-size:12px;font-family:var(--font-family)" />
    <button class="td-action-btn" id="tvProjectMoveBtn"><i class="ph ph-folder-simple-plus"></i> Apply Project</button>
  </div>`;
}

function buildContributingBotsMarkup(costData) {
  const bots = Array.isArray(costData?.contributingBots) ? costData.contributingBots.filter(Boolean) : [];
  if (!bots.length) {
    return '';
  }

  return `<div class="td-meta-row" style="margin-top:8px;flex-wrap:wrap"><span class="td-meta-item"><i class="ph ph-robot"></i> Contributing Bots</span>${bots.map((bot) => `<span class="td-meta-item" style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.16);border-radius:var(--radius-pill);padding:4px 8px"><i class="ph ph-cpu"></i> ${escapeHtml(bot.agentName || bot.agentId || 'unknown')} · ${formatCost(readCostNumber(bot.totalCost))}</span>`).join('')}</div>`;
}

function dedupeProjects(projects, ticket) {
  const map = new Map();
  projects.forEach((project) => {
    const id = String(project?.id || project?.projectId || '').trim();
    const name = String(project?.name || project?.identifier || id || '').trim();
    if (!id || !name) return;
    map.set(id, { id, name });
  });

  const fallbackId = String(ticket.projectId || '').trim();
  const fallbackName = String(ticket.project || '').trim();
  if (fallbackId && fallbackName && !map.has(fallbackId)) {
    map.set(fallbackId, { id: fallbackId, name: fallbackName });
  }
  if (!map.has('default')) {
    map.set('default', { id: 'default', name: 'Default' });
  }

  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function buildActionSelectMarkup(state) {
  const stateOptions = buildStateOptions(state);
  return `<select class="td-state-select" id="tvStateSelect" data-original="${state}">${stateOptions.map((option) => `<option value="${option.value}"${option.value === state ? ' selected' : ''}>${option.label}</option>`).join('')}</select>`;
}

function bindDetailInteractions(view, pane, ticket, timeline, costData, parentTicket) {
  bindTabs(view, pane, ticket, timeline, costData);
  bindStateChange(view, pane, ticket, timeline, costData);
  bindRespond(view, ticket, timeline, costData);
  bindDelete(view, ticket);
  bindParentJump(view, pane, parentTicket);
  bindRetryDetail(view, pane, ticket);
  bindProjectMove(view, pane, ticket);
  bindEscalationActions(view, pane, ticket, timeline, costData);
}

function bindTabs(view, pane, ticket, timeline, costData) {
  pane.querySelectorAll('.td-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      pane.querySelectorAll('.td-tab').forEach((button) => {
        button.classList.toggle('active', button.dataset.tab === tab.dataset.tab);
      });
      void renderTicketTab(view, tab.dataset.tab, ticket, timeline, costData);
    });
  });
}

function bindStateChange(view, pane, ticket, timeline, costData) {
  pane.querySelector('#tvStateSelect')?.addEventListener('change', async (event) => {
    const select = event.target;
    const newState = select.value;
    const originalValue = select.dataset.original || select.value;
    const activeTab = pane.querySelector('.td-tab.active')?.dataset.tab || 'feed';
    select.disabled = true;
    try {
      await view.api.updateTicketState(ticket.id, newState);
      ticket.state = newState;
      ticket.updatedAt = new Date().toISOString();
      select.dataset.original = newState;
      view._syncTicketRecord(ticket.id, (record) => {
        record.state = newState;
        record.rawStatus = newState;
        record.updatedAt = ticket.updatedAt;
      });
      view._refreshTicketListSelection();
      if (originalValue === 'escalated' || newState === 'escalated') {
        if (newState !== 'escalated') {
          ticket.escalation = null;
        }
        await rerenderDetailPreservingActiveTab(view, ticket, timeline, costData, activeTab);
      } else {
        updateStatusPill(pane, newState);
      }
      view.showToast(`Ticket moved to ${getStatusLabel(newState)}`, 'success');
    } catch (error) {
      view._logWarning('update-ticket-state-failed', error, { ticketId: ticket.id, newState });
      select.value = originalValue;
      view.showToast(`Status update failed: ${view._errorMessage(error)}`, 'error');
    } finally {
      select.disabled = false;
    }
  });
}

function bindRespond(view, ticket, timeline, costData) {
  view.container.querySelector('#tvRespondBtn')?.addEventListener('click', () => {
    setActiveTab(view, 'feed', ticket, timeline, costData);
    window.requestAnimationFrame(() => view._focusReplyComposer());
    view.showToast('Reply composer focused', 'info');
  });
}

function bindDelete(view, ticket) {
  view.container.querySelector('#tvDeleteBtn')?.addEventListener('click', () => {
    view._confirmDelete({
      ...ticket,
      onDelete: async () => {
        try {
          await view.api.delete(`/api/v1/tickets/${encodeURIComponent(ticket.id)}`);
          view.selectedId = null;
          view.tickets = view.tickets.filter((row) => row.id !== ticket.id);
          view._renderList();
          const detailPane = view.container.querySelector('#tvDetailPane');
          if (detailPane) {
            detailPane.innerHTML = '<div class="ticket-detail-empty"><i class="ph ph-envelope-open"></i><span>Ticket deleted</span></div>';
          }
          view.showToast('Ticket deleted', 'success');
        } catch (error) {
          view._logWarning('delete-ticket-failed', error, { ticketId: ticket.id });
          view.showToast(`Delete failed: ${view._errorMessage(error)}`, 'error');
          await view.loadTickets();
        }
      },
    });
  });
}

function bindParentJump(view, pane, parentTicket) {
  pane.querySelector('#tvParentTicketBtn')?.addEventListener('click', () => {
    if (parentTicket?.id) {
      void view._selectTicket(parentTicket.id);
    }
  });
}

function bindRetryDetail(view, pane, ticket) {
  pane.querySelector('#tvRetryDetailBtn')?.addEventListener('click', () => {
    void view._selectTicket(ticket.id);
  });
}

function bindProjectMove(view, pane, ticket) {
  const moveButton = pane.querySelector('#tvProjectMoveBtn');
  if (!(moveButton instanceof HTMLButtonElement)) {
    return;
  }

  moveButton.addEventListener('click', async () => {
    const select = pane.querySelector('#tvProjectMoveSelect');
    const input = pane.querySelector('#tvProjectCustomName');
    const customName = input instanceof HTMLInputElement ? input.value.trim() : '';
    const selectedProjectId = select instanceof HTMLSelectElement ? select.value.trim() : '';
    await view._moveRootTicketToProject(ticket, { customName, selectedProjectId, button: moveButton, input, select });
  });
}

function bindEscalationActions(view, pane, ticket, timeline, costData) {
  const deescalateButton = pane.querySelector('#tvDeescalateBtn');
  if (!(deescalateButton instanceof HTMLButtonElement)) {
    return;
  }

  deescalateButton.addEventListener('click', async () => {
    const activeTab = pane.querySelector('.td-tab.active')?.dataset.tab || 'feed';
    deescalateButton.disabled = true;
    deescalateButton.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Returning to queue...';

    try {
      await view.api.updateTicketState(ticket.id, 'approved');
      ticket.state = 'approved';
      ticket.updatedAt = new Date().toISOString();
      ticket.escalation = null;
      view._syncTicketRecord(ticket.id, (record) => {
        record.state = 'approved';
        record.rawStatus = 'approved';
        record.updatedAt = ticket.updatedAt;
      });
      view._refreshTicketListSelection();
      await rerenderDetailPreservingActiveTab(view, ticket, timeline, costData, activeTab);
      view.showToast('Ticket de-escalated and returned to Approved', 'success');
    } catch (error) {
      view._logWarning('deescalate-ticket-failed', error, { ticketId: ticket.id });
      deescalateButton.disabled = false;
      deescalateButton.innerHTML = '<i class="ph ph-arrow-u-up-left"></i> De-escalate to Approved';
      view.showToast(`De-escalation failed: ${view._errorMessage(error)}`, 'error');
    }
  });
}

function setActiveTab(view, tab, ticket, timeline, costData) {
  view.container.querySelectorAll('.td-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  void renderTicketTab(view, tab, ticket, timeline, costData);
}

async function rerenderDetailPreservingActiveTab(view, ticket, timeline, costData, activeTab = 'feed') {
  await renderTicketDetail(view, ticket, timeline, costData);
  if (activeTab && activeTab !== 'feed') {
    setActiveTab(view, activeTab, ticket, timeline, costData);
  }
}

function buildSubtaskTreeHtml(subtaskGroups, ticket) {
  if (subtaskGroups.size === 0) return '';
  let html = `<div style="margin-top:16px;border-top:1px solid var(--border-color);padding-top:12px"><div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;display:flex;align-items:center;gap:6px"><i class="ph ph-git-branch"></i> Subtask Activity (${subtaskGroups.size} subtask${subtaskGroups.size !== 1 ? 's' : ''})</div>`;
  for (const [seqId, group] of subtaskGroups) {
    const entryCount = group.entries.length;
    const latestTs = group.entries[0]?.timestamp || group.entries[0]?.created_at || '';
    const latestStr = latestTs ? timeAgo(latestTs) : '';
    html += `<details class="subtask-tree-group" style="margin-bottom:6px;border:1px solid var(--border-color);border-radius:var(--radius-md);background:var(--glass-bg)"><summary style="cursor:pointer;padding:8px 12px;font-size:12px;display:flex;align-items:center;gap:8px;list-style:none"><span style="font-size:10px;color:var(--text-muted)">▶</span><span style="font-size:10px;padding:1px 6px;border-radius:var(--radius-pill);background:var(--accent-primary);color:#fff">↳ #${seqId}</span><span style="flex:1;font-weight:500">${truncate(group.name, 40)}</span><span style="font-size:10px;color:var(--text-muted)">${entryCount} entr${entryCount !== 1 ? 'ies' : 'y'}${latestStr ? ` · ${latestStr}` : ''}</span></summary><div style="padding:8px 12px;border-top:1px solid var(--border-color)">${buildFeedEntriesHtml(group.entries, ticket)}</div></details>`;
  }
  html += '</div>';
  return html;
}

function renderFeedTab(view, body, ticket, timeline) {
  const sorted = [...timeline].sort((left, right) => {
    const leftTime = new Date(left.timestamp || left.createdAt || left.created_at || 0).getTime();
    const rightTime = new Date(right.timestamp || right.createdAt || right.created_at || 0).getTime();
    return rightTime - leftTime;
  });

  // Separate own entries from child-ticket rolled-up entries
  const ownEntries = sorted.filter(e => !e.sourceSequenceId);
  const childEntries = sorted.filter(e => e.sourceSequenceId);
  const subtaskGroups = new Map();
  for (const entry of childEntries) {
    const key = entry.sourceSequenceId;
    if (!subtaskGroups.has(key)) {
      subtaskGroups.set(key, { name: entry.sourceTicketName || `Subtask #${key}`, sequenceId: key, entries: [] });
    }
    subtaskGroups.get(key).entries.push(entry);
  }

  const recent = ownEntries.slice(0, 5);
  const older = ownEntries.slice(5);
  const recentHtml = recent.length
    ? buildFeedEntriesHtml(recent, ticket)
    : buildInlineEmptyState('chat-circle-dots', 'No activity yet', 'Be the first to reply on this ticket.');
  const historyHtml = older.length
    ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--text-muted);padding:8px 0;user-select:none"><i class="ph ph-clock-counter-clockwise" style="margin-right:4px"></i>Show ${older.length} older messages</summary><div style="margin-top:8px">${buildFeedEntriesHtml(older, ticket)}</div></details>`
    : '';

  body.innerHTML = `<div style="display:flex;flex-direction:column;gap:0;height:100%"><div data-ticket-feed-list style="flex:1;overflow-y:auto;min-height:0;padding-bottom:8px">${recentHtml}${historyHtml}</div><div style="border-top:1px solid var(--border-color);padding-top:12px;margin-top:8px;flex-shrink:0"><textarea id="tvFeedReply" placeholder="Reply to this ticket..." style="width:100%;padding:10px 12px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:var(--glass-bg);color:var(--text-primary);font-size:13px;font-family:var(--font-family);resize:none;outline:none;min-height:72px;box-sizing:border-box;transition:border-color 0.15s"></textarea><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px"><button class="td-action-btn" id="tvFeedSendBtn" style="background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)"><i class="ph ph-paper-plane-tilt"></i> Send Reply</button></div></div></div>`;

  bindReplyComposer(view, body, ticket);

  // Append collapsible subtask tree after the flat feed when child entries exist
  const subtaskTreeHtml = buildSubtaskTreeHtml(subtaskGroups, ticket);
  if (subtaskTreeHtml) {
    const feedList = body.querySelector('[data-ticket-feed-list]');
    if (feedList) {
      const treeWrapper = document.createElement('div');
      treeWrapper.innerHTML = subtaskTreeHtml;
      if (treeWrapper.firstElementChild) {
        feedList.appendChild(treeWrapper.firstElementChild);
      }
    }
  }
}

function bindReplyComposer(view, body, ticket) {
  const replyArea = body.querySelector('#tvFeedReply');
  const sendButton = body.querySelector('#tvFeedSendBtn');
  if (!(replyArea instanceof HTMLTextAreaElement) || !(sendButton instanceof HTMLButtonElement)) {
    return;
  }

  view._focusReplyComposer();
  sendButton.addEventListener('click', () => sendTicketReply(view, ticket, replyArea, sendButton));
  replyArea.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      sendButton.click();
    }
  });
}

async function sendTicketReply(view, ticket, replyArea, sendButton) {
  const text = replyArea.value.trim();
  if (!text) return;

  logger.info('Sending cockpit ticket reply', {
    ticketId: ticket.id,
    targetAgent: ticket.assignee || 'assistant',
  });
  sendButton.disabled = true;
  sendButton.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Sending...';

  try {
    const result = await view.api.replyOnTicket(ticket.id, text);
    replyArea.value = '';
    view.showToast('Reply sent', 'success');
    prependFeedEntry(view, { actor: 'You', role: 'user', summary: text, timestamp: new Date().toISOString() }, ticket);
    logger.info('Sent cockpit ticket reply', {
      ticketId: ticket.id,
      success: result?.success ?? true,
    });
    window.setTimeout(() => view._selectTicket(ticket.id), 1500);
  } catch (error) {
    logger.error('Failed to send cockpit ticket reply', {
      ticketId: ticket.id,
      error: serializeUiError(error),
    });
    view._logWarning('ticket-reply-failed', error, { ticketId: ticket.id });
    view.showToast(`Reply failed: ${view._errorMessage(error)}`, 'error');
  } finally {
    sendButton.disabled = false;
    sendButton.innerHTML = '<i class="ph ph-paper-plane-tilt"></i> Send Reply';
  }
}

function prependFeedEntry(view, entry, ticket) {
  const feedList = view.container.querySelector('[data-ticket-feed-list]');
  if (!(feedList instanceof HTMLElement)) {
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = buildFeedEntriesHtml([entry], ticket);
  const nextEntry = wrapper.firstElementChild;
  if (nextEntry) {
    feedList.insertBefore(nextEntry, feedList.firstChild);
  }
}

function renderDescriptionTab(view, body, ticket) {
  const description = ticket.description || '';
  const parentTicket = view._findParentTicket(ticket.parentId);
  const rendered = description && typeof marked !== 'undefined' ? marked.parse(description) : description;

  let html = '';
  if (parentTicket) {
    html += `<button class="td-action-btn" data-parent-ticket-id="${parentTicket.id}" style="margin-bottom:12px"><i class="ph ph-arrow-bend-up-left"></i> Open parent ticket #${parentTicket.sequenceId}: ${truncate(parentTicket.name, 42)}</button>`;
  }
  html += rendered
    ? `<div style="font-size:13px;color:var(--text-primary);line-height:1.6">${rendered}</div>`
    : buildInlineEmptyState('note-blank', 'No description yet', 'Add detail through the ticket source system or related task metadata.');

  if (ticket.children.length) {
    html += buildChildSectionMarkup(view, ticket.children);
  }

  body.innerHTML = html;
  body.querySelectorAll('[data-parent-ticket-id]').forEach((element) => {
    element.addEventListener('click', () => view._selectTicket(element.dataset.parentTicketId));
  });
  body.querySelectorAll('[data-child-id]').forEach((element) => {
    element.addEventListener('click', () => view._selectTicket(element.dataset.childId));
  });
}

function buildChildSectionMarkup(view, children) {
  const rows = children.map((childRow) => {
    const child = view._norm(childRow);
    const state = normalizeWorkflowState(child.state);
    const icon = state === 'complete' ? 'ph-check-circle' : state.startsWith('in_process_') ? 'ph-spinner-gap' : 'ph-circle';
    const color = state === 'complete' ? 'var(--status-success)' : state.startsWith('in_process_') ? 'var(--status-active)' : 'var(--text-muted)';
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.03);cursor:pointer" data-child-id="${child.id}"><i class="ph ${icon}" style="color:${color};font-size:16px"></i><span style="color:var(--text-primary);flex:1">#${child.sequenceId} ${child.name}</span><span style="color:var(--text-muted);font-size:11px">${stateLabel(state)}</span></div>`;
  }).join('');

  return `<h4 style="margin-top:20px;color:var(--text-secondary);font-size:13px;border-top:1px solid var(--border-color);padding-top:12px"><i class="ph ph-tree-structure" style="margin-right:4px"></i> Subtasks (${children.length})</h4>${rows}`;
}

async function renderArtifactsTab(view, body, ticket) {
  const codeServerBase = '/code';
  const workspaceTicketId = ticket.workspaceTaskId || ticket.parentId || ticket.id;
  const parentTicket = view._findParentTicket(ticket.parentId);
  const usesParentWorkspace = Boolean(ticket.parentId && workspaceTicketId === ticket.parentId);
  logger.debug('Rendering cockpit ticket artifacts tab', {
    ticketId: ticket.id,
    workspaceTicketId,
    usesParentWorkspace,
  });

  try {
    const files = await view.api.getWorkspaceFiles(workspaceTicketId);
    if (files?.__error) {
      throw new Error(files.error || 'Workspace inventory unavailable');
    }

    const items = files.files || files.data?.children || files.children || [];
    const actualPath = resolveWorkspaceDisplayPath(files, ticket, workspaceTicketId);
    const workspacePath = buildCodeServerWorkspacePath(actualPath);
    const codeServerUrl = `${codeServerBase}?folder=${encodeURIComponent(workspacePath)}`;
    const headerHtml = buildArtifactsHeader(codeServerUrl, actualPath, usesParentWorkspace, parentTicket);
    logger.debug('Loaded cockpit ticket artifacts', {
      ticketId: ticket.id,
      workspaceTicketId,
      itemCount: items.length,
      actualPath,
    });

    if (items.length) {
      body.innerHTML = headerHtml + items.map((file) => {
        const name = file.name || file.path || String(file);
        const fileCodeUrl = `${codeServerBase}?folder=${encodeURIComponent(workspacePath)}&file=${encodeURIComponent(joinWorkspacePath(workspacePath, name))}`;
        return `<div class="td-artifact" data-href="${fileCodeUrl}" style="cursor:pointer"><i class="ph ph-file-code"></i><span class="td-artifact-name" style="flex:1">${name}</span><i class="ph ph-arrow-square-out" style="color:var(--text-muted);font-size:11px"></i></div>`;
      }).join('');
      bindArtifactLinks(body);
      return;
    }

    body.innerHTML = `${headerHtml}${buildInlineEmptyState('folder-open', `No workspace files yet for ticket #${ticket.sequenceId}.`, 'Files will appear here once a bot completes work and saves files to the workspace.')}`;
  } catch (error) {
    renderArtifactsFailure(view, body, ticket, workspaceTicketId, usesParentWorkspace, parentTicket, error);
  }
}

function buildArtifactsHeader(codeServerUrl, actualPath, usesParentWorkspace, parentTicket) {
  const workspaceNote = usesParentWorkspace
    ? buildInfoNote('tree-structure', `Using the shared parent-ticket workspace${parentTicket ? ` from #${parentTicket.sequenceId}` : ''}.`, 'data-ticket-workspace-note')
    : '';
  return `<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap"><a href="${codeServerUrl}" target="_blank" class="td-action-btn" style="text-decoration:none;background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)"><i class="ph ph-code"></i> Open in Code Server</a><span style="font-size:11px;color:var(--text-muted);align-self:center">${actualPath}</span>${workspaceNote}</div>`;
}

function bindArtifactLinks(body) {
  body.querySelectorAll('.td-artifact').forEach((element) => {
    element.addEventListener('click', () => {
      if (element.dataset.href) {
        window.open(element.dataset.href, '_blank');
      }
    });
  });
}

function renderArtifactsFailure(view, body, ticket, workspaceTicketId, usesParentWorkspace, parentTicket, error) {
  logger.warn('Failed to render cockpit ticket artifacts', {
    ticketId: ticket.id,
    workspaceTicketId,
    error: serializeUiError(error),
  });
  view._logWarning('load-ticket-artifacts-failed', error, { ticketId: ticket.id, workspaceTicketId });
  const fallbackPath = buildCodeServerWorkspacePath(`/workspace/${workspaceTicketId}`);
  const fallbackUrl = `/code?folder=${encodeURIComponent(fallbackPath)}`;
  const workspaceNote = usesParentWorkspace
    ? buildInfoNote('tree-structure', `Using the shared parent-ticket workspace${parentTicket ? ` from #${parentTicket.sequenceId}` : ''}.`, 'data-ticket-workspace-note')
    : '';

  body.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap"><a href="${fallbackUrl}" target="_blank" class="td-action-btn" style="text-decoration:none;background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)"><i class="ph ph-code"></i> Open in Code Server</a><span style="font-size:11px;color:var(--text-muted);align-self:center">${fallbackPath}</span>${workspaceNote}<button class="td-action-btn" id="tvRetryArtifactsBtn" type="button"><i class="ph ph-arrow-clockwise"></i> Retry inventory</button></div>${buildInlineEmptyState('files', 'Workspace file inventory is not available yet.', 'The code workspace can still be opened directly while file listing catches up.')}`;
  body.querySelector('#tvRetryArtifactsBtn')?.addEventListener('click', () => {
    void renderArtifactsTab(view, body, ticket);
  });
}

function readCostNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @description Renders the Process tab: fetches status history and displays a vertical timeline.
 * @param view - Active TicketView instance.
 * @param body - Tab body element.
 * @param ticket - Normalized ticket detail object.
 * @param timeline - Existing activity timeline used as a compatibility fallback.
 */
async function renderProcessTab(view, body, ticket, timeline = []) {
  body.innerHTML = `<div style="display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:12px;padding:16px 0"><i class="ph ph-spinner" style="animation:spin 1s linear infinite"></i> Loading process history…</div>`;
  try {
    const res = await fetch(`${view.api.baseURL}/api/v1/tickets/${encodeURIComponent(ticket.id)}/history`);
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    const history = Array.isArray(data.history) ? data.history : [];

    if (history.length === 0) {
      body.innerHTML = buildProcessEmptyState(ticket);
      return;
    }

    body.innerHTML = buildProcessTimelineWithActivity(ticket, history);
  } catch (err) {
    logger.warn('Failed to load process history', { ticketId: ticket.id, err: String(err) });
    if (readHttpStatusCode(err) === 404) {
      body.innerHTML = buildProcessFallbackMarkup(ticket, timeline);
      return;
    }
    body.innerHTML = `<div style="padding:16px;color:var(--color-error,#ef4444);font-size:12px"><i class="ph ph-warning"></i> Could not load process history. <button class="td-action-btn" id="tvRetryProcessBtn" type="button" style="margin-left:8px"><i class="ph ph-arrow-clockwise"></i> Retry</button></div>`;
    body.querySelector('#tvRetryProcessBtn')?.addEventListener('click', () => {
      void renderProcessTab(view, body, ticket, timeline);
    });
  }
}

/**
 * @description Builds the empty state markup for the Process tab.
 * @param ticket - Normalized ticket detail object.
 */
function buildProcessEmptyState(ticket) {
  return `${buildProcessAssigneeBanner(ticket)}<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;color:var(--text-muted);text-align:center;gap:8px"><i class="ph ph-clock-clockwise" style="font-size:28px;opacity:0.4"></i><div style="font-size:12px">No status transitions recorded yet.</div><div style="font-size:11px;opacity:0.7">Transitions will appear here as the ticket moves through its lifecycle.</div></div>`;
}

const STATUS_COLORS = {
  backlog: '#6b7280',
  approved: '#3b82f6',
  in_process_discovery: '#6366f1',
  in_process_design: '#8b5cf6',
  in_process_build: '#f59e0b',
  in_process_deploy: '#f97316',
  in_process_test: '#06b6d4',
  in_process_release: '#10b981',
  approval_required: '#ec4899',
  customer_action: '#ec4899',
  complete: '#22c55e',
  escalated: '#ef4444',
  paused: '#9ca3af',
  cancelled: '#6b7280',
};

/**
 * @description Returns a display-friendly label for a ticket status key.
 * @param status - Raw status string.
 */
function formatStatusLabel(status) {
  if (!status) return '—';
  return status
    .replace(/^in_process_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeHistoryMetadata(entry) {
  const raw = entry?.metadata;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function readMetadataString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function buildInternalActivityDisplay(metadata) {
  const event = readMetadataString(metadata.event);
  const isInternalActivity = metadata.internalActivity === true
    || metadata.internalComment === true
    || readMetadataString(metadata.source) === 'swarm-agent-worker'
    || event.startsWith('execution_');
  if (!isInternalActivity) return null;

  const titleByEvent = {
    execution_started: 'Worker started',
    execution_heartbeat: 'Worker heartbeat',
    execution_finished: 'Worker finished',
    execution_failed: 'Worker failed',
  };
  const colorByEvent = {
    execution_started: '#38bdf8',
    execution_heartbeat: '#22d3ee',
    execution_finished: metadata.resultSuccess === false ? '#ef4444' : '#10b981',
    execution_failed: '#ef4444',
  };
  const parts = [];
  const agentId = readMetadataString(metadata.agentId);
  const phase = metadata.phase != null ? String(metadata.phase) : '';
  const round = metadata.round != null ? String(metadata.round) : '';
  const elapsed = formatDurationMs(metadata.elapsedMs);
  const failureClass = readMetadataString(metadata.failureClass);
  const providerRuntime = readMetadataString(metadata.providerRuntime);
  const message = readMetadataString(metadata.message) || readMetadataString(metadata.reason);
  const nextAction = readMetadataString(metadata.nextAction);

  if (agentId) parts.push(`agent ${agentId}`);
  if (phase || round) parts.push(`phase ${phase || '?'}${round ? `, round ${round}` : ''}`);
  if (elapsed) parts.push(`elapsed ${elapsed}`);
  if (metadata.resultSuccess === true) parts.push('result success');
  if (metadata.resultSuccess === false) parts.push('result failed');
  if (failureClass) parts.push(failureClass.replace(/_/g, ' '));
  if (providerRuntime) parts.push(providerRuntime);
  if (message) parts.push(message);
  if (nextAction) parts.push(`next: ${nextAction}`);

  return {
    title: titleByEvent[event] || 'Worker activity',
    detail: parts.join(' | '),
    color: colorByEvent[event] || '#38bdf8',
  };
}

/**
 * @description Builds the process timeline HTML from history records.
 * @param ticket - Normalized ticket detail object.
 * @param history - Array of status history records newest-first.
 */
function buildProcessTimeline(ticket, history) {
  const orderedHistory = [...history].reverse();
  const items = orderedHistory.map((entry, idx) => {
    const color = STATUS_COLORS[entry.toStatus] || '#6b7280';
    const label = formatStatusLabel(entry.toStatus);
    const fromLabel = entry.fromStatus ? formatStatusLabel(entry.fromStatus) : null;
    const arrow = fromLabel ? `<span style="color:var(--text-muted);margin:0 4px">→</span><strong style="color:${color}">${label}</strong>` : `<strong style="color:${color}">${label}</strong>`;
    const fromPart = fromLabel ? `<span style="opacity:0.7">${fromLabel}</span>${arrow}` : arrow;
    const ts = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '';
    const isLast = idx === orderedHistory.length - 1;
    return `<div style="display:flex;gap:12px">
      <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
        <div style="width:10px;height:10px;border-radius:50%;background:${color};margin-top:4px;flex-shrink:0"></div>
        ${isLast ? '' : '<div style="flex:1;width:2px;background:var(--glass-border);min-height:24px;margin:4px 0"></div>'}
      </div>
      <div style="flex:1;padding-bottom:${isLast ? '0' : '16px'}">
        <div style="font-size:12px;line-height:1.4">${fromPart}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px"><i class="ph ph-user-circle"></i> ${entry.changedByLabel || entry.changedBy} · ${ts}</div>
      </div>
    </div>`;
  }).join('');

  return `${buildProcessAssigneeBanner(ticket)}<div style="padding:4px 0">${items}</div>`;
}

function buildProcessTimelineWithActivity(ticket, history) {
  const orderedHistory = [...history].reverse();
  const items = orderedHistory.map((entry, idx) => {
    const metadata = normalizeHistoryMetadata(entry);
    const activity = buildInternalActivityDisplay(metadata);
    const color = activity?.color || STATUS_COLORS[entry.toStatus] || '#6b7280';
    const label = formatStatusLabel(entry.toStatus);
    const fromLabel = entry.fromStatus ? formatStatusLabel(entry.fromStatus) : null;
    const arrow = fromLabel
      ? `<span style="color:var(--text-muted);margin:0 4px">&rarr;</span><strong style="color:${color}">${escapeHtml(label)}</strong>`
      : `<strong style="color:${color}">${escapeHtml(label)}</strong>`;
    const fromPart = activity
      ? `<strong style="color:${color}">${escapeHtml(activity.title)}</strong>`
      : fromLabel
        ? `<span style="opacity:0.7">${escapeHtml(fromLabel)}</span>${arrow}`
        : arrow;
    const detail = activity?.detail
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;line-height:1.45">${escapeHtml(activity.detail)}</div>`
      : '';
    const ts = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '';
    const isLast = idx === orderedHistory.length - 1;
    return `<div style="display:flex;gap:12px">
      <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
        <div style="width:10px;height:10px;border-radius:50%;background:${color};margin-top:4px;flex-shrink:0"></div>
        ${isLast ? '' : '<div style="flex:1;width:2px;background:var(--glass-border);min-height:24px;margin:4px 0"></div>'}
      </div>
      <div style="flex:1;padding-bottom:${isLast ? '0' : '16px'}">
        <div style="font-size:12px;line-height:1.4">${fromPart}</div>
        ${detail}
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px"><i class="ph ph-user-circle"></i> ${escapeHtml(entry.changedByLabel || entry.changedBy || 'system')} &middot; ${escapeHtml(ts)}</div>
      </div>
    </div>`;
  }).join('');

  return `${buildProcessAssigneeBanner(ticket)}<div style="padding:4px 0">${items}</div>`;
}

function buildProcessFallbackMarkup(ticket, timeline) {
  const events = deriveProcessFallbackEvents(ticket, timeline);
  const notice = `<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;margin-bottom:16px;border:1px solid color-mix(in srgb, var(--accent-primary) 35%, var(--glass-border));border-radius:var(--radius-md);background:rgba(255,255,255,0.02);color:var(--text-muted);font-size:12px"><i class="ph ph-info" style="margin-top:1px;color:var(--accent-primary)"></i><div style="display:flex;flex-direction:column;gap:4px"><strong style="font-size:12px;color:var(--text-secondary)">Compatibility mode</strong><span>Detailed process history is unavailable on this server, so this view is inferred from the ticket activity already loaded in the detail pane.</span></div></div>`;

  if (events.length === 0) {
    return `${buildProcessAssigneeBanner(ticket)}${notice}${buildInlineEmptyState('clock-clockwise', 'No process milestones are available yet.', 'Once the backend exposes detailed history, each lifecycle transition will appear here automatically.')}`;
  }

  const items = events.map((event, idx) => {
    const isLast = idx === events.length - 1;
    const actor = event.actor || 'system';
    const timestamp = event.timestamp ? new Date(event.timestamp).toLocaleString() : '';
    return `<div style="display:flex;gap:12px">
      <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
        <div style="width:10px;height:10px;border-radius:50%;background:${event.color};margin-top:4px;flex-shrink:0"></div>
        ${isLast ? '' : '<div style="flex:1;width:2px;background:var(--glass-border);min-height:24px;margin:4px 0"></div>'}
      </div>
      <div style="flex:1;padding-bottom:${isLast ? '0' : '16px'}">
        <div style="font-size:12px;line-height:1.4"><strong style="color:${event.color}">${event.title}</strong></div>
        ${event.detail ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px">${event.detail}</div>` : ''}
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px"><i class="ph ph-user-circle"></i> ${actor} · ${timestamp}</div>
      </div>
    </div>`;
  }).join('');

  return `${buildProcessAssigneeBanner(ticket)}${notice}<div style="padding:4px 0">${items}</div>`;
}

function deriveProcessFallbackEvents(ticket, timeline) {
  const events = [];
  const seen = new Set();
  const createdAt = ticket.createdAt || ticket.created_at || '';
  const updatedAt = ticket.updatedAt || ticket.updated_at || createdAt || new Date().toISOString();
  const currentStatus = normalizeWorkflowState(ticket.rawStatus || ticket.state || ticket.status);
  const currentLabel = formatStatusLabel(currentStatus);
  const currentColor = STATUS_COLORS[currentStatus] || '#6b7280';

  if (createdAt) {
    pushProcessFallbackEvent(events, seen, {
      id: `created-${ticket.id}`,
      title: 'Ticket created',
      detail: ticket.name || `Ticket ${ticket.sequenceId || ticket.id}`,
      actor: ticket.assignee || 'system',
      timestamp: createdAt,
      color: '#6b7280',
    });
  }

  const explicitStatusEvents = Array.isArray(timeline)
    ? timeline
      .map((entry) => parseProcessStatusEvent(entry, ticket.id))
      .filter(Boolean)
    : [];

  explicitStatusEvents.forEach((event) => pushProcessFallbackEvent(events, seen, event));

  if (currentStatus && !explicitStatusEvents.some((event) => event.status === currentStatus)) {
    pushProcessFallbackEvent(events, seen, {
      id: `current-${ticket.id}-${currentStatus}`,
      title: `Current status: ${currentLabel}`,
      detail: 'Showing the current lifecycle state because the detailed history endpoint is unavailable.',
      actor: ticket.assignee || 'system',
      timestamp: updatedAt,
      color: currentColor,
      status: currentStatus,
    });
  }

  return events.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
}

function parseProcessStatusEvent(entry, ticketId) {
  const rawText = [
    entry?.summary,
    entry?.text,
    entry?.description,
    entry?.action,
  ]
    .map((value) => String(value || '').replace(/\*+/g, '').trim())
    .filter(Boolean)
    .join(' ');

  if (!rawText) {
    return null;
  }

  const statusChangeMatch = rawText.match(/status changed(?:\s+from\s+(.+?))?\s*(?:→|->)\s*(.+)$/i);
  if (!statusChangeMatch) {
    return null;
  }

  const fromStatus = statusChangeMatch[1] ? normalizeWorkflowState(statusChangeMatch[1]) : null;
  const toStatus = normalizeWorkflowState(statusChangeMatch[2]);
  const toLabel = formatStatusLabel(toStatus);
  const fromLabel = fromStatus ? formatStatusLabel(fromStatus) : '';

  return {
    id: entry?.id || `fallback-${ticketId}-${toStatus}-${entry?.timestamp || entry?.created_at || Date.now()}`,
    title: fromLabel ? `${fromLabel} -> ${toLabel}` : toLabel,
    detail: 'Status changed',
    actor: entry?.actor || entry?.author || 'system',
    timestamp: entry?.timestamp || entry?.created_at || new Date().toISOString(),
    color: STATUS_COLORS[toStatus] || '#6b7280',
    status: toStatus,
  };
}

function pushProcessFallbackEvent(events, seen, event) {
  const key = `${event.id}|${event.title}|${event.timestamp}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  events.push(event);
}

function buildProcessAssigneeBanner(ticket) {
  return ticket.assignee
    ? `<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:rgba(255,255,255,0.02);margin-bottom:16px"><i class="ph ph-robot" style="color:var(--accent-primary)"></i><span style="font-size:12px"><strong>Current agent:</strong> ${ticket.assignee}</span></div>`
    : '';
}

// ── RCA & Remediation Tab ─────────────────────────────────────────────────────────

async function renderRcaTab(view, body, ticket) {
  // The rich in-cockpit RCA deliverables view was backed by the operations data
  // endpoint that has since been retired. Until the operations backend is rebuilt
  // (ADR-069), an incident bot's RCA report, impact assessment, and remediation
  // steps live in this ticket's deliverables/ workspace folder.
  body.innerHTML = `
    <div style="padding:16px;color:var(--text-muted);font-size:12px;line-height:1.6">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--text-secondary);font-weight:600">
        <i class="ph ph-notepad"></i> RCA &amp; Remediation deliverables
      </div>
      An incident bot writes its RCA report, impact assessment, and remediation steps into
      this ticket's <strong>deliverables/</strong> workspace folder — open the Workspace tab to read them.
    </div>`;
}

function readHttpStatusCode(error) {
  const direct = Number(error?.status);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const match = String(error?.message || error).match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : 0;
}

function updateStatusPill(pane, state) {
  const pill = pane.querySelector('.status-pill');
  if (!pill) {
    return;
  }

  pill.className = `status-pill ${getStatusClass(String(state || '').toLowerCase())}`;
  pill.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:var(--radius-pill)';
  pill.textContent = getStatusLabel(String(state || '').toLowerCase());
}

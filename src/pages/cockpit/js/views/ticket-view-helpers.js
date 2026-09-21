/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted shared ticket-view helper utilities so the cockpit ticket surface can stay under the file cap while adding project reassignment controls
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserved canonical /app/workspace paths in cockpit detail views while mapping them back onto code-server /workspace links for operator navigation
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added selectEscalationDetail so an empty durable swarm_escalations lookup can no longer erase the escalation reason the ticket payload already carries from the recorded status transition
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | selectEscalationDetail preferred any durable record that named a reason, with nothing testing that the record belonged to the escalation on screen. The durable lookup is by ticket id and returns the ticket's newest record, so a ticket that escalated, de-escalated and escalated again explained its current escalation with a reason from the run that had already closed. Date the durable record against the current escalation and drop one written before it, so an escalation that recorded nothing says so instead of borrowing an old answer.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-163 D3: the canonical escalation record leads. swarm_escalations answers only escalations raised INSIDE a swarm run - one writer, and it needs a run id - while every escalating path writes the ticket_status_history transition the payload carries. Leading with the run record meant the cockpit's first question was answered by the store that sees a strict subset. The transition now explains the escalation and a current run record contributes only what a run knows (target, retryClass, attemptState), so the panel keeps every chip it had without the reason depending on which store happened to have a row.
 */

import { getStatusLabel } from '../utils/formatters.js';

// A durable swarm_escalations row is written immediately BEFORE the status transition it
// causes, so a record that genuinely explains the escalation on screen still predates it.
// Measured over all 24 escalated-ticket/newest-record pairs on the operator's database:
// same-run records lead their transition by 8-59 ms and never trail it, while the closest
// leftover from a run that had already closed predates the current escalation by 13.6 s
// and the other seven by 11 hours to 1.4 days. One second sits ~17x above the largest real
// lead and ~13x below the smallest stale gap, so it absorbs the write ordering without
// ever reaching back into a run that is over.
const DURABLE_RECORD_WRITE_LEAD_MS = 1000;

/**
 * @description Valid cockpit ticket lifecycle transitions keyed by canonical internal state.
 */
export const VALID_STATE_TRANSITIONS = {
  backlog: ['approved', 'escalated', 'paused', 'cancelled'],
  approved: ['in_process_discovery', 'in_process_design', 'in_process_build', 'backlog', 'escalated', 'paused', 'cancelled'],
  in_process_discovery: ['approval_required', 'in_process_build', 'approved', 'escalated', 'paused', 'cancelled'],
  in_process_design: ['approval_required', 'in_process_build', 'customer_action', 'escalated', 'approved', 'paused', 'cancelled'],
  in_process_build: ['approved', 'in_process_deploy', 'in_process_test', 'customer_action', 'complete', 'escalated', 'in_process_discovery', 'paused', 'cancelled'],
  in_process_deploy: ['approved', 'in_process_test', 'in_process_build', 'customer_action', 'complete', 'escalated', 'paused', 'cancelled'],
  in_process_test: ['approved', 'in_process_release', 'in_process_build', 'customer_action', 'complete', 'escalated', 'paused', 'cancelled'],
  in_process_release: ['approved', 'complete', 'in_process_test', 'customer_action', 'escalated', 'paused', 'cancelled'],
  approval_required: ['in_process_build', 'approved', 'escalated', 'paused', 'cancelled'],
  customer_action: ['approved', 'in_process_discovery', 'in_process_design', 'in_process_build', 'in_process_test', 'escalated', 'complete', 'paused', 'cancelled'],
  complete: ['backlog'],
  escalated: ['backlog', 'approved', 'in_process_discovery', 'approval_required', 'in_process_design', 'in_process_build', 'paused', 'cancelled'],
  paused: ['approved', 'approval_required', 'backlog', 'escalated', 'cancelled'],
  cancelled: ['backlog'],
};

/**
 * @description Normalizes loose workflow labels into canonical OSHAL ticket lifecycle states.
 * @param state - Raw state label.
 * @returns Canonical state key.
 */
export function normalizeWorkflowState(state) {
  const normalized = String(state || '').trim().toLowerCase();
  if (!normalized) return 'backlog';
  if (VALID_STATE_TRANSITIONS[normalized]) return normalized;
  if (normalized.includes('approval')) return 'approval_required';
  if (normalized.includes('discovery') || normalized.includes('phase 0') || normalized === 'phase0') return 'in_process_discovery';
  if (normalized.includes('planning')) return 'in_process_discovery';
  if (normalized.includes('customer')) return 'customer_action';
  if (normalized.includes('design')) return 'in_process_design';
  if (normalized.includes('build') || normalized.includes('develop') || normalized.includes('implement')) return 'in_process_build';
  if (normalized.includes('deploy')) return 'in_process_deploy';
  if (normalized.includes('test') || normalized.includes('qa') || normalized.includes('verify') || normalized === 'in review' || normalized === 'review') return 'in_process_test';
  if (normalized.includes('release')) return 'in_process_release';
  if (normalized.includes('progress') || normalized.includes('doing')) return 'in_process_build';
  if (normalized === 'done' || normalized === 'completed') return 'complete';
  if (normalized === 'todo') return 'approved';
  if (normalized.includes('pause') || normalized === 'hold' || normalized === 'on hold') return 'paused';
  if (normalized.includes('cancel') || normalized === 'aborted') return 'cancelled';
  return 'backlog';
}

/**
 * @description Builds the select-option list for the current ticket state plus valid transitions.
 * @param currentState - Raw current state label.
 * @returns Array of state option descriptors.
 */
export function buildStateOptions(currentState) {
  const normalizedState = normalizeWorkflowState(currentState);
  const nextStates = VALID_STATE_TRANSITIONS[normalizedState] || [];
  return [normalizedState, ...nextStates]
    .filter((value, index, array) => array.indexOf(value) === index)
    .map((value) => ({ value, label: getStatusLabel(value) }));
}

/**
 * @description Collapses detailed workflow states into the bucket labels used by toolbar filtering.
 * @param state - Raw state label.
 * @returns Toolbar state-group label.
 */
export function getTicketStateGroup(state) {
  const normalized = normalizeWorkflowState(state);
  return normalized.startsWith('in_process_') ? 'in progress' : normalized;
}

/**
 * @description Resolves the user-facing label for one ticket state.
 * @param state - Raw state label.
 * @returns Formatted label.
 */
export function stateLabel(state) {
  return getStatusLabel(normalizeWorkflowState(state));
}

/**
 * @description Tests whether a ticket row or any of its visible descendants matches the active ticket search query.
 * @param ticket - Normalized ticket row.
 * @param query - Lower-cased search query.
 * @param normalizeTicket - Ticket normalizer callback.
 * @returns True when the ticket tree matches the query.
 */
export function ticketMatchesSearch(ticket, query, normalizeTicket) {
  const parentHaystack = [ticket.name, ticket.sequenceId, ticket.assignee, ticket.project, ticket.description]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  if (parentHaystack.includes(query)) {
    return true;
  }

  return (ticket.children || []).some((childRow) => {
    const child = normalizeTicket(childRow);
    const childHaystack = [child.name, child.sequenceId, child.assignee, child.description, stateLabel(child.state)]
      .map((value) => String(value || '').toLowerCase())
      .join(' ');
    return childHaystack.includes(query);
  });
}

/**
 * @description Resolves the best visible workspace path from workspace inventory data and ticket fallback metadata.
 * @param files - Workspace inventory payload.
 * @param ticket - Normalized ticket detail object.
 * @param workspaceTicketId - Ticket or parent ticket identifier used for workspace lookup.
 * @returns Display path for operator use.
 */
export function resolveWorkspaceDisplayPath(files, ticket, workspaceTicketId) {
  const candidates = [files?.data?.path, files?.path, ticket.workspacePath, `/app/workspace/${workspaceTicketId}`];
  for (const candidate of candidates) {
    const normalized = normalizeWorkspaceDisplayPath(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return `/app/workspace/${workspaceTicketId}`;
}

/**
 * @description Normalizes mixed host-local and shared workspace paths onto the cockpit display convention.
 * @param value - Raw workspace path candidate.
 * @returns Normalized display path.
 */
export function normalizeWorkspaceDisplayPath(value) {
  const normalizedValue = String(value || '').trim().replace(/\\/g, '/');
  if (!normalizedValue) return '';
  if (normalizedValue === 'workspace' || normalizedValue === '/workspace') return '/app/workspace';
  if (normalizedValue === '/app/workspace') return normalizedValue;
  if (normalizedValue.startsWith('/app/workspace/')) return normalizedValue;
  if (normalizedValue.startsWith('workspace/')) return `/app/${normalizedValue.replace(/^\/+/, '')}`;
  if (normalizedValue.startsWith('/workspace/')) return `/app${normalizedValue}`;
  const workspaceMarker = normalizedValue.lastIndexOf('/workspace/');
  if (workspaceMarker >= 0) return `/app/workspace/${normalizedValue.slice(workspaceMarker + '/workspace/'.length)}`;
  if (normalizedValue.startsWith('/')) return `/app/workspace/${normalizedValue.split('/').filter(Boolean).pop() || ''}`;
  return `/app/workspace/${normalizedValue.replace(/^\/+/, '')}`;
}

/**
 * @description Converts a display workspace path into the shared code-server folder path.
 * @param displayPath - Display path shown in cockpit.
 * @returns Code-server folder path.
 */
export function buildCodeServerWorkspacePath(displayPath) {
  const normalizedDisplayPath = normalizeWorkspaceDisplayPath(displayPath);
  if (normalizedDisplayPath.startsWith('/app/workspace')) {
    return normalizedDisplayPath.replace(/^\/app/, '') || '/workspace';
  }
  return `/${normalizedDisplayPath || 'workspace'}`;
}

/**
 * @description Joins a workspace folder path with a child file path for code-server deep links.
 * @param basePath - Shared workspace folder path.
 * @param childPath - Child file path.
 * @returns Joined workspace file path.
 */
export function joinWorkspacePath(basePath, childPath) {
  const normalizedBase = String(basePath || '').replace(/\/+$/, '');
  const normalizedChild = String(childPath || '').replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedChild}`;
}

/**
 * @description Builds the standard inline empty-state block used inside ticket tabs.
 * @param icon - Phosphor icon suffix.
 * @param title - Empty-state title.
 * @param detail - Optional explanatory detail.
 * @returns Empty-state HTML string.
 */
export function buildInlineEmptyState(icon, title, detail) {
  const safeTitle = String(title || '').trim();
  const safeDetail = String(detail || '').trim();
  return `<div class="ticket-detail-empty" data-ticket-empty-state="true" style="min-height:auto;padding:20px 0"><i class="ph ph-${icon}"></i><span>${safeTitle}</span>${safeDetail ? `<small style="display:block;margin-top:6px;font-size:12px;color:var(--text-muted);text-align:center;max-width:420px;line-height:1.5">${safeDetail}</small>` : ''}</div>`;
}

/**
 * @description Builds the standard full-pane empty-state block used by the ticket workbench.
 * @param icon - Phosphor icon suffix.
 * @param title - Empty-state title.
 * @param detail - Optional explanatory detail.
 * @returns Empty-state HTML string.
 */
export function buildDetailEmptyState(icon, title, detail = '') {
  return `<div class="ticket-detail-empty"><i class="ph ph-${icon}"></i><span>${title}</span>${detail ? `<small style="display:block;margin-top:6px;font-size:12px;color:var(--text-muted);text-align:center;max-width:420px;line-height:1.5">${detail}</small>` : ''}</div>`;
}

/**
 * @description Builds a full-pane empty state with one retry/action button.
 * @param icon - Phosphor icon suffix.
 * @param title - Empty-state title.
 * @param detail - Optional explanatory detail.
 * @param buttonId - Optional action button id.
 * @param buttonLabel - Optional action button label.
 * @returns Empty-state HTML string.
 */
export function buildActionableEmptyState(icon, title, detail, buttonId, buttonLabel) {
  return `<div class="ticket-detail-empty"><i class="ph ph-${icon}"></i><span>${title}</span>${detail ? `<small style="display:block;margin-top:6px;font-size:12px;color:var(--text-muted);text-align:center;max-width:420px;line-height:1.5">${detail}</small>` : ''}${buttonId && buttonLabel ? `<button class="td-action-btn" id="${buttonId}" type="button" style="margin-top:12px"><i class="ph ph-arrow-clockwise"></i> ${buttonLabel}</button>` : ''}</div>`;
}

/**
 * @description Builds an inline warning/info notice with an optional action button.
 * @param icon - Phosphor icon suffix.
 * @param title - Notice title.
 * @param detail - Notice detail.
 * @param buttonId - Optional action button id.
 * @param buttonLabel - Optional action button label.
 * @returns Notice HTML string.
 */
export function buildActionableNotice(icon, title, detail, buttonId, buttonLabel) {
  return `<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;margin-top:12px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:rgba(255,255,255,0.02);color:var(--text-muted);font-size:12px"><i class="ph ph-${icon}" style="margin-top:1px"></i><div style="display:flex;flex-direction:column;gap:4px;flex:1"><strong style="font-size:12px;color:var(--text-secondary);font-weight:600">${title}</strong><span>${detail}</span></div>${buttonId && buttonLabel ? `<button class="td-action-btn" id="${buttonId}" type="button"><i class="ph ph-arrow-clockwise"></i> ${buttonLabel}</button>` : ''}</div>`;
}

/**
 * @description Builds a compact informational note block for the detail pane.
 * @param icon - Phosphor icon suffix.
 * @param message - Note message.
 * @param dataAttribute - Optional data-attribute marker for tests.
 * @returns Info-note HTML string.
 */
export function buildInfoNote(icon, message, dataAttribute = '') {
  const attribute = dataAttribute ? ` ${dataAttribute}="true"` : '';
  return `<div${attribute} style="display:flex;align-items:center;gap:8px;width:100%;font-size:12px;color:var(--text-muted)"><i class="ph ph-${icon}"></i><span>${message}</span></div>`;
}

/**
 * @description Extracts a readable error message from unknown thrown values.
 * @param error - Unknown error payload.
 * @returns Safe error message.
 */
export function extractErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error || 'Unknown error');
}

/**
 * @description Builds the escalation record the detail panel renders, from the two records
 * the system keeps.
 *
 * ADR-163: the CANONICAL record is the `escalated` transition the ticket payload carries —
 * every escalating path writes one, run or not. The durable `swarm_escalations` record is a
 * run-scoped verification-attempt record: one writer, reached only from a swarm run, so it
 * answers a strict subset of escalations. It therefore enriches rather than explains — it
 * contributes what only a run knows (target, retry class, the attempt snapshot) while the
 * transition supplies the reason, source, severity and next action.
 *
 * A run record still has to belong to the escalation on screen. That lookup is by ticket id and
 * returns the ticket's NEWEST record, so a ticket that escalated, was de-escalated and escalated
 * again still has the closed run's record to hand; one written before the current escalation is
 * dropped before anything is merged. When the transition recorded no reason and no current run
 * record survives, "no reason was recorded" is the honest answer; the old reason presented as the
 * current one is the dishonest one.
 * @param {Record<string, unknown> | null | undefined} recordedDetail - Escalation detail from the ticket payload.
 * @param {Record<string, unknown> | null | undefined} durableRecord - Record from the durable escalation store.
 * @param {string | null | undefined} escalatedAt - When the ticket's current escalation was recorded.
 * @returns {Record<string, unknown> | null} The record to render, or null when none applies.
 */
export function selectEscalationDetail(recordedDetail, durableRecord, escalatedAt) {
  const escalatedAtMs = readEscalationTimestamp(recordedDetail, escalatedAt);
  const currentDurable = precedesEscalation(durableRecord, escalatedAtMs) ? null : durableRecord;

  if (readEscalationReason(recordedDetail)) {
    return currentDurable ? overlayRecordedDetail(currentDurable, recordedDetail) : recordedDetail;
  }
  if (readEscalationReason(currentDurable)) {
    return currentDurable;
  }
  return currentDurable || recordedDetail || null;
}

/**
 * @description Lays the canonical transition detail over a run record, field by field. Only fields
 * the transition actually recorded are overlaid: the detail shape fills absent fields with '', and
 * an empty string must not erase a value the run record does carry (its severity, for instance).
 * Whatever the transition did not record — target, retry class, the attempt snapshot — survives
 * from the run record, which is the only thing that knows them.
 * @param {Record<string, unknown>} runRecord - The current run-scoped escalation record.
 * @param {Record<string, unknown>} recordedDetail - Detail from the escalating status transition.
 * @returns {Record<string, unknown>} The merged record the panel renders.
 */
function overlayRecordedDetail(runRecord, recordedDetail) {
  const merged = { ...runRecord };

  Object.entries(recordedDetail).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' && !value.trim()) return;
    merged[key] = value;
  });

  return merged;
}

/**
 * @description Reads a trimmed reason string off either escalation record shape.
 * @param {Record<string, unknown> | null | undefined} record - Escalation record.
 * @returns {string} The reason, or '' when the record names none.
 */
function readEscalationReason(record) {
  return typeof record?.reason === 'string' ? record.reason.trim() : '';
}

/**
 * @description Resolves when the ticket's current escalation was recorded. The payload's
 * `escalatedAt` answers even when that escalation recorded no reason — which is exactly
 * the case a leftover record hides behind. The recorded detail carries the same
 * transition's date and stands in for callers that pass no `escalatedAt`.
 * @param {Record<string, unknown> | null | undefined} recordedDetail - Escalation detail from the ticket payload.
 * @param {string | null | undefined} escalatedAt - When the ticket's current escalation was recorded.
 * @returns {number} Epoch milliseconds, or 0 when the escalation cannot be dated.
 */
function readEscalationTimestamp(recordedDetail, escalatedAt) {
  return parseTimestamp(escalatedAt) || parseTimestamp(recordedDetail?.createdAt);
}

/**
 * @description Tests whether a durable record was written before the current escalation,
 * allowing for the record being written just ahead of the transition it causes. An
 * undatable record or an undatable escalation is not evidence of staleness, so either
 * leaves the record in play and preserves the behaviour callers had before dates were
 * compared at all.
 * @param {Record<string, unknown> | null | undefined} durableRecord - Record from the durable escalation store.
 * @param {number} escalatedAtMs - Epoch milliseconds the current escalation was recorded, or 0.
 * @returns {boolean} True when the record was written for an earlier run.
 */
function precedesEscalation(durableRecord, escalatedAtMs) {
  const durableAt = parseTimestamp(durableRecord?.createdAt);
  if (!durableAt || !escalatedAtMs) {
    return false;
  }
  return durableAt < escalatedAtMs - DURABLE_RECORD_WRITE_LEAD_MS;
}

/**
 * @description Parses a recorded timestamp into epoch milliseconds.
 * @param {unknown} value - Timestamp candidate.
 * @returns {number} Epoch milliseconds, or 0 when the value is not a usable date.
 */
function parseTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value.trim()) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

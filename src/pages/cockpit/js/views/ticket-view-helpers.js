/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted shared ticket-view helper utilities so the cockpit ticket surface can stay under the file cap while adding project reassignment controls
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserved canonical /app/workspace paths in cockpit detail views while mapping them back onto code-server /workspace links for operator navigation
 */

import { getStatusLabel } from '../utils/formatters.js';

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

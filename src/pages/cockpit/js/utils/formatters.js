/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added canonical ticket lifecycle label/class mappings so cockpit ticket controls align with the real internal workflow model
 */

/**
 * @description Formats a numeric spend value into cockpit currency display.
 * @param {number | string | null | undefined} value - Raw spend value.
 * @returns {string} Currency label or hidden placeholder.
 */
export function formatCost(value) {
  if (value === null || value === undefined) return '--';
  const num = Number(value);
  if (!num || num === 0) return '--'; // Hide $0.00 — no real cost data
  return '$' + num.toFixed(2);
}

/**
 * @description Formats elapsed milliseconds into a compact operator-facing duration label.
 * @param {number | null | undefined} ms - Duration in milliseconds.
 * @returns {string} Human-readable elapsed time label.
 */
export function formatTime(ms) {
  if (ms === null || ms === undefined) return '--';
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  return (ms / 3600000).toFixed(1) + 'h';
}

/**
 * @description Formats an ISO date/time into a relative "time ago" label.
 * @param {string} dateStr - Source timestamp string.
 * @returns {string} Relative timestamp label.
 */
export function timeAgo(dateStr) {
  if (!dateStr) return '--';
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  if (hours < 24) return hours + 'h ago';
  return days + 'd ago';
}

/**
 * @description Maps cockpit ticket states into CSS status classes for pills, rows, and charts.
 * @param {string} state - Raw ticket state or workflow label.
 * @returns {string} CSS status class key.
 */
export function getStatusClass(state) {
  if (!state) return 'backlog';
  const s = state.toLowerCase().trim();
  const map = {
    // Backlog column
    backlog: 'backlog',
    intake: 'backlog',
    triage: 'backlog',
    approved: 'todo',
    approval_required: 'customer-action',
    escalated: 'customer-action',
    // Todo column
    todo: 'todo',
    planning: 'todo',
    // In Progress column
    'in progress': 'in-progress',
    in_progress: 'in-progress',
    in_process_discovery: 'in-progress',
    in_process_design: 'in-progress',
    in_process_build: 'in-progress',
    in_process_deploy: 'in-progress',
    in_process_test: 'in-review',
    in_process_release: 'in-review',
    execution: 'in-progress',
    started: 'in-progress',
    routing: 'in-progress',
    // In Review column
    'in review': 'in-review',
    review: 'in-review',
    testing: 'in-review',
    // Customer Action column
    'customer action': 'customer-action',
    'customer approval': 'customer-action',
    // Done column
    done: 'done',
    delivered: 'done',
    completed: 'done',
    complete: 'done',
    // Cancelled column
    cancelled: 'cancelled',
    canceled: 'cancelled',
  };
  return map[s] || 'backlog';
}

/**
 * @description Maps raw ticket states into a stable operator-facing label.
 * @param {string} state - Raw ticket state or workflow key.
 * @returns {string} Human-readable status label.
 */
export function getStatusLabel(state) {
  if (!state) return 'Backlog';
  const s = state.toLowerCase().trim();
  const map = {
    backlog: 'Backlog',
    intake: 'Intake',
    triage: 'Triage',
    approved: 'Approved',
    approval_required: 'Approval Required',
    todo: 'Todo',
    planning: 'Planning',
    'in progress': 'In Progress',
    in_progress: 'In Progress',
    in_process_discovery: 'Phase 0 - Discovery & Planning',
    in_process_design: 'In Process - Design',
    in_process_build: 'In Process - Build',
    in_process_deploy: 'In Process - Deploy',
    in_process_test: 'In Process - Test',
    in_process_release: 'In Process - Release',
    execution: 'In Progress',
    started: 'Started',
    routing: 'Routing',
    testing: 'Testing',
    'in review': 'In Review',
    review: 'In Review',
    'customer action': 'Customer Action',
    customer_action: 'Customer Action',
    'customer approval': 'Customer Approval',
    done: 'Done',
    delivered: 'Delivered',
    completed: 'Completed',
    complete: 'Complete',
    escalated: 'Escalated',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
  };
  return map[s] || state;
}

/**
 * @description Truncates a string for compact cockpit list rendering.
 * @param {string} str - Input string.
 * @param {number} len - Maximum output length before ellipsis.
 * @returns {string} Truncated string.
 */
export function truncate(str, len = 50) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len) + '...';
}

/**
 * @description Maps ticket states into an approximate progress percentage for cockpit visuals.
 * @param {string} state - Raw ticket state or workflow key.
 * @returns {number} Progress percentage from 0 to 100.
 */
export function getProgressPercent(state) {
  if (!state) return 0;
  const s = state.toLowerCase().trim();
  const map = {
    backlog: 5,
    intake: 5,
    triage: 10,
    approved: 20,
    approval_required: 40,
    todo: 15,
    planning: 20,
    'in progress': 50,
    in_progress: 50,
    in_process_discovery: 25,
    in_process_design: 35,
    in_process_build: 50,
    in_process_deploy: 65,
    in_process_test: 75,
    in_process_release: 85,
    execution: 50,
    started: 40,
    routing: 30,
    'in review': 70,
    review: 70,
    testing: 75,
    'customer action': 85,
    customer_action: 85,
    'customer approval': 90,
    done: 100,
    delivered: 100,
    completed: 100,
    complete: 100,
    escalated: 95,
    cancelled: 100,
    canceled: 100,
  };
  return map[s] || 0;
}

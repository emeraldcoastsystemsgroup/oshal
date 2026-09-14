/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Present compact assistant state and bounded source groups while retaining existing task actions.
 */

const dashboardOpenGroups = new Set();
const dashboardActiveStates = new Set(['pending', 'running', 'queued', 'summarizing']);

/** @description Build display nodes with textContent so task labels remain inert. */
function dashboardNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @description Reflect the actual voice/turn mode independently from task labels. */
function dashboardSetMode(mode) {
  const labels = { idle: 'Ready', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', stopped: 'Stopped' };
  const state = document.getElementById('assistantState');
  if (!state || !Object.hasOwn(labels, mode)) return;
  state.dataset.state = mode;
  state.textContent = labels[mode];
}

/** @description Count the full supplied list, including every collapsed or already-read result. */
function dashboardCounts(jobs, isRead) {
  return jobs.reduce((counts, job) => {
    if (dashboardActiveStates.has(job.status)) counts.active++;
    if (job.status === 'done') { counts.done++; if (!isRead(job.jobId)) counts.unread++; }
    if (job.status === 'error') counts.failed++;
    return counts;
  }, { active: 0, done: 0, unread: 0, failed: 0 });
}

/** @description Group by the existing source/topic prefix, retaining input order within each group. */
function dashboardGroups(jobs, source) {
  const groups = new Map();
  for (const job of jobs) {
    const name = source(job.label) || 'Your requests';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(job);
  }
  return groups;
}

/** @description Keep each original open/dismiss operation on its own keyboard-accessible button. */
function dashboardTaskRow(job, actions) {
  const read = actions.isRead(job.jobId);
  const state = job.status === 'done' ? (read ? 'done read' : 'done unread') : job.status === 'error' ? 'err' : 'run';
  const row = dashboardNode('div', `shelf-item ${state}`);
  row.dataset.job = job.jobId;
  const open = dashboardNode('button', 'dashboard-task-open');
  open.type = 'button'; open.dataset.jobOpen = job.jobId;
  open.append(dashboardNode('span', 'si-label', job.label || 'Untitled task'));
  const status = job.status === 'done' ? (read ? 'Read' : 'New') : job.status === 'error' ? 'Failed' : 'In progress';
  open.append(dashboardNode('span', 'si-when', status));
  open.addEventListener('click', async () => {
    await actions.open(job.jobId);
    if (job.status === 'error') actions.discussion();
  });
  const dismiss = dashboardNode('button', 'si-x', '×');
  dismiss.type = 'button'; dismiss.dataset.dismiss = job.jobId;
  dismiss.setAttribute('aria-label', `Dismiss ${job.label || 'task'}`);
  dismiss.addEventListener('click', () => { void actions.dismiss(job.jobId); });
  row.append(open, dismiss);
  return row;
}

/** @description Native disclosures expose all individual results without marking any as read. */
function dashboardGroup(name, jobs, actions) {
  const group = dashboardNode('details', 'dashboard-task-group');
  group.dataset.source = name; group.open = dashboardOpenGroups.has(name);
  const counts = dashboardCounts(jobs, actions.isRead);
  const summary = dashboardNode('summary', 'dashboard-group-summary');
  summary.append(dashboardNode('span', 'dashboard-group-name', name));
  summary.append(dashboardNode('span', 'dashboard-group-count', `${jobs.length} update${jobs.length === 1 ? '' : 's'}`));
  const detail = [counts.unread && `${counts.unread} new`, counts.active && `${counts.active} active`, counts.failed && `${counts.failed} failed`].filter(Boolean);
  if (detail.length) summary.append(dashboardNode('span', 'dashboard-group-meta', detail.join(' · ')));
  const list = dashboardNode('div', 'dashboard-group-items');
  for (const job of jobs) list.append(dashboardTaskRow(job, actions));
  group.append(summary, list);
  group.addEventListener('toggle', () => {
    if (!group.isConnected) return;
    if (group.open) dashboardOpenGroups.add(name); else dashboardOpenGroups.delete(name);
  });
  return group;
}

/** @description Keep summary totals and the existing full report available above bounded groups. */
function dashboardTaskSummary(jobs, actions) {
  const counts = dashboardCounts(jobs, actions.isRead);
  const summary = dashboardNode('div', 'shelf-sum');
  for (const [key, label] of [['active', 'active'], ['unread', 'new'], ['done', 'done'], ['failed', 'failed']]) {
    if (counts[key] || key === 'done') summary.append(dashboardNode('span', `sm ${key}`, `${counts[key]} ${label}`));
  }
  const report = dashboardNode('button', 'ctl dashboard-report', 'Full report');
  report.type = 'button'; report.dataset.shelfReport = '';
  report.addEventListener('click', actions.report);
  summary.append(report);
  return summary;
}

/** @description Restore focus across polling only when its exact task or source still exists. */
function dashboardRestoreFocus(root, previous) {
  if (!previous) return;
  const candidates = root.querySelectorAll('button,summary');
  const next = [...candidates].find(node => previous.open
    ? node.dataset.jobOpen === previous.open
    : previous.dismiss ? node.dataset.dismiss === previous.dismiss
      : node.tagName === 'SUMMARY' && node.parentElement.dataset.source === previous.source);
  next?.focus({ preventScroll: true });
}

/** @description Replace presentation only; expansion neither writes nor delivers task records. */
function dashboardRenderTasks(jobs, actions) {
  const root = document.getElementById('shelf');
  const active = document.activeElement;
  const previous = root.contains(active) ? { open: active.dataset.jobOpen, dismiss: active.dataset.dismiss,
    source: active.closest('[data-source]')?.dataset.source } : null;
  const scrollTop = root.scrollTop;
  document.getElementById('shelfSect').style.display = '';
  const content = document.createDocumentFragment();
  content.append(dashboardTaskSummary(jobs, actions));
  if (!jobs.length) content.append(dashboardNode('p', 'empty', 'No task updates yet. Your results will appear here.'));
  for (const [name, grouped] of dashboardGroups(jobs, actions.source)) content.append(dashboardGroup(name, grouped, actions));
  root.replaceChildren(content);
  root.scrollTop = scrollTop;
  dashboardRestoreFocus(root, previous);
}

/** @description Escape closes the secondary disclosure while preserving existing modal focus traps. */
function dashboardOptionsKey(event) {
  const options = document.getElementById('assistantOptions');
  if (event.key !== 'Escape' || event.defaultPrevented || !options?.open) return;
  if (document.querySelector('.jarvis-ambient__backdrop:not([hidden]),.discussion-drawer.open,.jarvis-speakers:not([hidden])')) return;
  options.open = false;
  options.querySelector('summary').focus();
  event.preventDefault();
}

window.JarvisDashboard = Object.freeze({ setMode: dashboardSetMode, renderTasks: dashboardRenderTasks });
document.addEventListener('keydown', dashboardOptionsKey);

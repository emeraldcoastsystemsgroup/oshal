/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: read-only Workflow sub-screen over GET /api/v1/tickets/:ticketId/workflow. Renders the registered definition (labelled as current, not a run snapshot), the recorded run with per-step gate decisions only where one decision can be paired to one visit, approval-gate receipts, lifecycle transitions and child tickets; every field is HTML-escaped and each unavailable source says so instead of inferring an outcome.
 */

/** Ticket-as-workflow read-only view. The server authorizes and projects this payload. */
import { createUiLogger, serializeUiError } from '../../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-ticket-view-workflow-renderer');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function when(value) {
  if (!value) return 'time not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'time not recorded' : date.toLocaleString();
}

function jsonBlock(title, value) {
  if (value === null || value === undefined) return '';
  let text;
  try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  return `<details style="margin-top:6px"><summary>${escapeHtml(title)}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px">${escapeHtml(text)}</pre></details>`;
}

function section(title, contents) {
  return `<section style="margin:0 0 20px"><h3 style="font-size:13px;color:var(--text-primary);margin:0 0 8px">${escapeHtml(title)}</h3>${contents}</section>`;
}

function renderDefinition(definition) {
  if (!definition) return section('Registered workflow', '<p>No workflow is registered for this ticket type. This can be normal for a chat/fallback ticket; it is not proof the ticket was dispatched.</p>');
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  const edges = Array.isArray(definition.edges) ? definition.edges : [];
  const nodeRows = nodes.map((node) => {
    const outgoing = edges.filter((edge) => edge.source === node.id);
    const next = outgoing.length
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Next: ${outgoing.map((edge) => `${escapeHtml(edge.target)}${edge.label ? ` (${escapeHtml(edge.label)})` : ''}`).join(', ')}</div>`
      : '';
    const assignment = node.agentBinding
      ? `<div style="font-size:11px;color:var(--text-muted)">Declared bot: ${escapeHtml(node.agentBinding)}</div>`
      : node.type === 'approval-gate'
        ? '<div style="font-size:11px;color:var(--text-muted)">Approver assignment is not declared on this gate.</div>'
        : '';
    return `<li style="padding:8px 0;border-bottom:1px solid var(--glass-border)"><strong>${escapeHtml(node.title || node.id)}</strong> <span style="color:var(--text-muted)">(${escapeHtml(node.type)})</span>${assignment}${next}</li>`;
  }).join('');
  const graph = nodes.length
    ? `<ol style="padding-left:24px;margin:8px 0">${nodeRows}</ol>${definition.graphTruncated ? '<p>Graph preview is truncated.</p>' : ''}`
    : '<p>This pipeline has no node graph in the registered definition. Its phases may still run through the ticket queue.</p>';
  return section('Registered workflow', `<p><strong>${escapeHtml(definition.name || definition.ticketType)}</strong> · ${escapeHtml(definition.pipeline)}</p>
    ${definition.defaultWorkerBot ? `<p style="font-size:11px;color:var(--text-muted)">Default worker: ${escapeHtml(definition.defaultWorkerBot)}${definition.declaredReviewerBot ? ` · declared reviewer: ${escapeHtml(definition.declaredReviewerBot)}` : ''}</p>` : ''}
    <p style="font-size:11px;color:var(--text-muted)">This is the current registered definition, not a snapshot of what a past run executed. Declared roles are not proof of assignment.</p>${graph}`);
}

function renderGateDecision(receipt) {
  if (receipt.disposition === 'awaiting') return 'Awaiting a decision';
  if (!receipt.decision) return 'Decision not recorded in available history';
  return `Transitioned to ${escapeHtml(receipt.decision.toStatus)} · actor ${escapeHtml(receipt.decision.actor)} · ${escapeHtml(when(receipt.decision.decidedAt))}`;
}

function renderRun(run, available, otherRunCount, approvalGates) {
  if (!available) return section('Recorded execution', '<p>Run history is unavailable. No execution outcome is inferred from this gap.</p>');
  if (!run) return section('Recorded execution', '<p>No graph run was recorded for this ticket. Non-graph pipelines and unrecorded runs will not have node receipts here.</p>');
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const gateReceiptsByNode = new Map();
  for (const receipt of approvalGates) {
    if (receipt.workflowRunId !== run.runId) continue;
    const queued = gateReceiptsByNode.get(receipt.gateNodeId) || [];
    queued.push(receipt);
    gateReceiptsByNode.set(receipt.gateNodeId, queued);
  }
  const gateStepCounts = new Map();
  for (const step of steps) {
    if (step.nodeType !== 'approval-gate') continue;
    gateStepCounts.set(step.nodeId, (gateStepCounts.get(step.nodeId) || 0) + 1);
  }
  const rows = steps.map((step) => {
    const nodeReceipts = gateReceiptsByNode.get(step.nodeId) || [];
    const gateDecision = step.nodeType !== 'approval-gate' ? ''
      : gateStepCounts.get(step.nodeId) === 1 && nodeReceipts.length === 1
        ? renderGateDecision(nodeReceipts[0])
        : nodeReceipts.length > 1 || gateStepCounts.get(step.nodeId) > 1
          ? 'Repeated gate visits cannot be paired to individual step receipts; see Approval gates.'
          : 'Gate decision not linked in available history.';
    return `<li style="padding:8px 0;border-bottom:1px solid var(--glass-border)">
    <strong>${escapeHtml(step.nodeTitle || step.nodeId)}</strong> · ${escapeHtml(step.status || 'outcome not recorded')}
    <div style="font-size:11px;color:var(--text-muted)">#${escapeHtml(step.seq)} ${escapeHtml(step.nodeType)}${step.agentId ? ` · bot ${escapeHtml(step.agentId)}` : ''} · ${escapeHtml(when(step.finishedAt || step.startedAt))}</div>
    ${step.nodeType === 'approval-gate' ? `<div style="font-size:11px;color:var(--text-muted)">${gateDecision}</div>` : ''}
    ${jsonBlock('Input summary', step.inputSummary)}${jsonBlock('Output summary', step.outputSummary)}
  </li>`;
  }).join('');
  const note = otherRunCount ? `<p style="font-size:11px;color:var(--text-muted)">${escapeHtml(otherRunCount)} other run(s) appear in the recent result; Workflow Studio has the run history.</p>` : '';
  return section('Recorded execution', `<p><strong>${escapeHtml(run.workflowName || 'Graph run')}</strong> · ${escapeHtml(run.status)}${run.outcome ? ` · ${escapeHtml(run.outcome)}` : ''}</p>
    <p style="font-size:11px;color:var(--text-muted)">Started ${escapeHtml(when(run.startedAt))}${run.finishedAt ? ` · ended ${escapeHtml(when(run.finishedAt))}` : ''}; ${escapeHtml(run.resumedCount || 0)} resume(s).</p>
    ${run.reason ? `<p>${escapeHtml(run.reason)}</p>` : ''}
    ${steps.length ? `<ol style="padding-left:24px;margin:8px 0">${rows}</ol>` : '<p>No steps were recorded for this run.</p>'}
    ${run.stepsTruncated ? '<p>Only the first 200 recorded steps are shown.</p>' : ''}${note}`);
}

function renderApprovalGates(approvalGates, historyAvailable) {
  if (!historyAvailable) return section('Approval gates', '<p>Gate decisions are unavailable with status history offline.</p>');
  if (!approvalGates.length) return section('Approval gates', '<p>No node-linked approval request is recorded in the available history.</p>');
  const rows = approvalGates.map((receipt) => `<li style="padding:6px 0"><strong>${escapeHtml(receipt.gateNodeId)}</strong> · requested ${escapeHtml(when(receipt.requestedAt))}
    <div style="font-size:11px;color:var(--text-muted)">${renderGateDecision(receipt)}</div></li>`).join('');
  return section('Approval gates', `<p style="font-size:11px;color:var(--text-muted)">A recorded transition identifies the actor and outcome; it does not by itself prove human review.</p><ol style="padding-left:24px;margin:8px 0">${rows}</ol>`);
}

function renderHistory(history, available) {
  if (!available) return section('Decisions and lifecycle', '<p>Status history is unavailable; approval actors cannot be shown.</p>');
  if (!history.length) return section('Decisions and lifecycle', '<p>No lifecycle transitions were recorded.</p>');
  const rows = history.slice(0, 20).map((entry) => `<li style="padding:5px 0">
    ${entry.fromStatus ? `${escapeHtml(entry.fromStatus)} → ` : ''}${escapeHtml(entry.toStatus)}
    <span style="color:var(--text-muted)"> · ${escapeHtml(entry.changedByLabel || 'actor not recorded')} · ${escapeHtml(when(entry.createdAt))}</span>
  </li>`).join('');
  return section('Decisions and lifecycle', `<p style="font-size:11px;color:var(--text-muted)">These are ticket transitions, including holds not caused by graph approval gates.</p><ol style="padding-left:24px;margin:8px 0">${rows}</ol>${history.length > 20 ? '<p>Showing the 20 most recent transitions.</p>' : ''}`);
}

function renderChildren(children, available) {
  if (!available) return section('Child-ticket steps', '<p>Child tickets are unavailable in this view.</p>');
  if (!children.length) return section('Child-ticket steps', '<p>No direct child tickets are recorded.</p>');
  const rows = children.map((child) => `<li style="padding:5px 0"><button type="button" class="td-action-btn" data-workflow-child-id="${escapeHtml(child.ticketId)}">${escapeHtml(child.title || child.ticketId)}</button>
    <span style="color:var(--text-muted)"> ${escapeHtml(child.status)} · ${escapeHtml(child.ticketType || 'type not recorded')} · ${child.assignedAgentId ? `bot ${escapeHtml(child.assignedAgentId)}` : 'unassigned'}</span></li>`).join('');
  return section('Child-ticket steps', `<ol style="padding-left:24px;margin:8px 0">${rows}</ol>`);
}

/**
 * @description Pure renderer for mocked and live authorized workflow projections. Kept free of DOM
 * access so the escaping and honesty wording can be proven without a browser.
 * @param {object} payload - The success body of GET /api/v1/tickets/:ticketId/workflow.
 * @returns {string} Escaped HTML for the Workflow tab body.
 */
export function buildWorkflowTabMarkup(payload) {
  const ticket = payload?.ticket || {};
  const history = Array.isArray(payload?.history) ? payload.history : [];
  const children = Array.isArray(payload?.children) ? payload.children : [];
  const approvalGates = Array.isArray(payload?.approvalGates) ? payload.approvalGates : [];
  return `<div style="font-size:12px;line-height:1.5;color:var(--text-secondary)">
    <p><strong>${escapeHtml(ticket.title || 'Ticket')}</strong> · ${escapeHtml(ticket.ticketType || 'type not recorded')} · ${escapeHtml(ticket.status || 'status not recorded')}${ticket.assignedAgentId ? ` · assigned ${escapeHtml(ticket.assignedAgentId)}` : ' · unassigned'}</p>
    <p style="font-size:11px;color:var(--text-muted)">Queue: ${ticket.queueId ? `${escapeHtml(ticket.queueName || ticket.queueId)} (${escapeHtml(ticket.queueId)})` : 'not recorded'} · Workflow selection: ticket type</p>
    ${renderDefinition(payload?.definition)}
    ${renderRun(payload?.run, payload?.runHistoryAvailable === true, payload?.otherRunCount || 0, approvalGates)}
    ${renderApprovalGates(approvalGates, payload?.historyAvailable === true)}
    ${renderHistory(history, payload?.historyAvailable === true)}
    ${renderChildren(children, payload?.childrenAvailable === true)}
  </div>`;
}

/**
 * @description Fetch one owner-scoped read model and bind child-ticket navigation. A response that
 * arrives after the operator moved to another ticket or tab is dropped via deps.isCurrent.
 * @param {HTMLElement} body - The tab body element to fill.
 * @param {{id: string}} ticket - The ticket whose workflow is shown.
 * @param {{fetchImpl?: Function, isCurrent?: Function, openTicket?: Function}} [deps] - Injectable fetch, staleness check and child navigation.
 * @returns {Promise<void>} Resolves once the tab body is rendered or the stale response is dropped.
 */
export async function renderWorkflowTab(body, ticket, deps = {}) {
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const isCurrent = deps.isCurrent || (() => true);
  const ticketId = String(ticket?.id || '').trim();
  if (!ticketId || !fetchImpl) {
    body.innerHTML = '<p>Workflow view is unavailable for this ticket.</p>';
    return;
  }
  body.innerHTML = '<p>Loading workflow…</p>';
  try {
    const response = await fetchImpl(`/api/v1/tickets/${encodeURIComponent(ticketId)}/workflow`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload?.success) throw new Error('Workflow read failed');
    if (!isCurrent()) return;
    body.innerHTML = buildWorkflowTabMarkup(payload);
    body.querySelectorAll?.('[data-workflow-child-id]').forEach((element) => {
      element.addEventListener('click', () => deps.openTicket?.(element.dataset.workflowChildId));
    });
  } catch (error) {
    logger.error('Ticket workflow read failed', { ticketId, error: serializeUiError(error) });
    if (!isCurrent()) return;
    body.innerHTML = '<p>Could not load this ticket workflow. <button type="button" class="td-action-btn" data-workflow-retry>Retry</button></p>';
    body.querySelector?.('[data-workflow-retry]')?.addEventListener('click', () => {
      void renderWorkflowTab(body, ticket, deps);
    });
  }
}

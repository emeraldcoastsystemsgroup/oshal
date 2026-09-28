/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: correlate each named graph-gate approval request (reason approval_gate, source dispatch-graph-worker, gateNodeId) with the next recorded transition out of that hold, so the ticket workflow view can show who moved a gated ticket on and when without claiming that a transition proves human review.
 */
import type { TicketStatusHistoryRecord } from '@/entities/ticket';

/** @description One graph-gate request and the next recorded transition out of its hold, if any. */
export interface WorkflowGateReceipt {
  gateNodeId: string;
  workflowRunId: string | null;
  requestedAt: string;
  disposition: 'awaiting' | 'unresolved' | 'transitioned';
  decision: {
    toStatus: string;
    actor: string;
    decidedAt: string;
  } | null;
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : '';
}

/**
 * @description Correlate recorded gate requests with the next lifecycle transition out of that hold.
 * History is newest-first. A status transition is not itself proof that a human reviewed the
 * gate; the receipt reports the recorded actor and status without assigning a role or intent.
 * @param history - Status history for one ticket, newest first (as the ticket store returns it).
 * @param currentStatus - The ticket's current status; an open receipt is "awaiting" only while held.
 * @returns One receipt per named graph-gate request, oldest first.
 */
export function projectWorkflowGateReceipts(
  history: TicketStatusHistoryRecord[],
  currentStatus: string,
): WorkflowGateReceipt[] {
  const receipts: WorkflowGateReceipt[] = [];
  let pending: WorkflowGateReceipt | null = null;
  for (const entry of [...history].reverse()) {
    const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
    if (entry.toStatus === 'approval_required') {
      // A later approval hold supersedes an unresolved earlier one. Only the graph worker's
      // named gate request may be projected as a graph approval; other holds stay separate.
      pending = null;
      const gateNodeId = boundedString(metadata.gateNodeId, 120);
      if (metadata.reason === 'approval_gate' && metadata.source === 'dispatch-graph-worker' && gateNodeId) {
        pending = {
          gateNodeId,
          workflowRunId: boundedString(metadata.workflowRunId, 120) || null,
          requestedAt: entry.createdAt,
          disposition: 'unresolved',
          decision: null,
        };
        receipts.push(pending);
      }
      continue;
    }
    if (entry.fromStatus === 'approval_required' && pending) {
      pending.decision = {
        toStatus: boundedString(entry.toStatus, 80),
        actor: boundedString(entry.changedByLabel || entry.changedBy, 160) || 'actor not recorded',
        decidedAt: entry.createdAt,
      };
      pending.disposition = 'transitioned';
      pending = null;
    }
  }
  if (pending && currentStatus === 'approval_required') pending.disposition = 'awaiting';
  return receipts;
}

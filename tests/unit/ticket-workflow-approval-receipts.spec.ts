/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Gate receipt projection: only named dispatch-graph-worker gate requests become receipts, a later hold supersedes an unresolved one, and the next transition out of the hold supplies the recorded actor and status.
 */
import { describe, expect, it } from 'vitest';
import type { TicketStatusHistoryRecord } from '../../src/entities/ticket';
import { projectWorkflowGateReceipts } from '../../src/app/routes/ticket-workflow-approval-receipts';

function event(input: Partial<TicketStatusHistoryRecord>): TicketStatusHistoryRecord {
  return {
    id: input.id || 'event',
    ticketId: input.ticketId || 'ticket-1',
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus || 'approved',
    changedBy: input.changedBy || 'system',
    changedByLabel: input.changedByLabel || 'System',
    metadata: input.metadata || {},
    createdAt: input.createdAt || '2026-09-25T12:00:00.000Z',
  };
}

function gateRequest(nodeId: string, at: string, runId = 'run-1') {
  return event({ fromStatus: 'paused', toStatus: 'approval_required', createdAt: at,
    metadata: { reason: 'approval_gate', source: 'dispatch-graph-worker', gateNodeId: nodeId,
      workflowRunId: runId, token: 'not-for-projection-sentinel' } });
}

describe('graph gate decision receipts', () => {
  it('links the exact gate request to the next transition out, preserving actor and outcome', () => {
    const decision = event({ fromStatus: 'approval_required', toStatus: 'approved',
      changedBy: 'roger', changedByLabel: 'Operator Roger', createdAt: '2026-09-25T12:02:00.000Z' });
    const receipts = projectWorkflowGateReceipts([decision, gateRequest('gate-a', '2026-09-25T12:01:00.000Z')], 'approved');
    expect(receipts).toEqual([{ gateNodeId: 'gate-a', workflowRunId: 'run-1',
      requestedAt: '2026-09-25T12:01:00.000Z', disposition: 'transitioned',
      decision: { toStatus: 'approved', actor: 'Operator Roger', decidedAt: '2026-09-25T12:02:00.000Z' } }]);
    expect(JSON.stringify(receipts)).not.toContain('not-for-projection-sentinel');
  });

  it('does not project generic approval holds or invent a decision actor', () => {
    const generic = event({ toStatus: 'approval_required', metadata: { reason: 'planning_complete' } });
    expect(projectWorkflowGateReceipts([generic], 'approval_required')).toEqual([]);
    expect(projectWorkflowGateReceipts([gateRequest('gate-a', '2026-09-25T12:01:00.000Z')], 'approval_required'))
      .toMatchObject([{ disposition: 'awaiting', decision: null }]);
    expect(projectWorkflowGateReceipts([gateRequest('gate-a', '2026-09-25T12:01:00.000Z')], 'complete'))
      .toMatchObject([{ disposition: 'unresolved', decision: null }]);
  });

  it('keeps repeated gate visits distinct and does not call a cancellation an approval', () => {
    const history = [
      event({ fromStatus: 'approval_required', toStatus: 'cancelled', changedByLabel: 'Operator Two', createdAt: '2026-09-25T12:04:00.000Z' }),
      gateRequest('gate-a', '2026-09-25T12:03:00.000Z'),
      event({ fromStatus: 'approval_required', toStatus: 'approved', changedByLabel: 'Operator One', createdAt: '2026-09-25T12:02:00.000Z' }),
      gateRequest('gate-a', '2026-09-25T12:01:00.000Z'),
    ];
    const receipts = projectWorkflowGateReceipts(history, 'cancelled');
    expect(receipts.map((receipt) => receipt.decision?.toStatus)).toEqual(['approved', 'cancelled']);
    expect(receipts.map((receipt) => receipt.decision?.actor)).toEqual(['Operator One', 'Operator Two']);
  });
});

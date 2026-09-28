/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Graph gate lifecycle through the real dispatch worker and in-memory ticket store: same-millisecond transitions keep causal order and the stamped gate node and run ids produce a receipt with the resuming actor.
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryTicketStore, TicketService } from '../../src/features/ticketing';
import { CreateInternalTicketSchema } from '../../src/entities/ticket';
import { dispatchGraphTicket } from '../../src/features/swarm-orchestration/services/dispatch-graph-worker';
import { projectWorkflowGateReceipts } from '../../src/app/routes/ticket-workflow-approval-receipts';
import type { WorkflowRunFinishInput, WorkflowRunStartInput, WorkflowRunStepInput } from '../../src/features/workflow-studio/services/workflow-run-history-store';

const workflow = {
  ticketType: 'approval-proof',
  name: 'Approval lifecycle proof',
  pipeline: 'graph',
  workerBot: '',
  processDefinition: { name: 'Approval lifecycle proof', nodeGraph: {
    nodes: [
      { id: 'start', type: 'start', title: 'Start', config: {} },
      { id: 'gate', type: 'approval-gate', title: 'Review result', config: {} },
      { id: 'deliver', type: 'deliver', title: 'Deliver', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'gate' },
      { id: 'e2', source: 'gate', target: 'deliver' },
    ],
    topologicalOrder: ['start', 'gate', 'deliver'],
  } },
};

describe('ticket workflow graph gate lifecycle', () => {
  it('keeps rapid same-millisecond status transitions in causal order', async () => {
    const store = new InMemoryTicketStore();
    const timestamp = '2026-09-25T12:00:00.000Z';
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(timestamp));
      await store.recordStatusHistory('ticket-1', 'approved', 'paused', 'system', 'System');
      await store.recordStatusHistory('ticket-1', 'paused', 'approval_required', 'system', 'System', {
        reason: 'approval_gate', source: 'dispatch-graph-worker', gateNodeId: 'gate', workflowRunId: 'run-1',
      });
      const history = await store.getStatusHistory('ticket-1', 20);
      expect(history.map((entry) => entry.toStatus)).toEqual(['approval_required', 'paused']);
      expect(projectWorkflowGateReceipts(history, 'approval_required')).toMatchObject([
        { gateNodeId: 'gate', disposition: 'awaiting' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs, parks with a gate receipt, records the decision actor, then resumes the same run', async () => {
    const service = new TicketService(new InMemoryTicketStore());
    const ticket = await service.createTicket(CreateInternalTicketSchema.parse({ title: 'Review and deliver', ownerSub: 'owner-1',
      ticketType: 'approval-proof', status: 'approved' }));
    const recorder = {
      startRun: vi.fn(async (_input: WorkflowRunStartInput) => 'run-1'),
      resumeRun: vi.fn(async (_runId: string) => true),
      recordStep: vi.fn(async (_runId: string, _step: WorkflowRunStepInput) => undefined),
      finishRun: vi.fn(async (_runId: string, _input: WorkflowRunFinishInput) => undefined),
    };
    const deps = { activeTicketIds: new Set<string>(), dispatchStartTimes: new Map<string, number>(),
      ticketService: service, runRecorder: recorder };

    await dispatchGraphTicket(ticket, workflow, deps);
    const parked = await service.getTicket(ticket.ticketId);
    expect(parked?.status).toBe('approval_required');
    const requestHistory = await service.getStatusHistory(ticket.ticketId, 20);
    expect(requestHistory[0].metadata).toMatchObject({ reason: 'approval_gate',
      gateNodeId: 'gate', workflowRunId: 'run-1' });
    expect(projectWorkflowGateReceipts(requestHistory, parked!.status)).toMatchObject([
      { gateNodeId: 'gate', workflowRunId: 'run-1', disposition: 'awaiting', decision: null },
    ]);

    await service.updateStatusAs(ticket.ticketId, 'approved', 'owner-1', 'Operator Owner');
    const decisionHistory = await service.getStatusHistory(ticket.ticketId, 20);
    expect(projectWorkflowGateReceipts(decisionHistory, 'approved')).toMatchObject([
      { gateNodeId: 'gate', disposition: 'transitioned',
        decision: { toStatus: 'approved', actor: 'Operator Owner' } },
    ]);

    await dispatchGraphTicket((await service.getTicket(ticket.ticketId))!, workflow, deps);
    expect((await service.getTicket(ticket.ticketId))?.status).toBe('complete');
    expect(recorder.startRun).toHaveBeenCalledTimes(1);
    expect(recorder.resumeRun).toHaveBeenCalledWith('run-1');
    expect(recorder.recordStep.mock.calls.map((call) => call[1].nodeId)).toEqual(['start', 'gate', 'deliver']);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { compileWorkflowSpec } from '../../src/features/swarm-apps/services/workflow-publish-compiler';
import { dispatchGraphTicket } from '../../src/features/swarm-orchestration/services/dispatch-graph-worker';

describe('workflow authoring e2e', () => {
  it('compiles an authored workflow, pauses at approval, resumes, and records terminal history', async () => {
    const manifest = compileWorkflowSpec(
      {
        name: 'customer-onboarding',
        displayName: 'Customer Onboarding',
        mode: 'staged',
        stages: [
          { bot: 'intake-bot', name: 'Intake', approvalAfter: true },
          { bot: 'delivery-bot', name: 'Delivery' },
        ],
      },
      'person',
    );

    const workflow = {
      ticketType: manifest.ticketType,
      name: manifest.workflow?.name ?? manifest.displayName,
      pipeline: manifest.workflow?.pipeline ?? 'graph',
      workerBot: manifest.workflow?.workerBot ?? 'intake-bot',
      stages: manifest.workflow?.stages,
      processDefinition: manifest.workflow?.processDefinition,
    };

    const ticket = {
      ticketId: 'ticket-authored-1',
      externalId: 'ticket-authored-1',
      title: 'Onboard Acme',
      body: 'Create the kickoff checklist and delivery plan.',
      ticketType: manifest.ticketType,
      status: 'approved',
      metadata: {},
    } as any;

    const history: Array<{ fromStatus: string; toStatus: string; metadata?: unknown }> = [];
    const dispatchedAgents: string[] = [];

    const recordStatus = (toStatus: string, metadata?: unknown) => {
      history.push({ fromStatus: ticket.status, toStatus, metadata });
      ticket.status = toStatus;
    };

    const ticketService = {
      updateTicket: vi.fn(async (_ticketId: string, patch: { metadata?: Record<string, unknown> }) => {
        ticket.metadata = { ...(patch.metadata ?? {}) };
        return ticket;
      }),
      updateStatus: vi.fn(async (_ticketId: string, status: string, metadata?: unknown) => {
        recordStatus(status, metadata);
        return ticket;
      }),
    };

    const deps = {
      activeTicketIds: new Set<string>(),
      dispatchStartTimes: new Map<string, number>(),
      resolveAgentIdByName: vi.fn(async (name: string) => ({
        'intake-bot': 'agent-intake',
        'delivery-bot': 'agent-delivery',
      })[name]),
      botNodeClient: {
        execute: vi.fn(async (agentId: string) => {
          dispatchedAgents.push(agentId);
          return { success: true, response: `ok:${agentId}` };
        }),
      },
      ticketService,
      port: '5000',
    } as any;

    await dispatchGraphTicket(ticket, workflow as any, deps);

    expect(ticket.status).toBe('approval_required');
    // Durable-execution contract (2026-07-05): the approval-gate suspend persists a
    // workflowCheckpoint {resumeNodeId, snapshot} instead of the legacy bare
    // graphResumeNode string (which the worker still READS for old tickets but no
    // longer writes). Same protective intent: pause must persist where to resume.
    expect(ticket.metadata.workflowCheckpoint?.resumeNodeId).toBe('n-stage-1');
    expect(history.map((entry) => entry.toStatus)).toEqual(['paused', 'approval_required']);
    expect(dispatchedAgents).toEqual(['agent-intake']);

    recordStatus('approved', { source: 'operator-resume' });
    await dispatchGraphTicket(ticket, workflow as any, deps);

    expect(ticket.status).toBe('complete');
    expect(ticket.metadata.workflowCheckpoint).toBeUndefined();
    expect(ticket.metadata.graphResumeNode).toBeUndefined();
    expect(dispatchedAgents).toEqual(['agent-intake', 'agent-delivery']);
    expect(history.map((entry) => entry.toStatus)).toEqual([
      'paused',
      'approval_required',
      'approved',
      'complete',
    ]);
    expect(ticketService.updateStatus).toHaveBeenLastCalledWith('ticket-authored-1', 'complete', undefined);
  });
});

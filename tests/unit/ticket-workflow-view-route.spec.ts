/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Route contract for GET /tickets/:ticketId/workflow: owner, other-user and application-result denial answer 404 before any run or history read; the projection carries no raw ticket metadata, history metadata or node config; unavailable sources are flagged rather than inferred.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleGetCockpitTicketWorkflow } from '../../src/app/routes/cockpit-ticket-workflow-route';
import type { WorkflowDefinition } from '../../src/features/swarm-orchestration/services/dispatch-routing';

const TICKET_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const OWNER = 'auth0|owner';

function makeFixture(sub = OWNER, ticketOwner = OWNER) {
  const getTicket = vi.fn(async () => ({
    ticketId: TICKET_ID,
    title: 'Import <review>',
    ticketType: 'import-review',
    status: 'approval_required',
    ownerSub: ticketOwner,
    assignedAgentId: 'worker-a',
    metadata: { workflowRunId: RUN_ID, queueId: 'import-work', queueName: 'Import <Work>', secret: 'raw-ticket-sentinel' },
  }));
  const getStatusHistory = vi.fn(async () => [{
    fromStatus: 'approval_required', toStatus: 'approved', changedBy: 'user-1',
    changedByLabel: 'Roger <owner>', createdAt: '2026-09-25T12:00:00.000Z',
    metadata: { token: 'raw-history-sentinel' },
  }, {
    fromStatus: 'paused', toStatus: 'approval_required', changedBy: 'system',
    changedByLabel: 'System', createdAt: '2026-09-25T11:59:00.000Z',
    metadata: { reason: 'approval_gate', source: 'dispatch-graph-worker',
      gateNodeId: 'old-node', workflowRunId: RUN_ID, token: 'raw-history-sentinel' },
  }]);
  const listTickets = vi.fn(async () => [{
    ticketId: '33333333-3333-4333-8333-333333333333', title: 'Child <build>',
    ownerSub: ticketOwner, parentTicketId: TICKET_ID, status: 'in_process_build',
    ticketType: 'build', assignedAgentId: 'bot-child',
  }]);
  const listRuns = vi.fn(async () => [{
    runId: RUN_ID, ticketId: TICKET_ID, ownerSub: ticketOwner,
    workflowName: 'Graph', status: 'suspended',
  }]);
  const getRun = vi.fn(async () => ({
    runId: RUN_ID, ticketId: TICKET_ID, ownerSub: ticketOwner,
    workflowName: 'Original <graph>', status: 'suspended', outcome: 'waiting',
    reason: 'token=raw-run-reason-sentinel', resumedCount: 1, startedAt: '2026-09-25T11:00:00.000Z', finishedAt: null,
    steps: [{
      stepId: 'step-1', seq: 1, nodeId: 'old-node', nodeType: 'execute-agent',
      nodeTitle: 'Old <node>', agentId: 'worker-a', status: 'completed',
      inputSummary: { apiKey: 'raw-run-sentinel', title: 'safe value' },
      outputSummary: { artifact: 'deliverables/report.md' },
      startedAt: '2026-09-25T11:00:00.000Z', finishedAt: '2026-09-25T11:01:00.000Z',
    }],
  }));
  const canReadApplicationResult = vi.fn(async () => true);
  const resolveWorkflow = vi.fn((_ticketType: string): WorkflowDefinition | undefined => ({
    name: 'Current <graph>', ticketType: 'import-review', pipeline: 'graph', workerBot: 'worker-a',
    processDefinition: { nodeGraph: {
      nodes: [{ id: 'new-node', type: 'approval-gate', title: 'Review <now>', config: { password: 'raw-definition-sentinel' } }],
      edges: [],
    } },
  }));
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as { oidc?: unknown }).oidc = { user: { sub } };
    next();
  });
  app.get('/api/v1/tickets/:ticketId/workflow', handleGetCockpitTicketWorkflow({
    pool: null,
    ticketService: { getTicket, getStatusHistory, listTickets },
  } as never, {
    runReader: { listRuns, getRun } as never,
    resolveWorkflow,
    canReadApplicationResult,
  }));
  return { app, getTicket, getStatusHistory, listTickets, listRuns, getRun, canReadApplicationResult, resolveWorkflow };
}

const servers: Array<{ close: (cb: () => void) => void }> = [];
async function read(app: express.Express) {
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return fetch(`http://127.0.0.1:${address.port}/api/v1/tickets/${TICKET_ID}/workflow`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))));
});

describe('ticket workflow read model', () => {
  it('projects current definition separately from historical execution, approval actors and child assignments', async () => {
    const fixture = makeFixture();
    const response = await read(fixture.app);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.definition).toMatchObject({ name: 'Current <graph>', defaultWorkerBot: 'worker-a', historicalSnapshot: false,
      nodes: [{ id: 'new-node', type: 'approval-gate', title: 'Review <now>' }] });
    expect(body.ticket).toMatchObject({ queueId: 'import-work', queueName: 'Import <Work>', ticketType: 'import-review' });
    expect(body.run).toMatchObject({ workflowName: 'Original <graph>', steps: [{ nodeId: 'old-node',
      inputSummary: { apiKey: '[REDACTED]', title: 'safe value' } }] });
    expect(body.history[0]).toMatchObject({ changedByLabel: 'Roger <owner>' });
    expect(body.approvalGates).toMatchObject([{ gateNodeId: 'old-node', workflowRunId: RUN_ID,
      decision: { toStatus: 'approved', actor: 'Roger <owner>' } }]);
    expect(body.children).toMatchObject([{ title: 'Child <build>', assignedAgentId: 'bot-child' }]);
    const serialized = JSON.stringify(body);
    for (const secret of ['raw-ticket-sentinel', 'raw-history-sentinel', 'raw-run-sentinel', 'raw-run-reason-sentinel', 'raw-definition-sentinel']) {
      expect(serialized).not.toContain(secret);
    }
    expect(fixture.listRuns).toHaveBeenCalledWith({ ticketId: TICKET_ID, ownerSub: OWNER, limit: 20 });
  });

  it('returns 404 before reading history, children or runs for another owner', async () => {
    const fixture = makeFixture('auth0|other');
    const response = await read(fixture.app);
    expect(response.status).toBe(404);
    expect(fixture.getStatusHistory).not.toHaveBeenCalled();
    expect(fixture.listTickets).not.toHaveBeenCalled();
    expect(fixture.listRuns).not.toHaveBeenCalled();
  });

  it('returns 404 before reading workflow evidence when application-result access is denied', async () => {
    const fixture = makeFixture();
    fixture.canReadApplicationResult.mockResolvedValueOnce(false);
    const response = await read(fixture.app);
    expect(response.status).toBe(404);
    expect(fixture.getStatusHistory).not.toHaveBeenCalled();
    expect(fixture.listTickets).not.toHaveBeenCalled();
    expect(fixture.listRuns).not.toHaveBeenCalled();
  });

  it('never substitutes another owner’s run, even if the reader returns one', async () => {
    const fixture = makeFixture();
    fixture.listRuns.mockResolvedValueOnce([{ runId: RUN_ID, ticketId: TICKET_ID, ownerSub: 'auth0|other', workflowName: 'Other', status: 'complete' }]);
    const response = await read(fixture.app);
    const body = await response.json();
    expect(body.run).toBeNull();
    expect(fixture.getRun).not.toHaveBeenCalled();
  });

  it('returns explicit unavailable markers when evidence stores fail, without inventing a result', async () => {
    const fixture = makeFixture();
    fixture.getStatusHistory.mockRejectedValueOnce(new Error('history offline'));
    fixture.listTickets.mockRejectedValueOnce(new Error('children offline'));
    fixture.listRuns.mockRejectedValueOnce(new Error('runs offline'));
    const response = await read(fixture.app);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ historyAvailable: false, history: [], childrenAvailable: false,
      children: [], runHistoryAvailable: false, run: null });
  });

  it('keeps a workflow-less ticket visible without claiming a graph run', async () => {
    const fixture = makeFixture();
    fixture.resolveWorkflow.mockReturnValueOnce(undefined);
    fixture.listRuns.mockResolvedValueOnce([]);
    const response = await read(fixture.app);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.definition).toBeNull();
    expect(body.run).toBeNull();
    expect(body.runHistoryAvailable).toBe(true);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-13 / D6 done-when (b). A graph ticket is dispatched from `approved` and no code writes an in_process_* status, so a ticket parked at a gate said only "Approval Required" - which node of which workflow was waiting, and what had just finished, lived in metadata and a workflow_run_steps row nobody joined. The REAL dispatchGraphTicket drives the REAL ProcessDefinitionExecutionEngine here against a disposable postgres:16-alpine running migration 062 as shipped, with the REAL WorkflowRunHistoryStore recording steps. The ONLY double is the bot dispatch at the engine-services seam, which is where the done-when says to put it: what a bot returns is not this claim. Self-validated - the run and its step are read back off the table directly before anything about the position is asserted, so a fixture that recorded nothing fails loudly instead of letting the position assertions pass on an empty read.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { dispatchGraphTicket } from '@/features/swarm-orchestration/services/dispatch-graph-worker';
import { WorkflowRunHistoryStore } from '@/features/workflow-studio/services/workflow-run-history-store';
import { readTicketWorkflowPosition } from '@/app/routes/ticket-workflow-position';
import type { InternalTicket } from '@/entities/ticket';

// workflow_runs.ticket_id is a UUID column, so the fixture ticket needs a real one. The first
// cut used 'tkt-ckr13' and startRun swallowed the 22P02 and returned null - the run recorded
// nothing and every position assertion would have passed on an empty read. That is what the
// self-validation below is for.
const TICKET_ID = '3f7a1c90-5b2e-4d61-9a03-8c4e1b6d27f5';
const OWNER = 'auth0|ckr13-owner';

const fixture = new DisposablePostgres({
  purpose: 'ticket-workflow-position',
  migrations: ['062-workflow-run-history.sql'],
});

let pool: Pool;
let recorder: WorkflowRunHistoryStore;

/** A two-node run with a gate between them: the bot node, then the approval gate. */
const PROCESS_DEFINITION = {
  name: 'Gated Flow',
  nodeGraph: {
    nodes: [
      { id: 'n-start', type: 'start', title: 'Start', config: { triggerMode: 'manual' } },
      {
        id: 'n-draft',
        type: 'execute-agent',
        title: 'Draft the thing',
        config: { agentBinding: 'drafting-bot', workType: 'authored' },
      },
      {
        id: 'n-gate',
        type: 'approval-gate',
        title: 'Confirm before delivery',
        config: { gateState: 'approval_required' },
      },
      { id: 'n-deliver', type: 'deliver', title: 'Deliver', config: { deliveryMode: 'standard' } },
    ],
    edges: [
      { id: 'e1', source: 'n-start', target: 'n-draft' },
      { id: 'e2', source: 'n-draft', target: 'n-gate' },
      { id: 'e3', source: 'n-gate', target: 'n-deliver' },
    ],
    topologicalOrder: ['n-start', 'n-draft', 'n-gate', 'n-deliver'],
  },
};

/** The ticket, mutated by the fake service exactly as the real one would persist it. */
let ticketState: { status: string; metadata: Record<string, unknown> };

/** The ONLY double: what a bot returns is not this spec's claim. */
const botNodeClient = {
  execute: async () => ({ success: true, output: 'drafted', content: 'drafted' }),
};

const ticketService = {
  getTicket: async () => ({ ticketId: TICKET_ID, ...ticketState } as unknown as InternalTicket),
  updateStatus: async (_id: string, status: string) => { ticketState.status = status; },
  updateTicket: async (_id: string, updates: { metadata?: Record<string, unknown> }) => {
    if (updates.metadata) ticketState.metadata = updates.metadata;
  },
};

beforeAll(async () => {
  pool = await fixture.start();
  recorder = new WorkflowRunHistoryStore(pool);
}, 180_000);

afterAll(async () => {
  await fixture.stop();
}, 60_000);

describe('a graph ticket parked at a gate can say where it is', () => {
  it('suspends at the gate, records a step, and the position names both', async () => {
    ticketState = { status: 'approved', metadata: { ownerSub: OWNER } };

    await dispatchGraphTicket(
      { ticketId: TICKET_ID, ownerSub: OWNER, metadata: ticketState.metadata } as unknown as InternalTicket,
      {
        ticketType: 'ckr13-gated',
        name: 'Gated Flow',
        pipeline: 'graph',
        workerBot: 'drafting-bot',
        processDefinition: PROCESS_DEFINITION,
      },
      {
        activeTicketIds: new Set<string>(),
        dispatchStartTimes: new Map<string, number>(),
        ticketService,
        botNodeClient,
        runRecorder: recorder,
        resolveAgentIdByName: async () => 'agent-drafting',
      } as never,
    );

    // Self-validation FIRST: if the fixture recorded nothing, every assertion below would pass on
    // an empty read and prove nothing at all.
    const runs = await pool.query('SELECT run_id FROM workflow_runs');
    expect(runs.rowCount, 'no workflow run was recorded — the fixture is not exercising the recorder')
      .toBeGreaterThan(0);
    const steps = await pool.query('SELECT node_id, node_title FROM workflow_run_steps ORDER BY seq');
    expect(steps.rowCount, 'no workflow step was recorded').toBeGreaterThan(0);

    // The ticket is parked, and the status is the one the cockpit badge reads.
    expect(ticketState.status, 'the run did not park at the gate').toBe('approval_required');

    const position = await readTicketWorkflowPosition(pool, ticketState.metadata);
    expect(position, 'the ticket carries no workflowRunId, so no position could be read').toBeTruthy();
    expect(position?.runId).toBe(String(runs.rows[0].run_id));

    // The resume point: what the engine will continue from on approval.
    expect(position?.resumeNodeId, 'no resume node — an approved ticket would restart the run')
      .toBeTruthy();
    expect(position?.resumeNodeIdIsLegacy, 'the checkpoint key should be the one in use').toBe(false);

    // And the node title, from the most recent recorded step.
    expect(position?.lastStep, 'no last step — the operator still cannot see what just ran').toBeTruthy();
    expect(position?.lastStep?.nodeTitle, 'the step carries no title to show')
      .toBe(String(steps.rows[steps.rowCount - 1].node_title));
    expect(position?.lastStep?.nodeId).toBe(String(steps.rows[steps.rowCount - 1].node_id));
  }, 120_000);

  it('a ticket that is not a graph run has no position at all', async () => {
    // The enrichment must be absent, not empty: every non-graph ticket's payload stays identical.
    expect(await readTicketWorkflowPosition(pool, { some: 'ordinary ticket' })).toBeNull();
    expect(await readTicketWorkflowPosition(pool, null)).toBeNull();
  });

  it('the pre-2026-07-05 resume key is still read, and is flagged as legacy', async () => {
    // Not hypothetical: on 2026-09-19 five tickets on the operator box carried graphResumeNode,
    // three of them still parked at approval_required. Retiring this fallback would strand them,
    // which is why CKR-13 (c) gates that retirement on a live count of zero.
    const position = await readTicketWorkflowPosition(pool, {
      workflowRunId: '00000000-0000-0000-0000-000000000000',
      graphResumeNode: 'n-gate',
    });
    expect(position?.resumeNodeId).toBe('n-gate');
    expect(position?.resumeNodeIdIsLegacy, 'a legacy resume point must be identifiable as one').toBe(true);
  });

  it('the checkpoint wins over the legacy key when a ticket carries both', async () => {
    const position = await readTicketWorkflowPosition(pool, {
      workflowRunId: '00000000-0000-0000-0000-000000000000',
      workflowCheckpoint: { resumeNodeId: 'n-current' },
      graphResumeNode: 'n-stale',
    });
    expect(position?.resumeNodeId).toBe('n-current');
    expect(position?.resumeNodeIdIsLegacy).toBe(false);
  });
});

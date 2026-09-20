/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-18 / CV-4. readAgentHandover's second parameter is the WORKSPACE task id - it names it - and both call sites in the dispatch service passed the TICKET id. Wherever the two differ the read looked in a directory the handover was never written to and reported a missing handover for a round that wrote one, which is what made the coverage check incapable of passing at all. The defect is WHICH ID IS PASSED, so that is what this asserts: the real MultiRoundDispatchService, driven through its public entry, with the handover manager doubled ON the seam whose argument is the claim. Nothing else about handovers is being tested here - what a handover document contains, and whether coverage is reported, live in handover-coverage-not-a-gate.spec.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { MultiRoundDispatchService } from '@/features/swarm-orchestration/services/multi-round-dispatch-service';

const TICKET_ID = 'tkt-cv4';
const WORKSPACE_TASK_ID = 'ws-task-cv4-different-on-purpose';

/** Records the id each handover read was made against — the whole point of this spec. */
function recordingHandoverManager() {
  const readsFor: string[] = [];
  return {
    readsFor,
    manager: {
      readAgentHandover: (_agentId: string, workspaceTaskId: string) => {
        readsFor.push(workspaceTaskId);
        // Answer as if the handover is there, so the run proceeds and the ASSERTION is about
        // which directory was consulted rather than about what the check concluded.
        return { agentId: _agentId, content: 'x'.repeat(200), modifiedAt: new Date() };
      },
      readHandovers: () => [],
    },
  };
}

/**
 * Enough of the mesh to let a round reach the handover read. `send` is what executeRound calls;
 * omitting it threw before the read and the self-validation below caught that rather than letting
 * the assertion pass on an empty list. No workItemRepository is injected, so awaitRoundOutput
 * returns immediately — waiting for real work is not this claim.
 */
function stubMesh() {
  return { send: vi.fn(async () => undefined) };
}

describe('the handover read uses the workspace task id, not the ticket id', () => {
  it('a phase driven with a workspaceTaskId reads handovers against THAT id', async () => {
    const { readsFor, manager } = recordingHandoverManager();
    const service = new MultiRoundDispatchService({
      meshService: stubMesh() as never,
      handoverManager: manager as never,
      selectAgent: (async () => 'agent-1') as never,
    } as never);

    await service.executePhaseWithRounds(
      'run-1',
      TICKET_ID,
      2,
      [{ id: 'wu-1', title: 'do the thing', description: 'x' } as never],
      'agent-1',
      { maxRounds: 1, roundTimeoutMs: 10 } as never,
      WORKSPACE_TASK_ID,
    ).catch(() => undefined); // a stubbed mesh may not complete the phase; the read still happened

    expect(readsFor.length, 'no handover read was attempted — the fixture never reached the check')
      .toBeGreaterThan(0);
    expect(readsFor, 'the read used the TICKET id, so it looked where the handover was never written')
      .not.toContain(TICKET_ID);
    expect(readsFor, 'the read did not use the workspace task id').toContain(WORKSPACE_TASK_ID);
  });

  it('with no workspaceTaskId it falls back to the ticket id — the pre-existing behaviour', async () => {
    // The fix must not require a workspace id that older callers do not thread through.
    const { readsFor, manager } = recordingHandoverManager();
    const service = new MultiRoundDispatchService({
      meshService: stubMesh() as never,
      handoverManager: manager as never,
      selectAgent: (async () => 'agent-1') as never,
    } as never);

    await service.executePhaseWithRounds(
      'run-1',
      TICKET_ID,
      2,
      [{ id: 'wu-1', title: 'do the thing', description: 'x' } as never],
      'agent-1',
      { maxRounds: 1, roundTimeoutMs: 10 } as never,
    ).catch(() => undefined);

    expect(readsFor.length, 'no handover read was attempted').toBeGreaterThan(0);
    expect(readsFor).toContain(TICKET_ID);
  });
});

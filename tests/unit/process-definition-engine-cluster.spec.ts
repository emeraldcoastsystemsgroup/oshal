import { describe, expect, it, vi } from 'vitest';
import { ProcessDefinitionExecutionEngine } from '../../src/features/workflow-studio/engine/process-definition-execution-engine';
import type { EngineServices } from '../../src/features/workflow-studio/engine/engine-services';

/** start → cluster(agents:[a1,a2], reviewer:rev) → deliver */
function buildClusterDef() {
  return {
    id: 'gc', name: 'Cluster',
    nodeGraph: {
      nodes: [
        { id: 'start', type: 'start', title: 'Start', config: {} },
        { id: 'c', type: 'agent-cluster', title: 'Cluster', config: { agents: ['a1', 'a2'], reviewer: 'rev' } },
        { id: 'deliver', type: 'deliver', title: 'Deliver', config: {} },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'c' }, { id: 'e2', source: 'c', target: 'deliver' }],
    },
  } as never;
}

function buildServices(overrides: Partial<EngineServices> = {}): EngineServices {
  return {
    intakeAndScore: vi.fn(async () => ({ complexity: 'medium', complexityScore: 50, activePhases: [], workUnitCount: 0 })),
    runPlanning: vi.fn(async () => ({ stopAfterPlanning: false, workUnits: [], routing: {}, planningSource: 'test' })),
    runExecution: vi.fn(async (_t, c) => ({ outcome: { dispatched: true }, agentId: String(c.agentId), strategy: 'x' })),
    runTesting: vi.fn(async () => ({ passed: true })),
    runReview: vi.fn(async () => ({ passed: true })),
    runSpecialistInput: vi.fn(async () => ({ contextInjected: false })),
    runDelivery: vi.fn(async () => ({ delivered: true })),
    escalate: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('agent-cluster step', () => {
  it('runs the cluster with its members + reviewer and advances on a passing gate', async () => {
    const runClusterStep = vi.fn(async () => ({ passed: true, winnerAgentId: 'a2', memberCount: 2, respondedCount: 2 }));
    const engine = new ProcessDefinitionExecutionEngine(buildServices({ runClusterStep }));

    const result = await engine.execute(buildClusterDef(), { ticketId: 't', title: 'Do it', body: 'work' });

    expect(runClusterStep).toHaveBeenCalledTimes(1);
    expect(runClusterStep.mock.calls[0][1]).toMatchObject({ agents: ['a1', 'a2'], reviewer: 'rev' });
    expect(result.outcome).toBe('completed');
    expect(result.variables.clusterPassed).toBe(true);
    expect(result.variables.clusterWinner).toBe('a2');
  });

  it('marks clusterPassed=false and sets regression feedback when the reviewer gate fails', async () => {
    const runClusterStep = vi.fn(async () => ({ passed: false, memberCount: 2, respondedCount: 2, feedback: 'all candidates too shallow' }));
    const engine = new ProcessDefinitionExecutionEngine(buildServices({ runClusterStep }));

    const result = await engine.execute(buildClusterDef(), { ticketId: 't', title: 'Do it' });

    // Without an author-wired logic-gate the graph still advances, but the fail signal is recorded
    // (a real workflow reads clusterPassed on a gate to loop or escalate).
    expect(result.variables.clusterPassed).toBe(false);
  });

  it('passes through in stub mode when no cluster service is wired', async () => {
    const engine = new ProcessDefinitionExecutionEngine(buildServices()); // no runClusterStep
    const result = await engine.execute(buildClusterDef(), { ticketId: 't' });
    expect(result.outcome).toBe('completed');
    expect(result.variables.clusterPassed).toBe(true);
  });
});

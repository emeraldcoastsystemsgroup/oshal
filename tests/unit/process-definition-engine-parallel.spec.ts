import { describe, expect, it, vi } from 'vitest';
import { ProcessDefinitionExecutionEngine } from '../../src/features/workflow-studio/engine/process-definition-execution-engine';
import type { EngineServices } from '../../src/features/workflow-studio/engine/engine-services';

/**
 * A parallel region: start → split ⇒ {branchA, branchB} → join → deliver.
 * Proves BOTH branches run (the bug being fixed: passthrough split ran only the first edge).
 */
function buildParallelDefinition() {
  return {
    id: 'graph-parallel',
    name: 'Parallel Graph',
    nodeGraph: {
      nodes: [
        { id: 'start', type: 'start', title: 'Start', config: {} },
        { id: 'split', type: 'parallel-split', title: 'Fan out', config: {} },
        { id: 'a', type: 'execute-agent', title: 'Branch A', config: { agentId: 'agent-a', workType: 'authored' } },
        { id: 'b', type: 'execute-agent', title: 'Branch B', config: { agentId: 'agent-b', workType: 'authored' } },
        { id: 'join', type: 'parallel-join', title: 'Join', config: {} },
        { id: 'deliver', type: 'deliver', title: 'Deliver', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'split' },
        { id: 'e2', source: 'split', target: 'a' },
        { id: 'e3', source: 'split', target: 'b' },
        { id: 'e4', source: 'a', target: 'join' },
        { id: 'e5', source: 'b', target: 'join' },
        { id: 'e6', source: 'join', target: 'deliver' },
      ],
    },
  } as never;
}

function buildServices(overrides: Partial<EngineServices> = {}): EngineServices {
  return {
    intakeAndScore: vi.fn(async () => ({ complexity: 'medium', complexityScore: 50, activePhases: [], workUnitCount: 0 })),
    runPlanning: vi.fn(async () => ({ stopAfterPlanning: false, workUnits: [], routing: {}, planningSource: 'test' })),
    runExecution: vi.fn(async () => ({ outcome: { dispatched: true }, agentId: 'x', strategy: 'authored-stage' })),
    runTesting: vi.fn(async () => ({ passed: true })),
    runReview: vi.fn(async () => ({ passed: true })),
    runSpecialistInput: vi.fn(async () => ({ contextInjected: false })),
    runDelivery: vi.fn(async () => ({ delivered: true })),
    escalate: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('process definition engine — parallel-split fan-out', () => {
  it('runs EVERY branch of a parallel split, then continues past the join to deliver', async () => {
    const dispatched: string[] = [];
    const services = buildServices({
      runExecution: vi.fn(async (_ticket, config) => {
        dispatched.push(String(config.agentId));
        return { outcome: { dispatched: true }, agentId: String(config.agentId), strategy: 'authored-stage' };
      }),
    });
    const engine = new ProcessDefinitionExecutionEngine(services);

    const result = await engine.execute(buildParallelDefinition(), { ticketId: 't-par', title: 'Parallel work' });

    expect(dispatched.sort()).toEqual(['agent-a', 'agent-b']); // BOTH branches executed
    expect(result.outcome).toBe('completed');
    expect(result.success).toBe(true);
    expect(services.runDelivery).toHaveBeenCalledTimes(1); // join → deliver runs once
  });

  it('runs the branches CONCURRENTLY — both dispatch before either completes', async () => {
    let started = 0;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const services = buildServices({
      runExecution: vi.fn(async (_ticket, config) => {
        started += 1;
        if (started === 2) releaseGate(); // both branches are in-flight at once
        await gate; // a SEQUENTIAL engine would hang here forever (started never reaches 2)
        return { outcome: { dispatched: true }, agentId: String(config.agentId), strategy: 'authored-stage' };
      }),
    });
    const engine = new ProcessDefinitionExecutionEngine(services);

    const result = await engine.execute(buildParallelDefinition(), { ticketId: 't-conc', title: 'Concurrent work' });

    expect(started).toBe(2); // proves both branch bots were dispatched simultaneously
    expect(result.outcome).toBe('completed');
  });

  it('escalates the workflow when a parallel branch fails (does not falsely complete)', async () => {
    const services = buildServices({
      runExecution: vi.fn(async (_ticket, config) => {
        if (String(config.agentId) === 'agent-b') {
          return { outcome: { dispatched: false, reason: 'bot-b refused' }, agentId: 'agent-b', strategy: 'authored-stage' };
        }
        return { outcome: { dispatched: true }, agentId: String(config.agentId), strategy: 'authored-stage' };
      }),
    });
    const engine = new ProcessDefinitionExecutionEngine(services);

    const result = await engine.execute(buildParallelDefinition(), { ticketId: 't-fail', title: 'One branch fails' });

    expect(result.outcome).toBe('escalated');
    expect(result.success).toBe(false);
    expect(services.runDelivery).not.toHaveBeenCalled(); // never reaches deliver
  });
});

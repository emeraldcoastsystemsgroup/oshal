import { describe, expect, it, vi } from 'vitest';
import { ProcessDefinitionExecutionEngine } from '../../src/features/workflow-studio/engine/process-definition-execution-engine';
import type { EngineServices } from '../../src/features/workflow-studio/engine/engine-services';
import { snapshotEngineState, applyEngineSnapshot, createEngineState } from '../../src/features/workflow-studio/engine/engine-state';

/** start → a → b → deliver */
function buildDef() {
  return {
    id: 'g', name: 'Durable',
    nodeGraph: {
      nodes: [
        { id: 'start', type: 'start', title: 'Start', config: {} },
        { id: 'a', type: 'execute-agent', title: 'A', config: { agentId: 'agent-a' } },
        { id: 'b', type: 'execute-agent', title: 'B', config: { agentId: 'agent-b' } },
        { id: 'deliver', type: 'deliver', title: 'Deliver', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'deliver' },
      ],
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

describe('engine-state snapshot round-trip', () => {
  it('snapshots and restores variables, node outputs, visit counts, regression', () => {
    const s = createEngineState('r', '', {});
    s.variables.foo = 'bar';
    s.nodeOutputs.set('a', { phase: 'execution' });
    s.visitCounts.set('a', 2);
    s.regressionLoopCount = 1;
    s.regressionFeedback = 'retry';
    const snap = snapshotEngineState(s);
    expect(snap).toEqual({ variables: { foo: 'bar' }, nodeOutputs: { a: { phase: 'execution' } }, visitCounts: { a: 2 }, regressionLoopCount: 1, regressionFeedback: 'retry' });

    const restored = applyEngineSnapshot(createEngineState('r2', '', {}), snap);
    expect(restored.variables.foo).toBe('bar');
    expect(restored.nodeOutputs.get('a')).toEqual({ phase: 'execution' });
    expect(restored.visitCounts.get('a')).toBe(2);
    expect(restored.regressionLoopCount).toBe(1);
    expect(restored.regressionFeedback).toBe('retry');
  });
});

describe('durable execution — resume + checkpoint', () => {
  it('checkpoints before each node (skipping start), growing the snapshot', async () => {
    const seen: string[] = [];
    const engine = new ProcessDefinitionExecutionEngine(buildServices());
    await engine.execute(buildDef(), { ticketId: 't' }, undefined, {
      onCheckpoint: (nodeId) => { seen.push(nodeId); },
    });
    expect(seen).toEqual(['a', 'b', 'deliver']); // start is never checkpointed
  });

  it('resumes from a checkpoint without re-running completed nodes, with state restored', async () => {
    const dispatched: string[] = [];
    const services = buildServices({
      runExecution: vi.fn(async (_t, c) => { dispatched.push(String(c.agentId)); return { outcome: { dispatched: true }, agentId: String(c.agentId), strategy: 'x' }; }),
    });
    const engine = new ProcessDefinitionExecutionEngine(services);
    // As if node A already completed: resume at B carrying A's accumulated state.
    const resumeState = { variables: { executionComplete: true, fromA: 'yes' }, nodeOutputs: { a: { phase: 'execution' } }, visitCounts: { a: 1 }, regressionLoopCount: 0 };
    const result = await engine.execute(buildDef(), { ticketId: 't' }, 'b', { resumeState });

    expect(dispatched).toEqual(['agent-b']);          // A was NOT re-run
    expect(result.outcome).toBe('completed');
    expect(result.variables.fromA).toBe('yes');       // restored state carried through to the end
  });

  it('a mid-run crash resumes from the last checkpoint and does not re-run completed nodes', async () => {
    const checkpoints: Array<{ resumeNodeId: string; snapshot: unknown }> = [];
    const dispatched: string[] = [];
    let failB = true;
    const services = buildServices({
      runExecution: vi.fn(async (_t, c) => {
        const id = String(c.agentId);
        if (id === 'agent-b' && failB) throw new Error('boom (simulated crash while B was in flight)');
        dispatched.push(id);
        return { outcome: { dispatched: true }, agentId: id, strategy: 'x' };
      }),
    });
    const engine = new ProcessDefinitionExecutionEngine(services);
    const onCheckpoint = (resumeNodeId: string, snapshot: unknown) => { checkpoints.push({ resumeNodeId, snapshot }); };

    // Run 1 crashes while executing B (after A completed + B was checkpointed).
    await expect(engine.execute(buildDef(), { ticketId: 't' }, undefined, { onCheckpoint })).rejects.toThrow(/boom/);
    const last = checkpoints[checkpoints.length - 1];
    expect(last.resumeNodeId).toBe('b'); // checkpoint points at the in-flight node

    // Run 2 resumes from that checkpoint; B now succeeds.
    failB = false;
    const result = await engine.execute(buildDef(), { ticketId: 't' }, last.resumeNodeId, { resumeState: last.snapshot as never });

    expect(result.outcome).toBe('completed');
    expect(dispatched).toEqual(['agent-a', 'agent-b']); // A ran once (run 1), B once (run 2) — A NOT re-run
  });
});

import { describe, it, expect } from 'vitest';
import { ProcessDefinitionExecutionEngine } from '../../src/features/workflow-studio/engine/process-definition-execution-engine';

/** Minimal ProcessDefinition — the engine only reads `.nodeGraph`. */
function makeDef(): any {
  const nodes = [
    { id: 'start', type: 'start', title: 'Start', config: {} },
    { id: 's0', type: 'execute-agent', title: 'Stage A', config: {} },
    { id: 'gate', type: 'approval-gate', title: 'Approve', config: {} },
    { id: 's1', type: 'execute-agent', title: 'Stage B', config: {} },
    { id: 'deliver', type: 'deliver', title: 'Deliver', config: {} },
  ];
  const edges = [
    { id: 'e1', source: 'start', target: 's0' },
    { id: 'e2', source: 's0', target: 'gate' },
    { id: 'e3', source: 'gate', target: 's1' },
    { id: 'e4', source: 's1', target: 'deliver' },
  ];
  return { name: 'test', nodeGraph: { nodes, edges, topologicalOrder: nodes.map((n) => n.id) } };
}

describe('ProcessDefinitionExecutionEngine — approval gate suspend/resume', () => {
  it('suspends at the approval gate and reports the resume node (the gate successor)', async () => {
    const engine = new ProcessDefinitionExecutionEngine(); // stub mode — no real bot dispatch
    const result = await engine.execute(makeDef(), { ticketId: 't1' });
    expect(result.outcome).toBe('suspended');
    expect(result.resumeNodeId).toBe('s1');
    // It ran the first stage and the gate, but did NOT reach delivery.
    expect(result.trace.some((t) => t.nodeId === 's0')).toBe(true);
    expect(result.trace.some((t) => t.nodeType === 'deliver')).toBe(false);
  });

  it('resumes past the gate to completion without re-evaluating the gate', async () => {
    const engine = new ProcessDefinitionExecutionEngine();
    const result = await engine.execute(makeDef(), { ticketId: 't1' }, 's1');
    expect(result.outcome).toBe('completed');
    expect(result.trace.some((t) => t.nodeType === 'approval-gate')).toBe(false);
    expect(result.trace.some((t) => t.nodeType === 'deliver')).toBe(true);
  });

  it('runs straight through when there are no approval gates', async () => {
    const engine = new ProcessDefinitionExecutionEngine();
    const nodes = [
      { id: 'start', type: 'start', title: 'Start', config: {} },
      { id: 's0', type: 'execute-agent', title: 'Only', config: {} },
      { id: 'deliver', type: 'deliver', title: 'Deliver', config: {} },
    ];
    const edges = [
      { id: 'e1', source: 'start', target: 's0' },
      { id: 'e2', source: 's0', target: 'deliver' },
    ];
    const def: any = { name: 't', nodeGraph: { nodes, edges, topologicalOrder: nodes.map((n) => n.id) } };
    const result = await engine.execute(def, { ticketId: 't2' });
    expect(result.outcome).toBe('completed');
  });
});

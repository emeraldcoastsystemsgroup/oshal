import { describe, expect, it, vi } from 'vitest';
import { ProcessDefinitionExecutionEngine } from '../../src/features/workflow-studio/engine/process-definition-execution-engine';
import type { EngineServices } from '../../src/features/workflow-studio/engine/engine-services';

function buildDefinition() {
  return {
    id: 'graph-1',
    name: 'Dispatch Failure Graph',
    version: 1,
    status: 'active',
    nodeGraph: {
      nodes: [
        { id: 'start', type: 'start', title: 'Start', config: {} },
        { id: 'exec', type: 'execute-agent', title: 'Execute', config: { agentId: 'agent-1', workType: 'implementation' } },
        { id: 'deliver', type: 'deliver', title: 'Deliver', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'exec' },
        { id: 'e2', source: 'exec', target: 'deliver' },
      ],
    },
  } as never;
}

function buildServices(runExecution: EngineServices['runExecution']): EngineServices {
  return {
    intakeAndScore: vi.fn(async () => ({ complexity: 'medium', complexityScore: 50, activePhases: [], workUnitCount: 0 })),
    runPlanning: vi.fn(async () => ({ stopAfterPlanning: false, workUnits: [], routing: {}, planningSource: 'test' })),
    runExecution,
    runTesting: vi.fn(async () => ({ passed: true })),
    runReview: vi.fn(async () => ({ passed: true })),
    runSpecialistInput: vi.fn(async () => ({ contextInjected: false })),
    runDelivery: vi.fn(async () => ({ delivered: true })),
    escalate: vi.fn(async () => undefined),
  };
}

describe('process definition terminal outcomes', () => {
  it('escalates the graph when execute-agent dispatch reports failure', async () => {
    const services = buildServices(vi.fn(async () => ({
      outcome: { dispatched: false, reason: 'bot refused' },
      agentId: 'agent-1',
      strategy: 'authored-stage',
    })));
    const engine = new ProcessDefinitionExecutionEngine(services);

    const result = await engine.execute(buildDefinition(), { ticketId: 'ticket-1', title: 'Do work' });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('escalated');
    expect(result.terminalResult).toMatchObject({ outcome: 'escalated', reason: 'bot refused', agentId: 'agent-1' });
    expect(services.runDelivery).not.toHaveBeenCalled();
  });

  it('still completes when execute-agent dispatch succeeds and the graph reaches deliver', async () => {
    const services = buildServices(vi.fn(async () => ({
      outcome: { dispatched: true, agentId: 'agent-1' },
      agentId: 'agent-1',
      strategy: 'authored-stage',
    })));
    const engine = new ProcessDefinitionExecutionEngine(services);

    const result = await engine.execute(buildDefinition(), { ticketId: 'ticket-1', title: 'Do work' });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('completed');
    expect(services.runDelivery).toHaveBeenCalled();
  });
});

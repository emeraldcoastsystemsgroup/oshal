import { describe, expect, it, vi } from 'vitest';
import { ProcessDefinitionExecutionEngine } from '../../src/features/workflow-studio/engine/process-definition-execution-engine';
import type { EngineServices } from '../../src/features/workflow-studio/engine/engine-services';

/**
 * A decision graph: start → decide ⇒ {approve → execApprove, reject → execReject} → deliver.
 * The chosen branch's execute-agent is the one that runs.
 */
function buildDecisionDefinition() {
  return {
    id: 'graph-decision',
    name: 'Decision Graph',
    nodeGraph: {
      nodes: [
        { id: 'start', type: 'start', title: 'Start', config: {} },
        { id: 'decide', type: 'ai-decision', title: 'Approve or reject?', config: { agentId: 'judge', outcomes: ['approve', 'reject'], fallbackOutcome: 'approve' } },
        { id: 'execApprove', type: 'execute-agent', title: 'Handle approve', config: { agentId: 'agent-approve', workType: 'authored' } },
        { id: 'execReject', type: 'execute-agent', title: 'Handle reject', config: { agentId: 'agent-reject', workType: 'authored' } },
        { id: 'deliver', type: 'deliver', title: 'Deliver', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'decide' },
        { id: 'e2', source: 'decide', target: 'execApprove', label: 'approve' },
        { id: 'e3', source: 'decide', target: 'execReject', label: 'reject' },
        { id: 'e4', source: 'execApprove', target: 'deliver' },
        { id: 'e5', source: 'execReject', target: 'deliver' },
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

describe('process definition engine — ai-decision branch selection', () => {
  it('follows the branch the bound bot chooses', async () => {
    const dispatched: string[] = [];
    const services = buildServices({
      decideBranch: vi.fn(async () => ({ outcome: 'reject' })),
      runExecution: vi.fn(async (_ticket, config) => {
        dispatched.push(String(config.agentId));
        return { outcome: { dispatched: true }, agentId: String(config.agentId), strategy: 'authored-stage' };
      }),
    });
    const engine = new ProcessDefinitionExecutionEngine(services);

    const result = await engine.execute(buildDecisionDefinition(), { ticketId: 't-dec', title: 'Review it' });

    expect(services.decideBranch).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual(['agent-reject']); // reject branch only
    expect(result.outcome).toBe('completed');
  });

  it('uses the configured fallbackOutcome when no decision service is wired', async () => {
    const dispatched: string[] = [];
    const services = buildServices({
      // no decideBranch
      runExecution: vi.fn(async (_ticket, config) => {
        dispatched.push(String(config.agentId));
        return { outcome: { dispatched: true }, agentId: String(config.agentId), strategy: 'authored-stage' };
      }),
    });
    const engine = new ProcessDefinitionExecutionEngine(services);

    const result = await engine.execute(buildDecisionDefinition(), { ticketId: 't-dec2', title: 'Review it' });

    expect(dispatched).toEqual(['agent-approve']); // fallbackOutcome: 'approve'
    expect(result.outcome).toBe('completed');
  });
});

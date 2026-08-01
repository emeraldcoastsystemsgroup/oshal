/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the published-queue brief drop: swarm tickets carry `description`, the engine context carries `body` — buildTicketContext must map one to the other or every graph dispatch prompts the worker bot with "(no description provided)" (observed live 2026-08-01 on the capability-ideation queue).
 */

import { describe, expect, it, vi } from 'vitest';
import { ProcessDefinitionExecutionEngine } from '../../src/features/workflow-studio/engine/process-definition-execution-engine';
import type { EngineServices, EngineTicketContext } from '../../src/features/workflow-studio/engine/engine-services';

function buildLinearDefinition() {
  return {
    id: 'graph-linear',
    name: 'Linear Graph',
    nodeGraph: {
      nodes: [
        { id: 'start', type: 'start', title: 'Start', config: {} },
        { id: 'exec', type: 'execute-agent', title: 'Do the work', config: { agentId: 'worker-bot', workType: 'authored' } },
        { id: 'deliver', type: 'deliver', title: 'Deliver', config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'exec' },
        { id: 'e2', source: 'exec', target: 'deliver' },
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

describe('process definition engine — ticket description reaches the execution brief', () => {
  it('maps a swarm ticket description onto the engine context body end-to-end', async () => {
    const seen: EngineTicketContext[] = [];
    const services = buildServices({
      runExecution: vi.fn(async (ticket: EngineTicketContext) => {
        seen.push(ticket);
        return { outcome: { dispatched: true }, agentId: 'worker-bot', strategy: 'authored-stage' };
      }),
    });
    const engine = new ProcessDefinitionExecutionEngine(services);

    const result = await engine.execute(buildLinearDefinition(), {
      ticketId: 'ticket-brief',
      title: 'Ideation cycle',
      description: 'First live ideation run. No focus hint.',
    });

    expect(result.success).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toBe('First live ideation run. No focus hint.');
  });

  it('prefers an explicit body over description when both are present', async () => {
    const engine = new ProcessDefinitionExecutionEngine(buildServices());
    const context = engine.buildTicketContext({
      ticket: { ticketId: 't2', title: 'T', body: 'engine body', description: 'swarm description' },
      runId: 'run-2',
    } as never);
    expect(context.body).toBe('engine body');
  });

  it('leaves body undefined when the ticket has neither field', async () => {
    const engine = new ProcessDefinitionExecutionEngine(buildServices());
    const context = engine.buildTicketContext({
      ticket: { ticketId: 't3', title: 'T' },
      runId: 'run-3',
    } as never);
    expect(context.body).toBeUndefined();
  });
});

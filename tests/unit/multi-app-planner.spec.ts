/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the multi-app planner (SEAM D): a 2-step dependent plan compiles to one 'graph' ProcessDefinition, dispatches as a graph ticket (chooseDispatchPath → 'graph'), checkpoints between steps, and passes step-1 output into step-2 input via the plan-step executor; a single-app request stays single-dispatch (no regression); outward steps get an approval gate; directive parse is fail-closed.
 */

import { describe, it, expect } from 'vitest';
import {
  parseMultiAppPlan,
  isMultiAppPlan,
  extractPlanDirective,
  stripPlanDirective,
  substitutePlanVariables,
  compilePlanToProcessDefinition,
  buildPlanWorkflowDefinition,
  newPlanTicketType,
  registerPlanStepExecutor,
  type MultiAppPlan,
} from '@/features/swarm-orchestration';
import { chooseDispatchPath } from '@/features/swarm-orchestration/services/queue-manager-service';
import {
  ProcessDefinitionExecutionEngine,
  type ProcessDefinition,
  type EngineServices,
} from '@/features/workflow-studio';

const builtIns = new Set(['build', 'incident']);

/** A dependent 2-step plan: step2's prompt references step1's output. */
const dependentPlan: MultiAppPlan = {
  title: 'Inbox → post',
  steps: [
    { id: 'step1', app: 'email', agentId: 'agent-email', prompt: 'Summarize my inbox.' },
    { id: 'step2', app: 'social', agentId: 'agent-social', prompt: 'Draft a LinkedIn post about: ${step1}' },
  ],
};

describe('multi-app plan schema + directive parsing', () => {
  it('parseMultiAppPlan accepts a valid plan and rejects malformed / duplicate-id plans', () => {
    expect(parseMultiAppPlan(dependentPlan)?.steps).toHaveLength(2);
    expect(parseMultiAppPlan({ title: 'x', steps: [] })).toBeNull();
    expect(parseMultiAppPlan({ title: 'x', steps: [{ id: 'a', app: 'email' }] })).toBeNull(); // missing prompt
    expect(parseMultiAppPlan({
      title: 'dup',
      steps: [
        { id: 'step1', app: 'email', prompt: 'a' },
        { id: 'step1', app: 'social', prompt: 'b' },
      ],
    })).toBeNull();
  });

  it('isMultiAppPlan: >=2 steps is a plan; a single step stays a single dispatch (no regression)', () => {
    expect(isMultiAppPlan(dependentPlan)).toBe(true);
    expect(isMultiAppPlan({ title: 'one', steps: [{ id: 'step1', app: 'email', prompt: 'hi' }] })).toBe(false);
    expect(isMultiAppPlan(null)).toBe(false);
  });

  it('extractPlanDirective honours exactly one ```oshal:plan fence and is fail-closed', () => {
    const reply = 'Sure!\n```oshal:plan\n' + JSON.stringify(dependentPlan) + '\n```\nStarting now.';
    expect(extractPlanDirective(reply)?.steps).toHaveLength(2);
    expect(extractPlanDirective('no fence here')).toBeNull();
    expect(extractPlanDirective('```oshal:plan\n{not json}\n```')).toBeNull();
    // Two fences is ambiguous → rejected.
    expect(extractPlanDirective('```oshal:plan\n{}\n```\n```oshal:plan\n{}\n```')).toBeNull();
  });

  it('stripPlanDirective removes the control fence from the user-facing answer', () => {
    const reply = 'On it.\n```oshal:plan\n' + JSON.stringify(dependentPlan) + '\n```';
    const clean = stripPlanDirective(reply);
    expect(clean).toBe('On it.');
    expect(clean).not.toContain('oshal:plan');
  });

  it('substitutePlanVariables replaces ${var} from prior outputs; unknown → empty', () => {
    expect(substitutePlanVariables('Post about ${step1}', { step1: 'the news' })).toBe('Post about the news');
    expect(substitutePlanVariables('x ${missing} y', {})).toBe('x  y');
  });
});

describe('multi-app plan compiler → graph rail (SEAM D)', () => {
  it('compiles a 2-step dependent plan to ONE nodeGraph: start → plan-step → plan-step → deliver', () => {
    const def = compilePlanToProcessDefinition(dependentPlan);
    const types = def.nodeGraph.nodes.map((n) => n.type);
    expect(types).toEqual(['start', 'plan-step', 'plan-step', 'deliver']);
    const step1Node = def.nodeGraph.nodes[1] as Record<string, unknown>;
    const cfg = step1Node.config as Record<string, unknown>;
    expect(cfg.agentId).toBe('agent-email');
    expect(cfg.outputVar).toBe('step1');
    expect(cfg.promptTemplate).toBe('Summarize my inbox.');
    // Linear chain: 3 edges connecting the 4 nodes.
    expect(def.nodeGraph.edges).toHaveLength(3);
  });

  it('outward steps get an approval-gate node before them (automation opt-in, default OFF)', () => {
    const outwardPlan: MultiAppPlan = {
      title: 'draft → send',
      steps: [
        { id: 'step1', app: 'email', agentId: 'agent-email', prompt: 'Draft a reply.' },
        { id: 'step2', app: 'email', agentId: 'agent-email', prompt: 'Send: ${step1}', outward: true },
      ],
    };
    const types = compilePlanToProcessDefinition(outwardPlan).nodeGraph.nodes.map((n) => n.type);
    // gate is inserted immediately before the outward plan-step.
    expect(types).toEqual(['start', 'plan-step', 'approval-gate', 'plan-step', 'deliver']);
  });

  it('buildPlanWorkflowDefinition → pipeline "graph" and chooseDispatchPath routes it to graph', () => {
    const ticketType = newPlanTicketType();
    expect(ticketType).toMatch(/^plan-[0-9a-f]{8}$/);
    const workflow = buildPlanWorkflowDefinition(dependentPlan, ticketType);
    expect(workflow.pipeline).toBe('graph');
    expect(workflow.processDefinition).toBeDefined();
    expect(workflow.autoStart).toBe(true);
    expect(chooseDispatchPath(ticketType, workflow, builtIns)).toBe('graph');
  });
});

describe('multi-app plan execution on the unchanged engine', () => {
  it('runs the compiled plan step-by-step: checkpoints between steps + step-1 output flows into step-2', async () => {
    const dispatched: Array<{ agentId?: string; prompt: string }> = [];
    const services = {
      async dispatchAgentPrompt(_ticket: unknown, config: { agentId?: string; prompt: string }) {
        dispatched.push({ agentId: config.agentId, prompt: config.prompt });
        return { dispatched: true, response: `REPLY[${config.agentId}]`, agentId: config.agentId };
      },
      // Terminal deliver node calls runDelivery when services are wired.
      async runDelivery() {
        return { delivered: true };
      },
    } as unknown as EngineServices;

    const engine = new ProcessDefinitionExecutionEngine(services);
    registerPlanStepExecutor(engine);

    const definition = compilePlanToProcessDefinition(dependentPlan) as unknown as ProcessDefinition;
    const checkpoints: string[] = [];
    const result = await engine.execute(
      definition,
      { ticketId: 't-plan-1', title: dependentPlan.title },
      undefined,
      { onCheckpoint: (resumeNodeId) => { checkpoints.push(resumeNodeId); } },
    );

    // The graph completed and both app-bot steps dispatched in order.
    expect(result.outcome).toBe('completed');
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0].agentId).toBe('agent-email');
    expect(dispatched[1].agentId).toBe('agent-social');

    // DATA-PASSING: step-2's prompt carried step-1's captured output.
    expect(dispatched[0].prompt).toBe('Summarize my inbox.');
    expect(dispatched[1].prompt).toContain('REPLY[agent-email]');
    expect(result.variables.step1).toBe('REPLY[agent-email]');
    expect(result.variables.step2).toBe('REPLY[agent-social]');

    // CHECKPOINTS between steps: a durable checkpoint was written before step-2 (and before step-1),
    // in order, so a crash/restart resumes mid-plan instead of re-running from the top.
    expect(checkpoints).toContain('n-step-0');
    expect(checkpoints).toContain('n-step-1');
    expect(checkpoints.indexOf('n-step-1')).toBeGreaterThan(checkpoints.indexOf('n-step-0'));
  });

  it('a dispatch failure escalates the run (honest failure, no fabricated output)', async () => {
    const services = {
      async dispatchAgentPrompt() {
        return { dispatched: false, reason: 'bot offline' };
      },
      async runDelivery() {
        return { delivered: true };
      },
    } as unknown as EngineServices;
    const engine = new ProcessDefinitionExecutionEngine(services);
    registerPlanStepExecutor(engine);
    const definition = compilePlanToProcessDefinition(dependentPlan) as unknown as ProcessDefinition;
    const result = await engine.execute(definition, { ticketId: 't-plan-2', title: 'x' });
    expect(result.outcome).toBe('escalated');
  });
});

/**
 * Multi-app plan → ProcessDefinition compiler.
 *
 * Maps an ordered MultiAppPlan onto the EXISTING graph rail (SEAM D): each step becomes a `plan-step`
 * node linked in sequence, and every outward-acting step is preceded by an `approval-gate` node so it
 * suspends for human approval (automation opt-in, default OFF). Prior-step outputs flow to later steps
 * through the engine's own variable state (each node writes its reply into `config.outputVar`, and a
 * later step's prompt references it as `${stepId}` — see plan-step-executor.ts). The result runs on the
 * unchanged ProcessDefinitionExecutionEngine + dispatch-graph-worker (checkpoints, suspend/resume, and
 * approval gates all inherited), dispatched via ticketType → 'graph'.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: compilePlanToProcessDefinition (start → [approval-gate?] plan-step … → deliver), buildPlanWorkflowDefinition (pipeline 'graph', autoStart), and newPlanTicketType. Reuses the studio graph rail; emits no new engine.
 *
 * @module multi-app-plan-compiler
 */

import { randomUUID } from 'node:crypto';
import type { MultiAppPlan } from './multi-app-plan';
import { PLAN_STEP_NODE_TYPE } from './plan-step-executor';
import type { WorkflowDefinition } from './dispatch-routing';

/** A minimal ProcessDefinition shape the ProcessDefinitionExecutionEngine reads (it uses .nodeGraph).
 *  Kept loosely typed so this module carries no workflow-studio zod dependency, matching how the
 *  swarm-apps publish compiler emits its nodeGraph. */
export interface CompiledPlanProcessDefinition {
  name: string;
  nodeGraph: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    topologicalOrder: string[];
  };
}

/**
 * @description Compile a plan into an executable nodeGraph ProcessDefinition. Emits, in order:
 * a start node, then per step an optional approval-gate (outward steps only) followed by a plan-step
 * node carrying the step's bot binding + prompt template + output variable, and finally a deliver node.
 * @param plan - the ordered plan (steps' `agentId` should be pre-resolved by the caller when known)
 * @returns a ProcessDefinition whose nodeGraph the engine walks sequentially with data-passing
 */
export function compilePlanToProcessDefinition(plan: MultiAppPlan): CompiledPlanProcessDefinition {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const order: string[] = [];

  const addNode = (id: string, type: string, title: string, config: Record<string, unknown> = {}): void => {
    nodes.push({ id, type, title, config });
    order.push(id);
  };
  const link = (source: string, target: string): void => {
    edges.push({ id: `e-${source}-${target}`, source, target });
  };

  addNode('n-start', 'start', 'Start', { triggerMode: 'manual' });
  let prev = 'n-start';

  plan.steps.forEach((step, i) => {
    // Outward-acting steps pause for human approval BEFORE they run (automation opt-in, default OFF).
    if (step.outward) {
      const gateId = `n-gate-${i}`;
      addNode(gateId, 'approval-gate', `Approve before ${step.id}`, { gateState: 'approval_required' });
      link(prev, gateId);
      prev = gateId;
    }
    const nodeId = `n-step-${i}`;
    addNode(nodeId, PLAN_STEP_NODE_TYPE, step.id, {
      app: step.app,
      ...(step.agentId ? { agentId: step.agentId } : {}),
      agentBinding: step.app,
      promptTemplate: step.prompt,
      outputVar: step.id,
      workType: 'plan-step',
    });
    link(prev, nodeId);
    prev = nodeId;
  });

  addNode('n-deliver', 'deliver', 'Deliver', { deliveryMode: 'standard' });
  link(prev, 'n-deliver');

  return { name: plan.title, nodeGraph: { nodes, edges, topologicalOrder: order } };
}

/**
 * @description Wrap a compiled plan as a WorkflowDefinition on the 'graph' pipeline so the queue
 * manager routes its tickets through dispatch-graph-worker (chooseDispatchPath → 'graph'). autoStart
 * is set so the ticket runs on arrival; any human pause lives in the plan's own approval-gate nodes.
 * @param plan - the ordered plan (agentIds pre-resolved by the caller)
 * @param ticketType - the unique ticketType this workflow handles (see newPlanTicketType)
 * @returns a graph WorkflowDefinition carrying the compiled ProcessDefinition
 */
export function buildPlanWorkflowDefinition(plan: MultiAppPlan, ticketType: string): WorkflowDefinition {
  return {
    ticketType,
    name: (plan.title || 'Multi-app plan').slice(0, 150),
    pipeline: 'graph',
    // Informational only — the graph drives execution; set it to the first step's app for context.
    workerBot: plan.steps[0]?.app ?? 'general-bot',
    processDefinition: compilePlanToProcessDefinition(plan) as unknown as Record<string, unknown>,
    autoStart: true,
  };
}

/**
 * @description Mint a unique ticketType for one dispatched plan, so each plan registers its own
 * caller-scoped graph workflow without colliding with another plan's ticketType.
 * @returns a `plan-<8hex>` ticketType
 */
export function newPlanTicketType(): string {
  return `plan-${randomUUID().slice(0, 8)}`;
}

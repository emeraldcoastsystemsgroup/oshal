/**
 * Plan-step node executor — the one net-new engine primitive for the multi-app planner.
 *
 * A `plan-step` node is a single app-bot delegation inside a compiled multi-app plan
 * (see multi-app-plan-compiler.ts). It reuses the EXISTING ProcessDefinitionExecutionEngine
 * unchanged: this file only supplies a custom NodeExecutor (registered on the engine instance
 * the graph dispatcher already builds — engine internals are untouched). The executor
 *   1. substitutes prior-step outputs into this step's prompt template (data-passing), and
 *   2. dispatches the resolved prompt to the step's bot via the engine's services adapter,
 *      capturing the reply into this step's output variable so downstream steps can reference it.
 *
 * Bot dispatch is delegated to the wired EngineServices adapter (dispatchAgentPrompt) — the
 * SAME bot-node/localhost path authored workflows already use — so cost capture, per-bot
 * settings, and the controller/LLM boundary all hold. The controller never calls an LLM; this
 * executor runs inside the graph-dispatch worker, which asks the accountable bot node.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: plan-step node type + executor (prompt-template variable substitution from prior step outputs + bot dispatch via EngineServices.dispatchAgentPrompt), registerPlanStepExecutor, and the AgentPromptDispatch contract the engine-services adapter implements. Reuses the graph engine unchanged.
 *
 * @module plan-step-executor
 */

import type {
  EngineState,
  EngineTicketContext,
  NodeExecutor,
  ProcessDefinitionExecutionEngine,
} from '@/features/workflow-studio';

/** The engine node type a compiled multi-app plan emits for each app-bot step. */
export const PLAN_STEP_NODE_TYPE = 'plan-step';

/** Request to dispatch one prompt to a resolved app-bot for a plan step. */
export interface AgentPromptDispatchConfig {
  /** Explicit bot agentId — preferred when the controller already resolved the app to a bot. */
  agentId?: string;
  /** Persona/app name to resolve to an agentId when no explicit id is supplied. */
  agentBinding?: string;
  /** The fully-substituted prompt for this step. */
  prompt: string;
  /** Work-type label for logging/telemetry. */
  workType?: string;
}

/** Result of dispatching one plan step to its bot. */
export interface AgentPromptDispatchResult {
  /** Whether the bot was resolved and dispatched. */
  dispatched: boolean;
  /** The bot's text reply (captured into the step's output variable). */
  response?: string;
  /** The resolved bot agentId. */
  agentId?: string;
  /** Failure reason when dispatched === false. */
  reason?: string;
}

/**
 * @description The one engine-services capability a plan step needs: dispatch a prompt to a bot
 * and return its reply. The engine-services adapter implements it structurally (reusing its
 * existing bot-node/localhost dispatch path); the executor casts the wired services to this shape
 * so the workflow-studio EngineServices interface is not widened.
 */
export interface AgentPromptDispatcher {
  dispatchAgentPrompt(ticket: EngineTicketContext, config: AgentPromptDispatchConfig): Promise<AgentPromptDispatchResult>;
}

/** Matches `${var}` / `${ var }` placeholders — a bounded identifier only (no expressions). */
const PLAN_VAR_TOKEN = /\$\{\s*([a-zA-Z_][\w.-]*)\s*\}/g;

/**
 * @description Substitute `${stepId}` placeholders in a plan step's prompt template with the string
 * values of prior step outputs held in engine state. An unknown/undefined variable resolves to an
 * empty string (fail-soft — a step never dispatches a literal `${...}` token). Pure and deterministic.
 * @param template - the step prompt, possibly containing `${var}` references to prior step outputs
 * @param variables - the engine's accumulated variables (each prior step's output keyed by its id)
 * @returns the prompt with every recognised placeholder replaced
 */
export function substitutePlanVariables(template: string, variables: Record<string, unknown>): string {
  return template.replace(PLAN_VAR_TOKEN, (_match, key: string) => {
    const value = variables[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * @description Build the plan-step NodeExecutor. On each plan-step node it substitutes prior-step
 * outputs into the prompt template, dispatches to the step's bot via the wired services adapter, and
 * writes the reply into `config.outputVar` (default: the node id) so later steps can reference it.
 * A dispatch failure terminates the run as an escalation (honest failure — no fabricated output).
 * When no services adapter is wired (unit tests without a dispatcher), the step advances with an
 * empty output so the graph still walks; production always wires the adapter.
 * @returns a NodeExecutor for the `plan-step` node type
 */
export function createPlanStepExecutor(): NodeExecutor {
  return async (state: EngineState, node, engine: ProcessDefinitionExecutionEngine) => {
    const config = (node.config ?? {}) as Record<string, unknown>;
    const outputVar = typeof config.outputVar === 'string' && config.outputVar ? config.outputVar : node.id;
    const agentId = typeof config.agentId === 'string' ? config.agentId : undefined;
    const agentBinding = typeof config.agentBinding === 'string' ? config.agentBinding : undefined;
    const template = String(config.promptTemplate ?? config.prompt ?? '');
    const prompt = substitutePlanVariables(template, state.variables);

    const services = engine.getServices() as unknown as Partial<AgentPromptDispatcher> | undefined;
    if (services?.dispatchAgentPrompt && (agentId || agentBinding)) {
      const ticket = engine.buildTicketContext(state);
      const result = await services.dispatchAgentPrompt(ticket, {
        agentId,
        agentBinding,
        prompt,
        workType: 'plan-step',
      });
      if (!result.dispatched) {
        return {
          output: { phase: 'plan-step', app: config.app, escalated: true, reason: result.reason },
          terminate: true,
          terminalResult: {
            outcome: 'escalated',
            reason: result.reason || 'plan-step dispatch failed',
            agentId: result.agentId,
          },
        };
      }
      return {
        output: { phase: 'plan-step', app: config.app, agentId: result.agentId, response: result.response },
        variables: { [outputVar]: result.response ?? '', selectedAgentId: result.agentId ?? agentId },
      };
    }

    // No dispatcher wired (test harness without services). Advance so the graph still walks — a real
    // dispatch is required in production, where the graph worker always wires the services adapter.
    return { output: { phase: 'plan-step', app: config.app, stub: true }, variables: { [outputVar]: '' } };
  };
}

/**
 * @description Register the plan-step executor on a ProcessDefinitionExecutionEngine instance. The
 * graph-dispatch worker calls this after constructing the engine; it is additive (studio-authored
 * graphs never emit plan-step nodes, so nothing else is affected) and touches no engine internals.
 * @param engine - the engine instance the graph worker built for this dispatch
 */
export function registerPlanStepExecutor(engine: ProcessDefinitionExecutionEngine): void {
  engine.registerExecutor(PLAN_STEP_NODE_TYPE, createPlanStepExecutor());
}

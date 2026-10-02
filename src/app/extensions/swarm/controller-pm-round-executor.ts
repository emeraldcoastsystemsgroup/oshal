/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Build-lane planning runs in-process (docs/security/http-delegation.md, "Build-lane planning runs in-process"). project-manager's Phase-2 round used to cross the mesh to the api worker, which ran it on an unattended command-line harness the controller refuses (SEC-05), so no build ticket could be planned. This executor runs the round in the controller process on the root owner's hosted ladder, only for operator-owned roots that carry a verified issuer, with no tools and a note saying so on the turn, and refuses by name otherwise.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The planning round's provider opts into the same-endpoint retry (429/402/503 high-demand wall replayed on the same endpoint, bounded by the existing plan). The first live run escalated its root on one HTTP 503 "high demand" from the hosted endpoint; the planning round has no rotation and no later attempt, so a single blip cost the whole ticket.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { isControllerInlineContainer, type MeshEnvelope } from '@/features/agent-management';
import {
  LLMService,
  createGovernedByoHostedProvider,
  type ByoHostedConnection,
  type CostResult,
  type LLMResponse,
  type SendRequestOptions,
  type TokenUsage,
} from '@/features/llm-provider';
import {
  createLLMExecutionHandler,
  type CostRecordFn,
  type EnvelopeExecutionResult,
  type LLMExecutionHandlerDeps,
  type LocalRoundExecutor,
  type RoundOwner,
} from '@/features/swarm-orchestration';
import { isDeploymentOperatorSub } from '@/shared/deployment-mode';
import { isApplicationExecutionProtected } from '@/shared/application-authorization-execution';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { resolveUserLlmConnection } from '@/app/routes/free-tier-rotation';
import { SwarmBotRegistry } from './swarm-bot-registry';

const logger = createChildLogger({ module: 'controller-pm-round-executor' });

/** project-manager, which owns build-lane Phase-2 planning (planning-round-orchestrator.ts). */
export const PM_PLANNING_AGENT_ID = 'a0000000-0000-0000-0000-000000000001';

/** Reply budget for one planning call; a thinking model spends part of it before it writes. */
const DEFAULT_PM_PLANNING_MAX_TOKENS = 16384;

/** @description What the executor needs; every seam defaults to the production implementation. */
export interface ControllerPmRoundExecutorDeps {
  pool: Pool | null;
  /** The controller worker's handler deps; each round builds its own handler from them. */
  handlerDeps: LLMExecutionHandlerDeps;
  /** The owner's hosted brain. Default: resolveUserLlmConnection under the SYSTEM identity. */
  resolveConnection?: (ownerSub: string) => Promise<ByoHostedConnection | undefined>;
  /** Whether a protected application owns the bot. Default: isApplicationExecutionProtected. */
  isProtected?: (agentId: string) => Promise<boolean>;
  /** Whether the subject is a deployment operator. Default: isDeploymentOperatorSub. */
  isOperator?: (ownerSub: string) => boolean;
  /** Whether project-manager's own registry entry is controller-inline. Default: the registry. */
  isControllerInline?: (agentId: string) => boolean;
  /** Reply budget per call. Default: OSHAL_PM_PLANNING_MAX_TOKENS, else 16384. */
  maxTokens?: number;
}

/**
 * Server-authored note for a planning turn. The persona and the phase-2 prompt are written for agents
 * that have file tools, and a hosted model offered none can answer with a tool call and no text
 * (seen on 2026-10-01: gemini-3.8-flash finished MALFORMED_FUNCTION_CALL on the planning prompt).
 */
export const TOOL_LESS_PLANNING_NOTE = 'You have no file, shell or other tools in this turn, so do not call any tool. '
  + 'Write the whole plan, including the ## SUBTASK DECOMPOSITION section, as your reply; '
  + 'the system records your reply as the plan.';

/**
 * @description Wraps a provider for a planning turn: every request carries the planning reply
 * budget, and the final user message carries the tool-less note. The governed hosted provider
 * defaults to 4096 tokens and the agent passes none, which a thinking model can spend before it
 * writes the plan.
 */
class PlanningTurnProvider extends LLMService {
  private readonly delegate: LLMService;
  private readonly maxTokens: number;

  constructor(delegate: LLMService, maxTokens: number) {
    super(delegate.getProviderName(), {});
    this.delegate = delegate;
    this.maxTokens = maxTokens;
  }

  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    return this.delegate.sendRequest({
      ...options,
      messages: withToolLessNote(options.messages),
      maxTokens: options.maxTokens ?? this.maxTokens,
    });
  }

  override calculateCost(usage: TokenUsage): CostResult {
    return this.delegate.calculateCost(usage);
  }
}

/**
 * @description Appends the tool-less note to the final user message, or adds it as one.
 * @param messages - The turn's messages.
 * @returns A copy with the note on the last user message.
 */
function withToolLessNote(messages: SendRequestOptions['messages']): SendRequestOptions['messages'] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || typeof last.content !== 'string') {
    return [...messages, { role: 'user', content: TOOL_LESS_PLANNING_NOTE }];
  }
  return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${TOOL_LESS_PLANNING_NOTE}` }];
}

/**
 * @description Creates the executor that runs build-lane planning rounds in the controller process.
 * @param deps - The controller worker's handler deps, the pool and optional seams.
 * @returns A LocalRoundExecutor for MultiRoundDispatchService.setLocalRoundExecutor.
 */
export function createControllerPmRoundExecutor(deps: ControllerPmRoundExecutorDeps): LocalRoundExecutor {
  const isControllerInline = deps.isControllerInline ?? registryEntryIsControllerInline;
  return {
    handles: (agentId) => agentId === PM_PLANNING_AGENT_ID && isControllerInline(agentId),
    execute: (envelope, owner) => executePlanningRound(deps, envelope, owner),
  };
}

/**
 * @description Runs one planning round: refuse by name, resolve the owner's hosted brain, then run
 * the swarm execution handler on that brain with the persona embedded and no tools.
 * @param deps - Executor deps.
 * @param envelope - The round envelope MultiRoundDispatchService built.
 * @param owner - The root ticket's owner and verified issuer.
 * @returns The execution result; a refusal or a missing brain is a named failure, not a throw.
 */
async function executePlanningRound(
  deps: ControllerPmRoundExecutorDeps,
  envelope: MeshEnvelope,
  owner: RoundOwner,
): Promise<EnvelopeExecutionResult> {
  const startedAt = Date.now();
  const ticketId = readString((envelope.payload as Record<string, unknown> | undefined)?.externalId);
  logger.info({ ticketId, hasOwner: Boolean(owner.ownerSub), hasIssuer: Boolean(owner.principalIssuer) }, 'In-process planning round start');
  const refusal = await refusalFor(deps, owner);
  if (refusal) {
    logger.warn({ ticketId, reason: refusal }, 'In-process planning round refused');
    return { success: false, error: `pm_hosted_brain_refused: ${refusal}` };
  }
  const ownerSub = owner.ownerSub as string;
  const connection = await resolveBrain(deps, ownerSub, ticketId);
  if (!connection) {
    return {
      success: false,
      error: 'pm_hosted_brain_unavailable: no hosted brain resolved for the root owner (an endpoint in Settings, AI Providers, or the deployment operator key on a demo box)',
    };
  }
  const handler = createLLMExecutionHandler(planningHandlerDeps(deps, connection));
  const payload = { ...(envelope.payload as Record<string, unknown>), ownerSub, principalIssuer: owner.principalIssuer };
  const result = await handler({ ...envelope, payload });
  logger.info({ ticketId, model: connection.model, success: result.success, durationMs: Date.now() - startedAt }, 'In-process planning round end');
  return result;
}

/**
 * @description The reason a round may not run, or null when it may. Fails closed: an error while
 * checking application protection is a refusal.
 * @param deps - Executor deps.
 * @param owner - The root ticket's owner and verified issuer.
 * @returns The refusal reason, or null.
 */
async function refusalFor(deps: ControllerPmRoundExecutorDeps, owner: RoundOwner): Promise<string | null> {
  if (!owner.ownerSub) return 'the root ticket has no owner';
  if (!owner.principalIssuer) return 'the root ticket carries no verified principal issuer';
  const isOperator = deps.isOperator ?? isDeploymentOperatorSub;
  if (!isOperator(owner.ownerSub)) return 'the root ticket owner is not a deployment operator';
  const isProtected = deps.isProtected
    ?? ((agentId: string) => isApplicationExecutionProtected({ kind: 'bots', operation: agentId }));
  try {
    if (await isProtected(PM_PLANNING_AGENT_ID)) return 'project-manager is bound to a protected application';
  } catch (err) {
    logger.error({ err }, 'Protected-application check failed; refusing the planning round');
    return 'the protected-application check failed';
  }
  return null;
}

/**
 * @description Resolves the owner's hosted brain. A throw or an incomplete connection resolves to null.
 * @param deps - Executor deps.
 * @param ownerSub - The root ticket's owner.
 * @param ticketId - For the logs.
 * @returns The connection, or null.
 */
async function resolveBrain(
  deps: ControllerPmRoundExecutorDeps,
  ownerSub: string,
  ticketId: string | undefined,
): Promise<ByoHostedConnection | null> {
  const resolve = deps.resolveConnection
    ?? ((sub: string) => runWithSystemIdentity(() => resolveUserLlmConnection(deps.pool, sub)));
  try {
    const connection = await resolve(ownerSub);
    if (connection?.baseUrl && connection.apiKey && connection.model) {
      return { baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model };
    }
    logger.warn({ ticketId }, 'No hosted brain resolved for the planning round owner');
  } catch (err) {
    logger.error({ err, ticketId }, 'Hosted brain resolution failed for the planning round');
  }
  return null;
}

/**
 * @description The handler deps for one planning round: the controller worker's deps, with
 * project-manager pinned to the hosted brain, the persona embedded, and the cost row naming the
 * provider and model that actually ran.
 * @param deps - Executor deps.
 * @param connection - The resolved hosted connection.
 * @returns Handler deps for createLLMExecutionHandler.
 */
function planningHandlerDeps(deps: ControllerPmRoundExecutorDeps, connection: ByoHostedConnection): LLMExecutionHandlerDeps {
  const maxTokens = deps.maxTokens ?? (Number(process.env.OSHAL_PM_PLANNING_MAX_TOKENS) || DEFAULT_PM_PLANNING_MAX_TOKENS);
  const provider = new PlanningTurnProvider(
    createGovernedByoHostedProvider(connection, deps.pool, { agentId: PM_PLANNING_AGENT_ID, sameEndpointRetry: true }),
    maxTokens,
  );
  return {
    ...deps.handlerDeps,
    inlineFilePersona: true,
    resolveAgentHarness: (agentId: string) => (agentId === PM_PLANNING_AGENT_ID ? provider : null),
    recordCost: relabelCost(deps.handlerDeps.recordCost, provider.getProviderName(), connection.model),
  };
}

/**
 * @description Makes the cost row name the hosted provider and model that ran, not the
 * project-manager profile's configured provider.
 * @param recordCost - The worker's cost recorder.
 * @param providerId - The hosted provider's name (`byo-hosted:<model>`).
 * @param modelId - The connection's model.
 * @returns The relabelling recorder, or undefined without one.
 */
function relabelCost(recordCost: CostRecordFn | undefined, providerId: string, modelId: string): CostRecordFn | undefined {
  if (!recordCost) return undefined;
  return (event) => recordCost({ ...event, providerId, modelId });
}

/**
 * @description True when the agent's own registry entry runs in the controller container. Reads the
 * exact entry, never a governing fallback, so an id the registry does not define is not handled.
 * @param agentId - The agent id.
 * @returns Whether the entry is controller-inline.
 */
function registryEntryIsControllerInline(agentId: string): boolean {
  const entry = SwarmBotRegistry.listDefinitions().find((definition) => definition.agentId === agentId);
  return Boolean(entry && isControllerInlineContainer(entry.container));
}

/**
 * @description A trimmed non-empty string, or undefined.
 * @param value - Any value.
 * @returns The string, or undefined.
 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

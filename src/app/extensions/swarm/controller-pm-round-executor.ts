/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Build-lane planning runs in-process (docs/security/http-delegation.md, "Build-lane planning runs in-process"). project-manager's Phase-2 round used to cross the mesh to the api worker, which ran it on an unattended command-line harness the controller refuses (SEC-05), so no build ticket could be planned. This executor runs the round in the controller process on the root owner's hosted ladder, only for operator-owned roots that carry a verified issuer, with no tools and a note saying so on the turn, and refuses by name otherwise.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The planning round's provider opts into the same-endpoint retry (429/402/503 high-demand wall replayed on the same endpoint, bounded by the existing plan). The first live run escalated its root on one HTTP 503 "high demand" from the hosted endpoint; the planning round has no rotation and no later attempt, so a single blip cost the whole ticket.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The hosted-key path is gone (operator, 2026-10-02: every bot runs on the configured fleet default, the logged-in subscription, never a free-tier key; nothing names a provider, a model or a key). The round is sent over the signed bot-node hop to a build-lane node, where the installed provider switch rows (per-bot row, then the fleet default) choose the engine and the ADR-127 demo carve lets it run as the operator, exactly as the children run. The node that plans is configuration: OSHAL_PM_PLANNING_NODE names a build-lane bot by registry name (default system-architect, the node with the decomposition capability); it must own a node and be on the build-lane execution allowlist. The refusals (owner, verified issuer, deployment operator, protected application) stand and now cover that node's bot too. The reply budget, the tool-less note and the embedded persona went with the hosted path; the turn carries a note that the queue decomposes the reply.
 */

import { createChildLogger } from '@/shared/logger';
import {
  isControllerInlineContainer,
  type BotNodeClient,
  type MeshEnvelope,
  type RuntimeParamsResolver,
} from '@/features/agent-management';
import {
  BUILD_EXECUTION_TARGETS,
  buildUserMessage,
  pushOnDispatchFields,
  type EnvelopeExecutionResult,
  type LocalRoundExecutor,
  type RoundOwner,
} from '@/features/swarm-orchestration';
import { isDeploymentOperatorSub } from '@/shared/deployment-mode';
import { isApplicationExecutionProtected } from '@/shared/application-authorization-execution';
import { SwarmBotRegistry } from './swarm-bot-registry';

const logger = createChildLogger({ module: 'controller-pm-round-executor' });

/** project-manager, which owns build-lane Phase-2 planning (planning-round-orchestrator.ts). */
export const PM_PLANNING_AGENT_ID = 'a0000000-0000-0000-0000-000000000001';

/** The setting that names, by registry name, the build-lane bot whose node runs the planning round. */
export const PLANNING_NODE_ENV = 'OSHAL_PM_PLANNING_NODE';

/** The planning node when the setting is unset: the architect, the build-lane node that carries the decomposition capability. */
export const DEFAULT_PLANNING_NODE = 'system-architect';

/**
 * Server-authored note on the planning turn. The node's engine has file tools and may well write
 * the plan to the workspace; the queue decomposes the reply it returns, never a file.
 */
export const PLANNING_REPLY_NOTE = 'Your final reply must contain the complete plan, including the ## SUBTASK DECOMPOSITION section '
  + 'with every subtask, even if you also write IMPLEMENTATION-PLAN.md: the queue decomposes your reply, not the file.';

/** @description What the executor needs; every seam defaults to the production implementation. */
export interface ControllerPmRoundExecutorDeps {
  /** The signed bot-node client (docs/security/http-delegation.md). */
  botNodeClient: Pick<BotNodeClient, 'execute'>;
  /** Push-on-dispatch config fields for the planning node, as every other dispatch carries them. */
  runtimeParamsResolver?: RuntimeParamsResolver;
  /** Whether a protected application owns the bot. Default: isApplicationExecutionProtected. */
  isProtected?: (agentId: string) => Promise<boolean>;
  /** Whether the subject is a deployment operator. Default: isDeploymentOperatorSub. */
  isOperator?: (ownerSub: string) => boolean;
  /** Whether project-manager's own registry entry is controller-inline. Default: the registry. */
  isControllerInline?: (agentId: string) => boolean;
  /** The planning node's registry name. Default: OSHAL_PM_PLANNING_NODE, else system-architect. */
  planningNode?: string;
}

/** A resolved planning node, or why none can plan. */
type PlanningNode = { agentId: string; name: string };

/**
 * @description Creates the executor that sends build-lane planning rounds over the signed hop.
 * @param deps - The signed client, the config resolver and optional seams.
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
 * @description Runs one planning round: refuse by name, then send the round's prompt to the
 * planning node as the root's owner and record the node's reply as the round output.
 * @param deps - Executor deps.
 * @param envelope - The round envelope MultiRoundDispatchService built.
 * @param owner - The root ticket's owner and verified issuer.
 * @returns The execution result; a refusal or a failed node call is a named failure, not a throw.
 */
async function executePlanningRound(
  deps: ControllerPmRoundExecutorDeps,
  envelope: MeshEnvelope,
  owner: RoundOwner,
): Promise<EnvelopeExecutionResult> {
  const startedAt = Date.now();
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const ticketId = readString(payload.externalId);
  const resolved = resolvePlanningNode(deps);
  logger.info({ ticketId, node: resolved.node?.name ?? null, hasOwner: Boolean(owner.ownerSub), hasIssuer: Boolean(owner.principalIssuer) }, 'Planning round over the signed hop: start');
  const refusal = resolved.refusal ?? (ticketId ? await refusalFor(deps, owner, resolved.node!.agentId) : 'the round envelope names no ticket');
  if (refusal) {
    logger.warn({ ticketId, reason: refusal }, 'Planning round refused');
    return { success: false, error: `pm_planning_refused: ${refusal}` };
  }
  const node = resolved.node!;
  try {
    const result = await deps.botNodeClient.execute(node.agentId, {
      text: `${buildUserMessage({ payload } as Parameters<typeof buildUserMessage>[0])}\n\n${PLANNING_REPLY_NOTE}`,
      taskId: ticketId as string,
      workspaceFolderId: readString(payload.workspaceTaskId) ?? (ticketId as string),
      agentId: node.agentId,
      agenticMode: true,
      userSub: owner.ownerSub as string,
      principalIssuer: owner.principalIssuer as string,
      ...(await pushOnDispatchFields(deps.runtimeParamsResolver, node.agentId)),
    });
    logger.info({ ticketId, node: node.name, success: result.success, provider: result.provider, model: result.model, durationMs: Date.now() - startedAt }, 'Planning round over the signed hop: end');
    if (!result.success) {
      return { success: false, error: `pm_planning_node_failed: ${result.error ?? 'the planning node reported a failed execution'}`, output: result.response ?? null };
    }
    return {
      success: true,
      output: { agentId: PM_PLANNING_AGENT_ID, executedBy: node.agentId, taskId: ticketId, content: result.response, provider: result.provider, model: result.model, usage: result.usage },
    };
  } catch (err) {
    logger.error({ err, ticketId, node: node.name }, 'Planning round over the signed hop failed');
    return { success: false, error: `pm_planning_node_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * @description The configured planning node: a registry bot that owns a node and is on the
 * build-lane execution allowlist. Anything else is a refusal naming the setting.
 * @param deps - Executor deps.
 * @returns The node, or the refusal.
 */
function resolvePlanningNode(deps: ControllerPmRoundExecutorDeps): { node?: PlanningNode; refusal?: string } {
  const name = deps.planningNode ?? process.env[PLANNING_NODE_ENV]?.trim() ?? '';
  const wanted = name || DEFAULT_PLANNING_NODE;
  const entry = SwarmBotRegistry.listDefinitions().find((definition) => definition.name === wanted);
  const agentId = entry?.agentId;
  if (!entry || !agentId) return { refusal: `${PLANNING_NODE_ENV} names no registry bot (${wanted})` };
  if (!entry.requiresOwnNode) return { refusal: `the planning node ${wanted} does not own a node (${PLANNING_NODE_ENV})` };
  if (!BUILD_EXECUTION_TARGETS.has(agentId)) return { refusal: `the planning node ${wanted} is not a build-lane execution target (${PLANNING_NODE_ENV})` };
  return { node: { agentId, name: wanted } };
}

/**
 * @description The reason a round may not run, or null when it may. Fails closed: an error while
 * checking application protection is a refusal.
 * @param deps - Executor deps.
 * @param owner - The root ticket's owner and verified issuer.
 * @param nodeAgentId - The planning node's bot.
 * @returns The refusal reason, or null.
 */
async function refusalFor(deps: ControllerPmRoundExecutorDeps, owner: RoundOwner, nodeAgentId: string): Promise<string | null> {
  if (!owner.ownerSub) return 'the root ticket has no owner';
  if (!owner.principalIssuer) return 'the root ticket carries no verified principal issuer';
  const isOperator = deps.isOperator ?? isDeploymentOperatorSub;
  if (!isOperator(owner.ownerSub)) return 'the root ticket owner is not a deployment operator';
  const isProtected = deps.isProtected
    ?? ((agentId: string) => isApplicationExecutionProtected({ kind: 'bots', operation: agentId }));
  for (const [agentId, label] of [[PM_PLANNING_AGENT_ID, 'project-manager'], [nodeAgentId, 'the planning node bot']]) {
    try {
      if (await isProtected(agentId)) return `${label} is bound to a protected application`;
    } catch (err) {
      logger.error({ err, agentId }, 'Protected-application check failed; refusing the planning round');
      return 'the protected-application check failed';
    }
  }
  return null;
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

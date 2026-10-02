/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Build-lane execution crosses the signed bot-node hop while delegation signing is configured (docs/security/http-delegation.md, "Worker routing"). Every node refuses unsigned mesh execution then, so a child sent over the mesh could never run. The target must be on the build-lane allowlist before any token is issued; the request carries the ticket's owner and persisted verified issuer, the same shape the incident path uses live; the unit work item is kept fresh for the routing watchdog while the node works and records the result.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The unit work item stays assigned until the node call returns, whatever the ticket's state. It used to stop being refreshed once the ticket was cancelled, so the routing watchdog flipped it to routing_failed while the node was still writing, and anything waiting for the node to return (the live case's cleanup) read that as returned. A ticket that has already ended (cancelled, escalated, dead-lettered) is never sent to a node: the execution policy runner retries a failed attempt without reading the ticket, and this is what keeps a cancelled child from reaching a node again.
 */

import { createChildLogger } from '@/shared/logger';
import type { ExternalWorkItem } from '@/entities/ticket';
import type { WorkItemRepository } from '@/entities/work-item';
import type { BotNodeClient, RuntimeParamsResolver } from '@/features/agent-management';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { buildUserMessage } from './llm-execution-handler';
import { pushOnDispatchFields } from './dispatch-manifest-worker';
import type { DecomposedWorkUnit } from './ticket-decomposition-service';

const logger = createChildLogger({ module: 'signed-child-dispatch' });

/**
 * @description The only bots a build ticket's execution may be sent to over the signed hop: the
 * seven build specialists, system-architect, and general-bot (routing's catch-all). Planning text
 * can name any active agent, including privileged ones, so a target outside this set is refused
 * before a token is issued.
 */
export const BUILD_EXECUTION_TARGETS: ReadonlyMap<string, string> = new Map([
  ['a0000000-0000-0000-0000-000000000002', 'code-developer'],
  ['a0000000-0000-0000-0000-000000000003', 'code-reviewer'],
  ['a0000000-0000-0000-0000-000000000004', 'documentation-writer'],
  ['a0000000-0000-0000-0000-000000000005', 'test-engineer'],
  ['a0000000-0000-0000-0000-000000000008', 'devops-bot'],
  ['a0000000-0000-0000-0000-00000000000c', 'research-bot'],
  ['a0000000-0000-0000-0000-00000000000e', 'tester-bot'],
  ['a0000000-0000-0000-0000-000000000018', 'system-architect'],
  ['a0000000-0000-0000-0000-000000000099', 'general-bot'],
]);

/** Ticket states in which no node call is started. */
const STOPPED_TICKET_STATES = new Set(['cancelled', 'escalated', 'dead_letter']);

/** The routing watchdog's default threshold in minutes, mirrored from work-item-routing-watchdog-service. */
const DEFAULT_ROUTING_FAILURE_MINUTES = 30;

/** @description What a signed build dispatch needs. */
export interface SignedChildDispatchDeps {
  botNodeClient: Pick<BotNodeClient, 'execute' | 'isDelegationEnforced'>;
  workItemRepository?: WorkItemRepository;
  runtimeParamsResolver?: RuntimeParamsResolver;
  /** Reads a ticket's current status, so a ticket that has already ended is never sent to a node. */
  readTicketStatus?: (ticketId: string) => Promise<string | null>;
  /** How often the unit work item is refreshed; default a third of the routing watchdog threshold. */
  refreshIntervalMs?: number;
}

/** @description One execution dispatch for a build ticket. */
export interface SignedChildDispatchInput {
  /** The ticket's work item; its rawPayload is the queued ticket. */
  item: ExternalWorkItem;
  /** The routing winner. */
  agentId: string;
  workUnits: DecomposedWorkUnit[];
  /** The root ticket's folder, shared by every child of the tree. */
  workspaceTaskId: string;
  retryFeedback?: string;
}

/** @description Sends build execution over the signed hop when signing is configured. */
export interface SignedChildDispatcher {
  /** True while delegation signing is configured; only then does the lifecycle use this dispatcher. */
  isEnforced(): boolean;
  /** Runs one execution and returns its output, or `{ status: 'failed', error }`. */
  dispatch(input: SignedChildDispatchInput): Promise<unknown>;
}

/**
 * @description Creates the signed build-execution dispatcher.
 * @param deps - The bot-node client, the work-item repository and the config resolver.
 * @returns The dispatcher the execution lifecycle consults.
 */
export function createSignedChildDispatcher(deps: SignedChildDispatchDeps): SignedChildDispatcher {
  return {
    isEnforced: () => deps.botNodeClient.isDelegationEnforced(),
    dispatch: (input) => dispatchOverSignedHop(deps, input),
  };
}

/**
 * @description One execution over the signed hop: refuse a target off the allowlist, mark the unit
 * work item assigned and keep it fresh, call the node as the ticket's owner, record the result.
 * @param deps - Dispatcher deps.
 * @param input - The dispatch.
 * @returns The output recorded on the unit work item.
 */
async function dispatchOverSignedHop(deps: SignedChildDispatchDeps, input: SignedChildDispatchInput): Promise<unknown> {
  const ticketId = input.item.externalId;
  const workItemId = await findUnitWorkItem(deps, ticketId, input.workUnits[0]?.unitId);
  if (!BUILD_EXECUTION_TARGETS.has(input.agentId)) {
    logger.warn({ ticketId, agentId: input.agentId }, 'Build execution target is not on the build-lane allowlist - refused before any token');
    const refused = { status: 'failed', error: `child_target_not_allowlisted: ${input.agentId} is not a build-lane execution target` };
    await recordUnitResult(deps, workItemId, refused, false, input.agentId);
    return refused;
  }
  const stopped = await stoppedTicketState(deps, ticketId);
  if (stopped) {
    logger.info({ ticketId, agentId: input.agentId, status: stopped }, 'Build execution not started - the ticket has already ended');
    const refused = { status: 'failed', error: `child_ticket_stopped: ticket ${ticketId} is ${stopped}; no node call was made` };
    await recordUnitResult(deps, workItemId, refused, false, input.agentId);
    return refused;
  }
  await markUnitAssigned(deps, workItemId, input.agentId);
  const stopRefreshing = startUnitRefresher(deps, ticketId, workItemId, input.agentId);
  const startedAt = Date.now();
  try {
    const output = await executeOnNode(deps, input);
    await recordUnitResult(deps, workItemId, output, !isFailure(output), input.agentId);
    logger.info({ ticketId, agentId: input.agentId, success: !isFailure(output), durationMs: Date.now() - startedAt }, 'Signed build execution finished');
    return output;
  } catch (err) {
    logger.error({ err, ticketId, agentId: input.agentId }, 'Signed build execution failed');
    const failed = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    await recordUnitResult(deps, workItemId, failed, false, input.agentId);
    return failed;
  } finally {
    stopRefreshing();
  }
}

/**
 * @description Calls the node with the prompt the mesh worker would have built, as the ticket's
 * owner with its persisted verified issuer.
 * @param deps - Dispatcher deps.
 * @param input - The dispatch.
 * @returns The execution output, or a failure record when the node reported failure.
 */
async function executeOnNode(deps: SignedChildDispatchDeps, input: SignedChildDispatchInput): Promise<unknown> {
  const ticketId = input.item.externalId;
  const ticket = (input.item as Record<string, unknown>).rawPayload as Record<string, unknown> | undefined;
  const ownerSub = typeof ticket?.ownerSub === 'string' && ticket.ownerSub.trim() ? ticket.ownerSub : undefined;
  const configFields = await pushOnDispatchFields(deps.runtimeParamsResolver, input.agentId);
  const result = await deps.botNodeClient.execute(input.agentId, {
    text: buildExecutionText(input),
    taskId: ticketId,
    workspaceFolderId: input.workspaceTaskId,
    agentId: input.agentId,
    agenticMode: true,
    userSub: ownerSub,
    principalIssuer: readOwnerPrincipalIssuer(ticket?.metadata as Record<string, unknown> | undefined) ?? undefined,
    ...configFields,
  });
  if (!result.success) {
    return { status: 'failed', error: result.error ?? 'the bot node reported a failed execution', output: result.response ?? null };
  }
  return {
    agentId: input.agentId, taskId: ticketId, content: result.response,
    provider: result.provider, model: result.model, usage: result.usage,
  };
}

/**
 * @description The execution prompt, built by the same function the mesh worker uses, from a
 * phase-4 envelope carrying the ticket's work units, depth, sibling titles and retry feedback.
 * @param input - The dispatch.
 * @returns The prompt text the node receives.
 */
function buildExecutionText(input: SignedChildDispatchInput): string {
  const ticket = (input.item as Record<string, unknown>).rawPayload as Record<string, unknown> | undefined;
  const metadata = (ticket?.metadata ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = {
    externalId: input.item.externalId,
    phase: 4,
    round: 1,
    agentId: input.agentId,
    ticketDepth: Number(metadata.depth ?? 0),
    workspaceTaskId: input.workspaceTaskId,
    workUnits: input.workUnits,
    ...(Array.isArray(metadata.siblingTitles) ? { siblingTitles: metadata.siblingTitles } : {}),
    ...(input.retryFeedback ? { retryFeedback: input.retryFeedback } : {}),
  };
  return buildUserMessage({ payload } as Parameters<typeof buildUserMessage>[0]);
}

/**
 * @description The work item for the dispatch's first unit.
 * @param deps - Dispatcher deps.
 * @param ticketId - The ticket.
 * @param unitId - The first unit's id.
 * @returns The work item id, or undefined when none exists or the read fails.
 */
async function findUnitWorkItem(deps: SignedChildDispatchDeps, ticketId: string, unitId: string | undefined): Promise<string | undefined> {
  if (!deps.workItemRepository || !unitId) return undefined;
  try {
    const items = await deps.workItemRepository.findByExternalIdAnyProvider(ticketId);
    return items.find((item) => (item as { unitId?: string }).unitId === unitId)?.workItemId;
  } catch (err) {
    logger.error({ err, ticketId, unitId }, 'Failed to read the unit work item for a signed build execution');
    return undefined;
  }
}

/**
 * @description Marks the unit work item assigned to the node doing the work.
 * @param deps - Dispatcher deps.
 * @param workItemId - The unit work item, when one exists.
 * @param agentId - The node's agent.
 * @returns Resolves once written or failed.
 */
async function markUnitAssigned(deps: SignedChildDispatchDeps, workItemId: string | undefined, agentId: string): Promise<void> {
  if (!workItemId || !deps.workItemRepository) return;
  try {
    await deps.workItemRepository.updateStatus(workItemId, 'assigned', agentId);
  } catch (err) {
    logger.error({ err, workItemId }, 'Failed to mark the unit work item assigned');
  }
}

/**
 * @description The ticket's state when it has already ended (cancelled, escalated or dead-lettered),
 * or null. The execution policy runner retries a failed attempt without reading the ticket, so this
 * check is what keeps a cancelled child from reaching a node again.
 * @param deps - Dispatcher deps.
 * @param ticketId - The ticket.
 * @returns The ended state, or null when the ticket is live or unreadable.
 */
async function stoppedTicketState(deps: SignedChildDispatchDeps, ticketId: string): Promise<string | null> {
  if (!deps.readTicketStatus) return null;
  const status = await deps.readTicketStatus(ticketId).catch(() => null);
  return status && STOPPED_TICKET_STATES.has(status) ? status : null;
}

/**
 * @description Keeps the unit work item fresh while the node works, so the routing watchdog does not
 * read a long run as a dropped dispatch. A node call cannot be aborted, so the item stays assigned
 * until the call returns, whatever the ticket's state: `assigned` means a call is in flight, which
 * is what anything waiting for the node to return relies on.
 * @param deps - Dispatcher deps.
 * @param ticketId - The ticket.
 * @param workItemId - The unit work item, when one exists.
 * @param agentId - The node's agent.
 * @returns A stop function, called once the call has returned.
 */
function startUnitRefresher(deps: SignedChildDispatchDeps, ticketId: string, workItemId: string | undefined, agentId: string): () => void {
  if (!workItemId || !deps.workItemRepository) return () => undefined;
  const repository = deps.workItemRepository;
  const timer = setInterval(() => {
    repository.updateStatus(workItemId, 'assigned', agentId)
      .catch((err) => logger.error({ err, ticketId, workItemId }, 'Failed to refresh the unit work item'));
  }, deps.refreshIntervalMs ?? defaultRefreshIntervalMs());
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * @description A third of the routing watchdog threshold.
 * @returns The refresh interval in milliseconds.
 */
function defaultRefreshIntervalMs(): number {
  const minutes = Number(process.env.OSHAL_ROUTING_FAILURE_MINUTES);
  const threshold = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_ROUTING_FAILURE_MINUTES;
  return Math.max(10_000, Math.floor((threshold * 60_000) / 3));
}

/**
 * @description Records the execution output and terminal status on the unit work item.
 * @param deps - Dispatcher deps.
 * @param workItemId - The unit work item, when one exists.
 * @param output - The output to store.
 * @param succeeded - Whether the execution succeeded.
 * @param agentId - The node's agent.
 * @returns Resolves once written or failed.
 */
async function recordUnitResult(
  deps: SignedChildDispatchDeps,
  workItemId: string | undefined,
  output: unknown,
  succeeded: boolean,
  agentId: string,
): Promise<void> {
  if (!workItemId || !deps.workItemRepository) return;
  try {
    await deps.workItemRepository.setExecutionOutput(workItemId, output);
    await deps.workItemRepository.updateStatus(workItemId, succeeded ? 'completed' : 'failed', agentId);
  } catch (err) {
    logger.error({ err, workItemId }, 'Failed to record the signed build execution result');
  }
}

/**
 * @description True for a failure record (`{ status: 'failed' }`).
 * @param output - An execution output.
 * @returns Whether it records a failure.
 */
function isFailure(output: unknown): boolean {
  return output !== null && typeof output === 'object' && (output as Record<string, unknown>).status === 'failed';
}

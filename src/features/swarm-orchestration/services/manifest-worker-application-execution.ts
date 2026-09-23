/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Restore immutable queued callers and attach protected fan-out results to their exact parent ticket.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Build the supported direct/hosted request for a queued protected dispatch instead of sending the agentic queue shape the worker denies, and refuse with the exact missing requirement when the ticket owner has no hosted connection.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Resolve queued work through the same configured user-brain ladder as Jarvis. A hosted selection carries its endpoint; a CLI selection carries its provider/model stamp. No vendor is selected here, so protected work can no longer silently replace the configured brain with a stale hosted connection.
 */
import type { InternalTicket } from '@/entities/ticket';
import type { BotNodeClient, BotNodeRequest, BotNodeResponse } from '@/features/agent-management';
import type { ITaskStore } from '@/entities/task';
import { isApplicationExecutionProtected } from '@/shared/application-authorization-execution';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { runWithQueuedApplicationPrincipal } from '@/shared/queued-application-principal';
import { runWithRemoteExecutionResults } from '@/shared/remote-execution-results';
import { appendProtectedResultExecution, assertProtectedResultAccess } from '@/shared/protected-results';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY, readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'manifest-worker-application-execution' });

/** @description The three wire fields a hosted brain carries as its reasoning endpoint. */
export interface QueuedHostedBrainConnection { baseUrl: string; apiKey: string; model: string }

/** @description The one configuration-owned brain selection shared with Jarvis. */
export type QueuedResolvedBrain =
  | { kind: 'hosted'; connection: QueuedHostedBrainConnection }
  | { kind: 'cli'; providerId: string; model?: string }
  | { kind: 'none' };

/**
 * @description Resolves the ticket owner's configured brain for a queued dispatch. Composition
 * supplies the same `resolveUserBrain` ladder used by Jarvis, so a queue cannot silently replace
 * the selected CLI provider with an unrelated hosted connection.
 */
export type QueuedBrainResolver = (ownerSub: string) => Promise<QueuedResolvedBrain | null | undefined>;

/** Controller-added dispatch stamping that a protected request must not carry — see {@link supportedProtectedRequest}. */
const AUTHORITATIVE_CONFIG_FIELDS = ['providerId', 'model', 'configVersion', 'providerConfigRequired'] as const;
const HOSTED_WIRE_FIELDS = ['baseUrl', 'apiKey', 'model'] as const;

/**
 * @description A queued protected dispatch that cannot be built in the supported shape. The stable
 * code leads the message so existing callers keep matching it, and the reason names exactly what is
 * missing so the ticket's escalation metadata — and the failure line the thread shows — can quote it
 * instead of escalating blank.
 */
export class QueuedProtectedDispatchError extends Error {
  /** Stable machine code; dispatch refuses the localhost fallback on it. */
  readonly code = 'authorization_queued_protected_shape_required';
  constructor(public readonly reason: string) {
    super(`authorization_queued_protected_shape_required: ${reason}`);
    this.name = 'QueuedProtectedDispatchError';
  }
}

/**
 * @description Builds one of the configured reasoning shapes the protected worker admits (see
 * docs/security/remote-application-execution.md "Supported execution"): always `direct: true`
 * and `agenticMode: false`, with either a server-resolved hosted connection or an authoritative
 * provider/model stamp. The queue otherwise sends its ordinary agentic shape, which the worker
 * denies with `authorization_remote_hosted_reasoning_required`.
 *
 * This does not relax anything: the worker's contract is unchanged and still the authority. What
 * changes is that a queued dispatch now either satisfies it or refuses with a reason a human can act
 * on, rather than being signed, delegated and then denied at the far end.
 *
 * Connector credentials and deterministic provider intents are REFUSED rather than stripped — a
 * protected application may not carry them, and silently dropping one would turn a deterministic
 * operation into a reasoning-only answer without saying so. The controller's own authoritative
 * provider/model stamping is replaced by the resolved brain: hosted selections carry only the
 * endpoint, while CLI selections carry only the selected provider/model authority.
 * @param request - The request the queue built for this worker.
 * @param resolveBrain - The owner's configured-brain resolver, injected by composition.
 * @returns The same work in the supported protected shape.
 * @throws QueuedProtectedDispatchError naming the exact unmet requirement.
 */
async function supportedProtectedRequest(request: BotNodeRequest,
  resolveBrain?: QueuedBrainResolver): Promise<BotNodeRequest> {
  const ownerSub = request.userSub?.trim();
  if (!ownerSub) throw new QueuedProtectedDispatchError('the ticket carries no authenticated owner subject to resolve its configured AI brain');
  if (request.providerIntent || (request.creds && Object.keys(request.creds).length > 0)) {
    throw new QueuedProtectedDispatchError('a protected application dispatch may not carry connector credentials or a deterministic provider intent');
  }
  if (!resolveBrain) {
    throw new QueuedProtectedDispatchError('this controller has no configured-brain resolver wired for queued protected dispatch');
  }
  let brain: QueuedResolvedBrain | null | undefined;
  try {
    brain = await resolveBrain(ownerSub);
  } catch (error) {
    throw new QueuedProtectedDispatchError(
      `resolving the ticket owner's configured AI brain failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (brain?.kind === 'cli') {
    const providerId = brain.providerId?.trim();
    if (!providerId) throw new QueuedProtectedDispatchError('the ticket owner\'s configured CLI brain has no provider id');
    const shaped: BotNodeRequest = { ...request, direct: true, agenticMode: false,
      providerId, providerConfigRequired: true };
    delete shaped.byoLlmConnection;
    delete shaped.configVersion;
    if (brain.model?.trim()) shaped.model = brain.model.trim();
    else delete shaped.model;
    return shaped;
  }
  const connection = brain?.kind === 'hosted' ? brain.connection : null;
  const missing = HOSTED_WIRE_FIELDS.filter(field => typeof connection?.[field] !== 'string' || !connection[field].trim());
  if (missing.length > 0) {
    throw new QueuedProtectedDispatchError(connection
      ? `the ticket owner's hosted AI connection is incomplete (missing ${missing.join(', ')}); connect a hosted provider under Settings -> AI Providers`
      : 'the ticket owner has no usable configured AI brain; select a provider under Settings -> AI Providers');
  }
  const shaped: BotNodeRequest = { ...request, direct: true, agenticMode: false,
    byoLlmConnection: { baseUrl: connection!.baseUrl, apiKey: connection!.apiKey, model: connection!.model } };
  for (const field of AUTHORITATIVE_CONFIG_FIELDS) delete shaped[field];
  return shaped;
}

async function recordResult(taskStore: ITaskStore | undefined, ticket: InternalTicket, agentId: string, executionId: string): Promise<void> {
  const actor = getApplicationAuthorizationActor();
  if (!actor || !taskStore) throw new Error('authorization_result_persistence_required');
  await assertProtectedResultAccess(executionId, ticket.ticketId, actor);
  let task = await taskStore.get(ticket.ticketId);
  if (!task) {
    try {
      task = await taskStore.create({ taskId: ticket.ticketId, title: ticket.title, processingMode: 'direct', agentId, ownerSub: actor.sub,
        metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: actor.issuer } });
    } catch (error) { task = await taskStore.get(ticket.ticketId); if (!task) throw error; }
  }
  if (task.ownerSub !== actor.sub || readOwnerPrincipalIssuer(task.metadata) !== actor.issuer) throw new Error('authorization_result_owner_mismatch');
  await taskStore.replace({ ...task, metadata: appendProtectedResultExecution(task.metadata, executionId) });
}

/** @description Dispatch queued work using immutable initiator evidence and current protected application authority.
 * @param client Signed controller client. @param ticket Durable ticket. @param agentId Selected actual bot.
 * @param request Controller-built payload. @param taskStore Canonical result destination.
 * @param resolveBrain Owner configured-brain resolver; required for a protected target.
 * @returns Result only after protected lineage has been linked and persisted.
 */
export async function executeManifestApplicationBot(client: BotNodeClient, ticket: InternalTicket, agentId: string,
  request: BotNodeRequest, taskStore?: ITaskStore, resolveBrain?: QueuedBrainResolver): Promise<BotNodeResponse> {
  const protectedTarget = await isApplicationExecutionProtected({ kind: 'bots', operation: agentId });
  const dispatched = protectedTarget ? await supportedProtectedRequest(request, resolveBrain) : request;
  if (protectedTarget) {
    logger.info({ agentId, ticketId: ticket.ticketId,
      provider: dispatched.providerId ?? (dispatched.byoLlmConnection ? 'hosted' : null),
      model: dispatched.model ?? dispatched.byoLlmConnection?.model },
    'Queued protected dispatch built from the owner configured brain');
  }
  return runWithQueuedApplicationPrincipal({ ticketId: ticket.ticketId, ownerSub: ticket.ownerSub,
    issuer: readOwnerPrincipalIssuer(ticket.metadata) }, protectedTarget, () => runWithRemoteExecutionResults({
      taskId: ticket.ticketId, record: executionId => recordResult(taskStore, ticket, agentId, executionId),
    }, () => client.execute(agentId, dispatched)));
}

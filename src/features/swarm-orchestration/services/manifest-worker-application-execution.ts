/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Restore immutable queued callers and attach protected fan-out results to their exact parent ticket.
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
 * @returns Result only after protected lineage has been linked and persisted.
 */
export async function executeManifestApplicationBot(client: BotNodeClient, ticket: InternalTicket, agentId: string,
  request: BotNodeRequest, taskStore?: ITaskStore): Promise<BotNodeResponse> {
  const protectedTarget = await isApplicationExecutionProtected({ kind: 'bots', operation: agentId });
  return runWithQueuedApplicationPrincipal({ ticketId: ticket.ticketId, ownerSub: ticket.ownerSub,
    issuer: readOwnerPrincipalIssuer(ticket.metadata) }, protectedTarget, () => runWithRemoteExecutionResults({
      taskId: ticket.ticketId, record: executionId => recordResult(taskStore, ticket, agentId, executionId),
    }, () => client.execute(agentId, request)));
}

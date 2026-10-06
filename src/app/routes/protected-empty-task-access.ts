/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Admit only genuinely empty protected threads to their active stamped owner under stable current bot policy and repeated store checks.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { readProtectedResultExecutions, readProtectedTaskNoticeState, type ProtectedResultTask } from '@/shared/protected-results';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';

/** @description Permit an exact owner's empty thread shell without treating absent lineage as readable output.
 * @param ctx Canonical task/message stores and verified actor resolver.
 * @param req Authenticated user request, after the existing ownership gate.
 * @param task Actual requested task; ticket-derived ownership cannot qualify an ownerless task.
 * @returns True only after actual emptiness and current bot permission are independently rechecked.
 */
export async function callerCanReadEmptyProtectedTask(ctx: AppContext, req: Request, task: ProtectedResultTask): Promise<boolean> {
  try {
    const authority = getApplicationRemoteExecutionAuthority(), runtime = ctx.applicationAuthorization;
    if (!authority || typeof authority.assertEmptyTaskAccess !== 'function' || !runtime || !task.agentId
      || readProtectedResultExecutions(task.metadata).length) return false;
    const actor = await runtime.resolveActor(req);
    if (!exactOwner(task, actor) || !await storedEmptyTask(ctx, task, actor)) return false;
    await authority.assertEmptyTaskAccess(task.agentId, actor);
    const currentTask = await storedEmptyTask(ctx, task, actor);
    const currentActor = await runtime.resolveActor(req);
    if (!currentTask?.agentId || !exactOwner(currentTask, currentActor)) return false;
    await authority.assertEmptyTaskAccess(currentTask.agentId, currentActor);
    return authority === getApplicationRemoteExecutionAuthority() && runtime === ctx.applicationAuthorization;
  } catch { return false; }
}

/** Only a creation-stamped exact principal qualifies; ordinary legacy and operator exceptions stay outside this gate. */
function exactOwner(task: ProtectedResultTask, actor: AuthorizationActor): boolean {
  const issuer = readOwnerPrincipalIssuer(task.metadata);
  return Boolean(actor.isActive && actor.sub && actor.issuer && issuer
    && task.ownerSub === actor.sub && issuer === actor.issuer);
}

/** Read the actual task and count, then classify its protected state through the stable configured result authority. */
async function storedEmptyTask(ctx: AppContext, requested: ProtectedResultTask, actor: AuthorizationActor): Promise<ProtectedResultTask | null> {
  const stored = await ctx.taskStore.get(requested.taskId);
  if (!stored || !sameOwnerBinding(stored, requested) || !exactOwner(stored, actor)
    || await ctx.messageStore.count(stored.taskId) !== 0) return null;
  const confirmed = await ctx.taskStore.get(requested.taskId);
  if (!confirmed || !sameOwnerBinding(confirmed, requested) || !exactOwner(confirmed, actor)) return null;
  return await readProtectedTaskNoticeState(confirmed) === 'protected-empty' ? confirmed : null;
}

function sameOwnerBinding(stored: ProtectedResultTask, requested: ProtectedResultTask): boolean {
  return stored.taskId === requested.taskId && stored.agentId === requested.agentId && stored.ownerSub === requested.ownerSub
    && readOwnerPrincipalIssuer(stored.metadata) === readOwnerPrincipalIssuer(requested.metadata);
}

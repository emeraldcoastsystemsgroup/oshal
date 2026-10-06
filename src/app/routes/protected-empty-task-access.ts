/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Admit only genuinely empty protected threads to their active stamped owner under stable current bot policy and repeated store checks.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Document each owner-binding check and record sanitized empty-thread decision lifecycles and caught failures without changing authorization order.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { readProtectedResultExecutions, readProtectedTaskNoticeState, type ProtectedResultTask } from '@/shared/protected-results';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { createChildLogger, logOperationError, observeAsyncOperation } from '@/shared/logger';

const logger = createChildLogger({ module: 'protected-empty-task-access' });

/**
 * @description Permit an exact owner's empty thread shell without treating absent lineage as readable output.
 * @param ctx Canonical task/message stores and verified actor resolver.
 * @param req Authenticated user request, after the existing ownership gate.
 * @param task Actual requested task; ticket-derived ownership cannot qualify an ownerless task.
 * @returns True only after actual emptiness and current bot permission are independently rechecked.
 */
export async function callerCanReadEmptyProtectedTask(ctx: AppContext, req: Request, task: ProtectedResultTask): Promise<boolean> {
  const operation = 'callerCanReadEmptyProtectedTask', context = { taskId: task.taskId, agentId: task.agentId };
  const startedAt = Date.now();
  return observeAsyncOperation(logger, operation, context, async () => {
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
    } catch (error) {
      logOperationError(logger, operation, context, error, startedAt);
      return false;
    }
  });
}

/**
 * @description Keep legacy and operator exceptions outside this creation-stamped owner gate.
 * @param task Actual task carrying the server-stamped owner and issuer.
 * @param actor Verified current principal whose account must remain active.
 * @returns Whether both principal components exactly match the stored active owner.
 */
function exactOwner(task: ProtectedResultTask, actor: AuthorizationActor): boolean {
  const issuer = readOwnerPrincipalIssuer(task.metadata);
  return Boolean(actor.isActive && actor.sub && actor.issuer && issuer
    && task.ownerSub === actor.sub && issuer === actor.issuer);
}

/**
 * @description Recheck stored ownership and real message emptiness before classifying a thread shell.
 * @param ctx Canonical task and message stores.
 * @param requested Earlier task binding that must survive every read.
 * @param actor Verified current principal allowed to read the task.
 * @returns The confirmed empty protected task, or null when any binding or count changed.
 */
async function storedEmptyTask(ctx: AppContext, requested: ProtectedResultTask, actor: AuthorizationActor): Promise<ProtectedResultTask | null> {
  const stored = await ctx.taskStore.get(requested.taskId);
  if (!stored || !sameOwnerBinding(stored, requested) || !exactOwner(stored, actor)
    || await ctx.messageStore.count(stored.taskId) !== 0) return null;
  const confirmed = await ctx.taskStore.get(requested.taskId);
  if (!confirmed || !sameOwnerBinding(confirmed, requested) || !exactOwner(confirmed, actor)) return null;
  return await readProtectedTaskNoticeState(confirmed) === 'protected-empty' ? confirmed : null;
}

/**
 * @description Refuse a changed destination or owner while an empty-thread decision is pending.
 * @param stored Task read again from the canonical store.
 * @param requested Original task binding for this decision.
 * @returns Whether task, bot and exact stamped principal still match.
 */
function sameOwnerBinding(stored: ProtectedResultTask, requested: ProtectedResultTask): boolean {
  return stored.taskId === requested.taskId && stored.agentId === requested.agentId && stored.ownerSub === requested.ownerSub
    && readOwnerPrincipalIssuer(stored.metadata) === readOwnerPrincipalIssuer(requested.metadata);
}

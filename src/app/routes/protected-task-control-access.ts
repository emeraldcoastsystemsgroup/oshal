/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Authorize exact-owner protected approval controls through repeated stored principal and live execution policy checks without admitting pending output.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Document private owner-binding checks and observe sanitized control decisions and caught failures while preserving current-policy check order.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { hasAuthenticatedUserIdentity } from '@/shared/middleware/authz';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import type { ProtectedResultTask } from '@/shared/protected-results';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { createChildLogger, logOperationError, observeAsyncOperation } from '@/shared/logger';

const logger = createChildLogger({ module: 'protected-task-control-access' });

/**
 * @description Admit a protected task's approval controls independently of completed result/history access.
 * @param ctx Canonical task store and verified request actor resolver.
 * @param req Authenticated subscriber request; content never supplies identity.
 * @param taskId Exact server-selected task carrying the approval event.
 * @returns True only for an unchanged stamped owner and stable authority after repeated current execution checks.
 */
export async function callerCanReadTaskControlEvent(ctx: AppContext, req: Request, taskId: string): Promise<boolean> {
  const operation = 'callerCanReadTaskControlEvent', context = { taskId }, startedAt = Date.now();
  return observeAsyncOperation(logger, operation, context, async () => {
    try {
      const authority = getApplicationRemoteExecutionAuthority(), runtime = ctx.applicationAuthorization;
      if (!authority || typeof authority.assertTaskControlAccess !== 'function' || !runtime
        || isGuestRequest(req) || !hasAuthenticatedUserIdentity(req)) return false;
      const task = await ctx.taskStore.get(taskId), actor = await runtime.resolveActor(req);
      if (!task || task.taskId !== taskId || !exactOwner(task, actor)) return false;
      await authority.assertTaskControlAccess(taskId, actor);
      const currentTask = await ctx.taskStore.get(taskId), currentActor = await runtime.resolveActor(req);
      if (!currentTask || !sameOwnerBinding(currentTask, task) || !exactOwner(currentTask, currentActor)) return false;
      await authority.assertTaskControlAccess(taskId, currentActor);
      return authority === getApplicationRemoteExecutionAuthority() && runtime === ctx.applicationAuthorization;
    } catch (error) {
      logOperationError(logger, operation, context, error, startedAt);
      return false;
    }
  });
}

/**
 * @description Keep guest and operator exceptions outside the active creation-stamped owner gate.
 * @param task Actual task carrying the server-selected bot and stamped owner.
 * @param actor Verified current principal whose account must remain active.
 * @returns Whether both principal components exactly match an owned task with a bot.
 */
function exactOwner(task: ProtectedResultTask, actor: AuthorizationActor): boolean {
  const issuer = readOwnerPrincipalIssuer(task.metadata);
  return Boolean(task.agentId && actor.isActive && actor.sub && actor.issuer && issuer
    && task.ownerSub === actor.sub && issuer === actor.issuer);
}

/**
 * @description Invalidate an earlier control decision if its destination or stamped principal changed.
 * @param current Task read again after the current execution-policy check.
 * @param initial Original stored binding for this subscriber.
 * @returns Whether task, bot and exact stamped principal still match.
 */
function sameOwnerBinding(current: ProtectedResultTask, initial: ProtectedResultTask): boolean {
  return current.taskId === initial.taskId && current.agentId === initial.agentId && current.ownerSub === initial.ownerSub
    && readOwnerPrincipalIssuer(current.metadata) === readOwnerPrincipalIssuer(initial.metadata);
}

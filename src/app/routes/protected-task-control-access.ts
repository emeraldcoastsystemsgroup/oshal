/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Authorize exact-owner protected approval controls through repeated stored principal and live execution policy checks without admitting pending output.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { hasAuthenticatedUserIdentity } from '@/shared/middleware/authz';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import type { ProtectedResultTask } from '@/shared/protected-results';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';

/**
 * @description Admit a protected task's approval controls independently of completed result/history access.
 * @param ctx Canonical task store and verified request actor resolver.
 * @param req Authenticated subscriber request; content never supplies identity.
 * @param taskId Exact server-selected task carrying the approval event.
 * @returns True only for an unchanged stamped owner and stable authority after repeated current execution checks.
 */
export async function callerCanReadTaskControlEvent(ctx: AppContext, req: Request, taskId: string): Promise<boolean> {
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
  } catch { return false; }
}

/** The exact active owner must have a server-stamped issuer; guest and operator exceptions do not qualify. */
function exactOwner(task: ProtectedResultTask, actor: AuthorizationActor): boolean {
  const issuer = readOwnerPrincipalIssuer(task.metadata);
  return Boolean(task.agentId && actor.isActive && actor.sub && actor.issuer && issuer
    && task.ownerSub === actor.sub && issuer === actor.issuer);
}

/** Changing the task destination or principal while policy is checked invalidates the earlier decision. */
function sameOwnerBinding(current: ProtectedResultTask, initial: ProtectedResultTask): boolean {
  return current.taskId === initial.taskId && current.agentId === initial.agentId && current.ownerSub === initial.ownerSub
    && readOwnerPrincipalIssuer(current.metadata) === readOwnerPrincipalIssuer(initial.metadata);
}

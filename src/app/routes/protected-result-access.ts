/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reuse the verified request actor and current stored task for protected result reads.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import { canAccessResource, getTrustedServiceUserSub } from '@/shared/middleware/authz';
import { canReadProtectedResult, type ProtectedResultTask } from '@/shared/protected-results';

/**
 * @description Combine legacy task ownership with current exact-principal protected-result authority.
 * @param ctx - Controller context containing the shared verified actor resolver.
 * @param req - Authenticated request; no body identity is inspected.
 * @param task - Current stored task.
 * @returns Whether the task may be exposed to this request.
 */
export async function callerCanReadTaskResult(ctx: AppContext, req: Request, task: ProtectedResultTask): Promise<boolean> {
  const serviceSub = getTrustedServiceUserSub(req);
  if (!(serviceSub ? serviceSub === task.ownerSub : canAccessResource(req, task.ownerSub))) return false;
  return canReadProtectedResult(task, async () => {
    if (!ctx.applicationAuthorization) throw new Error('protected_result_identity_unavailable');
    return ctx.applicationAuthorization.resolveActor(req);
  });
}

/**
 * @description Read current task ownership for stream subscription and each subsequent event.
 * @param ctx - Controller stores and authority.
 * @param req - The subscribing authenticated request.
 * @param taskId - Server-selected task being delivered.
 * @returns False for missing, unavailable, foreign or revoked results.
 */
export async function callerCanReadStoredTaskResult(ctx: AppContext, req: Request, taskId: string): Promise<boolean> {
  try {
    const task = await ctx.taskStore.get(taskId);
    return Boolean(task && await callerCanReadTaskResult(ctx, req, task));
  } catch { return false; }
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reuse the verified request actor and current stored task for protected result reads.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Report a stored-task access check that could not be DETERMINED rather than answering "denied" in silence. The fail-closed return is unchanged  this is a per-event stream callback and a throw here would reach the stream loop  but a store error is now logged at ERROR with the task it was deciding, so an outage stops reading as a refusal.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Apply current canonical row ownership before ordinary or protected task reads, preserving strict guest provenance and the explicitly inherited bare-service ordinary rail.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Admit genuinely empty protected thread shells through exact stamped ownership and current bot policy while retaining all completed-result checks.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import { getTrustedServiceUserSub, hasAuthenticatedUserIdentity } from '@/shared/middleware/authz';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import { canReadProtectedResult, type ProtectedResultTask } from '@/shared/protected-results';
import { createChildLogger } from '@/shared/logger';
import { createRecordOwnership, guestOwnsRecord, type OwnedRecord } from './record-ownership';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { callerCanReadEmptyProtectedTask } from './protected-empty-task-access';

const logger = createChildLogger({ module: 'protected-result-access' });

/**
 * @description Require current row ownership and protected-result rights without borrowing ticket execution metadata.
 * @param ctx - Controller context containing the shared verified actor resolver.
 * @param req - Authenticated request; no body identity is inspected.
 * @param task - Current stored task.
 * @param ownership - Optional actual ticket ownership for an ownerless or missing task; separate from result lineage.
 * @returns Whether the task may be exposed to this request.
 */
export async function callerCanReadTaskResult(ctx: AppContext, req: Request, task: ProtectedResultTask,
  ownership: OwnedRecord = task): Promise<boolean> {
  try {
    if (!consistentTaskOwnership(task, ownership)) return false;
    const checks = createRecordOwnership(ctx, req);
    const guest = isGuestRequest(req);
    const authenticated = hasAuthenticatedUserIdentity(req);
    const serviceSub = !guest && !authenticated ? getTrustedServiceUserSub(req) : null;
    const owned = guest ? guestOwnsRecord(req, ownership)
      : authenticated ? await checks.owns(ownership) : Boolean(serviceSub && serviceSub === ownership.ownerSub);
    if (!owned) return false;
    // Only task metadata participates in protected-result lineage. Bare services and guests
    // have no application actor; they retain ordinary compatibility but cannot read protected output.
    const readable = await canReadProtectedResult({ taskId: task.taskId, ownerSub: ownership.ownerSub,
      agentId: task.agentId, metadata: task.metadata }, async () => {
      if (guest || !authenticated) throw new Error('protected_result_identity_unavailable');
      return checks.actor();
    });
    return readable || (!guest && authenticated && await callerCanReadEmptyProtectedTask(ctx, req, task));
  } catch (err) {
    logger.error({ err, taskId: task.taskId }, 'task result ownership undetermined; failing closed');
    return false;
  }
}

function consistentTaskOwnership(task: ProtectedResultTask, ownership: OwnedRecord): boolean {
  if (task.ownerSub && task.ownerSub !== ownership.ownerSub) return false;
  const issuer = readOwnerPrincipalIssuer(task.metadata);
  return !issuer || issuer === readOwnerPrincipalIssuer(ownership.metadata);
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
  } catch (err) {
    // Fail closed. The return stays `false` deliberately: this runs as the per-event callback
    // registered with streamManager, so throwing would surface as an unhandled rejection per
    // streamed event rather than a clean 5xx. The ERROR is what makes the fault visible.
    logger.error({ err, taskId }, 'stored task result access undetermined; failing closed');
    return false;
  }
}

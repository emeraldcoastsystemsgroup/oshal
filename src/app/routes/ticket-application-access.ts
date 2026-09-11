/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Apply exact-principal current result checks to ticket detail and queue listings.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import type { InternalTicket } from '@/entities/ticket';
import { canReadProtectedResult } from '@/shared/protected-results';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';

/** @description Constrain ticket fields and chat access using canonical task execution lineage.
 * @param ctx Canonical task store and actor resolver. @param req Verified request. @param ticket Loaded ticket.
 * @returns Whether current application authority permits exposing this ticket's result surface.
 */
export async function canReadTicketApplicationResult(ctx: AppContext, req: Request, ticket: InternalTicket): Promise<boolean> {
  try {
    const task = await ctx.taskStore?.get(ticket.ticketId);
    const target = task ?? { taskId: ticket.ticketId, ownerSub: ticket.ownerSub,
      agentId: ticket.assignedAgentId ?? (typeof ticket.metadata.targetAgentId === 'string' ? ticket.metadata.targetAgentId : undefined),
      metadata: ticket.metadata };
    return canReadProtectedResult(target, async () => {
      const actor = ctx.applicationAuthorization ? await ctx.applicationAuthorization.resolveActor(req) : getApplicationAuthorizationActor();
      if (!actor) throw new Error('authorization_result_identity_required');
      return actor;
    });
  } catch { return false; }
}

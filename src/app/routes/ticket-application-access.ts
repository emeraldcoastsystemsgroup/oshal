/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Apply exact-principal current result checks to ticket detail and queue listings.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | canReadTicket: the one by-id ticket read verdict (owner or operator, AND current result rights), so loading a ticket by id and selecting it as a parent cannot drift apart again.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | canReadTicket decides ownership through ownsRecord (record-ownership.ts), the exact-principal check the cockpit already used: owner or operator, an ACTIVE verified actor, and the recorded owner issuer for a non-operator. It fails closed when no verified actor exists, and the cockpit's canReadCockpitTicket now delegates here. Before, /api/tickets admitted by sub alone, so a principal with the owner's sub from another issuer, or an inactive owner, could read what the cockpit refused. The result check reuses the same verified-actor resolver. P5 step 1.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import type { InternalTicket } from '@/entities/ticket';
import { canReadProtectedResult } from '@/shared/protected-results';
import { ownsRecord, verifiedActorFor } from './record-ownership';

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
    return canReadProtectedResult(target, () => verifiedActorFor(ctx, req));
  } catch { return false; }
}

/** @description The one ticket read verdict, shared by /api/tickets (load by id, parent selection, the
 * cockpit-compatibility state route) and the cockpit: exact-principal ownership through ownsRecord (owner or
 * operator, an ACTIVE verified actor, the recorded owner issuer for a non-operator) AND current result rights.
 * @param ctx Canonical task store and actor resolver. @param req Verified request. @param ticket Loaded ticket.
 * @returns Whether the caller may read the ticket; false when no verified actor exists.
 */
export async function canReadTicket(ctx: AppContext, req: Request, ticket: InternalTicket): Promise<boolean> {
  try { return await ownsRecord(ctx, req, ticket) && await canReadTicketApplicationResult(ctx, req, ticket); }
  catch { return false; }
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Apply exact-principal current result checks to ticket detail and queue listings.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | canReadTicket: the one by-id ticket read verdict (owner or operator, AND current result rights), so loading a ticket by id and selecting it as a parent cannot drift apart again.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | canReadTicket decides ownership through ownsRecord (record-ownership.ts), the exact-principal check the cockpit already used: owner or operator, an ACTIVE verified actor, and the recorded owner issuer for a non-operator. It fails closed when no verified actor exists, and the cockpit's canReadCockpitTicket now delegates here. Before, /api/tickets admitted by sub alone, so a principal with the owner's sub from another issuer, or an inactive owner, could read what the cockpit refused. The result check reuses the same verified-actor resolver. P5 step 1.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Guest own-ticket reads restored (coordinator option b, 2026-10-04). Seq 3 refused guests every by-id ticket, because a signed guest session has no application actor; the guest-reachable experience shells read a guest's own work by id. A guest request now owns a ticket only through guestOwnsRecord (marker + guest issuer + exact sub + recorded guest issuer); everyone else keeps exact-principal ownsRecord. The result leg is unchanged, so a guest's protected-app ticket is still refused. createTicketReadCheck applies the same verdict to a collection with one verified-actor lookup per request; the LIST route uses it.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import type { InternalTicket } from '@/entities/ticket';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import { canReadProtectedResult } from '@/shared/protected-results';
import { createRecordOwnership, guestOwnsRecord, verifiedActorFor } from './record-ownership';

/** @description The ticket's result leg: current exact-principal application rights over its execution lineage.
 * @param ctx Canonical task store. @param ticket Loaded ticket. @param resolveActor The request's verified actor.
 * @returns Whether current application authority permits exposing this ticket's result surface.
 */
async function ticketResultReadable(ctx: AppContext, ticket: InternalTicket,
  resolveActor: () => Promise<AuthorizationActor>): Promise<boolean> {
  try {
    const task = await ctx.taskStore?.get(ticket.ticketId);
    const target = task ?? { taskId: ticket.ticketId, ownerSub: ticket.ownerSub,
      agentId: ticket.assignedAgentId ?? (typeof ticket.metadata.targetAgentId === 'string' ? ticket.metadata.targetAgentId : undefined),
      metadata: ticket.metadata };
    return await canReadProtectedResult(target, resolveActor);
  } catch { return false; }
}

/** @description Constrain ticket fields and chat access using canonical task execution lineage.
 * @param ctx Canonical task store and actor resolver. @param req Verified request. @param ticket Loaded ticket.
 * @returns Whether current application authority permits exposing this ticket's result surface.
 */
export async function canReadTicketApplicationResult(ctx: AppContext, req: Request, ticket: InternalTicket): Promise<boolean> {
  return ticketResultReadable(ctx, ticket, () => verifiedActorFor(ctx, req));
}

/** @description The one ticket read verdict for a request, reusable across a collection: ownership (a guest through
 * guestOwnsRecord, everyone else through exact-principal ownership with one memoized verified actor) AND current
 * result rights. Shared by /api/tickets (by id, parent selection, the state route, the LIST) and the cockpit.
 * @param ctx Canonical task store and actor resolver. @param req Verified request.
 * @returns A per-ticket check that fails closed when no verified actor exists.
 */
export function createTicketReadCheck(ctx: AppContext, req: Request): (ticket: InternalTicket) => Promise<boolean> {
  const guest = isGuestRequest(req);
  const ownership = createRecordOwnership(ctx, req);
  return async (ticket: InternalTicket): Promise<boolean> => {
    try {
      const owns = guest ? guestOwnsRecord(req, ticket) : await ownership.owns(ticket);
      return owns && await ticketResultReadable(ctx, ticket, ownership.actor);
    } catch { return false; }
  };
}

/** @description The one ticket read verdict for a single ticket (see createTicketReadCheck).
 * @param ctx Canonical task store and actor resolver. @param req Verified request. @param ticket Loaded ticket.
 * @returns Whether the caller may read the ticket; false when no verified actor exists.
 */
export async function canReadTicket(ctx: AppContext, req: Request, ticket: InternalTicket): Promise<boolean> {
  return createTicketReadCheck(ctx, req)(ticket);
}

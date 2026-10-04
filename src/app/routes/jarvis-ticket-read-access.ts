/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep Jarvis ticket projections and chat carriers on current exact-principal ownership and result authority, logging unavailable read boundaries at ERROR without changing refusal or fallback decisions.
 */
import type { Request } from 'express';
import type { AppContext } from '../composition-root';
import type { InternalTicket } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import { getVerifiedWorkloadDelegation } from '@/features/security';
import { getCaller, hasAuthenticatedUserIdentity } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer, GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { isAuthenticatedGuest, verifiedActorFor } from './record-ownership';
import { createTicketReadCheck, canReadTicketApplicationResult } from './ticket-application-access';

const logger = createChildLogger({ module: 'jarvis-ticket-read-access' });

/** @description One request's ticket read and fresh owned-carrier admission callbacks. */
export interface JarvisTicketReadAccess {
  canRead(ticket: InternalTicket): Promise<boolean>;
  canOpen(ownerSub: string): Promise<boolean>;
}

/** @description Resolve current ordinary/guest ticket rights, adapting only verified delegated self-reads.
 * @param ctx Current actor and result authorities. @param req Authenticated user or verified delegation.
 * @returns Canonical ordinary/guest reads and exact delegated-owner reads; no machine or operator grant is invented.
 */
export function createJarvisTicketReadAccess(ctx: AppContext, req: Request): JarvisTicketReadAccess {
  const delegated = hasAuthenticatedUserIdentity(req) ? null : getVerifiedWorkloadDelegation(req);
  let pending: ReturnType<typeof verifiedActorFor> | undefined;
  const actor = () => pending ??= verifiedActorFor(ctx, req);
  const sub = delegated?.sub ?? getCaller(req).sub;
  const issuer = delegated?.principal_iss ?? getAuthenticatedPrincipalIssuer(req);
  const ordinary = createTicketReadCheck(ctx, req);
  return {
    async canRead(ticket) {
      if (!delegated) return ordinary(ticket);
      try {
        const current = await actor(), storedIssuer = readOwnerPrincipalIssuer(ticket.metadata);
        if (!current.isActive || current.sub !== sub || current.issuer !== issuer || ticket.ownerSub !== sub
          || storedIssuer && storedIssuer !== issuer) return false;
        return await canReadTicketApplicationResult(ctx, req, ticket);
      } catch (err) {
        logger.error({ err, ticketId: ticket.ticketId }, 'Jarvis delegated ticket read failed');
        return false;
      }
    },
    async canOpen(ownerSub) {
      if (!sub || ownerSub !== sub) return false;
      if (!delegated && (isGuestRequest(req) || issuer === GUEST_PRINCIPAL_ISSUER)) return isAuthenticatedGuest(req);
      try {
        const current = await actor();
        return Boolean(issuer && current.isActive && current.sub === sub && current.issuer === issuer);
      } catch (err) {
        logger.error({ err }, 'Jarvis carrier admission failed');
        return false;
      }
    },
  };
}

/** @description Filter ticket records before any count, projection or carrier selection.
 * @param tickets Loaded candidate records. @param canRead Server-bound request verdict.
 * @returns Only currently admitted records, preserving source order.
 */
export async function readableJarvisTickets(tickets: readonly InternalTicket[],
  canRead: JarvisTicketReadAccess['canRead']): Promise<InternalTicket[]> {
  const readable: InternalTicket[] = [];
  for (const ticket of tickets) if (await canRead(ticket)) readable.push(ticket);
  return readable;
}

/** @description Minimal shelf row fields needed to prevent unreadable tickets contributing results or return effects. */
export interface JarvisComplexTicketRow { kind?: string | null; ticket_id?: string | null }

/** @description Admit linked complex rows before status/metadata projection or terminal/summary writes.
 * @param ctx Ticket service. @param sub Authenticated shelf owner. @param rows Already result-scoped shelf rows.
 * @param canRead Current canonical ticket verdict.
 * @returns Admitted rows and only their readable linked tickets; plain rows remain independent of ticket availability.
 */
export async function readJarvisComplexTickets<T extends JarvisComplexTicketRow>(ctx: AppContext, sub: string,
  rows: readonly T[], canRead: JarvisTicketReadAccess['canRead']): Promise<{ rows: T[]; tickets: Map<string, InternalTicket> }> {
  if (!rows.some(row => row.kind === 'complex' && row.ticket_id)) return { rows: [...rows], tickets: new Map() };
  let candidates = new Map<string, InternalTicket>();
  try { candidates = new Map((await ctx.ticketService.listTickets({ ownerSub: sub, limit: 200 })).map(t => [t.ticketId, t])); }
  catch (err) {
    logger.error({ err }, 'Jarvis ticket candidate list failed; checking referenced records');
  }
  const admitted: T[] = [], tickets = new Map<string, InternalTicket>(), decisions = new Map<string, boolean>();
  for (const row of rows) {
    if (row.kind !== 'complex' || !row.ticket_id) { admitted.push(row); continue; }
    const id = row.ticket_id;
    if (!decisions.has(id)) {
      try {
        const ticket = candidates.get(id) ?? await ctx.ticketService.getTicket(id);
        const readable = Boolean(ticket && await canRead(ticket));
        decisions.set(id, readable);
        if (ticket && readable) tickets.set(id, ticket);
      } catch (err) {
        logger.error({ err, ticketId: id }, 'Jarvis linked ticket read failed');
        decisions.set(id, false);
      }
    }
    if (decisions.get(id)) admitted.push(row);
  }
  return { rows: admitted, tickets };
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ticket filing integrity: the three ticket fields that carry authority are checked at the door, on create AND on update. A non-operator pin (metadata.targetAgentId) skipped the call-out's ADR-087 role gate and the excluded-agent list, and dispatch sent it without the `direct` flag, so entitlement trusted it. A parentTicketId the caller cannot read was accepted (BACKLOG "POST /api/tickets accepts any parentTicketId", decided under the operator's delegation: refuse, 404). A privileged ticket type could be filed by an operator under a super-admin's owner sub, while the queue gate checked only that owner. Each rule reuses the check that already governs the same question elsewhere: decideExecuteEntitlement for a direct user call to an agent, canAccessResource for reading a ticket, isSuperAdminSub for the privileged lane.
 */

import type { Request } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { decideExecuteEntitlement } from '@/app/bot-node-execute-entitlement';
import { canAccessResource, getCaller, isOperator } from '@/shared/middleware/authz';
import { isPrivilegedTicketType, isSuperAdminSub } from '@/shared/middleware/superadmin';

/** A refusal the route sends as `res.status(status).json({ error })`; nothing is written. */
export interface TicketFilingRefusal {
  status: 403 | 404;
  error: string;
}

/** The authority-bearing fields a create or update may set. Absent means "not being set". */
export interface TicketAuthorityFields {
  ticketType?: unknown;
  parentTicketId?: unknown;
  metadata?: unknown;
}

/** The ticket's current values, on update; omitted on create. */
export interface CurrentTicketAuthority {
  ticketType?: string | null;
  parentTicketId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * @description Refuse a privileged ticket type (ADR-081) unless the FILER is a super-admin. The
 * queue gate checks the owner; checking the filer here closes the path where an operator filed
 * under a super-admin's sub, and the route keeps the filer as the owner of such a ticket.
 * @param req - The request.
 * @param ticketType - The type being set.
 * @returns A 403 refusal, or null.
 */
function refusePrivilegedType(req: Request, ticketType: unknown): TicketFilingRefusal | null {
  if (typeof ticketType !== 'string' || !isPrivilegedTicketType(ticketType)) return null;
  return isSuperAdminSub(getCaller(req).sub) ? null : { status: 403, error: 'superadmin_required' };
}

/**
 * @description Read a pinned agent id from ticket metadata.
 * @param metadata - Ticket metadata (any shape).
 * @returns The trimmed pin, or null when none is set.
 */
function pinnedAgentId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const target = (metadata as Record<string, unknown>).targetAgentId;
  return typeof target === 'string' && target.trim() ? target.trim() : null;
}

/**
 * @description Refuse a non-operator pin to an agent the caller could not call directly. The
 * pin outranks the call-out at dispatch, so it must pass the same entitlement a direct user call
 * to that agent passes (operator, an ADR-087 jarvis-accessible bot, or the assistant front door).
 * @param req - The request.
 * @param metadata - The metadata being set.
 * @returns A 403 refusal, or null.
 */
function refusePinnedAgent(req: Request, metadata: unknown): TicketFilingRefusal | null {
  const target = pinnedAgentId(metadata);
  if (!target || isOperator(req)) return null;
  const decision = decideExecuteEntitlement({ userSub: getCaller(req).sub, direct: true, targetAgentId: target });
  return decision.allowed ? null : { status: 403, error: 'target_agent_not_permitted' };
}

/**
 * @description Refuse a parent ticket the caller cannot read, with the same 404 a missing parent
 * gets, so the answer is not an existence oracle. Operators and the parent's owner pass.
 * @param ctx - Context holding the ticket service.
 * @param req - The request.
 * @param parentTicketId - The parent being set.
 * @returns A 404 refusal, or null.
 */
async function refuseUnreadableParent(
  ctx: AppContext, req: Request, parentTicketId: unknown,
): Promise<TicketFilingRefusal | null> {
  if (typeof parentTicketId !== 'string' || !parentTicketId) return null;
  const parent = await ctx.ticketService.getTicket(parentTicketId);
  const ownerSub = parent ? (parent as { ownerSub?: string | null }).ownerSub ?? null : null;
  if (!parent || !canAccessResource(req, ownerSub)) return { status: 404, error: 'Parent ticket not found' };
  return null;
}

/**
 * @description Check the authority-bearing fields of a ticket create or update. On update only
 * a field whose value CHANGES is checked, so a client echoing a ticket back is not refused for
 * a value it did not set.
 * @param ctx - Context holding the ticket service.
 * @param req - The request (its caller is the filer).
 * @param fields - The fields being set.
 * @param current - The ticket's current values on update; omit on create.
 * @returns The first refusal, or null when every field may be set.
 */
export async function refuseTicketAuthorityFields(
  ctx: AppContext, req: Request, fields: TicketAuthorityFields, current?: CurrentTicketAuthority,
): Promise<TicketFilingRefusal | null> {
  const typeChanges = fields.ticketType !== undefined && fields.ticketType !== current?.ticketType;
  const pinChanges = fields.metadata !== undefined && pinnedAgentId(fields.metadata) !== pinnedAgentId(current?.metadata);
  const parentChanges = fields.parentTicketId !== undefined && fields.parentTicketId !== (current?.parentTicketId ?? null);
  return (typeChanges ? refusePrivilegedType(req, fields.ticketType) : null)
    ?? (pinChanges ? refusePinnedAgent(req, fields.metadata) : null)
    ?? (parentChanges ? await refuseUnreadableParent(ctx, req, fields.parentTicketId) : null);
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Share current owner, issuer and protected-result checks between project discovery and ticket streams.
 */
import type { Request } from 'express';
import type { InternalTicket } from '@/entities/ticket';
import type { StoredTask } from '@/shared/types';
import { canAccessResource, isOperator } from '@/shared/middleware/authz';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { canReadProtectedResult, type ProtectedResultTask } from '@/shared/protected-results';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import type { AppContext } from '../composition-root';
import { canReadTicketApplicationResult } from './ticket-application-access';

/** @description Resolve only the verified request actor. @param ctx Runtime. @param req Request. @returns Current actor. */
async function actorFor(ctx: AppContext, req: Request) {
  const actor = ctx.applicationAuthorization
    ? await ctx.applicationAuthorization.resolveActor(req) : getApplicationAuthorizationActor();
  if (!actor) throw new Error('authorization_result_identity_required');
  return actor;
}

/** @description Keep recorded owner issuers distinct. @param ctx Runtime. @param req Request. @param row Stored owner binding. @returns Current ownership admission. */
async function ownsRow(ctx: AppContext, req: Request, row: { ownerSub?: string | null; metadata?: Record<string, unknown> | null }): Promise<boolean> {
  if (!canAccessResource(req, row.ownerSub)) return false;
  const actor = await actorFor(ctx, req);
  if (!actor.isActive) return false;
  const issuer = readOwnerPrincipalIssuer(row.metadata);
  if (!issuer || isOperator(req)) return true;
  return actor.sub === row.ownerSub && actor.issuer === issuer;
}

/** @description Admit ticket metadata only with current owner and application rights. @param ctx Runtime. @param req Request. @param ticket Stored ticket. @returns Read admission. */
export async function canReadCockpitTicket(ctx: AppContext, req: Request, ticket: InternalTicket): Promise<boolean> {
  try { return await ownsRow(ctx, req, ticket) && await canReadTicketApplicationResult(ctx, req, ticket); }
  catch { return false; }
}

/** @description Admit task metadata only with current owner and application rights. @param ctx Runtime. @param req Request. @param task Stored task. @returns Read admission. */
export async function canReadCockpitTask(ctx: AppContext, req: Request, task: StoredTask): Promise<boolean> {
  return canReadCockpitResult(ctx, req, task);
}

/** @description Constrain correlated work-item output using its canonical owner and current result lineage. @param ctx Runtime. @param req Caller. @param task Bound result source. @returns Read admission. */
export async function canReadCockpitResult(ctx: AppContext, req: Request, task: ProtectedResultTask): Promise<boolean> {
  try { return await ownsRow(ctx, req, task) && await canReadProtectedResult(task, () => actorFor(ctx, req)); }
  catch { return false; }
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The one exact-principal ownership check for a stored record, moved unchanged out of cockpit-resource-access.ts (ownsRow/actorFor) so /api/tickets and the cockpit decide ownership by the same rule: the owner sub or an operator, an ACTIVE verified actor, and, where the record names its owner's issuer, that exact issuer for a non-operator. P5 step 1.
 */
import type { Request } from 'express';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { canAccessResource, isOperator } from '@/shared/middleware/authz';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import type { AppContext } from '../composition-root';

/**
 * @description The owner binding ownsRecord checks a caller against: the record's owner sub, and the metadata
 * that may carry the owner's issuer. The issuer is written only from verified identity at creation
 * (bindOwnerPrincipalIssuer). Any stored record with these two fields (a ticket, a task, a protected-result
 * task) is checked by this one rule, which is why the shape is structural rather than a ticket type.
 */
export interface OwnedRecord {
  ownerSub?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * @description Resolve only the verified request actor, never an identity the request body names.
 * @param ctx - Runtime holding the application-authorization actor resolver.
 * @param req - The verified request.
 * @returns The current actor.
 * @throws When no verified actor is available; callers fail closed.
 */
export async function verifiedActorFor(ctx: AppContext, req: Request): Promise<AuthorizationActor> {
  const actor = ctx.applicationAuthorization
    ? await ctx.applicationAuthorization.resolveActor(req) : getApplicationAuthorizationActor();
  if (!actor) throw new Error('authorization_result_identity_required');
  return actor;
}

/**
 * @description Exact-principal ownership of a stored record. The caller must pass the owner-or-operator
 * check, resolve to an ACTIVE verified actor, and, when the record recorded its owner's issuer and the
 * caller is not an operator, be that exact principal (sub AND issuer). A record with no recorded issuer
 * (legacy or system rows) binds by sub alone.
 * @param ctx - Runtime holding the application-authorization actor resolver.
 * @param req - The verified request.
 * @param row - The record's owner binding.
 * @returns Whether the caller currently owns the record.
 * @throws When no verified actor is available; callers fail closed.
 */
export async function ownsRecord(ctx: AppContext, req: Request, row: OwnedRecord): Promise<boolean> {
  if (!canAccessResource(req, row.ownerSub)) return false;
  const actor = await verifiedActorFor(ctx, req);
  if (!actor.isActive) return false;
  const issuer = readOwnerPrincipalIssuer(row.metadata);
  if (!issuer || isOperator(req)) return true;
  return actor.sub === row.ownerSub && actor.issuer === issuer;
}

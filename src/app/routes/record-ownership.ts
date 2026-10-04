/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The one exact-principal ownership check for a stored record, moved unchanged out of cockpit-resource-access.ts (ownsRow/actorFor) so /api/tickets and the cockpit decide ownership by the same rule: the owner sub or an operator, an ACTIVE verified actor, and, where the record names its owner's issuer, that exact issuer for a non-operator. P5 step 1.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guest own-record read (coordinator option b, 2026-10-04). A signed guest session has no application actor, so the exact-principal check refused guests even their own tickets. guestOwnsRecord admits a guest only when all hold: the injector's guest marker, the canonical authenticated guest issuer, the exact owner sub, and a recorded guest issuer on the row. There is no unstamped, ownerless, operator or other-issuer access, and a spoofed marker without the guest issuer is refused. createRecordOwnership resolves the verified actor at most once per request, so a collection check does not pay a resolver lookup per row; ownsRecord keeps its single-record behavior.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Comment only: the guestOwnsRecord JSDoc no longer explains the refusal of unstamped rows by an August/12-hour provenance that did not cover every row. It states the rule (an authenticated guest, the exact owner sub, the recorded guest issuer) and that unstamped rows are refused, including demo rows seeded before the seeder recorded the issuer. No behavior change.
 */
import type { Request } from 'express';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { canAccessResource, getCaller, isOperator } from '@/shared/middleware/authz';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import { getAuthenticatedPrincipalIssuer, GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
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
 * @description Ownership checks for one request. The verified actor is resolved at most once and shared by every
 * record checked, so a collection costs one resolver lookup, not one per row.
 */
export interface RecordOwnership {
  /** Exact-principal ownership of one record (see ownsRecord). */
  owns(row: OwnedRecord): Promise<boolean>;
  /** The request's verified actor, memoized; rejects when none is available. */
  actor(): Promise<AuthorizationActor>;
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
 * @description Request-scoped exact-principal ownership. The caller must pass the owner-or-operator check (tested
 * first, so a foreign row costs no actor lookup), resolve to an ACTIVE verified actor, and, when the record
 * recorded its owner's issuer and the caller is not an operator, be that exact principal (sub AND issuer). A
 * record with no recorded issuer (legacy or system rows) binds by sub alone.
 * @param ctx - Runtime holding the application-authorization actor resolver.
 * @param req - The verified request.
 * @returns The request's ownership checks, sharing one memoized actor.
 */
export function createRecordOwnership(ctx: AppContext, req: Request): RecordOwnership {
  let pending: Promise<AuthorizationActor> | undefined;
  const actor = (): Promise<AuthorizationActor> => (pending ??= verifiedActorFor(ctx, req));
  return {
    actor,
    async owns(row: OwnedRecord): Promise<boolean> {
      if (!canAccessResource(req, row.ownerSub)) return false;
      const current = await actor();
      if (!current.isActive) return false;
      const issuer = readOwnerPrincipalIssuer(row.metadata);
      if (!issuer || isOperator(req)) return true;
      return current.sub === row.ownerSub && current.issuer === issuer;
    },
  };
}

/**
 * @description Exact-principal ownership of one stored record (see createRecordOwnership).
 * @param ctx - Runtime holding the application-authorization actor resolver.
 * @param req - The verified request.
 * @param row - The record's owner binding.
 * @returns Whether the caller currently owns the record.
 * @throws When no verified actor is available; callers fail closed.
 */
export async function ownsRecord(ctx: AppContext, req: Request, row: OwnedRecord): Promise<boolean> {
  return createRecordOwnership(ctx, req).owns(row);
}

/**
 * @description A signed guest session: the guest injector's marker AND the canonical authenticated guest issuer.
 * The marker alone is not trusted; a session that claims it without the guest issuer is not a guest.
 * @param req - The request.
 * @returns Whether the request is an authenticated guest.
 */
export function isAuthenticatedGuest(req: Request): boolean {
  return isGuestRequest(req) && getAuthenticatedPrincipalIssuer(req) === GUEST_PRINCIPAL_ISSUER;
}

/**
 * @description Guest own-record read. A guest has no application actor, so ownership is decided from the signed
 * session itself. The caller must be an authenticated guest and the exact owner sub, and the row must have recorded
 * the guest issuer (`urn:oshal:guest`) as its owner issuer. Unstamped rows are refused, whoever their owner sub
 * names, including demo rows the guest demo seeder inserted before it recorded the issuer.
 * @param req - The request.
 * @param row - The record's owner binding.
 * @returns Whether the guest owns the record.
 */
export function guestOwnsRecord(req: Request, row: OwnedRecord): boolean {
  const sub = getCaller(req).sub;
  return isAuthenticatedGuest(req) && Boolean(sub) && row.ownerSub === sub
    && readOwnerPrincipalIssuer(row.metadata) === GUEST_PRINCIPAL_ISSUER;
}

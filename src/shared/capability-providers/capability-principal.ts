/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D8: every capability call carries the principal it is made for. Constructors for the three kinds (a signed-in person, the system, a legacy caller that named no one), the runtime check the resolver applies before it reads any rung, and the mapping from the request identity a route already established. A legacy caller is never silently promoted: it resolves the operator-written rungs only, exactly as the system does, and its reason is logged so slice S4 can move it.
 */

/**
 * @description Principals for capability resolution (ADR-173 D8).
 * @module shared/capability-providers/capability-principal
 */

import { GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { getRequestIdentity, isSystemIdentity } from '@/shared/services/database/request-identity';
import type { CapabilityPrincipal } from './capability-types';

/** What a route knows about its caller. */
export interface CapabilityUserFacts {
  sub: string;
  isOperator: boolean;
  isGuest?: boolean;
}

/**
 * @description The principal of a signed-in caller (a guest included).
 * @param facts - The caller's subject and the operator/guest facts the route already decided.
 * @returns A user principal.
 * @throws Error when the subject is blank: a person without a subject is not a principal.
 */
export function userCapabilityPrincipal(facts: CapabilityUserFacts): CapabilityPrincipal {
  const sub = typeof facts.sub === 'string' ? facts.sub.trim() : '';
  if (!sub) throw new Error('a user capability principal needs a subject');
  return { kind: 'user', sub, isOperator: facts.isOperator === true, isGuest: facts.isGuest === true };
}

/**
 * @description The principal of scheduled or swarm-owned work: it resolves operator-written rungs only.
 * @param reason - Which work this is, for the resolution log line.
 * @returns A system principal.
 */
export function systemCapabilityPrincipal(reason: string): CapabilityPrincipal {
  return { kind: 'system', reason: String(reason || 'system work') };
}

/**
 * @description The principal of a legacy caller that named no one (store code not yet moved by S4).
 * It resolves exactly like the system and is logged with its reason.
 * @param reason - Which entry point the call came through.
 * @returns An unattributed principal.
 */
export function unattributedCapabilityPrincipal(reason: string): CapabilityPrincipal {
  return { kind: 'unattributed', reason: String(reason || 'caller named no principal') };
}

/**
 * @description The runtime half of the D8 guard: is this a principal the resolver may act for?
 * TypeScript already requires the key; this catches JavaScript callers and casts.
 * @param value - Whatever the caller passed.
 * @returns True for a well-formed principal of one of the three kinds.
 */
export function isCapabilityPrincipal(value: unknown): value is CapabilityPrincipal {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { kind?: unknown; sub?: unknown; reason?: unknown };
  if (candidate.kind === 'user') return typeof candidate.sub === 'string' && candidate.sub.trim().length > 0;
  if (candidate.kind === 'system' || candidate.kind === 'unattributed') return typeof candidate.reason === 'string';
  return false;
}

/**
 * @description The principal for a route caller: the signed-in person when the route resolved a
 * subject, otherwise an unattributed principal naming the route.
 * @param sub - The caller's subject, or null when the route has none.
 * @param facts - The operator and guest facts for that subject.
 * @param route - The route, for the unattributed reason.
 * @returns The principal.
 */
export function routeCapabilityPrincipal(
  sub: string | null,
  facts: { isOperator: boolean; isGuest: boolean },
  route: string,
): CapabilityPrincipal {
  if (sub && sub.trim()) return userCapabilityPrincipal({ sub, isOperator: facts.isOperator, isGuest: facts.isGuest });
  return unattributedCapabilityPrincipal(`${route} has no caller subject`);
}

/**
 * @description The principal of the request identity the server already established for this
 * async context (the same identity row-level security scopes by): the system sentinel is the
 * system, a subject is that person (a guest when its issuer is the guest issuer), and no identity
 * at all is unattributed. For a call site that runs inside a request but is handed no request
 * object, such as a transcriber an orchestrator calls.
 * @param reason - The call site, for the log line.
 * @returns The principal.
 */
export function requestIdentityCapabilityPrincipal(reason: string): CapabilityPrincipal {
  const identity = getRequestIdentity();
  if (isSystemIdentity(identity)) return systemCapabilityPrincipal(reason);
  if (identity?.sub) {
    return userCapabilityPrincipal({ sub: identity.sub, isOperator: identity.isOperator,
      isGuest: identity.principalIssuer === GUEST_PRINCIPAL_ISSUER });
  }
  return unattributedCapabilityPrincipal(`${reason}: no request identity in scope`);
}

/**
 * @description A short, log-safe description of a principal: its kind and, for a person, the
 * subject the existing voice routes already log.
 * @param principal - The principal.
 * @returns A record for a structured log line.
 */
export function describeCapabilityPrincipal(principal: CapabilityPrincipal): Record<string, unknown> {
  if (principal.kind === 'user') {
    return { principalKind: 'user', sub: principal.sub, isOperator: principal.isOperator, isGuest: principal.isGuest };
  }
  return { principalKind: principal.kind, principalReason: principal.reason };
}

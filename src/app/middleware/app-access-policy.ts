/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: shared request-subject, rollout-mode, and method/tier policy for both dynamic package routes and hard-mounted kernel routes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Resolve issuer from the same verified identity rail as subject; never accept caller-supplied issuer hints or infer local provenance.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Document why a carried trusted-service subject resolves to a null issuer on purpose: the fleet secret carries a subject string and no identity provider, so the gate and mounter refuse it (app_access_identity_required) instead of inferring local-auth or reading every issuer. Second review of PR 605.
 */

import type { Request } from 'express';
import type { ResolvedAppAccess } from '@/features/swarm-apps';
import { getCaller, getTrustedServiceUserSub } from '@/shared/middleware/authz';
import { getRequestIdentity } from '@/shared/services/database/request-identity';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';

export type AppAccessEnforcementMode = 'shadow' | 'enforce';

/** Unknown rollout values fail closed to enforcement; compatibility requires naming shadow. */
export function appAccessEnforcementMode(env: NodeJS.ProcessEnv = process.env): AppAccessEnforcementMode {
  return (env.OSHAL_APP_ACCESS_MODE ?? 'enforce').trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'enforce';
}

/**
 * Resolve only identities established by framework authentication/delegation middleware.
 * Body/query values never participate. Null means truly anonymous; ADR-118's defaultTier is for
 * signed-in users, while anonymous access remains governed by the guest capability matrix.
 */
export function appAccessCallerSub(req: Request): string | null {
  const scoped = getRequestIdentity()?.sub;
  if (scoped) return scoped; // includes verified durable workload delegation
  const oidc = getCaller(req).sub;
  if (oidc) return oidc;
  const carried = (req as Request & { oshalCallerSub?: string }).oshalCallerSub;
  return carried ?? getTrustedServiceUserSub(req);
}

/**
 * @description Resolve the issuer for the same principal selected by appAccessCallerSub. Null is
 * deliberate for a subject that arrived without a verified issuer - a fleet service-secret call
 * carrying only `X-Oshal-User-Sub-B64`, or an older derived credential - and both enforcement
 * paths refuse such a request (`app_access_identity_required`) rather than inferring local-auth
 * or reading the subject across every issuer: the secret is held by injectable bot processes, and
 * a subject string alone cannot name a principal. Issuer-bearing automation rides the
 * workload-delegation rail, whose verified `principal_iss` is stamped on the request identity.
 * @param req - Express request after authentication and identity middleware.
 * @returns The verified issuer for the selected subject, or null when none was established.
 */
export function appAccessCallerIssuer(req: Request): string | null {
  const scoped = getRequestIdentity();
  if (scoped?.sub) return scoped.principalIssuer || null;
  return getCaller(req).sub ? getAuthenticatedPrincipalIssuer(req) : null;
}

/** @description Return the stable denial code for a resolved tier/method, or null when admitted. */
export function appAccessDenial(
  method: string,
  decision: ResolvedAppAccess,
): 'app_access_denied' | 'app_readonly' | null {
  if (decision.tier === 'deny') return 'app_access_denied';
  if (decision.tier !== 'viewer') return null;
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? null : 'app_readonly';
}

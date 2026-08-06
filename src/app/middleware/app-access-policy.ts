/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: shared request-subject, rollout-mode, and method/tier policy for both dynamic package routes and hard-mounted kernel routes.
 */

import type { Request } from 'express';
import type { ResolvedAppAccess } from '@/features/swarm-apps';
import { getCaller, getTrustedServiceUserSub } from '@/shared/middleware/authz';
import { getRequestIdentity } from '@/shared/services/database/request-identity';

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

/** @description Return the stable denial code for a resolved tier/method, or null when admitted. */
export function appAccessDenial(
  method: string,
  decision: ResolvedAppAccess,
): 'app_access_denied' | 'app_readonly' | null {
  if (decision.tier === 'deny') return 'app_access_denied';
  if (decision.tier !== 'viewer') return null;
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? null : 'app_readonly';
}

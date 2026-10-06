/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 S02: the swarm admin's identity moves here from swarm-admin-scope.ts, unchanged: SWARM_ADMIN_SUB and isSwarmAdminPrincipal. This module is a leaf: besides the express Request type it imports only ./principal-issuer, so authz.ts and deployment-mode.ts can ask "is this the swarm admin?" without an import cycle (swarm-admin-scope.ts imports authz.ts). swarm-admin-scope.ts re-exports both names, so existing imports keep working.
 */

import type { Request } from 'express';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from './principal-issuer';

/** The swarm admin's subject: localSubForEmail('admin'), the reserved login's deterministic local sub. */
export const SWARM_ADMIN_SUB = 'local-8c6976e5b5410415';

/**
 * @description True when the request's signed-in principal is the configuration-only swarm admin
 * (ADR-174 D1). The admin-only sign-in stamps the `swarm-admin` account kind; a local session for
 * the reserved login's subject counts too, so the admin is recognised whichever local rail signed it in.
 *
 * @param req - Express request after identity resolution.
 * @returns True for the swarm admin, false for everyone else and for anonymous requests.
 */
export function isSwarmAdminPrincipal(req: Request): boolean {
  const oidc = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { iss?: string; sub?: string; oshal_account_kind?: string } } }).oidc;
  if (!oidc?.isAuthenticated?.()) return false;
  const user = oidc.user ?? {};
  return user.oshal_account_kind === 'swarm-admin' || (user.iss === LOCAL_AUTH_PRINCIPAL_ISSUER && user.sub === SWARM_ADMIN_SUB);
}

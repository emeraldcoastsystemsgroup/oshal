/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Centralize verified principal issuer constants and extraction so non-OIDC session rails preserve the identity namespace that authenticated the user
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | Read verified protocol claims before the filtered OIDC presentation user; a present invalid protocol issuer fails closed.
 * -----------------------------------------------------------------------------
 */

import type { Request } from 'express';

/** Stable issuer namespaces for kernel-authenticated identities that do not come from an IdP. */
export const LOCAL_AUTH_PRINCIPAL_ISSUER = 'urn:oshal:local-auth';
export const MOCK_OIDC_PRINCIPAL_ISSUER = 'urn:oshal:mock-oidc';
export const GUEST_PRINCIPAL_ISSUER = 'urn:oshal:guest';

/**
 * @description THE predicate for "is this deployment running mock OIDC". One reading, so the
 * auth bypass and everything that reasons about it can never disagree.
 *
 * It lives beside {@link MOCK_OIDC_PRINCIPAL_ISSUER} rather than in the OIDC middleware because
 * that module pulls `express-openid-connect`, and a ticket store has no business importing the
 * auth stack to answer a question about an environment variable — which is precisely why two
 * copies of this function grew there.
 *
 * Accepted spellings are deliberately broader than `=== 'true'`: an operator who writes
 * `MOCK_OIDC=1` gets the auth bypass, so every site that reasons about mock mode must agree with
 * the bypass or the deployment ends up half in demo mode and half out of it.
 * @param env - Environment to read; injectable so a guard can state the case exactly.
 * @returns True when mock OIDC is on.
 */
export function isMockOidcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.MOCK_OIDC ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

const MAX_ISSUER_LENGTH = 2048;

type OidcRequestShape = {
  oidc?: {
    isAuthenticated?: () => boolean;
    user?: { iss?: unknown };
    idTokenClaims?: { iss?: unknown };
  };
};

/**
 * @description Normalizes an issuer already established by a trusted authentication rail.
 * This helper never invents a fallback: absence stays absence so legacy bearer credentials
 * cannot be silently rebound into the deployment's current identity-provider namespace.
 *
 * @param value - Candidate issuer claim from a verified session or signed credential.
 * @returns A bounded non-empty issuer, otherwise null.
 */
export function normalizePrincipalIssuer(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const issuer = value.trim();
  return issuer.length > 0 && issuer.length <= MAX_ISSUER_LENGTH ? issuer : null;
}

/**
 * @description Reads the principal issuer from an authenticated request. `req.oidc` is populated
 * only by the kernel's verified OIDC/local/PAT/TV/guest middleware; callers must not use a body,
 * query parameter, or header as an issuer substitute. Returning null is deliberate fail-closed
 * behavior for an older derived credential that predates issuer provenance.
 *
 * @param req - Express request after authentication middleware.
 * @returns The verified issuer namespace, or null when unavailable/unauthenticated.
 */
export function getAuthenticatedPrincipalIssuer(req: Request): string | null {
  const oidc = (req as Request & OidcRequestShape).oidc;
  if (!oidc?.isAuthenticated?.()) return null;
  if (oidc.idTokenClaims !== undefined) return normalizePrincipalIssuer(oidc.idTokenClaims?.iss);
  return normalizePrincipalIssuer(oidc.user?.iss);
}

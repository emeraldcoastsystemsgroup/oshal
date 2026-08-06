/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Centralize verified principal issuer constants and extraction so non-OIDC session rails preserve the identity namespace that authenticated the user
 * -----------------------------------------------------------------------------
 */

import type { Request } from 'express';

/** Stable issuer namespaces for kernel-authenticated identities that do not come from an IdP. */
export const LOCAL_AUTH_PRINCIPAL_ISSUER = 'urn:oshal:local-auth';
export const MOCK_OIDC_PRINCIPAL_ISSUER = 'urn:oshal:mock-oidc';
export const GUEST_PRINCIPAL_ISSUER = 'urn:oshal:guest';

const MAX_ISSUER_LENGTH = 2048;

type OidcRequestShape = {
  oidc?: {
    isAuthenticated?: () => boolean;
    user?: { iss?: unknown };
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
  return normalizePrincipalIssuer(oidc.user?.iss);
}

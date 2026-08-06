/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added a reserved ticket-metadata carrier that persists verified owner issuer provenance and strips caller-spoofed values before later bot delegation.
 */

import { normalizePrincipalIssuer } from '@/shared/middleware/principal-issuer';
import {
  getRequestIdentity,
  isSystemIdentity,
} from '@/shared/services/database/request-identity';

/** Reserved metadata field written only from verified request identity or trusted system replay. */
export const OWNER_PRINCIPAL_ISSUER_METADATA_KEY = 'oshalOwnerPrincipalIssuer';

/**
 * @description Stamps owner issuer provenance at ticket creation. Interactive callers cannot
 * supply or replace the reserved value: their verified AsyncLocalStorage identity is authoritative.
 * Trusted system work may preserve a previously verified value while deriving child tickets.
 * @param metadata - Candidate ticket metadata, including any untrusted request-body fields.
 * @param ownerSub - Ticket owner selected by the route/service.
 * @returns A defensive metadata copy with a trusted issuer or no reserved field.
 */
export function bindOwnerPrincipalIssuer(
  metadata: Record<string, unknown>,
  ownerSub: string | null | undefined,
): Record<string, unknown> {
  const next = { ...metadata };
  const supplied = normalizePrincipalIssuer(next[OWNER_PRINCIPAL_ISSUER_METADATA_KEY]);
  delete next[OWNER_PRINCIPAL_ISSUER_METADATA_KEY];
  if (!ownerSub) return next;
  const identity = getRequestIdentity();
  const requestIssuer = identity?.sub === ownerSub
    ? normalizePrincipalIssuer(identity.principalIssuer)
    : null;
  const trustedIssuer = requestIssuer ?? (isSystemIdentity(identity) ? supplied : null);
  if (trustedIssuer) next[OWNER_PRINCIPAL_ISSUER_METADATA_KEY] = trustedIssuer;
  return next;
}

/**
 * @description Reads a bounded issuer previously stamped into trusted ticket metadata.
 * @param metadata - Persisted ticket metadata.
 * @returns The verified issuer string, or null for legacy/system tickets without provenance.
 */
export function readOwnerPrincipalIssuer(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  return normalizePrincipalIssuer(metadata?.[OWNER_PRINCIPAL_ISSUER_METADATA_KEY]);
}

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Validate closed membership inputs and actor-owned preview freshness.
 */
import { z } from 'zod';
import { GUEST_PRINCIPAL_ISSUER, LOCAL_AUTH_PRINCIPAL_ISSUER, MOCK_OIDC_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { ExternalTenantMembershipError, type StoredMembershipPreview } from './types';

const identity = z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 512 && !/[\u0000-\u001f\u007f]/.test(value));
/** @description Keep kernel identities on their existing tenancy path. @param issuer Exact namespace. @returns Whether native-external membership is eligible. */
export function isExternalMembershipIssuer(issuer: string): boolean {
  return ![LOCAL_AUTH_PRINCIPAL_ISSUER, MOCK_OIDC_PRINCIPAL_ISSUER, GUEST_PRINCIPAL_ISSUER].includes(issuer)
    && !issuer.startsWith('urn:oshal:');
}
/** @description Closed change schema; unknown authority-bearing fields are refused rather than stripped. */
export const ExternalTenantMembershipChangeSchema = z.object({
  action: z.enum(['grant', 'revoke']), targetSub: identity,
  targetIssuer: identity.refine(isExternalMembershipIssuer), tenantId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000), expectedRevision: z.number().int().nonnegative().safe(),
}).strict();
/** @description Closed apply schema with an opaque preview and bounded idempotency key. */
export const ExternalTenantMembershipApplySchema = z.object({
  previewId: z.string().uuid(), idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
}).strict();

/** @description Protect preview provenance before replay or state disclosure.
 * @param preview Stored preview. @param actor Current exact actor. @returns The preview after ownership verification.
 */
export function requireMembershipPreview(preview: StoredMembershipPreview | null,
  actor: Pick<AuthorizationActor, 'sub' | 'issuer'>): StoredMembershipPreview {
  if (!preview || preview.actor.sub !== actor.sub || preview.actor.issuer !== actor.issuer) {
    throw new ExternalTenantMembershipError(404, 'tenant_membership_preview_not_found');
  }
  return preview;
}
/** @description Refuse expired or stale reviews under the shared writer lock.
 * @param preview Owned preview. @param revision Locked revision. @param now Current clock. @returns Nothing when current.
 */
export function requireMembershipFreshness(preview: StoredMembershipPreview, revision: number, now: number): void {
  if (Date.parse(preview.expiresAt) <= now) throw new ExternalTenantMembershipError(409, 'tenant_membership_preview_expired');
  if (preview.revision !== revision) throw new ExternalTenantMembershipError(409, 'tenant_membership_revision_changed');
}

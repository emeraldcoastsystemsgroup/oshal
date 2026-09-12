/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Define exact external business membership and current-administrator change contracts.
 */
import type { AuthorizationActor } from '@/shared/application-authorization';

/** @description One explicit business membership; provider directory tenant claims are unrelated. */
export interface ExternalTenantMembership { targetSub: string; targetIssuer: string; tenantId: string }
/** @description Fixed reviewed membership operation; no role, application, or authority payload is accepted. */
export interface ExternalTenantMembershipChange extends ExternalTenantMembership {
  action: 'grant' | 'revoke'; reason: string; expectedRevision: number;
}
/** @description Actor-owned, short-lived preview at the shared authorization revision. */
export interface ExternalTenantMembershipPreview {
  previewId: string; revision: number; expiresAt: string; change: ExternalTenantMembershipChange;
}
/** @description Durable receipt for exactly one applied membership change. */
export interface ExternalTenantMembershipReceipt { applied: true; revision: number; auditId: string }
/** @description Retrying the same preview and key returns its original receipt after current authority checks. */
export interface ExternalTenantMembershipApply { previewId: string; idempotencyKey: string }
/** @description Internal persisted preview provenance; request bodies cannot populate these fields. */
export interface StoredMembershipPreview extends ExternalTenantMembershipPreview {
  actor: Pick<AuthorizationActor, 'sub' | 'issuer'>; receipt?: ExternalTenantMembershipReceipt; idempotencyKey?: string;
}
/** @description Administrative inventory of existing business tenants and explicit native-external memberships. */
export interface ExternalTenantMembershipCatalog {
  revision: number; tenants: Array<{ tenantId: string; name: string | null }>; memberships: ExternalTenantMembership[];
}
/** @description Durable fixed-operation port; implementation shares the authorization writer lock and audit log. */
export interface ExternalTenantMembershipStore {
  catalog(): Promise<ExternalTenantMembershipCatalog>;
  tenantIds(sub: string, issuer: string): Promise<string[]>;
  readPreview(id: string): Promise<StoredMembershipPreview | null>;
  savePreview(preview: StoredMembershipPreview, now: () => number): Promise<void>;
  apply(actor: Pick<AuthorizationActor, 'sub' | 'issuer'>, input: ExternalTenantMembershipApply, now: () => number): Promise<ExternalTenantMembershipReceipt>;
}
/** @description Composition supplies current authenticated actors and exact existing account resolution. */
export interface ExternalTenantMembershipOptions {
  refreshActor(actor: AuthorizationActor): Promise<AuthorizationActor | null>;
  resolveTarget(sub: string, issuer: string): Promise<AuthorizationActor | null>;
  now?: () => number;
}
/** @description Expected refusal safe for the fixed HTTP adapter; internal errors remain private. */
export class ExternalTenantMembershipError extends Error {
  /** @description Carry only the safe refusal contract. @param status HTTP status. @param code Stable client-facing refusal code. */
  constructor(public readonly status: number, public readonly code: string) {
    super(code); this.name = 'ExternalTenantMembershipError';
  }
}

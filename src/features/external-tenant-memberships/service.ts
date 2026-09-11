/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Administer exact native-external business memberships without inferring provider tenant authority.
 */
import { randomUUID } from 'node:crypto';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { ExternalTenantMembershipError, type ExternalTenantMembershipApply, type ExternalTenantMembershipChange,
  type ExternalTenantMembershipOptions, type ExternalTenantMembershipStore, type StoredMembershipPreview } from './types';
import { ExternalTenantMembershipApplySchema, ExternalTenantMembershipChangeSchema, isExternalMembershipIssuer, requireMembershipPreview } from './validation';

/** @description One fixed membership authority; application management roles never satisfy its platform-admin requirement. */
export class ExternalTenantMembershipService {
  private readonly now: () => number;
  /** @description Compose current identity ports with durable facts. @param store Exact membership repository. @param options Trusted identity refresh and account lookup. */
  constructor(private readonly store: ExternalTenantMembershipStore, private readonly options: ExternalTenantMembershipOptions) {
    this.now = options.now ?? Date.now;
  }
  /** @description Read business tenants without granting business-data access. @param actor Verified administrator. @returns Current administrative inventory. */
  async catalog(actor: AuthorizationActor) {
    await this.currentAdmin(actor, false); return this.store.catalog();
  }
  /** @description Supply fresh membership to trusted actor composition without business grants.
   * @param sub Exact verified subject. @param issuer Exact verified namespace. @returns Explicit current business tenant IDs.
   */
  async tenantIds(sub: string, issuer: string): Promise<string[]> {
    if (!isExternalMembershipIssuer(issuer)) return [];
    return this.store.tenantIds(sub, issuer);
  }
  /** @description Bind a reviewed change to its administrator and shared policy revision.
   * @param actor Verified administrator. @param raw Untrusted closed change. @returns Short-lived public preview.
   */
  async preview(actor: AuthorizationActor, raw: ExternalTenantMembershipChange) {
    const change = ExternalTenantMembershipChangeSchema.parse(raw);
    const current = await this.currentAdmin(actor, true); await this.requireTarget(change);
    const preview: StoredMembershipPreview = { previewId: randomUUID(), actor: { sub: current.sub, issuer: current.issuer },
      revision: change.expectedRevision, expiresAt: new Date(this.now() + 300_000).toISOString(), change };
    await this.store.savePreview(preview, this.now);
    return { previewId: preview.previewId, revision: preview.revision, expiresAt: preview.expiresAt, change: preview.change };
  }
  /** @description Refresh accounts before the writer, then atomically recheck review and tenant state.
   * @param actor Verified administrator. @param raw Untrusted preview reference. @returns Durable idempotent receipt.
   */
  async apply(actor: AuthorizationActor, raw: ExternalTenantMembershipApply) {
    const input = ExternalTenantMembershipApplySchema.parse(raw);
    let current = await this.currentAdmin(actor, true);
    const preview = requireMembershipPreview(await this.store.readPreview(input.previewId), current);
    if (!preview.receipt) await this.requireTarget(preview.change);
    current = await this.currentAdmin(actor, true);
    return this.store.apply(current, input, this.now);
  }
  private async currentAdmin(actor: AuthorizationActor, write: boolean): Promise<AuthorizationActor> {
    if (!actor?.isActive || !actor.sub || !actor.issuer) throw new ExternalTenantMembershipError(401, 'authorization_identity_required');
    const current = await this.options.refreshActor(actor);
    if (!current?.isActive || current.sub !== actor.sub || current.issuer !== actor.issuer) {
      throw new ExternalTenantMembershipError(401, 'authorization_identity_required');
    }
    const permissions = write ? ['assign', 'directory'] : ['read'];
    const permitted = [actor, current].every(identity => identity.isSwarmAdmin && permissions.every(permission =>
      !identity.allowedPermissions || identity.allowedPermissions.includes(`platform:authorization.${permission}`)));
    if (!permitted) throw new ExternalTenantMembershipError(403, 'tenant_membership_admin_required');
    return current;
  }
  private async requireTarget(change: ExternalTenantMembershipChange): Promise<void> {
    // Revocation must remain possible after the target is disabled or its provider is removed.
    if (change.action === 'revoke') return;
    const target = await this.options.resolveTarget(change.targetSub, change.targetIssuer);
    if (!target?.isActive || target.sub !== change.targetSub || target.issuer !== change.targetIssuer) {
      throw new ExternalTenantMembershipError(400, 'tenant_membership_active_external_identity_required');
    }
  }
}

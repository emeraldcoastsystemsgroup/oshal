/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
/** ADR-149 authoritative management and execution service. No swarm-admin business bypass. */
import { randomUUID } from 'node:crypto';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import {
  validateAuthorizationCatalog,
  type ApplicationAuthorizationManagementService, type AuthorizationActor, type AuthorizationAppRegistration,
  type AuthorizationAppSummary, type AuthorizationApplyInput, type AuthorizationCatalogResult,
  type AuthorizationChange, type AuthorizationDecision, type AuthorizationEffective, type AuthorizationInventory,
  type AuthorizationOperation, type AuthorizationPreview, type AuthorizationReceipt, type AuthorizationTarget,
  type AuthorizationTier,
  type AuthorizationResourceAdapter,
} from '@/shared/application-authorization';
import type { AuthorizationAssignment, AuthorizationState, AuthorizationStore, StoredAuthorizationPreview } from './types';
import { ApplicationAuthorizationError } from './types';
import { APP_ADMIN_ROLE, TIER_ORDER, assertActor, catalogRevision, managementAllowed, matchingAssignments,
  requireManagement, resolveGrantSet, resolveOperationPermissions, type RegisteredAuthorizationApp } from './policy';
import { parseAuthorizationApply, parseAuthorizationChange } from './change-validation';

export interface ApplicationAuthorizationServiceOptions {
  now?: () => number;
  resolveActor?: (sub: string, issuer: string) => Promise<AuthorizationActor | null>;
  /** Revalidate a previously authenticated caller against current account and management state. */
  refreshActor?: (actor: AuthorizationActor) => Promise<AuthorizationActor | null>;
  resolveTier?: (app: string, actor: AuthorizationActor) => Promise<{ tier: AuthorizationTier; explicit: boolean }>;
  verifyApproval?: (actor: AuthorizationActor, preview: AuthorizationPreview, reference: string) => Promise<boolean>;
  /** Provider must scope directory inventory to actor.managementScopes; this is not a business-data read. */
  inventory?: (actor: AuthorizationActor) => Promise<AuthorizationInventory>;
}
export class ApplicationAuthorizationService implements ApplicationAuthorizationManagementService {
  private readonly apps = new Map<string, RegisteredAuthorizationApp>();
  private readonly now: () => number;
  constructor(private readonly store: AuthorizationStore, private readonly options: ApplicationAuthorizationServiceOptions = {}) {
    this.now = options.now ?? Date.now;
  }
  /** Changed grant meanings require explicit migration; stale assigned catalogs cannot silently activate. */
  async registerApp(input: AuthorizationAppRegistration): Promise<void> {
    await this.validateRegistration(input);
    const catalog = input.catalog === null ? null : validateAuthorizationCatalog(input.catalog);
    await this.store.publishAppPosture(input.app, Boolean(catalog) || input.mode === 'enforce', input.agentIds ?? [], input.toolNames ?? []);
    this.apps.set(input.app, { ...input, access: input.access ? structuredClone(input.access) : undefined,
      mountPaths: [...(input.mountPaths ?? [])], adapters: { ...input.adapters }, catalog,
      mode: catalog ? 'enforce' : input.mode, catalogRevision: catalogRevision({ ...input, catalog }) });
  }
  async validateRegistration(input: AuthorizationAppRegistration): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.app) || !input.source || !input.version || !['legacy','enforce'].includes(input.mode)) throw new ApplicationAuthorizationError(400, 'invalid_authorization_registration');
    const catalog = input.catalog === null ? null : validateAuthorizationCatalog(input.catalog);
    const app = { ...input, catalog, mode: catalog ? 'enforce' as const : input.mode, catalogRevision: catalogRevision({ ...input, catalog }) };
    const state = await this.store.read();
    if (state.assignments.some(row => row.app === input.app && (row.source !== input.source || row.catalogRevision !== app.catalogRevision))) {
      throw new ApplicationAuthorizationError(409, 'authorization_catalog_migration_required');
    }
  }
  registerResourceAdapter(appName: string, resource: string, adapter: AuthorizationResourceAdapter): void {
    const app = this.requireApp(appName);
    if (!app.catalog || !Object.prototype.hasOwnProperty.call(app.catalog.resources, resource) || typeof adapter?.authorize !== 'function') throw new ApplicationAuthorizationError(400, 'invalid_authorization_resource_adapter');
    app.adapters = { ...app.adapters, [resource]: adapter };
  }
  unregisterApp(app: string): void { this.apps.delete(app); }
  getApp(app: string): AuthorizationAppSummary | null { const registration = this.apps.get(app); return registration ? this.summary(registration) : null; }
  async catalog(actor: AuthorizationActor): Promise<AuthorizationCatalogResult> {
    actor = await this.currentActor(actor);
    if (actor.allowedPermissions && !actor.allowedPermissions.includes('platform:authorization.read')) throw new ApplicationAuthorizationError(403, 'authorization_management_denied');
    const available = [...this.apps.values()].filter(app => actor.isSwarmAdmin || actor.managementScopes?.some(scope => scope.app === app.app && scope.permissions.includes('read')));
    if (!available.length && !actor.isSwarmAdmin) throw new ApplicationAuthorizationError(403, 'authorization_management_denied');
    const state = await this.store.read(); const visible = new Set(available.map(app => app.app));
    const assignments = state.assignments.filter(row => visible.has(row.app) && managementAllowed(actor, row.app, row.tenantId, 'read'));
    const inventory = this.options.inventory ? await this.options.inventory(actor) : { users: [], groups: [] };
    const users = new Map(inventory.users.map(user => [`${user.issuer}\0${user.sub}`, user]));
    const groups = new Map(inventory.groups.map(group => [`${group.issuer}\0${group.tenantId}\0${group.id}`, group]));
    for (const row of assignments) {
      if (row.targetSub && row.targetIssuer) users.set(`${row.targetIssuer}\0${row.targetSub}`, users.get(`${row.targetIssuer}\0${row.targetSub}`) ?? { sub: row.targetSub, issuer: row.targetIssuer, label: row.targetSub });
      if (row.group) groups.set(`${row.group.issuer}\0${row.group.tenantId}\0${row.group.id}`, { ...row.group, label: row.group.id });
    }
    return { revision: state.revision, apps: available.map(app => ({ ...this.summary(app), managementScopes: (actor.isSwarmAdmin
      ? [{ app: app.app, permissions: ['read','assign','directory'] as Array<'read' | 'assign' | 'directory'> }] : actor.managementScopes?.filter(scope => scope.app === app.app) ?? [])
      .map(scope => ({ ...scope, permissions: scope.permissions.filter(permission => !actor.allowedPermissions || actor.allowedPermissions.includes(`platform:authorization.${permission}`)) })) })),
    users: [...users.values()], groups: [...groups.values()], assignments };
  }
  async ownCatalog(actor: AuthorizationActor): Promise<AuthorizationCatalogResult> {
    actor = await this.currentActor(actor); const apps: AuthorizationAppSummary[] = [];
    for (const app of this.apps.values()) {
      const tenants = [undefined, ...(actor.tenantIds ?? [])]; let visible = false;
      for (const tenantId of tenants) {
        const access = await this.effective(actor, { app: app.app, tenantId });
        if (!access.denied && access.tier !== 'deny') { visible = true; break; }
      }
      if (visible) apps.push({ ...this.summary(app), catalog: null, managementScopes: [] });
    }
    return { revision: (await this.store.read()).revision, apps, users: [], groups: [], assignments: [] };
  }
  async effective(actor: AuthorizationActor, target: AuthorizationTarget): Promise<AuthorizationEffective> {
    actor = await this.currentActor(actor); const app = this.requireApp(target.app); const subject = await this.targetActor(actor, target);
    const state = await this.store.read(); const resolution = matchingAssignments(state, app, subject, target.tenantId, this.now());
    const tier = await this.explicitTier(app.app, subject); const grants = resolveGrantSet(app, resolution.rows, tier);
    const denied = grants.denied || !subject.isActive || resolution.stale || resolution.unknownDirectory
      || Boolean(target.tenantId && !subject.tenantIds?.includes(target.tenantId));
    return { app: app.app, targetSub: subject.sub, targetIssuer: subject.issuer, tenantId: target.tenantId,
      revision: state.revision, catalogRevision: app.catalogRevision, tier: denied ? 'deny' : grants.tier,
      roles: grants.roles, denied, permissions: denied ? [] : structuredClone(grants.grants), status: this.summary(app).status };
  }
  async explain(actor: AuthorizationActor, input: AuthorizationOperation & { targetSub?: string; targetIssuer?: string }): Promise<AuthorizationDecision> {
    actor = await this.currentActor(actor); const target = await this.targetActor(actor, input);
    return this.authorize(target, input);
  }
  /** Call again at execution, retries and result retrieval; a discovery decision is not a capability. */
  async authorize(actor: AuthorizationActor, operation: AuthorizationOperation): Promise<AuthorizationDecision> {
    const state = await this.store.read(); const app = this.apps.get(operation.app);
    const deny = (reason: string, tier?: AuthorizationTier): AuthorizationDecision => ({ allowed: false, reason, decisionId: randomUUID(), revision: state.revision, app: operation.app, catalogRevision: app?.catalogRevision, tier, grants: [] });
    try { actor = await this.currentActor(actor); } catch { return deny('authorization_identity_required'); }
    if (!app) return deny('authorization_app_unavailable');
    if (operation.tenantId && !actor.tenantIds?.includes(operation.tenantId)) return deny('authorization_tenant_denied');
    const explicitTier = await this.explicitTier(app.app, actor);
    const resolved = matchingAssignments(state, app, actor, operation.tenantId, this.now());
    if (resolved.unknownDirectory) return deny('authorization_directory_unavailable');
    if (resolved.stale) return deny('authorization_assignment_stale');
    const grantSet = resolveGrantSet(app, resolved.rows, explicitTier);
    if (grantSet.denied) return deny('authorization_explicit_deny', 'deny');
    if (app.mode === 'legacy' && !app.catalog) return { ...deny('authorization_legacy'), allowed: true };
    if (!app.catalog) {
      if (actor.allowedPermissions && !actor.allowedPermissions.includes(`${app.app}:@app-admin`)) return deny('authorization_executor_scope_denied');
      if (!grantSet.roles.includes(APP_ADMIN_ROLE) || grantSet.tier !== 'admin') return deny('authorization_app_admin_required', grantSet.tier);
      return { ...deny('authorization_app_admin'), allowed: true, tier: 'admin' };
    }
    const permissions = resolveOperationPermissions(app, operation);
    if (!permissions?.length) return deny('authorization_operation_unbound');
    const admitted = [] as AuthorizationDecision['grants'];
    for (const permission of permissions) {
      if (actor.allowedPermissions && !actor.allowedPermissions.includes(`${app.app}:${permission}`)) return deny('authorization_executor_scope_denied');
      if (resolved.rows.some(row => row.deny && row.permission === permission)) return deny('authorization_explicit_deny');
      const declaration = app.catalog.permissions[permission];
      if (TIER_ORDER.indexOf(grantSet.tier) < TIER_ORDER.indexOf(declaration.minimumTier)) return deny('authorization_tier_denied', grantSet.tier);
      if (operation.method && grantSet.tier === 'viewer' && !['GET','HEAD','OPTIONS'].includes(operation.method.toUpperCase())) return deny('app_readonly', grantSet.tier);
      const adapter = app.adapters?.[declaration.resource];
      if (!adapter) return deny('authorization_resource_adapter_unavailable');
      let allowed = false;
      for (const grant of grantSet.grants.filter(candidate => candidate.permission === permission)) {
        if (grant.scope !== 'own' && !operation.tenantId) continue;
        const fields = grant.fields ? app.catalog.resources[declaration.resource].fieldSets?.[grant.fields] ?? [] : [];
        if (operation.fields?.some(field => !fields.includes(field))) continue;
        const accepted = await runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
          principalIssuer: actor.issuer, isOperator: false }, () => adapter.authorize({ actor, operation, grant, fields })));
        if (accepted) { allowed = true; admitted.push(grant); }
      }
      if (!allowed) return deny('authorization_permission_denied');
    }
    return { ...deny('authorization_allowed'), allowed: true, tier: grantSet.tier, grants: structuredClone(admitted) };
  }
  async previewChange(actor: AuthorizationActor, input: AuthorizationChange): Promise<AuthorizationPreview> {
    actor = await this.currentActor(actor);
    const change = parseAuthorizationChange(input); const app = this.requireApp(change.app); this.validateChange(actor, change, app);
    return this.store.transaction(async ({ state }) => {
      if (state.revision !== change.expectedRevision) throw new ApplicationAuthorizationError(409, 'authorization_revision_conflict');
      state.previews = state.previews.filter(preview => preview.receipt || Date.parse(preview.expiresAt) > this.now());
      if (state.previews.length >= 10_000) throw new ApplicationAuthorizationError(503, 'authorization_preview_capacity');
      const self = change.targetSub === actor.sub && change.targetIssuer === actor.issuer;
      const sensitive = Boolean(change.role && app.catalog?.roles[change.role]?.sensitive);
      const restoresSensitive = change.action === 'clear-deny' && state.assignments.some(row => row.app === app.app
        && row.targetSub === actor.sub && row.targetIssuer === actor.issuer && row.role && app.catalog?.roles[row.role]?.sensitive);
      const preview: StoredAuthorizationPreview = { previewId: randomUUID(), expiresAt: new Date(this.now() + 600_000).toISOString(), revision: state.revision,
        catalogRevision: app.catalogRevision, change, requiresApproval: (self && (sensitive || restoresSensitive)) || (Boolean(change.group) && sensitive), actor: { sub: actor.sub, issuer: actor.issuer } };
      state.previews.push(preview); return this.publicPreview(preview);
    });
  }
  async applyChange(actor: AuthorizationActor, raw: AuthorizationApplyInput): Promise<AuthorizationReceipt> {
    const input = parseAuthorizationApply(raw); actor = await this.currentActor(actor);
    return this.store.transaction(async ({ state, audit }) => {
      const preview = state.previews.find(row => row.previewId === input.previewId);
      if (!preview || preview.actor.sub !== actor.sub || preview.actor.issuer !== actor.issuer) throw new ApplicationAuthorizationError(404, 'authorization_preview_not_found');
      const app = this.requireApp(preview.change.app);
      requireManagement(actor, app.app, preview.change.tenantId, preview.change.group ? 'directory' : 'assign');
      if (preview.change.group) requireManagement(actor, app.app, preview.change.tenantId, 'assign');
      if (state.previews.some(row => row.previewId !== preview.previewId && row.actor.sub === actor.sub && row.actor.issuer === actor.issuer && row.idempotencyKey === input.idempotencyKey)) throw new ApplicationAuthorizationError(409, 'authorization_idempotency_conflict');
      if (preview.receipt) {
        if (preview.idempotencyKey !== input.idempotencyKey) throw new ApplicationAuthorizationError(409, 'authorization_preview_consumed');
        return preview.receipt;
      }
      if (Date.parse(preview.expiresAt) <= this.now()) throw new ApplicationAuthorizationError(409, 'authorization_preview_expired');
      if (preview.catalogRevision !== app.catalogRevision || preview.revision !== state.revision) throw new ApplicationAuthorizationError(409, 'authorization_revision_conflict');
      this.validateChange(actor, preview.change, app);
      if (preview.requiresApproval && (!input.approvalReference || !this.options.verifyApproval
        || !await this.options.verifyApproval(actor, this.publicPreview(preview), input.approvalReference))) throw new ApplicationAuthorizationError(403, 'authorization_approval_required');
      // Revalidate after asynchronous approval, before authority and its audit become one commit.
      actor = await this.currentActor(actor); this.validateChange(actor, preview.change, app);
      const change = preview.change;
      const matches = (row: AuthorizationAssignment): boolean => row.app === change.app && row.source === app.source && row.targetSub === change.targetSub
        && row.targetIssuer === change.targetIssuer && row.tenantId === change.tenantId && JSON.stringify(row.group) === JSON.stringify(change.group)
        && row.role === change.role && row.permission === change.permission && row.deny === ['deny','clear-deny'].includes(change.action);
      state.assignments = state.assignments.filter(row => !matches(row));
      if (['grant','deny','group-map'].includes(change.action)) state.assignments.push({ id: randomUUID(), app: app.app, source: app.source,
        catalogRevision: app.catalogRevision, targetSub: change.targetSub, targetIssuer: change.targetIssuer, tenantId: change.tenantId,
        group: change.group, role: change.role, permission: change.permission, deny: change.action === 'deny', expiresAt: change.expiresAt });
      state.revision += 1; const auditId = randomUUID();
      audit({ id: auditId, actor: { sub: actor.sub, issuer: actor.issuer }, at: new Date(this.now()).toISOString(), change, revision: state.revision, previewId: preview.previewId });
      const receipt: AuthorizationReceipt = { previewId: preview.previewId, revision: state.revision, auditId, applied: true };
      preview.receipt = receipt; preview.idempotencyKey = input.idempotencyKey; return receipt;
    });
  }
  private validateChange(actor: AuthorizationActor, change: AuthorizationChange, app: RegisteredAuthorizationApp): void {
    requireManagement(actor, app.app, change.tenantId, change.group ? 'directory' : 'assign');
    if (change.group) requireManagement(actor, app.app, change.tenantId, 'assign');
    if (change.expiresAt && Date.parse(change.expiresAt) <= this.now()) throw new ApplicationAuthorizationError(400, 'authorization_expiry_invalid');
    if (change.role && (app.catalog ? !Object.prototype.hasOwnProperty.call(app.catalog.roles, change.role) : change.role !== APP_ADMIN_ROLE)) throw new ApplicationAuthorizationError(400, 'authorization_role_unknown');
    if (change.permission && (!app.catalog || !Object.prototype.hasOwnProperty.call(app.catalog.permissions, change.permission))) throw new ApplicationAuthorizationError(400, 'authorization_permission_unknown');
  }
  private async currentActor(actor: AuthorizationActor): Promise<AuthorizationActor> {
    assertActor(actor);
    if (!this.options.refreshActor) return actor;
    const current = await this.options.refreshActor(actor);
    if (!current || current.sub !== actor.sub || current.issuer !== actor.issuer) throw new ApplicationAuthorizationError(401, 'authorization_identity_required');
    assertActor(current);
    const allowedPermissions = actor.allowedPermissions === undefined ? current.allowedPermissions
      : actor.allowedPermissions.filter(permission => current.allowedPermissions === undefined || current.allowedPermissions.includes(permission));
    return { ...current, allowedPermissions };
  }
  private requireApp(name: string): RegisteredAuthorizationApp {
    const app = this.apps.get(name); if (!app) throw new ApplicationAuthorizationError(404, 'authorization_app_unavailable'); return app;
  }
  private summary(app: RegisteredAuthorizationApp): AuthorizationAppSummary {
    return { app: app.app, source: app.source, version: app.version, catalogRevision: app.catalogRevision, mode: app.mode,
      status: app.catalog ? 'catalog' : app.mode === 'enforce' ? 'admin-required' : 'legacy', catalog: structuredClone(app.catalog),
      missingAdapters: Object.keys(app.catalog?.resources ?? {}).filter(resource => !app.adapters?.[resource]) };
  }
  private async explicitTier(app: string, actor: AuthorizationActor): Promise<AuthorizationTier | undefined> {
    const resolved = await this.options.resolveTier?.(app, actor); return resolved?.explicit ? resolved.tier : undefined;
  }
  private async targetActor(actor: AuthorizationActor, input: AuthorizationTarget): Promise<AuthorizationActor> {
    const sub = input.targetSub ?? actor.sub; const issuer = input.targetIssuer ?? actor.issuer;
    if (sub === actor.sub && issuer === actor.issuer) return actor;
    requireManagement(actor, input.app, input.tenantId, 'read');
    return await this.options.resolveActor?.(sub, issuer) ?? { sub, issuer, isActive: false, isSwarmAdmin: false };
  }
  private publicPreview(preview: StoredAuthorizationPreview): AuthorizationPreview {
    return { previewId: preview.previewId, expiresAt: preview.expiresAt, revision: preview.revision,
      catalogRevision: preview.catalogRevision, change: structuredClone(preview.change), requiresApproval: preview.requiresApproval };
  }
}

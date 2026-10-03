/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify ordinary authorization edits retain managed provenance and cannot separately consume a reserved composite constituent.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';
import { parseCompositeRoleInput, parseCompositeRoleApply } from '@/features/application-authorization/composite-role-validation';
import type { CompositeRolePreview, CompositeRoleInput } from '@/shared/application-authorization';

const ISSUER = 'https://composite.fixture.invalid';
const admin: AuthorizationActor = { sub: 'synthetic-admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const user: AuthorizationActor = { sub: 'synthetic-user', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const catalog: AuthorizationCatalog = { version: 1, resources: { application: { scopes: ['own'] } }, permissions: { 'app.open': { resource: 'application', effect: 'read', minimumTier: 'viewer' } },
  roles: { viewer: { tier: 'viewer', grants: [{ permission: 'app.open', scope: 'own' }] } }, bindings: { http: [{ id: 'entry', method: 'GET', path: '/app', allOf: ['app.open'] }] } };
let store: MemoryAuthorizationStore, service: ApplicationAuthorizationService;
beforeEach(async () => {
  store = new MemoryAuthorizationStore();
  service = new ApplicationAuthorizationService(store, { resolveActor: async sub => sub === user.sub ? user : admin });
  await service.registerApp({ app: 'synthetic-member', source: 'synthetic-source', version: '1.0.0', catalog, mode: 'enforce' });
});
async function change(action: 'grant' | 'revoke') {
  const preview = await service.previewChange(admin, { action, app: 'synthetic-member', targetSub: user.sub, targetIssuer: user.issuer, role: 'viewer', reason: 'Synthetic provenance verification', expectedRevision: (await store.read()).revision });
  return service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
}
describe('managed role provenance at the existing authority', () => {
  it('a direct grant and its revoke retain overlapping managed role sources', async () => {
    await change('grant');
    await store.transaction(async ({ state }) => {
      const original = state.assignments[0];
      state.assignments.push({ ...original, id: 'synthetic-managed-one', grantSource: 'experience-composite:synthetic-one' },
        { ...original, id: 'synthetic-managed-two', grantSource: 'experience-composite:synthetic-two' });
      state.revision++;
    });
    await change('grant');
    expect((await store.read()).assignments).toHaveLength(3);
    await change('revoke');
    expect((await store.read()).assignments.map(row => row.grantSource).sort()).toEqual(['experience-composite:synthetic-one', 'experience-composite:synthetic-two']);
    expect((await service.effective(admin, { app: 'synthetic-member', targetSub: user.sub, targetIssuer: user.issuer })).roles).toEqual(['viewer']);
  });
  it('the ordinary apply route refuses a constituent reserved for an atomic composite', async () => {
    const preview = await service.previewChange(admin, { action: 'grant', app: 'synthetic-member', targetSub: user.sub, targetIssuer: user.issuer, role: 'viewer', reason: 'Synthetic reserved review', expectedRevision: (await store.read()).revision });
    await store.transaction(async ({ state }) => { state.previews.find(row => row.previewId === preview.previewId)!.compositeId = 'synthetic-composite-review'; });
    await expect(service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403, code: 'authorization_composite_preview_reserved' });
    expect((await store.read()).assignments).toEqual([]);
  });
});
describe('composite lifecycle request boundary', () => {
  const request = () => ({ action: 'assign', app: 'home-experience', template: 'adult', targetSub: user.sub, targetIssuer: user.issuer, optionalApps: ['shopping'], reason: 'Synthetic explicit selections', expectedRevision: 0 });
  it('accepts exact target identity and deliberate optional selections without authority fields', () => {
    expect(parseCompositeRoleInput(request())).toEqual(request());
    expect(parseCompositeRoleApply({ previewId: randomUUID(), idempotencyKey: randomUUID() }).approvals).toBeUndefined();
  });
  it.each([{ source: 'forged' }, { permissions: ['all'] }, { targetIssuer: undefined }, { optionalApps: ['shopping', 'shopping'] }, { expectedRevision: -1 }])('refuses ambiguous or authority-bearing selection %j', override => {
    expect(() => parseCompositeRoleInput({ ...request(), ...override })).toThrow();
  });
  it('a lifecycle update cannot retarget an existing assignment or silently select new optional members', () => {
    const revoke = { action: 'revoke', app: 'home-experience', assignmentId: randomUUID(), reason: 'Synthetic source removal', expectedRevision: 0 };
    expect(parseCompositeRoleInput(revoke)).toEqual(revoke);
    expect(() => parseCompositeRoleInput({ ...revoke, targetSub: user.sub })).toThrow();
    expect(() => parseCompositeRoleInput({ ...revoke, optionalApps: ['shopping'] })).toThrow();
  });
});

describe('reviewed composite lifecycle', () => {
  const host = 'synthetic-experience';
  const template = { id: 'resident', version: 1, label: 'Resident', members: [{ app: host, role: 'viewer' }, { app: 'synthetic-member', role: 'viewer' }, { app: 'synthetic-optional', role: 'viewer' }] };
  const registerHost = (version = 1) => service.registerApp({ app: host, source: 'synthetic-host-source', version: '1.0.' + version, catalog, mode: 'enforce',
    compositeRoles: { templates: [{ ...template, version }], requiredApps: ['synthetic-member'], optionalApps: ['synthetic-optional'] } });
  const preview = async (override: Partial<CompositeRoleInput> = {}) => service.previewCompositeRole(admin, {
    action: 'assign', app: host, template: 'resident', targetSub: user.sub, targetIssuer: user.issuer,
    reason: 'Synthetic composite acceptance', expectedRevision: (await store.read()).revision, ...override });
  const apply = (review: CompositeRolePreview, key = randomUUID()) => service.applyCompositeRole(admin, { previewId: review.previewId!, idempotencyKey: key });
  beforeEach(async () => { await registerHost(); });
  it('installation creates no assignment; explicit review selects required roles only', async () => {
    expect((await store.read()).assignments).toEqual([]);
    const review = await preview();
    expect(review.ready).toBe(true);
    expect(review.members.map(row => row.app)).toEqual([host, 'synthetic-member']);
    expect((await store.read()).assignments).toEqual([]);
    await apply(review);
    expect((await store.read()).assignments).toHaveLength(2);
    expect((await service.listCompositeRoles(admin)).assignments[0].optionalApps).toEqual([]);
  });
  it('keeps overlapping composite and direct grants when one source is revoked', async () => {
    await change('grant');
    const first = await apply(await preview()), second = await apply(await preview());
    await apply(await preview({ action: 'revoke', template: undefined, targetSub: undefined, targetIssuer: undefined, assignmentId: first.assignmentId }));
    const state = await store.read();
    expect(state.assignments).toHaveLength(3);
    expect(state.assignments.filter(row => row.grantSource === 'experience-composite:' + second.assignmentId)).toHaveLength(2);
    expect((await service.effective(admin, { app: 'synthetic-member', targetSub: user.sub, targetIssuer: user.issuer })).roles).toEqual(['viewer']);
  });
  it('replays the receipt without duplicating edges or audit events', async () => {
    const review = await preview(), key = randomUUID(), first = await apply(review, key);
    expect(await apply(review, key)).toEqual(first);
    expect(store.auditEvents).toHaveLength(2);
    await expect(apply(review)).rejects.toMatchObject({ code: 'authorization_preview_consumed' });
  });
  it('reports an explicitly selected missing optional member and grants nothing', async () => {
    const review = await preview({ optionalApps: ['synthetic-optional'] });
    expect(review.ready).toBe(false); expect(review.previewId).toBeUndefined();
    expect(review.members.find(row => row.app === 'synthetic-optional')?.blocked).toBe('composite_member_unavailable');
    expect((await store.read()).assignments).toEqual([]);
  });
  it('grants a deliberately selected installed optional member', async () => {
    await service.registerApp({ app: 'synthetic-optional', source: 'optional-source', version: '1', catalog, mode: 'enforce' });
    await apply(await preview({ optionalApps: ['synthetic-optional'] }));
    expect((await store.read()).assignments).toHaveLength(3);
  });
  it('a changed policy invalidates the entire reviewed set', async () => {
    const review = await preview(); await change('grant');
    await expect(apply(review)).rejects.toMatchObject({ code: 'authorization_revision_conflict' });
    expect((await store.read()).assignments.every(row => !row.grantSource)).toBe(true);
  });
  it('rechecks the exact template even when its version changes without a policy revision', async () => {
    const review = await preview(); await registerHost(2);
    await expect(apply(review)).rejects.toMatchObject({ code: 'authorization_revision_conflict' });
    expect((await store.read()).assignments).toEqual([]);
  });
  it('a reviewed upgrade retains assignment identity and replaces its own source only', async () => {
    const receipt = await apply(await preview()); await change('grant'); await registerHost(2);
    expect((await service.listCompositeRoles(admin)).assignments[0].upgradeAvailable).toBe(true);
    const updated = await apply(await preview({ action: 'upgrade', template: undefined, targetSub: undefined, targetIssuer: undefined, assignmentId: receipt.assignmentId }));
    expect(updated.assignmentId).toBe(receipt.assignmentId);
    expect((await store.read()).assignments).toHaveLength(3);
    expect((await service.listCompositeRoles(admin)).assignments[0].templateVersion).toBe(2);
  });
  it('revokes provenance even after the host and a member are uninstalled', async () => {
    const receipt = await apply(await preview()); await change('grant');
    service.unregisterApp(host); service.unregisterApp('synthetic-member');
    await apply(await preview({ action: 'revoke', template: undefined, targetSub: undefined, targetIssuer: undefined, assignmentId: receipt.assignmentId }));
    expect((await store.read()).assignments).toHaveLength(1);
    expect((await store.read()).assignments[0].grantSource).toBeUndefined();
  });
  it('rolls back all constituent writes and their audits if a later constituent fails', async () => {
    const review = await preview();
    await store.transaction(async ({ state }) => { state.previews.find(row => row.previewId === review.members[1].preview!.previewId)!.revokeGrantSource = 'forged-source'; });
    // Simulate corruption of the reserved second change after its review. It must fail under the writer lock.
    await store.transaction(async ({ state }) => { state.previews.find(row => row.previewId === review.members[1].preview!.previewId)!.change.action = 'revoke'; });
    await expect(apply(review)).rejects.toMatchObject({ code: 'authorization_composite_source_mismatch' });
    expect((await store.read()).assignments).toEqual([]); expect(store.auditEvents).toEqual([]);
  });
  it('does not clear an explicit member deny', async () => {
    const denied = await service.previewChange(admin, { action: 'deny', app: 'synthetic-member', targetSub: user.sub, targetIssuer: user.issuer, reason: 'Synthetic explicit refusal', expectedRevision: (await store.read()).revision });
    await service.applyChange(admin, { previewId: denied.previewId, idempotencyKey: randomUUID() });
    const review = await preview();
    expect(review.ready).toBe(false); expect(review.members[1].blocked).toBe('composite_member_denied');
    expect((await store.read()).assignments).toHaveLength(1);
  });
  it('blocks a qualified subject who is not a member of the selected tenant', async () => {
    const review = await preview({ tenantId: 'synthetic-tenant' });
    expect(review.ready).toBe(false); expect(review.members.every(row => row.blocked === 'composite_subject_tenant_denied')).toBe(true);
  });
  it('requires independent sensitive approval through each existing constituent', async () => {
    const sensitive = structuredClone(catalog); sensitive.roles.viewer.sensitive = true;
    await service.registerApp({ app: 'synthetic-sensitive', source: 'sensitive-source', version: '1', catalog: sensitive, mode: 'enforce' });
    await service.registerApp({ app: host, source: 'synthetic-host-source', version: '1', catalog, mode: 'enforce', compositeRoles: {
      templates: [{ ...template, members: [{ app: host, role: 'viewer' }, { app: 'synthetic-sensitive', role: 'viewer' }] }], requiredApps: ['synthetic-sensitive'], optionalApps: [] } });
    const review = await preview({ targetSub: admin.sub, targetIssuer: admin.issuer });
    expect(review.members[1].requiresApproval).toBe(true);
    await expect(apply(review)).rejects.toMatchObject({ code: 'authorization_approval_required' });
    expect((await store.read()).assignments).toEqual([]);
  });
  it('refuses a member role that the installed catalog does not define', async () => {
    await service.registerApp({ app: host, source: 'synthetic-host-source', version: '1', catalog, mode: 'enforce', compositeRoles: {
      templates: [{ ...template, members: [{ app: host, role: 'viewer' }, { app: 'synthetic-member', role: 'invented-editor' }] }], requiredApps: ['synthetic-member'], optionalApps: [] } });
    const review = await preview(); expect(review.ready).toBe(false); expect(review.members[1].blocked).toBe('composite_member_role_unavailable');
  });
  it('refreshes the qualified subject before apply and refuses a deactivated account', async () => {
    const review = await preview(); user.isActive = false;
    try { await expect(apply(review)).rejects.toMatchObject({ code: 'composite_subject_unavailable' }); expect((await store.read()).assignments).toEqual([]); }
    finally { user.isActive = true; }
  });
  it('rechecks current per-member administration before applying', async () => {
    const review = await preview(); admin.isSwarmAdmin = false;
    try { await expect(apply(review)).rejects.toMatchObject({ code: 'authorization_management_denied' }); expect((await store.read()).assignments).toEqual([]); }
    finally { admin.isSwarmAdmin = true; }
  });
  it('retains exact group issuer and tenant while requiring directory authority', async () => {
    const group = { issuer: ISSUER, tenantId: 'synthetic-tenant', id: 'synthetic-group' };
    const review = await preview({ group, targetSub: undefined, targetIssuer: undefined });
    expect(review.tenantId).toBe(group.tenantId); expect(review.ready).toBe(true); await apply(review);
    expect((await store.read()).assignments.every(row => JSON.stringify(row.group) === JSON.stringify(group) && row.tenantId === group.tenantId)).toBe(true);
    expect((await service.effective(admin, { app: host, targetSub: user.sub, targetIssuer: user.issuer, tenantId: group.tenantId })).denied).toBe(true);
  });
  it('expires a stored review without applying any member', async () => {
    const review = await preview();
    await store.transaction(async ({ state }) => { state.compositePreviews!.find(row => row.id === review.previewId)!.review.expiresAt = new Date(0).toISOString(); });
    await expect(apply(review)).rejects.toMatchObject({ code: 'authorization_preview_expired' }); expect((await store.read()).assignments).toEqual([]);
  });
  it('all member grants share explicit expiry and report expired assignment state', async () => {
    const expiry = new Date(Date.now() + 60000).toISOString(); const receipt = await apply(await preview({ expiresAt: expiry }));
    expect((await store.read()).assignments.every(row => row.expiresAt === expiry)).toBe(true);
    await store.transaction(async ({ state }) => { state.compositeAssignments!.find(row => row.id === receipt.assignmentId)!.expiresAt = new Date(0).toISOString(); });
    expect((await service.listCompositeRoles(admin)).assignments[0].status).toBe('expired');
  });
  it('does not accept approval references for unrelated previews', async () => {
    const review = await preview();
    await expect(service.applyCompositeRole(admin, { previewId: review.previewId!, idempotencyKey: randomUUID(), approvals: { [randomUUID()]: 'forged-approval' } })).rejects.toMatchObject({ code: 'composite_approval_reference_invalid' });
    expect((await store.read()).assignments).toEqual([]);
  });
});

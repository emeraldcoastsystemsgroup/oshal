/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
import { describe, it, expect } from 'vitest';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '../../src/features/application-authorization';
import { validateAuthorizationCatalog, parseAuthorizationCatalog, type AuthorizationActor, type AuthorizationChange, type AuthorizationCatalog } from '../../src/shared/application-authorization';
import { getApplicationAuthorizationActor, runWithApplicationAuthorizationActor } from '../../src/shared/application-authorization-context';
import { getRequestIdentity, runWithSystemIdentity } from '../../src/shared/services/database/request-identity';

const admin: AuthorizationActor = { sub: 'admin', issuer: 'fixture', isActive: true, isSwarmAdmin: true, tenantIds: ['company-a'] };
const user: AuthorizationActor = { sub: 'user', issuer: 'fixture', isActive: true, isSwarmAdmin: false, tenantIds: ['company-a'] };
const rawCatalog: AuthorizationCatalog = {
  version: 1,
  resources: { records: { scopes: ['own','team'], fieldSets: { summary: ['id'], details: ['id','email'] } } },
  permissions: { 'records.read': { resource: 'records', effect: 'read', minimumTier: 'viewer' }, 'records.write': { resource: 'records', effect: 'write', minimumTier: 'editor' } },
  roles: { reader: { tier: 'viewer', grants: [{ permission: 'records.read', scope: 'own', fields: 'details' }] },
    team: { tier: 'viewer', grants: [{ permission: 'records.read', scope: 'team', fields: 'summary' }] },
    editor: { tier: 'editor', grants: [{ permission: 'records.write', scope: 'own', fields: 'details' }] },
    sensitive: { tier: 'editor', sensitive: true, grants: [{ permission: 'records.write', scope: 'own', fields: 'details' }] } },
  bindings: { http: [{ id: 'read', method: 'GET', path: '/records/:id', allOf: ['records.read'] }],
    tools: [{ id: 'read-records', allOf: ['records.read'] }, { id: 'write-records', allOf: ['records.write'] }] },
};
function setup(now = Date.now()) {
  const store = new MemoryAuthorizationStore();
  let clock = now;
  const service = new ApplicationAuthorizationService(store, { now: () => clock, resolveActor: async (sub, issuer) => ({ ...user, sub, issuer }) });
  return { store, service, setClock: (time: number) => { clock = time; } };
}
async function grant(service: ApplicationAuthorizationService, actor: AuthorizationActor, change: Partial<AuthorizationChange> = {}) {
  const revision = (await service.catalog(actor)).revision;
  const preview = await service.previewChange(actor, { action: 'grant', app: 'fixture-app', role: 'reader', targetSub: user.sub, targetIssuer: user.issuer, reason: 'Fixture assignment', expectedRevision: revision, ...change });
  return service.applyChange(actor, { previewId: preview.previewId, idempotencyKey: preview.previewId });
}
describe('application authorization contract', () => {
  it('validates the same imported catalog without mutating its source', () => {
    const copy = validateAuthorizationCatalog(rawCatalog); copy.roles.reader.tier = 'admin';
    expect(rawCatalog.roles.reader.tier).toBe('viewer');
    expect(parseAuthorizationCatalog(JSON.stringify(rawCatalog))).toEqual(rawCatalog);
  });
  it.each([
    (c: AuthorizationCatalog) => { c.permissions['records.write'].minimumTier = 'viewer'; },
    (c: AuthorizationCatalog) => { c.roles.reader.grants[0].fields = 'unknown'; },
    (c: AuthorizationCatalog) => { c.bindings.tools![0].allOf = []; },
    (c: AuthorizationCatalog) => { c.bindings.http!.push({ id: 'overlap', method: 'GET', path: '/records/named', allOf: ['records.read'] }); },
  ])('rejects malformed permission meanings and ambiguous operation bindings', mutate => {
    const catalog = structuredClone(rawCatalog); mutate(catalog); expect(() => validateAuthorizationCatalog(catalog)).toThrow();
  });
  it('rejects duplicate YAML keys and unknown catalog fields', () => {
    expect(() => parseAuthorizationCatalog('version: 1\nversion: 1')).toThrow();
    expect(() => validateAuthorizationCatalog({ ...rawCatalog, arbitrarySql: 'select *' })).toThrow();
  });
  it('refuses cyclic or expanding YAML aliases before serializing an imported catalog', () => {
    expect(() => parseAuthorizationCatalog('version: 1\nresources: &loop [*loop]')).toThrow(/aliases and cycles/);
    const aliases = ['resources: &a [x,x]'];
    for (let index = 1; index < 24; index += 1) aliases.push(`a${index}: &a${index} [*${index === 1 ? 'a' : `a${index - 1}`},*${index === 1 ? 'a' : `a${index - 1}`}]`);
    expect(() => parseAuthorizationCatalog(aliases.join('\n'))).toThrow(/aliases and cycles/);
  });
});
describe('application authorization real service', () => {
  it('explains another user under that target identity rather than the managing operator context', async () => {
    const { service } = setup();
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: rawCatalog, mode: 'enforce' });
    await grant(service, admin);
    let inspected = false;
    service.registerResourceAdapter('fixture-app', 'records', { authorize: async ({ actor }) => {
      inspected = true; expect(actor.sub).toBe(user.sub);
      expect(getApplicationAuthorizationActor()).toMatchObject({ sub: user.sub, isSwarmAdmin: false });
      expect(getRequestIdentity()).toMatchObject({ sub: user.sub, principalIssuer: user.issuer, isOperator: false });
      expect(getRequestIdentity()?.system).not.toBe(true); return true;
    } });
    const decision = await runWithSystemIdentity(() => runWithApplicationAuthorizationActor(admin, () => service.explain(admin, {
      app: 'fixture-app', kind: 'tools', operation: 'read-records', targetSub: user.sub, targetIssuer: user.issuer,
    })));
    expect(decision.allowed).toBe(true); expect(inspected).toBe(true);
  });
  it('refreshes stale callers for execution and management without expanding a delegation ceiling', async () => {
    let active = true; let swarmAdmin = true; let wrongIssuer = false;
    const service = new ApplicationAuthorizationService(new MemoryAuthorizationStore(), { refreshActor: async actor => ({ ...actor,
      issuer: wrongIssuer ? 'other' : actor.issuer, isActive: active, isSwarmAdmin: swarmAdmin, allowedPermissions: undefined }) });
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: null, mode: 'enforce' });
    await grant(service, admin, { role: '@app-admin' });
    expect((await service.authorize({ ...user, allowedPermissions: [] }, { app: 'fixture-app' })).reason).toBe('authorization_executor_scope_denied');
    expect((await service.authorize(user, { app: 'fixture-app' })).allowed).toBe(true);
    swarmAdmin = false; await expect(service.catalog(admin)).rejects.toMatchObject({ status: 403 });
    active = false;
    expect((await service.authorize(user, { app: 'fixture-app' })).allowed).toBe(false);
    await expect(service.effective(admin, { app: 'fixture-app' })).rejects.toMatchObject({ status: 401 });
    active = true; wrongIssuer = true;
    expect((await service.authorize(user, { app: 'fixture-app' })).allowed).toBe(false);
  });
  it('revalidates caller authority after approval and rolls back an elevation if it was revoked', async () => {
    let active = true; const store = new MemoryAuthorizationStore();
    const service = new ApplicationAuthorizationService(store, {
      refreshActor: async actor => ({ ...actor, isActive: active }),
      verifyApproval: async () => { active = false; return true; },
    });
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: rawCatalog, mode: 'enforce' });
    const preview = await service.previewChange(admin, { action: 'grant', app: 'fixture-app', role: 'sensitive', targetSub: admin.sub,
      targetIssuer: admin.issuer, reason: 'Revoked during approval', expectedRevision: 0 });
    await expect(service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: preview.previewId, approvalReference: 'trusted-approval' })).rejects.toMatchObject({ status: 401 });
    expect((await store.read()).revision).toBe(0); expect(store.auditEvents).toHaveLength(0);
  });
  it('requires explicit fallback app-admin and preserves deny, issuer and executor boundaries', async () => {
    const { service } = setup();
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: null, mode: 'enforce', access: { supported: ['deny','admin'], defaultTier: 'admin' } });
    expect((await service.authorize(admin, { app: 'fixture-app' })).allowed).toBe(false);
    await grant(service, admin, { role: '@app-admin' });
    expect((await service.authorize(user, { app: 'fixture-app' })).allowed).toBe(true);
    expect((await service.authorize({ ...user, issuer: 'other' }, { app: 'fixture-app' })).allowed).toBe(false);
    expect((await service.authorize({ ...user, allowedPermissions: [] }, { app: 'fixture-app' })).allowed).toBe(false);
    expect((await service.authorize({ ...user, allowedPermissions: ['fixture-app:@app-admin'] }, { app: 'fixture-app' })).allowed).toBe(true);
    await grant(service, admin, { action: 'deny', role: undefined });
    expect((await service.authorize(user, { app: 'fixture-app' })).reason).toBe('authorization_explicit_deny');
  });
  it('honors an explicit existing admin tier but never its default', async () => {
    const store = new MemoryAuthorizationStore(); let explicit = false;
    const service = new ApplicationAuthorizationService(store, { resolveTier: async () => ({ tier: 'admin', explicit }) });
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: null, mode: 'enforce' });
    expect((await service.authorize(user, { app: 'fixture-app' })).allowed).toBe(false);
    explicit = true; expect((await service.authorize(user, { app: 'fixture-app' })).allowed).toBe(true);
  });
  it('never combines team-summary with own-details to reveal another record email', async () => {
    const { service } = setup();
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: rawCatalog, mode: 'legacy', mountPaths: ['/api/fixture'] });
    await grant(service, admin, { tenantId: 'company-a' }); await grant(service, admin, { role: 'team', tenantId: 'company-a' });
    const input = { app: 'fixture-app', kind: 'tools' as const, operation: 'read-records', tenantId: 'company-a', resourceId: 'other', fields: ['email'] };
    expect((await service.authorize(user, input)).reason).toBe('authorization_resource_adapter_unavailable');
    service.registerResourceAdapter('fixture-app', 'records', { authorize: async ({ operation, grant }) => grant.scope === 'team' || operation.resourceId === 'own' });
    expect((await service.authorize(user, input)).allowed).toBe(false);
    expect((await service.authorize(user, { ...input, fields: ['id'] })).allowed).toBe(true);
    expect((await service.authorize(user, { ...input, resourceId: 'own' })).allowed).toBe(true);
    expect((await service.authorize(user, { ...input, tenantId: 'company-b' })).reason).toBe('authorization_tenant_denied');
    expect((await service.authorize(user, { ...input, operation: 'write-records' })).allowed).toBe(false);
    expect((await service.authorize(user, { app: 'fixture-app', method: 'GET', path: '/api/fixture/records/own', resourceId: 'own', tenantId: 'company-a' })).allowed).toBe(true);
    expect((await service.authorize(user, { app: 'fixture-app', method: 'GET', path: '/api/fixture/unbound' })).reason).toBe('authorization_operation_unbound');
  });
  it('denies after revocation and rejects stale concurrent previews atomically', async () => {
    const { service, store } = setup();
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: null, mode: 'enforce' });
    const change: AuthorizationChange = { action: 'grant', app: 'fixture-app', role: '@app-admin', targetSub: user.sub, targetIssuer: user.issuer, reason: 'Test', expectedRevision: 0 };
    const [a, b] = await Promise.all([service.previewChange(admin, change), service.previewChange(admin, change)]);
    const results = await Promise.allSettled([a,b].map(preview => service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: preview.previewId })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(store.auditEvents).toHaveLength(1);
    await grant(service, admin, { action: 'revoke', role: '@app-admin' });
    expect((await service.authorize(user, { app: 'fixture-app' })).allowed).toBe(false);
  });
  it('binds previews to actor, approval, expiry and one idempotent result', async () => {
    const { service, store, setClock } = setup(1_800_000_000_000);
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: rawCatalog, mode: 'enforce' });
    const preview = await service.previewChange(admin, { action: 'grant', app: 'fixture-app', role: 'sensitive', targetSub: admin.sub, targetIssuer: admin.issuer, reason: 'Sensitive self assignment', expectedRevision: 0 });
    expect(preview.requiresApproval).toBe(true);
    await expect(service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: preview.previewId })).rejects.toMatchObject({ code: 'authorization_approval_required' });
    await expect(service.applyChange({ ...admin, sub: 'other' }, { previewId: preview.previewId, idempotencyKey: preview.previewId })).rejects.toMatchObject({ status: 404 });
    setClock(1_800_000_700_000);
    await expect(service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: preview.previewId })).rejects.toMatchObject({ code: 'authorization_preview_expired' });
    const receipt = await grant(service, admin);
    expect(await service.applyChange(admin, { previewId: receipt.previewId, idempotencyKey: receipt.previewId })).toEqual(receipt);
    expect(store.auditEvents).toHaveLength(1);
  });
  it('binds directory grants to fresh complete issuer/tenant/group evidence and conservatively retains deny', async () => {
    const now = 1_800_000_000_000; const { service } = setup(now);
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: null, mode: 'enforce' });
    await grant(service, admin, { action: 'group-map', role: '@app-admin', targetSub: undefined, targetIssuer: undefined, group: { issuer: 'directory', tenantId: 'directory-a', id: 'group-a' } });
    const directory = [{ issuer: 'directory', tenantId: 'directory-a', groups: ['group-a'], complete: true, observedAt: new Date(now).toISOString() }];
    expect((await service.authorize({ ...user, directory }, { app: 'fixture-app' })).allowed).toBe(true);
    expect((await service.authorize({ ...user, directory: [{ ...directory[0], tenantId: 'directory-b' }] }, { app: 'fixture-app' })).allowed).toBe(false);
    await grant(service, admin, { role: '@app-admin' });
    expect((await service.authorize({ ...user, directory: [{ ...directory[0], complete: false }] }, { app: 'fixture-app' })).reason).toBe('authorization_directory_unavailable');
  });
  it('rejects mutation inputs and namespace/permission escalation; changed catalogs preserve previous registration', async () => {
    const { service } = setup();
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: rawCatalog, mode: 'enforce' });
    const change: AuthorizationChange = { action: 'grant', app: 'fixture-app', role: 'reader', targetSub: user.sub, targetIssuer: user.issuer, reason: 'Test', expectedRevision: 0 };
    await expect(service.previewChange(user, change)).rejects.toMatchObject({ status: 403 });
    await expect(service.previewChange({ ...admin, allowedPermissions: [] }, change)).rejects.toMatchObject({ status: 403 });
    await expect(service.previewChange(admin, { ...change, approved: true } as AuthorizationChange)).rejects.toMatchObject({ status: 400 });
    await grant(service, admin);
    const changed = structuredClone(rawCatalog); changed.resources.records.fieldSets!.details.push('salary');
    await expect(service.registerApp({ app: 'fixture-app', source: 'fixture', version: '2', catalog: changed, mode: 'enforce' })).rejects.toMatchObject({ status: 409 });
    expect(service.getApp('fixture-app')!.version).toBe('1');
  });
});

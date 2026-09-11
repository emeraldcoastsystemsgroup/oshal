/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove durable app access administrators and auditors through the real policy and HTTP service.
 */
import { afterEach, expect, it } from 'vitest';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationChange } from '@/shared/application-authorization';
import { AuthorizationToolRuntime } from '@/app/composition/authorization-tool';
import { CATALOG, createAuthorizationFixture, ISSUER } from '../fixtures/authorization';

let fixture: Awaited<ReturnType<typeof createAuthorizationFixture>> | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

async function httpFixture() { fixture = await createAuthorizationFixture(); return fixture; }
const admin: AuthorizationActor = { sub: 'admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const manager: AuthorizationActor = { sub: 'manager', issuer: ISSUER, isActive: true, isSwarmAdmin: false };

async function directFixture() {
  const store = new MemoryAuthorizationStore(); let now = Date.now(); let active = true;
  const service = new ApplicationAuthorizationService(store, { now: () => now,
    refreshActor: async actor => ({ ...actor, isActive: actor.sub === manager.sub ? active : actor.isActive, managementScopes: undefined }),
    verifyApproval: async () => true });
  const registration = { app: 'catalog-app', source: 'fixture', version: '1', catalog: CATALOG, mode: 'enforce' as const };
  await service.registerApp(registration);
  const change = async (input: Partial<AuthorizationChange> = {}, caller = admin) => {
    const preview = await service.previewChange(caller, { action: 'grant', app: registration.app, targetSub: manager.sub,
      targetIssuer: manager.issuer, role: '@access-admin', reason: 'Fixture access delegation', expectedRevision: (await store.read()).revision, ...input });
    return service.applyChange(caller, { previewId: preview.previewId, idempotencyKey: preview.previewId, approvalReference: 'trusted-fixture-approval' });
  };
  return { service, store, registration, change, advance() { now += 600_000; }, disable() { active = false; } };
}

it('lets an app auditor inspect access and scoped history without business access or writes', async () => {
  const f = await httpFixture(); await f.apply({ role: '@access-auditor' });
  const catalog = await f.call('/catalog', undefined, 'alice');
  expect(catalog.status).toBe(200); expect(catalog.body.apps.map((app: any) => app.app)).toEqual(['catalog-app']);
  expect(catalog.body.managementRoles.map((role: any) => role.id)).toEqual(['@access-admin', '@access-auditor']);
  expect(catalog.body.apps[0]).toMatchObject({ canDelegateManagement: false, managementScopes: [{ permissions: ['read'] }] });
  const own = await f.call('/me?app=catalog-app', undefined, 'alice');
  expect(own.body).toMatchObject({ roles: [], permissions: [], tier: 'deny', managementRoles: ['@access-auditor'], managementPermissions: ['read'] });
  expect((await f.call('/audit?app=catalog-app', undefined, 'alice')).status).toBe(200);
  expect((await f.call('/audit', undefined, 'alice')).status).toBe(403);
  expect((await f.call('/preview', await f.change({ targetSub: 'bob' }), 'alice')).status).toBe(403);
  expect((await f.service.authorize(f.actors.alice, { app: 'catalog-app', method: 'GET', path: '/records' })).allowed).toBe(false);
});

it('lets an app access administrator grant imported business roles but not delegate platform management', async () => {
  const f = await httpFixture(); await f.apply({ role: '@access-admin' });
  const catalog = await f.call('/catalog', undefined, 'alice');
  expect(catalog.body.apps[0].managementScopes[0].permissions).toEqual(['read', 'assign', 'directory']);
  const preview = await f.call('/preview', await f.change({ targetSub: 'bob' }), 'alice');
  expect(preview.status).toBe(200);
  expect((await f.call('/apply', { previewId: preview.body.previewId, idempotencyKey: preview.body.previewId }, 'alice')).status).toBe(200);
  expect((await f.service.authorize(f.actors.bob, { app: 'catalog-app', method: 'GET', path: '/records' })).allowed).toBe(true);
  for (const role of ['@access-admin', '@access-auditor']) {
    expect((await f.call('/preview', await f.change({ role, targetSub: 'bob' }), 'alice')).status).toBe(403);
    expect((await f.call('/preview', await f.change({ action: 'revoke', role }), 'alice')).status).toBe(403);
  }
  expect((await f.call('/preview', await f.change({ app: 'fallback-app', role: '@app-admin' }), 'alice')).status).toBe(403);
});

it('preserves exact tenant and issuer limits and executor ceilings for delegated administration', async () => {
  const f = await httpFixture(); f.actors.alice.tenantIds = ['tenant-one'];
  await f.apply({ role: '@access-admin', tenantId: 'tenant-one' });
  for (const tenantId of [undefined, 'tenant-two']) {
    expect((await f.call('/preview', await f.change({ targetSub: 'bob', tenantId }), 'alice')).status).toBe(403);
  }
  expect((await f.call('/preview', await f.change({ targetSub: 'bob', tenantId: 'tenant-one' }), 'alice')).status).toBe(200);
  await expect(f.service.catalog({ ...f.actors.alice, issuer: 'https://another.example' })).rejects.toMatchObject({ status: 403 });
  await expect(f.service.previewChange({ ...f.actors.alice, allowedPermissions: ['platform:authorization.read'] },
    await f.change({ targetSub: 'bob', tenantId: 'tenant-one' }))).rejects.toMatchObject({ status: 403 });
});

it('refuses self-sensitive grants and group escalation without independently verified approval', async () => {
  const f = await httpFixture(); await f.apply({ role: '@access-admin' });
  const change = await f.change({ role: 'sensitive-reader' });
  const preview = await f.call('/preview', change, 'alice');
  expect(preview.body.requiresApproval).toBe(true);
  expect((await f.call('/apply', { previewId: preview.body.previewId, idempotencyKey: preview.body.previewId,
    approvalReference: 'caller-invented' }, 'alice')).status).toBe(403);
  const group = await f.call('/preview', { ...change, action: 'group-map', targetSub: undefined, targetIssuer: undefined,
    group: { issuer: ISSUER, tenantId: 'directory-tenant', id: 'group-one' } }, 'alice');
  expect(group.status).toBe(200); expect(group.body.requiresApproval).toBe(true);
});

it('revokes pending management immediately and never converts its cached scopes into durable authority', async () => {
  const f = await directFixture(); await f.change();
  const preview = await f.service.previewChange(manager, { action: 'grant', app: 'catalog-app', role: 'reader',
    targetSub: 'other', targetIssuer: ISSUER, reason: 'Pending business access', expectedRevision: (await f.store.read()).revision });
  await f.change({ action: 'revoke' });
  await expect(f.service.applyChange(manager, { previewId: preview.previewId, idempotencyKey: preview.previewId })).rejects.toMatchObject({ status: 403 });
  await expect(f.service.catalog(manager)).rejects.toMatchObject({ status: 403 });
  expect((await f.store.read()).assignments).toEqual([]);
});

it('fails closed for disabled accounts, expired roles, source changes and removed applications', async () => {
  const f = await directFixture(); await f.change({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
  expect((await f.service.catalog(manager)).apps).toHaveLength(1); f.advance();
  await expect(f.service.catalog(manager)).rejects.toMatchObject({ status: 403 });
  await f.change({ expiresAt: undefined }); f.disable();
  await expect(f.service.catalog(manager)).rejects.toMatchObject({ status: 401 });
  await expect(f.service.registerApp({ ...f.registration, source: 'replacement' })).rejects.toMatchObject({ status: 409 });
  f.service.unregisterApp('catalog-app');
  await expect(f.service.catalog({ ...manager, sub: 'other' })).rejects.toMatchObject({ status: 403 });
});

it('honors whole-application deny before a direct access-management role', async () => {
  const f = await directFixture(); await f.change(); await f.change({ action: 'deny', role: undefined });
  await expect(f.service.catalog(manager)).rejects.toMatchObject({ status: 403 });
  const effective = await f.service.effective(admin, { app: 'catalog-app', targetSub: manager.sub, targetIssuer: manager.issuer });
  expect(effective.managementRoles).toEqual([]);
});

it('uses verified fresh group evidence for delegated management and rejects incomplete or stale evidence', async () => {
  const f = await directFixture(); const group = { issuer: ISSUER, tenantId: 'directory-tenant', id: 'delegated-group' };
  await f.change({ action: 'group-map', targetSub: undefined, targetIssuer: undefined, group, role: '@access-auditor' });
  const evidence = { issuer: ISSUER, tenantId: group.tenantId, groups: [group.id], complete: true, observedAt: new Date(Date.now() - 1000).toISOString() };
  expect((await f.service.catalog({ ...manager, directory: [evidence] })).apps).toHaveLength(1);
  for (const directory of [[], [{ ...evidence, complete: false }], [{ ...evidence, issuer: 'https://other.example' }],
    [{ ...evidence, observedAt: new Date(Date.now() - 600_000).toISOString() }]]) {
    await expect(f.service.catalog({ ...manager, directory })).rejects.toMatchObject({ status: 403 });
  }
});

it('advertises registered tool writes only while the persisted access-administrator role remains current', async () => {
  const f = await httpFixture(); await f.apply({ role: '@access-admin' });
  const tool = new AuthorizationToolRuntime(f.service);
  expect((await tool.discover(f.actors.alice, true)).find(row => row.name === 'swarm_authorization')?.operations).toContain('preview_change');
  await f.apply({ action: 'revoke', role: '@access-admin' });
  expect(await tool.discover(f.actors.alice, true)).toEqual([]);
  await f.apply({ role: '@access-auditor' });
  const reads = await tool.discover(f.actors.alice, true);
  expect(reads).toHaveLength(1); expect(reads[0].operations).not.toContain('preview_change');
});

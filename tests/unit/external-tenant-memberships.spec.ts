/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove exact business membership, current authority, audit isolation and atomic PostgreSQL behavior.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { ApplicationAuthorizationService, PostgresAuthorizationStore } from '@/features/application-authorization';
import { ExternalTenantMembershipService, PostgresExternalTenantMembershipStore } from '@/features/external-tenant-memberships';
import { EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP, type AuthorizationActor } from '@/shared/application-authorization';
import { LOCAL_AUTH_PRINCIPAL_ISSUER, MOCK_OIDC_PRINCIPAL_ISSUER, GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { ExternalMembershipFixture, BUSINESS_TENANT, GOOGLE_ISSUER, MICROSOFT_ISSUER, MICROSOFT_TENANT } from '../fixtures/external-tenant-memberships';
import { CATALOG } from '../fixtures/authorization';

const fixture = new ExternalMembershipFixture();
beforeAll(async () => { vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP',''); await fixture.start(); }, 90_000);
beforeEach(async () => { await fixture.reset(); });
afterAll(async () => { await fixture.close(); vi.unstubAllEnvs(); }, 30_000);

it('persists exact issuer and subject across restart without merging matching provider emails or local users', async () => {
  await fixture.apply();
  const restart = new PostgresExternalTenantMembershipStore(fixture.pool);
  expect(await restart.tenantIds(fixture.google.sub,GOOGLE_ISSUER)).toEqual([BUSINESS_TENANT]);
  expect(await restart.tenantIds(fixture.google.sub,MICROSOFT_ISSUER)).toEqual([]);
  expect(await restart.tenantIds(fixture.google.sub,LOCAL_AUTH_PRINCIPAL_ISSUER)).toEqual([]);
  expect((await restart.catalog()).revision).toBe(1);
  expect((await fixture.database.owner.query('SELECT payload FROM oshal_authorization_audit')).rows[0].payload)
    .toMatchObject({ revision: 1,actor: { sub: fixture.admin.sub,issuer: GOOGLE_ISSUER },change: { app: EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP,role: 'member' } });
});

it('requires existing business tenants and refuses provider tid as membership authority', async () => {
  await expect(fixture.service.preview(fixture.admin,await fixture.change({ tenantId: MICROSOFT_TENANT })))
    .rejects.toMatchObject({ code: 'tenant_membership_tenant_unknown' });
  const actor = { ...fixture.microsoft,directory: [{ issuer: MICROSOFT_ISSUER,tenantId: BUSINESS_TENANT,
    groups: ['staff'],complete: true,observedAt: new Date().toISOString() }] };
  expect((await fixture.refreshActor(actor))?.tenantIds).toEqual([]);
  expect((await fixture.store.catalog()).memberships).toEqual([]);
});

it('rejects unknown, disabled, linked-canonical and disabled-provider grant targets without inventing an issuer', async () => {
  await expect(fixture.service.preview(fixture.admin,await fixture.change({ targetIssuer: 'https://unknown.example.test' })))
    .rejects.toMatchObject({ code: 'tenant_membership_active_external_identity_required' });
  await fixture.database.owner.query("UPDATE oshal_verified_principals SET status='disabled' WHERE issuer=$1",[GOOGLE_ISSUER]);
  await expect(fixture.apply()).rejects.toMatchObject({ code: 'tenant_membership_active_external_identity_required' });
  await fixture.database.owner.query("UPDATE oshal_verified_principals SET status='active',canonical_local_sub='existing-local' WHERE issuer=$1",[GOOGLE_ISSUER]);
  await expect(fixture.apply()).rejects.toMatchObject({ code: 'tenant_membership_active_external_identity_required' });
  fixture.env.MICROSOFT_LOGIN = 'false';
  await expect(fixture.apply({ targetIssuer: MICROSOFT_ISSUER })).rejects.toMatchObject({ code: 'tenant_membership_active_external_identity_required' });
});

it('refuses kernel identity namespaces and unknown authority-bearing input fields', async () => {
  for (const targetIssuer of [LOCAL_AUTH_PRINCIPAL_ISSUER,MOCK_OIDC_PRINCIPAL_ISSUER,GUEST_PRINCIPAL_ISSUER]) {
    expect((await fixture.call('/preview',await fixture.change({ targetIssuer }))).status).toBe(400);
  }
  expect((await fixture.call('/preview',{ ...await fixture.change(),isSwarmAdmin: true })).status).toBe(400);
  expect((await fixture.call('/catalog?targetSub=other')).status).toBe(400);
  expect((await fixture.store.catalog()).revision).toBe(0);
});

it('denies ordinary and delegated app administrators, including attenuation on original or refreshed admins', async () => {
  const manager = { ...fixture.google,managementScopes: [{ app: EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP,permissions: ['read','assign','directory'] as const }] };
  await expect(fixture.service.catalog(manager as unknown as AuthorizationActor)).rejects.toMatchObject({ status: 403 });
  await expect(fixture.service.catalog({ ...fixture.admin,allowedPermissions: [] })).rejects.toMatchObject({ status: 403 });
  await expect(fixture.service.preview({ ...fixture.admin,allowedPermissions: ['platform:authorization.assign'] },await fixture.change()))
    .rejects.toMatchObject({ status: 403 });
  const original = { ...fixture.admin }; fixture.admin.allowedPermissions = ['platform:authorization.read'];
  await expect(fixture.service.preview(original,await fixture.change())).rejects.toMatchObject({ status: 403 });
});

it('requires same-origin JSON writes and authenticated catalog access without side effects', async () => {
  expect((await fixture.call('/catalog',undefined,'anonymous')).status).toBe(401);
  expect((await fixture.call('/catalog',undefined,'google')).status).toBe(403);
  expect((await fixture.call('/preview',await fixture.change(),'admin',{ origin: 'https://foreign.example.test' })).status).toBe(403);
  const catalog = await fixture.call('/catalog'); expect(catalog.headers.get('cache-control')).toBe('private, no-store');
  expect(catalog.body.tenants).toEqual([{ tenantId: BUSINESS_TENANT,name: 'Business fixture' }]);
  expect((await fixture.store.catalog()).revision).toBe(0);
});

it('applies real HTTP previews once and rechecks administration before returning an idempotent receipt', async () => {
  const preview = await fixture.call('/preview',await fixture.change()); expect(preview.status).toBe(200);
  const input = { previewId: preview.body.previewId,idempotencyKey: preview.body.previewId };
  const first = await fixture.call('/apply',input); expect(first.status).toBe(200);
  expect((await fixture.call('/apply',input)).body).toEqual(first.body);
  fixture.admin.isSwarmAdmin = false; expect((await fixture.call('/apply',input)).status).toBe(403);
  expect((await fixture.database.owner.query('SELECT count(*)::int AS total FROM oshal_authorization_audit')).rows[0].total).toBe(1);
});

it('rejects expired, differently owned and globally stale previews without changing memberships', async () => {
  const preview = await fixture.service.preview(fixture.admin,await fixture.change());
  const input = { previewId: preview.previewId,idempotencyKey: preview.previewId };
  const foreignService = new ExternalTenantMembershipService(fixture.store,{ refreshActor: async actor => actor,resolveTarget: fixture.directory.targetActor });
  await expect(foreignService.apply({ ...fixture.admin,issuer: MICROSOFT_ISSUER },input)).rejects.toMatchObject({ status: 404 });
  fixture.now += 300_001; await expect(fixture.service.apply(fixture.admin,input)).rejects.toMatchObject({ code: 'tenant_membership_preview_expired' });
  fixture.now = Date.now(); await fixture.database.owner.query('UPDATE oshal_authorization_state SET revision=revision+1');
  await expect(fixture.service.apply(fixture.admin,input)).rejects.toMatchObject({ code: 'tenant_membership_revision_changed' });
  expect((await fixture.store.catalog()).memberships).toEqual([]);
});

it('allows cleanup after target disable and refuses account or tenant removal between preview and apply', async () => {
  const preview = await fixture.service.preview(fixture.admin,await fixture.change());
  await fixture.database.owner.query("UPDATE oshal_verified_principals SET status='disabled' WHERE issuer=$1",[GOOGLE_ISSUER]);
  await expect(fixture.service.apply(fixture.admin,{ previewId: preview.previewId,idempotencyKey: preview.previewId }))
    .rejects.toMatchObject({ code: 'tenant_membership_active_external_identity_required' });
  await fixture.apply({ targetIssuer: MICROSOFT_ISSUER }); fixture.env.MICROSOFT_LOGIN = 'false';
  await expect(fixture.apply({ action: 'revoke',targetIssuer: MICROSOFT_ISSUER })).resolves.toMatchObject({ applied: true });
  const removed = await fixture.service.preview(fixture.admin,await fixture.change({ action: 'revoke' }));
  await fixture.database.owner.query('DELETE FROM oshal_tenants WHERE tenant_id=$1',[BUSINESS_TENANT]);
  await expect(fixture.service.apply(fixture.admin,{ previewId: removed.previewId,idempotencyKey: removed.previewId }))
    .rejects.toMatchObject({ code: 'tenant_membership_tenant_unknown' });
});

it('shares policy revision with concurrent writes and releases the single pool connection before actor/provider reads', async () => {
  const first = await fixture.service.preview(fixture.admin,await fixture.change());
  const second = await fixture.service.preview(fixture.admin,await fixture.change({ targetIssuer: MICROSOFT_ISSUER }));
  const results = await Promise.allSettled([first,second].map(preview => fixture.service.apply(fixture.admin,
    { previewId: preview.previewId,idempotencyKey: preview.previewId })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await fixture.store.catalog()).revision).toBe(1);
}, 10_000);

it('forces control-plane RLS on membership and preview tables for ordinary SQL readers and writers', async () => {
  await fixture.apply();
  expect((await fixture.pool.query('SELECT * FROM oshal_external_tenant_memberships')).rowCount).toBe(0);
  expect((await fixture.pool.query('SELECT * FROM oshal_external_tenant_previews')).rowCount).toBe(0);
  await expect(fixture.pool.query('INSERT INTO oshal_external_tenant_memberships(issuer,user_sub,tenant_id) VALUES($1,$2,$3)',
    [MICROSOFT_ISSUER,'forged',BUSINESS_TENANT])).rejects.toMatchObject({ code: '42501' });
  expect((await fixture.pool.query('DELETE FROM oshal_external_tenant_memberships')).rowCount).toBe(0);
  expect(await fixture.store.tenantIds(fixture.google.sub,GOOGLE_ISSUER)).toEqual([BUSINESS_TENANT]);
});

it('keeps global membership history inaccessible to delegated app readers and reserves its package name', async () => {
  await fixture.apply(); const service = new ApplicationAuthorizationService(new PostgresAuthorizationStore(fixture.pool));
  await expect(service.registerApp({ app: EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP,source: 'package',version: '1',catalog: null,mode: 'enforce' }))
    .rejects.toMatchObject({ code: 'authorization_app_name_reserved' });
  const scoped = { ...fixture.google,managementScopes: [{ app: EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP,permissions: ['read'] as Array<'read'> }] };
  await expect(service.auditHistory(scoped,{ app: EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP })).rejects.toMatchObject({ status: 403 });
  const history = await service.auditHistory(fixture.admin,{ app: EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP });
  expect(history.entries).toHaveLength(1); expect(history.entries[0]).not.toHaveProperty('reason');
});

it('requires a named business grant plus current exact membership and revokes tenant access immediately', async () => {
  const store = new PostgresAuthorizationStore(fixture.pool);
  const service = new ApplicationAuthorizationService(store,{ refreshActor: fixture.refreshActor,resolveActor: fixture.directory.targetActor });
  const catalog = structuredClone(CATALOG); catalog.resources.records.scopes = ['tenant']; catalog.roles.reader.grants[0].scope = 'tenant';
  catalog.roles['sensitive-reader'].grants[0].scope = 'tenant';
  await service.registerApp({ app: 'catalog-app',source: 'fixture',version: '1',catalog,mode: 'enforce',
    adapters: { records: { authorize: async ({ actor,operation }) => actor.issuer === GOOGLE_ISSUER && actor.tenantIds?.includes(operation.tenantId!) === true } } });
  const operation = { app: 'catalog-app',method: 'GET',path: '/records',tenantId: BUSINESS_TENANT };
  await fixture.apply(); expect((await service.authorize(fixture.google,operation)).allowed).toBe(false);
  const preview = await service.previewChange(fixture.admin,{ app: 'catalog-app',action: 'grant',role: 'reader',targetSub: fixture.google.sub,
    targetIssuer: GOOGLE_ISSUER,tenantId: BUSINESS_TENANT,reason: 'Business read authorization',expectedRevision: 1 });
  await service.applyChange(fixture.admin,{ previewId: preview.previewId,idempotencyKey: preview.previewId });
  expect((await service.authorize(fixture.google,operation)).allowed).toBe(true);
  expect((await service.authorize(fixture.microsoft,operation)).allowed).toBe(false);
  await fixture.apply({ action: 'revoke' });
  expect((await service.authorize({ ...fixture.google,tenantIds: [BUSINESS_TENANT] },operation)).reason).toBe('authorization_tenant_denied');
});

it('grants and revokes from the actual Users page with review and no application permission changes', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-user': 'admin' } });
    await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
    const page = await context.newPage(); await page.goto(fixture.base + '/users');
    await expect.poll(() => page.locator('#rosterCount').textContent()).toBe('2 / 2');
    await page.locator('#businessMemberships summary').click(); await page.locator('#membershipRefresh').click();
    await page.locator('#membershipForm').waitFor({ state: 'visible' });
    await page.locator('#membershipUser').selectOption(JSON.stringify([GOOGLE_ISSUER,fixture.google.sub]));
    await page.locator('#membershipTenant').selectOption(BUSINESS_TENANT);
    await page.locator('#membershipReason').fill('Reviewed business workspace membership');
    await page.locator('#membershipPreviewButton').click(); await page.locator('#membershipReview').waitFor({ state: 'visible' });
    expect(await page.locator('#membershipReviewText').textContent()).toContain('Application permissions do not change.');
    expect((await fixture.store.catalog()).memberships).toEqual([]);
    await page.locator('#membershipApply').click();
    await expect.poll(() => page.locator('#membershipRows tbody tr').count()).toBe(1);
    expect(await fixture.store.tenantIds(fixture.google.sub,GOOGLE_ISSUER)).toEqual([BUSINESS_TENANT]);
    await page.locator('#membershipAction').selectOption('revoke');
    await page.locator('#membershipPreviewButton').click(); await page.locator('#membershipReview').waitFor({ state: 'visible' });
    await page.locator('#membershipApply').click();
    await expect.poll(() => page.locator('#membershipRows tbody tr').count()).toBe(0);
    expect((await new PostgresAuthorizationStore(fixture.pool).read()).assignments).toEqual([]);
    expect(await fixture.store.tenantIds(fixture.google.sub,GOOGLE_ISSUER)).toEqual([]);
    await context.close();
  } finally { await browser.close(); }
}, 30_000);

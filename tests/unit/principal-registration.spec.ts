/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify reviewed roster import, issuer separation, PostgreSQL RLS, HTTP boundaries and unchanged account authority.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove metadata cannot supply authority and discard obsolete asynchronous browser previews.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { PrincipalRegistrationStore, RosterImportSchema } from '@/features/principal-directory/registration-store';
import { REGISTRATION_SCHEMA } from '@/features/principal-directory/registration-schema';
import { createApplicationPrincipalDirectory } from '@/app/composition/application-principal-directory';
import { PrincipalDirectoryStore } from '@/features/principal-directory';
import { refreshPrivilegedCache } from '@/features/swarm-roles';
import { chromium } from 'playwright';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { LocalAccountFixture } from '../fixtures/local-account-administration';

const database = new LocalAccountFixture(); let store: PrincipalRegistrationStore; let now = Date.now();
const google = 'https://accounts.google.com'; const other = 'https://identity.example.test';
const admin: AuthorizationActor = { sub: 'operator', issuer: google, isActive: true, isSwarmAdmin: true };
const entry = { issuer: google, sub: 'registered-person', displayName: '<script>Label</script>', email: 'person@example.test' };
const input = (expectedRevision = 0) => ({ source: 'directory-snapshot', reason: 'Reviewed fixture directory export', expectedRevision, entries: [entry] });
beforeAll(async () => { vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', ''); await database.start(); store = new PrincipalRegistrationStore(database.runtime, () => now); }, 90_000);
beforeEach(async () => { await database.reset(); now = Date.now(); });
afterAll(async () => { await database.close(); vi.unstubAllEnvs(); }, 30_000);

it('persists exact identities after review and restart without verifying sign-in or granting a role', async () => {
  const preview = await store.preview(admin, { ...input(), entries: [entry, { ...entry, issuer: other }] });
  expect(await store.list()).toEqual([]);
  expect(await store.apply(admin, { previewId: preview.previewId })).toMatchObject({ applied: true, revision: 1, count: 2 });
  expect(await new PrincipalRegistrationStore(database.runtime).list()).toHaveLength(2);
  const directory = createApplicationPrincipalDirectory(database.runtime, Promise.resolve(), {
    OIDC_ISSUER_URL: google, OIDC_CLIENT_ID: 'fixture', OIDC_CLIENT_SECRET: 'fixture',
  });
  expect((await directory.inventory(admin)).users.filter(user => user.sub === entry.sub)).toHaveLength(2);
  expect(await directory.targetActor(entry.sub, google)).toBeNull();
  expect(await directory.nativePrincipal(entry.sub, google)).toEqual({ isActive: false, isSwarmAdmin: false });
  expect((await database.owner.query('SELECT * FROM oshal_verified_principals')).rowCount).toBe(0);
  expect((await database.owner.query('SELECT * FROM swarm_roles')).rowCount).toBe(2);
});

it('requires current administration and the exact preview actor while retries are idempotent', async () => {
  const preview = await store.preview(admin, input()); const request = { previewId: preview.previewId };
  await expect(store.apply({ ...admin, isSwarmAdmin: false }, request)).rejects.toMatchObject({ status: 403 });
  await expect(store.apply({ ...admin, allowedPermissions: ['platform:authorization.read'] }, request)).rejects.toMatchObject({ code: 'roster_scope_denied' });
  await expect(store.apply({ ...admin, issuer: other }, request)).rejects.toMatchObject({ code: 'roster_preview_actor_mismatch' });
  const first = await store.apply(admin, request); expect(await store.apply(admin, request)).toEqual(first);
  expect((await database.owner.query('SELECT * FROM oshal_roster_audit')).rowCount).toBe(1);
});

it('serializes conflicting previews and rejects stale or expired input without partial writes', async () => {
  const one = await store.preview(admin, input()); const two = await store.preview(admin, input());
  const result = await Promise.allSettled([store.apply(admin, { previewId: one.previewId }), store.apply(admin, { previewId: two.previewId })]);
  expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter(item => item.status === 'rejected')).toMatchObject([{ reason: { code: 'roster_revision_changed' } }]);
  const expired = await store.preview(admin, input(1)); now += 600_001;
  await expect(store.apply(admin, { previewId: expired.previewId })).rejects.toMatchObject({ status: 410 });
  expect(await store.revision()).toBe(1);
});

it('uses the same additive migration and hides directory and audit rows from ordinary SQL', async () => {
  expect(readFileSync('scripts/migrations/134-principal-registrations.sql', 'utf8')).toContain(REGISTRATION_SCHEMA.join(';\n'));
  const preview = await store.preview(admin, input()); await store.apply(admin, { previewId: preview.previewId });
  for (const table of ['oshal_principal_registrations', 'oshal_roster_previews', 'oshal_roster_audit']) {
    expect((await database.runtime.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
  }
  expect((await database.owner.query("SELECT count(*) FROM pg_class WHERE relname LIKE 'oshal_roster_%' AND relrowsecurity AND relforcerowsecurity")).rows[0].count).toBe('3');
});

it('rejects role injection, local account fabrication, duplicate exact identities and oversized batches', () => {
  expect(RosterImportSchema.safeParse({ ...input(), roles: ['admin'] }).success).toBe(false);
  expect(RosterImportSchema.safeParse({ ...input(), entries: [{ ...entry, emailVerified: true }] }).success).toBe(false);
  expect(RosterImportSchema.safeParse({ ...input(), entries: [{ ...entry, issuer: 'urn:oshal:local-auth' }] }).success).toBe(false);
  expect(RosterImportSchema.safeParse({ ...input(), entries: [entry, entry] }).success).toBe(false);
  expect(RosterImportSchema.safeParse({ ...input(), entries: Array.from({ length: 251 }, (_, i) => ({ ...entry, sub: String(i) })) }).success).toBe(false);
});

it('protects the real HTTP roster and imports against anonymous, service, member and cross-origin requests', async () => {
  for (const caller of ['', 'service', 'member']) {
    const result = await database.post('/api/user-directory/preview', input(), caller);
    expect([401, 403]).toContain(result.status);
  }
  expect((await database.post('/api/user-directory/preview', input())).status).toBe(403);
  const headers = { 'x-fixture-user': 'admin', 'content-type': 'application/json', origin: database.base, 'x-oshal-access-request': '1' };
  const preview = await fetch(database.base + '/api/user-directory/preview', { method: 'POST', headers, body: JSON.stringify(input()) });
  expect(preview.status).toBe(200);
  const body = await preview.json();
  const cross = await fetch(database.base + '/api/user-directory/apply', { method: 'POST', headers: { ...headers, origin: 'https://other.example.test' }, body: JSON.stringify({ previewId: body.previewId }) });
  expect(cross.status).toBe(403); expect(await store.list()).toEqual([]);
});

it('shows issuerless references separately without inventing provider users', async () => {
  await database.owner.query('CREATE TABLE IF NOT EXISTS user_preferences(user_id TEXT)');
  await database.owner.query("INSERT INTO user_preferences(user_id) VALUES('legacy-unknown')");
  await database.owner.query('GRANT SELECT ON user_preferences TO users_runtime');
  const response = await fetch(database.base + '/api/user-directory', { headers: { 'x-fixture-user': 'admin' } });
  expect(response.status).toBe(200); const body = await response.json();
  expect(body.users.some((user: { sub: string }) => user.sub === 'legacy-unknown')).toBe(false);
  expect(body.historical.entries).toContainEqual({ sub: 'legacy-unknown', sources: ['Preferences'] });
  expect(body.users).toHaveLength(3);
});

it('never adopts imported operator-looking labels as verified email, account activation or provider authority', async () => {
  const observed = new PrincipalDirectoryStore(database.runtime);
  await observed.observe({ issuer: google,sub: entry.sub,provider: 'google',email: 'untrusted@example.test',emailVerified: false,
    displayName: 'Verified account label',canonicalLocalSub: null });
  const directory = createApplicationPrincipalDirectory(database.runtime,Promise.resolve(),{ OIDC_ISSUER_URL: google,
    OIDC_CLIENT_ID: 'fixture',OIDC_CLIENT_SECRET: 'fixture',OSHAL_OPERATOR_EMAILS: 'operator@example.test' });
  const preview = await store.preview(admin,{ ...input(),entries: [{ ...entry,email: 'operator@example.test',displayName: 'Swarm Administrator' }] });
  await store.apply(admin,{ previewId: preview.previewId });
  expect(await directory.nativePrincipal(entry.sub,google)).toEqual({ isActive: true,isSwarmAdmin: false });
  expect(await observed.get(google,entry.sub)).toMatchObject({ email: 'untrusted@example.test',emailVerified: false,displayName: 'Verified account label' });
  await database.owner.query("UPDATE oshal_verified_principals SET status='disabled' WHERE issuer=$1 AND user_sub=$2",[google,entry.sub]);
  const update = await store.preview(admin,{ ...input(1),entries: [{ ...entry,email: 'operator@example.test' }] });
  await store.apply(admin,{ previewId: update.previewId });
  expect(await directory.nativePrincipal(entry.sub,google)).toEqual({ isActive: false,isSwarmAdmin: false });
  await database.owner.query("UPDATE oshal_verified_principals SET status='active' WHERE issuer=$1 AND user_sub=$2",[google,entry.sub]);
  const disabledProvider = createApplicationPrincipalDirectory(database.runtime,Promise.resolve(),{ LOCAL_AUTH: 'true' });
  expect(await disabledProvider.nativePrincipal(entry.sub,google)).toEqual({ isActive: false,isSwarmAdmin: false });
  expect((await database.owner.query('SELECT * FROM swarm_roles')).rowCount).toBe(2);
});

it('refuses a real HTTP apply after administrator revocation without consuming the saved preview', async () => {
  const headers = { 'x-fixture-user': 'admin','content-type': 'application/json',origin: database.base,'x-oshal-access-request': '1' };
  const response = await fetch(database.base + '/api/user-directory/preview',{ method: 'POST',headers,body: JSON.stringify(input()) });
  expect(response.status).toBe(200); const preview = await response.json();
  await database.owner.query("UPDATE swarm_roles SET role='user' WHERE user_sub=$1",[database.users.admin.userSub]);
  await refreshPrivilegedCache(database.runtime);
  const applied = await fetch(database.base + '/api/user-directory/apply',{ method: 'POST',headers,body: JSON.stringify({ previewId: preview.previewId }) });
  expect(applied.status).toBe(403); expect(await store.list()).toEqual([]);
  expect((await database.owner.query('SELECT receipt FROM oshal_roster_previews WHERE id=$1',[preview.previewId])).rows[0].receipt).toBeNull();
  expect((await database.owner.query('SELECT * FROM oshal_roster_audit')).rowCount).toBe(0);
});

it('prevents ordinary SQL from forging roster labels or replacing reviewed imports through forced RLS', async () => {
  const preview = await store.preview(admin,input());
  await expect(database.runtime.query(`INSERT INTO oshal_principal_registrations(issuer,user_sub,display_name,source)
    VALUES($1,$2,$3,'manual')`,[google,'forged','Root'])).rejects.toMatchObject({ code: '42501' });
  expect((await database.runtime.query('UPDATE oshal_roster_previews SET payload=$1 WHERE id=$2',
    [JSON.stringify({ ...input(),entries: [{ ...entry,sub: 'replacement' }] }),preview.previewId])).rowCount).toBe(0);
  await store.apply(admin,{ previewId: preview.previewId });
  expect(await store.list()).toEqual([{ ...entry,source: 'directory-snapshot' }]);
});

it.each(['edit','refresh'] as const)('does not restore a late Users roster preview after %s discards it', async action => {
  const browser = await chromium.launch({ headless: true }); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const context = await browser.newContext(); await context.addCookies([{ name: 'fixture',value: 'admin',url: database.base }]);
    await context.route('**/*',route => new URL(route.request().url()).origin === database.base ? route.continue() : route.abort());
    const page = await context.newPage(); await page.goto(database.base + '/users');
    await page.locator('#providerAccountsCard').waitFor({ state: 'visible' });
    await page.locator('#rosterImport summary').click();
    await page.locator('#rosterEntries').fill(JSON.stringify([entry])); await page.locator('#rosterReason').fill('Reviewed identity import');
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    await page.route('**/api/user-directory/preview',async route => {
      const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
    });
    await page.locator('#rosterPreviewButton').click(); await waiting;
    if (action === 'edit') await page.locator('#rosterEntries').fill(JSON.stringify([{ ...entry,sub: 'other-selected-user' }]));
    else await page.locator('#refreshBtn').click();
    release(); await expect.poll(() => page.locator('#rosterPreviewButton').isEnabled()).toBe(true);
    expect(await page.locator('#rosterReview').isHidden()).toBe(true); expect(await store.list()).toEqual([]);
    await context.close();
  } finally { release(); await browser.close(); }
}, 30_000);

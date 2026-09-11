/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real Users invitations and account suspension plus root and nonadministrator UI fences in Chromium.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Bound browser case registration while retaining the suite and browser/database hook scope.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { LocalAccountFixture, fixturePassword, fixtureServiceSecret } from '../fixtures/local-account-administration';
import { refreshPrivilegedCache } from '@/features/swarm-roles';

const fixture = new LocalAccountFixture();
let browser: Browser, context: BrowserContext, page: Page;
beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET', 'isolated-session-signing-secret-for-users-browser'); vi.stubEnv('SWARM_SERVICE_SECRET', fixtureServiceSecret);
  vi.stubEnv('OSHAL_OPERATOR_SUBS', ''); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', ''); vi.stubEnv('LOCAL_AUTH_PUBLIC_URL', ''); vi.stubEnv('APP_URL', ''); vi.stubEnv('SMTP_HOST', ''); vi.stubEnv('LOG_LEVEL', 'silent');
  await fixture.start(); browser = await chromium.launch({ headless: true });
}, 90_000);
beforeEach(async () => {
  await fixture.reset(); context = await browser.newContext();
  await context.addCookies([{ name: 'fixture', value: 'admin', url: fixture.base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage(); page.on('dialog', dialog => dialog.accept());
});
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); await fixture.close(); vi.unstubAllEnvs(); }, 30_000);
async function openUsers() {
  await page.goto(fixture.base + '/users');
  await page.locator('#accountsCard').waitFor({ state: 'visible' });
}

/** Register established account rendering and the complete local invitation workflow. */
function registerAccountWorkflowCases() {
  it('shows established accounts and protects root while showing verified provider identities without local suspension controls', async () => {
    await fixture.externalIdentity(); await openUsers();
    expect(await page.locator('#accountsCount').textContent()).toBe('3 accounts');
    const root = page.locator('#accountsBody tr').filter({ hasText: 'root@example.test' });
    expect(await root.locator('button').count()).toBe(0);
    expect(await root.textContent()).toContain('Transfer root before disabling');
    await page.locator('#providerAccountsCard').waitFor({ state: 'visible' });
    expect(await page.locator('#providerAccounts').textContent()).toContain('https://accounts.google.com / external-person');
    expect(await page.locator('#providerAccounts img').count()).toBe(0);
    expect(await page.locator('#providerAccountsCard button').count()).toBe(0);
    expect(await page.locator('#providerAccountsCard').textContent()).toContain('remain with their identity provider');
  });

  it('invites, displays the one-time link, activates, disables and re-enables an account through real APIs', async () => {
    await openUsers();
    await page.locator('#inviteEmail').fill('new-person@example.test'); await page.locator('#inviteName').fill('New Person');
    await page.getByRole('button', { name: 'Invite user', exact: true }).click();
    await page.locator('#inviteResult').waitFor({ state: 'visible' });
    const invite = await page.locator('#inviteLink').inputValue();
    expect(invite).toMatch(/^\/invite\?token=/);
    expect(await page.locator('#inviteDelivery').textContent()).toContain('one-time link');
    const token = new URL(invite, fixture.base).searchParams.get('token');
    expect((await fixture.post('/api/local-auth/accept', { token, password: fixturePassword }, '')).status).toBe(200);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const row = page.locator('#accountsBody tr').filter({ hasText: 'new-person@example.test' });
    await expect.poll(() => row.textContent()).toContain('active');
    await row.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect.poll(() => row.textContent()).toContain('disabled');
    expect((await fixture.post('/api/local-auth/login', { email: 'new-person@example.test', password: fixturePassword }, '')).status).toBe(401);
    await row.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect.poll(() => row.textContent()).toContain('active');
    expect((await fixture.post('/api/local-auth/login', { email: 'new-person@example.test', password: fixturePassword }, '')).status).toBe(200);
    await row.getByRole('button', { name: 'Reinvite', exact: true }).click();
    await expect.poll(() => page.locator('#inviteLink').inputValue()).not.toBe(invite);
  });

}

/** Register current-authority UI refusals with the existing per-case browser isolation. */
function registerAdministrationRefusalCases() {
  it('removes administration controls and invitation secrets when privileges are revoked during the session', async () => {
    await openUsers();
    await page.locator('#inviteEmail').fill('later@example.test'); await page.getByRole('button', { name: 'Invite user', exact: true }).click();
    await page.locator('#inviteResult').waitFor({ state: 'visible' });
    await fixture.owner.query("UPDATE swarm_roles SET role='user' WHERE user_sub=$1", [fixture.users.admin.userSub]);
    await refreshPrivilegedCache(fixture.runtime);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => page.locator('#rolesBody').textContent()).toContain('Only swarm administrators');
    expect(await page.locator('#accountsCard').isHidden()).toBe(true);
    expect(await page.locator('#grantForm').isHidden()).toBe(true);
    expect(await page.locator('#inviteLink').inputValue()).toBe('');
    expect((await fixture.post('/api/local-auth/users', { email: 'denied@example.test' })).status).toBe(403);
  });

  it('does not offer root election or account administration to an ordinary user even with no role rows', async () => {
    await fixture.owner.query('TRUNCATE swarm_roles'); await refreshPrivilegedCache(fixture.runtime);
    await context.addCookies([{ name: 'fixture', value: 'member', url: fixture.base }]);
    await page.goto(fixture.base + '/users');
    await expect.poll(() => page.locator('#rootBody').textContent()).toContain('existing operator');
    expect(await page.locator('#claimBtn').count()).toBe(0);
    expect(await page.locator('#accountsCard').isHidden()).toBe(true);
    expect(await page.locator('#grantForm').isHidden()).toBe(true);
    expect((await fixture.post('/api/swarm/roles/claim-root', {}, 'member')).status).toBe(403);
  });
}

describe('Users account administration browser', () => {
  registerAccountWorkflowCases();
  registerAdministrationRefusalCases();
});

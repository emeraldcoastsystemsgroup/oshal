/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real Users invitations and account suspension plus root and nonadministrator UI fences in Chromium.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Bound browser case registration while retaining the suite and browser/database hook scope.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Verify current operator access independently from root ownership and shared-theme contrast without Docker.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Verify exact roster links and reviewed metadata imports without sign-in or privilege changes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { LocalAccountFixture, fixturePassword, fixtureServiceSecret } from '../fixtures/local-account-administration';
import { refreshPrivilegedCache } from '@/features/swarm-roles';
import express from 'express';
import { resolve } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const fixture = new LocalAccountFixture();
let browser: Browser, context: BrowserContext, page: Page;
function registerDatabaseHooks() {
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
}
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
    const external = page.locator('#providerAccounts tr').filter({ hasText: 'external-person' });
    expect(await external.textContent()).toContain('https://accounts.google.com');
    expect(await page.locator('#providerAccounts img').count()).toBe(0);
    expect(await external.locator('button').count()).toBe(0);
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
  registerDatabaseHooks();
  registerAccountWorkflowCases();
  registerAdministrationRefusalCases();
  registerRosterCases();
});

/** Register exact user roster navigation and the reviewed registration workflow against actual SQL/API. */
function registerRosterCases() {
  it('registers reviewed provider identities without creating login accounts or access and links the exact target', async () => {
    await openUsers();
    await expect.poll(() => page.locator('#rosterCount').textContent()).toBe('3 / 3');
    await page.locator('#rosterImport summary').click();
    await page.locator('#rosterEntries').fill(JSON.stringify([{ issuer: 'https://identity.example.test', sub: 'exact-person',
      displayName: 'New <img src=x onerror=alert(1)> Person', email: 'new@example.test' }]));
    await page.locator('#rosterReason').fill('Review imported provider subject');
    await page.locator('#rosterPreviewButton').click();
    await page.locator('#rosterReview').waitFor({ state: 'visible' });
    expect((await fixture.owner.query('SELECT * FROM oshal_principal_registrations')).rowCount).toBe(0);
    expect(await page.locator('#rosterReviewText').textContent()).toContain('Does not enable sign-in');
    await page.locator('#rosterApply').click();
    await expect.poll(() => page.locator('#rosterCount').textContent()).toBe('4 / 4');
    await page.locator('#rosterSearch').fill('exact-person');
    const row = page.locator('#providerAccounts tbody tr');
    expect(await row.count()).toBe(1); expect(await row.textContent()).toContain('provider-disabled');
    const link = new URL((await row.locator('a').getAttribute('href'))!, fixture.base);
    expect(link.searchParams.get('issuer')).toBe('https://identity.example.test');
    expect(link.searchParams.get('sub')).toBe('exact-person');
    expect(await page.locator('#providerAccounts img').count()).toBe(0);
    expect((await fixture.owner.query('SELECT * FROM oshal_local_users')).rowCount).toBe(3);
    expect((await fixture.owner.query('SELECT * FROM swarm_roles')).rowCount).toBe(2);
    expect((await fixture.owner.query('SELECT * FROM oshal_verified_principals')).rowCount).toBe(0);
  });
}

function statusResponse() {
  return { me: { sub: 'existing-operator', role: 'user', isOperator: true, breakGlassOnly: true, isRoot: false },
    status: { rootClaimed: false, callerIsRoot: false, callerIsOperator: true, callerBreakGlassOnly: true,
      rolesLoaded: true, privilegedCount: 0 } };
}
let statusState = statusResponse();
let statusServer: http.Server, statusBase: string, statusBrowser: Browser, statusContext: BrowserContext, statusPage: Page;
const statusWrites: string[] = [];
function registerStatusHooks() {
  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => { if (req.method !== 'GET') statusWrites.push(req.path); next(); });
    app.get('/users', (_req, res) => res.sendFile(resolve('src/pages/users/index.html')));
    app.get('/api/swarm/roles/me', (_req, res) => res.json(statusState.me));
    app.get('/api/swarm/roles/status', (_req, res) => res.json(statusState.status));
    app.get('/api/swarm/roles', (_req, res) => res.json({ roles: [] }));
    app.get('/api/local-auth/users', (_req, res) => res.status(404).json({ error: 'oidc_mode' }));
    app.get('/api/authorization/catalog', (_req, res) => res.json({ users: [] }));
    app.get('/api/user-directory', (_req, res) => res.json({ revision: 0, users: [], providers: [], historical: { entries: [], truncated: false } }));
    app.use('/shared/ui/css', express.static(resolve('src/shared/ui/css')));
    app.use('/cockpit/css/themes', express.static(resolve('src/pages/cockpit/css/themes')));
    statusServer = http.createServer(app);
    await new Promise<void>(done => statusServer.listen(0, '127.0.0.1', done));
    statusBase = `http://127.0.0.1:${(statusServer.address() as AddressInfo).port}`;
    statusBrowser = await chromium.launch({ headless: true });
  });
  beforeEach(async () => {
    statusState = statusResponse(); statusWrites.length = 0; statusContext = await statusBrowser.newContext();
    await statusContext.route('**/*', route => new URL(route.request().url()).origin === statusBase ? route.continue() : route.abort());
    statusPage = await statusContext.newPage();
  });
  afterEach(async () => { expect(statusWrites).toEqual([]); await statusContext?.close(); });
  afterAll(async () => {
    await statusBrowser?.close(); statusServer?.closeAllConnections();
    if (statusServer) await new Promise<void>(done => statusServer.close(() => done()));
  });
}
async function openStatus() {
  await statusPage.goto(statusBase + '/users');
  await expect.poll(() => statusPage.locator('#currentAccessBody').textContent()).not.toContain('Loading');
}
function registerStatusCases() {
  it('shows environment-backed administrator access with unclaimed root and no saved roles', async () => {
    await openStatus();
    expect(await statusPage.locator('#currentAccessBody').textContent()).toContain('You have swarm administrator access.');
    expect(await statusPage.locator('#currentAccessBody').textContent()).toContain('configured operator allowlist');
    expect(await statusPage.locator('#rootPill').textContent()).toBe('unclaimed');
    expect(await statusPage.locator('#claimBtn').isVisible()).toBe(true);
    expect(await statusPage.locator('#rootBody').textContent()).toContain('separate from your current access');
    await expect.poll(() => statusPage.locator('#rolesBody').textContent()).toContain('No saved roles');
  });
  it('keeps environment-backed administrator status when another identity owns root', async () => {
    statusState.status.rootClaimed = true; await openStatus();
    expect(await statusPage.locator('#rootPill').textContent()).toBe('claimed');
    expect(await statusPage.locator('#currentAccessBody').textContent()).toContain('You have swarm administrator access.');
    expect(await statusPage.locator('#rootBody').textContent()).not.toContain('not an administrator');
    expect(await statusPage.locator('#claimBtn').count()).toBe(0);
    expect(await statusPage.locator('#grantForm').isVisible()).toBe(true);
  });
  it('identifies a saved admin role without claiming that unassigned root implies environment access', async () => {
    statusState.me.role = 'admin'; statusState.status.callerBreakGlassOnly = false; await openStatus();
    expect(await statusPage.locator('#currentAccessBody').textContent()).toContain('saved admin role');
    expect(await statusPage.locator('#currentAccessBody').textContent()).not.toContain('environment settings');
    expect(await statusPage.locator('#rootBody').textContent()).not.toContain('depends on');
  });
  it('shows ordinary access without root-claim or role-administration controls', async () => {
    statusState.status.callerIsOperator = false; statusState.status.callerBreakGlassOnly = false; await openStatus();
    expect(await statusPage.locator('#currentAccessBody').textContent()).toContain('standard user access');
    expect(await statusPage.locator('#claimBtn').count()).toBe(0);
    expect(await statusPage.locator('#grantForm').isHidden()).toBe(true);
  });
}
function registerContrastCases() {
  it.each(['midnight', 'daylight'])('keeps heading and card copy readable with the actual %s theme', async theme => {
    await statusPage.addInitScript(value => localStorage.setItem('cockpit-theme', value), theme); await openStatus();
    const ratios = await statusPage.evaluate(() => {
      const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => value / 255);
        const channels = rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const ratio = (foreground: string, background: string) => {
        const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (values[0] + .05) / (values[1] + .05);
      };
      const color = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      return [ratio(color('h1').color, color('body').backgroundColor),
        ratio(color('#currentAccessBody .sub').color, color('#currentAccessCard').backgroundColor)];
    });
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
}
describe('Users authority status browser', () => {
  registerStatusHooks(); registerStatusCases(); registerContrastCases();
});

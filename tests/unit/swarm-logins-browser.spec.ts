/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-4), driven in headless Chromium against the real /swarm-admin/logins page served through the real surface registration, with the admin API and the vendors' routes mocked: the import and sign-in panels are hidden until asked for and close on Cancel; "Sign in here" shows the link the real start reply carries (authUrl), says "Already signed in." without a panel when the start reply says so, and hides the link when there is none; an outcome (sign-in, import, sign-out) is still on the card after the rebuild; the import button follows each login's own adoption standing (Codex offered to a non-demo operator, the gated three not); a sign-out that leaves a login present or expired says so; no reply's account email ever appears on the page; a 403 shows the operator-role banner. Each fails if its fix returns.
 */

import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Request, type RequestHandler } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { requireAdminConsoleAccess } from '@/features/governance/rbac/policy';
import { registerUiSurfaceRoutes } from '@/app/routes/ui-surface-routes';
import { resolveUiSurfacePages, sendHtmlResponse } from '@/app/server-ui-assets';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';

const OPERATOR = { sub: 'idp-operator', email: 'operator@example.test', iss: 'https://login.example.test/tenant' };
const SECRET_EMAIL = 'secret-person@example.test';
const IDS = ['claude-code', 'openai-codex', 'gemini', 'antigravity'] as const;
type Id = typeof IDS[number];
type LoginState = { connected: boolean; expired: boolean };
type Gate = 'ok' | 'not-demo' | 'not-operator-subject';

const RAILS: Record<Id, Record<string, string>> = {
  'claude-code': { status: '/api/claude-code/auth/status', start: '/api/claude-code/auth/start', submitCode: '/api/claude-code/auth/submit-code', import: '/api/claude-code/auth/import', signout: '/api/claude-code/auth/signout' },
  'openai-codex': { status: '/api/openai-codex/oauth/status', import: '/api/openai-codex/oauth/import', signout: '/api/openai-codex/oauth/signout' },
  gemini: { status: '/api/gemini/auth/status', import: '/api/gemini/auth/import', signout: '/api/gemini/auth/signout' },
  antigravity: { status: '/api/antigravity/auth/status', import: '/api/antigravity/auth/import', signout: '/api/antigravity/auth/signout' },
};

/** The mocked swarm: each login's state, this caller's gate, the start reply's shape, and what the API answers. */
const swarm = {
  state: {} as Record<Id, LoginState>,
  gate: 'ok' as Gate,
  start: 'real' as 'real' | 'already' | 'nourl',
  api: 'normal' as 'normal' | '403',
  requests: [] as string[],
  reset(overrides: Partial<Record<Id, LoginState>> = {}) {
    this.state = { 'claude-code': { connected: false, expired: false }, 'openai-codex': { connected: false, expired: false }, gemini: { connected: false, expired: false }, antigravity: { connected: false, expired: false }, ...overrides };
    this.gate = 'ok'; this.start = 'real'; this.api = 'normal'; this.requests = [];
  },
};

const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) next(); else res.redirect(302, '/login');
};

/** The loopback server: the real page through the real registration; the admin API and the vendors' routes mocked. */
function buildServer(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { oidc: { isAuthenticated: () => true, user: OPERATOR } }); next(); });
  app.use((req, _res, next) => { if (req.path.startsWith('/api/')) swarm.requests.push(`${req.method} ${req.path}`); next(); });
  app.get('/login', (_q, r) => r.type('html').send('<html><body>Sign in</body></html>'));
  app.get('/api/admin/swarm-logins', (_q, r) => {
    if (swarm.api === '403') { r.status(403).json({ error: 'Operator privilege required' }); return; }
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    r.json({ logins: IDS.map((id) => ({
      id, title: id, connected: swarm.state[id].connected, expired: swarm.state[id].expired, expiresAt: swarm.state[id].connected ? soon : null,
      detail: swarm.state[id].connected ? 'present' : 'absent', rails: RAILS[id],
      adoption: id === 'openai-codex' ? { allowed: true, reason: 'ok' } : { allowed: swarm.gate === 'ok', reason: swarm.gate },
    })) });
  });
  app.get('/api/claude-code/auth/start', (_q, r) => {
    if (swarm.start === 'already') { r.json({ success: true, alreadyAuthenticated: true, loginInProgress: false, authUrl: null, oauthMode: true }); return; }
    if (swarm.start === 'nourl') { r.json({ success: true, alreadyAuthenticated: false, loginInProgress: true, authUrl: null, oauthMode: false }); return; }
    r.json({ success: true, alreadyAuthenticated: false, loginInProgress: false, authUrl: 'https://claude.ai/oauth/authorize?x=1', oauthMode: true });
  });
  app.post('/api/claude-code/auth/submit-code', (_q, r) => { swarm.state['claude-code'] = { connected: true, expired: false }; r.json({ success: true, authenticated: true, email: SECRET_EMAIL }); });
  app.post('/api/claude-code/auth/signout', (_q, r) => { swarm.state['claude-code'] = { connected: false, expired: true }; r.json({ success: true, signedOut: true, email: SECRET_EMAIL }); });
  app.post('/api/openai-codex/oauth/import', (_q, r) => { swarm.state['openai-codex'] = { connected: true, expired: false }; r.json({ success: true, authenticated: true, email: SECRET_EMAIL }); });
  app.post('/api/openai-codex/oauth/signout', (_q, r) => { r.json({ success: true, signedOut: true }); }); // the live file stays: it was not this operator's
  app.post('/api/gemini/auth/import', (_q, r) => { r.status(409).json({ success: false, imported: false, error: 'gemini_credentials_path_read_only', hint: 'Set GEMINI_AUTH_MOUNT_MODE=rw in .env.' }); });
  app.post('/api/antigravity/auth/signout', (_q, r) => { swarm.state.antigravity = { connected: false, expired: false }; r.json({ success: true, signedOut: true, removed: true, authenticated: false }); });
  const src = path.resolve(process.cwd(), 'src');
  app.use('/shared/ui/css', express.static(path.join(src, 'shared/ui/css')));
  app.use('/shared/ui/js', express.static(path.join(src, 'shared/ui/js')));
  app.use('/fonts', express.static(path.join(process.cwd(), 'node_modules/@vscode/codicons/dist')));
  registerUiSurfaceRoutes({ app, requiresAuth, serveHtml: sendHtmlResponse, pages: resolveUiSurfacePages([requireAdminConsoleAccess()]) });
  return app;
}

let browser: Browser;
let context: BrowserContext;
let server: Server;
let base = '';

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  server = buildServer().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => { await browser?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }, 30_000);
beforeEach(async () => {
  setPrivilegedIdentities([{ sub: OPERATOR.sub, email: OPERATOR.email, role: 'admin' }]);
  swarm.reset();
  context = await browser.newContext({ viewport: { width: 1100, height: 1200 } });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
}, 60_000);
afterEach(async () => { await context?.close(); clearPrivilegedIdentities(); }, 30_000);

async function open(): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`${base}/swarm-admin/logins`, { waitUntil: 'networkidle' });
  await expect.poll(() => page.locator('#loginCards .sl-card').count()).toBe(4);
  return page;
}
const card = (page: Page, id: Id) => page.locator(`.sl-card[data-login="${id}"]`);
const message = (page: Page, id: Id) => card(page, id).locator('.sl-message').textContent();

describe('the swarm logins page in Chromium', () => {
  it('keeps the import and sign-in panels hidden until asked for, and closes them on Cancel', async () => {
    swarm.reset({ 'claude-code': { connected: true, expired: false } });
    const page = await open();
    for (const id of IDS) {
      expect(await card(page, id).locator('.sl-import').isVisible(), `${id} import`).toBe(false);
      expect(await card(page, id).locator('.sl-signin').isVisible(), `${id} signin`).toBe(false);
    }
    const codex = card(page, 'openai-codex');
    await codex.getByRole('button', { name: 'Import a pushed login' }).click();
    expect(await codex.locator('.sl-import').isVisible()).toBe(true);
    await codex.locator('.sl-import-cancel').click();
    expect(await codex.locator('.sl-import').isVisible()).toBe(false);
    const claude = card(page, 'claude-code');
    await claude.getByRole('button', { name: 'Sign in here' }).click();
    await expect.poll(() => claude.locator('.sl-signin').isVisible()).toBe(true);
    await claude.locator('.sl-signin-cancel').click();
    expect(await claude.locator('.sl-signin').isVisible()).toBe(false);
  });

  it('shows the link the real start reply carries, says "Already signed in." without a panel, and hides a missing link', async () => {
    const page = await open();
    const claude = card(page, 'claude-code');
    await claude.getByRole('button', { name: 'Sign in here' }).click();
    await expect.poll(() => claude.locator('.sl-signin').isVisible()).toBe(true);
    expect(await claude.locator('.sl-signin-link').getAttribute('href')).toBe('https://claude.ai/oauth/authorize?x=1');
    expect(await claude.locator('.sl-signin-link').isVisible()).toBe(true);
    await claude.locator('.sl-signin-cancel').click();

    swarm.start = 'nourl';
    await claude.getByRole('button', { name: 'Sign in here' }).click();
    await expect.poll(() => claude.locator('.sl-signin').isVisible()).toBe(true);
    expect(await claude.locator('.sl-signin-link').isVisible()).toBe(false);
    await claude.locator('.sl-signin-cancel').click();

    swarm.start = 'already';
    await claude.getByRole('button', { name: 'Sign in here' }).click();
    await expect.poll(() => message(page, 'claude-code')).toBe('Already signed in.');
    expect(await card(page, 'claude-code').locator('.sl-signin').isVisible()).toBe(false);
  });

  it('keeps an outcome on the card after the rebuild, and never shows a reply\'s account email', async () => {
    const page = await open();
    const claude = card(page, 'claude-code');
    await claude.getByRole('button', { name: 'Sign in here' }).click();
    await expect.poll(() => claude.locator('.sl-code').isVisible()).toBe(true);
    await claude.locator('.sl-code').fill('abc#def');
    await claude.locator('.sl-code-send').click();
    await expect.poll(() => message(page, 'claude-code')).toContain('Signed in.');
    expect(await card(page, 'claude-code').locator('.sl-state').textContent()).toBe('Connected');

    const codex = card(page, 'openai-codex');
    await codex.getByRole('button', { name: 'Import a pushed login' }).click();
    await codex.locator('.sl-paste').fill('{"tokens":{"access_token":"a","refresh_token":"r"}}');
    await codex.locator('.sl-import-send').click();
    await expect.poll(() => message(page, 'openai-codex')).toContain('Imported.');
    expect(await card(page, 'openai-codex').locator('.sl-state').textContent()).toBe('Connected');
    expect(swarm.requests).toContain('POST /api/openai-codex/oauth/import');

    const gemini = card(page, 'gemini');
    await gemini.getByRole('button', { name: 'Import a pushed login' }).click();
    await gemini.locator('.sl-paste').fill('{}');
    await gemini.locator('.sl-import-send').click();
    await expect.poll(() => message(page, 'gemini')).toContain('read-only');
    expect(await message(page, 'gemini')).toContain('GEMINI_AUTH_MOUNT_MODE=rw');

    expect(await page.content()).not.toContain(SECRET_EMAIL);
  });

  it('offers the import button per login: Codex to a non-demo operator, the gated three not, with the note shown', async () => {
    swarm.reset(); swarm.gate = 'not-demo';
    const page = await open();
    expect(await card(page, 'openai-codex').getByRole('button', { name: 'Import a pushed login' }).count()).toBe(1);
    for (const id of ['claude-code', 'gemini', 'antigravity'] as const) expect(await card(page, id).getByRole('button', { name: 'Import a pushed login' }).count(), id).toBe(0);
    expect(await page.locator('#adoptionNote').isVisible()).toBe(true);
    expect(await page.locator('#adoptionNote').textContent()).toContain('DEMO_MODE');
    expect(await card(page, 'claude-code').getByRole('button', { name: 'Sign in here' }).count()).toBe(1);
    swarm.gate = 'ok';
    await page.reload({ waitUntil: 'networkidle' });
    expect(await page.locator('#adoptionNote').isVisible()).toBe(false);
  });

  it('says plainly when a sign-out leaves a login present or expired, and "Signed out." when it is gone', async () => {
    swarm.reset({ 'openai-codex': { connected: true, expired: false }, antigravity: { connected: true, expired: false }, 'claude-code': { connected: true, expired: false } });
    const page = await open();
    await card(page, 'openai-codex').getByRole('button', { name: 'Sign out' }).click();
    await expect.poll(() => message(page, 'openai-codex')).toContain('still present');
    expect(await card(page, 'openai-codex').locator('.sl-message').getAttribute('data-tone')).toBe('error');
    await card(page, 'antigravity').getByRole('button', { name: 'Sign out' }).click();
    await expect.poll(() => message(page, 'antigravity')).toBe('Signed out.');
    expect(await card(page, 'antigravity').locator('.sl-state').textContent()).toBe('Not connected');
    // An expired file the sign-out could not remove is still a login present.
    await card(page, 'claude-code').getByRole('button', { name: 'Sign out' }).click();
    await expect.poll(() => message(page, 'claude-code')).toContain('still present');
  });

  it('shows the operator-role banner on a 403', async () => {
    swarm.api = '403';
    const page = await context.newPage();
    await page.goto(`${base}/swarm-admin/logins`, { waitUntil: 'networkidle' });
    await expect.poll(() => page.locator('#statusBanner').textContent()).toContain('operator role');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('error');
  });
});

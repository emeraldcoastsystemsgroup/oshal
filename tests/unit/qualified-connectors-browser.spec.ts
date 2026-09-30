/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prepare real Chromium/loopback guards for shipped Utilities OAuth escaping its iframe, exact revision writes and secret clearing. API/auth/provider responders are named fixtures, not PostgreSQL, OAuth or live-provider acceptance.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { registerCockpitStaticRoutes } from '@/app/routes/cockpit-static-routes';
import { sendHtmlResponse } from '@/app/server-ui-assets';
import { buildStrictCsp } from '@/features/security/hardening/strict-csp';

const BASE = '/api/connect/qualified', TOKEN = 'synthetic-browser-qualified-pat';
const ID = '00000000-0000-4000-8000-000000000001', REVISION = '9007199254740993';
const TEST_MS = 30_000, HOOK_MS = 60_000;
interface Grant {
  connectionId: string; provider: string; accountKey: string; revision: string;
  status: string; expiresAt: string | null; createdAt: string; updatedAt: string;
}
interface Recorded {
  method: string; path: string; url: string; body: unknown; origin?: string; revision?: string;
  destination?: string; mode?: string;
}
const grant = (revision = REVISION): Grant => ({
  connectionId: ID, provider: 'smartthings', accountKey: 'smartthings-location:browser-fixture',
  revision, status: 'connected', expiresAt: null,
  createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z',
});
const world = {
  rows: [] as Grant[], requests: [] as Recorded[], provider: [] as Recorded[],
  blockedOrigins: [] as string[], hold: undefined as Promise<void> | undefined, tokenStatus: 200,
};
let appServer: Server | undefined, providerServer: Server | undefined;
let origin: string, providerOrigin: string, browser: Browser | undefined;
let context: BrowserContext | undefined, page: Page;

function record(req: Request): Recorded {
  return { method: req.method, path: req.path, url: req.originalUrl, body: req.body,
    origin: req.get('origin'), revision: req.get('if-match'),
    destination: req.get('sec-fetch-dest'), mode: req.get('sec-fetch-mode') };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolveGate => { release = resolveGate; });
  return { promise, release };
}
async function listen(app: express.Application): Promise<{ server: Server; origin: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolveListen, reject) => { server.once('listening', resolveListen); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback fixture address missing');
  return { server, origin: 'http://127.0.0.1:' + address.port };
}
async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}

/** Named recording API double; no production grant/session/SQL or actual provider code is invoked. */
async function tokenResponse(req: Request, res: Response): Promise<void> {
  if (world.hold) await world.hold;
  if (world.tokenStatus !== 200) {
    if (world.tokenStatus === 409 && world.rows[0]) world.rows[0].revision = String(BigInt(world.rows[0].revision) + 1n);
    res.status(world.tokenStatus).json({ error: 'untrusted-fixture-error-' + TOKEN }); return;
  }
  const target = req.params.connectionId ? world.rows.find(row => row.connectionId === req.params.connectionId) : undefined;
  if (req.params.connectionId && (!target || req.get('if-match') !== '"' + target.revision + '"')) {
    res.status(404).json({ error: 'not_found_or_stale' }); return;
  }
  const fresh = target ?? grant();
  if (target) fresh.revision = String(BigInt(fresh.revision) + 1n);
  else world.rows.push(fresh);
  res.json({ connection: fresh });
}
function revokeResponse(req: Request, res: Response): void {
  const target = world.rows.find(row => row.connectionId === req.params.connectionId);
  if (!target || req.get('if-match') !== '"' + target.revision + '"') { res.status(404).json({ error: 'not_found_or_stale' }); return; }
  target.status = 'revoked'; target.revision = String(BigInt(target.revision) + 1n);
  res.json({ connection: target });
}
/** The start/302 is deliberately a protocol recorder, not the real OAuth ceremony or provider. */
function registerRecordingApi(app: express.Application): void {
  app.get(BASE, (_req, res) => { res.json({ connections: world.rows }); });
  app.get(BASE + '/smartthings/start', (req, res) => {
    const suffix = typeof req.query.reconnect === 'string' ? '?reconnect=' + encodeURIComponent(req.query.reconnect) : '';
    res.redirect(302, providerOrigin + '/authorize' + suffix);
  });
  app.post([BASE + '/smartthings/token', BASE + '/smartthings/:connectionId/token'], (req, res, next) => {
    void tokenResponse(req, res).catch(next);
  });
  app.delete(BASE + '/:connectionId', revokeResponse);
  // Unrelated shipped Utilities boot reads are unavailable, not forwarded to a running service.
  app.use('/api', (_req, res) => { res.status(503).json({ error: 'fixture_unavailable' }); });
}
/** Real HTML sender/static registrar; only the enclosing Settings page and auth gate are fixtures. */
function registerSurface(app: express.Application): void {
  const requiresAuth: express.RequestHandler = (_req, _res, next) => next();
  // Same shipped bytes and sender as mountProviderAuthRoutes, without loading unrelated auth runtimes.
  app.get('/utilities', requiresAuth, (_req, res) => sendHtmlResponse(res, resolve('src/api/utilities.html'), '/utilities'));
  // server.ts owns this real static mount; the cockpit registrar intentionally does not mount shared JS.
  app.use('/shared/ui/js', express.static(resolve('src/shared/ui/js'), { index: false, redirect: false }));
  registerCockpitStaticRoutes({ app, requiresAuth, cockpitDir: resolve('src/pages/cockpit'),
    uiEnhancedDir: resolve('any-bot/ui-enhanced'), codiconFontsDir: resolve('node_modules/@vscode/codicons/dist'),
    sharedUiCssDir: resolve('src/shared/ui/css'), sharedUiJsDir: resolve('src/shared/ui/js') });
  app.get('/fixture/settings', (req, res) => {
    const framing = buildStrictCsp()['frame-src'].join(' ');
    // Enforce the real framing directive on the parent. Do not silently disable it for OAuth.
    res.set('Content-Security-Policy', 'frame-src ' + framing + "; object-src 'none'; base-uri 'none'");
    const src = req.query.blocked === '1' ? providerOrigin + '/forbidden-frame' : '/utilities';
    res.type('html').send('<!doctype html><html><body><iframe title="Connections" src="' + src
      + '" style="width:100%;height:900px" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-top-navigation-by-user-activation"></iframe></body></html>');
  });
}

beforeAll(async () => {
  const provider = express();
  provider.use((req, _res, next) => { world.provider.push(record(req)); next(); });
  provider.get(['/authorize', '/forbidden-frame'], (_req, res) => {
    res.type('html').send('<!doctype html><h1 id="provider-stub">Named loopback authorization responder</h1>');
  });
  const remote = await listen(provider); providerServer = remote.server; providerOrigin = remote.origin;
  const app = express(); app.use(express.json({ limit: '80kb' }));
  app.use((req, _res, next) => { world.requests.push(record(req)); next(); });
  registerRecordingApi(app); registerSurface(app);
  const local = await listen(app); appServer = local.server; origin = local.origin;
  browser = await chromium.launch({ headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--no-proxy-server'] });
}, HOOK_MS);
afterAll(async () => {
  try { await browser?.close(); }
  finally { await Promise.all([close(appServer), close(providerServer)]); }
}, HOOK_MS);
beforeEach(async () => {
  world.rows = []; world.requests = []; world.provider = []; world.blockedOrigins = [];
  world.hold = undefined; world.tokenStatus = 200;
  if (!browser) throw new Error('Chromium fixture not started');
  context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, serviceWorkers: 'block' });
  // Catch redirects and subresources too; two exact loopback origins are the whole network allowlist.
  await context.route('**/*', async route => {
    const destination = new URL(route.request().url()).origin;
    if (destination === origin || destination === providerOrigin) { await route.continue(); return; }
    world.blockedOrigins.push(destination); await route.abort('blockedbyclient');
  });
  page = await context.newPage();
});
afterEach(async () => {
  await context?.close();
  expect(world.blockedOrigins).toEqual([]);
  expect(world.requests.filter(req => !['GET', 'HEAD'].includes(req.method) && !req.path.startsWith(BASE + '/'))).toEqual([]);
});

function panel() { return page.frameLocator('iframe[title="Connections"]').locator('#qualifiedConnectorsPanel'); }
function card() { return panel().locator('[data-qualified-id="' + ID + '"]'); }
const writes = () => world.requests.filter(req => req.path.startsWith(BASE + '/') && req.method !== 'GET');
async function openPanel(): Promise<void> {
  const response = await page.goto(origin + '/fixture/settings', { waitUntil: 'domcontentloaded' });
  expect(response?.headers()['content-security-policy']).toContain("frame-src 'self'");
  await expect.poll(() => panel().locator('[role="status"]').textContent()).toContain('Personal qualified metadata loaded');
  expect(await panel().getByRole('button', { name: 'Connect fresh PAT', exact: true }).isEnabled()).toBe(true);
}

describe('shipped Utilities in real Chromium / loopback APIs and authorization responder', () => {
  it.each([false, true])('a user click escapes the iframe once under enforced frame-src self (reconnect=%s)', async reconnect => {
    if (reconnect) world.rows = [grant()];
    await openPanel();
    const link = (reconnect ? card() : panel()).getByRole('link', { name: reconnect ? 'Reconnect via OAuth' : 'Connect via OAuth', exact: true });
    expect(await link.getAttribute('target')).toBe('_top');
    const target = providerOrigin + '/authorize' + (reconnect ? '?reconnect=' + ID : '');
    await Promise.all([page.waitForURL(target, { timeout: TEST_MS }), link.click()]);
    expect(page.url()).toBe(target); expect(page.frames()).toHaveLength(1);
    expect(await page.locator('#provider-stub').textContent()).toBe('Named loopback authorization responder');
    const starts = world.requests.filter(req => req.path === BASE + '/smartthings/start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ method: 'GET', destination: 'document', mode: 'navigate',
      url: BASE + '/smartthings/start' + (reconnect ? '?reconnect=' + ID : '') });
    const authorizations = world.provider.filter(req => req.path === '/authorize');
    expect(authorizations).toHaveLength(1); expect(authorizations[0].destination).toBe('document');
    expect(writes()).toEqual([]); // No fetch preflight, credential POST, or device command.
  }, TEST_MS);

  it('actually blocks the second origin inside a frame rather than weakening the framing policy', async () => {
    const violation = page.waitForEvent('console', { predicate: message =>
      message.text().includes('frame-src') && message.text().includes(providerOrigin), timeout: TEST_MS });
    await page.goto(origin + '/fixture/settings?blocked=1', { waitUntil: 'domcontentloaded' });
    await violation;
    expect(page.url()).toBe(origin + '/fixture/settings?blocked=1');
    expect(world.provider.filter(req => req.path === '/forbidden-frame')).toEqual([]);
  }, TEST_MS);

  it('clears fresh PAT before the held response and lets Chromium supply same-origin headers', async () => {
    await openPanel();
    const held = deferred(); world.hold = held.promise;
    try {
      const input = panel().locator('#qualified-pat-new');
      await input.fill(TOKEN); await panel().getByRole('button', { name: 'Connect fresh PAT', exact: true }).click();
      await expect.poll(() => writes().length).toBe(1);
      expect(await input.inputValue()).toBe('');
      expect(await panel().getByRole('button', { name: 'Connect fresh PAT', exact: true }).isDisabled()).toBe(true);
      expect(writes()[0]).toMatchObject({ method: 'POST', path: BASE + '/smartthings/token', origin, body: { token: TOKEN } });
      expect(writes()[0].revision).toBeUndefined();
    } finally { held.release(); world.hold = undefined; }
    await expect.poll(() => panel().locator('[role="status"]').textContent()).toContain('Qualified grant updated');
    expect(await panel().textContent()).not.toContain(TOKEN);
    expect(await panel().locator('#qualified-pat-new').inputValue()).toBe('');
  }, TEST_MS);

  it('sends the exact displayed revision, clears a stale PAT, and requires a new explicit submission', async () => {
    world.rows = [grant()]; await openPanel(); world.tokenStatus = 409;
    await card().locator('input').fill(TOKEN);
    await card().getByRole('button', { name: 'Reconnect with fresh PAT' }).click();
    await expect.poll(() => panel().locator('[role="status"]').textContent()).toContain('No write was retried');
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ origin, revision: '"' + REVISION + '"', path: BASE + '/smartthings/' + ID + '/token', body: { token: TOKEN } });
    expect(await card().locator('input').inputValue()).toBe('');
    expect(await panel().textContent()).not.toContain(TOKEN);
    world.tokenStatus = 200;
    await card().locator('input').fill('synthetic-second-pat');
    await card().getByRole('button', { name: 'Reconnect with fresh PAT' }).click();
    await expect.poll(() => panel().locator('[role="status"]').textContent()).toContain('Qualified grant updated');
    expect(writes()).toHaveLength(2); expect(writes()[1].revision).toBe('"9007199254740994"');
  }, TEST_MS);

  it('uses a real confirmation dialog for local revoke and never retries a cancelled action', async () => {
    world.rows = [grant()]; await openPanel(); await card().locator('input').fill(TOKEN);
    page.once('dialog', dialog => { void dialog.dismiss(); });
    await card().getByRole('button', { name: 'Revoke local grant' }).click();
    expect(writes()).toEqual([]); expect(await card().locator('input').inputValue()).toBe('');
    let confirmation = '';
    page.once('dialog', dialog => { confirmation = dialog.message(); void dialog.accept(); });
    await card().getByRole('button', { name: 'Revoke local grant' }).click();
    await expect.poll(() => panel().locator('[role="status"]').textContent()).toContain('Qualified grant updated');
    expect(confirmation).toContain('does not revoke the token at SmartThings or send a device action');
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: 'DELETE', path: BASE + '/' + ID, origin, revision: '"' + REVISION + '"' });
    expect(await card().textContent()).toContain('Status: revoked'); expect(world.provider).toEqual([]);
  }, TEST_MS);
});

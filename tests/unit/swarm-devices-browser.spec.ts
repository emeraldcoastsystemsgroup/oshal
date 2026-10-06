/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-7), driven in headless Chromium against the real /swarm-admin/devices page served through the real surface registration, with the remote-clients and directory APIs mocked in the real reply shapes (the rotate route answers 201): the fleet strip and every device with its binding named from the directory with the email, its state as the page tells it (a fresh heartbeat is online; a stale one is silent and not counted online, since the registry never times a node out; degraded as the daemon reports it), heartbeat, work and tools; the text, binding and state filters; bind posts the chosen person's subject and the outcome survives the reload; unbind asks and posts an empty owner, and a cancelled dialog posts nothing; rotate asks (a cancelled dialog posts nothing), posts, shows the 201's token exactly once with a Copy that reports a missing clipboard, and hides it; the route's refusal is shown as said; a directory that cannot be read is said and the bind picker says so; a failed load clears the rows; a hostile device name is text; the page fits a phone; a 403 shows the operator-role banner. Each fails if its fix returns.
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
const PERSON_SUB = 'idp-person-7b1';
const PERSON_LABEL = 'Pat Example';
const PERSON_EMAIL = 'pat@example.test';
const HOSTILE = '<img src=x onerror="document.body.dataset.pwned=\'1\'">Laptop';

type Client = { clientId: string; name: string; platform: string; ownerSub?: string; status: string; healthy: boolean; lastHeartbeatAt: string | null; lastSeenAt: string | null; taskQueueDepth: number; activeTaskId?: string; mcpToolCount: number; registeredAt: string };

const fleet = {
  clients: [] as Client[],
  posted: [] as Array<{ path: string; body: Record<string, unknown> | null }>,
  api: 'normal' as 'normal' | '403' | '500',
  directory: 'normal' as 'normal' | '403',
  reset() {
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 3 * 86400_000).toISOString();
    this.clients = [
      { clientId: 'node-pat-1', name: 'Pat desk', platform: 'windows', ownerSub: PERSON_SUB, status: 'online', healthy: true, lastHeartbeatAt: now, lastSeenAt: now, taskQueueDepth: 2, activeTaskId: 'task-77', mcpToolCount: 14, registeredAt: now },
      { clientId: 'node-new-2', name: HOSTILE, platform: 'linux', status: 'online', healthy: true, lastHeartbeatAt: now, lastSeenAt: now, taskQueueDepth: 0, mcpToolCount: 0, registeredAt: now },
      { clientId: 'node-old-3', name: 'Basement box', platform: 'macos', ownerSub: 'someone-unknown', status: 'offline', healthy: false, lastHeartbeatAt: new Date(Date.now() - 2 * 3600_000).toISOString(), lastSeenAt: null, taskQueueDepth: 0, mcpToolCount: 3, registeredAt: now },
      { clientId: 'node-sleepy-4', name: 'Sleeping laptop', platform: 'macos', ownerSub: PERSON_SUB, status: 'online', healthy: true, lastHeartbeatAt: stale, lastSeenAt: stale, taskQueueDepth: 0, mcpToolCount: 5, registeredAt: stale },
      { clientId: 'node-degraded-5', name: 'Shaky node', platform: 'linux', ownerSub: PERSON_SUB, status: 'degraded', healthy: true, lastHeartbeatAt: now, lastSeenAt: now, taskQueueDepth: 1, mcpToolCount: 2, registeredAt: now },
    ];
    this.posted = []; this.api = 'normal'; this.directory = 'normal';
  },
};

const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) next(); else res.redirect(302, '/login');
};

function buildServer(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { oidc: { isAuthenticated: () => true, user: OPERATOR } }); next(); });
  app.get('/login', (_q, r) => r.type('html').send('<html><body>Sign in</body></html>'));
  app.get('/api/remote-clients', (_q, r) => {
    if (fleet.api === '403') { r.status(403).json({ error: 'Operator privilege required' }); return; }
    if (fleet.api === '500') { r.status(500).json({ error: 'registry unavailable' }); return; }
    r.json({ clients: fleet.clients.map((c) => ({ ...c, ownership: { state: c.ownerSub ? 'another-person' : 'unowned', owned: Boolean(c.ownerSub), label: c.ownerSub ? 'Another person' : 'Nobody', hint: '' } })), count: fleet.clients.length });
  });
  app.get('/api/user-directory', (_q, r) => {
    if (fleet.directory === '403') { r.status(403).json({ error: 'roster_administrator_required' }); return; }
    r.json({ users: [{ sub: PERSON_SUB, issuer: 'x', label: PERSON_LABEL, email: PERSON_EMAIL, source: 'verified-sign-in', signIn: 'active', lastSeenAt: null }, { sub: OPERATOR.sub, issuer: OPERATOR.iss, label: 'The operator', email: OPERATOR.email, source: 'verified-sign-in', signIn: 'active', lastSeenAt: null }] });
  });
  app.post('/api/remote-clients/:id/owner', (q, r) => {
    fleet.posted.push({ path: `/api/remote-clients/${q.params.id}/owner`, body: q.body as Record<string, unknown> });
    const client = fleet.clients.find((c) => c.clientId === q.params.id);
    if (!client) { r.status(404).json({ error: 'Remote client not found' }); return; }
    const ownerSub = String((q.body as { ownerSub?: string }).ownerSub ?? '');
    if (ownerSub) client.ownerSub = ownerSub; else delete client.ownerSub;
    r.json({ client });
  });
  app.post('/api/remote-clients/:id/token/rotate', (q, r) => {
    fleet.posted.push({ path: `/api/remote-clients/${q.params.id}/token/rotate`, body: null });
    const client = fleet.clients.find((c) => c.clientId === q.params.id);
    if (!client) { r.status(404).json({ error: 'Remote client not found' }); return; }
    if (!client.ownerSub) { r.status(400).json({ error: 'device_has_no_owner', message: 'Bind an owner (POST /:clientId/owner) before issuing a per-node token.' }); return; }
    r.status(201).json({ clientId: client.clientId, ownerSub: client.ownerSub, token: 'example-node-token-returned-once', tokenId: 'tok-9', revokedCount: 2, expiresAt: '2026-11-06T00:00:00.000Z' });
  });
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
  fleet.reset();
  context = await browser.newContext({ viewport: { width: 1200, height: 1400 } });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
}, 60_000);
afterEach(async () => { await context?.close(); clearPrivilegedIdentities(); }, 30_000);

async function open(accept = true): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  if (accept) page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`${base}/swarm-admin/devices`, { waitUntil: 'networkidle' });
  await expect.poll(() => page.locator('#devices tr[data-id]').count()).toBe(fleet.clients.length);
  return page;
}
const row = (page: Page, id: string) => page.locator(`#devices tr[data-id="${id}"]`);
const banner = (page: Page) => page.locator('#statusBanner').textContent();
const shown = async (page: Page) => page.locator('#devices tr[data-id]').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.id));

describe('the devices page in Chromium', () => {
  it('shows the fleet and every device with its binding named with the email, its state as the page tells it, heartbeat, work and tools; a hostile name is text', async () => {
    const page = await open();
    const posture = await page.locator('#posture').textContent();
    expect(posture).toContain('5device(s) joined');
    expect(posture).toContain('2online (fresh heartbeat)');
    expect(posture).toContain('3silent, degraded or offline');
    expect(posture).toContain('4bound to a person');
    expect(posture).toContain('1unbound');
    expect(posture).toContain('never times a node out');
    const pat = row(page, 'node-pat-1');
    expect(await pat.locator('td').nth(0).textContent()).toBe('Pat desknode-pat-1');
    expect(await pat.locator('td').nth(2).textContent()).toBe(`${PERSON_LABEL} <${PERSON_EMAIL}>`);
    expect(await pat.locator('td').nth(3).textContent()).toBe('online');
    expect(await pat.locator('td').nth(4).textContent()).toMatch(/^\d+ s ago$/);
    expect(await pat.locator('td').nth(5).textContent()).toBe('2 queuedrunning task-77');
    expect(await pat.locator('td').nth(6).textContent()).toBe('14');
    expect(await pat.getByRole('button').allTextContents()).toEqual(['Rebind', 'Unbind', 'Rotate token']);
    const fresh = row(page, 'node-new-2');
    expect(await fresh.locator('td').nth(0).textContent()).toBe(`${HOSTILE}node-new-2`);
    expect(await fresh.locator('td').nth(2).textContent()).toBe('Nobody');
    expect(await fresh.getByRole('button').allTextContents()).toEqual(['Bind']);
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => document.body.dataset.pwned ?? null)).toBeNull();
    expect(await row(page, 'node-old-3').locator('td').nth(2).textContent()).toBe('someone-unknown');
    expect(await row(page, 'node-old-3').locator('td').nth(3).textContent()).toBe('offline');
    expect(await row(page, 'node-old-3').locator('td').nth(4).textContent()).toBe('2 h ago');
    expect(await row(page, 'node-sleepy-4').locator('td').nth(3).textContent()).toBe('silent');
    expect(await row(page, 'node-sleepy-4').locator('td').nth(3).locator('.pill').getAttribute('data-state')).toBe('silent');
    expect(await row(page, 'node-sleepy-4').locator('td').nth(4).textContent()).toBe('3 d ago');
    expect(await row(page, 'node-degraded-5').locator('td').nth(3).textContent()).toBe('degraded');
    expect(await banner(page)).toBe('5 device(s), 2 online, 1 unbound.');
  });

  it('filters by text, binding and state, where online means a fresh heartbeat', async () => {
    const page = await open();
    await page.fill('#search', 'pat');
    await expect.poll(() => shown(page)).toEqual(['node-pat-1', 'node-sleepy-4', 'node-degraded-5']);
    await page.fill('#search', '');
    await page.selectOption('#boundFilter', 'unbound');
    await expect.poll(() => shown(page)).toEqual(['node-new-2']);
    await page.selectOption('#boundFilter', '');
    await page.selectOption('#stateFilter', 'online');
    await expect.poll(() => shown(page)).toEqual(['node-pat-1', 'node-new-2']);
    await page.selectOption('#stateFilter', 'silent');
    await expect.poll(() => shown(page)).toEqual(['node-sleepy-4']);
    await page.selectOption('#stateFilter', 'degraded');
    await expect.poll(() => shown(page)).toEqual(['node-degraded-5']);
    expect(await page.locator('#count').textContent()).toBe('1 of 5 device(s) shown.');
  });

  it('binds a device to a person from the directory and keeps the outcome after the reload; unbind asks and a cancelled dialog posts nothing', async () => {
    const page = await open(false);
    await row(page, 'node-new-2').getByRole('button', { name: 'Bind' }).click();
    const form = page.locator('#devices .sd-bind-row form');
    expect(await form.locator('select[name="ownerSub"] option').allTextContents()).toEqual(['Choose a person', `${PERSON_LABEL} <${PERSON_EMAIL}>`, `The operator <${OPERATOR.email}>`]);
    await form.locator('select[name="ownerSub"]').selectOption(PERSON_SUB);
    await form.locator('button[type="submit"]').click();
    await expect.poll(() => banner(page)).toBe(`${HOSTILE}: bound to ${PERSON_LABEL} <${PERSON_EMAIL}>.`);
    expect(fleet.posted).toEqual([{ path: '/api/remote-clients/node-new-2/owner', body: { ownerSub: PERSON_SUB } }]);
    expect(await row(page, 'node-new-2').locator('td').nth(2).textContent()).toBe(`${PERSON_LABEL} <${PERSON_EMAIL}>`);
    expect(await page.locator('#posture').textContent()).toContain('0unbound');

    page.once('dialog', (dialog) => void dialog.dismiss());
    await row(page, 'node-pat-1').getByRole('button', { name: 'Unbind' }).click();
    await expect.poll(() => row(page, 'node-pat-1').getByRole('button', { name: 'Unbind' }).isEnabled()).toBe(true);
    expect(fleet.posted).toHaveLength(1);

    page.once('dialog', (dialog) => void dialog.accept());
    await row(page, 'node-pat-1').getByRole('button', { name: 'Unbind' }).click();
    await expect.poll(() => banner(page)).toBe("Pat desk: unbound; no person's own work is dispatched to it until it is bound again.");
    expect(fleet.posted.at(-1)).toEqual({ path: '/api/remote-clients/node-pat-1/owner', body: { ownerSub: '' } });
    expect(await row(page, 'node-pat-1').locator('td').nth(2).textContent()).toBe('Nobody');
  });

  it('rotates a node token after asking (a cancelled dialog posts nothing), accepts the 201, shows the token once with Copy feedback, and hides it; the refusal is shown as said', async () => {
    await context.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });
    const page = await open(false);
    page.once('dialog', (dialog) => void dialog.dismiss());
    await row(page, 'node-pat-1').getByRole('button', { name: 'Rotate token' }).click();
    await expect.poll(() => row(page, 'node-pat-1').getByRole('button', { name: 'Rotate token' }).isEnabled()).toBe(true);
    expect(fleet.posted).toEqual([]);

    page.once('dialog', (dialog) => void dialog.accept());
    await row(page, 'node-pat-1').getByRole('button', { name: 'Rotate token' }).click();
    await expect.poll(() => banner(page)).toBe('Pat desk: node token rotated; the new token is shown below once.');
    expect(fleet.posted).toEqual([{ path: '/api/remote-clients/node-pat-1/token/rotate', body: null }]);
    const note = page.locator('#tokenNote');
    expect(await note.isVisible()).toBe(true);
    expect(await note.locator('code').textContent()).toBe('example-node-token-returned-once');
    expect(await note.textContent()).toContain('2 earlier token(s) revoked');
    await note.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(() => note.locator('.sd-copy-feedback').textContent()).toContain('Copy failed here');
    await note.getByRole('button', { name: 'Hide' }).click();
    expect(await note.isVisible()).toBe(false);
    expect(await page.content()).not.toContain('example-node-token-returned-once');

    expect(await row(page, 'node-new-2').getByRole('button', { name: 'Rotate token' }).count()).toBe(0);
    fleet.clients[1].ownerSub = PERSON_SUB;
    await page.click('#reload');
    await expect.poll(() => row(page, 'node-new-2').getByRole('button', { name: 'Rotate token' }).count()).toBe(1);
    delete fleet.clients[1].ownerSub;
    page.once('dialog', (dialog) => void dialog.accept());
    await row(page, 'node-new-2').getByRole('button', { name: 'Rotate token' }).click();
    await expect.poll(() => banner(page)).toBe(`${HOSTILE}: Bind an owner (POST /:clientId/owner) before issuing a per-node token.`);
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('error');
    expect(await row(page, 'node-new-2').locator('td').nth(2).textContent()).toBe('Nobody');
  });

  it('says when the directory could not be read and the bind picker says so too', async () => {
    fleet.directory = '403';
    const page = await open();
    expect(await banner(page)).toBe('5 device(s), 2 online, 1 unbound. The directory could not be read, so people show by subject and binding must wait for a reload.');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('error');
    expect(await row(page, 'node-pat-1').locator('td').nth(2).textContent()).toBe(PERSON_SUB);
    await row(page, 'node-new-2').getByRole('button', { name: 'Bind' }).click();
    expect(await page.locator('#devices .sd-bind-row select option').allTextContents()).toEqual(['The directory could not be read; reload to try again']);
  });

  it('clears the rows when a load fails, fits a phone width, and shows the operator-role banner on a 403', async () => {
    const page = await open();
    fleet.api = '500';
    await page.click('#reload');
    await expect.poll(() => banner(page)).toBe('registry unavailable');
    expect(await page.locator('#devices tr[data-id]').count()).toBe(0);
    expect(await page.locator('#posture li').count()).toBe(0);
    await page.fill('#search', 'pat');
    await expect.poll(() => page.locator('#devices td.empty').textContent()).toBe('The devices could not be read.');
    fleet.api = 'normal';

    await context.close();
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
    const phone = await open();
    const widths = await phone.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth, wrap: document.querySelector('.sd-table-wrap')!.clientWidth, wrapScroll: document.querySelector('.sd-table-wrap')!.scrollWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.view);
    expect(widths.wrapScroll).toBeGreaterThan(widths.wrap);

    fleet.api = '403';
    const other = await context.newPage();
    await other.goto(`${base}/swarm-admin/devices`, { waitUntil: 'networkidle' });
    await expect.poll(() => other.locator('#statusBanner').textContent()).toContain('operator role');
    expect(await other.locator('#devices td.empty').textContent()).toContain('could not be read');
  });
});

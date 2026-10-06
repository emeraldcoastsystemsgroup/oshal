/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-8), driven in headless Chromium against the real /swarm-admin/households page served through the real surface registration, with the households, tenants and directory APIs mocked in the real reply shapes (the create route keeps 'org' and turns any other kind into 'space'): the overview and every household with its real kind (household or team), its members named from the directory, roles, external-identity members counted, and an access-review link per member with the subject encoded; a manageable household offers the add form, role selects and Remove except for its only admin, an unmanageable one says who manages it (or that it has no admin) and offers none; adding posts the chosen person and role and the outcome survives the reload; a role change posts; removing asks and a cancelled dialog posts nothing; a refusal shows the route's text and re-reads; creating posts name and kind and a refused create is shown; a directory that cannot be read is said; a hostile name is text; a failed load clears the cards; the page fits a phone; a 403 shows the operator-role banner. Each fails if its fix returns.
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
const ALICE = 'idp-alice';
const BOB = 'idp-bob+plus&amp#hash';
const CAROL = 'idp-carol';
const HOSTILE = '<img src=x onerror="document.body.dataset.pwned=\'1\'">Home';
const OPS_ID = '11111111-1111-4111-8111-111111111111';
const ALICES_ID = '22222222-2222-4222-8222-222222222222';
const ORPHAN_ID = '44444444-4444-4444-8444-444444444444';

type Member = { sub: string; role: 'admin' | 'member'; joinedAt: string };
type Household = { tenantId: string; kind: string; name: string | null; createdBySub: string; createdAt: string; members: Member[]; externalMembers: number };

const world = {
  households: [] as Household[],
  posted: [] as Array<{ method: string; path: string; body: Record<string, unknown> | null }>,
  api: 'normal' as 'normal' | '403' | '500',
  directory: 'normal' as 'normal' | '403',
  refuse: '' as string,
  reset() {
    this.households = [
      { tenantId: OPS_ID, kind: 'org', name: 'Ops shop', createdBySub: OPERATOR.sub, createdAt: '2026-10-01T10:00:00.000Z', members: [{ sub: OPERATOR.sub, role: 'admin', joinedAt: '2026-10-01T10:00:00.000Z' }, { sub: ALICE, role: 'member', joinedAt: '2026-10-02T10:00:00.000Z' }], externalMembers: 2 },
      { tenantId: ALICES_ID, kind: 'space', name: HOSTILE, createdBySub: ALICE, createdAt: '2026-10-03T10:00:00.000Z', members: [{ sub: ALICE, role: 'admin', joinedAt: '2026-10-03T10:00:00.000Z' }, { sub: BOB, role: 'member', joinedAt: '2026-10-04T10:00:00.000Z' }], externalMembers: 0 },
      { tenantId: ORPHAN_ID, kind: 'space', name: 'Orphan house', createdBySub: 'gone-sub', createdAt: '2026-10-05T10:00:00.000Z', members: [{ sub: CAROL, role: 'member', joinedAt: '2026-10-05T10:00:00.000Z' }], externalMembers: 0 },
    ];
    this.posted = []; this.api = 'normal'; this.directory = 'normal'; this.refuse = '';
  },
  view() {
    return this.households.map((h) => ({ ...h, members: [...h.members].sort((a, b) => Number(b.role === 'admin') - Number(a.role === 'admin')), myRole: h.members.find((m) => m.sub === OPERATOR.sub)?.role ?? null, manageable: h.members.some((m) => m.sub === OPERATOR.sub && m.role === 'admin') }));
  },
};

const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) next(); else res.redirect(302, '/login');
};

function buildServer(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { oidc: { isAuthenticated: () => true, user: OPERATOR } }); next(); });
  app.use((req, _res, next) => { if (req.method !== 'GET' && req.path.startsWith('/api/')) world.posted.push({ method: req.method, path: req.path, body: req.body && Object.keys(req.body).length ? req.body : null }); next(); });
  app.get('/login', (_q, r) => r.type('html').send('<html><body>Sign in</body></html>'));
  app.get('/api/admin/households', (_q, r) => {
    if (world.api === '403') { r.status(403).json({ error: 'Operator privilege required' }); return; }
    if (world.api === '500') { r.status(500).json({ error: 'households_unavailable' }); return; }
    r.json({ households: world.view(), count: world.households.length, note: 'A household is managed by its own admins.' });
  });
  app.get('/api/user-directory', (_q, r) => {
    if (world.directory === '403') { r.status(403).json({ error: 'roster_administrator_required' }); return; }
    r.json({ users: [
      { sub: OPERATOR.sub, issuer: OPERATOR.iss, label: 'The operator', email: OPERATOR.email, source: 'verified-sign-in', signIn: 'active', lastSeenAt: null },
      { sub: ALICE, issuer: 'x', label: 'Alice Example', email: 'alice@example.test', source: 'verified-sign-in', signIn: 'active', lastSeenAt: null },
      { sub: BOB, issuer: 'x', label: 'Bob Example', email: 'bob@example.test', source: 'verified-sign-in', signIn: 'active', lastSeenAt: null },
      { sub: CAROL, issuer: 'x', label: 'Carol Example', email: 'carol@example.test', source: 'verified-sign-in', signIn: 'active', lastSeenAt: null },
    ] });
  });
  app.post('/api/tenants', (q, r) => {
    if (world.refuse === 'create') { r.status(500).json({ error: 'tenants unavailable' }); return; }
    const body = q.body as { name: string; kind?: string };
    const kind = body.kind === 'org' ? 'org' : 'space'; // exactly what tenant-routes.ts keeps
    world.households.push({ tenantId: '33333333-3333-4333-8333-333333333333', kind, name: body.name, createdBySub: OPERATOR.sub, createdAt: '2026-10-06T10:00:00.000Z', members: [{ sub: OPERATOR.sub, role: 'admin', joinedAt: '2026-10-06T10:00:00.000Z' }], externalMembers: 0 });
    r.json({ tenant: { tenant_id: '33333333-3333-4333-8333-333333333333', kind, name: body.name, role: 'admin' } });
  });
  app.post('/api/tenants/:id/members', (q, r) => {
    const h = world.households.find((x) => x.tenantId === q.params.id);
    if (!h) { r.status(404).json({ error: 'not found' }); return; }
    if (world.refuse === 'add') { h.members.push({ sub: 'stale-sub', role: 'member', joinedAt: '2026-10-06T12:00:00.000Z' }); r.status(403).json({ error: 'not a tenant admin' }); return; }
    const body = q.body as { memberSub: string; role?: string };
    h.members.push({ sub: body.memberSub, role: body.role === 'admin' ? 'admin' : 'member', joinedAt: '2026-10-06T11:00:00.000Z' });
    r.json({ success: true });
  });
  app.patch('/api/tenants/:id/members/:sub', (q, r) => {
    const m = world.households.find((x) => x.tenantId === q.params.id)?.members.find((x) => x.sub === q.params.sub);
    if (!m) { r.status(404).json({ error: 'member not found' }); return; }
    m.role = (q.body as { role: string }).role === 'admin' ? 'admin' : 'member';
    r.json({ success: true });
  });
  app.delete('/api/tenants/:id/members/:sub', (q, r) => {
    const h = world.households.find((x) => x.tenantId === q.params.id);
    if (!h) { r.status(404).json({ error: 'not found' }); return; }
    if (h.members.filter((m) => m.role === 'admin').length <= 1 && h.members.find((m) => m.sub === q.params.sub)?.role === 'admin') { r.status(403).json({ error: 'cannot remove the last admin' }); return; }
    h.members = h.members.filter((m) => m.sub !== q.params.sub);
    r.json({ success: true });
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
  world.reset();
  context = await browser.newContext({ viewport: { width: 1200, height: 1600 } });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
}, 60_000);
afterEach(async () => { await context?.close(); clearPrivilegedIdentities(); }, 30_000);

async function open(accept = true): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  if (accept) page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`${base}/swarm-admin/households`, { waitUntil: 'networkidle' });
  await expect.poll(() => page.locator('#households .sh-card').count()).toBe(world.households.length);
  return page;
}
const card = (page: Page, id: string) => page.locator(`#households .sh-card[data-id="${id}"]`);
const member = (page: Page, id: string, sub: string) => card(page, id).locator('tbody tr').filter({ has: page.locator(`xpath=self::tr[@data-sub="${sub}"]`) });
const banner = (page: Page) => page.locator('#statusBanner').textContent();

describe('the households page in Chromium', () => {
  it('shows every household with its real kind, members named, roles, external members and encoded access-review links; manageable ones offer actions except for the only admin, the others say who manages them', async () => {
    const page = await open();
    expect(await page.locator('#posture').textContent()).toContain('3household(s)');
    expect(await page.locator('#posture').textContent()).toContain('1you manage');
    expect(await page.locator('#posture').textContent()).toContain('5membership(s) in all');
    const ops = card(page, OPS_ID);
    expect(await ops.locator('.sh-name').textContent()).toBe('Ops shop');
    expect(await ops.locator('.sh-kind').textContent()).toBe('team');
    expect(await ops.locator('.sh-manage').textContent()).toBe('you manage it');
    expect(await ops.locator('.sh-meta').textContent()).toContain('2 member(s) + 2 from an external identity provider (managed on the access screen)');
    expect(await ops.locator('.sh-meta').textContent()).toContain('admins: The operator');
    expect(await member(page, OPS_ID, ALICE).locator('td').nth(0).textContent()).toBe(`Alice Example${ALICE}`);
    expect(await member(page, OPS_ID, ALICE).locator('select').inputValue()).toBe('member');
    expect(await member(page, OPS_ID, ALICE).locator('a').getAttribute('href')).toBe(`/access-review?sub=${encodeURIComponent(ALICE)}`);
    expect(await member(page, OPS_ID, ALICE).getByRole('button', { name: 'Remove' }).count()).toBe(1);
    // The only admin is kept: no role select, no Remove.
    expect(await member(page, OPS_ID, OPERATOR.sub).locator('.pill').textContent()).toBe('admin (the only one)');
    expect(await member(page, OPS_ID, OPERATOR.sub).locator('select').count()).toBe(0);
    expect(await member(page, OPS_ID, OPERATOR.sub).getByRole('button', { name: 'Remove' }).count()).toBe(0);
    expect(await ops.locator('.sh-add').isVisible()).toBe(true);
    expect(await ops.locator('.sh-add select[name="memberSub"] option').allTextContents()).toEqual(['Choose a person', 'Bob Example', 'Carol Example']);
    const alices = card(page, ALICES_ID);
    expect(await alices.locator('.sh-name').textContent()).toBe(HOSTILE);
    expect(await alices.locator('.sh-kind').textContent()).toBe('household');
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => document.body.dataset.pwned ?? null)).toBeNull();
    expect(await alices.locator('.sh-manage').textContent()).toBe('managed by its admins');
    expect(await alices.locator('.sh-note').textContent()).toBe('Managed by Alice Example: only a household\'s own admin may add or change its members from this swarm\'s directory.');
    expect(await member(page, ALICES_ID, BOB).locator('.pill').textContent()).toBe('member');
    expect(await member(page, ALICES_ID, BOB).locator('a').getAttribute('href')).toBe(`/access-review?sub=${encodeURIComponent(BOB)}`);
    expect(await alices.getByRole('button', { name: 'Remove' }).count()).toBe(0);
    expect(await alices.locator('.sh-add').isVisible()).toBe(false);
    const orphan = card(page, ORPHAN_ID);
    expect(await orphan.locator('.sh-manage').textContent()).toBe('no admin');
    expect(await orphan.locator('.sh-note').textContent()).toContain('no admin among this swarm\'s members');
    expect(await banner(page)).toBe('3 household(s), 1 you manage.');
  });

  it('adds a member, changes a role and removes a member on a manageable household, keeping each outcome after the reload; a cancelled removal posts nothing; a refusal shows the route\'s text and re-reads', async () => {
    const page = await open(false);
    const ops = card(page, OPS_ID);
    await ops.locator('.sh-add select[name="memberSub"]').selectOption(CAROL);
    await ops.locator('.sh-add select[name="role"]').selectOption('admin');
    await ops.locator('.sh-add button[type="submit"]').click();
    await expect.poll(() => banner(page)).toBe('Ops shop: Carol Example added as admin.');
    expect(world.posted).toEqual([{ method: 'POST', path: `/api/tenants/${OPS_ID}/members`, body: { memberSub: CAROL, role: 'admin' } }]);
    expect(await member(page, OPS_ID, CAROL).locator('select').inputValue()).toBe('admin');
    // Two admins now: the operator gets controls again.
    expect(await member(page, OPS_ID, OPERATOR.sub).locator('select').count()).toBe(1);

    await member(page, OPS_ID, ALICE).locator('select').selectOption('admin');
    await expect.poll(() => banner(page)).toBe('Ops shop: Alice Example is now admin.');
    expect(world.posted.at(-1)).toEqual({ method: 'PATCH', path: `/api/tenants/${OPS_ID}/members/${encodeURIComponent(ALICE)}`, body: { role: 'admin' } });

    page.once('dialog', (dialog) => void dialog.dismiss());
    await member(page, OPS_ID, ALICE).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => member(page, OPS_ID, ALICE).getByRole('button', { name: 'Remove' }).isEnabled()).toBe(true);
    expect(world.posted).toHaveLength(2);
    expect(await member(page, OPS_ID, ALICE).count()).toBe(1);

    page.once('dialog', (dialog) => void dialog.accept());
    await member(page, OPS_ID, ALICE).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => banner(page)).toBe('Ops shop: Alice Example removed.');
    expect(world.posted.at(-1)).toEqual({ method: 'DELETE', path: `/api/tenants/${OPS_ID}/members/${encodeURIComponent(ALICE)}`, body: null });
    expect(await member(page, OPS_ID, ALICE).count()).toBe(0);

    // A refused add shows the route's text and re-reads: the member the server added meanwhile appears.
    world.refuse = 'add';
    await ops.locator('.sh-add select[name="memberSub"]').selectOption(BOB);
    await ops.locator('.sh-add button[type="submit"]').click();
    await expect.poll(() => banner(page)).toBe('Ops shop: not a tenant admin');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('error');
    await expect.poll(() => member(page, OPS_ID, 'stale-sub').count()).toBe(1);
  });

  it('creates a household with its name and kind as the route keeps them, and shows a refused create', async () => {
    const page = await open();
    await page.fill('#createName', 'Night shift');
    await page.selectOption('#createKind', 'org');
    await page.click('#createForm button[type="submit"]');
    await expect.poll(() => banner(page)).toBe('Created "Night shift"; you are its admin.');
    expect(world.posted).toEqual([{ method: 'POST', path: '/api/tenants', body: { name: 'Night shift', kind: 'org' } }]);
    expect(await page.locator('#households .sh-card').count()).toBe(4);
    expect(await card(page, '33333333-3333-4333-8333-333333333333').locator('.sh-kind').textContent()).toBe('team');
    expect(await page.inputValue('#createName')).toBe('');
    world.refuse = 'create';
    await page.fill('#createName', 'Doomed');
    await page.click('#createForm button[type="submit"]');
    await expect.poll(() => page.locator('#createMessage').textContent()).toBe('tenants unavailable');
    expect(await page.locator('#households .sh-card').count()).toBe(4);
  });

  it('says when the directory could not be read, filters by name or member, clears the cards when a load fails, fits a phone, and shows the operator-role banner on a 403', async () => {
    world.directory = '403';
    const page = await open();
    expect(await banner(page)).toBe('3 household(s), 1 you manage. The directory could not be read, so people show by subject and adding must wait for a reload.');
    expect(await member(page, OPS_ID, ALICE).locator('td').nth(0).textContent()).toBe(ALICE);
    expect(await card(page, OPS_ID).locator('.sh-add select[name="memberSub"] option').allTextContents()).toEqual(['The directory could not be read; reload to try again']);
    world.directory = 'normal';
    await page.click('#reload');
    await expect.poll(() => banner(page)).toBe('3 household(s), 1 you manage.');

    await page.fill('#search', 'bob');
    await expect.poll(() => page.locator('#households .sh-card').count()).toBe(1);
    expect(await page.locator('#count').textContent()).toBe('1 of 3 household(s) shown.');
    world.api = '500';
    await page.click('#reload');
    await expect.poll(() => banner(page)).toBe('households_unavailable');
    expect(await page.locator('#households .sh-card').count()).toBe(0);
    expect(await page.locator('#posture li').count()).toBe(0);
    await page.fill('#search', '');
    await expect.poll(() => page.locator('#households .empty').textContent()).toBe('The households could not be read.');
    world.api = 'normal';

    await context.close();
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
    const phone = await open();
    const widths = await phone.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth, table: document.querySelector('.sh-members')!.clientWidth, tableScroll: document.querySelector('.sh-members')!.scrollWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.view);
    expect(widths.tableScroll).toBeGreaterThan(widths.table);

    world.api = '403';
    const other = await context.newPage();
    await other.goto(`${base}/swarm-admin/households`, { waitUntil: 'networkidle' });
    await expect.poll(() => other.locator('#statusBanner').textContent()).toContain('operator role');
  });
});

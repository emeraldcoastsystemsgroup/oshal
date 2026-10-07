/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-9), driven in headless Chromium against the real /swarm-admin/jobs page served through the real surface registration, with the jobs API, the activation route and the schedule control route mocked in the real reply shapes: the overview counts scheduled, running, skipped awaiting activation and paused; one card per service not activated, with a package without a catalog said up front and its button disabled; the schedules table with kinds, the server-clock timezone, owners (system or a shortened subject), times in the viewer's locale, and the service route no activation covers marked skipped; the timers with their states and flags; a hostile application name is text; Activate posts runsAs system and the card disappears after the re-read; the 409 catalog refusal renders the plain sentence on the card with the button enabled again; Pause patches enabled false and the row says paused by the operator with a Resume button; a 409 refusal of the control renders its code and re-enables the button; a 403 shows the operator-role banner and clears every section; the page fits a phone with the tables scrolling inside. Each fails if its fix returns.
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
const HOSTILE = '<img src=x onerror="document.body.dataset.pwned=\'1\'">world';
const CATALOG_SENTENCE = 'This package has no authorization catalog, so its system job cannot be activated under the enforce posture.';
const ISO = '2026-10-06T11:00:00.000Z';

type Service = { app: string; scheduleId: string; id: string; cron: string; runsAs: 'system' | 'user' | null; requires: string[]; state: 'not-activated' | 'active' | 'suspended'; catalog: boolean };
type Schedule = { id: string; taskType: string; kind: string; app: string | null; cron: string; timezone: string | null; status: 'active' | 'paused'; ownerSub: string | null; lastRunAt: string | null; nextRunAt: string | null; executionCount: number; once: boolean; override: { enabled: boolean; cron: string | null } | null };

const world = {
  services: [] as Service[],
  schedules: [] as Schedule[],
  posted: [] as Array<{ method: string; path: string; body: Record<string, unknown> | null }>,
  api: 'normal' as 'normal' | '403' | '500',
  refuse: '' as '' | 'catalog' | 'control',
  reset() {
    this.services = [
      { app: 'intelligent-sales', scheduleId: 'intelligent-sales-email-auto-log', id: 'email-auto-log', cron: '*/15 * * * *', runsAs: 'system', requires: ['crm.write'], state: 'not-activated', catalog: true },
      { app: 'free-library', scheduleId: 'free-library-daily-clean', id: 'daily-clean', cron: '0 4 * * *', runsAs: 'system', requires: [], state: 'not-activated', catalog: false },
      { app: 'scene-studio', scheduleId: 'scene-studio-render', id: 'render', cron: '0 * * * *', runsAs: 'system', requires: ['scene.render'], state: 'active', catalog: true },
    ];
    const base = { timezone: null, ownerSub: null, lastRunAt: ISO, nextRunAt: '2026-10-06T11:15:00.000Z', executionCount: 12, once: false, override: null, status: 'active' as const };
    this.schedules = [
      { ...base, id: 'sched-1', taskType: 'app-route:intelligent-sales-email-auto-log', kind: 'service', app: 'intelligent-sales', cron: '*/15 * * * *' },
      { ...base, id: 'sched-2', taskType: 'app-route:scene-studio-render', kind: 'service', app: 'scene-studio', cron: '0 * * * *' },
      { ...base, id: 'sched-3', taskType: 'app:world-refresh', kind: 'prompt', app: 'world', cron: '0 */6 * * *', timezone: 'America/Chicago' },
      { ...base, id: 'sched-4', taskType: 'trading-event-leg:open', kind: 'trading', app: null, cron: '30 8 * * 1-5', ownerSub: 'idp-operator-long-subject', lastRunAt: null },
      { ...base, id: 'sched-5', taskType: 'social-digest', kind: 'other', app: null, cron: '0 7 * * *', status: 'paused' },
      { ...base, id: 'sched-6', taskType: 'workflow:oshal-dev', kind: 'workflow', app: 'oshal-dev', cron: '0 2 * * *' },
      { ...base, id: 'sched-7', taskType: 'app-route:intelligent-sales-email-auto-log:idpuser1', kind: 'service', app: 'intelligent-sales', cron: '*/15 * * * *', ownerSub: 'idp-user-1' },
      { ...base, id: 'sched-8', taskType: 'nightly-thing', kind: 'other', app: HOSTILE, cron: '0 3 * * *' },
    ];
    this.posted = []; this.api = 'normal'; this.refuse = '';
  },
  view() {
    return {
      generatedAt: ISO, scheduler: { enabled: true, pollIntervalMs: 15000 }, schedules: this.schedules, services: this.services, warnings: [],
      timers: [
        { id: 'schedule-runner', name: 'Schedule runner', cadence: 'polls every 15000 ms', enabled: true, flag: 'ENABLE_AGENT_SCHEDULER', description: 'Fires every scheduled job.' },
        { id: 'haven-push', name: 'Haven push proactivity', cadence: 'every 30 min; each person opts in', enabled: false, flag: 'HAVEN_PUSH_CRON', description: 'Proactive Haven messages.' },
      ],
    };
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
  app.get('/api/admin/jobs', (_q, r) => {
    if (world.api === '403') { r.status(403).json({ error: 'Operator privilege required' }); return; }
    if (world.api === '500') { r.status(500).json({ error: 'jobs_unavailable' }); return; }
    r.json(world.view());
  });
  app.post('/api/swarm/apps/:name/services/:id/activate', (q, r) => {
    if (world.refuse === 'catalog') { r.status(409).json({ error: 'authorization_service_catalog_required' }); return; }
    const service = world.services.find((s) => s.app === q.params.name && s.id === q.params.id);
    if (!service) { r.status(404).json({ error: 'authorization_service_not_declared' }); return; }
    service.state = 'active';
    r.json({ activation: { id: 'act-1', runsAs: (q.body as { runsAs: string }).runsAs, activatedAt: ISO } });
  });
  app.patch('/api/swarm/apps/:name/schedules/:id', (q, r) => {
    if (world.refuse === 'control') { r.status(409).json({ error: 'schedule_not_controllable' }); return; }
    const key = `${q.params.name}-${q.params.id}`;
    const schedule = world.schedules.find((s) => s.taskType === `app-route:${key}` || s.taskType === `app:${key}`);
    if (!schedule) { r.status(404).json({ error: 'schedule_not_found' }); return; }
    const enabled = (q.body as { enabled: boolean }).enabled;
    schedule.status = enabled ? 'active' : 'paused';
    schedule.override = enabled ? null : { enabled: false, cron: null };
    r.json({ schedule: { id: q.params.id, key, enabled, status: schedule.status, override: schedule.override } });
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
  context = await browser.newContext({ viewport: { width: 1200, height: 1600 }, locale: 'en-US' });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
}, 60_000);
afterEach(async () => { await context?.close(); clearPrivilegedIdentities(); }, 30_000);

async function open(): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${base}/swarm-admin/jobs`, { waitUntil: 'networkidle' });
  await expect.poll(() => page.locator('#schedules tbody tr').count()).toBe(world.schedules.length);
  return page;
}
const card = (page: Page, key: string) => page.locator(`#activation .sj-card[data-key="${key}"]`);
const row = (page: Page, id: string) => page.locator(`#schedules tbody tr[data-id="${id}"]`);
const banner = (page: Page) => page.locator('#statusBanner').textContent();

describe('the jobs page in Chromium', () => {
  it('shows the overview, the services awaiting activation (a catalog-less one said up front, button disabled), the schedules with kinds, clocks, owners and the skipped service route, the timers, and a hostile name as text', async () => {
    const page = await open();
    const posture = await page.locator('#posture').textContent();
    for (const part of ['8job(s) scheduled', '6running', '1skipped awaiting activation', '1paused', 'onscheduler runner']) expect(posture).toContain(part);
    expect(await banner(page)).toBe('8 job(s) scheduled, 6 running, 1 skipped awaiting activation, 1 paused.');
    expect(await page.locator('#activation .sj-card').count()).toBe(2);
    const sales = card(page, 'intelligent-sales/intelligent-sales-email-auto-log');
    expect(await sales.locator('.sj-app').textContent()).toBe('intelligent-sales');
    expect(await sales.locator('.sj-meta').textContent()).toBe('Job intelligent-sales-email-auto-log · cron */15 * * * * · proposed to run as system');
    expect(await sales.locator('.sj-requires').textContent()).toBe('Requires: crm.write');
    expect(await sales.locator('.sj-note').isVisible()).toBe(false);
    expect(await sales.locator('.sj-activate').isEnabled()).toBe(true);
    const library = card(page, 'free-library/free-library-daily-clean');
    expect(await library.locator('.sj-note').textContent()).toBe(CATALOG_SENTENCE);
    expect(await library.locator('.sj-requires').textContent()).toBe('Requires no permissions.');
    expect(await library.locator('.sj-activate').isDisabled()).toBe(true);
    // The schedules table.
    expect(await row(page, 'sched-1').getAttribute('data-skipped')).toBe('yes');
    expect(await row(page, 'sched-1').locator('td').nth(5).textContent()).toBe('activeskipped: not activated');
    expect(await row(page, 'sched-1').locator('td').nth(9).textContent()).toBe('system');
    expect(await row(page, 'sched-1').locator('td').nth(6).textContent()).toContain('2026');
    expect(await row(page, 'sched-2').getAttribute('data-skipped')).toBe('no');
    expect(await row(page, 'sched-3').locator('td').nth(2).textContent()).toBe('prompt');
    expect(await row(page, 'sched-3').locator('td').nth(4).textContent()).toBe('America/Chicago');
    expect(await row(page, 'sched-4').locator('td').nth(4).textContent()).toBe('server clock (UTC)');
    expect(await row(page, 'sched-4').locator('td').nth(6).textContent()).toBe('—');
    expect(await row(page, 'sched-4').locator('td').nth(9).textContent()).toBe('idp-oper…');
    expect(await row(page, 'sched-5').locator('td').nth(5).textContent()).toBe('paused');
    expect(await row(page, 'sched-5').locator('button').count()).toBe(0);
    expect(await row(page, 'sched-7').locator('button').count()).toBe(0);
    expect(await row(page, 'sched-1').locator('button').textContent()).toBe('Pause');
    expect(await row(page, 'sched-3').locator('button').textContent()).toBe('Pause');
    expect(await row(page, 'sched-8').locator('td').nth(0).textContent()).toBe(HOSTILE);
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => document.body.dataset.pwned ?? null)).toBeNull();
    // The timers.
    expect(await page.locator('#timers tbody tr').count()).toBe(2);
    expect(await page.locator('#timers tbody tr[data-id="schedule-runner"] td').nth(2).textContent()).toBe('on');
    expect(await page.locator('#timers tbody tr[data-id="haven-push"] td').nth(2).textContent()).toBe('off');
    expect(await page.locator('#timers tbody tr[data-id="haven-push"] td').nth(3).textContent()).toBe('HAVEN_PUSH_CRON');
  });

  it('activates a service as the application, re-reads, and the card disappears; the catalog refusal renders its sentence on the card with the button enabled again', async () => {
    const page = await open();
    const sales = card(page, 'intelligent-sales/intelligent-sales-email-auto-log');
    await sales.locator('.sj-activate').click();
    await expect.poll(() => banner(page)).toBe('intelligent-sales-email-auto-log is activated as the application; the scheduler runs it from its next tick.');
    expect(world.posted).toEqual([{ method: 'POST', path: '/api/swarm/apps/intelligent-sales/services/email-auto-log/activate', body: { runsAs: 'system' } }]);
    expect(await page.locator('#activation .sj-card').count()).toBe(1);
    expect(await sales.count()).toBe(0);
    expect(await row(page, 'sched-1').getAttribute('data-skipped')).toBe('no');
    expect(await page.locator('#posture').textContent()).toContain('0skipped awaiting activation');

    world.reset();
    world.refuse = 'catalog';
    await page.click('#reload');
    await expect.poll(() => page.locator('#activation .sj-card').count()).toBe(2);
    const again = card(page, 'intelligent-sales/intelligent-sales-email-auto-log');
    await again.locator('.sj-activate').click();
    await expect.poll(() => card(page, 'intelligent-sales/intelligent-sales-email-auto-log').locator('.sj-note').textContent()).toBe(CATALOG_SENTENCE);
    const refused = card(page, 'intelligent-sales/intelligent-sales-email-auto-log');
    expect(await refused.locator('.sj-note').getAttribute('data-tone')).toBe('error');
    expect(await refused.locator('.sj-activate').isEnabled()).toBe(true);
    expect(await banner(page)).toBe(`intelligent-sales-email-auto-log: ${CATALOG_SENTENCE}`);
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('error');
    expect(await page.locator('#activation .sj-card').count()).toBe(2);
  });

  it('pauses a manifest schedule through the control route and shows it paused by the operator with Resume; a refused control renders its code and re-enables the button', async () => {
    const page = await open();
    await row(page, 'sched-1').locator('button').click();
    await expect.poll(() => banner(page)).toBe('app-route:intelligent-sales-email-auto-log paused by you; the scheduler skips it until it is resumed.');
    expect(world.posted).toEqual([{ method: 'PATCH', path: '/api/swarm/apps/intelligent-sales/schedules/email-auto-log', body: { enabled: false } }]);
    expect(await row(page, 'sched-1').locator('td').nth(5).textContent()).toBe('paused by the operatorskipped: not activated');
    expect(await row(page, 'sched-1').locator('button').textContent()).toBe('Resume');
    expect(await page.locator('#posture').textContent()).toContain('2paused');

    world.refuse = 'control';
    await row(page, 'sched-1').locator('button').click();
    await expect.poll(() => banner(page)).toBe('app-route:intelligent-sales-email-auto-log: the swarm refused the change: schedule not controllable (HTTP 409).');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('error');
    expect(await row(page, 'sched-1').locator('button').isEnabled()).toBe(true);
    expect(await row(page, 'sched-1').locator('button').textContent()).toBe('Resume');
    expect(world.posted).toHaveLength(2);

    world.refuse = '';
    await row(page, 'sched-1').locator('button').click();
    await expect.poll(() => banner(page)).toBe('app-route:intelligent-sales-email-auto-log resumed; the scheduler runs it from its next tick.');
    expect(world.posted.at(-1)).toEqual({ method: 'PATCH', path: '/api/swarm/apps/intelligent-sales/schedules/email-auto-log', body: { enabled: true } });
    expect(await row(page, 'sched-1').locator('button').textContent()).toBe('Pause');
  });

  it('clears every section when a load fails, shows the operator-role banner on a 403, and fits a phone with the tables scrolling inside', async () => {
    const page = await open();
    world.api = '500';
    await page.click('#reload');
    await expect.poll(() => banner(page)).toBe('jobs_unavailable');
    expect(await page.locator('#posture li').count()).toBe(0);
    expect(await page.locator('#activation .sj-card').count()).toBe(0);
    expect(await page.locator('#activation .empty').textContent()).toBe('The jobs could not be read.');
    expect(await page.locator('#schedules tbody tr').count()).toBe(0);
    expect(await page.locator('#timers tbody tr').count()).toBe(0);

    world.api = '403';
    const other = await context.newPage();
    await other.goto(`${base}/swarm-admin/jobs`, { waitUntil: 'networkidle' });
    await expect.poll(() => other.locator('#statusBanner').textContent()).toContain('operator role');
    expect(await other.locator('#activation .sj-card').count()).toBe(0);
    expect(await other.locator('#schedules tbody tr').count()).toBe(0);
    world.api = 'normal';

    await context.close();
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
    const phone = await open();
    const widths = await phone.evaluate(() => ({
      doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth,
      wrap: document.querySelector('#schedules')!.parentElement!.clientWidth, table: document.querySelector('#schedules')!.scrollWidth,
    }));
    expect(widths.doc).toBeLessThanOrEqual(390);
    expect(widths.doc).toBeLessThanOrEqual(widths.view);
    expect(widths.table).toBeGreaterThan(widths.wrap);
  });
});

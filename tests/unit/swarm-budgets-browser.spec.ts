/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-5), driven in headless Chromium against the real /swarm-admin/budgets page served through the real surface registration, with the budgets, directory, apps and governance APIs mocked: a cap names its person from the directory and its application from the app list; unknown spend is a dash, never zero; the posture strip says plainly when the LLM gate env switch is off and states the runaway thresholds; the set-a-cap form sends the chosen person's subject and the cap, and the new row appears with the outcome still in the banner after the reload; switch and edit send the whole cap; remove asks, sends the scope, and keeps a 404's text; the scope picker hides the fields it does not need; the caps still render when the governance status cannot be read; the window picker re-reads with its hours; a 403 shows the operator-role banner. Each fails if its fix returns.
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

type Cap = { scopeType: 'user' | 'app' | 'ticket'; scopeKey: string; dailyUsd: number; hard: boolean; enabled: boolean; setByOperator: boolean; spendUsd: number | null };

/** The mocked swarm: the caps, whether the gate is on, what the governance route does, and what was posted. */
const swarm = {
  caps: [] as Cap[],
  gateOn: false,
  governance: 'normal' as 'normal' | 'down',
  api: 'normal' as 'normal' | '403',
  posted: [] as Array<{ path: string; body: Record<string, unknown> }>,
  stateQueries: [] as string[],
  reset() {
    this.caps = [
      { scopeType: 'user', scopeKey: PERSON_SUB, dailyUsd: 12, hard: true, enabled: true, setByOperator: true, spendUsd: 3.5 },
      { scopeType: 'app', scopeKey: 'wiki-app', dailyUsd: 40, hard: false, enabled: false, setByOperator: false, spendUsd: null },
      { scopeType: 'ticket', scopeKey: 'TCK-9', dailyUsd: 1, hard: true, enabled: true, setByOperator: true, spendUsd: 1.2 },
    ];
    this.gateOn = false; this.governance = 'normal'; this.api = 'normal'; this.posted = []; this.stateQueries = [];
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
  app.get('/api/budgets/state', (q, r) => {
    if (swarm.api === '403') { r.status(403).json({ success: false, error: 'Operator privilege required' }); return; }
    swarm.stateQueries.push(String(q.query.windowHours ?? ''));
    r.json({
      success: true, windowHours: Number(q.query.windowHours) || 24, runaway: { max: 25, windowMin: 30 }, eventCooldownMin: 30,
      budgets: swarm.caps.map((cap, i) => ({ id: i + 1, ...cap, createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z' })),
      events: [{ id: 1, scopeType: 'ticket', scopeKey: 'TCK-9', spendUsd: 1.2, capUsd: 1, action: 'hard_block', detail: { reason: 'breach' }, ts: '2026-10-06T12:30:00.000Z' }],
    });
  });
  app.post('/api/budgets', (q, r) => {
    const body = q.body as Record<string, unknown>;
    swarm.posted.push({ path: '/api/budgets', body });
    const next: Cap = { scopeType: body.scopeType as Cap['scopeType'], scopeKey: String(body.scopeKey), dailyUsd: Number(body.dailyUsd), hard: Boolean(body.hard), enabled: Boolean(body.enabled), setByOperator: true, spendUsd: 0 };
    const at = swarm.caps.findIndex((cap) => cap.scopeType === next.scopeType && cap.scopeKey === next.scopeKey);
    if (at >= 0) swarm.caps[at] = next; else swarm.caps.push(next);
    r.json({ success: true, budget: next });
  });
  app.post('/api/budgets/remove', (q, r) => {
    const body = q.body as Record<string, unknown>;
    swarm.posted.push({ path: '/api/budgets/remove', body });
    const at = swarm.caps.findIndex((cap) => cap.scopeType === body.scopeType && cap.scopeKey === body.scopeKey);
    if (at < 0) { r.status(404).json({ success: false, removed: false, error: 'No cap for that scope' }); return; }
    swarm.caps.splice(at, 1);
    r.json({ success: true, removed: true });
  });
  app.get('/api/user-directory', (_q, r) => r.json({ revision: 1, users: [
    { sub: PERSON_SUB, issuer: 'https://login.example.test/tenant', label: PERSON_LABEL, email: 'pat@example.test', source: 'verified-sign-in', signIn: 'active', lastSeenAt: null },
    { sub: OPERATOR.sub, issuer: OPERATOR.iss, label: 'The operator', email: OPERATOR.email, source: 'verified-sign-in', signIn: 'active', lastSeenAt: null },
  ], historical: [], providers: [], explanation: '' }));
  app.get('/api/swarm/apps', (_q, r) => r.json({ apps: [{ name: 'wiki-app', displayName: 'Team Wiki', status: 'active' }, { name: 'other-app', displayName: 'Other', status: 'inactive' }] }));
  app.get('/api/llm-governance/status', (_q, r) => {
    if (swarm.governance === 'down') { r.status(500).json({ success: false, error: 'boom' }); return; }
    r.json({ enforcement: { on: swarm.gateOn, budgets: swarm.gateOn, quotas: false, routing: false, envFlag: 'OSHAL_LLM_BUDGETS' } });
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
  swarm.reset();
  context = await browser.newContext({ viewport: { width: 1200, height: 1400 } });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
}, 60_000);
afterEach(async () => { await context?.close(); clearPrivilegedIdentities(); }, 30_000);

async function open(): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`${base}/swarm-admin/budgets`, { waitUntil: 'networkidle' });
  await expect.poll(() => page.locator('#caps tr[data-scope]').count()).toBe(swarm.caps.length);
  return page;
}
const row = (page: Page, scope: string) => page.locator(`#caps tr[data-scope="${scope}"]`);
const banner = (page: Page) => page.locator('#statusBanner').textContent();

describe('the budgets page in Chromium', () => {
  it('names the person and the application, shows unknown spend as a dash, and states the posture', async () => {
    const page = await open();
    const person = row(page, `user:${PERSON_SUB}`);
    expect(await person.locator('td').nth(1).textContent()).toBe(PERSON_LABEL);
    expect(await person.locator('td').nth(2).textContent()).toBe('$12.0000');
    expect(await person.locator('td').nth(3).textContent()).toContain('$3.5000');
    expect(await person.locator('td').nth(5).textContent()).toBe('Stops work');
    expect(await person.locator('td').nth(6).textContent()).toBe('On');
    expect(await person.locator('td').nth(7).textContent()).toBe('an administrator');
    const app = row(page, 'app:wiki-app');
    expect(await app.locator('td').nth(1).textContent()).toBe('Team Wiki');
    expect(await app.locator('td').nth(3).textContent()).toBe('—');
    expect(await app.locator('td').nth(3).textContent()).not.toContain('0.0000');
    expect(await app.locator('td').nth(4).textContent()).toBe('—');
    expect(await app.locator('td').nth(5).textContent()).toBe('Warns only');
    expect(await app.locator('td').nth(6).textContent()).toBe('Off');
    expect(await app.locator('td').nth(7).textContent()).toBe('the person');
    const posture = await page.locator('#posture').textContent();
    expect(posture).toContain('NOT enforced');
    expect(posture).toContain('OSHAL_LLM_BUDGETS');
    expect(posture).toContain('25 events in 30 min');
    expect(await page.locator('#posture li').first().getAttribute('data-state')).toBe('off');
    expect(await page.locator('#events tr').count()).toBe(1);
    expect(await page.locator('#events td').nth(3).textContent()).toBe('TCK-9');
    expect(await banner(page)).toContain('spend unreadable for 1 cap(s)');
    swarm.gateOn = true;
    await page.reload({ waitUntil: 'networkidle' });
    await expect.poll(() => page.locator('#posture').textContent()).toContain('are enforced');
  });

  it('sets a cap from the form with the chosen person\'s subject and keeps the outcome after the reload', async () => {
    swarm.caps = [];
    const page = await open();
    expect(await page.locator('#caps td.empty').textContent()).toContain('No caps are set');
    await expect.poll(() => page.locator('#personSelect option').count()).toBe(3);
    await page.selectOption('#personSelect', PERSON_SUB);
    await page.fill('#dailyUsd', '7.5');
    await page.uncheck('#hard');
    await page.click('#setCapForm button[type="submit"]');
    await expect.poll(() => page.locator('#caps tr[data-scope]').count()).toBe(1);
    expect(swarm.posted[0]).toEqual({ path: '/api/budgets', body: { scopeType: 'user', scopeKey: PERSON_SUB, dailyUsd: 7.5, hard: false, enabled: true } });
    expect(await banner(page)).toBe(`${PERSON_LABEL}: cap set to $7.50 per day.`);
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('success');
    expect(await row(page, `user:${PERSON_SUB}`).locator('td').nth(1).textContent()).toBe(PERSON_LABEL);
    // The reset form: a cap without a person is refused on the page, and nothing is posted.
    await page.fill('#dailyUsd', '1');
    await page.click('#setCapForm button[type="submit"]');
    await expect.poll(() => page.locator('#setMessage').textContent()).toBe('Choose a person.');
    expect(await page.locator('#setMessage').getAttribute('data-tone')).toBe('error');
    expect(swarm.posted).toHaveLength(1);
  });

  it('switches and edits a cap by sending the whole cap, and removes one after asking', async () => {
    const page = await open();
    await row(page, 'app:wiki-app').getByRole('button', { name: 'Switch on' }).click();
    await expect.poll(() => banner(page)).toBe('Team Wiki: cap switched on.');
    expect(swarm.posted.at(-1)).toEqual({ path: '/api/budgets', body: { scopeType: 'app', scopeKey: 'wiki-app', dailyUsd: 40, hard: false, enabled: true } });
    expect(await row(page, 'app:wiki-app').locator('td').nth(6).textContent()).toBe('On');

    await row(page, 'ticket:TCK-9').getByRole('button', { name: 'Edit' }).click();
    const edit = page.locator('#caps .sb-edit-row form');
    expect(await edit.locator('[name="dailyUsd"]').inputValue()).toBe('1');
    await edit.locator('[name="dailyUsd"]').fill('2.25');
    await edit.locator('[name="hard"]').uncheck();
    await edit.locator('button[type="submit"]').click();
    await expect.poll(() => banner(page)).toBe('TCK-9: cap saved.');
    expect(swarm.posted.at(-1)).toEqual({ path: '/api/budgets', body: { scopeType: 'ticket', scopeKey: 'TCK-9', dailyUsd: 2.25, hard: false, enabled: true } });
    expect(await page.locator('#caps .sb-edit-row').count()).toBe(0);
    expect(await row(page, 'ticket:TCK-9').locator('td').nth(2).textContent()).toBe('$2.2500');

    await row(page, `user:${PERSON_SUB}`).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => banner(page)).toBe(`${PERSON_LABEL}: cap removed.`);
    expect(swarm.posted.at(-1)).toEqual({ path: '/api/budgets/remove', body: { scopeType: 'user', scopeKey: PERSON_SUB } });
    expect(await page.locator('#caps tr[data-scope]').count()).toBe(2);

    swarm.caps.push({ scopeType: 'ticket', scopeKey: 'GONE', dailyUsd: 1, hard: true, enabled: true, setByOperator: true, spendUsd: 0 });
    await page.click('#reload');
    await expect.poll(() => page.locator('#caps tr[data-scope]').count()).toBe(3);
    swarm.caps = swarm.caps.filter((cap) => cap.scopeKey !== 'GONE');
    await row(page, 'ticket:GONE').getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => banner(page)).toBe('No cap for that scope');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('error');
  });

  it('shows only the field the chosen scope needs, and re-reads with the chosen window', async () => {
    const page = await open();
    expect(await page.locator('#personField').isVisible()).toBe(true);
    expect(await page.locator('#appField').isVisible()).toBe(false);
    expect(await page.locator('#ticketField').isVisible()).toBe(false);
    await page.selectOption('#scopeType', 'app');
    expect(await page.locator('#personField').isVisible()).toBe(false);
    expect(await page.locator('#appField').isVisible()).toBe(true);
    await expect.poll(() => page.locator('#appSelect option').count()).toBe(3);
    expect(await page.locator('#appSelect option').nth(1).textContent()).toBe('Team Wiki (active)');
    await page.selectOption('#scopeType', 'ticket');
    expect(await page.locator('#appField').isVisible()).toBe(false);
    expect(await page.locator('#ticketField').isVisible()).toBe(true);
    await page.selectOption('#windowHours', '168');
    await expect.poll(() => swarm.stateQueries.at(-1)).toBe('168');
    await expect.poll(() => banner(page)).toContain('window 168 h');
  });

  it('still renders the caps when the governance status cannot be read, and says so', async () => {
    swarm.governance = 'down';
    const page = await open();
    expect(await page.locator('#posture').textContent()).toContain('could not be read');
    expect(await row(page, `user:${PERSON_SUB}`).locator('td').nth(1).textContent()).toBe(PERSON_LABEL);
  });

  it('shows the operator-role banner on a 403', async () => {
    swarm.api = '403';
    const page = await context.newPage();
    await page.goto(`${base}/swarm-admin/budgets`, { waitUntil: 'networkidle' });
    await expect.poll(() => banner(page)).toContain('operator role');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('error');
    expect(await page.locator('#caps td.empty').textContent()).toContain('could not be read');
  });
});

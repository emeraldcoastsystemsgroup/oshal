/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-5), driven in headless Chromium against the real /swarm-admin/connectors page served through the real surface registration, with the marketplace routes mocked in the real reply shapes (audit issues are {level:'warn'|'error', message}): the totals strip (write and tool counts computed from the rows, not the summary's unrelated figures) and every catalog row with its sign-in, risk, tools, audit reasons inline and state; a hostile label renders as text and runs nothing; the text, state, risk and category filters, where the machine tags match nothing; enable and disable quote the tools registered or deregistered and the outcome is still in the banner after the reload, while a remove or re-audit of a never-enabled connector quotes none; remove asks, and a cancelled dialog posts nothing; a connector that failed its audit gets no Enable button but the reason; a refused action shows the route's text AND re-reads the row, which may already have changed; a failed load clears the rows and a filter touch does not bring them back; the page does not overflow a phone's width; the export link; a 403 shows the operator-role banner. Each fails if its fix returns.
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
const HOSTILE = '<img src=x onerror="document.body.dataset.pwned=\'1\'">Weather';

type Issue = { level: 'warn' | 'error'; message: string };
type Entry = { id: string; label: string; category: string; tags: string[]; authType: string; onboarding: { label: string; credentialScope: string }; installState: string; enabled: boolean; riskLevel: string; toolCount: number; readCount: number; writeCount: number; destructiveCount: number; audit: { pass: boolean; errors: number; warnings: number; issues: Issue[] } };

/** The mocked marketplace: its entries, what was posted, which action fails after the state changed, and whether the API refuses. */
const market = {
  entries: [] as Entry[],
  posted: [] as string[],
  api: 'normal' as 'normal' | '403' | '500',
  failAfterState: '' as string,
  reset() {
    this.entries = [
      { id: 'github', label: 'GitHub', category: 'devops', tags: ['git', 'code', 'action:read', 'setup:self-serve', 'GET'], authType: 'oauth2', onboarding: { label: 'Sign in with GitHub', credentialScope: 'per-user' }, installState: 'enabled', enabled: true, riskLevel: 'medium', toolCount: 12, readCount: 9, writeCount: 3, destructiveCount: 0, audit: { pass: true, errors: 0, warnings: 1, issues: [{ level: 'warn', message: 'scope list is broad' }] } },
      { id: 'slack', label: 'Slack', category: 'messaging', tags: ['chat', 'action:read', 'action:write', 'POST'], authType: 'oauth2', onboarding: { label: 'Sign in with Slack', credentialScope: 'per-user' }, installState: 'available', enabled: false, riskLevel: 'high', toolCount: 6, readCount: 2, writeCount: 4, destructiveCount: 1, audit: { pass: true, errors: 0, warnings: 0, issues: [] } },
      { id: 'legacy-crm', label: 'Legacy CRM', category: 'sales', tags: ['action:read'], authType: 'apiKey', onboarding: { label: 'Operator token', credentialScope: 'operator' }, installState: 'blocked', enabled: false, riskLevel: 'low', toolCount: 2, readCount: 2, writeCount: 0, destructiveCount: 0, audit: { pass: false, errors: 2, warnings: 9, issues: [{ level: 'warn', message: 'w1' }, { level: 'warn', message: 'w2' }, { level: 'error', message: 'no auth block' }] } },
      { id: 'weather', label: HOSTILE, category: 'data', tags: ['forecast', 'GET'], authType: 'none', onboarding: { label: 'No sign-in', credentialScope: 'none' }, installState: 'removed', enabled: false, riskLevel: 'low', toolCount: 1, readCount: 1, writeCount: 0, destructiveCount: 0, audit: { pass: true, errors: 0, warnings: 0, issues: [] } },
    ];
    this.posted = []; this.api = 'normal'; this.failAfterState = '';
  },
  summary() {
    const e = this.entries;
    // The real summary's writeCapable and actionCount are not what their names say; the page must not show them.
    return { generatedAt: '2026-10-06T12:00:00.000Z', totals: { entries: e.length, enabled: e.filter((x) => x.enabled).length, available: e.filter((x) => x.installState === 'available').length, disabled: e.filter((x) => x.installState === 'disabled').length, removed: e.filter((x) => x.installState === 'removed').length, blocked: e.filter((x) => x.installState === 'blocked').length, highRisk: e.filter((x) => x.riskLevel === 'high').length, writeCapable: 99, actionCount: 1103 }, entries: e };
  },
};

const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) next(); else res.redirect(302, '/login');
};

function buildServer(): express.Express {
  const app = express();
  app.use((req, _res, next) => { Object.assign(req, { oidc: { isAuthenticated: () => true, user: OPERATOR } }); next(); });
  app.get('/login', (_q, r) => r.type('html').send('<html><body>Sign in</body></html>'));
  app.get('/api/connectors/marketplace', (_q, r) => {
    if (market.api === '403') { r.status(403).json({ success: false, error: 'Operator privilege required' }); return; }
    if (market.api === '500') { r.status(500).json({ success: false, error: 'catalog scan failed' }); return; }
    r.json({ success: true, data: market.summary() });
  });
  app.post('/api/connectors/marketplace/:provider/:action', (q, r) => {
    const key = `${q.params.provider}/${q.params.action}`;
    market.posted.push(key);
    const entry = market.entries.find((e) => e.id === q.params.provider);
    if (!entry) { r.status(404).json({ success: false, error: `Connector '${q.params.provider}' is not in the local marketplace catalog.` }); return; }
    const tools = Array.from({ length: entry.toolCount }, (_, i) => `${entry.id}_${i}`);
    if (q.params.action === 'enable') {
      if (!entry.audit.pass) { r.status(400).json({ success: false, error: `Connector '${entry.id}' failed the audit gate and cannot be enabled.` }); return; }
      entry.enabled = true; entry.installState = 'enabled'; // the real service writes its state before the tool step
      if (market.failAfterState === key) { r.status(500).json({ success: false, error: 'tool registry unavailable' }); return; }
      r.json({ success: true, data: { entry, registeredTools: tools, summary: market.summary().totals } });
      return;
    }
    if (q.params.action === 'disable') { entry.enabled = false; entry.installState = 'disabled'; r.json({ success: true, data: { entry, deregisteredTools: tools, summary: market.summary().totals } }); return; }
    // The real route deregisters BY SPEC: a never-enabled connector's remove or re-audit still names every tool.
    if (q.params.action === 'remove') { entry.enabled = false; entry.installState = 'removed'; r.json({ success: true, data: { entry, deregisteredTools: tools, summary: market.summary().totals } }); return; }
    if (q.params.action === 'audit-refresh') { r.json({ success: true, data: { entry, registeredTools: entry.enabled ? tools : [], deregisteredTools: entry.enabled ? [] : tools, summary: market.summary().totals } }); return; }
    r.status(404).json({ success: false, error: 'no such action' });
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
  market.reset();
  context = await browser.newContext({ viewport: { width: 1200, height: 1400 } });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
}, 60_000);
afterEach(async () => { await context?.close(); clearPrivilegedIdentities(); }, 30_000);

async function open(accept = true): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  if (accept) page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`${base}/swarm-admin/connectors`, { waitUntil: 'networkidle' });
  await expect.poll(() => page.locator('#catalog tr[data-id]').count()).toBe(market.entries.length);
  return page;
}
const row = (page: Page, id: string) => page.locator(`#catalog tr[data-id="${id}"]`);
const banner = (page: Page) => page.locator('#statusBanner').textContent();
const shown = async (page: Page) => page.locator('#catalog tr[data-id]').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.id));

describe('the connectors page in Chromium', () => {
  it('shows honest totals and every connector with its sign-in, risk, tools, audit reasons and state; a hostile label is text', async () => {
    const page = await open();
    const totals = await page.locator('#totals').textContent();
    expect(totals).toContain('4in the catalog');
    expect(totals).toContain('1enabled');
    expect(totals).toContain('1blocked by audit');
    expect(totals).toContain('1high risk');
    expect(totals).toContain('2with write actions');
    expect(totals).toContain('21tools in all');
    expect(totals).not.toContain('99');
    expect(totals).not.toContain('1103');
    const github = row(page, 'github');
    expect(await github.locator('td').nth(0).textContent()).toBe('GitHubgithub');
    expect(await github.locator('td').nth(2).textContent()).toBe('Sign in with GitHubeach person signs in');
    expect(await github.locator('td').nth(3).textContent()).toBe('medium');
    expect(await github.locator('td').nth(4).textContent()).toBe('129 read · 3 write · 0 destructive');
    expect(await github.locator('td').nth(5).locator('.pill').textContent()).toBe('passes, 1 warning(s)');
    expect(await github.locator('td').nth(5).locator('.sc-issues li').allTextContents()).toEqual(['warn: scope list is broad']);
    expect(await github.locator('td').nth(6).textContent()).toBe('Enabled');
    expect(await github.getByRole('button', { name: 'Disable' }).count()).toBe(1);
    const crm = row(page, 'legacy-crm');
    expect(await crm.locator('td').nth(5).locator('.pill').textContent()).toBe('fails (2 error(s))');
    expect(await crm.locator('td').nth(5).locator('.sc-issues li').allTextContents()).toEqual(['error: no auth block', 'warn: w1', 'warn: w2', '+8 more']);
    expect(await crm.locator('td').nth(6).textContent()).toBe('Blocked');
    expect(await crm.getByRole('button', { name: 'Enable' }).count()).toBe(0);
    expect(await crm.locator('.sc-why').textContent()).toBe('Fix the audit before enabling.');
    const weather = row(page, 'weather');
    expect(await weather.locator('td').nth(0).textContent()).toBe(`${HOSTILE}weather`);
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => document.body.dataset.pwned ?? null)).toBeNull();
    expect(await weather.getByRole('button', { name: 'Remove' }).count()).toBe(0);
    expect(await page.locator('#exportLink').getAttribute('href')).toBe('/api/connectors/marketplace/audit-export?format=csv');
    expect(await banner(page)).toBe('1 of 4 connector(s) enabled.');
  });

  it('filters by text (not by the machine tags), state, risk and category, and says how many are shown', async () => {
    const page = await open();
    await page.fill('#search', 'chat');
    await expect.poll(() => shown(page)).toEqual(['slack']);
    expect(await page.locator('#count').textContent()).toBe('1 of 4 connector(s) shown.');
    for (const machine of ['action', 'read', 'setup', 'get']) {
      await page.fill('#search', machine);
      await expect.poll(() => shown(page), machine).toEqual([]);
    }
    await page.fill('#search', '');
    await page.selectOption('#stateFilter', 'blocked');
    await expect.poll(() => shown(page)).toEqual(['legacy-crm']);
    await page.selectOption('#stateFilter', '');
    await page.selectOption('#riskFilter', 'low');
    await expect.poll(() => shown(page)).toEqual(['legacy-crm', 'weather']);
    await page.selectOption('#categoryFilter', 'data');
    await expect.poll(() => shown(page)).toEqual(['weather']);
    await page.selectOption('#riskFilter', 'high');
    await expect.poll(() => page.locator('#catalog td.empty').textContent()).toContain('No connector matches');
  });

  it('enables, disables, re-audits and removes through the operator routes, quoting tools only when they were real', async () => {
    const page = await open();
    await row(page, 'slack').getByRole('button', { name: 'Enable' }).click();
    await expect.poll(() => banner(page)).toBe('Slack: enabled (6 tool(s) registered).');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('success');
    expect(market.posted).toEqual(['slack/enable']);
    expect(await row(page, 'slack').locator('td').nth(6).textContent()).toBe('Enabled');
    expect(await page.locator('#totals').textContent()).toContain('2enabled');

    await row(page, 'github').getByRole('button', { name: 'Disable' }).click();
    await expect.poll(() => banner(page)).toBe('GitHub: disabled (12 tool(s) deregistered).');
    expect(await row(page, 'github').locator('td').nth(6).textContent()).toBe('Disabled');
    expect(await row(page, 'github').getByRole('button', { name: 'Enable' }).count()).toBe(1);

    // Never enabled now: the route still names every tool, the page must not.
    await row(page, 'github').getByRole('button', { name: 'Re-audit' }).click();
    await expect.poll(() => banner(page)).toBe('GitHub: re-audited: passes.');
    await row(page, 'legacy-crm').getByRole('button', { name: 'Re-audit' }).click();
    await expect.poll(() => banner(page)).toBe('Legacy CRM: re-audited: fails, so it is not enabled.');
    await row(page, 'github').getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => banner(page)).toBe('GitHub: removed from the shelf.');
    expect(await row(page, 'github').locator('td').nth(6).textContent()).toBe('Removed');
    expect(await row(page, 'github').getByRole('button', { name: 'Remove' }).count()).toBe(0);

    // Enabled: a remove does deregister real tools, and says so.
    await row(page, 'slack').getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => banner(page)).toBe('Slack: removed from the shelf (6 tool(s) deregistered).');
    expect(market.posted.at(-1)).toBe('slack/remove');
  });

  it('asks before removing, and a cancelled dialog posts nothing', async () => {
    const page = await open(false);
    const messages: string[] = [];
    page.once('dialog', (dialog) => { messages.push(dialog.message()); void dialog.dismiss(); });
    await row(page, 'slack').getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toContain('Remove Slack from the shelf?');
    expect(market.posted).toEqual([]);
    expect(await row(page, 'slack').locator('td').nth(6).textContent()).toBe('Available');
    expect(await row(page, 'slack').getByRole('button', { name: 'Remove' }).isEnabled()).toBe(true);
  });

  it('shows the route\'s refusal text and re-reads the row, which the service may already have changed', async () => {
    const page = await open();
    market.failAfterState = 'slack/enable';
    await row(page, 'slack').getByRole('button', { name: 'Enable' }).click();
    await expect.poll(() => banner(page)).toBe('Slack: tool registry unavailable');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('error');
    expect(await row(page, 'slack').locator('td').nth(6).textContent()).toBe('Enabled');
    expect(await row(page, 'slack').getByRole('button', { name: 'Disable' }).count()).toBe(1);

    // A stale page can still post an enable for a blocked connector; the refusal is shown as the route said it.
    market.entries[2].audit.pass = true; market.entries[2].installState = 'available';
    await page.click('#reload');
    await expect.poll(() => row(page, 'legacy-crm').getByRole('button', { name: 'Enable' }).count()).toBe(1);
    market.entries[2].audit.pass = false;
    await row(page, 'legacy-crm').getByRole('button', { name: 'Enable' }).click();
    await expect.poll(() => banner(page)).toBe("Legacy CRM: Connector 'legacy-crm' failed the audit gate and cannot be enabled.");
  });

  it('clears the rows when a load fails, and a filter touch does not bring stale rows back', async () => {
    const page = await open();
    market.api = '500';
    await page.click('#reload');
    await expect.poll(() => banner(page)).toBe('catalog scan failed');
    expect(await page.locator('#catalog tr[data-id]').count()).toBe(0);
    expect(await page.locator('#totals li').count()).toBe(0);
    await page.fill('#search', 'git');
    await page.selectOption('#stateFilter', 'enabled');
    await expect.poll(() => page.locator('#catalog td.empty').textContent()).toBe('The catalog could not be read.');
    expect(await page.locator('#catalog tr[data-id]').count()).toBe(0);
    expect(await page.locator('#count').textContent()).toBe('');
  });

  it('fits a phone width: the page does not scroll sideways, the table wrapper does', async () => {
    await context.close();
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
    const page = await open();
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth, wrap: document.querySelector('.sc-table-wrap')!.clientWidth, wrapScroll: document.querySelector('.sc-table-wrap')!.scrollWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.view);
    expect(widths.wrapScroll).toBeGreaterThan(widths.wrap);
  });

  it('shows the operator-role banner on a 403', async () => {
    market.api = '403';
    const page = await context.newPage();
    await page.goto(`${base}/swarm-admin/connectors`, { waitUntil: 'networkidle' });
    await expect.poll(() => banner(page)).toContain('operator role');
    expect(await page.locator('#statusBanner').getAttribute('data-tone')).toBe('error');
    expect(await page.locator('#catalog td.empty').textContent()).toContain('could not be read');
  });
});

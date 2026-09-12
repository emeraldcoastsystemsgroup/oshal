/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify deployed localhost Users, Access and Lab through the existing authenticated browser without account or grant changes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Require an explicit loopback or HTTPS installation origin and exact full deployed commit before attaching to the existing browser.
 */
import { test, expect } from './_attach-noprune';
import type { Page } from '@playwright/test';

function acceptanceTarget(): { origin: string; commit: string } {
  const configured = process.env.OSHAL_E2E_BASE_URL;
  if (!configured) throw new Error('Set OSHAL_E2E_BASE_URL explicitly to the installation origin; this acceptance has no default.');
  const url = new URL(configured);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((configured !== url.origin && configured !== url.origin + '/') || url.username || url.password
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('OSHAL_E2E_BASE_URL must be an exact HTTPS origin or HTTP localhost/127.0.0.1/[::1] origin, without credentials, path, query or fragment.');
  }
  const commit = process.env.OSHAL_E2E_EXPECTED_COMMIT;
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('Set OSHAL_E2E_EXPECTED_COMMIT to the exact full 40-character lowercase deployed GIT_SHA.');
  }
  return { origin: url.origin, commit };
}

const { origin: ORIGIN, commit: EXPECTED_COMMIT } = acceptanceTarget();
const LIVE_PATH = 'tests/live/authorization-management.live.spec.ts';
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function restrictRequests(page: Page, blocked: string[]): Promise<void> {
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const read = ['GET', 'HEAD'].includes(method);
    const effective = method === 'POST' && url.pathname === '/api/authorization/effective';
    const lab = method === 'POST' && url.pathname === '/api/test-lab/run'
      && request.postData() === JSON.stringify({ scenarioId: 'authorization-management' });
    if (url.origin === ORIGIN && (read || effective || lab)) { await route.continue(); return; }
    blocked.push(`${method} ${url.origin === ORIGIN ? url.pathname : 'external-origin'}`);
    await route.abort('blockedbyclient');
  });
}

async function readJson<T>(page: Page, path: string, project: (body: any) => T): Promise<T> {
  const response = await page.evaluate(async endpoint => {
    const result = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
    return { status: result.status, json: await result.json().catch(() => null) };
  }, path);
  expect(response.status, `${path}: an authenticated operator session on the explicit target origin and deployed module are required`).toBe(200);
  return project(response.json);
}

async function inspectBuild(page: Page) {
  const response = await page.goto(ORIGIN + '/health', { waitUntil: 'domcontentloaded' });
  expect(response?.status(), 'The explicitly selected installation must be running').toBe(200);
  const build = await readJson(page, '/api/version', body => ({ version: body?.version, commit: body?.commit }));
  expect(build.version, 'Deployed package version is required').toMatch(/^\d+\.\d+\.\d+/);
  expect(build.commit, 'The selected origin must serve the exact expected deployed GIT_SHA').toBe(EXPECTED_COMMIT);
  return build;
}

async function inspectUsers(page: Page) {
  const me = await readJson(page, '/api/swarm/roles/me', body => ({ operator: body?.isOperator,
    root: body?.isRoot, breakGlass: body?.breakGlassOnly, role: body?.role }));
  const status = await readJson(page, '/api/swarm/roles/status', body => ({ claimed: body?.rootClaimed,
    operator: body?.callerIsOperator, root: body?.callerIsRoot, breakGlass: body?.callerBreakGlassOnly, loaded: body?.rolesLoaded }));
  expect(me.operator, 'Sign in on the explicit target origin as the existing operator; no bootstrap or impersonation is performed').toBe(true);
  expect(status.operator).toBe(me.operator); expect(status.root).toBe(me.root);
  expect(status.breakGlass).toBe(me.breakGlass); expect(status.loaded).toBe(true);
  expect(typeof status.claimed).toBe('boolean'); expect(typeof me.root).toBe('boolean');
  if (me.root) { expect(status.claimed).toBe(true); expect(me.role).toBe('root'); }
  const response = await page.goto(ORIGIN + '/users', { waitUntil: 'domcontentloaded' });
  expect(response?.status(), 'Users must serve the authenticated deployed page').toBe(200);
  expect(new URL(page.url()).origin).toBe(ORIGIN);
  await expect(page.locator('#rootBody')).not.toContainText('Loading');
  await expect(page.locator('#rolesBody')).not.toContainText('Loading');
  await expect(page.locator('#grantForm')).toBeVisible();
  await expect(page.locator('#currentAccessPill')).toHaveText('administrator');
  await expect(page.locator('#currentAccessBody')).toContainText('You have swarm administrator access.');
  if (me.breakGlass) await expect(page.locator('#currentAccessBody')).toContainText('configured operator allowlist');
  await expect(page.locator('#rootPill')).toContainText(status.claimed ? me.root ? 'you are root' : 'claimed' : 'unclaimed');
  if (status.claimed) await expect(page.locator('#claimBtn')).toHaveCount(0);
  const roleCount = await readJson(page, '/api/swarm/roles', body => Array.isArray(body?.roles) ? body.roles.length : -1);
  expect(roleCount).toBeGreaterThanOrEqual(0);
  return { ...status, role: me.role, roleCount };
}

async function inspectAccess(page: Page) {
  const catalog = await readJson(page, '/api/authorization/catalog', body => ({ revision: body?.revision,
    valid: Array.isArray(body?.apps) && body.apps.every((app: any) => typeof app.app === 'string' && Boolean(app.app)
      && typeof app.source === 'string' && Boolean(app.source) && typeof app.version === 'string' && Boolean(app.version)
      && typeof app.catalogRevision === 'string' && Boolean(app.catalogRevision)
      && ['catalog', 'admin-required', 'legacy'].includes(app.status)), count: body?.apps?.length,
    first: body?.apps?.[0] ? { app: body.apps[0].app, source: body.apps[0].source,
      version: body.apps[0].version, catalogRevision: body.apps[0].catalogRevision } : null }));
  expect(Number.isSafeInteger(catalog.revision) && catalog.revision >= 0).toBe(true); expect(catalog.valid).toBe(true);
  const response = await page.goto(ORIGIN + '/access', { waitUntil: 'domcontentloaded' });
  expect(response?.status(), 'Access must serve its real management-scoped page').toBe(200);
  await expect(page.locator('h1')).toHaveText('Access Administration');
  await expect(page.locator('#administration')).toBeVisible();
  await expect(page.locator('#status')).toContainText('Access catalog loaded');
  expect(await page.locator('#application option').count()).toBe(catalog.count);
  if (catalog.first) {
    await page.locator('#application').selectOption(catalog.first.app);
    await expect(page.locator('#app-revision')).toContainText(catalog.first.catalogRevision);
    await inspectApplicationReads(page, catalog.first.app);
  } else await expect(page.locator('#app-title')).toHaveText('No visible applications');
  return { appCount: catalog.count, revision: catalog.revision, source: catalog.first };
}

async function inspectApplicationReads(page: Page, app: string): Promise<void> {
  const effective = await readJson(page, '/api/authorization/me?' + new URLSearchParams({ app }), body => ({ app: body?.app,
    tier: body?.tier, denied: body?.denied, roles: Array.isArray(body?.roles), permissions: Array.isArray(body?.permissions) }));
  expect(effective.app).toBe(app); expect(['deny', 'viewer', 'editor', 'admin']).toContain(effective.tier);
  expect(typeof effective.denied).toBe('boolean'); expect(effective.roles && effective.permissions).toBe(true);
  const audit = await readJson(page, '/api/authorization/audit?' + new URLSearchParams({ app, limit: '1' }), body => ({
    count: Array.isArray(body?.entries) ? body.entries.length : -1, revision: body?.snapshotRevision,
    scoped: Array.isArray(body?.entries) && body.entries.every((entry: any) => entry.app === app) }));
  expect(audit.count).toBeGreaterThanOrEqual(0); expect(audit.count).toBeLessThanOrEqual(1);
  expect(audit.scoped).toBe(true); expect(Number.isSafeInteger(audit.revision)).toBe(true);
}

async function inspectLab(page: Page): Promise<void> {
  const catalog = await readJson(page, '/api/test-lab/catalog', body => ({
    probe: body?.scenarios?.find((item: any) => item.id === 'authorization-management'),
    live: body?.scenarios?.find((item: any) => item.id === 'authorization-localhost-live') }));
  expect(catalog.probe?.steps?.map((item: any) => item.id)).toEqual(['catalog']);
  expect(catalog.live?.regressionTests).toEqual([{ level: 'browser', path: LIVE_PATH }]);
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/test-lab/run', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarioId: 'authorization-management' }) });
    const body = await response.json();
    return { status: response.status, ran: body.ran, results: body.results?.map((item: any) => ({ id: item.id, state: item.state })) };
  });
  expect(result.status).toBe(200); expect(result.ran).toBe(1);
  expect(result.results).toEqual([{ id: 'authorization-management', state: 'pass' }]);
}

test('existing operator can read Users, Access and registered authorization probe on the explicit installation build', async ({ page }, info) => {
  test.setTimeout(120_000);
  const blocked: string[] = []; let pageErrors = 0;
  page.on('pageerror', () => { pageErrors += 1; }); await restrictRequests(page, blocked);
  const build = await inspectBuild(page), users = await inspectUsers(page), access = await inspectAccess(page);
  await inspectLab(page);
  expect(blocked, 'The read-only acceptance must not submit account/grant changes or contact another origin').toEqual([]);
  expect(pageErrors, 'Users and Access must finish loading without uncaught browser errors').toBe(0);
  await info.attach('installation-uam-summary', { contentType: 'application/json',
    body: JSON.stringify({ origin: ORIGIN, build, users, access, lab: 'pass', accountOrGrantWrites: 0 }) });
});

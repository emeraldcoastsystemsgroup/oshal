/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real HTTP, local Git, and Chromium exercise registry discovery, trust, and explicit source replacement. Only persistence/auth and remote catalog transport are fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createAppRegistryRoutes } from '@/app/routes/app-registry-routes';
import { registerAppStoreRemoteRoutes } from '@/app/routes/app-store-remote';
import { createStore } from '../fixtures/multi-store';
import { APP_REGISTRY_SCENARIOS } from '@/app/routes/test-lab-app-registry-scenarios';

let root: string, dest: string, base: string, server: Server, browser: Browser;
let stores: ReturnType<typeof createStore>[];
const rows: Record<string, any>[] = [];
const loaded: string[] = [];
let mutationCount = 0;
const nativeFetch = globalThis.fetch;
const auth: RequestHandler = (req, _res, next) => {
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: req.headers['x-test-user'] || 'store-operator' } } });
  next();
};
const pool = { query: async (sql: string, values: unknown[] = []) => {
  if (sql.startsWith('SELECT') && sql.includes('app_registries')) {
    return { rows: sql.includes('WHERE slug = $1') ? rows.filter(row => row.slug === values[0]) : rows };
  }
  if (sql.includes('UPDATE app_registries SET display_name')) {
    const row = rows.find(row => row.slug === values[0])!;
    Object.assign(row, { display_name: values[1], url: values[2], ref: values[3], host_kind: values[4], enabled: values[5], trust_state: values[6], allow_unsigned: values[7], allow_private_host: values[8] });
    mutationCount++;
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('UPDATE app_registries SET last_fetch_at')) return { rows: [], rowCount: 1 };
  throw new Error('Unimplemented fixture SQL: ' + sql);
} } as unknown as Pool;

async function call(endpoint: string, method = 'GET', body?: unknown, user?: string) {
  const response = await nativeFetch(base + endpoint, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() as any };
}
function prior(repo = 'https://example.test/old-store') {
  mkdirSync(join(dest, 'sample-app'), { recursive: true });
  writeFileSync(join(dest, 'sample-app', 'oshal-app.yaml'), 'name: sample-app\nversion: 0.1.0\n');
  writeFileSync(join(dest, 'sample-app', '.oshal-install.json'), JSON.stringify({ repo, registry: 'old-store', sha: 'a'.repeat(40) }));
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'store-operator');
  vi.stubEnv('OSHAL_PACKAGE_AUDIT_MODE', 'compatible');
  root = mkdtempSync(join(tmpdir(), 'oshal-multi-store-http-')); dest = join(root, 'deployed');
  stores = [createStore(join(root, 'one')), createStore(join(root, 'two'))];
  for (const slug of ['first-store', 'second-store', 'broken-store']) rows.push({
    id: slug, slug, display_name: slug, url: `https://github.com/fixtures/${slug}`, ref: 'main', host_kind: 'github',
    builtin: false, enabled: true, trust_state: 'trusted', allow_unsigned: true, allow_private_host: false, secret_backend: 'none',
  });
  const app = express(); app.use(express.json()); app.use(auth);
  app.get('/catalog-fixture/:slug', (req, res) => {
    if (req.params.slug === 'broken-store') { res.status(503).send('offline'); return; }
    res.json({ apps: stores[req.params.slug === 'second-store' ? 1 : 0].apps });
  });
  app.get('/legacy-catalog', (_req, res) => res.json({ apps: stores[0].apps.map(app => ({ ...app, source: { ...app.source, url: 'https://github.com/fixtures/legacy-store' } })) }));
  app.use('/api/swarm/registries', createAppRegistryRoutes(pool, auth, { deployedAppsDir: dest, loadApp: async manifest => { loaded.push(manifest); } }));
  const legacy = express.Router(); registerAppStoreRemoteRoutes(legacy, { deployedAppsDir: dest, loadApp: async () => { throw new Error('Legacy collision must never load'); } });
  app.use('/api/swarm/apps', legacy);
  app.get('/api/swarm/apps', (_req, res) => res.json({ apps: [{ name: 'sample-app', displayName: 'Previously installed', version: '0.1.0', status: 'active' }] }));
  app.get('/api/updates', (_req, res) => res.json({ apps: [] }));
  app.get('/api/dev-console/access', (_req, res) => res.json({ superAdmin: true }));
  app.get('/api/auth/user', (_req, res) => res.json({ guestMode: false }));
  app.get('/api/swarm/apps/access-matrix', (_req, res) => res.json({ apps: [], assignments: [] }));
  app.get('/applications/', (_req, res) => res.sendFile(resolve('src/pages/applications/index.html')));
  app.get('/app-loader/', (_req, res) => res.sendFile(resolve('src/pages/app-loader/index.html')));
  app.use('/shared', express.static(resolve('src/shared')));
  app.use('/cockpit/css/themes', express.static(resolve('src/pages/cockpit/css/themes')));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv('PORT', String((server.address() as AddressInfo).port));
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('raw.githubusercontent.com/fixtures/')) {
      const slug = new URL(url).pathname.split('/')[2];
      return nativeFetch(base + '/catalog-fixture/' + slug, init);
    }
    if (url.startsWith('https://raw.githubusercontent.com/')) return nativeFetch(base + '/legacy-catalog', init);
    if (url.startsWith(base)) return nativeFetch(input, init);
    throw new Error('Fixture prevented external network: ' + url);
  });
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  await browser?.close(); server?.closeAllConnections();
  await new Promise<void>(done => server?.close(() => done()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('multi-store HTTP boundaries', () => {
  it('keeps both qualified package identities and reports one broken registry independently', async () => {
    const result = await call('/api/swarm/registries/catalog?refresh=1');
    expect(result.status).toBe(200);
    expect(result.json.apps.map((app: any) => `${app.registry}/${app.name}`)).toEqual(['first-store/sample-app', 'second-store/sample-app']);
    expect(result.json.sources.find((row: any) => row.slug === 'broken-store')).toMatchObject({ ok: false, count: 0 });
  });
  it('rejects non-operators for catalog, preview, install and trust changes before a mutation', async () => {
    const count = mutationCount;
    for (const [endpoint, method, body] of [
      ['/catalog', 'GET', undefined], ['/second-store/preview/sample-app', 'GET', undefined],
      ['/install', 'POST', { registry: 'second-store', name: 'sample-app' }], ['/second-store', 'PATCH', { trustState: 'revoked' }],
    ] as const) expect((await call('/api/swarm/registries' + endpoint, method, body, 'member')).status).toBe(403);
    expect(mutationCount).toBe(count); expect(loaded).toEqual([]);
  });
  it('registers executable read-only Lab discovery and reports broken-store prerequisites honestly', async () => {
    const scenario = APP_REGISTRY_SCENARIOS.find(item => item.id === 'multi-store-discovery')!;
    expect(scenario.regressionTests?.map(test => test.path)).toContain('tests/unit/multi-store-routes-browser.spec.ts');
    const count = mutationCount;
    expect((await scenario.steps[0].run('', {})).state).toBe('degraded');
    rows[2].enabled = false;
    expect((await scenario.steps[0].run('', {})).state).toBe('pass');
    rows[2].enabled = true;
    expect(mutationCount).toBe(count); expect(loaded).toEqual([]);
  });
  it('returns409 without replacement; preview names the actual old source and source-folder manifest', async () => {
    prior();
    const conflict = await call('/api/swarm/registries/install', 'POST', { registry: 'second-store', name: 'sample-app' });
    expect(conflict.status).toBe(409); expect(loaded).toEqual([]);
    expect(conflict.json.replacement.from.repo).toBe('https://example.test/old-store');
    const preview = await call('/api/swarm/registries/second-store/preview/sample-app');
    expect(preview.status).toBe(200); expect(preview.json.replacement.token).toBe(conflict.json.replacement.token);
    expect(preview.json.impact.routes.mounts).toEqual(['/api/sample-app']);
  }, 30000);
  it('rejects stale preview approval before installing or loading', async () => {
    const conflict = await call('/api/swarm/registries/install', 'POST', { registry: 'second-store', name: 'sample-app' });
    prior('https://example.test/changed-store');
    const response = await call('/api/swarm/registries/install', 'POST', { registry: 'second-store', name: 'sample-app', replaceSource: conflict.json.replacement.token });
    expect(response.status).toBe(409); expect(loaded).toEqual([]);
  });
  it('closes the legacy install-remote bypass with409', async () => {
    const result = await call('/api/swarm/apps/install-remote', 'POST', { name: 'sample-app' });
    expect(result.status).toBe(409); expect(result.json.error).toContain('App Loader');
  });
});

describe('multi-store browser controls through the real routes', () => {
  it('shows both sources despite an installed name and requires a checked replacement before real install', async () => {
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/applications/');
    await page.waitForSelector('[data-store-registry="second-store"]');
    expect(await page.locator('[data-store-name="sample-app"]').count()).toBe(2);
    expect(await page.locator('#discover').innerText()).toContain('broken-store');
    await page.locator('[data-store-registry="second-store"] button').click();
    await page.waitForURL('**/app-loader/?**');
    expect(new URL(page.url()).searchParams.get('registry')).toBe('second-store');
    await page.waitForSelector('#dlgReplacement:not([hidden])');
    expect(await page.locator('#dlgConfirm').isDisabled()).toBe(true);
    expect(await page.locator('#dlgReplaceText').innerText()).toContain('https://example.test/changed-store');
    await page.locator('#dlgReplaceCheck').check();
    const response = page.waitForResponse(res => res.url().endsWith('/api/swarm/registries/install') && res.request().method() === 'POST');
    await page.locator('#dlgConfirm').click();
    const installed = await response;
    expect(installed.status(), await installed.text()).toBe(201);
    expect(loaded).toEqual([join(dest, 'sample-app', 'oshal-app.yaml')]);
    expect(JSON.parse(readFileSync(join(dest, 'sample-app', '.oshal-install.json'), 'utf8'))).toMatchObject({ repo: stores[1].repo, registry: 'second-store' });
    const upgrade = await call('/api/swarm/registries/install', 'POST', { registry: 'second-store', name: 'sample-app' });
    expect(upgrade.status, JSON.stringify(upgrade.json)).toBe(201);
    await page.close();
  }, 60000);
  it('revokes via the visible control, blocks install, and requires typed host to restore trust', async () => {
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/app-loader/');
    const trust = page.locator('[data-slug="second-store"] [data-act="trust"]');
    await trust.waitFor();
    page.once('dialog', dialog => dialog.accept());
    await trust.click();
    await page.waitForFunction(() => document.querySelector('[data-slug="second-store"] [data-act="trust"]')?.textContent === 'Restore trust');
    expect((await call('/api/swarm/registries/install', 'POST', { registry: 'second-store', name: 'sample-app' })).status).toBe(409);
    expect((await call('/api/swarm/registries/catalog')).json.apps.some((app: any) => app.registry === 'second-store')).toBe(false);
    const count = mutationCount;
    page.once('dialog', dialog => dialog.accept('wrong-host')); await trust.click();
    expect(mutationCount).toBe(count);
    page.once('dialog', dialog => dialog.accept('github.com')); await trust.click();
    await page.waitForFunction(() => document.querySelector('[data-slug="second-store"] [data-act="trust"]')?.textContent === 'Revoke trust');
    expect((await call('/api/swarm/registries/catalog')).json.apps.some((app: any) => app.registry === 'second-store')).toBe(true);
    await page.close();
  }, 30000);
});

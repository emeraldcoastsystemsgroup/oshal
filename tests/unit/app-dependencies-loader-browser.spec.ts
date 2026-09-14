/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Dependency tiers in the App Loader over real HTTP routes, a real local Git store, the real installer child and real Chromium: the preview resolves each dependency app the way the installer does and refuses an unresolvable required one; the confirm screen offers optional apps as checkboxes and sends only the chosen ones; install hot-loads the pulled dependencies before the package; a required dependency that fails to load keeps the package unloaded while an optional one is reported. Only persistence/auth and the remote catalog transport are fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createAppRegistryRoutes } from '@/app/routes/app-registry-routes';
import { APP_REGISTRY_SCENARIOS } from '@/app/routes/test-lab-app-registry-scenarios';
import { createStore } from '../fixtures/multi-store';

let root: string, dest: string, base: string, server: Server, browser: Browser;
let store: ReturnType<typeof createStore>;
const loaded: string[] = [];
const nativeFetch = globalThis.fetch;
const auth: RequestHandler = (req, _res, next) => {
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: 'store-operator' } } });
  next();
};
const rows = [{
  id: 'dep-store', slug: 'dep-store', display_name: 'Dependency store', url: 'https://github.com/fixtures/dep-store', ref: 'main',
  host_kind: 'github', builtin: false, enabled: true, trust_state: 'trusted', allow_unsigned: true, allow_private_host: false, secret_backend: 'none',
}];
const pool = { query: async (sql: string, values: unknown[] = []) => {
  if (sql.startsWith('SELECT') && sql.includes('app_registries')) return { rows: sql.includes('WHERE slug = $1') ? rows.filter(row => row.slug === values[0]) : rows };
  if (sql.includes('UPDATE app_registries SET last_fetch_at')) return { rows: [], rowCount: 1 };
  throw new Error('Unimplemented fixture SQL: ' + sql);
} } as unknown as Pool;
/** The package a manifest path belongs to (…/<name>/oshal-app.yaml). */
const packageOf = (manifestPath: string) => manifestPath.split(sep).slice(-2)[0];

async function call(endpoint: string, method = 'GET', body?: unknown) {
  const response = await nativeFetch(base + endpoint, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() as any };
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'store-operator');
  vi.stubEnv('OSHAL_PACKAGE_AUDIT_MODE', 'compatible');
  root = mkdtempSync(join(tmpdir(), 'oshal-deps-loader-')); dest = join(root, 'deployed');
  store = createStore(join(root, 'store'), [
    { name: 'scanner', deps: ['engine'], optional: ['cad-kit', 'slicer'] },
    { name: 'engine', deps: [] }, { name: 'cad-kit', deps: [] }, { name: 'slicer', deps: [] },
    { name: 'orphaned', deps: ['not-published'], tiered: true },
    { name: 'fragile', deps: ['brittle-a'], tiered: true }, { name: 'brittle-a', deps: [] },
    { name: 'tolerant', deps: [], optional: ['brittle-b'] }, { name: 'brittle-b', deps: [] },
  ]);
  const app = express(); app.use(express.json()); app.use(auth);
  app.get('/catalog-fixture', (_req, res) => res.json({ apps: store.apps }));
  app.use('/api/swarm/registries', createAppRegistryRoutes(pool, auth, {
    deployedAppsDir: dest,
    loadApp: async (manifestPath) => {
      if (packageOf(manifestPath).startsWith('brittle-')) throw new Error(`${packageOf(manifestPath)} refused to activate`);
      loaded.push(packageOf(manifestPath));
    },
  }));
  app.get('/app-loader/', (_req, res) => res.sendFile(resolve('src/pages/app-loader/index.html')));
  app.use('/shared', express.static(resolve('src/shared')));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('raw.githubusercontent.com/fixtures/dep-store/')) return nativeFetch(base + '/catalog-fixture', init);
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

describe('the install preview resolves both tiers the way the installer does', () => {
  it('lists required and optional apps with their state and allows the install', async () => {
    const preview = await call('/api/swarm/registries/dep-store/preview/scanner');
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(preview.json.impact.dependencies.required.apps).toEqual([{ name: 'engine', state: 'available' }]);
    expect(preview.json.impact.dependencies.optional.apps).toEqual([{ name: 'cad-kit', state: 'available' }, { name: 'slicer', state: 'available' }]);
    expect(preview.json.install.allowed).toBe(true);
  }, 30000);

  it('refuses the install when a required app is neither installed nor published by the source', async () => {
    const preview = await call('/api/swarm/registries/dep-store/preview/orphaned');
    expect(preview.json.impact.dependencies.required.apps).toEqual([{ name: 'not-published', state: 'unavailable' }]);
    expect(preview.json.install).toMatchObject({ allowed: false });
    expect(preview.json.install.note).toMatch(/requires not-published, which is not installed and not published by Dependency store/);
  }, 30000);

  it('rejects a malformed optional selection before the installer runs', async () => {
    for (const withOptional of ['slicer', ['--repo'], Array.from({ length: 33 }, (_, i) => `app-${i}`)]) {
      const result = await call('/api/swarm/registries/install', 'POST', { registry: 'dep-store', name: 'scanner', withOptional });
      expect(result.status).toBe(400);
    }
    expect(existsSync(join(dest, 'scanner'))).toBe(false);
  });
});

describe('the confirm screen and the install through the real routes', () => {
  it('offers optional apps as checkboxes, sends only the chosen one, and loads dependencies before the package', async () => {
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/app-loader/?registry=dep-store&name=scanner');
    await page.waitForSelector('#dlgOptional:not([hidden]) input[data-optional-app="slicer"]');
    expect(await page.locator('#dlgImpact').innerText()).toMatch(/requires\s+engine \(installs from this source\)/);
    expect(await page.locator('input[data-optional-app="cad-kit"]').isChecked()).toBe(false);
    await page.locator('input[data-optional-app="slicer"]').check();
    const request = page.waitForRequest(req => req.url().endsWith('/api/swarm/registries/install') && req.method() === 'POST');
    const response = page.waitForResponse(res => res.url().endsWith('/api/swarm/registries/install'));
    await page.locator('#dlgConfirm').click();
    expect((await request).postDataJSON()).toMatchObject({ registry: 'dep-store', name: 'scanner', withOptional: ['slicer'] });
    const installed = await response;
    expect(installed.status(), await installed.text()).toBe(201);
    expect(loaded).toEqual(['engine', 'slicer', 'scanner']);
    expect(existsSync(join(dest, 'cad-kit'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dest, 'scanner', '.oshal-install.json'), 'utf8')).dependencies).toEqual({
      required: { engine: 'installed-from-store' }, optional: { 'cad-kit': 'not-selected', slicer: 'installed-from-store' },
    });
    await page.waitForSelector('#msg.ok');
    expect(await page.locator('#msg').innerText()).toContain('Also installed: engine, slicer.');
    await page.close();
  }, 90000);

  it('disables Install and says why when a required app cannot resolve', async () => {
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/app-loader/?registry=dep-store&name=orphaned');
    await page.waitForFunction(() => /Will not install/.test(document.getElementById('dlgAudit')?.textContent || ''));
    expect(await page.locator('#dlgConfirm').isDisabled()).toBe(true);
    expect(await page.locator('#dlgImpact li.danger', { hasText: 'requires' }).innerText()).toMatch(/not-published \(NOT AVAILABLE/);
    await page.close();
  }, 60000);
});

describe('hot-loading the dependencies an install pulled in', () => {
  it('keeps the package unloaded when a REQUIRED dependency fails to load', async () => {
    loaded.length = 0;
    const result = await call('/api/swarm/registries/install', 'POST', { registry: 'dep-store', name: 'fragile' });
    expect(result.status).toBe(500);
    expect(result.json.error).toMatch(/required dependencies did not load \(brittle-a: brittle-a refused to activate\) — "fragile" was not loaded/);
    expect(loaded).toEqual([]);
    expect(existsSync(join(dest, 'fragile', 'oshal-app.yaml'))).toBe(true); // on disk; it loads on the next boot
  }, 60000);

  it('loads the package and reports an OPTIONAL dependency that failed to load', async () => {
    loaded.length = 0;
    const result = await call('/api/swarm/registries/install', 'POST', { registry: 'dep-store', name: 'tolerant', withOptional: ['brittle-b'] });
    expect(result.status, JSON.stringify(result.json)).toBe(201);
    expect(result.json.dependencies.failed).toEqual([{ name: 'brittle-b', tier: 'optional', error: 'brittle-b refused to activate' }]);
    expect(loaded).toEqual(['tolerant']);
  }, 60000);
});

describe('Test Lab registration', () => {
  it('registers this suite and the installer suite on the dependency-tier scenario', () => {
    const scenario = APP_REGISTRY_SCENARIOS.find(item => item.id === 'app-dependency-tiers');
    expect(scenario?.regressionTests?.map(test => test.path)).toEqual(expect.arrayContaining([
      'tests/unit/app-dependencies-contract.spec.ts',
      'tests/unit/app-dependencies-installer.spec.ts',
      'tests/unit/app-dependencies-loader-browser.spec.ts',
    ]));
  });
});

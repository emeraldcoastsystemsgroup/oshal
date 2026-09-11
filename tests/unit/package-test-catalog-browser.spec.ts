/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Verify pending catalogs and stale-selection refusal through Chromium and real Lab HTTP routes.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { InstalledAppTestCatalog } from '@/features/swarm-apps/services/installed-app-test-catalog';
import type { SwarmApplicationRecord } from '@/features/swarm-apps';
import { createTestLabRoutes } from '@/app/routes/test-lab-routes';
import { packageManifest, packageTestCase, writeTestPackage } from '../fixtures/package-testing';

let root: string, base: string, server: Server, browser: Browser, record: SwarmApplicationRecord;
const catalog = new InstalledAppTestCatalog();
let smokeCalls = 0;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'oshal-test-catalog-browser-'));
  const fixture = writeTestPackage(root, packageManifest(), [packageTestCase({
    name: '<img src=x onerror="window.catalogXss=1">', expected: ['The catalog renders <script> as text.'],
  })]);
  record = { appId: 'fixture', name: fixture.manifest.name, displayName: 'Fixture', description: '', version: '1.0.0',
    status: 'active', manifestPath: fixture.file, manifest: fixture.manifest, agentIds: [], toolNames: [], scope: 'public',
    ownerSub: null, tenantId: null, guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
  catalog.register(record);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: 'fixture-viewer' } } }); next(); });
  app.get('/api/swarm/apps', (_req, res) => res.json({ apps: [] }));
  app.get('/api/catalog-fixture/ready', (_req, res) => { smokeCalls++; res.json({ ready: true }); });
  app.use('/shared', express.static(resolve('src/shared')));
  app.use('/api/test-lab', (req, res, next) => createTestLabRoutes({} as never, {
    installedTests: catalog, visibleApps: async () => new Map([['catalog-fixture', 'Fixture']]), apiBaseUrl: base,
  })(req, res, next));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv('PORT', new URL(base).port);
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => {
  await browser?.close(); server?.closeAllConnections(); await new Promise<void>(done => server?.close(() => done()));
  vi.unstubAllEnvs();
  if (!relative(resolve(tmpdir()), resolve(root)).startsWith('oshal-test-catalog-browser-')) throw new Error('Unsafe fixture cleanup');
  rmSync(root, { recursive: true, force: true });
}, 30000);

it('shows escaped suite metadata, remains pending, and refreshes before running a replaced smoke', async () => {
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  try {
    await page.goto(base + '/api/test-lab/app');
    const suite = page.locator('[id="card-app:catalog-fixture:test:behavior"]');
    await suite.waitFor({ state: 'visible' });
    expect(await suite.textContent()).toContain('Pending: The vitest runner is unavailable');
    await suite.getByText('Runner and prerequisites', { exact: true }).click();
    expect(await suite.textContent()).toContain('Side effects: fixture-write');
    expect(await suite.textContent()).toContain('Isolation: disposable');
    expect(await suite.textContent()).toContain('runner:vitest');
    expect(await suite.textContent()).toMatch(/Source: local:[a-f0-9]{64}/);
    expect(await suite.textContent()).toContain('The catalog renders <script> as text.');
    expect(await suite.locator('img, script').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).catalogXss)).toBeUndefined();
    await suite.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => suite.locator('.badge').textContent()).toBe('degraded');
    expect(smokeCalls).toBe(0);

    record = { ...record, version: '2.0.0', manifest: { ...record.manifest, version: '2.0.0' } };
    catalog.register(record);
    const smoke = page.locator('[id="card-app:catalog-fixture:smoke:ready"]');
    await smoke.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => smoke.locator('.badge').textContent()).toBe('degraded');
    expect(await smoke.locator('.step-detail').textContent()).toContain('Case changed after selection');
    expect(smokeCalls).toBe(0);
    await page.locator('#refreshCatalog').click();
    await expect.poll(() => smoke.textContent()).toContain('Installed 2.0.0');
    await smoke.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => smoke.locator('.badge').textContent()).toBe('pass');
    expect(smokeCalls).toBe(1);
  } finally { await context.close(); }
}, 30000);

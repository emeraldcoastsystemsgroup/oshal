/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Render the actual dashboard activity method in Chromium over isolated HTTP replies and verify its existing Lab registration.
 */
import express from 'express';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';

let server: Server, origin: string, browser: Browser, context: BrowserContext, page: Page;
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let errors: string[], external: string[];
vi.setConfig({ hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

beforeAll(async () => {
  const app = express();
  app.get('/', (_req, res) => res.type('html').send('<!doctype html><html lang="en"><title>Isolated dashboard method</title><section id="dashSwarmMessages"><h3>Swarm Messages</h3><div class="dash-loading">Loading…</div></section></html>'));
  app.get('/DashboardHomeView.js', (_req, res) => res.sendFile(path.resolve('src/pages/cockpit/js/views/DashboardHomeView.js')));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  owned = await launchIsolatedBrowser(); browser = owned.browser;
});
afterAll(async () => {
  try {
    if (owned) {
      const receipt = await owned.close(); await mkdir('temp', { recursive: true });
      await writeFile('temp/dashboard-home-swarm-browser-cleanup.json', JSON.stringify(receipt, null, 2));
    }
  } finally {
    server?.closeAllConnections(); if (server) await new Promise<void>(done => server.close(() => done()));
  }
});
beforeEach(async () => {
  context = await browser.newContext({ serviceWorkers: 'block' }); errors = []; external = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
});
afterEach(async () => { await context?.close(); expect(errors).toEqual([]); expect(external).toEqual([]); });

/** @description Invoke the actual exported class and method; only its API answer is synthetic. @returns Render completion. */
async function render() {
  await page.evaluate(`(async () => {
    const { DashboardHomeView } = await import('/DashboardHomeView.js');
    await new DashboardHomeView({}).loadSwarmMessages();
  })()`);
}

it('shows operator-only refusal without drawing any refused body records', async () => {
  await page.route('**/api/swarm/work-items', route => route.fulfill({ status: 403,
    contentType: 'application/json', body: JSON.stringify({ workItems: [{ title: 'REFUSED PRIVATE ROW' }] }) }));
  await render();
  expect(await page.getByRole('status').textContent()).toBe('Global swarm activity is available to operators only.');
  expect(await page.locator('#dashSwarmMessages').textContent()).not.toMatch(/REFUSED|No recent swarm activity/);
  expect(await page.locator('.dash-list-item').count()).toBe(0);
});

it.each([401, 404, 500, 503])('shows HTTP%i as unavailable rather than a false empty list', async status => {
  await page.route('**/api/swarm/work-items', route => route.fulfill({ status, body: '{"workItems":[]}' }));
  await render(); expect(await page.getByRole('status').textContent()).toContain('Swarm activity is unavailable.');
  expect(await page.locator('#dashSwarmMessages').textContent()).not.toContain('No recent swarm activity.');
});

it.each(['not JSON', 'null', '{}', '{"workItems":"wrong"}', '{"workItems":[null]}', '{"workItems":["row"]}'])(
  'shows malformed successful answer %s as unavailable', async body => {
    await page.route('**/api/swarm/work-items', route => route.fulfill({ status: 200, contentType: 'application/json', body }));
    await render(); expect(await page.getByRole('status').textContent()).toContain('Swarm activity is unavailable.');
  },
);

it('retains loading until the answer arrives and offers truthful network recovery', async () => {
  let failRequest!: () => void;
  const received = new Promise<void>(done => { failRequest = done; });
  let release!: () => void; const hold = new Promise<void>(done => { release = done; });
  await page.route('**/api/swarm/work-items', async route => { failRequest(); await hold; await route.abort(); });
  const pending = render(); await Promise.race([received, pending]);
  expect(await page.getByRole('status').textContent()).toBe('Loading…'); release(); await pending;
  expect(await page.getByRole('status').textContent()).toBe('Swarm activity is unavailable. Try opening this dashboard again.');
  await page.unroute('**/api/swarm/work-items');
  await page.route('**/api/swarm/work-items', route => route.fulfill({ status: 200, body: '{"workItems":[]}' }));
  await page.reload(); await render(); expect(await page.getByRole('status').textContent()).toBe('No recent swarm activity.');
});

it.each(['workItems', 'items'])('retains real 200-empty %s and capped escaped successful rows', async key => {
  let rows: object[] = [];
  await page.route('**/api/swarm/work-items', route => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ [key]: rows }) }));
  await render(); expect(await page.getByRole('status').textContent()).toBe('No recent swarm activity.');
  rows = Array.from({ length: 6 }, (_, index) => ({ title: `<img src=x onerror="window.fixtureExecuted=true"> Row ${index}`,
    updatedAt: new Date(Date.now() - 120_000).toISOString() }));
  await page.reload(); await render();
  expect(await page.locator('.dash-list-item').count()).toBe(5);
  expect(await page.locator('.dash-item-title').first().textContent()).toContain('<img src=x onerror=');
  expect(await page.locator('#dashSwarmMessages img').count()).toBe(0);
  expect(await page.locator('.dash-item-meta').first().textContent()).toBe('2m ago');
  expect(await page.evaluate(() => 'fixtureExecuted' in window)).toBe(false);
});

it('registers this synthetic DOM boundary suite on the existing appearance card', () => {
  const cards = SCENARIOS.filter(card => card.id === 'cockpit-appearance'); expect(cards).toHaveLength(1);
  expect(cards[0].regressionTests).toContainEqual({ level: 'browser', path: 'tests/unit/dashboard-home-swarm-browser.spec.ts' });
});

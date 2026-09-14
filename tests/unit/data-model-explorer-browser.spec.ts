/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Browser guard for the data-model explorer: real Chromium against the real page files, the real route + operator gate and the real service over fixture ports (a temp source tree with a core migration and one store package). Proves the graph renders, the tabs and URL deep links drive it, the detail panel navigates FKs, search opens a table, the stores view shows every card, and a non-operator gets the operator-only explanation instead of data. Browser console errors fail the suite.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Export guards at the real boundary: the Mermaid block copied for the view on screen names exactly the tables Chromium drew and reaches the clipboard, the SVG and JSON downloads are real files with the drawn scope inside them, and a non-operator - who never got a snapshot - is told there is nothing to export instead of being handed an empty one.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Download, type Page } from 'playwright';
import { requiresOperator } from '@/shared/middleware/authz';
import { createDataModelRoutes } from '@/app/routes/data-model-routes';
import { createDataModelService, type CatalogSnapshot, type RelationInfo } from '@/features/data-model';

let root: string, base: string, server: Server, browser: Browser;
const consoleErrors: string[] = [];
const rel = (name: string, cols: string[], fks: Array<[string, string]> = []): RelationInfo => ({
  name, kind: 'table', comment: null, rls: true, forced: true, columns: cols.map((c) => ({ name: c, type: 'text', nullable: c !== 'id', default: null, comment: null })),
  primaryKey: ['id'], uniques: [], hypertable: null, materialized: false, source: 'catalog',
  foreignKeys: fks.map(([col, ref]) => ({ name: `${col}_fk`, columns: [col], refTable: ref, refColumns: ['id'] })),
  policies: [{ name: `${name}_owner_or_operator`, command: 'ALL', using: "((user_sub = current_setting('oshal.current_sub'::text, true)) OR (current_setting('oshal.is_operator'::text, true) = 'on'::text))", check: null }],
});
const catalog: CatalogSnapshot = {
  database: 'oshal',
  tables: [rel('tickets', ['id', 'user_sub', 'title']), rel('work_items', ['id', 'user_sub', 'ticket_id'], [['ticket_id', 'tickets']]), rel('shop_items', ['id', 'user_sub', 'ticket_id', 'sku_code'], [['ticket_id', 'tickets']])],
  views: [],
};
const cookieAuth: RequestHandler = (req, res, next) => {
  const sub = /(?:^|;\s*)test-user=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!sub) { res.status(401).json({ error: 'Authentication required' }); return; }
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
  next();
};
const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

beforeAll(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'the-operator');
  root = mkdtempSync(join(tmpdir(), 'data-model-browser-'));
  write(join(root, 'scripts', 'migrations', '001.sql'), 'CREATE TABLE tickets (id uuid PRIMARY KEY);\nCREATE TABLE work_items (id uuid PRIMARY KEY);');
  write(join(root, 'deployed', 'shop', 'oshal-app.yaml'), 'name: shop\n');
  write(join(root, 'deployed', 'shop', 'migrations', '001.sql'), 'CREATE TABLE shop_items (id uuid PRIMARY KEY);');
  const service = createDataModelService({
    repoRoot: root,
    readPlatformCatalog: async () => catalog,
    listApps: async () => [{ name: 'shop', displayName: 'Shop', version: '1.0.0', status: 'active', manifestPath: join(root, 'deployed', 'shop', 'oshal-app.yaml'), manifest: { dependencies: { apps: ['office'] } } },
      { name: 'office', displayName: 'Office', version: '2.0.0', status: 'active', manifestPath: join(root, 'deployed', 'office.yaml'), manifest: {} }],
    graphInventory: async () => ({ store: 'graph', engine: 'ArangoDB', status: 'ok', detail: '1 graph databases.', databases: [{ name: 'g_p_fixture', collections: [{ name: 'nodes', count: 3 }] }] }),
    vectorInventory: async () => ({ store: 'vector', engine: 'ChromaDB', status: 'ok', detail: '1 collections.', collections: [{ name: 'infra-runbooks', count: 42 }] }),
    cacheInventory: async () => ({ store: 'cache', engine: 'Redis', status: 'ok', detail: '2 keys in 1 families.', families: [{ prefix: 'oshal:mesh', keys: 2, types: { stream: 2 } }] }),
  });
  const app = express();
  app.get('/favicon.ico', (_req, res) => { res.status(204).end(); });
  app.use('/shared/ui', express.static(resolve(__dirname, '../../src/shared/ui')));
  app.use('/shared', express.static(resolve(__dirname, '../../src/pages/shared')));
  app.use('/cockpit/css', express.static(resolve(__dirname, '../../src/pages/cockpit/css')));
  app.use('/data-model', express.static(resolve(__dirname, '../../src/pages/data-model')));
  app.use('/api/admin/data-model', cookieAuth, requiresOperator, createDataModelRoutes(service));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** Open the explorer as `user` at `query`, collecting console errors. */
async function open(user: string, query = ''): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addCookies([{ name: 'test-user', value: user, url: base }]);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto(`${base}/data-model/${query}`);
  return page;
}

/** Read a download's bytes as text, then drop the temporary file. */
async function readDownload(download: Download): Promise<string> {
  const path = await download.path();
  const text = readFileSync(path, 'utf8');
  await download.delete();
  return text;
}

// Real Chromium page loads on a loaded host need more than vitest's 5 s default.
describe('data-model explorer in the browser', { timeout: 60_000 }, () => {
  it('renders the app integration graph for an operator', async () => {
    const page = await open('the-operator');
    await page.waitForSelector('#graph g.node');
    expect(await page.locator('#stats').textContent()).toContain('3 tables');
    expect(await page.locator('#graph g.node').count()).toBeGreaterThanOrEqual(2);
    expect(await page.locator('#graph line.edge--dependency').count()).toBe(1);
    await page.context().close();
  });

  it('deep-links to a table, shows its columns and navigates its foreign keys', async () => {
    const page = await open('the-operator', '?view=tables&app=%40core&table=work_items');
    await page.waitForSelector('#detail h2');
    expect(await page.locator('#detail h2').textContent()).toBe('work_items');
    expect(await page.locator('#detail table.columns tbody tr').count()).toBe(3);
    await page.locator('#detail button.nav-link', { hasText: 'tickets' }).first().click();
    await page.waitForFunction(() => document.querySelector('#detail h2')?.textContent === 'tickets');
    expect(page.url()).toContain('table=tickets');
    expect(await page.locator('#detail').textContent()).toContain('shop_items');
    await page.context().close();
  });

  it('finds a table by column through search and opens it', async () => {
    const page = await open('the-operator');
    await page.waitForSelector('#graph g.node');
    await page.fill('#search', 'sku');
    await page.locator('#results .result').first().click();
    await page.waitForFunction(() => document.querySelector('#detail h2')?.textContent === 'shop_items');
    expect(page.url()).toContain('view=tables');
    await page.context().close();
  });

  it('shows every store card on the stores view', async () => {
    const page = await open('the-operator', '?view=stores');
    await page.waitForSelector('.store-card h3:has-text("Redis")');
    const titles = await page.locator('.store-card h3').allTextContents();
    expect(titles.join('|')).toMatch(/ArangoDB.*ChromaDB.*Redis/);
    expect(await page.locator('#listArea').textContent()).toContain('oshal:mesh');
    await page.context().close();
  });

  it('explains the operator requirement to anyone else and shows no data', async () => {
    const page = await open('someone-else');
    await page.waitForFunction(() => !document.getElementById('banner')?.hidden);
    expect(await page.locator('#banner').textContent()).toContain('operator-only');
    expect(await page.locator('#graph g.node').count()).toBe(0);
    await page.context().close();
  });

  it('copies the view on screen as a Mermaid erDiagram naming exactly its tables', async () => {
    const page = await open('the-operator', '?view=tables&app=%40core');
    await page.waitForSelector('#graph g.node');
    const drawn = (await page.locator('#graph g.node').evaluateAll((gs) => gs.map((g) => (g as HTMLElement).dataset.id))).sort();
    await page.click('#exportBtn');
    await page.click('[data-export="mermaid"]');
    await page.waitForSelector('#exportPreview:not([hidden])');
    const block = await page.locator('#exportPreview').textContent() || '';
    expect(block.split('\n')[0]).toBe('```mermaid');
    expect(block.split('\n')[1]).toBe('erDiagram');
    expect([...block.matchAll(/^ {2}(\S+) \{$/gm)].map((m) => m[1]).sort()).toEqual(drawn);
    expect(block).toContain('tickets |o--o{ work_items : "ticket_id"');
    // Windows Chromium hands clipboard text back with CRLF; the block itself is LF either way.
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(block);
    await page.context().close();
  });

  it('downloads the same view as a standalone SVG and as scoped JSON', async () => {
    const page = await open('the-operator', '?view=tables&app=%40core');
    await page.waitForSelector('#graph g.node');
    await page.click('#exportBtn');
    const svgWait = page.waitForEvent('download');
    await page.click('[data-export="svg"]');
    const svgFile = await svgWait;
    expect(svgFile.suggestedFilename()).toMatch(/^data-model-tables-core-\d{4}-\d{2}-\d{2}\.svg$/);
    const svg = await readDownload(svgFile);
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svg).toContain('.edge--foreign-key');
    expect(svg).toContain('work_items');
    expect(svg).not.toContain('graph-root" transform');
    const jsonWait = page.waitForEvent('download');
    await page.click('[data-export="json"]');
    const jsonFile = await jsonWait;
    expect(jsonFile.suggestedFilename()).toMatch(/\.json$/);
    const scope = JSON.parse(await readDownload(jsonFile));
    expect(scope.view).toBe('tables');
    expect(scope.relations.map((r: { name: string }) => r.name).sort()).toEqual(['tickets', 'work_items']);
    expect(scope.relations[0].columns.length).toBeGreaterThan(0);
    await page.context().close();
  });

  it('gives a non-operator nothing to export and says why', async () => {
    const page = await open('someone-else');
    await page.waitForFunction(() => !document.getElementById('banner')?.hidden);
    await page.click('#exportBtn');
    await page.click('[data-export="json"]');
    await page.waitForSelector('#exportNote:not([hidden])');
    expect(await page.locator('#exportNote').textContent()).toContain('has not loaded');
    expect(await page.locator('#exportPreview').isHidden()).toBe(true);
    await page.context().close();
  });

  it('raised no browser errors along the way', () => {
    expect(consoleErrors.filter((e) => !e.includes('403'))).toEqual([]);
  });
});

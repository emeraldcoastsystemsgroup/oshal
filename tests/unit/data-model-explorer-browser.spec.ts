/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Browser guard for the data-model explorer: real Chromium against the real page files, the real route + operator gate and the real service over fixture ports (a temp source tree with a core migration and one store package). Proves the graph renders, the tabs and URL deep links drive it, the detail panel navigates FKs, search opens a table, the stores view shows every card, and a non-operator gets the operator-only explanation instead of data. Browser console errors fail the suite.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Export guards at the real boundary: the Mermaid block copied for the view on screen names exactly the tables Chromium drew and reaches the clipboard, the SVG and JSON downloads are real files with the drawn scope inside them, and a non-operator - who never got a snapshot - is told there is nothing to export instead of being handed an empty one.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Shared glass finish at the served boundary: Chromium must load /shared/ui/css/surface-glass.css from the real static mount AFTER the page's own data-model.css, and --oshal-glass-bg (defined only by that sheet) must resolve on :root. The page shipped without the link and the source-level glass specs went red; this case runs inside `npm run test:data-model`, the command the explorer's own work runs.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | A real mermaid@11 parse, at the only boundary that settles it: the block Chromium copied out of the real page is handed to mermaid's own parser, which must read the Tables export as an `er` diagram and the owner export as a flowchart, and must REJECT a mangled block - so a parser that silently accepted anything could not pass this. The structural assertions above and the byte-parity to the docs generator never ran a parser at all; a block that renders on GitHub but throws in mermaid would have shipped unnoticed.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Give afterAll a bound of its own, so the mermaid parse above can actually be READ in CI. The one automated gate this trunk has is scripts/ci-local.sh, whose `unit` gate is `npm run test:unit` - a bare `vitest run`, on vitest's 10 s DEFAULT hookTimeout, not the 180 s `npm run test:data-model` passes. Under that bound this FILE reported FAIL on every run while all 11 cases inside it PASSED, so a real mermaid regression and this teardown were indistinguishable in the gate: "Hook timed out in 10000ms", 11 passed / 1 file failed, reproduced 2026-09-17 from a clean checkout of origin/main 02936a38 and by the 2026-09-16 nightly (ci-local-last-run.log, origin/main 184377cee79a). The cause is not the fixture server - instrumented, `browser.close()` took 72588 ms and `server.close()` took 1 ms - it is that closing a real Chromium is slow on a loaded box and this hook, unlike its own beforeAll and unlike the repo's other browser specs, never said so.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Download, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { requiresOperator } from '@/shared/middleware/authz';
import { createDataModelRoutes } from '@/app/routes/data-model-routes';
import { createDataModelService, type CatalogSnapshot, type RelationInfo } from '@/features/data-model';

// The real mermaid@11 bundle: a self-contained UMD build that defines globalThis.mermaid, so the
// parse runs in a page with no network and no CDN.
const MERMAID_BUNDLE = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.js');
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
  // The bound is explicit for the same reason beforeAll's is: this hook closes a REAL browser, and
  // vitest's default is 10 s. Measured here, closing the eleven contexts' Chromium took 72.6 s on a
  // box running other suites in parallel while server.close() took 1 ms - so without a bound of its
  // own this FILE reported FAIL in the unit gate with every case inside it green.
}, 180_000);

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

/**
 * Parse each fenced export block with the real mermaid@11, in a page of its own (no console-error
 * collector, because a deliberately mangled block makes mermaid log). Returns the diagram type
 * mermaid detected, or null when mermaid refused the block.
 */
async function mermaidParse(blocks: string[]): Promise<Array<string | null>> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<!doctype html><title>mermaid parse</title><body></body>');
  await page.addScriptTag({ path: MERMAID_BUNDLE });
  const types = await page.evaluate(async (texts: string[]) => {
    const api = (window as unknown as { mermaid: { initialize: (c: unknown) => void; parse: (t: string) => Promise<{ diagramType: string }> } }).mermaid;
    api.initialize({ startOnLoad: false });
    const out: Array<string | null> = [];
    for (const text of texts) {
      const body = text.split(/\r?\n/).filter((l) => !l.startsWith('```')).join('\n');
      try { out.push((await api.parse(body)).diagramType); } catch { out.push(null); }
    }
    return out;
  }, blocks);
  await context.close();
  return types;
}

/** Copy the Mermaid block for the view `query` opens, straight out of the real page. */
async function copiedMermaid(query: string): Promise<string> {
  const page = await open('the-operator', query);
  await page.waitForSelector('#graph g.node');
  await page.click('#exportBtn');
  await page.click('[data-export="mermaid"]');
  await page.waitForSelector('#exportPreview:not([hidden])');
  const block = await page.locator('#exportPreview').textContent() || '';
  await page.context().close();
  return block;
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

  it('carries the shared glass finish, loaded after the explorer stylesheet', async () => {
    const page = await open('the-operator');
    await page.waitForSelector('#graph g.node');
    const sheets = await page.evaluate(() => Array.from(document.styleSheets, (s) => (s.href ? new URL(s.href).pathname : '')));
    expect(sheets).toContain('/data-model/data-model.css');
    expect(sheets.indexOf('/shared/ui/css/surface-glass.css')).toBeGreaterThan(sheets.indexOf('/data-model/data-model.css'));
    // Only surface-glass.css defines this token, so it resolves only if the served sheet actually applied.
    const glassToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--oshal-glass-bg').trim());
    expect(glassToken).not.toBe('');
    await page.context().close();
  });

  it('exports blocks mermaid@11 parses itself - and would refuse a mangled one', async () => {
    const er = await copiedMermaid('?view=tables&app=%40core');
    const flow = await copiedMermaid('?view=apps');
    // Same renderer writes docs/architecture/data-model, so parsing this block parses those too.
    const mangled = er.replace('erDiagram', 'erDiagram' + String.fromCharCode(10) + '  {{ not an entity');
    const [erType, flowType, mangledType] = await mermaidParse([er, flow, mangled]);
    expect(erType).toBe('er');
    expect(flowType).toMatch(/^flowchart/);
    expect(mangledType).toBeNull();
  });

  it('raised no browser errors along the way', () => {
    expect(consoleErrors.filter((e) => !e.includes('403'))).toEqual([]);
  });
});

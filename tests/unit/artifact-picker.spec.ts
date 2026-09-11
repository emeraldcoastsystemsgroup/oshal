/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real HTTP, local files, artifact handles and Chromium drive the shipped Portrait Studio picker. Authentication/provider discovery and the portrait SQL store are fixtures; storage ownership and handle redemption are not mocked.
 */
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { AppContext } from '@/app/composition/app-context';
import { createArtifactExchangeRoutes } from '@/app/routes/artifact-exchange-routes';
import { createFilesRoutes } from '@/app/routes/files-routes';
import { registerAppArtifactActions, unregisterAppArtifactActions, validateArtifactActionsDeclaration } from '@/shared/artifact-exchange';

let server: Server, browser: Browser, base: string, workspace: string;
const store = resolve(process.env.OSHAL_STORE_REPO || '../oshal-applications');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const portraitId = '00000000-0000-4000-8000-000000000001';
const queries: Array<{ sql: string; values?: unknown[] }> = [];
let denyPortraits = false;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'oshal-picker-proof-'));
  vi.stubEnv('SHARED_WORKSPACE_ROOT', workspace);
  vi.stubEnv('SWARM_SERVICE_SECRET', 'picker-proof-local-only');
  const owned = join(workspace, 'userfiles', createHash('sha256').update('alice').digest('hex').slice(0, 32));
  mkdirSync(join(owned, 'Trips'), { recursive: true });
  writeFileSync(join(owned, 'headshot.png'), image);
  writeFileSync(join(owned, 'Trips', 'beach.png'), image);
  writeFileSync(join(owned, 'notes.txt'), 'not an image');
  writeFileSync(join(owned, 'portrait.png'), image);
  const pool = { query: async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    if (/SELECT portrait_id FROM ps_portraits/.test(sql)) {
      return { rows: values?.[0] === 'alice' ? [{ portrait_id: portraitId }] : [], rowCount: 1 };
    }
    if (/SELECT \* FROM ps_portraits WHERE portrait_id/.test(sql)) {
      return { rows: values?.[0] === portraitId && values?.[1] === 'alice' ? [{ portrait_id: portraitId, status: 'done', output_path: join(owned, 'portrait.png') }] : [] };
    }
    return { rows: [], rowCount: 0 };
  } };
  const ctx = { pool, appPackageDir: join(store, 'portrait-studio') } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const match = /(?:^|;\s*)picker-user=(alice|bob)/.exec(req.headers.cookie || '');
    if (match) (req as any).oidc = { user: { sub: match[1] }, isAuthenticated: () => true };
    next();
  });
  registerAppArtifactActions('portrait-studio', { provides: [{ label: 'Portrait Studio', types: ['image/png'], list: '/api/portrait-studio/artifacts' }] });
  registerAppArtifactActions('hidden-source', { provides: [{ types: ['image/png'], list: '/api/hidden/artifacts' }] });
  app.use('/api/artifacts', createArtifactExchangeRoutes(ctx, async () => new Map(denyPortraits ? [] : [['portrait-studio', 'Portrait Studio']])));
  app.use('/api/files', createFilesRoutes(ctx, workspace));
  app.get('/api/portrait-studio/provider', (_req, res) => res.json({ configured: true, provider: 'fixture' }));
  app.use('/shared', express.static(join(process.cwd(), 'src/shared')));
  app.use('/cockpit/css/themes', express.static(join(process.cwd(), 'src/pages/cockpit/css/themes')));
  // Vite transforms the actual package TypeScript and its framework imports, not a route double.
  const { createPortraitStudioRoutes } = await import(join(store, 'portrait-studio/src-routes/portrait-studio-routes.ts').replaceAll('\\', '/'));
  app.use('/api/portrait-studio', createPortraitStudioRoutes(ctx));
  await new Promise<void>(done => { server = app.listen(0, '127.0.0.1', done); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>(done => server.close(() => done()));
  unregisterAppArtifactActions('portrait-studio'); unregisterAppArtifactActions('hidden-source');
  vi.unstubAllEnvs();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/** @description Call the real HTTP endpoint as one fixture-authenticated user. */
function request(path: string, user = 'alice', init: RequestInit = {}) {
  return fetch(base + path, { ...init, headers: { Cookie: `picker-user=${user}`, ...init.headers } });
}

describe('shared artifact picker', () => {
  it('discovers only visible, matching sources and retracts deactivated registrations', async () => {
    expect((await fetch(base + '/api/artifacts/sources')).status).toBe(401);
    const sources = await (await request('/api/artifacts/sources?type=image/*')).json();
    expect(sources.sources.map((s: any) => s.app)).toEqual(['kernel-storage', 'portrait-studio']);
    const docs = await (await request('/api/artifacts/sources?type=application/pdf')).json();
    expect(docs.sources.map((s: any) => s.app)).toEqual(['kernel-storage']);
    denyPortraits = true;
    expect((await (await request('/api/artifacts/sources')).json()).sources).toHaveLength(1);
    denyPortraits = false;
    unregisterAppArtifactActions('portrait-studio');
    expect((await (await request('/api/artifacts/sources')).json()).sources).toHaveLength(1);
    registerAppArtifactActions('portrait-studio', { provides: [{ types: ['image/png'], list: '/api/portrait-studio/artifacts' }] });
    expect(validateArtifactActionsDeclaration({ provides: [{ types: ['image/png'], label: ' ', list: '/api/a' }] })).toContain('label');
  });

  it('reads only owner files, rejects invalid cursors, and redeems handles only for their owner', async () => {
    expect((await request('/api/artifacts/storage?cursor=bad!')).status).toBe(400);
    const roots = await (await request('/api/artifacts/storage')).json();
    const cursor = roots.folders.find((f: any) => f.name === 'OSHAL Storage').cursor;
    const alice = await (await request('/api/artifacts/storage?cursor=' + cursor)).json();
    expect(alice.items.some((f: any) => f.name === 'headshot.png')).toBe(true);
    expect((await (await request('/api/artifacts/storage?cursor=' + cursor, 'bob')).json()).items).toEqual([]);
    const selected = alice.items.find((f: any) => f.name === 'headshot.png');
    const handle = await (await request('/api/artifacts/handles', 'alice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selected) })).json();
    expect((await request(`/api/artifacts/handles/${handle.ref}/content`, 'bob')).status).toBe(404);
    expect(Buffer.from(await (await request(`/api/artifacts/handles/${handle.ref}/content`)).arrayBuffer())).toEqual(image);
    const portrait = await (await request('/api/portrait-studio/artifacts')).json();
    expect(portrait.items[0].source).toContain(portraitId);
    expect((await (await request('/api/portrait-studio/artifacts', 'bob')).json()).items).toEqual([]);
    expect((await request('/api/portrait-studio/artifacts?cursor=-1')).status).toBe(400);
    expect(queries.some(q => /SELECT portrait_id FROM ps_portraits/.test(q.sql) && q.values?.[0] === 'alice' && /status = 'done'/.test(q.sql))).toBe(true);
  });

  it('loads a real stored image into the shipped Portrait Studio crop stage and cancels without minting', async () => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'picker-user', value: 'alice', url: base }]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let mints = 0;
    page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/api/artifacts/handles')) mints++; });
    await page.goto(base + '/api/portrait-studio/app');
    await page.getByRole('button', { name: 'Choose from OSHAL', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a photo from OSHAL' });
    await dialog.getByRole('button', { name: 'Folder: OSHAL Storage', exact: true }).click();
    await dialog.getByRole('button', { name: 'Folder: Trips', exact: true }).click();
    await dialog.getByRole('button', { name: 'beach.png', exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    await dialog.getByRole('button', { name: 'headshot.png', exact: true }).waitFor();
    expect(await dialog.getByRole('button', { name: 'notes.txt', exact: true }).count()).toBe(0);
    expect(await dialog.locator('.ap-status').textContent()).toContain('1 unsupported');
    await page.keyboard.press('Escape');
    expect(mints).toBe(0);
    expect(await page.locator('#browseFilesBtn').evaluate(el => el === document.activeElement)).toBe(true);
    await page.locator('#browseFilesBtn').click();
    await dialog.getByRole('button', { name: 'Folder: OSHAL Storage', exact: true }).click();
    await dialog.getByRole('button', { name: 'headshot.png', exact: true }).click();
    await page.locator('#cropStage').waitFor({ state: 'visible' });
    expect(mints).toBe(1);
    await page.goto(base + '/api/portrait-studio/app');
    await page.locator('#browseFilesBtn').click();
    await dialog.getByRole('button', { name: 'Portrait Studio', exact: true }).click();
    await dialog.getByRole('button', { name: `portrait-${portraitId}.png`, exact: true }).waitFor();
    const before = queries.length;
    await dialog.getByRole('button', { name: `portrait-${portraitId}.png`, exact: true }).click();
    await page.locator('#cropStage').waitFor({ state: 'visible' });
    expect(mints).toBe(2);
    expect(await page.locator('#fileModal').count()).toBe(0);
    expect(queries.slice(before).every(q => /^SELECT /i.test(q.sql))).toBe(true);
    expect(errors).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { (window as any).oshalPickArtifact({ accept: ['image/*'] }); });
    await page.locator('.oshal-artifact-picker').waitFor();
    const box = await page.locator('.oshal-artifact-picker').boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    if (process.env.OSHAL_PICKER_SCREENSHOT_DIR) {
      mkdirSync(process.env.OSHAL_PICKER_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.OSHAL_PICKER_SCREENSHOT_DIR, 'picker-mobile.png') });
    }
    const darkBackground = await page.locator('.oshal-artifact-picker').evaluate(el => getComputedStyle(el).backgroundColor);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'daylight'));
    const lightBackground = await page.locator('.oshal-artifact-picker').evaluate(el => getComputedStyle(el).backgroundColor);
    expect(lightBackground).not.toBe(darkBackground);
    await page.keyboard.press('Escape');
    await context.close();
  }, 30000);

  it('refuses malformed source links without minting and ignores a response after cancellation', async () => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'picker-user', value: 'alice', url: base }]);
    const page = await context.newPage();
    await page.goto(base + '/api/portrait-studio/app');
    let mints = 0;
    page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/api/artifacts/handles')) mints++; });
    await page.route('**/api/portrait-studio/artifacts', route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ items: [{ name: 'foreign.png', type: 'image/png', source: 'https://example.invalid/private.png' }] }),
    }));
    await page.locator('#browseFilesBtn').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Portrait Studio', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Retry', exact: true }).waitFor();
    expect(await page.getByRole('dialog').locator('.ap-status').textContent()).toContain('invalid file link');
    expect(mints).toBe(0);
    await page.keyboard.press('Escape');
    await page.unroute('**/api/portrait-studio/artifacts');
    let release: (() => void) | undefined;
    const pending = new Promise<void>(done => { release = done; });
    let started: (() => void) | undefined;
    const requested = new Promise<void>(done => { started = done; });
    await page.route('**/api/artifacts/sources?*', async route => {
      started!(); await pending;
      await route.fulfill({ contentType: 'application/json', body: '{"sources":[]}' }).catch(() => {});
    });
    await page.locator('#browseFilesBtn').click(); await requested;
    await page.keyboard.press('Escape'); release!();
    expect(await page.getByRole('dialog', { name: 'Choose a photo from OSHAL' }).count()).toBe(0);
    expect(mints).toBe(0);
    await context.close();
  }, 30000);
});

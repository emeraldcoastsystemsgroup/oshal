/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exercise the shipped Project Manager over isolated HTTP envelopes, refusal, malformed data and safe text; preserve explicit creation and owned browser cleanup.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Observe completed list outcomes across current and prior shipped markup, keeping the same semantic assertions meaningful in old-source regression proofs.
 */
import express from 'express';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';

type Reply = { status: number; body: unknown; wait?: Promise<void>; raw?: boolean };
let server: Server, origin: string, browser: Browser, context: BrowserContext, page: Page;
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let reply: Reply, posts: unknown[], expectedPosts: number, createStatus: number;
let errors: string[], external: string[], reads: number;
vi.setConfig({ hookTimeout: BROWSER_HOOK_TIMEOUT_MS, testTimeout: 20_000 });

beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.get('/', (_req, res) => res.type('html').send('<!doctype html><html lang="en"><title>Isolated Project Manager</title><body></body></html>'));
  app.use('/cockpit', express.static(path.resolve('src/pages/cockpit')));
  app.get('/api/v1/projects', async (_req, res) => {
    const selected = reply; reads++; await selected.wait;
    if (selected.raw) res.status(selected.status).type('json').send(selected.body);
    else res.status(selected.status).json(selected.body);
  });
  app.post('/api/v1/projects', (req, res) => {
    posts.push(req.body); res.status(createStatus).json({ success: createStatus === 200 });
  });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  owned = await launchIsolatedBrowser(); browser = owned.browser;
});
beforeEach(async () => {
  reply = { status: 200, body: { success: true, projects: [] } };
  posts = []; expectedPosts = 0; createStatus = 200; reads = 0; errors = []; external = [];
  context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(4000);
  page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
});
afterEach(async () => {
  try { expect(posts).toHaveLength(expectedPosts); expect(errors).toEqual([]); expect(external).toEqual([]); }
  finally { await context?.close(); }
});
afterAll(async () => {
  try {
    if (owned) {
      const receipt = await owned.close(); await mkdir('temp', { recursive: true });
      await writeFile(`temp/ticket-project-modal-browser-cleanup-${Date.now()}.json`, JSON.stringify(receipt, null, 2));
    }
  } finally {
    server?.closeAllConnections(); if (server) await new Promise<void>(done => server.close(() => done()));
  }
}, BROWSER_HOOK_TIMEOUT_MS);

/** @description Invoke the shipped exported modal, not an alternate renderer or controller.
 * @returns Browser-native module completion; the asynchronous HTTP read settles separately. */
async function open() {
  await page.evaluate(`(async () => {
    const { openProjectManagerModal } = await import('/cockpit/js/views/TicketModals.js');
    openProjectManagerModal(() => { window.projectCallback = (window.projectCallback || 0) + 1; });
  })()`);
}

/** @description Wait for the current modal's real fetch response and DOM outcome.
 * @returns No value. */
async function settled() {
  await expect.poll(() => page.locator('#pmProjectList .loading-text').count()).toBe(0);
}

it('renders the actual success/projects envelope and uses text nodes for every server field', async () => {
  const name = '<img src=x onerror="window.projectInjected=true"> & Project';
  const description = '<script>window.projectInjected=true</script> description';
  reply.body = { success: true, projects: [{ id: 'own', name, description }, { id: 'second', name: 'Second Project' }] };
  await open(); await settled();
  expect(await page.locator('.project-card').count()).toBe(2);
  expect(await page.locator('.project-card strong').first().textContent()).toBe(name);
  expect(await page.locator('.project-card p').first().textContent()).toBe(description);
  expect(await page.locator('.project-card p').last().textContent()).toBe('No description');
  expect(await page.locator('#pmProjectList img, #pmProjectList script').count()).toBe(0);
  expect(await page.locator('#pmProjectList').textContent()).not.toContain('No projects yet.');
  expect(await page.evaluate(() => 'projectInjected' in window)).toBe(false);
  expect(reads).toBe(1);
});

it('shows a genuine successful empty list without creating a project', async () => {
  await open(); await settled();
  expect(await page.locator('#pmProjectList .empty-text').textContent()).toBe('No projects yet.');
  expect(await page.locator('.project-card, .error-text').count()).toBe(0);
});

it.each([401, 403, 500, 503])('keeps HTTP%i distinct from an empty list and withholds any refused body rows', async status => {
  reply = { status, body: { success: true, projects: [{ name: 'REFUSED PRIVATE PROJECT' }] } };
  await open(); await settled();
  expect(await page.locator('#pmProjectList').textContent()).not.toMatch(/No projects yet|REFUSED PRIVATE/);
  const text = await page.locator('#pmProjectList .error-text').textContent();
  expect(text).toBe(status === 403 ? 'Projects are not available to you.'
    : 'Projects could not be loaded. Close and reopen to try again.');
  expect(await page.locator('.project-card').count()).toBe(0);
});

it.each([
  'null', '{}', '[]', '{"success":false,"projects":[]}', '{"success":true,"projects":"wrong"}',
  '{"success":true,"projects":[null]}', '{"success":true,"projects":[{"name":""}]}',
  '{"success":true,"projects":[{"name":"Valid","description":42}]}', 'not JSON',
])('reports malformed HTTP200 %s as unavailable without false empty or partial rows', async body => {
  reply = { status: 200, body, raw: true }; await open(); await settled();
  expect(await page.locator('#pmProjectList .error-text').textContent()).toContain('Projects could not be loaded.');
  expect(await page.locator('#pmProjectList').textContent()).not.toContain('No projects yet.');
  expect(await page.locator('.project-card').count()).toBe(0);
});

it('keeps loading until the HTTP answer arrives and recovers by reopening after failure', async () => {
  let release!: () => void; const wait = new Promise<void>(done => { release = done; });
  reply = { status: 503, body: { success: false }, wait };
  try {
    await open(); await expect.poll(() => reads).toBe(1);
    expect(await page.locator('#pmProjectList').getAttribute('aria-busy')).toBe('true');
    expect(await page.locator('#pmProjectList .loading-text').textContent()).toBe('Loading projects...');
    release(); await settled(); await page.locator('#pmCancel').click();
    reply = { status: 200, body: { success: true, projects: [{ name: 'Recovered own project' }] } };
    await open(); await settled();
    expect(await page.locator('.project-card strong').textContent()).toBe('Recovered own project');
  } finally { release(); }
});

it('does not repaint a reopened modal with a late answer from its cancelled predecessor', async () => {
  let release!: () => void; const wait = new Promise<void>(done => { release = done; });
  reply = { status: 200, body: { success: true, projects: [{ name: 'Cancelled modal row' }] }, wait };
  try {
    const firstRead = page.waitForRequest('**/api/v1/projects');
    await open(); const cancelledRead = await firstRead; await expect.poll(() => reads).toBe(1);
    await page.locator('#pmCancel').click();
    reply = { status: 200, body: { success: true, projects: [{ name: 'Current modal row' }] } };
    await open(); await settled(); release(); await (await cancelledRead.response())?.finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.locator('.project-card strong').textContent()).toBe('Current modal row');
    expect(await page.locator('#pmProjectList').textContent()).not.toContain('Cancelled modal row');
  } finally { release(); }
});

it('preserves explicit successful creation and calls the existing callback exactly once', async () => {
  await open(); await settled(); expectedPosts = 1;
  await page.locator('#pmName').fill('Explicit Project'); await page.locator('#pmDescription').fill('User description');
  await page.getByRole('button', { name: 'Create Project' }).click();
  await expect.poll(() => page.locator('#projectManagerOverlay').count()).toBe(0);
  expect(posts).toEqual([{ name: 'Explicit Project', description: 'User description' }]);
  expect(await page.evaluate(() => (window as Window & { projectCallback?: number }).projectCallback)).toBe(1);
});

it('preserves an explicit refused create without closing the modal or invoking success', async () => {
  createStatus = 403; await open(); await settled(); expectedPosts = 1;
  const alert = page.waitForEvent('dialog'); await page.locator('#pmName').fill('Refused Project');
  const click = page.getByRole('button', { name: 'Create Project' }).click();
  const dialog = await alert; expect(dialog.message()).toBe('Failed to create project: HTTP 403'); await dialog.dismiss();
  await click;
  expect(await page.locator('#projectManagerOverlay').count()).toBe(1);
  expect(await page.locator('#pmName').inputValue()).toBe('Refused Project');
  expect(await page.evaluate(() => (window as Window & { projectCallback?: number }).projectCallback)).toBeUndefined();
});

it('registers the shipped modal fixture and its actual server-fence companion without changing readiness into a write', async () => {
  const cards = SCENARIOS.filter(card => card.id === 'cockpit-appearance'); expect(cards).toHaveLength(1);
  expect(cards[0].regressionTests).toContainEqual({ level: 'browser', path: 'tests/unit/ticket-project-modal-browser.spec.ts' });
  expect(cards[0].steps.map(step => step.id)).toEqual(['workspace-stylesheet', 'profile-stylesheet']);
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
  expect(pkg.scripts['test:ticket-projects']).toBe('vitest run --no-file-parallelism --hookTimeout 60000 tests/unit/ticket-project-modal-browser.spec.ts tests/unit/cockpit-project-administration-http.spec.ts tests/unit/test-lab-appearance-registration.spec.ts');
});

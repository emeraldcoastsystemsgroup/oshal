/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-164 D6 audience view of the kernel Workflow Studio page, proven in headless Chromium over the REAL page (src/pages/workflow-studio at /workflow-studio/, its module scripts, /shared/ui and /shared from the tree) behind one loopback express server with synthetic JSON answers and a journal of every request: the company and family views paint the card from exactly GET /api/workflow-studio/definitions and GET /api/workflow-studio/runs?limit=50 with no write and the studio hidden and not started; each refusal (401, the 403 operator gate, 404, 5xx, network failure, malformed JSON) is said with no stat in its place; the primary action leaves the view for the full studio in the same frame; without an audience and with ?audience=classroom the studio starts exactly as before and #av-root is absent.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | All four start gates are proven: under a view a click on the Runs rail button opens no flyout and a surface-bridge render_options message renders nothing, with no new request; without an audience the same two stimuli open the flyout and render the options (the positive control that lets the probe go red).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  buildSeedWorkflowDefinition,
  buildWorkflowDefinitionSummary,
  buildWorkflowStudioCatalog,
  type WorkflowDefinition,
} from '@/features/workflow-studio';

vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });

const PAGE_DIR = resolve(process.cwd(), 'src/pages/workflow-studio');
const SHARED_UI_DIR = resolve(process.cwd(), 'src/shared/ui');
const PAGES_SHARED_DIR = resolve(process.cwd(), 'src/pages/shared');
/** The only two reads the card may make: both are GETs the full studio already makes. */
const CARD_READS = ['GET /api/workflow-studio/definitions', 'GET /api/workflow-studio/runs?limit=50'];

type Mode = 'ok' | 401 | 403 | 404 | 503 | 'network' | 'malformed';
interface FixtureState { modes: Record<'definitions' | 'runs', Mode>; journal: string[] }

/** @description An ISO timestamp a number of minutes before now, so relative dates stay stable in any zone. */
function minutesAgo(minutes: number): string { return new Date(Date.now() - minutes * 60000).toISOString(); }

/** @description Three synthetic saved workflows built by the studio's own seed builder, newest first. */
function syntheticDefinitions(): WorkflowDefinition[] {
  const specs: Array<[string, number, number]> = [['Synthetic onboarding', 4, 30], ['Synthetic incident triage', 2, 60 * 26], ['Synthetic build review', 1, 60 * 24 * 5]];
  return specs.map(([name, version, age]) => ({ ...buildSeedWorkflowDefinition({ name }), version, updatedAt: minutesAgo(age) }));
}

/** @description Four synthetic runs for the signed-in account: running, suspended, escalated and completed. */
function syntheticRuns(): Array<Record<string, unknown>> {
  const run = (id: string, status: string, age: number, tookMs: number | null, stepCount: number) => {
    const startedAt = minutesAgo(age);
    return { runId: `run-${id}`, ticketId: `ticket-${id}`, ownerSub: 'synthetic-user', ticketType: 'synthetic-onboarding', workflowName: 'Synthetic onboarding', status, outcome: null, reason: null, resumedCount: 0,
      startedAt, finishedAt: tookMs === null ? null : new Date(new Date(startedAt).getTime() + tookMs).toISOString(), stepCount };
  };
  return [run('1', 'running', 5, null, 3), run('2', 'suspended', 90, null, 2), run('3', 'escalated', 180, 120000, 5), run('4', 'completed', 60 * 30, 4200, 6)];
}

/** @description Answer one read in the mode the case chose: the synthetic body, a refusal, a dropped socket or broken JSON. */
function answer(res: express.Response, mode: Mode, body: unknown): void {
  if (mode === 'network') { res.socket?.destroy(); return; }
  if (mode === 'malformed') { res.status(200).type('application/json').send('{"definitions": [{"id": '); return; }
  if (mode === 401) { res.status(401).json({ error: 'Authentication required' }); return; }
  if (mode === 403) { res.status(403).json({ error: 'Operator privilege required' }); return; }
  if (mode === 404) { res.status(404).json({ error: 'Not found' }); return; }
  if (mode === 503) { res.status(503).json({ success: false, error: 'Run history requires a database.' }); return; }
  res.json(body);
}

/** @description Mount the studio's reads (the card's two plus the full page's own load reads) over the synthetic data. */
function apiRoutes(app: express.Application, state: FixtureState, definitions: WorkflowDefinition[], runs: Array<Record<string, unknown>>): void {
  app.get('/api/workflow-studio/definitions', (_req, res) => {
    const summaries = definitions.map((d) => buildWorkflowDefinitionSummary(d));
    answer(res, state.modes.definitions, { count: summaries.length, definitions: summaries, success: true });
  });
  app.get('/api/workflow-studio/runs', (_req, res) => answer(res, state.modes.runs, { success: true, count: runs.length, runs }));
  app.get('/api/workflow-studio/catalog', (_req, res) => res.json({ catalog: buildWorkflowStudioCatalog(), success: true }));
  app.get('/api/workflow-studio/templates', (_req, res) => res.json({ templates: [{ id: 'synthetic-template', name: 'Synthetic template', description: 'A synthetic starting point.' }], success: true }));
  app.get('/api/workflow-studio/definitions/:id/versions', (req, res) => res.json({ definitionId: req.params.id, versions: [], success: true }));
  app.get('/api/workflow-studio/definitions/:id', (req, res) => {
    const definition = definitions.find((d) => d.id === req.params.id);
    if (!definition) { res.status(404).json({ error: 'Workflow definition not found', success: false }); return; }
    res.json({ definition, success: true });
  });
  app.get('/api/agents', (_req, res) => res.json({ agents: [] }));
  app.use('/api', (_req, res) => { res.status(405).json({ error: 'Not part of this fixture' }); });
}

/** @description Start the loopback server: the real page and its assets at their real paths, the synthetic reads, and a journal. */
async function startServer(state: FixtureState) {
  const definitions = syntheticDefinitions(), runs = syntheticRuns();
  const app = express();
  app.use((req, _res, next) => { state.journal.push(`${req.method} ${req.originalUrl}`); next(); });
  app.use('/shared/ui', express.static(SHARED_UI_DIR));
  app.use('/shared', express.static(PAGES_SHARED_DIR, { index: false, redirect: false }));
  app.use('/workflow-studio', express.static(PAGE_DIR));
  app.get('/host', (req, res) => res.type('html').send(`<!doctype html><html><head><title>Synthetic shell</title></head><body><iframe id="host-frame" src="/workflow-studio/?audience=${String(req.query.audience || 'company')}" style="width:1100px;height:800px"></iframe></body></html>`));
  app.get('/cockpit/', (_req, res) => res.type('html').send('<!doctype html><html><head><title>Synthetic cockpit</title></head><body>Synthetic cockpit</body></html>'));
  apiRoutes(app, state, definitions, runs);
  const server: Server = await new Promise((done) => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, definitions, runs, close: () => new Promise<void>((done) => server.close(() => done())) };
}

const state: FixtureState = { modes: { definitions: 'ok', runs: 'ok' }, journal: [] };
let server: Awaited<ReturnType<typeof startServer>>;
let browser: Browser, context: BrowserContext, page: Page;
const errors: string[] = [];

beforeAll(async () => { server = await startServer(state); browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); await server?.close(); });
beforeEach(async () => {
  state.modes = { definitions: 'ok', runs: 'ok' }; state.journal.length = 0; errors.length = 0;
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort()));
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(String((e as Error)?.message || e)));
});
afterEach(async () => { await context?.close(); });

/** @description Every API request and every non-GET the page made, in the order the server saw them. */
function apiAndWrites(): string[] { return state.journal.filter((entry) => entry.startsWith('GET /api/') || !entry.startsWith('GET ')); }

/** @description Open the real studio page with a query string and wait until the card or the studio has painted. */
async function openStudio(query: string): Promise<void> {
  await page.goto(`${server.origin}/workflow-studio/${query}`);
  await page.waitForFunction(() => typeof (window as unknown as { AppView?: unknown }).AppView === 'object');
}

/** @description The text of every cell of one table section's first body row. */
function firstRow(section: string): Promise<string[]> {
  return page.locator(`#av-root [data-section="${section}"] tbody tr`).first().locator('td').allTextContents();
}

/** @description Send the two stimuli only a started studio answers: a click on the Runs rail button (runsPanel.init binds it) and a
 * surface-bridge render_options message (bridge.attach listens for it). Returns what each produced. */
async function stimulateRunsAndBridge(): Promise<{ flyoutOpen: boolean; railActive: boolean; options: number }> {
  await page.evaluate(() => {
    (document.getElementById('railRunsButton') as HTMLElement | null)?.click();
    window.postMessage({ channel: 'oshal-surface-bridge', v: 1, app: 'workflow-studio', op: 'render_options', prompt: 'Synthetic prompt',
      options: [{ id: 'synthetic-option', label: 'Synthetic option' }] }, window.location.origin);
  });
  await page.waitForTimeout(300);
  return page.evaluate(() => ({
    flyoutOpen: (document.getElementById('runsFlyout') as HTMLElement | null)?.hidden === false,
    railActive: !!document.getElementById('railRunsButton')?.classList.contains('is-active'),
    options: document.querySelector('[data-bridge-host="options"]')?.childElementCount ?? -1,
  }));
}

/** @description Assert the studio underneath the card is hidden and never started (no load, no chat greeting, and neither the
 * runs panel nor the surface bridge answers its stimulus). */
async function expectStudioNotStarted(): Promise<void> {
  const probe = await page.evaluate(() => {
    const w = window as unknown as { workflowStudioApp?: { state: { definitions: unknown[] } } };
    const shown = (sel: string) => { const el = document.querySelector(sel) as HTMLElement | null; return !!el && getComputedStyle(el).display !== 'none'; };
    return { studio: shown('.studio'), fab: shown('#wfChatFab'), dock: shown('#wfBridgeDock'), definitions: w.workflowStudioApp?.state.definitions.length, greeting: document.getElementById('wfChatLog')?.childElementCount };
  });
  expect(probe).toEqual({ studio: false, fab: false, dock: false, definitions: 0, greeting: 0 });
  const before = apiAndWrites().length;
  expect(await stimulateRunsAndBridge()).toEqual({ flyoutOpen: false, railActive: false, options: 0 });
  expect(apiAndWrites().length, 'the stimuli made no request').toBe(before);
}

/** @description Assert the full studio started exactly as before: its own load reads, its greeting, no card and no write. */
async function expectStudioStarted(): Promise<void> {
  await page.waitForFunction(() => document.getElementById('statusBanner')?.textContent === 'Workflow studio ready.');
  const first = server.definitions[0].id;
  expect(apiAndWrites().sort()).toEqual([
    'GET /api/agents', 'GET /api/workflow-studio/catalog', 'GET /api/workflow-studio/definitions',
    `GET /api/workflow-studio/definitions/${first}`, `GET /api/workflow-studio/definitions/${first}/versions`, 'GET /api/workflow-studio/templates',
  ].sort());
  expect(await page.locator('#av-root').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBeNull();
  expect(await page.locator('#canvasHeading').textContent()).toBe('Synthetic onboarding');
  expect(await page.locator('#wfChatLog .wf-chat-msg, #wfChatLog > *').count()).toBeGreaterThan(0);
  expect(await page.locator('.studio').isVisible()).toBe(true);
  // Positive control: the started studio answers both stimuli, so the gate probe above can go red.
  const answered = await stimulateRunsAndBridge();
  expect(answered.flyoutOpen && answered.railActive, 'the Runs rail button opens the flyout').toBe(true);
  expect(answered.options, 'the bridge renders the options').toBeGreaterThan(0);
}

/** @description Assert the painted card carries the synthetic figures, sections and escape, from exactly the two reads. */
async function expectCard(audience: 'company' | 'family'): Promise<void> {
  await page.waitForSelector('#av-root [data-section="runs"] tbody tr');
  expect(await page.locator('#av-root').getAttribute('data-audience')).toBe(audience);
  expect(await page.locator('#av-root .av-kicker').textContent()).toBe('Engineering · Workflow Studio');
  expect(await page.locator('#av-root .av-title').textContent()).toBe('1 run escalated or failed');
  const stat = (id: string) => page.locator(`#av-root [data-stat="${id}"] .av-stat-value`).textContent();
  expect([await stat('workflows'), await stat('runs'), await stat('active'), await stat('attention')]).toEqual(['3', '4', '2', '1']);
  expect(await page.locator('#av-root [data-stat="workflows"] .av-stat-hint').textContent()).toMatch(/^Last edited /);
  expect(await page.locator('#av-root [data-section="workflows"] tbody tr').count()).toBe(3);
  const newest = buildWorkflowDefinitionSummary(server.definitions[0]);
  expect((await firstRow('workflows')).slice(0, 4)).toEqual(['Synthetic onboarding', 'v4', String(newest.nodeCount), String(newest.edgeCount)]);
  const runRows = page.locator('#av-root [data-section="runs"] tbody tr');
  expect(await runRows.count()).toBe(4);
  expect((await firstRow('runs')).slice(0, 3)).toEqual(['Synthetic onboarding', 'running', '3']);
  expect(await runRows.nth(2).locator('td').nth(1).getAttribute('class')).toContain('tone-bad');
  expect(await runRows.nth(2).locator('td').nth(4).textContent()).toBe('2 min 0 s');
  expect(await runRows.nth(3).locator('td').nth(4).textContent()).toBe('4.2 s');
  expect(await page.locator('#av-root .av-escape-link').getAttribute('href')).toBe('/cockpit/?app=workflow-studio');
  expect(await page.locator('#av-root .av-escape-link').textContent()).toBe('Open Workflow Studio in the cockpit');
  expect(await page.locator('#av-root header, #av-root h1, #av-root h2, #av-root h3').count()).toBe(0);
  expect(apiAndWrites().sort()).toEqual([...CARD_READS].sort());
}

describe('Workflow Studio audience view (ADR-164 D6)', () => {
  it('company view paints the card from the two reads, writes nothing and leaves the studio hidden and not started', async () => {
    await openStudio('?audience=company');
    await expectCard('company');
    await expectStudioNotStarted();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBe('company');
    expect(errors).toEqual([]);
  });

  it('family view paints the same card from the same two reads', async () => {
    await openStudio('?audience=family');
    await expectCard('family');
    await expectStudioNotStarted();
    expect(errors).toEqual([]);
  });

  const refusals: Array<[string, Mode, string]> = [
    ['401', 401, 'this session is not signed in (HTTP 401).'],
    ['the 403 operator gate', 403, 'this account was refused (HTTP 403). The server said: Operator privilege required'],
    ['404', 404, 'this server does not offer it (HTTP 404).'],
    ['5xx', 503, 'the server failed (HTTP 503). The server said: Run history requires a database.'],
    ['a network failure', 'network', 'the server could not be reached.'],
    ['malformed JSON', 'malformed', 'the answer was not the JSON the studio expects.'],
  ];
  it.each(refusals)('says %s in the card with no stat in place of a figure', async (_name, mode, said) => {
    state.modes = { definitions: mode, runs: mode };
    await openStudio('?audience=company');
    await page.waitForSelector('#av-root [data-section="runs"] .av-empty');
    expect(await page.locator('#av-root .av-title').textContent()).toBe('Workflow Studio could not be read');
    expect(await page.locator('#av-root .av-stat').count()).toBe(0);
    expect(await page.locator('#av-root table').count()).toBe(0);
    expect(await page.locator('#av-root [data-section="workflows"] .av-empty').textContent()).toBe(`The saved workflows could not be read: ${said}`);
    expect(await page.locator('#av-root [data-section="runs"] .av-empty').textContent()).toBe(`The run history could not be read: ${said}`);
    expect(state.journal.filter((entry) => !entry.startsWith('GET '))).toEqual([]);
    expect(state.journal.filter((entry) => entry.startsWith('GET /api/') && !CARD_READS.includes(entry))).toEqual([]);
    await expectStudioNotStarted();
    expect(errors).toEqual([]);
  });

  it('keeps the figures it could read and says the one refusal when only the run history fails', async () => {
    state.modes = { definitions: 'ok', runs: 503 };
    await openStudio('?audience=company');
    await page.waitForSelector('#av-root [data-section="runs"] .av-empty');
    expect(await page.locator('#av-root .av-stat').count()).toBe(1);
    expect(await page.locator('#av-root [data-stat="workflows"] .av-stat-value').textContent()).toBe('3');
    expect(await page.locator('#av-root .av-title').textContent()).toBe('3 saved workflows');
    expect(await page.locator('#av-root [data-section="runs"] .av-empty').textContent()).toBe('The run history could not be read: the server failed (HTTP 503). The server said: Run history requires a database.');
    expect(errors).toEqual([]);
  });

  it('the primary action leaves the view for the full studio in the same frame', async () => {
    await page.goto(`${server.origin}/host?audience=company`);
    const frame = page.frameLocator('#host-frame');
    await frame.locator('#av-root [data-section="runs"] tbody tr').first().waitFor();
    state.journal.length = 0;
    await frame.locator('#av-root .av-btn.is-primary', { hasText: 'Open Workflow Studio' }).click();
    const framed = page.frames().find((f) => f !== page.mainFrame());
    await expect.poll(() => framed && new URL(framed.url()).search, { timeout: 15000 }).toBe('');
    expect(new URL(framed!.url()).pathname).toBe('/workflow-studio/');
    expect(new URL(page.url()).pathname).toBe('/host');
    await framed!.waitForFunction(() => document.getElementById('statusBanner')?.textContent === 'Workflow studio ready.');
    expect(await framed!.locator('#av-root').count()).toBe(0);
    expect(state.journal).toContain('GET /api/workflow-studio/catalog');
    expect(errors).toEqual([]);
  });

  it('without an audience the full studio starts exactly as before and #av-root is absent', async () => {
    await openStudio('');
    await expectStudioStarted();
    expect(errors).toEqual([]);
  });

  it('with ?audience=classroom (not provided by this page) the full studio starts exactly as before', async () => {
    await openStudio('?audience=classroom');
    await expectStudioStarted();
    expect(await page.evaluate(() => (window as unknown as { AppView: { active(): string | null } }).AppView.active())).toBeNull();
    expect(errors).toEqual([]);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Configuration (oshal-engineering) audience view (ADR-164 D6) in headless Chromium over one loopback server: the real src/pages/config-admin/index.html at its real route (/config/), its scripts and stylesheet at their real alias (/config-admin/), /shared/ui-debug.js and /shared/ui from source, synthetic answers for the four GETs the card reads (/api/agents/provider-switch, /api/agents, /api/config, /api/config/rag) plus the two more the full page makes on load (/api/config/ownership, /api/providers), and a journal of every request. The company and family views paint the same card from those four reads with no write, no other read and the full page hidden and unstarted; every refusal kind (401, the 403 operator gate, another 403, 404, 5xx, network failure, malformed JSON, an unreadable shape) is said with no stat; a mixed operator-gate refusal paints the bot figures and says the rest; the primary action leaves the view for the full page in the same frame; without an audience, with ?audience=classroom and on a core without the kit, the full page starts exactly as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import express, { type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });

const ROOT = process.cwd();
const HOUR = 3600_000;
const PAGE_DIR = resolve(ROOT, 'src/pages/config-admin');
const PAGE_FILE = resolve(PAGE_DIR, 'index.html');
const PAGE_PATH = '/config/';
const READS = ['/api/agents/provider-switch', '/api/agents', '/api/config', '/api/config/rag'];
const FULL_ONLY = ['/api/config/ownership', '/api/providers'];
/** @description An ISO timestamp offsetMs from now, so synthetic timestamps sit at known distances from the reader's clock. */
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Answer = { status: number; body?: unknown; raw?: string };
type ReadKey = 'switch' | 'agents' | 'config' | 'rag';
interface Journaled { method: string; url: string }

/** @description One synthetic bot as GET /api/agents reports it: the summary fields plus the resolved provider rung. */
function bot(n: number, providerSource: string | null, provider: string, model: string | null) {
  return {
    agentId: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, agent_id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    name: `synthetic-bot-${String(n).padStart(2, '0')}`, status: n % 2 ? 'active' : 'inactive', providerId: 'auto', modelId: null,
    effectiveProvider: provider, effectiveModel: model, ...(providerSource ? { providerSource } : {}), providerOverridable: true,
  };
}

/** @description Ten synthetic bots: one refused switch, two on their own row, five on the fleet default, one registry harness, one unreported. */
function syntheticAgents() {
  return {
    agents: [
      bot(1, 'fleet-default', 'synthetic-provider-a', 'synthetic-model-a'), bot(2, 'fleet-default', 'synthetic-provider-a', 'synthetic-model-a'),
      bot(3, 'bot-row', 'synthetic-provider-b', null), bot(4, 'fleet-default', 'synthetic-provider-a', 'synthetic-model-a'),
      bot(5, 'switch-refused', 'synthetic-retired-provider', null), bot(6, 'registry-harness', 'synthetic-harness', null),
      bot(7, 'fleet-default', 'synthetic-provider-a', 'synthetic-model-a'), bot(8, 'bot-row', 'synthetic-provider-c', 'synthetic-model-c'),
      bot(9, null, '', null), bot(10, 'fleet-default', 'synthetic-provider-a', 'synthetic-model-a'),
    ],
  };
}

/** @description GET /api/agents/provider-switch shaped like provider-switch-routes.ts: the fleet row, three per-bot rows, the snapshot, the accepted ids. */
function syntheticSwitch() {
  const row = (scopeId: string, providerId: string) => ({ scopeId, providerId, modelId: null, fallbackOrder: null, updatedBy: 'synthetic-operator', updatedAt: iso(-5 * HOUR) });
  return {
    success: true,
    fleetDefault: { scopeId: 'fleet-default', providerId: 'synthetic-provider-a', modelId: 'synthetic-model-a', fallbackOrder: ['synthetic-provider-b', 'synthetic-provider-c'], updatedBy: 'synthetic-operator', updatedAt: iso(-2 * HOUR) },
    perBot: [row('00000000-0000-4000-8000-000000000003', 'synthetic-provider-b'), row('00000000-0000-4000-8000-000000000008', 'synthetic-provider-c'), row('00000000-0000-4000-8000-000000000005', 'synthetic-retired-provider')],
    snapshot: { loaded: true, loadedAt: iso(-3 * HOUR), rowCount: 4, fleetDefault: null, lastError: null },
    accepted: ['synthetic-provider-a', 'synthetic-provider-b', 'synthetic-provider-c'],
  };
}

/** @description GET /api/config after the route's redaction: provider picks, addresses (one carrying a synthetic credential) and a redacted key. */
function syntheticConfig() {
  return {
    success: true,
    config: {
      planModeApiProvider: 'synthetic-provider-a', actModeApiProvider: 'synthetic-provider-b', planeUrl: 'http://synthetic-plane.invalid',
      redisUrl: 'redis://synthetic:synthetic-redis-password@synthetic-redis.invalid:6379', gitRepoUrl: '', codeServerWorkspaceRoot: '/synthetic/workspace', apiKey: '[REDACTED]',
    },
  };
}

/** @description GET /api/config/rag: a configured endpoint, a collection, an embedder and tiered chunking. */
function syntheticRag() {
  return {
    success: true,
    config: {
      endpoint: 'http://synthetic-chroma.invalid:8000', defaultCollection: 'synthetic-collection', embeddingProviderId: 'synthetic-embedder', embeddingModelId: 'synthetic-embedding-model',
      chunking: { strategy: 'tiered', chunkSize: 700, chunkOverlap: 100, tierSizes: [1200, 700, 350], tierOverlaps: [180, 100, 60] },
    },
  };
}

/** @description The two reads only the full page makes: the ownership contract and the provider catalog. */
function syntheticOwnership() {
  const part = (routeBase: string) => ({ routeBase, summary: `Synthetic summary for ${routeBase}.`, examples: [`${routeBase}/synthetic`], routes: [routeBase] });
  return {
    success: true,
    ownership: {
      globalConfig: { ...part('/api/config'), routes: ['/api/config', '/api/config/rag'] }, perAgentProfile: part('/api/agents/:agentId/profile'),
      perAgentTools: part('/api/agents/:agentId/tools'), legacyCompatibility: { routes: ['/api/config/llm'], summary: 'Synthetic legacy summary.', guidance: ['Synthetic guidance.'] },
    },
  };
}
/** @description Three synthetic provider rows in the shape the provider list answers, for the card's provider count. */
const syntheticProviders = () => ['a', 'b', 'c'].map((k) => ({ id: `synthetic-provider-${k}`, displayName: `Synthetic Provider ${k.toUpperCase()}`, description: 'Synthetic provider.', models: [{ id: `synthetic-model-${k}`, name: `Synthetic model ${k}` }], defaultModelId: `synthetic-model-${k}`, requiresApiKey: false, configKeys: [] }));

const state = { answers: {} as Record<ReadKey, Answer>, kit: true, journal: [] as Journaled[] };

/** @description Fresh synthetic answers, the kit served, an empty journal: every case starts from the same swarm. */
function resetState() {
  state.answers = { switch: { status: 200, body: syntheticSwitch() }, agents: { status: 200, body: syntheticAgents() }, config: { status: 200, body: syntheticConfig() }, rag: { status: 200, body: syntheticRag() } };
  state.kit = true;
  state.journal = [];
}

/** @description Script every card read with the same answer. */
function answerAll(answer: Answer) { (Object.keys(state.answers) as ReadKey[]).forEach((k) => { state.answers[k] = answer; }); }

/** @description Answer one read from the case's scripted state (a raw body is sent as-is under a JSON content type). */
function send(res: Response, answer: Answer) {
  if (answer.raw !== undefined) { res.status(answer.status).type('application/json').send(answer.raw); return; }
  res.status(answer.status).json(answer.body ?? {});
}

/** @description The page's six load reads over the scripted state; any other /api path is outside the fixture. */
function apiRoutes(app: express.Application) {
  app.get('/api/agents/provider-switch', (_req, res) => send(res, state.answers.switch));
  app.get('/api/agents', (_req, res) => send(res, state.answers.agents));
  app.get('/api/config/rag', (_req, res) => send(res, state.answers.rag));
  app.get('/api/config/ownership', (_req, res) => res.json(syntheticOwnership()));
  app.get('/api/config', (_req, res) => send(res, state.answers.config));
  app.get('/api/providers', (_req, res) => res.json(syntheticProviders()));
  app.use('/api', (_req, res) => res.status(405).json({ error: 'not_in_fixture' }));
}

/** @description One loopback server: the real page at its real route and asset alias, the shared helpers and theme files from source, the synthetic reads, a framing host and a journal of every request. */
async function startServer() {
  const app = express();
  app.use((req, _res, next) => { state.journal.push({ method: req.method, url: req.originalUrl }); next(); });
  app.get('/shared/ui/js/app-view.js', (_req, res, next) => { if (state.kit) next(); else res.status(404).send('Not found'); });
  app.use('/shared/ui', express.static(resolve(ROOT, 'src/shared/ui')));
  app.use('/shared', express.static(resolve(ROOT, 'src/pages/shared'), { index: false, redirect: false }));
  app.use('/cockpit/css/themes', express.static(resolve(ROOT, 'src/pages/cockpit/css/themes')));
  // The per-bot panel imports the cockpit theme catalog (../cockpit/js/theme-manager.js, exports only).
  app.use('/cockpit/js', express.static(resolve(ROOT, 'src/pages/cockpit/js')));
  app.get(PAGE_PATH, (_req, res) => res.sendFile(PAGE_FILE));
  app.use('/config-admin', express.static(PAGE_DIR, { index: false, redirect: false }));
  apiRoutes(app);
  app.get('/fixture/host', (_req, res) => res.type('html').send(`<!DOCTYPE html><html><head><title>Synthetic shell</title></head><body><iframe id="host-frame" src="${PAGE_PATH}?audience=company" style="width:1200px;height:800px"></iframe></body></html>`));
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.use((_req, res) => res.status(404).json({ error: 'not_in_fixture' }));
  const server = await new Promise<Server>((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

let browser: Browser, context: BrowserContext, page: Page, server: Server, origin: string;
const errors: string[] = [];

beforeAll(async () => {
  ({ server, origin } = await startServer());
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
});
beforeEach(async () => {
  resetState();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', locale: 'en-US', serviceWorkers: 'block' });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(String((e && (e as Error).message) || e)));
});
afterEach(async () => { await context?.close(); });

/** @description Journal entries outside the contract: any non-GET, or a GET that is not a page asset (the kit and theme files, the page's own scripts and stylesheet, the shared debug logger, the cockpit theme catalog its module graph imports), the favicon or one of the allowed URLs. */
function offContract(allowed: string[]) {
  const asset = (url: string) => url.startsWith('/shared/ui/') || url.startsWith('/cockpit/css/themes/') || url.startsWith('/config-admin/')
    || url === '/shared/ui-debug.js' || url === '/cockpit/js/theme-manager.js' || url === '/favicon.ico';
  return state.journal.filter((r) => r.method !== 'GET' || !(asset(r.url) || allowed.includes(r.url)));
}
/** @description How many times a URL was read (the card and the full page share the four reads, so a second read means the full page started too). */
const readCount = (url: string) => state.journal.filter((r) => r.method === 'GET' && r.url === url).length;
/** @description Text of the first element matching a selector. */
const text = (selector: string) => page.locator(selector).first().textContent();
/** @description Whether an element exists and is displayed. */
const visible = (selector: string) => page.evaluate((sel) => { const el = document.querySelector(sel) as HTMLElement | null; return !!el && getComputedStyle(el).display !== 'none'; }, selector);
/** @description The card's stat values keyed by data-stat. */
const statValues = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#av-root [data-stat]')).map((n) => [n.getAttribute('data-stat'), n.querySelector('.av-stat-value')?.textContent])));
/** @description The body rows of a table section, as cell texts. */
const rows = (id: string) => page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((tr) => Array.from(tr.children).map((td) => td.textContent)), `#av-root [data-section="${id}"] tbody tr`);

/** @description Open the page with an audience and wait until the card (or its refusal) has painted and the network is quiet. */
async function openView(query: string, ready = '#av-root .av-stat') {
  await page.goto(`${origin}${PAGE_PATH}${query}`);
  await page.waitForSelector(ready);
  await page.waitForLoadState('networkidle');
}

/** @description The fleet switch and bot sections both shells paint from the synthetic reads. */
async function expectFleetAndBots() {
  expect(await rows('fleet')).toEqual([
    ['Fleet default', 'synthetic-provider-a'], ['Model', 'synthetic-model-a'], ['Fallback order', 'synthetic-provider-b → synthetic-provider-c'],
    ['Last changed', '2 h ago by synthetic-operator'], ['Per-bot switch rows stored', '3'], ['Switch snapshot', 'Loaded 3 h ago · 4 rows'],
  ]);
  const bots = await rows('bots');
  expect(bots).toHaveLength(8);
  expect(bots[0]).toEqual(['synthetic-bot-05', 'synthetic-retired-provider', 'Default', 'A switch this build cannot run', 'active']);
  expect(bots[1]).toEqual(['synthetic-bot-03', 'synthetic-provider-b', 'Default', 'Its own switch row', 'active']);
  expect(bots[2]).toEqual(['synthetic-bot-08', 'synthetic-provider-c', 'synthetic-model-c', 'Its own switch row', 'inactive']);
  expect(bots[3]).toEqual(['synthetic-bot-01', 'synthetic-provider-a', 'synthetic-model-a', 'The fleet default', 'active']);
  expect(await text('[data-section="bots"] .av-section-note')).toBe('The first 8 of 10: refused switches first, then bots on their own switch row.');
  expect(await page.locator('[data-section="bots"] tbody tr').first().locator('td').nth(1).getAttribute('class')).toContain('tone-bad');
  expect(await rows('sources')).toEqual([['The fleet default', '5'], ['Its own switch row', '2'], ['A switch this build cannot run', '1'], ['Not reported', '1'], ['The registry harness', '1']]);
}

/** @description The card both shells paint from the four reads: hero, five stats, five sections, the escape, and no address or credential. */
async function expectCard(audience: string) {
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBe(audience);
  expect(await page.locator('#av-root').getAttribute('data-audience')).toBe(audience);
  expect(await text('.av-kicker')).toBe('Engineering · Configuration');
  expect(await text('.av-title')).toBe('1 bot holds a provider switch this build cannot run');
  expect(await statValues()).toEqual({ 'fleet-default': 'synthetic-provider-a', bots: '10', own: '2', refused: '1', rag: 'Configured' });
  expect(await text('[data-stat="fleet-default"] .av-stat-hint')).toBe('synthetic-model-a · changed 2 h ago');
  expect(await text('[data-stat="bots"] .av-stat-hint')).toBe('5 on the fleet default');
  expect(await text('[data-stat="rag"] .av-stat-hint')).toBe('Collection synthetic-collection');
  expect(await page.locator('[data-stat="refused"]').getAttribute('class')).toContain('tone-bad');
  await expectFleetAndBots();
  expect(await rows('shared')).toEqual([
    ['Plan provider', 'synthetic-provider-a'], ['Act provider', 'synthetic-provider-b'], ['Plane URL', 'Set'], ['Redis URL', 'Set'],
    ['Git repository URL', 'Not set'], ['Code-server workspace root', 'Set'], ['Shared API key', 'Set'],
  ]);
  expect(await rows('rag')).toEqual([['Vector store endpoint', 'Set'], ['Default collection', 'synthetic-collection'], ['Embedding', 'synthetic-embedder / synthetic-embedding-model'], ['Chunking', 'Tiered · sizes 1,200 / 700 / 350']]);
  const card = await page.locator('#av-root').textContent();
  for (const hidden of ['synthetic-redis-password', 'synthetic-plane.invalid', 'synthetic-chroma.invalid', '/synthetic/workspace', '[REDACTED]']) expect(card).not.toContain(hidden);
  expect(await text('.av-btn.is-primary')).toBe('Open Configuration');
  expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=oshal-engineering');
  expect(await text('.av-escape-link')).toBe('Open OSHAL Engineering in the cockpit');
}

/** @description The full page stayed hidden and never started: default metrics and banner, no agent cards, each card read made once (by the card) and none of the full page's own reads. */
async function expectFullPageIdle() {
  expect(await visible('.page-shell')).toBe(false);
  expect(await text('#metricAgents')).toBe('0');
  expect(await text('#statusBanner')).toBe('Loading config ownership...');
  expect(await page.locator('#agentList .agent-card').count()).toBe(0);
  for (const url of READS) expect(readCount(url)).toBe(1);
  for (const url of FULL_ONLY) expect(readCount(url)).toBe(0);
}

/** @description The full page started exactly as before: all six load reads once, the metrics, the agent cards, the fleet default panel and the loaded banner. */
async function expectFullPageStarted(query: string) {
  await page.waitForSelector('#statusBanner[data-tone="success"]');
  await page.waitForLoadState('networkidle');
  expect(await page.locator('#av-root').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBeNull();
  expect(await visible('.page-shell')).toBe(true);
  expect(await text('#statusBanner')).toBe('Config admin loaded from mounted OSHAL APIs.');
  expect([await text('#metricSharedRoutes'), await text('#metricProviders'), await text('#metricAgents'), await text('#metricLegacyRoutes')]).toEqual(['2', '3', '10', '1']);
  expect(await page.locator('#agentList .agent-card').count()).toBe(10);
  expect(await text('#fleetDefaultStatus')).toContain('Fleet default: synthetic-provider-a / synthetic-model-a');
  for (const url of [...READS, ...FULL_ONLY]) expect(readCount(url)).toBe(1);
  expect(offContract([`${PAGE_PATH}${query}`, ...READS, ...FULL_ONLY])).toEqual([]);
}

describe('Configuration (oshal-engineering) audience view (ADR-164 D6)', () => {
  it('loads the kit right after the theme bootstrap and builds the card without innerHTML or a write', () => {
    const html = readFileSync(PAGE_FILE, 'utf8');
    const theme = html.indexOf('<script src="/shared/ui/js/surface-theme.js"></script>');
    expect(theme).toBeGreaterThan(-1);
    const after = html.slice(theme).split('\n').slice(1, 4).join('\n');
    expect(after).toContain('<link rel="stylesheet" href="/shared/ui/css/app-view.css" />');
    expect(after).toContain('<script src="/shared/ui/js/app-view.js"></script>');
    const block = html.slice(html.indexOf('/* Audience view (ADR-164 D6).'), html.indexOf("A.boot({ app: 'oshal-engineering'"));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toContain('innerHTML');
    expect(block).not.toMatch(/method\s*:/);
    const script = readFileSync(resolve(PAGE_DIR, 'config-admin.js'), 'utf8');
    expect(script).toContain('if (!window.AppView || !AppView.active()) {\n  app.init()');
  });

  it('company view paints the card from the four reads, writes nothing, reads nothing else, and keeps the full page hidden and unstarted', async () => {
    await openView('?audience=company');
    await expectCard('company');
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    await expectFullPageIdle();
    expect(errors).toEqual([]);
  });

  it('family view paints the same card', async () => {
    await openView('?audience=family');
    await expectCard('family');
    expect(offContract([`${PAGE_PATH}?audience=family`, ...READS])).toEqual([]);
    await expectFullPageIdle();
    expect(errors).toEqual([]);
  });

  const REFUSALS: Array<{ kind: string; answer?: Answer; network?: boolean; said: string }> = [
    { kind: '401 signed-out', answer: { status: 401, body: { authenticated: false, error: 'unauthorized', loginPath: '/login' } }, said: 'Nothing could be read: this session is not signed in (HTTP 401).' },
    { kind: '403 operator-gate', answer: { status: 403, body: { error: 'Operator privilege required' } }, said: 'Nothing could be read: it is open to operators only (HTTP 403).' },
    { kind: '403 other refusal', answer: { status: 403, body: { error: 'synthetic forbidden' } }, said: 'Nothing could be read: this account was refused (HTTP 403).' },
    { kind: '404 not-found', answer: { status: 404, raw: 'Not found' }, said: 'Nothing could be read: this core does not offer it (HTTP 404).' },
    { kind: '5xx server-error', answer: { status: 500, body: { success: false, error: 'synthetic database failure' } }, said: 'Nothing could be read: the server failed to answer (HTTP 500).' },
    { kind: 'network failure', network: true, said: 'Nothing could be read: the server could not be reached (network failure).' },
    { kind: 'malformed JSON', answer: { status: 200, raw: '{"agents": ' }, said: 'Nothing could be read: the answer was not JSON.' },
    { kind: 'unreadable shape', answer: { status: 200, body: { success: true, agents: 'none', config: [], fleetDefault: 'synthetic' } }, said: 'Nothing could be read: the answer was not in a shape this view can read.' },
  ];

  it.each(REFUSALS)('says a $kind refusal in the card with no stat in its place', async ({ answer, network, said }) => {
    if (answer) answerAll(answer);
    if (network) await page.route((url) => READS.includes(url.pathname), (route) => route.abort('failed'));
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-title')).toBe('Configuration could not be read');
    expect(await text('.av-lede')).toBe(said);
    expect(await page.locator('#av-root .av-stat').count()).toBe(0);
    expect(await page.locator('#av-root [data-section]').count()).toBe(0);
    expect(await page.locator('#av-root').textContent()).not.toContain('synthetic database failure');
    expect(await page.locator('.av-btn', { hasText: 'Try again' }).count()).toBe(1);
    expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=oshal-engineering');
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    expect(await visible('.page-shell')).toBe(false);
    expect(await text('#statusBanner')).toBe('Loading config ownership...');
    expect(errors).toEqual([]);
  });

  it('says each read its own refusal when nothing answered and the reasons differ', async () => {
    state.answers = { switch: { status: 403, body: { error: 'Operator privilege required' } }, agents: { status: 502, body: { error: 'synthetic upstream' } }, config: { status: 404, raw: 'Not found' }, rag: { status: 200, raw: '<html>' } };
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe('The fleet provider switch could not be read: it is open to operators only (HTTP 403). The bot list could not be read: the server failed to answer (HTTP 502). The shared settings could not be read: this core does not offer it (HTTP 404). The RAG runtime settings could not be read: the answer was not JSON.');
    expect(await page.locator('#av-root .av-stat').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('paints the bot figures and says the operator gate in place of the fleet switch, shared settings and RAG runtime', async () => {
    const gate: Answer = { status: 403, body: { error: 'Operator privilege required' } };
    state.answers.switch = gate; state.answers.config = gate; state.answers.rag = gate;
    await openView('?audience=company');
    expect(await text('.av-title')).toBe('1 bot holds a provider switch this build cannot run');
    expect(await statValues()).toEqual({ bots: '10', own: '2', refused: '1' });
    expect((await rows('bots'))[0][0]).toBe('synthetic-bot-05');
    expect(await text('[data-section="fleet"] .av-empty')).toBe('The fleet provider switch could not be read: it is open to operators only (HTTP 403).');
    expect(await text('[data-section="shared"] .av-empty')).toBe('The shared settings could not be read: it is open to operators only (HTTP 403).');
    expect(await text('[data-section="rag"] .av-empty')).toBe('The RAG runtime settings could not be read: it is open to operators only (HTTP 403).');
    expect(await page.locator('[data-section="fleet"] tbody tr').count()).toBe(0);
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('paints the figures once refused reads answer and the reader tries again', async () => {
    answerAll({ status: 503, body: { success: false, error: 'synthetic outage' } });
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe('Nothing could be read: the server failed to answer (HTTP 503).');
    resetState();
    await page.locator('.av-btn', { hasText: 'Try again' }).click();
    await page.waitForSelector('#av-root .av-stat');
    expect((await statValues()).bots).toBe('10');
    expect(await text('.av-title')).toBe('1 bot holds a provider switch this build cannot run');
    expect(errors).toEqual([]);
  });

  it('the primary action leaves the view for the full page in the same frame', async () => {
    await page.goto(`${origin}/fixture/host`);
    const frame = page.frameLocator('#host-frame');
    await frame.locator('#av-root .av-stat').first().waitFor();
    const framed = page.frames().find((f) => f.url().includes(`${PAGE_PATH}?audience=company`));
    expect(framed).toBeTruthy();
    await frame.locator('.av-btn.is-primary').click();
    await frame.locator('#statusBanner[data-tone="success"]').waitFor();
    await page.waitForLoadState('networkidle');
    const at = new URL(framed!.url());
    expect(at.pathname + at.search).toBe(PAGE_PATH);
    expect(new URL(page.url()).pathname).toBe('/fixture/host');
    expect(await frame.locator('#av-root').count()).toBe(0);
    expect(await frame.locator('#metricAgents').textContent()).toBe('10');
    expect(await frame.locator('#agentList .agent-card').count()).toBe(10);
    expect(offContract(['/fixture/host', `${PAGE_PATH}?audience=company`, PAGE_PATH, ...READS, ...FULL_ONLY])).toEqual([]);
    // Once by the card, once by the full page it opened; the full page's own two reads once.
    for (const url of READS) expect(readCount(url)).toBe(2);
    for (const url of FULL_ONLY) expect(readCount(url)).toBe(1);
    expect(errors).toEqual([]);
  });

  it.each([
    { name: 'without an audience', query: '', kit: true },
    { name: 'with ?audience=classroom, which this page does not provide', query: '?audience=classroom', kit: true },
    { name: 'on a core without the kit', query: '?audience=company', kit: false },
  ])('starts the full page exactly as before $name', async ({ query, kit }) => {
    state.kit = kit;
    await page.goto(`${origin}${PAGE_PATH}${query}`);
    await expectFullPageStarted(query);
    expect(errors).toEqual([]);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bot Forge (codex-packer) audience view (ADR-164 D6) in headless Chromium over one loopback server: the real src/api/forge.html at its real route (/api/forge), /shared/ui from source (the kit and the surface-bridge client the page imports), synthetic answers for exactly the two GETs the full page makes on load (/api/swarm/apps?status=active and /api/swarm/apps/pending) and a journal of every request. The company and family views paint the same card from those reads (title, stats, sections by id, escape) with no write, no other read, the full page hidden and unstarted and the surface bridge unwired; every refusal kind (401, 403, 404, 5xx, network failure, malformed JSON, an unreadable shape) is said with no stat; a refused pending read is said in its own section while the live figures paint; an empty swarm reads as zeros, not a failure; the primary action leaves the view for the full page in the same frame; without an audience, with ?audience=classroom and on a core without the kit, the full page starts exactly as before.
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
const DAY = 24 * HOUR;
const PAGE_FILE = resolve(ROOT, 'src/api/forge.html');
const PAGE_PATH = '/api/forge';
const APPS_READ = '/api/swarm/apps?status=active';
const PENDING_READ = '/api/swarm/apps/pending';
const READS = [APPS_READ, PENDING_READ];
/** @description An ISO timestamp offsetMs from now, so synthetic loadedAt/updatedAt values sit at known distances from the reader's clock. */
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Answer = { status: number; body?: unknown; raw?: string };
interface Journaled { method: string; url: string }

/** @description One active-app summary shaped like SwarmApplicationSummary (swarm-app-service toSummary), every value synthetic. */
function syntheticApp(slug: string, extra: Record<string, unknown>) {
  return {
    name: `synthetic-${slug}`, displayName: `Synthetic ${slug.charAt(0).toUpperCase()}${slug.slice(1)}`, description: `Synthetic ${slug} description.`,
    version: '1.0.0', status: 'active', botCount: 1, toolCount: 1, icon: null, hasSurface: true, suite: 'ai-engineering',
    connectors: { required: [], optional: [] }, manifestPath: `/synthetic/swarm-apps/${slug}.yaml`, loadedAt: iso(-DAY), updatedAt: iso(-HOUR),
    queueId: `synthetic-${slug}`, ticketType: null, scope: 'public', ownerSub: null, tenantId: null, ...extra,
  };
}

/** @description The GET /api/swarm/apps?status=active answer: four synthetic live applications across two shelves and one unshelved. */
function syntheticApps() {
  return {
    apps: [
      syntheticApp('alpha', { botCount: 2, toolCount: 3, loadedAt: iso(-3 * DAY) }),
      syntheticApp('beta', { botCount: 1, toolCount: 0, suite: 'ai-productivity', hasSurface: false, loadedAt: iso(-2 * HOUR) }),
      syntheticApp('gamma', { botCount: 3, toolCount: 4, loadedAt: iso(-10 * DAY) }),
      syntheticApp('delta', { botCount: null, toolCount: 1, suite: null, loadedAt: iso(-12 * DAY) }),
    ],
  };
}

/** @description The GET /api/swarm/apps/pending answer: two synthetic manifests on disk, the second with no display name or description. */
function syntheticPending() {
  return {
    pending: [
      { name: 'synthetic-pending-one', displayName: 'Synthetic Pending One', description: 'Synthetic pending description.', path: '/synthetic/deployed-apps/one.yaml' },
      { name: 'synthetic-pending-two', displayName: '', description: '', path: '/synthetic/deployed-apps/two.yaml' },
    ],
  };
}

const state = { apps: { status: 200 } as Answer, pending: { status: 200 } as Answer, kit: true, journal: [] as Journaled[] };

/** @description Fresh synthetic answers, the kit served, an empty journal: every case starts from the same swarm. */
function resetState() {
  state.apps = { status: 200, body: syntheticApps() };
  state.pending = { status: 200, body: syntheticPending() };
  state.kit = true;
  state.journal = [];
}

/** @description Answer one read from the case's scripted state (a raw body is sent as-is under a JSON content type). */
function send(res: Response, answer: Answer) {
  if (answer.raw !== undefined) { res.status(answer.status).type('application/json').send(answer.raw); return; }
  res.status(answer.status).json(answer.body ?? {});
}

/** @description One loopback server: the real page at its real route, /shared/ui and the imported cockpit theme files from source, the two synthetic reads, a framing host and a journal of every request. */
async function startServer() {
  const app = express();
  app.use((req, _res, next) => { state.journal.push({ method: req.method, url: req.originalUrl }); next(); });
  app.get('/shared/ui/js/app-view.js', (_req, res, next) => { if (state.kit) next(); else res.status(404).send('Not found'); });
  app.use('/shared/ui', express.static(resolve(ROOT, 'src/shared/ui')));
  app.use('/cockpit/css/themes', express.static(resolve(ROOT, 'src/pages/cockpit/css/themes')));
  app.get(PAGE_PATH, (_req, res) => res.sendFile(PAGE_FILE));
  app.get('/api/swarm/apps/pending', (_req, res) => send(res, state.pending));
  app.get('/api/swarm/apps', (_req, res) => send(res, state.apps));
  app.get('/fixture/host', (_req, res) => res.type('html').send(`<!DOCTYPE html><html><head><title>Synthetic shell</title></head><body><iframe id="host-frame" src="${PAGE_PATH}?audience=company" style="width:1200px;height:800px"></iframe></body></html>`));
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.use((_req, res) => res.status(404).json({ error: 'not_in_fixture' }));
  const server = await new Promise<Server>(ok => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
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
  await new Promise<void>(ok => (server ? server.close(() => ok()) : ok()));
});
beforeEach(async () => {
  resetState();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  errors.length = 0;
  page.on('pageerror', e => errors.push(String((e && (e as Error).message) || e)));
});
afterEach(async () => { await context?.close(); });

/** @description Journal entries outside the contract: any non-GET, or a GET that is not a page asset (/shared/ui, the theme files surface-themes.css imports), the favicon or one of the allowed URLs. */
function offContract(allowed: string[]) {
  return state.journal.filter(r => r.method !== 'GET' || !(r.url.startsWith('/shared/ui/') || r.url.startsWith('/cockpit/css/themes/') || r.url === '/favicon.ico' || allowed.includes(r.url)));
}
/** @description How many times a URL was read (the card and the full page share both reads, so a second read means the full page started too). */
const readCount = (url: string) => state.journal.filter(r => r.method === 'GET' && r.url === url).length;
/** @description Text of the first element matching a selector. */
const text = (selector: string) => page.locator(selector).first().textContent();
/** @description Whether an element exists and is displayed. */
const visible = (selector: string) => page.evaluate(sel => { const el = document.querySelector(sel) as HTMLElement | null; return !!el && getComputedStyle(el).display !== 'none'; }, selector);
/** @description The card's stat values keyed by data-stat. */
const statValues = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#av-root [data-stat]')).map(n => [n.getAttribute('data-stat'), n.querySelector('.av-stat-value')?.textContent])));
/** @description The body rows of a table section, as cell texts. */
const rows = (id: string) => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(tr => Array.from(tr.children).map(td => td.textContent)), `[data-section="${id}"] tbody tr`);
/** @description The item titles of a list section, in order. */
const titles = (id: string) => page.locator(`[data-section="${id}"] .av-item .av-item-title`).allTextContents();

/** @description Open the page with an audience and wait until the card (or its refusal) has painted and the network is quiet. */
async function openView(query: string, ready = '#av-root .av-stat') {
  await page.goto(`${origin}${PAGE_PATH}${query}`);
  await page.waitForSelector(ready);
  await page.waitForLoadState('networkidle');
}

/** @description The card both shells paint from the synthetic reads: hero, five stats, three sections, the escape. */
async function expectCard(audience: string) {
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBe(audience);
  expect(await page.locator('#av-root').getAttribute('data-audience')).toBe(audience);
  expect(await text('.av-kicker')).toBe('Live swarm injection');
  expect(await text('.av-title')).toBe('Bot Forge');
  expect(await statValues()).toEqual({ live: '4', bots: '6', tools: '8', newest: '2 h ago', pending: '2' });
  expect(await text('[data-stat="live"] .av-stat-hint')).toBe('3 with a cockpit surface');
  expect(await text('[data-stat="newest"] .av-stat-hint')).toBe('Synthetic Beta');
  expect(await page.locator('[data-stat="pending"]').getAttribute('class')).toContain('tone-warn');
  expect(await titles('pending')).toEqual(['Synthetic Pending One', 'synthetic-pending-two']);
  expect(await page.locator('[data-section="pending"] .av-item-text').allTextContents()).toEqual(['Synthetic pending description.', 'Authored by the Forge, not yet live.']);
  expect(await titles('newest')).toEqual(['Synthetic Beta', 'Synthetic Alpha', 'Synthetic Gamma', 'Synthetic Delta']);
  expect(await page.locator('[data-section="newest"] .av-meta').allTextContents()).toEqual([
    '1 bot · 0 tools · injected 2 h ago', '2 bots · 3 tools · injected 3 days ago', '3 bots · 4 tools · injected 10 days ago', '0 bots · 1 tool · injected 12 days ago',
  ]);
  expect(await page.locator('[data-section="newest"] .av-item').first().locator('.av-badge').textContent()).toBe('Productivity');
  expect(await page.locator('[data-section="newest"] .av-item').last().locator('.av-badge').count()).toBe(0);
  expect(await rows('shelves')).toEqual([['Engineering', '2', '5'], ['Productivity', '1', '1'], ['No shelf', '1', '0']]);
  expect(await page.locator('#av-root').textContent()).not.toContain('/synthetic/');
  expect(await text('.av-btn.is-primary')).toBe('Open Bot Forge');
  expect(await text('.av-escape-link')).toBe('Open Bot Forge in the cockpit');
  expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=codex-packer');
}

/** @description The full page stayed hidden and never started: no gallery, no tray, no bridge, each read made once (by the card). */
async function expectFullPageIdle() {
  expect(await visible('.wrap')).toBe(false);
  expect(await page.locator('#grid .card, #grid .empty').count()).toBe(0);
  expect(await text('#count')).toBe('');
  expect(await page.locator('#pgrid .card').count()).toBe(0);
  expect(await page.evaluate(() => typeof (window as unknown as { __forgeBridge?: unknown }).__forgeBridge)).toBe('undefined');
  for (const url of READS) expect(readCount(url)).toBe(1);
}

describe('Bot Forge audience view (ADR-164 D6)', () => {
  it('loads the kit right after the theme bootstrap and builds the card without innerHTML or a write', () => {
    const html = readFileSync(PAGE_FILE, 'utf8');
    const theme = html.indexOf('<script src="/shared/ui/js/surface-theme.js"></script>');
    expect(theme).toBeGreaterThan(-1);
    const after = html.slice(theme).split('\n').slice(1, 4).join('\n');
    expect(after).toContain('<link rel="stylesheet" href="/shared/ui/css/app-view.css" />');
    expect(after).toContain('<script src="/shared/ui/js/app-view.js"></script>');
    const block = html.slice(html.indexOf('/* Audience view (ADR-164 D6).'), html.indexOf("A.boot({ app: 'codex-packer'"));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toContain('innerHTML');
    expect(block).not.toMatch(/method\s*:/);
  });

  it('company view paints the card from the two reads, writes nothing, reads nothing else, and keeps the full page hidden and unstarted', async () => {
    await openView('?audience=company');
    await expectCard('company');
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    await expectFullPageIdle();
    // A relayed packer `custom` refresh reaches no listener: the bridge never wired, so the trays are not re-polled.
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('surface-bridge:custom', { detail: { name: 'refresh' } })));
    await page.waitForLoadState('networkidle');
    for (const url of READS) expect(readCount(url)).toBe(1);
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
    { kind: '401 signed-out', answer: { status: 401, body: { authenticated: false, error: 'unauthorized', loginPath: '/login' } }, said: 'You are not signed in (HTTP 401). Sign in, then open the Bot Forge again.' },
    { kind: '403 refused', answer: { status: 403, body: { error: 'Operator privilege required' } }, said: 'This account is not allowed to read the live swarm (HTTP 403).' },
    { kind: '404 not-found', answer: { status: 404, raw: 'Not found' }, said: 'The live swarm did not answer on this core (HTTP 404).' },
    { kind: '5xx server-error', answer: { status: 500, body: { error: 'synthetic database failure' } }, said: 'The live swarm failed to answer (HTTP 500).' },
    { kind: 'network failure', network: true, said: 'The live swarm could not be reached (network failure).' },
    { kind: 'malformed JSON', answer: { status: 200, raw: '{"apps": ' }, said: 'The live swarm answered with something that is not JSON.' },
    { kind: 'unreadable shape', answer: { status: 200, body: { apps: 'none', pending: {} } }, said: 'The live swarm answered in a shape this view cannot read.' },
  ];

  it.each(REFUSALS)('says a $kind refusal in the card with no stat in its place', async ({ answer, network, said }) => {
    if (answer) { state.apps = answer; state.pending = answer; }
    if (network) await page.route(url => url.pathname.startsWith('/api/swarm/apps'), route => route.abort('failed'));
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe(said);
    expect(await page.locator('#av-root .av-stat').count()).toBe(0);
    expect(await page.locator('#av-root [data-section]').count()).toBe(0);
    expect(await page.locator('#av-root').textContent()).not.toContain('synthetic database failure');
    expect(await page.locator('.av-btn', { hasText: 'Try again' }).count()).toBe(1);
    expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=codex-packer');
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    expect(await visible('.wrap')).toBe(false);
    expect(await page.locator('#grid .card, #grid .empty').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('paints the figures once a refused read answers and the reader tries again', async () => {
    state.apps = { status: 503, body: { error: 'synthetic outage' } };
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe('The live swarm failed to answer (HTTP 503).');
    state.apps = { status: 200, body: syntheticApps() };
    await page.locator('.av-btn', { hasText: 'Try again' }).click();
    await page.waitForSelector('#av-root .av-stat');
    expect((await statValues()).live).toBe('4');
    expect(errors).toEqual([]);
  });

  it('says a refused pending read in its own section, with no pending figure, while the live figures still paint', async () => {
    state.pending = { status: 500, body: { error: 'synthetic pending failure' } };
    await openView('?audience=company');
    expect(await statValues()).toEqual({ live: '4', bots: '6', tools: '8', newest: '2 h ago' });
    expect(await page.locator('[data-section="pending"] .av-item').count()).toBe(0);
    expect(await text('[data-section="pending"] .av-empty')).toBe('Bots waiting to be injected could not be read. The live swarm failed to answer (HTTP 500).');
    expect(await titles('newest')).toEqual(['Synthetic Beta', 'Synthetic Alpha', 'Synthetic Gamma', 'Synthetic Delta']);
    expect(await page.locator('#av-root').textContent()).not.toContain('synthetic pending failure');
    expect(errors).toEqual([]);
  });

  it('reads an empty swarm as zeros and says there is nothing yet, not a failure', async () => {
    state.apps = { status: 200, body: { apps: [] } };
    state.pending = { status: 200, body: { pending: [] } };
    await openView('?audience=family');
    expect(await statValues()).toEqual({ live: '0', bots: '0', tools: '0', newest: 'None yet', pending: '0' });
    expect(await text('[data-stat="newest"] .av-stat-hint')).toBe('Nothing is live yet.');
    expect(await text('[data-section="pending"] .av-empty')).toBe('Nothing is waiting to be injected.');
    expect(await text('[data-section="newest"] .av-empty')).toBe('No bots are live in the swarm yet.');
    expect(await text('[data-section="shelves"] .av-empty')).toBe('No bots are live in the swarm yet.');
    expect(await page.locator('.av-btn', { hasText: 'Try again' }).count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('the primary action leaves the view for the full page in the same frame', async () => {
    await page.goto(`${origin}/fixture/host`);
    const frame = page.frameLocator('#host-frame');
    await frame.locator('#av-root .av-stat').first().waitFor();
    const framed = page.frames().find(f => f.url().includes(`${PAGE_PATH}?audience=company`));
    expect(framed).toBeTruthy();
    await frame.locator('.av-btn.is-primary').click();
    await frame.locator('#grid .card').first().waitFor();
    await frame.locator('#pgrid .card').first().waitFor();
    const at = new URL(framed!.url());
    expect(at.pathname + at.search).toBe(PAGE_PATH);
    expect(new URL(page.url()).pathname).toBe('/fixture/host');
    expect(await frame.locator('#av-root').count()).toBe(0);
    expect(await frame.locator('#grid .card').count()).toBe(4);
    expect(await frame.locator('#count').textContent()).toBe('4 active');
    expect(await frame.locator('#pgrid .card').count()).toBe(2);
    expect(offContract(['/fixture/host', `${PAGE_PATH}?audience=company`, PAGE_PATH, ...READS])).toEqual([]);
    // Once by the card, once by the full page it opened.
    for (const url of READS) expect(readCount(url)).toBe(2);
    expect(errors).toEqual([]);
  });

  it.each([
    { name: 'without an audience', query: '', kit: true },
    { name: 'with ?audience=classroom, which this page does not provide', query: '?audience=classroom', kit: true },
    { name: 'on a core without the kit', query: '?audience=company', kit: false },
  ])('starts the full page exactly as before $name', async ({ query, kit }) => {
    state.kit = kit;
    await page.goto(`${origin}${PAGE_PATH}${query}`);
    await page.locator('#grid .card').first().waitFor();
    await page.locator('#pgrid .card').first().waitFor();
    await page.waitForFunction(() => typeof (window as unknown as { __forgeBridge?: unknown }).__forgeBridge === 'object');
    await page.waitForLoadState('networkidle');
    expect(await page.locator('#av-root').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBeNull();
    expect(await visible('.wrap')).toBe(true);
    expect(await page.locator('#grid .card').count()).toBe(4);
    expect(await text('#count')).toBe('4 active');
    expect(await text('#grid .card h3')).toBe('Synthetic Alpha');
    expect(await visible('#pendingWrap')).toBe(true);
    expect(await text('#pcount')).toBe('2 waiting');
    expect(await page.locator('#pgrid .card').count()).toBe(2);
    for (const url of READS) expect(readCount(url)).toBe(1);
    expect(offContract([`${PAGE_PATH}${query}`, ...READS])).toEqual([]);
    expect(errors).toEqual([]);
  });
});

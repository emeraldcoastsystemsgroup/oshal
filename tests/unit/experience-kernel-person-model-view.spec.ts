/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ambient Recall (person-model) audience view (ADR-164 D6) in headless Chromium over one loopback server: the real src/api/person-model.html at its real route (/api/jarvis/ambient/person/), /shared/ui from source, synthetic answers for exactly the four GETs the card reads (/people, /asks, /projection, /trends?weeks=2, all GETs the full page itself makes) and a journal of every request. The company and family views paint the same card from those reads (title, stats, sections by id, escape) with no write, no other read, and the full page hidden and unstarted; an empty caller paints zeros from the answers; every refusal kind (401, 403, 404, 5xx, network failure, malformed JSON, an unreadable shape) is said with no stat; a refused secondary read is said in its own place; the primary action leaves the view for the full page in the same frame; without an audience, with ?audience=classroom and on a core without the kit, the full page starts exactly as before.
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
const PAGE_FILE = resolve(ROOT, 'src/api/person-model.html');
const PAGE_PATH = '/api/jarvis/ambient/person/';
const API = '/api/jarvis/ambient/person';
const READS = [`${API}/people`, `${API}/asks`, `${API}/projection`, `${API}/trends?weeks=2`];
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Answer = { status: number; body?: unknown; raw?: string };
interface Journaled { method: string; url: string }

/** @description The GET /people answer shaped like listHeardPeople (most recently heard first), every voice explicitly synthetic. */
function syntheticPeople() {
  return {
    people: [
      { profileId: 'synthetic-profile-1', label: 'Synthetic Ella', isSelf: false, utterances: 120, firstHeardAt: iso(-20 * DAY), lastHeardAt: iso(-2 * HOUR) },
      { profileId: 'synthetic-profile-2', label: 'Synthetic Owner', isSelf: true, utterances: 300, firstHeardAt: state.firstHeard, lastHeardAt: iso(-3 * HOUR) },
      { profileId: 'synthetic-profile-3', label: 'Synthetic Sam', isSelf: false, utterances: 1, firstHeardAt: iso(-5 * DAY), lastHeardAt: iso(-5 * DAY) },
      { profileId: 'synthetic-profile-4', label: 'Unidentified Person 1', isSelf: false, utterances: 0, firstHeardAt: null, lastHeardAt: null },
    ],
  };
}

/** @description The GET /asks answer shaped like getOpenAsks (newest first), each beside its synthetic source quote. */
function syntheticAsks() {
  const ask = (n: number, kind: string, personLabel: string, ageMs: number, text: string) => ({
    askId: `synthetic-ask-${n}`, kind, text, sourceQuote: `Synthetic quote ${n}`, status: 'open', personLabel, createdAt: iso(-ageMs), isInference: true,
  });
  return {
    asks: [
      ask(1, 'ask', 'Synthetic Ella', 2 * HOUR, 'Synthetic ask: sign the permission slip'),
      ask(2, 'commitment', 'Synthetic Sam', 26 * HOUR, 'Synthetic commitment: call back'),
      ask(3, 'ask', 'Synthetic Ella', 3 * DAY, 'Synthetic ask: bring the kneepads'),
    ],
  };
}

/** @description The GET /projection answer: the semantic leg on, the synthetic owner's projection lagging canon. */
function syntheticProjection() {
  return { semanticAvailable: true, ledger: { ownerSub: 'synthetic-owner-sub', canonRows: 421, projectedRows: 400, watermarkCapturedAt: iso(-3 * HOUR), lastRebuildAt: null, status: 'lagging' } };
}

/** @description The GET /trends?weeks=2 answer shaped like weeklyTopicTrends for anyone, newest week first. */
function syntheticTrends() {
  const row = (weekStart: string, topic: string, mentions: number, personLabel: string) => ({ weekStart, topic, mentions, personLabel });
  return {
    personLabel: 'Anyone', personResolved: true, weeks: 2,
    rows: [
      row('2026-09-21', 'volleyball', 5, 'Synthetic Ella'), row('2026-09-21', 'school trip', 3, 'Synthetic Sam'),
      row('2026-09-14', 'volleyball', 4, 'Synthetic Ella'), row('2026-09-14', 'volleyball', 2, 'Synthetic Owner'),
      row('2026-09-14', 'groceries', 3, 'Synthetic Owner'),
    ],
  };
}

const state = {
  people: { status: 200 } as Answer, asks: { status: 200 } as Answer, projection: { status: 200 } as Answer, trends: { status: 200 } as Answer,
  kit: true, journal: [] as Journaled[], firstHeard: '',
};

/** @description Fresh synthetic answers, the kit served, an empty journal: every case starts from the same swarm. */
function resetState() {
  state.firstHeard = iso(-30 * DAY);
  state.people = { status: 200, body: syntheticPeople() };
  state.asks = { status: 200, body: syntheticAsks() };
  state.projection = { status: 200, body: syntheticProjection() };
  state.trends = { status: 200, body: syntheticTrends() };
  state.kit = true;
  state.journal = [];
}

/** @description Answer one read from the case's scripted state (a raw body is sent as-is under a JSON content type). */
function send(res: Response, answer: Answer) {
  if (answer.raw !== undefined) { res.status(answer.status).type('application/json').send(answer.raw); return; }
  res.status(answer.status).json(answer.body ?? {});
}

/** @description One loopback server: the real page at its real route, /shared/ui and the imported cockpit theme files from source, the four synthetic reads, a framing host and a journal of every request. */
async function startServer() {
  const app = express();
  app.use((req, _res, next) => { state.journal.push({ method: req.method, url: req.originalUrl }); next(); });
  app.get('/shared/ui/js/app-view.js', (_req, res, next) => { if (state.kit) next(); else res.status(404).send('Not found'); });
  app.use('/shared/ui', express.static(resolve(ROOT, 'src/shared/ui')));
  app.use('/cockpit/css/themes', express.static(resolve(ROOT, 'src/pages/cockpit/css/themes')));
  app.get(PAGE_PATH, (_req, res) => res.sendFile(PAGE_FILE));
  app.get(`${API}/people`, (_req, res) => send(res, state.people));
  app.get(`${API}/asks`, (_req, res) => send(res, state.asks));
  app.get(`${API}/projection`, (_req, res) => send(res, state.projection));
  app.get(`${API}/trends`, (_req, res) => send(res, state.trends));
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

/** @description Journal entries outside the contract: any non-GET, or a GET that is not a page asset (the kit, the theme files surface-themes.css imports), the favicon or one of the allowed URLs. */
function offContract(allowed: string[]) {
  return state.journal.filter(r => r.method !== 'GET' || !(r.url.startsWith('/shared/ui/') || r.url.startsWith('/cockpit/css/themes/') || r.url === '/favicon.ico' || allowed.includes(r.url)));
}
/** @description How many times a URL was read (the card and the full page share /projection, so a second read means the full page started too). */
const readCount = (url: string) => state.journal.filter(r => r.method === 'GET' && r.url === url).length;
/** @description Text of the first element matching a selector. */
const text = (selector: string) => page.locator(selector).first().textContent();
/** @description Whether an element exists and is displayed. */
const visible = (selector: string) => page.evaluate(sel => { const el = document.querySelector(sel) as HTMLElement | null; return !!el && getComputedStyle(el).display !== 'none'; }, selector);
/** @description The card's stat values keyed by data-stat. */
const statValues = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#av-root [data-stat]')).map(n => [n.getAttribute('data-stat'), n.querySelector('.av-stat-value')?.textContent])));
/** @description The body rows of a table section, as cell texts. */
const rows = (id: string) => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(tr => Array.from(tr.children).map(td => td.textContent)), `[data-section="${id}"] tbody tr`);
/** @description The items of a list section as { title, text, meta, badge } (null where a part is absent). */
const items = (id: string) => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(li => ({
  title: li.querySelector('.av-item-title')?.textContent ?? null, text: li.querySelector('.av-item-text')?.textContent ?? null,
  meta: li.querySelector('.av-meta')?.textContent ?? null, badge: li.querySelector('.av-badge')?.textContent ?? null,
})), `[data-section="${id}"] .av-item`);

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
  expect(await text('.av-title')).toBe('Ambient Recall');
  expect(await statValues()).toEqual({ voices: '4', lines: '421', 'last-heard': '2 h ago', asks: '3', semantic: 'On' });
  const since = await page.evaluate(v => (window as unknown as { AppView: { date: (x: string) => string } }).AppView.date(v), state.firstHeard);
  expect(await text('[data-stat="voices"] .av-stat-hint')).toBe(`Since ${since}`);
  expect(await text('[data-stat="last-heard"] .av-stat-hint')).toBe('Synthetic Ella');
  expect(await text('[data-stat="asks"] .av-stat-hint')).toBe('2 asks · 1 commitment');
  expect(await text('[data-stat="semantic"] .av-stat-hint')).toBe('Projected 400 of 421 lines (lagging)');
  expect(await text('[data-section="voices"] .av-section-title')).toBe('Voices heard');
  expect(await items('voices')).toEqual([
    { title: 'Synthetic Ella', text: '120 lines', meta: 'Last heard 2 h ago', badge: null },
    { title: 'Synthetic Owner', text: '300 lines', meta: 'Last heard 3 h ago', badge: 'you' },
    { title: 'Synthetic Sam', text: '1 line', meta: 'Last heard 5 days ago', badge: null },
    { title: 'Unidentified Person 1', text: '0 lines', meta: 'Not heard yet', badge: null },
  ]);
  expect(await text('[data-section="asks"] .av-section-title')).toBe('Open asks and commitments');
  expect(await items('asks')).toEqual([
    { title: 'Synthetic ask: sign the permission slip', text: 'Heard as: “Synthetic quote 1”', meta: 'Synthetic Ella · 2 h ago', badge: 'Ask' },
    { title: 'Synthetic commitment: call back', text: 'Heard as: “Synthetic quote 2”', meta: 'Synthetic Sam · yesterday', badge: 'Commitment' },
    { title: 'Synthetic ask: bring the kneepads', text: 'Heard as: “Synthetic quote 3”', meta: 'Synthetic Ella · 3 days ago', badge: 'Ask' },
  ]);
  expect(await text('[data-section="topics"] .av-section-title')).toBe('Topics, last 2 weeks');
  expect(await rows('topics')).toEqual([['volleyball', 'Synthetic Ella, Synthetic Owner', '11'], ['groceries', 'Synthetic Owner', '3'], ['school trip', 'Synthetic Sam', '3']]);
  const card = await page.locator('#av-root').textContent();
  expect(card).not.toContain('synthetic-owner-sub');
  expect(card).not.toContain('synthetic-profile-');
  expect(await text('.av-btn.is-primary')).toBe('Open Ambient Recall');
  expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=person-model');
}

/** @description The full page stayed hidden and never started: no status line, no tab rewrite of the URL, each read made once (by the card). */
async function expectFullPageIdle(query: string) {
  expect(await visible('.wrap')).toBe(false);
  expect(await text('#status')).toBe('');
  expect(await page.evaluate(() => window.location.search)).toBe(query);
  for (const url of READS) expect(readCount(url)).toBe(1);
}

describe('Ambient Recall (person-model) audience view (ADR-164 D6)', () => {
  it('loads the kit right after the theme bootstrap, builds the card without innerHTML and gates the full page boot', () => {
    const html = readFileSync(PAGE_FILE, 'utf8');
    const theme = html.indexOf('<script src="/shared/ui/js/surface-theme.js"></script>');
    expect(theme).toBeGreaterThan(-1);
    const after = html.slice(theme).split('\n').slice(1, 4).join('\n');
    expect(after).toContain('<link rel="stylesheet" href="/shared/ui/css/app-view.css" />');
    expect(after).toContain('<script src="/shared/ui/js/app-view.js"></script>');
    const block = html.slice(html.indexOf('/* Audience view (ADR-164 D6).'), html.indexOf("A.boot({ app: 'person-model'"));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toContain('innerHTML');
    expect(block).not.toMatch(/method\s*:/);
    expect(html).toContain('if (!window.AppView || !AppView.active()) {\n      (function boot() {');
  });

  it('company view paints the card from the four reads, writes nothing, reads nothing else, and keeps the full page hidden and unstarted', async () => {
    await openView('?audience=company');
    await expectCard('company');
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    await expectFullPageIdle('?audience=company');
    expect(errors).toEqual([]);
  });

  it('family view paints the same card', async () => {
    await openView('?audience=family');
    await expectCard('family');
    expect(offContract([`${PAGE_PATH}?audience=family`, ...READS])).toEqual([]);
    await expectFullPageIdle('?audience=family');
    expect(errors).toEqual([]);
  });

  it('paints an empty caller from the answers: zeros, never-heard, semantic off and each section says it is empty', async () => {
    state.people = { status: 200, body: { people: [] } };
    state.asks = { status: 200, body: { asks: [] } };
    state.projection = { status: 200, body: { semanticAvailable: false, ledger: null } };
    state.trends = { status: 200, body: { personLabel: 'Anyone', personResolved: true, weeks: 2, rows: [] } };
    await openView('?audience=company');
    expect(await statValues()).toEqual({ voices: '0', lines: '0', 'last-heard': 'Never', asks: '0', semantic: 'Off' });
    expect(await text('[data-stat="voices"] .av-stat-hint')).toBe('None heard yet');
    expect(await text('[data-stat="semantic"] .av-stat-hint')).toBe('Exact search only');
    expect(await text('[data-section="voices"] .av-empty')).toBe('No voices heard yet. Turn on ambient listening in the Jarvis panel and name voices under Manage Voices.');
    expect(await text('[data-section="asks"] .av-empty')).toContain('Nothing open.');
    expect(await text('[data-section="topics"] .av-empty')).toContain('No modeled topics in that window.');
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    expect(errors).toEqual([]);
  });

  const REFUSALS: Array<{ kind: string; answer?: Answer; network?: boolean; said: string }> = [
    { kind: '401 signed-out', answer: { status: 401, body: { error: 'sign_in_required' } }, said: 'You are not signed in (HTTP 401). Sign in, then open Ambient Recall again.' },
    { kind: '403 refused', answer: { status: 403, body: { error: 'Operator privilege required' } }, said: 'Ambient Recall refused this account (HTTP 403).' },
    { kind: '404 not-found', answer: { status: 404, raw: 'Not found' }, said: 'Ambient Recall did not answer on this core (HTTP 404).' },
    { kind: '5xx server-error', answer: { status: 500, body: { error: 'synthetic database failure' } }, said: 'Ambient Recall failed to answer (HTTP 500).' },
    { kind: 'network failure', network: true, said: 'Ambient Recall could not be reached (network failure).' },
    { kind: 'malformed JSON', answer: { status: 200, raw: '{"people": ' }, said: 'Ambient Recall answered with something that is not JSON.' },
    { kind: 'unreadable shape', answer: { status: 200, body: { people: 'none', asks: {}, rows: 7 } }, said: 'Ambient Recall answered in a shape this view cannot read.' },
  ];

  it.each(REFUSALS)('says a $kind refusal in the card with no stat in its place', async ({ answer, network, said }) => {
    if (answer) { state.people = answer; state.asks = answer; state.projection = answer; state.trends = answer; }
    if (network) await page.route(url => url.pathname.startsWith(`${API}/`) && url.pathname !== PAGE_PATH, route => route.abort('failed'));
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe(said);
    expect(await page.locator('#av-root .av-stat').count()).toBe(0);
    expect(await page.locator('#av-root [data-section]').count()).toBe(0);
    expect(await page.locator('#av-root').textContent()).not.toContain('synthetic database failure');
    expect(await page.locator('.av-btn', { hasText: 'Try again' }).count()).toBe(1);
    expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=person-model');
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    expect(await visible('.wrap')).toBe(false);
    expect(await text('#status')).toBe('');
    expect(errors).toEqual([]);
  });

  it('paints the figures once a refused read answers and the reader tries again', async () => {
    state.people = { status: 503, body: { error: 'synthetic outage' } };
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe('Ambient Recall failed to answer (HTTP 503).');
    state.people = { status: 200, body: syntheticPeople() };
    await page.locator('.av-btn', { hasText: 'Try again' }).click();
    await page.waitForSelector('#av-root .av-stat');
    expect((await statValues()).voices).toBe('4');
    expect(errors).toEqual([]);
  });

  it('says a refused asks, projection or trends read in its own place while the voice figures still paint', async () => {
    state.asks = { status: 500, body: { error: 'synthetic asks failure' } };
    state.projection = { status: 403, body: { error: 'synthetic refusal' } };
    state.trends = { status: 404, raw: 'Not found' };
    await openView('?audience=company');
    expect(await statValues()).toEqual({ voices: '4', lines: '421', 'last-heard': '2 h ago', asks: '—', semantic: '—' });
    expect(await text('[data-stat="asks"] .av-stat-hint')).toBe('Could not be read');
    expect(await text('[data-stat="semantic"] .av-stat-hint')).toBe('Ambient Recall refused this account (HTTP 403).');
    expect(await page.locator('[data-section="voices"] .av-item').count()).toBe(4);
    expect(await page.locator('[data-section="asks"] .av-item').count()).toBe(0);
    expect(await text('[data-section="asks"] .av-empty')).toBe('Open asks could not be read. Ambient Recall failed to answer (HTTP 500).');
    expect(await rows('topics')).toEqual([]);
    expect(await text('[data-section="topics"] .av-empty')).toBe('Topics could not be read. Ambient Recall did not answer on this core (HTTP 404).');
    expect(await page.locator('#av-root').textContent()).not.toContain('synthetic asks failure');
    expect(errors).toEqual([]);
  });

  it('the primary action leaves the view for the full page in the same frame', async () => {
    await page.goto(`${origin}/fixture/host`);
    const frame = page.frameLocator('#host-frame');
    await frame.locator('#av-root .av-stat').first().waitFor();
    const framed = page.frames().find(f => f.url().includes(`${PAGE_PATH}?audience=company`));
    expect(framed).toBeTruthy();
    await frame.locator('.av-btn.is-primary').click();
    await framed!.waitForFunction(() => (document.getElementById('status')?.textContent || '').length > 0);
    const at = new URL(framed!.url());
    expect(at.pathname).toBe(PAGE_PATH);
    expect(at.searchParams.get('audience')).toBeNull();
    expect(new URL(page.url()).pathname).toBe('/fixture/host');
    expect(await frame.locator('#av-root').count()).toBe(0);
    expect(await frame.locator('#status').textContent()).toBe('Semantic recall: on · projected 400 of 421 lines (lagging)');
    expect(await frame.locator('[data-panel="recall"]').isVisible()).toBe(true);
    expect(offContract(['/fixture/host', `${PAGE_PATH}?audience=company`, PAGE_PATH, ...READS])).toEqual([]);
    // /projection once by the card and once by the full page it opened; the other reads only by the card.
    expect(readCount(`${API}/projection`)).toBe(2);
    for (const url of READS.filter(u => !u.endsWith('/projection'))) expect(readCount(url)).toBe(1);
    expect(errors).toEqual([]);
  });

  it.each([
    { name: 'without an audience', query: '', kit: true },
    { name: 'with ?audience=classroom, which this page does not provide', query: '?audience=classroom', kit: true },
    { name: 'on a core without the kit', query: '?audience=company', kit: false },
  ])('starts the full page exactly as before $name', async ({ query, kit }) => {
    state.kit = kit;
    await page.goto(`${origin}${PAGE_PATH}${query}`);
    await page.waitForFunction(() => (document.getElementById('status')?.textContent || '').length > 0);
    await page.waitForLoadState('networkidle');
    expect(await page.locator('#av-root').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBeNull();
    expect(await visible('.wrap')).toBe(true);
    expect(await page.locator('[data-panel="recall"]').isVisible()).toBe(true);
    expect(await page.locator('[data-tab="recall"]').getAttribute('aria-selected')).toBe('true');
    expect(await text('#status')).toBe('Semantic recall: on · projected 400 of 421 lines (lagging)');
    expect(await page.evaluate(() => new URLSearchParams(window.location.search).get('tab'))).toBe('recall');
    // The full page's own load read is /projection alone; the card's other reads never happen.
    expect(readCount(`${API}/projection`)).toBe(1);
    for (const url of READS.filter(u => !u.endsWith('/projection'))) expect(readCount(url)).toBe(0);
    expect(offContract([`${PAGE_PATH}${query}`, `${API}/projection`])).toEqual([]);
    expect(errors).toEqual([]);
  });
});

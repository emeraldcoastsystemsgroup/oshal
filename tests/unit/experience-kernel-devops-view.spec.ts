/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | DevOps + Vault audience view (ADR-164 D6) in headless Chromium over one loopback server: the real src/api/devops-vault.html at its real route (/api/devops/console), /shared/ui from source, synthetic answers for exactly the GETs the full page makes on load (/access, /status and the /trace/stream SSE the card never opens) and a journal of every request. The company and family views paint the same card from /access then /status (title, stats, sections by id, escape) with no write, no other read, and the full page hidden and unstarted; the sealed, denied and unreachable lights paint only the facts their answer carries; every refusal kind on either read (401, 403, the super-admin gate turning a caller away, 404, 5xx incl. an unconfigured Vault, network failure, malformed JSON, an unreadable shape) is said with no stat; the primary action leaves the view for the full page in the same frame; without an audience, with ?audience=classroom and on a core without the kit, the full page starts exactly as before.
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
const PAGE_FILE = resolve(ROOT, 'src/api/devops-vault.html');
const PAGE_PATH = '/api/devops/console';
const ACCESS = '/api/devops/access';
const STATUS = '/api/devops/status';
const TRACE = '/api/devops/trace/stream';
const READS = [ACCESS, STATUS];
const ADDR = 'http://vault.synthetic.invalid:8200';

type Answer = { status: number; body?: unknown; raw?: string };
interface Journaled { method: string; url: string; accept: string }

/** @description The GET /status answer for a working Vault, shaped like VaultConsoleService.status(), every value synthetic. */
function syntheticStatus() {
  return { ok: true, light: 'green', reason: 'working', sealed: false, initialized: true, standby: false, version: '1.99.0-synthetic', addr: ADDR };
}

const state = { access: { status: 200 } as Answer, status: { status: 200 } as Answer, kit: true, journal: [] as Journaled[] };

/** @description A super-admin caller, a working synthetic Vault, the kit served, an empty journal: every case starts from the same core. */
function resetState() {
  state.access = { status: 200, body: { superAdmin: true } };
  state.status = { status: 200, body: syntheticStatus() };
  state.kit = true;
  state.journal = [];
}

/** @description Answer one read from the case's scripted state (a raw body is sent as-is under a JSON content type). */
function send(res: Response, answer: Answer) {
  if (answer.raw !== undefined) { res.status(answer.status).type('application/json').send(answer.raw); return; }
  res.status(answer.status).json(answer.body ?? {});
}

/**
 * @description The owner-scoped trace stream as the full page receives it: one connected frame, a long retry so the
 * browser does not reconnect during the case, then the response ends so the network can go quiet.
 */
function sendTrace(res: Response) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write('retry: 600000\n\n');
  res.write(`data: ${JSON.stringify({ ts: Date.now(), actor: 'synthetic-operator', action: 'trace.connected', level: 'info', text: 'Synthetic trace connected.' })}\n\n`);
  res.end();
}

/** @description One loopback server: the real page at its real route, /shared/ui and the imported cockpit theme files from source, the synthetic reads, a framing host and a journal of every request. */
async function startServer() {
  const app = express();
  app.use((req, _res, next) => { state.journal.push({ method: req.method, url: req.originalUrl, accept: req.get('accept') || '' }); next(); });
  app.get('/shared/ui/js/app-view.js', (_req, res, next) => { if (state.kit) next(); else res.status(404).send('Not found'); });
  app.use('/shared/ui', express.static(resolve(ROOT, 'src/shared/ui')));
  app.use('/cockpit/css/themes', express.static(resolve(ROOT, 'src/pages/cockpit/css/themes')));
  app.get(PAGE_PATH, (_req, res) => res.sendFile(PAGE_FILE));
  app.get(ACCESS, (_req, res) => send(res, state.access));
  app.get(STATUS, (_req, res) => send(res, state.status));
  app.get(TRACE, (_req, res) => sendTrace(res));
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
/** @description How many times a URL was read (the card and the full page share /access and /status, so a second read means the full page started too). */
const readCount = (url: string) => state.journal.filter(r => r.method === 'GET' && r.url === url).length;
/** @description Text of the first element matching a selector. */
const text = (selector: string) => page.locator(selector).first().textContent();
/** @description Whether an element exists and is displayed. */
const visible = (selector: string) => page.evaluate(sel => { const el = document.querySelector(sel) as HTMLElement | null; return !!el && getComputedStyle(el).display !== 'none'; }, selector);
/** @description The card's stat values keyed by data-stat. */
const statValues = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#av-root [data-stat]')).map(n => [n.getAttribute('data-stat'), n.querySelector('.av-stat-value')?.textContent])));
/** @description The items of a list section as [title, text] pairs. */
const listItems = (id: string) => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(li => [li.querySelector('.av-item-title')?.textContent, li.querySelector('.av-item-text')?.textContent]), `[data-section="${id}"] .av-item`);
/** @description The titles of a tiles section. */
const tileTitles = (id: string) => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(n => n.textContent), `[data-section="${id}"] .av-tile-title`);

/** @description Open the page with an audience and wait until the card (or its refusal) has painted and the network is quiet. */
async function openView(query: string, ready = '#av-root .av-stat') {
  await page.goto(`${origin}${PAGE_PATH}${query}`);
  await page.waitForSelector(ready);
  await page.waitForLoadState('networkidle');
}

/** @description The card both shells paint from the synthetic reads: hero, five stats, the server list, the console tiles, the escape. */
async function expectCard(audience: string) {
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBe(audience);
  expect(await page.locator('#av-root').getAttribute('data-audience')).toBe(audience);
  expect(await text('.av-kicker')).toBe('Infrastructure Vault');
  expect(await text('.av-title')).toBe('DevOps + Vault');
  expect(await statValues()).toEqual({ connection: 'Working', version: 'v1.99.0-synthetic', seal: 'Unsealed', initialized: 'Yes', mode: 'Active' });
  expect(await text('[data-stat="connection"] .av-stat-hint')).toBe('Vault is reachable and the console credential is accepted.');
  expect(await page.locator('[data-stat="connection"]').getAttribute('class')).toContain('tone-ok');
  expect(await listItems('server')).toEqual([['Address', ADDR]]);
  expect(await tileTitles('console')).toEqual(['KV secrets', 'Scope (ACL policy)', 'Credential broker', 'Database dynamic secrets', 'Live process trace']);
  expect(await text('.av-btn.is-primary')).toBe('Open DevOps + Vault');
  expect(await text('.av-escape-link')).toBe('Open DevOps + Vault in the cockpit');
  expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=devops');
}

/** @description The full page stayed hidden and never started: neither the console nor the gate revealed, no trace stream, each card read made once. */
async function expectFullPageIdle(reads: Record<string, number>) {
  expect(await visible('.page')).toBe(false);
  expect(await page.locator('#console.hidden').count()).toBe(1);
  expect(await page.locator('#gate.hidden').count()).toBe(1);
  expect(await text('#statusLine')).toBe('Loading…');
  expect(readCount(TRACE)).toBe(0);
  for (const [url, n] of Object.entries(reads)) expect(readCount(url)).toBe(n);
}

describe('DevOps + Vault audience view (ADR-164 D6)', () => {
  it('loads the kit right after the theme bootstrap, builds the card without innerHTML, and gates the page start', () => {
    const html = readFileSync(PAGE_FILE, 'utf8');
    const theme = html.indexOf('<script src="/shared/ui/js/surface-theme.js"></script>');
    expect(theme).toBeGreaterThan(-1);
    const after = html.slice(theme).split('\n').slice(1, 4).join('\n');
    expect(after).toContain('<link rel="stylesheet" href="/shared/ui/css/app-view.css" />');
    expect(after).toContain('<script src="/shared/ui/js/app-view.js"></script>');
    const block = html.slice(html.indexOf('/* Audience view (ADR-164 D6).'), html.indexOf("A.boot({ app: 'devops'"));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toContain('innerHTML');
    expect(block).not.toMatch(/method\s*:/);
    expect(html).toMatch(/if \(!window\.AppView \|\| !AppView\.active\(\)\) \{\s*init\(\);\s*\}/);
    expect(html.match(/^\s*init\(\);\s*$/gm)?.length).toBe(1);
  });

  it('company view paints the card from /access and /status, writes nothing, reads nothing else, and keeps the full page hidden and unstarted', async () => {
    await openView('?audience=company');
    await expectCard('company');
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    for (const r of state.journal.filter(j => READS.includes(j.url))) expect(r.accept).toBe('application/json');
    await expectFullPageIdle({ [ACCESS]: 1, [STATUS]: 1 });
    expect(errors).toEqual([]);
  });

  it('family view paints the same card', async () => {
    await openView('?audience=family');
    await expectCard('family');
    expect(offContract([`${PAGE_PATH}?audience=family`, ...READS])).toEqual([]);
    await expectFullPageIdle({ [ACCESS]: 1, [STATUS]: 1 });
    expect(errors).toEqual([]);
  });

  it.each([
    { light: 'sealed', body: { ok: false, light: 'red', reason: 'sealed', sealed: true, version: '1.99.0-synthetic', addr: ADDR },
      stats: { connection: 'Sealed', version: 'v1.99.0-synthetic', seal: 'Sealed' }, server: [['Address', ADDR]], tone: 'tone-bad' },
    { light: 'denied', body: { ok: false, light: 'red', reason: 'denied', version: '1.99.0-synthetic', addr: ADDR },
      stats: { connection: 'Denied', version: 'v1.99.0-synthetic' }, server: [['Address', ADDR]], tone: 'tone-bad' },
    { light: 'unreachable', body: { ok: false, light: 'yellow', reason: 'unreachable', error: 'synthetic connect refused', addr: ADDR },
      stats: { connection: 'Unreachable' }, server: [['Address', ADDR], ['Vault reported an error', 'synthetic connect refused']], tone: 'tone-warn' },
  ])('paints only the facts a $light Vault answer carries', async ({ body, stats, server: items, tone }) => {
    state.status = { status: 200, body };
    await openView('?audience=company');
    expect(await statValues()).toEqual(stats);
    expect(await page.locator('[data-stat="connection"]').getAttribute('class')).toContain(tone);
    expect(await listItems('server')).toEqual(items);
    expect(await page.locator('[data-section="console"] .av-tile').count()).toBe(5);
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    await expectFullPageIdle({ [ACCESS]: 1, [STATUS]: 1 });
    expect(errors).toEqual([]);
  });

  const GATE_REASON = 'Caller is not on the synthetic super-admin allowlist.';
  const REFUSALS: Array<{ read: 'access' | 'status'; kind: string; answer?: Answer; network?: boolean; said: string }> = [
    { read: 'access', kind: '401 signed-out', answer: { status: 401, body: { authenticated: false, error: 'unauthorized', loginPath: '/login' } }, said: 'You are not signed in (HTTP 401). Sign in, then open DevOps + Vault again.' },
    { read: 'access', kind: '403 refused', answer: { status: 403, body: { error: 'Forbidden', reason: GATE_REASON } }, said: `DevOps + Vault refused this account (HTTP 403): it is open to super-admins only. ${GATE_REASON}` },
    { read: 'access', kind: 'super-admin gate', answer: { status: 200, body: { superAdmin: false, reason: GATE_REASON } }, said: `Super-admin access required. ${GATE_REASON}` },
    { read: 'access', kind: 'super-admin gate without a reason', answer: { status: 200, body: { superAdmin: false } }, said: 'Super-admin access required. This console operates the platform’s infrastructure Vault.' },
    { read: 'access', kind: '404 not-found', answer: { status: 404, raw: 'Not found' }, said: 'DevOps + Vault did not answer on this core (HTTP 404).' },
    { read: 'access', kind: '5xx server-error', answer: { status: 500, body: { error: 'synthetic database failure' } }, said: 'DevOps + Vault failed to answer (HTTP 500).' },
    { read: 'access', kind: 'network failure', network: true, said: 'DevOps + Vault could not be reached (network failure).' },
    { read: 'access', kind: 'malformed JSON', answer: { status: 200, raw: '{"superAdmin": ' }, said: 'DevOps + Vault answered with something that is not JSON.' },
    { read: 'access', kind: 'unreadable shape', answer: { status: 200, body: { superAdmin: 'yes' } }, said: 'DevOps + Vault answered in a shape this view cannot read.' },
    { read: 'status', kind: '401 signed-out', answer: { status: 401, body: { authenticated: false, error: 'unauthorized' } }, said: 'You are not signed in (HTTP 401). Sign in, then open DevOps + Vault again.' },
    { read: 'status', kind: '403 super-admin gate', answer: { status: 403, body: { error: 'Super-admin privilege required', reason: GATE_REASON } }, said: `DevOps + Vault refused this account (HTTP 403): it is open to super-admins only. ${GATE_REASON}` },
    { read: 'status', kind: '404 not-found', answer: { status: 404, raw: 'Not found' }, said: 'DevOps + Vault did not answer on this core (HTTP 404).' },
    { read: 'status', kind: '503 unconfigured Vault', answer: { status: 503, body: { error: 'vault_not_configured', message: 'VAULT_TOKEN is not set on this deployment.' } }, said: 'Vault is not configured on this core (HTTP 503): no Vault token is set, so the console has nothing to show.' },
    { read: 'status', kind: '5xx server-error', answer: { status: 502, body: { error: 'synthetic vault failure' } }, said: 'DevOps + Vault failed to answer (HTTP 502).' },
    { read: 'status', kind: 'network failure', network: true, said: 'DevOps + Vault could not be reached (network failure).' },
    { read: 'status', kind: 'malformed JSON', answer: { status: 200, raw: '{"light": ' }, said: 'DevOps + Vault answered with something that is not JSON.' },
    { read: 'status', kind: 'unreadable shape', answer: { status: 200, body: { light: 'purple', reason: 'synthetic' } }, said: 'DevOps + Vault answered in a shape this view cannot read.' },
  ];

  it.each(REFUSALS)('says a $kind refusal of /$read in the card with no stat in its place', async ({ read, answer, network, said }) => {
    const url = read === 'access' ? ACCESS : STATUS;
    if (answer) state[read] = answer;
    if (network) await page.route(u => u.pathname === url, route => route.abort('failed'));
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe(said);
    expect(await page.locator('#av-root .av-stat').count()).toBe(0);
    expect(await page.locator('#av-root [data-section]').count()).toBe(0);
    const card = await page.locator('#av-root').textContent();
    for (const leak of ['synthetic database failure', 'synthetic vault failure', 'VAULT_TOKEN', ADDR]) expect(card).not.toContain(leak);
    expect(await page.locator('.av-btn', { hasText: 'Try again' }).count()).toBe(1);
    expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=devops');
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    // A refused or gated /access never reaches /status, exactly as the full page's own gate; an aborted read never reaches the server.
    const reached = network ? 0 : 1;
    await expectFullPageIdle(read === 'access' ? { [ACCESS]: reached, [STATUS]: 0 } : { [ACCESS]: 1, [STATUS]: reached });
    expect(errors).toEqual([]);
  });

  it('paints the figures once a refused read answers and the reader tries again', async () => {
    state.status = { status: 503, body: { error: 'synthetic outage' } };
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe('DevOps + Vault failed to answer (HTTP 503).');
    state.status = { status: 200, body: syntheticStatus() };
    await page.locator('.av-btn', { hasText: 'Try again' }).click();
    await page.waitForSelector('#av-root .av-stat');
    expect((await statValues()).connection).toBe('Working');
    expect(errors).toEqual([]);
  });

  it('the primary action leaves the view for the full page in the same frame', async () => {
    await page.goto(`${origin}/fixture/host`);
    const frame = page.frameLocator('#host-frame');
    await frame.locator('#av-root .av-stat').first().waitFor();
    const framed = page.frames().find(f => f.url().includes(`${PAGE_PATH}?audience=company`));
    expect(framed).toBeTruthy();
    await frame.locator('.av-btn.is-primary').click();
    await frame.locator('#traceLog .tl.info').first().waitFor();
    await page.waitForLoadState('networkidle');
    const at = new URL(framed!.url());
    expect(at.pathname + at.search).toBe(PAGE_PATH);
    expect(new URL(page.url()).pathname).toBe('/fixture/host');
    expect(await frame.locator('#av-root').count()).toBe(0);
    expect(await frame.locator('#console.hidden').count()).toBe(0);
    expect(await frame.locator('#statusPill').textContent()).toBe('v1.99.0-synthetic');
    expect(offContract(['/fixture/host', `${PAGE_PATH}?audience=company`, PAGE_PATH, ...READS, TRACE])).toEqual([]);
    // Once by the card, once by the full page it opened; the trace stream only by the full page.
    for (const url of READS) expect(readCount(url)).toBe(2);
    expect(readCount(TRACE)).toBe(1);
    expect(errors).toEqual([]);
  });

  it.each([
    { name: 'without an audience', query: '', kit: true },
    { name: 'with ?audience=classroom, which this page does not provide', query: '?audience=classroom', kit: true },
    { name: 'on a core without the kit', query: '?audience=company', kit: false },
  ])('starts the full page exactly as before $name', async ({ query, kit }) => {
    state.kit = kit;
    await page.goto(`${origin}${PAGE_PATH}${query}`);
    await page.locator('#traceLog .tl.info').first().waitFor();
    await page.waitForLoadState('networkidle');
    expect(await page.locator('#av-root').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBeNull();
    expect(await visible('.page')).toBe(true);
    expect(await visible('#console')).toBe(true);
    expect(await visible('#gate')).toBe(false);
    expect(await text('#statusPill')).toBe('v1.99.0-synthetic');
    expect(await text('#statusLine')).toContain('Vault reachable and credentials accepted.');
    expect(await text('#statusLine')).toContain(ADDR);
    expect(await text('#traceLog')).toContain('trace.connected');
    for (const url of [...READS, TRACE]) expect(readCount(url)).toBe(1);
    expect(offContract([`${PAGE_PATH}${query}`, ...READS, TRACE])).toEqual([]);
    expect(errors).toEqual([]);
  });
});

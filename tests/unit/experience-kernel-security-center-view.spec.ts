/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Security Center audience view (ADR-164 D6) in headless Chromium over one loopback server: the real src/api/security.html at its real route (/api/security/), /shared/ui from source, synthetic answers for exactly the two GETs the full page makes on load (/status and /findings?status=open) and a journal of every request. The company and family views paint the same card from those reads (title, stats, sections by id, escape) with no write, no other read, and the full page hidden and unstarted; every refusal kind (401, the 403 operator gate, 404, 5xx, network failure, malformed JSON, an unreadable shape) is said with no stat; the primary action leaves the view for the full page in the same frame; without an audience, with ?audience=classroom and on a core without the kit, the full page starts exactly as before.
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
const PAGE_FILE = resolve(ROOT, 'src/api/security.html');
const PAGE_PATH = '/api/security/';
const READS = ['/api/security/status', '/api/security/findings?status=open'];
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Answer = { status: number; body?: unknown; raw?: string };
interface Journaled { method: string; url: string }

/** @description The GET /status answer shaped like security-routes.ts, every figure explicitly synthetic. */
function syntheticStatus() {
  return {
    severity: { critical: 1, high: 2, medium: 3, low: 1 },
    category: { secret: 1, route_auth: 2, dependency: 3, threat: 1 },
    status: { open: 7, triaged: 1, resolved: 4, ignored: 2 },
    lastScan: {
      scan_id: 'synthetic-scan', kinds: ['posture', 'runtime'], status: 'complete', finding_count: 13, new_count: 2,
      summary: [{ kind: 'posture', available: true, count: 6 }, { kind: 'runtime', available: false, count: 0, note: 'Synthetic runtime detector offline' }],
      started_at: iso(-2 * HOUR), finished_at: iso(-2 * HOUR + 60_000),
    },
    scopes: ['posture', 'runtime', 'ledger', 'audit', 'image'],
  };
}

/** @description Seven synthetic open findings, worst first as GET /findings?status=open returns them. */
function syntheticFindings() {
  const row = (n: number, severity: string, category: string, extra: Record<string, unknown> = {}) => ({
    finding_id: `00000000-0000-4000-8000-00000000000${n}`, category, severity, title: `Synthetic finding ${n}`, detail: `Synthetic detail ${n}.`,
    source: `synthetic/source-${n}.ts`, evidence: { preview: 'synthetic-redacted-evidence' }, status: 'open', assessment: null, assessed_at: null,
    ticket_id: null, first_seen: iso(-48 * HOUR), last_seen: iso(-3 * HOUR), ...extra,
  });
  return {
    findings: [
      row(1, 'critical', 'secret', { assessment: { isRealThreat: true, summary: 'Synthetic verdict' } }),
      row(2, 'high', 'route_auth', { ticket_id: '11111111-1111-4111-8111-111111111111' }),
      row(3, 'high', 'route_auth', { assessment: { falsePositive: true, summary: 'Synthetic false positive' } }),
      row(4, 'medium', 'dependency'), row(5, 'medium', 'dependency'), row(6, 'medium', 'dependency'),
      row(7, 'low', 'threat'),
    ],
  };
}

const state = { status: { status: 200 } as Answer, findings: { status: 200 } as Answer, kit: true, journal: [] as Journaled[] };

/** @description Fresh synthetic answers, the kit served, an empty journal: every case starts from the same swarm. */
function resetState() {
  state.status = { status: 200, body: syntheticStatus() };
  state.findings = { status: 200, body: syntheticFindings() };
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
  app.get('/api/security/status', (_req, res) => send(res, state.status));
  app.get('/api/security/findings', (_req, res) => send(res, state.findings));
  app.get('/fixture/host', (_req, res) => res.type('html').send('<!DOCTYPE html><html><head><title>Synthetic shell</title></head><body><iframe id="host-frame" src="/api/security/?audience=company" style="width:1200px;height:800px"></iframe></body></html>'));
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

/** @description Open the page with an audience and wait until the card (or its refusal) has painted and the network is quiet. */
async function openView(query: string, ready = '#av-root .av-stat') {
  await page.goto(`${origin}${PAGE_PATH}${query}`);
  await page.waitForSelector(ready);
  await page.waitForLoadState('networkidle');
}

/** @description The card both shells paint from the synthetic reads: hero, five stats, four sections, the escape. */
async function expectCard(audience: string) {
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBe(audience);
  expect(await page.locator('#av-root').getAttribute('data-audience')).toBe(audience);
  expect(await text('.av-title')).toBe('Security Center');
  expect(await statValues()).toEqual({ open: '7', critical: '1', high: '2', resolved: '4', 'last-scan': '2 h ago' });
  expect(await text('[data-stat="resolved"] .av-stat-hint')).toBe('2 ignored');
  expect(await text('[data-stat="last-scan"] .av-stat-hint')).toBe('13 found, 2 new · complete');
  expect(await page.locator('[data-stat="critical"]').getAttribute('class')).toContain('tone-bad');
  const worst = page.locator('[data-section="worst"] .av-item');
  expect(await worst.count()).toBe(6);
  expect(await worst.first().locator('.av-item-title').textContent()).toBe('Synthetic finding 1');
  expect(await worst.first().locator('.av-item-text').textContent()).toBe('Secrets · synthetic/source-1.ts');
  expect(await worst.first().locator('.av-badge').textContent()).toBe('critical');
  expect(await worst.first().locator('.av-meta').textContent()).toBe('Confirmed · Seen 3 h ago');
  expect(await worst.nth(1).locator('.av-meta').textContent()).toBe('Ticket linked · Seen 3 h ago');
  expect(await worst.nth(2).locator('.av-meta').textContent()).toBe('Likely false positive · Seen 3 h ago');
  expect(await rows('areas')).toEqual([['Dependencies', '3'], ['Routes', '2'], ['Secrets', '1'], ['Threats', '1']]);
  expect(await rows('review')).toEqual([['Open', '7'], ['Triaged', '1'], ['Resolved', '4'], ['Ignored', '2']]);
  expect(await rows('coverage')).toEqual([['Posture', 'Ran', '6'], ['Runtime threats', 'Could not run: Synthetic runtime detector offline', '—']]);
  const card = await page.locator('#av-root').textContent();
  expect(card).not.toContain('Synthetic finding 7');
  expect(card).not.toContain('synthetic-redacted-evidence');
  expect(await text('.av-btn.is-primary')).toBe('Open Security Center');
  expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=security-center');
}

/** @description The full page stayed hidden and never started: no rollup, no last-scan line, each read made once (by the card). */
async function expectFullPageIdle() {
  expect(await visible('.page')).toBe(false);
  expect(await page.locator('#stats .stat').count()).toBe(0);
  expect(await text('#lastScan')).toBe('');
  for (const url of READS) expect(readCount(url)).toBe(1);
}

describe('Security Center audience view (ADR-164 D6)', () => {
  it('loads the kit right after the theme bootstrap and builds the card without innerHTML', () => {
    const html = readFileSync(PAGE_FILE, 'utf8');
    const theme = html.indexOf('<script src="/shared/ui/js/surface-theme.js"></script>');
    expect(theme).toBeGreaterThan(-1);
    const after = html.slice(theme).split('\n').slice(1, 4).join('\n');
    expect(after).toContain('<link rel="stylesheet" href="/shared/ui/css/app-view.css" />');
    expect(after).toContain('<script src="/shared/ui/js/app-view.js"></script>');
    const block = html.slice(html.indexOf('/* Audience view (ADR-164 D6).'), html.indexOf("A.boot({ app: 'security-center'"));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toContain('innerHTML');
    expect(block).not.toMatch(/method\s*:/);
  });

  it('company view paints the card from the two reads, writes nothing, reads nothing else, and keeps the full page hidden and unstarted', async () => {
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
    { kind: '401 signed-out', answer: { status: 401, body: { authenticated: false, error: 'unauthorized', loginPath: '/login' } }, said: 'You are not signed in (HTTP 401). Sign in, then open the Security Center again.' },
    { kind: '403 operator-gate', answer: { status: 403, body: { error: 'Operator privilege required' } }, said: 'The Security Center refused this account (HTTP 403): it is open to operators only.' },
    { kind: '404 not-found', answer: { status: 404, raw: 'Not found' }, said: 'The Security Center did not answer on this core (HTTP 404).' },
    { kind: '5xx server-error', answer: { status: 500, body: { error: 'synthetic database failure' } }, said: 'The Security Center failed to answer (HTTP 500).' },
    { kind: 'network failure', network: true, said: 'The Security Center could not be reached (network failure).' },
    { kind: 'malformed JSON', answer: { status: 200, raw: '{"severity": ' }, said: 'The Security Center answered with something that is not JSON.' },
    { kind: 'unreadable shape', answer: { status: 200, body: { severity: [], findings: 'none' } }, said: 'The Security Center answered in a shape this view cannot read.' },
  ];

  it.each(REFUSALS)('says a $kind refusal in the card with no stat in its place', async ({ answer, network, said }) => {
    if (answer) { state.status = answer; state.findings = answer; }
    if (network) await page.route(url => url.pathname.startsWith('/api/security/') && url.pathname !== PAGE_PATH, route => route.abort('failed'));
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe(said);
    expect(await page.locator('#av-root .av-stat').count()).toBe(0);
    expect(await page.locator('#av-root [data-section]').count()).toBe(0);
    expect(await page.locator('#av-root').textContent()).not.toContain('synthetic database failure');
    expect(await page.locator('.av-btn', { hasText: 'Try again' }).count()).toBe(1);
    expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=security-center');
    expect(offContract([`${PAGE_PATH}?audience=company`, ...READS])).toEqual([]);
    expect(await visible('.page')).toBe(false);
    expect(await page.locator('#stats .stat').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('paints the figures once a refused read answers and the reader tries again', async () => {
    state.status = { status: 503, body: { error: 'synthetic outage' } };
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe('The Security Center failed to answer (HTTP 503).');
    state.status = { status: 200, body: syntheticStatus() };
    await page.locator('.av-btn', { hasText: 'Try again' }).click();
    await page.waitForSelector('#av-root .av-stat');
    expect((await statValues()).open).toBe('7');
    expect(errors).toEqual([]);
  });

  it('says a refused findings read in its own section while the status figures still paint', async () => {
    state.findings = { status: 500, body: { error: 'synthetic findings failure' } };
    await openView('?audience=company');
    expect((await statValues()).open).toBe('7');
    expect(await page.locator('[data-section="worst"] .av-item').count()).toBe(0);
    expect(await text('[data-section="worst"] .av-empty')).toBe('Open findings could not be read. The Security Center failed to answer (HTTP 500).');
    expect(await rows('areas')).toEqual([['Dependencies', '3'], ['Routes', '2'], ['Secrets', '1'], ['Threats', '1']]);
    expect(errors).toEqual([]);
  });

  it('the primary action leaves the view for the full page in the same frame', async () => {
    await page.goto(`${origin}/fixture/host`);
    const frame = page.frameLocator('#host-frame');
    await frame.locator('#av-root .av-stat').first().waitFor();
    const framed = page.frames().find(f => f.url().includes('/api/security/?audience=company'));
    expect(framed).toBeTruthy();
    await frame.locator('.av-btn.is-primary').click();
    await frame.locator('#findings .find').first().waitFor();
    const at = new URL(framed!.url());
    expect(at.pathname + at.search).toBe(PAGE_PATH);
    expect(new URL(page.url()).pathname).toBe('/fixture/host');
    expect(await frame.locator('#av-root').count()).toBe(0);
    expect(await frame.locator('#stats .stat').count()).toBe(6);
    expect(await frame.locator('#findings .find').count()).toBe(7);
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
    await page.locator('#findings .find').first().waitFor();
    await page.waitForLoadState('networkidle');
    expect(await page.locator('#av-root').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBeNull();
    expect(await visible('.page')).toBe(true);
    expect(await page.locator('#stats .stat').count()).toBe(6);
    expect(await text('#stats .stat .n')).toBe('7');
    expect(await page.locator('#findings .find').count()).toBe(7);
    expect(await text('#lastScan')).toContain('13 findings (2 new) · complete');
    for (const url of READS) expect(readCount(url)).toBe(1);
    expect(offContract([`${PAGE_PATH}${query}`, ...READS])).toEqual([]);
    expect(errors).toEqual([]);
  });
});

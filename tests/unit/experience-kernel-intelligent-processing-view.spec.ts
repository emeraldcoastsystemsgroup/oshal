/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Intelligent Processing audience view (ADR-164 D6) in headless Chromium over one loopback server: the real src/pages/intelligent-processing/index.html at its real route (/intelligent-processing, its page directory mounted beside it as the core mounts it), /shared/ui from source, synthetic answers for exactly the ticket reads the full page makes (/api/tickets, its "All" filter, which the card reads, and /api/tickets?status=backlog, which the full page reads on load) and a journal of every request. The company and family views paint the same card from one read (title, stats, sections by id, escape) grouped by alert fingerprint as the full page groups it, with other queues' tickets left out, no write, no other read, and the full page hidden and never started (its 20 s poll included, proven on Playwright's clock); an empty queue paints zeros and says so; every refusal kind (401, 403 incl. the operator gate and the guest guard, 404, 5xx, network failure, malformed JSON, an unreadable shape) is said with no stat; the primary action leaves the view for the full page in the same frame; without an audience, with ?audience=classroom and on a core without the kit, the full page starts exactly as before, poll included.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import express, { type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });

const ROOT = process.cwd();
const PAGE_DIR = resolve(ROOT, 'src/pages/intelligent-processing');
const PAGE_FILE = resolve(PAGE_DIR, 'index.html');
const PAGE_PATH = '/intelligent-processing';
const QUEUE = '/api/tickets';
const BACKLOG = '/api/tickets?status=backlog';
const HOUR = 36e5;
const DAY = 24 * HOUR;
const DOT = ' · ';

type Answer = { status: number; body?: unknown; raw?: string };
interface Journaled { method: string; url: string; accept: string }
interface SyntheticTicket {
  ticketId: string; ticketType: string; title: string; status: string; createdAt: string;
  priority?: string; labels?: string[]; metadata?: Record<string, unknown>;
}

/** @description An ISO timestamp the given number of milliseconds before now, so relative phrases read the same on any clock. */
function ago(ms: number) { return new Date(Date.now() - ms).toISOString(); }

/** @description One synthetic intelligent-processing ticket shaped like the consolidator writes it (alert name and target in metadata). */
function ipTicket(id: string, status: string, alertname: string, target: string, age: number, meta: Record<string, unknown> = {}, extra: Partial<SyntheticTicket> = {}): SyntheticTicket {
  return { ticketId: `synthetic-${id}`, ticketType: 'intelligent-processing', title: `${alertname} on ${target}`, status, createdAt: ago(age), metadata: { alertname, target, ...meta }, ...extra };
}

/**
 * @description The caller's tickets, every value synthetic: nine distinct alert issues in this queue (one fired three times,
 * one twice without a fingerprint), parked for each of the two reasons, spread over every state bucket, plus two tickets of
 * other queues the view must leave out.
 */
function syntheticTickets(): SyntheticTicket[] {
  return [
    ipTicket('down-1', 'backlog', 'ContainerDown', 'synthetic-api', 2 * HOUR, { alertFingerprint: 'fp-down-api', severity: 'critical' }),
    ipTicket('probe-1', 'approval_required', 'ProbeFlapping', 'synthetic-gateway', 3 * HOUR, { alertFingerprint: 'fp-probe-gw', severity: 'minor' }),
    ipTicket('cpu-1', 'approved', 'CpuSaturated', 'synthetic-bot', 4 * HOUR, { alertFingerprint: 'fp-cpu-bot' }, { priority: 'high' }),
    ipTicket('mem-1', 'backlog', 'HighMemory', 'synthetic-worker', 5 * HOUR, { alertFingerprint: 'fp-mem-worker', severity: 'warning' }, { labels: ['analysis-skipped:budget'] }),
    ipTicket('queue-1', 'in_process_discovery', 'QueueStalled', 'synthetic-queue', 6 * HOUR, { alertFingerprint: 'fp-queue', severity: 'medium' }),
    ipTicket('down-2', 'complete', 'ContainerDown', 'synthetic-api', DAY, { alertFingerprint: 'fp-down-api', severity: 'critical' }),
    ipTicket('disk-1', 'backlog', 'DiskFilling', 'synthetic-db', 2 * DAY, { alertFingerprint: 'fp-disk-db', severity: 'info', incident: { flags: ['analysis-skipped:budget'] } }),
    ipTicket('cert-1', 'complete', 'CertExpiring', 'synthetic-edge', 3 * DAY, { severity: 'low' }),
    ipTicket('redis-1', 'escalated', 'RedisEvicting', 'synthetic-cache', 4 * DAY, { alertFingerprint: 'fp-redis', severity: 'warning' }),
    ipTicket('down-3', 'complete', 'ContainerDown', 'synthetic-api', 5 * DAY, { alertFingerprint: 'fp-down-api', severity: 'critical' }),
    ipTicket('cert-2', 'complete', 'CertExpiring', 'synthetic-edge', 5 * DAY + HOUR, { severity: 'low' }),
    ipTicket('restart-1', 'cancelled', 'BotRestarting', 'synthetic-node', 6 * DAY, { alertFingerprint: 'fp-restart', severity: 'info' }),
    { ticketId: 'synthetic-incident-1', ticketType: 'incident', title: 'Synthetic other-queue incident', status: 'backlog', createdAt: ago(HOUR), metadata: { alertname: 'OtherQueueAlert', severity: 'critical' } },
    { ticketId: 'synthetic-build-1', ticketType: 'build', title: 'Synthetic build ticket', status: 'approved', createdAt: ago(HOUR) },
  ];
}

const state = { queue: { status: 200 } as Answer, tickets: [] as SyntheticTicket[], kit: true, journal: [] as Journaled[] };

/** @description The synthetic queue answered, the kit served, an empty journal: every case starts from the same core. */
function resetState() {
  state.queue = { status: 200 };
  state.tickets = syntheticTickets();
  state.kit = true;
  state.journal = [];
}

/**
 * @description GET /api/tickets as the route answers it: newest first, narrowed by ?status= when given, under
 * { tickets, count }. A scripted refusal replaces the answer (a raw body is sent as-is under a JSON content type).
 */
function sendTickets(req: Request, res: Response) {
  const answer = state.queue;
  if (answer.raw !== undefined) { res.status(answer.status).type('application/json').send(answer.raw); return; }
  if (answer.status !== 200 || answer.body !== undefined) { res.status(answer.status).json(answer.body ?? {}); return; }
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const tickets = state.tickets.filter(t => !status || t.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ tickets, count: tickets.length });
}

/** @description One loopback server: the real page and its directory at the real route, /shared/ui and the imported cockpit theme files from source, the ticket reads, a framing host and a journal of every request. */
async function startServer() {
  const app = express();
  app.use((req, _res, next) => { state.journal.push({ method: req.method, url: req.originalUrl, accept: req.get('accept') || '' }); next(); });
  app.get('/shared/ui/js/app-view.js', (_req, res, next) => { if (state.kit) next(); else res.status(404).send('Not found'); });
  app.use('/shared/ui', express.static(resolve(ROOT, 'src/shared/ui')));
  app.use('/cockpit/css/themes', express.static(resolve(ROOT, 'src/pages/cockpit/css/themes')));
  app.get([PAGE_PATH, `${PAGE_PATH}/`], (_req, res) => res.sendFile(PAGE_FILE));
  app.use(PAGE_PATH, express.static(PAGE_DIR, { index: false, redirect: false }));
  app.get(QUEUE, sendTickets);
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
/** @description How many times a URL was read: the card reads /api/tickets, the full page /api/tickets?status=backlog. */
const readCount = (url: string) => state.journal.filter(r => r.method === 'GET' && r.url === url).length;
/** @description Text of the first element matching a selector. */
const text = (selector: string) => page.locator(selector).first().textContent();
/** @description Whether an element exists and is displayed. */
const visible = (selector: string) => page.evaluate(sel => { const el = document.querySelector(sel) as HTMLElement | null; return !!el && getComputedStyle(el).display !== 'none'; }, selector);
/** @description The card's stat values keyed by data-stat. */
const statValues = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#av-root [data-stat]')).map(n => [n.getAttribute('data-stat'), n.querySelector('.av-stat-value')?.textContent])));
/** @description The card's stat hints keyed by data-stat (null when a stat carries none). */
const statHints = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('#av-root [data-stat]')).map(n => [n.getAttribute('data-stat'), n.querySelector('.av-stat-hint')?.textContent ?? null])));
/** @description The section ids in the order the card paints them. */
const sectionIds = () => page.evaluate(() => Array.from(document.querySelectorAll('#av-root [data-section]')).map(n => n.getAttribute('data-section')));
/** @description A table section's header labels. */
const tableHead = (id: string) => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(n => n.textContent), `[data-section="${id}"] .av-table th`);
/** @description A table section's body rows as arrays of cell text. */
const tableRows = (id: string) => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent)), `[data-section="${id}"] .av-table tbody tr`);
/** @description The class of each body row's first cell (the severity tone). */
const firstCellClasses = (id: string) => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(td => td.getAttribute('class')), `[data-section="${id}"] .av-table tbody tr td:first-child`);
/** @description A timeline section's items as [when, title, text]. */
const timelineItems = (id: string) => page.evaluate(sel => Array.from(document.querySelectorAll(sel)).map(li => [li.querySelector('.av-time-when')?.textContent, li.querySelector('.av-time-title')?.textContent, li.querySelector('.av-time-text')?.textContent]), `[data-section="${id}"] .av-time`);

/** @description Open the page with an audience and wait until the card (or its refusal) has painted and the network is quiet. */
async function openView(query: string, ready = '#av-root .av-stat') {
  await page.goto(`${origin}${PAGE_PATH}${query}`);
  await page.waitForSelector(ready);
  await page.waitForLoadState('networkidle');
}

/** @description The card both shells paint from the synthetic queue: hero, six stats, the parked table, the latest issues, the escape. */
async function expectCard(audience: string) {
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBe(audience);
  expect(await page.locator('#av-root').getAttribute('data-audience')).toBe(audience);
  expect(await text('.av-kicker')).toBe('Self-Healing Queue');
  expect(await text('.av-title')).toBe('Intelligent Processing');
  expect(await text('.av-lede')).toContain('grouped by alert fingerprint so one issue is one row');
  expect(await statValues()).toEqual({ parked: '3', approval: '1', pipeline: '2', complete: '1', other: '2', alerts: '12' });
  expect(await statHints()).toEqual({
    parked: `1 waiting for a person${DOT}2 stopped by the RCA spend budget`, approval: null, pipeline: 'Approved, queued or being root-caused.',
    complete: null, other: `1 escalated${DOT}1 cancelled`, alerts: 'Folded into 9 distinct issues.',
  });
  expect(await page.locator('[data-stat="parked"]').getAttribute('class')).toContain('tone-warn');
  expect(await sectionIds()).toEqual(['parked', 'recent']);
  expect(await tableHead('parked')).toEqual(['Severity', 'Alert', 'Target', 'Alerts', 'Last seen', 'Why parked']);
  expect(await tableRows('parked')).toEqual([
    ['critical', 'ContainerDown', 'synthetic-api', '3', '2 h ago', 'Waiting for a person'],
    ['warning', 'HighMemory', 'synthetic-worker', '1', '5 h ago', 'Stopped by the RCA spend budget'],
    ['info', 'DiskFilling', 'synthetic-db', '1', '2 days ago', 'Stopped by the RCA spend budget'],
  ]);
  expect(await firstCellClasses('parked')).toEqual(['tone-bad', 'tone-warn', null]);
  expect(await timelineItems('recent')).toEqual([
    ['2 h ago', 'ContainerDown', `Parked${DOT}synthetic-api${DOT}3 alerts`],
    ['3 h ago', 'ProbeFlapping', `Awaiting approval${DOT}synthetic-gateway`],
    ['4 h ago', 'CpuSaturated', `Approved, queued for RCA${DOT}synthetic-bot`],
    ['5 h ago', 'HighMemory', `Parked${DOT}synthetic-worker`],
    ['6 h ago', 'QueueStalled', `Being root-caused${DOT}synthetic-queue`],
  ]);
  const card = await page.locator('#av-root').textContent();
  for (const other of ['OtherQueueAlert', 'Synthetic build ticket', 'Synthetic other-queue incident']) expect(card).not.toContain(other);
  expect(await text('.av-btn.is-primary')).toBe('Open the self-healing queue');
  expect(await text('.av-escape-link')).toBe('Open Intelligent Processing in the cockpit');
  expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=intelligent-processing');
}

/** @description The full page stayed hidden and never started: header hidden, its figures and rows untouched, the card's read made once and the page's own read never. */
async function expectFullPageIdle(queueReads = 1) {
  expect(await visible('header')).toBe(false);
  expect(await visible('table:not(.av-table)')).toBe(false);
  expect(await text('#statBacklog')).toBe('0');
  expect(await text('#statTotal')).toBe('0');
  expect(await text('#updatedAt')).toBe('');
  expect(await page.locator('#rows tr').count()).toBe(0);
  expect(readCount(BACKLOG)).toBe(0);
  expect(readCount(QUEUE)).toBe(queueReads);
}

/** @description The full page ran as it always has: its backlog read answered, three parked rows grouped by fingerprint, their reasons stated, no audience view. */
async function expectFullPageRan() {
  expect(await page.locator('#av-root').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-audience'))).toBeNull();
  expect(await visible('header')).toBe(true);
  expect(await text('#statBacklog')).toBe('3');
  expect(await text('#statTotal')).toBe('3');
  expect(await page.locator('#rows tr').count()).toBe(3);
  expect(await page.locator('#rows tr td:nth-child(2)').allTextContents()).toEqual(['ContainerDown', 'HighMemory', 'DiskFilling']);
  expect(await page.locator('#rows .park-reason').first().textContent()).toContain('waiting for a person');
  expect(await page.locator('#rows .park-reason').nth(1).textContent()).toContain('the RCA spend budget was gone');
  expect(await page.locator('#rows button.primary').count()).toBe(3);
}

describe('Intelligent Processing audience view (ADR-164 D6)', () => {
  it('loads the kit right after the theme bootstrap, builds the card without innerHTML, and gates the page start', () => {
    const html = readFileSync(PAGE_FILE, 'utf8');
    const theme = html.indexOf('<script src="/shared/ui/js/surface-theme.js"></script>');
    expect(theme).toBeGreaterThan(-1);
    const after = html.slice(theme).split('\n').slice(1, 4).join('\n');
    expect(after).toContain('<link rel="stylesheet" href="/shared/ui/css/app-view.css" />');
    expect(after).toContain('<script src="/shared/ui/js/app-view.js"></script>');
    const block = html.slice(html.indexOf('/* Audience view (ADR-164 D6).'), html.indexOf("A.boot({ app: 'intelligent-processing'"));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toContain('innerHTML');
    expect(block).not.toMatch(/method\s*:/);
    expect(html).toMatch(/if \(!window\.AppView \|\| !AppView\.active\(\)\) \{\s*\$\('statusFilter'\)\.addEventListener\('change', load\);\s*\$\('refreshBtn'\)\.addEventListener\('click', load\);\s*load\(\);\s*setInterval\(load, 20000\);\s*\}/);
    expect(html.match(/setInterval\(/g)?.length).toBe(1);
  });

  it('company view paints the card from /api/tickets, writes nothing, reads nothing else, and never starts the full page or its poll', async () => {
    await page.clock.install();
    await openView('?audience=company');
    await expectCard('company');
    expect(offContract([`${PAGE_PATH}?audience=company`, QUEUE])).toEqual([]);
    for (const r of state.journal.filter(j => j.url === QUEUE)) expect(r.accept).toBe('application/json');
    await expectFullPageIdle();
    await page.clock.runFor(60000);
    await page.waitForTimeout(500);
    await expectFullPageIdle();
    expect(errors).toEqual([]);
  });

  it('family view paints the same card', async () => {
    await openView('?audience=family');
    await expectCard('family');
    expect(offContract([`${PAGE_PATH}?audience=family`, QUEUE])).toEqual([]);
    await expectFullPageIdle();
    expect(errors).toEqual([]);
  });

  it('an empty queue paints zeros and says why it is empty', async () => {
    state.tickets = state.tickets.filter(t => t.ticketType !== 'intelligent-processing');
    await openView('?audience=company');
    expect(await statValues()).toEqual({ parked: '0', approval: '0', pipeline: '0', complete: '0', alerts: '0' });
    expect((await statHints()).parked).toBe('An empty backlog is the normal state.');
    expect((await statHints()).alerts).toBe('No alert has opened a ticket yet.');
    expect(await page.locator('[data-stat="parked"]').getAttribute('class')).not.toContain('tone-warn');
    expect(await sectionIds()).toEqual(['parked', 'recent']);
    expect(await text('[data-section="parked"] .av-empty')).toContain('Nothing is parked. An empty backlog is the normal state');
    expect(await text('[data-section="recent"] .av-empty')).toBe('No alert has opened a ticket yet.');
    expect(offContract([`${PAGE_PATH}?audience=company`, QUEUE])).toEqual([]);
    await expectFullPageIdle();
    expect(errors).toEqual([]);
  });

  const REFUSALS: Array<{ kind: string; answer?: Answer; network?: boolean; said: string }> = [
    { kind: '401 signed-out', answer: { status: 401, body: { authenticated: false, error: 'unauthorized', loginPath: '/login' } }, said: 'You are not signed in (HTTP 401). Sign in, then open Intelligent Processing again.' },
    { kind: '403 operator gate', answer: { status: 403, body: { error: 'Operator privilege required' } }, said: 'Intelligent Processing refused this account (HTTP 403): it is open to operators only.' },
    { kind: '403 guest guard', answer: { status: 403, body: { error: 'guest_blocked', message: 'This app is not available in guest mode.', guest: true } }, said: 'Intelligent Processing refused this account (HTTP 403). This app is not available in guest mode.' },
    { kind: '403 refused', answer: { status: 403, body: { error: 'synthetic forbidden detail' } }, said: 'Intelligent Processing refused this account (HTTP 403).' },
    { kind: '404 not-found', answer: { status: 404, raw: 'Not found' }, said: 'Intelligent Processing did not answer on this core (HTTP 404).' },
    { kind: '500 server-error', answer: { status: 500, body: { error: 'Failed to list tickets' } }, said: 'Intelligent Processing failed to answer (HTTP 500).' },
    { kind: '503 unavailable', answer: { status: 503, raw: 'synthetic upstream unavailable' }, said: 'Intelligent Processing failed to answer (HTTP 503).' },
    { kind: 'network failure', network: true, said: 'Intelligent Processing could not be reached (network failure).' },
    { kind: 'malformed JSON', answer: { status: 200, raw: '{"tickets": [' }, said: 'Intelligent Processing answered with something that is not JSON.' },
    { kind: 'unreadable shape', answer: { status: 200, body: { tickets: 'synthetic-none' } }, said: 'Intelligent Processing answered in a shape this view cannot read.' },
    { kind: 'unreadable ticket', answer: { status: 200, body: { tickets: ['synthetic-string-ticket'], count: 1 } }, said: 'Intelligent Processing answered in a shape this view cannot read.' },
  ];

  it.each(REFUSALS)('says a $kind refusal in the card with no stat in its place', async ({ answer, network, said }) => {
    if (answer) state.queue = answer;
    if (network) await page.route(u => u.pathname === QUEUE && u.search === '', route => route.abort('failed'));
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe(said);
    expect(await page.locator('#av-root .av-stat').count()).toBe(0);
    expect(await page.locator('#av-root [data-section]').count()).toBe(0);
    const card = await page.locator('#av-root').textContent();
    for (const leak of ['synthetic forbidden detail', 'Failed to list tickets', 'synthetic upstream unavailable', 'synthetic-none', 'synthetic-string-ticket']) expect(card).not.toContain(leak);
    expect(await page.locator('.av-btn', { hasText: 'Try again' }).count()).toBe(1);
    expect(await text('.av-btn.is-primary')).toBe('Open the self-healing queue');
    expect(await page.locator('.av-escape-link').getAttribute('href')).toBe('/cockpit/?app=intelligent-processing');
    expect(offContract([`${PAGE_PATH}?audience=company`, QUEUE])).toEqual([]);
    // An aborted read never reaches the server; every other refusal is the card's one read.
    await expectFullPageIdle(network ? 0 : 1);
    expect(errors).toEqual([]);
  });

  it('paints the figures once a refused read answers and the reader tries again', async () => {
    state.queue = { status: 503, body: { error: 'synthetic outage' } };
    await openView('?audience=company', '#av-root .av-lede');
    expect(await text('.av-lede')).toBe('Intelligent Processing failed to answer (HTTP 503).');
    state.queue = { status: 200 };
    await page.locator('.av-btn', { hasText: 'Try again' }).click();
    await page.waitForSelector('#av-root .av-stat');
    expect((await statValues()).parked).toBe('3');
    expect(readCount(QUEUE)).toBe(2);
    expect(readCount(BACKLOG)).toBe(0);
    expect(errors).toEqual([]);
  });

  it('the primary action leaves the view for the full page in the same frame', async () => {
    await page.goto(`${origin}/fixture/host`);
    const frame = page.frameLocator('#host-frame');
    await frame.locator('#av-root .av-stat').first().waitFor();
    const framed = page.frames().find(f => f.url().includes(`${PAGE_PATH}?audience=company`));
    expect(framed).toBeTruthy();
    await frame.locator('.av-btn.is-primary').click();
    await frame.locator('#updatedAt', { hasText: 'updated' }).waitFor();
    await page.waitForLoadState('networkidle');
    const at = new URL(framed!.url());
    expect(at.pathname + at.search).toBe(PAGE_PATH);
    expect(new URL(page.url()).pathname).toBe('/fixture/host');
    expect(await frame.locator('#av-root').count()).toBe(0);
    expect(await frame.locator('#statBacklog').textContent()).toBe('3');
    expect(await frame.locator('#rows tr').count()).toBe(3);
    expect(offContract(['/fixture/host', `${PAGE_PATH}?audience=company`, PAGE_PATH, QUEUE, BACKLOG])).toEqual([]);
    // The card read the queue once; the full page it opened made its own backlog read.
    expect(readCount(QUEUE)).toBe(1);
    expect(readCount(BACKLOG)).toBe(1);
    expect(errors).toEqual([]);
  });

  it.each([
    { name: 'without an audience', query: '', kit: true },
    { name: 'with ?audience=classroom, which this page does not provide', query: '?audience=classroom', kit: true },
    { name: 'on a core without the kit', query: '?audience=company', kit: false },
  ])('starts the full page exactly as before $name, poll included', async ({ query, kit }) => {
    state.kit = kit;
    await page.clock.install();
    await page.goto(`${origin}${PAGE_PATH}${query}`);
    await page.locator('#updatedAt', { hasText: 'updated' }).waitFor();
    await page.waitForLoadState('networkidle');
    await expectFullPageRan();
    expect(readCount(BACKLOG)).toBe(1);
    expect(readCount(QUEUE)).toBe(0);
    const polled = page.waitForResponse(r => r.url() === `${origin}${BACKLOG}`);
    await page.clock.runFor(20000);
    await polled;
    await expect.poll(() => readCount(BACKLOG)).toBe(2);
    expect(readCount(QUEUE)).toBe(0);
    expect(offContract([`${PAGE_PATH}${query}`, BACKLOG])).toEqual([]);
    expect(errors).toEqual([]);
  });
});

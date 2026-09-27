/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the central assistant's gap closure over existing contracts. Kit level (injected fetch): a refused /ask carries the route's machine code, a done payload passes only well-formed `dispatched` items and the tool proposal through, an abort ends the wait with no further polls and drops a completion that lands after it, transcription envelopes fold into text / unconfigured / empty / failed from a multipart `audio` upload, and the delivered and ticket-cancel helpers hit their routes. Browser level (headless Chromium through the real static routes over the synthetic fixture): typed result cards (owner-checked visual by kind, '/'-only handoffs, provider fallback, approval card pointing at the Jarvis page), untrusted and refused visuals, partial background work tracked to settlement with delivered-once marking, files and cancel plus refusal, setup-needed and failed states with readback offered on each, the stale-completion guard across Stop / New / Home, and push-to-talk dictation that fills the composer without sending, labels not-set-up / empty / failed / denied honestly and never drives the core.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | A protocol-relative hand-off target (//host/x) is never linked, the same as an absolute one
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Integration review: hostile hand-offs the browser would resolve off this origin ('/<TAB>/host', '/\host') are never linked and every anchor resolves same-origin; the client has no delivered marking and the page sends no POST .../delivered while tracking background work; reaching the poll limit (maxPolls/pollMs injected into LIVE.ask) is "Still running", never FAILED, and counts checks without an outcome; a request stopped before the swarm answered the send never reads "Not accepted".
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startExperienceBrowserFixture } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

const require = createRequire(import.meta.url);
const LIVE = require('../../src/experience/live-data.js') as Record<string, any>;

type Reply = { status: number; body?: unknown };
type Call = { method: string; url: string; init: RequestInit };
/** @description A fetch double keyed by method + path prefix that keeps the raw init (signal, FormData) for assertions. */
function fakeFetch(routes: Record<string, Reply | ((call: Call) => Reply)>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const call = { method: String(init.method || 'GET'), url, init }; calls.push(call);
    const key = Object.keys(routes).find(k => `${call.method} ${url}`.startsWith(k));
    const reply = key ? (typeof routes[key] === 'function' ? (routes[key] as (c: Call) => Reply)(call) : routes[key] as Reply) : { status: 404, body: { error: 'missing' } };
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => { if (reply.body === undefined) throw new Error('no body'); return reply.body; } } as Response;
  };
  return { fetch, calls };
}
const memoryStorage = () => { const map = new Map<string, string>([['jarvisSessionId', 'jarvis-kit']]); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } }; };
const client = (routes: Parameters<typeof fakeFetch>[0]) => { const f = fakeFetch(routes); return { api: LIVE.createClient({ fetch: f.fetch, storage: memoryStorage() }), calls: f.calls }; };

describe('central-assistant kit helpers over an injected fetch', () => {
  it('carries the route code on a refused ask and passes only well-formed hand-offs and the tool proposal through a done payload', async () => {
    const refused = client({ 'POST /api/jarvis/ask': { status: 503, body: { error: 'ai_disabled', code: 'ai_disabled', message: 'AI features are disabled on this deployment.' } } });
    expect(await refused.api.ask('x')).toMatchObject({ status: 'error', httpStatus: 503, code: 'ai_disabled', error: 'AI features are disabled on this deployment.' });
    const proposal = { id: 'p1', app: 'ledger', toolName: 'post_entry', label: 'Synthetic post', mode: 'ask', input: {}, expiresAt: '2099-01-01T00:00:00Z' };
    const done = client({ 'POST /api/jarvis/ask': { status: 202, body: { jobId: 'j1' } }, 'GET /api/jarvis/ask/result?jobId=j1': { status: 200, body: { status: 'done', answer: 'ok', dispatched: [{ workJobId: 'w1', title: 'Synthetic work' }, { title: 'no id' }, null, { workJobId: '' }], packageToolProposal: proposal } } });
    const result = await done.api.ask('x', { sleep: async () => {} });
    expect(result.dispatched).toEqual([{ workJobId: 'w1', title: 'Synthetic work' }]);
    expect(result.packageToolProposal).toEqual(proposal);
    const plain = client({ 'POST /api/jarvis/ask': { status: 202, body: { jobId: 'j2' } }, 'GET /api/jarvis/ask/result?jobId=j2': { status: 200, body: { status: 'done', answer: 'ok' } } });
    expect(await plain.api.ask('x', { sleep: async () => {} })).toMatchObject({ dispatched: [], packageToolProposal: null });
  });

  it('ends the wait on abort: the sleep wakes at once, nothing polls again, and a completion that lands after the abort is dropped', async () => {
    const controller = new AbortController();
    const slow = client({ 'POST /api/jarvis/ask': { status: 202, body: { jobId: 'j' } }, 'GET /api/jarvis/ask/result?jobId=j': { status: 200, body: { status: 'pending' } } });
    const started = Date.now();
    const result = await slow.api.ask('x', { signal: controller.signal, pollMs: 60000, onPhase: (p: { phase: string }) => { if (p.phase === 'waiting') controller.abort(); } });
    expect(result).toMatchObject({ status: 'aborted', jobId: 'j' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(slow.calls.filter(c => c.url.startsWith('/api/jarvis/ask/result'))).toHaveLength(1);
    expect(slow.calls.every(c => c.init.signal)).toBe(true);
    const late = new AbortController();
    const racing = client({ 'POST /api/jarvis/ask': { status: 202, body: { jobId: 'k' } }, 'GET /api/jarvis/ask/result?jobId=k': () => { late.abort(); return { status: 200, body: { status: 'done', answer: 'Synthetic late answer' } }; } });
    expect(await racing.api.ask('x', { signal: late.signal, sleep: async () => {} })).toMatchObject({ status: 'aborted' });
    const before = new AbortController(); before.abort();
    const never = client({ 'POST /api/jarvis/ask': { status: 202, body: { jobId: 'n' } } });
    expect(await never.api.ask('x', { signal: before.signal })).toMatchObject({ status: 'aborted' });
    expect(never.calls.some(c => c.url.includes('/ask/result'))).toBe(false);
  });

  it('reads the transcription envelope into text, not set up, empty and failed, from a multipart upload named audio', async () => {
    const blob = new Blob([new Uint8Array(16)], { type: 'audio/webm' });
    const cases: Array<[Reply | null, Record<string, unknown>]> = [
      [{ status: 200, body: { success: true, data: { providerId: 's', text: '  Synthetic words ' } } }, { outcome: 'text', text: 'Synthetic words' }],
      [{ status: 200, body: { success: true, data: { providerId: 'unavailable', fallback: 'unconfigured', message: 'x' } } }, { outcome: 'unconfigured', fallback: 'unconfigured' }],
      [{ status: 200, body: { success: true, data: { providerId: 'browser', fallback: 'browser' } } }, { outcome: 'unconfigured', fallback: 'browser' }],
      [{ status: 200, body: { success: true, data: { providerId: 's', text: '' } } }, { outcome: 'empty', text: '' }],
      [{ status: 200, body: { success: true, data: { providerId: 's', fallback: 'failed', message: 'quota' } } }, { outcome: 'failed', fallback: 'failed' }],
      [{ status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'File type not allowed' } } }, { outcome: 'failed', status: 400 }],
    ];
    for (const [reply, expected] of cases) {
      const kit = client({ 'POST /api/voice/transcribe': reply as Reply });
      expect(await kit.api.transcribe(blob, { filename: 'speech.webm' })).toMatchObject(expected);
      const form = kit.calls[0].init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect((form.get('audio') as File).name).toBe('speech.webm');
    }
    const offline = LIVE.createClient({ fetch: async () => { throw new Error('offline'); }, storage: memoryStorage() });
    expect(await offline.transcribe(blob)).toMatchObject({ outcome: 'failed', status: 0 });
  });

  it('cancels a hand-off ticket through its own route, returns the refusal with its status, and offers no delivered marking', async () => {
    const kit = client({ 'PUT /api/tickets/t-1/cancel': { status: 200, body: { success: true, status: 'cancelled', ticketId: 't-1' } }, 'PUT /api/tickets/t-2/cancel': { status: 404, body: { error: 'Ticket not found' } } });
    // The Jarvis page is the one surface that announces and marks results; the kit has no way to send POST .../delivered.
    expect(kit.api.packages.jarvis.markDelivered).toBeUndefined();
    expect(await kit.api.packages.jarvis.cancelWork('t-1')).toMatchObject({ ok: true, body: { status: 'cancelled' } });
    expect(await kit.api.packages.jarvis.cancelWork('t-2')).toMatchObject({ ok: false, status: 404 });
    expect(kit.calls.map(c => `${c.method} ${c.url}`)).toEqual(['PUT /api/tickets/t-1/cancel', 'PUT /api/tickets/t-2/cancel']);
    expect(kit.calls.some(c => c.url.endsWith('/delivered'))).toBe(false);
  });

  it('reports the poll limit as its own code, not a failure the page must name as one', async () => {
    const slow = client({ 'POST /api/jarvis/ask': { status: 202, body: { jobId: 'p' } }, 'GET /api/jarvis/ask/result?jobId=p': { status: 200, body: { status: 'pending' } } });
    expect(await slow.api.ask('x', { maxPolls: 2, sleep: async () => {} })).toMatchObject({ status: 'error', code: 'poll_limit', jobId: 'p', error: expect.stringContaining('may still finish') });
    expect(slow.calls.filter(c => c.url.startsWith('/api/jarvis/ask/result'))).toHaveLength(2);
  });
});

interface NexusLane {
  askRefusal: null | { status: number; body: Record<string, unknown> }; refusedAsks: number;
  hold: Set<string>; results: Record<string, Record<string, unknown>>; polls: Record<string, number>;
  cancels: string[]; cancelStatus: Record<string, number>; visualStatus: number;
  transcribe: { status: number; body: unknown }; uploads: Array<{ contentType: string; audioField: boolean; partType: string; bytes: number }>;
}
let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
const errors: string[] = [];
const lane = () => (fixture.state as unknown as { nexusGap: NexusLane }).nexusGap;
const VISUAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VISUAL = { artifactId: VISUAL_ID, type: 'image', kind: 'agenda', url: `/api/jarvis/visuals/${VISUAL_ID}`, mimeType: 'image/svg+xml', alt: 'Synthetic agenda for today', width: 40, height: 20, createdAt: '2026-09-27T00:00:00Z', provenance: {} };

/** @description Script the default /ask/result terminal payload (the fixture types it narrowly; extra typed fields are the point here). */
function setResult(result: Record<string, unknown>, polls = 0) { Object.assign(fixture.state.ask, { polls, result }); }
/** @description Add synthetic shelf rows the way GET /api/jarvis/tasks returns them. */
const taskRows = () => fixture.state.tasks as unknown as Array<Record<string, unknown>>;
async function open() {
  errors.length = 0;
  page.on('pageerror', e => errors.push(String(e && (e as Error).message || e)));
  await page.goto(fixture.origin + '/nexus');
  await page.waitForSelector('#intent-input');
}
async function ask(text: string) { await page.fill('#intent-input', text); await page.press('#intent-input', 'Enter'); }
const waitMode = (mode: string, timeout = 20000) => page.waitForFunction(m => document.querySelector('.mode-indicator')?.textContent === m, mode, { timeout });
const text = (selector: string) => page.locator(selector).first().innerText();
/** @description Every anchor whose href the browser resolves off the page origin (its own resolution: tab stripping, backslash as slash). */
const offOrigin = () => page.evaluate(() => Array.from(document.querySelectorAll('a')).filter(a => new URL(a.href, location.href).origin !== location.origin).map(a => a.getAttribute('href')));
/** @description POST .../delivered requests the page sent, from the fixture's request log. */
const deliveredPosts = () => fixture.state.calls.filter(c => c.startsWith('POST ') && c.endsWith('/delivered'));

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  fixture = await startExperienceBrowserFixture();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    // window.speechSynthesis is a read-only accessor: a plain assignment leaves the real engine in place.
    Object.defineProperty(window, 'speechSynthesis', { value: { speak() {}, cancel() {}, getVoices() { return []; } }, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: function SpeechSynthesisUtterance() {}, configurable: true });
    // No real microphone: a stub stream and recorder that hand back one synthetic clip typed the way Chromium reports it.
    const w = window as unknown as { __micDenied?: boolean; __tracksStopped?: number };
    w.__tracksStopped = 0;
    const stream = { getTracks: () => [{ stop: () => { w.__tracksStopped = (w.__tracksStopped || 0) + 1; } }] };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { if (w.__micDenied) throw new DOMException('Permission denied', 'NotAllowedError'); return stream; } } });
    class StubRecorder {
      mimeType = 'audio/webm;codecs=opus'; state = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null; onstop: (() => void) | null = null;
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; setTimeout(() => { if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) }); if (this.onstop) this.onstop(); }, 20); }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: StubRecorder });
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
});
afterEach(async () => { await context?.close(); await fixture?.close(); });

describe('central assistant gap closure in Chromium over the real routes', () => {
  it('renders the typed result fields: the owner-checked visual by kind, "/"-only handoffs, the provider that answered and an approval card pointing at the Jarvis page', async () => {
    setResult({ status: 'done', answer: 'Synthetic typed answer.', files: [], taskId: 'task-9', dispatched: [], visual: VISUAL,
      handoffs: [{ name: 'Synthetic ledger', deepLink: '/cockpit/?app=ledger' }, { name: 'Synthetic outside', deepLink: 'https://outside.example/x' }, { name: 'Synthetic relative', deepLink: '//outside.example/y' },
        // The browser strips a tab and reads a backslash as a slash, so both of these resolve to outside.example.
        { name: 'Synthetic tab split', deepLink: '/\t/outside.example/z' }, { name: 'Synthetic backslash', deepLink: '/\\outside.example/w' }],
      brainFallback: { providerUsed: 'Synthetic Provider', rung: 2, chainSource: 'fleet-default', failedEndpoint: { host: 'synthetic.host', model: 'synthetic-model' }, attempts: 2, failure: 'rate-limit' },
      packageToolProposal: { id: 'p1', app: 'ledger', toolName: 'post_entry', label: 'Synthetic post entry', mode: 'ask', input: { amount: 1 }, expiresAt: new Date(Date.now() + 600000).toISOString() } });
    await open(); await ask('Show me the typed answer');
    await waitMode('LIVE ANSWER');
    const img = page.locator('.result-visual img');
    expect(await img.getAttribute('src')).toBe(VISUAL.url);
    expect(await img.getAttribute('alt')).toBe('Synthetic agenda for today');
    expect(await text('.result-visual figcaption')).toContain('VISUAL · AGENDA');
    await page.waitForFunction(() => { const i = document.querySelector('.result-visual img') as HTMLImageElement | null; return Boolean(i && i.complete && i.naturalWidth > 0); });
    expect(await page.locator('.workspace-body a[href="/cockpit/?app=ledger"]').count()).toBeGreaterThan(0);
    expect(await page.locator('a[href^="https://outside"]').count()).toBe(0);
    // A protocol-relative target (//host/x) leaves the swarm just like an absolute one: never linked.
    expect(await page.locator('a[href^="//"]').count()).toBe(0);
    expect(await page.locator('a[href*="outside.example"]').count()).toBe(0);
    expect(await offOrigin()).toEqual([]);
    expect(await text('.provider-note')).toContain('Answered by Synthetic Provider');
    const card = page.locator('[data-part="proposal"]');
    expect(await card.innerText()).toMatch(/APPROVAL NEEDED[\s\S]*Synthetic post entry[\s\S]*Synthetic ledger · tool post_entry/);
    expect(await card.innerText()).toContain('This page cannot approve or run application tools.');
    expect(await card.locator('a').getAttribute('href')).toBe('/api/jarvis/');
    const ledger = await text('.action-ledger');
    expect(ledger).toMatch(/request progress/i); expect(ledger).toContain('5 application handoffs'); expect(ledger).toContain('Answered by Synthetic Provider');
    expect(ledger).toContain('Answer received, with a visual (Agenda).');
    expect(ledger).not.toMatch(/tool activity/i);
    await page.getByRole('tab', { name: 'Applications' }).click();
    expect(await page.locator('.workspace-body a[href^="https://"]').count()).toBe(0);
    expect(await text('.workspace-body')).toContain('Synthetic outside');
    expect(await text('.workspace-body')).toContain('Synthetic tab split'); expect(await text('.workspace-body')).toContain('Synthetic backslash');
    expect(await page.locator('.workspace-body a[href*="outside.example"]').count()).toBe(0);
    expect(await offOrigin()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('never renders an untrusted visual and says so when the owner-checked image route refuses one', async () => {
    setResult({ status: 'done', answer: 'Synthetic answer with a stray image.', handoffs: [], files: [], dispatched: [], visual: { ...VISUAL, url: '/api/elsewhere/image.svg' } });
    await open(); await ask('first');
    await waitMode('LIVE ANSWER');
    expect(await page.locator('.result-visual').count()).toBe(0);
    expect(await page.locator('img').count()).toBe(0);
    lane().visualStatus = 404;
    setResult({ status: 'done', answer: 'Synthetic answer with a refused image.', handoffs: [], files: [], dispatched: [], visual: VISUAL });
    await page.locator('.mission-actions [data-action="new"]').click();
    await ask('second');
    await waitMode('LIVE ANSWER');
    await page.waitForFunction(() => document.querySelector('.result-visual')?.textContent?.includes('could not be loaded'));
    expect(await text('.workspace-body')).toContain('Synthetic answer with a refused image.');
  });

  it('tracks handed-off work on the task list until it settles, offers its files, cancels or reports the refusal, and never marks anything delivered', async () => {
    const now = new Date().toISOString();
    taskRows().push({ id: 'work-a', title: 'Synthetic build A', status: 'queued', kind: 'complex', ticketId: 'ticket-a', createdAt: now },
      { id: 'work-b', title: 'Synthetic build B', status: 'running', kind: 'complex', ticketId: 'ticket-b', createdAt: now });
    lane().cancelStatus['ticket-b'] = 404;
    setResult({ status: 'done', answer: 'Synthetic: I handed both builds to the swarm.', handoffs: [], files: [],
      dispatched: [{ workJobId: 'work-a', title: 'Synthetic build A' }, { workJobId: 'work-b', title: 'Synthetic build B' }, { title: 'malformed' }] });
    await open(); await ask('Build two things');
    await waitMode('ANSWER READY · WORK CONTINUING');
    await page.waitForSelector('[data-work="work-a"][data-status="queued"]');
    await page.waitForSelector('[data-work="work-b"][data-status="running"]');
    expect(await page.locator('.work-item').count()).toBe(2);
    expect(await text('.action-ledger')).toContain('Background work · Synthetic build A');
    await page.locator('[data-work="work-a"] [data-action="cancel-work"]').click();
    await page.waitForFunction(() => document.querySelector('[data-work="work-a"]')?.textContent?.includes('Cancel accepted'));
    await page.locator('[data-work="work-b"] [data-action="cancel-work"]').click();
    await page.waitForFunction(() => document.querySelector('[data-work="work-b"]')?.textContent?.includes('Cancel refused: the ticket was not found'));
    expect(lane().cancels).toEqual(['ticket-a', 'ticket-b']);
    Object.assign(taskRows().find(t => t.id === 'work-b')!, { status: 'done', result: 'Synthetic build B finished.', files: [{ name: 'build-b.txt', downloadUrl: '/api/jarvis/files/build-b', bytes: 5 }] });
    await waitMode('LIVE ANSWER', 20000);
    expect(await page.locator('[data-work="work-b"] a[href="/api/jarvis/files/build-b"]').count()).toBe(1);
    expect(await text('[data-work="work-a"]')).toContain('This one was cancelled before it finished.');
    expect(await text('[data-work="work-a"]')).toContain('Did not finish');
    // Settled items stay unannounced here: the Jarvis page is the one surface that announces and marks results.
    await page.waitForTimeout(3500);
    expect(deliveredPosts()).toEqual([]);
    expect(await text('[data-part="work"]')).not.toMatch(/delivered/i);
    expect(await page.locator('[data-action="cancel-work"]').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('shows setup-needed for the job code and the ai_disabled refusal, failed otherwise, and offers readback on every terminal text', async () => {
    const readback = async () => {
      await page.locator('.readback-button').first().click();
      await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent?.includes('BROWSER VOICE'));
      await page.locator('.readback-button').first().click();
    };
    const fresh = () => page.locator('.mission-actions [data-action="new"]').click();
    setResult({ status: 'error', error: 'Jarvis has no AI engine connected — add one under Settings → Connections → Bring Your Own LLM.', code: 'NO_HOSTED_BRAIN' });
    await open(); await ask('hello');
    await waitMode('SETUP NEEDED');
    expect(await text('.loading-body')).toContain('Jarvis needs setup before it can answer.');
    expect(await text('.loading-body')).toContain('Bring Your Own LLM');
    expect(await text('.action-ledger')).toContain('Setup needed');
    await readback();
    await fresh();
    lane().askRefusal = { status: 503, body: { error: 'ai_disabled', code: 'ai_disabled', message: 'AI features are disabled on this deployment. Connect a model or remove OSHAL_NO_AI=true.' } };
    await ask('hello again');
    await waitMode('SETUP NEEDED');
    expect(await text('.loading-body')).toContain('AI features are disabled on this deployment.');
    expect(await text('.action-ledger')).toContain('Refused with HTTP 503');
    await readback();
    await fresh();
    lane().askRefusal = { status: 503, body: { error: 'Synthetic capacity refusal' } };
    await ask('a 503 without the code');
    await waitMode('FAILED');
    expect(await text('.loading-body')).toContain('Synthetic capacity refusal');
    await fresh();
    lane().askRefusal = null;
    setResult({ status: 'error', error: 'Synthetic tool failure' });
    await ask('fails in the job');
    await waitMode('FAILED');
    expect(await text('.assistant-message')).toContain('Synthetic tool failure');
    await readback();
    expect(lane().refusedAsks).toBe(2);
    expect(errors).toEqual([]);
  });

  it('never lets a stopped, restarted or abandoned request reopen or overwrite the workspace, and releases the composer at once', async () => {
    const answer = (a: string) => ({ status: 'done', answer: a, handoffs: [], files: [], dispatched: [] });
    const releaseAndWait = async (job: string) => { await page.waitForTimeout(300); const at = lane().polls[job]; lane().hold.delete(job); await page.waitForTimeout(3500); expect(lane().polls[job]).toBe(at); };
    await open();
    lane().hold.add('job-1'); lane().results['job-1'] = answer('Synthetic stale answer A');
    await ask('first');
    await expect.poll(() => lane().polls['job-1'] || 0).toBeGreaterThan(0);
    await page.locator('.mission-actions [data-action="stop"]').click();
    await waitMode('STOPPED WAITING');
    expect(await page.locator('#intent-input').isDisabled()).toBe(false);
    await releaseAndWait('job-1');
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('Synthetic stale answer A');
    expect(await text('.mode-indicator')).toBe('STOPPED WAITING');
    expect(await text('.mode-indicator')).not.toMatch(/cancel/i);

    lane().hold.add('job-2'); lane().results['job-2'] = answer('Synthetic stale answer B');
    await ask('second');
    await expect.poll(() => lane().polls['job-2'] || 0).toBeGreaterThan(0);
    await page.locator('.rail [data-action="new"]').click();
    await page.waitForSelector('.welcome');
    expect(await page.locator('#intent-input').isDisabled()).toBe(false);
    await releaseAndWait('job-2');
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('Synthetic stale answer B');
    expect(await page.locator('.welcome').count()).toBe(1);

    lane().hold.add('job-3'); lane().results['job-3'] = answer('Synthetic stale answer C');
    await ask('third');
    await expect.poll(() => lane().polls['job-3'] || 0).toBeGreaterThan(0);
    await page.locator('.rail [data-action="home"]').click();
    await page.waitForSelector('.welcome');
    expect(await page.locator('#intent-input').isDisabled()).toBe(false);
    await releaseAndWait('job-3');
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('Synthetic stale answer C');
    await page.getByRole('button', { name: 'Back to the stopped request' }).click();
    await waitMode('STOPPED WAITING');

    await ask('fourth');
    await waitMode('LIVE ANSWER');
    const body = await page.evaluate(() => document.body.innerText);
    expect(body).toContain('Synthetic answer');
    expect(body).not.toMatch(/Synthetic stale answer [ABC]/);
    expect(errors).toEqual([]);
  });

  it('reaching the poll limit is "Still running": the page stopped checking and the job may still finish, never FAILED', async () => {
    // Inject maxPolls/pollMs into the page's LIVE.ask (the adapter's own config seam) so the limit arrives in three quick checks.
    await page.addInitScript(() => {
      let live: unknown;
      Object.defineProperty(window, 'OSHAL_LIVE', { configurable: true, get: () => live, set: (api: Record<string, any>) => {
        live = new Proxy(api, { get: (target, key) => key === 'ask' ? (message: string, config: Record<string, unknown>) => target.ask(message, { ...config, maxPolls: 3, pollMs: 10 }) : Reflect.get(target, key) });
      } });
    });
    await open();
    lane().hold.add('job-1');
    await ask('a long job');
    await waitMode('STILL RUNNING · STOPPED CHECKING');
    expect(lane().polls['job-1']).toBe(3);
    const body = await text('.loading-body');
    expect(body).toContain('STILL RUNNING · THIS PAGE STOPPED CHECKING'); expect(body).toContain('The job may still finish'); expect(body).toContain('check Jarvis later');
    expect(body).not.toMatch(/FAILED|did not work/i);
    expect(await page.locator('.loading-body a[href="/api/jarvis/"]').count()).toBe(1);
    const ledger = await text('.action-ledger');
    expect(ledger).toContain('Checked 3 times without an outcome.'); expect(ledger).toContain('Still running');
    expect(ledger).not.toMatch(/Request failed|while the job was still running/);
    expect(await page.locator('.ledger-step[data-mark="failed"]').count()).toBe(0);
    await page.locator('.rail [data-action="home"]').click();
    await page.getByRole('button', { name: 'Back to the request still running' }).click();
    await waitMode('STILL RUNNING · STOPPED CHECKING');
    expect(errors).toEqual([]);
  });

  it('a request stopped before the swarm answered the send says so, never "Not accepted"', async () => {
    // The send never reaches the swarm: the POST is held at the browser, so no job id ever comes back.
    await page.route('**/api/jarvis/ask', () => { /* held until the page aborts it */ });
    await open();
    await ask('held at the send');
    await waitMode('WORKING');
    await page.locator('.mission-actions [data-action="stop"]').click();
    await waitMode('STOPPED WAITING');
    const ledger = await text('.action-ledger');
    expect(ledger).toContain('This page stopped waiting before the swarm’s reply to the send arrived.');
    expect(ledger).not.toContain('Not accepted');
    expect(fixture.state.asks).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('push-to-talk fills the composer without sending, labels not set up, empty, failed and denied honestly, and never drives the core', async () => {
    const talk = async () => { await page.locator('.mic-button').click(); await page.waitForFunction(() => document.querySelector('.mic-button')?.getAttribute('aria-pressed') === 'true'); await page.locator('.mic-button').click(); };
    const status = (fragment: string) => page.waitForFunction(f => document.querySelector('.mic-status')?.textContent?.includes(f), fragment);
    const draft = () => page.locator('#intent-input').inputValue();
    await open();
    await page.getByRole('button', { name: 'Motion off' }).click();
    await page.fill('#intent-input', 'Please');
    await page.locator('.mic-button').click();
    await page.waitForFunction(() => document.querySelector('.mic-button')?.getAttribute('aria-pressed') === 'true');
    await page.waitForTimeout(700);
    expect(await page.locator('#core-canvas').getAttribute('data-energy')).toBe('0.000');
    expect(await page.locator('#core-canvas').getAttribute('data-scatter')).toBe('0.000');
    await page.locator('.mic-button').click();
    await status('Transcribed');
    expect(await draft()).toBe('Please Synthetic spoken request');
    expect(fixture.state.asks).toHaveLength(0);
    expect(lane().uploads[0]).toMatchObject({ audioField: true, partType: 'audio/webm' });
    expect(lane().uploads[0].contentType).toContain('multipart/form-data');
    expect(await page.evaluate(() => (window as unknown as { __tracksStopped: number }).__tracksStopped)).toBeGreaterThan(0);
    expect(await page.locator('#core-canvas').getAttribute('data-energy')).toBe('0.000');

    lane().transcribe = { status: 200, body: { success: true, data: { providerId: 'unavailable', fallback: 'unconfigured', message: 'Requested STT provider is not configured' } } };
    await talk(); await status('Server transcription is not set up on this deployment');
    lane().transcribe = { status: 200, body: { success: true, data: { providerId: 'synthetic-stt', text: '' } } };
    await talk(); await status('No words were recognised');
    lane().transcribe = { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'File type not allowed' } } };
    await talk(); await status('Transcription failed (HTTP 400)');
    expect(await draft()).toBe('Please Synthetic spoken request');
    const uploads = lane().uploads.length;
    await page.evaluate(() => { (window as unknown as { __micDenied: boolean }).__micDenied = true; });
    await page.locator('.mic-button').click();
    await status('Microphone access was denied');
    expect(await page.locator('.mic-button').getAttribute('aria-pressed')).toBe('false');
    expect(lane().uploads).toHaveLength(uploads);
    expect(fixture.state.asks).toHaveLength(0);
    expect(errors).toEqual([]);
  });
});

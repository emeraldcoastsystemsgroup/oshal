/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Simple chat (/simple, docs/architecture/simple-chat.md) in headless Chromium through the real static routes over the synthetic experience fixture: sign-in gate, first-run help that leaves after the first message, the box pinned at the bottom with the history above it, the history restored on reload, the Jarvis ask/poll round trip with the answer's links, Shift+Enter, refusals and failed jobs as rows, the expired-session retry, escape-first rendering and phone width.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startExperienceBrowserFixture } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
let defaultResult: Record<string, unknown>;
const errors: string[] = [];

async function newPage(viewport = { width: 900, height: 800 }) {
  context = await browser.newContext({ viewport });
  page = await context.newPage();
  page.on('pageerror', e => errors.push(String((e as Error).message || e)));
}
async function open() {
  await page.goto(fixture.origin + '/simple');
  await page.waitForSelector('.sc-input:not([disabled])');
}
async function sendText(text: string) { await page.fill('.sc-input', text); await page.press('.sc-input', 'Enter'); }
const answered = (n = 1) => page.waitForFunction(count => document.querySelectorAll('.sc-assistant, .sc-error').length >= count, n, { timeout: 20000 });
const apiCalls = () => fixture.state.calls.filter(c => c.includes(' /api/'));
const roles = () => page.locator('.sc-log .sc-turn').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.role));

beforeAll(async () => {
  fixture = await startExperienceBrowserFixture();
  defaultResult = { ...fixture.state.ask.result };
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); await fixture?.close(); });
beforeEach(async () => {
  errors.length = 0;
  Object.assign(fixture.state, { history: [] });
  fixture.state.asks.length = 0; fixture.state.calls.length = 0;
  Object.assign(fixture.state.ask, { status: 202, refuseFirst: false, polls: 0, result: { ...defaultResult } });
  await newPage();
});
afterEach(async () => { await context?.close(); });

describe('Simple chat over the real routes', () => {
  it('serves /simple and its page script only behind the real requiresAuth seat', async () => {
    const denied = await startExperienceBrowserFixture({ denyAuth: true });
    try {
      for (const path of ['/simple', '/simple/', '/experience/simple.js']) {
        expect((await fetch(denied.origin + path, { redirect: 'manual' })).status, path).toBe(401);
      }
    } finally { await denied.close(); }
    const res = await fetch(fixture.origin + '/simple');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('first visit: help with examples, the box pinned to the bottom, and only the Jarvis history read on load', async () => {
    await open();
    await page.waitForSelector('.sc-help:not([hidden])');
    expect(await page.locator('.sc-example').allInnerTexts()).toEqual(['What can you help me with?', 'What is on my calendar today?', 'Give me a short summary of my open work.']);
    expect(await page.locator('.sc-title').innerText()).toBe('Jarvis');
    const box = await page.locator('.sc-composer').boundingBox();
    expect(Math.round((box?.y || 0) + (box?.height || 0))).toBe(800);
    const main = await page.locator('.sc-main').boundingBox();
    expect((main?.y || 0) + (main?.height || 0)).toBeLessThanOrEqual((box?.y || 0) + 1);
    expect(apiCalls()).toEqual(['GET /api/jarvis/history']);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('sc-input'))).toBe(true);
    expect(errors).toEqual([]);
  });

  it('an example fills the box, Enter sends it, and the answer renders above the box with its links; help never returns', async () => {
    await open();
    await page.click('.sc-example >> nth=1');
    expect(await page.inputValue('.sc-input')).toBe('What is on my calendar today?');
    await page.press('.sc-input', 'Enter');
    await page.waitForSelector('.sc-thinking');
    expect(await page.locator('.sc-input').isDisabled()).toBe(true);
    await answered();
    expect(await roles()).toEqual(['user', 'assistant']);
    expect(await page.locator('.sc-user .sc-bubble').innerText()).toBe('What is on my calendar today?');
    const answer = page.locator('.sc-assistant .sc-bubble');
    expect(await answer.locator('strong').innerText()).toBe('ledger');
    expect(await answer.locator('li').allInnerTexts()).toEqual(['one', 'two']);
    const inlineLink = answer.locator('a', { hasText: 'Synthetic ledger' });
    expect(await inlineLink.getAttribute('href')).toBe('/cockpit/?app=ledger');
    expect(await inlineLink.getAttribute('target')).toBeNull();
    expect(await page.locator('.sc-assistant .sc-link').innerText()).toBe('Open Synthetic ledger ↗');
    const session = await page.evaluate(() => localStorage.getItem('jarvisSessionId'));
    expect(fixture.state.asks).toEqual([{ message: 'What is on my calendar today?', sessionId: session }]);
    expect(await page.locator('.sc-help').isHidden()).toBe(true);
    expect(await page.locator('.sc-input').isDisabled()).toBe(false);
    await page.reload(); await page.waitForSelector('.sc-input:not([disabled])');
    expect(await page.locator('.sc-help').isHidden()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('the conversation survives a reload, oldest first above the box, with no help over an existing thread', async () => {
    Object.assign(fixture.state, { history: [
      { role: 'user', text: 'Earlier question' },
      { role: 'jarvis', text: 'Earlier **answer**' },
      { role: 'jarvis', text: 'Here is your chart.', visual: { kind: 'chart' } },
    ] });
    await open();
    expect(await roles()).toEqual(['user', 'assistant', 'assistant']);
    expect(await page.locator('.sc-turn .sc-bubble').allInnerTexts()).toEqual(['Earlier question', 'Earlier answer', 'Here is your chart.']);
    const visual = page.locator('.sc-assistant >> nth=1').locator('.sc-link');
    expect(await visual.innerText()).toBe('Open Jarvis to see the picture');
    expect(await visual.getAttribute('href')).toBe('/api/jarvis/');
    expect(await page.locator('.sc-help').isHidden()).toBe(true);
    await page.click('[data-action="help"]');
    expect(await page.locator('.sc-help').isVisible()).toBe(true);
    await page.click('[data-action="dismiss-help"]');
    expect(await page.locator('.sc-help').isHidden()).toBe(true);
  });

  it('Shift+Enter starts a new line and an empty box sends nothing', async () => {
    await open();
    await page.click('.sc-input');
    await page.keyboard.type('line one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line two');
    expect(await page.inputValue('.sc-input')).toBe('line one\nline two');
    await page.fill('.sc-input', '   ');
    await page.press('.sc-input', 'Enter');
    await page.click('.sc-send');
    expect(fixture.state.asks).toEqual([]);
    expect(await page.locator('.sc-user').count()).toBe(0);
  });

  it('a refused ask is a row with the server\'s own message, and the box comes back', async () => {
    fixture.state.ask.status = 503;
    await open();
    await sendText('Hello');
    await answered();
    expect(await roles()).toEqual(['user', 'error']);
    expect(await page.locator('.sc-error .sc-bubble').innerText()).toBe('Synthetic assistant unavailable');
    expect(await page.locator('.sc-input').isDisabled()).toBe(false);
  });

  it('a job that fails or expires is said as it is, never answered for it', async () => {
    fixture.state.ask.result = { status: 'error', error: 'Synthetic job failed' } as unknown as typeof fixture.state.ask.result;
    await open();
    await sendText('Do the thing');
    await answered();
    expect(await page.locator('.sc-error .sc-bubble').innerText()).toBe('Synthetic job failed');
    fixture.state.ask.result = { status: 'expired' } as unknown as typeof fixture.state.ask.result;
    await sendText('Again');
    await answered(2);
    expect(await page.locator('.sc-error .sc-bubble >> nth=1').innerText()).toBe('That request expired before an answer arrived.');
    expect(await page.locator('.sc-assistant').count()).toBe(0);
  });

  it('an expired thread rolls to a fresh session once, as the Jarvis page does', async () => {
    fixture.state.ask.refuseFirst = true;
    await open();
    const before = await page.evaluate(() => localStorage.getItem('jarvisSessionId'));
    await sendText('Are you there?');
    await answered();
    expect(fixture.state.asks.length).toBe(2);
    expect(fixture.state.asks[0].sessionId).toBe(before);
    const after = await page.evaluate(() => localStorage.getItem('jarvisSessionId'));
    expect(after).not.toBe(before);
    expect(fixture.state.asks[1].sessionId).toBe(after);
    expect(await roles()).toEqual(['user', 'assistant']);
  });

  it('reply markup cannot inject: tags stay text and unsafe links are not links', async () => {
    fixture.state.ask.result = { ...defaultResult, handoffs: [], answer: '<img src=x onerror="window.__pwned=1"> [bad](javascript:alert(1)) [off](//evil.test/x) **ok**' } as unknown as typeof fixture.state.ask.result;
    await open();
    await sendText('Show me');
    await answered();
    const bubble = page.locator('.sc-assistant .sc-bubble');
    expect(await bubble.locator('img').count()).toBe(0);
    expect(await bubble.locator('a').count()).toBe(0);
    expect(await bubble.innerText()).toContain('<img src=x');
    expect(await bubble.locator('strong').innerText()).toBe('ok');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });

  it('phone width: the box stays at the bottom and nothing scrolls sideways', async () => {
    await context.close();
    await newPage({ width: 375, height: 700 });
    await open();
    const box = await page.locator('.sc-composer').boundingBox();
    expect(Math.round((box?.y || 0) + (box?.height || 0))).toBe(700);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await sendText('A short question from a phone');
    await answered();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});

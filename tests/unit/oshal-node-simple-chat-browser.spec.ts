/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | OSHAL Node Simple chat (docs/architecture/simple-chat.md): the node's REAL renderer files in headless Chromium (served over loopback so the page's own CSP applies) with only the desktop bridge stubbed. Proves the orb stays the default and unchanged, Simple chat shows the plain chat with first-run help and the box at the bottom, turns go over the bridge and replies land above the box without speech, history stays on this computer across a reload, failures are rows, worker events are notes, the Config setting swaps the window, and the node's kit copy is byte-identical to the shared kit. No window opens on the desktop.
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const RENDERER = resolve(process.cwd(), 'packages/oshal-chat/src/renderer');
let browser: Browser, context: BrowserContext, page: Page, server: Server, origin = '';
const errors: string[] = [];

type Call = [string, unknown];
type Probe = { __calls: Call[]; __spoken: string[]; __replyCb: (r: unknown) => void; __workerCb: (e: unknown) => void };

/** Open the renderer with a stubbed preload bridge: `cfg` is what getConfig returns; `failSend` makes sendChat reject. */
async function openNode(cfg: Record<string, unknown>, failSend = '') {
  context = await browser.newContext({ viewport: { width: 520, height: 760 } });
  await context.addInitScript(({ initial, fail }) => {
    const w = window as unknown as Record<string, unknown>;
    const calls: Array<[string, unknown]> = [], spoken: string[] = [];
    w.__calls = calls; w.__spoken = spoken;
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak: (u: { text?: string }) => { spoken.push(String(u && u.text)); }, cancel: () => undefined, getVoices: () => [], onvoiceschanged: null } });
    let config: Record<string, unknown> = { controlPlaneUrl: 'http://swarm.test', sharedSecret: 'fixture-secret', workerEnabled: true, fullJarvisEnabled: false, ...initial };
    const none = async () => undefined;
    w.oshal = {
      getConfig: async () => ({ ...config }),
      saveConfig: async (update: Record<string, unknown>) => { calls.push(['saveConfig', update]); config = { ...config, ...update }; return config; },
      sendChat: async (text: string) => { calls.push(['sendChat', text]); if (fail) throw new Error(fail); return { taskId: 't', correlationId: 'c' }; },
      onStatus: none, onReply: (cb: unknown) => { w.__replyCb = cb; }, onWorkerEvent: (cb: unknown) => { w.__workerCb = cb; }, onBackgroundWakeStatus: none,
      getBackgroundWakeStatus: async () => ({ enabled: false, state: 'off', detail: '' }), setBackgroundMicOwner: none,
      authStatus: async () => [], authSwarmStatus: async () => ({}), espnStatus: async () => ({ present: false }),
      openJarvis: async () => ({ ok: true }), minimizeWindow: none, closeWindow: none, openConnections: none,
    };
  }, { initial: cfg, fail: failSend });
  page = await context.newPage();
  page.on('pageerror', e => errors.push(String((e as Error).message || e)));
  await page.goto(origin + '/index.html');
}
const probe = <K extends keyof Probe>(key: K) => page.evaluate(k => (window as unknown as Record<string, unknown>)[k], key) as Promise<Probe[K]>;
const reply = (payload: Record<string, unknown>) => page.evaluate(p => (window as unknown as Probe).__replyCb(p), payload);
const workerEvent = (payload: Record<string, unknown>) => page.evaluate(p => (window as unknown as Probe).__workerCb(p), payload);
const roles = () => page.locator('#chatView .sc-turn').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.role));
async function sendText(text: string) { await page.fill('#node-chat-input', text); await page.press('#node-chat-input', 'Enter'); }

beforeAll(async () => {
  const app = express();
  app.use(express.static(RENDERER));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', () => done()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>(done => server.close(() => done()));
});
afterEach(async () => { await context?.close(); errors.length = 0; });

describe('OSHAL Node: Simple chat window', () => {
  it('keeps the voice orb as the default and unchanged: no setting means the orb, a typed turn is spoken back, and the chat is never drawn', async () => {
    await openNode({});
    await page.waitForFunction(() => document.querySelector('#chatView') !== null);
    expect(await page.locator('#orbView').isVisible()).toBe(true);
    expect(await page.locator('#chatView').isHidden()).toBe(true);
    expect(await page.locator('#chatView .sc').count()).toBe(0);
    expect(await page.inputValue('#viewMode')).toBe('orb');
    await page.click('#typeToggle');
    await page.fill('#typein', 'Hello orb');
    await page.press('#typein', 'Enter');
    expect(await probe('__calls')).toEqual([['sendChat', 'Hello orb']]);
    expect(await page.locator('#you').innerText()).toBe('You: Hello orb');
    await reply({ type: 'chat.reply', success: true, text: 'Hi from the **orb**' });
    expect(await page.locator('#ai b').innerText()).toBe('orb');
    expect(await probe('__spoken')).toEqual(['Hi from the orb']);
    expect(errors).toEqual([]);
  });

  it('Simple chat replaces the orb with help the first time and the box pinned to the bottom', async () => {
    await openNode({ viewMode: 'chat' });
    await page.waitForSelector('#chatView .sc-help:not([hidden])');
    expect(await page.locator('#orbView').isHidden()).toBe(true);
    expect(await page.locator('#chatView .sc-example').count()).toBe(3);
    const box = await page.locator('#chatView .sc-composer').boundingBox();
    expect(Math.round((box?.y || 0) + (box?.height || 0))).toBe(760);
    expect(await page.inputValue('#viewMode')).toBe('chat');
    expect(errors).toEqual([]);
  });

  it('a turn goes over the bridge and the reply lands above the box, never spoken; the history survives a reload', async () => {
    await openNode({ viewMode: 'chat' });
    await page.waitForSelector('#node-chat-input:not([disabled])');
    await sendText('What can you do?');
    await page.waitForSelector('#chatView .sc-thinking');
    expect(await probe('__calls')).toEqual([['sendChat', 'What can you do?']]);
    expect(await page.locator('#node-chat-input').isDisabled()).toBe(true);
    await reply({ type: 'chat.reply', success: true, text: '**Plenty**, for example:\n\n- answer\n- draft' });
    await page.waitForSelector('#chatView .sc-assistant');
    expect(await roles()).toEqual(['user', 'assistant']);
    expect(await page.locator('#chatView .sc-assistant strong').innerText()).toBe('Plenty');
    expect(await page.locator('#chatView .sc-assistant li').allInnerTexts()).toEqual(['answer', 'draft']);
    expect(await probe('__spoken')).toEqual([]);
    expect(await page.locator('#chatView .sc-help').isHidden()).toBe(true);
    expect(await page.locator('#node-chat-input').isDisabled()).toBe(false);
    await page.reload();
    await page.waitForSelector('#chatView .sc-assistant');
    expect(await roles()).toEqual(['user', 'assistant']);
    expect(await page.locator('#chatView .sc-turn .sc-bubble').allTextContents()).toEqual(['What can you do?', 'Plenty, for example:answerdraft']);
    expect(await page.locator('#chatView .sc-help').isHidden()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('a bridge failure and an error reply are rows with their own words, and the box comes back', async () => {
    await openNode({ viewMode: 'chat' }, 'Not connected to the swarm.');
    await page.waitForSelector('#node-chat-input:not([disabled])');
    await sendText('Anyone there?');
    await page.waitForSelector('#chatView .sc-error');
    expect(await page.locator('#chatView .sc-error .sc-bubble').innerText()).toBe('Not connected to the swarm.');
    expect(await page.locator('#node-chat-input').isDisabled()).toBe(false);
    await context.close();
    await openNode({ viewMode: 'chat' });
    await page.waitForSelector('#node-chat-input:not([disabled])');
    await sendText('Try again');
    await page.waitForSelector('#chatView .sc-thinking');
    await reply({ type: 'chat.reply', success: false, text: '', error: 'The bot is busy.' });
    await page.waitForSelector('#chatView .sc-error');
    expect(await page.locator('#chatView .sc-error .sc-bubble').innerText()).toBe('The bot is busy.');
  });

  it('swarm tasks this computer runs appear as notes in the history', async () => {
    await openNode({ viewMode: 'chat' });
    await page.waitForSelector('#node-chat-input:not([disabled])');
    await workerEvent({ phase: 'claimed', intent: 'Print the weekly report' });
    await workerEvent({ phase: 'completed', intent: 'Print the weekly report', text: 'printed' });
    await workerEvent({ phase: 'failed', intent: 'Open the drawing', error: 'App not installed' });
    expect(await page.locator('#chatView .sc-note .sc-bubble').allInnerTexts()).toEqual([
      'Running a swarm task on this computer: Print the weekly report', 'Finished: Print the weekly report', 'Failed: Open the drawing (App not installed)']);
    expect(await page.locator('#worklog .work-row').count()).toBe(3);
  });

  it('the Window setting in Config swaps the window without a restart and is saved', async () => {
    await openNode({});
    await page.click('#settingsToggle');
    await page.selectOption('#viewMode', 'chat');
    await page.click('#saveBtn');
    await expect.poll(async () => (await probe('__calls')).find(c => c[0] === 'saveConfig')?.[1]).toMatchObject({ viewMode: 'chat' });
    expect(await page.locator('#orbView').isHidden()).toBe(true);
    expect(await page.locator('#chatView').isHidden()).toBe(true);
    await page.click('#closeSettings');
    expect(await page.locator('#chatView').isVisible()).toBe(true);
    expect(await page.locator('#orbView').isHidden()).toBe(true);
    await page.click('#settingsToggle');
    await page.selectOption('#viewMode', 'orb');
    await page.click('#saveBtn');
    await page.click('#closeSettings');
    expect(await page.locator('#orbView').isVisible()).toBe(true);
    expect(await page.locator('#chatView').isHidden()).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe('OSHAL Node: the kit copy', () => {
  it('ships byte-identical copies of the shared simple chat kit, so the node and /simple cannot drift', () => {
    for (const [copy, shared] of [['simple-chat.js', 'src/shared/ui/js/simple-chat.js'], ['simple-chat.css', 'src/shared/ui/css/simple-chat.css']]) {
      expect(readFileSync(resolve(RENDERER, copy), 'utf8'), copy).toBe(readFileSync(resolve(process.cwd(), shared), 'utf8'));
    }
  });
});

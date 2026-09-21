/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The chat-to-surface loop walked in a REAL browser on the reference app (the Forge), because every other surface-bridge spec drives fake windows or pure functions and so proves nothing about frame identity, browser-stamped origins or the rail's send. Four cases: a live assistant reply renders selectable options in the app's surface iframe and a real click on one returns to the SAME conversation through the shipped message route; the identical click against a thread owned by another user is refused by that route, so no relayed selection lands in someone else's conversation; an op the app's manifest never declared and an op outside the vocabulary are both dropped while a declared op in the same test still lands; and a frame on another origin cannot drive the surface or speak for the app even when it IS the app-surface frame.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import {
  FOREIGN_TASK_ID,
  REFERENCE_APP,
  startSurfaceBridgeRoundTripFixture,
} from '../fixtures/surface-bridge-roundtrip';

const ENV_KEYS = ['DATABASE_URL', 'PGHOST', 'POSTGRES_HOST', 'OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'];
const savedEnv: Record<string, string | undefined> = {};

const FENCE = '```';
/** A realistic packer turn: the human answer plus the control fence that drives the surface. */
const REPLY_WITH_OPTIONS = [
  'Q2 - what does the operator hand the bot to start a task?',
  '',
  `${FENCE}oshal:surface`,
  JSON.stringify({
    ops: [{
      op: 'render_options',
      prompt: 'What starts a task?',
      options: [
        { id: 'ticket', label: 'A ticket title + description' },
        { id: 'file', label: 'A file path in the workspace' },
      ],
    }],
  }),
  FENCE,
].join('\n');

/** Record every bridge envelope each frame RECEIVES, so a drop can be told from a never-sent. */
const RECORDER = `window.__bridgeSeen = [];
window.addEventListener('message', (event) => {
  const data = event.data;
  if (data && typeof data === 'object' && data.channel === 'oshal-surface-bridge') {
    window.__bridgeSeen.push({ op: data.op, origin: event.origin, raw: JSON.stringify(data) });
  }
});`;

let fixture: Awaited<ReturnType<typeof startSurfaceBridgeRoundTripFixture>>;
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
  fixture = await startSurfaceBridgeRoundTripFixture();
  browser = await chromium.launch({ headless: true });
}, 120000);

afterAll(async () => {
  await browser?.close();
  await fixture?.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(async () => {
  context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
  const allowed = new Set([fixture.origin, fixture.foreignOrigin]);
  await context.route('**/*', (route) =>
    allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort('failed'));
  await context.addInitScript(RECORDER);
  page = await context.newPage();
  page.setDefaultTimeout(20000);
});

afterEach(async () => {
  await context?.close();
  fixture.sends.length = 0;
  fixture.turns.length = 0;
  fixture.createdTaskIds.length = 0;
});

/** @description The rail frame, once the cockpit's own chat controller has navigated it. */
function railFrame(): Frame {
  const frame = page.frames().find((candidate) => candidate.url().includes('/swarmbot/chat'));
  if (!frame) throw new Error('the cockpit never loaded the chat rail');
  return frame;
}

/** @description The app-surface frame the relay addresses as `.tool-view-container iframe`. */
function surfaceFrame(): Frame {
  const frame = page.frames().find((candidate) => candidate.url().includes('/api/forge'));
  if (!frame) throw new Error('the cockpit never loaded the app surface');
  return frame;
}

/**
 * @description Open the reference app in the real cockpit and wait until both halves of the loop
 * are live: the Forge surface embedded by the shell, and the chat rail holding a real task.
 * @returns The task id the rail minted for this conversation.
 */
async function openLoop(): Promise<string> {
  await page.goto(`${fixture.origin}/cockpit/?app=${REFERENCE_APP}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.tool-view-container iframe').waitFor();
  await page.waitForFunction(() => Boolean(window.__cockpit?.ribbon?.profile?.surfaceOps?.length));
  // The shipped affordance every explicit chat action uses; the rail iframe is lazy until shown.
  await page.evaluate(() => window.__cockpit.toggleChatPanel(true));
  await page.waitForFunction(
    () => (document.getElementById('chatWorkspaceFrame') as HTMLIFrameElement | null)?.getAttribute('src')?.includes('/swarmbot/chat') === true);
  await expect.poll(() => fixture.createdTaskIds.length, { timeout: 20000 }).toBeGreaterThan(0);
  const taskId = fixture.createdTaskIds[fixture.createdTaskIds.length - 1];
  // The rail only relays once its stream is attached - that is what carries the assistant reply.
  await expect.poll(() => fixture.streamCount(taskId), { timeout: 20000 }).toBeGreaterThan(0);
  await surfaceFrame().waitForSelector('[data-bridge-host="options"]', { state: 'attached' });
  return taskId;
}

/** @description Post one envelope from the rail frame, exactly as a bot-direction message arrives. */
async function postFromRail(envelope: Record<string, unknown>): Promise<void> {
  await railFrame().evaluate((payload) => {
    window.parent.postMessage(payload, window.location.origin);
  }, { channel: 'oshal-surface-bridge', v: 1, app: REFERENCE_APP, ...envelope });
}

/**
 * @description How many bridge envelopes from one named off-origin sender the SHELL has received.
 * Each sender stamps its own name into the payload, so the two forgeries cannot be confused.
 * @param sender - The sender's name, as the foreign page spells it.
 * @returns The count seen so far.
 */
async function foreignEnvelopesAtShell(sender: string): Promise<number> {
  return page.evaluate((name) => (window.__bridgeSeen ?? [])
    .filter((entry) => entry.origin !== window.location.origin && entry.raw.includes(name)).length, sender);
}

/** @description What the app surface has RECEIVED through the relay, newest last. */
async function opsSeenBySurface(): Promise<string[]> {
  return surfaceFrame().evaluate(() => (window.__bridgeSeen ?? []).map((entry) => entry.op));
}

describe('chat-to-surface bridge - the loop walked in a real browser', () => {
  it('a live reply renders selectable options, and the click returns to the SAME conversation', async () => {
    const taskId = await openLoop();
    expect(fixture.allowedOps).toContain('render_options');

    fixture.pushAssistantReply(taskId, REPLY_WITH_OPTIONS);

    // Bot output updated selectable UI state - rendered by the shipped client in the app's frame.
    const options = surfaceFrame().locator('[data-bridge-host="options"] button.bridge-option');
    await expect.poll(async () => options.count(), { timeout: 20000 }).toBe(2);
    expect(await options.first().innerText()).toContain('A ticket title + description');
    // The control fence never reaches the bubble.
    const bubbles = await railFrame().locator('#messageArea').innerText();
    expect(bubbles).toContain('Q2 - what does the operator hand the bot');
    expect(bubbles).not.toContain('oshal:surface');

    await options.first().click();

    // ...and the selection lands in the SAME conversation, through the shipped message route.
    await expect.poll(() => fixture.sends.length, { timeout: 20000 }).toBe(1);
    expect(fixture.sends[0]).toEqual({ taskId, text: 'I selected "ticket".', status: 200 });
    expect(fixture.turns).toEqual([{ taskId, text: 'I selected "ticket".' }]);
  }, 120000);

  it('the same click cannot land in ANOTHER user\'s conversation', async () => {
    const ownTaskId = await openLoop();
    fixture.pushAssistantReply(ownTaskId, REPLY_WITH_OPTIONS);
    const options = surfaceFrame().locator('[data-bridge-host="options"] button.bridge-option');
    await expect.poll(async () => options.count(), { timeout: 20000 }).toBe(2);

    // Point the rail at a thread owned by a DIFFERENT user, through the cockpit's own control.
    await page.evaluate((foreign) => window.__cockpit.chatPanel.loadTask(foreign), FOREIGN_TASK_ID);
    await page.waitForFunction(
      (foreign) => (document.getElementById('chatWorkspaceFrame') as HTMLIFrameElement | null)?.getAttribute('src')?.includes(`taskId=${foreign}`) === true,
      FOREIGN_TASK_ID);
    // The rail's module script is deferred: wait until the page has RUN (it renders the task id
    // it is holding), or the click below would arrive before its message listener is bound.
    await expect.poll(
      async () => railFrame().evaluate(() => document.getElementById('taskId')?.textContent ?? ''),
      { timeout: 20000 }).toBe(FOREIGN_TASK_ID);
    fixture.sends.length = 0;
    fixture.turns.length = 0;

    await options.first().click();

    await expect.poll(() => fixture.sends.length, { timeout: 20000 }).toBe(1);
    expect(fixture.sends[0]).toEqual({ taskId: FOREIGN_TASK_ID, text: 'I selected "ticket".', status: 404 });
    // Nothing reached the other user's conversation.
    expect(fixture.turns).toEqual([]);
  }, 120000);

  it('an op the app never declared and an op that is not in the vocabulary are dropped - while a declared op lands', async () => {
    await openLoop();
    expect(await opsSeenBySurface()).toEqual([]);

    // An op in the contract vocabulary that the reference app's manifest never declared.
    expect(fixture.allowedOps).not.toContain('set_field');
    await postFromRail({ op: 'set_field', field: 'packer-note', value: 'forced' });
    // An op that is not in the vocabulary at all.
    await postFromRail({ op: 'exfiltrate_workspace', target: 'everything' });
    expect(await opsSeenBySurface()).toEqual([]);

    // Liveness: the identical path still carries a declared op, so the two drops above are the
    // relay refusing them rather than a dead channel.
    expect(fixture.allowedOps).toContain('notify');
    await postFromRail({ op: 'notify', level: 'success', text: 'Allowed op landed.' });
    await expect.poll(opsSeenBySurface, { timeout: 20000 }).toEqual(['notify']);
    expect(await surfaceFrame().locator('[data-bridge-host="notices"]').innerText()).toContain('Allowed op landed.');
  }, 120000);

  it('a frame on another origin cannot drive the surface, even when it IS the surface frame', async () => {
    await openLoop();
    const railTaskId = fixture.createdTaskIds[fixture.createdTaskIds.length - 1];
    expect(railTaskId).toBeTruthy();

    // A stray frame the shell never embedded, posting one envelope in each direction. The browser
    // stamps the origin, so this is the one forgery a fake-window spec cannot stage.
    await page.evaluate((foreign) => {
      const frame = document.createElement('iframe');
      frame.src = `${foreign}/forge-attempt?as=stray`;
      frame.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';
      document.body.appendChild(frame);
    }, fixture.foreignOrigin);
    await expect.poll(async () => foreignEnvelopesAtShell('forged-from-stray'), { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    expect(await opsSeenBySurface()).toEqual([]);

    // Now the harder one: the APP-SURFACE frame itself navigates off-origin and speaks for the
    // app. It is the frame the relay addresses, so the emitter-sibling check passes it and only
    // the origin check refuses it.
    await page.evaluate((foreign) => {
      const frame = document.querySelector('.tool-view-container iframe') as HTMLIFrameElement;
      frame.src = `${foreign}/forge-attempt?as=surface`;
    }, fixture.foreignOrigin);
    await expect.poll(async () => foreignEnvelopesAtShell('forged-from-surface'), { timeout: 20000 }).toBeGreaterThanOrEqual(2);

    // Nothing it said reached the conversation.
    expect(fixture.sends).toEqual([]);
    expect(fixture.turns).toEqual([]);
    expect(await railFrame().evaluate(() => (window.__bridgeSeen ?? []).map((entry) => entry.op))).toEqual([]);
  }, 120000);
});

declare global {
  interface Window {
    __bridgeSeen?: Array<{ op: string; origin: string; raw: string }>;
    __cockpit: {
      ribbon?: { profile?: { surfaceOps?: string[] } };
      chatPanel: { loadTask: (taskId: string) => Promise<void> };
      toggleChatPanel: (show: boolean) => void;
    };
  }
}

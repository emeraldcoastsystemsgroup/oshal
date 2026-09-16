/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove compact Jarvis layout, grouped real task actions and retained voice/stage flows in Chromium.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove the page rolls a refused persisted thread id to a fresh one and resends the turn exactly once (the 'Sorry — I couldn't do that just now' regression after issuer provenance landed).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Give the hooks that own the isolated fixture browser the fixture's exit budget, so a confirmed but slow shutdown on a loaded box is failed by neither deadline.
 */
import { type Browser, type Page, type Frame } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { dashboardGate, dashboardState, dashboardMediaFile, startJarvisDashboardFixture, type DashboardTask } from '../fixtures/jarvis-dashboard';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';

vi.setConfig({ testTimeout: 20_000, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });
let browser: Browser, fixture: Awaited<ReturnType<typeof startJarvisDashboardFixture>>;
let media: Awaited<ReturnType<typeof dashboardMediaFile>>;
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
beforeAll(async () => {
  fixture = await startJarvisDashboardFixture();
  media = await dashboardMediaFile();
  owned = await launchIsolatedBrowser({ args: ['--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${media.path}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  browser = owned.browser;
});
beforeEach(() => Object.assign(fixture.state, dashboardState()));
afterAll(async () => {
  try {
    const cleanup = await owned?.close();
    await writeFile('temp/jarvis-dashboard-browser-cleanup.json', JSON.stringify(cleanup, null, 2));
  } finally { await fixture?.stop(); await media?.cleanup(); }
}, BROWSER_HOOK_TIMEOUT_MS);

/** @description Read the real current page with all outbound origins blocked. */
async function openDashboard(width = 1280, height = 800, embedded = false, theme = 'workspace', persistedSessionId?: string) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', permissions: ['microphone'] });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  await context.addInitScript(value => localStorage.setItem('cockpit-theme', value), theme);
  // A thread id this browser bookmarked on an earlier visit — the page reads it before any turn.
  if (persistedSessionId) await context.addInitScript(value => localStorage.setItem('jarvisSessionId', value), persistedSessionId);
  await context.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    (window as any).fixtureCanvasDraws = {};
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      const counts = (window as any).fixtureCanvasDraws;
      counts[this.canvas.id] = (counts[this.canvas.id] || 0) + 1;
      return clear.apply(this, args);
    };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => original(constraints).catch(error => {
      (window as any).fixtureMediaError = `${error.name}: ${error.message}`; throw error;
    });
  });
  const page = await context.newPage(), errors: string[] = [];
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(fixture.base + (embedded ? '/fixture-home' : '/api/jarvis/?layout=compact'));
    const surface = embedded ? await (await page.locator('iframe').elementHandle())?.contentFrame() : page;
    if (!surface) throw new Error('Fixture iframe missing');
    await surface.waitForFunction(() => typeof (window as any).handleInput === 'function' && !!document.querySelector('.jarvis-ambient'));
    await surface.locator('#shelf .shelf-sum').waitFor();
    return { page, surface, context, errors };
  } catch (error) {
    await context.close(); throw new Error(`${String(error)}; page errors: ${JSON.stringify(errors)}`);
  }
}

/** @description Measure actual viewport geometry and hit targets rather than CSS source patterns. */
async function composerGeometry(surface: Page | Frame) {
  return surface.evaluate(() => {
    const ids = ['orb', 'typein', 'mic', 'mute', 'addMediaBtn'];
    const boxes = ids.map(id => {
      const el = document.getElementById(id)!, r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { id, x: r.x, y: r.y, width: r.width, bottom: r.bottom, right: r.right, hit: el === hit || el.contains(hit) };
    });
    return { boxes, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
      backdropVisible: getComputedStyle(document.getElementById('nodes')!).display !== 'none' };
  });
}

for (const [width, height, embedded] of [[1280, 800, false], [390, 740, false], [360, 500, true]] as const) {
  it(`shows the composer and primary controls without overlap at ${width}x${height}${embedded ? ' embedded' : ''}`, async () => {
    const { page, surface, context, errors } = await openDashboard(width, height, embedded);
    try {
      const geometry = await composerGeometry(surface);
      expect(geometry.overflow).toBe(false); expect(geometry.backdropVisible).toBe(false);
      for (const box of geometry.boxes) {
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(geometry.width);
        expect(box.bottom).toBeLessThan(geometry.height); expect(box.hit, box.id).toBe(true);
      }
      expect(geometry.boxes.find(box => box.id === 'orb')!.width).toBeLessThanOrEqual(48);
      expect(await surface.locator('#typein').isVisible()).toBe(true);
      expect(await surface.locator('#assistantState').textContent()).toBe('Ready');
      await surface.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const draws = await surface.evaluate(() => (window as any).fixtureCanvasDraws);
      expect(draws.nodes || 0).toBe(0); expect(draws.orb).toBeGreaterThan(0);
      if (embedded) {
        await surface.locator('#typein').fill('Keep this unfinished request.');
        await page.evaluate(() => { document.documentElement.dataset.theme = 'midnight'; });
        await expect.poll(() => surface.locator('html').getAttribute('data-theme')).toBe('midnight');
        expect(await surface.locator('#typein').inputValue()).toBe('Keep this unfinished request.');
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}

/** @description Construct delivered task records so display grouping cannot accidentally acknowledge them. */
function task(id: string, title: string, status = 'done'): DashboardTask {
  return { id, title, status, result: `Individual detail for ${id}.`, createdAt: new Date().toISOString(), delivered: true };
}

it('bounds grouped updates while keeping every individual result, counts and original read/dismiss actions', async () => {
  fixture.state.tasks = Array.from({ length: 24 }, (_, i) => task(`finance-${i}`, `Finance: Daily update ${i}`));
  fixture.state.tasks.push(task('scan-error', 'Scan: Build failed', 'error'), task('own', 'A personal request'));
  const { surface, context } = await openDashboard();
  try {
    expect(await surface.locator('.dashboard-task-group').count()).toBe(3);
    expect(await surface.locator('.dashboard-task-open:visible').count()).toBe(0);
    expect(await surface.locator('#shelf').textContent()).toContain('25 new');
    const group = surface.locator('[data-source="Finance"]');
    await group.locator('summary').click();
    expect(await group.locator('[data-job-open]').count()).toBe(24);
    expect(fixture.state.mutations).toEqual([]);
    expect(await surface.evaluate(() => localStorage.getItem('jarvisReadResults'))).toBeNull();
    await group.locator('[data-job-open="finance-23"]').click();
    await expect.poll(() => surface.locator('#resultContent').textContent()).toContain('Individual detail for finance-23.');
    await expect.poll(() => surface.locator('[data-job="finance-23"]').getAttribute('class')).toContain('read');
    await surface.locator('[data-dismiss="finance-22"]').click();
    await expect.poll(() => fixture.state.mutations).toEqual(['dismiss:finance-22']);
    await expect.poll(() => surface.locator('[data-job-open="finance-22"]').count()).toBe(0);
    expect(await surface.locator('#shelf').evaluate(el => el.clientHeight)).toBeLessThanOrEqual(410);
  } finally { await context.close(); }
});

it('retains expanded group and exact focused task across normal task refresh without changing the conversation', async () => {
  fixture.state.tasks = [task('one', 'Finance: First'), task('two', 'Finance: Second')];
  const { surface, context } = await openDashboard();
  try {
    await surface.locator('[data-source="Finance"] summary').click();
    await surface.locator('[data-job-open="two"]').focus();
    const before = await surface.evaluate(() => localStorage.getItem('jarvisSessionId'));
    await surface.evaluate(() => (window as any).pollShelf());
    expect(await surface.locator('[data-source="Finance"]').getAttribute('open')).not.toBeNull();
    expect(await surface.locator('[data-job-open="two"]').evaluate(el => el === document.activeElement)).toBe(true);
    expect(await surface.evaluate(() => localStorage.getItem('jarvisSessionId'))).toBe(before);
    expect(fixture.state.mutations).toEqual([]);
  } finally { await context.close(); }
});

it('opens an individual failure in the existing discussion without marking it read or dismissing it', async () => {
  fixture.state.tasks = [{ ...task('failed-build', 'Engineering: Failed build', 'error'), error: 'Fixture compilation failed at the input boundary.' }];
  const { surface, context } = await openDashboard();
  try {
    await surface.locator('[data-source="Engineering"] summary').click();
    await surface.locator('[data-job-open="failed-build"]').click();
    await expect.poll(() => surface.locator('#discussionDrawer').getAttribute('aria-hidden')).toBe('false');
    expect(await surface.locator('#convo').textContent()).toContain('Fixture compilation failed at the input boundary.');
    expect(await surface.evaluate(() => localStorage.getItem('jarvisReadResults'))).toBeNull();
    expect(fixture.state.mutations).toEqual([]);
  } finally { await context.close(); }
});

it('uses inert task text and preserves briefing refusal without client acknowledgement or automatic speech', async () => {
  fixture.state.tasks = [{ ...task('briefing', 'Finance: <img src=x onerror=alert(1)>'), delivered: false, briefing: { sourceId: 'fixture-source' } }];
  const { surface, context } = await openDashboard();
  try {
    await expect.poll(() => fixture.state.claims.length).toBe(1);
    await surface.locator('[data-source="Finance"] summary').click();
    expect(await surface.locator('[data-job-open="briefing"]').textContent()).toContain('<img src=x onerror=alert(1)>');
    expect(await surface.locator('#shelf img, #shelf script').count()).toBe(0);
    expect(fixture.state.mutations).toEqual([]);
    expect(await surface.locator('#assistantState').textContent()).toBe('Ready');
  } finally { await context.close(); }
});

it('keeps secondary controls and ambient settings reachable by keyboard, then returns to the composer', async () => {
  const { surface, context } = await openDashboard(390, 740);
  try {
    const summary = surface.locator('#assistantOptions > summary');
    await summary.focus(); await summary.press('Enter');
    for (const id of ['newThreadBtn', 'voiceBtn', 'orbBtn', 'discussionBtn', 'closeThreadBtn']) expect(await surface.locator(`#${id}`).isVisible()).toBe(true);
    await surface.getByRole('button', { name: 'Ambient listening settings', exact: true }).click();
    expect(await surface.getByRole('dialog', { name: 'Always ready, on your terms' }).isVisible()).toBe(true);
    await surface.getByRole('button', { name: 'Close settings', exact: true }).click();
    await summary.press('Escape');
    expect(await surface.locator('#assistantOptions').getAttribute('open')).toBeNull();
    expect(await summary.evaluate(el => el === document.activeElement)).toBe(true);
    await summary.press('Enter'); await surface.locator('#typeToggle').click();
    expect(await surface.locator('#typein').evaluate(el => el === document.activeElement)).toBe(true);
  } finally { await context.close(); }
});

it('shows actual thinking, speaking and stopped state through the unchanged text/voice transport', async () => {
  const result = dashboardGate(), speech = dashboardGate();
  fixture.state.resultGate = result.promise; fixture.state.speechGate = speech.promise;
  const { surface, context } = await openDashboard();
  try {
    await surface.locator('#typein').fill('Explain this status.');
    await surface.locator('#typer button').click();
    await expect.poll(() => fixture.state.asks.length).toBe(1);
    expect(fixture.state.asks[0].message).toBe('Explain this status.');
    expect(await surface.locator('#assistantState').textContent()).toBe('Thinking');
    result.release();
    await expect.poll(() => surface.locator('#assistantState').textContent()).toBe('Speaking');
    expect(await surface.locator('#resultContent strong').textContent()).toBe('clear answer');
    speech.release();
    await expect.poll(() => surface.locator('#assistantState').textContent(), { timeout: 5000 }).toBe('Ready');
    await surface.locator('#mute').click();
    await expect.poll(() => surface.locator('#assistantState').textContent()).toBe('Stopped');
    expect(await surface.locator('#status').textContent()).toContain('Stopped.');
    await surface.locator('#resultDiscussionBtn').click();
    expect(await surface.locator('#discussionDrawer').getAttribute('aria-hidden')).toBe('false');
    expect(await surface.locator('#convo').textContent()).toContain('Explain this status.');
  } finally { result.release(); speech.release(); await context.close(); }
});

it('records with the real browser fake microphone and stops without transcribing an explicitly discarded recording', async () => {
  const { surface, context } = await openDashboard();
  try {
    await surface.locator('#mic').click();
    await expect.poll(async () => ({ state: await surface.locator('#assistantState').textContent(),
      error: await surface.evaluate(() => (window as any).fixtureMediaError || '') }), { timeout: 5000 }).toEqual({ state: 'Listening', error: '' });
    expect(await surface.locator('#miclabel').textContent()).toBe('Stop & send');
    await surface.locator('#mute').click();
    await expect.poll(() => surface.locator('#assistantState').textContent()).toBe('Stopped');
    expect(await surface.locator('#miclabel').textContent()).toBe('Tap to talk');
    expect(fixture.state.asks).toEqual([]);
  } finally { await context.close(); }
});

it('keeps a readable typed fallback when the browser enforces a denied microphone policy', async () => {
  fixture.state.denyMicrophone = true;
  const { surface, context } = await openDashboard(390, 740);
  try {
    await surface.locator('#mic').click();
    await expect.poll(() => surface.locator('#status').textContent()).toContain('Microphone blocked');
    expect(await surface.locator('#typein').isVisible()).toBe(true);
    expect(await surface.locator('#assistantState').textContent()).toBe('Ready');
    await surface.locator('#typein').fill('Use text instead.'); await surface.locator('#typer button').click();
    await expect.poll(() => fixture.state.asks.length).toBe(1);
    expect(fixture.state.asks[0].message).toBe('Use text instead.');
  } finally { await context.close(); }
});

it('retains attachment text and one turn when sent from the visible composer', async () => {
  const { surface, context } = await openDashboard();
  try {
    await surface.locator('#addMediaBtn').click();
    expect(await surface.locator('#attachMenu').isVisible()).toBe(true);
    await surface.locator('#docInput').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment contents.') });
    await expect.poll(() => surface.locator('#attachStrip').textContent()).toContain('notes.txt');
    await surface.locator('#typein').fill('Use these notes.'); await surface.locator('#typer button').click();
    await expect.poll(() => fixture.state.asks.length).toBe(1);
    expect(fixture.state.asks[0].attachments).toEqual([{ kind: 'doc', name: 'notes.txt', text: 'Synthetic attachment contents.' }]);
  } finally { await context.close(); }
});

it('keeps a real image stage and its discussion/return focus behavior in the compact surface', async () => {
  fixture.state.result.visual = { type: 'image', artifactId: 'c94fc97a-2497-4eeb-8b89-0214e8f4629e', url: '/api/jarvis/visuals/c94fc97a-2497-4eeb-8b89-0214e8f4629e', mimeType: 'image/svg+xml', kind: 'diagram', alt: 'Fixture visual', width: 320, height: 180 };
  const { surface, context } = await openDashboard(390, 740);
  try {
    await surface.locator('#typein').fill('Show the fixture diagram.'); await surface.locator('#typer button').click();
    await expect.poll(() => surface.locator('body').getAttribute('class')).toContain('jarvis-response-active');
    expect(await surface.locator('#scroll').evaluate(el => (el as HTMLElement).inert)).toBe(true);
    expect(await surface.locator('#responseStageImage').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(320);
    await surface.locator('#responseDiscussionBtn').click();
    expect(await surface.locator('#discussionDrawer').getAttribute('aria-hidden')).toBe('false');
    await surface.locator('#discussionClose').click();
    await surface.locator('#responseStopBtn').click();
    expect(await surface.locator('#scroll').evaluate(el => (el as HTMLElement).inert)).toBe(false);
    expect(await surface.locator('#typein').isVisible()).toBe(true);
  } finally { await context.close(); }
});

for (const theme of ['workspace', 'midnight']) {
  it(`uses the current ${theme} palette and captures the actual dashboard`, async () => {
    fixture.state.tasks = [task('finance', 'Finance: Account review'), task('create', 'Create: Draft ready'), task('engineering', 'Engineering: Build check', 'running')];
    const { page, surface, context } = await openDashboard(theme === 'workspace' ? 1280 : 390, 800, false, theme);
    try {
      expect(await surface.locator('html').getAttribute('data-theme')).toBe(theme);
      const colors = await surface.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor,
        expected: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim() }));
      expect(colors.body).toBe(theme === 'workspace' ? 'rgb(245, 246, 249)' : 'rgb(10, 10, 18)');
      expect(colors.expected).toBe(theme === 'workspace' ? '#f5f6f9' : '#0a0a12');
      await mkdir('temp', { recursive: true });
      await page.screenshot({ path: `temp/jarvis-dashboard-${theme}.png`, fullPage: true });
    } finally { await context.close(); }
  });
}

it('keeps the closed discussion drawer from shading the compact iframe', async () => {
  const { page, surface, context } = await openDashboard(390, 600, true);
  try {
    const clip = { x: 378, y: 550, width: 8, height: 20 };
    const actual = await page.screenshot({ clip });
    await surface.locator('#discussionDrawer').evaluate(el => { (el as HTMLElement).style.visibility = 'hidden'; });
    const withoutDrawer = await page.screenshot({ clip });
    expect(actual.equals(withoutDrawer)).toBe(true);
  } finally { await context.close(); }
});

it('keeps Stopped visible after the active audio completion cleanup settles', async () => {
  fixture.state.speechSamples = 16_000;
  const { surface, context } = await openDashboard();
  try {
    await surface.locator('#typein').fill('Read this answer.'); await surface.locator('#typer button').click();
    await surface.waitForFunction('ttsAudio && !ttsAudio.paused');
    await surface.locator('#mute').click();
    await surface.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await surface.locator('#assistantState').textContent()).toBe('Stopped');
    expect(await surface.evaluate('ttsAudio === null || ttsAudio.paused')).toBe(true);
  } finally { await context.close(); }
});

it('rolls a refused persisted thread id to a fresh thread and resends the turn once', async () => {
  // The server refuses a thread it cannot attribute to the current sign-in (404 session_not_found,
  // guarded in tests/unit/protected-jarvis-results.spec.ts). The bookmarked id must not brick every ask.
  fixture.state.refusedSessionIds = ['jarvis-legacy-fixture-thread'];
  const { surface, context } = await openDashboard(1280, 800, false, 'workspace', 'jarvis-legacy-fixture-thread');
  try {
    await surface.locator('#typein').fill('How did I do in the market last week?'); await surface.locator('#typer button').click();
    await expect.poll(() => fixture.state.asks.length, { timeout: 5000 }).toBe(2);
    expect(fixture.state.asks[0]).toMatchObject({ message: 'How did I do in the market last week?', sessionId: 'jarvis-legacy-fixture-thread' });
    const fresh = String(fixture.state.asks[1].sessionId);
    expect(fixture.state.asks[1].message).toBe('How did I do in the market last week?');
    expect(fresh).toMatch(/^jarvis-[0-9a-f-]{36}$/);
    await expect.poll(() => surface.locator('#resultContent strong').textContent(), { timeout: 5000 }).toBe('clear answer');
    expect(await surface.evaluate(() => localStorage.getItem('jarvisSessionId'))).toBe(fresh);
    expect(await surface.locator('#convo').textContent()).not.toContain('session_not_found');
  } finally { await context.close(); }
});

it('surfaces a refusal of the fresh thread as one readable error instead of retrying again', async () => {
  fixture.state.refusedSessionIds = ['*'];
  const { surface, context } = await openDashboard(1280, 800, false, 'workspace', 'jarvis-legacy-fixture-thread');
  try {
    await surface.locator('#typein').fill('Try again please.'); await surface.locator('#typer button').click();
    await expect.poll(() => surface.locator('#convo .err').count(), { timeout: 5000 }).toBe(1);
    expect(await surface.locator('#convo .err').textContent()).toBe('Jarvis could not open a conversation for your current sign-in.');
    expect(fixture.state.asks.length).toBe(2);
    expect(fixture.state.asks[1].sessionId).not.toBe('jarvis-legacy-fixture-thread');
  } finally { await context.close(); }
});

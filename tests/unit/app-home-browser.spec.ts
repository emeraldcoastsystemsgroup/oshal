/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove daily Home geometry, stable real Jarvis draft, authorized directory, saved choices and honest probe failures in Chromium.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Verify exact canonical palette colors in the actual parent and Jarvis frame as well as layout geometry.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startAppHomeBrowserFixture, homeEntry } from '../fixtures/app-home-browser';
import { launchIsolatedBrowser } from '../fixtures/isolated-browser';

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startAppHomeBrowserFixture>>;
let isolated: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
beforeAll(async () => { isolated = await launchIsolatedBrowser(); browser = isolated.browser; });
afterAll(async () => {
  if (!isolated) return;
  const cleanup = await isolated.close(); mkdirSync('temp', { recursive: true });
  writeFileSync(`temp/app-home-browser-cleanup-${cleanup.pid}.json`, JSON.stringify(cleanup, null, 2) + '\n', { flag: 'wx' });
});
beforeEach(async () => {
  fixture = await startAppHomeBrowserFixture();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  page = await context.newPage();
});
afterEach(async () => { await context?.close(); await fixture?.close(); });

/** @description Open the actual Cockpit app controller and wait for its real Home source details. */
async function open(theme = 'workspace') {
  await context.addInitScript(value => localStorage.setItem('cockpit-theme', value), theme);
  await page.goto(fixture.origin + '/cockpit/');
  await page.waitForSelector('.apps-home-detail .apps-home-tile');
  await page.frameLocator('#appsHomeJarvisFrame').locator('#typein').waitFor({ state: 'visible' });
}

/** @description Measure actual occupied rectangles and scroll widths, including the embedded document. */
async function geometry() {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('#appsHomeJarvisFrame')!;
    const box = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width }; };
    return { assistant: box('.apps-home-assistant'), summary: box('.apps-home-summary'), viewport: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      frameOverflow: frame.contentDocument!.documentElement.scrollWidth - frame.contentWindow!.innerWidth };
  });
}

it('bounds a large catalog into named areas and one source detail while retaining every directory entry', async () => {
  fixture.home.entries.push(...Array.from({ length: 24 }, (_, i) => homeEntry(`additional-${i}`, i % 2 ? 'ai-finance' : undefined)));
  await open();
  expect(await page.locator('.apps-home-areas button').count()).toBe(7);
  expect(await page.locator('.apps-home-updates li').count()).toBe(4);
  expect(await page.locator('.apps-home-card').count()).toBe(1);
  expect(await page.locator('.apps-home-shelf').count()).toBe(0);
  expect(await page.locator('.apps-home-areas').innerText()).toContain('Finance');
  expect(await page.locator('.apps-home-areas').innerText()).not.toContain('Other');
  await page.getByRole('button', { name: 'All applications', exact: true }).click();
  expect(await page.locator('#appsHomeDirectory li').count()).toBe(32);
  await page.getByRole('searchbox').fill('uncategorized');
  expect(await page.locator('#appsHomeDirectory li').count()).toBe(1);
  await page.locator('#appsHomeDirectory').getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(async () => page.frames().some(frame => new URL(frame.url()).pathname === '/fixture/uncategorized')).toBe(true);
  expect(fixture.home.writes).toEqual([]);
}, 30000);

it('keeps the actual Jarvis document and typed draft through late probes, source selection, directory and refresh', async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  fixture.home.gates.set('source-3', pending);
  try {
    await page.goto(fixture.origin + '/cockpit/');
    const input = page.frameLocator('#appsHomeJarvisFrame').locator('#typein'); await input.fill('Keep this unsent draft');
    const frame = page.frames().find(f => f.url().includes('/api/jarvis/'))!;
    const token = await frame.evaluate(() => { (window as any).homeDocumentToken = crypto.randomUUID(); return (window as any).homeDocumentToken; });
    release(); await page.waitForSelector('.apps-home-tile');
    await page.locator('[data-home-area="ai-finance"]').click();
    await page.getByRole('button', { name: 'OSHAL menu', exact: true }).click();
    await page.locator('[data-workspace-all]').click();
    await page.getByRole('searchbox').fill('source-3'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForSelector('.apps-home-tile');
    expect(await input.inputValue()).toBe('Keep this unsent draft');
    expect(await frame.evaluate(() => (window as any).homeDocumentToken)).toBe(token);
    expect(fixture.home.calls.filter(call => call === 'GET /api/jarvis/')).toHaveLength(1);
    expect(fixture.home.calls.filter(call => call.startsWith('POST '))).toEqual([]);
  } finally { release(); }
}, 30000);

it('persists account hiding without removing directory reachability or resetting the assistant draft', async () => {
  await open(); const input = page.frameLocator('#appsHomeJarvisFrame').locator('#typein'); await input.fill('Draft while customizing');
  await page.getByRole('button', { name: 'Customize', exact: true }).click();
  await page.locator('[data-choice="app"][data-id="source-3"]').uncheck();
  await expect.poll(() => fixture.home.preferences.hiddenApps).toEqual(['source-3']);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await page.locator('[data-home-area="ai-finance"]').count()).toBe(0);
  expect(await input.inputValue()).toBe('Draft while customizing');
  await page.reload(); await page.waitForSelector('.apps-home-tile');
  expect(await page.locator('[data-home-area="ai-finance"]').count()).toBe(0);
  await page.getByRole('button', { name: 'All applications', exact: true }).click();
  await page.getByRole('searchbox').fill('source-3'); expect(await page.locator('#appsHomeDirectory li').count()).toBe(1);
  expect(fixture.home.writes).toEqual([{ preferences: { version: 1, hiddenApps: ['source-3'] }, revision: 0 }]);
}, 30000);

it('shows a failed source as unavailable rather than zero and keeps setup behind disclosure', async () => {
  fixture.home.status['source-3'] = 503;
  await open(); await page.locator('[data-home-area="ai-finance"]').click();
  expect(await page.locator('.apps-home-card').innerText()).toContain('cannot be checked');
  expect(await page.locator('.apps-home-card .apps-home-tile').count()).toBe(0);
  expect(await page.locator('[data-home-area="ai-finance"]').innerText()).toContain('Updates unavailable');
  expect(await page.locator('.apps-home-todos').getAttribute('open')).toBeNull();
  await page.locator('.apps-home-todos summary').click();
  expect(await page.locator('.apps-home-todos').innerText()).toContain("can't be checked");
  expect(fixture.home.calls.filter(call => call.startsWith('POST '))).toEqual([]);
}, 30000);

it('refuses preference editing when settings cannot be read and keeps applications reachable', async () => {
  fixture.home.preferenceStatus = 503; await open();
  expect(await page.getByRole('button', { name: 'Customize', exact: true }).isDisabled()).toBe(true);
  expect(await page.locator('[data-home-notice]').innerText()).toContain('Display settings could not be loaded');
  await page.getByRole('button', { name: 'All applications', exact: true }).click();
  expect(await page.locator('#appsHomeDirectory li').count()).toBe(8);
  expect(fixture.home.writes).toEqual([]);
}, 30000);

it('keeps an unavailable authorized catalog distinct from an empty search while Jarvis remains usable', async () => {
  fixture.home.planStatus = 403;
  await page.goto(fixture.origin + '/cockpit/');
  await expect.poll(() => page.locator('[data-home-notice]').innerText()).toContain('application list could not be read');
  await page.frameLocator('#appsHomeJarvisFrame').locator('#typein').fill('Unsent draft with unavailable catalog');
  await page.getByRole('button', { name: 'All applications', exact: true }).click();
  await page.getByRole('searchbox').fill('source');
  expect(await page.locator('#appsHomeDirectory').innerText()).toContain('application list is unavailable');
  expect(await page.locator('#appsHomeDirectory [data-open]').count()).toBe(0);
  expect(fixture.home.calls.filter(call => call.startsWith('GET /fixture/probe/'))).toEqual([]);
  expect(fixture.home.writes).toEqual([]);
}, 30000);

it('reports missing recent activity as unavailable when a source has no summary and its fallback read fails', async () => {
  const entry = homeEntry('without-summary', 'ai-finance'); entry.summary = []; entry.todos = [];
  fixture.home.entries = [entry]; fixture.home.taskStatus = 503;
  await page.goto(fixture.origin + '/cockpit/');
  await expect.poll(() => page.locator('.apps-home-card').innerText()).toContain('Recent activity could not be checked');
  expect(await page.locator('[data-home-area="ai-finance"]').innerText()).toContain('Updates unavailable');
  expect(await page.locator('.apps-home-tile').count()).toBe(0);
  expect(await page.locator('.apps-home-card').innerText()).not.toContain('Nothing to report');
}, 30000);

it('retracts a no-longer-admitted entry after the existing refresh without showing cached links', async () => {
  await open(); fixture.home.entries = fixture.home.entries.filter(entry => entry.name !== 'uncategorized');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForSelector('.apps-home-tile');
  await page.getByRole('button', { name: 'All applications', exact: true }).click();
  await page.getByRole('searchbox').fill('uncategorized');
  expect(await page.locator('#appsHomeDirectory').innerText()).toContain('No matching applications');
  expect(await page.locator('#appsHomeDirectory [data-open]').count()).toBe(0);
}, 30000);

it('retains six concurrent probes, shared-path deduplication and the actual three-second timeout', async () => {
  fixture.home.entries = Array.from({ length: 12 }, (_, i) => homeEntry(`held-${i}`, 'ai-finance'));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.home.entries.forEach(entry => fixture.home.gates.set(entry.name, gate));
  await page.clock.install();
  try {
    await page.goto(fixture.origin + '/cockpit/');
    await expect.poll(() => fixture.home.peakProbes).toBe(6);
    expect(fixture.home.calls.filter(call => call.startsWith('GET /fixture/probe/'))).toHaveLength(6);
    await page.clock.runFor(3100);
    await expect.poll(() => fixture.home.calls.filter(call => call.startsWith('GET /fixture/probe/')).length).toBe(12);
    await page.clock.runFor(3100);
    await expect.poll(() => page.locator('.apps-home-card').innerText()).toContain('cannot be checked');
    expect(fixture.home.peakProbes).toBe(6);
    expect(new Set(fixture.home.calls.filter(call => call.startsWith('GET /fixture/probe/'))).size).toBe(12);
    expect(await page.locator('.apps-home-tile').count()).toBe(0);
    await page.frameLocator('#appsHomeJarvisFrame').locator('#typein').fill('Still usable after slow sources');
  } finally { release(); }
}, 30000);

it('preserves saved visibility and the current draft when the real preference PUT is refused', async () => {
  await open(); fixture.home.saveStatus = 409;
  const input = page.frameLocator('#appsHomeJarvisFrame').locator('#typein'); await input.fill('Keep my draft');
  await page.getByRole('button', { name: 'Customize', exact: true }).click();
  await page.locator('[data-choice="app"][data-id="source-3"]').click();
  await expect.poll(() => page.locator('.apps-home-editor').innerText()).toContain('Your changes were not applied');
  expect(await page.locator('[data-choice="app"][data-id="source-3"]').isChecked()).toBe(true);
  expect(fixture.home.preferences).toEqual({ version: 1 }); expect(fixture.home.revision).toBe(0);
  expect(fixture.home.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await input.inputValue()).toBe('Keep my draft'); expect(await page.locator('[data-home-area="ai-finance"]').count()).toBe(1);
}, 30000);

it('keeps keyboard focus and readable layout at 200 percent zoom with long owner text', async () => {
  fixture.home.entries[3].displayName = 'Synthetic Finance source with a deliberately long accessible name';
  await open(); await page.addStyleTag({ content: 'html { zoom: 2; }' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const area = page.locator('[data-home-area="ai-finance"]'); await area.focus(); await page.keyboard.press('Enter');
  expect(await area.evaluate(el => el === document.activeElement)).toBe(true);
  expect(await page.locator('.apps-home-card h3').innerText()).toContain('deliberately long');
  expect((await geometry()).overflow).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'All applications', exact: true }).click();
  expect(await page.getByRole('searchbox').evaluate(el => el === document.activeElement)).toBe(true);
  await page.keyboard.press('Escape'); await expect.poll(() => page.locator('#appsHomeDirectory').isVisible()).toBe(false);
  expect(await page.getByRole('button', { name: 'All applications', exact: true }).evaluate(el => el === document.activeElement)).toBe(true);
}, 30000);

for (const [width, theme, primary, background] of [[1440, 'workspace', '#f5f6f9', 'rgb(245, 246, 249)'],
  [960, 'midnight', '#0a0a12', 'rgb(10, 10, 18)'], [390, 'daylight', '#f0f2f8', 'rgb(240, 242, 248)']] as const) {
  it(`fits the real Home and Jarvis documents at ${width}px in ${theme}`, async () => {
    await page.setViewportSize({ width, height: 1000 }); await open(theme);
    const g = await geometry(); expect(g.overflow).toBeLessThanOrEqual(1); expect(g.frameOverflow).toBeLessThanOrEqual(1);
    expect(g.assistant.x).toBeGreaterThanOrEqual(0); expect(g.summary.right).toBeLessThanOrEqual(g.viewport + 1);
    if (width > 800) { expect(g.summary.x).toBeGreaterThanOrEqual(g.assistant.right); expect(Math.abs(g.summary.y - g.assistant.y)).toBeLessThan(2); }
    else expect(g.summary.y).toBeGreaterThanOrEqual(g.assistant.bottom);
    await expect.poll(() => page.frameLocator('#appsHomeJarvisFrame').locator('html').getAttribute('data-theme')).toBe(theme);
    expect(await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--bg-primary').trim())).toBe(primary);
    const frame = page.frameLocator('#appsHomeJarvisFrame');
    await expect.poll(() => frame.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--bg-primary').trim())).toBe(primary);
    expect(await frame.locator('body').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(background);
    mkdirSync('temp/app-home-daily-canonical-screenshots', { recursive: true });
    await page.screenshot({ path: `temp/app-home-daily-canonical-screenshots/home-${width}-${theme}.png`, fullPage: true });
  }, 30000);
}

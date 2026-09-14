/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reproduce the blocked Cockpit parser and verify full real-shell startup with external scripts stalled or refused.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { APPEARANCE_SCENARIOS } from '@/app/routes/test-lab-appearance-scenarios';
import { startCockpitStartupFixture, startCockpitVendorFixture } from '../fixtures/cockpit-startup';

const ASSETS = [
  ['marked.umd.js', 'node_modules/marked/lib/marked.umd.js'],
  ...['style.css', 'Phosphor.woff2', 'Phosphor.woff', 'Phosphor.ttf', 'Phosphor.svg']
    .map(name => [`phosphor/${name}`, `node_modules/@phosphor-icons/web/src/regular/${name}`]),
];

let fixture: Awaited<ReturnType<typeof startCockpitStartupFixture>>;
let browser: Browser, context: BrowserContext, page: Page;
let release: Array<() => Promise<void>>, external: string[], errors: string[];

beforeAll(async () => { fixture = await startCockpitStartupFixture(); browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); await fixture?.close(); });
beforeEach(async () => {
  fixture.startup.previousWorker = false;
  context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  release = []; external = []; errors = [];
  page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
});
afterEach(async () => { await Promise.all(release.map(done => done())); await context?.close(); });

/** @description Every external request is either held or rejected; no CDN or provider is actually contacted. */
async function externalFailure(mode: 'stall' | 'refuse') {
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
    external.push(route.request().url());
    if (mode === 'refuse') return route.abort('failed');
    return new Promise<void>(done => { release.push(async () => {
      try { await route.abort('failed'); } finally { done(); }
    }); });
  });
}

for (const mode of ['stall', 'refuse'] as const) it(`boots the complete shell when external scripts ${mode}`, async () => {
  await externalFailure(mode);
  await page.goto(fixture.origin + '/cockpit/', { waitUntil: 'commit' });
  await page.locator('body').waitFor({ state: 'attached', timeout: 3000 });
  await page.frameLocator('.tool-view-container iframe').locator('#draft').fill('Retained synthetic draft');
  await page.locator('.ribbon-btn[data-view="settings"]').click();
  await page.locator('#settingsThemePicker').waitFor();
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

it('renders Markdown through the real ticket feed with the local parser', async () => {
  await externalFailure('refuse');
  await page.goto(fixture.origin + '/cockpit/');
  await page.frameLocator('.tool-view-container iframe').locator('#draft').waitFor();
  const summary = '## Synthetic result\n\n**Ready** with `code`.\n\n- First\n- Second\n\n[Home](/cockpit/)';
  await page.addScriptTag({ type: 'module', content: `
    import { buildFeedEntriesHtml } from '/cockpit/js/views/ticket-result-feed-entry.js';
    const host = document.createElement('section'); host.id = 'fixtureFeed';
    host.innerHTML = buildFeedEntriesHtml([{ type: 'user', summary: ${JSON.stringify(summary)} }], {});
    document.body.appendChild(host);
  ` });
  await page.locator('#fixtureFeed').waitFor();
  expect(await page.locator('#fixtureFeed h2').innerText()).toBe('Synthetic result');
  expect(await page.locator('#fixtureFeed strong').innerText()).toBe('Ready');
  expect(await page.locator('#fixtureFeed code').innerText()).toBe('code');
  expect(await page.locator('#fixtureFeed li').count()).toBe(2);
  expect(await page.locator('#fixtureFeed a').getAttribute('href')).toBe('/cockpit/');
  expect(external).toEqual([]); expect(errors).toEqual([]);
});

it('retains the existing engineering topology view without a parent graph preload', async () => {
  await externalFailure('refuse');
  await page.goto(fixture.origin + '/cockpit/');
  await page.locator('.ribbon-btn[data-view="advanced"]').click();
  await page.locator('.adv-sub-btn[data-page="mesh-dashboard"]').click();
  const mesh = page.frameLocator('iframe[title="Mesh Dashboard"]');
  await mesh.locator('#statusBanner').filter({ hasText: 'refreshed successfully' }).waitFor();
  expect(await mesh.locator('#channelTableBody').innerText()).toContain('Synthetic topology');
  expect(await mesh.locator('#metricActiveChannels').innerText()).toBe('1');
  expect(await mesh.locator('#metricParticipants').innerText()).toBe('1');
  await mesh.locator('#refreshButton').click();
  await mesh.locator('#statusBanner').filter({ hasText: 'refreshed successfully' }).waitFor();
  expect(await mesh.locator('#channelTableBody tr').count()).toBe(1);
  expect(external).toEqual([]); expect(errors).toEqual([]);
}, 15000);

it('loads distinct regular icon glyphs from the actual locked font', async () => {
  await externalFailure('refuse');
  await page.goto(fixture.origin + '/cockpit/');
  await page.locator('.ribbon-btn[data-view="settings"]').click();
  const glyphs = await page.evaluate(async () => {
    const icons = Array.from(document.querySelectorAll('.ph'));
    const chars = [...new Set(icons.map(icon => getComputedStyle(icon, '::before').content.replaceAll('"', '')))]
      .filter(value => value.length === 1).slice(0, 2);
    const fonts = await document.fonts.load('24px Phosphor', chars.join(''));
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40;
    const drawing = canvas.getContext('2d')!; drawing.font = '24px Phosphor';
    const images = chars.map(char => { drawing.clearRect(0, 0, 40, 40); drawing.fillText(char, 4, 30); return canvas.toDataURL(); });
    return { count: chars.length, loaded: fonts.some(font => font.family === 'Phosphor' && font.status === 'loaded'), images };
  });
  expect(glyphs.count).toBe(2); expect(glyphs.loaded).toBe(true);
  expect(glyphs.images[0]).not.toBe(glyphs.images[1]); expect(external).toEqual([]); expect(errors).toEqual([]);
});

it('serves exact locked asset bytes behind the existing session gate and excludes other dependency files', async () => {
  const server = await startCockpitVendorFixture();
  try {
    for (const [name, file] of ASSETS) {
      const url = `${server.origin}/cockpit/vendor/${name}`;
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: { 'x-fixture-session': 'signed-in' } });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'))
        .toBe(createHash('sha256').update(readFileSync(file)).digest('hex'));
    }
    for (const path of ['package.json', 'phosphor/package.json', 'phosphor/index.js', 'phosphor/../LICENSE']) {
      expect((await fetch(`${server.origin}/cockpit/vendor/${path}`, { headers: { 'x-fixture-session': 'signed-in' } })).status).toBe(404);
    }
  } finally { await server.close(); }
});

/** @description A fresh browser runs the actual page's worker registration with synthetic API data and explicit saved preferences. */
async function workerBrowser(previousWorker = false) {
  await context.close(); fixture.startup.previousWorker = previousWorker;
  context = await browser.newContext({ serviceWorkers: 'allow' }); await externalFailure('refuse');
  await context.addInitScript(() => {
    localStorage.setItem('cockpit-theme', 'ocean'); localStorage.setItem('oshal-navigation-layout', 'workspaces');
  });
  page = await context.newPage(); page.setDefaultTimeout(5000);
  const navigations = { count: 0 };
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.count += 1; });
  await page.goto(fixture.origin + '/cockpit/?app=fixture-studio');
  await page.frameLocator('.tool-view-container iframe').locator('#draft').waitFor();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  return navigations;
}

it('precaches exact local assets on first installation and reads them offline without a startup reload', async () => {
  const navigations = await workerBrowser();
  const cached = await page.evaluate(async (paths) => Promise.all(paths.map(async path => {
    const response = await caches.match('/cockpit/vendor/' + path);
    if (!response) return null;
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  })), ASSETS.map(([name]) => name));
  expect(cached).toEqual(ASSETS.map(([, file]) => createHash('sha256').update(readFileSync(file)).digest('hex')));
  await context.setOffline(true);
  const offline = await page.evaluate(async () => ({
    marked: (await (await fetch('/cockpit/vendor/marked.umd.js')).text()).includes('marked'),
    font: (await (await fetch('/cockpit/vendor/phosphor/Phosphor.woff2')).arrayBuffer()).byteLength,
    theme: document.documentElement.dataset.theme, layout: document.documentElement.dataset.navigationLayout,
  }));
  expect(offline.marked).toBe(true); expect(offline.font).toBeGreaterThan(1000);
  expect(offline.theme).toBe('ocean'); expect(offline.layout).toBe('workspaces'); expect(external).toEqual([]);
  expect(navigations.count).toBe(1);
}, 15000);

it('updates the real worker with one reload and retains the saved palette, layout and focused application', async () => {
  await workerBrowser(true);
  let reloads = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) reloads += 1; });
  fixture.startup.previousWorker = false;
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await expect.poll(() => reloads, { timeout: 10000 }).toBe(1);
  await page.frameLocator('.tool-view-container iframe').locator('#draft').waitFor();
  await page.waitForLoadState('load');
  expect(page.url()).toBe(fixture.origin + '/cockpit/?app=fixture-studio');
  const state = await page.evaluate(async () => ({ theme: document.documentElement.dataset.theme,
    layout: document.documentElement.dataset.navigationLayout, caches: await caches.keys() }));
  expect(state.theme).toBe('ocean'); expect(state.layout).toBe('workspaces');
  expect(state.caches.some(name => name.includes('fixture-previous'))).toBe(false);
  expect(reloads).toBe(1); expect(external).toEqual([]);
}, 15000);

it('links the browser recipe in the existing Lab card without claiming its readiness GET runs it', () => {
  const card = APPEARANCE_SCENARIOS.find(item => item.id === 'cockpit-appearance');
  expect(card?.regressionTests).toContainEqual({ level: 'browser', path: 'tests/unit/cockpit-startup-browser.spec.ts' });
  expect(card?.description).toContain('does not execute the browser suite');
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  expect(scripts['test:cockpit-startup']).toContain('tests/unit/cockpit-startup-browser.spec.ts');
});

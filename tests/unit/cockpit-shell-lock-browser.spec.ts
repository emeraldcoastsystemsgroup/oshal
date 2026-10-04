/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The focused-landing shell lock in Chromium over the real cockpit document and app.js boot (tests/fixtures/workspace-navigation.ts; only the profile answer is chosen per case). A refused profile with a ticket deep link shows the refusal and never asks for tickets; header Settings, Knowledge, Central assistant and Simple chat are not displayed, the logo returns to the landing, no platform view is registered, and neither a view navigation posted to the shell nor the Settings handler replaces the refusal. A locked allowed application keeps only its own rail and ignores the ticket link. An unreadable answer on the plain document stays closed. An unlocked verdict draws every door exactly as before.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Exercise malformed profile refusal, phone layout and keyboard retry against the real document; count profile reads at the answering route.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { startWorkspaceNavigationFixture } from '../fixtures/workspace-navigation';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';

vi.setConfig({ testTimeout: 30_000, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

const LANDING_APP = 'fixture-sales';
/** The profile answer for the current case; null keeps the fixture's ordinary unlocked profile. */
let answer: { status: number; body: unknown; text?: boolean } | null = null;
let profileReads = 0;
let fixture: Awaited<ReturnType<typeof startWorkspaceNavigationFixture>>;
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>, browser: Browser;
let context: BrowserContext, page: Page, errors: string[];

const LOCKED_APP = {
  profile: { name: LANDING_APP, displayName: 'Synthetic Sales', defaultView: 'tool-fixture-editor', ribbon: { items: [
    { id: 'tool-fixture-editor', label: 'Editor', section: 'home', toolUi: { iframeUrl: '/fixture/editor?mode=edit' } }], dynamicTools: { allow: [] } } },
  requested: LANDING_APP, source: 'swarm-app', landingApp: LANDING_APP, operator: false,
};

beforeAll(async () => { owned = await launchIsolatedBrowser(); browser = owned.browser; });
afterAll(async () => { await owned?.close(); }, BROWSER_HOOK_TIMEOUT_MS);
beforeEach(async () => {
  answer = null;
  profileReads = 0;
  fixture = await startWorkspaceNavigationFixture((app) => {
    app.get('/api/ui/profile', (_req, res, next) => {
      profileReads++;
      if (!answer) { next(); return; }
      if (answer.text) res.status(answer.status).type('text').send(String(answer.body));
      else res.status(answer.status).json(answer.body);
    });
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/*', route => (new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort()));
  page = await context.newPage(); page.setDefaultTimeout(10_000); errors = [];
  page.on('pageerror', error => errors.push(error.message));
});

it('keeps malformed successful profiles closed on a phone with a keyboard-operable retry', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  answer = { status: 200, body: { profile: {} } };
  await open('/cockpit/?ticket=T-9');
  const panel = page.locator('#mainContent'); await panel.getByRole('heading', { name: 'Application unavailable' }).waitFor();
  expect(await ribbonState()).toEqual({ locked: true, collapsed: true, views: [] });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const door of ['#portalSettingsBtn', '#ragBtn', 'a[data-experience="/nexus"]', 'a[data-experience="/simple"]']) expect(await displayed(door)).toBe(false);
  let retryFocused = false;
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab');
    retryFocused = await panel.getByRole('button', { name: 'Reload', exact: true }).evaluate(el => el === document.activeElement);
    if (retryFocused) break;
  }
  expect(retryFocused).toBe(true);
  const before = profileReads;
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#mainContent h1')?.textContent === 'Application unavailable');
  await expect.poll(() => profileReads).toBeGreaterThan(before);
  expect(await ribbonState()).toEqual({ locked: true, collapsed: true, views: [] }); expect(errors).toEqual([]);
});
afterEach(async () => { await context?.close(); await fixture?.close(); });

/** @description Open the cockpit and wait for the ribbon's verdict. @param path Path and query. */
async function open(path: string) {
  await page.goto(fixture.origin + path);
  await page.waitForFunction(() => typeof (window as unknown as { __cockpit?: { ribbon?: { shellLocked?: boolean } } }).__cockpit?.ribbon?.shellLocked === 'boolean');
}
/** Whether an element is laid out at all (display none hides it whatever menu holds it). */
const displayed = (selector: string) => page.locator(selector).evaluate(el => getComputedStyle(el).display !== 'none');
const ribbonState = () => page.evaluate(() => {
  const ribbon = (window as unknown as { __cockpit: { ribbon: { shellLocked: boolean; hidePlatformChrome: boolean; views: Array<{ id: string }> } } }).__cockpit.ribbon;
  return { locked: ribbon.shellLocked, collapsed: ribbon.hidePlatformChrome, views: ribbon.views.map(view => view.id) };
});
const mainText = () => page.locator('#mainContent').innerText();
/** Two animation frames, so a posted message or a handler has had its chance to render. */
const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));

it('a refused profile with a ticket link shows only the refusal, every door closed and nothing registered', async () => {
  answer = { status: 403, body: { error: 'experience_navigation_refused', landingApp: LANDING_APP, operator: false } };
  await open('/cockpit/?app=refused-exp&ticket=T-9');
  await page.locator('#mainContent').getByText('Application unavailable').waitFor();
  expect(await ribbonState()).toEqual({ locked: true, collapsed: true, views: [] });
  for (const door of ['#portalSettingsBtn', '#ragBtn', 'a[data-experience="/nexus"]', 'a[data-experience="/simple"]']) expect(await displayed(door), door).toBe(false);
  expect(await page.locator('#cockpitHomeLink').getAttribute('href')).toBe(`/cockpit/?app=${LANDING_APP}`);
  await page.evaluate(() => window.postMessage({ type: 'app-navigate', view: 'operations' }, location.origin));
  await page.evaluate(() => (window as unknown as { __cockpit: { openCockpitSettingsPage: (tab?: string) => void } }).__cockpit.openCockpitSettingsPage('knowledge'));
  await settle();
  expect(await mainText()).toContain('Application unavailable');
  // TicketView's first read is the active application list; the Experiences menu reads /api/ui/experiences.
  expect(fixture.state.requests).not.toContain('GET /api/swarm/apps');
  expect(fixture.state.requests).not.toContain('GET /api/ui/experiences');
  expect(errors).toEqual([]);
});

it('a locked allowed application keeps only its own rail and ignores a ticket link it has no Tickets for', async () => {
  answer = { status: 200, body: LOCKED_APP };
  await open(`/cockpit/?app=${LANDING_APP}&ticket=T-9`);
  await page.frameLocator('.tool-view-container iframe').locator('h1').waitFor();
  expect(await ribbonState()).toEqual({ locked: true, collapsed: true, views: ['tool-fixture-editor'] });
  expect(await page.locator('#ribbonContainer .ribbon-btn').count()).toBe(1);
  expect(await displayed('#portalSettingsBtn')).toBe(false);
  expect(await page.locator('#cockpitHomeLink').getAttribute('href')).toBe(`/cockpit/?app=${LANDING_APP}`);
  expect(fixture.state.requests).not.toContain('GET /api/swarm/apps');
  expect(errors).toEqual([]);
});

it('a filtered default opens its admitted tool rather than the native Tickets workbench', async () => {
  answer = { status: 200, body: { ...LOCKED_APP, profile: { ...LOCKED_APP.profile, defaultView: 'tickets' } } };
  await open(`/cockpit/?app=${LANDING_APP}&ticket=T-9`);
  await page.frameLocator('.tool-view-container iframe').locator('h1').waitFor();
  expect(fixture.state.requests).not.toContain('GET /api/swarm/apps');
  expect(await ribbonState()).toEqual({ locked: true, collapsed: true, views: ['tool-fixture-editor'] });
  expect(await page.locator('#ribbonContainer [data-view="tool-fixture-editor"]').getAttribute('class')).toContain('active');
  expect(errors).toEqual([]);
});

it('an empty admitted rail shows an empty state and still loads its admitted dynamic tool', async () => {
  answer = { status: 200, body: { ...LOCKED_APP, profile: { ...LOCKED_APP.profile, defaultView: null,
    ribbon: { items: [], dynamicTools: { allow: ['fixture-editor'] } } } } };
  fixture.state.dynamicTools = [{ toolName: 'fixture-editor', ui: { iframeUrl: '/fixture/editor?mode=edit', sidebarLabel: 'Editor' } }];
  await open(`/cockpit/?app=${LANDING_APP}&ticket=T-9`);
  await page.locator('#mainContent').getByRole('heading', { name: 'No views available' }).waitFor();
  expect(fixture.state.requests).not.toContain('GET /api/swarm/apps');
  await page.locator('#ribbonContainer [data-view="tool-fixture-editor"]').click();
  await page.frameLocator('.tool-view-container iframe').locator('h1').waitFor();
  expect(await ribbonState()).toEqual({ locked: true, collapsed: true, views: ['tool-fixture-editor'] });
  expect(errors).toEqual([]);
});

it('an unreadable profile on the plain document stays closed: no framework rail, no doors', async () => {
  answer = { status: 502, body: 'fixture gateway unavailable', text: true };
  await open('/cockpit/');
  await page.locator('#mainContent').getByText('Application unavailable').waitFor();
  expect(await ribbonState()).toEqual({ locked: true, collapsed: true, views: [] });
  expect(await page.locator('#cockpitHomeLink').getAttribute('href')).toBeNull();
  for (const door of ['#portalSettingsBtn', '#ragBtn', 'a[data-experience="/nexus"]']) expect(await displayed(door), door).toBe(false);
  expect(errors).toEqual([]);
});

it('an unlocked verdict draws every door exactly as before and keeps the platform tools', async () => {
  await open('/cockpit/');
  await page.frameLocator('.tool-view-container iframe').locator('h1').waitFor();
  const state = await ribbonState();
  expect(state.locked).toBe(false);
  expect(state.views).toEqual(expect.arrayContaining(['tool-fixture-editor', 'operations', 'tool-help', 'tool-my-data']));
  expect(await page.locator('#cockpitHomeLink').getAttribute('href')).toBe('/cockpit/');
  for (const door of ['#portalSettingsBtn', '#ragBtn', 'a[data-experience="/nexus"]', 'a[data-experience="/simple"]']) {
    expect(await page.locator(door).getAttribute('hidden'), door).toBeNull();
    expect(await displayed(door), door).toBe(true);
  }
  expect(errors).toEqual([]);
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real default-profile sidebar delegation and admitted Federal CRM navigation while preserving application pages and iframe state.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startWorkspaceNavigationFixture } from '../fixtures/workspace-navigation';
import type { UIProfileRibbonItem } from '@/features/ui-profile/types';

let fixture: Awaited<ReturnType<typeof startWorkspaceNavigationFixture>>;
let browser: Browser, context: BrowserContext, page: Page;
let errors: string[], external: string[];
const editor = () => page.frameLocator('.tool-view-container iframe');

/** @description Boot the real shell around an isolated custom screen. */
async function open(path = '/cockpit/', layout?: string, theme?: string) {
  if (layout || theme) await context.addInitScript(({ layout, theme }) => {
    if (sessionStorage.getItem('fixture-navigation-seeded')) return;
    sessionStorage.setItem('fixture-navigation-seeded', '1');
    if (layout) localStorage.setItem('oshal-navigation-layout', layout);
    if (theme) localStorage.setItem('cockpit-theme', theme);
  }, { layout, theme });
  await page.goto(fixture.origin + path);
  await page.locator('#workspaceNavigationToggle').waitFor({ state: 'attached' });
  await editor().locator('h1').waitFor();
}

/** @description Use the actual shared header navigation selector. */
async function chooseLayout(value: 'sidebar' | 'workspaces') {
  const toggle = await headerControl('#workspaceNavigationToggle');
  if (await page.locator('#workspaceNavigationOptions').isHidden()) await toggle.click();
  await page.locator(`input[name=workspace-navigation-layout][value=${value}]`).check();
}

/** @description Reach real controls through their current header disclosure. */
async function headerControl(selector: string) {
  const control = page.locator(selector);
  if (await control.isVisible()) return control;
  if (await page.locator('html').getAttribute('data-navigation-layout') === 'workspaces') {
    const compact = page.locator('#workspaceNavigationCompactToggle');
    if (await compact.isVisible() && await compact.getAttribute('aria-expanded') === 'false') await compact.click();
    const more = page.locator('#workspaceNavigationMore');
    if (await more.getAttribute('open') === null) await more.locator('summary').click();
  } else await page.locator('#cockpitHeaderOptions > summary').click();
  return control;
}

/** @description Wait for a current admitted destination. */
async function discovered() { await page.locator('#workspaceNavigation [data-workspace=create]').waitFor({ state: 'attached' }); }

/** @description Measure trigger alignment and real pointer access. */
async function expectMoreAnchored() {
  const measure = () => page.locator('#workspaceNavigationMore').evaluate(element => {
    const trigger = element.querySelector('summary')!.getBoundingClientRect();
    const menu = element.querySelector('.workspace-navigation-more')!.getBoundingClientRect();
    const link = element.querySelector('a')!, hit = link.getBoundingClientRect();
    return { trigger: { left: trigger.left, right: trigger.right, bottom: trigger.bottom },
      menu: { left: menu.left, top: menu.top, right: menu.right, width: menu.width }, width: innerWidth,
      reachable: link.contains(document.elementFromPoint(hit.left + hit.width / 2, hit.top + hit.height / 2)) };
  });
  await expect.poll(async () => {
    const geometry = await measure();
    const edge = geometry.trigger.left + geometry.menu.width > geometry.width - 12 ? 'right' : 'left';
    return Math.abs(geometry.menu[edge] - geometry.trigger[edge]);
  }).toBeLessThanOrEqual(1);
  const geometry = await measure();
  expect(geometry.menu.top - geometry.trigger.bottom).toBeGreaterThanOrEqual(0);
  expect(geometry.menu.top - geometry.trigger.bottom).toBeLessThanOrEqual(12);
  expect(geometry.menu.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.reachable).toBe(true);
}

/** @description Capture only synthetic fixture content for review. */
async function screenshot(name: string) {
  const directory = process.env.WORKSPACE_NAVIGATION_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `synthetic-${name}.png`), fullPage: true, animations: 'disabled' });
}

/** @description Check viewport bounds and actual hit testing. */
async function menuControlReachable(selector: string) {
  return page.locator(selector).evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight
      && element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  });
}

beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30000);
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  fixture = await startWorkspaceNavigationFixture();
  context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  errors = []; external = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
});
afterEach(async () => { await context?.close(); await fixture?.close(); });

/** @description Use real framework metadata with only its iframe bodies and dynamic class data made synthetic. */
function contextualProfile(name = '') {
  const profile = JSON.parse(readFileSync(resolve('config-seed/profiles/oshal-framework.json'), 'utf8'));
  if (name) profile.ribbon.items = profile.ribbon.items.filter((item: UIProfileRibbonItem) =>
    typeof item !== 'string' && item.workspace === name);
  profile.ribbon.items.forEach((item: UIProfileRibbonItem) => {
    if (typeof item !== 'string' && item.toolUi) item.toolUi.iframeUrl = `/fixture/editor?tool=${item.id}`;
  });
  profile.ribbon.items.unshift({ id: 'tool-fixture-editor', label: 'Synthetic editor', section: 'home',
    toolUi: { iframeUrl: '/fixture/editor?mode=edit', sidebarLabel: 'Synthetic editor' } });
  profile.defaultView = 'tool-fixture-editor';
  if (name) profile.name = name;
  fixture.state.profiles[name] = profile;
  fixture.state.dynamicTools = [{ toolName: 'lm-class-12345678', ui: {
    iframeUrl: '/fixture/editor?class=synthetic', sidebarLabel: 'Synthetic class', sidebarGroup: 'Little Monsters' } }];
}

it.each(['intelligent-career', 'career-hunter'])('delegates admitted application bands from the real default sidebar with %s while preserving unique tools and its active iframe', async career => {
  fixture.state.workspaces.find(item => item.name === 'intelligent-career')!.name = career;
  fixture.state.workspaces.find(item => item.name === career)!.href = `/cockpit/?app=${career}`;
  contextualProfile(); await open('/cockpit/', 'sidebar', 'daylight');
  await page.locator('.ribbon-btn[data-view=tool-lm-class-12345678]').waitFor();
  await editor().locator('#draft').fill('Synthetic delegated-sidebar draft');
  const documentId = await editor().locator('html').getAttribute('data-document-id');
  await chooseLayout('workspaces'); await discovered();
  for (const id of ['tool-lm-dashboard', 'tool-lm-class-12345678', 'tool-career-board', 'tool-presentations-studio'])
    expect(await page.locator(`.ribbon-btn[data-view=${id}]`).count()).toBe(0);
  for (const group of ['Little Monsters', 'Career Placement', 'Create'])
    expect(await page.locator('.ribbon-group-label').filter({ hasText: group }).count()).toBe(0);
  for (const id of ['tool-forge', 'tool-workflow-studio', 'tool-pumpkin', 'tool-govcon-board', 'tool-govcon-plan'])
    expect(await page.locator(`.ribbon-btn[data-view=${id}]`).count()).toBe(1);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.locator('#ribbonNavInner').hover(); await screenshot(`contextual-default-sidebar-${career}`);
  await chooseLayout('sidebar');
  for (const id of ['tool-lm-dashboard', 'tool-lm-class-12345678', 'tool-career-board', 'tool-presentations-studio'])
    expect(await page.locator(`.ribbon-btn[data-view=${id}]`).count()).toBe(1);
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(documentId);
  expect(await editor().locator('#draft').inputValue()).toBe('Synthetic delegated-sidebar draft');
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it('restores the default sidebar on failed discovery and delegates only destinations admitted by Retry', async () => {
  contextualProfile(); await open('/cockpit/', 'workspaces'); await discovered();
  expect(await page.locator('.ribbon-btn[data-view=tool-lm-dashboard]').count()).toBe(0);
  fixture.state.workspaceStatus = 403;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  expect(await page.locator('.ribbon-btn[data-view=tool-lm-dashboard]').count()).toBe(1);
  fixture.state.workspaceStatus = 200;
  fixture.state.workspaces = fixture.state.workspaces.filter(item => item.name !== 'little-monsters');
  await page.getByRole('button', { name: 'Retry', exact: true }).click(); await discovered();
  expect(await page.locator('.ribbon-btn[data-view=tool-lm-dashboard]').count()).toBe(1);
  expect(await page.locator('.ribbon-btn[data-view=tool-presentations-studio]').count()).toBe(0);
  expect(await page.locator('[data-workspace=little-monsters]').count()).toBe(0);
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it('retains an active delegated page and resolves registered hidden pages through the existing iframe bridge', async () => {
  contextualProfile(); await open('/cockpit/', 'sidebar');
  await page.locator('.ribbon-btn[data-view=tool-presentations-studio]').click();
  await editor().locator('#draft').fill('Synthetic active-studio draft');
  const documentId = await editor().locator('html').getAttribute('data-document-id');
  await chooseLayout('workspaces'); await discovered();
  expect(await page.locator('.ribbon-btn[data-view=tool-presentations-studio]').count()).toBe(1);
  expect(await page.locator('.ribbon-btn[data-view=tool-lm-tutor]').count()).toBe(0);
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(documentId);
  await editor().locator('body').evaluate(() => parent.postMessage({ type: 'app-navigate', tool: 'lm-tutor' }, location.origin));
  await expect.poll(() => page.locator('.tool-view-container iframe').getAttribute('src')).toContain('tool=tool-lm-tutor');
  expect(await page.locator('.ribbon-btn[data-view=tool-lm-tutor].active').count()).toBe(1);
  expect(await page.locator('.ribbon-btn[data-view=tool-presentations-studio]').count()).toBe(0);
  await expect.poll(() => editor().locator('html').getAttribute('data-document-id')).not.toBeNull();
  const tutorId = await editor().locator('html').getAttribute('data-document-id');
  await Promise.all([
    page.waitForEvent('console', { predicate: message => message.text().includes('Bridge navigation target not in ribbon') }),
    editor().locator('body').evaluate(() => parent.postMessage({ type: 'app-navigate', tool: 'synthetic-not-registered' }, location.origin)),
  ]);
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(tutorId);
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it.each(['little-monsters', 'create'])('keeps focused %s internal pages available under its top workspace', async name => {
  contextualProfile(name); await open(`/cockpit/?app=${name}`, 'workspaces', 'daylight'); await discovered();
  const internal = name === 'create' ? 'tool-presentations-studio' : 'tool-lm-tutor';
  expect(await page.locator(`.ribbon-btn[data-view=${internal}]`).count()).toBe(1);
  if (name === 'little-monsters') await page.locator('.ribbon-btn[data-view=tool-lm-class-12345678]').waitFor();
  await page.locator(`.ribbon-btn[data-view=${internal}]`).click();
  await expect.poll(() => page.locator('.tool-view-container iframe').getAttribute('src')).toContain(`tool=${internal}`);
  await editor().locator('#draft').fill('Synthetic focused-page draft');
  const documentId = await editor().locator('html').getAttribute('data-document-id');
  await chooseLayout('sidebar');
  expect(await page.locator(`.ribbon-btn[data-view=${internal}]`).count()).toBe(1);
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(documentId);
  expect(await editor().locator('#draft').inputValue()).toBe('Synthetic focused-page draft');
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it('keeps keyboard focus on a default-sidebar page after its contextual buttons update', async () => {
  contextualProfile(); await open('/cockpit/', 'workspaces'); await discovered();
  const button = page.locator('.ribbon-btn[data-view=tool-govcon-board]');
  await button.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('.tool-view-container iframe').getAttribute('src')).toContain('tool=tool-govcon-board');
  expect(await button.evaluate(element => element === document.activeElement)).toBe(true);
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it('opens the admitted Federal CRM as a first-class tab and removes it when permission discovery withdraws it', async () => {
  fixture.state.workspaces.push({ name: 'capture-crm', displayName: 'Federal CRM', kind: 'app', href: '/cockpit/?app=capture-crm' });
  await open('/cockpit/?app=create', 'workspaces', 'daylight'); await discovered();
  const crm = page.locator('.workspace-navigation-links [data-workspace=capture-crm]');
  expect(await crm.count()).toBe(1);
  expect(await crm.innerText()).toBe('Federal CRM');
  expect(await crm.getAttribute('href')).toBe('/cockpit/?app=capture-crm');
  expect(await page.locator('#workspaceNavigationMore [data-workspace=capture-crm]').count()).toBe(0);
  await crm.click(); await page.waitForURL(fixture.origin + '/cockpit/?app=capture-crm'); await discovered();
  expect(await crm.getAttribute('aria-current')).toBe('page');
  await editor().locator('#draft').fill('Synthetic Federal CRM draft');
  const documentId = await editor().locator('html').getAttribute('data-document-id');
  await (await headerControl('#workspaceNavigationToggle')).focus();
  fixture.state.workspaces = fixture.state.workspaces.filter(item => item.name !== 'capture-crm');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await discovered();
  expect(await page.locator('[data-workspace=capture-crm]').count()).toBe(0);
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(documentId);
  expect(await editor().locator('#draft').inputValue()).toBe('Synthetic Federal CRM draft');
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it.each([960, 390])('keeps the admitted Federal CRM tab and More reachable at %ipx', async width => {
  fixture.state.workspaces.push({ name: 'capture-crm', displayName: 'Federal CRM', kind: 'app', href: '/cockpit/?app=capture-crm' });
  await page.setViewportSize({ width, height: 844 });
  await open('/cockpit/?app=create', 'workspaces', 'daylight'); await discovered();
  if (width === 390) await page.locator('#workspaceNavigationCompactToggle').click();
  const crm = page.locator('.workspace-navigation-links [data-workspace=capture-crm]');
  await crm.focus(); expect(await menuControlReachable('.workspace-navigation-links [data-workspace=capture-crm]')).toBe(true);
  await page.locator('#workspaceNavigationMore > summary').click();
  expect(await menuControlReachable('#themeToggle')).toBe(true);
  if (width !== 390) await expectMoreAnchored();
  await screenshot(`federal-crm-tab-${width}`);
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

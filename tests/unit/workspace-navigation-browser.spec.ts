/**
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove optional workspace navigation preserves real Cockpit custom screens, links, permissions feedback and independent theme preferences.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Verify the Career heading uses the admitted app fallback and prefers the group without duplicating the selected destination in More.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Use held real HTTP responses and Chromium virtual time to cover cold discovery beyond five seconds and the bounded thirty-second retry path.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Measure the real top-header layout and unclipped compact menus with long labels, keyboard controls and retained iframe drafts.
 * =============================================================================
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startWorkspaceNavigationFixture } from '../fixtures/workspace-navigation';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';

let fixture: Awaited<ReturnType<typeof startWorkspaceNavigationFixture>>;
let browser: Browser, context: BrowserContext, page: Page;
let errors: string[], external: string[];
const editor = () => page.frameLocator('.tool-view-container iframe');

/** @description Boot actual app.js and wait for its real custom-surface renderer. */
async function open(path = '/cockpit/', layout?: string, theme?: string) {
  if (layout || theme) await context.addInitScript(({ layout, theme }) => {
    if (sessionStorage.getItem('fixture-navigation-seeded')) return;
    sessionStorage.setItem('fixture-navigation-seeded', '1');
    if (layout) localStorage.setItem('oshal-navigation-layout', layout);
    if (theme) localStorage.setItem('cockpit-theme', theme);
  }, { layout, theme });
  await page.goto(fixture.origin + path);
  await page.locator('#workspaceNavigationToggle').waitFor();
  await editor().locator('h1').waitFor();
}

/** @description Use only the real header preference controls. */
async function chooseLayout(value: 'sidebar' | 'workspaces') {
  if (await page.locator('#workspaceNavigationOptions').isHidden()) await page.locator('#workspaceNavigationToggle').click();
  await page.locator(`input[name=workspace-navigation-layout][value=${value}]`).check();
}

/** @description Wait for a current admitted response without relying on generic network-idle. */
async function discovered() { await page.locator('#workspaceNavigation [data-workspace=create]').waitFor({ state: 'attached' }); }

/** @description Read rendered header boundaries so misplaced rows and overlapping controls fail in Chromium. */
async function headerGeometry() {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector)!;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
    };
    return { header: rect('.header-bar'), body: rect('.cockpit-body'), brand: rect('.header-left'),
      rail: rect('#workspaceNavigation'), actions: rect('.header-right'),
      inside: document.querySelector('.header-bar')!.contains(document.querySelector('#workspaceNavigation')),
      overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
}

/** @description Require a single header row with usable separate brand, navigation and action regions. */
async function expectHeaderRow() {
  const geometry = await headerGeometry();
  expect(geometry.inside).toBe(true);
  expect(geometry.overflow).toBe(false);
  expect(geometry.header.height).toBeLessThanOrEqual(56);
  for (const box of [geometry.brand, geometry.rail, geometry.actions]) {
    expect(box.left).toBeGreaterThanOrEqual(geometry.header.left);
    expect(box.right).toBeLessThanOrEqual(geometry.header.right);
    expect(box.top).toBeGreaterThanOrEqual(geometry.header.top);
    expect(box.bottom).toBeLessThanOrEqual(geometry.header.bottom);
  }
  expect(geometry.brand.right).toBeLessThanOrEqual(geometry.rail.left);
  expect(geometry.rail.right).toBeLessThanOrEqual(geometry.actions.left);
  expect(geometry.body.top).toBeCloseTo(geometry.header.bottom, 0);
}

/** @description Check the visible final menu link remains within the viewport and receives real pointer hits. */
async function expectMenuReachable() {
  const link = page.locator('[data-workspace-all]');
  await link.scrollIntoViewIfNeeded();
  const geometry = await link.evaluate(element => {
    const box = element.getBoundingClientRect(), header = document.querySelector('.header-bar')!.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, headerBottom: header.bottom,
      width: innerWidth, height: innerHeight,
      hit: element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.headerBottom);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height); expect(geometry.hit).toBe(true);
}

/** @description Capture optional review evidence containing only the isolated synthetic surface. */
async function screenshot(name: string) {
  const directory = process.env.WORKSPACE_NAVIGATION_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `synthetic-${name}.png`), fullPage: true, animations: 'disabled' });
}

/** @description Exercise the existing theme button around the same custom document and capture both header palettes. */
async function headerThemeVariants(label: string) {
  const documentId = await editor().locator('html').getAttribute('data-document-id');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  await screenshot(`header-${label}-workspace`);
  await page.locator('#themeToggle').click();
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await expect.poll(() => editor().locator('html').getAttribute('data-theme')).toBe('midnight');
  await expectHeaderRow(); await screenshot(`header-${label}-midnight`);
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(documentId);
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

it.each([1440, 960, 768])('places workspace links beside the brand in one unclipped header row at %ipx', async width => {
  fixture.state.profileDisplayName = 'Synthetic application with a deliberately long brand';
  fixture.state.workspaces.find(item => item.name === 'fixture-studio')!.displayName = 'Synthetic studio with a long workspace label';
  await page.setViewportSize({ width, height: 960 });
  await open('/cockpit/?app=fixture-studio', 'workspaces', 'workspace'); await discovered();
  await expectHeaderRow();
  expect(await page.locator('.logo-text').isVisible()).toBe(true);
  expect(await page.locator('.logo-text').innerText()).toBe(fixture.state.profileDisplayName);
  await page.locator('#workspaceNavigationMore > summary').click(); await expectMenuReachable();
  await screenshot(`header-${width}-more`); await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Tab');
  const link = page.locator('#workspaceNavigation [data-workspace=intelligent-career]');
  expect(await link.evaluate(element => document.activeElement === element)).toBe(true);
  expect(await link.evaluate(element => { const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)); })).toBe(true);
  await expectHeaderRow(); await headerThemeVariants(String(width));
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it('opens an unclipped phone workspace menu beside the brand without replacing an iframe draft', async () => {
  page.setDefaultTimeout(5000);
  fixture.state.workspaces.find(item => item.name === 'fixture-studio')!.displayName = 'Synthetic studio ' + 'long label '.repeat(10);
  await page.setViewportSize({ width: 390, height: 844 });
  await open('/cockpit/?app=fixture-studio&record=17#draft', 'workspaces', 'workspace'); await discovered();
  await editor().locator('#draft').fill('Synthetic phone draft');
  const before = await editor().locator('html').getAttribute('data-document-id'), url = page.url();
  await expectHeaderRow();
  const toggle = page.getByRole('button', { name: 'Application workspaces', exact: true });
  expect(await toggle.getAttribute('aria-expanded')).toBe('false');
  await toggle.focus(); await page.keyboard.press('Enter');
  expect(await toggle.getAttribute('aria-expanded')).toBe('true');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.workspace)).toBe('cockpit');
  await page.locator('#workspaceNavigationMore > summary').click(); await expectMenuReachable();
  await screenshot('header-phone-more'); await page.keyboard.press('Escape');
  expect(await page.locator('#workspaceNavigationMore').getAttribute('open')).toBeNull();
  await page.keyboard.press('Escape'); expect(await toggle.getAttribute('aria-expanded')).toBe('false');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('workspaceNavigationCompactToggle');
  await toggle.click(); await page.setViewportSize({ width: 768, height: 960 });
  expect(await page.locator('#workspaceNavigationCompactToggle').getAttribute('aria-expanded')).toBe('false'); await expectHeaderRow();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await toggle.getAttribute('aria-expanded')).toBe('false'); await expectHeaderRow();
  await page.locator('#workspaceNavigationToggle').click();
  expect(await page.locator('#workspaceNavigationOptions').isVisible()).toBe(true); await page.keyboard.press('Escape');
  expect(await page.locator('#themeToggle').isVisible()).toBe(true);
  expect(await editor().locator('#draft').inputValue()).toBe('Synthetic phone draft');
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(before);
  await headerThemeVariants('390');
  expect(page.url()).toBe(url); expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it('keeps phone discovery failure and Retry usable inside the compact header menu', async () => {
  fixture.state.workspaceStatus = 403;
  await page.setViewportSize({ width: 390, height: 844 });
  await open('/cockpit/?app=create', 'workspaces');
  await expectHeaderRow();
  await page.getByRole('button', { name: 'Application workspaces', exact: true }).click();
  await page.locator('[data-workspace-status]').filter({ hasText: 'Workspaces unavailable' }).waitFor();
  expect(await page.locator('[data-workspace=create]').count()).toBe(0);
  const retry = page.locator('#workspaceNavigation').getByRole('button', { name: 'Retry', exact: true });
  expect(await retry.evaluate(element => { const box = element.getBoundingClientRect();
    return box.bottom <= innerHeight && element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)); })).toBe(true);
  fixture.state.workspaceStatus = 200; await retry.click(); await discovered();
  expect(await page.locator('[data-workspace=create]').isVisible()).toBe(true);
  await expectHeaderRow(); expect(errors).toEqual([]);
}, 30000);

it('defaults to the existing rail and changes only chrome around an unsaved custom screen', async () => {
  await open('/cockpit/?app=create&workspace=team-a#draft-17', undefined, 'ocean');
  expect(await page.locator('html').getAttribute('data-navigation-layout')).toBe('sidebar');
  expect(await page.locator('#workspaceNavigation').isHidden()).toBe(true);
  await editor().locator('#draft').fill('Unsaved local draft');
  const before = await editor().locator('html').getAttribute('data-document-id'), url = page.url();
  const ribbonCount = await page.locator('#ribbonContainer .ribbon-btn').count();
  await chooseLayout('workspaces'); await discovered();
  expect(await editor().locator('#draft').inputValue()).toBe('Unsaved local draft');
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(before);
  expect(page.url()).toBe(url); expect(await page.locator('#ribbonContainer .ribbon-btn').count()).toBe(ribbonCount);
  expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean');
  await page.keyboard.press('Escape'); await screenshot('desktop-draft');
  await chooseLayout('sidebar'); expect(await page.locator('#workspaceNavigation').isHidden()).toBe(true);
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('ocean');
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it('persists through the real Settings selector separately from the Workspace color choice', async () => {
  await open('/cockpit/', 'invalid-layout', 'workspace');
  expect(await page.locator('html').getAttribute('data-navigation-layout')).toBe('sidebar');
  await page.locator('.ribbon-btn[data-view=settings]').click();
  await page.locator('#settingsNavigationLayout').selectOption('workspaces'); await discovered();
  await page.locator('#settingsThemePicker [data-theme=ocean]').click();
  expect(await page.evaluate(() => localStorage.getItem('oshal-navigation-layout'))).toBe('workspaces');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('ocean');
  await page.reload(); await editor().locator('h1').waitFor(); await discovered();
  expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean');
  await chooseLayout('sidebar'); await page.keyboard.press('Escape');
  await page.locator('.ribbon-btn[data-view=settings]').click();
  expect(await page.locator('#settingsNavigationLayout').inputValue()).toBe('sidebar');
  expect(errors).toEqual([]);
}, 30000);

it('offers only admitted canonical destinations and keeps other applications in the real More menu', async () => {
  fixture.state.workspaces = fixture.state.workspaces.filter(item => item.name !== 'intelligent-career');
  fixture.state.workspaces.push({ name: 'foreign-target', displayName: 'Forbidden external link', kind: 'app', href: 'https://example.invalid/' });
  await open('/cockpit/?app=fixture-studio', 'workspaces'); await discovered();
  expect(await page.locator('[data-workspace=little-monsters]').innerText()).toBe('Learning');
  expect(await page.locator('[data-workspace=cockpit]').innerText()).toBe('oshal Cockpit');
  expect(await page.locator('[data-workspace=intelligent-career]').count()).toBe(0);
  expect(await page.locator('[data-workspace=not-installed]').count()).toBe(0);
  expect(await page.locator('[data-workspace=foreign-target]').count()).toBe(0);
  await page.locator('#workspaceNavigationMore > summary').click();
  expect(await page.locator('[data-workspace=fixture-studio]').getAttribute('aria-current')).toBe('page');
  expect(await page.locator('[data-workspace=fixture-studio]').getAttribute('href')).toBe('/cockpit/?app=fixture-studio');
  expect(await page.locator('[data-workspace-all]').getAttribute('href')).toBe('/cockpit/');
  expect(fixture.state.requests.some(path => /foreign-target|not-installed/.test(path))).toBe(false);
  expect(external).toEqual([]);
}, 30000);

it('uses the admitted Career app as the top heading when its group is unavailable', async () => {
  fixture.state.workspaces = fixture.state.workspaces.filter(item => item.name !== 'intelligent-career');
  fixture.state.workspaces.push({ name: 'career-hunter', displayName: 'Intelligent Career', kind: 'app', href: '/cockpit/?app=career-hunter' });
  await open('/cockpit/?app=create&workspace=synthetic-team#draft', 'workspaces'); await discovered();
  const top = page.locator('.workspace-navigation-links [data-workspace=career-hunter]');
  expect(await top.count()).toBe(1);
  expect(await top.innerText()).toBe('Intelligent Career');
  expect(await top.getAttribute('href')).toBe('/cockpit/?app=career-hunter');
  expect(await page.locator('.workspace-navigation-links a').evaluateAll(links => links.map(link => (link as HTMLElement).dataset.workspace)))
    .toEqual(['cockpit', 'little-monsters', 'create', 'career-hunter']);
  expect(await page.locator('#workspaceNavigationMore [data-workspace=career-hunter]').count()).toBe(0);
  expect(await page.locator('[data-workspace=intelligent-career]').count()).toBe(0);
  await top.click(); await page.waitForURL(fixture.origin + '/cockpit/?app=career-hunter'); await discovered();
  expect(await top.getAttribute('aria-current')).toBe('page');
  await editor().locator('#draft').fill('Synthetic Career draft');
  const before = await editor().locator('html').getAttribute('data-document-id');
  await page.locator('#workspaceNavigationToggle').focus();
  fixture.state.workspaces = fixture.state.workspaces.filter(item => item.name !== 'career-hunter');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await discovered();
  expect(await page.locator('[data-workspace=career-hunter], [data-workspace=intelligent-career]').count()).toBe(0);
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(before);
  expect(await editor().locator('#draft').inputValue()).toBe('Synthetic Career draft');
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it('prefers the admitted Career group while keeping its admitted member in More', async () => {
  const group = fixture.state.workspaces.find(item => item.name === 'intelligent-career')!;
  group.kind = 'group'; group.displayName = 'Intelligent Career';
  fixture.state.workspaces.unshift({ name: 'career-hunter', displayName: 'Intelligent Career', kind: 'app', href: '/cockpit/?app=career-hunter' });
  await open('/cockpit/?app=career-hunter', 'workspaces'); await discovered();
  expect(await page.locator('.workspace-navigation-links a').evaluateAll(links => links.map(link => (link as HTMLElement).dataset.workspace)))
    .toEqual(['cockpit', 'little-monsters', 'create', 'intelligent-career']);
  expect(await page.locator('.workspace-navigation-links [data-workspace=intelligent-career]').getAttribute('href'))
    .toBe('/cockpit/?app=intelligent-career');
  expect(await page.locator('[data-workspace=intelligent-career]').count()).toBe(1);
  await page.locator('#workspaceNavigationMore > summary').click();
  const member = page.locator('#workspaceNavigationMore [data-workspace=career-hunter]');
  expect(await member.isVisible()).toBe(true);
  expect(await member.getAttribute('href')).toBe('/cockpit/?app=career-hunter');
  expect(await member.getAttribute('aria-current')).toBe('page');
  expect(await page.locator('#workspaceNavigationMore [data-workspace=fixture-studio]').isVisible()).toBe(true);
  expect(await page.locator('[data-workspace=career-hunter]').count()).toBe(1);
  fixture.state.workspaces = fixture.state.workspaces.filter(item => item.name !== 'intelligent-career');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await discovered();
  expect(await page.locator('.workspace-navigation-links [data-workspace=career-hunter]').count()).toBe(1);
  expect(await page.locator('#workspaceNavigationMore [data-workspace=career-hunter]').count()).toBe(0);
  expect(await page.locator('[data-workspace=intelligent-career]').count()).toBe(0);
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it('retracts stale headings on failed or revoked discovery without replacing the active app', async () => {
  await open('/cockpit/?app=create', 'workspaces'); await discovered();
  const before = await editor().locator('html').getAttribute('data-document-id');
  fixture.state.workspaceStatus = 403;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('status').filter({ hasText: 'Workspaces unavailable' }).waitFor();
  expect(await page.locator('[data-workspace=create]').count()).toBe(0);
  fixture.state.workspaceStatus = 200;
  fixture.state.workspaces = fixture.state.workspaces.filter(item => item.name !== 'create');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator('[data-workspace=little-monsters]').waitFor();
  expect(await page.locator('[data-workspace=create]').count()).toBe(0);
  expect(await editor().locator('html').getAttribute('data-document-id')).toBe(before);
  fixture.state.allowSave = false;
  await editor().getByRole('button', { name: 'Save locally' }).click();
  await expect.poll(() => editor().locator('#saved').innerText()).toBe('Refused');
  expect(fixture.state.saves).toBe(0); expect(errors).toEqual([]);
}, 30000);

it('cannot restore an old discovery response after the operator opts out', async () => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route('**/api/ui/workspaces', async route => { await held; await route.continue().catch(() => {}); });
  try {
    await open(); await chooseLayout('workspaces');
    await page.locator('[data-workspace-status]').waitFor();
    await chooseLayout('sidebar'); release();
    await expect.poll(() => page.locator('#workspaceNavigation').isHidden()).toBe(true);
    expect(await page.locator('#workspaceNavigation [data-workspace=create]').count()).toBe(0);
    await page.unroute('**/api/ui/workspaces');
    await chooseLayout('workspaces'); await discovered();
    expect(await page.locator('#workspaceNavigation [data-workspace=create]').count()).toBe(1);
  } finally { release(); }
}, 30000);

it('uses native application links and restores the focused query and fragment through browser Back', async () => {
  const path = '/cockpit/?app=create&workspace=team-a&record=17#detail';
  await open(path, 'workspaces'); await discovered();
  await page.locator('[data-workspace=intelligent-career]').click();
  await page.waitForURL(fixture.origin + '/cockpit/?app=intelligent-career');
  await editor().locator('h1').waitFor();
  await page.goBack(); await page.waitForURL(fixture.origin + path); await editor().locator('h1').waitFor();
  await discovered(); expect(await page.locator('[data-workspace=create]').getAttribute('aria-current')).toBe('page');
  await page.locator('[data-workspace=cockpit]').click(); await page.waitForURL(fixture.origin + '/cockpit/');
  await editor().locator('h1').waitFor();
  expect(new URL(page.url()).search).toBe(''); expect(new URL(page.url()).hash).toBe('');
  expect(errors).toEqual([]);
}, 30000);

it('preserves the real iframe navigation bridge, selected surface query and artifact forwarding', async () => {
  await open('/cockpit/?app=create&artifact=art_fixture123#section', 'workspaces'); await discovered();
  await editor().locator('#openDetails').click();
  await editor().getByRole('heading', { name: 'Synthetic details' }).waitFor();
  const url = new URL(await page.locator('.tool-view-container iframe').getAttribute('src') || '', fixture.origin);
  expect(url.pathname).toBe('/fixture/detail'); expect(url.searchParams.get('mode')).toBe('inspect');
  expect(url.searchParams.get('kind')).toBe('docx'); expect(url.searchParams.get('starter')).toBe('resume');
  expect(url.searchParams.get('artifact')).toBe('art_fixture123');
  await page.locator('.ribbon-btn[data-view=tool-fixture-editor]').click();
  await editor().getByRole('heading', { name: 'Synthetic editor' }).waitFor();
  await page.locator('.ribbon-btn[data-view=tool-fixture-detail]').click();
  await editor().getByRole('heading', { name: 'Synthetic details' }).waitFor();
  const plain = new URL(await page.locator('.tool-view-container iframe').getAttribute('src') || '', fixture.origin);
  expect(plain.searchParams.has('kind')).toBe(false); expect(plain.searchParams.has('starter')).toBe(false);
  await editor().locator('body').evaluate(() => parent.postMessage({ type: 'app-navigate', view: 'tool-not-admitted' }, location.origin));
  expect(await editor().locator('h1').innerText()).toBe('Synthetic details'); expect(errors).toEqual([]);
}, 30000);

it('inherits explicitly enabled application CSS inside the unchanged custom iframe without persisting that theme', async () => {
  await context.addInitScript(() => localStorage.setItem('cockpit-application-colors', 'true'));
  await open('/cockpit/?app=fixture-studio', 'sidebar', 'workspace');
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('fixture-studio');
  await expect.poll(() => editor().locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(233, 244, 235)');
  await chooseLayout('workspaces'); await discovered();
  expect(await editor().locator('html').getAttribute('data-theme')).toBe('fixture-studio');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  await page.keyboard.press('Escape'); await page.locator('[data-workspace=cockpit]').click();
  await page.waitForURL(fixture.origin + '/cockpit/'); await editor().locator('h1').waitFor();
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace'); expect(errors).toEqual([]);
}, 30000);

it('uses an explicit initial profile and clears an obsolete remembered app on the Cockpit link', async () => {
  await context.addInitScript(() => {
    if (window !== window.top || sessionStorage.getItem('fixture-profile-seeded')) return;
    sessionStorage.setItem('fixture-profile-seeded', '1');
    localStorage.setItem('oshal-ui-profile', 'little-monsters');
  });
  await open('/cockpit/?profile=fixture-studio&record=17#draft', 'workspaces', 'ocean'); await discovered();
  expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean');
  await page.locator('#workspaceNavigationMore > summary').click();
  expect(await page.locator('[data-workspace=fixture-studio]').getAttribute('aria-current')).toBe('page');
  expect(await editor().locator('h1').innerText()).toBe('Synthetic editor');
  await page.locator('[data-workspace=cockpit]').click();
  await page.waitForURL(fixture.origin + '/cockpit/'); await editor().locator('h1').waitFor(); await discovered();
  expect(await page.locator('[data-workspace=cockpit]').getAttribute('aria-current')).toBe('page');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean');
  expect(await page.evaluate(() => localStorage.getItem('oshal-ui-profile'))).toBeNull();
  expect(errors).toEqual([]);
}, 30000);

it('keeps a delayed or empty discovery usable without remounting the active custom screen', async () => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  fixture.state.workspaces = [];
  await page.route('**/api/ui/workspaces', async route => { await held; await route.continue(); });
  try {
    await open('/cockpit/?app=create', 'workspaces');
    await page.locator('[data-workspace-status]').waitFor();
    await editor().locator('#draft').fill('Draft while discovery waits');
    const documentId = await editor().locator('html').getAttribute('data-document-id');
    expect(await page.locator('[data-workspace=create]').count()).toBe(0);
    release();
    await page.locator('[data-workspace-status]').waitFor({ state: 'detached' });
    expect(await page.locator('#workspaceNavigation [data-workspace]').count()).toBe(1);
    const reads = fixture.state.requests.filter(path => path === 'GET /api/ui/workspaces').length;
    await page.locator('#workspaceNavigationMore > summary').click();
    expect(await page.locator('[data-workspace-all]').isVisible()).toBe(true);
    expect(fixture.state.requests.filter(path => path === 'GET /api/ui/workspaces').length).toBe(reads);
    expect(await editor().locator('#draft').inputValue()).toBe('Draft while discovery waits');
    expect(await editor().locator('html').getAttribute('data-document-id')).toBe(documentId);
    fixture.state.workspaceStatus = 403;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('[data-workspace-status]').filter({ hasText: 'Workspaces unavailable' }).waitFor();
    expect(fixture.state.requests.filter(path => path === 'GET /api/ui/workspaces').length).toBeGreaterThan(reads);
    expect(errors).toEqual([]);
  } finally { release(); }
}, 30000);

it('accepts a valid response after five seconds within the discovery deadline without replacing the draft', async () => {
  let release!: () => void, requested!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const started = new Promise<void>(done => { requested = done; });
  await page.route('**/api/ui/workspaces', async route => { requested(); await held; await route.continue().catch(() => {}); });
  try {
    await open('/cockpit/?app=create&workspace=synthetic-team#draft', undefined, 'ocean');
    await editor().locator('#draft').fill('Synthetic draft while cold discovery loads');
    const documentId = await editor().locator('html').getAttribute('data-document-id'), url = page.url();
    await page.clock.install({ time: new Date('2026-09-12T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-09-12T12:01:00Z'));
    await chooseLayout('workspaces'); await started;
    await page.clock.fastForward(19000);
    expect(await page.locator('[data-workspace-status]').innerText()).toBe('Loading workspaces…');
    expect(await page.locator('#workspaceNavigation [data-workspace=create]').count()).toBe(0);
    release();
    await expect.poll(() => page.locator('#workspaceNavigation [data-workspace=create]').count()).toBe(1);
    expect(await page.locator('[data-workspace-status]').count()).toBe(0);
    expect(await page.locator('#workspaceNavigation').getByRole('button', { name: 'Retry', exact: true }).count()).toBe(0);
    expect(await editor().locator('#draft').inputValue()).toBe('Synthetic draft while cold discovery loads');
    expect(await editor().locator('html').getAttribute('data-document-id')).toBe(documentId);
    expect(page.url()).toBe(url); expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean');
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { release(); }
}, 30000);

it('fails a hung discovery deadline at thirty seconds and admits fresh links through Retry', async () => {
  let release!: () => void, requested!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const started = new Promise<void>(done => { requested = done; });
  await page.route('**/api/ui/workspaces', async route => { requested(); await held; await route.continue().catch(() => {}); });
  try {
    await open('/cockpit/?app=create');
    await editor().locator('#draft').fill('Synthetic draft through discovery timeout');
    const documentId = await editor().locator('html').getAttribute('data-document-id');
    await page.clock.install({ time: new Date('2026-09-12T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-09-12T12:01:00Z'));
    await chooseLayout('workspaces'); await started;
    await page.clock.fastForward(29999);
    expect(await page.locator('[data-workspace-status]').innerText()).toBe('Loading workspaces…');
    expect(await page.locator('#workspaceNavigation [data-workspace]').count()).toBe(1);
    await page.clock.fastForward(1);
    await page.locator('[data-workspace-status]').filter({ hasText: 'Workspaces unavailable' }).waitFor();
    expect(await page.locator('#workspaceNavigation [data-workspace]').count()).toBe(1);
    expect(await page.locator('#workspaceNavigation [data-workspace=cockpit]').count()).toBe(1);
    release(); await page.unroute('**/api/ui/workspaces');
    await page.locator('#workspaceNavigation').getByRole('button', { name: 'Retry', exact: true }).click(); await discovered();
    expect(await page.locator('[data-workspace-status]').count()).toBe(0);
    expect(await editor().locator('#draft').inputValue()).toBe('Synthetic draft through discovery timeout');
    expect(await editor().locator('html').getAttribute('data-document-id')).toBe(documentId);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { release(); }
}, 30000);

it('links the navigation policy, preference and real browser regressions from the Test Lab catalog', () => {
  const scenario = SCENARIOS.find(item => item.id === 'cockpit-workspace-navigation');
  expect(scenario?.regressionTests).toEqual(expect.arrayContaining([
    { level: 'unit', path: 'tests/unit/workspace-navigation-model.spec.ts' },
    { level: 'integration', path: 'tests/unit/workspace-navigation-routes.spec.ts' },
    { level: 'browser', path: 'tests/unit/workspace-navigation-browser.spec.ts' },
  ]));
  expect(scenario?.steps.map(step => step.id)).toContain('workspace-discovery');
});

it('keeps actual custom form, dialog, download and fullscreen actions working under the overlay', async () => {
  await open('/cockpit/?app=create', 'workspaces'); await discovered();
  await editor().locator('#draft').fill('Synthetic local edit');
  await editor().getByRole('button', { name: 'Save locally' }).click();
  await expect.poll(() => editor().locator('#saved').innerText()).toBe('Saved in isolated fixture');
  expect(fixture.state.saves).toBe(1);
  page.once('dialog', dialog => dialog.accept()); await editor().locator('#confirmLocal').click();
  expect(await editor().locator('#confirmed').innerText()).toBe('Confirmed');
  const download = page.waitForEvent('download'); await editor().locator('#download').click();
  expect((await download).suggestedFilename()).toBe('synthetic.txt');
  await editor().locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  expect(await page.locator('#workspaceNavigation').isHidden()).toBe(true);
  await page.evaluate(() => document.exitFullscreen()); await discovered();
  expect(await page.locator('#workspaceNavigation').isVisible()).toBe(true); expect(errors).toEqual([]);
}, 30000);

it('keeps mobile drawer taps and keyboard layout controls usable without horizontal overflow', async () => {
  fixture.state.workspaces.find(item => item.name === 'fixture-studio')!.displayName = 'Synthetic studio ' + 'long label '.repeat(12);
  await page.setViewportSize({ width: 390, height: 844 }); await open('/cockpit/?app=fixture-studio', 'workspaces'); await discovered();
  await page.locator('#workspaceNavigationToggle').focus(); await page.keyboard.press('Enter');
  expect(await page.locator('#workspaceNavigationOptions').isVisible()).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('workspaceNavigationToggle');
  await page.getByRole('button', { name: 'Application workspaces', exact: true }).click();
  await page.locator('#workspaceNavigationMore > summary').focus(); await page.keyboard.press('Enter');
  expect(await page.locator('#workspaceNavigationMore').getAttribute('open')).not.toBeNull();
  await page.keyboard.press('Escape'); expect(await page.locator('#workspaceNavigationMore').getAttribute('open')).toBeNull();
  await page.locator('#mobileMenuBtn').click();
  await page.locator('.ribbon-btn[data-view=tool-fixture-editor]').click();
  expect(await page.locator('.ribbon-nav').evaluate(element => element.classList.contains('mobile-open'))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await screenshot('mobile-custom-app');
  expect(errors).toEqual([]);
}, 30000);

it('respects immersive app policies, kiosk suppression and existing Zen escape controls', async () => {
  await open('/cockpit/?app=little-monsters', 'workspaces'); await discovered();
  expect(await page.locator('html').getAttribute('data-oshal-assistant-hidden')).toBe('true');
  expect(await page.locator('.status-bar').isHidden()).toBe(true);
  expect(await page.locator('#chatWorkspaceFrame').getAttribute('src')).toBe('about:blank');
  expect(fixture.state.requests.some(path => path.includes('/swarmbot/chat'))).toBe(false);
  await page.locator('#zenModeBtn').click(); expect(await page.locator('#workspaceNavigation').isHidden()).toBe(true);
  await page.keyboard.press('Escape'); expect(await page.locator('#workspaceNavigation').isVisible()).toBe(true);
  for (const mode of ['student=1', 'kiosk=1', 'view=student']) {
    await page.goto(fixture.origin + '/cockpit/?app=little-monsters&' + mode); await editor().locator('h1').waitFor();
    expect(await page.locator('#workspaceNavigationToggle').count()).toBe(0);
    expect(await page.locator('#workspaceNavigation').count()).toBe(0);
    expect(await page.locator('#ribbonContainer .ribbon-btn').count()).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
}, 30000);

it('precaches both navigation assets on first install and serves their real bytes offline without caching discovery', async () => {
  await context.close();
  context = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'allow' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await open('/cockpit/?app=create', 'workspaces'); await discovered();
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/cockpit/service-worker.js', { scope: '/cockpit/' });
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const cached = await page.evaluate(async () => ({
    javascript: Boolean(await caches.match('/cockpit/js/workspace-navigation.js')),
    stylesheet: Boolean(await caches.match('/cockpit/css/workspace-navigation.css')),
    discovery: Boolean(await caches.match('/api/ui/workspaces')),
  }));
  expect(cached).toEqual({ javascript: true, stylesheet: true, discovery: false });
  await context.setOffline(true);
  const offline = await page.evaluate(async () => {
    const script = await fetch('/cockpit/js/workspace-navigation.js', { cache: 'no-store' });
    const css = await fetch('/cockpit/css/workspace-navigation.css', { cache: 'no-store' });
    return { scriptStatus: script.status, cssStatus: css.status, script: await script.text(), css: await css.text() };
  });
  expect(offline.scriptStatus).toBe(200); expect(offline.cssStatus).toBe(200);
  expect(offline.script).toContain('export class WorkspaceNavigation');
  expect(offline.css).toContain('#workspaceNavigation');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('[data-workspace-status]').filter({ hasText: 'Workspaces unavailable' }).waitFor();
  expect(await page.locator('[data-workspace=create]').count()).toBe(0);
  expect(await editor().locator('h1').innerText()).toBe('Synthetic editor');
  expect(errors).toEqual([]);
}, 30000);

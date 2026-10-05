/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive shipped Homebase source on loopback to verify admitted member/resource return, refused remembered surfaces and principal/package-scoped unsent drafts with caret-preserving recovery. Package entry attributes and member/auth APIs are synthetic; this does not prove deployed admission or real-user approval.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Assert focus before recovery and after successful ticket/task reads and completed source rendering; the retry button also disappears during loading.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { installAssemblyHosts, startExperienceBrowserFixture } from '../fixtures/experience-browser';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 60000, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });
const PACKAGES: Record<string, string> = { 'home-experience': 'family', 'business-experience': 'company', 'classroom-experience': 'classroom', 'second-home-experience': 'family' };
const MEMBERS = [
  { app: 'home-experience', tool: 'tool-movies-concierge', surface: 'movies-concierge', audience: 'family' },
  { app: 'business-experience', tool: 'tool-email-myday', surface: 'email-myday', audience: 'company' },
  { app: 'classroom-experience', tool: 'tool-presentations-studio', surface: 'presentations-studio', audience: 'classroom' },
];
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>, fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
let context: BrowserContext, page: Page, documentSource: string;
let errors: string[], external: string[];
const entry = (app = 'home-experience') => `/api/${app}/app`;

beforeAll(async () => {
  [owned, documentSource] = await Promise.all([launchIsolatedBrowser(), readFile(resolve('src/experience/homebase.html'), 'utf8')]);
});
beforeEach(async () => {
  fixture = await startExperienceBrowserFixture();
  Object.assign(fixture.state.user, { iss: 'urn:fixture:homebase:first' });
  installAssemblyHosts(fixture.state); errors = []; external = [];
  context = await owned.browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.origin) { external.push(url.href); return route.abort(); }
    const app = /^\/api\/([a-z-]+-experience)\/app$/.exec(url.pathname)?.[1];
    if (app && PACKAGES[app]) return route.fulfill({ contentType: 'text/html', body: documentSource.replace('<body data-page="homebase">', `<body data-page="homebase" data-experience-app="${app}" data-layout="${PACKAGES[app]}">`) });
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
});
afterEach(async () => {
  try {
    expect(errors).toEqual([]); expect(external).toEqual([]); expect(fixture.state.asks).toEqual([]);
    expect(fixture.state.calls.filter(call => !call.startsWith('GET '))).toEqual([]);
  } finally { await context?.close(); await fixture?.close(); }
});
afterAll(async () => {
  if (!owned) return;
  const receipt = await owned.close(); await mkdir('temp', { recursive: true });
  await writeFile(`temp/experience-homebase-navigation-browser-cleanup-${Date.now()}.json`, JSON.stringify(receipt, null, 2));
}, BROWSER_HOOK_TIMEOUT_MS);

/** Open a synthetic package document using the shipped shared source and wait for fresh admission restoration. */
async function open(app = 'home-experience', selected = 'home') {
  await page.goto(fixture.origin + entry(app));
  await expect.poll(() => new URL(page.url()).searchParams.get('homePage')).toBe(selected);
  await page.waitForSelector('.home-sidebar');
}
/** Select an actually offered member, then prove its real iframe has loaded. */
async function member(tool: string, surface: string) {
  await page.locator(`.home-sidebar [data-tool="${tool}"]`).click();
  await expect.poll(() => page.frameLocator('#tool-frame').locator('h1').textContent()).toBe(`Opened ${surface}`);
}
/** Capture the actual input selection after a repaint instead of merely checking saved storage. */
const inputState = (id = 'composer-input') => page.locator(`#${id}`).evaluate((node: HTMLInputElement) => ({
  value: node.value, focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection,
}));
/** Change the skin through the shipped event handler while an input owns focus. */
async function repaintWithSkin() {
  await page.locator('#universal-skin-picker').evaluate((node: HTMLSelectElement) => {
    node.value = Array.from(node.options).find(option => option.value !== node.value)!.value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('Home, Business and Classroom navigation and drafts', () => {
  it.each(MEMBERS)('$app restores its admitted member/resource after Back, refresh and package return', async ({ app, tool, surface, audience }) => {
    await open(app); await member(tool, surface);
    const resource = `/fixture/surface/${surface}?audience=${audience}&fixtureResource=own-1#part`;
    await page.frameLocator('#tool-frame').locator('h1').evaluate((_node, href) => history.replaceState({}, '', href), resource);
    await page.locator('.tool-actions [data-page="home"]').click();
    expect(await page.locator('#tool-frame').count()).toBe(0);
    await page.goBack();
    await expect.poll(() => page.locator('#tool-frame').getAttribute('src')).toBe(resource);
    await page.reload();
    await expect.poll(() => page.locator('#tool-frame').getAttribute('src')).toBe(resource);
    await expect.poll(() => page.frameLocator('#tool-frame').locator('h1').textContent()).toBe(`Opened ${surface}`);
    await page.goto(fixture.origin + '/portal'); await open(app, 'tool');
    await expect.poll(() => page.locator('#tool-frame').getAttribute('src')).toBe(resource);
    expect(fixture.state.calls.filter(call => call === 'GET /api/ui/profile').length).toBeGreaterThan(3);
    expect(await page.locator('#tool-frame').getAttribute('title')).toContain('Synthetic');
  });

  it('rechecks a remembered member and clears it without fetching its surface after admission is withdrawn', async () => {
    await open(); await member('tool-movies-concierge', 'movies-concierge');
    fixture.state.status.profile = 403; fixture.state.calls.length = 0;
    await page.reload();
    await expect.poll(() => new URL(page.url()).searchParams.get('homePage')).toBe('home');
    expect(await page.locator('#tool-frame').count()).toBe(0);
    expect(await page.locator('#toast').textContent()).toContain('remembered view is not available');
    expect(fixture.state.calls.some(call => call === 'GET /api/ui/profile')).toBe(true);
    expect(fixture.state.calls.filter(call => call.startsWith('GET /fixture/surface/'))).toEqual([]);
  });

  it('refuses remembered resources outside the exact currently admitted member surface', async () => {
    for (const resource of ['/fixture/surface/private?record=other', '//outside.invalid/private', '/\\outside.invalid/private']) {
      fixture.state.calls.length = 0;
      const query = new URLSearchParams({ homePage: 'tool', homeTool: 'tool-movies-concierge', homeResource: resource });
      await page.goto(`${fixture.origin}${entry()}?${query}`);
      await expect.poll(() => new URL(page.url()).searchParams.get('homePage')).toBe('home');
      expect(await page.locator('#tool-frame').count()).toBe(0);
      expect(await page.locator('#toast').textContent()).toContain('remembered view is not available');
      expect(fixture.state.calls.filter(call => call.startsWith('GET /fixture/surface/'))).toEqual([]);
    }
  });

  it('keeps an unsent composer and its actual caret/focus through work recovery, skin repaint and reload', async () => {
    fixture.state.status.tickets = 503; fixture.state.status.tasks = 503;
    await open(); await page.waitForSelector('[data-action="retry-work"]');
    const draft = 'Unsent <question> & personal details';
    await page.locator('#composer-input').fill(draft);
    await page.locator('#composer-input').evaluate((node: HTMLInputElement) => { node.setSelectionRange(7, 17, 'backward'); node.dataset.oldNode = 'yes'; });
    const expected = { value: draft, focused: true, start: 7, end: 17, direction: 'backward' };
    expect(await inputState(), 'Composer must own focus before recovery starts').toEqual(expected);
    fixture.state.status.tickets = 200; fixture.state.status.tasks = 200;
    const recovered = ['/api/tickets', '/api/jarvis/tasks'].map(path => page.waitForResponse(response => new URL(response.url()).pathname === path && response.status() === 200));
    await page.locator('[data-action="retry-work"]').evaluate((node: HTMLButtonElement) => node.click());
    await Promise.all(recovered.map(async response => (await response).finished()));
    await expect.poll(() => page.locator('.work-source-status').count()).toBe(0);
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect(await inputState()).toEqual(expected);
    expect(await page.locator('#composer-input').getAttribute('data-old-node')).toBe(null);
    await repaintWithSkin(); expect(await inputState()).toEqual(expected);
    await member('tool-movies-concierge', 'movies-concierge');
    await page.locator('.tool-actions [data-page="home"]').click();
    expect(await page.locator('#composer-input').inputValue()).toBe(draft);
    await page.reload(); await expect.poll(() => page.locator('#composer-input').inputValue()).toBe(draft);
  });

  it('preserves the Ask dialog draft/caret on repaint and restores it after reload only when opened explicitly', async () => {
    await open(); await page.locator('.assistant [data-action="ask"]').click();
    const draft = 'Private unsent dialog question';
    await page.locator('#ask-input').fill(draft);
    await page.locator('#ask-input').evaluate((node: HTMLInputElement) => node.setSelectionRange(3, 9));
    const expected = await inputState('ask-input');
    await repaintWithSkin();
    expect(await inputState('ask-input')).toEqual(expected);
    await page.locator('#homebase-dialog [data-action="close"]').click();
    await page.reload(); await expect.poll(() => new URL(page.url()).searchParams.get('homePage')).toBe('home');
    expect(await page.locator('#homebase-dialog').count()).toBe(0);
    await page.locator('.assistant [data-action="ask"]').click();
    expect(await page.locator('#ask-input').inputValue()).toBe(draft);
  });

  it('separates unsent drafts by page, preset, actual package and exact issuer even with the same subject', async () => {
    await open(); await page.locator('#composer-input').fill('Home question');
    await page.locator('.room-tabs [data-page="tasks"]').click();
    expect(await page.locator('#composer-input').inputValue()).toBe('');
    await page.locator('#composer-input').fill('Tasks question');
    await page.reload(); await expect.poll(() => page.locator('#composer-input').inputValue()).toBe('Tasks question');
    await open('business-experience'); expect(await page.locator('#composer-input').inputValue()).toBe('');
    await page.locator('#composer-input').fill('Business question');
    await open('second-home-experience'); expect(await page.locator('#composer-input').inputValue()).toBe('');
    await open('home-experience', 'tasks'); expect(await page.locator('#composer-input').inputValue()).toBe('Tasks question');
    await page.locator('.home-sidebar [data-page="home"]').click();
    expect(await page.locator('#composer-input').inputValue()).toBe('Home question');
    Object.assign(fixture.state.user, { iss: 'urn:fixture:homebase:second' });
    await page.reload(); await expect.poll(() => page.locator('#composer-input').inputValue()).toBe('');
    Object.assign(fixture.state.user, { iss: 'urn:fixture:homebase:first' });
    await open(); expect(await page.locator('#composer-input').inputValue()).toBe('Home question');
  });

  it('keeps drafts in memory when the verified principal issuer is unavailable', async () => {
    Object.assign(fixture.state.user, { iss: '' });
    await open(); await page.locator('#composer-input').fill('Memory-only question');
    await repaintWithSkin(); expect(await page.locator('#composer-input').inputValue()).toBe('Memory-only question');
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('oshal-experience:homebase-state:')))).toEqual([]);
    await page.reload(); await expect.poll(() => new URL(page.url()).searchParams.get('homePage')).toBe('home');
    expect(await page.locator('#composer-input').inputValue()).toBe('');
  });
});

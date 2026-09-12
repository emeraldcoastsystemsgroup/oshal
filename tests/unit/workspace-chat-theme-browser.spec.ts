/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reproduce native chat overwriting Workspace, then guard real iframe prepaint, profile inheritance and cross-tab preference preservation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startWorkspaceChatThemeFixture } from '../fixtures/workspace-chat-theme';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';

let fixture: Awaited<ReturnType<typeof startWorkspaceChatThemeFixture>>;
let browser: Browser, context: BrowserContext, page: Page;
let errors: string[], external: string[];
const chat = (target = page) => target.frameLocator('#chatWorkspaceFrame');

/** @description Seed a saved operator choice once before any actual shell or iframe code executes. */
async function seed(theme: string) {
  await context.addInitScript(value => {
    if (window !== window.top || sessionStorage.getItem('fixture-chat-seeded')) return;
    sessionStorage.setItem('fixture-chat-seeded', '1'); localStorage.setItem('cockpit-theme', value);
  }, theme);
}

/** @description Wait for the actual chat controller's no-bot waiting state, not a substituted theme-only frame. */
async function open(target = page) {
  await target.goto(fixture.origin + '/cockpit/');
  await chat(target).locator('#statusBanner').filter({ hasText: 'Select a swarm bot' }).waitFor();
}

/** @description Drive the real Settings picker and its production embedded-chat message bridge. */
async function select(theme: string) {
  if (!await page.locator('#settingsThemePicker').count()) await page.locator('.ribbon-btn[data-view=settings]').click();
  await page.locator(`#settingsThemePicker [data-theme="${theme}"]`).click();
}

beforeAll(async () => { fixture = await startWorkspaceChatThemeFixture(); browser = await chromium.launch({ headless: true }); }, 30000);
afterAll(async () => { await browser?.close(); await fixture?.close(); });
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  errors = []; external = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
});
afterEach(async () => { await context?.close(); });

it('keeps a real Settings Workspace choice persisted after the actual chat bridge paints it', async () => {
  await seed('daylight'); await open();
  await select('workspace');
  await expect.poll(() => chat().locator('html').getAttribute('data-theme')).toBe('workspace');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  expect(await chat().locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--bg-primary').trim())).toBe('#f5f6f9');
  await page.reload(); await chat().locator('#statusBanner').filter({ hasText: 'Select a swarm bot' }).waitFor();
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  expect(await chat().locator('html').getAttribute('data-theme')).toBe('workspace');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  expect(errors).toEqual([]); expect(external).toEqual([]);
}, 30000);

it('retains every previous palette and the unsent chat draft through real picker changes', async () => {
  await seed('daylight'); await open();
  await chat().locator('#messageInput').fill('Synthetic unsent chat draft');
  for (const theme of ['midnight', 'daylight', 'ocean', 'sakura', 'forest', 'gray', 'black', 'light-blue', 'aurora', 'graphite', 'amber', 'workspace']) {
    await select(theme);
    await expect.poll(() => chat().locator('html').getAttribute('data-theme')).toBe(theme);
    expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe(theme);
    expect(await chat().locator('#messageInput').inputValue()).toBe('Synthetic unsent chat draft');
  }
  expect(errors).toEqual([]);
}, 30000);

it('does not let another open chat iframe overwrite a newer global selection', async () => {
  await seed('daylight'); await open();
  const previousTab = await context.newPage(); await open(previousTab);
  await select('workspace');
  await expect.poll(() => chat().locator('html').getAttribute('data-theme')).toBe('workspace');
  await previousTab.evaluate(async () => {
    const frame = (document.getElementById('chatWorkspaceFrame') as HTMLIFrameElement).contentWindow!;
    await new Promise<void>(done => {
      frame.addEventListener('message', () => setTimeout(done, 0), { once: true });
      frame.postMessage({ type: 'oshal-cockpit-theme', theme: 'daylight' }, location.origin);
    });
  });
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  expect(await chat(previousTab).locator('html').getAttribute('data-theme')).toBe('daylight');
  await previousTab.close(); expect(errors).toEqual([]);
}, 30000);

it('paints Workspace before the chat module arrives', async () => {
  await seed('workspace');
  await page.route('**/swarmbot-chat.js', route => route.abort());
  await page.goto(fixture.origin + '/cockpit/');
  await chat().locator('html[data-theme=workspace]').waitFor({ state: 'attached', timeout: 5000 });
  expect(await chat().locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--bg-primary').trim())).toBe('#f5f6f9');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
}, 30000);

it('keeps the parent choice when an embedded bot profile supplies its own theme', async () => {
  await seed('workspace'); await open();
  await page.locator('#chatWorkspaceFrame').evaluate(element => { (element as HTMLIFrameElement).src =
    '/swarmbot/chat?embed=cockpit&agentId=fixture-bot&taskId=fixture-task&theme=amber'; });
  await chat().locator('#workspaceTitle').filter({ hasText: 'Synthetic theme bot' }).waitFor({ state: 'attached', timeout: 5000 });
  expect(await chat().locator('html').getAttribute('data-theme')).toBe('workspace');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  expect(errors).toEqual([]);
}, 30000);

it('preserves standalone defaults and query themes without an embedding parent', async () => {
  await page.goto(fixture.origin + '/swarmbot/chat');
  await page.locator('#statusBanner').filter({ hasText: 'Choose a swarm bot' }).waitFor();
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  for (const theme of ['ocean', 'workspace']) {
    await page.goto(fixture.origin + '/swarmbot/chat?theme=' + theme);
    await page.locator('#statusBanner').filter({ hasText: 'Choose a swarm bot' }).waitFor();
    expect(await page.locator('html').getAttribute('data-theme')).toBe(theme);
  }
  expect(errors).toEqual([]);
}, 30000);

it('registers actual chat inheritance coverage alongside the appearance browser suite', () => {
  expect(SCENARIOS.find(item => item.id === 'cockpit-appearance')?.regressionTests).toContainEqual(
    { level: 'browser', path: 'tests/unit/workspace-chat-theme-browser.spec.ts' });
});

/**
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove selectable Workspace styling through real Cockpit components, persisted choices, shared iframes and transient package themes in Chromium.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Verify the existing chooser through relocated header controls with keyboard and pointer dismissal.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Exercise the chooser inside the OSHAL menu alongside the compact daily Home composition.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Prove first-screen appearance controls and keyboard-expandable runtime help through the complete Settings view.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Give the hooks that own the isolated fixture browser the fixture's exit budget, so a confirmed but slow shutdown on a loaded box is failed by neither deadline.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Qualify existing shared-form cases as operator fixtures and cover personal controls, pending/refused/unavailable admission and stale shared responses through actual Settings modules.
 * =============================================================================
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { installSettingsBoundaryFixture, startWorkspaceThemeFixture } from '../fixtures/workspace-theme';
import { startWorkspaceNavigationFixture } from '../fixtures/workspace-navigation';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';

vi.setConfig({ hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

declare global {
  interface Window {
    workspaceThemeFixture: { theme: {
      apply(theme: string): string; applyTransient(theme: string, cssUrl?: string): string;
      setApplicationTheme(theme?: string, cssUrl?: string): string;
    }; showHome(): Promise<void>; showSettings(): void; showSurface(): void };
  }
}
let fixture: Awaited<ReturnType<typeof startWorkspaceThemeFixture>>;
let settingsFixture: Awaited<ReturnType<typeof startWorkspaceNavigationFixture>>;
let settingsBoundary: ReturnType<typeof installSettingsBoundaryFixture>;
let isolated: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let browser: Browser, context: BrowserContext, page: Page;
let errors: string[];

/** @description Wait for actual component boot; optional existing saved choice is seeded before any script runs. */
async function open(saved?: string) {
  if (saved) await context.addInitScript(value => localStorage.setItem('cockpit-theme', value), saved);
  await page.goto(fixture.origin + '/cockpit/');
  await page.waitForSelector('html[data-fixture-ready=true]');
  await page.locator('.apps-home-card').first().waitFor();
}

/** @description Read a computed shared token after stylesheets have loaded. */
async function token(name: string) {
  return page.evaluate(key => getComputedStyle(document.documentElement).getPropertyValue(key).trim(), name);
}

/** @description Exercise the actual sidebar options disclosure before the existing cycle control. */
async function cycleTheme() {
  await page.locator('#workspaceNavigationMore > summary').click();
  await page.locator('#themeToggle').click();
}

/** @description WCAG contrast between the actual opaque hex theme tokens, without synthetic pixel assertions. */
function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = hex.startsWith('#') ? [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
      : (hex.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const rgb = channels.map(value => value / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

beforeAll(async () => {
  fixture = await startWorkspaceThemeFixture();
  settingsFixture = await startWorkspaceNavigationFixture(app => {
    settingsBoundary = installSettingsBoundaryFixture(app);
  });
  isolated = await launchIsolatedBrowser(); browser = isolated.browser;
});
afterAll(async () => {
  try {
    if (isolated) {
      const cleanup = await isolated.close(); mkdirSync('temp', { recursive: true });
      writeFileSync(`temp/workspace-theme-browser-cleanup-${cleanup.pid}.json`, JSON.stringify(cleanup, null, 2) + '\n', { flag: 'wx' });
    }
  } finally { await settingsFixture?.close(); await fixture?.close(); }
}, BROWSER_HOOK_TIMEOUT_MS);
beforeEach(async () => {
  Object.assign(settingsBoundary, { operator: true, identityStatus: 200, configStatus: 200, malformedConfig: false,
    identityGate: null, configGate: null, requests: [] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => [fixture.origin, settingsFixture.origin].includes(new URL(route.request().url()).origin)
    ? route.continue() : route.abort());
  // Keep the original fixture bytes while making its synthetic GET envelope match the maintained config handler.
  for (const path of ['/api/config', '/api/config/rag']) {
    await context.route(settingsFixture.origin + path, async route => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      const response = await route.fetch();
      const payload = await response.json();
      await route.fulfill({ response, json: { ...payload, success: response.ok() } });
    });
  }
  page = await context.newPage(); errors = [];
  page.on('pageerror', error => errors.push(error.message));
});
afterEach(async () => { await context?.close(); });

/** @description Enter Global Settings through the actual shell action and its unchanged asynchronous data loading. */
async function openFullSettings(reload = false, state: string | null = 'admitted') {
  if (reload) await page.reload();
  else await page.goto(settingsFixture.origin + '/cockpit/');
  await page.locator('#workspaceNavigationMore > summary').click();
  await page.locator('#portalSettingsBtn').click();
  await page.locator('#settingsThemePicker').waitFor();
  if (state) await sharedAccess(state);
}

/** @description Wait for the actual shared section's current verdict rather than inferring admission from static controls. */
async function sharedAccess(state: string) {
  await expect.poll(() => page.locator('[data-shared-runtime-state]').getAttribute('data-shared-runtime-state')).toBe(state);
}

/** @description Check shared controls are absent, independently of the explanatory text or zero-valued browser estimate. */
async function noSharedControls() {
  for (const id of ['settingsProvider', 'settingsModel', 'settingsApiKey', 'settingsGitToken', 'settingsRagEndpoint',
    'settingsAutoSafe', 'settingsAutoRead', 'settingsAutoWrite', 'settingsSaveBtn', 'settingsOpenAiCodexSignInBtn']) {
    expect(await page.locator('#' + id).count()).toBe(0);
  }
}

/** @description Observe only global Settings requests; ordinary permission-aware bot/knowledge reads are separate features. */
function sharedRequests() {
  return settingsBoundary.requests.filter(request => /^\w+ \/api\/(config(?:\/|$)|providers$|rag\/health$|openai-codex\/oauth|dev-console\/access$)/.test(request));
}

/** @description Inspect booleans and counts on the real shipped view, without fixture overrides or configuration values. */
async function sharedState() {
  return page.evaluate(() => {
    const view = (window as unknown as { __cockpit: { viewController: { activeViewInstance: {
      settings: object; providers: unknown[]; openAiCodexAuthState: { authenticated: boolean }; openAiCodexAuthPollToken: number;
    } } } }).__cockpit.viewController.activeViewInstance;
    return { settingsFields: Object.keys(view.settings).length, providers: view.providers.length,
      authenticated: view.openAiCodexAuthState.authenticated, pollToken: view.openAiCodexAuthPollToken };
  });
}

/** @description Check actual first-screen geometry before any control can scroll itself into view. */
async function firstScreenControl(selector: string) {
  const box = await page.locator(selector).boundingBox();
  const content = await page.locator('#settingsBody').boundingBox();
  expect(box).not.toBeNull(); expect(content).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(content!.y);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(Math.min(content!.y + content!.height, page.viewportSize()!.height));
}

it.each([{ width: 1280, height: 800 }, { width: 390, height: 844 }])(
  'puts full Global Settings appearance controls on the first screen at $width pixels', async viewport => {
    await page.setViewportSize(viewport); await openFullSettings();
    await firstScreenControl('#settingsThemePicker [data-theme=workspace]');
    await firstScreenControl('#settingsApplicationColors');
    await firstScreenControl('#settingsNavigationLayout');
    mkdirSync('temp/settings-appearance-screenshots', { recursive: true });
    await page.screenshot({ path: `temp/settings-appearance-screenshots/settings-${viewport.width}.png` });
    expect(await page.locator('#settingsBody').evaluate(element => element.scrollTop)).toBe(0);
    expect(await page.locator('#settingsBody > .setting-section').first().locator('.setting-section-title').first().innerText()).toBe('Appearance');
    const appearance = page.locator('#settingsThemePicker').locator('..');
    expect(await appearance.locator('#settingsAutoSafe').count()).toBe(0);
    for (const id of ['settingsAutoSafe', 'settingsAutoRead', 'settingsAutoWrite', 'settingsSaveBtn']) {
      expect(await page.locator('#' + id).count()).toBe(1);
    }
    await page.locator('#settingsApplicationColors').check();
    await page.locator('#settingsThemePicker [data-theme=midnight]').click();
    expect(await page.locator('#settingsApplicationColors').isChecked()).toBe(false);
    await page.locator('#settingsNavigationLayout').selectOption('workspaces');
    expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('midnight');
    expect(await page.evaluate(() => localStorage.getItem('oshal-navigation-layout'))).toBe('workspaces');
    await openFullSettings(true);
    expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
    expect(await page.locator('#settingsNavigationLayout').inputValue()).toBe('workspaces');
    expect(await page.locator('#settingsThemePicker [data-theme=midnight]').getAttribute('aria-pressed')).toBe('true');
    expect(errors).toEqual([]);
  }, 30000,
);

it('keeps full Global Settings runtime help closed until keyboard expansion without changing configuration', async () => {
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url()); });
  await openFullSettings();
  const help = page.locator('[data-testid=config-ownership-section]');
  expect(await help.evaluate(element => element.tagName)).toBe('DETAILS');
  expect(await help.getAttribute('open')).toBeNull();
  expect(await help.locator('code').filter({ hasText: '/api/agents/:agentId/profile' }).isVisible()).toBe(false);
  const summary = help.locator('summary');
  await summary.scrollIntoViewIfNeeded(); await summary.focus(); await page.keyboard.press('Enter');
  expect(await help.getAttribute('open')).not.toBeNull();
  for (const route of ['/api/config', '/api/agents/:agentId/profile', '/api/agents/:agentId/tools']) {
    expect(await help.locator('code').filter({ hasText: route }).last().isVisible()).toBe(true);
  }
  await page.keyboard.press('Space');
  expect(await help.getAttribute('open')).toBeNull();
  expect(await summary.evaluate(element => element === document.activeElement)).toBe(true);
  expect(writes).toEqual([]); expect(errors).toEqual([]);
}, 30000);

it.each([{ width: 1280, height: 800 }, { width: 390, height: 844 }])(
  'keeps ordinary personal Settings usable without global settings requests at $width pixels', async viewport => {
    settingsBoundary.operator = false;
    await page.setViewportSize(viewport); await openFullSettings(false, 'operator-required');
    await firstScreenControl('#settingsApplicationColors'); await firstScreenControl('#settingsNavigationLayout');
    await noSharedControls(); expect(sharedRequests()).toEqual([]);
    expect(await page.locator('#settingsSharedRuntime').innerText()).toContain('require operator access');
    expect(await page.locator('#settingsBody').innerText()).toContain('These counters do not report total swarm spending');
    expect(await page.locator('#settingsDevicesLink').getAttribute('href')).toBe('/cockpit/tools/devices.html');
    await page.locator('#costDailyLimit').fill('12'); await page.locator('#costSaveLimitsBtn').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cockpit-cost-tracker') || '{}').dailyLimit)).toBe(12);
    await page.locator('#settingsApplicationColors').check(); await page.locator('#settingsThemePicker [data-theme=midnight]').click();
    expect(await page.locator('#settingsApplicationColors').isChecked()).toBe(false);
    await page.locator('#settingsNavigationLayout').selectOption('workspaces');
    await openFullSettings(true, 'operator-required');
    expect(await page.locator('#settingsNavigationLayout').inputValue()).toBe('workspaces');
    expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
    for (const tab of ['knowledge', 'connections', 'channels', 'location', 'bots']) {
      expect(await page.locator(`.settings-tab[data-tab=${tab}]`).isEnabled()).toBe(true);
    }
    await noSharedControls(); expect(sharedRequests()).toEqual([]); expect(errors).toEqual([]);
  }, 30000,
);

it('renders pending access with personal drafts intact until the fresh identity verdict arrives', async () => {
  await page.goto(settingsFixture.origin + '/cockpit/');
  await page.locator('#workspaceNavigationMore > summary').click();
  let release!: () => void;
  settingsBoundary.identityGate = new Promise<void>(done => { release = done; });
  settingsBoundary.operator = false;
  try {
    await page.locator('#portalSettingsBtn').click(); await sharedAccess('pending'); await noSharedControls();
    await page.locator('#costDailyLimit').fill('17'); await page.locator('#settingsApplicationColors').check();
    expect(sharedRequests()).toEqual([]);
    release(); await sharedAccess('operator-required');
    expect(await page.locator('#costDailyLimit').inputValue()).toBe('17');
    expect(await page.locator('#settingsApplicationColors').isChecked()).toBe(true);
    expect(sharedRequests()).toEqual([]); expect(errors).toEqual([]);
  } finally { release(); settingsBoundary.identityGate = null; }
}, 30000);

it('explains a config refusal after operator identity without constructing fallback shared forms', async () => {
  settingsBoundary.configStatus = 403;
  await openFullSettings(false, 'operator-required'); await noSharedControls();
  expect(sharedRequests()).toEqual(['GET /api/config']);
  await page.locator('#costDailyLimit').fill('19');
  settingsBoundary.configStatus = 200; await page.locator('#settingsRetryRuntime').click();
  await sharedAccess('admitted');
  expect(await page.locator('#settingsSaveBtn').count()).toBe(1);
  expect(await page.locator('#costDailyLimit').inputValue()).toBe('19'); expect(errors).toEqual([]);
}, 30000);

it.each(['identity', 'config', 'malformed'] as const)(
  'offers Retry for unavailable %s instead of default admin controls', async failure => {
    if (failure === 'identity') settingsBoundary.identityStatus = 503;
    if (failure === 'config') settingsBoundary.configStatus = 503;
    if (failure === 'malformed') settingsBoundary.malformedConfig = true;
    await openFullSettings(false, 'unavailable'); await noSharedControls();
    expect(await page.locator('#settingsRetryRuntime').isEnabled()).toBe(true);
    await page.locator('#costBucketLimit').fill('23');
    Object.assign(settingsBoundary, { identityStatus: 200, configStatus: 200, malformedConfig: false });
    await page.locator('#settingsRetryRuntime').click(); await sharedAccess('admitted');
    expect(await page.locator('#settingsProvider').inputValue()).toBe('openai-codex');
    expect(await page.locator('#costBucketLimit').inputValue()).toBe('23'); expect(errors).toEqual([]);
  }, 30000,
);

it('requires a literal current operator boolean rather than a truthy identity field', async () => {
  settingsBoundary.operator = 'true';
  await openFullSettings(false, 'unavailable'); await noSharedControls();
  expect(sharedRequests()).toEqual([]); expect(errors).toEqual([]);
}, 30000);

it.each([{ config: null, success: true }, { config: {}, success: false, error: 'synthetic_config_failure' }])(
  'refuses a malformed successful-HTTP config envelope %j without default admin forms', async payload => {
    await page.route(settingsFixture.origin + '/api/config', route => route.fulfill({ status: 200, json: payload }));
    await openFullSettings(false, 'unavailable'); await noSharedControls();
    expect(await page.locator('#settingsRetryRuntime').isEnabled()).toBe(true);
    expect(sharedRequests()).toEqual([]); expect(errors).toEqual([]);
  }, 30000,
);

it('retires shared controls immediately during delayed ordinary bot discovery and refuses detached shared actions', async () => {
  await openFullSettings(); await page.locator('#settingsOpenAiCodexSignInBtn').waitFor({ state: 'visible' });
  const save = await page.locator('#settingsSaveBtn').elementHandle();
  const signIn = await page.locator('#settingsOpenAiCodexSignInBtn').elementHandle();
  expect(save).not.toBeNull(); expect(signIn).not.toBeNull();
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route(settingsFixture.origin + '/api/agents', async route => {
    await held; await route.fulfill({ status: 200, json: { agents: [] } });
  });
  try {
    settingsBoundary.requests = [];
    const request = page.waitForRequest(settingsFixture.origin + '/api/agents');
    await page.locator('.settings-tab[data-tab=bots]').click(); await request;
    await noSharedControls(); expect(await page.locator('#settingsBody').innerText()).toContain('Loading bot settings');
    await save!.evaluate(element => (element as HTMLButtonElement).click());
    await signIn!.evaluate(element => (element as HTMLButtonElement).click());
    expect(sharedRequests()).toEqual([]);
    const completed = page.waitForResponse(settingsFixture.origin + '/api/agents'); release(); await (await completed).finished();
    await page.locator('.settings-tab[data-tab=global]').click(); await sharedAccess('admitted');
    expect(await page.locator('#settingsSaveBtn').count()).toBe(1);
    expect(sharedRequests().filter(request => request.startsWith('POST ') || request.endsWith('/oauth/start'))).toEqual([]);
    expect(errors).toEqual([]);
  } finally { release(); await save?.dispose(); await signIn?.dispose(); }
}, 30000);

it('clears admitted shared fields on current revocation while retaining personal drafts and invalidating OAuth work', async () => {
  await openFullSettings();
  const initial = await sharedState();
  await page.locator('#costDailyLimit').fill('29');
  settingsBoundary.operator = false; settingsBoundary.requests = [];
  await page.locator('#settingsRetryRuntime').click(); await sharedAccess('operator-required');
  await noSharedControls(); expect(await page.locator('#costDailyLimit').inputValue()).toBe('29');
  const revoked = await sharedState();
  expect(revoked.settingsFields).toBe(0); expect(revoked.providers).toBe(0); expect(revoked.authenticated).toBe(false);
  expect(revoked.pollToken).toBeGreaterThan(initial.pollToken);
  expect(sharedRequests()).toEqual([]);
  await page.locator('.settings-tab[data-tab=knowledge]').click();
  await page.locator('#knowledgeTextInput').fill('An ordinary knowledge draft.');
  expect(await page.locator('#knowledgeTextInput').inputValue()).toBe('An ordinary knowledge draft.');
  await page.locator('.settings-tab[data-tab=global]').click(); await noSharedControls();
  expect(sharedRequests()).toEqual([]); expect(errors).toEqual([]);
}, 30000);

it('discards a late successful config response after a newer ordinary verdict', async () => {
  await page.goto(settingsFixture.origin + '/cockpit/');
  await page.locator('#workspaceNavigationMore > summary').click();
  let release!: () => void;
  settingsBoundary.configGate = new Promise<void>(done => { release = done; });
  try {
    await page.locator('#portalSettingsBtn').click(); await sharedAccess('pending');
    await expect.poll(() => settingsBoundary.requests.includes('GET /api/config')).toBe(true);
    await page.locator('#costDailyLimit').fill('31'); settingsBoundary.operator = false;
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sharedAccess('operator-required'); release(); await (await completed).finished();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    await sharedAccess('operator-required');
    await noSharedControls(); expect(await page.locator('#costDailyLimit').inputValue()).toBe('31');
    expect((await sharedState()).settingsFields).toBe(0); expect((await sharedState()).providers).toBe(0);
    expect(sharedRequests()).toEqual(['GET /api/config']); expect(errors).toEqual([]);
  } finally { release(); settingsBoundary.configGate = null; }
}, 30000);

it('discards a delayed OAuth status after shared admission has been revoked', async () => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route('**/api/openai-codex/oauth/status', async route => {
    await held; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true }) });
  });
  try {
    const request = page.waitForRequest('**/api/openai-codex/oauth/status');
    await openFullSettings(); await request;
    settingsBoundary.operator = false;
    await page.locator('#settingsRetryRuntime').click(); await sharedAccess('operator-required');
    const completed = page.waitForResponse('**/api/openai-codex/oauth/status'); release(); await (await completed).finished();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    await sharedAccess('operator-required');
    await noSharedControls();
    expect((await sharedState()).authenticated).toBe(false);
    expect(await page.locator('#settingsOpenAiCodexAuthStatus').count()).toBe(0); expect(errors).toEqual([]);
  } finally { release(); }
}, 30000);

it('clears shared controls after a save refusal while personal local actions remain available', async () => {
  await openFullSettings(); await page.locator('#costDailyLimit').fill('37');
  await page.locator('#settingsSaveBtn').click(); await sharedAccess('operator-required');
  await noSharedControls(); expect(await page.locator('#costDailyLimit').inputValue()).toBe('37');
  const writes = () => settingsBoundary.requests.filter(request => request.startsWith('POST /api/config'));
  expect(writes().sort()).toEqual(['POST /api/config', 'POST /api/config/rag']);
  await page.locator('#costSaveLimitsBtn').click();
  expect(writes().sort()).toEqual(['POST /api/config', 'POST /api/config/rag']); expect(errors).toEqual([]);
}, 30000);

it('selects through the real Settings picker, persists and stays in the existing theme cycle', async () => {
  await open(); expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  await cycleTheme(); expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.locator('.ribbon-btn[data-view=settings]').click();
  const choice = page.locator('#settingsThemePicker [data-theme=workspace]');
  await choice.click(); expect(await choice.innerText()).toContain('Workspace');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  await expect.poll(() => token('--bg-primary')).toBe('#f5f6f9');
  await cycleTheme();
  expect(await choice.getAttribute('aria-pressed')).toBe('false');
  expect(await page.locator('#settingsThemePicker [data-theme=midnight]').getAttribute('aria-pressed')).toBe('true');
  expect(await page.locator('#settingsThemePicker button.active').count()).toBe(1);
  await choice.click();
  await page.reload(); await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  await cycleTheme(); expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.evaluate(() => window.workspaceThemeFixture.theme.apply('amber'));
  await cycleTheme(); expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  expect(errors).toEqual([]);
}, 30000);

it('honors the saved theme before the actual Cockpit component boot completes', async () => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await context.addInitScript(() => localStorage.setItem('cockpit-theme', 'ocean'));
  await page.route('**/fixture/bootstrap.js', async route => { await held; await route.continue(); });
  try {
    await page.goto(fixture.origin + '/cockpit/', { waitUntil: 'commit' });
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('ocean');
    expect(await page.locator('html').getAttribute('data-fixture-ready')).toBeNull();
    release(); await page.waitForSelector('html[data-fixture-ready=true]');
    expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean'); expect(errors).toEqual([]);
  } finally { release(); }
}, 30000);

it('retains existing saved choices while allowing a transient Workspace skin', async () => {
  await open('ocean'); expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean');
  await page.evaluate(() => window.workspaceThemeFixture.theme.applyTransient('workspace'));
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('ocean');
  await page.reload(); await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('ocean'); expect(errors).toEqual([]);
}, 30000);

it('uses Workspace in a fresh standalone surface but retains the existing invalid-choice fallback', async () => {
  await page.goto(fixture.origin + '/cockpit/tools/budgets.html');
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('workspace');
  await page.evaluate(() => localStorage.setItem('cockpit-theme', 'unknown-fixture-theme'));
  await page.reload(); await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.goto(fixture.origin + '/cockpit/'); await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('midnight'); expect(errors).toEqual([]);
}, 30000);

it('keeps current parent and packaged themes authoritative in the real shared surface without overwriting Workspace', async () => {
  await open(); await page.evaluate(() => { window.workspaceThemeFixture.theme.apply('workspace'); window.workspaceThemeFixture.showSurface(); });
  const shared = page.frameLocator('#shared-surface');
  await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('workspace');
  await expect.poll(() => shared.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(245, 246, 249)');
  await page.evaluate(() => window.workspaceThemeFixture.theme.applyTransient('forest'));
  await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('forest');
  await page.evaluate(() => window.workspaceThemeFixture.theme.applyTransient('fixture-studio', '/fixture/packaged.css'));
  await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('fixture-studio');
  await expect.poll(() => shared.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(233, 244, 235)');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  await page.evaluate(() => window.workspaceThemeFixture.theme.apply('workspace'));
  await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('workspace');
  await expect.poll(() => shared.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(245, 246, 249)');
  await page.goto(fixture.origin + '/cockpit/tools/budgets.html');
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('workspace'); expect(errors).toEqual([]);
}, 30000);

it('keeps a newer Workspace choice when an older package stylesheet finishes loading late', async () => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route('**/fixture/packaged.css', async route => { await held; await route.continue(); });
  try {
    await open(); await page.evaluate(() => window.workspaceThemeFixture.showSurface());
    const shared = page.frameLocator('#shared-surface');
    await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('workspace');
    await page.evaluate(() => window.workspaceThemeFixture.theme.applyTransient('fixture-studio', '/fixture/packaged.css'));
    await shared.locator('#app-package-theme-css').waitFor({ state: 'attached' });
    await page.evaluate(() => window.workspaceThemeFixture.theme.apply('workspace'));
    await expect.poll(() => shared.locator('html').getAttribute('data-theme')).toBe('workspace');
    release();
    await expect.poll(() => shared.locator('#app-package-theme-css').evaluate(element => Boolean((element as HTMLLinkElement).sheet))).toBe(true);
    expect(await shared.locator('html').getAttribute('data-theme')).toBe('workspace');
    expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  } finally { release(); }
}, 30000);

it('renders readable paper cards on the existing Home DOM at desktop and phone widths with visible keyboard focus', async () => {
  await open(); await page.evaluate(() => window.workspaceThemeFixture.theme.apply('workspace'));
  await expect.poll(() => token('--bg-card')).toBe('#ffffff');
  for (const foreground of ['--text-primary', '--text-secondary', '--text-muted']) {
    for (const background of ['--bg-card', '--bg-primary', '--bg-tertiary']) {
      expect(contrast(await token(foreground), await token(background))).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(contrast('#ffffff', await token('--accent-primary'))).toBeGreaterThanOrEqual(4.5);
  expect(await page.locator('.header-bar').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.locator('.apps-home-card').count()).toBe(1);
  expect(await page.locator('.apps-home-head').innerText()).toContain('Today');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('solid');
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  expect(errors).toEqual([]);
}, 30000);

it('keeps every real Settings theme label readable with a distinct selected state and candidate color swatches', async () => {
  await open(); await page.locator('.ribbon-btn[data-view=settings]').click();
  const choices = page.locator('#settingsThemePicker button'); expect(await choices.count()).toBe(12);
  const colors = await choices.evaluateAll(buttons => buttons.map(button => {
    const style = getComputedStyle(button);
    return { text: style.color, background: style.backgroundColor, swatch: getComputedStyle(button, '::before').backgroundColor };
  }));
  for (const color of colors) expect(contrast(color.text, color.background)).toBeGreaterThanOrEqual(4.5);
  expect(new Set(colors.map(color => color.swatch)).size).toBeGreaterThan(5);
  const selected = page.locator('#settingsThemePicker [data-theme=workspace]');
  expect(await selected.getAttribute('aria-pressed')).toBe('true');
  expect(await selected.evaluate(element => getComputedStyle(element).borderTopColor)).toBe('rgb(83, 91, 200)');
  await page.locator('#settingsThemePicker [data-theme=midnight]').click();
  expect(await selected.getAttribute('aria-pressed')).toBe('false');
  await selected.click(); expect(await selected.getAttribute('aria-pressed')).toBe('true'); expect(errors).toEqual([]);
}, 30000);

it('precaches the default Workspace palette and prepaint bootstrap on the first real service-worker installation', async () => {
  await context.close();
  context = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'allow' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  page = await context.newPage();
  await open();
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/cockpit/service-worker.js', { scope: '/cockpit/' });
    await navigator.serviceWorker.ready;
  });
  const cached = await page.evaluate(async () => ({
    theme: Boolean(await caches.match('/cockpit/css/themes/workspace.css')),
    bootstrap: Boolean(await caches.match('/shared/ui/js/surface-theme.js')),
  }));
  expect(cached).toEqual({ theme: true, bootstrap: true });
  await context.setOffline(true);
  const assets = await page.evaluate(async () => {
    const theme = await caches.match('/cockpit/css/themes/workspace.css');
    const bootstrap = await caches.match('/shared/ui/js/surface-theme.js');
    return { theme: await theme?.text(), bootstrap: await bootstrap?.text() };
  });
  expect(assets.theme).toContain('[data-theme="workspace"]');
  expect(assets.bootstrap).toContain("defaultTheme ? resolve(defaultTheme) : 'workspace'");
}, 30000);

it('loads the real guarded CSS route and registers its browser proof without claiming it executes during a Lab asset check', async () => {
  const response = await context.request.get(fixture.origin + '/cockpit/css/themes/workspace.css');
  expect(response.status()).toBe(200); expect(response.headers()['content-type']).toContain('text/css');
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(await response.text()).toBe(readFileSync('src/pages/cockpit/css/themes/workspace.css', 'utf8'));
  const scenario = SCENARIOS.find(item => item.id === 'cockpit-appearance');
  expect(scenario?.regressionTests).toContainEqual({ level: 'browser', path: 'tests/unit/workspace-theme-browser.spec.ts' });
  expect(scenario?.description).toContain('does not execute the browser suite');
});

it('keeps the chosen portal palette across application defaults and only enables app colors on request', async () => {
  await page.goto(fixture.origin + '/cockpit/?app=fixture-studio');
  await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('workspace');
  await page.evaluate(() => window.workspaceThemeFixture.showSettings());
  await page.locator('#settingsApplicationColors').check();
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('fixture-studio');
  expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('workspace');
  await page.reload(); await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('fixture-studio');
  await page.evaluate(() => window.workspaceThemeFixture.showSettings());
  await page.locator('#settingsThemePicker [data-theme=midnight]').click();
  expect(await page.locator('#settingsApplicationColors').isChecked()).toBe(false);
  await page.reload(); await page.waitForSelector('html[data-fixture-ready=true]');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.evaluate(() => window.workspaceThemeFixture.theme.setApplicationTheme('daylight'));
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  expect(errors).toEqual([]);
}, 30000);

it('keeps secondary header actions tucked away and makes the real Settings chooser reachable', async () => {
  await open('workspace');
  expect(await page.locator('#themeToggle').isVisible()).toBe(false);
  expect(await page.locator('#zenModeBtn').isVisible()).toBe(false);
  expect(await page.locator('#profileBtn').isVisible()).toBe(true);
  await page.locator('#workspaceNavigationMore > summary').click();
  await page.locator('#portalSettingsBtn').click();
  expect(await page.locator('#settingsThemePicker').isVisible()).toBe(true);
  expect(await page.locator('#workspaceNavigationMore').getAttribute('open')).toBeNull();
  expect(await page.locator('#cockpitHomeLink').getAttribute('href')).toBe('/cockpit/');
  expect(errors).toEqual([]);
});

it('returns keyboard focus to the options trigger after switching theme', async () => {
  await open('midnight');
  const trigger = page.locator('#workspaceNavigationMore > summary');
  await trigger.focus(); await page.keyboard.press('Enter');
  await page.locator('#themeToggle').focus(); await page.keyboard.press('Enter');
  expect(await page.locator('html').getAttribute('data-theme')).not.toBe('midnight');
  expect(await page.locator('#workspaceNavigationMore').getAttribute('open')).toBeNull();
  expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true);
  expect(errors).toEqual([]);
});

it('dismisses the options disclosure using Escape and outside pointer without activating a tool', async () => {
  await open('midnight');
  const trigger = page.locator('#workspaceNavigationMore > summary');
  await trigger.focus(); await page.keyboard.press('Enter');
  expect(await page.locator('#themeToggle').isVisible()).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.locator('#themeToggle').isVisible()).toBe(false);
  expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true);
  await trigger.click(); await page.locator('#mainContent').click({ position: { x: 5, y: 5 } });
  expect(await page.locator('#themeToggle').isVisible()).toBe(false);
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  expect(errors).toEqual([]);
});

it('follows the real chooser across open portal tabs without replacing an embedded document or its draft', async () => {
  await open();
  const other = await context.newPage();
  await other.goto(fixture.origin + '/cockpit/?app=fixture-studio');
  await other.waitForSelector('html[data-fixture-ready=true]');
  await other.evaluate(() => window.workspaceThemeFixture.showSurface());
  const frame = other.frameLocator('#shared-surface');
  await frame.locator('body').waitFor();
  await frame.locator('body').evaluate(body => {
    const input = document.createElement('input'); input.id = 'appearance-draft';
    input.value = 'Keep this unsaved note'; body.append(input);
  });
  const documentBefore = await frame.locator('html').elementHandle();
  await page.bringToFront(); await page.locator('.ribbon-btn[data-view=settings]').click();
  await page.locator('#settingsThemePicker [data-theme=daylight]').click();
  await expect.poll(() => other.locator('html').getAttribute('data-theme')).toBe('daylight');
  await expect.poll(() => frame.locator('html').getAttribute('data-theme')).toBe('daylight');
  expect(await frame.locator('#appearance-draft').inputValue()).toBe('Keep this unsaved note');
  expect(await documentBefore?.evaluate(element => element === document.documentElement)).toBe(true);
  await page.locator('#settingsThemePicker [data-theme=workspace]').click();
  await expect.poll(() => frame.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(245, 246, 249)');
  expect(await frame.locator('#appearance-draft').inputValue()).toBe('Keep this unsaved note');
  await other.close(); expect(errors).toEqual([]);
}, 30000);

it('offers readable primary-control ink and correct native control schemes in every portal palette', async () => {
  await open();
  const themes = ['midnight','daylight','ocean','sakura','forest','gray','black','light-blue','aurora','graphite','amber','workspace'];
  for (const theme of themes) {
    await page.evaluate(value => window.workspaceThemeFixture.theme.apply(value), theme);
    expect(contrast(await token('--text-on-accent'), await token('--accent-primary')), theme).toBeGreaterThanOrEqual(4.5);
    const scheme = await page.locator('html').evaluate(element => getComputedStyle(element).colorScheme);
    expect(scheme, theme).toBe(['daylight','light-blue','workspace'].includes(theme) ? 'light' : 'dark');
  }
  expect(errors).toEqual([]);
}, 30000);

it('keeps the actual theme picker usable when browser preference writes are blocked', async () => {
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
  });
  await open(); await page.locator('.ribbon-btn[data-view=settings]').click();
  await page.locator('#settingsThemePicker [data-theme=midnight]').click();
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
  await page.evaluate(() => window.workspaceThemeFixture.theme.setApplicationTheme('forest'));
  await page.locator('#settingsApplicationColors').check();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await page.locator('html').getAttribute('data-theme')).toBe('forest');
  await page.locator('#settingsThemePicker [data-theme=workspace]').click();
  await expect.poll(() => token('--bg-primary')).toBe('#f5f6f9');
  expect(errors).toEqual([]);
}, 30000);

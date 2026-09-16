/**
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual Profile markup, account session states, palette geometry and modal lifecycle in isolated Chromium.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Give the hooks that own the isolated fixture browser the fixture's exit budget, so a confirmed but slow shutdown on a loaded box is failed by neither deadline.
 * =============================================================================
 */
import { type Browser, type BrowserContext, type Page, type Request } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { profileGate, signedInProfile, startCockpitProfileFixture } from '../fixtures/cockpit-profile';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';

vi.setConfig({ testTimeout: 20_000, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });
let fixture: Awaited<ReturnType<typeof startCockpitProfileFixture>>;
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>, browser: Browser;
let context: BrowserContext, page: Page;
beforeAll(async () => {
  fixture = await startCockpitProfileFixture();
  owned = await launchIsolatedBrowser(); browser = owned.browser;
});
beforeEach(() => { fixture.profile.reply = signedInProfile(); fixture.profile.requests = []; });
afterEach(async () => {
  try { expect(fixture.profile.requests.filter(value => !value.startsWith('GET '))).toEqual([]); }
  finally { await context?.close(); }
});
afterAll(async () => {
  try { await writeFile('temp/cockpit-profile-browser-cleanup.json', JSON.stringify(await owned?.close(), null, 2)); }
  finally { await fixture?.close(); }
}, 30_000);

/** @description Load the real application and retain its synthetic editor as an unsaved-draft witness. */
async function open(theme = 'workspace', width = 1280, height = 800) {
  context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await context.addInitScript(value => localStorage.setItem('cockpit-theme', value), theme);
  page = await context.newPage(); page.setDefaultTimeout(4000);
  await page.goto(fixture.origin + '/cockpit/');
  await page.frameLocator('.tool-view-container iframe').locator('#draft').waitFor();
  await page.frameLocator('.tool-view-container iframe').locator('#draft').fill('Unsubmitted synthetic draft');
}

/** @description Exercise the real header entry and await a completed synthetic session read. */
async function profile() {
  await page.locator('#profileBtn').click();
  await expect.poll(() => page.locator('#profileModalBody').getAttribute('aria-busy')).toBe('false');
}

/** @description Wait past body delivery or observed abort before asserting that a late response cannot mutate the DOM. */
async function settled(request: Request) {
  const response = await request.response(); await response?.finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

it('uses readable aligned controls and current navigation copy in the actual shell', async () => {
  await open(); await profile();
  expect(await page.locator('#profileModalBody').innerText()).not.toMatch(/stay on the ribbon/);
  const button = await page.locator('#profileSettingsAction').boundingBox();
  expect(button!.height).toBeGreaterThanOrEqual(40);
  expect(await page.locator('#profileModalBody.modal-content, #profileModalBody .login-status').count()).toBe(0);
  expect(await page.locator('#profileIdentity').innerText()).toContain('Example Member');
  expect(await page.locator('#profileSignOutAction').innerText()).toBe('Sign Out');
});

it('reports a transient session failure without claiming the caller signed out', async () => {
  await open(); fixture.profile.reply = { status: 503, body: { error: 'Synthetic session unavailable' } };
  await page.locator('#profileBtn').click();
  await expect.poll(() => page.locator('#profileModalBody').innerText()).toMatch(/Could not check|Unable to check/);
  expect(await page.locator('#profileSignInAction').count()).toBe(0);
  expect(await page.locator('#profileSignOutAction').count()).toBe(0);
});

it('does not hydrate a closed profile after its held session response finishes', async () => {
  await open(); const gate = profileGate();
  fixture.profile.reply = { ...signedInProfile(), wait: gate.wait };
  try {
    const read = page.waitForRequest('**/api/auth/user');
    await page.locator('#profileBtn').click(); const request = await read;
    const original = await page.locator('#profileModalBody').innerHTML();
    await page.locator('#modalCloseBtn').click(); gate.release();
    await settled(request);
    expect(await page.locator('#profileModalBody').innerHTML()).toBe(original);
    expect(await page.locator('#profileBtn').evaluate(element => element === document.activeElement)).toBe(true);
  } finally { gate.release(); }
});

/** @description Inspect rendered bounds, visible hit targets and opacity with the actual complete CSS cascade. */
async function geometry() {
  return page.locator('#modalContainer').evaluate(element => {
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, width: innerWidth, height: innerHeight,
      background: style.backgroundColor, image: style.backgroundImage,
      controls: Array.from(element.querySelectorAll('button')).filter(button => button.getClientRects().length).map(button => {
        const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { id: button.id, x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height,
          hit: hit === button || button.contains(hit) };
      }) };
  });
}

for (const [theme, width, height, background] of [
  ['workspace', 1280, 800, 'rgb(245, 246, 249)'], ['daylight', 390, 740, 'rgb(240, 242, 248)'],
  ['midnight', 640, 400, 'rgb(10, 10, 18)'],
] as const) {
  it(`keeps the real ${theme} dialog opaque and usable at ${width}x${height}`, async () => {
    await open(theme, width, height); await profile();
    const data = await geometry();
    expect(data.x).toBeGreaterThanOrEqual(0); expect(data.y).toBeGreaterThanOrEqual(0);
    expect(data.right).toBeLessThanOrEqual(data.width); expect(data.bottom).toBeLessThanOrEqual(data.height);
    expect(data.background).toBe(background); expect(data.image).toBe('none');
    for (const control of data.controls) {
      expect(control.height).toBeGreaterThanOrEqual(40); expect(control.hit, control.id).toBe(true);
      expect(control.x).toBeGreaterThanOrEqual(data.x); expect(control.right).toBeLessThanOrEqual(data.right);
    }
    await page.screenshot({ path: `temp/cockpit-profile-${theme}.png` });
  });
}

it('keeps both account actions reachable with 200 percent text enlargement and a long identity', async () => {
  await open('workspace', 640, 520);
  fixture.profile.reply = { status: 200, body: { authenticated: true, user: { name: 'A deliberately long synthetic member name for wrapping',
    email: 'long-synthetic-address@example.test' } } };
  await page.addStyleTag({ content: ':root { --font-size-sm:28px; --font-size-lg:40px; }' });
  await profile(); await page.locator('#profileSignOutAction').scrollIntoViewIfNeeded();
  const data = await geometry();
  expect(data.x).toBeGreaterThanOrEqual(0); expect(data.right).toBeLessThanOrEqual(data.width);
  expect(data.bottom).toBeLessThanOrEqual(data.height);
  expect(data.controls.find(control => control.id === 'profileSignOutAction')?.hit).toBe(true);
  expect(await page.locator('#profileModalBody').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

it('retains the current profile and draft while another portal tab changes the palette', async () => {
  await open(); const frame = page.frameLocator('.tool-view-container iframe');
  const documentId = await frame.locator('html').getAttribute('data-document-id');
  await profile();
  const other = await context.newPage(); await other.goto(fixture.origin + '/login');
  await other.evaluate(() => localStorage.setItem('cockpit-theme', 'midnight')); await other.close();
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('midnight');
  expect((await geometry()).background).toBe('rgb(10, 10, 18)');
  expect(await page.locator('#profileIdentity').innerText()).toContain('Example Member');
  await page.keyboard.press('Escape');
  expect(await frame.locator('html').getAttribute('data-document-id')).toBe(documentId);
  expect(await frame.locator('#draft').inputValue()).toBe('Unsubmitted synthetic draft');
});

it('traps keyboard focus and restores the profile opener on Escape without replacing an editor', async () => {
  await open(); await page.locator('#profileBtn').focus(); await page.keyboard.press('Enter');
  await page.locator('#profileSignOutAction').waitFor();
  expect(await page.locator('#modalContainer').getAttribute('role')).toBe('dialog');
  expect(await page.locator('#modalContainer').getAttribute('aria-labelledby')).toBe('modalTitle');
  expect(await page.locator('#modalCloseBtn').evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await page.locator('#profileSignOutAction').evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.locator('#modalCloseBtn').evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.locator('#profileBtn').evaluate(element => element === document.activeElement)).toBe(true);
  expect(await page.frameLocator('.tool-view-container iframe').locator('#draft').inputValue()).toBe('Unsubmitted synthetic draft');
  expect(await page.locator('#modalContainer').getAttribute('role')).toBeNull();
});

for (const [authenticated, route] of [[true, '/logout'], [false, '/login']] as const) {
  it(`uses the verified ${authenticated ? 'signed-in' : 'signed-out'} state and explicit ${route} destination`, async () => {
    await open(); if (!authenticated) fixture.profile.reply = { status: 200, body: { authenticated: false, user: null } };
    await page.evaluate(() => { localStorage.setItem('oshal_access_token', 'untrusted-fixture-token'); localStorage.setItem('oshal_user', 'untrusted-user'); });
    await profile();
    expect(await page.locator('#profileStatusText').innerText()).toBe(authenticated ? 'Signed in' : 'You are not signed in.');
    expect(fixture.profile.requests.filter(value => /^GET \/(login|logout)$/.test(value))).toEqual([]);
    await page.locator(authenticated ? '#profileSignOutAction' : '#profileSignInAction').click();
    await page.waitForURL(fixture.origin + route);
    expect(fixture.profile.requests.filter(value => /^GET \/(login|logout)$/.test(value))).toEqual([`GET ${route}`]);
  });
}

it('hands off to the same actual Global Settings view used by the OSHAL menu', async () => {
  await open(); await profile(); await page.locator('#profileSettingsAction').click();
  await page.locator('#settingsThemePicker').waitFor();
  expect(await page.locator('#modalOverlay').isVisible()).toBe(false);
  expect(await page.locator('.settings-tab.active').innerText()).toBe('Global Settings');
  await page.locator('#workspaceNavigationMore > summary').click(); await page.locator('#portalSettingsBtn').click();
  expect(await page.locator('#settingsThemePicker').isVisible()).toBe(true);
  expect(fixture.profile.requests.filter(value => /^GET \/(login|logout)$/.test(value))).toEqual([]);
});

for (const [label, reply] of [
  ['HTTP 403', { status: 403, body: { error: 'synthetic-private-value' } }],
  ['invalid JSON', { status: 200, body: null, raw: 'synthetic-private-value' }],
  ['null response', { status: 200, body: null }],
] as const) {
  it(`offers one explicit Retry after ${label} without leaking its response or signing out`, async () => {
    await open(); fixture.profile.reply = reply; const messages: string[] = [];
    page.on('console', message => { if (message.text().includes('profile-session-unavailable')) messages.push(message.text()); });
    await profile(); expect(await page.locator('#profileRetryAction').isVisible()).toBe(true);
    expect(await page.locator('#profileSignInAction').count()).toBe(0);
    const reads = fixture.profile.authReads; fixture.profile.reply = signedInProfile();
    await page.locator('#profileRetryAction').click(); await page.locator('#profileSignOutAction').waitFor();
    expect(fixture.profile.authReads).toBe(reads + 1); expect(await page.locator('#profileRetryAction').isVisible()).toBe(false);
    expect(messages.length).toBe(1); expect(messages.join()).not.toContain('synthetic-private-value');
  });
}

it('bounds a stalled check and retries without accepting the old response', async () => {
  await open(); await page.clock.install(); const gate = profileGate();
  fixture.profile.reply = { ...signedInProfile(), wait: gate.wait };
  try {
    const read = page.waitForRequest('**/api/auth/user'); await page.locator('#profileBtn').click(); const request = await read;
    expect(await page.locator('#profileModalBody').getAttribute('aria-busy')).toBe('true');
    expect(await page.locator('#profileSignInAction').count()).toBe(0);
    await page.clock.fastForward(10001);
    await expect.poll(() => page.locator('#profileRetryAction').isVisible()).toBe(true);
    fixture.profile.reply = { status: 401, body: { authenticated: false } };
    await page.locator('#profileRetryAction').click(); await page.locator('#profileSignInAction').waitFor();
    gate.release(); await request.response();
    expect(await page.locator('#profileSignOutAction').count()).toBe(0);
  } finally { gate.release(); }
});

it('keeps a reopened profile tied to its own session response and Settings listener', async () => {
  await open(); const gate = profileGate(); fixture.profile.reply = { ...signedInProfile(), wait: gate.wait };
  try {
    const read = page.waitForRequest('**/api/auth/user'); await page.locator('#profileBtn').click(); const request = await read;
    await page.keyboard.press('Escape'); fixture.profile.reply = { status: 200, body: { authenticated: false } };
    await profile(); gate.release(); await settled(request);
    expect(await page.locator('#profileStatusText').innerText()).toBe('You are not signed in.');
    expect(await page.locator('#profileSignOutAction').count()).toBe(0);
    await page.evaluate(() => {
      const app = (window as unknown as { __cockpit: { openCockpitSettingsPage: (...args: unknown[]) => void; profileHandoffs?: number } }).__cockpit;
      const original = app.openCockpitSettingsPage; app.profileHandoffs = 0;
      app.openCockpitSettingsPage = function (...args) { this.profileHandoffs!++; return original.apply(this, args); };
    });
    await page.locator('#profileSettingsAction').click(); await page.locator('#settingsThemePicker').waitFor();
    expect(await page.evaluate(() => (window as unknown as { __cockpit: { profileHandoffs: number } }).__cockpit.profileHandoffs)).toBe(1);
  } finally { gate.release(); }
});

it('retires a pending profile when another shell modal replaces it', async () => {
  await open(); const gate = profileGate(); fixture.profile.reply = { ...signedInProfile(), wait: gate.wait };
  try {
    const read = page.waitForRequest('**/api/auth/user'); await page.locator('#profileBtn').click(); const request = await read;
    await page.evaluate(() => (window as unknown as { __cockpit: { openModal: (type: string) => void } }).__cockpit.openModal('rag'));
    const original = await page.locator('#modalBody').innerHTML(); gate.release(); await settled(request);
    expect(await page.locator('#modalTitle').innerText()).toBe('RAG Ingestion');
    expect(await page.locator('#modalBody').innerHTML()).toBe(original);
    expect(await page.locator('#modalContainer').evaluate(element => element.classList.contains('profile-dialog'))).toBe(false);
  } finally { gate.release(); }
});

it('renders account text inertly and closes on the backdrop without an account action', async () => {
  await open(); fixture.profile.reply = { status: 200, body: { authenticated: true,
    user: { name: '<img src="/fixture/identity-probe" onerror="alert(1)">', email: '<b>member</b>@example.test' } } };
  await profile(); expect(await page.locator('#profileIdentity img, #profileIdentity b').count()).toBe(0);
  expect(await page.locator('#profileIdentity').innerText()).toContain('<img');
  expect(fixture.profile.requests.some(value => value.includes('identity-probe'))).toBe(false);
  await page.locator('#modalOverlay').click({ position: { x: 4, y: 4 } });
  expect(await page.locator('#modalOverlay').isVisible()).toBe(false);
  expect(await page.locator('#profileBtn').evaluate(element => element === document.activeElement)).toBe(true);
});

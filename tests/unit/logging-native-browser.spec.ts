/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive shipped logging ES modules in Chromium across rendering, acknowledgement and lifecycle boundaries; HTTP is an explicit browser-only double, not native authority/persistence proof.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Assert acknowledged configuration preconditions and retain effective state on a stale conditional update.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';
import { LoggingNativeBrowserFixture, loggingBrowserRecord, type LoggingBrowserConfig } from './support/logging-native-browser-fixture';

declare global {
  interface Window {
    __loggingBrowser: { ready: Promise<void>; pending: Promise<void>[]; view: {
      entries: unknown[]; settings: { config: LoggingBrowserConfig | null }; destroy(): void;
    } };
  }
}

vi.setConfig({ testTimeout: 20_000, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });
const fixture = new LoggingNativeBrowserFixture();
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let context: BrowserContext, page: Page;
let pageErrors: string[];

beforeAll(async () => {
  await fixture.start();
  try {
    owned = await launchIsolatedBrowser({ executablePath: process.env.OSHAL_FIXTURE_BROWSER_EXECUTABLE });
    console.info('Logging browser-only fixture:', JSON.stringify({ browserVersion: owned.browser.version(), http: 'mocked-loopback' }));
  } catch (error) { await fixture.close(); throw error; }
});
beforeEach(async () => {
  fixture.reset();
  context = await owned.browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin
    ? route.continue() : route.abort());
  page = await context.newPage();
  page.setDefaultTimeout(4000);
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
});
afterEach(async () => {
  try { expect(pageErrors).toEqual([]); }
  finally { fixture.releaseAll(); await context?.close(); }
});
afterAll(async () => {
  try { if (owned) console.info('Logging owned browser cleanup:', JSON.stringify(await owned.close())); }
  finally { await fixture.close(); }
}, BROWSER_HOOK_TIMEOUT_MS);

async function open(ready = true) {
  await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#logsSearch').waitFor();
  if (ready) await page.evaluate(() => window.__loggingBrowser.ready);
}

async function drain() {
  await page.evaluate(() => Promise.all(window.__loggingBrowser.pending));
}

async function settings() {
  await page.locator('.logging-settings > summary').click();
  expect(await page.locator('#loggingEffective').isVisible()).toBe(true);
}

async function config() {
  return page.evaluate(() => window.__loggingBrowser.view.settings.config);
}

async function edit(level: string, overrides: string) {
  await page.locator('#loggingDefaultLevel').selectOption(level);
  await page.locator('#loggingOverrides').fill(overrides);
}

it('renders real retained records and sends encoded trace/ticket/TRACE filters', async () => {
  fixture.records.push(loggingBrowserRecord({ msg: 'Separate trace', traceId: 'trace-fixture-B', levelLabel: 'trace' }));
  await open();
  expect(await page.locator('.logs-row').count()).toBe(2);
  expect(await page.locator('#logsStatus').textContent()).toContain('recent memory buffer · resets on restart');
  expect(await page.locator('#logsStatus').textContent()).toContain('7 older entries evicted');
  expect(await page.locator('#logsLevel option[value="trace"]').textContent()).toBe('trace');
  await page.locator('.logs-row').first().click();
  await page.locator('[data-log-filter="traceId"]').first().click();
  await drain();
  expect(await page.locator('.logs-row').count()).toBe(1);
  expect(await page.locator('#logsTraceId').inputValue()).toBe('trace-fixture-A');
  await page.locator('.logs-row').click();
  await page.locator('[data-log-filter="ticketId"]').first().click();
  await drain();
  const clicked = fixture.calls.filter(call => call.path === '/api/v1/logs/query').at(-1)!;
  expect(clicked.query).toMatchObject({ traceId: 'trace-fixture-A', ticketId: 'ticket-fixture-A', limit: '500' });
  await page.locator('#logsTraceId').fill('trace & reserved?=value');
  await page.locator('#logsLevel').selectOption('trace');
  await drain();
  expect(fixture.calls.at(-1)!.query).toMatchObject({ traceId: 'trace & reserved?=value', level: 'trace' });
  expect(await page.locator('.logs-empty').textContent()).toContain('No retained entries match');
});

it('keeps malicious module, message, level and correlation fields inert', async () => {
  const hostile = '<img src=x onerror="document.body.dataset.pwned=1">';
  const module = '</option><script>document.body.dataset.pwned=2</script>';
  fixture.records = [loggingBrowserRecord({ msg: hostile, module, levelLabel: 'error" onclick="alert(1)',
    traceId: 'trace"><svg onload="document.body.dataset.pwned=3">', details: { value: hostile } })];
  fixture.modules.push(module);
  await open();
  expect(await page.locator('.logs-msg').textContent()).toBe(hostile);
  expect(await page.locator('.logs-module').textContent()).toBe(module);
  expect(await page.locator('.logs-level').getAttribute('class')).toBe('logs-level logs-level-info');
  expect(await page.locator('#logsModule option').last().textContent()).toBe(module);
  expect(await page.locator('#logsModule option').last().getAttribute('value')).toBe(module);
  await page.locator('.logs-row').click();
  expect(await page.locator('[data-log-filter="traceId"]').getAttribute('data-log-value'))
    .toBe('trace"><svg onload="document.body.dataset.pwned=3">');
  expect(await page.locator('#fixtureRoot img, #fixtureRoot svg, #fixtureRoot script').count()).toBe(0);
  expect(await page.evaluate(() => document.body.dataset.pwned)).toBeUndefined();
});

for (const [status, message] of [[401, 'Sign in to read logs.'], [403, 'Administrator access is required.'],
  [503, 'Logging storage is unavailable.']] as const) {
  it(`shows ${status} read refusal explicitly rather than empty history/settings`, async () => {
    fixture.queryStatus = fixture.settingsStatus = status;
    await open();
    expect(await page.locator('#logsBody [role="alert"]').textContent()).toBe(message);
    expect(await page.locator('#logsStatus').textContent()).toBe('Log read failed.');
    expect(await page.locator('#loggingSettings').textContent()).toBe(message);
    expect(await page.locator('#logsBody').textContent()).not.toContain('No retained entries match');
    expect(await page.locator('#fixtureRoot').textContent()).not.toContain('Private detail');
  });
}

it('sends the complete TRACE/module map and changes effective state only after actual HTTP acknowledgement', async () => {
  await open(); await settings();
  expect(await page.locator('#loggingDefaultLevel option[value="trace"]').textContent()).toBe('trace');
  const original = await config();
  const held = fixture.holdNext('/api/admin/logging', 'PUT');
  await edit('trace', 'api::admission=trace\nauth::guard=error');
  await page.locator('#loggingApply').click();
  await held.entered;
  const expected = { level: 'trace', module_levels: { 'api::admission': 'trace', 'auth::guard': 'error' } };
  const written = fixture.calls.filter(call => call.method === 'PUT');
  expect(written).toHaveLength(1);
  expect(written[0].path).toBe('/api/admin/logging');
  expect(written[0].body).toEqual({ ...expected, expected_config: original });
  expect(await config()).toEqual(original);
  expect(await page.locator('#loggingEffective').textContent()).toContain('Effective default: info');
  expect(await page.locator('#loggingSettingsStatus').textContent()).toBe('Saving…');
  expect(await page.locator('#loggingApply').isDisabled()).toBe(true);
  held.release(); await drain();
  expect(await config()).toEqual(expected);
  expect(await page.locator('#loggingSettingsStatus').textContent()).toBe('Applied: trace.');
  const effective = await page.locator('#loggingEffective').textContent();
  expect(effective).toContain('Effective default: trace');
  expect(effective).toContain('auth::guard=error');
  expect(effective).not.toContain('worker=debug');
  expect(await page.locator('#loggingApply').isEnabled()).toBe(true);
});

it('preserves acknowledged effective state after a genuine stale-config 409 response', async () => {
  await open(); await settings();
  const original = await config();
  const effective = await page.locator('#loggingEffective').textContent();
  fixture.config = { level: 'error', module_levels: { 'api::admission': 'warn' } };
  await edit('trace', 'api::admission=trace');
  await page.locator('#loggingApply').click(); await drain();
  const written = fixture.calls.filter(call => call.method === 'PUT');
  expect(written).toHaveLength(1);
  expect(written[0].body).toEqual({ level: 'trace', module_levels: { 'api::admission': 'trace' },
    expected_config: original });
  expect(await page.locator('#loggingSettingsStatus').textContent())
    .toBe('Logging settings changed. Reload this screen before applying.');
  expect(await config()).toEqual(original);
  expect(await page.locator('#loggingEffective').textContent()).toBe(effective);
  expect(fixture.config).toEqual({ level: 'error', module_levels: { 'api::admission': 'warn' } });
  expect(await page.locator('#loggingSettingsStatus').textContent()).not.toContain('Applied:');
  expect(await page.locator('#loggingDefaultLevel').inputValue()).toBe('trace');
});

it('retains prior acknowledged state and effective display after refused persistence', async () => {
  await open(); await settings();
  const original = await config();
  const effective = await page.locator('#loggingEffective').textContent();
  fixture.updateStatus = 503;
  await edit('trace', 'new::module=debug');
  await page.locator('#loggingApply').click(); await drain();
  expect(fixture.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  expect(await page.locator('#loggingSettingsStatus').textContent()).toBe('Logging storage is unavailable.');
  expect(await config()).toEqual(original);
  expect(await page.locator('#loggingEffective').textContent()).toBe(effective);
  expect(await page.locator('#loggingSettingsStatus').textContent()).not.toContain('Applied:');
  expect(await page.locator('#loggingDefaultLevel').inputValue()).toBe('trace');
  expect(await page.locator('#loggingApply').isEnabled()).toBe(true);
});

for (const [overrides, message] of [['api=debug\napi=trace', 'Duplicate module: api'],
  ['module without equals', 'Each override must use module=level.'],
  ['api=TRACE', 'Each override must use module=level.']] as const) {
  it(`prevents PUT for invalid/duplicate override ${JSON.stringify(overrides)}`, async () => {
    await open(); await settings();
    const original = await config();
    await edit('trace', overrides);
    await page.locator('#loggingApply').click(); await drain();
    expect(fixture.calls.filter(call => call.method === 'PUT')).toEqual([]);
    expect(await page.locator('#loggingSettingsStatus').textContent()).toBe(message);
    expect(await config()).toEqual(original);
    expect(await page.locator('#loggingEffective').textContent()).toContain('Effective default: info');
  });
}

it('refuses a malformed success reply without publishing requested effective settings', async () => {
  await open(); await settings();
  const original = await config();
  fixture.updateReply = { level: '<img src=x onerror=alert(1)>', module_levels: {} };
  await edit('debug', 'api::admission=trace');
  await page.locator('#loggingApply').click(); await drain();
  expect(await page.locator('#loggingSettingsStatus').textContent()).toBe('The logging settings response is invalid.');
  expect(await config()).toEqual(original);
  expect(await page.locator('#loggingEffective').textContent()).toContain('Effective default: info');
  expect(await page.locator('#fixtureRoot img').count()).toBe(0);
});

it('does not replace the newest filter result with a slower earlier response', async () => {
  fixture.records = [loggingBrowserRecord({ msg: 'Earlier debug record', levelLabel: 'debug' })];
  await open();
  const held = fixture.holdNext('/api/v1/logs/query');
  await page.locator('#logsLevel').selectOption('debug');
  await held.entered;
  fixture.records = [loggingBrowserRecord({ msg: 'Latest trace record', levelLabel: 'trace' })];
  await page.locator('#logsLevel').selectOption('trace');
  await expect.poll(() => page.locator('.logs-msg').textContent()).toBe('Latest trace record');
  held.release(); await drain();
  expect(await page.locator('.logs-msg').textContent()).toBe('Latest trace record');
  expect(await page.locator('#logsLevel').inputValue()).toBe('trace');
  expect(await page.locator('#logsBody').textContent()).not.toContain('Earlier debug record');
});

it('does not render late log/settings reads into a replacement view after destroy', async () => {
  const logs = fixture.holdNext('/api/v1/logs/query');
  const settingsRead = fixture.holdNext('/api/admin/logging');
  await open(false);
  await Promise.all([logs.entered, settingsRead.entered]);
  await page.evaluate(() => {
    window.__loggingBrowser.view.destroy();
    document.getElementById('fixtureRoot')!.textContent = 'Replacement workspace';
  });
  logs.release(); settingsRead.release();
  await page.evaluate(() => window.__loggingBrowser.ready); await drain();
  expect(await page.locator('#fixtureRoot').textContent()).toBe('Replacement workspace');
  expect(await page.locator('#logsBody, #loggingApply').count()).toBe(0);
});

it('does not acknowledge a late settings PUT into a departed view', async () => {
  await open(); await settings();
  const original = await config();
  const held = fixture.holdNext('/api/admin/logging', 'PUT');
  await edit('trace', 'api::admission=trace');
  await page.locator('#loggingApply').click(); await held.entered;
  await page.evaluate(() => {
    window.__loggingBrowser.view.destroy();
    document.getElementById('fixtureRoot')!.textContent = 'Replacement workspace';
  });
  held.release(); await drain();
  expect(await config()).toEqual(original);
  expect(await page.locator('#fixtureRoot').textContent()).toBe('Replacement workspace');
  expect(await page.locator('#loggingSettingsStatus').count()).toBe(0);
});

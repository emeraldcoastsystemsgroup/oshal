/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3 done-when in Chromium on localhost with MOCK_OIDC: the real Settings, Location page (/cockpit/tools/location.html) over the real /api/location mount and a private PostgreSQL. A person turns location on for their browser (the page opens the sign-in-again window, MOCK_OIDC completes it on the top-level navigation, the page spends the proof), the browser's position is posted and the page shows the place it falls in; stopping reporting clears the current place while the stored history stays and further fixes are refused; deleting the history removes the rows. Then script on a same-origin packaged surface, running as the same person, tries every exposure-raising call: with no proof, with a challenge it opened itself but could not prove (its fetch to the start endpoint and a framed start both refused, because a browser marks both as other than a top-level navigation), and for arming a rule, which no route in this build performs. Nothing changes in the database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  MOCK_SUB_HEADER, PACKAGED_SURFACE_PATH, countRows, seedOwnPlace, startLocationBrowserServer, type LocationBrowserServer,
} from '../helpers/location-browser-server';

const PERSON = 'loc-browser-person';
const HOME = { name: 'Home', label: 'home', lat: -12.3461, lon: -31.9882, radiusM: 120 };
const HERE = { latitude: -12.34615, longitude: -31.98825, accuracy: 15 };
let fx: LocationBrowserServer;
let browser: Browser;
let context: BrowserContext;

async function settingsPage(): Promise<Page> {
  const page = await context.newPage();
  page.on('dialog', (dialog) => { void dialog.accept(); });
  await page.goto(`${fx.base}/cockpit/tools/location.html`);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Loading…');
  return page;
}

beforeAll(async () => {
  fx = await startLocationBrowserServer('location-settings-browser');
  await seedOwnPlace(fx, PERSON, HOME);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    geolocation: HERE, permissions: ['geolocation'], extraHTTPHeaders: { [MOCK_SUB_HEADER]: PERSON },
  });
}, 180_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await fx?.close();
}, 60_000);

/** Turn location on through the page: the sign-in-again window opens, completes and closes. */
async function optInThroughPage(page: Page): Promise<void> {
  await expect.poll(() => page.textContent('[data-testid="browser-card"] h3')).toBe('Location is off for this browser');
  const popup = context.waitForEvent('page');
  await page.click('[data-testid="opt-in"]');
  const signIn = await popup;
  await expect.poll(() => signIn.isClosed(), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => page.textContent('[data-testid="current-place"]'), { timeout: 20_000 }).toBe('At Home');
  await expect.poll(() => page.textContent('[data-testid="browser-card"] h3')).toBe('Reporting from this browser');
}

/** Stop reporting through the page; the current place clears, the history stays and ingest is refused. */
async function optOutThroughPage(page: Page): Promise<void> {
  await page.click('[data-testid="opt-out"]');
  await expect.poll(() => page.textContent('[data-testid="current-place"]')).toBe('No position yet');
  await expect.poll(() => page.textContent('[data-testid="history-count"]')).toContain('1 position stored');
  expect(await countRows(fx, 'location_current')).toBe(0);
  expect(await countRows(fx, 'location_observations WHERE owner_sub = $1', [PERSON])).toBe(1);
  const refused = await page.evaluate(async () => {
    const deviceId = localStorage.getItem('oshal.location.browserDeviceId');
    const res = await fetch('/api/location/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, lat: -12.3461, lon: -31.9882 }) });
    return { status: res.status, error: (await res.json()).error };
  });
  expect(refused).toEqual({ status: 409, error: 'reporting_off' });
}

/**
 * Every exposure-raising call script on a packaged surface can make as the person: no proof, a
 * challenge it opened itself (then tried to prove by fetch and by a frame), and arming.
 */
async function surfaceAttempts(surface: Page, deviceId: string): Promise<Record<string, string>> {
  return surface.evaluate(async (deviceId: string) => {
    const post = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`/api/location${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return `${res.status}:${(await res.json().catch(() => ({}))).error ?? ''}`;
    };
    const optInBody = { deviceId, precisionClass: 'exact' };
    const opened = await (await fetch('/api/location/step-up', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'opt-in', params: optInBody }) })).json();
    const startByFetch = await fetch(opened.startUrl);
    const frame = document.createElement('iframe');
    frame.src = opened.startUrl;
    await new Promise((resolve) => { frame.onload = resolve; document.body.appendChild(frame); });
    const stateAfter = (await (await fetch(`/api/location/step-up/${opened.challengeId}`)).json()).state;
    const share = { tenantId: '11111111-1111-4111-8111-111111111111', placeIds: ['22222222-2222-4222-8222-222222222222'] };
    return {
      optInNoProof: await post('POST', '/devices/browser/opt-in', optInBody),
      startByFetch: `${startByFetch.status}:${(await startByFetch.json()).error}`,
      stateAfter,
      optInUnproven: await post('POST', '/devices/browser/opt-in', optInBody, { 'X-Oshal-Location-Step-Up': opened.challengeId }),
      raise: await post('PUT', `/devices/${deviceId}/precision`, { precisionClass: 'exact' }),
      raiseDefault: await post('PUT', '/settings', { defaultPrecisionClass: 'exact' }),
      share: await post('POST', '/shares', share),
      arm: await post('POST', '/step-up', { operation: 'arm-rule', params: {} }),
    };
  }, deviceId);
}

describe('Settings, Location in Chromium (MOCK_OIDC, localhost)', () => {
  it('opts a browser in, shows the current place, opts out keeping history, then purges it', async () => {
    const page = await settingsPage();
    await optInThroughPage(page);
    const stored = (await fx.db.pool.query('SELECT owner_sub, source, precision_class, lat, lon FROM location_observations')).rows;
    expect(stored).toEqual([{ owner_sub: PERSON, source: 'browser', precision_class: 'block', lat: -12.346, lon: -31.988 }]);
    expect(await countRows(fx, 'location_current WHERE owner_sub = $1 AND place_id IS NOT NULL', [PERSON])).toBe(1);
    await optOutThroughPage(page);
    await page.click('[data-testid="purge"]');
    await expect.poll(() => page.textContent('[data-testid="history-count"]')).toContain('0 positions stored');
    expect(await countRows(fx, 'location_observations')).toBe(0);
    expect(await countRows(fx, 'location_current')).toBe(0);
    await page.close();
  }, 90_000);

  it('script on a packaged surface cannot opt in, raise precision, accept a share or arm a rule without a fresh proof', async () => {
    const devicesBefore = (await fx.db.pool.query('SELECT device_id, reporting_enabled, precision_class FROM location_devices')).rows;
    expect(devicesBefore).toEqual([{ device_id: expect.any(String), reporting_enabled: false, precision_class: 'block' }]);
    const surface = await context.newPage();
    await surface.goto(`${fx.base}${PACKAGED_SURFACE_PATH}`);
    const outcome = await surfaceAttempts(surface, devicesBefore[0].device_id);
    expect(outcome).toEqual({
      optInNoProof: '403:step_up_required', startByFetch: '403:navigation_required', stateAfter: 'pending',
      optInUnproven: '403:step_up_required', raise: '403:step_up_required', raiseDefault: '403:step_up_required',
      share: '403:step_up_required', arm: '400:operation_not_available',
    });
    expect((await fx.db.pool.query('SELECT device_id, reporting_enabled, precision_class FROM location_devices')).rows).toEqual(devicesBefore);
    expect(await countRows(fx, 'location_shares')).toBe(0);
    expect(await countRows(fx, 'location_settings')).toBe(0);
    await surface.close();
  }, 60_000);
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The assistant pages' location reporter (src/experience/location-reporter.js), run as the shipped file: it starts only for a browser turned on in Settings, Location whose geolocation permission is already granted (never prompting), posts at most one fix per 30 s and only while the page is visible, stops on a refusal that means the device is gone or reporting is off, and posts a body the server's own browser-fix parser accepts.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { parseBrowserFix } from '@/app/location-presence';

const require = createRequire(import.meta.url);
const REPORTER = require('../../src/experience/location-reporter.js') as {
  start: (env: unknown) => Promise<{ stop: () => void; isWatching: () => boolean } | null>;
  DEVICE_KEY: string; POST_EVERY_MS: number;
};

const DEVICE = '0b9d2c6e-4f1a-4c39-9a51-2f1f7c3d0a11';

/** A browser as the reporter sees it, with a scripted clock, permission and server answer. */
function fakeBrowser(options: { device?: string | null; permission?: string; status?: number } = {}) {
  const state = { now: 1_800_000_000_000, hidden: false, watching: false, cleared: false, prompted: false };
  const posts: Array<{ url: string; init: { method: string; credentials: string; body: string } }> = [];
  let onPosition: ((pos: unknown) => void) | null = null;
  const env = {
    storage: { getItem: (key: string) => (key === REPORTER.DEVICE_KEY ? (options.device === undefined ? DEVICE : options.device) : null) },
    permissions: { query: async () => ({ state: options.permission ?? 'granted' }) },
    geolocation: {
      watchPosition: (cb: (pos: unknown) => void) => { state.watching = true; state.prompted = (options.permission ?? 'granted') !== 'granted'; onPosition = cb; return 7; },
      clearWatch: (id: number) => { state.cleared = id === 7; },
    },
    fetch: async (url: string, init: { method: string; credentials: string; body: string }) => { posts.push({ url, init }); return { status: options.status ?? 201 }; },
    document: { get hidden() { return state.hidden; } },
    now: () => state.now,
  };
  /** Deliver one position and let the post's answer settle. */
  const position = async (lat: number, lon: number): Promise<void> => {
    onPosition?.({ coords: { latitude: lat, longitude: lon, accuracy: 12 }, timestamp: state.now });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { env, state, posts, position };
}

describe('the assistant pages\' location reporter', () => {
  it('does nothing in a browser that was never turned on in Settings, Location', async () => {
    const browser = fakeBrowser({ device: null });
    expect(await REPORTER.start(browser.env)).toBeNull();
    expect(browser.state.watching).toBe(false);
  });

  it('never prompts: without an already granted permission it does not watch', async () => {
    for (const permission of ['prompt', 'denied']) {
      const browser = fakeBrowser({ permission });
      expect(await REPORTER.start(browser.env)).toBeNull();
      expect(browser.state.watching).toBe(false);
      expect(browser.state.prompted).toBe(false);
    }
  });

  it('posts a fix the server\'s own parser accepts, for this browser\'s device, with the session cookie', async () => {
    const browser = fakeBrowser();
    const handle = await REPORTER.start(browser.env);
    expect(handle?.isWatching()).toBe(true);
    await browser.position(-21.4712, -27.3051);
    expect(browser.posts).toHaveLength(1);
    const [post] = browser.posts;
    expect(post.url).toBe('/api/location/presence');
    expect(post.init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    const parsed = parseBrowserFix(JSON.parse(post.init.body), browser.state.now) as unknown as Record<string, unknown>;
    expect(parsed).toMatchObject({ deviceId: DEVICE });
  });

  it('posts at most once per 30 seconds, and not while the page is hidden', async () => {
    const browser = fakeBrowser();
    await REPORTER.start(browser.env);
    await browser.position(-21.4712, -27.3051);
    browser.state.now += 10_000;
    await browser.position(-21.4713, -27.3051);
    expect(browser.posts).toHaveLength(1);
    browser.state.now += REPORTER.POST_EVERY_MS;
    browser.state.hidden = true;
    await browser.position(-21.4714, -27.3051);
    expect(browser.posts).toHaveLength(1);
    browser.state.hidden = false;
    await browser.position(-21.4715, -27.3051);
    expect(browser.posts).toHaveLength(2);
  });

  it('stops watching when the server says the device is gone or reporting is off', async () => {
    for (const status of [404, 409, 401, 403]) {
      const browser = fakeBrowser({ status });
      const handle = await REPORTER.start(browser.env);
      await browser.position(-21.4712, -27.3051);
      expect(browser.state.cleared).toBe(true);
      expect(handle?.isWatching()).toBe(false);
      browser.state.now += REPORTER.POST_EVERY_MS;
      await browser.position(-21.4713, -27.3051);
      expect(browser.posts).toHaveLength(1);
    }
  });

  it('keeps watching through a rate-limit answer', async () => {
    const browser = fakeBrowser({ status: 429 });
    const handle = await REPORTER.start(browser.env);
    await browser.position(-21.4712, -27.3051);
    expect(handle?.isWatching()).toBe(true);
  });
});

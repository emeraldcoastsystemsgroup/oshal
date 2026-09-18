/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Split verbatim out of tests/jarvis-rich-response-integration.spec.ts at the 1000-code-line cap: the native-wake microphone lifecycle group, which proves the command stream, its AudioContext, and the recorder are released on speech end, on the no-voice timeout, on user interruption, and on page hide, while ambient speaker capture keeps its own stream.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fourth case: the page must still stand up its native-wake listener and open/release the command microphone when the framework theme assets fail to load. BUG-12 (#191) left the orb's colour fallbacks as the literal 'var(--accent-primary)', canvas addColorStop threw on it inside the first synchronous tick(), and the rest of the main script (mic handlers, wake listener, pagehide release) never registered. Red on the origin/main page.
 */

import { expect, test } from '@playwright/test';
import {
  fulfillNativeWake,
  installNativeWakeAudioStub,
  installSpeechStub,
  THEME_ASSET_PATHS,
} from './helpers/jarvis-rich-response-fixtures';

test('native wake releases its command microphone after speech while ambient speaker capture keeps its own stream', async ({ page }) => {
  await installSpeechStub(page);
  await installNativeWakeAudioStub(page);
  await page.route('**/*', (route) => fulfillNativeWake(route, true));
  await page.goto('http://jarvis.test/api/jarvis/');

  await expect.poll(() => page.evaluate(() => (window as any).__nativeWakeAudio.streams.length)).toBe(1);
  await page.evaluate(() => {
    const state = (window as any).__nativeWakeAudio;
    state.voice = true;
    window.dispatchEvent(new CustomEvent('oshal:native-wake', {
      detail: { phrase: 'Hey Computer', detectedAt: new Date().toISOString() },
    }));
    setTimeout(() => { state.voice = false; }, 250);
  });

  await expect.poll(() => page.evaluate(() => (window as any).__nativeWakeAudio.streams.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as any).__nativeWakeAudio.streams[1].tracks[0].stopped), {
    timeout: 4_000,
  }).toBe(true);
  const lifecycle = await page.evaluate(() => {
    const state = (window as any).__nativeWakeAudio;
    const capture = (window as any).JarvisSpeakerCapture.getInstance();
    return {
      ambientTrackStopped: state.streams[0].tracks[0].stopped,
      commandTrackStopped: state.streams[1].tracks[0].stopped,
      contextStates: state.contexts.map((context: any) => context.state),
      ambientStreamRetained: capture.stream === state.streams[0],
    };
  });
  expect(lifecycle).toEqual({
    ambientTrackStopped: false,
    commandTrackStopped: true,
    contextStates: ['closed'],
    ambientStreamRetained: true,
  });
});

test('native wake releases tracks and AudioContext on the no-voice timeout', async ({ page }) => {
  await installSpeechStub(page);
  // Each analyser sample advances Date.now beyond the 12-second production bound, so this drives
  // the real timeout branch without making the browser test sleep for 12 seconds.
  await installNativeWakeAudioStub(page, 13_000);
  await page.route('**/*', (route) => fulfillNativeWake(route, false));
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.evaluate(() => {
    const state = (window as any).__nativeWakeAudio;
    state.voice = false;
    window.dispatchEvent(new CustomEvent('oshal:native-wake', {
      detail: { phrase: 'Hey Computer', detectedAt: new Date().toISOString() },
    }));
  });

  await expect.poll(() => page.evaluate(() => (window as any).__nativeWakeAudio.streams[0]?.tracks[0].stopped), {
    timeout: 2_000,
  }).toBe(true);
  expect(await page.evaluate(() => (window as any).__nativeWakeAudio.contexts.map((context: any) => context.state)))
    .toEqual(['closed']);
});

test('native wake releases the microphone on user interruption and page close', async ({ page }) => {
  await installSpeechStub(page);
  await installNativeWakeAudioStub(page);
  await page.route('**/*', (route) => fulfillNativeWake(route, false));
  await page.goto('http://jarvis.test/api/jarvis/');

  const wake = async (detectedAtOffset: number) => page.evaluate((offset) => {
    (window as any).__nativeWakeAudio.voice = true;
    window.dispatchEvent(new CustomEvent('oshal:native-wake', {
      detail: { phrase: 'Hey Computer', detectedAt: new Date(Date.now() + offset).toISOString() },
    }));
  }, detectedAtOffset);

  await wake(0);
  await expect(page.locator('#mic')).toHaveClass(/live/);
  await page.evaluate(() => (document.getElementById('mute') as HTMLButtonElement).click());
  await expect.poll(() => page.evaluate(() => (window as any).__nativeWakeAudio.streams[0].tracks[0].stopped)).toBe(true);
  expect(await page.evaluate(() => (window as any).__nativeWakeAudio.contexts[0].state)).toBe('closed');

  await wake(1);
  await expect.poll(() => page.evaluate(() => (window as any).__nativeWakeAudio.streams.length)).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => ({
    trackStopped: (window as any).__nativeWakeAudio.streams[1].tracks[0].stopped,
    contextState: (window as any).__nativeWakeAudio.contexts[1].state,
  }))).toEqual({ trackStopped: true, contextState: 'closed' });
});

test('native wake still opens and releases the command microphone when the framework theme fails to load', async ({ page }) => {
  // The boundary that failed is the page's own main script in a real Chromium: with the theme
  // tokens absent, the orb's colour fallback went into a real CanvasGradient.addColorStop, which
  // threw inside the synchronous first tick(), and nothing below it - the mic handlers, the
  // oshal:native-wake listener, the pagehide release - ever registered. Withhold exactly the theme
  // assets (a failed stylesheet load presents as a 404 or a network error either way) and prove the
  // wake path still owns and releases the microphone.
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installSpeechStub(page);
  await installNativeWakeAudioStub(page);
  await page.route('**/*', (route) => {
    const pathName = new URL(route.request().url()).pathname;
    const themeAsset = (THEME_ASSET_PATHS as readonly string[]).includes(pathName) || pathName.startsWith('/cockpit/css/themes/');
    return themeAsset ? route.fulfill({ status: 404, body: '' }) : fulfillNativeWake(route, false);
  });
  await page.goto('http://jarvis.test/api/jarvis/');

  // Set at the end of the main script, right before the listener: unset means the script died above it.
  expect(await page.evaluate(() => (window as any).__OSHAL_JARVIS_NATIVE_WAKE_READY__)).toBe(true);
  await page.evaluate(() => {
    (window as any).__nativeWakeAudio.voice = true;
    window.dispatchEvent(new CustomEvent('oshal:native-wake', {
      detail: { phrase: 'Hey Computer', detectedAt: new Date().toISOString() },
    }));
  });
  await expect(page.locator('#mic')).toHaveClass(/live/);
  await expect.poll(() => page.evaluate(() => (window as any).__nativeWakeAudio.streams.length)).toBe(1);

  await page.evaluate(() => (document.getElementById('mute') as HTMLButtonElement).click());
  await expect.poll(() => page.evaluate(() => (window as any).__nativeWakeAudio.streams[0].tracks[0].stopped)).toBe(true);
  expect(await page.evaluate(() => (window as any).__nativeWakeAudio.contexts[0].state)).toBe('closed');
  expect(pageErrors).toEqual([]);
});

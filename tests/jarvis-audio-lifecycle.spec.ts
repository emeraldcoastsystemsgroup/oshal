/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added browser-runtime regressions for consent revocation, TTS capture gating, bounded upload fallback, settings rollback, and modal focus containment.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Loader update for the jarvis-ambient decomposition: inject the four load-ordered classic scripts (core/ui/recognition/coordinator) instead of the former single file. Assertions unchanged.
 */

import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
// The ambient client is four load-ordered classic scripts (see jarvis.html).
const AMBIENT_SCRIPTS = [
  path.join(ROOT, 'src', 'api', 'jarvis-ambient-core.js'),
  path.join(ROOT, 'src', 'api', 'jarvis-ambient-ui.js'),
  path.join(ROOT, 'src', 'api', 'jarvis-ambient-recognition.js'),
  path.join(ROOT, 'src', 'api', 'jarvis-ambient.js'),
];
const CAPTURE_SCRIPT = path.join(ROOT, 'src', 'api', 'jarvis-speaker-capture.js');

async function addAmbientScripts(page: Page): Promise<void> {
  for (const script of AMBIENT_SCRIPTS) await page.addScriptTag({ path: script });
}

declare global {
  interface Window {
    JarvisAmbient: any;
    JarvisSpeakerCapture: any;
    __audioTest: {
      started: number;
      track: { stopped: boolean };
      stream: unknown;
      resolveStream(): void;
    };
    __setAudioMode(mode: 'success' | 'timeout'): void;
    __rejectSettings(): void;
    __savePromise: Promise<void>;
    __beaconPayload: Blob | null;
  }
}

async function blankPage(page: Page): Promise<void> {
  await page.route('https://jarvis-audio.test/**', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: '<button id="outside">Outside</button><main id="mount"></main>',
    });
  });
  await page.goto('https://jarvis-audio.test/');
}

async function installFakeRecorder(page: Page, deferredStream: boolean): Promise<void> {
  await page.evaluate((deferred) => {
    let resolveStream: ((stream: unknown) => void) | null = null;
    const track = { stopped: false, stop() { this.stopped = true; } };
    const stream = { active: true, getTracks: () => [track] };
    const state = { started: 0, track, stream, resolveStream: () => resolveStream?.(stream) };
    Object.defineProperty(window, '__audioTest', { configurable: true, value: state });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => deferred
          ? new Promise((resolve) => { resolveStream = resolve; })
          : Promise.resolve(stream),
      },
    });
    class FakeRecorder extends EventTarget {
      static isTypeSupported(): boolean { return true; }
      state = 'inactive';
      mimeType = 'audio/webm';
      start(): void { this.state = 'recording'; state.started += 1; }
      stop(): void { this.state = 'inactive'; this.dispatchEvent(new Event('stop')); }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeRecorder });
  }, deferredStream);
}

test.describe('Jarvis audio privacy lifecycle', () => {
  test('stops a late microphone grant after consent is revoked', async ({ page }) => {
    await blankPage(page);
    await installFakeRecorder(page, true);
    await page.addScriptTag({ path: CAPTURE_SCRIPT });

    const result = await page.evaluate(async () => {
      const client = window.JarvisSpeakerCapture.mount({ apiBase: '/unused' });
      client.applySettings({ enabled: true, speakerDiarizationEnabled: true });
      await Promise.resolve();
      const pending = client.starting;
      client.applySettings({ enabled: false, speakerDiarizationEnabled: false });
      window.__audioTest.resolveStream();
      await pending?.catch(() => undefined);
      return {
        retained: client.stream === window.__audioTest.stream,
        trackStopped: window.__audioTest.track.stopped,
        recorderStarted: window.__audioTest.started,
      };
    });

    expect(result).toEqual({ retained: false, trackStopped: true, recorderStarted: 0 });
  });

  test('stops a late microphone grant after the capture client is destroyed', async ({ page }) => {
    await blankPage(page);
    await installFakeRecorder(page, true);
    await page.addScriptTag({ path: CAPTURE_SCRIPT });

    const result = await page.evaluate(async () => {
      const client = window.JarvisSpeakerCapture.mount({ apiBase: '/unused' });
      client.applySettings({ enabled: true, speakerDiarizationEnabled: true });
      await Promise.resolve();
      const pending = client.starting;
      client.destroy();
      window.__audioTest.resolveStream();
      await pending?.catch(() => undefined);
      return {
        retained: client.stream === window.__audioTest.stream,
        trackStopped: window.__audioTest.track.stopped,
        recorderStarted: window.__audioTest.started,
      };
    });

    expect(result).toEqual({ retained: false, trackStopped: true, recorderStarted: 0 });
  });

  test('does not begin one-shot enrollment when TTS starts during microphone permission', async ({ page }) => {
    await blankPage(page);
    await installFakeRecorder(page, true);
    await page.addScriptTag({ path: CAPTURE_SCRIPT });

    const result = await page.evaluate(async () => {
      const errors: string[] = [];
      document.addEventListener('jarvis:speakers-upload-error', (event) => {
        errors.push((event as CustomEvent).detail.message);
      });
      const client = window.JarvisSpeakerCapture.mount({ apiBase: '/unused' });
      client.applySettings({ rememberSpeakers: true });
      const enrollment = client.enrollCurrentUser();
      await Promise.resolve();
      client.setAssistantSpeaking(true);
      window.__audioTest.resolveStream();
      await enrollment;
      return {
        recorderStarted: window.__audioTest.started,
        trackStopped: window.__audioTest.track.stopped,
        error: errors.at(-1),
      };
    });

    expect(result.recorderStarted).toBe(0);
    expect(result.trackStopped).toBe(true);
    expect(result.error).toContain('Wait until Jarvis finishes speaking');
  });

  test('acknowledges successful audio persistence once and falls back to generic text on timeout', async ({ page }) => {
    await blankPage(page);
    await installFakeRecorder(page, false);
    await page.evaluate(() => {
      class FakeRecognition { start(): void {} abort(): void {} }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
      let audioMode: 'success' | 'timeout' = 'success';
      Object.defineProperty(window, '__setAudioMode', { value: (mode: 'success' | 'timeout') => { audioMode = mode; } });
      window.fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith('/settings')) {
          return new Response(JSON.stringify({ settings: {
            ambientEnabled: false, assistantName: 'Jarvis', wakePhrases: ['Hey Jarvis'],
            speakerDiarizationEnabled: true, rememberSpeakers: false,
          } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.endsWith('/audio') && audioMode === 'success') {
          return new Response(JSON.stringify({
            accepted: 1, duplicates: 0,
            processing: { status: 'complete', transcription: 'provider', diarization: 'complete' },
            segments: [{ text: 'first note', speakerLabel: 'Unidentified Person 1', speakerProfileId: 'profile-1' }],
          }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.endsWith('/audio')) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          });
        }
        if (url.endsWith('/segments')) {
          return new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), {
            status: 201, headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
    });
    await addAmbientScripts(page);
    await page.addScriptTag({ path: CAPTURE_SCRIPT });

    const result = await page.evaluate(async () => {
      const ambient = window.JarvisAmbient.mount({ mountTarget: '#mount', speakerAckTimeoutMs: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const capture = window.JarvisSpeakerCapture.mount({ apiBase: '/api/jarvis/ambient', uploadTimeoutMs: 50 });
      const processRecognized = async (text: string) => {
        ambient.acceptTranscript(text);
        const bundle = capture.takeTranscript(new Date(Date.now() - 1000), new Date(Date.now() + 1000));
        await capture.uploadAudio(new Blob([new Uint8Array(900)], { type: 'audio/webm' }), 'ambient', {
          startedAt: new Date(Date.now() - 1000), endedAt: new Date(),
          clientTranscript: bundle.text, recognitionIds: bundle.recognitionIds,
        });
      };
      await processRecognized('first note');
      const afterSuccess = { queued: ambient.pending.length, awaitingAck: ambient.pendingDiarization.size };
      window.__setAudioMode('timeout');
      await processRecognized('second note');
      return {
        afterSuccess,
        afterTimeout: { queued: ambient.pending.length, text: ambient.pending[0]?.text, awaitingAck: ambient.pendingDiarization.size },
      };
    });

    expect(result.afterSuccess).toEqual({ queued: 0, awaitingAck: 0 });
    expect(result.afterTimeout).toEqual({ queued: 1, text: 'second note', awaitingAck: 0 });
  });

  test('moves held diarization text into the exit beacon before capture teardown', async ({ page }) => {
    await blankPage(page);
    await page.evaluate(() => {
      class FakeRecognition { start(): void {} abort(): void {} }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
      window.__beaconPayload = null;
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        value: (_url: string, body: Blob) => { window.__beaconPayload = body; return true; },
      });
      window.fetch = async () => new Response(JSON.stringify({ settings: {
        ambientEnabled: false, speakerDiarizationEnabled: true, rememberSpeakers: false,
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await addAmbientScripts(page);

    const payload = await page.evaluate(async () => {
      const ambient = window.JarvisAmbient.mount({ mountTarget: '#mount' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      ambient.acceptTranscript('keep this on exit');
      const before = { generic: ambient.pending.length, held: ambient.pendingDiarization.size };
      window.dispatchEvent(new Event('pagehide'));
      const body = JSON.parse(await window.__beaconPayload!.text());
      return { before, body, after: { generic: ambient.pending.length, held: ambient.pendingDiarization.size } };
    });

    expect(payload.before).toEqual({ generic: 0, held: 1 });
    expect(payload.body.segments).toHaveLength(1);
    expect(payload.body.segments[0].text).toBe('keep this on exit');
    expect(payload.after).toEqual({ generic: 1, held: 0 });
  });
});

test.describe('Jarvis ambient settings lifecycle', () => {
  test('notifies capture before PUT and rolls a public remember setting back on 403', async ({ page }) => {
    await blankPage(page);
    await page.evaluate(() => {
      class FakeRecognition { start(): void {} abort(): void {} }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
      let resolvePut: ((response: Response) => void) | null = null;
      Object.defineProperty(window, '__rejectSettings', {
        value: () => resolvePut?.(new Response(JSON.stringify({ error: 'public_tenant_profile_forbidden' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        })),
      });
      window.fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith('/settings') && init?.method === 'PUT') {
          return new Promise((resolve) => { resolvePut = resolve; });
        }
        if (url.endsWith('/speaker-context')) {
          return new Response(JSON.stringify({ context: {
            available: false, reason: 'public_tenant', selectedTenantId: null, organizations: [], members: [],
          } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ settings: {
          ambientEnabled: false, assistantName: 'Jarvis', wakePhrases: ['Hey Jarvis'],
          speakerDiarizationEnabled: false, rememberSpeakers: false,
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
    });
    await addAmbientScripts(page);

    const beforeReject = await page.evaluate(async () => {
      const changes: Array<{ enabled: boolean; remember: boolean }> = [];
      document.addEventListener('jarvis:ambient-settings-changed', (event) => {
        const settings = (event as CustomEvent).detail.settings;
        changes.push({ enabled: settings.enabled, remember: settings.rememberSpeakers });
      });
      const client = window.JarvisAmbient.mount({ mountTarget: '#mount' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      client.ui.form.elements.enabled.checked = true;
      client.ui.form.elements.speakerDiarizationEnabled.checked = true;
      client.ui.form.elements.rememberSpeakers.checked = true;
      window.__savePromise = client.saveForm();
      return {
        changes, local: { ...client.settings },
        rememberDisabled: client.ui.form.elements.rememberSpeakers.disabled,
      };
    });

    expect(beforeReject.rememberDisabled).toBe(true);
    expect(beforeReject.changes.at(-1)).toEqual({ enabled: true, remember: true });
    expect(beforeReject.local.rememberSpeakers).toBe(true);

    await page.evaluate(async () => { window.__rejectSettings(); await window.__savePromise; });
    const afterReject = await page.evaluate(() => {
      const client = window.JarvisAmbient.getInstance();
      return {
        settings: client.settings,
        stored: JSON.parse(localStorage.getItem('oshal.jarvis.ambient.settings.v1')),
        notice: client.ui.notice.textContent,
      };
    });
    expect(afterReject.settings.rememberSpeakers).toBe(false);
    expect(afterReject.stored.rememberSpeakers).toBe(false);
    expect(afterReject.notice).toContain('cannot remember voice profiles');
  });

  test('contains focus, closes on Escape, and makes the parent modal inert for Voice & Speakers', async ({ page }) => {
    await blankPage(page);
    await page.evaluate(() => {
      class FakeRecognition { start(): void {} abort(): void {} }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
      window.fetch = async () => new Response(JSON.stringify({ settings: { ambientEnabled: false } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    await addAmbientScripts(page);
    await page.evaluate(async () => {
      const client = window.JarvisAmbient.mount({ mountTarget: '#mount' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      document.querySelector<HTMLElement>('#outside').focus();
      client.openSettings();
      const controls = [...client.ui.backdrop.querySelectorAll('button,input,select,textarea')]
        .filter((node) => !node.disabled && node.offsetParent !== null);
      controls.at(-1).focus();
    });

    await page.keyboard.press('Tab');
    await expect(page.locator('[data-ja-close]').first()).toBeFocused();
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('jarvis:speakers-opened')));
    const obscured = await page.locator('.jarvis-ambient__panel').evaluate((node) => ({
      inert: node.inert, hidden: node.getAttribute('aria-hidden'),
    }));
    expect(obscured).toEqual({ inert: true, hidden: 'true' });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('jarvis:speakers-closed')));
    await expect(page.getByRole('button', { name: 'Manage voices' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-ja-backdrop]')).toBeHidden();
    await expect(page.locator('#outside')).toBeFocused();
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the Jarvis rich-response route/speech/audio stubs verbatim out of tests/jarvis-rich-response-integration.spec.ts, which had grown to 1006 code lines (over the 1000-line cap) and now splits into four topic specs that all share these fixtures
 */

// DELIBERATELY NOT re-exported through tests/helpers/index.ts. This module reads eight Jarvis
// surface files at import time; putting it in the shared barrel would make every spec that
// imports './helpers' for an unrelated origin helper pay those reads and fail if the surface
// files move. The four jarvis-rich-response specs import this path directly.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Page, type Route } from '@playwright/test';

const ROOT = path.resolve(__dirname, '../..');
const HTML = readFileSync(path.join(ROOT, 'src/api/jarvis.html'), 'utf8');
const STAGE_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-stage.js'), 'utf8');
const STAGE_CSS = readFileSync(path.join(ROOT, 'src/api/jarvis-stage.css'), 'utf8');
const AMBIENT_CORE_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-ambient-core.js'), 'utf8');
const AMBIENT_UI_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-ambient-ui.js'), 'utf8');
const AMBIENT_RECOGNITION_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-ambient-recognition.js'), 'utf8');
const AMBIENT_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-ambient.js'), 'utf8');
const AMBIENT_CSS = readFileSync(path.join(ROOT, 'src/api/jarvis-ambient.css'), 'utf8');
const SPEAKER_CAPTURE_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-speaker-capture.js'), 'utf8');

/**
 * @description Inline SVG body served for every stubbed visual artifact. Kept as a literal so the
 * specs never depend on a real generated artifact on disk.
 */
export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" rx="36" fill="#101329"/><circle cx="250" cy="270" r="150" fill="#67c9ff"/><text x="455" y="290" fill="white" font-size="64">72° Today</text></svg>';
/**
 * @description Artifact id the stubbed /api/jarvis/ask/result answers reference. The surface only
 * trusts visual metadata whose URL is exactly the owner-scoped artifact URL for this id, so the
 * security specs mutate around this constant rather than inventing their own.
 */
export const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111';
/**
 * @description The one owner-scoped visual URL the Jarvis surface is allowed to render.
 */
export const ARTIFACT_URL = `/api/jarvis/visuals/${ARTIFACT_ID}`;

/**
 * @description Fulfill a route with a 200 JSON body. Extracted so each stub reads as routing rather
 * than as Playwright boilerplate.
 * @param route - The intercepted Playwright route.
 * @param body - Value serialized as the JSON response.
 * @returns Promise resolving once the route is fulfilled.
 */
export function json(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * @description The baseline Jarvis surface stub: serves the real jarvis.html plus its stage and
 * ambient scripts/styles off disk, so the specs exercise production code rather than a fake, and
 * answers every backing API with an empty-but-valid payload. Anything unrecognized 404s on purpose
 * — a spec that silently depends on an unstubbed endpoint should fail, not pass.
 * @param route - The intercepted Playwright route.
 * @returns Promise resolving once the route is fulfilled.
 */
export async function fulfillJarvis(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const pathName = url.pathname;
  if (pathName === '/api/jarvis/') return route.fulfill({ contentType: 'text/html', body: HTML });
  if (pathName.endsWith('/jarvis-stage.js')) return route.fulfill({ contentType: 'application/javascript', body: STAGE_JS });
  if (pathName.endsWith('/jarvis-stage.css')) return route.fulfill({ contentType: 'text/css', body: STAGE_CSS });
  if (pathName.endsWith('/jarvis-ambient-core.js')) return route.fulfill({ contentType: 'application/javascript', body: AMBIENT_CORE_JS });
  if (pathName.endsWith('/jarvis-ambient-ui.js')) return route.fulfill({ contentType: 'application/javascript', body: AMBIENT_UI_JS });
  if (pathName.endsWith('/jarvis-ambient-recognition.js')) return route.fulfill({ contentType: 'application/javascript', body: AMBIENT_RECOGNITION_JS });
  if (pathName.endsWith('/jarvis-ambient.js')) return route.fulfill({ contentType: 'application/javascript', body: AMBIENT_JS });
  if (pathName.endsWith('/jarvis-ambient.css')) return route.fulfill({ contentType: 'text/css', body: AMBIENT_CSS });
  if (pathName === ARTIFACT_URL) return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
  if (pathName === '/api/jarvis/ambient/settings') return json(route, { settings: {
    assistantName: 'Computer', wakePhrases: ['Hey Computer'], ambientEnabled: false,
    transcriptRetentionDays: 30, timeZone: 'America/Chicago', dailyReviewEnabled: true,
    dailyReviewTime: '21:00', suggestFollowUps: true,
  } });
  if (pathName === '/api/jarvis/ask' && route.request().method() === 'POST') return json(route, { jobId: 'job-1' });
  if (pathName === '/api/jarvis/ask/result') return json(route, {
    status: 'done', answer: 'Today is sunny with a high of 72 degrees.',
    visual: { artifactId: ARTIFACT_ID, type: 'image', kind: 'weather', url: ARTIFACT_URL, mimeType: 'image/svg+xml', alt: 'Sunny weather, 72 degrees', width: 960, height: 540 },
  });
  if (pathName === '/api/jarvis/overview') return json(route, { bots: [], comms: {}, activity: {}, calendar: {} });
  if (pathName === '/api/jarvis/tasks') return json(route, { tasks: [] });
  if (pathName === '/api/tickets') return json(route, { tickets: [] });
  if (pathName === '/api/user-model/suggestions') return json(route, { suggestions: [] });
  if (pathName === '/api/swarm/work-items') return json(route, { workItems: [] });
  if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'application/javascript', body: 'export default null;' });
  return route.fulfill({ status: 404, body: '' });
}

/**
 * @description Baseline stub with the answer replaced by a text-only reply, for proving the surface
 * keeps an inline result readable when no visual artifact exists.
 * @param route - The intercepted Playwright route.
 * @returns Promise resolving once the route is fulfilled.
 */
export async function fulfillTextOnlyJarvis(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/jarvis/ask/result') return json(route, {
    status: 'done', answer: 'Yes. I will keep the answer in the discussion without opening a visual.',
  });
  return fulfillJarvis(route);
}

/**
 * @description Install a deterministic speechSynthesis stub that starts in 5ms and ends in 550ms.
 * Real narration timing would make every assertion on the speaking/idle transition flaky.
 * @param page - The Playwright page to instrument before any surface script runs.
 * @returns Promise resolving once the init script is registered.
 */
export async function installSpeechStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeUtterance {
      text: string;
      onstart?: () => void;
      onend?: () => void;
      constructor(text: string) { this.text = text; }
    }
    const synth = {
      speaking: false, active: null as FakeUtterance | null, onvoiceschanged: null,
      getVoices: () => [], cancel() { this.active = null; this.speaking = false; },
      speak(utterance: FakeUtterance) {
        this.active = utterance; this.speaking = true;
        setTimeout(() => utterance.onstart?.(), 5);
        setTimeout(() => { this.speaking = false; this.active = null; utterance.onend?.(); }, 550);
      },
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: FakeUtterance });
  });
}

/**
 * @description Speech stub for the voice-preview race: it reports local voices, fires onerror on
 * cancel, and records every jarvis:speaking-start/end event, which is what makes a stale preview's
 * late completion observable.
 * @param page - The Playwright page to instrument before any surface script runs.
 * @returns Promise resolving once the init script is registered.
 */
export async function installPreviewRaceSpeechStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeUtterance {
      text: string;
      voice?: unknown;
      onstart?: () => void;
      onend?: () => void;
      onerror?: () => void;
      constructor(text: string) { this.text = text; }
    }
    const synth = {
      speaking: false,
      active: null as FakeUtterance | null,
      onvoiceschanged: null,
      getVoices: () => [
        { name: 'Local One', lang: 'en-US', localService: true },
        { name: 'Local Two', lang: 'en-US', localService: true },
      ],
      cancel() {
        const cancelled = this.active;
        this.active = null;
        this.speaking = false;
        if (cancelled) setTimeout(() => cancelled.onerror?.(), 30);
      },
      speak(utterance: FakeUtterance) {
        this.active = utterance;
        this.speaking = true;
        setTimeout(() => utterance.onstart?.(), 1);
        setTimeout(() => {
          if (this.active !== utterance) return;
          this.speaking = false;
          this.active = null;
          utterance.onend?.();
        }, 180);
      },
    };
    (window as any).__speakingEvents = [];
    document.addEventListener('jarvis:speaking-start', () => (window as any).__speakingEvents.push(true));
    document.addEventListener('jarvis:speaking-end', () => (window as any).__speakingEvents.push(false));
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: FakeUtterance });
  });
}

/**
 * @description Install fake getUserMedia/AudioContext/MediaRecorder plumbing that records every
 * stream, context, and recorder it hands out, so a spec can assert the microphone was actually
 * released rather than merely that the UI stopped showing it.
 * @param page - The Playwright page to instrument before any surface script runs.
 * @param clockStepMs - Milliseconds Date.now advances per analyser sample; a large value drives the
 * production no-voice timeout branch without making the test sleep for its real duration.
 * @returns Promise resolving once the init script is registered.
 */
export async function installNativeWakeAudioStub(page: Page, clockStepMs = 0): Promise<void> {
  await page.addInitScript((stepMs) => {
    const realNow = Date.now.bind(Date);
    const state: any = {
      streams: [], contexts: [], recorders: [], voice: true, clockOffset: 0, clockStepMs: stepMs,
    };
    Date.now = () => realNow() + state.clockOffset;
    Object.defineProperty(window, '__nativeWakeAudio', { configurable: true, value: state });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const stream: any = { active: true, tracks: [] };
          const track = { stopped: false, stop() { this.stopped = true; stream.active = false; } };
          stream.tracks = [track];
          stream.getTracks = () => stream.tracks;
          state.streams.push(stream);
          return stream;
        },
      },
    });
    class FakeAnalyser {
      fftSize = 128;
      frequencyBinCount = 64;
      getByteFrequencyData(values: Uint8Array): void { values.fill(0); }
      getByteTimeDomainData(values: Uint8Array): void {
        values.fill(state.voice ? 160 : 128);
        state.clockOffset += state.clockStepMs;
      }
    }
    class FakeAudioContext {
      state = 'running';
      analyser = new FakeAnalyser();
      constructor() { state.contexts.push(this); }
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() { return this.analyser; }
      close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }
    }
    class FakeRecorder extends EventTarget {
      static isTypeSupported(): boolean { return true; }
      state = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(public stream: any) { super(); state.recorders.push(this); }
      start(): void { this.state = 'recording'; }
      stop(): void {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        const data = new Blob([new Uint8Array(1600)], { type: this.mimeType });
        const dataEvent = new Event('dataavailable');
        Object.defineProperty(dataEvent, 'data', { value: data });
        this.dispatchEvent(dataEvent);
        this.ondataavailable?.({ data });
        this.onstop?.();
        this.dispatchEvent(new Event('stop'));
      }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeRecorder });
  }, clockStepMs);
}

/**
 * @description Baseline stub plus the native-wake surface: the speaker-capture script, ambient
 * settings with diarization toggled by ambientEnabled, an accepting audio ingest, and a canned
 * transcription.
 * @param route - The intercepted Playwright route.
 * @param ambientEnabled - Whether ambient listening (and speaker diarization) is reported as on.
 * @returns Promise resolving once the route is fulfilled.
 */
export async function fulfillNativeWake(route: Route, ambientEnabled: boolean): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('/jarvis-speaker-capture.js')) {
    return route.fulfill({ contentType: 'application/javascript', body: SPEAKER_CAPTURE_JS });
  }
  if (url.pathname === '/api/jarvis/ambient/settings') return json(route, { settings: {
    assistantName: 'Computer', wakePhrases: ['Hey Computer'], ambientEnabled,
    speakerDiarizationEnabled: ambientEnabled, rememberSpeakers: false,
  } });
  if (url.pathname === '/api/jarvis/ambient/audio') {
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
      accepted: 1, duplicates: 0, processing: { status: 'complete' }, segments: [],
    }) });
  }
  if (url.pathname === '/api/voice/transcribe') return json(route, { text: 'native wake command' });
  return fulfillJarvis(route);
}

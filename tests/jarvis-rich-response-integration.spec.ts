/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exercise the real Jarvis surface contract from image-backed answer through narration, archive, configurable identity, and rematerialization.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added a real-surface regression proving stale voice-preview completion cannot resume capture during a newer preview.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added production acceptance coverage for reduced motion, text zoom/reflow, keyboard Stop/Discussion use, modal focus trapping, and visual-text equivalence.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added phone-width reply wrapping, stable center-copy geometry, and hard-token visual-caption regressions.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added security coverage proving model-authored image links and untrusted visual metadata stay inert.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const HTML = readFileSync(path.join(ROOT, 'src/api/jarvis.html'), 'utf8');
const STAGE_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-stage.js'), 'utf8');
const STAGE_CSS = readFileSync(path.join(ROOT, 'src/api/jarvis-stage.css'), 'utf8');
const AMBIENT_CORE_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-ambient-core.js'), 'utf8');
const AMBIENT_UI_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-ambient-ui.js'), 'utf8');
const AMBIENT_RECOGNITION_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-ambient-recognition.js'), 'utf8');
const AMBIENT_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-ambient.js'), 'utf8');
const AMBIENT_CSS = readFileSync(path.join(ROOT, 'src/api/jarvis-ambient.css'), 'utf8');
const SPEAKER_CAPTURE_JS = readFileSync(path.join(ROOT, 'src/api/jarvis-speaker-capture.js'), 'utf8');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" rx="36" fill="#101329"/><circle cx="250" cy="270" r="150" fill="#67c9ff"/><text x="455" y="290" fill="white" font-size="64">72° Today</text></svg>';
const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111';
const ARTIFACT_URL = `/api/jarvis/visuals/${ARTIFACT_ID}`;

function json(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function fulfillJarvis(route: Route): Promise<void> {
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

async function fulfillTextOnlyJarvis(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/jarvis/ask/result') return json(route, {
    status: 'done', answer: 'Yes. I will keep the answer in the discussion without opening a visual.',
  });
  return fulfillJarvis(route);
}

async function installSpeechStub(page: Page): Promise<void> {
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

async function installPreviewRaceSpeechStub(page: Page): Promise<void> {
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

async function installNativeWakeAudioStub(page: Page, clockStepMs = 0): Promise<void> {
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

async function fulfillNativeWake(route: Route, ambientEnabled: boolean): Promise<void> {
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

test('keeps a supplied image visible after narration and replays it from the full result', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');

  await expect(page).toHaveTitle('Computer · OSHAL');
  await expect(page.locator('.eyebrow')).toHaveText('Computer Assistant');
  await expect(page.locator('.jarvis-ambient')).toBeVisible();
  await expect(page.locator('.canvas-wrap > #ambientMount .jarvis-ambient')).toHaveCount(1);
  await expect(page.locator('#orb')).toHaveAttribute('role', 'button');
  await expect(page.locator('#orb')).toHaveAttribute('tabindex', '0');
  await expect(page.locator('#orb')).toHaveAttribute('aria-label', 'Talk to Computer');
  await expect(page.locator('.main #convo')).toHaveCount(0);
  await expect(page.locator('#discussionDrawer #convo')).toHaveCount(1);

  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill("What's the weather today?");
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 6_000 });
  await expect(page.locator('#responseStageImage')).toHaveAttribute('alt', 'Sunny weather, 72 degrees');
  await expect(page.locator('#responseStageImage')).toHaveClass(/visible/);
  await expect(page.locator('body')).toHaveClass(/jarvis-response-active/);
  await expect(page.locator('#responseStageImage')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('#responseStageImage')).toHaveCSS('border-top-style', 'none');
  await expect(page.locator('body > .scroll')).toHaveCSS('opacity', '0');
  await expect(page.locator('body > .scroll')).toHaveAttribute('inert', '');
  await expect(page.locator('body > .scroll')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#responseStopBtn')).toBeVisible();
  await expect(page.locator('#responseDiscussionBtn')).toBeVisible();
  await expect(page.locator('#responseStopBtn')).toBeFocused();
  await page.waitForTimeout(800);
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking');
  await expect(page.locator('#responseStageImage')).toHaveClass(/visible/);
  await expect(page.locator('body')).toHaveClass(/jarvis-response-active/);
  await page.locator('#responseStopBtn').click();
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('body > .scroll')).toHaveCSS('opacity', '1');
  await expect(page.locator('body > .scroll')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#resultPanel')).toBeVisible();
  await expect(page.locator('#resultContent')).toContainText('Today is sunny with a high of 72 degrees.');

  await page.locator('#resultDiscussionBtn').click();
  await expect(page.locator('#discussionDrawer')).toHaveClass(/open/);
  await expect(page.locator('#convo')).toContainText('Today is sunny with a high of 72 degrees.');
  const savedVisual = page.locator('#discussionDrawer .discussion-visual-thumb');
  await expect(savedVisual).toHaveAttribute('src', ARTIFACT_URL);
  await expect(savedVisual).toHaveAttribute('alt', 'Sunny weather, 72 degrees');
  await expect(savedVisual).toHaveAttribute('loading', 'lazy');
  const externalPreview = await page.evaluate(() => (window as any).visualReplayHtml({
    type: 'image', url: 'https://example.test/not-owner-scoped.svg', alt: 'External visual',
  }));
  expect(externalPreview).toBe('');
  await page.getByRole('button', { name: 'Rematerialize visual' }).click();
  await expect(page.locator('#discussionDrawer')).not.toHaveClass(/open/);
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 6_000 });
});

test('opens an offered completed visual when the user says yes without starting another ask', async ({ page }) => {
  await installSpeechStub(page);
  let askPosts = 0;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/jarvis/tasks' && route.request().method() === 'GET') {
      return json(route, { tasks: [{
        id: 'offered-weather', title: 'Live weather in Destin', status: 'done',
        result: 'In Destin, it is sunny and 72 degrees.', error: null, kind: 'complex',
        ticketId: 'weather-ticket', delivered: false, createdAt: '2026-07-10T22:00:00.000Z',
        visual: {
          artifactId: ARTIFACT_ID, type: 'image', kind: 'weather', url: ARTIFACT_URL,
          mimeType: 'image/svg+xml', alt: 'Sunny weather, 72 degrees', width: 960, height: 540,
        },
      }] });
    }
    if (url.pathname === '/api/jarvis/tasks/offered-weather/delivered') return json(route, { ok: true });
    if (url.pathname === '/api/jarvis/ask' && route.request().method() === 'POST') {
      askPosts += 1;
      return json(route, { jobId: 'unexpected-ask' });
    }
    if (url.pathname === '/api/jarvis/ask/result') {
      return json(route, { status: 'done', answer: 'This fallback must not handle the acceptance.' });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');

  await expect(page.locator('[data-job-read="offered-weather"]')).toHaveCount(1);
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('yes');
  await page.locator('#typer button[type="submit"]').click();

  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 6_000 });
  await expect(page.locator('#responseStageImage')).toHaveAttribute('alt', 'Sunny weather, 72 degrees');
  await expect(page.locator('#responseStageImage')).toHaveClass(/visible/);
  await expect(page.locator('body')).toHaveClass(/jarvis-response-active/);
  await expect(page.locator('body > .scroll')).toHaveCSS('opacity', '0');
  await expect(page.locator('#resultContent [data-open-task="weather-ticket"]')).toHaveCount(1);
  await expect(page.locator('#discussionDrawer #convo [data-open-task="weather-ticket"]')).toHaveCount(1);
  expect(askPosts).toBe(0);
});

test('does not let a stale result offer capture a later yes after an unrelated turn', async ({ page }) => {
  await installSpeechStub(page);
  let askPosts = 0;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/jarvis/tasks' && route.request().method() === 'GET') {
      return json(route, { tasks: [{
        id: 'stale-weather', title: 'Older weather result', status: 'done',
        result: 'An older weather result.', error: null, kind: 'complex',
        ticketId: 'stale-ticket', delivered: false, createdAt: '2026-07-10T21:00:00.000Z',
        visual: {
          artifactId: ARTIFACT_ID, type: 'image', kind: 'weather', url: ARTIFACT_URL,
          mimeType: 'image/svg+xml', alt: 'Older weather visual', width: 960, height: 540,
        },
      }] });
    }
    if (url.pathname === '/api/jarvis/tasks/stale-weather/delivered') return json(route, { ok: true });
    if (url.pathname === '/api/jarvis/ask' && route.request().method() === 'POST') {
      askPosts += 1;
      return json(route, { jobId: `chat-${askPosts}` });
    }
    if (url.pathname === '/api/jarvis/ask/result') {
      return json(route, { status: 'done', answer: 'Handled as the current conversation.' });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');

  await expect(page.locator('[data-job-read="stale-weather"]')).toHaveCount(1);
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('What time is it?');
  await page.locator('#typer button[type="submit"]').click();
  await expect.poll(() => askPosts).toBe(1);
  await page.waitForTimeout(650);

  await page.locator('#typein').fill('yes');
  await page.locator('#typer button[type="submit"]').click();
  await expect.poll(() => askPosts).toBe(2);
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#responseStageImage')).not.toHaveClass(/visible/);
});

test('inspecting a completed task does not replace the active Jarvis chat session', async ({ page }) => {
  await installSpeechStub(page);
  const activeSession = 'jarvis-image-thread';
  await page.addInitScript((sessionId) => localStorage.setItem('jarvisSessionId', sessionId), activeSession);
  const postedSessions: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/jarvis/tasks' && route.request().method() === 'GET') {
      return json(route, { tasks: [{
        id: 'completed-task', title: 'Previous jobs research', status: 'done',
        result: 'The previous task result stays available without changing this conversation.',
        error: null, kind: 'complex', ticketId: 'jobs-ticket', delivered: true,
        createdAt: '2026-07-10T22:00:00.000Z',
      }] });
    }
    if (url.pathname === '/api/jarvis/ask' && route.request().method() === 'POST') {
      postedSessions.push(String((route.request().postDataJSON() as { sessionId?: string }).sessionId || ''));
      return json(route, { jobId: 'follow-up-job' });
    }
    if (url.pathname === '/api/jarvis/ask/result') {
      return json(route, { status: 'done', answer: 'This answer belongs to the original image thread.' });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');

  await expect(page.locator('[data-job="completed-task"]')).toBeVisible();
  await page.locator('[data-job="completed-task"]').click();
  await expect(page.locator('#resultContent')).toContainText('previous task result stays available');

  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('Show me images of Van Buren, Arkansas.');
  await page.locator('#typer button[type="submit"]').click();
  await expect.poll(() => postedSessions).toEqual([activeSession]);
});

test('uses the configurable name in the orb halo and exposes settings without a separate toolbar', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');

  const state = page.locator('.canvas-wrap .jarvis-ambient__state');
  await expect(state).toContainText('Always listening: OFF');
  await page.evaluate(() => (window as any).JarvisAmbient.getInstance().setState('armed'));
  await expect(state).toContainText('Computer is awake');
  await expect(page.locator('.canvas-wrap')).toHaveAttribute('data-ambient-state', 'armed');
  await expect(page.getByRole('button', { name: 'Ambient listening settings' })).toBeVisible();
});

test('keeps the orb halo, state label, and controls separated on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');

  const layout = await page.evaluate(() => {
    const state = document.querySelector('.jarvis-ambient__state')!.getBoundingClientRect();
    const status = document.getElementById('status')!.getBoundingClientRect();
    const settings = document.querySelector('.jarvis-ambient__settings-button')!.getBoundingClientRect();
    const chips = document.getElementById('chips')!.getBoundingClientRect();
    return {
      noStateOverlap: state.bottom <= status.top,
      settingsWidth: settings.width,
      settingsHeight: settings.height,
      chipsBottom: chips.bottom,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.noStateOverlap).toBe(true);
  expect(layout.settingsWidth).toBeGreaterThanOrEqual(44);
  expect(layout.settingsHeight).toBeGreaterThanOrEqual(44);
  expect(layout.chipsBottom).toBeLessThanOrEqual(844);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
});

test('wraps a complete mobile text reply without horizontal clipping', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await installSpeechStub(page);
  const hardToken = `mobile-wrap-${'W'.repeat(190)}`;
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/jarvis/ask/result') {
      return json(route, { status: 'done', answer: `Here is the compact reply ${hardToken}` });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await expect(page.locator('#chips .chip')).toHaveCount(3);
  await page.locator('#typeToggle').click();

  await page.locator('#typein').fill('Give me a compact mobile answer.');
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#resultContent')).toContainText(hardToken);

  const duringReply = await page.evaluate(() => {
    const result = document.getElementById('resultContent')!;
    const panel = document.getElementById('resultPanel')!.getBoundingClientRect();
    return {
      resultClientWidth: result.clientWidth,
      resultScrollWidth: result.scrollWidth,
      panelLeft: panel.left,
      panelRight: panel.right,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });

  expect(duringReply.resultScrollWidth).toBeLessThanOrEqual(duringReply.resultClientWidth);
  expect(duringReply.panelLeft).toBeGreaterThanOrEqual(0);
  expect(duringReply.panelRight).toBeLessThanOrEqual(duringReply.viewportWidth);
  expect(duringReply.documentWidth).toBeLessThanOrEqual(duringReply.viewportWidth);
});

test('renders the complete answer and Markdown table on the primary Jarvis surface', async ({ page }) => {
  await installSpeechStub(page);
  const tail = 'END-OF-FULL-JARVIS-RESULT';
  const answer = [
    `This is the complete result ${'with enough detail to exceed the old clipped preview. '.repeat(8)}`,
    '',
    '| Place | Result |',
    '|---|---|',
    '| Van Buren | Historic Main Street |',
    '| Fort Smith | Riverfront |',
    '',
    tail,
  ].join('\n');
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/jarvis/ask/result') {
      return json(route, { status: 'done', answer });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('Show me the complete result.');
  await page.locator('#typer button[type="submit"]').click();

  await expect(page.locator('#resultPanel')).toBeVisible();
  await expect(page.locator('#resultContent')).toContainText(tail);
  await expect(page.locator('#resultContent table.md')).toBeVisible();
  await expect(page.locator('#resultContent table.md tbody tr')).toHaveCount(2);
  await expect(page.locator('#resultContent')).toContainText('Historic Main Street');
  await expect(page.locator('#ai')).toHaveText('');
});

test('hard-wraps a generated visual caption inside a 320px response stage', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await installSpeechStub(page);
  const hardCaption = `Forecast-${'Z'.repeat(210)}`;
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/jarvis/ask/result') {
      return json(route, {
        status: 'done',
        answer: hardCaption,
        visual: {
          artifactId: ARTIFACT_ID, type: 'image', kind: 'weather', url: ARTIFACT_URL,
          mimeType: 'image/svg+xml', alt: 'Generated forecast visual', width: 960, height: 540,
        },
      });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('Show me the forecast.');
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 6_000 });

  const caption = await page.evaluate(() => {
    const element = document.getElementById('responseStageCaption')!;
    const bounds = element.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      left: bounds.left,
      right: bounds.right,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });

  expect(caption.scrollWidth).toBeLessThanOrEqual(caption.clientWidth);
  expect(caption.left).toBeGreaterThanOrEqual(0);
  expect(caption.right).toBeLessThanOrEqual(caption.viewportWidth);
  expect(caption.documentWidth).toBeLessThanOrEqual(caption.viewportWidth);
});

test('opens Discussion from the active visual plane and restores modal focus safely', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill("What's the weather today?");
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#responseDiscussionBtn')).toBeVisible({ timeout: 6_000 });
  await expect(page.locator('#responseStopBtn')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#responseDiscussionBtn')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#discussionDrawer')).toHaveClass(/open/);
  await expect(page.locator('#discussionDrawer')).toHaveAttribute('role', 'dialog');
  await expect(page.locator('#responseStage')).toHaveAttribute('inert', '');
  await expect(page.locator('#discussionClose')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Rematerialize visual' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#discussionClose')).toBeFocused();
  await page.locator('#discussionClose').click();
  await expect(page.locator('#discussionDrawer')).not.toHaveClass(/open/);
  await expect(page.locator('#responseDiscussionBtn')).toBeFocused();
});

test('lets keyboard users activate the orb', async ({ page }) => {
  await installSpeechStub(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')) },
    });
  });
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#orb').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#typer')).toHaveClass(/show/);
});

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

test('opens and closes ambient settings by keyboard while containing and restoring focus', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');

  const settings = page.getByRole('button', { name: 'Ambient listening settings' });
  await settings.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Always ready, on your terms' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.locator('footer')).toBeVisible();
  const focusedInsideDialog = await page.evaluate(() => Boolean(document.activeElement?.closest('.jarvis-ambient__panel')));
  expect(focusedInsideDialog).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
});

test('honors reduced motion and keeps Stop and Discussion immediately operable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.evaluate(() => (window as any).JarvisAmbient.getInstance().setState('armed'));

  const reducedStyles = await page.evaluate(() => {
    const halo = document.querySelector('.jarvis-ambient__bar')!;
    const image = document.getElementById('responseStageImage')!;
    return {
      mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
      haloAnimation: getComputedStyle(halo, '::before').animationName,
      imageTransitionSeconds: getComputedStyle(image).transitionDuration
        .split(',').map((value) => Number.parseFloat(value) || 0),
    };
  });
  expect(reducedStyles.mediaMatches).toBe(true);
  expect(reducedStyles.haloAnimation).toBe('none');
  expect(Math.max(...reducedStyles.imageTransitionSeconds)).toBeLessThanOrEqual(0.001);

  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill("What's the weather today?");
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 2_000 });
  await expect(page.locator('#responseStopBtn')).toBeVisible();
  await expect(page.locator('#responseDiscussionBtn')).toBeVisible();
  await expect(page.locator('#responseStopBtn')).toBeFocused();
});

test('keeps the authoritative text and saved image alt equivalent, and keyboard Stop restores the surface', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill("What's the weather today?");
  await page.locator('#typer button[type="submit"]').click();

  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 6_000 });
  const activeAlt = await page.locator('#responseStageImage').getAttribute('alt');
  expect(activeAlt).toBe('Sunny weather, 72 degrees');
  await expect(page.locator('#convo')).toContainText('Today is sunny with a high of 72 degrees.');
  for (const fact of ['sunny', '72']) {
    expect(activeAlt?.toLowerCase()).toContain(fact);
    expect((await page.locator('#convo').innerText()).toLowerCase()).toContain(fact);
  }

  await page.keyboard.press('Enter');
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('body')).not.toHaveClass(/jarvis-response-active/);
  await expect(page.locator('body > .scroll')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#responseStageActions')).toBeHidden();
  // Focus returns to the control that submitted the answer, not to the now-removed Stop action.
  await expect(page.locator('#typer button[type="submit"]')).toBeFocused();

  await page.locator('#discussionBtn').click();
  const savedImage = page.locator('#discussionDrawer .discussion-visual-thumb');
  await expect(savedImage).toHaveAttribute('alt', activeAlt || '');
  await expect(page.locator('#discussionDrawer')).toContainText('Today is sunny with a high of 72 degrees.');
});

test('reflows visual controls at 200% text size and a half-width viewport without clipping', async ({ page }) => {
  // A 640px layout viewport is the reflow pressure of a 1280px desktop viewed at 200%; the doubled
  // root font additionally exercises browser text-only zoom for labels and dialog content.
  await page.setViewportSize({ width: 640, height: 800 });
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill("What's the weather today?");
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 6_000 });

  const layout = await page.evaluate(() => {
    const stop = document.getElementById('responseStopBtn')!.getBoundingClientRect();
    const discussion = document.getElementById('responseDiscussionBtn')!.getBoundingClientRect();
    const image = document.getElementById('responseStageImage')!.getBoundingClientRect();
    return {
      stop: { left: stop.left, right: stop.right, top: stop.top, bottom: stop.bottom, width: stop.width, height: stop.height },
      discussion: { left: discussion.left, right: discussion.right, top: discussion.top, bottom: discussion.bottom, width: discussion.width, height: discussion.height },
      image: { left: image.left, right: image.right, top: image.top, bottom: image.bottom },
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  for (const control of [layout.stop, layout.discussion]) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(layout.viewport.width);
    expect(control.top).toBeGreaterThanOrEqual(0);
    expect(control.bottom).toBeLessThanOrEqual(layout.viewport.height);
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }
  expect(layout.stop.right).toBeLessThanOrEqual(layout.discussion.left);
  expect(layout.image.left).toBeGreaterThanOrEqual(0);
  expect(layout.image.right).toBeLessThanOrEqual(layout.viewport.width);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport.width);

  await page.locator('#responseDiscussionBtn').click();
  const drawer = page.locator('#discussionDrawer');
  await expect(drawer).toHaveClass(/open/);
  await expect.poll(async () => {
    const bounds = await drawer.boundingBox();
    return bounds ? {
      leftIsVisible: bounds.x >= 0,
      rightEdge: Math.round(bounds.x + bounds.width),
    } : null;
  }).toEqual({ leftIsVisible: true, rightEdge: 640 });
});

test('a stale cancelled voice preview cannot unsuppress capture during the next preview', async ({ page }) => {
  await installPreviewRaceSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');

  await page.locator('#voiceBtn').click();
  await page.locator('#voiceBtn').click();
  await page.waitForTimeout(80);
  const duringSecondPreview = await page.evaluate(() => (window as any).__speakingEvents as boolean[]);
  expect(duringSecondPreview.at(-1)).toBe(true);
  expect(duringSecondPreview.filter((value) => !value)).toHaveLength(1);

  await page.waitForTimeout(150);
  const completed = await page.evaluate(() => (window as any).__speakingEvents as boolean[]);
  expect(completed.at(-1)).toBe(false);
  expect(completed.filter((value) => !value)).toHaveLength(2);
});

test('keeps the complete inline result visible when an answer has no real visual artifact', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillTextOnlyJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');

  const alwaysListening = page.locator('#ambientMount .jarvis-ambient__bar');
  await expect(alwaysListening).toBeVisible();
  await expect(alwaysListening).toContainText('Always listening');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('Yes');
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#convo')).toContainText('without opening a visual');
  await expect(page.locator('#resultPanel')).toBeVisible();
  await expect(page.locator('#resultContent')).toContainText('without opening a visual');
  await expect(page.locator('body')).not.toHaveClass(/jarvis-response-active/);
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#responseStageImage')).not.toHaveAttribute('src', /.+/);
  await expect(page.locator('#ai')).toHaveText('', { timeout: 3_000 });
  await expect(page.locator('#you')).toHaveText('');
  await expect(page.locator('.bubble')).not.toHaveClass(/has-copy/);
});

test('claims a Markdown table is on screen only after a table visual materializes', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');

  const narration = await page.evaluate(() => {
    const markdown = [
      'The order task finished.',
      '| Item | Status |',
      '|---|---|',
      '| Ice cream | Ready |',
    ].join('\n');
    return {
      discussionOnly: (window as any).toSpeech(markdown),
      materializedTable: (window as any).toSpeech(markdown, 'table'),
    };
  });
  expect(narration.discussionOnly).toContain('the table is in Discussion');
  expect(narration.discussionOnly).not.toContain('the table is on screen');
  expect(narration.materializedTable).toContain('the table is on screen');
});

test('bridges only strict workspace Markdown files to the authenticated code surface', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  const ticketId = '08ad8960-2920-4761-9cf4-6d126b1119b7';
  const workspacePath = `/app/workspace-shared/${ticketId}/deliverables/order-options.md`;

  const hrefs = await page.evaluate(({ ticketId: id, workspacePath: pathName }) => {
    const markdown = [
      `[notes](${pathName})`,
      `[traversal](/app/workspace-shared/${id}/deliverables/../private.md)`,
      `[query](${pathName}?token=secret)`,
      '[protocol-relative](//attacker.example/file.md)',
      '[Uber Eats](https://www.ubereats.com/search?q=ice-cream)',
    ].join('\n');
    const host = document.createElement('div');
    host.innerHTML = (window as any).renderMarkdown(markdown);
    return [...host.querySelectorAll('a')].map((link) => link.getAttribute('href'));
  }, { ticketId, workspacePath });

  expect(hrefs).toEqual([
    `/code?file=${encodeURIComponent(workspacePath)}`,
    '#',
    '#',
    '#',
    'https://www.ubereats.com/search?q=ice-cream',
  ]);
});

test('keeps model-authored remote and data image Markdown inert without making hostile requests', async ({ page }) => {
  await installSpeechStub(page);
  const hostileRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'attacker.example') hostileRequests.push(request.url());
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'attacker.example') {
      return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
    }
    if (url.pathname === '/api/jarvis/ask/result') {
      return json(route, {
        status: 'done',
        answer: [
          'These model-authored image links must remain readable but inert.',
          '![remote beacon](https://attacker.example/pixel.svg?tenant=private)',
          '![inline data](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
        ].join('\n'),
      });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('Show the model-authored images.');
  await page.locator('#typer button[type="submit"]').click();

  const answer = page.locator('#convo .msg.bot').last();
  await expect(answer).toContainText('These model-authored image links');
  await expect(answer.locator('.md-image-note')).toHaveCount(2);
  await expect(answer.locator('.md-image-note').nth(0)).toHaveText('Image link not loaded: remote beacon');
  await expect(answer.locator('.md-image-note').nth(1)).toHaveText('Image link not loaded: inline data');
  await expect(answer.locator('img')).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(hostileRequests).toEqual([]);
  await expect(page.locator('body')).not.toHaveClass(/jarvis-response-active/);
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#responseStageImage')).not.toHaveClass(/visible/);
  await expect(page.locator('#responseStageImage')).not.toHaveAttribute('src', /.+/);
});

test('accepts an owner-scoped gallery SVG while keeping its model-authored remote image inert', async ({ page }) => {
  await installSpeechStub(page);
  const hostileRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'attacker.example') hostileRequests.push(request.url());
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'attacker.example') {
      return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
    }
    if (url.pathname === '/api/jarvis/ask/result') {
      return json(route, {
        status: 'done',
        answer: [
          'I found two live product options. The saved gallery is the trusted visual.',
          '![untrusted product beacon](https://attacker.example/product.svg?owner=private)',
        ].join('\n'),
        visual: {
          artifactId: ARTIFACT_ID,
          type: 'image',
          kind: 'gallery',
          url: ARTIFACT_URL,
          mimeType: 'image/svg+xml',
          alt: 'Two live product options with product photos, names, and prices',
          width: 1280,
          height: 720,
        },
      });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('Show me the product options.');
  await page.locator('#typer button[type="submit"]').click();

  const answer = page.locator('#convo .msg.bot').last();
  await expect(answer.locator('.md-image-note')).toHaveText('Image link not loaded: untrusted product beacon');
  await expect(answer.locator('img[src*="attacker.example"]')).toHaveCount(0);
  await expect(page.locator('#responseStageImage')).toHaveAttribute('src', ARTIFACT_URL, { timeout: 6_000 });
  await expect(page.locator('#responseStageImage')).toHaveAttribute(
    'alt',
    'Two live product options with product photos, names, and prices',
  );
  await expect(page.locator('#responseStageImage')).toHaveClass(/visible/);
  expect(hostileRequests).toEqual([]);

  const rejectedRemoteMetadata = await page.evaluate(({ artifactId }) => (window as any).trustedVisualMetadata({
    artifactId,
    type: 'image',
    kind: 'gallery',
    url: 'https://attacker.example/gallery.svg',
    mimeType: 'image/svg+xml',
    alt: 'Untrusted remote gallery',
    width: 1280,
    height: 720,
  }), { artifactId: ARTIFACT_ID });
  expect(rejectedRemoteMetadata).toBeNull();
});

test('ignores visual metadata whose URL is not the exact owner-scoped artifact URL', async ({ page }) => {
  await installSpeechStub(page);
  const attemptedImageRequests: string[] = [];
  const invalidVisuals: Array<{ label: string; overrides: Record<string, unknown> }> = [
    { label: 'cross-origin', overrides: { url: 'https://attacker.example/stolen.svg' } },
    { label: 'protocol-relative', overrides: { url: '//attacker.example/stolen.svg' } },
    { label: 'same-origin absolute', overrides: { url: `http://jarvis.test${ARTIFACT_URL}` } },
    { label: 'data URL', overrides: { url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } },
    { label: 'other root-relative', overrides: { url: '/uploads/untrusted.svg' } },
    { label: 'mismatched artifact', overrides: { url: '/api/jarvis/visuals/22222222-2222-4222-8222-222222222222' } },
    { label: 'query-suffixed', overrides: { url: `${ARTIFACT_URL}?token=private` } },
    { label: 'string dimensions', overrides: { width: '960' } },
    { label: 'fractional dimensions', overrides: { height: 539.5 } },
    { label: 'oversized alt', overrides: { alt: 'A'.repeat(421) } },
    { label: 'unknown kind', overrides: { kind: 'arbitrary-html' } },
    { label: 'wrong MIME', overrides: { mimeType: 'image/png' } },
  ];
  let resultCount = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.resourceType() === 'image'
      || url.hostname === 'attacker.example'
      || (url.pathname === ARTIFACT_URL && url.search)) {
      attemptedImageRequests.push(request.url());
    }
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'attacker.example') {
      return route.fulfill({ contentType: 'image/svg+xml', body: SVG });
    }
    if (url.pathname === '/api/jarvis/ask/result') {
      const invalid = invalidVisuals[resultCount++];
      return json(route, {
        status: 'done',
        answer: `Ignored ${invalid.label} visual metadata.`,
        visual: {
          artifactId: ARTIFACT_ID,
          type: 'image',
          kind: 'weather',
          url: ARTIFACT_URL,
          mimeType: 'image/svg+xml',
          alt: `${invalid.label} visual`,
          width: 960,
          height: 540,
          ...invalid.overrides,
        },
      });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();

  for (const invalid of invalidVisuals) {
    await page.locator('#typein').fill(`Try the ${invalid.label} visual.`);
    await page.locator('#typer button[type="submit"]').click();
    await expect(page.locator('#convo')).toContainText(`Ignored ${invalid.label} visual metadata.`);
    await expect(page.locator('body')).not.toHaveClass(/jarvis-response-active/);
    await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'idle');
    await expect(page.locator('#responseStageImage')).not.toHaveClass(/visible/);
    await expect(page.locator('#responseStageImage')).not.toHaveAttribute('src', /.+/);
    await expect(page.locator('#discussionDrawer .discussion-visual-thumb')).toHaveCount(0);
  }

  await page.waitForTimeout(100);
  expect(resultCount).toBe(invalidVisuals.length);
  expect(attemptedImageRequests).toEqual([]);
});

test('does not let an interrupted narration clear the newer inline result', async ({ page }) => {
  await installSpeechStub(page);
  let resultCount = 0;
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/jarvis/ask/result') {
      resultCount += 1;
      return json(route, {
        status: 'done',
        answer: resultCount === 1 ? 'First narration is still finishing.' : 'Second narration must remain visible.',
      });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('First');
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#resultContent')).toContainText('First narration');
  await page.locator('#typein').fill('Second');
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#resultContent')).toContainText('Second narration');
  await page.waitForTimeout(120);
  await expect(page.locator('#resultContent')).toContainText('Second narration');
  await page.waitForTimeout(600);
  await expect(page.locator('#resultContent')).toContainText('Second narration');
});

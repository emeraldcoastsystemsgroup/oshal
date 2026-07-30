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
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Split at the 1000-code-line cap: the shared route/speech/audio stubs moved to tests/helpers/jarvis-rich-response-fixtures.ts, and the responsive/a11y, native-wake, and visual-trust groups moved to sibling specs. This file keeps the visual replay, offer lifecycle, session, identity, and narration contract. Test bodies were moved verbatim.
 */

import { expect, test } from '@playwright/test';
import {
  ARTIFACT_ID,
  ARTIFACT_URL,
  fulfillJarvis,
  fulfillTextOnlyJarvis,
  installPreviewRaceSpeechStub,
  installSpeechStub,
  json,
} from './helpers/jarvis-rich-response-fixtures';

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

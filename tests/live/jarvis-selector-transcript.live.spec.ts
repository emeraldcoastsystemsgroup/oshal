/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live authenticated proof that Jarvis accepts a
 *                     |               | natural-language transcript and returns a route/result.
 */

/**
 * @description
 * Read-only live proof for the NL/Jarvis competitive gate. Attaches to the
 * operator's already-signed-in Chrome via CDP, sends a natural-language jobs
 * request, and verifies Jarvis returns a concrete result or background dispatch
 * without requiring a fresh login.
 */
import { test, expect } from './fixtures';
import { BASE_URL } from './helpers';

type JarvisAskStart = {
  status: number;
  payload: {
    jobId?: string;
    sessionId?: string;
    chatTicketId?: string;
    error?: string;
    message?: string;
  };
};

type JarvisAskResult = {
  status?: 'pending' | 'done' | 'error' | 'expired';
  label?: string;
  taskId?: string;
  answer?: string;
  routed?: Array<{ key?: string; name?: string; deepLink?: string }>;
  handoffs?: Array<{ key?: string; name?: string; deepLink?: string }>;
  dispatched?: Array<{ workJobId?: string; title?: string }>;
  error?: string;
};

test('Jarvis routes a natural-language career request and returns a result', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  await page.goto(`${BASE_URL}/api/jarvis/`, { waitUntil: 'domcontentloaded' });

  const start = await page.evaluate(async () => {
    const res = await fetch('/api/jarvis/ask', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: `jarvis-live-proof-${Date.now()}`,
        message: [
          'I need a job. Use the career/job capability to help me find remote AI architect roles.',
          'Read-only only: do not apply, send messages, or change anything.',
          'If this needs background work, hand it off and acknowledge the task.',
        ].join(' '),
      }),
    });
    const payload = await res.json().catch(async () => ({ raw: await res.text() }));
    return { status: res.status, payload };
  }) as JarvisAskStart;

  expect(start.status, JSON.stringify(start.payload)).toBe(202);
  expect(start.payload.jobId).toBeTruthy();

  let result: JarvisAskResult = { status: 'pending' };
  for (let i = 0; i < 70; i += 1) {
    await page.waitForTimeout(1500);
    result = await page.evaluate(async (jobId) => {
      const res = await fetch(`/api/jarvis/ask/result?jobId=${encodeURIComponent(jobId)}`, {
        credentials: 'same-origin',
      });
      return await res.json();
    }, start.payload.jobId || '') as JarvisAskResult;
    if (result.status !== 'pending') break;
  }

  expect(result.status, JSON.stringify(result)).toBe('done');
  const routedNames = [
    ...(result.routed || []).map((item) => `${item.key || ''} ${item.name || ''}`),
    ...(result.handoffs || []).map((item) => `${item.key || ''} ${item.name || ''}`),
    ...(result.dispatched || []).map((item) => `${item.title || ''}`),
  ].join(' ');
  const answer = String(result.answer || '');
  expect(`${answer} ${routedNames}`).toMatch(/job|career|architect|background|hand/i);

  await testInfo.attach('jarvis-selector-transcript.json', {
    body: JSON.stringify({ start: start.payload, result }, null, 2),
    contentType: 'application/json',
  });
});

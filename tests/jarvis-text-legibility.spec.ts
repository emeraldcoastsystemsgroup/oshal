/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the "bare minimum: the
 *            | text is visible" floor — the transcribed user line must WRAP (never clip to one line
 *            | with an ellipsis) and must never force the surface to scroll horizontally.
 */

import { expect, test } from '@playwright/test';

const BASE = `http://localhost:${process.env.PLAYWRIGHT_PORT ?? '4458'}`;

// A realistic long dictation plus one very long unbroken token (the classic horizontal-overflow trap).
const LONG_YOU = 'Please look up the current weather in Destin Florida and then also summarize my '
  + 'most important unread emails and tell me what my top job opportunities are this morning '
  + 'supercalifragilisticexpialidociousantidisestablishmentarianismpneumonoultramicroscopicsilicovolcanoconiosis';
const LONG_AI = 'Here is a fairly long answer that should remain completely visible on the surface '
  + 'without being clipped by an ellipsis, and without introducing any left/right horizontal scroll '
  + 'no-matter-how-long-this-single-token-gets-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.';

test.describe('Jarvis text legibility', () => {
  test('the transcribed user line wraps (no one-line ellipsis) and does not scroll sideways', async ({ page }) => {
    await page.goto(`${BASE}/api/jarvis/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#you').waitFor({ state: 'attached', timeout: 15_000 });

    const m = await page.evaluate(({ you, ai }) => {
      const youEl = document.getElementById('you') as HTMLElement;
      const aiEl = document.getElementById('ai') as HTMLElement;
      document.querySelector('.bubble')?.classList.add('has-copy');
      youEl.innerHTML = '<b>You:</b> ' + you;
      aiEl.textContent = ai;
      const cs = getComputedStyle(youEl);
      return {
        whiteSpace: cs.whiteSpace,
        textOverflow: cs.textOverflow,
        youScrollWidth: youEl.scrollWidth,
        youClientWidth: youEl.clientWidth,
        aiScrollWidth: aiEl.scrollWidth,
        aiClientWidth: aiEl.clientWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    }, { you: LONG_YOU, ai: LONG_AI });

    // Bug A: the user line must not be clipped to a single line with an ellipsis.
    expect(m.whiteSpace, 'transcribed line must wrap, not nowrap').not.toBe('nowrap');
    expect(m.youScrollWidth, 'transcribed line must not overflow its own box').toBeLessThanOrEqual(m.youClientWidth + 2);
    // The answer stays fully wrapped too.
    expect(m.aiScrollWidth).toBeLessThanOrEqual(m.aiClientWidth + 2);
    // Bug B: no horizontal scroll of the whole surface, even with a long unbroken token.
    expect(m.docScrollWidth, 'surface must not scroll horizontally').toBeLessThanOrEqual(m.innerWidth + 1);
  });

  test('holds on a narrow phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`${BASE}/api/jarvis/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#you').waitFor({ state: 'attached', timeout: 15_000 });

    const m = await page.evaluate(({ you, ai }) => {
      const youEl = document.getElementById('you') as HTMLElement;
      document.querySelector('.bubble')?.classList.add('has-copy');
      youEl.innerHTML = '<b>You:</b> ' + you;
      (document.getElementById('ai') as HTMLElement).textContent = ai;
      return {
        whiteSpace: getComputedStyle(youEl).whiteSpace,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    }, { you: LONG_YOU, ai: LONG_AI });

    expect(m.whiteSpace).not.toBe('nowrap');
    expect(m.docScrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
  });
});

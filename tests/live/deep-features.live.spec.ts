/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Deep run: open every feature, assert it
 *                     |               | renders REAL content (catch blank surfaces),
 *                     |               | and make concierge apps answer a real query.
 */

/**
 * @description
 * The DEEP pass — goes beyond "does the surface open without an error string."
 * For every cockpit feature it asserts the surface actually rendered meaningful
 * content (catching blank/broken iframes the text-only smoke missed, e.g. a dead
 * Optimizer). For the concierge/query apps it then types a real question and
 * proves the app answers with real data. Read-only (questions, list loads) — no
 * sends/buys/books.
 */
import { test, expect } from './fixtures';
import { openCockpit, listRibbonTools, openTool } from './helpers';

/** Concierge/query surfaces worth a real interaction (the rest get a content check). */
const DEEP_INTERACT = new Set([
  'tool-jarvis-home',
  'tool-travel-concierge',
  'tool-email-inbox',
  'tool-finance-home',
  'tool-feeds-dashboard',
  'tool-world-dashboard',
  'tool-security-center-home',
]);

const QUERY =
  'Using my real connected data, show me one concrete example of what you can do right now.';

/** Below this many characters of rendered text, a surface is effectively blank. */
const BLANK_THRESHOLD = 40;

type Result = {
  label: string;
  id: string;
  contentLen: number;
  blank: boolean;
  interacted: boolean;
  responded: boolean | null;
  error?: string;
};

test('deep: every feature renders real content; concierges answer a real query', async ({
  page,
}, testInfo) => {
  test.setTimeout(900_000); // up to ~12 concierge round-trips on a live LLM path

  await openCockpit(page);
  const tools = await listRibbonTools(page);
  expect(tools.length, 'ribbon should expose features').toBeGreaterThan(0);

  const results: Result[] = [];

  for (const tool of tools) {
    await test.step(`deep: ${tool.label} (${tool.id})`, async () => {
      const r: Result = {
        label: tool.label,
        id: tool.id,
        contentLen: 0,
        blank: false,
        interacted: false,
        responded: null,
      };
      try {
        const frame = await openTool(page, tool.id);
        const body = () =>
          (frame ? frame.locator('body') : page.locator('body')).innerText().catch(() => '');

        const before = (await body()).trim();
        r.contentLen = before.length;
        r.blank = r.contentLen < BLANK_THRESHOLD;

        if (DEEP_INTERACT.has(tool.id)) {
          const box = (frame ?? page).getByRole('textbox').first();
          if (await box.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await box.fill(QUERY);
            await box.press('Enter');
            r.interacted = true;
            // Real answer = the surface text grows meaningfully (a response bubble).
            try {
              await expect
                .poll(async () => (await body()).length, {
                  timeout: 45_000,
                  intervals: [2_000, 3_000, 5_000],
                })
                .toBeGreaterThan(r.contentLen + 80);
              r.responded = true;
            } catch {
              r.responded = false;
            }
          }
        }

        await testInfo.attach(tool.label, {
          body: await page.screenshot({ fullPage: false }),
          contentType: 'image/png',
        });
      } catch (err) {
        r.error = String(err).split('\n')[0];
      }

      results.push(r);
      expect.soft(r.blank, `${tool.label} surface rendered blank (${r.contentLen} chars)`).toBeFalsy();
      if (r.interacted) {
        expect.soft(r.responded, `${tool.label} did not answer a real query`).toBeTruthy();
      }
    });
  }

  // eslint-disable-next-line no-console
  console.table(
    results.map((r) => ({
      feature: r.label,
      chars: r.contentLen,
      blank: r.blank ? 'BLANK' : '',
      queried: r.interacted ? (r.responded ? 'answered' : 'NO ANSWER') : '',
      error: r.error ?? '',
    })),
  );
  const blanks = results.filter((r) => r.blank).map((r) => r.label);
  const noAnswer = results.filter((r) => r.interacted && !r.responded).map((r) => r.label);
  const errored = results.filter((r) => r.error).map((r) => r.label);
  // eslint-disable-next-line no-console
  console.log(`[deep] blank surfaces: ${blanks.join(', ') || 'none'}`);
  // eslint-disable-next-line no-console
  console.log(`[deep] concierges with no answer: ${noAnswer.join(', ') || 'none'}`);
  // eslint-disable-next-line no-console
  console.log(`[deep] threw on open: ${errored.join(', ') || 'none'}`);
});

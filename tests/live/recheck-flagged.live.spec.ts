/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Patient recheck of flagged surfaces for a
 *                     |               | heavily-loaded host: screenshot every 3s for
 *                     |               | up to 30s until a definitive good/not-good.
 */

/**
 * @description
 * The host is under heavy load (builds + dozens of agents + this run), so a
 * single tight wait produces false "blank"/"no answer". This spec re-checks only
 * the previously-flagged surfaces, PATIENTLY: it polls every 3 seconds for up to
 * 30 seconds, attaching a screenshot each tick, and only declares NOT-GOOD after
 * the full window. Light on the machine (a handful of features, not all 41).
 */
import { test, expect } from './fixtures';
import { openCockpit, openTool } from './helpers';

const QUERY =
  'Using my real connected data, show me one concrete example of what you can do right now.';

/** A content surface is good once it renders this many chars; a concierge is good once it grows. */
const MIN_CONTENT_CHARS = 60;
const RESPONSE_GROWTH = 80;
const TICK_MS = 3_000;
const TICKS = 10; // 3s * 10 = 30s

type RecheckSurface = {
  id: string;
  label: string;
  kind: 'content' | 'concierge';
  inputSelector?: string;
  submitSelector?: string;
};

const RECHECK: RecheckSurface[] = [
  { id: 'tool-career-insights', label: 'Insights', kind: 'content' },
  { id: 'tool-career-settings', label: 'Career Settings', kind: 'content' },
];

test('patient recheck of flagged surfaces (screenshot every 3s up to 30s)', async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  await openCockpit(page);

  const verdicts: Array<{ label: string; good: boolean; chars: number; tookS: number }> = [];

  for (const item of RECHECK) {
    await test.step(`recheck: ${item.label}`, async () => {
      let frame;
      try {
        frame = await openTool(page, item.id);
      } catch (err) {
        verdicts.push({ label: item.label, good: false, chars: 0, tookS: 0 });
        expect.soft(false, `${item.label} would not open: ${String(err).split('\n')[0]}`).toBeTruthy();
        return;
      }
      const body = () =>
        (frame ? frame.locator('body') : page.locator('body')).innerText().catch(() => '');

      let baseline = 0;
      let asked = false;
      if (item.kind === 'concierge') {
        const root = frame ?? page;
        const box = item.inputSelector
          ? root.locator(item.inputSelector)
          : root.getByRole('textbox').first();
        if (await box.isVisible({ timeout: 10_000 }).catch(() => false)) {
          baseline = (await body()).length;
          await box.fill(QUERY);
          if (item.submitSelector) {
            await root.locator(item.submitSelector).click();
          } else {
            await box.press('Enter');
          }
          asked = true;
        }
      }

      let good = false;
      let chars = 0;
      let tick = 0;
      for (tick = 1; tick <= TICKS; tick++) {
        const txt = (await body()).trim();
        chars = txt.length;
        good =
          item.kind === 'concierge'
            ? asked && chars > baseline + RESPONSE_GROWTH
            : chars >= MIN_CONTENT_CHARS;
        await testInfo.attach(`${item.label} t+${tick * 3}s ${good ? 'GOOD' : 'waiting'}`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
        if (good) break;
        await page.waitForTimeout(TICK_MS);
      }

      verdicts.push({ label: item.label, good, chars, tookS: tick * 3 });
      // eslint-disable-next-line no-console
      console.log(
        `[recheck] ${item.label}: ${good ? 'GOOD' : 'NOT GOOD'} (${chars} chars after up to 30s)`,
      );
      expect.soft(good, `${item.label} did not validate within 30s (${chars} chars)`).toBeTruthy();
    });
  }

  // eslint-disable-next-line no-console
  console.table(verdicts);
});

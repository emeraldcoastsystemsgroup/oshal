/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Headed smoke: open every cockpit feature on
 *                     |               | real data and report which surfaces load.
 */

/**
 * @description
 * Data-driven smoke over the REAL cockpit. Reads the ribbon from the live DOM
 * (so it always covers exactly the features your profile ships), clicks each
 * tool, and records whether its surface loaded without error. Read-only — it
 * navigates and observes, it never sends/buys/books.
 *
 * Each tool is its own test.step, so the HTML report shows a per-feature
 * pass/fail grid with a screenshot for each.
 */
import { test, expect } from './fixtures';
import { openCockpit, listRibbonTools, openTool, hasSurfaceError } from './helpers';

test('every cockpit feature opens on real data', async ({ page }, testInfo) => {
  await openCockpit(page);

  const tools = await listRibbonTools(page);
  expect(tools.length, 'ribbon should expose features').toBeGreaterThan(0);
  // eslint-disable-next-line no-console
  console.log(`[smoke] ${tools.length} features to open:`, tools.map((t) => t.label).join(', '));

  const broken: string[] = [];

  for (const tool of tools) {
    await test.step(`open: ${tool.label} (${tool.id})`, async () => {
      try {
        await openTool(page, tool.id);
        const errored = await hasSurfaceError(page);
        const shot = await page.screenshot();
        await testInfo.attach(`${tool.label}`, { body: shot, contentType: 'image/png' });
        // Soft assertion: keep sweeping even if one feature fails.
        expect.soft(errored, `${tool.label} surfaced an error`).toBeFalsy();
        if (errored) broken.push(tool.label);
      } catch (err) {
        broken.push(`${tool.label} (${String(err).split('\n')[0]})`);
        expect.soft(false, `${tool.label} threw: ${String(err).split('\n')[0]}`).toBeTruthy();
      }
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    broken.length
      ? `[smoke] features needing attention (${broken.length}/${tools.length}): ${broken.join(' | ')}`
      : `[smoke] all ${tools.length} features opened cleanly`,
  );
});

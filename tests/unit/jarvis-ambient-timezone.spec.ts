/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the real ambient settings form in Chromium: render the saved zone, edit it, and carry it into the API settings payload without enabling capture.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

it('lets an owner correct an existing UTC review zone from the rendered settings form', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main id="ambient"></main>');
    for (const script of ['jarvis-ambient-core.js', 'jarvis-ambient-ui.js']) {
      await page.addScriptTag({ content: readFileSync(resolve('src/api', script), 'utf8') });
    }
    await page.evaluate(() => {
      const root = window as any;
      const element = document.querySelector('#ambient')!;
      element.innerHTML = root.JarvisAmbientUi.htmlTemplate();
      element.querySelector('[data-ja-backdrop]')!.removeAttribute('hidden');
      const form = element.querySelector('form');
      root.ambientFixture = {
        settings: root.JarvisAmbientCore.normalizeSettings({ timeZone: 'UTC', dailyReviewEnabled: true }),
        ui: { form, enabled: form!.elements.namedItem('enabled') },
        supported: false,
        renderLimitation() {}, updateSyncCopy() {},
      };
      root.JarvisAmbientUi.clientMethods.renderSettings.call(root.ambientFixture);
    });
    expect(await page.getByLabel('Review time zone', { exact: true }).inputValue()).toBe('UTC');
    await page.getByLabel('Review time zone', { exact: true }).fill('America/Chicago');
    const payload = await page.evaluate(() => {
      const root = window as any;
      const next = root.JarvisAmbientUi.clientMethods.settingsFromForm.call(root.ambientFixture);
      return root.JarvisAmbientCore.settingsForApi(next);
    });
    expect(payload).toMatchObject({ timeZone: 'America/Chicago', dailyReviewTime: '21:00', dailyReviewEnabled: true, ambientEnabled: false });
    await page.evaluate((saved) => {
      const root = window as any;
      root.ambientFixture.settings = root.JarvisAmbientCore.normalizeSettings(saved);
      root.JarvisAmbientUi.clientMethods.renderSettings.call(root.ambientFixture);
    }, payload);
    expect(await page.getByLabel('Review time zone', { exact: true }).inputValue()).toBe('America/Chicago');
  } finally { await browser.close(); }
}, 30_000);

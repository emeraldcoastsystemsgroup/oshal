/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression: ?app= must not poison plain /cockpit/ via localStorage cache
 */

import { test, expect } from '@playwright/test';

test.describe('Cockpit — URL ?app= is the single source of truth', () => {
  test('plain /cockpit/ shows framework ribbon (Tickets), even after a previous ?app=eats visit cached the profile name', async ({ page }) => {
    // First visit: poison localStorage by simulating an old build's behavior.
    // We can't rely on the URL alone setting it (we just removed that code),
    // so set the legacy key directly to reproduce the historical state.
    await page.goto('/cockpit/');
    await page.evaluate(() => {
      window.localStorage.setItem('oshal-ui-profile', 'eats');
    });

    // Now reload plain /cockpit/. With the fix in place, the cockpit must
    // ignore the cached 'eats' value and render the framework
    // ribbon (Tickets default), not the LM ribbon (Student Dashboard etc).
    await page.reload();
    await page.waitForTimeout(800);

    // The Tickets ribbon button must exist and the LM ribbon entries must NOT.
    await expect(page.locator('.ribbon-btn[data-view="tickets"]')).toBeVisible();
    await expect(page.locator('[data-view="tool-lm-dashboard"]')).toHaveCount(0);
    await expect(page.locator('[data-view="tool-lm-recorder"]')).toHaveCount(0);
    await expect(page.locator('[data-view="tool-lm-tutor"]')).toHaveCount(0);

    // The localStorage key must have been cleared by the new resolve logic.
    const stored = await page.evaluate(() => window.localStorage.getItem('oshal-ui-profile'));
    expect(stored).toBeNull();
  });

  test('URL ?app=eats still loads the LM profile (when explicitly requested)', async ({ page }) => {
    await page.goto('/cockpit/?app=eats');
    await page.waitForTimeout(800);
    // LM profile should be in effect — the LM dashboard tool button is the
    // strongest signal. (LM is `inactive` in the manifest but the API still
    // serves the profile, which is fine — explicit URL = explicit choice.)
    const lmDashboard = page.locator('[data-view="tool-lm-dashboard"]');
    await expect(lmDashboard).toBeVisible();
  });
});

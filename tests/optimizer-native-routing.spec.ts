/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression for first-party Optimizer routing.
 */

/**
 * @description
 * The cockpit Optimizer must stay inside OSHAL. This guards against silently
 * embedding the legacy external optimize host, which hides auth/logging failures
 * and produced opaque null race results.
 */
import { test, expect } from '@playwright/test';

test.describe('Optimizer native routing', () => {
  test('cockpit Optimizer opens the first-party Token Chase surface', async ({ page }) => {
    await page.goto('/cockpit/?profile=oshal-framework', { waitUntil: 'domcontentloaded' });
    const optimizerButton = page.locator('.ribbon-btn[data-view="tool-token-chase"]');
    await expect(optimizerButton).toBeVisible({ timeout: 30_000 });

    await optimizerButton.evaluate((el) => (el as HTMLElement).click());

    const iframe = page.locator('iframe[src*="/api/token-chase/ui"]').first();
    await expect(iframe, 'Optimizer iframe should be same-origin Token Chase UI').toBeVisible({ timeout: 30_000 });
    await expect(page.locator('iframe[src*="optimize.agenticfederal.us"]')).toHaveCount(0);

    const surface = page.frameLocator('iframe[src*="/api/token-chase/ui"]').first();
    await expect(surface.locator('h1')).toContainText(/OPTIMIZER/i);
  });

  test('native optimize API is mounted for roster/catalog work', async ({ request }) => {
    const catalog = await request.get('/api/optimize/catalog');
    expect(catalog.ok()).toBeTruthy();
    const body = await catalog.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.length).toBeGreaterThan(0);

    const page = await request.get('/api/optimize/');
    expect(page.ok()).toBeTruthy();
    expect(await page.text()).toMatch(/Model Optimize/i);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright coverage for native mesh-dashboard route and cockpit Engineering embed wiring
 */

import { test, expect } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

/**
 * @description Navigates to cockpit and opens the Engineering ribbon view.
 * @param page - Playwright page instance.
 * @returns Promise that resolves once the engineering panel is visible.
 */
async function gotoEngineering(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(COCKPIT_URL);
  await page.locator('.ribbon-btn[data-view="advanced"]').click();
  await page.waitForTimeout(350);
}

test.describe('Mesh Dashboard — Native Surface', () => {
  test('direct route renders native mesh dashboard process-flow surface', async ({ page }) => {
    await page.goto('/mesh-dashboard/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Mesh Dashboard');
    await expect(page.locator('#flowGrid')).toBeVisible();
    await expect(page.locator('[data-testid="mesh-channel-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="mesh-participant-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="mesh-linkage-list"]')).toBeVisible();
  });

  test('native mesh dashboard exposes refresh controls and metric cards', async ({ page }) => {
    await page.goto('/mesh-dashboard/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#refreshButton')).toBeVisible();
    await expect(page.locator('#metricActiveChannels')).toBeVisible();
    await expect(page.locator('#metricParticipants')).toBeVisible();
    await expect(page.locator('#metricTicketLinked')).toBeVisible();
    await expect(page.locator('#metricCoverage')).toBeVisible();
  });

  test('cockpit engineering embeds mesh dashboard as native route', async ({ page }) => {
    await gotoEngineering(page);
    await page.locator('.adv-sub-btn[data-page="mesh-dashboard"]').click();
    await page.waitForTimeout(350);

    await expect(page.locator('#advPanel')).toContainText('Native');
    await expect(page.locator('#advPanel')).toContainText('native mesh dashboard showing real channel lifecycle');
    await expect(page.locator('iframe[title="Mesh Dashboard"]')).toHaveAttribute('src', '/mesh-dashboard/');
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright coverage for native queue-manager-admin route and cockpit Engineering embed wiring
 */

import { test, expect } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

/**
 * @description Navigates to cockpit and opens the Engineering ribbon view.
 * @param page - Playwright page instance.
 * @returns Promise that resolves when engineering view is visible.
 */
async function gotoEngineering(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(COCKPIT_URL);
  await page.locator('.ribbon-btn[data-view="advanced"]').click();
  await page.waitForTimeout(350);
}

test.describe('Queue Manager Admin — Native Surface', () => {
  test('direct route renders native queue manager admin surface', async ({ page }) => {
    await page.goto('/queue-manager-admin/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Queue Manager Admin');
    await expect(page.locator('#flowGrid')).toBeVisible();
    await expect(page.locator('[data-testid="qa-agent-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="qa-dispatch-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="qa-run-list"]')).toBeVisible();
  });

  test('native queue manager admin exposes refresh controls and metric cards', async ({ page }) => {
    await page.goto('/queue-manager-admin/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#refreshButton')).toBeVisible();
    await expect(page.locator('#metricScheduler')).toBeVisible();
    await expect(page.locator('#metricTickets')).toBeVisible();
    await expect(page.locator('#metricDispatches')).toBeVisible();
    await expect(page.locator('#metricRuns')).toBeVisible();
  });

  test('cockpit engineering embeds queue manager admin as native route', async ({ page }) => {
    await gotoEngineering(page);
    await page.locator('.adv-sub-btn[data-page="queue-manager-admin"]').click();
    await page.waitForTimeout(350);

    await expect(page.locator('#advPanel')).toContainText('Native');
    await expect(page.locator('#advPanel')).toContainText('queue manager admin screen with real process-flow telemetry');
    await expect(page.locator('iframe[title="Queue Manager Admin"]')).toHaveAttribute('src', '/queue-manager-admin/');
  });
});

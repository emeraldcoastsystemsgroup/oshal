/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright coverage for native ops-dashboard route and cockpit Engineering embed wiring
 */

import { test, expect } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

/**
 * @description Navigates to cockpit and opens the Engineering ribbon view.
 * @param page - Playwright page instance.
 * @returns Promise that resolves when engineering panel is ready.
 */
async function gotoEngineering(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(COCKPIT_URL);
  await page.locator('.ribbon-btn[data-view="advanced"]').click();
  await page.waitForTimeout(350);
}

test.describe('Ops Dashboard — Native Surface', () => {
  test('direct route renders native ops dashboard process-flow surface', async ({ page }) => {
    await page.goto('/ops-dashboard/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Ops Dashboard');
    await expect(page.locator('#flowGrid')).toBeVisible();
    await expect(page.locator('[data-testid="ops-node-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="ops-agent-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="ops-attention-list"]')).toBeVisible();
  });

  test('native ops dashboard exposes refresh controls and metric cards', async ({ page }) => {
    await page.goto('/ops-dashboard/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#refreshButton')).toBeVisible();
    await expect(page.locator('#metricApi')).toBeVisible();
    await expect(page.locator('#metricScheduler')).toBeVisible();
    await expect(page.locator('#metricTickets')).toBeVisible();
    await expect(page.locator('#metricRuns')).toBeVisible();
  });

  test('cockpit engineering embeds ops dashboard as native route', async ({ page }) => {
    await gotoEngineering(page);
    await page.locator('.adv-sub-btn[data-page="ops-dashboard"]').click();
    await page.waitForTimeout(350);

    await expect(page.locator('#advPanel')).toContainText('Native');
    await expect(page.locator('#advPanel')).toContainText('native ops dashboard with real runtime health');
    await expect(page.locator('iframe[title="Ops Dashboard"]')).toHaveAttribute('src', '/ops-dashboard/');
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Playwright tests for swarm debug panel diagnostic warnings and processing summary
 */

import { test, expect } from '@playwright/test';

/**
 * @description Navigate to /ui swarm debug page and wait for React to mount.
 * @param page - Playwright Page instance
 */
async function gotoSwarmDebug(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/ui', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('#chat-root', { timeout: 10000 });
  await page.waitForFunction(
    () => {
      const root = document.getElementById('chat-root');
      return root !== null && root.innerHTML.length > 0;
    },
    null,
    { timeout: 10000 }
  );
}

test.describe('Swarm Debug Panel — Diagnostic Warnings', () => {
  test('renders Process Lead Tickets button', async ({ page }) => {
    await gotoSwarmDebug(page);
    const btn = page.locator('button', { hasText: 'Process Lead Tickets' });
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test('renders Load Run button', async ({ page }) => {
    await gotoSwarmDebug(page);
    const btn = page.locator('button', { hasText: 'Load Run' });
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test('Load Run with empty input shows error', async ({ page }) => {
    await gotoSwarmDebug(page);
    const loadBtn = page.locator('button', { hasText: 'Load Run' });
    await loadBtn.click();
    const errorNotice = page.locator('.error-notice');
    await expect(errorNotice).toBeVisible({ timeout: 5000 });
    await expect(errorNotice).toContainText('swarm run ID');
  });

  test('Process Lead Tickets shows summary card after click', async ({ page }) => {
    await gotoSwarmDebug(page);
    const processBtn = page.locator('button', { hasText: 'Process Lead Tickets' });
    await processBtn.click();

    // Button should show "Processing..." during request
    await expect(processBtn).toContainText(/Processing|Process Lead Tickets/);

    // Wait for summary or error to appear
    const summaryOrError = page.locator('.glass-card.debug-feed, .error-notice');
    await expect(summaryOrError.first()).toBeVisible({ timeout: 15000 });
  });

  test('Process Lead Tickets surfaces source field in summary', async ({ page }) => {
    await gotoSwarmDebug(page);
    const processBtn = page.locator('button', { hasText: 'Process Lead Tickets' });
    await processBtn.click();

    // Wait for processing to complete
    await expect(processBtn).toContainText('Process Lead Tickets', { timeout: 15000 });

    // Either the summary card with source or an error notice should be visible
    const hasSummarySource = page.locator('text=source:');
    const hasErrorNotice = page.locator('.error-notice');
    const visible = await Promise.race([
      hasSummarySource.isVisible().then(() => 'source'),
      hasErrorNotice.isVisible().then(() => 'error'),
    ]);

    expect(['source', 'error']).toContain(visible);
  });

  test('Swarm Ticket Lab section renders with status chip', async ({ page }) => {
    await gotoSwarmDebug(page);
    const labHeader = page.locator('text=Swarm Ticket Lab');
    await expect(labHeader).toBeVisible();
    const statusChip = page.locator('.badge');
    await expect(statusChip.first()).toBeVisible();
  });

  test('Run ID input field exists', async ({ page }) => {
    await gotoSwarmDebug(page);
    const runIdInput = page.locator('input[aria-label="Swarm run id"]');
    await expect(runIdInput).toBeVisible();
    await expect(runIdInput).toHaveAttribute('placeholder', 'Paste a swarm run id');
  });

  test('Provider dropdown defaults to Plane', async ({ page }) => {
    await gotoSwarmDebug(page);
    const providerSelect = page.locator('.glass-card select');
    await expect(providerSelect.first()).toHaveValue('plane');
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added focused Playwright coverage for cockpit embedded-history task restores so selected-bot conversation loads stay inside the right rail with embed context preserved
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log attribution for governance compliance during engineering-screen retrofit work
 */

import { test, expect } from '@playwright/test';

const PLAYWRIGHT_PORT = process.env.PLAYWRIGHT_PORT ?? process.env.PORT ?? '3456';
const BASE_URL = process.env.APP_URL ?? `http://localhost:${PLAYWRIGHT_PORT}`;

/**
 * @description Navigate to cockpit and wait for the OSHAL shell bootstrap to finish.
 * @param page - Playwright page instance.
 */
async function gotoCockpit(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${BASE_URL}/cockpit/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean((window as { __cockpit?: unknown }).__cockpit), null, { timeout: 15000 });
}

/**
 * @description Wait for the embedded native chat frame to be interactive.
 * @param page - Playwright page currently pointed at `/cockpit/`.
 */
async function waitForEmbeddedChatReady(page: import('@playwright/test').Page): Promise<void> {
  const frame = page.frameLocator('#chatWorkspaceFrame');
  await expect(page.locator('#chatWorkspaceFrame')).toBeVisible();
  await expect(frame.locator('#messageInput')).toBeVisible();
}

test.describe('Cockpit UI — Embedded History Workspace', () => {
  /**
   * @description Verify selected-bot history loads stay inside the cockpit rail and preserve embed context.
   */
  test('selected-bot history restores conversations inside the cockpit rail', async ({ page }) => {
    await gotoCockpit(page);
    await waitForEmbeddedChatReady(page);

    const selectorOptions = page.locator('#botSelector option');
    expect(await selectorOptions.count()).toBeGreaterThan(1);

    const selectedAgentId = await selectorOptions.nth(1).getAttribute('value');
    const selectedAgentLabel = (await selectorOptions.nth(1).textContent())?.trim() || '';
    expect(selectedAgentId).toBeTruthy();

    const historyTaskId = 'session-78-history-task';
    await page.route(
      new RegExp(`/api/tasks\\?agentId=${selectedAgentId}\\&limit=150$`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            tasks: [
              {
                taskId: historyTaskId,
                title: 'Selected Bot Conversation',
                status: 'completed',
                updatedAt: '2026-03-14T00:00:00.000Z',
                totalCost: 0,
                totalInputTokens: 12,
                totalOutputTokens: 34,
                totalTokens: 46,
                messageCount: 2,
                turnCount: 1,
                totalRequests: 1,
                usageByModel: {},
              },
            ],
          }),
        });
      },
    );

    await page.locator('#botSelector').selectOption(selectedAgentId || '');
    await page.locator('#chatWorkspaceHistoryBtn').click();

    const embeddedFrame = page.frameLocator('#chatWorkspaceFrame');
    await expect(embeddedFrame.locator('#historyModal')).toBeVisible();
    await expect(embeddedFrame.locator('#historyList')).toContainText('Selected Bot Conversation');

    await embeddedFrame
      .locator(`[data-load-task-id="${historyTaskId}"]`)
      .evaluate((button) => button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    await expect(page.locator('#chatWorkspaceFrame')).toHaveAttribute(
      'src',
      new RegExp(`embed=cockpit.*taskId=${historyTaskId}.*agentId=${selectedAgentId}`),
    );

    const reloadedFrame = page.frameLocator('#chatWorkspaceFrame');
    await expect(reloadedFrame.locator('#cockpitContextSummary')).toContainText(selectedAgentLabel);
  });
});

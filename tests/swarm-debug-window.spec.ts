/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright coverage for the chat debug window swarm control panel
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added smoke-test control coverage for the /ui swarm debug window
 */

import { expect, test } from '@playwright/test';

test.describe('Swarm Debug Window', () => {
  test('runs a mocked Plane smoke test and renders the result summary', async ({ page }) => {
    await stubDebugFeeds(page);
    await stubSwarmSmokeTest(page);

    await page.goto('/ui');
    await expect(page.getByRole('button', { name: 'Run Smoke Test' })).toBeVisible();

    await page.getByRole('button', { name: 'Run Smoke Test' }).click();

    await expect(page.getByText('Last smoke test')).toBeVisible();
    await expect(page.getByText('Pulled 1 ticket(s).')).toBeVisible();
    await expect(page.getByText(/source: plane-live/)).toBeVisible();
    await expect(page.getByText('First ticket: Smoke test lead ticket')).toBeVisible();
  });

  test('processes a mocked lead ticket and renders the swarm run snapshot', async ({ page }) => {
    await stubDebugFeeds(page);
    await stubSwarmProcessing(page);

    await page.goto('/ui');
    await expect(page.locator('.debug-window')).toBeVisible({ timeout: 15000 });

    await expect(page.getByText('Swarm Ticket Lab')).toBeVisible();
    await expect(page.getByText('UI ready')).toBeVisible();
    await page.getByRole('button', { name: 'Process Lead Tickets' }).click();

    await expect(page.getByLabel('Swarm run id')).toHaveValue('run-debug-123');
    await expect(page.getByText('Lead ticket only')).toBeVisible();
    await expect(page.getByText(/project-manager/)).toBeVisible();
    await expect(page.getByText(/intake:completed/)).toBeVisible();
  });
});

async function stubDebugFeeds(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/logs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { level: 'INFO', message: 'UI ready', timestamp: '10:00:00' },
      ]),
    });
  });

  await page.route('**/api/stream/debug', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body: 'data: {"event":"swarm","data":"mock-event","timestamp":"10:00:01"}\n\n',
    });
  });
}

async function stubSwarmSmokeTest(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/swarm/smoke', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'plane',
        itemCount: 1,
        source: 'plane-live',
        durationMs: 118,
        items: [
          {
            externalId: 'issue-smoke-1',
            title: 'Smoke test lead ticket',
          },
        ],
      }),
    });
  });
}

async function stubSwarmProcessing(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/swarm/providers/plane/process', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        runId: 'run-debug-123',
        provider: 'plane',
        pulledCount: 1,
        processedCount: 1,
      }),
    });
  });

  await page.route('**/api/swarm/runs/run-debug-123', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        runId: 'run-debug-123',
        provider: 'plane',
        status: 'completed',
        startedAt: '2026-03-12T10:00:00.000Z',
        completedAt: '2026-03-12T10:00:04.000Z',
        itemCount: 1,
        processed: [
          {
            externalId: 'issue-123',
            title: 'Lead ticket only',
            selectedAgentId: 'project-manager',
            workUnitCount: 3,
            lifecycle: {
              overallStatus: 'completed',
              cycles: [
                { cycle: 'intake', status: 'completed' },
                { cycle: 'planning', status: 'completed' },
                { cycle: 'specialist_input', status: 'skipped' },
                { cycle: 'execution', status: 'completed' },
                { cycle: 'testing', status: 'skipped' },
                { cycle: 'review', status: 'skipped' },
                { cycle: 'delivery', status: 'completed' },
              ],
            },
          },
        ],
      }),
    });
  });
}

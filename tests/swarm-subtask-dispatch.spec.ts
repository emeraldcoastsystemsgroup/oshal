/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright E2E tests for subtask dispatch flow — creation, lifecycle, rollup, and work item rendering
 */

import { expect, test } from '@playwright/test';

test.describe('Swarm Subtask Dispatch Flow', () => {
  test('processes a ticket with subtask decomposition and renders parent + subtask work items', async ({ page }) => {
    await stubDebugFeeds(page);
    await stubSubtaskProcessing(page);
    await stubSubtaskWorkItems(page);

    await page.goto('/ui');
    await expect(page.locator('.debug-window')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('UI ready')).toBeVisible();

    await page.getByRole('button', { name: 'Process Lead Tickets' }).click();

    await expect(page.getByLabel('Swarm run id')).toHaveValue('run-subtask-001');
    await expect(page.getByText('Parent decomposed ticket')).toBeVisible();
    await expect(page.getByText(/project-manager/)).toBeVisible();
    await expect(page.getByText(/intake:completed/)).toBeVisible();
    await expect(page.getByText(/planning:completed/)).toBeVisible();
    await expect(page.getByText(/execution:completed/)).toBeVisible();
    await expect(page.getByText(/delivery:completed/)).toBeVisible();
  });

  test('renders subtask work items with correct status badges after dispatch completes', async ({ page }) => {
    await stubDebugFeeds(page);
    await stubSubtaskProcessing(page);
    await stubSubtaskWorkItems(page);

    await page.goto('/ui');
    await expect(page.locator('.debug-window')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Process Lead Tickets' }).click();
    await expect(page.getByLabel('Swarm run id')).toHaveValue('run-subtask-001');

    await expect(page.getByText('3 item(s)')).toBeVisible();
    await expect(page.getByText('Parent: Decomposed ticket')).toBeVisible();
    await expect(page.getByText('Subtask: Implement API endpoint')).toBeVisible();
    await expect(page.getByText('Subtask: Write unit tests')).toBeVisible();
  });

  test('subtask work items show execution output when expanded', async ({ page }) => {
    await stubDebugFeeds(page);
    await stubSubtaskProcessing(page);
    await stubSubtaskWorkItems(page);

    await page.goto('/ui');
    await expect(page.locator('.debug-window')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Process Lead Tickets' }).click();
    await expect(page.getByText('3 item(s)')).toBeVisible();

    const subtaskCard = page.locator('div.glass-card', { hasText: 'Subtask: Implement API endpoint' });
    await expect(subtaskCard).toBeVisible();
    await expect(subtaskCard.locator('.badge-success', { hasText: 'output' })).toBeVisible();

    await subtaskCard.click();
    await expect(page.getByText('Execution Output')).toBeVisible();
    await expect(page.getByText(/endpoint created at/)).toBeVisible();
  });

  test('subtask with failed status shows failed badge', async ({ page }) => {
    await stubDebugFeeds(page);
    await stubSubtaskProcessing(page);
    await stubSubtaskWorkItemsWithFailure(page);

    await page.goto('/ui');
    await expect(page.locator('.debug-window')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Process Lead Tickets' }).click();
    await expect(page.getByText('3 item(s)')).toBeVisible();

    const failedCard = page.locator('div.glass-card', { hasText: 'Subtask: Write unit tests' });
    await expect(failedCard).toBeVisible();

    const failedBadge = failedCard.locator('text=failed');
    await expect(failedBadge).toBeVisible();
  });

  test('include subtickets checkbox sends includeSubtickets flag in process request', async ({ page }) => {
    await stubDebugFeeds(page);

    let capturedBody: Record<string, unknown> | null = null;
    await page.route('**/api/swarm/providers/plane/process', async (route) => {
      const request = route.request();
      capturedBody = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: 'run-subtask-flag',
          provider: 'plane',
          pulledCount: 0,
          processedCount: 0,
        }),
      });
    });

    await page.route('**/api/swarm/runs/run-subtask-flag', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: 'run-subtask-flag',
          provider: 'plane',
          status: 'completed',
          startedAt: '2026-03-14T10:00:00.000Z',
          completedAt: '2026-03-14T10:00:01.000Z',
          itemCount: 0,
          processed: [],
        }),
      });
    });

    await stubEmptyWorkItems(page);

    await page.goto('/ui');
    await expect(page.locator('.debug-window')).toBeVisible({ timeout: 15000 });

    const checkbox = page.getByLabel('Include subtickets in pull results');
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    await page.getByRole('button', { name: 'Process Lead Tickets' }).click();
    await expect(page.getByLabel('Swarm run id')).toHaveValue('run-subtask-flag');

    expect(capturedBody).toBeTruthy();
    expect(capturedBody!.includeSubtickets).toBe(true);
  });

  test('processing summary shows correct counts for parent with subtasks', async ({ page }) => {
    await stubDebugFeeds(page);
    await stubSubtaskProcessing(page);
    await stubSubtaskWorkItems(page);

    await page.goto('/ui');
    await expect(page.locator('.debug-window')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Process Lead Tickets' }).click();

    await expect(page.getByText(/pulledCount.*1|Pulled.*1/i)).toBeVisible();
    await expect(page.getByText(/processedCount.*1|Processed.*1/i)).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/* Stub helpers                                                        */
/* ------------------------------------------------------------------ */

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

async function stubSubtaskProcessing(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/swarm/providers/plane/process', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        runId: 'run-subtask-001',
        provider: 'plane',
        pulledCount: 1,
        processedCount: 1,
      }),
    });
  });

  await page.route('**/api/swarm/runs/run-subtask-001', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        runId: 'run-subtask-001',
        provider: 'plane',
        status: 'completed',
        startedAt: '2026-03-14T16:00:00.000Z',
        completedAt: '2026-03-14T16:00:08.000Z',
        itemCount: 1,
        processed: [
          {
            externalId: 'issue-parent-001',
            title: 'Parent decomposed ticket',
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

async function stubSubtaskWorkItems(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/swarm/work-items*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        workItems: [
          {
            workItemId: 'wi-parent-001',
            title: 'Parent: Decomposed ticket',
            description: 'Root ticket decomposed into subtasks',
            unitId: 'unit-parent-001',
            assignedAgentId: 'project-manager',
            status: 'completed',
            executionOutput: { summary: 'Decomposed into 2 subtasks' },
            verificationResult: { status: 'approved', verdict: 'All subtasks completed successfully' },
            createdAt: '2026-03-14T16:00:00.000Z',
          },
          {
            workItemId: 'wi-subtask-001',
            title: 'Subtask: Implement API endpoint',
            description: 'Create the REST endpoint for the new feature',
            unitId: 'unit-subtask-001',
            assignedAgentId: 'code-bot',
            status: 'completed',
            executionOutput: { result: 'endpoint created at /api/feature/new', filesChanged: 3 },
            createdAt: '2026-03-14T16:00:02.000Z',
          },
          {
            workItemId: 'wi-subtask-002',
            title: 'Subtask: Write unit tests',
            description: 'Add test coverage for the new endpoint',
            unitId: 'unit-subtask-002',
            assignedAgentId: 'code-bot',
            status: 'completed',
            executionOutput: { result: 'Added 12 test cases, all passing', coverage: '94%' },
            createdAt: '2026-03-14T16:00:05.000Z',
          },
        ],
      }),
    });
  });
}

async function stubSubtaskWorkItemsWithFailure(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/swarm/work-items*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        workItems: [
          {
            workItemId: 'wi-parent-001',
            title: 'Parent: Decomposed ticket',
            description: 'Root ticket decomposed into subtasks',
            unitId: 'unit-parent-001',
            assignedAgentId: 'project-manager',
            status: 'completed',
            createdAt: '2026-03-14T16:00:00.000Z',
          },
          {
            workItemId: 'wi-subtask-001',
            title: 'Subtask: Implement API endpoint',
            description: 'Create the REST endpoint for the new feature',
            unitId: 'unit-subtask-001',
            assignedAgentId: 'code-bot',
            status: 'completed',
            executionOutput: { result: 'endpoint created' },
            createdAt: '2026-03-14T16:00:02.000Z',
          },
          {
            workItemId: 'wi-subtask-002',
            title: 'Subtask: Write unit tests',
            description: 'Add test coverage for the new endpoint',
            unitId: 'unit-subtask-002',
            assignedAgentId: 'code-bot',
            status: 'failed',
            createdAt: '2026-03-14T16:00:05.000Z',
          },
        ],
      }),
    });
  });
}

async function stubEmptyWorkItems(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/swarm/work-items*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ workItems: [] }),
    });
  });
}

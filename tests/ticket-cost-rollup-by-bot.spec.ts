/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright regression coverage for cockpit ticket cost rollups so per-bot usage badges and Cost by Bot tables render from linked chat_tasks telemetry
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched ticket cost rollup fixture seeding to the task telemetry API so MOCK_OIDC localhost validation no longer depends on direct Postgres access
 */

import { expect, test } from '@playwright/test';

/**
 * @description Create a ticket linked to two task rows, then inject direct chat_tasks telemetry for two different bots.
 * @param request - Playwright API request context.
 * @param pool - Postgres pool for chat_tasks updates.
 * @returns Fixture identifiers used by the browser assertions.
 */
async function createCostRollupFixture(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ ticketId: string; ticketTitle: string; taskIds: string[] }> {
  const uniqueId = Date.now().toString(36);

  const taskAResponse = await request.post('/api/tasks', {
    data: {
      title: `Cost rollup task A ${uniqueId}`,
      processingMode: 'agentic',
      metadata: { source: 'playwright-ticket-cost-rollup' },
    },
  });
  expect(taskAResponse.ok()).toBeTruthy();
  const taskATaskId = String((await taskAResponse.json())?.taskId || '');
  expect(taskATaskId).toBeTruthy();

  const taskBResponse = await request.post('/api/tasks', {
    data: {
      title: `Cost rollup task B ${uniqueId}`,
      processingMode: 'agentic',
      metadata: { source: 'playwright-ticket-cost-rollup' },
    },
  });
  expect(taskBResponse.ok()).toBeTruthy();
  const taskBTaskId = String((await taskBResponse.json())?.taskId || '');
  expect(taskBTaskId).toBeTruthy();

  const ticketTitle = `Ticket Cost Rollup ${uniqueId}`;
  const ticketResponse = await request.post('/api/tickets', {
    data: {
      title: ticketTitle,
      description: 'Validate ticket cost rollups by contributing bot.',
      metadata: { source: 'playwright-ticket-cost-rollup' },
    },
  });
  expect(ticketResponse.ok()).toBeTruthy();
  const ticketId = String((await ticketResponse.json())?.ticketId || '');
  expect(ticketId).toBeTruthy();

  const primaryLinkResponse = await request.post(`/api/tickets/${encodeURIComponent(ticketId)}/tasks`, {
    data: { taskId: taskATaskId, role: 'primary' },
  });
  expect(primaryLinkResponse.ok()).toBeTruthy();

  const reviewLinkResponse = await request.post(`/api/tickets/${encodeURIComponent(ticketId)}/tasks`, {
    data: { taskId: taskBTaskId, role: 'review' },
  });
  expect(reviewLinkResponse.ok()).toBeTruthy();

  await updateTaskUsage(request, {
    taskId: taskATaskId,
    agentId: 'code-developer',
    providerId: 'playwright-test',
    modelId: 'claude-sonnet',
    inputTokens: 1400,
    outputTokens: 600,
    inputCost: 0.14,
    outputCost: 0.08,
    totalCost: 0.22,
    requestCount: 2,
  });

  await updateTaskUsage(request, {
    taskId: taskBTaskId,
    agentId: 'test-engineer',
    providerId: 'playwright-test',
    modelId: 'gpt-4.1',
    inputTokens: 900,
    outputTokens: 300,
    inputCost: 0.09,
    outputCost: 0.03,
    totalCost: 0.12,
    requestCount: 1,
  });

  return { ticketId, ticketTitle, taskIds: [taskATaskId, taskBTaskId] };
}

/**
 * @description Inject one deterministic task telemetry summary for a linked task.
 * @param request - Playwright API request context.
 * @param usage - Usage values to persist.
 */
async function updateTaskUsage(
  request: import('@playwright/test').APIRequestContext,
  usage: {
    taskId: string;
    agentId: string;
    providerId: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    inputCost: number;
    outputCost: number;
    totalCost: number;
    requestCount: number;
  },
): Promise<void> {
  const response = await request.post(`/api/tasks/${encodeURIComponent(usage.taskId)}/usage`, {
    data: {
      agentId: usage.agentId,
      providerId: usage.providerId,
      modelId: usage.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      inputCost: usage.inputCost,
      outputCost: usage.outputCost,
      totalCost: usage.totalCost,
      requestCount: usage.requestCount,
    },
  });

  expect(response.ok()).toBeTruthy();
}

test.describe('Cockpit Ticket Cost Rollup by Bot', () => {
  test('ticket detail shows contributing bot badges and Cost by Bot table from linked chat_tasks usage', async ({ page, request }) => {
    let fixture: { ticketId: string; ticketTitle: string; taskIds: string[] } | null = null;

    try {
      fixture = await createCostRollupFixture(request);

      await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
      await page.locator('.ribbon-btn[data-view="tickets"]').click();

      const ticketRow = page.locator('.ticket-row', { hasText: fixture.ticketTitle }).first();
      await expect(ticketRow).toBeVisible({ timeout: 15000 });
      await ticketRow.click();

      await expect(page.locator('#tvDetailPane')).toContainText('Contributing Bots', { timeout: 15000 });
      await expect(page.locator('#tvDetailPane')).toContainText('code-developer');
      await expect(page.locator('#tvDetailPane')).toContainText('test-engineer');

      await page.locator('.td-tab[data-tab="cost"]').click();
      await expect(page.locator('#tvDetailBody')).toContainText('Cost by Bot');
      await expect(page.locator('#tvDetailBody')).toContainText('code-developer');
      await expect(page.locator('#tvDetailBody')).toContainText('test-engineer');
      await expect(page.locator('#tvDetailBody')).toContainText('Cost by Model');
      await expect(page.locator('#tvDetailBody')).not.toContainText('No cost telemetry recorded yet');
    } finally {
      if (fixture?.ticketId) {
        await request.delete(`/api/v1/tickets/${encodeURIComponent(fixture.ticketId)}`).catch(() => undefined);
      }
    }
  });
});
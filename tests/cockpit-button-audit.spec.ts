/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added live-backed cockpit click-audit coverage for chat, calendar, address book, and dashboard button flows
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added calendar-to-ticket handoff coverage so the ribbon calendar proves its operator drill-in path instead of only schedule CRUD
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Corrected historical Change Log author attribution while validating calendar visibility regressions
 */

import { expect, test } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

async function switchToView(page: any, viewId: string): Promise<void> {
  await page.goto(COCKPIT_URL, { waitUntil: 'domcontentloaded' });
  await page.locator(`.ribbon-btn[data-view="${viewId}"]`).click();
  await page.waitForTimeout(500);
}

async function getFirstAgent(request: any): Promise<string> {
  const response = await request.get('/api/agents');
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  const agent = (body.agents || body || [])[0];
  expect(agent).toBeTruthy();
  return agent.agent_id || agent.agentId || agent.name;
}

async function getSchedulerEnabledAgent(request: any): Promise<string | null> {
  const response = await request.get('/api/agents');
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  const agents = body.agents || body || [];

  for (const agent of agents) {
    const agentId = agent.agent_id || agent.agentId || agent.name;
    const toolsResponse = await request.get(`/api/agents/${encodeURIComponent(agentId)}/tools`);
    if (!toolsResponse.ok()) continue;
    const toolsBody = await toolsResponse.json();
    const tools = toolsBody.tools || toolsBody || [];
    const scheduler = tools.find((tool: any) => (tool.toolId || tool.id) === 'agent-scheduler');
    if (scheduler?.enabled) return agentId;
  }

  return null;
}

async function createCalendarTicket(request: any): Promise<{ ticketId: string; title: string }> {
  const title = `Calendar ticket audit ${Date.now()}`;
  const response = await request.post('/api/tickets', {
    data: {
      title,
      description: 'Calendar open-ticket flow validation',
      metadata: { source: 'cockpit-button-audit' },
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return {
    ticketId: String(body.ticketId || ''),
    title,
  };
}

async function waitForToast(page: any, text: string): Promise<void> {
  await expect(page.locator('.toast').filter({ hasText: text }).last()).toBeVisible();
}

test.describe('Cockpit live button audit', () => {
  test('chat conversation row opens detail and delete removes the real task', async ({ page, request }) => {
    const agentId = await getFirstAgent(request);
    const title = `Cockpit button audit chat ${Date.now()}`;
    const createResponse = await request.post('/api/tasks', {
      data: {
        title,
        text: title,
        processingMode: 'agentic',
        agentId,
        metadata: { source: 'cockpit-button-audit' },
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    const createBody = await createResponse.json();
    const taskId = createBody.taskId || createBody.id;

    await switchToView(page, 'chat');
    await page.locator('#cvSearch').fill(title);
    await page.waitForTimeout(300);

    const row = page.locator(`#cvList .ticket-row[data-id="${taskId}"]`);
    await expect(row).toBeVisible();
    await row.click();

    await expect(page.locator('#cvDetailPane')).not.toContainText('Conversation not found');
    await expect(page.locator('#cvDetailPane')).toContainText('Conversation with');
    await expect(page.locator('#cvDetailPane')).toContainText(taskId.slice(0, 8));

    await page.locator('#cvFocusInRail').click();
    await waitForToast(page, 'Conversation focused in the right rail');

    const deleteResponsePromise = page.waitForResponse((response: any) =>
      response.url().includes(`/api/tasks/${taskId}`) && response.request().method() === 'DELETE',
    );
    await page.locator('#cvDeleteConv').click();
    const deleteResponse = await deleteResponsePromise;

    expect(deleteResponse.status()).toBe(204);
    await waitForToast(page, 'Conversation deleted');
    await expect(page.locator(`#cvList .ticket-row[data-id="${taskId}"]`)).toHaveCount(0);
  });

  test('calendar schedule dialog creates, triggers, and deletes a live schedule', async ({ page, request }) => {
    const agentId = await getSchedulerEnabledAgent(request);
    const description = `Cockpit button audit schedule ${Date.now()}`;
    let scheduleId = '';

    await switchToView(page, 'calendar');
    await page.locator('#calAddSchedule').click();
    await expect(page.locator('.cal-schedule-dialog')).toBeVisible();

    if (!agentId) {
      await expect(page.locator('#schedCreate')).toBeDisabled();
      await expect(page.locator('.cal-schedule-dialog')).toContainText('No bots currently have Agent Scheduler enabled');
      return;
    }

    await page.locator('#schedBot').selectOption(agentId);
    await page.locator('#schedDesc').fill(description);
    await page.locator('#schedCron').fill('*/15 * * * *');

    const createResponsePromise = page.waitForResponse((response: any) =>
      response.url().includes('/api/v1/agent/schedule-task') && response.request().method() === 'POST',
    );
    await page.locator('#schedCreate').click();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBeTruthy();

    const createBody = await createResponse.json();
    scheduleId = createBody.scheduleId || createBody.schedule?.id || '';
    expect(scheduleId).toBeTruthy();

    await waitForToast(page, 'Schedule created');
    await page.locator('.cal-day.today').click();

    const eventRow = page.locator(`#calDayDetail .cal-event-item[data-event-id="${scheduleId}"]`);
    await expect(eventRow).toBeVisible();
    await expect(eventRow).toContainText(description);

    const triggerResponsePromise = page.waitForResponse((response: any) =>
      response.url().includes(`/api/v1/agent/schedules/${scheduleId}/trigger`) && response.request().method() === 'POST',
    );
    await eventRow.locator('[data-action="trigger"]').click();
    const triggerResponse = await triggerResponsePromise;

    expect(triggerResponse.ok()).toBeTruthy();
    await waitForToast(page, 'Schedule triggered');

    const deleteResponsePromise = page.waitForResponse((response: any) =>
      response.url().includes(`/api/v1/agent/schedules/${scheduleId}`) && response.request().method() === 'DELETE',
    );
    await eventRow.locator('[data-action="delete-schedule"]').click();
    const deleteResponse = await deleteResponsePromise;

    expect(deleteResponse.ok()).toBeTruthy();
    await waitForToast(page, 'Schedule deleted');
    await expect(page.locator(`#calDayDetail .cal-event-item[data-event-id="${scheduleId}"]`)).toHaveCount(0);
  });

  test('calendar ticket activity opens the selected ticket in the workbench', async ({ page, request }) => {
    const fixture = await createCalendarTicket(request);

    await switchToView(page, 'calendar');
    await page.locator('.cal-day.today').click();

    const eventRow = page.locator('#calDayDetail .cal-event-item').filter({ hasText: fixture.title }).first();
    await expect(eventRow).toBeVisible({ timeout: 10000 });
    await eventRow.locator('[data-action="open-ticket"]').click();

    await expect(page.locator('.ribbon-btn[data-view="tickets"]')).toHaveClass(/active/);
    await expect(page.locator('#tvDetailPane')).toContainText(fixture.title, { timeout: 10000 });
    await expect(page.locator('#tvDetailPane')).toContainText(fixture.ticketId.slice(0, 8));
  });

  test('address book activity button switches to calendar scoped to the selected bot', async ({ page, request }) => {
    const agentId = await getFirstAgent(request);

    await switchToView(page, 'addressbook');
    await page.locator('#abSearch').fill(agentId);
    await page.waitForTimeout(300);

    const card = page.locator(`.ab-card[data-bot-id="${agentId}"]`).first();
    await expect(card).toBeVisible();
    await card.locator('[data-action="activity"]').click();

    await expect(page.locator('#calViewRoot')).toBeVisible();
    await expect(page.locator('#calBotFilter')).toHaveValue(agentId, { timeout: 3000 });
  });

  test('dashboard refresh keeps health legend grounded in live values', async ({ page }) => {
    await switchToView(page, 'dashboard');
    await page.locator('#dashRefresh').click();
    await expect(page.locator('#dashContent')).toBeVisible();

    const legendText = await page.locator('#dashDonutLegend').textContent();
    expect(legendText || '').not.toContain('Healthy: 40');
    expect(legendText || '').not.toContain('Degraded: 3');
    expect(legendText || '').not.toContain('Offline: 5');
  });
});

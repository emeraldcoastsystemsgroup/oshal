/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for root-ticket project moves so backend propagation and cockpit reassignment stay aligned with the Default-project ticket model
 */

import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

interface TicketTreeFixture {
  workspaceId: string;
  rootTicketId: string;
  childTicketId: string;
  rootTaskId: string;
  childTaskId: string;
  rootTitle: string;
  childTitle: string;
}

/**
 * @description Creates one root/child internal ticket tree linked to a shared workspace and dedicated tasks.
 * @param request - Playwright API request context.
 * @returns Root/child fixture identifiers for project-move validation.
 */
async function createTicketTreeFixture(
  request: import('@playwright/test').APIRequestContext,
): Promise<TicketTreeFixture> {
  const suffix = Date.now().toString(36);
  const workspaceId = randomUUID();
  const rootTitle = `Project Move Root ${suffix}`;
  const childTitle = `Project Move Child ${suffix}`;

  const rootTicketResponse = await request.post('/api/tickets', {
    data: {
      title: rootTitle,
      description: 'Root feature ticket for project reassignment coverage.',
      workspaceId,
      metadata: {
        sequenceId: `ROOT-${suffix}`,
      },
    },
  });
  expect(rootTicketResponse.ok()).toBeTruthy();
  const rootTicket = await rootTicketResponse.json();

  const childTicketResponse = await request.post('/api/tickets', {
    data: {
      title: childTitle,
      description: 'Child ticket that should inherit project moves from the root.',
      workspaceId,
      parentTicketId: rootTicket.ticketId,
      metadata: {
        sequenceId: `CHILD-${suffix}`,
      },
    },
  });
  expect(childTicketResponse.ok()).toBeTruthy();
  const childTicket = await childTicketResponse.json();

  const rootTaskResponse = await request.post('/api/tasks', {
    data: {
      title: `${rootTitle} Task`,
      processingMode: 'agentic',
      metadata: {
        ticketId: rootTicket.ticketId,
        sequenceId: `ROOT-TASK-${suffix}`,
      },
    },
  });
  expect(rootTaskResponse.ok()).toBeTruthy();
  const rootTask = await rootTaskResponse.json();

  const childTaskResponse = await request.post('/api/tasks', {
    data: {
      title: `${childTitle} Task`,
      processingMode: 'agentic',
      metadata: {
        ticketId: childTicket.ticketId,
        parentId: rootTask.taskId,
        sequenceId: `CHILD-TASK-${suffix}`,
      },
    },
  });
  expect(childTaskResponse.ok()).toBeTruthy();
  const childTask = await childTaskResponse.json();

  const rootLinkResponse = await request.post(`/api/tickets/${rootTicket.ticketId}/tasks`, {
    data: { taskId: rootTask.taskId, role: 'primary' },
  });
  expect(rootLinkResponse.ok()).toBeTruthy();

  const childLinkResponse = await request.post(`/api/tickets/${childTicket.ticketId}/tasks`, {
    data: { taskId: childTask.taskId, role: 'subtask' },
  });
  expect(childLinkResponse.ok()).toBeTruthy();

  return {
    workspaceId,
    rootTicketId: rootTicket.ticketId,
    childTicketId: childTicket.ticketId,
    rootTaskId: rootTask.taskId,
    childTaskId: childTask.taskId,
    rootTitle,
    childTitle,
  };
}

test.describe('Ticket Project Move', () => {
  test('root ticket project move propagates to descendants and linked tasks while preserving shared workspace ownership', async ({ request }) => {
    const fixture = await createTicketTreeFixture(request);

    const rootBeforeResponse = await request.get(`/api/tickets/${fixture.rootTicketId}`);
    expect(rootBeforeResponse.ok()).toBeTruthy();
    const rootBefore = await rootBeforeResponse.json();
    expect(rootBefore.metadata.projectId).toBe('default');
    expect(rootBefore.workspaceId).toBe(fixture.workspaceId);

    const moveResponse = await request.put(`/api/tickets/${fixture.rootTicketId}/project`, {
      data: {
        projectName: 'Website Alpha',
      },
    });
    expect(moveResponse.ok()).toBeTruthy();
    const moveBody = await moveResponse.json();
    expect(moveBody.success).toBe(true);
    expect(moveBody.project.projectId).toBe('website-alpha');
    expect(moveBody.updatedTicketIds).toContain(fixture.rootTicketId);
    expect(moveBody.updatedTicketIds).toContain(fixture.childTicketId);
    expect(moveBody.updatedTaskIds).toContain(fixture.rootTaskId);
    expect(moveBody.updatedTaskIds).toContain(fixture.childTaskId);
    expect(moveBody.preservedWorkspaceId).toBe(fixture.workspaceId);

    const rootAfter = await (await request.get(`/api/tickets/${fixture.rootTicketId}`)).json();
    const childAfter = await (await request.get(`/api/tickets/${fixture.childTicketId}`)).json();
    const rootTaskAfter = await (await request.get(`/api/tasks/${fixture.rootTaskId}`)).json();
    const childTaskAfter = await (await request.get(`/api/tasks/${fixture.childTaskId}`)).json();

    expect(rootAfter.metadata.projectName).toBe('Website Alpha');
    expect(rootAfter.metadata.projectId).toBe('website-alpha');
    expect(rootAfter.workspaceId).toBe(fixture.workspaceId);
    expect(childAfter.metadata.projectId).toBe('website-alpha');
    expect(childAfter.parentTicketId).toBe(fixture.rootTicketId);
    expect(childAfter.workspaceId).toBe(fixture.workspaceId);
    expect(rootTaskAfter.metadata.projectId).toBe('website-alpha');
    expect(childTaskAfter.metadata.projectId).toBe('website-alpha');
  });

  test('child tickets cannot move projects directly', async ({ request }) => {
    const fixture = await createTicketTreeFixture(request);
    const moveResponse = await request.put(`/api/tickets/${fixture.childTicketId}/project`, {
      data: {
        projectName: 'Should Fail',
      },
    });

    expect(moveResponse.status()).toBe(400);
    const body = await moveResponse.json();
    expect(String(body.error || '')).toContain('Only root tickets');
  });

  test('cockpit root-ticket project control moves the tree into a new project and preserves child drill-in', async ({ page, request }) => {
    const fixture = await createTicketTreeFixture(request);

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    const rootRow = page.locator('.ticket-row', { hasText: fixture.rootTitle }).first();
    await expect(rootRow).toBeVisible({ timeout: 15000 });
    await rootRow.click();

    await expect(page.locator('#tvProjectBadge')).toContainText('Default');
    await page.locator('#tvProjectCustomName').fill('Operator Launch');
    await page.locator('#tvProjectMoveBtn').click();

    await expect(page.locator('#toastContainer .toast').last()).toContainText('Project updated to Operator Launch');
    await expect(page.locator('#tvProjectBadge')).toContainText('Operator Launch');
    await expect(page.locator('#tvProjectFilter')).toHaveValue('operator-launch');

    const refreshedRootRow = page.locator(`.ticket-row[data-id="${fixture.rootTicketId}"]`).first();
    await expect(refreshedRootRow).toBeVisible({ timeout: 15000 });
    await refreshedRootRow.locator('.expand-chevron').click();

    const childRow = page.locator(`.ticket-row[data-id="${fixture.childTicketId}"]`).first();
    await expect(childRow).toBeVisible();
    await childRow.click();

    await expect(page.locator('[data-ticket-project-note]')).toContainText('Operator Launch');
    await expect(page.locator('#tvDeleteBtn')).toHaveCount(0);
  });
});

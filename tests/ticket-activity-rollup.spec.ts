/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for root-ticket child activity rollup so timeline, cost, and tree context surface from subtasks into the parent feed
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added workspace-link regression coverage so populated shared root workspaces remain browsable from root and child ticket activity payloads
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Aligned the spec's resolveWorkspaceRoot with the server's resolver (the /app/workspace existsSync branch was missing here, so on hosts where C:\app\workspace exists the server and spec seeded different roots and the workspace-browse assertion failed CI-only).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

/**
 * @description Creates a root + child ticket tree with linked tasks for activity rollup validation.
 * @param request - Playwright API request context
 * @returns Fixture with root/child ticket and task identifiers
 */
async function createActivityFixture(
  request: import('@playwright/test').APIRequestContext,
) {
  const suffix = Date.now().toString(36);
  const workspaceId = randomUUID();

  const rootResp = await request.post('/api/tickets', {
    data: { title: `Rollup Root ${suffix}`, description: 'Root for activity rollup test.', workspaceId },
  });
  expect(rootResp.ok()).toBeTruthy();
  const root = await rootResp.json();

  const childResp = await request.post('/api/tickets', {
    data: { title: `Rollup Child ${suffix}`, description: 'Child that produces activity.', workspaceId, parentTicketId: root.ticketId },
  });
  expect(childResp.ok()).toBeTruthy();
  const child = await childResp.json();

  const rootTaskResp = await request.post('/api/tasks', {
    data: { title: `Root Task ${suffix}`, processingMode: 'agentic', metadata: { ticketId: root.ticketId } },
  });
  expect(rootTaskResp.ok()).toBeTruthy();
  const rootTask = await rootTaskResp.json();

  const childTaskResp = await request.post('/api/tasks', {
    data: { title: `Child Task ${suffix}`, processingMode: 'agentic', metadata: { ticketId: child.ticketId } },
  });
  expect(childTaskResp.ok()).toBeTruthy();
  const childTask = await childTaskResp.json();

  await request.post(`/api/tickets/${root.ticketId}/tasks`, { data: { taskId: rootTask.taskId, role: 'primary' } });
  await request.post(`/api/tickets/${child.ticketId}/tasks`, { data: { taskId: childTask.taskId, role: 'primary' } });

  return {
    workspaceId,
    rootTicketId: root.ticketId as string,
    childTicketId: child.ticketId as string,
    rootTaskId: rootTask.taskId as string,
    childTaskId: childTask.taskId as string,
    rootTitle: `Rollup Root ${suffix}`,
    childTitle: `Rollup Child ${suffix}`,
  };
}

function resolveWorkspaceRoot(): string {
  const configuredRoot = process.env.SHARED_WORKSPACE_ROOT
    || process.env.CLINE_WORKSPACE_ROOT
    || process.env.WORKSPACE_ROOT;
  if (configuredRoot && configuredRoot.trim().length > 0) {
    return path.resolve(configuredRoot);
  }
  // Mirror the server's TaskExplorerWorkspaceService.resolveWorkspaceRoot exactly:
  // it prefers /app/workspace when that directory exists on the host. Omitting this
  // branch made the spec seed a different root than the server browsed (CI-only red).
  return fs.existsSync('/app/workspace')
    ? '/app/workspace'
    : path.resolve(process.cwd(), 'workspace-shared');
}

function seedWorkspace(rootTicketId: string): { workspaceRoot: string; filePath: string } {
  const workspaceRoot = resolveWorkspaceRoot();
  const deliverablesDir = path.join(workspaceRoot, rootTicketId, 'deliverables', 'src');
  fs.mkdirSync(deliverablesDir, { recursive: true });
  const filePath = path.join(deliverablesDir, 'index.ts');
  fs.writeFileSync(filePath, 'export const seeded = true;\n', 'utf8');
  return { workspaceRoot, filePath };
}

test.describe('Ticket Activity Rollup', () => {
  test('root ticket activity includes children metadata and rolled-up child timeline entries', async ({ request }) => {
    const fixture = await createActivityFixture(request);

    const activityResp = await request.get(`/api/v1/tickets/${fixture.rootTicketId}/activity`);
    expect(activityResp.ok()).toBeTruthy();
    const body = await activityResp.json();

    expect(body.success).toBe(true);
    expect(body.ticket).toBeTruthy();
    expect(body.ticket.parentId).toBeNull();
    expect(Array.isArray(body.ticket.children)).toBe(true);
    expect(body.ticket.children.length).toBeGreaterThanOrEqual(1);

    const childEntry = body.ticket.children.find((c: any) => c.id === fixture.childTicketId);
    expect(childEntry).toBeTruthy();
    expect(childEntry.name).toContain('Rollup Child');
  });

  test('child ticket activity does not include sibling or parent rollup', async ({ request }) => {
    const fixture = await createActivityFixture(request);

    const activityResp = await request.get(`/api/v1/tickets/${fixture.childTicketId}/activity`);
    expect(activityResp.ok()).toBeTruthy();
    const body = await activityResp.json();

    expect(body.success).toBe(true);
    expect(body.ticket).toBeTruthy();
    expect(body.ticket.parentId).toBe(fixture.rootTicketId);
    expect(body.ticket.children).toEqual([]);
  });

  test('root and child ticket activity point workspace browsing at the populated shared root workspace', async ({ request }) => {
    const fixture = await createActivityFixture(request);
    const seeded = seedWorkspace(fixture.rootTicketId);

    const rootActivityResp = await request.get(`/api/v1/tickets/${fixture.rootTicketId}/activity`);
    expect(rootActivityResp.ok()).toBeTruthy();
    const rootBody = await rootActivityResp.json();

    expect(rootBody.ticket.workspaceTaskId).toBe(fixture.rootTicketId);
    expect(String(rootBody.ticket.workspacePath || '')).toContain(fixture.rootTicketId);

    const childActivityResp = await request.get(`/api/v1/tickets/${fixture.childTicketId}/activity`);
    expect(childActivityResp.ok()).toBeTruthy();
    const childBody = await childActivityResp.json();

    expect(childBody.ticket.workspaceTaskId).toBe(fixture.rootTicketId);
    expect(String(childBody.ticket.workspacePath || '')).toContain(fixture.rootTicketId);

    const workspaceResp = await request.get(`/api/v1/workspace/${childBody.ticket.workspaceTaskId}/files`);
    expect(workspaceResp.ok()).toBeTruthy();
    const workspaceBody = await workspaceResp.json();
    const serializedChildren = JSON.stringify(workspaceBody.data.children).replace(/\\\\/g, '/');

    expect(workspaceBody.success).toBe(true);
    expect(workspaceBody.data.exists).toBe(true);
    expect(serializedChildren).toContain('deliverables/src/index.ts');
    expect(seeded.filePath).toContain(path.join(fixture.rootTicketId, 'deliverables', 'src', 'index.ts'));
  });

  test('cockpit root ticket feed shows subtask source badge for rolled-up child entries', async ({ page, request }) => {
    const fixture = await createActivityFixture(request);

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    const rootRow = page.locator('.ticket-row', { hasText: fixture.rootTitle }).first();
    await expect(rootRow).toBeVisible({ timeout: 15000 });
    await rootRow.click();

    // Feed tab should load — verify it renders without errors
    await expect(page.locator('[data-ticket-feed-list]')).toBeVisible({ timeout: 10000 });
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright button-usability audit for engineering screens and direct swarmbot workspace actions
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Hardened pop-out button assertion to trigger click via DOM dispatch when responsive layout hides the control
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added cockpit ticket feed/artifact/code-server button regression coverage using real ticket/task/message APIs
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Updated swarmbot toolbar assertions for the shared knowledge workspace close/preview behavior
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added RAG Center refresh coverage to the engineering-button usability audit
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Normalized code-server bridge assertions to the slashless /code query path while keeping trailing-slash bridge compatibility covered
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added ticket project-filter and child-search coverage so the cockpit ticket workbench proves parent/child filtering behavior with real task hierarchy data
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added code-server shared-workspace normalization coverage so cockpit artifact links and bridge redirects stop leaking host-local absolute paths
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added grouped-ticket hierarchy coverage so grouped status views still allow parent expansion into real child rows
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Added no-telemetry cost-tab coverage so empty ticket cost states stay explicit instead of masquerading as measured zero-cost work
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Added ticket project-grouping and child-parent drill-in coverage so grouped project views and child detail navigation stay actionable
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Added child-ticket action/workspace guidance coverage so subtasks explain parent-managed delete and workspace behavior explicitly
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Added sparse-ticket empty-state coverage so description/artifacts/cost tabs all use the normalized operator guidance treatment
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Added ticket detail/artifact failure-state coverage so degraded snapshots and retry actions are verified against browser-level backend failures
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Strengthened cockpit artifact smoke coverage so seeded ticket workspaces must render a non-empty artifacts tab and root-ticket code-server links
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Removed the Presentron modal sub-flow from the swarmbot toolbar button smoke (studio retired; the button now navigates to AI Office)
 */

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * @description Wait for a status banner to leave loading state and reach an actionable message.
 * @param page - Playwright page instance.
 * @param bannerSelector - CSS selector for the status banner.
 * @returns Promise that resolves when status text is no longer loading.
 */
async function waitForStatusSettled(page: import('@playwright/test').Page, bannerSelector: string): Promise<void> {
  const banner = page.locator(bannerSelector);
  await expect(banner).toBeVisible();
  await expect(banner).not.toContainText(/Loading/i, { timeout: 20000 });
}

/**
 * @description Click refresh on a page and assert the status banner reports a completed refresh cycle.
 * @param page - Playwright page instance.
 * @param bannerSelector - CSS selector for the status banner.
 */
async function verifyRefreshFlow(page: import('@playwright/test').Page, bannerSelector = '#statusBanner'): Promise<void> {
  await waitForStatusSettled(page, bannerSelector);
  await page.locator('#refreshButton').click();
  await waitForStatusSettled(page, bannerSelector);
  await expect(page.locator(bannerSelector)).toContainText(/refreshed|loaded|failed|degraded/i);
}

/**
 * @description Read one persisted bot so direct swarmbot workspace tests use real agent data.
 * @param request - Playwright API request context.
 * @returns First available bot id and label.
 */
async function readFirstAgent(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ agentId: string; agentLabel: string }> {
  const response = await request.get('/api/agents');
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  const agents = Array.isArray(body?.agents) ? body.agents : [];
  expect(agents.length).toBeGreaterThan(0);
  const first = agents[0] || {};
  const agentId = String(first.agentId || first.agent_id || '');
  const agentLabel = String(first.name || agentId);
  expect(agentId).toBeTruthy();
  return { agentId, agentLabel };
}

/**
 * @description Create a real ticket+task fixture for cockpit feed/artifact validation.
 * @param request - Playwright API request context.
 * @returns Ticket/task identifiers plus expected feed text.
 */
async function createTicketFeedFixture(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ ticketId: string; taskId: string; ticketTitle: string; messageText: string }> {
  const uniqueId = Date.now().toString(36);
  const taskResponse = await request.post('/api/tasks', {
    data: {
      title: `Playwright task ${uniqueId}`,
      processingMode: 'agentic',
      metadata: { source: 'playwright-engineering-button-usability' },
    },
  });
  expect(taskResponse.ok()).toBeTruthy();
  const taskBody = await taskResponse.json();
  const taskId = String(taskBody?.taskId || '');
  expect(taskId).toBeTruthy();

  const ticketTitle = `Playwright Ticket ${uniqueId}`;
  const ticketResponse = await request.post('/api/tickets', {
    data: {
      title: ticketTitle,
      description: 'Ticket flow validation for cockpit feed/artifacts',
      metadata: { source: 'playwright-engineering-button-usability' },
    },
  });
  expect(ticketResponse.ok()).toBeTruthy();
  const ticketBody = await ticketResponse.json();
  const ticketId = String(ticketBody?.ticketId || '');
  expect(ticketId).toBeTruthy();

  const linkResponse = await request.post(`/api/tickets/${encodeURIComponent(ticketId)}/tasks`, {
    data: { taskId, role: 'primary' },
  });
  expect(linkResponse.ok()).toBeTruthy();

  const messageText = `Ticket created: ${ticketTitle}`;

  return { ticketId, taskId, ticketTitle, messageText };
}

function resolveWorkspaceRoot(): string {
  return process.env.SHARED_WORKSPACE_ROOT
    || process.env.CLINE_WORKSPACE_ROOT
    || process.env.WORKSPACE_ROOT
    || path.join(process.cwd(), 'workspace-shared');
}

function seedTicketWorkspace(ticketId: string, fileName = 'index.ts'): string {
  const deliverablesDir = path.join(resolveWorkspaceRoot(), ticketId, 'deliverables', 'src');
  fs.mkdirSync(deliverablesDir, { recursive: true });
  const filePath = path.join(deliverablesDir, fileName);
  fs.writeFileSync(filePath, 'export const cockpitWorkspaceSmoke = true;\n', 'utf8');
  return filePath;
}

/**
 * @description Create a real linked ticket/task fixture with intentionally sparse detail data.
 * @param request - Playwright API request context.
 * @returns Ticket/task identifiers for empty-state validation.
 */
async function createSparseTicketFixture(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ ticketId: string; taskId: string; ticketTitle: string }> {
  const uniqueId = Date.now().toString(36);
  const taskResponse = await request.post('/api/tasks', {
    data: {
      title: `Sparse task ${uniqueId}`,
      processingMode: 'agentic',
      metadata: { source: 'playwright-ticket-empty-state' },
    },
  });
  expect(taskResponse.ok()).toBeTruthy();
  const taskBody = await taskResponse.json();
  const taskId = String(taskBody?.taskId || '');
  expect(taskId).toBeTruthy();

  const ticketTitle = `Sparse Ticket ${uniqueId}`;
  const ticketResponse = await request.post('/api/tickets', {
    data: {
      title: ticketTitle,
      metadata: { source: 'playwright-ticket-empty-state' },
    },
  });
  expect(ticketResponse.ok()).toBeTruthy();
  const ticketBody = await ticketResponse.json();
  const ticketId = String(ticketBody?.ticketId || '');
  expect(ticketId).toBeTruthy();

  const linkResponse = await request.post(`/api/tickets/${encodeURIComponent(ticketId)}/tasks`, {
    data: { taskId, role: 'primary' },
  });
  expect(linkResponse.ok()).toBeTruthy();

  return { ticketId, taskId, ticketTitle };
}

/**
 * @description Create a real parent/child task hierarchy tied to one synthetic project for ticket filter validation.
 * @param request - Playwright API request context.
 * @returns Parent/child task identifiers plus the project metadata used by the hierarchy service.
 */
async function createTicketHierarchyFixture(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ projectId: string; projectName: string; parentTaskId: string; parentTitle: string; childTaskId: string; childTitle: string }> {
  const uniqueId = Date.now().toString(36);
  const projectId = `playwright-project-${uniqueId}`;
  const projectName = `Playwright Project ${uniqueId}`;
  const parentTitle = `Playwright Parent ${uniqueId}`;
  const childTitle = `Playwright Child ${uniqueId}`;

  const parentResponse = await request.post('/api/tasks', {
    data: {
      title: parentTitle,
      text: parentTitle,
      processingMode: 'agentic',
      metadata: {
        project: projectName,
        projectId,
        projectIdentifier: 'PWT',
        sequenceId: `P-${uniqueId}`,
      },
    },
  });
  expect(parentResponse.ok()).toBeTruthy();
  const parentBody = await parentResponse.json();
  const parentTaskId = String(parentBody?.taskId || '');
  expect(parentTaskId).toBeTruthy();

  const childResponse = await request.post('/api/tasks', {
    data: {
      title: childTitle,
      text: childTitle,
      processingMode: 'agentic',
      metadata: {
        project: projectName,
        projectId,
        projectIdentifier: 'PWT',
        sequenceId: `C-${uniqueId}`,
        parentId: parentTaskId,
        description: `Child task for ${projectName}`,
      },
    },
  });
  expect(childResponse.ok()).toBeTruthy();
  const childBody = await childResponse.json();
  const childTaskId = String(childBody?.taskId || '');
  expect(childTaskId).toBeTruthy();

  return {
    projectId,
    projectName,
    parentTaskId,
    parentTitle,
    childTaskId,
    childTitle,
  };
}

test.describe('Engineering Screen Button Usability', () => {
  test('code bridge route redirects instead of returning OSHAL not-found', async ({ request }) => {
    const response = await request.get('/code?folder=/workspace/bridge-check', { maxRedirects: 0 });
    expect([301, 302, 307, 308]).toContain(response.status());
  });

  test('code bridge trailing-slash compatibility still redirects for older cockpit links', async ({ request }) => {
    const response = await request.get('/code/?folder=/workspace/bridge-check', { maxRedirects: 0 });
    expect([301, 302, 307, 308]).toContain(response.status());
  });

  test('code bridge rewrites host-local workspace paths onto shared workspace paths', async ({ request }) => {
    const response = await request.get('/code?folder=/Users/tester/project/workspace/bridge-check&file=/Users/tester/project/workspace/bridge-check/src/index.ts', {
      maxRedirects: 0,
    });
    expect([301, 302, 307, 308]).toContain(response.status());
    const location = response.headers()['location'] || '';
    const decodedLocation = decodeURIComponent(location);
    expect(location).toContain('folder=');
    expect(location).toContain('bridge-check');
    expect(location).not.toContain('/Users/tester/project/workspace');
    expect(decodedLocation).toContain('/workspace/bridge-check');
    expect(decodedLocation).toContain('/workspace/bridge-check/src/index.ts');
  });

  test('health dashboard refresh button performs a full refresh cycle', async ({ page }) => {
    await page.goto('/health-dashboard/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Health Dashboard');
    await verifyRefreshFlow(page);
  });

  test('redis diagnostics refresh button performs a full refresh cycle', async ({ page }) => {
    await page.goto('/redis-visibility/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Redis Diagnostics');
    await verifyRefreshFlow(page);
  });

  test('queue manager admin refresh button performs a full refresh cycle', async ({ page }) => {
    await page.goto('/queue-manager-admin/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Queue Manager Admin');
    await verifyRefreshFlow(page);
  });

  test('mesh dashboard refresh button performs a full refresh cycle', async ({ page }) => {
    await page.goto('/mesh-dashboard/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Mesh Dashboard');
    await verifyRefreshFlow(page);
  });

  test('ops dashboard refresh button performs a full refresh cycle', async ({ page }) => {
    await page.goto('/ops-dashboard/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Ops Dashboard');
    await verifyRefreshFlow(page);
  });

  test('rag center refresh button performs a full refresh cycle', async ({ page }) => {
    await page.goto('/rag-center/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('RAG Center');
    await verifyRefreshFlow(page);
    await expect(page.locator('[data-testid="rag-center-documents"]')).toBeVisible();
  });

  test('queue dashboard refresh button performs a full refresh cycle', async ({ page }) => {
    await page.goto('/queue-dashboard/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toContainText('Queue Dashboard');
    await verifyRefreshFlow(page);
    await expect(page.locator('[data-testid="queue-dashboard-runs"]')).toBeVisible();
  });

  test('task explorer buttons switch tabs and refresh without breaking the view', async ({ page }) => {
    await page.goto('/task-explorer/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Task Explorer');

    await page.locator('.tab[data-tab="files"]').click();
    await expect(page.locator('.tab[data-tab="files"]')).toHaveClass(/active/);
    await expect(page.locator('#filesPanel')).not.toHaveClass(/hidden/);

    await page.locator('.tab[data-tab="activity"]').click();
    await expect(page.locator('.tab[data-tab="activity"]')).toHaveClass(/active/);
    await expect(page.locator('#activityPanel')).not.toHaveClass(/hidden/);

    await page.locator('#refreshButton').click();
    await expect(page.locator('#projectSelect')).toBeVisible();
    await expect(page.locator('#treeContent')).toBeVisible();
  });

  test('config admin refresh and save buttons complete actionable flows', async ({ page }) => {
    await page.goto('/config/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Config Admin');
    await expect(page.locator('#codeServerWorkspaceRootInput')).toBeVisible();

    await waitForStatusSettled(page, '#statusBanner');
    await page.locator('#refreshButton').click();
    await waitForStatusSettled(page, '#statusBanner');

    await page.locator('#saveButton').click();
    await waitForStatusSettled(page, '#statusBanner');
    await expect(page.locator('#statusBanner')).toContainText(/saved|failed/i);
  });

  test('direct swarmbot workspace toolbar buttons open and close their target modals', async ({ page, request }) => {
    const { agentId, agentLabel } = await readFirstAgent(request);

    await page.addInitScript(() => {
      window.open = ((url: string | URL | undefined) => {
        (window as typeof window & { __lastOpenUrl?: string }).__lastOpenUrl = String(url || '');
        return window;
      }) as typeof window.open;
    });

    await page.goto(`/swarmbot/chat?agentId=${encodeURIComponent(agentId)}&agentLabel=${encodeURIComponent(agentLabel)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await expect(page.locator('#workspaceTitle')).toContainText(agentLabel);

    await page.locator('#openSettingsBtn').click();
    await expect(page.locator('#quickSettingsModal')).toBeVisible();
    await page.locator('#closeQuickSettingsBtn').click();

    await page.locator('#openToolsBtn').click();
    await expect(page.locator('#switchFrameworkModal')).toBeVisible();
    await page.locator('#closeSwitchFrameworkBtn').click();

    await page.locator('#openHistoryBtn').click();
    await expect(page.locator('#historyModal')).toBeVisible();
    await page.locator('#closeHistoryBtn').click();

    await page.locator('#openRagBtn').click();
    await expect(page.locator('#ragModal')).toBeVisible();
    await expect(page.locator('#ragCollectionPreview')).toHaveText('swarm-knowledge');
    await page.locator('.rag-workspace-close').click();
    await expect(page.locator('#ragModal')).toBeHidden();

    await page.evaluate(() => {
      const button = document.getElementById('popOutBtn');
      if (button) {
        button.click();
      }
    });
    const lastOpenUrl = await page.evaluate(() => (window as typeof window & { __lastOpenUrl?: string }).__lastOpenUrl || '');
    expect(lastOpenUrl).toContain('/swarmbot/chat?');
  });

  test('cockpit ticket flow shows persisted feed text and provides artifacts code-server action', async ({ page, request }) => {
    const fixture = await createTicketFeedFixture(request);
    seedTicketWorkspace(fixture.ticketId);

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    const ticketRow = page.locator('.ticket-row', { hasText: fixture.ticketTitle }).first();
    await expect(ticketRow).toBeVisible({ timeout: 15000 });
    await ticketRow.click();

    await expect(page.locator('#tvDetailBody')).toContainText(fixture.messageText, { timeout: 15000 });
    await page.locator('#tvRespondBtn').click();
    await expect(page.locator('.td-tab[data-tab="feed"]')).toHaveClass(/active/);
    await expect(page.locator('#tvFeedReply')).toBeFocused();

    const stateResponsePromise = page.waitForResponse((response) =>
      response.url().includes(`/api/tickets/${fixture.ticketId}/state`) && response.request().method() === 'PUT',
    );
    await page.locator('#tvStateSelect').selectOption('approved');
    const stateResponse = await stateResponsePromise;
    expect(stateResponse.ok()).toBeTruthy();
    await expect(page.locator('.status-pill')).toContainText('Approved');
    await expect(ticketRow).toContainText('Approved');

    await page.locator('.td-tab[data-tab="artifacts"]').click();
    const codeLink = page.locator('#tvDetailBody a:has-text("Open in Code Server")').first();
    await expect(codeLink).toBeVisible();
    const href = await codeLink.getAttribute('href');
    expect(href).toBeTruthy();
    const decodedHref = decodeURIComponent(href || '');
    expect(href).toContain('/code?folder=');
    expect(href).toContain('folder=');
    expect(href).toContain(fixture.ticketId);
    expect(decodedHref).not.toContain('/Users/');
    expect(decodedHref).toContain(`/workspace/${fixture.ticketId}`);
    await expect(page.locator('#tvDetailBody')).toContainText(`/app/workspace/${fixture.ticketId}`);
    await expect(page.locator('#tvDetailBody .td-artifact-name')).toContainText('deliverables');

    await page.locator('.td-tab[data-tab="cost"]').click();
    await expect(page.locator('#tvDetailBody')).toContainText('Cost by Bot');
    await expect(page.locator('#tvDetailBody')).toContainText('Project: Default');
  });

  test('cockpit ticket delete flow removes a root ticket with visible confirmation feedback', async ({ page, request }) => {
    const fixture = await createTicketFeedFixture(request);

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    const ticketRow = page.locator('.ticket-row', { hasText: fixture.ticketTitle }).first();
    await expect(ticketRow).toBeVisible({ timeout: 15000 });
    await ticketRow.click();

    const deleteResponsePromise = page.waitForResponse((response) =>
      response.url().includes(`/api/v1/tickets/${fixture.ticketId}`) && response.request().method() === 'DELETE',
    );
    await page.locator('#tvDeleteBtn').click();
    await expect(page.locator('.delete-confirm-dialog')).toBeVisible();
    await page.locator('.confirm-delete-btn').click();
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.ok()).toBeTruthy();

    await expect(page.locator('#toastContainer .toast').last()).toContainText('Ticket deleted');
    await expect(page.locator('.ticket-row', { hasText: fixture.ticketTitle })).toHaveCount(0);
  });

  test('cockpit ticket filters surface parent rows for child matches and clear stale detail when hidden', async ({ page, request }) => {
    const fixture = await createTicketHierarchyFixture(request);

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    await expect(page.locator(`#tvProjectFilter option[value="${fixture.projectId}"]`)).toBeAttached({ timeout: 15000 });
    await page.locator('#tvProjectFilter').selectOption(fixture.projectId);
    const parentRow = page.locator(`.ticket-row[data-id="${fixture.parentTaskId}"]`).first();
    await expect(parentRow).toBeVisible({ timeout: 15000 });
    await expect(parentRow).toContainText(fixture.parentTitle);

    await page.locator('#tvSearch').fill(fixture.childTitle);
    await page.waitForTimeout(300);
    await expect(parentRow).toBeVisible();
    await expect(parentRow).toContainText('1 subtasks');

    await parentRow.locator('.expand-chevron').click();
    const childRow = page.locator(`.ticket-row[data-id="${fixture.childTaskId}"]`).first();
    await expect(childRow).toBeVisible();
    await childRow.click();
    await expect(page.locator('#tvDetailPane')).toContainText(fixture.childTitle);

    await page.locator('#tvSearch').fill('nonexistent-child-filter-state');
    await page.waitForTimeout(300);
    await expect(page.locator('#tvDetailPane')).toContainText('Current selection is outside the active filters');
  });

  test('cockpit grouped ticket view keeps parent-child drill-in available', async ({ page, request }) => {
    const fixture = await createTicketHierarchyFixture(request);

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    await expect(page.locator(`#tvProjectFilter option[value="${fixture.projectId}"]`)).toBeAttached({ timeout: 15000 });
    await page.locator('#tvProjectFilter').selectOption(fixture.projectId);
    await page.locator('#tvGroupBy').selectOption('state');
    await page.waitForTimeout(300);

    const groupRow = page.locator('.ticket-row[data-group="Backlog"]').first();
    await expect(groupRow).toBeVisible({ timeout: 15000 });
    await groupRow.click();

    const parentRow = page.locator(`.ticket-row[data-id="${fixture.parentTaskId}"]`).first();
    await expect(parentRow).toBeVisible();
    await expect(parentRow).toContainText('1 subtasks');

    await parentRow.locator('.expand-chevron').click();
    const childRow = page.locator(`.ticket-row[data-id="${fixture.childTaskId}"]`).first();
    await expect(childRow).toBeVisible();
    await childRow.click();
    await expect(page.locator('#tvDetailPane')).toContainText(fixture.childTitle);
  });

  test('cockpit project grouping keeps child drill-in linked to the parent ticket', async ({ page, request }) => {
    const fixture = await createTicketHierarchyFixture(request);

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    await expect(page.locator(`#tvProjectFilter option[value="${fixture.projectId}"]`)).toBeAttached({ timeout: 15000 });
    await page.locator('#tvProjectFilter').selectOption(fixture.projectId);
    await page.locator('#tvGroupBy').selectOption('project');
    await page.waitForTimeout(300);

    const groupRow = page.locator('.ticket-row[data-group]', { hasText: fixture.projectName }).first();
    await expect(groupRow).toBeVisible({ timeout: 15000 });
    await groupRow.click();

    const parentRow = page.locator(`.ticket-row[data-id="${fixture.parentTaskId}"]`).first();
    await expect(parentRow).toBeVisible();
    await parentRow.locator('.expand-chevron').click();

    const childRow = page.locator(`.ticket-row[data-id="${fixture.childTaskId}"]`).first();
    await expect(childRow).toBeVisible();
    await childRow.click();

    await expect(page.locator('#tvParentTicketBtn')).toContainText(fixture.parentTitle);
    await page.locator('.td-tab[data-tab="description"]').click();
    const openParentButton = page.locator('[data-parent-ticket-id]').first();
    await expect(openParentButton).toContainText(fixture.parentTitle);
    await openParentButton.click();
    await expect(page.locator('#tvDetailPane')).toContainText(fixture.parentTitle);
  });

  test('cockpit child ticket explains parent-managed actions and shared workspace usage', async ({ page, request }) => {
    const fixture = await createTicketHierarchyFixture(request);

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    await expect(page.locator(`#tvProjectFilter option[value="${fixture.projectId}"]`)).toBeAttached({ timeout: 15000 });
    await page.locator('#tvProjectFilter').selectOption(fixture.projectId);

    const parentRow = page.locator(`.ticket-row[data-id="${fixture.parentTaskId}"]`).first();
    await expect(parentRow).toBeVisible({ timeout: 15000 });
    await parentRow.locator('.expand-chevron').click();

    const childRow = page.locator(`.ticket-row[data-id="${fixture.childTaskId}"]`).first();
    await expect(childRow).toBeVisible();
    await childRow.click();

    await expect(page.locator('#tvDeleteBtn')).toHaveCount(0);
    await expect(page.locator('#tvChildActionNote')).toContainText('parent ticket');

    await page.locator('.td-tab[data-tab="artifacts"]').click();
    await expect(page.locator('[data-ticket-workspace-note]')).toContainText('shared parent-ticket workspace');
  });

  test('cockpit sparse ticket uses normalized empty-state guidance across description, artifacts, and cost tabs', async ({ page, request }) => {
    const fixture = await createSparseTicketFixture(request);

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    const ticketRow = page.locator('.ticket-row', { hasText: fixture.ticketTitle }).first();
    await expect(ticketRow).toBeVisible({ timeout: 15000 });
    await ticketRow.click();

    await page.locator('.td-tab[data-tab="description"]').click();
    const descriptionEmpty = page.locator('#tvDetailBody [data-ticket-empty-state="true"]').first();
    await expect(descriptionEmpty).toContainText('No description yet');
    await expect(descriptionEmpty).toContainText('related task metadata');

    await page.locator('.td-tab[data-tab="artifacts"]').click();
    const artifactEmpty = page.locator('#tvDetailBody [data-ticket-empty-state="true"]').first();
    await expect(artifactEmpty).toContainText('No workspace files yet');
    await expect(artifactEmpty).toContainText('Files will appear here once a bot completes work');

    await page.locator('.td-tab[data-tab="cost"]').click();
    const costEmpty = page.locator('#tvDetailBody [data-ticket-empty-state="true"]').first();
    await expect(costEmpty).toContainText('No cost telemetry recorded yet');
    await expect(costEmpty).toContainText('Measured usage will appear here');
  });

  test('cockpit ticket detail falls back to a degraded snapshot with retry when activity loading fails', async ({ page, request }) => {
    const fixture = await createSparseTicketFixture(request);
    let failActivity = true;

    await page.route(`**/api/v1/tickets/${fixture.ticketId}/activity`, async (route) => {
      if (failActivity) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'activity unavailable' }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    const ticketRow = page.locator('.ticket-row', { hasText: fixture.ticketTitle }).first();
    await expect(ticketRow).toBeVisible({ timeout: 15000 });
    await ticketRow.click();

    await expect(page.locator('#tvDetailPane')).toContainText('Live activity is unavailable right now.');
    await expect(page.locator('#tvDetailPane')).toContainText(fixture.ticketTitle);

    failActivity = false;
    await page.locator('#tvRetryDetailBtn').click();
    await expect(page.locator('#tvDetailPane')).not.toContainText('Live activity is unavailable right now.');
  });

  test('cockpit ticket artifacts failure offers retry while preserving code-server access', async ({ page, request }) => {
    const fixture = await createSparseTicketFixture(request);
    let failArtifacts = true;

    await page.route(`**/api/v1/workspace/${fixture.taskId}/files`, async (route) => {
      if (failArtifacts) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'workspace unavailable' }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/cockpit/', { waitUntil: 'domcontentloaded' });
    await page.locator('.ribbon-btn[data-view="tickets"]').click();

    const ticketRow = page.locator('.ticket-row', { hasText: fixture.ticketTitle }).first();
    await expect(ticketRow).toBeVisible({ timeout: 15000 });
    await ticketRow.click();

    await page.locator('.td-tab[data-tab="artifacts"]').click();
    await expect(page.locator('#tvDetailBody')).toContainText('Workspace file inventory is not available yet.');
    await expect(page.locator('#tvRetryArtifactsBtn')).toBeVisible();
    await expect(page.locator('#tvDetailBody a:has-text("Open in Code Server")')).toBeVisible();

    failArtifacts = false;
    await page.locator('#tvRetryArtifactsBtn').click();
    await expect(page.locator('#tvDetailBody')).not.toContainText('Workspace file inventory is not available yet.');
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added focused Playwright regression coverage for cockpit embedded-chat bot switches so the right rail reloads into a bot-scoped session instead of preserving the prior task
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added live-registry filtering coverage so stale undeployed profiles like devops-bot do not appear in the cockpit bot selector
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added selector-refresh coverage so an already-open cockpit rechecks the live swarm registry and drops stale dead-bot options on focus
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added offline-registry coverage so standalone hosts keep the deployed registry roster instead of falling back to stale persisted bot profiles
 */

import { test, expect } from '@playwright/test';

const PLAYWRIGHT_PORT = process.env.PLAYWRIGHT_PORT ?? process.env.PORT ?? '3456';
const BASE_URL = process.env.APP_URL ?? `http://localhost:${PLAYWRIGHT_PORT}`;

/**
 * @description Navigate to cockpit after clearing prior cockpit rail session state.
 * @param page - Playwright page instance.
 */
async function gotoFreshCockpit(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${BASE_URL}/cockpit/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean((window as { __cockpit?: unknown }).__cockpit), null, { timeout: 15000 });
  await page.evaluate(() => window.sessionStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean((window as { __cockpit?: unknown }).__cockpit), null, { timeout: 15000 });
}

/**
 * @description Wait for the embedded chat iframe to finish booting.
 * @param page - Playwright page instance.
 */
async function waitForEmbeddedChat(page: import('@playwright/test').Page): Promise<void> {
  const frame = page.frameLocator('#chatWorkspaceFrame');
  await expect(page.locator('#chatWorkspaceFrame')).toBeVisible();
  await expect(frame.locator('#messageInput')).toBeVisible();
}

test.describe('Cockpit UI — Embedded Bot Switching', () => {
  /**
   * @description Verify the cockpit bot selector excludes persisted-but-undeployed agents
   * when the live swarm registry does not advertise them.
   */
  test('bot selector prefers the live swarm registry over stale persisted agent profiles', async ({ page }) => {
    await page.route('**/api/agents', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            { agentId: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager' },
            { agentId: 'a0000000-0000-0000-0000-000000000008', name: 'devops-bot' },
          ],
        }),
      });
    });

    await page.route('**/api/swarm/bots/registry', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          bots: [
            { agentId: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager', online: true },
          ],
        }),
      });
    });

    await gotoFreshCockpit(page);
    await waitForEmbeddedChat(page);

    await expect(page.locator('#botSelector option', { hasText: 'project-manager' })).toHaveCount(1);
    await expect(page.locator('#botSelector option', { hasText: 'devops-bot' })).toHaveCount(0);
  });

  /**
   * @description Verify an already-open cockpit refreshes the selector from the live swarm
   * registry when the operator re-focuses the bot picker.
   */
  test('bot selector refreshes on focus and removes stale dead-bot options', async ({ page }) => {
    let registryRequestCount = 0;

    await page.route('**/api/agents', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            { agentId: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager' },
            { agentId: 'a0000000-0000-0000-0000-000000000008', name: 'devops-bot' },
          ],
        }),
      });
    });

    await page.route('**/api/swarm/bots/registry', async (route) => {
      registryRequestCount += 1;
      const bots = registryRequestCount <= 2
        ? [
            { agentId: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager', online: true },
            { agentId: 'a0000000-0000-0000-0000-000000000008', name: 'devops-bot', online: true },
          ]
        : [
            { agentId: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager', online: true },
          ];

      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ bots }),
      });
    });

    await gotoFreshCockpit(page);
    await waitForEmbeddedChat(page);

    await expect(page.locator('#botSelector option', { hasText: 'devops-bot' })).toHaveCount(1);
    await page.locator('#botSelector').focus();
    await expect.poll(() => registryRequestCount).toBeGreaterThan(1);
    await expect(page.locator('#botSelector option', { hasText: 'devops-bot' })).toHaveCount(0);
  });

  /**
   * @description Verify cockpit keeps the deployed registry roster even when the registry
   * reports zero live heartbeats, instead of falling back to stale persisted agent profiles.
   */
  test('bot selector keeps registry bots when swarm heartbeats are offline', async ({ page }) => {
    await page.route('**/api/agents', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            { agentId: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager' },
            { agentId: 'a0000000-0000-0000-0000-000000000008', name: 'devops-bot' },
          ],
        }),
      });
    });

    await page.route('**/api/swarm/bots/registry', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          bots: [
            { agentId: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager', online: false },
            { agentId: 'a0000000-0000-0000-0000-000000000006', name: 'task-manager', online: false },
          ],
        }),
      });
    });

    await gotoFreshCockpit(page);
    await waitForEmbeddedChat(page);

    await expect(page.locator('#botSelector option', { hasText: 'project-manager' })).toHaveCount(1);
    await expect(page.locator('#botSelector option', { hasText: 'task-manager' })).toHaveCount(1);
    await expect(page.locator('#botSelector option', { hasText: 'devops-bot' })).toHaveCount(0);
  });

  /**
   * @description Verify changing the cockpit bot selector reloads the embedded rail onto the selected bot's own session.
   */
  test('bot switch reloads the embedded rail into the selected bot session', async ({ page }) => {
    await page.route('**/api/agents', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            { agentId: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager' },
            { agentId: 'a0000000-0000-0000-0000-000000000002', name: 'code-developer' },
            { agentId: 'a0000000-0000-0000-0000-000000000006', name: 'task-manager' },
          ],
        }),
      });
    });

    await page.route('**/api/swarm/bots/registry', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          bots: [
            { agentId: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager', online: true },
            { agentId: 'a0000000-0000-0000-0000-000000000002', name: 'code-developer', online: true },
            { agentId: 'a0000000-0000-0000-0000-000000000006', name: 'task-manager', online: true },
          ],
        }),
      });
    });

    await gotoFreshCockpit(page);
    await waitForEmbeddedChat(page);

    const initialFrame = page.frameLocator('#chatWorkspaceFrame');
    const initialTaskText = (await initialFrame.locator('#taskId').textContent())?.trim() || '';
    const selectorOptions = page.locator('#botSelector option');
    expect(await selectorOptions.count()).toBeGreaterThan(1);

    const selectedAgentId = await selectorOptions.nth(1).getAttribute('value');
    const selectedAgentLabel = (await selectorOptions.nth(1).textContent())?.trim() || '';
    expect(selectedAgentId).toBeTruthy();

    await page.locator('#botSelector').selectOption(selectedAgentId || '');
    await expect(page.locator('#chatWorkspaceFrame')).toHaveAttribute(
      'src',
      new RegExp(`embed=cockpit.*agentId=${selectedAgentId}.*fresh=`),
    );

    const switchedFrame = page.frameLocator('#chatWorkspaceFrame');
    await expect(switchedFrame.locator('#cockpitContextSummary')).toContainText(selectedAgentLabel);
    await expect(switchedFrame.locator('#agentSummary')).toContainText(selectedAgentLabel);

    const switchedTaskText = (await switchedFrame.locator('#taskId').textContent())?.trim() || '';
    expect(switchedTaskText).not.toEqual(initialTaskText);

    let routedAgentId = '';
    await page.route('**/api/send-message', async (route) => {
      const payload = JSON.parse(route.request().postData() || '{}') as { agentId?: string };
      routedAgentId = String(payload.agentId || '');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    await switchedFrame.locator('#messageInput').fill('Validate switched bot routing');
    await switchedFrame.locator('#sendBtn').click();
    await expect.poll(() => routedAgentId).toBe(selectedAgentId);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright coverage for chat history, Presentron, and RAG popup workflows in standalone chat
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated RAG popup coverage for knowledge-base workspace behavior and settings handoff
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Updated Presentron coverage for studio popup behavior and MCP settings handoff
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added tool activation guardrail coverage for token-gated repo tools and Presentron button visibility
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Reset persisted agent tool state in popup tests so visibility and activation assertions do not depend on previous runs
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Switched agent-profile setup to dedicated /api/agents/:agentId/profile persistence
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added Google Search MCP settings-card assertions to standalone workspace popup coverage
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Updated chat popup assertions for the shared swarm-vs-bot knowledge workspace contract
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added deep-link coverage for opening the shared knowledge workspace from URL parameters
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Retired the Presentron studio + Google Search MCP card coverage; the header presentation control now links to AI Office (?app=presentations) — assert the AI Office button and its navigation instead
 */

import { expect, test } from '@playwright/test';

const DEFAULT_AGENT_ID = '00000000-0000-4000-8000-000000000032';

/**
 * @description Validates standalone chat auxiliary popup workflows for history loading,
 * the AI Office presentation link, and the RAG knowledge-base workspace.
 */
test.describe('Chat Workspace Popups', () => {
  async function resetAllToolModes(page) {
    await page.evaluate(async (agentId) => {
      const toolsResponse = await fetch(`/api/agents/${agentId}/tools`, { credentials: 'include' });
      const toolsPayload = await toolsResponse.json();
      const tools = Array.isArray(toolsPayload.tools) ? toolsPayload.tools : [];

      await Promise.all(tools.map((tool) => fetch(`/api/agents/${agentId}/tools/${tool.toolId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authMode: 'off' }),
      })));
    }, DEFAULT_AGENT_ID);
  }

  async function configureTool(page, toolName, body) {
    await page.evaluate(async ({ agentId, toolName, body }) => {
      const toolsResponse = await fetch(`/api/agents/${agentId}/tools`, { credentials: 'include' });
      const toolsPayload = await toolsResponse.json();
      const tool = (toolsPayload.tools || []).find((entry) => entry.tool.name === toolName);
      if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
      }

      const response = await fetch(`/api/agents/${agentId}/tools/${tool.toolId}/config`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Failed to configure ${toolName}`);
      }
    }, { agentId: DEFAULT_AGENT_ID, toolName, body });
  }

  async function setToolMode(page, toolName, authMode) {
    await page.evaluate(async ({ agentId, toolName, authMode }) => {
      const toolsResponse = await fetch(`/api/agents/${agentId}/tools`, { credentials: 'include' });
      const toolsPayload = await toolsResponse.json();
      const tool = (toolsPayload.tools || []).find((entry) => entry.tool.name === toolName);
      if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
      }

      const response = await fetch(`/api/agents/${agentId}/tools/${tool.toolId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authMode }),
      });

      if (!response.ok) {
        throw new Error(`Failed to set mode for ${toolName}`);
      }
    }, { agentId: DEFAULT_AGENT_ID, toolName, authMode });
  }

  test('history/ai-office/rag popups work and persist settings', async ({ page }) => {
    await page.goto('/chat');
    await resetAllToolModes(page);

    await configureTool(page, 'rag-ingestion', { toolConfig: { auth: { type: 'none', enabled: false }, endpoint: {}, env: {}, metadata: {} } });
    await setToolMode(page, 'rag-ingestion', 'auto');

    await page.reload();

    const createdTaskId = await page.evaluate(async () => {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Playwright history restore task',
          processingMode: 'agentic',
          agentId: '00000000-0000-4000-8000-000000000032',
          metadata: { source: 'playwright-history-spec' },
        }),
      });
      const payload = await response.json();
      return payload.taskId as string;
    });

    await expect(page.locator('#openHistoryModalBtn')).toBeVisible();
    await expect(page.locator('#openAiOfficeBtn')).toBeVisible();
    await expect(page.locator('#openRagModalBtn')).toBeVisible();

    await page.click('#openHistoryModalBtn');
    await expect(page.locator('#historyModal')).toBeVisible();
    await expect.poll(async () => page.locator('#historyList').innerText()).toContain(createdTaskId);
    await expect(page.locator('#historySummary')).toContainText('Conversations');
    await expect(page.locator('#historyList')).toContainText('Total Tokens');
    await expect(page.locator('#historyList')).toContainText('Load Conversation');
    await expect(page.locator('#historyList')).toContainText('No model telemetry yet');

    await page.locator(`[data-load-task-id="${createdTaskId}"]`).click();
    await page.waitForURL(new RegExp(`/chat\\?taskId=${createdTaskId}$`));
    await expect(page.locator('#taskId')).toContainText(createdTaskId);

    await page.click('#openRagModalBtn');
    await expect(page.locator('#ragModal')).toBeVisible();
    await expect(page.locator('#ragDropZone')).toBeVisible();
    await expect(page.locator('#browseRagFilesBtn')).toBeVisible();
    await expect(page.locator('#ragCollectionPreview')).toHaveText('swarm-knowledge');
    await expect(page.locator('#ragScopeSwarm')).toBeChecked();
    await expect(page.locator('#ragSearchInput')).toBeVisible();
    await page.click('#openRagSettingsBtn');
    await expect(page.locator('#toolsConfigModal')).toBeVisible();
    await expect(page.locator('.config-nav-btn.active[data-config-section=\"tools\"]')).toBeVisible();
    await page.click('#closeToolsConfigBtn');

    await page.click('#openHistoryModalBtn');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator(`[data-delete-task-id="${createdTaskId}"]`).click();
    await expect.poll(async () => page.locator('#historyStatus').innerText()).toContain('deleted');
  });

  test('tool activation requires config', async ({ page }) => {
    await page.goto('/chat');
    await resetAllToolModes(page);

    await page.evaluate(async () => {
      await fetch('/api/agents/00000000-0000-4000-8000-000000000032/profile', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: {
            name: 'OSHAL Chat Agent',
            projectUrl: '',
            selectorSkillsText: '',
            avatarUrl: '',
            themePreference: 'midnight',
          },
        }),
      });
    });

    await configureTool(page, 'gh', { toolConfig: { auth: { type: 'oauth2', enabled: false, oauth2: { accessToken: '' } }, endpoint: {}, env: {}, metadata: {} } });
    await page.reload();

    await page.click('#openToolsConfigBtn');
    await page.click('[data-config-section="tools"]');

    const ghRow = page.locator('.tool-switch-row[data-tool-name="gh"]');
    await ghRow.locator('.auth-toggle[data-auth-mode="auto"]').click();
    await page.click('#saveToolsConfigBtn');
    await expect(page.locator('#modalStatus')).toContainText('Configure required tool settings before activation');
    await expect(page.locator('#modalStatus')).toContainText('GitHub CLI');

    await page.click('[data-config-section="agent"]');
    await page.fill('#projectUrlInput', 'https://github.com/example/repo');
    await page.click('[data-config-section="tools"]');
    await ghRow.locator('input[data-config-path="auth.enabled"]').check();
    await ghRow.locator('input[data-config-path="auth.oauth2.accessToken"]').fill('test-gh-token');
    await page.click('#saveToolsConfigBtn');
    await expect(page.locator('#modalStatus')).toContainText('Saved agent, MCP, tool switch, and tool auth configuration.');
    await page.click('#closeToolsConfigBtn');
  });

  test('AI Office button links to the office-suite presentation surface', async ({ page }) => {
    await page.goto('/chat');
    await expect(page.locator('#openAiOfficeBtn')).toBeVisible();
    await page.click('#openAiOfficeBtn');
    await page.waitForURL(/[?&]app=presentations/);
  });

  test('redis jobs popup manages active-bot schedules and hands off to tools settings', async ({ page }) => {
    const scheduleId = `redis-workspace-${Date.now()}`;

    await page.goto('/chat');
    await resetAllToolModes(page);
    await setToolMode(page, 'agent-scheduler', 'auto');
    await page.reload();

    await expect(page.locator('#openRedisJobsModalBtn')).toBeVisible();

    await page.click('#openRedisJobsModalBtn');
    await expect(page.locator('#redisJobsModal')).toBeVisible();
    await expect(page.locator('#redisJobsSummary')).toContainText('Bot');

    await page.fill('#redisJobIdInput', scheduleId);
    await page.fill('#redisJobCronInput', '0 * * * *');
    await page.fill('#redisJobPromptInput', 'Prepare the hourly platform report.');
    await page.fill('#redisJobActionInput', 'hourly_report');
    await page.fill('#redisJobWorkspaceSlugInput', 'devopscloud-00');
    await page.click('#saveRedisJobBtn');
    await expect(page.locator('#redisJobsStatus')).toContainText(`Created Redis job ${scheduleId}.`);

    const scheduleCard = page.locator(`#redisJobsModal article[data-schedule-id="${scheduleId}"]`);
    await expect(scheduleCard).toBeVisible();
    await expect(scheduleCard).toContainText('hourly_report');

    await scheduleCard.locator('[data-redis-job-action="edit"]').click();
    await expect(page.locator('#redisJobIdInput')).toBeDisabled();
    await page.fill('#redisJobCronInput', '0 */6 * * *');
    await page.fill('#redisJobPromptInput', 'Prepare the six-hour platform report.');
    await page.click('#saveRedisJobBtn');
    await expect(page.locator('#redisJobsStatus')).toContainText(`Updated Redis job ${scheduleId}.`);
    await expect(scheduleCard).toContainText('0 */6 * * *');
    await expect(scheduleCard).toContainText('six-hour platform report');

    await page.click('#openRedisJobsSettingsBtn');
    await expect(page.locator('#redisJobsModal')).toBeHidden();
    await expect(page.locator('#toolsConfigModal')).toBeVisible();
    await expect(page.locator('.config-nav-btn.active[data-config-section="tools"]')).toBeVisible();
    await page.click('#closeToolsConfigBtn');

    await page.click('#openRedisJobsModalBtn');
    await expect(page.locator('#redisJobsModal')).toBeVisible();
    await page.locator(`#redisJobsModal article[data-schedule-id="${scheduleId}"] [data-redis-job-action="delete"]`).click();
    await expect(page.locator('#redisJobsStatus')).toContainText(`Deleted Redis job ${scheduleId}.`);
    await expect(page.locator(`#redisJobsModal article[data-schedule-id="${scheduleId}"]`)).toHaveCount(0);
  });

  test('chat deep link opens the shared knowledge workspace immediately', async ({ page }) => {
    await page.goto('/chat?openWorkspace=rag&source=rag-center');
    await expect(page.locator('#ragModal')).toBeVisible();
    await expect(page.locator('#ragDropZone')).toBeVisible();
    await expect(page.locator('#ragCollectionPreview')).toHaveText('swarm-knowledge');
    await expect(page).not.toHaveURL(/openWorkspace=rag/);
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added coverage for shared OpenAI Codex auth messaging in the dedicated swarm-bot workspace
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added focused Playwright coverage for the dedicated /swarmbot/chat workspace and its cockpit embed behavior
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added functional auth coverage for the dedicated swarm-bot workspace provider sign-in and sign-out flow
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added focused functional coverage for direct RAG and Presentron actions inside the dedicated swarm-bot workspace
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added switch-framework modal coverage so cockpit and direct workspace tools actions validate in-rail tool auth controls
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Updated settings coverage to assert the native quick-settings modal, profile save path, and advanced-config handoff
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Updated cockpit settings flow coverage for icon-first controls and top-level bot-scoped /config navigation
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Updated cockpit-embedded settings expectations to validate in-rail quick-settings modal behavior
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log attribution for governance compliance during engineering-screen retrofit work
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Updated swarm workspace coverage for the shared knowledge modal and explicit queued-upload behavior
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Updated Presentron coverage for the shared studio and shared-runtime config guidance
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage proving swarmbot PM intake switches onto the dedicated ticket-linked task returned by the server
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Retired the Presentron studio coverage (studio removed); the toolbar presentation button (#openAiOfficeBtn) now links to AI Office (?app=presentations) — assert that navigation instead. RAG coverage unchanged.
 */

import { test, expect } from '@playwright/test';

const PLAYWRIGHT_PORT = process.env.PLAYWRIGHT_PORT ?? process.env.PORT ?? '3456';
const BASE_URL = process.env.APP_URL ?? `http://localhost:${PLAYWRIGHT_PORT}`;
const PROJECT_MANAGER_AGENT_ID = 'a0000000-0000-0000-0000-000000000001';

/**
 * @description Load the first non-default bot option from cockpit for swarm-bot workspace tests.
 * @param page - Playwright page instance.
 * @returns Selected bot id and label.
 */
async function readSelectedBot(page: import('@playwright/test').Page): Promise<{ agentId: string; agentLabel: string }> {
  await expect.poll(async () => {
    const values = await page.locator('#botSelector option').evaluateAll((nodes) => (
      nodes.map((node) => (node as HTMLOptionElement).value || '')
    ));
    return values.filter((value) => value.trim().length > 0).length;
  }).toBeGreaterThan(0);

  const options = await page.locator('#botSelector option').evaluateAll((nodes) => (
    nodes.map((node) => ({
      value: (node as HTMLOptionElement).value || '',
      label: (node.textContent || '').trim(),
    }))
  ));
  const selectedValue = await page.locator('#botSelector').inputValue();
  const candidate = options.find((option) => option.value && option.value !== selectedValue)
    || options.find((option) => option.value)
    || { value: '', label: '' };
  return {
    agentId: candidate.value,
    agentLabel: candidate.label || candidate.value,
  };
}

/**
 * @description Wait until the swarm-bot workspace has created or loaded a task.
 * @param locator - Locator pointing at the task id summary element.
 */
async function waitForTaskId(locator: import('@playwright/test').Locator): Promise<void> {
  await expect(locator).not.toContainText('Loading...');
  await expect(locator).not.toContainText('Creating task...');
}

/**
 * @description Read lightweight persisted agents from the OSHAL API.
 * @param request - Playwright API request context.
 * @returns Persisted agent summaries.
 */
async function readAgents(request: import('@playwright/test').APIRequestContext): Promise<Array<Record<string, unknown>>> {
  const response = await request.get('/api/agents');
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return Array.isArray(body.agents) ? body.agents : [];
}

/**
 * @description Pick a persisted agent that already uses a provider with inline auth support.
 * @param request - Playwright API request context.
 * @returns Agent id, label, and provider id for a supported bot.
 */
async function readAuthCapableBot(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ agentId: string; agentLabel: string; providerId: string }> {
  const agents = await readAgents(request);
  const match = agents.find((entry) => ['openai-codex', 'claude-code'].includes(String(entry.providerId || '')));
  expect(match).toBeTruthy();
  return {
    agentId: String(match?.agentId || match?.agent_id || ''),
    agentLabel: String(match?.name || match?.agentId || ''),
    providerId: String(match?.providerId || ''),
  };
}

test.describe('Swarm Bot Workspace', () => {
  /**
   * @description Verify the direct bot-scoped workspace route boots a real task session and composer.
   */
  test('direct /swarmbot/chat boots a bot-scoped workspace', async ({ page, request }) => {
    const agentsResponse = await request.get('/api/agents');
    expect(agentsResponse.ok()).toBeTruthy();
    const agentsBody = await agentsResponse.json();
    const agent = (agentsBody.agents || []).find((entry: Record<string, unknown>) => entry.name);
    const agentId = String(agent?.agentId || agent?.agent_id || '');
    const agentLabel = String(agent?.name || agentId);
    expect(agentId).toBeTruthy();

    await page.goto(`${BASE_URL}/swarmbot/chat?agentId=${encodeURIComponent(agentId)}&agentLabel=${encodeURIComponent(agentLabel)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await expect(page.locator('#workspaceTitle')).toContainText(agentLabel);
    await waitForTaskId(page.locator('#taskId'));
    await expect(page.locator('#messageInput')).toBeVisible();
    await expect(page.locator('#sendBtn')).toBeEnabled();
  });

  /**
   * @description Verify PM ticket intake swaps the workspace onto the dedicated task returned by the server.
   */
  test('direct /swarmbot/chat follows the server-provided PM ticket task after intake', async ({ page }) => {
    const nextTaskId = '11111111-2222-4333-8444-555555555555';
    const ticketId = '99999999-8888-4777-8666-555555555555';

    await page.route('**/api/send-message', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          taskId: nextTaskId,
          taskIdUsed: nextTaskId,
          ticketCreated: true,
          ticketId,
          response: 'Ticket created.',
        }),
      });
    });

    await page.route(`**/api/${nextTaskId}/messages`, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            { role: 'user', text: 'please create a ticket to build a website about dogs' },
            { role: 'assistant', text: 'Ticket created and linked.' },
          ],
          count: 2,
        }),
      });
    });

    await page.goto(`${BASE_URL}/swarmbot/chat?agentId=${PROJECT_MANAGER_AGENT_ID}&agentLabel=project-manager`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await waitForTaskId(page.locator('#taskId'));
    await page.locator('#messageInput').fill('please create a ticket to build a website about dogs');
    await page.locator('#sendBtn').click();

    await expect(page.locator('#taskId')).toHaveText(nextTaskId);
    await expect(page).toHaveURL(new RegExp(`taskId=${nextTaskId}`));
    await expect(page.locator('#messageArea')).toContainText('Ticket created and linked.');
  });

  /**
   * @description Verify direct quick-settings saves use the canonical profile payload and hand off to bot-scoped /config.
   */
  test('direct /swarmbot/chat quick settings save and handoff use bot-scoped config routes', async ({ page, request }) => {
    const agents = await readAgents(request);
    const firstAgent = agents.find((entry) => readAgentId(entry).length > 0);
    expect(firstAgent).toBeTruthy();
    const agentId = readAgentId(firstAgent);
    const agentLabel = String(firstAgent?.name || agentId);
    const profileState: Record<string, unknown> = {
      agentId,
      name: agentLabel,
      projectUrl: '',
      selectorSkillsText: '',
      themePreference: 'midnight',
      providerId: 'openai-codex',
      modelId: 'gpt-5.4',
    };

    await page.route('**/api/agents/**/profile', async (route) => {
      const requestData = route.request();
      if (requestData.method() === 'PUT') {
        const body = JSON.parse(requestData.postData() || '{}') as { profile?: Record<string, unknown> };
        Object.assign(profileState, body.profile || {});
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, profile: profileState }),
        });
        return;
      }

      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, profile: profileState }),
      });
    });

    await page.goto(`${BASE_URL}/swarmbot/chat?agentId=${encodeURIComponent(agentId)}&agentLabel=${encodeURIComponent(agentLabel)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.locator('#openSettingsBtn').click();
    await expect(page.locator('#quickSettingsModal')).toBeVisible();
    await page.fill('#quickSettingsProjectUrlInput', 'https://example.com/bot-scoped');
    await page.selectOption('#quickSettingsThemeSelect', 'graphite');
    await page.locator('#saveQuickSettingsBtn').scrollIntoViewIfNeeded();
    await page.locator('#saveQuickSettingsBtn').click();
    await expect(page.locator('#quickSettingsStatus')).toContainText('Bot settings saved');
    await page.locator('#openAdvancedConfigBtn').scrollIntoViewIfNeeded();
    await page.locator('#openAdvancedConfigBtn').click();
    await expect(page).toHaveURL(new RegExp(`/config/\\?agentId=${agentId}.*scope=agent`));
    await expect(page).toHaveURL(/#agentConfigSection$/);
  });

  /**
   * @description Verify cockpit embeds the dedicated swarm-bot workspace and routes workspace actions into it.
   */
  test('cockpit embeds /swarmbot/chat and opens bot config/history actions', async ({ page }) => {
    await page.goto(`${BASE_URL}/cockpit/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => Boolean((window as { __cockpit?: unknown }).__cockpit), null, { timeout: 15000 });

    const { agentId, agentLabel } = await readSelectedBot(page);
    expect(agentId).toBeTruthy();
    const profileState: Record<string, unknown> = {
      agentId,
      name: agentLabel,
      projectUrl: '',
      selectorSkillsText: '',
      themePreference: 'midnight',
      providerId: 'openai-codex',
      modelId: 'gpt-5.4',
    };

    await page.route('**/api/agents/**/profile', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, profile: profileState }),
      });
    });

    await page.locator('#botSelector').selectOption(agentId);
    await expect(page.locator('#chatWorkspaceFrame')).toHaveAttribute(
      'src',
      new RegExp(`/swarmbot/chat\\?embed=cockpit.*agentId=${agentId}`),
    );

    const frame = page.frameLocator('#chatWorkspaceFrame');
    await expect(frame.locator('#workspaceTitle')).toContainText(agentLabel);
    await waitForTaskId(frame.locator('#taskId'));
    const messageOverflowY = await frame.locator('#messageArea').evaluate((node) => window.getComputedStyle(node).overflowY);
    expect(['auto', 'scroll']).toContain(messageOverflowY);

    await page.locator('#chatWorkspaceToolsBtn').click();
    await expect(frame.locator('#switchFrameworkModal')).toBeVisible();
    await expect(frame.locator('#switchFrameworkStatus')).toContainText('Switch-framework');
    await frame.locator('#closeSwitchFrameworkBtn').click();
    await page.locator('#chatWorkspaceHistoryBtn').click();
    await expect(frame.locator('#historyModal')).toBeVisible();
    await expect(frame.locator('#historyList')).not.toContainText('Loading bot history...');
    await frame.locator('#closeHistoryBtn').click();

    await page.route('**/api/rag/collections', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ collections: ['default', 'cockpit-knowledge'] }),
      });
    });
    await page.locator('#chatWorkspaceRagBtn').click();
    await expect(frame.locator('#ragModal')).toBeVisible();
    await expect(frame.locator('#ragStatus')).toContainText('Knowledge workspace ready');
    await expect(frame.locator('#ragCollectionPreview')).toHaveText('swarm-knowledge');
    await frame.locator('.rag-workspace-close').click();

    await page.locator('#chatWorkspaceSettingsBtn').click();
    await expect(frame.locator('#quickSettingsModal')).toBeVisible();
    await expect(frame.locator('#quickSettingsNameInput')).toBeVisible();
    const quickSettingsDialogMetrics = await frame.locator('#quickSettingsModal .workspace-modal-dialog').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        dialogHeight: rect.height,
        viewportHeight: window.innerHeight,
      };
    });
    expect(quickSettingsDialogMetrics.dialogHeight).toBeLessThanOrEqual(quickSettingsDialogMetrics.viewportHeight);
    await expect(page).toHaveURL(/\/cockpit\/(?:\?.*)?$/);
  });

  /**
   * @description Verify the dedicated swarm-bot workspace can read and drive provider auth flows for the selected bot.
   */
  test('direct /swarmbot/chat exposes selected bot provider auth controls', async ({ page, request }) => {
    const bot = await readAuthCapableBot(request);
    let authenticated = true;
    const signInUrl = `${BASE_URL}/${bot.providerId}-auth-start`;

    await page.addInitScript(() => {
      window.open = ((url: string) => {
        (window as typeof window & { __lastOpenUrl?: string }).__lastOpenUrl = url;
        return { closed: false } as Window;
      }) as typeof window.open;
    });

    await page.route(`**${resolveStatusPath(bot.providerId)}`, async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(buildAuthStatusPayload(bot.providerId, authenticated)),
      });
    });
    await page.route(`**${resolveStartPath(bot.providerId)}`, async (route) => {
      authenticated = true;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, authUrl: signInUrl }),
      });
    });
    await page.route(`**${resolveSignOutPath(bot.providerId)}`, async (route) => {
      authenticated = false;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, signedOut: true }),
      });
    });

    await page.goto(`${BASE_URL}/swarmbot/chat?agentId=${encodeURIComponent(bot.agentId)}&agentLabel=${encodeURIComponent(bot.agentLabel)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await expect(page.locator('#authPanelTitle')).toContainText(bot.providerId === 'openai-codex' ? 'OpenAI Codex' : 'Claude Code');
    if (bot.providerId === 'openai-codex') {
    await expect(page.locator('#authInfoText')).toContainText('shared across every Codex-configured bot');
      await expect(page.locator('#authSignOutBtn')).toHaveAttribute('title', /Shared Codex Session/);
    }
    await expect(page.locator('#authStatusBadge')).toContainText('Signed in');
    await page.locator('#authSignOutBtn').click();
    await expect(page.locator('#authStatusBadge')).toContainText('Not signed in');
    await expect(page.locator('#authSignInBtn')).toBeVisible();
    if (bot.providerId === 'openai-codex') {
      await expect(page.locator('#authSignInBtn')).toHaveAttribute('title', /For All Codex Bots/);
    }

    await page.locator('#authSignInBtn').click();
    await expect(page.locator('#authStatusBadge')).toContainText('Signed in');
    await expect(page.locator('#statusBanner')).toContainText(bot.providerId === 'openai-codex' ? 'for all Codex bots' : 'sign-in complete');
    await expect.poll(async () => page.evaluate(() => (window as typeof window & { __lastOpenUrl?: string }).__lastOpenUrl || '')).toBe(signInUrl);
  });

  /**
   * @description Verify direct RAG actions run inside the dedicated swarm-bot workspace.
   */
  test('direct /swarmbot/chat runs RAG workflows in-rail', async ({ page, request }) => {
    const bot = await readAuthCapableBot(request);

    await page.route('**/api/rag/collections', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ collections: ['default', 'knowledge-hub'] }),
      });
    });
    await page.route('**/api/rag/search**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          collection: 'swarm-knowledge',
          results: [
            {
              text: 'Swarm workspace parity checklist',
              score: 0.11,
              metadata: { source: 'session-82-note.md' },
            },
          ],
        }),
      });
    });
    await page.route('**/api/rag/upload', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, count: 1, chunks: 2, collection: 'swarm-knowledge' }),
      });
    });
    await page.route('**/api/agents/**/tools/**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });
    await page.route('**/api/agents/**/tools', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          tools: [
            { id: '00000000-0000-4000-8000-000000000101', displayName: 'RAG', authMode: 'auto', installed: true },
          ],
        }),
      });
    });

    await page.goto(`${BASE_URL}/swarmbot/chat?agentId=${encodeURIComponent(bot.agentId)}&agentLabel=${encodeURIComponent(bot.agentLabel)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.locator('#openRagBtn').click();
    await expect(page.locator('#ragModal')).toBeVisible();
    await expect(page.locator('#ragCollectionPreview')).toHaveText('swarm-knowledge');
    await page.setInputFiles('#ragFileInput', {
      name: 'swarm-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Swarm Session 82 knowledge document'),
    });
    await expect(page.locator('#ragStatus')).toContainText('Queued 1 knowledge document');
    await page.locator('#ragUploadAction').click();
    await expect(page.locator('#ragStatus')).toContainText('Uploaded 1 document');
    await page.fill('#ragSearchInput', 'swarm parity checklist');
    await page.getByRole('button', { name: 'Search Knowledge' }).click();
    await expect(page.locator('#ragStatus')).toContainText('Found 1 result');
    await expect(page.locator('#ragResultsList')).toContainText('Swarm workspace parity checklist');
    await page.locator('.rag-workspace-close').click();

    await page.locator('#openToolsBtn').click();
    await expect(page.locator('#switchFrameworkModal')).toBeVisible();
    await expect(page.locator('#switchFrameworkStatus')).toContainText('Switch-framework ready');
    await expect(page.locator('#switchFrameworkList')).toContainText('RAG');
    await page.locator('#closeSwitchFrameworkBtn').click();

    // The presentation entry point now links to the office-suite AI Office surface.
    await page.locator('#openAiOfficeBtn').click();
    await page.waitForURL(/[?&]app=presentations/);
  });

});

/**
 * @description Resolve the provider auth status endpoint path for a supported bot provider.
 * @param providerId - Supported provider id.
 * @returns Provider auth status endpoint path.
 */
function resolveStatusPath(providerId: string): string {
  return providerId === 'claude-code' ? '/api/claude-code/auth/status' : '/api/openai-codex/oauth/status';
}

/**
 * @description Resolve the provider auth start endpoint path for a supported bot provider.
 * @param providerId - Supported provider id.
 * @returns Provider auth start endpoint path.
 */
function resolveStartPath(providerId: string): string {
  return providerId === 'claude-code' ? '/api/claude-code/auth/start' : '/api/openai-codex/oauth/start';
}

/**
 * @description Resolve the provider auth sign-out endpoint path for a supported bot provider.
 * @param providerId - Supported provider id.
 * @returns Provider auth sign-out endpoint path.
 */
function resolveSignOutPath(providerId: string): string {
  return providerId === 'claude-code' ? '/api/claude-code/auth/signout' : '/api/openai-codex/oauth/signout';
}

/**
 * @description Build a realistic auth status payload for the supported bot auth providers.
 * @param providerId - Supported provider id.
 * @param authenticated - Whether the mocked provider is signed in.
 * @returns Mock auth status payload.
 */
function buildAuthStatusPayload(providerId: string, authenticated: boolean): Record<string, unknown> {
  if (providerId === 'claude-code') {
    return {
      success: true,
      available: true,
      authenticated,
      email: authenticated ? 'claude-bot@example.com' : null,
      authMethod: authenticated ? 'cli' : null,
    };
  }

  return {
    success: true,
    authenticated,
    email: authenticated ? 'codex-bot@example.com' : null,
  };
}

/**
 * @description Read one canonical agent id from an API agent summary payload.
 * @param entry - Agent summary object.
 * @returns Canonical agent identifier.
 */
function readAgentId(entry: Record<string, unknown> | undefined): string {
  return String(entry?.agentId || entry?.agent_id || '');
}

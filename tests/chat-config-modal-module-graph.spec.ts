/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the chat config modal decomposition: chat-config-modal.mjs was 1850 code lines (1.85x the cap) and split into four modules that share one state module. The modal had no coverage at all, so a missed import, a dropped export, or a module-evaluation-order mistake would only have shown up as a blank panel in a browser. This spec loads chat-standalone.html with every /chat-assets/ module served from disk, stubs only the backend, and asserts each extracted module's renderer actually produced output — plus that nothing threw.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const CHAT_UI_DIR = path.join(ROOT, 'src/pages/chat/ui');
const AGENT_ID = '00000000-0000-4000-8000-000000000032';

// Minimal stand-in for the vite chat bundle. src/api/dist is gitignored and not built in a plain
// checkout; without SOME module at /dist/chat-ui.js the modal's own import fails and nothing under
// test evaluates. The stub is deliberately inert — this spec is about the config modal graph, not
// about ChatApp.
const CHAT_UI_STUB = `
export class ChatApp {
  constructor(taskId) { this.taskId = taskId; window.__chatAppTaskId = taskId; }
  initialize() { window.__chatAppInitialized = true; }
  clearChat() {}
}
`;

const PROVIDERS = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    description: 'Anthropic Claude models.',
    models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }, { id: 'claude-opus-4', name: 'Claude Opus 4' }],
    configKeys: ['anthropicApiKey', 'awsUseProfile', 'maxRequestTimeout'],
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    description: 'Claude Code CLI.',
    models: [{ id: 'claude-code-default', name: 'Claude Code Default' }],
    configKeys: ['claudeCodePath'],
  },
];

const AGENT_TOOLS = [
  { toolId: 'tool-scheduler', tool: { name: 'agent-scheduler', displayName: 'Agent Scheduler' }, installed: true, authMode: 'act' },
  { toolId: 'tool-web', tool: { name: 'web-fetch', displayName: 'Web Fetch' }, installed: true, authMode: 'plan' },
];

const SCHEDULES = [
  {
    id: 'nightly-digest',
    taskType: 'nightly-digest',
    cron: '0 21 * * *',
    status: 'active',
    executionCount: 12,
    nextRunAt: '2026-07-30T02:00:00.000Z',
    lastRunAt: '2026-07-29T02:00:00.000Z',
    updatedAt: '2026-07-29T02:05:00.000Z',
    taskData: { prompt: 'Summarize the day.', targetAgent: AGENT_ID, action: 'digest', workspaceSlug: 'ops' },
  },
];

function json(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

function asset(route: Route, file: string, contentType: string): Promise<void> {
  return route.fulfill({ contentType, body: readFileSync(path.join(CHAT_UI_DIR, file), 'utf8') });
}

/**
 * Serve the real chat surface off disk and stub every backend call. Unknown paths 404 on purpose:
 * a module the surface actually needs must be served explicitly, so a renamed asset fails loudly
 * instead of silently rendering an empty panel.
 */
async function routeChatSurface(route: Route, recorded: Array<{ method: string; url: string; body: string }>): Promise<void> {
  const url = new URL(route.request().url());
  const pathName = url.pathname;
  const method = route.request().method();
  if (pathName.startsWith('/api/')) {
    recorded.push({ method, url: pathName, body: route.request().postData() || '' });
  }

  if (pathName === '/chat' || pathName === '/chat/') return asset(route, 'chat-standalone.html', 'text/html');
  if (pathName === '/dist/chat-ui.js') return route.fulfill({ contentType: 'application/javascript', body: CHAT_UI_STUB });
  if (pathName.startsWith('/chat-assets/')) {
    const file = pathName.slice('/chat-assets/'.length);
    if (file.endsWith('.css')) return asset(route, file, 'text/css');
    return asset(route, file, 'application/javascript');
  }
  // Stylesheets and fonts the surface links but this spec does not assert on.
  if (pathName.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: '' });
  // The standalone-surface shared helpers. src/pages/shared is mounted at /shared by
  // ui-surface-routes.ts, and `../../shared/ui-debug.js` inside a /chat-assets module resolves
  // there — four of the modal's transitive imports need it, so a missing mount fails the whole
  // module graph with a bare `error` event and no page error at all.
  if (pathName.startsWith('/shared/')) {
    return route.fulfill({
      contentType: 'application/javascript',
      body: readFileSync(path.join(ROOT, 'src/pages/shared', pathName.slice('/shared/'.length)), 'utf8'),
    });
  }

  if (pathName === '/api/branding') return json(route, { displayName: 'OSHAL' });
  if (pathName === '/api/config' && method === 'GET') {
    return json(route, { config: {
      mode: 'plan',
      planModeApiProvider: 'anthropic', planModeApiModelId: 'claude-sonnet-4',
      actModeApiProvider: 'claude-code', actModeApiModelId: 'claude-code-default',
      maxTokens: 8192, temperature: 0.7, anthropicApiKey: 'sk-test-value',
    } });
  }
  if (pathName === '/api/config' && method === 'POST') return json(route, { success: true });
  if (pathName === '/api/providers') return json(route, PROVIDERS);
  if (pathName === '/api/config/mcp') return json(route, { config: { mcpServers: { filesystem: { command: 'npx', args: ['-y', 'server'], env: { ROOT: '/app' } } } } });
  if (pathName === '/api/agents' && method === 'GET') return json(route, { agents: [{ agentId: AGENT_ID, name: 'Chat Agent' }] });
  if (pathName === `/api/agents/${AGENT_ID}/profile`) {
    return json(route, { profile: { agentId: AGENT_ID, name: 'Config Modal Agent', projectUrl: 'https://example.test/repo', selectorSkillsText: 'triage', avatarUrl: '', themePreference: 'ocean' } });
  }
  if (pathName === `/api/agents/${AGENT_ID}/tools`) return json(route, { tools: AGENT_TOOLS });
  if (pathName === '/api/v1/agent/scheduler/status') return json(route, { redisHealthy: true, isRunning: true, pollIntervalMs: 30000 });
  if (pathName === '/api/v1/agent/schedules') return json(route, { schedules: SCHEDULES });
  if (pathName === '/api/claude-code/auth/status') return json(route, { available: true, authenticated: true, email: 'operator@example.test' });
  if (pathName.startsWith('/api/')) return json(route, {});
  return route.fulfill({ status: 404, body: '' });
}

/** Record uncaught errors and console errors so a broken module graph cannot pass quietly. */
function collectFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text()}`);
  });
  return failures;
}

async function openModal(page: Page): Promise<void> {
  await page.locator('#openToolsConfigBtn').click();
  await expect(page.locator('#toolsConfigModal')).toBeVisible();
}

test('every extracted config-modal module renders its own section from shared state', async ({ page }) => {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const failures = collectFailures(page);
  await page.route('**/*', (route) => routeChatSurface(route, requests));
  await page.goto('http://chat.test/chat');

  // The state module owns the header pills: proof it evaluated and its renderers ran.
  await expect(page.locator('#providerStatus')).toHaveText('Provider: plan · Anthropic (claude-sonnet-4)');
  await expect(page.locator('#agentSummary')).toContainText('Agent: Config Modal Agent');
  await expect(page.locator('#modelSummary')).toContainText('Model: claude-sonnet-4');

  await openModal(page);

  // chat-config-api-runtime.mjs — summary cards, both provider selects, both model selects, and a
  // provider field card carrying the secret-key input plus the claude-code auth row.
  await expect(page.locator('#apiRuntimeSummary .api-summary-card')).toHaveCount(4);
  await expect(page.locator('#apiRuntimeSummary')).toContainText('Anthropic · claude-sonnet-4');
  await expect(page.locator('#apiPlanProviderSelect')).toHaveValue('anthropic');
  await expect(page.locator('#apiActProviderSelect')).toHaveValue('claude-code');
  await expect(page.locator('#apiPlanModelSelect')).toHaveValue('claude-sonnet-4');
  await expect(page.locator('#apiPlanProviderInfo')).toHaveText('Anthropic Claude models.');
  await expect(page.locator('#apiProviderFields .api-provider-config-card')).toHaveCount(2);
  await expect(page.locator('#apiProviderFields input[data-api-config-key="anthropicApiKey"]')).toHaveAttribute('type', 'password');
  await expect(page.locator('#apiProviderFields input[data-api-config-key="awsUseProfile"]')).toHaveAttribute('type', 'checkbox');
  // The label overrides map moved with this module; a lost import would render "Anthropic Api Key".
  await expect(page.locator('#apiProviderFields')).toContainText('Anthropic API Key');
  await expect(page.locator('#apiProviderFields [data-provider-auth-action="signout"]').first()).toBeVisible();
  await expect(page.locator('#apiProviderFields .api-provider-auth-status').first()).toContainText('operator@example.test');

  // chat-config-agent-profile.mjs — the profile form and the avatar status line.
  await expect(page.locator('#agentNameInput')).toHaveValue('Config Modal Agent');
  await expect(page.locator('#projectUrlInput')).toHaveValue('https://example.test/repo');
  await expect(page.locator('#agentDisplayName')).toHaveText('Config Modal Agent');
  await expect(page.locator('#agentAvatarFileStatus')).toHaveText('Upload an image and it will be stored in the bot profile record.');

  // Still-resident sections: generated skills, bot stats, MCP list, tool switches.
  await expect(page.locator('#generatedSkills .chip')).not.toHaveCount(0);
  await expect(page.locator('#botStats .stat-card')).toHaveCount(4);
  await expect(page.locator('#botStats')).toContainText('MCP Servers');
  await expect(page.locator('#mcpServerList .mcp-server-card')).toHaveCount(1);
  await expect(page.locator('#mcpServerList')).toContainText('filesystem');
  await expect(page.locator('#toolSwitchList')).toContainText('Agent Scheduler');

  // chat-config-scheduler.mjs is loaded and its load-time entry points ran — proven by the fact that
  // the schedules and scheduler-status endpoints were both fetched during loadConfigState.
  expect(requests.some((r) => r.url === '/api/v1/agent/scheduler/status')).toBe(true);
  expect(requests.some((r) => r.url === '/api/v1/agent/schedules')).toBe(true);

  expect(failures).toEqual([]);
});

test('the scheduler module no-ops safely on a surface with no scheduler markup', async ({ page }) => {
  // chat-standalone.html carries none of the scheduler ids (the live scheduler UI is the separate
  // chat-redis-scheduler-popup.mjs). Every scheduler renderer must therefore return without
  // touching the DOM — this is the contract hasLegacySchedulerEditor() exists to enforce, and it is
  // why the decomposition could move that code without changing what the operator sees.
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const failures = collectFailures(page);
  await page.route('**/*', (route) => routeChatSurface(route, requests));
  await page.goto('http://chat.test/chat');
  await openModal(page);

  for (const id of ['schedulerReportCards', 'scheduledJobList', 'schedulerAgentFilter', 'scheduleTaskTypeInput', 'saveScheduleBtn']) {
    await expect(page.locator(`#${id}`)).toHaveCount(0);
  }
  expect(failures).toEqual([]);
});

test('theme cycling persists through the state module and the profile route', async ({ page }) => {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const failures = collectFailures(page);
  await page.route('**/*', (route) => routeChatSurface(route, requests));
  await page.goto('http://chat.test/chat');

  // The persisted profile themePreference is applied on load by applyTheme (still in the modal) via
  // SUPPORTED_THEMES imported from the state module.
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('ocean');

  await page.locator('#themeCycleBtn').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('sakura');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('sakura');
  await expect.poll(() => requests.filter((r) => r.method === 'PUT' && r.url === `/api/agents/${AGENT_ID}/profile`).length)
    .toBeGreaterThan(0);
  const put = requests.find((r) => r.method === 'PUT' && r.url === `/api/agents/${AGENT_ID}/profile`);
  expect(JSON.parse(put?.body || '{}')).toEqual({ profile: { themePreference: 'sakura' } });
  expect(failures).toEqual([]);
});

test('editing a provider field and saving posts the sanitized runtime config', async ({ page }) => {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const failures = collectFailures(page);
  await page.route('**/*', (route) => routeChatSurface(route, requests));
  await page.goto('http://chat.test/chat');
  await openModal(page);

  await page.locator('#apiModeActBtn').click();
  await expect(page.locator('#apiModeActBtn')).toHaveClass(/active/);
  await page.locator('#apiMaxTokensInput').fill('4096');
  await page.locator('#apiProviderFields input[data-api-config-key="anthropicApiKey"]').fill('sk-updated-value');
  await page.locator('#saveToolsConfigBtn').click();

  await expect(page.locator('#modalStatus')).toHaveAttribute('data-tone', 'success');
  const post = requests.filter((r) => r.method === 'POST' && r.url === '/api/config').at(-1);
  expect(post).toBeTruthy();
  const payload = JSON.parse(post?.body || '{}');
  expect(payload.mode).toBe('act');
  expect(payload.maxTokens).toBe(4096);
  expect(payload.anthropicApiKey).toBe('sk-updated-value');
  // sanitizeApiConfigForSave drops empty strings; nothing empty may survive into the payload.
  expect(Object.values(payload).some((value) => value === '')).toBe(false);
  expect(failures).toEqual([]);
});

test('the knowledge-workspace popup still injects its extracted stylesheet', async ({ page }) => {
  // chat-rag-workspace-popup.mjs was 1044 code lines because a 335-line CSS template literal lived
  // inside it; the literal moved to chat-rag-workspace-styles.mjs. The popup builds its DOM at
  // runtime with no build step, so the only thing that proves the string still crosses the module
  // boundary is the injected <style> actually carrying the rules.
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const failures = collectFailures(page);
  await page.route('**/*', (route) => routeChatSurface(route, requests));
  await page.goto('http://chat.test/chat');

  const style = page.locator('#sharedRagWorkspaceStyle');
  await expect(style).toHaveCount(1);
  const css = await style.textContent();
  expect(css).toContain('.rag-workspace-dialog');
  expect(css).toContain('.rag-workspace-backdrop');
  // The tail of the literal — a truncated template would still contain the opening rules.
  expect(css).toContain('grid-template-columns: 1fr;');
  await expect(page.locator('#ragModal.rag-workspace-modal')).toHaveCount(1);
  expect(failures).toEqual([]);
});

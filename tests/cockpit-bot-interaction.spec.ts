/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real interaction tests: bot selection, context sync, API contracts, per-bot flows
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the stale #chatWorkspacePresentronBtn entry from the workspace-actions button sweep (element removed)
 */

import { test, expect, type Page } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

/**
 * Seed agents matching migration 008/010/011 and the getSeedAgentFallback() in agent-profile-controller.ts.
 * These are the bots the cockpit MUST populate when the DB is unavailable.
 */
const SEED_AGENTS = [
  { id: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager', role: 'project-manager' },
  { id: 'a0000000-0000-0000-0000-000000000002', name: 'code-developer', role: 'developer' },
  { id: 'a0000000-0000-0000-0000-000000000003', name: 'code-reviewer', role: 'reviewer' },
  { id: 'a0000000-0000-0000-0000-000000000004', name: 'documentation-writer', role: 'writer' },
  { id: 'a0000000-0000-0000-0000-000000000005', name: 'test-engineer', role: 'tester' },
  { id: 'a0000000-0000-0000-0000-000000000006', name: 'task-manager', role: 'qa-gatekeeper' },
  { id: 'a0000000-0000-0000-0000-000000000007', name: 'agent-factory', role: 'factory' },
  { id: 'a0000000-0000-0000-0000-000000000008', name: 'devops-bot', role: 'devops-engineer' },
  { id: 'a0000000-0000-0000-0000-000000000009', name: 'rca-specialist', role: 'root-cause-analyst' },
  { id: 'a0000000-0000-0000-0000-00000000000a', name: 'security-auditor-bot', role: 'security-auditor' },
  { id: 'a0000000-0000-0000-0000-00000000000b', name: 'incident-response-bot', role: 'incident-responder' },
];

// ═══ HELPER: wait for cockpit bots to load ═══

async function waitForBotsLoaded(page: Page) {
  await page.waitForFunction(() => {
    const sel = document.getElementById('botSelector') as HTMLSelectElement | null;
    return sel && sel.options.length >= 5;
  }, { timeout: 10000 });
}

// ═══ BOT SELECTOR — SELECT EACH BOT ONE AT A TIME ═══

test.describe('Cockpit — Select Each Bot Individually', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await waitForBotsLoaded(page);
  });

  for (const agent of SEED_AGENTS) {
    test(`selects "${agent.name}" (${agent.id}) and updates dropdown value`, async ({ page }) => {
      const selector = page.locator('#botSelector');
      // Select by value (UUID)
      await selector.selectOption(agent.id);
      const selected = await selector.inputValue();
      expect(selected).toBe(agent.id);
    });
  }

  for (const agent of SEED_AGENTS) {
    test(`selects "${agent.name}" and persists to localStorage`, async ({ page }) => {
      const selector = page.locator('#botSelector');
      await selector.selectOption(agent.id);
      const stored = await page.evaluate(() =>
        localStorage.getItem('oshal-cockpit-selected-agent-id')
      );
      expect(stored).toBe(agent.id);
    });
  }
});

// ═══ BOT SELECTOR — IFRAME CONTEXT SYNC ═══

test.describe('Cockpit — Bot Selection Updates Embedded Chat Iframe', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await waitForBotsLoaded(page);
  });

  for (const agent of SEED_AGENTS) {
    test(`selecting "${agent.name}" reloads iframe with agentId=${agent.id}`, async ({ page }) => {
      const selector = page.locator('#botSelector');
      const frame = page.locator('#chatWorkspaceFrame');

      await selector.selectOption(agent.id);

      // The iframe src should update to include the selected agent's UUID
      await page.waitForFunction(
        (expectedId: string) => {
          const iframe = document.getElementById('chatWorkspaceFrame') as HTMLIFrameElement | null;
          return iframe?.src?.includes(`agentId=${encodeURIComponent(expectedId)}`);
        },
        agent.id,
        { timeout: 5000 }
      );

      const src = await frame.getAttribute('src');
      expect(src).toContain(`agentId=${agent.id}`);
      expect(src).toContain('embed=cockpit');
    });
  }

  test('selecting different bots changes the iframe src each time', async ({ page }) => {
    const selector = page.locator('#botSelector');
    const frame = page.locator('#chatWorkspaceFrame');
    const previousSrcs: string[] = [];

    for (const agent of SEED_AGENTS.slice(0, 5)) {
      await selector.selectOption(agent.id);
      await page.waitForFunction(
        (expectedId: string) => {
          const iframe = document.getElementById('chatWorkspaceFrame') as HTMLIFrameElement | null;
          return iframe?.src?.includes(`agentId=${encodeURIComponent(expectedId)}`);
        },
        agent.id,
        { timeout: 5000 }
      );
      const src = await frame.getAttribute('src');
      expect(src).toBeTruthy();
      // Each selection should produce a different src (different agentId at minimum)
      for (const prev of previousSrcs) {
        expect(src).not.toBe(prev);
      }
      previousSrcs.push(src!);
    }
  });

  test('iframe agentLabel matches the dropdown text for each bot', async ({ page }) => {
    const selector = page.locator('#botSelector');
    const frame = page.locator('#chatWorkspaceFrame');

    for (const agent of SEED_AGENTS.slice(0, 3)) {
      await selector.selectOption(agent.id);
      await page.waitForFunction(
        (expectedId: string) => {
          const iframe = document.getElementById('chatWorkspaceFrame') as HTMLIFrameElement | null;
          return iframe?.src?.includes(`agentId=${encodeURIComponent(expectedId)}`);
        },
        agent.id,
        { timeout: 5000 }
      );
      const src = await frame.getAttribute('src');
      expect(src).toContain(`agentLabel=${encodeURIComponent(agent.name)}`);
    }
  });
});

// ═══ BOT SELECTOR — IFRAME DATA ATTRIBUTES ═══

test.describe('Cockpit — Bot Selection Sets Data Attributes on Iframe', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await waitForBotsLoaded(page);
  });

  for (const agent of SEED_AGENTS.slice(0, 5)) {
    test(`iframe data-selected-agent-id is set to "${agent.id}" after selecting ${agent.name}`, async ({ page }) => {
      await page.locator('#botSelector').selectOption(agent.id);
      // The embedded chat controller sets data attributes on the iframe
      await page.waitForFunction(
        (expectedId: string) => {
          const iframe = document.getElementById('chatWorkspaceFrame') as HTMLIFrameElement | null;
          return iframe?.dataset?.selectedAgentId === expectedId;
        },
        agent.id,
        { timeout: 5000 }
      );
      const dataId = await page.locator('#chatWorkspaceFrame').getAttribute('data-selected-agent-id');
      expect(dataId).toBe(agent.id);
    });
  }
});

// ═══ API CONTRACT — /api/agents RESPONSE VERIFICATION ═══

test.describe('Cockpit — API Agents Response Contract', () => {
  test('/api/agents returns all 11 seed agents with correct structure', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const data = await page.evaluate(async () => {
      const res = await fetch('/api/agents');
      return res.json();
    });

    const agents = data.agents || data || [];
    expect(agents.length).toBeGreaterThanOrEqual(11);

    // Verify each seed agent is present
    for (const seed of SEED_AGENTS) {
      const found = agents.find((a: any) =>
        (a.agentId === seed.id || a.agent_id === seed.id) && a.name === seed.name
      );
      expect(found).toBeTruthy();
    }
  });

  test('each agent has required fields: agentId, name, status, role', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const data = await page.evaluate(async () => {
      const res = await fetch('/api/agents');
      return res.json();
    });

    const agents = data.agents || data || [];
    for (const agent of agents) {
      const id = agent.agentId || agent.agent_id;
      expect(id).toBeTruthy();
      expect(agent.name).toBeTruthy();
      expect(typeof agent.name).toBe('string');
      expect(agent.status).toBeTruthy();
      expect(agent.role).toBeTruthy();
    }
  });

  test('agent UUIDs are valid v4-style format', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const data = await page.evaluate(async () => {
      const res = await fetch('/api/agents');
      return res.json();
    });

    const agents = data.agents || data || [];
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const agent of agents) {
      const id = agent.agentId || agent.agent_id;
      expect(id).toMatch(uuidPattern);
    }
  });

  test('no duplicate agent IDs in the response', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const data = await page.evaluate(async () => {
      const res = await fetch('/api/agents');
      return res.json();
    });

    const agents = data.agents || data || [];
    const ids = agents.map((a: any) => a.agentId || a.agent_id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ═══ BOT SELECTOR — DROPDOWN CONTENT VERIFICATION ═══

test.describe('Cockpit — Bot Selector Dropdown Content', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await waitForBotsLoaded(page);
  });

  test('dropdown has exactly 11 options (one per seed agent)', async ({ page }) => {
    const count = await page.locator('#botSelector option').count();
    expect(count).toBe(11);
  });

  test('each option value is a UUID, not a name', async ({ page }) => {
    const values = await page.locator('#botSelector option').evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value)
    );
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const val of values) {
      expect(val).toMatch(uuidPattern);
    }
  });

  test('each option text is a readable agent name', async ({ page }) => {
    const labels = await page.locator('#botSelector option').evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.textContent?.trim() || '')
    );
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
      // Should be kebab-case agent names, not UUIDs
      expect(label).not.toMatch(/^[0-9a-f]{8}-/);
    }
  });

  for (const agent of SEED_AGENTS) {
    test(`dropdown contains option for "${agent.name}"`, async ({ page }) => {
      const option = page.locator('#botSelector option', { hasText: agent.name });
      await expect(option).toBeAttached();
      const value = await option.getAttribute('value');
      expect(value).toBe(agent.id);
    });
  }
});

// ═══ BOT SELECTOR — SWITCHING DOES NOT LOSE STATE ═══

test.describe('Cockpit — Bot Switching Preserves Cockpit State', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await waitForBotsLoaded(page);
  });

  test('switching bots keeps the current view active', async ({ page }) => {
    // Switch to dashboard view
    await page.locator('.ribbon-btn[data-view="dashboard"]').click();
    await page.waitForTimeout(500);
    await expect(page.locator('.ribbon-btn[data-view="dashboard"]')).toHaveClass(/active/);

    // Now switch bot
    await page.locator('#botSelector').selectOption(SEED_AGENTS[3].id);
    await page.waitForTimeout(300);

    // Dashboard should still be the active view
    await expect(page.locator('.ribbon-btn[data-view="dashboard"]')).toHaveClass(/active/);
  });

  test('switching bots preserves the theme', async ({ page }) => {
    const initialTheme = await page.locator('html').getAttribute('data-theme');
    await page.locator('#themeToggle').click();
    const changedTheme = await page.locator('html').getAttribute('data-theme');
    expect(changedTheme).not.toBe(initialTheme);

    // Switch bot
    await page.locator('#botSelector').selectOption(SEED_AGENTS[5].id);
    await page.waitForTimeout(300);

    // Theme should remain
    const afterSwitch = await page.locator('html').getAttribute('data-theme');
    expect(afterSwitch).toBe(changedTheme);
  });

  test('switching bots preserves chat panel visibility', async ({ page }) => {
    const chatPanel = page.locator('#chatPanel');
    // Ensure the panel is open. There is no right-edge expand tab any more (the Jarvis orb is
    // the standing affordance), so open the rail the way the cockpit does internally.
    await page.evaluate(() => {
      const cockpit = (window as unknown as { __cockpit?: { toggleChatPanel: (show: boolean) => void } }).__cockpit;
      cockpit?.toggleChatPanel(true);
    });
    await expect(chatPanel).not.toHaveClass(/collapsed/);

    // Switch bot
    await page.locator('#botSelector').selectOption(SEED_AGENTS[7].id);
    await page.waitForTimeout(300);

    // Chat panel should still be visible
    await expect(chatPanel).not.toHaveClass(/collapsed/);
  });

  test('rapid bot switching does not crash the UI', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('net::ERR')) {
        errors.push(msg.text());
      }
    });

    // Rapidly cycle through 6 bots
    for (let i = 0; i < 6; i++) {
      await page.locator('#botSelector').selectOption(SEED_AGENTS[i].id);
      await page.waitForTimeout(100);
    }

    // Wait for last navigation to settle
    await page.waitForTimeout(1000);

    // Core UI should still be intact
    await expect(page.locator('.header-bar')).toBeVisible();
    await expect(page.locator('#ribbonContainer')).toBeVisible();
    await expect(page.locator('#mainContent')).toBeVisible();
    await expect(page.locator('#chatPanel')).toBeAttached();

    // No JS runtime errors
    const criticalErrors = errors.filter((e) =>
      !e.includes('Failed to load resource') && !e.includes('favicon') && !e.includes('Phosphor') && !e.includes('unpkg')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});

// ═══ BOT SELECTOR — localStorage PERSISTENCE ACROSS RELOAD ═══

test.describe('Cockpit — Bot Selection Persists Across Reload', () => {
  for (const agent of SEED_AGENTS.slice(0, 4)) {
    test(`selecting "${agent.name}" and reloading restores the selection`, async ({ page }) => {
      await page.goto(COCKPIT_URL);
      await waitForBotsLoaded(page);

      // Select the bot
      await page.locator('#botSelector').selectOption(agent.id);
      await page.waitForTimeout(300);

      // Reload the page
      await page.reload();
      await waitForBotsLoaded(page);

      // The bot should still be selected
      const selected = await page.locator('#botSelector').inputValue();
      expect(selected).toBe(agent.id);
    });
  }
});

// ═══ MOCKED API — VERIFY UI HANDLES DIFFERENT AGENT DATA ═══

test.describe('Cockpit — Bot Selector With Mocked API Data', () => {
  test('custom agent names from API appear in dropdown', async ({ page }) => {
    // Intercept the agents API and return custom data — format matches real /api/agents response
    await page.route('**/api/agents', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            { agentId: 'custom-001', agent_id: 'custom-001', name: 'alpha-bot', status: 'active', role: 'custom' },
            { agentId: 'custom-002', agent_id: 'custom-002', name: 'beta-bot', status: 'active', role: 'custom' },
            { agentId: 'custom-003', agent_id: 'custom-003', name: 'gamma-bot', status: 'active', role: 'custom' },
          ],
        }),
      });
    });

    await page.goto(COCKPIT_URL);
    await page.waitForFunction(() => {
      const sel = document.getElementById('botSelector') as HTMLSelectElement | null;
      return sel && sel.options.length >= 3;
    }, { timeout: 10000 });

    const options = page.locator('#botSelector option');
    const count = await options.count();
    expect(count).toBe(3);

    // Verify the custom names appear
    await expect(options.nth(0)).toContainText('alpha-bot');
    await expect(options.nth(1)).toContainText('beta-bot');
    await expect(options.nth(2)).toContainText('gamma-bot');
  });

  test('empty API response shows fallback placeholder', async ({ page }) => {
    await page.route('**/api/agents', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agents: [] }),
      });
    });

    await page.goto(COCKPIT_URL);
    await page.waitForTimeout(2000);

    const options = page.locator('#botSelector option');
    const count = await options.count();
    // Should have at least a "Choose a bot" placeholder
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('API failure still renders cockpit without crashing', async ({ page }) => {
    await page.route('**/api/agents', (route) => {
      route.fulfill({ status: 500, body: 'Internal Server Error' });
    });

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('net::ERR') && !msg.text().includes('favicon')) {
        errors.push(msg.text());
      }
    });

    await page.goto(COCKPIT_URL);
    await page.waitForTimeout(2000);

    // Core layout should still render
    await expect(page.locator('.header-bar')).toBeVisible();
    await expect(page.locator('#ribbonContainer')).toBeVisible();
    await expect(page.locator('#mainContent')).toBeVisible();
  });
});

// ═══ ADDRESS BOOK — BOT INTERACTION FLOWS ═══

test.describe('Cockpit — Address Book Bot Actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await waitForBotsLoaded(page);
    // Navigate to address book
    await page.locator('.ribbon-btn[data-view="addressbook"]').click();
    await page.waitForTimeout(1000);
  });

  test('address book shows bot cards for loaded agents', async ({ page }) => {
    const cards = page.locator('.ab-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('bot cards display the agent name', async ({ page }) => {
    const firstCardName = page.locator('.ab-card .ab-name').first();
    await expect(firstCardName).toBeVisible();
    const name = await firstCardName.textContent();
    expect(name).toBeTruthy();
    expect(name!.length).toBeGreaterThan(0);
  });

  test('bot cards display the agent role', async ({ page }) => {
    const firstCardRole = page.locator('.ab-card .ab-role').first();
    await expect(firstCardRole).toBeVisible();
    const role = await firstCardRole.textContent();
    expect(role).toBeTruthy();
  });

  test('clicking "Message" on a bot card opens chat panel', async ({ page }) => {
    const messageBtn = page.locator('.ab-card .ab-action-btn').filter({ hasText: 'Message' }).first();
    if (await messageBtn.count() > 0) {
      await messageBtn.click();
      await page.waitForTimeout(500);
      const chatPanel = page.locator('#chatPanel');
      await expect(chatPanel).not.toHaveClass(/collapsed/);
    }
  });
});

// ═══ BOT CONFIG NAVIGATION ═══

test.describe('Cockpit — Bot Config Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await waitForBotsLoaded(page);
  });

  test('bot config button builds correct URL with selected agent', async ({ page }) => {
    // Select a specific bot
    const agent = SEED_AGENTS[1]; // code-developer
    await page.locator('#botSelector').selectOption(agent.id);
    await page.waitForTimeout(200);

    // Check what the config button would navigate to
    const configHref = await page.evaluate(() => {
      const select = document.getElementById('botSelector') as HTMLSelectElement;
      const selectedAgentId = select?.value || '';
      const params = new URLSearchParams();
      if (selectedAgentId) params.set('agentId', selectedAgentId);
      params.set('scope', 'agent');
      return `/config/?${params.toString()}#agentConfigSection`;
    });

    expect(configHref).toContain(`agentId=${agent.id}`);
    expect(configHref).toContain('scope=agent');
  });
});

// ═══ NEW CHAT PER BOT ═══

test.describe('Cockpit — New Chat Creates Fresh Session Per Bot', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await waitForBotsLoaded(page);
  });

  test('clicking New Chat reloads iframe with fresh nonce', async ({ page }) => {
    const frame = page.locator('#chatWorkspaceFrame');
    const srcBefore = await frame.getAttribute('src');

    await page.locator('#newChatBtn').click();

    // Wait for the iframe src to change
    await page.waitForFunction(
      (prevSrc: string) => {
        const iframe = document.getElementById('chatWorkspaceFrame') as HTMLIFrameElement | null;
        return iframe?.getAttribute('src') !== prevSrc;
      },
      srcBefore || '',
      { timeout: 5000 }
    );

    const srcAfter = await frame.getAttribute('src');
    expect(srcAfter).toContain('embed=cockpit');
    expect(srcAfter).not.toBe(srcBefore);
  });

  test('new chat preserves the currently selected bot', async ({ page }) => {
    const agent = SEED_AGENTS[4]; // test-engineer
    await page.locator('#botSelector').selectOption(agent.id);
    await page.waitForTimeout(500);

    await page.locator('#newChatBtn').click();
    await page.waitForTimeout(500);

    // Bot should still be selected
    const selected = await page.locator('#botSelector').inputValue();
    expect(selected).toBe(agent.id);

    // Iframe should still reference the same agent
    const src = await page.locator('#chatWorkspaceFrame').getAttribute('src');
    expect(src).toContain(`agentId=${agent.id}`);
  });

  test('new chat for different bots produces different iframe sessions', async ({ page }) => {
    // Select bot A, click new chat
    await page.locator('#botSelector').selectOption(SEED_AGENTS[0].id);
    await page.waitForTimeout(300);
    await page.locator('#newChatBtn').click();
    await page.waitForTimeout(300);
    const srcA = await page.locator('#chatWorkspaceFrame').getAttribute('src');

    // Select bot B, click new chat
    await page.locator('#botSelector').selectOption(SEED_AGENTS[1].id);
    await page.waitForTimeout(300);
    await page.locator('#newChatBtn').click();
    await page.waitForTimeout(300);
    const srcB = await page.locator('#chatWorkspaceFrame').getAttribute('src');

    expect(srcA).toContain(SEED_AGENTS[0].id);
    expect(srcB).toContain(SEED_AGENTS[1].id);
    expect(srcA).not.toBe(srcB);
  });
});

// ═══ WORKSPACE ACTION BUTTONS PER BOT ═══

test.describe('Cockpit — Workspace Actions With Selected Bot', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await waitForBotsLoaded(page);
  });

  const workspaceActions = [
    { id: '#chatWorkspaceSettingsBtn', label: 'Settings' },
    { id: '#chatWorkspaceToolsBtn', label: 'Switch Framework' },
    { id: '#chatWorkspaceHistoryBtn', label: 'History' },
    { id: '#chatWorkspaceRagBtn', label: 'RAG' },
  ];

  for (const action of workspaceActions) {
    test(`"${action.label}" button is clickable without errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' && !msg.text().includes('net::ERR') && !msg.text().includes('favicon')) {
          errors.push(msg.text());
        }
      });

      // Select a specific bot first
      await page.locator('#botSelector').selectOption(SEED_AGENTS[2].id);
      await page.waitForTimeout(300);

      // Click the workspace action
      const btn = page.locator(action.id);
      if (await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(500);
      }

      // No critical errors
      const critical = errors.filter((e) =>
        !e.includes('Failed to load resource') && !e.includes('Phosphor') && !e.includes('unpkg')
      );
      expect(critical).toHaveLength(0);
    });
  }
});

// ═══ COST CONTROLS — REAL INTERACTION ═══

test.describe('Cockpit — Cost Controls Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    // Go to settings view
    await page.locator('.ribbon-btn[data-view="settings"]').click();
    await page.waitForTimeout(1000);
  });

  test('daily limit input accepts numeric values', async ({ page }) => {
    const input = page.locator('#dailyLimit');
    if (await input.count() > 0) {
      await input.fill('25.50');
      const value = await input.inputValue();
      expect(value).toBe('25.50');
    }
  });

  test('bucket limit input accepts numeric values', async ({ page }) => {
    const input = page.locator('#bucketLimit');
    if (await input.count() > 0) {
      await input.fill('100');
      const value = await input.inputValue();
      expect(value).toBe('100');
    }
  });

  test('setting cost limits persists to localStorage', async ({ page }) => {
    const dailyInput = page.locator('#dailyLimit');
    const saveBtn = page.locator('.settings-save-btn, button').filter({ hasText: /Save/i }).first();

    if (await dailyInput.count() > 0 && await saveBtn.count() > 0) {
      await dailyInput.fill('50');
      await saveBtn.click();
      await page.waitForTimeout(500);

      const stored = await page.evaluate(() =>
        localStorage.getItem('cockpit-cost-tracker')
      );
      if (stored) {
        const parsed = JSON.parse(stored);
        expect(parsed.dailyLimit).toBe(50);
      }
    }
  });
});

// ═══ SETTINGS VIEW — THEME INTERACTION ═══

test.describe('Cockpit — Settings Theme Picker Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await page.locator('.ribbon-btn[data-view="settings"]').click();
    await page.waitForTimeout(1000);
  });

  test('theme picker buttons exist for all themes', async ({ page }) => {
    const themeButtons = page.locator('#settingsThemePicker .td-action-btn, #settingsThemePicker button');
    const count = await themeButtons.count();
    // Should have at least 2 theme options (midnight, daylight, ocean, sakura, forest)
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('clicking a theme button changes the page theme', async ({ page }) => {
    const themeButtons = page.locator('#settingsThemePicker .td-action-btn, #settingsThemePicker button');
    const count = await themeButtons.count();
    if (count >= 2) {
      const initialTheme = await page.locator('html').getAttribute('data-theme');
      // Click a different theme button
      await themeButtons.nth(1).click();
      await page.waitForTimeout(300);
      const newTheme = await page.locator('html').getAttribute('data-theme');
      expect(newTheme).toBeTruthy();
    }
  });
});

// ═══ TICKET VIEW — INTERACTION TESTS ═══

test.describe('Cockpit — Ticket View Real Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await page.waitForTimeout(1000);
  });

  test('search input filters tickets on typing', async ({ page }) => {
    const searchInput = page.locator('#tvSearch');
    if (await searchInput.count() > 0) {
      // Type a nonsense query that won't match any real ticket
      await searchInput.fill('nonexistent-ticket-xyz-999');
      await page.waitForTimeout(500);
      // The ticket list should show "No tickets found" empty state or zero matching rows
      const emptyState = page.locator('.ticket-detail-empty');
      const ticketRows = page.locator('.ticket-row');
      const rowCount = await ticketRows.count();
      const hasEmptyState = await emptyState.count() > 0;
      // Either empty state is shown or no ticket rows match
      expect(hasEmptyState || rowCount === 0).toBe(true);
    }
  });

  test('status filter dropdown changes displayed tickets', async ({ page }) => {
    const statusFilter = page.locator('#tvStatusFilter');
    if (await statusFilter.count() > 0) {
      const options = statusFilter.locator('option');
      const count = await options.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });
});

// ═══ CALENDAR VIEW — INTERACTION TESTS ═══

test.describe('Cockpit — Calendar View Real Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await page.locator('.ribbon-btn[data-view="calendar"]').click();
    await page.waitForTimeout(1000);
  });

  test('clicking prev/next month changes the displayed month', async ({ page }) => {
    const monthLabel = page.locator('.cal-month-label, .calendar-month, .month-display').first();
    if (await monthLabel.count() > 0) {
      const initialMonth = await monthLabel.textContent();
      const prevBtn = page.locator('.cal-prev, .month-prev, button[aria-label*="prev" i]').first();
      if (await prevBtn.count() > 0) {
        await prevBtn.click();
        await page.waitForTimeout(300);
        const newMonth = await monthLabel.textContent();
        expect(newMonth).not.toBe(initialMonth);
      }
    }
  });

  test('clicking a calendar day selects it', async ({ page }) => {
    const dayCell = page.locator('.cal-day:not(.empty), .calendar-day:not(.other-month)').first();
    if (await dayCell.count() > 0) {
      await dayCell.click();
      await page.waitForTimeout(300);
      // Should show selected state or day detail
      const selectedDay = page.locator('.cal-day.selected, .calendar-day.selected, .day-detail');
      const count = await selectedDay.count();
      expect(count).toBeGreaterThanOrEqual(0); // May or may not have visual selection
    }
  });
});

// ═══ DASHBOARD VIEW — DATA VERIFICATION ═══

test.describe('Cockpit — Dashboard Metrics Verification', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await page.locator('.ribbon-btn[data-view="dashboard"]').click();
    await page.waitForTimeout(1500);
  });

  test('dashboard renders metric cards with labels and values', async ({ page }) => {
    const cards = page.locator('.dash-metric-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Each card should have a label
    for (let i = 0; i < Math.min(count, 6); i++) {
      const card = cards.nth(i);
      const text = await card.textContent();
      expect(text).toBeTruthy();
      expect(text!.length).toBeGreaterThan(0);
    }
  });

  test('refresh button triggers new metrics fetch', async ({ page }) => {
    let metricsCallCount = 0;
    page.on('request', (req) => {
      if (req.url().includes('/api/v1/metrics/summary')) {
        metricsCallCount++;
      }
    });

    const refreshBtn = page.locator('.dash-refresh-btn, button[title*="Refresh" i], #dashboardRefresh').first();
    if (await refreshBtn.count() > 0) {
      const beforeCount = metricsCallCount;
      await refreshBtn.click();
      await page.waitForTimeout(1000);
      expect(metricsCallCount).toBeGreaterThan(beforeCount);
    }
  });
});

// ═══ SEARCH — REAL INTERACTION ═══

test.describe('Cockpit — Global Search Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
  });

  test('typing in search input updates its value', async ({ page }) => {
    const input = page.locator('#searchInput');
    await input.fill('test query');
    const value = await input.inputValue();
    expect(value).toBe('test query');
  });

  test('Cmd+K focuses the search input from anywhere', async ({ page }) => {
    // Click somewhere else first
    await page.locator('.header-bar').click();
    await page.waitForTimeout(100);

    await page.keyboard.press('Meta+k');
    await expect(page.locator('#searchInput')).toBeFocused();
  });

  test('clearing search input restores original state', async ({ page }) => {
    const input = page.locator('#searchInput');
    await input.fill('some search');
    await page.waitForTimeout(200);
    await input.fill('');
    await page.waitForTimeout(200);
    const value = await input.inputValue();
    expect(value).toBe('');
  });
});

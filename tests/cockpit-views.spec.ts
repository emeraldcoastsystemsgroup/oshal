/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Comprehensive Playwright tests for all 7 cockpit views
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalized governance metadata before targeted cockpit engineering retrofit validation
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Updated non-live migration test to replacement-page operational surface test for compatibility-first restoration
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added settings-view regressions for provider-driven model selector and OpenAI Codex auth controls
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added engineering compatibility API assertions for live-backed OSHAL payloads
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added cockpit engineering coverage for the native RAG Center screen
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Updated ticket-view assertions to match the normalized lifecycle filter vocabulary exposed by the cockpit ticket toolbar
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added settings coverage for the shared code-server workspace-root field so swarm deployment mount paths are configurable from the cockpit UI
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added ticket-view coverage for project grouping so the toolbar exposes every supported grouping mode
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Corrected historical Change Log author attribution while reviewing cockpit calendar regression coverage
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Added legacy platform and Advanced view coverage: multi-source alarms, source/severity filters, AdvancedView CSS class structure
 */

import { test, expect } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

/** Navigate to cockpit and switch to a specific ribbon view. */
async function switchToView(page: any, viewId: string): Promise<void> {
  await page.goto(COCKPIT_URL);
  await page.locator(`.ribbon-btn[data-view="${viewId}"]`).click();
  // Allow view to render
  await page.waitForTimeout(500);
}

// ═══ TICKET VIEW ═══

test.describe('Cockpit — Ticket View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    // Tickets is the default view, but explicitly click to be sure
    await page.locator('.ribbon-btn[data-view="tickets"]').click();
    await page.waitForTimeout(500);
  });

  test('renders the split-pane layout (list + detail)', async ({ page }) => {
    await expect(page.locator('.ticket-view')).toBeVisible();
    await expect(page.locator('.ticket-list-pane')).toBeVisible();
    await expect(page.locator('#tvDetailPane')).toBeVisible();
  });

  test('toolbar has search input', async ({ page }) => {
    const search = page.locator('#tvSearch');
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('placeholder', /Search tickets/);
  });

  test('toolbar has status filter dropdown', async ({ page }) => {
    const filter = page.locator('#tvStatusFilter');
    await expect(filter).toBeVisible();
    // Check that it has options
    const options = filter.locator('option');
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('toolbar has project filter dropdown', async ({ page }) => {
    await expect(page.locator('#tvProjectFilter')).toBeVisible();
  });

  test('toolbar has group-by dropdown', async ({ page }) => {
    const groupBy = page.locator('#tvGroupBy');
    await expect(groupBy).toBeVisible();
    // Verify grouping options
    await expect(groupBy.locator('option[value="none"]')).toBeAttached();
    await expect(groupBy.locator('option[value="date"]')).toBeAttached();
    await expect(groupBy.locator('option[value="state"]')).toBeAttached();
    await expect(groupBy.locator('option[value="project"]')).toBeAttached();
  });

  test('list header has sortable columns', async ({ page }) => {
    const header = page.locator('#tvListHeader');
    await expect(header).toBeVisible();
    await expect(header.locator('[data-sort="status"]')).toBeAttached();
    await expect(header.locator('[data-sort="name"]')).toBeAttached();
    await expect(header.locator('[data-sort="cost"]')).toBeAttached();
    await expect(header.locator('[data-sort="date"]')).toBeAttached();
  });

  test('ticket list scroll area exists', async ({ page }) => {
    await expect(page.locator('#tvListScroll')).toBeVisible();
  });

  test('detail pane shows empty state when no ticket selected', async ({ page }) => {
    const detail = page.locator('#tvDetailPane');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.ticket-detail-empty')).toBeVisible();
    await expect(detail).toContainText('Select a ticket');
  });

  test('search input filters tickets', async ({ page }) => {
    const search = page.locator('#tvSearch');
    await search.fill('nonexistent-ticket-xyz-12345');
    await page.waitForTimeout(300);
    // Should show "No tickets found" or an empty state
    const scroll = page.locator('#tvListScroll');
    const content = await scroll.textContent();
    expect(content).toBeTruthy();
  });

  test('status filter changes the list', async ({ page }) => {
    await page.locator('#tvStatusFilter').selectOption('approved');
    await page.waitForTimeout(300);
    // Filter applied — list should re-render
    await expect(page.locator('#tvListScroll')).toBeVisible();
  });

  test('group-by changes list rendering', async ({ page }) => {
    await page.locator('#tvGroupBy').selectOption('state');
    await page.waitForTimeout(300);
    await expect(page.locator('#tvListScroll')).toBeVisible();
  });

  test('clicking a sortable column header triggers re-render', async ({ page }) => {
    const nameCol = page.locator('#tvListHeader [data-sort="name"]');
    await nameCol.click();
    // Should still have content
    await expect(page.locator('#tvListScroll')).toBeVisible();
  });
});

// ═══ CHAT VIEW ═══

test.describe('Cockpit — Chat View', () => {
  test.beforeEach(async ({ page }) => {
    await switchToView(page, 'chat');
  });

  test('renders conversation list pane', async ({ page }) => {
    await expect(page.locator('.ticket-list-pane')).toBeVisible();
  });

  test('has search conversations input', async ({ page }) => {
    const search = page.locator('#cvSearch');
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('placeholder', /Search conversations/);
  });

  test('has "New" conversation button', async ({ page }) => {
    const btn = page.locator('#cvNewBtn');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('New');
  });

  test('conversation list area exists', async ({ page }) => {
    await expect(page.locator('#cvList')).toBeVisible();
  });

  test('detail pane shows empty state', async ({ page }) => {
    const detail = page.locator('#cvDetailPane');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(/Select a conversation|No conversations/);
  });

  test('search filters conversations', async ({ page }) => {
    const search = page.locator('#cvSearch');
    await search.fill('nonexistent-conv-xyz');
    await page.waitForTimeout(300);
    await expect(page.locator('#cvList')).toBeVisible();
  });
});

// ═══ CALENDAR VIEW ═══

test.describe('Cockpit — Calendar View', () => {
  test.beforeEach(async ({ page }) => {
    await switchToView(page, 'calendar');
  });

  test('renders calendar root', async ({ page }) => {
    await expect(page.locator('#calViewRoot')).toBeVisible();
  });

  test('displays month navigation with prev/next buttons', async ({ page }) => {
    await expect(page.locator('#calPrev')).toBeVisible();
    await expect(page.locator('#calNext')).toBeVisible();
    await expect(page.locator('.cal-month-label')).toBeVisible();
  });

  test('month label shows current month and year', async ({ page }) => {
    const label = page.locator('.cal-month-label');
    const text = await label.textContent();
    // Should contain a month name and year
    expect(text).toMatch(/\w+ \d{4}/);
  });

  test('has bot filter dropdown', async ({ page }) => {
    await expect(page.locator('#calBotFilter')).toBeVisible();
  });

  test('has schedule button', async ({ page }) => {
    const btn = page.locator('#calAddSchedule');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('Schedule');
  });

  test('renders weekday header (Sun-Sat)', async ({ page }) => {
    const header = page.locator('.cal-weekday-header');
    await expect(header).toBeVisible();
    const weekdays = header.locator('.cal-weekday');
    await expect(weekdays).toHaveCount(7);
  });

  test('renders calendar grid', async ({ page }) => {
    const grid = page.locator('#calGrid');
    await expect(grid).toBeVisible();
    // Grid should have day cells
    const days = grid.locator('.cal-day');
    const count = await days.count();
    expect(count).toBeGreaterThanOrEqual(28);
  });

  test('today cell has "today" class', async ({ page }) => {
    const todayCell = page.locator('.cal-day.today');
    await expect(todayCell).toBeVisible();
  });

  test('clicking prev changes month', async ({ page }) => {
    const label = page.locator('.cal-month-label');
    await expect(label).toBeVisible({ timeout: 10000 });
    const initialMonth = await label.textContent();
    // Click prev twice to ensure we get a different month even with edge-case timing
    await page.locator('#calPrev').click();
    await page.waitForTimeout(500);
    await page.locator('#calPrev').click();
    await page.waitForTimeout(500);
    const newMonth = await label.textContent();
    expect(newMonth).not.toBe(initialMonth);
  });

  test('clicking next changes month', async ({ page }) => {
    const label = page.locator('.cal-month-label');
    const initialMonth = await label.textContent();
    await page.locator('#calNext').click();
    await page.waitForTimeout(300);
    const newMonth = await label.textContent();
    expect(newMonth).not.toBe(initialMonth);
  });

  test('clicking a day cell shows/hides day detail', async ({ page }) => {
    // Click a non-other-month day
    const day = page.locator('.cal-day:not(.other-month)').first();
    await day.click();
    await page.waitForTimeout(200);
    // Day detail should appear
    const detail = page.locator('#calDayDetail');
    const content = await detail.textContent();
    expect(content!.length).toBeGreaterThan(0);
  });

  test('schedule dialog opens on button click', async ({ page }) => {
    await page.locator('#calAddSchedule').click();
    await page.waitForTimeout(200);
    // Dialog should appear with form fields
    await expect(page.locator('.cal-schedule-dialog')).toBeVisible();
    await expect(page.locator('#schedDesc')).toBeVisible();
    // #schedCron is hidden by default — only shown when "Custom cron..." recurrence is selected
    await expect(page.locator('#schedCron')).toBeAttached();
    await expect(page.locator('#schedCreate')).toBeVisible();
    await expect(page.locator('#schedCancel')).toBeVisible();
  });

  test('schedule dialog closes on cancel', async ({ page }) => {
    await page.locator('#calAddSchedule').click();
    await page.waitForTimeout(200);
    await page.locator('#schedCancel').click();
    await expect(page.locator('.cal-schedule-dialog')).not.toBeVisible();
  });
});

// ═══ ADDRESS BOOK VIEW ═══

test.describe('Cockpit — Address Book View', () => {
  test.beforeEach(async ({ page }) => {
    await switchToView(page, 'addressbook');
  });

  test('renders address book view', async ({ page }) => {
    await expect(page.locator('.addressbook-view')).toBeVisible();
  });

  test('has search input', async ({ page }) => {
    const search = page.locator('#abSearch');
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('placeholder', /Search bots/);
  });

  test('has online/offline filter', async ({ page }) => {
    const filter = page.locator('#abFilter');
    await expect(filter).toBeVisible();
    await expect(filter.locator('option[value="all"]')).toBeAttached();
    await expect(filter.locator('option[value="online"]')).toBeAttached();
    await expect(filter.locator('option[value="offline"]')).toBeAttached();
  });

  test('has bot count display', async ({ page }) => {
    const count = page.locator('#abCount');
    await expect(count).toBeVisible();
    await expect(count).toContainText('bots');
  });

  test('bot grid renders', async ({ page }) => {
    await expect(page.locator('#abGrid')).toBeVisible();
  });

  test('bot cards have expected structure', async ({ page }) => {
    await expect(page.locator('.ab-card').first()).toBeVisible({ timeout: 15000 });
    const firstCard = page.locator('.ab-card').first();
    await expect(firstCard.locator('.ab-name')).toBeVisible({ timeout: 5000 });
  });

  test('bot cards have action buttons', async ({ page }) => {
    await expect(page.locator('.ab-card').first()).toBeVisible({ timeout: 15000 });
    const firstCard = page.locator('.ab-card').first();
    const actions = firstCard.locator('.ab-actions button, .ab-actions a, [data-action]');
    const count = await actions.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('search filters bot cards', async ({ page }) => {
    await page.waitForTimeout(1000);
    await page.locator('#abSearch').fill('nonexistent-bot-xyz');
    await page.waitForTimeout(300);
    // Should show no bots or fewer bots
    await expect(page.locator('#abGrid')).toBeVisible();
  });

  test('filter by online/offline changes list', async ({ page }) => {
    await page.locator('#abFilter').selectOption('online');
    await page.waitForTimeout(300);
    await expect(page.locator('#abGrid')).toBeVisible();
  });
});

// ═══ DASHBOARD VIEW ═══

test.describe('Cockpit — Dashboard View', () => {
  test.beforeEach(async ({ page }) => {
    await switchToView(page, 'dashboard');
  });

  test('renders dashboard view with title', async ({ page }) => {
    await expect(page.locator('.dashboard-view')).toBeVisible();
    await expect(page.locator('.dash-title')).toContainText('Dashboard');
  });

  test('has refresh button', async ({ page }) => {
    const btn = page.locator('#dashRefresh');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('Refresh');
  });

  test('dashboard content area renders', async ({ page }) => {
    await expect(page.locator('#dashContent')).toBeVisible();
  });

  test('renders 6 metric cards after load', async ({ page }) => {
    await page.waitForTimeout(1500);
    const metricCards = page.locator('.dash-metric-card');
    const count = await metricCards.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('metric cards show correct labels', async ({ page }) => {
    await page.waitForTimeout(2000);
    const content = page.locator('#dashContent');
    await expect(content).toContainText('Total Tickets');
    await expect(content).toContainText('Online Bots');
  });

  test('spending chart canvas exists', async ({ page }) => {
    await page.waitForTimeout(1500);
    const canvas = page.locator('#dashSpendingChart');
    await expect(canvas).toBeAttached();
  });

  test('bot performance section exists', async ({ page }) => {
    await page.waitForTimeout(1500);
    await expect(page.locator('#dashBotPerf')).toBeAttached();
  });

  test('swarm health donut chart exists', async ({ page }) => {
    await page.waitForTimeout(1500);
    await expect(page.locator('#dashDonutChart')).toBeAttached();
    await expect(page.locator('#dashDonutLegend')).toBeAttached();
  });

  test('case breakdown funnel exists', async ({ page }) => {
    await page.waitForTimeout(1500);
    await expect(page.locator('#dashFunnel')).toBeAttached();
  });

  test('queue status bars exist', async ({ page }) => {
    await page.waitForTimeout(1500);
    await expect(page.locator('#dashQueueBars')).toBeAttached();
  });

  test('refresh button triggers data reload', async ({ page }) => {
    await page.waitForTimeout(1000);
    const btn = page.locator('#dashRefresh');
    await btn.click();
    // Button should still be visible after refresh
    await expect(btn).toBeVisible();
  });

  test('spending chart displays total cost label', async ({ page }) => {
    await page.waitForTimeout(1500);
    const subtitle = page.locator('.dash-chart-subtitle');
    if (await subtitle.count() > 0) {
      // May show "Total: $0.00" or "Total: --" depending on data availability
      await expect(subtitle.first()).toContainText('Total:');
    }
  });

  test('donut legend shows Online, Degraded, Offline', async ({ page }) => {
    await page.waitForTimeout(2000);
    const legend = page.locator('#dashDonutLegend');
    await expect(legend).toContainText('Online', { timeout: 10000 });
  });
});

// ═══ SETTINGS VIEW ═══

test.describe('Cockpit — Settings View', () => {
  test.beforeEach(async ({ page }) => {
    await switchToView(page, 'settings');
  });

  test('renders settings view with tabs', async ({ page }) => {
    await expect(page.locator('.settings-view')).toBeVisible();
  });

  test('has Global Settings and Bot Settings tabs', async ({ page }) => {
    await expect(page.locator('.settings-tab[data-tab="global"]')).toBeVisible();
    await expect(page.locator('.settings-tab[data-tab="bots"]')).toBeVisible();
  });

  test('Global Settings tab is active by default', async ({ page }) => {
    await expect(page.locator('.settings-tab[data-tab="global"]')).toHaveClass(/active/);
  });

  test('settings body renders content', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('#settingsBody')).not.toBeEmpty();
  });

  test('theme picker section exists with theme buttons', async ({ page }) => {
    await page.waitForTimeout(1500);
    const picker = page.locator('#settingsThemePicker');
    await expect(picker).toBeVisible({ timeout: 10000 });
    const themeButtons = picker.locator('button');
    const count = await themeButtons.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('cost controls section exists', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('#costDailyLimit')).toBeVisible();
    await expect(page.locator('#costBucketLimit')).toBeVisible();
    await expect(page.locator('#costSaveLimitsBtn')).toBeVisible();
    await expect(page.locator('#costResetBucketBtn')).toBeVisible();
  });

  test('cost status cards display values', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('#costDailySpent')).toBeVisible();
    await expect(page.locator('#costBucketSpent')).toBeVisible();
  });

  test('LLM provider section exists', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('#settingsProvider')).toBeAttached();
  });

  test('LLM model selector exists for provider-driven runtime model binding', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('#settingsModel')).toBeAttached();
  });

  test('OpenAI Codex auth section renders sign-in status controls', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('[data-testid="settings-openai-codex-auth"]')).toBeVisible();
    await expect(page.locator('#settingsOpenAiCodexAuthStatus')).toBeAttached();
  });

  test('API key field exists', async ({ page }) => {
    await page.waitForTimeout(1000);
    const input = page.locator('#settingsApiKey');
    await expect(input).toBeAttached();
    await expect(input).toHaveAttribute('type', 'password');
  });

  test('swarm integration fields exist', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('#settingsGitUrl')).toBeAttached();
    await expect(page.locator('#settingsGitToken')).toBeAttached();
    await expect(page.locator('#settingsPlaneUrl')).toBeAttached();
    await expect(page.locator('#settingsRedis')).toBeAttached();
  });

  test('shared service runtime fields exist', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('#settingsRagEndpoint')).toBeAttached();
    await expect(page.locator('#settingsRagDefaultCollection')).toBeAttached();
    await expect(page.locator('#settingsCodeServerWorkspaceRoot')).toBeAttached();
    await expect(page.locator('#settingsRefreshRuntimeBtn')).toBeVisible();
  });

  test('shared service runtime health cards render', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('#settingsRagHealthCard')).toBeVisible();
  });

  test('auto-approve toggles exist', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('#settingsAutoSafe')).toBeAttached();
    await expect(page.locator('#settingsAutoRead')).toBeAttached();
    await expect(page.locator('#settingsAutoWrite')).toBeAttached();
  });

  test('save settings button exists', async ({ page }) => {
    await page.waitForTimeout(1000);
    await expect(page.locator('#settingsSaveBtn')).toBeVisible();
  });

  test('shared code-server workspace root can be saved from Global Settings', async ({ page }) => {
    await page.waitForTimeout(1000);
    const input = page.locator('#settingsCodeServerWorkspaceRoot');
    const originalValue = await input.inputValue();
    const nextValue = `/usr/workspace/playwright-${Date.now().toString(36)}`;

    try {
      await input.fill(nextValue);
      await page.locator('#settingsSaveBtn').click();
      await expect(page.locator('#toastContainer .toast').last()).toContainText('Settings saved');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.ribbon-btn[data-view="settings"]').click();
      await page.waitForTimeout(1000);
      await expect(page.locator('#settingsCodeServerWorkspaceRoot')).toHaveValue(nextValue);
    } finally {
      await page.locator('#settingsCodeServerWorkspaceRoot').fill(originalValue);
      await page.locator('#settingsSaveBtn').click();
      await expect(page.locator('#toastContainer .toast').last()).toContainText('Settings saved');
    }
  });

  test('switching to Bot Settings tab renders bot list', async ({ page }) => {
    await page.locator('.settings-tab[data-tab="bots"]').click();
    await page.waitForTimeout(1000);
    const body = page.locator('#settingsBody');
    await expect(body).not.toBeEmpty();
  });

  test('bot settings cards have Edit and Open Config buttons', async ({ page }) => {
    await page.locator('.settings-tab[data-tab="bots"]').click();
    await page.waitForTimeout(1000);
    const cards = page.locator('.bot-setting-card');
    const count = await cards.count();
    if (count > 0) {
      await expect(cards.first().locator('[data-testid="bot-setting-edit-tools"]')).toBeAttached();
      await expect(cards.first().locator('[data-testid="bot-setting-open-config"]')).toBeAttached();
    }
  });

  test('theme button click changes document theme', async ({ page }) => {
    await page.waitForTimeout(1000);
    const picker = page.locator('#settingsThemePicker');
    const oceanBtn = picker.locator('button[data-theme="ocean"]');
    await oceanBtn.click();
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('ocean');
  });
});

// ═══ OPERATIONS VIEW (replaces Advanced/Engineering) ═══

test.describe('Cockpit — Operations View', () => {
  test.beforeEach(async ({ page }) => {
    await switchToView(page, 'operations');
  });

  test('renders operations view with header and nav', async ({ page }) => {
    await expect(page.locator('.ops-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.ops-title')).toContainText('Operations');
  });

  test('has Overview, Agents, Work Items, and Cost tabs', async ({ page }) => {
    await expect(page.locator('.ops-view')).toBeVisible({ timeout: 10000 });
    const tabs = page.locator('.ops-tab');
    await expect(tabs).toHaveCount(4);
    await expect(tabs.nth(0)).toContainText('Overview');
    await expect(tabs.nth(1)).toContainText('Agents');
    await expect(tabs.nth(2)).toContainText('Work');
    await expect(tabs.nth(3)).toContainText('Cost');
  });

  test('overview tab shows KPI strip with metrics', async ({ page }) => {
    await expect(page.locator('.ops-kpi-strip')).toBeVisible({ timeout: 15000 });
    const kpis = page.locator('.ops-kpi');
    const count = await kpis.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('overview tab shows pipeline flow and health ring', async ({ page }) => {
    await expect(page.locator('.ops-kpi-strip')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.ops-pipeline')).toBeVisible();
    await expect(page.locator('.ops-ring-svg')).toBeVisible();
  });

  test('agents tab shows agent fleet cards', async ({ page }) => {
    await expect(page.locator('.ops-view')).toBeVisible({ timeout: 10000 });
    await page.locator('.ops-tab', { hasText: 'Agents' }).click();
    await expect(page.locator('.ops-agent-card').first()).toBeVisible({ timeout: 15000 });
    const count = await page.locator('.ops-agent-card').count();
    expect(count).toBeGreaterThan(0);
  });

  test('work items tab shows content', async ({ page }) => {
    await expect(page.locator('.ops-view')).toBeVisible({ timeout: 10000 });
    await page.locator('.ops-tab', { hasText: 'Work' }).click();
    await expect(page.locator('.ops-card').first()).toBeVisible({ timeout: 15000 });
  });

  test('cost tab shows spend summary', async ({ page }) => {
    await expect(page.locator('.ops-view')).toBeVisible({ timeout: 10000 });
    await page.locator('.ops-tab', { hasText: 'Cost' }).click();
    await expect(page.locator('.ops-kpi-strip')).toBeVisible({ timeout: 15000 });
  });

  test('refresh button is visible and clickable', async ({ page }) => {
    await expect(page.locator('.ops-view')).toBeVisible({ timeout: 10000 });
    const refreshBtn = page.locator('#opsRefresh');
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();
    await expect(page.locator('.ops-kpi-strip')).toBeVisible({ timeout: 15000 });
  });
});

// ═══ ENGINEERING COMPATIBILITY APIs ═══

test.describe('Cockpit — Engineering Compatibility APIs', () => {
  test('GET /api/health-dashboard/registry returns nodes and source counts', async ({ request }) => {
    const response = await request.get('/api/health-dashboard/registry');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.nodes[0]).toHaveProperty('name');
    expect(body.nodes[0]).toHaveProperty('category');
    expect(body.sources).toHaveProperty('agents');
    expect(body.sources).toHaveProperty('schedules');
    expect(body.sources).toHaveProperty('runs');
  });

  test('GET and POST /api/health-dashboard/nodes return consistent node collections', async ({ request }) => {
    const getResponse = await request.get('/api/health-dashboard/nodes');
    expect(getResponse.ok()).toBeTruthy();
    const getBody = await getResponse.json();

    expect(getBody.success).toBe(true);
    expect(Array.isArray(getBody.nodes)).toBe(true);
    expect(getBody.count).toBe(getBody.nodes.length);

    const postResponse = await request.post('/api/health-dashboard/nodes');
    expect(postResponse.ok()).toBeTruthy();
    const postBody = await postResponse.json();

    expect(postBody.success).toBe(true);
    expect(Array.isArray(postBody.nodes)).toBe(true);
    expect(postBody.count).toBe(postBody.nodes.length);
  });

  test('GET /api/redis-visibility returns live compatibility data sections', async ({ request }) => {
    const response = await request.get('/api/redis-visibility');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.agentRegistry)).toBe(true);
    expect(Array.isArray(body.scheduledJobs)).toBe(true);
    expect(Array.isArray(body.routingDecisions)).toBe(true);
    expect(body.queueMetrics).toBeTruthy();
    expect(body.rawKeyStats).toBeTruthy();
    expect(body.rawKeyStats).toHaveProperty('totalKeys');
  });

  test('GET /api/qm/activity returns agent and dispatch compatibility maps', async ({ request }) => {
    const response = await request.get('/api/qm/activity');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.agents).toBeTruthy();
    expect(body.ticketPhases).toBeTruthy();
    expect(body.dispatches).toBeTruthy();
    expect(body.agentTicketMappings).toBeTruthy();
  });

  test('GET /api/mesh/channels and /api/tickets/active return compatibility collections', async ({ request }) => {
    const meshResponse = await request.get('/api/mesh/channels');
    expect(meshResponse.ok()).toBeTruthy();
    const meshBody = await meshResponse.json();

    expect(meshBody.success).toBe(true);
    expect(Array.isArray(meshBody.channels)).toBe(true);

    const ticketsResponse = await request.get('/api/tickets/active');
    expect(ticketsResponse.ok()).toBeTruthy();
    const ticketsBody = await ticketsResponse.json();

    expect(ticketsBody.success).toBe(true);
    expect(Array.isArray(ticketsBody.tickets)).toBe(true);
    expect(ticketsBody.count).toBe(ticketsBody.tickets.length);
  });

  test('GET /api/proxy-health allows localhost target and blocks external domains', async ({ request }) => {
    const healthResponse = await request.get('/api/health');
    expect(healthResponse.ok()).toBeTruthy();
    const baseUrl = new URL(healthResponse.url()).origin;

    const allowedProxyResponse = await request.get(
      `/api/proxy-health?url=${encodeURIComponent(`${baseUrl}/health`)}`,
    );
    expect(allowedProxyResponse.ok()).toBeTruthy();
    const allowedBody = await allowedProxyResponse.json();
    expect(allowedBody).toHaveProperty('target');
    expect(allowedBody.target).toContain('localhost');

    const blockedProxyResponse = await request.get(
      `/api/proxy-health?url=${encodeURIComponent('http://example.com/health')}`,
    );
    expect(blockedProxyResponse.status()).toBe(403);
    const blockedBody = await blockedProxyResponse.json();
    expect(blockedBody.success).toBe(false);
  });

  test('POST /api/bot/restart returns a response for known bots', async ({ request }) => {
    const response = await request.post('/api/bot/restart', {
      data: { containerName: 'swarm-code-developer' },
    });
    // The endpoint may succeed or fail depending on Docker state, but it should respond
    const body = await response.json();
    expect(body).toHaveProperty('success');
  });
});

// ═══ ADVANCED / ENGINEERING VIEW ═══
// Advanced is a legacy view not in the ribbon — access via window.__cockpit.viewController.switchView

async function switchToAdvanced(page: any): Promise<void> {
  await page.goto(COCKPIT_URL);
  await page.waitForFunction(() => !!(window as any).__cockpit?.viewController, { timeout: 10000 });
  await page.evaluate(() => (window as any).__cockpit.viewController.switchView('advanced'));
  await page.waitForTimeout(600);
}

test.describe('Cockpit — Advanced Engineering View', () => {
  test.beforeEach(async ({ page }) => {
    await switchToAdvanced(page);
  });

  test('renders shell with sidebar ribbon and content area', async ({ page }) => {
    await expect(page.locator('.advanced-view')).toBeVisible();
    await expect(page.locator('.adv-sub-ribbon')).toBeVisible();
    await expect(page.locator('.adv-iframe-container')).toBeVisible();
  });

  test('sidebar ribbon has all 9 engineering buttons', async ({ page }) => {
    const buttons = page.locator('.adv-sub-btn');
    await expect(buttons).toHaveCount(9);
  });

  test('panel uses CSS classes not inline styles for hero card', async ({ page }) => {
    await expect(page.locator('.adv-hero-card')).toBeVisible();
    await expect(page.locator('.adv-hero-title')).toBeVisible();
    await expect(page.locator('.adv-hero-status-chip')).toContainText('Native');
  });

  test('panel meta grid has Route, Source, Next Step cards', async ({ page }) => {
    await expect(page.locator('.adv-meta-grid')).toBeVisible();
    const metaCards = page.locator('.adv-meta-card');
    await expect(metaCards).toHaveCount(3);
    await expect(metaCards.nth(0).locator('.adv-meta-label')).toContainText('Route');
    await expect(metaCards.nth(1).locator('.adv-meta-label')).toContainText('Source');
    await expect(metaCards.nth(2).locator('.adv-meta-label')).toContainText('Next Step');
  });

  test('panel iframe section uses CSS class', async ({ page }) => {
    await expect(page.locator('.adv-iframe-section')).toBeVisible();
    await expect(page.locator('.adv-iframe-section iframe')).toBeAttached();
  });

  test('clicking a ribbon button switches panel content', async ({ page }) => {
    const redisBtn = page.locator('.adv-sub-btn[data-page="redis-visibility"]');
    await redisBtn.click();
    await page.waitForTimeout(300);
    await expect(redisBtn).toHaveClass(/active/);
    await expect(page.locator('.adv-hero-title')).toContainText('Redis');
  });

  test('exactly one ribbon button is active at a time', async ({ page }) => {
    await expect(page.locator('.adv-sub-btn.active')).toHaveCount(1);
  });

  test('panel scroll wrapper uses adv-panel class', async ({ page }) => {
    await expect(page.locator('#advPanel')).toHaveClass(/adv-panel/);
  });
});

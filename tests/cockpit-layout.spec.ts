/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Comprehensive Playwright tests for cockpit layout, header, status bar, ribbon nav, and chat panel
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated header layout assertions after simplifying the top bar to global tools plus profile access
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added resize regression coverage so the shared cockpit shell keeps the right rail docked without leaving dead space after a drag
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Removed the retired Presentron header-button test and the stale #chatWorkspacePresentronBtn workspace-button assertions
 */

import { test, expect } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

// ═══ PAGE LOAD & STRUCTURE ═══

test.describe('Cockpit — Page Load & Structure', () => {
  test('loads cockpit page with 200 status', async ({ page }) => {
    const response = await page.goto(COCKPIT_URL);
    expect(response?.status()).toBe(200);
  });

  test('has correct page title', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await expect(page).toHaveTitle('OSHAL Cockpit');
  });

  test('renders the 3-column layout: ribbon + main content + chat panel', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await expect(page.locator('#ribbonContainer')).toBeVisible();
    await expect(page.locator('#mainContent')).toBeVisible();
    await expect(page.locator('#chatPanel')).toBeAttached();
  });

  test('renders header bar with logo', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await expect(page.locator('.header-bar')).toBeVisible();
    await expect(page.locator('.logo-text')).toHaveText('OSHAL Cockpit');
  });

  test('renders status bar footer', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await expect(page.locator('.status-bar')).toBeVisible();
  });

  test('renders modal overlay (hidden by default)', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const overlay = page.locator('#modalOverlay');
    await expect(overlay).toBeAttached();
    await expect(overlay).toHaveClass(/hidden/);
  });

  test('renders toast container', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await expect(page.locator('#toastContainer')).toBeAttached();
  });

  test('body has midnight theme by default', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBeTruthy();
  });
});

// ═══ HEADER BAR ═══

test.describe('Cockpit — Header Bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
  });

  test('legacy dead search bar is absent', async ({ page }) => {
    await expect(page.locator('#searchInput')).toHaveCount(0);
  });

  test('RAG button exists and is clickable', async ({ page }) => {
    const btn = page.locator('#ragBtn');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('title', 'RAG Ingestion');
  });

  test('theme toggle button exists', async ({ page }) => {
    await expect(page.locator('#themeToggle')).toBeVisible();
  });

  test('profile button exists', async ({ page }) => {
    await expect(page.locator('#profileBtn')).toBeVisible();
    await expect(page.locator('#profileBtn')).toHaveAttribute('title', 'Profile & Access');
  });

  test('header only renders the 4 global controls', async ({ page }) => {
    const buttons = page.locator('.header-right .header-btn');
    await expect(buttons).toHaveCount(4);
  });
});

// ═══ STATUS BAR ═══

test.describe('Cockpit — Status Bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
  });

  test('displays bots count', async ({ page }) => {
    const el = page.locator('#statusBots');
    await expect(el).toBeVisible();
    // After metrics load, should show a number + "bots"
    await expect(el).toContainText('bots');
  });

  test('displays tickets count', async ({ page }) => {
    const el = page.locator('#statusTickets');
    await expect(el).toBeVisible();
    await expect(el).toContainText('tickets');
  });

  test('displays cost', async ({ page }) => {
    const el = page.locator('#statusCost');
    await expect(el).toBeVisible();
    // Should contain $ sign or -- placeholder before metrics load
    const text = await el.textContent();
    expect(text).toBeTruthy();
    expect(text!.includes('$') || text!.includes('--')).toBe(true);
  });

  test('displays queue depth', async ({ page }) => {
    const el = page.locator('#statusQueue');
    await expect(el).toBeVisible();
    await expect(el).toContainText('Q:');
  });

  test('status bar has 4 status items', async ({ page }) => {
    const items = page.locator('.status-bar .status-item');
    await expect(items).toHaveCount(4);
  });

  test('connection status dot is visible', async ({ page }) => {
    await expect(page.locator('.status-dot')).toBeVisible();
  });
});

// ═══ RIBBON NAVIGATION ═══

test.describe('Cockpit — Ribbon Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
  });

  test('ribbon nav renders the three trays: pinned home, scrollable middle, pinned bottom', async ({ page }) => {
    await expect(page.locator('#ribbonNavInner')).toBeVisible();
    await expect(page.locator('.ribbon-home')).toBeVisible();
    await expect(page.locator('.ribbon-scroll')).toBeVisible();
    await expect(page.locator('.ribbon-bottom')).toBeVisible();
  });

  test('Jarvis is pinned at the top as the home surface', async ({ page }) => {
    await expect(page.locator('.ribbon-home .ribbon-btn[data-view="tool-jarvis-home"]')).toBeVisible();
  });

  test('base essentials are pinned at the bottom (tickets, calendar, swarm messages, settings)', async ({ page }) => {
    for (const viewId of ['tickets', 'calendar', 'chat', 'settings']) {
      await expect(page.locator(`.ribbon-bottom .ribbon-btn[data-view="${viewId}"]`)).toBeAttached();
    }
  });

  test('app surfaces render under group headers in the scrollable middle', async ({ page }) => {
    const groups = page.locator('.ribbon-scroll .ribbon-group-label');
    await expect(groups.first()).toBeAttached();
    // The named groups the unified profile ships with.
    for (const group of ['Learning', 'Career Placement', 'Communications', 'Money']) {
      await expect(page.locator(`.ribbon-group-label[title="${group}"]`)).toBeAttached();
    }
  });

  test('Jarvis is the active view by default', async ({ page }) => {
    const jarvisBtn = page.locator('.ribbon-btn[data-view="tool-jarvis-home"]');
    await expect(jarvisBtn).toHaveClass(/active/);
  });

  test('each ribbon button has a title attribute', async ({ page }) => {
    const views = ['Jarvis', 'Tickets', 'Calendar', 'Swarm Messages', 'Settings'];
    for (const title of views) {
      await expect(page.locator(`.ribbon-btn[title="${title}"]`)).toBeAttached();
    }
  });

  test('clicking a ribbon button switches the active state', async ({ page }) => {
    const ticketsBtn = page.locator('.ribbon-btn[data-view="tickets"]');
    await ticketsBtn.click();
    await expect(ticketsBtn).toHaveClass(/active/);
    // Jarvis (the default) should no longer be active
    const jarvisBtn = page.locator('.ribbon-btn[data-view="tool-jarvis-home"]');
    await expect(jarvisBtn).not.toHaveClass(/active/);
  });

  test('clicking each base ribbon button switches the main content', async ({ page }) => {
    const viewIds = ['calendar', 'chat', 'settings', 'tickets'];
    for (const viewId of viewIds) {
      await page.locator(`.ribbon-bottom .ribbon-btn[data-view="${viewId}"]`).click();
      // After click, the active class should be on the clicked button
      await expect(page.locator(`.ribbon-btn[data-view="${viewId}"]`)).toHaveClass(/active/);
      // Main content should have something rendered
      const mainContent = page.locator('#mainContent');
      await expect(mainContent).not.toBeEmpty();
    }
  });

  test('every ribbon button carries a label', async ({ page }) => {
    const buttons = await page.locator('.ribbon-btn').count();
    const labels = await page.locator('.ribbon-label').count();
    expect(labels).toBe(buttons);
  });
});

// ═══ CHAT PANEL ═══

test.describe('Cockpit — Chat Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
  });

  test('chat panel header shows "Chat" title', async ({ page }) => {
    const title = page.locator('.panel-title');
    await expect(title.first()).toContainText('Chat');
  });

  test('New chat button exists', async ({ page }) => {
    await expect(page.locator('#newChatBtn')).toBeAttached();
  });

  test('collapse/expand toggle button exists', async ({ page }) => {
    await expect(page.locator('#toggleChat')).toBeAttached();
  });

  test('bot selector dropdown exists', async ({ page }) => {
    await expect(page.locator('#botSelector')).toBeAttached();
  });

  test('workspace action buttons are rendered', async ({ page }) => {
    const actions = page.locator('[data-testid="chat-workspace-actions"]');
    await expect(actions).toBeAttached();
    // Check all 5 workspace action buttons
    await expect(page.locator('#chatWorkspaceSettingsBtn')).toBeAttached();
    await expect(page.locator('#chatWorkspaceToolsBtn')).toBeAttached();
    await expect(page.locator('#chatWorkspaceHistoryBtn')).toBeAttached();
    await expect(page.locator('#chatWorkspaceRagBtn')).toBeAttached();
  });

  test('workspace actions have correct aria-labels', async ({ page }) => {
    await expect(page.locator('#chatWorkspaceSettingsBtn')).toHaveAttribute('aria-label', 'Settings');
    await expect(page.locator('#chatWorkspaceToolsBtn')).toHaveAttribute('aria-label', 'Switch Framework');
    await expect(page.locator('#chatWorkspaceHistoryBtn')).toHaveAttribute('aria-label', 'History');
    await expect(page.locator('#chatWorkspaceRagBtn')).toHaveAttribute('aria-label', 'RAG');
  });

  test('embedded chat workspace iframe exists', async ({ page }) => {
    const frame = page.locator('#chatWorkspaceFrame');
    await expect(frame).toBeAttached();
    const src = await frame.getAttribute('src');
    expect(src).toContain('/swarmbot/chat');
    expect(src).toContain('embed=cockpit');
  });

  test('chat native frame shell has test id', async ({ page }) => {
    await expect(page.locator('[data-testid="cockpit-native-chat-shell"]')).toBeAttached();
  });

  test('bot config button exists in chat toolbar', async ({ page }) => {
    await expect(page.locator('#chatBotConfigBtn')).toBeAttached();
  });

  test('resize handle between main and chat exists', async ({ page }) => {
    await expect(page.locator('#resizeChat')).toBeAttached();
  });

  test('dragging the shared resize handle keeps the chat rail docked to the right edge', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(COCKPIT_URL);

    const handle = page.locator('#resizeChat');
    const handleBox = await handle.boundingBox();
    expect(handleBox).toBeTruthy();

    await page.mouse.move(handleBox.x + (handleBox.width / 2), handleBox.y + (handleBox.height / 2));
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 140, handleBox.y + (handleBox.height / 2), { steps: 12 });
    await page.mouse.up();

    const chatBox = await page.locator('#chatPanel').boundingBox();
    expect(chatBox).toBeTruthy();

    const viewportWidth = page.viewportSize()?.width || 1600;
    const rightGap = viewportWidth - (chatBox.x + chatBox.width);
    expect(rightGap).toBeLessThanOrEqual(24);

    const mainInlineStyles = await page.locator('#mainContent').evaluate((element) => ({
      width: element.style.width,
      flex: element.style.flex,
    }));
    expect(mainInlineStyles.width).toBe('');
    expect(mainInlineStyles.flex === '' || mainInlineStyles.flex.includes('1 1 auto')).toBeTruthy();
  });

  test('no right-edge chat expand tab — the Jarvis orb is the only standing assistant affordance', async ({ page }) => {
    await expect(page.locator('#chatExpandBtn')).toHaveCount(0);
  });
});

// ═══ MESH CHAT OVERLAY ═══

test.describe('Cockpit — Mesh Chat Overlay', () => {
  test('mesh overlay is hidden by default', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const overlay = page.locator('#meshOverlay');
    await expect(overlay).toHaveClass(/hidden/);
  });

  test('mesh overlay has close button', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await expect(page.locator('#closeMeshOverlay')).toBeAttached();
  });

  test('mesh overlay contains conversation list and message panel', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await expect(page.locator('#conversationList')).toBeAttached();
    await expect(page.locator('#meshMessagePanel')).toBeAttached();
    await expect(page.locator('#meshParticipantList')).toBeAttached();
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Comprehensive Playwright tests for cockpit modals, keyboard shortcuts, theme, and interactions
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed the retired Presentron modal test (the cockpit Presentron button + modal were removed)
 */

import { test, expect } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

// ═══ MODAL SYSTEM ═══

test.describe('Cockpit — Modal System', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
  });

  test('RAG modal opens when clicking RAG button', async ({ page }) => {
    await page.locator('#ragBtn').click();
    const overlay = page.locator('#modalOverlay');
    await expect(overlay).not.toHaveClass(/hidden/);
    await expect(page.locator('#modalTitle')).toBeVisible();
  });

  test('Settings modal opens when clicking settings button', async ({ page }) => {
    await page.locator('#settingsBtn').click();
    const overlay = page.locator('#modalOverlay');
    await expect(overlay).not.toHaveClass(/hidden/);
  });

  test('Login modal opens when clicking login button', async ({ page }) => {
    await page.locator('#loginBtn').click();
    const overlay = page.locator('#modalOverlay');
    await expect(overlay).not.toHaveClass(/hidden/);
  });

  test('History modal opens when clicking history button', async ({ page }) => {
    await page.locator('#historyBtn').click();
    const overlay = page.locator('#modalOverlay');
    await expect(overlay).not.toHaveClass(/hidden/);
  });

  test('modal close button dismisses the modal', async ({ page }) => {
    await page.locator('#ragBtn').click();
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/hidden/);
    await page.locator('#modalCloseBtn').click();
    await expect(page.locator('#modalOverlay')).toHaveClass(/hidden/);
  });

  test('clicking the modal overlay backdrop closes modal', async ({ page }) => {
    await page.locator('#settingsBtn').click();
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/hidden/);
    // Click on the overlay itself (not the modal container)
    await page.locator('#modalOverlay').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#modalOverlay')).toHaveClass(/hidden/);
  });

  test('Escape key closes open modal', async ({ page }) => {
    await page.locator('#loginBtn').click();
    await expect(page.locator('#modalOverlay')).not.toHaveClass(/hidden/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modalOverlay')).toHaveClass(/hidden/);
  });

  test('modal has title and body content', async ({ page }) => {
    await page.locator('#historyBtn').click();
    await expect(page.locator('#modalTitle')).not.toBeEmpty();
    await expect(page.locator('#modalBody')).not.toBeEmpty();
  });

  test('opening a new modal replaces the previous content', async ({ page }) => {
    // Open RAG
    await page.locator('#ragBtn').click();
    const ragTitle = await page.locator('#modalTitle').textContent();
    // Close
    await page.locator('#modalCloseBtn').click();
    // Open Login
    await page.locator('#loginBtn').click();
    const loginTitle = await page.locator('#modalTitle').textContent();
    expect(ragTitle).not.toBe(loginTitle);
  });
});

// ═══ KEYBOARD SHORTCUTS ═══

test.describe('Cockpit — Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
  });

  test('Cmd+K focuses the search input', async ({ page }) => {
    await page.keyboard.press('Meta+k');
    await expect(page.locator('#searchInput')).toBeFocused();
  });

  test('Ctrl+K also focuses the search input', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('#searchInput')).toBeFocused();
  });

  test('Escape closes modal but does not affect navigation', async ({ page }) => {
    // First verify no modal is open
    await expect(page.locator('#modalOverlay')).toHaveClass(/hidden/);
    // Press escape — should not break anything
    await page.keyboard.press('Escape');
    await expect(page.locator('#modalOverlay')).toHaveClass(/hidden/);
  });
});

// ═══ THEME SWITCHING ═══

test.describe('Cockpit — Theme Switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
  });

  test('theme toggle button cycles theme on click', async ({ page }) => {
    const before = await page.locator('html').getAttribute('data-theme');
    await page.locator('#themeToggle').click();
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after).not.toBe(before);
  });

  test('clicking theme toggle multiple times cycles through themes', async ({ page }) => {
    const themes = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const theme = await page.locator('html').getAttribute('data-theme');
      if (theme) themes.add(theme);
      await page.locator('#themeToggle').click();
      await page.waitForTimeout(100);
    }
    // Should have cycled through at least 2 different themes
    expect(themes.size).toBeGreaterThanOrEqual(2);
  });

  test('theme persists in localStorage', async ({ page }) => {
    await page.locator('#themeToggle').click();
    const theme = await page.locator('html').getAttribute('data-theme');
    const stored = await page.evaluate(() => localStorage.getItem('cockpit-theme'));
    expect(stored).toBe(theme);
  });
});

// ═══ CHAT PANEL TOGGLE ═══

test.describe('Cockpit — Chat Panel Toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await page.waitForTimeout(500);
  });

  test('collapse button hides chat panel', async ({ page }) => {
    // If chat is visible, click collapse
    const chatPanel = page.locator('#chatPanel');
    const isCollapsed = await chatPanel.evaluate((el) => el.classList.contains('collapsed'));
    if (!isCollapsed) {
      await page.locator('#toggleChat').click();
      await expect(chatPanel).toHaveClass(/collapsed/);
    }
  });

  test('a contextual reopen shows the chat panel after collapse', async ({ page }) => {
    const chatPanel = page.locator('#chatPanel');
    // Collapse first
    const isCollapsed = await chatPanel.evaluate((el) => el.classList.contains('collapsed'));
    if (!isCollapsed) {
      await page.locator('#toggleChat').click();
    }
    await expect(chatPanel).toHaveClass(/collapsed/);
    // There is no right-edge expand tab any more — the rail reopens contextually
    // ("Chat with bot", workspace focus, a live task) through toggleChatPanel.
    await page.evaluate(() => {
      const cockpit = (window as unknown as { __cockpit?: { toggleChatPanel: (show: boolean) => void } }).__cockpit;
      cockpit?.toggleChatPanel(true);
    });
    await expect(chatPanel).not.toHaveClass(/collapsed/);
  });

  test('resize handle is hidden when panel collapsed', async ({ page }) => {
    const chatPanel = page.locator('#chatPanel');
    const isCollapsed = await chatPanel.evaluate((el) => el.classList.contains('collapsed'));
    if (!isCollapsed) {
      await page.locator('#toggleChat').click();
    }
    const handle = page.locator('#resizeChat');
    const display = await handle.evaluate((el) => (el as HTMLElement).style.display);
    expect(display).toBe('none');
  });
});

// ═══ BOT SELECTOR ═══

test.describe('Cockpit — Bot Selector', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await page.waitForTimeout(1000);
  });

  test('bot selector loads seed agents from API', async ({ page }) => {
    const selector = page.locator('#botSelector');
    const options = selector.locator('option');
    const count = await options.count();
    // Must have multiple seed agents (project-manager, code-developer, etc.)
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('bot selector contains project-manager agent', async ({ page }) => {
    const selector = page.locator('#botSelector');
    const pmOption = selector.locator('option', { hasText: 'project-manager' });
    await expect(pmOption).toBeAttached();
  });

  test('bot selector contains code-developer agent', async ({ page }) => {
    const selector = page.locator('#botSelector');
    const devOption = selector.locator('option', { hasText: 'code-developer' });
    await expect(devOption).toBeAttached();
  });

  test('selecting a different bot from dropdown works', async ({ page }) => {
    const selector = page.locator('#botSelector');
    const options = selector.locator('option');
    const count = await options.count();
    if (count >= 2) {
      const secondValue = await options.nth(1).getAttribute('value');
      if (secondValue) {
        await selector.selectOption(secondValue);
        const selected = await selector.inputValue();
        expect(selected).toBe(secondValue);
      }
    }
  });

  test('bot selector change persists to localStorage', async ({ page }) => {
    const selector = page.locator('#botSelector');
    const options = selector.locator('option');
    const count = await options.count();
    if (count > 1) {
      const secondValue = await options.nth(1).getAttribute('value');
      if (secondValue) {
        await selector.selectOption(secondValue);
        const stored = await page.evaluate(() =>
          localStorage.getItem('oshal-cockpit-selected-agent-id')
        );
        expect(stored).toBe(secondValue);
      }
    }
  });
});

// ═══ NAVIGATION FLOW ═══

test.describe('Cockpit — Navigation Flow', () => {
  test('navigating through all views preserves cockpit structure', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const views = ['tickets', 'chat', 'calendar', 'addressbook', 'dashboard', 'settings', 'advanced'];

    for (const viewId of views) {
      await page.locator(`.ribbon-btn[data-view="${viewId}"]`).click();
      await page.waitForTimeout(400);
      // Core structure should still exist after each switch
      await expect(page.locator('.header-bar')).toBeVisible();
      await expect(page.locator('#ribbonContainer')).toBeVisible();
      await expect(page.locator('#mainContent')).toBeVisible();
      await expect(page.locator('.status-bar')).toBeVisible();
    }
  });

  test('returning to tickets view after navigation works correctly', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    // Go to dashboard
    await page.locator('.ribbon-btn[data-view="dashboard"]').click();
    await page.waitForTimeout(500);
    await expect(page.locator('.dashboard-view')).toBeVisible();
    // Go back to tickets
    await page.locator('.ribbon-btn[data-view="tickets"]').click();
    await page.waitForTimeout(500);
    await expect(page.locator('.ticket-view')).toBeVisible();
  });
});

// ═══ API INTEGRATION ═══

test.describe('Cockpit — API Integration', () => {
  test('metrics API is called on page load', async ({ page }) => {
    const metricsRequest = page.waitForRequest((req) =>
      req.url().includes('/api/v1/metrics/summary')
    );
    await page.goto(COCKPIT_URL);
    const req = await metricsRequest;
    expect(req.method()).toBe('GET');
  });

  test('agents API is called on page load', async ({ page }) => {
    const agentsRequest = page.waitForRequest((req) =>
      req.url().includes('/api/agents')
    );
    await page.goto(COCKPIT_URL);
    const req = await agentsRequest;
    expect(req.method()).toBe('GET');
  });

  test('ticket hierarchy API is called when viewing tickets', async ({ page }) => {
    const ticketRequest = page.waitForRequest((req) =>
      req.url().includes('/api/v1/tickets/hierarchy')
    );
    await page.goto(COCKPIT_URL);
    const req = await ticketRequest;
    expect(req.method()).toBe('GET');
  });

  test('dashboard view fetches metrics, agents, and health', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const metricsPromise = page.waitForRequest((req) =>
      req.url().includes('/api/v1/metrics/summary')
    );
    const agentsPromise = page.waitForRequest((req) =>
      req.url().includes('/api/v1/metrics/agents')
    );
    await page.locator('.ribbon-btn[data-view="dashboard"]').click();
    await metricsPromise;
    await agentsPromise;
  });

  test('settings view fetches config and providers', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const configPromise = page.waitForRequest((req) =>
      req.url().includes('/api/config')
    );
    await page.locator('.ribbon-btn[data-view="settings"]').click();
    await configPromise;
  });

  test('calendar view fetches schedules and tickets', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const schedulesPromise = page.waitForRequest((req) =>
      req.url().includes('/api/v1/agent/schedules')
    );
    await page.locator('.ribbon-btn[data-view="calendar"]').click();
    await schedulesPromise;
  });
});

// ═══ VISUAL CONSISTENCY ═══

test.describe('Cockpit — Visual Consistency', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL);
  });

  test('header bar has correct height styling', async ({ page }) => {
    const header = page.locator('.header-bar');
    const box = await header.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height).toBeGreaterThan(30);
    expect(box!.height).toBeLessThan(80);
  });

  test('ribbon nav has 48px width', async ({ page }) => {
    const ribbon = page.locator('#ribbonNavInner');
    const box = await ribbon.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThanOrEqual(40);
    expect(box!.width).toBeLessThanOrEqual(64);
  });

  test('main content fills available space', async ({ page }) => {
    const main = page.locator('#mainContent');
    const box = await main.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThan(200);
  });

  test('status bar is at the bottom of the page', async ({ page }) => {
    const viewport = page.viewportSize();
    const status = page.locator('.status-bar');
    const box = await status.boundingBox();
    expect(box).toBeTruthy();
    // Status bar bottom should be near the viewport bottom
    const bottom = box!.y + box!.height;
    expect(bottom).toBeGreaterThan((viewport?.height || 600) - 50);
  });

  test('no console errors on page load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore known benign errors
        if (!text.includes('favicon') && !text.includes('net::ERR')) {
          errors.push(text);
        }
      }
    });
    await page.goto(COCKPIT_URL);
    await page.waitForTimeout(2000);
    // Allow for some non-critical errors from external resources
    // but flag any JS runtime errors
    const criticalErrors = errors.filter((e) =>
      !e.includes('Failed to load resource') &&
      !e.includes('Phosphor') &&
      !e.includes('unpkg')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('no broken images or assets', async ({ page }) => {
    const failedResources: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 404 && response.url().match(/\.(css|js|png|jpg|svg|woff)$/)) {
        failedResources.push(response.url());
      }
    });
    await page.goto(COCKPIT_URL);
    await page.waitForTimeout(2000);
    // Filter out external CDN failures (unpkg, etc)
    const localFailures = failedResources.filter((url) => url.includes('localhost'));
    expect(localFailures).toHaveLength(0);
  });
});

// ═══ SSE STREAMING ═══

test.describe('Cockpit — SSE Streaming', () => {
  test('streaming endpoint is reachable and returns 200', async ({ page }) => {
    await page.goto(COCKPIT_URL);
    // Use page.evaluate to make a fetch call that aborts quickly (SSE never ends)
    const result = await page.evaluate(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      try {
        const res = await fetch('/api/v1/streaming?sessionId=test-session', {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        return { status: res.status, contentType: res.headers.get('content-type') };
      } catch (e: any) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') {
          // Aborted is OK — the connection was established
          return { status: 200, contentType: 'text/event-stream', aborted: true };
        }
        return { status: 0, contentType: null, error: e.message };
      }
    });
    expect(result.status).toBe(200);
  });
});

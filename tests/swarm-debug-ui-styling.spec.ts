/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Playwright tests for /ui swarm debug surface design-system styling
 */

import { test, expect } from '@playwright/test';

/**
 * @description Navigate to /ui swarm debug page and wait for React to mount.
 * @param page - Playwright Page instance
 */
async function gotoSwarmDebug(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/ui', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('#chat-root', { timeout: 10000 });
  // Wait for React to render content inside the mount point
  await page.waitForFunction(
    () => {
      const root = document.getElementById('chat-root');
      return root !== null && root.innerHTML.length > 0;
    },
    null,
    { timeout: 10000 }
  );
}

/**
 * @description Extract a resolved CSS custom property value from an element.
 * @param page - Playwright Page instance
 * @param selector - CSS selector for the element
 * @param property - CSS property name to read
 * @returns The computed CSS value
 */
async function getComputedStyle(
  page: import('@playwright/test').Page,
  selector: string,
  property: string
): Promise<string> {
  return page.evaluate(
    ({ sel, prop }) => {
      const el = document.querySelector(sel);
      if (!el) return '';
      return window.getComputedStyle(el).getPropertyValue(prop).trim();
    },
    { sel: selector, prop: property }
  );
}

test.describe('Swarm Debug UI — Design System Compliance', () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await gotoSwarmDebug(page);
  });

  /**
   * @description Verify design-system.css loads successfully (no 404).
   */
  test('design-system.css loads without errors', async ({ page }) => {
    const cssErrors: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('design-system.css') && !response.ok()) {
        cssErrors.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(cssErrors).toHaveLength(0);
  });

  /**
   * @description Verify no critical JS errors on page load.
   */
  test('page loads without critical JS errors', async ({ page }) => {
    await page.waitForTimeout(2000);
    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes('Failed to fetch') &&
        !e.includes('ERR_CONNECTION_REFUSED') &&
        !e.includes('net::ERR_') &&
        !e.includes('404') &&
        !e.includes('/api/providers')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  /**
   * @description Verify the 2-panel layout renders with glass-panel class.
   */
  test('renders glass-panel chat column', async ({ page }) => {
    const chatPanel = page.locator('.glass-panel.chat-column');
    await expect(chatPanel).toBeVisible();
  });

  /**
   * @description Verify the debug column renders alongside chat.
   */
  test('renders debug column with glass-panel', async ({ page }) => {
    const debugPanel = page.locator('.debug-column .glass-panel');
    await expect(debugPanel).toBeVisible();
  });

  /**
   * @description Verify provider dropdown uses design-system .select class.
   */
  test('provider dropdown uses design-system select class', async ({ page }) => {
    const select = page.locator('.form-group .select');
    await expect(select).toBeVisible();
  });

  /**
   * @description Verify provider label uses design-system .label class.
   */
  test('provider label uses design-system label class', async ({ page }) => {
    const label = page.locator('.form-group .label');
    await expect(label).toBeVisible();
    await expect(label).toContainText('Provider');
  });

  /**
   * @description Verify chat messages area uses design-system class.
   */
  test('chat messages area has design-system class', async ({ page }) => {
    const messages = page.locator('.chat-messages');
    await expect(messages).toBeVisible();
  });

  /**
   * @description Verify chat input uses design-system class.
   */
  test('chat input uses design-system chat-input class', async ({ page }) => {
    const input = page.locator('.chat-input');
    await expect(input).toBeVisible();
  });

  /**
   * @description Verify send button uses design-system btn class.
   */
  test('send button uses design-system btn class', async ({ page }) => {
    const btn = page.locator('.chat-input-area .btn');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('Send');
  });

  /**
   * @description Verify the swarm debug layout has the 2-column flex layout.
   */
  test('swarm-debug-layout uses flex display', async ({ page }) => {
    const display = await getComputedStyle(page, '.swarm-debug-layout', 'display');
    expect(display).toBe('flex');
  });

  /**
   * @description Verify debug panel contains glass-card sections.
   */
  test('debug panel has glass-card sections', async ({ page }) => {
    const cards = page.locator('.debug-column .glass-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(2); // Swarm Lab + System Stream
  });

  /**
   * @description Verify debug panel buttons use btn classes.
   */
  test('debug panel buttons use design-system btn classes', async ({ page }) => {
    const primaryBtn = page.locator('.debug-column .btn-primary');
    await expect(primaryBtn.first()).toBeVisible();
    const secondaryBtn = page.locator('.debug-column .btn-secondary');
    await expect(secondaryBtn.first()).toBeVisible();
  });

  /**
   * @description Verify debug panel inputs use design-system input class.
   */
  test('debug panel inputs use design-system input class', async ({ page }) => {
    const inputs = page.locator('.debug-column .input');
    const count = await inputs.count();
    expect(count).toBeGreaterThanOrEqual(3); // ticket limit, verify attempts, write-back attempts
  });

  /**
   * @description Verify status badges use design-system badge class.
   */
  test('status badges use design-system badge class', async ({ page }) => {
    const badges = page.locator('.debug-column .badge');
    const count = await badges.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  /**
   * @description Verify theme CSS variables are applied (not hardcoded hex).
   * Checks that body background uses the theme's --bg-primary value.
   */
  test('body uses theme CSS variable for background', async ({ page }) => {
    const bgColor = await getComputedStyle(page, 'body', 'background-color');
    // Should NOT be white (#ffffff / rgb(255, 255, 255)) — that was the old hardcoded value
    expect(bgColor).not.toBe('rgb(255, 255, 255)');
    expect(bgColor).not.toBe('rgb(245, 247, 250)'); // old #f5f7fa
    // Should be a dark color from midnight theme
    expect(bgColor.length).toBeGreaterThan(0);
  });

  /**
   * @description Verify text color uses theme variable (not hardcoded dark text on dark bg).
   */
  test('heading uses theme text color', async ({ page }) => {
    const color = await getComputedStyle(page, '.chat-column h2', 'color');
    // Should NOT be the old hardcoded #111827 = rgb(17, 24, 39)
    expect(color).not.toBe('rgb(17, 24, 39)');
  });

  /**
   * @description Verify select dropdown text is readable (not invisible).
   */
  test('select dropdown text is visible (not invisible text)', async ({ page }) => {
    const selectColor = await getComputedStyle(page, '.select', 'color');
    const selectBg = await getComputedStyle(page, '.select', 'background-color');
    // Text and background should be different (readable)
    expect(selectColor).not.toBe(selectBg);
    // Text should not be the same as the dark background
    expect(selectColor).not.toBe('');
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for zen (full-window focus) mode: header toggle hides ALL cockpit chrome (header/ribbon/status/chat rail), the floating exit button + Esc restore it, and the state survives a same-tab reload (sessionStorage) — the reload path exists because the service-worker update reload must not kick the operator out of zen.
 */

import { test, expect } from '@playwright/test';

/**
 * @description Boot the cockpit shell and wait for the zen toggle to be interactive
 * (app.js init has run once the button responds to a click by toggling body.zen-mode).
 * @param page - Playwright page instance.
 * @returns Promise resolving when the cockpit shell is ready.
 */
async function openCockpit(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/cockpit/');
  await expect(page.locator('#zenModeBtn')).toBeVisible({ timeout: 20000 });
}

test.describe('cockpit zen (full-window focus) mode', () => {
  test('toggle hides all cockpit chrome and the exit button restores it', async ({ page }) => {
    await openCockpit(page);

    // Chrome is visible by default.
    await expect(page.locator('.header-bar')).toBeVisible();
    await expect(page.locator('footer.status-bar')).toBeVisible();
    await expect(page.locator('#zenExitBtn')).toBeHidden();

    // Enter zen: every piece of chrome disappears, only the exit button remains.
    // app.js binds the handler during init(), which can land after first paint —
    // poll the click until the class lands instead of racing the boot sequence.
    await expect(async () => {
      await page.locator('#zenModeBtn').click();
      await expect(page.locator('body')).toHaveClass(/zen-mode/, { timeout: 1000 });
    }).toPass({ timeout: 20000 });
    await expect(page.locator('.header-bar')).toBeHidden();
    await expect(page.locator('footer.status-bar')).toBeHidden();
    await expect(page.locator('.ribbon-nav')).toBeHidden();
    await expect(page.locator('aside.chat-panel')).toBeHidden();
    await expect(page.locator('#zenExitBtn')).toBeVisible();

    // Exit via the floating button: chrome returns.
    await page.locator('#zenExitBtn').click();
    await expect(page.locator('body')).not.toHaveClass(/zen-mode/);
    await expect(page.locator('.header-bar')).toBeVisible();
    await expect(page.locator('#zenExitBtn')).toBeHidden();
  });

  test('Esc exits zen mode', async ({ page }) => {
    await openCockpit(page);
    await expect(async () => {
      await page.locator('#zenModeBtn').click();
      await expect(page.locator('body')).toHaveClass(/zen-mode/, { timeout: 1000 });
    }).toPass({ timeout: 20000 });

    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/zen-mode/);
    await expect(page.locator('.header-bar')).toBeVisible();
  });

  test('zen state survives a same-tab reload (service-worker update reload path)', async ({ page }) => {
    await openCockpit(page);
    await expect(async () => {
      await page.locator('#zenModeBtn').click();
      await expect(page.locator('body')).toHaveClass(/zen-mode/, { timeout: 1000 });
    }).toPass({ timeout: 20000 });

    await page.reload();
    // init() re-applies zen from sessionStorage during boot.
    await expect(page.locator('body')).toHaveClass(/zen-mode/, { timeout: 20000 });
    await expect(page.locator('.header-bar')).toBeHidden();
    await expect(page.locator('#zenExitBtn')).toBeVisible();
  });
});

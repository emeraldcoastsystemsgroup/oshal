/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright coverage for Claude Code auth controls in provider configuration UI
 */

import { test, expect } from '@playwright/test';

/**
 * @description Playwright tests for Claude Code authentication controls rendered in the API configuration UI.
 */
test.describe('Claude Code Auth Settings UI', () => {
  test('renders Claude Code sign-in controls while preserving provider config fields', async ({ page }) => {
    await page.route('**/api/claude-code/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          available: true,
          authenticated: false,
          authMethod: null,
          email: null,
        }),
      });
    });

    await page.goto('/ui');
    await page.selectOption('#plan-provider', 'claude-code');

    const planConfig = page.locator('#plan-provider-config');
    await expect(planConfig.locator('[data-claude-code-signin]')).toBeVisible();
    await expect(planConfig.locator('[data-claude-code-status]')).toContainText('Not signed in');
    await expect(page.locator('#plan-claudeCodePath')).toBeVisible();
  });

  test('shows signed-in Claude Code status with sign-out action when backend is authenticated', async ({ page }) => {
    await page.route('**/api/claude-code/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          available: true,
          authenticated: true,
          authMethod: 'claude.ai',
          email: 'developer@example.com',
        }),
      });
    });

    await page.goto('/ui');
    await page.selectOption('#plan-provider', 'claude-code');

    const planConfig = page.locator('#plan-provider-config');
    await expect(planConfig.locator('[data-claude-code-signin]')).toBeHidden();
    await expect(planConfig.locator('[data-claude-code-signout]')).toBeVisible();
    await expect(planConfig.locator('[data-claude-code-status]')).toContainText('Signed in as developer@example.com via claude.ai');
  });
});

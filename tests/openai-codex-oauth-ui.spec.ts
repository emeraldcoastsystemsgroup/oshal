/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Playwright coverage for OpenAI Codex OAuth settings UI behavior
 */

import { test, expect } from '@playwright/test';

/**
 * @description Playwright tests for OpenAI Codex OAuth configuration UX in the legacy settings page.
 */
test.describe('OpenAI Codex OAuth Settings UI', () => {
  test('renders OAuth sign-in controls and removes API key field for OpenAI Codex', async ({ page }) => {
    await page.route('**/api/openai-codex/oauth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, authenticated: false }),
      });
    });

    await page.goto('/ui');
    await page.selectOption('#plan-provider', 'openai-codex');

    const planConfig = page.locator('#plan-provider-config');
    await expect(planConfig.locator('[data-openai-codex-signin]')).toBeVisible();
    await expect(planConfig.locator('[data-openai-codex-status]')).toContainText('Not signed in');
    await expect(page.locator('#plan-openAiCodexApiKey')).toHaveCount(0);
  });

  test('shows sign-out state when backend reports authenticated OpenAI Codex session', async ({ page }) => {
    await page.route('**/api/openai-codex/oauth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          authenticated: true,
          email: 'developer@example.com',
        }),
      });
    });

    await page.goto('/ui');
    await page.selectOption('#plan-provider', 'openai-codex');

    const planConfig = page.locator('#plan-provider-config');
    await expect(planConfig.locator('[data-openai-codex-signin]')).toBeHidden();
    await expect(planConfig.locator('[data-openai-codex-signout]')).toBeVisible();
    await expect(planConfig.locator('[data-openai-codex-status]')).toContainText('Signed in as developer@example.com');
  });
});

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added chat routing regression tests for root redirect and ES-module script loading
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added provider-status and return-to-chat settings workflow assertions
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added theme-registry assertions for new gray, black, and light-blue cockpit themes
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added cached-provider-summary and premium-theme assertions for refreshed standalone chat
 */

import { expect, test } from '@playwright/test';

test.describe('Chat Routing', () => {
  test('root route redirects to standalone chat', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/chat$/);
  });

  test('ui route does not throw module export syntax errors', async ({ page }) => {
    const scriptErrors: string[] = [];

    page.on('pageerror', (error) => {
      scriptErrors.push(error.message);
    });

    page.on('console', (message) => {
      if (message.type() === 'error') {
        scriptErrors.push(message.text());
      }
    });

    await page.goto('/ui');
    await page.waitForTimeout(500);

    const exportSyntaxError = scriptErrors.find((entry) => entry.includes("Unexpected token 'export'"));
    const moduleMimeError = scriptErrors.find((entry) => entry.includes('Failed to load module script'));

    expect(exportSyntaxError).toBeUndefined();
    expect(moduleMimeError).toBeUndefined();
  });

  test('chat header shows provider status summary', async ({ page }) => {
    await page.goto('/chat');
    await expect(page.locator('#providerStatus')).toContainText('Provider:');
  });

  test('ui page back button returns to chat', async ({ page }) => {
    await page.goto('/ui');
    await page.locator('#returnToChatBtn').click();
    await expect(page).toHaveURL(/\/chat$/);
  });

  test('ui theme chooser includes expanded premium theme catalog', async ({ page }) => {
    await page.goto('/ui');
    const themeSelect = page.locator('#themeSelect');
    await expect(themeSelect).toBeVisible();
    const themeOptions = await page.locator('#themeSelect option').evaluateAll((options) => {
      return options.map((option) => option.getAttribute('value'));
    });
    expect(themeOptions).toContain('gray');
    expect(themeOptions).toContain('black');
    expect(themeOptions).toContain('light-blue');
    expect(themeOptions).toContain('aurora');
    expect(themeOptions).toContain('graphite');
    expect(themeOptions).toContain('amber');

    await themeSelect.selectOption('aurora');
    await expect(themeSelect).toHaveValue('aurora');
    await expect.poll(async () => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('aurora');
  });

  test('chat footer summary falls back to cached embedded provider selection after refresh', async ({ page, request }) => {
    await request.delete('/api/config');
    await page.addInitScript(() => {
      localStorage.setItem('clineApiConfig', JSON.stringify({
        mode: 'plan',
        planModeApiProvider: 'anthropic',
        planModeApiModelId: 'claude-sonnet-4-5',
      }));
    });

    await page.goto('/chat');
    await expect.poll(async () => page.locator('#providerStatus').textContent()).toContain('Anthropic');
    await expect.poll(async () => page.locator('#modelSummary').textContent()).toContain('claude-sonnet-4-5');
  });
});

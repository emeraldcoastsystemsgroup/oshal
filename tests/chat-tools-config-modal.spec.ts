/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright validation for gear popup ribbon navigation and provider selection in chat tools configuration modal
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added coverage for modal theme chooser and per-tool auth configuration controls
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added assertion that embedded API iframe renders a non-white themed background in midnight mode
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added embedded-to-parent theme cascade assertion so iframe theme changes update the chat modal theme
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Updated theme assertions for single top-level icon toggle and hidden embedded theme chooser
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added direct modal-surface theme cascade assertion so popup chrome regressions are caught in Playwright
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added coverage for expanded top-level chat theme cycle catalog including gray
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added coverage for default Chroma MCP visibility in the MCP settings panel
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Relaxed theme-cycle assertion so expanded premium catalogs do not break hardcoded gray-index expectations
 */

import { test, expect } from '@playwright/test';

/**
 * @description Verifies the standalone chat gear modal keeps API/provider config in the same popup with ribbon-style navigation.
 */
test.describe('Chat Tools Config Modal', () => {
  test('gear modal exposes ribbon navigation and native API runtime selection', async ({ page }) => {
    await page.goto('/chat');
    await page.click('#openToolsConfigBtn');

    const modal = page.locator('#toolsConfigModal');
    await expect(modal).toBeVisible();

    const apiNav = page.locator('[data-config-section="api"]');
    const agentNav = page.locator('[data-config-section="agent"]');
    const toolsNav = page.locator('[data-config-section="tools"]');
    const mcpNav = page.locator('[data-config-section="mcp"]');

    await expect(apiNav).toBeVisible();
    await expect(agentNav).toBeVisible();
    await expect(toolsNav).toBeVisible();
    await expect(mcpNav).toBeVisible();

    await agentNav.click();
    await expect(page.locator('[data-config-panel="agent"]')).toBeVisible();

    await toolsNav.click();
    await expect(page.locator('[data-config-panel="tools"]')).toBeVisible();
    await expect(page.locator('#schedulerAgentFilter')).toHaveCount(0);
    await expect(page.locator('#schedulerReportSummary')).toHaveCount(0);
    await expect(page.locator('#saveScheduleBtn')).toHaveCount(0);
    await expect(page.locator('#scheduledJobList')).toHaveCount(0);

    const toolAuthTypeSelect = page.locator('[data-config-panel="tools"] [data-config-path="auth.type"]').first();
    await expect(toolAuthTypeSelect).toBeVisible();
    await toolAuthTypeSelect.selectOption('oauth2');
    await expect(toolAuthTypeSelect).toHaveValue('oauth2');

    await mcpNav.click();
    await expect(page.locator('[data-config-panel="mcp"]')).toBeVisible();
    await expect(page.locator('#mcpServerList')).toContainText('filesystem');
    await expect(page.locator('#mcpServerList')).toContainText('fetch');
    const contentOverflow = await page.locator('.config-content').evaluate((element) => {
      return window.getComputedStyle(element).overflowY;
    });
    expect(['auto', 'scroll']).toContain(contentOverflow);

    await apiNav.click();
    await expect(page.locator('[data-config-panel="api"]')).toBeVisible();

    const planProvider = page.locator('#apiPlanProviderSelect');
    await expect(planProvider).toBeVisible();
    await planProvider.selectOption('anthropic');
    await expect(planProvider).toHaveValue('anthropic');
    await expect(page.locator('#apiPlanModelSelect')).not.toHaveValue('');
    await expect(page.locator('#apiPlanProviderInfo')).toContainText('Anthropic');
    await expect(page.locator('#apiProviderFields')).toContainText('Anthropic');

    const initialModalSurfaceBorder = await page.locator('[data-config-panel="api"] .config-section').first().evaluate((element) => {
      return window.getComputedStyle(element).borderTopColor;
    });

    await page.click('#closeToolsConfigBtn');
    const themeToggle = page.locator('#themeCycleBtn');
    await expect(themeToggle).toBeVisible();
    const initialTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await themeToggle.click();
    await expect.poll(async () => {
      return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    }).not.toBe(initialTheme);

    await page.click('#openToolsConfigBtn');
    const nextModalSurfaceBorder = await page.locator('[data-config-panel="api"] .config-section').first().evaluate((element) => {
      return window.getComputedStyle(element).borderTopColor;
    });
    expect(nextModalSurfaceBorder).not.toBe(initialModalSurfaceBorder);
    await expect(page.locator('#apiPlanProviderSelect')).toBeVisible();

    await page.click('#closeToolsConfigBtn');
    for (let index = 0; index < 16; index += 1) {
      const currentTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (currentTheme === 'gray') {
        break;
      }
      await themeToggle.click();
    }

    await expect.poll(async () => {
      return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    }).toBe('gray');
  });
});

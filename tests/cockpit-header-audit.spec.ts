/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added cockpit header-audit coverage for top-bar utility buttons after removing the dead global search control
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated the header RAG audit to validate the shared embedded knowledge workspace instead of the retired cockpit-local modal
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Updated the header Presentron audit to validate the shared embedded studio instead of the retired cockpit-local modal
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Expanded header audits to cover theme persistence, quick-settings clarity, and history restore wiring
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Updated header workspace audits for cockpit workspace-focus mode and swarm-default RAG targeting
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added workspace-focus width-toggle coverage so heavyweight header tools prove the new wider stage behavior
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added drag-resize and quick-settings default-stage coverage for cockpit workspace focus
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Simplified header audits to cover only global tools plus the new profile-access modal
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Retired the Presentron header-button + studio audit (button removed); assert the renamed AI Office button (#openAiOfficeBtn) in the embedded chat frame instead
 */

import { expect, test } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

async function openHeaderModal(
  page: import('@playwright/test').Page,
  buttonSelector: string,
  expectedTitle: string,
): Promise<void> {
  await page.locator(buttonSelector).click();
  await expect(page.locator('#modalOverlay')).not.toHaveClass(/hidden/);
  await expect(page.locator('#modalTitle')).toHaveText(expectedTitle);
}

async function getChatFrame(page: import('@playwright/test').Page) {
  await expect(page.locator('#chatWorkspaceFrame')).toBeVisible();
  const frame = page.frameLocator('#chatWorkspaceFrame');
  await expect(frame.locator('body')).toBeAttached();
  await expect(frame.locator('#openRagBtn')).toBeVisible();
  await expect(frame.locator('#openAiOfficeBtn')).toBeVisible();
  return frame;
}

async function setWorkspaceFocusCustomWidth(
  page: import('@playwright/test').Page,
  width: number,
): Promise<void> {
  await page.evaluate((nextWidth) => {
    const cockpit = (window as Window & { __cockpit?: { setWorkspaceFocusCustomWidth?: (width: number) => void } }).__cockpit;
    if (!cockpit?.setWorkspaceFocusCustomWidth) {
      throw new Error('Workspace focus controller is not available');
    }
    cockpit.setWorkspaceFocusCustomWidth(nextWidth);
  }, width);
  await page.waitForTimeout(300);
}

test.describe('Cockpit header audit', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(COCKPIT_URL, { waitUntil: 'domcontentloaded' });
  });

  test('header shows only working utility controls and no dead global search field', async ({ page }) => {
    await expect(page.locator('.logo-text')).toHaveText('OSHAL Cockpit');
    await expect(page.locator('#searchInput')).toHaveCount(0);
    await expect(page.locator('#ragBtn')).toBeVisible();
    await expect(page.locator('#themeToggle')).toBeVisible();
    await expect(page.locator('#profileBtn')).toBeVisible();
    await expect(page.locator('#settingsBtn')).toHaveCount(0);
    await expect(page.locator('#historyBtn')).toHaveCount(0);
  });

  test('RAG button opens the shared embedded knowledge workspace', async ({ page }) => {
    const frame = await getChatFrame(page);

    await page.locator('#ragBtn').click();

    await expect(page.locator('.cockpit-body')).toHaveClass(/workspace-focus-mode/);
    await expect(page.locator('#chatWorkspaceFocusLabel')).toContainText('Swarm Knowledge');
    await expect(page.locator('#toggleWorkspaceFocusWidthBtn')).toHaveText('Wider');
    await expect(frame.locator('#ragModal')).toBeVisible();
    await expect(frame.locator('#ragScopeSwarm')).toBeChecked();
    await expect(frame.locator('#ragCollectionPreview')).toHaveText('swarm-knowledge');
    await expect(frame.locator('#ragTargetSummary')).toContainText('General swarm knowledge');
    await expect(frame.locator('#ragDropZone')).toContainText('Drop files here or browse from disk');
    await expect(frame.locator('#ragAgentSelect')).toBeDisabled();
    await expect(page.locator('#workspaceFocusResizeHandle')).toBeVisible();

    const startingBox = await page.locator('#chatPanel').boundingBox();
    expect(startingBox?.width || 0).toBeGreaterThan(800);
    await setWorkspaceFocusCustomWidth(page, Math.round((startingBox?.width || 1120) - 180));
    const resizedBox = await page.locator('#chatPanel').boundingBox();
    expect(resizedBox?.width || 0).toBeLessThan((startingBox?.width || 0) - 120);
    await expect(page.locator('#toggleWorkspaceFocusWidthBtn')).toHaveText('Reset Width');

    await frame.locator('.rag-workspace-close').click();
    await expect(frame.locator('#ragModal')).toBeHidden();
    await page.locator('#exitWorkspaceFocusBtn').click();
    await expect(page.locator('.cockpit-body')).not.toHaveClass(/workspace-focus-mode/);

    await page.locator('#ragBtn').click();
    const reopenedBox = await page.locator('#chatPanel').boundingBox();
    expect(reopenedBox?.width || 0).toBeLessThan((startingBox?.width || 0) - 120);
    await expect(page.locator('#toggleWorkspaceFocusWidthBtn')).toHaveText('Reset Width');
    await page.locator('#toggleWorkspaceFocusWidthBtn').click();
    await expect(page.locator('#toggleWorkspaceFocusWidthBtn')).toHaveText('Wider');
    await frame.locator('.rag-workspace-close').click();
    await page.locator('#exitWorkspaceFocusBtn').click();
  });

  test('theme button cycles the cockpit theme', async ({ page }) => {
    const html = page.locator('html');
    const initialTheme = await html.getAttribute('data-theme');
    await page.locator('#themeToggle').click();
    const nextTheme = await html.getAttribute('data-theme');
    expect(nextTheme).not.toBe(initialTheme);
    await expect(page.locator('#toastContainer .toast').last()).toContainText('Theme:');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(html).toHaveAttribute('data-theme', nextTheme || '');
  });

  test('profile button opens profile access and hands off to the ribbon settings page', async ({ page }) => {
    await page.locator('#profileBtn').click();
    await expect(page.locator('#modalTitle')).toHaveText('Profile & Access');
    await expect(page.locator('#profileStatusText')).toContainText('not signed in');
    await expect(page.locator('#profileSettingsAction')).toBeVisible();
    await expect(page.locator('#profileSignInAction')).toBeVisible();
    await page.locator('#profileSettingsAction').click();
    await expect(page.locator('#modalOverlay')).toHaveClass(/hidden/);
    await expect(page.locator('.settings-tab.active')).toHaveText('Global Settings');
    await expect(page.locator('#settingsBody')).toContainText('Theme');
  });

  test('profile button shows sign-out actions when the operator is authenticated', async ({ page }) => {
    await page.evaluate(() => {
      window.localStorage.setItem('oshal_access_token', 'test-token');
      window.localStorage.setItem('oshal_user', 'operator@example.com');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#profileBtn').click();
    await expect(page.locator('#modalTitle')).toHaveText('Profile & Access');
    await expect(page.locator('#profileStatusText')).toContainText('operator@example.com');
    await expect(page.locator('#profileSignOutAction')).toBeVisible();
    await page.locator('#profileSignOutAction').click();
    await expect(page.locator('#toastContainer .toast').last()).toContainText('Logged out');
    await page.locator('#profileBtn').click();
    await expect(page.locator('#profileSignInAction')).toBeVisible();
  });
});

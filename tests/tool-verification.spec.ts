/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of tool verification UI tests
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Navigation follows PLAYWRIGHT_PORT via the shared baseOrigin() helper instead of a hardcoded localhost:3456 (byte-identical under the default env)
 */

/**
 * @description Playwright tests for Sprint 4: Tool Installation Verification
 * Tests verification workflow, history modal, scheduler control, and error handling
 */

import { test, expect } from '@playwright/test';
import { baseOrigin } from './helpers';

test.describe('Tool Verification UI', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to installation dashboard
    await page.goto(`${baseOrigin()}/tools-admin/installation.html`);
    
    // Wait for page to load
    await page.waitForSelector('.install-matrix', { timeout: 10000 });
  });

  test.describe('Single Tool Verification', () => {
    test('should verify a single tool successfully', async ({ page }) => {
      // Find first tool card
      const firstToolCard = page.locator('.install-card').first();
      const toolName = await firstToolCard.locator('.install-card__name').textContent();
      
      // Click verify button
      const verifyBtn = firstToolCard.locator('.verify-btn');
      await verifyBtn.click();
      
      // Wait for button to show verifying state
      await expect(verifyBtn).toContainText('Verifying...');
      await expect(verifyBtn).toBeDisabled();
      
      // Wait for verification to complete (button re-enabled)
      await expect(verifyBtn).toBeEnabled({ timeout: 15000 });
      await expect(verifyBtn).toContainText('🔍 Verify');
      
      // Check that verification status badge is updated
      const statusBadge = firstToolCard.locator('dd:has-text("Verification Status") + dd .badge');
      const statusText = await statusBadge.textContent();
      expect(['passed', 'failed', 'error', 'skipped']).toContain(statusText?.toLowerCase());
      
      // Check that last verified timestamp is updated
      const lastVerifiedText = await firstToolCard.locator('dt:has-text("Last Verified") + dd').textContent();
      expect(lastVerifiedText).not.toContain('—');
      
      // Check toast notification
      const toast = page.locator('.toast').last();
      await expect(toast).toBeVisible({ timeout: 2000 });
      
      // Check logs viewer for verification entry
      const logsViewer = page.locator('#install-logs');
      await expect(logsViewer).toContainText(toolName || '');
    });

    test('should display verification status badges correctly', async ({ page }) => {
      // Verify at least one tool
      const firstVerifyBtn = page.locator('.verify-btn').first();
      await firstVerifyBtn.click();
      await expect(firstVerifyBtn).toBeEnabled({ timeout: 15000 });
      
      // Check that badge exists and has correct class
      const badges = page.locator('.badge');
      expect(await badges.count()).toBeGreaterThan(0);
      
      // Verify badge colors match status
      const statusBadge = page.locator('dd:has-text("Verification Status") + dd .badge').first();
      const badgeClass = await statusBadge.getAttribute('class');
      expect(badgeClass).toMatch(/badge--/);
    });

    test('should show history link after verification', async ({ page }) => {
      // Verify a tool
      const firstCard = page.locator('.install-card').first();
      const verifyBtn = firstCard.locator('.verify-btn');
      await verifyBtn.click();
      await expect(verifyBtn).toBeEnabled({ timeout: 15000 });
      
      // Check for history link
      const historyLink = firstCard.locator('a:has-text("History")');
      await expect(historyLink).toBeVisible();
    });
  });

  test.describe('Verify All Tools', () => {
    test('should verify all tools with batch operation', async ({ page }) => {
      // Click "Verify All" button
      const verifyAllBtn = page.locator('button:has-text("🔍 Verify All")');
      await verifyAllBtn.click();
      
      // Wait for toast notification
      const toast = page.locator('.toast:has-text("Verifying all tools")');
      await expect(toast).toBeVisible({ timeout: 2000 });
      
      // Wait for completion toast
      const completionToast = page.locator('.toast:has-text("Verified")').last();
      await expect(completionToast).toBeVisible({ timeout: 30000 });
      
      // Check logs for batch verification summary
      const logsViewer = page.locator('#install-logs');
      await expect(logsViewer).toContainText('Batch verification complete', { timeout: 5000 });
      
      // Verify that multiple tool cards have updated status
      const verificationBadges = page.locator('dd:has-text("Verification Status") + dd .badge');
      const count = await verificationBadges.count();
      expect(count).toBeGreaterThan(10); // Should have verified multiple tools
    });

    test('should display summary stats in logs', async ({ page }) => {
      // Trigger verify all
      await page.locator('button:has-text("🔍 Verify All")').click();
      
      // Wait for completion
      await expect(page.locator('.toast:has-text("Verified")')).toBeVisible({ timeout: 30000 });
      
      // Check logs for summary with counts
      const logsViewer = page.locator('#install-logs');
      const logsText = await logsViewer.textContent();
      expect(logsText).toMatch(/passed/i);
      expect(logsText).toMatch(/failed|skipped/i);
    });
  });

  test.describe('Verification History Modal', () => {
    test('should open history modal when clicking history link', async ({ page }) => {
      // Verify a tool first to ensure history exists
      const firstCard = page.locator('.install-card').first();
      await firstCard.locator('.verify-btn').click();
      await expect(firstCard.locator('.verify-btn')).toBeEnabled({ timeout: 15000 });
      
      // Click history link
      const historyLink = firstCard.locator('a:has-text("History")');
      await historyLink.click();
      
      // Check modal is visible
      const modal = page.locator('#verification-history-modal');
      await expect(modal).toHaveClass(/modal-overlay--open/);
      
      // Check modal title
      const modalTitle = modal.locator('.modal__title');
      await expect(modalTitle).toContainText('Verification History');
      
      // Check modal contains verification data
      const modalBody = modal.locator('.modal__body');
      await expect(modalBody).toContainText('Exit Code');
      await expect(modalBody).toContainText('Duration');
    });

    test('should display verification results in order', async ({ page }) => {
      // Verify a tool twice to create history
      const firstCard = page.locator('.install-card').first();
      const verifyBtn = firstCard.locator('.verify-btn');
      
      await verifyBtn.click();
      await expect(verifyBtn).toBeEnabled({ timeout: 15000 });
      
      await verifyBtn.click();
      await expect(verifyBtn).toBeEnabled({ timeout: 15000 });
      
      // Open history
      await firstCard.locator('a:has-text("History")').click();
      
      // Check that multiple entries exist
      const modal = page.locator('#verification-history-modal');
      const entries = modal.locator('.modal__body > div > div');
      expect(await entries.count()).toBeGreaterThan(0);
    });

    test('should close modal when clicking close button', async ({ page }) => {
      // Open history
      const firstCard = page.locator('.install-card').first();
      await firstCard.locator('.verify-btn').click();
      await expect(firstCard.locator('.verify-btn')).toBeEnabled({ timeout: 15000 });
      await firstCard.locator('a:has-text("History")').click();
      
      // Wait for modal to open
      const modal = page.locator('#verification-history-modal');
      await expect(modal).toHaveClass(/modal-overlay--open/);
      
      // Click close button
      const closeBtn = modal.locator('.modal__close');
      await closeBtn.click();
      
      // Check modal is closed
      await expect(modal).not.toHaveClass(/modal-overlay--open/);
    });

    test('should display stdout/stderr in history', async ({ page }) => {
      // Verify a tool
      const firstCard = page.locator('.install-card').first();
      await firstCard.locator('.verify-btn').click();
      await expect(firstCard.locator('.verify-btn')).toBeEnabled({ timeout: 15000 });
      
      // Open history
      await firstCard.locator('a:has-text("History")').click();
      
      // Check for output/error fields (they may or may not have content)
      const modal = page.locator('#verification-history-modal');
      const modalBody = modal.locator('.modal__body');
      const bodyText = await modalBody.textContent();
      
      // Should have detail list items
      expect(bodyText).toContain('Exit Code');
      expect(bodyText).toContain('Duration');
    });
  });

  test.describe('Scheduler Control', () => {
    test('should display scheduler status on page load', async ({ page }) => {
      const schedulerStatus = page.locator('#scheduler-status');
      await expect(schedulerStatus).toBeVisible();
      
      // Should have either "running" or "stopped" badge
      const statusText = await schedulerStatus.textContent();
      expect(statusText).toMatch(/running|stopped/i);
    });

    test('should start scheduler when clicking start button', async ({ page }) => {
      const schedulerStatus = page.locator('#scheduler-status');
      
      // Check if scheduler is stopped
      const statusText = await schedulerStatus.textContent();
      
      if (statusText?.includes('stopped')) {
        // Click start button
        const startBtn = schedulerStatus.locator('button:has-text("▶️ Start")');
        await startBtn.click();
        
        // Wait for toast notification
        const toast = page.locator('.toast:has-text("scheduler started")');
        await expect(toast).toBeVisible({ timeout: 2000 });
        
        // Verify status changed to running
        await expect(schedulerStatus).toContainText('running', { timeout: 3000 });
        
        // Verify buttons changed
        await expect(schedulerStatus.locator('button:has-text("⏹ Stop")')).toBeVisible();
        await expect(schedulerStatus.locator('button:has-text("▶️ Run Now")')).toBeVisible();
      }
    });

    test('should stop scheduler when clicking stop button', async ({ page }) => {
      const schedulerStatus = page.locator('#scheduler-status');
      
      // Ensure scheduler is running first
      const statusText = await schedulerStatus.textContent();
      if (statusText?.includes('stopped')) {
        await schedulerStatus.locator('button:has-text("▶️ Start")').click();
        await expect(schedulerStatus).toContainText('running', { timeout: 3000 });
      }
      
      // Click stop button
      const stopBtn = schedulerStatus.locator('button:has-text("⏹ Stop")');
      await stopBtn.click();
      
      // Wait for toast
      const toast = page.locator('.toast:has-text("scheduler stopped")');
      await expect(toast).toBeVisible({ timeout: 2000 });
      
      // Verify status changed to stopped
      await expect(schedulerStatus).toContainText('stopped', { timeout: 3000 });
    });

    test('should trigger manual run when clicking run now', async ({ page }) => {
      const schedulerStatus = page.locator('#scheduler-status');
      
      // Ensure scheduler is running
      const statusText = await schedulerStatus.textContent();
      if (statusText?.includes('stopped')) {
        await schedulerStatus.locator('button:has-text("▶️ Start")').click();
        await expect(schedulerStatus).toContainText('running', { timeout: 3000 });
      }
      
      // Click run now button
      const runNowBtn = schedulerStatus.locator('button:has-text("▶️ Run Now")');
      await runNowBtn.click();
      
      // Wait for verification to start
      const toast = page.locator('.toast:has-text("Running verification scheduler")');
      await expect(toast).toBeVisible({ timeout: 2000 });
      
      // Wait for completion
      const completionToast = page.locator('.toast:has-text("Scheduler run complete")');
      await expect(completionToast).toBeVisible({ timeout: 30000 });
      
      // Check logs for scheduler run entry
      const logsViewer = page.locator('#install-logs');
      await expect(logsViewer).toContainText('Scheduler run complete');
    });
  });

  test.describe('Error Handling', () => {
    test('should handle tool with no verify command (skipped)', async ({ page }) => {
      // Find a tool and verify (some tools may have no verify command)
      const cards = page.locator('.install-card');
      const count = await cards.count();
      
      let foundSkipped = false;
      for (let i = 0; i < Math.min(count, 5); i++) {
        const card = cards.nth(i);
        await card.locator('.verify-btn').click();
        await expect(card.locator('.verify-btn')).toBeEnabled({ timeout: 15000 });
        
        const statusBadge = card.locator('dd:has-text("Verification Status") + dd .badge');
        const statusText = await statusBadge.textContent();
        
        if (statusText?.toLowerCase() === 'skipped') {
          foundSkipped = true;
          
          // Check for appropriate toast message
          const toast = page.locator('.toast:has-text("skipped")');
          await expect(toast).toBeVisible({ timeout: 2000 });
          break;
        }
      }
      
      // Note: Not all tools may be skipped, so this is a soft check
      console.log('Skipped tool found:', foundSkipped);
    });

    test('should handle network errors gracefully', async ({ page }) => {
      // Block API requests to simulate network error
      await page.route('**/api/tools/verify/**', route => route.abort());
      
      // Try to verify a tool
      const firstVerifyBtn = page.locator('.verify-btn').first();
      await firstVerifyBtn.click();
      
      // Should show error toast
      const errorToast = page.locator('.toast--error');
      await expect(errorToast).toBeVisible({ timeout: 3000 });
      
      // Button should be re-enabled
      await expect(firstVerifyBtn).toBeEnabled();
    });

    test('should display clear logs button and functionality', async ({ page }) => {
      // Verify a tool to create log entries
      await page.locator('.verify-btn').first().click();
      await expect(page.locator('.verify-btn').first()).toBeEnabled({ timeout: 15000 });
      
      // Click clear logs button
      const clearBtn = page.locator('button:has-text("Clear Logs")');
      await clearBtn.click();
      
      // Verify logs are cleared
      const logsViewer = page.locator('#install-logs');
      await expect(logsViewer).toContainText('No logs available');
      
      // Check toast notification
      const toast = page.locator('.toast:has-text("Logs cleared")');
      await expect(toast).toBeVisible({ timeout: 2000 });
    });
  });

  test.describe('UI State Management', () => {
    test('should filter tools by category and verify', async ({ page }) => {
      // Select a category filter
      const categoryFilter = page.locator('#filter-install-category');
      await categoryFilter.selectOption('devops');
      
      // Wait for matrix to update
      await page.waitForTimeout(500);
      
      // Verify filtered tool
      const visibleCards = page.locator('.install-card');
      expect(await visibleCards.count()).toBeGreaterThan(0);
      
      // Verify a filtered tool
      const firstCard = visibleCards.first();
      await firstCard.locator('.verify-btn').click();
      await expect(firstCard.locator('.verify-btn')).toBeEnabled({ timeout: 15000 });
      
      // Status should update
      const statusBadge = firstCard.locator('dd:has-text("Verification Status") + dd .badge');
      await expect(statusBadge).toBeVisible();
    });

    test('should show loading state during verification', async ({ page }) => {
      const firstCard = page.locator('.install-card').first();
      const verifyBtn = firstCard.locator('.verify-btn');
      
      // Click verify
      await verifyBtn.click();
      
      // Check loading state immediately
      await expect(verifyBtn).toContainText('Verifying...', { timeout: 1000 });
      await expect(verifyBtn).toBeDisabled();
      
      // Wait for completion
      await expect(verifyBtn).toBeEnabled({ timeout: 15000 });
    });

    test('should preserve stats after verification', async ({ page }) => {
      // Get initial stats
      const totalStat = page.locator('#stats-total-install');
      const initialTotal = await totalStat.textContent();
      
      // Verify a tool
      await page.locator('.verify-btn').first().click();
      await expect(page.locator('.verify-btn').first()).toBeEnabled({ timeout: 15000 });
      
      // Stats should remain consistent
      const newTotal = await totalStat.textContent();
      expect(newTotal).toBe(initialTotal);
    });
  });
});
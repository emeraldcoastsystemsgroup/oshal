/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — chat operational flow end-to-end tests
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Rewrote to match actual API response formats and page structure
 */

import { test, expect } from '@playwright/test';

/**
 * @description End-to-end tests for the chat operational flow.
 *              Validates the complete user journey: auth → config → provider → chat.
 *              Run with: PLAYWRIGHT_PORT=3456 PLAYWRIGHT_REUSE_SERVER=true npx playwright test tests/chat-operational-flow.spec.ts
 */
test.describe('Chat Operational Flow', () => {
  test.describe('Server Health', () => {
    test('health endpoint returns ok', async ({ request }) => {
      const response = await request.get('/api/health');
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      expect(body.status).toBe('ok');
    });

    test('provider registry returns available providers', async ({ request }) => {
      const response = await request.get('/api/providers');
      expect(response.ok()).toBeTruthy();
      const providers = await response.json();
      expect(Array.isArray(providers)).toBeTruthy();
      expect(providers.length).toBeGreaterThan(0);

      const providerIds = providers.map((p: { id: string }) => p.id);
      expect(providerIds).toContain('anthropic');
    });

    test('anthropic provider includes claude models', async ({ request }) => {
      const response = await request.get('/api/providers');
      const providers = await response.json();
      const anthropic = providers.find((p: { id: string }) => p.id === 'anthropic');
      expect(anthropic).toBeDefined();
      expect(anthropic.models.length).toBeGreaterThan(0);
      const hasClaudeModel = anthropic.models.some((m: string) => m.includes('claude'));
      expect(hasClaudeModel).toBeTruthy();
    });
  });

  test.describe('Chat UI Loading', () => {
    test('chat page loads with heading', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');
      const heading = page.locator('h1');
      await expect(heading).toBeVisible({ timeout: 10000 });
    });

    test('mock OIDC user is logged in', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');
      await expect(page.locator('text=dev-user')).toBeVisible({ timeout: 10000 });
    });

    test('provider dropdown is populated', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');
      const select = page.locator('select').first();
      await expect(select).toBeVisible({ timeout: 10000 });
      const optionCount = await select.locator('option').count();
      expect(optionCount).toBeGreaterThan(5);
    });

    test('chat section has message input and send button', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');
      const input = page.locator('input[placeholder="Type a message..."]');
      await expect(input).toBeVisible({ timeout: 10000 });
      const sendBtn = page.locator('button:has-text("Send")');
      await expect(sendBtn).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Provider Configuration', () => {
    test('can select anthropic provider and save', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      const select = page.locator('select').first();
      await expect(select).toBeVisible({ timeout: 10000 });
      await select.selectOption('anthropic');

      const saveBtn = page.locator('button:has-text("Save Configuration")');
      await expect(saveBtn).toBeVisible({ timeout: 10000 });
      await saveBtn.click();

      await expect(page.locator('text=Configuration saved successfully')).toBeVisible({ timeout: 10000 });
    });

    test('auth popup opens and closes', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      const authBtn = page.locator('button:has-text("🔑")');
      await expect(authBtn).toBeVisible({ timeout: 10000 });
      await authBtn.click();

      await expect(page.locator('text=API Key / Credentials')).toBeVisible({ timeout: 5000 });
      
      const closeBtn = page.locator('button:has-text("Close")');
      await closeBtn.click();
      await expect(page.locator('text=API Key / Credentials')).not.toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Chat Message Flow', () => {
    test('can send a message and get response', async ({ page }) => {
      await page.goto('/chat');
      await page.waitForLoadState('networkidle');

      const input = page.locator('input[placeholder="Type a message..."]');
      await expect(input).toBeVisible({ timeout: 10000 });
      await input.fill('Hello smoke test');

      const sendBtn = page.locator('button:has-text("Send")');
      await sendBtn.click();

      // Wait for the user message to appear
      await expect(page.locator('text=Hello smoke test')).toBeVisible({ timeout: 10000 });

      // Wait for response (stub or real LLM)
      await page.waitForTimeout(5000);
      const paragraphs = await page.locator('p').allTextContents();
      const hasResponse = paragraphs.some(t => t.includes('[noop]') || t.length > 20);
      expect(hasResponse).toBeTruthy();
    });
  });

  test.describe('API Integration', () => {
    test('send message API returns task ID and status', async ({ request }) => {
      const taskId = `test_${Date.now()}`;
      const response = await request.post('/api/send-message', {
        data: { message: 'API test', taskId },
      });
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      expect(body.taskId).toBe(taskId);
      expect(body.status).toBe('processing');
    });

    test('config save API persists settings', async ({ request }) => {
      const response = await request.post('/api/config', {
        data: {
          actModeApiProvider: 'anthropic',
          actModeApiModelId: 'claude-sonnet-4-5-20250929',
          mode: 'act',
        },
      });
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      expect(body.success).toBeTruthy();
    });

    test('config load returns saved provider', async ({ request }) => {
      // Save first
      await request.post('/api/config', {
        data: {
          actModeApiProvider: 'anthropic',
          actModeApiModelId: 'claude-sonnet-4-5-20250929',
          mode: 'act',
        },
      });

      const loadResponse = await request.get('/api/config');
      expect(loadResponse.ok()).toBeTruthy();
      const config = await loadResponse.json();
      expect(config.actModeApiProvider).toBe('anthropic');
      expect(config.actModeApiModelId).toBe('claude-sonnet-4-5-20250929');
    });
  });
});
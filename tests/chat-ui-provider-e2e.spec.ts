/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | E2E test: gear modal → provider select → save → send message → verify response
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${process.env.PLAYWRIGHT_PORT || 3456}`;

test.describe('Chat UI Provider Selection E2E', () => {
  test('should load chat page, open gear modal, show providers, select one, save, send message, get response', async ({ page }) => {
    test.setTimeout(180_000);

    /* Step 1: Navigate to /chat */
    await page.goto(`${BASE_URL}/chat`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000); /* Allow JS modules to initialize */
    await page.screenshot({ path: 'test-results/01-chat-loaded.png', fullPage: true });

    /* Step 2: Verify the chat page loaded with key elements */
    const chatPanel = page.locator('#chatPanel');
    await expect(chatPanel).toBeVisible();

    const gearButton = page.locator('#openToolsConfigBtn');
    await expect(gearButton).toBeVisible();

    /* Step 3: Click gear to open config modal */
    await gearButton.click();
    await page.waitForTimeout(2000); /* Wait for modal to load config from APIs */
    await page.screenshot({ path: 'test-results/02-gear-modal-open.png', fullPage: true });

    /* Step 4: Verify config modal is visible */
    const modal = page.locator('#toolsConfigModal');
    await expect(modal).not.toHaveAttribute('hidden', '');

    /* Step 5: Check Act mode provider dropdown has options */
    const actProviderSelect = page.locator('#apiActProviderSelect');
    await expect(actProviderSelect).toBeVisible();

    const actOptions = await actProviderSelect.locator('option').allTextContents();
    console.log('Act provider options:', actOptions);
    expect(actOptions.length).toBeGreaterThan(5); /* Should have 41+ providers */

    /* Step 6: Check that OpenAI Codex is in the list */
    const hasCodex = actOptions.some(opt => opt.toLowerCase().includes('codex'));
    expect(hasCodex).toBe(true);

    /* Step 7: Select OpenAI Codex provider */
    await actProviderSelect.selectOption('openai-codex');
    await page.waitForTimeout(500);

    /* Step 8: Verify model dropdown updated */
    const actModelSelect = page.locator('#apiActModelSelect');
    const modelOptions = await actModelSelect.locator('option').allTextContents();
    console.log('Model options for openai-codex:', modelOptions);
    expect(modelOptions.length).toBeGreaterThan(0);

    /* Step 9: Select a model */
    await actModelSelect.selectOption('codex-mini-latest');

    /* Step 10: Set mode to Act */
    const actModeBtn = page.locator('#apiModeActBtn');
    await actModeBtn.click();

    await page.screenshot({ path: 'test-results/03-provider-selected.png', fullPage: true });

    /* Step 11: Save API config */
    const saveBtn = page.locator('#saveToolsConfigBtn');
    await saveBtn.click();
    await page.waitForTimeout(2000);

    /* Step 12: Verify save succeeded (check modal status) */
    const modalStatus = page.locator('#modalStatus');
    const statusText = await modalStatus.textContent();
    console.log('Modal status after save:', statusText);
    expect(statusText).toContain('Saved');

    await page.screenshot({ path: 'test-results/04-config-saved.png', fullPage: true });

    /* Step 13: Close modal */
    const closeBtn = page.locator('#closeToolsConfigBtn');
    await closeBtn.click();
    await page.waitForTimeout(500);

    /* Step 14: Verify provider status shows in footer */
    const providerStatus = page.locator('#providerStatus');
    const providerText = await providerStatus.textContent();
    console.log('Footer provider status:', providerText);
    expect(providerText).toContain('OpenAI Codex');

    /* Step 15: Type and send a message */
    const messageInput = page.locator('#messageInput');
    await messageInput.fill('Say hello in one sentence.');
    const sendBtn = page.locator('#sendBtn');
    await sendBtn.click();

    /* Step 16: Wait for response (up to 120s for LLM) */
    const assistantMessage = page.locator('.assistant-message').first();
    await expect(assistantMessage).toBeVisible({ timeout: 120_000 });

    const responseText = await assistantMessage.textContent();
    console.log('LLM response:', responseText);
    expect(responseText.length).toBeGreaterThan(5);

    await page.screenshot({ path: 'test-results/05-response-received.png', fullPage: true });
  });
});
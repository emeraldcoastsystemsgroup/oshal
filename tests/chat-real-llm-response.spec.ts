/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Playwright test for real LLM response via Cline CLI + OpenAI Codex
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${process.env.PLAYWRIGHT_PORT || 3456}`;

/**
 * @description Verifies that the chat endpoint produces a real LLM response (not a mirrored stub)
 * when the user sends a message through the agentic pipeline backed by Cline CLI
 * and the configured API provider (e.g., openai-codex with codex-mini-latest).
 *
 * This test validates the full provider wiring chain:
 *   POST /api/send-message → TaskOrchestrator → agentic loop → ClaudeCodeProvider
 *   → Cline CLI (--json -y) → OpenAI Codex API → completion_result → HTTP response
 *
 * Prerequisites:
 *   - Server running with MOCK_OIDC=true (no Keycloak required)
 *   - output/global-config.json has a valid API provider and model
 *   - ~/.cline/data/secrets.json has valid OAuth credentials for the provider
 *   - No Postgres or Redis required (fallback paths handle unavailability)
 */
test.describe('Real LLM Response Flow', () => {
  test('should send a message and receive a real LLM response (not a stub mirror)', async ({ request }) => {
    test.setTimeout(120_000);

    const taskId = `pw-real-llm-${Date.now()}`;

    const response = await request.post(`${BASE_URL}/api/send-message`, {
      data: {
        taskId,
        text: 'Say hello in exactly one sentence.',
        agenticMode: true,
      },
    });

    expect(response.status()).toBe(200);

    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.response).toBeTruthy();
    expect(typeof body.response).toBe('string');
    expect(body.response.length).toBeGreaterThan(5);
    expect(body.turnCount).toBeGreaterThanOrEqual(1);

    /* The response should NOT be a verbatim mirror of the input prompt */
    expect(body.response).not.toContain('Say hello in exactly one sentence');

    /* Usage summary should indicate real token consumption */
    if (body.usageSummary) {
      expect(body.usageSummary.totalTokens).toBeGreaterThan(0);
    }
  });

  test('should persist the assistant response in message history', async ({ request }) => {
    test.setTimeout(120_000);

    const taskId = `pw-real-llm-history-${Date.now()}`;

    /* Send a message through the real LLM pipeline */
    const sendResponse = await request.post(`${BASE_URL}/api/send-message`, {
      data: {
        taskId,
        text: 'What is 2 plus 2? Answer in one word.',
        agenticMode: true,
      },
    });

    expect(sendResponse.status()).toBe(200);
    const sendBody = await sendResponse.json();
    expect(sendBody.success).toBe(true);

    /* Verify message history contains both user and assistant messages */
    const historyResponse = await request.get(`${BASE_URL}/api/${taskId}/messages`);
    expect(historyResponse.status()).toBe(200);

    const historyBody = await historyResponse.json();
    expect(historyBody.messages.length).toBeGreaterThanOrEqual(2);

    const roles = historyBody.messages.map((msg: { role: string }) => msg.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');

    const assistantMessage = historyBody.messages.find((msg: { role: string }) => msg.role === 'assistant');
    expect(assistantMessage).toBeTruthy();
    expect(assistantMessage.text.length).toBeGreaterThan(0);
  });
});
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live product-path proof for Workflow Studio
 *                     |               | talk-to-build persistence.
 */

/**
 * @description
 * Authenticated live proof that Workflow Studio can turn an operator prompt into
 * a persisted graph through the same chat endpoint the UI uses.
 */
import { test, expect } from './fixtures';
import { openCockpit, openTool } from './helpers';

type WorkflowAssistPayload = {
  success?: boolean;
  needsInput?: boolean;
  definitionId?: string;
  definition?: {
    id?: string;
    nodes?: unknown[];
    edges?: unknown[];
  };
  message?: string;
  error?: string;
};

test('Workflow Studio chat endpoint saves a surfaced workflow graph', async ({ page }, testInfo) => {
  test.setTimeout(300_000);

  await openCockpit(page);
  const studio = await openTool(page, 'tool-workflow-studio');
  expect(studio, 'Workflow Studio should render in its own /workflow-studio iframe').toBeTruthy();

  await expect(studio!.locator('.wf-chat-panel'), 'Talk-to-build panel should be visible').toBeVisible({ timeout: 60_000 });
  await expect(studio!.locator('#wfChatInput'), 'Workflow chat input should be visible').toBeVisible();
  await expect(studio!.locator('#wfChatSend'), 'Workflow chat send button should be visible').toBeEnabled();

  const response = await page.evaluate(async () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 180_000);
    try {
      const res = await fetch('/api/workflow-studio/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({
          description: [
            'Create a simple three-step workflow named Live Builder Proof.',
            'First intake a customer request, then have a review bot inspect it, then deliver the final answer.',
          ].join(' '),
        }),
      });
      const text = await res.text();
      let payload: WorkflowAssistPayload | { raw: string };
      try {
        payload = JSON.parse(text) as WorkflowAssistPayload;
      } catch {
        payload = { raw: text.slice(0, 800) };
      }
      return { status: res.status, ok: res.ok, payload };
    } catch (error) {
      return { status: 0, ok: false, payload: { error: error instanceof Error ? error.message : String(error) } };
    } finally {
      window.clearTimeout(timer);
    }
  }) as { status: number; ok: boolean; payload: WorkflowAssistPayload };

  await testInfo.attach('workflow-studio-chat-response.json', {
    body: JSON.stringify(response, null, 2),
    contentType: 'application/json',
  });

  expect(response.status, JSON.stringify(response.payload)).toBe(200);
  expect(response.payload.success, JSON.stringify(response.payload)).toBe(true);
  expect(response.payload.needsInput, JSON.stringify(response.payload)).not.toBe(true);
  expect(response.payload.definitionId, JSON.stringify(response.payload)).toBeTruthy();
  expect(response.payload.definition?.nodes?.length ?? 0).toBeGreaterThanOrEqual(3);
  expect(response.payload.definition?.edges?.length ?? 0).toBeGreaterThanOrEqual(2);

  const persisted = await page.evaluate(async (definitionId) => {
    const res = await fetch(`/api/workflow-studio/definitions/${encodeURIComponent(String(definitionId))}`, {
      credentials: 'same-origin',
    });
    return { status: res.status, payload: await res.json().catch(() => ({})) };
  }, response.payload.definitionId);

  expect(persisted.status, JSON.stringify(persisted.payload)).toBe(200);
  await testInfo.attach('workflow-studio-persisted-definition.json', {
    body: JSON.stringify(persisted.payload, null, 2),
    contentType: 'application/json',
  });
});

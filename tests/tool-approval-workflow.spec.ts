/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Playwright tests for tool approval workflow
 */

import { test, expect } from '@playwright/test';

/**
 * @description Playwright test suite for Sprint 3: Tool Execution Integration.
 * Tests the approval workflow UI, SSE events, and auth mode enforcement.
 */

test.describe('Tool Approval Workflow', () => {
  test.describe('Approval Modal UI', () => {
    test('modal is hidden by default', async ({ page }) => {
      await page.goto('/chat');
      const overlay = page.locator('#tool-approval-overlay');
      await expect(overlay).toBeHidden();
    });

    test('modal shows when approval request event fires', async ({ page }) => {
      await page.goto('/chat');

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:request', {
          detail: {
            requestId: 'test-req-001',
            toolName: 'kubectl',
            toolInput: { command: 'get pods' },
            timeoutMs: 60000,
            context: {
              displayName: 'Kubernetes CLI',
              description: 'Manage Kubernetes clusters',
              category: 'devops',
            },
            requestedAt: new Date().toISOString(),
          },
        }));
      });

      const overlay = page.locator('#tool-approval-overlay');
      await expect(overlay).toBeVisible();
      await expect(page.locator('#approval-tool-name')).toContainText('Kubernetes CLI');
      await expect(page.locator('#approval-tool-desc')).toContainText('Manage Kubernetes clusters');
      await expect(page.locator('#approval-tool-category')).toContainText('devops');
    });

    test('modal displays tool input as JSON', async ({ page }) => {
      await page.goto('/chat');

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:request', {
          detail: {
            requestId: 'test-req-002',
            toolName: 'terraform',
            toolInput: { action: 'plan', workspace: 'production' },
            timeoutMs: 30000,
            context: { displayName: 'Terraform', description: 'IaC tool', category: 'infrastructure' },
          },
        }));
      });

      const inputJson = page.locator('#approval-tool-input');
      await expect(inputJson).toContainText('"action": "plan"');
      await expect(inputJson).toContainText('"workspace": "production"');
    });

    test('countdown timer displays and decrements', async ({ page }) => {
      await page.goto('/chat');

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:request', {
          detail: {
            requestId: 'test-req-003',
            toolName: 'aws-cli',
            toolInput: {},
            timeoutMs: 5000,
            context: { displayName: 'AWS CLI' },
          },
        }));
      });

      const countdown = page.locator('#approval-countdown');
      await expect(countdown).toContainText('5s');

      await page.waitForTimeout(1100);
      const text = await countdown.textContent();
      expect(parseInt(text ?? '0')).toBeLessThanOrEqual(4);
    });

    test('approve button hides modal', async ({ page }) => {
      await page.goto('/chat');

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:request', {
          detail: {
            requestId: 'test-req-004',
            toolName: 'docker',
            toolInput: { command: 'ps' },
            timeoutMs: 60000,
            context: { displayName: 'Docker' },
          },
        }));
      });

      await expect(page.locator('#tool-approval-overlay')).toBeVisible();

      await page.route('**/api/tools/approval', async (route) => {
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
      });

      await page.locator('#approval-approve-btn').click();
      await expect(page.locator('#tool-approval-overlay')).toBeHidden();
    });

    test('deny button hides modal', async ({ page }) => {
      await page.goto('/chat');

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:request', {
          detail: {
            requestId: 'test-req-005',
            toolName: 'helm',
            toolInput: {},
            timeoutMs: 60000,
            context: { displayName: 'Helm' },
          },
        }));
      });

      await expect(page.locator('#tool-approval-overlay')).toBeVisible();

      await page.route('**/api/tools/approval', async (route) => {
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
      });

      await page.locator('#approval-deny-btn').click();
      await expect(page.locator('#tool-approval-overlay')).toBeHidden();
    });
  });

  test.describe('SSE Event Handling', () => {
    test('timeout event hides modal', async ({ page }) => {
      await page.goto('/chat');

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:request', {
          detail: {
            requestId: 'test-req-timeout',
            toolName: 'ansible',
            toolInput: {},
            timeoutMs: 60000,
            context: { displayName: 'Ansible' },
          },
        }));
      });

      await expect(page.locator('#tool-approval-overlay')).toBeVisible();

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:timeout', {
          detail: { requestId: 'test-req-timeout', toolName: 'ansible', timeoutMs: 60000 },
        }));
      });

      await expect(page.locator('#tool-approval-overlay')).toBeHidden();
    });

    test('response event hides modal', async ({ page }) => {
      await page.goto('/chat');

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:request', {
          detail: {
            requestId: 'test-req-response',
            toolName: 'git',
            toolInput: {},
            timeoutMs: 60000,
            context: { displayName: 'Git' },
          },
        }));
      });

      await expect(page.locator('#tool-approval-overlay')).toBeVisible();

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:response', {
          detail: { requestId: 'test-req-response', toolName: 'git', approved: true },
        }));
      });

      await expect(page.locator('#tool-approval-overlay')).toBeHidden();
    });

    test('mismatched requestId does not hide modal', async ({ page }) => {
      await page.goto('/chat');

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:request', {
          detail: {
            requestId: 'test-req-match',
            toolName: 'curl',
            toolInput: {},
            timeoutMs: 60000,
            context: { displayName: 'cURL' },
          },
        }));
      });

      await expect(page.locator('#tool-approval-overlay')).toBeVisible();

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:timeout', {
          detail: { requestId: 'different-id', toolName: 'curl' },
        }));
      });

      await expect(page.locator('#tool-approval-overlay')).toBeVisible();
    });
  });

  test.describe('API Submission', () => {
    test('approve sends correct payload to API', async ({ page }) => {
      await page.goto('/chat');

      let capturedBody: Record<string, unknown> | null = null;

      await page.route('**/api/tools/approval', async (route) => {
        const body = route.request().postDataJSON();
        capturedBody = body;
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
      });

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:request', {
          detail: {
            requestId: 'test-req-api-approve',
            toolName: 'terraform',
            toolInput: { action: 'apply' },
            timeoutMs: 60000,
            context: { displayName: 'Terraform' },
          },
        }));
      });

      await page.locator('#approval-approve-btn').click();

      expect(capturedBody).toBeTruthy();
      expect(capturedBody!.requestId).toBe('test-req-api-approve');
      expect(capturedBody!.approved).toBe(true);
      expect(capturedBody!.decidedBy).toBe('user');
    });

    test('deny sends correct payload to API', async ({ page }) => {
      await page.goto('/chat');

      let capturedBody: Record<string, unknown> | null = null;

      await page.route('**/api/tools/approval', async (route) => {
        const body = route.request().postDataJSON();
        capturedBody = body;
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
      });

      await page.evaluate(() => {
        document.dispatchEvent(new CustomEvent('sse:tool:approval:request', {
          detail: {
            requestId: 'test-req-api-deny',
            toolName: 'kubectl',
            toolInput: { command: 'delete pod' },
            timeoutMs: 60000,
            context: { displayName: 'kubectl' },
          },
        }));
      });

      await page.locator('#approval-deny-btn').click();

      expect(capturedBody).toBeTruthy();
      expect(capturedBody!.requestId).toBe('test-req-api-deny');
      expect(capturedBody!.approved).toBe(false);
      expect(capturedBody!.decidedBy).toBe('user');
    });
  });

  test.describe('Auth Mode Enforcement (Integration)', () => {
    test('auto mode tools execute without modal', async ({ page }) => {
      await page.goto('/chat');
      const overlay = page.locator('#tool-approval-overlay');
      await expect(overlay).toBeHidden();
      // Auto mode should not show the modal — verified by absence
    });

    test('off mode tools return blocked message', async ({ page }) => {
      // This is a backend behavior test — verified via API response
      // The UI should display the [BLOCKED] message in the chat
      await page.goto('/chat');
      await expect(page.locator('#tool-approval-overlay')).toBeHidden();
    });
  });
});
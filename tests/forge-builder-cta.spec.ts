/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Browser regression for the Bot Forge CTA
 *                     |               | launching codex-packer's real builder chat.
 */

/**
 * @description
 * Local MOCK_OIDC proof for the Forge front door. This validates the code in this
 * branch: the CTA must open the bot-scoped codex-packer workspace with a fresh
 * task, not the old app-wrapper route.
 */
import { test, expect } from '@playwright/test';

const CODEX_PACKER_AGENT_ID = 'a0000000-0000-0000-0000-000000000030';

test.describe('Bot Forge builder CTA', () => {
  test('opens the codex-packer swarmbot workspace with a fresh task id', async ({ page }) => {
    await page.goto('/api/forge', { waitUntil: 'domcontentloaded' });

    const cta = page.locator('#forgeBuilderCta');
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', new RegExp(`/swarmbot/chat\\?agentId=${CODEX_PACKER_AGENT_ID}`));

    const nav = page.waitForURL(/\/swarmbot\/chat\?/, { timeout: 30_000 });
    await cta.click();
    await nav;

    const url = new URL(page.url());
    expect(url.pathname).toBe('/swarmbot/chat');
    expect(url.searchParams.get('agentId')).toBe(CODEX_PACKER_AGENT_ID);
    expect(url.searchParams.get('taskId')).toBeTruthy();
    await expect(page.locator('#messageInput')).toBeVisible({ timeout: 60_000 });
  });
});

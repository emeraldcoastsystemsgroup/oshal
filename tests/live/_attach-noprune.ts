/**
 * CDP-attach fixture that does NOT prune the operator's existing tabs.
 * The stock fixtures.ts closes every non-app tab on attach; that would kill
 * The operator's working tabs (Google Vids, downloads). This variant attaches to the
 * already-signed-in Chrome, opens its OWN tab, and leaves everything else alone.
 */
import { test as base, chromium, expect, BrowserContext, Page } from '@playwright/test';

const CDP_URL = process.env.OSHAL_E2E_CDP_URL ?? 'http://localhost:9222';

export const test = base.extend<{ page: Page }, { sharedContext: BrowserContext }>({
  sharedContext: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 60_000 });
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error('Attached to Chrome but found no browser context.');
      await use(ctx);
      // Disconnect CDP only — never close the operator's Chrome.
    },
    { scope: 'worker' },
  ],
  context: async ({ sharedContext }, use) => { await use(sharedContext); },
  page: async ({ sharedContext }, use) => {
    const page = await sharedContext.newPage();
    await use(page);
    await page.close().catch(() => {});
  },
});

export { expect };

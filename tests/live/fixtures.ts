/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CDP attach fixture: reuse the operator's
 *                     |               | own already-signed-in Chrome (no fresh login,
 *                     |               | sidesteps Google's automation block).
 */

/**
 * @description
 * Test fixture that ATTACHES to a Chrome you launched yourself (with
 * --remote-debugging-port) instead of letting Playwright launch a fresh browser.
 *
 * Why: the hosted app is gated by Google sign-in, and (a) Google blocks logins
 * from Playwright-launched browsers, (b) you are already signed in in your own
 * Chrome. So we connect over CDP and drive YOUR existing session — no login step.
 *
 * Start Chrome first (see tests/live/README.md or scripts/launch-e2e-chrome.ps1):
 *   chrome --remote-debugging-port=9222 --user-data-dir=%USERPROFILE%\.oshal-e2e-chrome
 * sign in to the app once in that window, then run the suite.
 */
import { test as base, chromium, expect, BrowserContext, Page } from '@playwright/test';

const CDP_URL = process.env.OSHAL_E2E_CDP_URL ?? 'http://localhost:9222';

/**
 * Close stale page targets left over from a prior run (e.g. an external
 * walmart.com tab). A hung external tab stalls Playwright's connectOverCDP
 * handshake, so we prune anything that is not an app page before attaching.
 */
async function pruneStaleTabs(cdpUrl: string): Promise<void> {
  try {
    const list = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{
      id: string;
      type: string;
      url?: string;
    }>;
    for (const t of list) {
      if (t.type === 'page' && !(t.url ?? '').includes('agenticfederal.us')) {
        await fetch(`${cdpUrl}/json/close/${t.id}`).catch(() => {});
      }
    }
  } catch {
    // Best-effort; if the CDP HTTP endpoint isn't reachable the connect below reports it.
  }
}

export const test = base.extend<{ page: Page }, { sharedContext: BrowserContext }>({
  // Connect once per worker to the Chrome you started. Never close it — it's yours.
  sharedContext: [
    async ({}, use) => {
      await pruneStaleTabs(CDP_URL);
      let browser;
      try {
        browser = await chromium.connectOverCDP(CDP_URL, { timeout: 60_000 });
      } catch (err) {
        throw new Error(
          `Could not attach to Chrome at ${CDP_URL}. Launch it first:\n` +
          `  scripts/launch-e2e-chrome.ps1   (or see tests/live/README.md)\n` +
          `and sign in to the app once in that window.\nOriginal: ${String(err)}`,
        );
      }
      const ctx = browser.contexts()[0];
      if (!ctx) {
        throw new Error('Attached to Chrome but found no browser context (open a tab first).');
      }
      await use(ctx);
      // Disconnect the CDP session only — do NOT close the operator's Chrome.
    },
    { scope: 'worker' },
  ],

  // Reuse your existing tab/session; everything runs as you.
  context: async ({ sharedContext }, use) => {
    await use(sharedContext);
  },
  page: async ({ sharedContext }, use) => {
    // Always open OUR OWN tab — never drive a tab you left open (no hijacking your
    // working session). We created it, so we close it when the test ends.
    const page = await sharedContext.newPage();
    await use(page);
    await page.close().catch(() => {});
  },
});

export { expect };

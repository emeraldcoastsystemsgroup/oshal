/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Headed live-E2E config: real data, hosted app.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched from fresh-login to CDP attach — reuse
 *                     |               | the operator's own signed-in Chrome (no login).
 */

import { defineConfig } from '@playwright/test';

/**
 * @description
 * FOREGROUND, REAL-DATA Playwright config — the opposite of playwright.config.ts
 * (which boots a throwaway server with MOCK_OIDC, headless).
 *
 * The browser is YOUR own Chrome, started with --remote-debugging-port and
 * already signed in; tests/live/fixtures.ts attaches over CDP and drives it.
 * No project launches a browser here, and there is no login step.
 *
 * Override the target with OSHAL_E2E_BASE_URL; the CDP endpoint with OSHAL_E2E_CDP_URL.
 */
const BASE_URL = process.env.OSHAL_E2E_BASE_URL ?? 'https://oshal.agenticfederal.us';

export default defineConfig({
  testDir: './tests/live',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The full framework profile sweeps ~40 features in one test — give it room.
  timeout: 600_000,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-live' }],
  ],
  use: {
    baseURL: BASE_URL,
    // Generous: the host runs builds + many agents, so the UI can be very janky
    // and a click/nav may take far longer than usual to become actionable.
    actionTimeout: 90_000,
    navigationTimeout: 120_000,
    trace: 'retain-on-failure',
    screenshot: 'on',
  },
  projects: [{ name: 'live', testMatch: /\.live\.spec\.ts$/ }],
});

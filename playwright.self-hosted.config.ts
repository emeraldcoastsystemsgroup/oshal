/**
 * Playwright configuration for HTTP contracts that boot their own ephemeral Express server.
 *
 * These tests do not use the shared application origin. Keeping them off the default
 * webServer lifecycle lets route/auth regressions run even when another local build owns
 * or delays the full application boot.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the bounded SmartThings/Plaid self-hosted connector profile with no external server or live provider calls.
 * -----------------------------------------------------------------------------
 */

import { defineConfig } from '@playwright/test';

/**
 * @description Playwright profile for connector contracts that own their loopback servers.
 */
const config = defineConfig({
  testDir: './tests',
  testMatch: [
    'smartthings-oauth-connector.spec.ts',
    'plaid-link-connector.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
});

export default config;

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run isolated Jarvis delivery browser contracts without a deployment server, model or database.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '..', testMatch: 'jarvis-task-delivery.spec.ts',
  workers: 1, retries: 0, reporter: 'list', use: { browserName: 'chromium' },
});

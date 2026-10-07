/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run intercepted ambient browser fixtures without starting an application server or inheriting deployment database settings.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '..',
  testMatch: 'jarvis-audio-lifecycle.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { browserName: 'chromium' },
});

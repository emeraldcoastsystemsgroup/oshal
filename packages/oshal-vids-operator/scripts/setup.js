'use strict';
/**
 * @description postinstall / `npx oshal-vids setup`.
 *
 * Best-effort, NEVER fatal (postinstall must not break `npm install`):
 *   1. Ensure Playwright's Chromium build deps are present (the driver attaches
 *      to YOUR Chrome over CDP, but Playwright still needs its own browser bits).
 *   2. Probe for the `codex` CLI (the packed bot in P2 uses it).
 *   3. Print the one-time setup the operator must do.
 */
const { spawnSync } = require('child_process');

function has(bin) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
  return probe.status === 0;
}

function tryInstallChromium() {
  process.stdout.write('[vids-setup] ensuring Playwright Chromium… ');
  const r = spawnSync('npx', ['--yes', 'playwright', 'install', 'chromium'], { stdio: 'ignore', shell: process.platform === 'win32' });
  console.log(r.status === 0 ? 'ok' : 'skipped (run `npx playwright install chromium` if the driver fails)');
}

function main() {
  try {
    tryInstallChromium();
  } catch {
    console.log('[vids-setup] Chromium install skipped.');
  }
  const codex = has('codex');
  console.log(`[vids-setup] codex CLI: ${codex ? 'found' : 'NOT found (the Veo bot in P2 needs it — `npm i -g @openai/codex` + login)'}`);
  console.log(`
[vids-setup] One-time setup:
  1) npx oshal-vids chrome     # opens a debug Chrome on a dedicated profile
  2) sign into Google + open your Vids project in that window
  3) npx oshal-vids            # opens the control panel at http://localhost:8074
`);
}

main();

#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Green-ratchet runner: run only the curated-passing Playwright e2e specs (tests/e2e-green-suite.txt). The gate ratchets up as specs are normalized; the full suite is red and normalized separately (BACKLOG).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preflight the vite chat bundle: src/api/dist is gitignored and neither ci.yml nor ci-local builds it, so on a clean checkout /dist/chat-ui.js 404s, chat-config-modal.mjs (which imports ChatApp from it) never evaluates, and every /chat modal spec times out "element is not visible" (the 2026-07-09 agent-profile-persistence quarantine). Build it when missing, fail loud when the build fails.
 */

/**
 * @description Runs `playwright test` against ONLY the spec files listed in
 * tests/e2e-green-suite.txt — the curated set proven green (all tests pass) under the
 * CI e2e env (Postgres + Redis + PLAYWRIGHT_PORT=3456 + FORCE_LLM_PROVIDER=noop). This
 * is the required CI e2e gate: it is green today and cannot silently regress. The full
 * ~132-spec suite is not green (see docs/BACKLOG.md "CI Playwright e2e suite
 * normalization"); as specs are fixed they are added to the list and the gate grows.
 * The list ignores blank lines and `#` comments. Extra CLI args pass through to
 * playwright (e.g. `--reporter=line`, `--workers=4`).
 * @returns Exits with playwright's exit code.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listPath = path.join(repoRoot, 'tests', 'e2e-green-suite.txt');

// The standalone /chat surface imports ChatApp from /dist/chat-ui.js — a vite build output
// (npm run build:chat) that is gitignored and built by Dockerfile.oshal but by NO CI step.
// On a clean checkout the import 404s, chat-config-modal.mjs never evaluates, and every
// /chat modal interaction times out. Build it here when absent so the green set runs
// against the same page a dev box / the Docker image serves. Fail loud: a silently skipped
// build would just re-manifest as an inscrutable 30s "element is not visible" timeout.
const chatBundle = path.join(repoRoot, 'src', 'api', 'dist', 'chat-ui.js');
if (!existsSync(chatBundle)) {
  console.log('[e2e-green] src/api/dist/chat-ui.js missing — running `npm run build:chat` (clean checkout)…');
  const build = spawnSync('npm', ['run', 'build:chat'], { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (build.status !== 0 || !existsSync(chatBundle)) {
    console.error('[e2e-green] build:chat failed or produced no src/api/dist/chat-ui.js — aborting instead of timing out later.');
    process.exit(build.status || 1);
  }
}

const files = readFileSync(listPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

if (files.length === 0) {
  console.error('[e2e-green] tests/e2e-green-suite.txt has no spec files — nothing to run.');
  process.exit(1);
}

const passthrough = process.argv.slice(2);
console.log(`[e2e-green] running ${files.length} curated-green e2e spec files` +
  (passthrough.length ? ` (args: ${passthrough.join(' ')})` : ''));

const result = spawnSync('npx', ['playwright', 'test', ...files, ...passthrough], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);

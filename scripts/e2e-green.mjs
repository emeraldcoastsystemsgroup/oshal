#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Green-ratchet runner: run only the curated-passing Playwright e2e specs (tests/e2e-green-suite.txt). The gate ratchets up as specs are normalized; the full suite is red and normalized separately (BACKLOG).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preflight the vite chat bundle: src/api/dist is gitignored and neither ci.yml nor ci-local builds it, so on a clean checkout /dist/chat-ui.js 404s, chat-config-modal.mjs (which imports ChatApp from it) never evaluates, and every /chat modal spec times out "element is not visible" (the 2026-07-09 agent-profile-persistence quarantine). Build it when missing, fail loud when the build fails.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The list is parsed by scripts/e2e-green-list.mjs, shared with the registration guard, so the two cannot drift; `--list` prints the paths this runner would hand to playwright and exits before any preflight, which is what the guard compares against the parser (PR #620 review: a source-text pin was satisfied by three runners that ran a different list).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The body is an exported function with the spawner and the preflight existence check injectable, and the CLI entry calls it with the real ones. The registration guard calls it with a recording spawner and asserts the playwright argv - the list the gate actually runs. `--list` is removed: it re-derived the list in its own branch, so a filter at the spawn site passed the guard while playwright never received the spec (PR #620 third review, mutations X1-X4).
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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readGreenSuite } from './e2e-green-list.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listPath = path.join(repoRoot, 'tests', 'e2e-green-suite.txt');

/**
 * @description The runner's body, with its two process boundaries injectable: the spawner that
 * runs playwright and the existence check behind the chat-bundle preflight. The CLI entry below
 * passes the real ones; the registration guard passes a recording spawner and asserts the argv
 * it receives - which is the list the gate actually runs, not a re-derivation of it.
 * @param options - listPath, repoRoot, passthrough args, and the injectable boundaries.
 * @returns The spawn result's status and the spec files that were handed to playwright.
 */
export function runGreenSuite({
  listPath: list = listPath,
  repoRoot: root = repoRoot,
  passthrough = [],
  spawn = spawnSync,
  exists = existsSync,
  log = console.log,
  error = console.error,
} = {}) {
  // The standalone /chat surface imports ChatApp from /dist/chat-ui.js - a vite build output
  // (npm run build:chat) that is gitignored and built by Dockerfile.oshal but by NO CI step.
  // On a clean checkout the import 404s, chat-config-modal.mjs never evaluates, and every
  // /chat modal interaction times out. Build it here when absent so the green set runs
  // against the same page a dev box / the Docker image serves. Fail loud: a silently skipped
  // build would just re-manifest as an inscrutable 30s "element is not visible" timeout.
  const chatBundle = path.join(root, 'src', 'api', 'dist', 'chat-ui.js');
  if (!exists(chatBundle)) {
    log('[e2e-green] src/api/dist/chat-ui.js missing - running `npm run build:chat` (clean checkout)...');
    const build = spawn('npm', ['run', 'build:chat'], { cwd: root, stdio: 'inherit', shell: true });
    if (build.status !== 0 || !exists(chatBundle)) {
      error('[e2e-green] build:chat failed or produced no src/api/dist/chat-ui.js - aborting instead of timing out later.');
      return { status: build.status || 1, files: [] };
    }
  }

  const files = readGreenSuite(list);
  if (files.length === 0) {
    error('[e2e-green] tests/e2e-green-suite.txt has no spec files - nothing to run.');
    return { status: 1, files };
  }

  log(`[e2e-green] running ${files.length} curated-green e2e spec files` +
    (passthrough.length ? ` (args: ${passthrough.join(' ')})` : ''));

  const result = spawn('npx', ['playwright', 'test', ...files, ...passthrough], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  return { status: result.status ?? 1, files };
}

// CLI entry: only when this file is the program, never when the guard imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { status } = runGreenSuite({ passthrough: process.argv.slice(2) });
  process.exit(status);
}

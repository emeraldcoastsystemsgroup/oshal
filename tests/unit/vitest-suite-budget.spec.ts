/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The declared budget this suite runs on, proven from inside the runner rather than by reading vitest.config.ts. The 2026-09-19 nightly lost 31 cases across 22 files to vitest's 5000 ms default and nothing else - real bash and powershell spawns, real chromium pages, throwaway Postgres/Redis containers and whole-tree inventory scans, all paying for the contention of 1044 files running in parallel. Declaring the budget fixes that class; this file is what keeps it declared. The case budget is read off the runner's own resolved task, so it costs nothing and cannot be satisfied by a config file that the runner never loaded. The hook budget has no equivalent read, so it is proven the only way it can be - by a beforeAll that takes longer than the 10000 ms default and is expected to complete.
 */
import { beforeAll, describe, expect, it } from 'vitest';

/** Vitest's own defaults, which this suite is too heavy to run on. */
const VITEST_DEFAULT_TEST_TIMEOUT_MS = 5_000;
const VITEST_DEFAULT_HOOK_TIMEOUT_MS = 10_000;
/** What a case here must be allowed, measured against the gate's parallel run of the whole corpus. */
const REQUIRED_MS = 30_000;

let hookElapsedMs = 0;

// Deliberately longer than vitest's 10000 ms hook default and well under the declared 30000 ms.
// On the default this beforeAll is killed and every case below reports as failed, which is exactly
// the shape that took out the browser cluster's bare afterAll teardowns in the same nightly.
beforeAll(async () => {
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  hookElapsedMs = Date.now() - startedAt;
});

describe('the unit suite runs on a declared budget, not vitest\'s defaults', () => {
  it('a case is given the declared budget — read from the runner, not from the config file', (ctx) => {
    const resolved = (ctx as { task?: { timeout?: number } }).task?.timeout;
    expect(typeof resolved, 'vitest no longer exposes task.timeout — this guard needs a new read')
      .toBe('number');
    expect(resolved).toBe(REQUIRED_MS);
    expect(resolved).toBeGreaterThan(VITEST_DEFAULT_TEST_TIMEOUT_MS);
  });

  it('a hook may take longer than vitest\'s default — this file\'s own beforeAll already did', () => {
    // Reaching this line at all means the 11 s hook was not killed. The assertion states the claim
    // the arrival proves, so a future reader sees what the elapsed time is evidence of.
    expect(hookElapsedMs).toBeGreaterThan(VITEST_DEFAULT_HOOK_TIMEOUT_MS);
    expect(hookElapsedMs).toBeLessThan(REQUIRED_MS);
  });

  it('an explicit per-case timeout still wins, so a file that needs longer can still say so', (ctx) => {
    expect((ctx as { task?: { timeout?: number } }).task?.timeout).toBe(45_000);
  }, 45_000);
});

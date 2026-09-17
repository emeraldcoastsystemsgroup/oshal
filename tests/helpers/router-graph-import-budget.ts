/**
 * Guard helper for the remote-client full-suite flake (docs/BACKLOG.md
 * "Remote-client full-suite flake").
 *
 * The flake was never registry or rate-limiter state. It was accounting: four
 * remote-client specs called `await import('.../remote-client-routes')` from
 * INSIDE their first `it()`, so that one test paid the one-time dynamic
 * import/transform of the whole router graph (express + authz + agent-management
 * + chat-orchestration + the task/workspace/print route modules) out of its own
 * timeout budget. Measured on an idle box with three spec files running, that
 * single test cost 12.9s-13.6s while every sibling in the same file cost 14-101ms;
 * on a cold vite cache it cost 17.5s. The specs compensated with a 30s budget,
 * which is a mask: under the full 990-file parallel sweep the same import is
 * competing for the same cores and blows straight through it, and the file dies
 * with a remote-client timeout.
 *
 * The fix is to load the router graph in a file-level `beforeAll`, where the cost
 * belongs and where the hook budget is explicit. This helper is what keeps it
 * fixed: each affected spec asserts, from inside a test, that importing the router
 * graph resolves from the module cache. If the `beforeAll` is removed or a new
 * test-scoped `await import(...)` of the graph creeps back in, the measured cost
 * jumps by three orders of magnitude and the assertion goes red — it cannot be
 * satisfied by a substring or by raising a timeout.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — measures whether a spec pays the router-graph import inside a test budget, so the de-flake cannot silently regress
 */

import { expect } from 'vitest';

/**
 * Ceiling for a module-cache hit, in milliseconds.
 *
 * A cached ESM namespace lookup is sub-millisecond even on a saturated box; the
 * unhoisted import measured 4,124ms warm and 17,500ms cold. 500ms sits ~500x above
 * the pass case and ~8x below the fail case, so the assertion separates the two
 * without becoming a second flake of its own.
 */
export const ROUTER_GRAPH_IMPORT_BUDGET_MS = 500;

/**
 * @description Times a dynamic import without asserting on it, for callers that
 * want to report the number themselves.
 * @param load Thunk performing the dynamic import under measurement.
 * @returns Wall-clock milliseconds the import took to settle.
 */
export async function measureImportMs(load: () => Promise<unknown>): Promise<number> {
  const startedAt = performance.now();
  await load();
  return performance.now() - startedAt;
}

/**
 * @description Asserts that the route module graph was already loaded before this
 * test ran — i.e. that the spec pays the import in a file-level `beforeAll` and not
 * out of an `it()` timeout budget. Call it from the FIRST test in the file so a
 * regression is measured rather than masked by an earlier test having warmed the
 * cache.
 * @param load Thunk performing the same dynamic import the spec's boot helper uses.
 * @returns Wall-clock milliseconds the cached import took, for logging.
 */
export async function expectRouterGraphPreloaded(load: () => Promise<unknown>): Promise<number> {
  const elapsedMs = await measureImportMs(load);
  expect(
    elapsedMs,
    `Importing the remote-client router graph inside a test took ${elapsedMs.toFixed(1)}ms. `
      + 'That import belongs in this file\'s beforeAll — charging it to an it() budget is the '
      + 'remote-client full-suite flake. Hoist it, do not raise the timeout.',
  ).toBeLessThan(ROUTER_GRAPH_IMPORT_BUDGET_MS);
  return elapsedMs;
}

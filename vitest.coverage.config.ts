/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The coverage config. Separate from
 *   vitest.config.ts on purpose: `npm run test:unit` stays the full corpus with no
 *   instrumentation cost, and the coverage figure comes from a stated, holdable
 *   scope instead of a whole-tree number nobody can act on. Scope and thresholds
 *   come from tests/coverage-scope.mjs so the banner and the figure cannot drift.
 */
import { defineConfig } from 'vitest/config';
import * as path from 'path';
import {
  COVERAGE_REPORTS_DIRECTORY,
  COVERAGE_SOURCE_GLOBS,
  COVERAGE_SPEC_FILES,
  resolveCoverageThresholds,
} from './tests/coverage-scope.mjs';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: COVERAGE_SPEC_FILES,
    environment: 'node',
    globals: true,
    // v8 instrumentation slows every spec down; the default 5s timeout makes the
    // timing-sensitive specs in this set flake under it, which would make the gate
    // unreliable rather than strict.
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      enabled: true,
      provider: 'v8',
      // Produce the figure even when a spec fails, so a red run still says what the
      // coverage was instead of silently reporting nothing.
      reportOnFailure: true,
      include: COVERAGE_SOURCE_GLOBS,
      reporter: ['text', 'json-summary'],
      reportsDirectory: COVERAGE_REPORTS_DIRECTORY,
      thresholds: resolveCoverageThresholds(),
    },
  },
});

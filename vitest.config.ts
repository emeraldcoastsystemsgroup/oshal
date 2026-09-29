/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep tree-walk PostgreSQL fixtures in a later one-worker project without removing them from the default unit command or changing budgets/retries.
 */
import { defineConfig } from 'vitest/config';
import * as path from 'path';

const TREE_WALK_POSTGRES = [
  'tests/unit/alert-incident-cutover.spec.ts',
  'tests/unit/alert-incident-reopen.spec.ts',
  'tests/unit/topology-traversal.spec.ts',
];

// THE unit-test config — a bare `npx vitest run` (and `npm run test:unit`) runs BOTH trees:
//   - src/**/*.test.ts        — pure-logic tests colocated with source (no DB / network)
//   - tests/unit/**/*.spec.ts — the main unit corpus (previously hidden behind
//     `--config vite.config.ts`, which made the obvious command silently skip 89% of
//     the tests — 2026-07-05 audit fix; the test block was removed from vite.config.ts)
// Scoped excludes keep stray fixture *.test.ts under .codex-harness-runs/ out.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    exclude: [
      'node_modules/**',
      'dist/**',
      '.codex-harness-runs/**',
      '**/.codex-home/**',
      'tests/tool-integrations/**',
    ],
    environment: 'node',
    globals: true,
    // Preserve the declared budgets for real shell/browser/container and inventory guards.
    // Files needing longer still declare their own budget. Serialization is not a timeout increase.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 0,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'tests/unit/**/*.spec.ts'],
          exclude: TREE_WALK_POSTGRES,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'tree-walk-postgres',
          include: TREE_WALK_POSTGRES,
          pool: 'forks', isolate: true, maxWorkers: 1, fileParallelism: false,
          // A separate positive group prevents overlap with the ordinary corpus, including
          // commands that already request one worker globally. Zero has special scheduler rules.
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});

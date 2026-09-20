import { defineConfig } from 'vitest/config';
import * as path from 'path';

// THE unit-test config — a bare `npx vitest run` (and `npm run test:unit`) runs BOTH trees:
//   - src/**/*.test.ts        — pure-logic tests colocated with source (no DB / network)
//   - tests/unit/**/*.spec.ts — the main unit corpus (previously hidden behind
//     `--config vite.config.ts`, which made the obvious command silently skip 89% of
//     the tests — 2026-07-05 audit fix; the test block was removed from vite.config.ts)
// Scoped excludes keep stray fixture *.test.ts under .codex-harness-runs/ out.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['src/**/*.test.ts', 'tests/unit/**/*.spec.ts'],
    exclude: [
      'node_modules/**',
      'dist/**',
      '.codex-harness-runs/**',
      '**/.codex-home/**',
      'tests/tool-integrations/**',
    ],
    environment: 'node',
    globals: true,
    // This suite has no business running on vitest's 5000 ms / 10000 ms defaults. It spawns real
    // bash and powershell.exe, drives real chromium pages, starts throwaway Postgres and Redis
    // CONTAINERS, and walks the whole source tree in several inventory guards — and the sanctioned
    // gate runs all 1044 files in parallel, so every one of those pays for the contention of the
    // other 1043. The 2026-09-19 nightly lost 31 cases across 22 files to the budget alone: not one
    // of them was a product defect, and a case measured at 2974 ms on an idle box still died at
    // 5000 ms in the gate. A red gate nobody can act on is the thing this repo's own rule says not
    // to leave standing, so the budget is declared here rather than hand-patched onto each case
    // that happens to trip it. Files needing longer still say so themselves; a genuine hang still
    // fails, 30 s later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

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
  },
});

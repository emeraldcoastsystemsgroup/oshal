// ESLint flat config (eslint 9 + typescript-eslint) — OSHAL governance gate.
//
// Scope is deliberately NARROW: the four CLAUDE.md governance rules only, NOT a full recommended
// ruleset. Warnings-first — these surface violations without failing a build, so the gate can be
// wired now and the counts driven to zero incrementally (see BACKLOG "Decompose the 11 real over-cap
// files + add lint gates"). Syntax-only (no `parserOptions.project`) so it runs fast over all of src/.
//
// Rules:
//   - no-restricted-imports: Feature-Sliced Design barrel boundary. Import a slice via its barrel
//     (`@/features/X`), never a deep path (`@/features/X/services/Y`). This is the isolation ADR-085
//     dynamic app-package loading depends on. `@/shared/*` and `@/app/*` are exempt (not barrel-only).
//   - no-empty (allowEmptyCatch:false): no swallowed exceptions (CLAUDE.md "no silent catches").
//   - no-console: never console.log in production code (use the Pino child logger).
//   - max-lines: the 1000 CODE-line cap (skipComments + skipBlankLines matches the definition).

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'output/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'any-bot/**', // battle-tested legacy JS layer — not Feature-Sliced, out of scope
      'src/api/dist/**',
      'src/pages/**/dist/**',
      'packages/**/dist/**',
      '**/*.d.ts',
    ],
  },
  {
    // The Feature-Sliced TypeScript surface — where the governance rules apply.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    // The existing `// eslint-disable @typescript-eslint/...` comments target rules this focused
    // gate deliberately doesn't enable, so they're dormant — not "unused-and-removable". Don't
    // report them (they become live again if a future config enables those rules).
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    // Register the typescript-eslint plugin (rules DEFINED, not enabled) so the many existing
    // `// eslint-disable-next-line @typescript-eslint/...` comments resolve to a known rule instead
    // of erroring "Definition for rule not found". Keeps the gate focused on the four rules below.
    // The `import` stub does the same for the handful of `import/no-cycle` disable comments without
    // pulling in eslint-plugin-import (+ its resolver) just to satisfy a comment — the rule is
    // defined-but-inert, so no cycle enforcement is added, only the "rule not found" error removed.
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: { rules: { 'no-cycle': { create: () => ({}) } } },
    },
    rules: {
      'no-restricted-imports': ['warn', {
        patterns: [{
          // Deep import into a feature/entity/page slice = anything past the slice folder that is
          // NOT the barrel (`index`). `@/features/foo` and `@/features/foo/index(.js)` are allowed;
          // `@/features/foo/services/bar` is flagged. `@/shared/*` and `@/app/*` are intentionally exempt.
          // ALSO exempt the `harness` sanctioned SECOND barrel (`@/features/llm-provider/harness` /
          // `.../harness/index`): the barrel-split (TODO-BOUNDARY-FINDING) made it a published entry
          // point so a controller import of the main llm-provider barrel never loads the harness
          // runtime. A published `<subdir>/index` barrel is a barrel, not an internal path — but a
          // deep path INTO it (`.../harness/services/x`) is still flagged. Guarded by
          // tests/unit/controller-runtime-boundary.spec.ts.
          regex: '^@/(features|entities|pages)/[^/]+/(?!index\\b)(?!harness(/index)?$)',
          message: 'FSD: import a slice through its barrel (e.g. @/features/foo), not a deep path (@/features/foo/services/bar). See CLAUDE.md.',
        }],
      }],
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-console': 'warn',
      'max-lines': ['warn', { max: 1000, skipComments: true, skipBlankLines: true }],
    },
  },
);

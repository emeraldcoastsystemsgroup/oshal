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
//
// TWO config objects, deliberately:
//   1. The Feature-Sliced TypeScript surface (src/**/*.ts{,x}) gets all four rules.
//   2. Everything else the cap applies to — src/**/*.{js,jsx,mjs,cjs}, tests/**, scripts/** — gets
//      max-lines ONLY. Before 2026-07-29 the max-lines rule was scoped to src/**/*.ts{,x}, so the
//      three files actually over the cap (a 1850-code-line chat modal, a 1044-line RAG popup, a
//      1006-line spec) were invisible to `npx eslint src` and exited 0. CLAUDE.md applies the cap to
//      "source, tests, and logic-bearing config", so the gate now sees all of it. The other three
//      rules stay off for these paths on purpose: scripts/ legitimately writes to the console, and
//      the FSD barrel rule is about src/ slice boundaries, not test or script imports. Widening
//      those is a separate decision with its own backlog burn-down, not a side effect of the cap.
//      gate_lint in scripts/ci-local.sh lints `src tests scripts` so this scope is enforced.
//
// any-bot/** stays ignored (below): battle-tested legacy JS, not Feature-Sliced, out of scope by
// prior decision — its four 860-970 code-line files are under the cap anyway.

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
  {
    // The rest of the capped surface: browser/Node JavaScript under src/, the Playwright + vitest
    // corpus, and the tooling in scripts/. max-lines ONLY — see the header note for why.
    files: [
      'src/**/*.js',
      'src/**/*.jsx',
      'src/**/*.mjs',
      'src/**/*.cjs',
      'tests/**/*.ts',
      'tests/**/*.tsx',
      'tests/**/*.js',
      'tests/**/*.mjs',
      'tests/**/*.cjs',
      'scripts/**/*.ts',
      'scripts/**/*.js',
      'scripts/**/*.mjs',
      'scripts/**/*.cjs',
    ],
    languageOptions: {
      // The TS parser reads plain JS too, so one parser covers every extension above.
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    // Same reasoning as the TypeScript block: existing `eslint-disable` comments in these trees
    // target rules this focused gate does not enable, so they are dormant, not removable.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    // Same defined-but-inert stubs as the TypeScript block, for the same reason: scripts/ and tests/
    // carry `eslint-disable` comments naming @typescript-eslint/* and import/* rules, and an
    // unresolvable rule name is a hard error ("Definition for rule not found") even when the rule
    // itself is not enabled.
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: { rules: { 'no-cycle': { create: () => ({}) }, first: { create: () => ({}) } } },
    },
    rules: {
      'max-lines': ['warn', { max: 1000, skipComments: true, skipBlankLines: true }],
    },
  },
);

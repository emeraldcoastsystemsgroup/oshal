<!-- Thanks for the PR. Fill the sections that apply; delete the others. -->

## Summary

<!-- 1-3 sentences. WHY this change exists, not just what it does. -->

## Type of change

<!-- Check one. -->
- [ ] `feat` — new user-facing functionality
- [ ] `fix` — bug fix
- [ ] `refactor` — internal restructure, no behavior change
- [ ] `test` — tests only
- [ ] `docs` — documentation only
- [ ] `chore` — tooling / build / infra
- [ ] `perf` — measurable performance change

## Scope

<!-- Feature directory. e.g. swarm-orchestration, rag, llm-provider, cockpit, intake, harness -->

## Linked issues / tickets

<!-- Closes #123 / Refs #456 / docs/BACKLOG.md item -->

## Testing

- [ ] `npx tsc --noEmit` clean
- [ ] Affected Playwright specs pass: `<list spec files>`
- [ ] Behavior tests added for new logic (not just regex-against-source)
- [ ] If touching the live container: rebuilt + recreated `oshal-api`,
      verified end-to-end

## Architecture / governance checklist

- [ ] No file exceeds the 1000-line cap (CLAUDE.md). Files >800 lines:
      flagged with a decomposition note in the description.
- [ ] No function exceeds 50 lines.
- [ ] Every public method has JSDoc with `@description` / `@param` /
      `@returns` explaining *why*, not *what*.
- [ ] No `console.log` in production code paths — uses Pino via
      `createChildLogger({ module: '...' })`.
- [ ] No empty catch blocks. Every `catch` logs at ERROR with the
      error and stack trace.
- [ ] New routes are auth-gated with `requiresAuth` unless they are
      explicitly public (and the rationale is in the route comment).
- [ ] No deep imports across feature slices — go through the slice's
      `index.ts` barrel.

## Multi-harness considerations

<!-- If your change touches src/features/llm-provider/ or src/app/composition/provider-runtime.ts -->
- [ ] If adding a new harness: extends `BaseCliHarnessAdapter` for
      CLI-spawn cases; entry added to **both** `HARNESS_FACTORIES`
      and `HARNESS_RUNTIME_DEFAULTS`; `HarnessType` union extended;
      tests in `tests/harness-adapter-behavior.spec.ts`.
- [ ] Live-validated the harness's actual flag set against `--help`
      (don't copy-paste from another adapter blind).

## Breaking changes

<!-- If yes, what changed, who is affected, migration steps. -->

## Screenshots / output (UI / cockpit changes only)

<!-- Drop in before/after if you touched src/pages/cockpit/. -->

## Operator notes

<!-- Anything an operator needs to do at deploy time?
     New env var? New persona file? Migration to run? -->

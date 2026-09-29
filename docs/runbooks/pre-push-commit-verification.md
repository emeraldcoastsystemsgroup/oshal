# Pre-push committed-HEAD verification

[The hook](../../.githooks/pre-push) runs the publish gate first, then decides
whether the committed-HEAD typecheck can use the existing docs-only optimization.
The range decision is:

- A successfully resolved, nonempty `@{push}..HEAD` containing no recognized
  source/config extensions retains the docs-only skip.
- An unavailable range, including a new branch without a push tracking ref or a
  missing remote-tracking ref, enters committed-HEAD verification.
- An empty known range also enters verification, as before.

The recognized extension list is unchanged: `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`
and `.json`. `HEAD~1..HEAD` is not a substitute for an unknown push range: a final
documentation commit or merge can follow earlier source changes in the same push.

Verification uses `git archive HEAD`, links installed dependencies into the owned
temporary export, and runs the compiler with `--preserveSymlinks`. A repaired but
uncommitted working tree cannot repair a broken commit in that export. This change
does not alter the publish gate, its stdin, existing override/tooling-failure paths,
dependency lookup, archive cleanup or compiler invocation. It corrects the range
classification only; it does not claim new per-ref verification semantics.

## Running and recognizing the check

Use the normal push with the configured hook. Read the result, not just Git's exit
status: actual compilation success is reported as `pre-push: committed HEAD
typechecks`. A known docs-only skip does not report that compilation succeeded.

Linked worktrees can use an absolute `core.hooksPath` pointing at the primary
checkout. Editing a worktree's hook does not change that active shared hook.
Do not change shared hook configuration to test a candidate: the focused guard
invokes the candidate hook directly against its own disposable Git repositories.
Normal publication and primary-checkout activation remain integration steps.

## Regression boundary

[The unknown-range spec](../../tests/unit/pre-push-unknown-range.spec.ts) runs real
Git commits/refs/merges, the complete candidate hook, its actual archive/dependency
link, and the installed TypeScript compiler. Cases cover earlier broken source
followed by a docs commit or merge; a separately repaired working tree; valid
unknown-range HEAD; a missing tracking ref; the known docs-only optimization;
known-range source refusal; and publish-gate refusal before either path.

Only `scripts/publish-gate.sh` in each synthetic repository is an explicitly named
ordering fixture. Its argv and ref-update stdin are checked. These tests do not
prove the real leak scanner or perform a remote push. Children receive a clean
environment, owned npm/Git configuration and cache paths, offline npm with
installation declined, and a 128 MiB Node heap. The compiler is already installed;
nothing is downloaded. Tests are explicitly sequential, with a 45-second case
budget around the owned hook's 30-second deadline and process-tree teardown.
Spawn/timeouts cannot count as expected
type-error refusals. The temporary archive's removal is asserted, and fixture
dependency junctions are unlinked before recursive cleanup of owned directories.

Companions are [ordering](../../tests/unit/pre-push-hook-ordering.spec.ts),
[dependency linking](../../tests/unit/pre-push-verification-tree.spec.ts), and
[real compiler symlink behavior](../../tests/unit/pre-push-preserve-symlinks.spec.ts).
All match `tests/unit/**/*.spec.ts` in [vitest.config.ts](../../vitest.config.ts),
selected by `npm run test:unit` in local/hosted CI. This developer-tool guard has no
runtime Test Lab card; CI discovery is not a claim that the full CI suite ran.

Run the focused group under the host's resource supervisor: runner 128 MiB, one
worker 384 MiB, fresh free memory at least 1800 MiB, reserve 600 MiB, deadline
180 seconds, and no concurrent owned compiler children:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=128'
node --max-old-space-size=128 node_modules/vitest/vitest.mjs run tests/unit/pre-push-unknown-range.spec.ts tests/unit/pre-push-hook-ordering.spec.ts tests/unit/pre-push-verification-tree.spec.ts tests/unit/pre-push-preserve-symlinks.spec.ts --pool=forks --maxWorkers=1 --no-file-parallelism --execArgv=--max-old-space-size=384
```

Local results and proof limits are recorded in the
[real-boundary audit](../governance/real-boundary-regression-audit.md#pre-push-unknown-range-verification-2026-09-29).

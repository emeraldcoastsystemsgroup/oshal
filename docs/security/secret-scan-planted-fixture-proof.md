# Secret-scan planted-fixture proof (fail, then pass)

**Proven 2026-09-21** against `origin/main` 6011ceb6. This is the closure evidence for the
BACKLOG entry *CI secret-scanner remote mutation proof*, under the operator's 2026-09-20 re-scope
of it to the local gate.

## What was owed, and what replaced it

The original clause wanted a hosted GitHub Actions run of the `gitleaks` job made red by a planted
secret on a disposable branch. Two things blocked it: every workflow that runs the scanner is
`workflow_dispatch`-only because hosted-runner minutes are the account's binding constraint, and
the proof as written meant pushing a secret-shaped fixture to a public repository past a
fail-closed pre-push publish gate — after which the planted commit stays fetchable by SHA whatever
happens to the branch.

The operator re-scoped it on 2026-09-20: plant the fixture in a throwaway export, make the
*local* `secret-scan` gate go red, remove it, watch it go green, and never push anything.
"Linked CI evidence" in the Done-when now means the local gate's own log — this page.

## What runs

`tests/unit/ci-local-secret-scan-planted-fixture.spec.ts`. It slices the production
`gitleaks_container_scan` and `gate_secrets` function bodies out of `scripts/ci-local.sh` and
executes them in Git Bash, so the guard runs the nightly's own text rather than a paraphrase of
it. Four sequential commits of one disposable repository — created under the OS temp directory and
deleted in `afterAll` — are scanned in turn. The repository carries this repo's **real**
`.gitleaks.toml`, so the production allowlist is the one under test.

The scanner is real. No `docker` stand-in is placed on PATH: `docker run --rm --network none`
launches `zricethezav/gitleaks:latest`, which on this box reports `v8.30.1`
(`RepoDigests=[zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f]`).
The gate uses the floating `:latest` tag, so that version is what this run measured, not a pin.

```bash
npx vitest run tests/unit/ci-local-secret-scan-planted-fixture.spec.ts \
  --no-file-parallelism --reporter=verbose
```

```
Test Files  1 passed (1)
     Tests  6 passed (6)
  Duration  15.35s
```

## The four stages, verbatim

Each block is the gate's own output for one commit, `LOG:` lines being `ci-local.sh`'s `log`
function and the timestamped lines being the scanner's replayed stderr.

**1. Clean tree — PASS**

```
LOG:secret-scan: PASS unread=0 of 3 exported files (scanner rc=0)
1:57PM INF scanned ~48 bytes (48 bytes) in 69.3ms
1:57PM INF no leaks found
```

**2. Planted fixture — FAIL.** One file added, holding an AWS-access-key-id-shaped synthetic
value (the `AKIA` prefix plus sixteen characters, assembled from parts at runtime so the spec
source never carries the contiguous token).

```
LOG:secret-scan: FAIL scanner rc=1 unread=0 of 4 exported files (findings or scanner error above)
1:57PM INF scanned ~91 bytes (91 bytes) in 83.2ms
1:57PM WRN leaks found: 1
```

**3. Control — the allowlisted AWS documentation dummy, still PASS.** The planted file is replaced
by one holding `AKIAIOSFODNN7EXAMPLE`, which `.gitleaks.toml` exempts by exact value. The export is
still four files and the same shape is still present, so this is what makes the red above
attributable to the planted *value* rather than to the shape or to the extra file.

```
LOG:secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)
1:57PM INF scanned ~92 bytes (92 bytes) in 110ms
1:57PM INF no leaks found
```

**4. Fixture removed — PASS again.**

```
LOG:secret-scan: PASS unread=0 of 3 exported files (scanner rc=0)
1:57PM INF scanned ~48 bytes (48 bytes) in 208ms
1:57PM INF no leaks found
```

The guard also asserts that the planted value never appears in any of the four outputs — the gate
passes `--redact`, and a proof that prints the thing it planted is not a proof anyone can paste.

## Mutation evidence: the guard was watched failing

A guard nobody watched fail is a guard nobody knows works. Two mutations were applied to the
lane's working tree, each reintroducing a real defect shape, and both were restored afterwards.

**Mutation A — the gate stops believing the scanner.** `--exit-code 0` added to the production
`gitleaks_container_scan` invocation in `scripts/ci-local.sh`, so findings no longer set a failing
exit code. The scanner still finds the leak; the gate now calls it a PASS:

```
tests/unit/ci-local-secret-scan-planted-fixture.spec.ts >
  goes RED on the planted credential-shaped fixture, with the scanner's own rc in the verdict
AssertionError: LOG:secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)
1:55PM WRN leaks found: 1
: expected +0 to be 1 // Object.is equality
Test Files  1 failed (1)
     Tests  1 failed | 5 passed (6)
```

**Mutation B — the allowlist is widened from a value to a shape.** The `.gitleaks.toml` entry
`'''AKIAIOSFODNN7EXAMPLE'''` replaced by `'''AKIA[0-9A-Z]{16}'''`, which is exactly the
"narrow the pattern until the gate stops complaining" move the repo forbids. The scanner now
reports nothing at all on the planted tree:

```
tests/unit/ci-local-secret-scan-planted-fixture.spec.ts >
  goes RED on the planted credential-shaped fixture, with the scanner's own rc in the verdict
AssertionError: LOG:secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)
1:56PM INF no leaks found
: expected +0 to be 1 // Object.is equality
Test Files  1 failed (1)
     Tests  1 failed | 5 passed (6)
```

Both mutations were reverted and the guard re-run green (`Tests  6 passed (6)`) before the change
was committed.

## No credential entered Git history

- The planted value is synthetic: an `AKIA` prefix plus sixteen characters that belong to no
  account and were invented for this fixture.
- It exists only inside a `mkdtemp` directory and only for the duration of the run. The disposable
  repository it is committed to is created by `git init` under that directory and removed in
  `afterAll`; it has no remote and is never pushed.
- The spec source never holds the token contiguously — it is assembled with `join('')` from three
  parts, the same technique `tests/unit/secret-scanner.spec.ts` already uses for its PEM header.
  That is also why this guard needs **no** entry in the `.gitleaks.toml` fixture allowlist: the
  repo's own secret scan and the pre-push publish gate both pass over this file cleanly.
- Nothing was pushed to a branch, disposable or otherwise, to obtain this evidence, and no hosted
  runner minutes were spent.

## What this does not prove

- **Nothing about GitHub Actions.** The hosted `gitleaks` jobs in `.github/workflows/ci.yml` and
  `.github/workflows/security.yml` remain `workflow_dispatch`-only and were not run. In
  particular the full-history pass (`--log-opts=--all`) is untested here; this proof is the
  `--no-git` working-tree shape the local gate uses.
- **Nothing about the partial-scan half.** `scripts/ci/ci-secret-scan.sh` refuses to call a scan
  clean when gitleaks skipped paths it could not read. That behaviour is still covered only by
  `tests/unit/ci-local-secret-scan.spec.ts`, which replays recorded stderr through a stand-in
  `docker`; making a real image fail to read a real path is a separate owed item, tracked in
  [../governance/real-boundary-regression-audit.md](../governance/real-boundary-regression-audit.md).
- **Nothing about rule coverage.** One rule (`aws-access-token`) is shown to fire end to end.
  This says nothing about whether any other gitleaks rule would catch any other credential shape.

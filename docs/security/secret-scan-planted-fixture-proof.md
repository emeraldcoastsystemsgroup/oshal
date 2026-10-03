# Secret-scan planted-fixture proof (fail, then pass)

**Re-proven 2026-10-01** against `origin/main` d9a6d9e5, the gate as it stands since
`gate_secrets` began exporting through `export_tree`. First proven 2026-09-21 against 6011ceb6.
This is the closure evidence for the BACKLOG entry *CI secret-scanner remote mutation proof*,
under the operator's 2026-09-20 re-scope of it to the local gate.

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

## Why it was re-run

On 2026-09-24 (30e9b7cd) `gate_secrets` stopped exporting with a bare `git archive | tar` and
began calling `export_tree` from `scripts/ci/ci-export.sh`, the watchdog-bounded export. The guard
runs the sliced gate text in a bare Git Bash and sources the helpers it needs there; it did not
source that one, so from then on every stage stopped before the scanner ran. The unchanged guard
on d9a6d9e5:

```
<tmp>/oshal-secret-scan-planted-WRs9QW/probe-clean.sh: line 19: export_tree: command not found
Test Files  1 failed (1)
     Tests  5 failed | 1 passed (6)
```

The one case still passing was "never prints the scanned value", which holds trivially when
nothing is scanned. The guard now sources `ci-purge.sh`, `ci-export.sh` and `ci-secret-scan.sh`,
the three helpers `scripts/ci-local.sh` loads before any gate runs.

`tests/unit/real-boundary-doctrine.spec.ts` now also finds, from the `name() {` definitions in
each `scripts/ci/*.sh` file, which helper files the sliced gate text calls, and requires the guard
to source every one of them. It checks sourcing the way the probe does it: the helper's path
constant must be on the probe's argv, and the positional it arrives on (`$4`, `$5`, ...) must be
dot-sourced by the probe script. A helper that is only named, or passed but never sourced, is
refused. That check needs no Docker. Each result below is from a run on 2026-10-01.

Against the old guard on d9a6d9e5, which never names `ci-export.sh`:

```
AssertionError: the gate calls export_tree from ci-export.sh; the guard must source it (its path constant is not on the probe argv): expected 0 to be greater than 0
Test Files  1 failed (1)
     Tests  1 failed | 14 passed (15)
```

**Mutation C — the helper is passed but not sourced.** In the fixed guard, `ci-export.sh` stays
named and passed as `$5`, but its `'. "$5"'` line is removed from the probe. Reverted
afterwards:

```
AssertionError: the gate calls export_tree from ci-export.sh; the guard must source it (argv $5 is never dot-sourced): expected '/**\n * CHANGE LOG\n * --------------…' to contain '\'. "$5"\''
Test Files  1 failed (1)
     Tests  1 failed | 14 passed (15)
```

With the guard as committed: `Tests  15 passed (15)`.

## What runs

`tests/unit/ci-local-secret-scan-planted-fixture.spec.ts`. It slices the production
`gitleaks_container_scan` and `gate_secrets` function bodies out of `scripts/ci-local.sh` and
executes them in Git Bash beside the same three helpers the gate script sources, so the guard runs
the nightly's own text rather than a paraphrase of it. Four sequential commits of one disposable
repository — created under the OS temp directory and deleted in `afterAll` — are scanned in turn.
The repository carries this repo's **real** `.gitleaks.toml`, so the production allowlist is the
one under test.

The scanner is real. No `docker` stand-in is placed on PATH: `docker run --rm --network none`
launches `zricethezav/gitleaks:latest`, and each scan container is removed when it exits. On this
box that tag resolves to
`RepoDigests=[zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f]`,
the same digest the 2026-09-21 run recorded as `v8.30.1`. The gate uses the floating `:latest`
tag, so that is what this run measured, not a pin.

Setting `OSHAL_SECRET_SCAN_PROOF_LOG` to a file path makes the guard write each stage's gate exit
and full output there before its temp directory is deleted. Unset, it writes nothing outside that
directory. The stage blocks below come from that file.

```bash
OSHAL_SECRET_SCAN_PROOF_LOG=<file> \
  npx vitest run tests/unit/ci-local-secret-scan-planted-fixture.spec.ts \
  --no-file-parallelism --reporter=verbose
```

Run at 2026-10-01T14:05:21Z:

```
Test Files  1 passed (1)
     Tests  6 passed (6)
  Duration  17.72s
```

## The four stages, verbatim

Each block is the gate's own output for one commit, copied from that run's
`OSHAL_SECRET_SCAN_PROOF_LOG` file. `LOG:` lines are `ci-local.sh`'s `log` function, the
`export: OK` line is `export_tree`'s own outcome line, and the timestamped lines are the scanner's
replayed stderr. Two edits only: the scanner's colour codes and ASCII banner are removed, and the
temp directory prefix is shortened to `<tmp>/`.

**1. Clean tree — PASS**

```
== stage clean: gate exit 0
LOG:purge: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-clean/ci-scan-src (already absent)
LOG:export: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-clean/ci-scan-src (1s)
LOG:secret-scan: PASS unread=0 of 3 exported files (scanner rc=0)
LOG:purge: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-clean/ci-scan-src (2s)
2:05PM INF scanned ~48 bytes (48 bytes) in 91.3ms
2:05PM INF no leaks found
```

**2. Planted fixture — FAIL.** One file added, holding an AWS-access-key-id-shaped synthetic
value (the `AKIA` prefix plus sixteen characters, assembled from parts at runtime so the spec
source never carries the contiguous token).

```
== stage planted: gate exit 1
LOG:purge: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-planted/ci-scan-src (already absent)
LOG:export: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-planted/ci-scan-src (1s)
LOG:secret-scan: FAIL scanner rc=1 unread=0 of 4 exported files (findings or scanner error above)
LOG:purge: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-planted/ci-scan-src (1s)
2:05PM INF scanned ~91 bytes (91 bytes) in 180ms
2:05PM WRN leaks found: 1
```

**3. Control — the allowlisted AWS documentation dummy, still PASS.** The planted file is replaced
by one holding `AKIAIOSFODNN7EXAMPLE`, which `.gitleaks.toml` exempts by exact value. The export is
still four files and the same shape is still present, so this is what makes the red above
attributable to the planted *value* rather than to the shape or to the extra file.

```
== stage allowlisted: gate exit 0
LOG:purge: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-allowlisted/ci-scan-src (already absent)
LOG:export: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-allowlisted/ci-scan-src (1s)
LOG:secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)
LOG:purge: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-allowlisted/ci-scan-src (1s)
2:05PM INF scanned ~92 bytes (92 bytes) in 214ms
2:05PM INF no leaks found
```

**4. Fixture removed — PASS again.**

```
== stage removed: gate exit 0
LOG:purge: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-removed/ci-scan-src (already absent)
LOG:export: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-removed/ci-scan-src (1s)
LOG:secret-scan: PASS unread=0 of 3 exported files (scanner rc=0)
LOG:purge: OK <tmp>/oshal-secret-scan-planted-3Ga8rC/state-removed/ci-scan-src (1s)
2:05PM INF scanned ~48 bytes (48 bytes) in 68.2ms
2:05PM INF no leaks found
```

The guard also asserts that the planted value never appears in any of the four outputs — the gate
passes `--redact`, and a proof that prints the thing it planted is not a proof anyone can paste.

## Mutation evidence: the guard was watched failing

A guard nobody watched fail is a guard nobody knows works. Mutations A and B break the gate and
are caught by this guard's verdicts. Both were re-applied on 2026-10-01 to the lane's working tree
against the current gate, each reintroducing a real defect shape, and both were restored
afterwards (`git status` showed only the two changed spec files). Mutation C breaks the guard's
own helper sourcing and is caught by the doctrine check; it is recorded above, under *Why it was
re-run*. Lines elided from the assertion output are marked `...`.

**Mutation A — the gate stops believing the scanner.** `--exit-code 0` added to the production
`gitleaks_container_scan` invocation in `scripts/ci-local.sh`, so findings no longer set a failing
exit code. The scanner still finds the leak; the gate now calls it a PASS:

```
tests/unit/ci-local-secret-scan-planted-fixture.spec.ts >
  goes RED on the planted credential-shaped fixture, with the scanner's own rc in the verdict
AssertionError: ...
LOG:secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)
...
2:04PM WRN leaks found: 1
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
AssertionError: ...
LOG:secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)
...
2:04PM INF no leaks found
: expected +0 to be 1 // Object.is equality
Test Files  1 failed (1)
     Tests  1 failed | 5 passed (6)
```

Mutations A and B were reverted and the guard re-run green (`Tests  6 passed (6)`, the run
quoted above) before the change was committed.

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
- The opt-in proof log holds only what the gate printed, and the gate runs the scanner with
  `--redact`; the guard's redact case fails the run if the planted value appears in any stage's
  output. The quoted run's log was checked the same way and does not contain it.
- Nothing was pushed to a branch, disposable or otherwise, to obtain this evidence, and no hosted
  runner minutes were spent.

## What this does not prove

- **Nothing about GitHub Actions.** The hosted `gitleaks` jobs in `.github/workflows/ci.yml` and
  `.github/workflows/security.yml` remain `workflow_dispatch`-only and were not run. In
  particular the full-history pass (`--log-opts=--all`) is untested here; this proof is the
  `--no-git` working-tree shape the local gate uses.
- **Nothing about the partial-scan half.** `scripts/ci/ci-secret-scan.sh` refuses to call a scan
  clean when gitleaks skipped paths it could not read. Nothing in *this* run exercises that: every
  tree it scans is fully readable. That half was proven separately on 2026-09-21 against the same
  image — see [secret-scan-unreadable-path-proof.md](./secret-scan-unreadable-path-proof.md).
- **Nothing about rule coverage.** One rule (`aws-access-token`) is shown to fire end to end.
  This says nothing about whether any other gitleaks rule would catch any other credential shape.
- **Not a full `ci-local.sh` run.** Only the `secret-scan` gate's text and its three helpers ran;
  the other gates, the lock and the run-log wrapper did not.

# Secret-scan partial-scan proof (a path the scanner could not read)

**Proven 2026-09-21** against `origin/main` dac39760. This is the closure evidence for the
`secret-scan` row of [the real-boundary regression audit](../governance/real-boundary-regression-audit.md)
— the last row on that page whose owed companion was reachable from this box.

## What was owed

`scripts/ci/ci-secret-scan.sh` exists because `gitleaks detect` **exits 0 on a scan it could not
finish**. On 2026-09-10 the nightly recorded 5 of 5077 exported files unread and `secret-scan`
reported PASS. The helper counts the scanner's own skipped-path stderr and refuses to call such a
run clean.

Two guards already covered parts of that:

- `tests/unit/ci-local-secret-scan.spec.ts` runs the production gate body but puts its **own
  `docker` first on PATH** and replays recorded stderr, so the image never runs.
- `tests/unit/ci-local-secret-scan-planted-fixture.spec.ts` runs the **real** image, but only over
  trees it can read; it proves the findings half (`scanner rc=1`), never the partial-scan half.

So nothing had ever made `zricethezav/gitleaks:latest` actually skip a path and exit 0. The audit
also owed a second, quieter clause: `GITLEAKS_UNREAD_PATTERN` lists five wordings calibrated
against **v8.30.1**, while the gate pulls the floating `:latest` tag. A reworded skip line counts
zero unread and passes a partial scan in silence.

## What runs

`tests/unit/ci-local-secret-scan-unreadable-path.spec.ts`. It takes the production text rather
than a paraphrase of it:

- `gitleaks_container_scan` is sliced whole out of `scripts/ci-local.sh`.
- the export is built by the `git archive | tar -x` **line** sliced out of `gate_secrets`.
- the scan is the `run_secret_scan "$exp" gitleaks_container_scan "$exp" || rc=1` **line** sliced
  out of `gate_secrets`, over `run_secret_scan` sourced from the shipped
  `scripts/ci/ci-secret-scan.sh`.

No `docker` stand-in is placed on PATH. The scanned tree is a four-file disposable export carrying
this repository's real `.gitleaks.toml`, which is what makes the denied file the only difference
between the RED run and the GREEN runs either side of it. `gate_secrets`' `purge_tree` wrapper is
not re-executed here; the two sibling guards own it.

The scanner is real: `docker run --rm --network none` launches `zricethezav/gitleaks:latest`,
which on this box reports `v8.30.1`
(`RepoDigests=[zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f]`).
The gate uses the floating tag, so that version is what this run measured, not a pin.

### How the path is made unreadable

The container mounts the export read-only from a Windows directory. A Windows **deny-read ACE**
on one exported file (`icacls <file> /deny *S-1-1-0:(R)`) is refused by the host side of the file
share, so inside the container the file appears as `--wx-wx-wx` and `open()` returns `EACCES`:

```
$ docker run --rm --network none -v <export>:/scan:ro --entrypoint sh zricethezav/gitleaks:latest \
    -c 'ls -la /scan/src; cat /scan/src/unreadable.ts'
-rwxrwxrwx    1 root     root            24 Sep 21 14:27 app.ts
--wx-wx-wx    1 root     root            15 Sep 21 14:27 unreadable.ts
cat: can't open '/scan/src/unreadable.ts': Permission denied
```

`chmod` from Git Bash is a **no-op** on this box (the MSYS mount carries no `acl` flag — measured:
a `chmod 0222` file still reads `-rwxrwxrwx` inside the container and `cat` succeeds), which is
why the guard uses `icacls` on Windows and `chmod 0o000` elsewhere. Either way it then reads the
file back from Node and **throws** if the read still succeeds: a guard that quietly failed to
create the condition it tests would pass for the wrong reason.

```bash
npx vitest run tests/unit/ci-local-secret-scan-unreadable-path.spec.ts \
  --no-file-parallelism --reporter=verbose
```

```
Test Files  1 passed (1)
     Tests  6 passed (6)
  Duration  21.89s
```

## The three stages, verbatim

`LOG:` lines are `ci-local.sh`'s `log` function; the timestamped lines are the scanner's own
stderr, passed through by `run_secret_scan`.

**1. Every exported file readable — PASS**

```
==== readable (status 0) ====
LOG:secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)
2:32PM INF scanned ~93 bytes (93 bytes) in 76.8ms
2:32PM INF no leaks found
```

**2. One path denied — FAIL, while the scanner itself reported success.** This is the 2026-09-10
defect reproduced rather than described: `no leaks found`, `scanner rc=0`, and a file that was
never opened.

```
==== denied (status 1) ====
LOG:secret-scan: FAIL unread=1 of 4 exported files (scanner rc=0) - gitleaks skipped paths it could not read; a partial scan is not a clean scan
2:32PM WRN skipping file: permission denied path=/scan/src/unreadable.ts
2:32PM INF scanned ~64 bytes (64 bytes) in 73.3ms
2:32PM INF no leaks found
```

The scanned-bytes line moves with it: 93 bytes read when the file is readable, 64 when it is not.

**3. The read given back — PASS again**, so the red above is that one permission and nothing else.

```
==== restored (status 0) ====
LOG:secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)
2:33PM INF scanned ~93 bytes (93 bytes) in 143ms
2:33PM INF no leaks found
```

Stage 2 also settles the floating-tag clause: `skipping file: permission denied` is still what the
image writes, and the guard matches that line against `GITLEAKS_UNREAD_PATTERN` **read out of the
shipped helper**, not against a copy of it.

## Mutation evidence: the guard was watched failing

Two mutations were applied to the lane's working tree, each reintroducing a real defect shape, and
both were restored afterwards.

**Mutation A — the wording list is narrowed.** `GITLEAKS_UNREAD_PATTERN` reduced to
`'could not read file|cannot allocate memory'`, which is exactly what a reworded `:latest` would
do to the gate, and exactly the "narrow the pattern until it stops complaining" move the repo
forbids. The partial scan goes green again:

```
× ... > goes RED when one exported path cannot be read, and says how many were missed
  → LOG:secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)
× ... > still recognises the wording the FLOATING :latest tag writes for a path it did not read
AssertionError: 2:31PM WRN skipping file: permission denied path=/scan/src/unreadable.ts: expected false to be true
Test Files  1 failed (1)
     Tests  2 failed | 4 passed (6)
```

**Mutation B — the gate stops refusing a partial scan.** `if [ "$unread" -gt 0 ]` in
`run_secret_scan` raised to `-gt 999`, i.e. the pre-2026-09-10 behaviour of trusting the scanner's
exit code. The count is still correct; the verdict is not:

```
× ... > goes RED when one exported path cannot be read, and says how many were missed
  → LOG:secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)
Test Files  1 failed (1)
     Tests  1 failed | 5 passed (6)
```

Both mutations were reverted (`git status` clean but for the new spec) and the guard re-run green
before the change was committed.

## What this does not prove

- **Nothing about the nightly's own export.** The gate scans ~5,900 files; this scans four. That
  the real nightly export contains no unreadable path is claimed only by
  `%LOCALAPPDATA%\oshal\ci-local.log`, which has recorded `unread=0` on every run that reached a
  verdict since the counter shipped.
- **Nothing about GitHub Actions.** The hosted `gitleaks` jobs stay `workflow_dispatch`-only and
  were not run.
- **Nothing about the other four wordings.** `could not read file`, `skipping directory`,
  `cannot allocate memory` and a bare `permission denied` remain covered only by the recorded
  stderr in `tests/unit/ci-local-secret-scan.spec.ts`; this run exercised `skipping file:
  permission denied`, which is the one a denied file produces.
- **Nothing about `purge_tree`.** The export lifecycle is the sibling guards' claim, not this one's.

# Local CI — the automatic daily gate

> Companion tools: [ADR-090](../adr/090-github-actions-to-local-ci.md) records the GH-Actions →
> local-CI migration decision; [gha-local.md](./gha-local.md) is the generic bridge that runs ANY
> workflow YAML locally (this script is the hardened port of this repo's specific pipeline).

**Operator decisions 2026-07-09:** GitHub-hosted Actions burned ~$15 on automatic runs
(per-push at 50+ pushes/day) and was retired that morning; after the billing hold was
paid that evening it came back **MANUAL-ONLY** (`workflow_dispatch` only — never a
`push:` trigger or `schedule:` cron; see the header of
[.github/workflows/ci.yml](../../.github/workflows/ci.yml)). This trunk has no separate
deployment workflow or retired-workflow archive. The cloud and local Compose smokes are ephemeral
image/build validation: both tear down their test stacks and change no durable target.

**The gate that runs automatically is this one:** [`scripts/ci-local.sh`](../../scripts/ci-local.sh),
daily on the operator's machine, $0, windowless, email only on failure.

**Proven ALL GATES GREEN 2026-07-09 20:51 on commit f18135d4 — ~16 min end to end.**

## What runs

Same gates the retired workflow ran (plus the quickstart-smoke equivalent), same order:

| Gate | What it does | Fails the run? |
|---|---|---|
| head-src (`--head`/`--scheduled` only) | clean pinned-commit export + `npm ci`; interactive `--head` pins HEAD, scheduled mode fetches and pins `origin/main` | yes |
| typecheck | `npm run typecheck` | yes |
| unit | `npm run test:unit` (vitest, no DB) | yes |
| lint | `npx eslint src tests scripts --max-warnings 0` | yes |
| connectors | `connectors:audit-gate --quiet` — structural audit of every `swarm-apps/connectors/*.yaml` (ADR-065); fails on an error-level issue (bad shape, duplicate tool name, paginating resource with no pagination block). Warnings advisory | yes |
| manifests | `validate:manifests --quiet` — every `swarm-apps/*.yaml` passes the real `readManifest` and each bot's persona path resolves + parses + has a `perspective` (ADR-085 boot safety); ADR-083 mis-route cases (worker persona with no router selector) are advisory warnings | yes |
| secret-scan | dockerized gitleaks (`--network none`) on the run's **pinned commit**, `.gitleaks.toml` allowlist | yes |
| e2e-green | Playwright green-ratchet set, `--retries=2 --workers=4`, ephemeral Postgres+Redis (127.0.0.1:**25432/26379** — the live stack owns 16379/55433/55434), `PLAYWRIGHT_PORT=3456`, `NODE_OPTIONS=--dns-result-order=ipv4first`, all broker/trading env pinned empty | yes |
| image-build | `git archive "$SOURCE_SHA" \| docker build` → scratch tag `oshal-ci:latest` (never touches `any-bot:latest`) | yes |
| image-smoke | boots the built image on the private `oshal-ci-net` against the ephemeral stores: `/health`, real ticket create (noop), `swarm_applications` non-empty | yes |
| trivy | Trivy on a docker-save tarball streamed into a docker **volume** (bind-mount I/O blows the timeout; no docker socket in the scanner) — CRITICAL/HIGH, fixable only, skips vendored `/usr/local/bin` | yes |

The Dockerfile runs `apk upgrade` at build time, so fixable base-OS CVEs (musl/zlib class)
self-heal on the daily rebuild without manual bumps.

## How to run

```bash
bash scripts/ci-local.sh --head          # interactive committed-HEAD run; never fetches
bash scripts/ci-local.sh                 # working-tree mode: test what you have right now
bash scripts/ci-local.sh --skip-image    # fast loop: no docker build / smoke / trivy
bash scripts/ci-local.sh --skip-e2e --skip-image   # fastest: typecheck+unit+secrets
```

The scheduled task uses `--scheduled`, not `--head`: it fetches
`refs/heads/main` into `refs/remotes/origin/main` once, resolves one immutable SHA, and uses that
same SHA for the node export, secret scan, image build, start log, and failure alert. A failed
fetch does not silently reuse a stale remote-tracking ref; the log labels
`DEGRADED_FETCH_FAILED_HEAD_FALLBACK` and judges the already-resolved local HEAD instead.

One run at a time (single-instance lock, exit 2 if held). **Never edit
`scripts/ci-local.sh` while a run is in flight** — bash reads the script
incrementally, and a mid-run rewrite makes the running instance execute shifted
lines. If you kill a run, check `ps -ef | grep ci-local` for surviving children
before clearing `%LOCALAPPDATA%\oshal\ci-local.lock` — a half-dead run's e2e
gate can destroy a live run's datastores (learned the hard way).

## Schedule + alerting

Windows task **"OSHAL Local CI"** runs daily at 23:30 local, windowless, via
`scripts/ci-local-hidden.vbs` (same zero-window pattern as the trading watchdog):

```
schtasks /create /tn "OSHAL Local CI" /sc daily /st 23:30 /f ^
  /tr "wscript.exe //B //Nologo C:\Projects\oshal\scripts\ci-local-hidden.vbs"
```

- **Green run → no email, no popup.** Summary line in the log only.
- **Red run → one email** via the api container's `oshal-send-alert.js` (the trading
  watchdog's alert rail). If the api container is down, the failure is log-only.
- The hidden launcher waits for the gate and returns its exit code, so Task Scheduler's
  `LastTaskResult` now agrees with the completed run instead of reporting launch success early.

Logs: `%LOCALAPPDATA%\oshal\ci-local.log` (one line per gate) and
`%LOCALAPPDATA%\oshal\ci-local-last-run.log` (full output of the latest run).

## Reading the failure alert

The gate has been red continuously since **2026-07-27**, so "it failed again" carries no
information. The alert exists to answer one question: **did anything change tonight?** Read the
subject, not the fact of the email.

| Subject after `OSHAL LOCAL CI FAILED -` | What it means |
|---|---|
| `NEW: <gates> (night N)` | Those gates were **not** failing in the last run that measured everything. This is the line worth acting on. |
| `no change from last run (night N)` | Identical failing set. Nothing to do. |
| `no new failures; FIXED: <gates> (night N)` | Those gates left the failing set **and this run actually ran them**. |
| `no new failures; N gate(s) DID NOT RUN (night N)` | Gates left the failing set but the run skipped them. **Not proof they pass.** |
| `all gates green` | The streak is broken. |

Three rules decide that wording, and each exists because its absence produced a false alert:

- **"New" is measured against one baseline run — the most recent prior run that skipped
  nothing.** A green run qualifies. When a run fails early it appends skip markers
  (`node-gates-skipped`, `<gate>-skipped`) and every downstream gate silently leaves its failing
  set; diffing against that manufactures false NEWs. On 2026-09-13 the alert announced
  `NEW: store-compatibility unit lint security-policy e2e-green trivy` when only
  `security-policy` was new — the rest had been red since July. When the baseline is not the
  immediately preceding run, the **body names it** and says how many runs were stepped over.
- **A skipped gate is never reported as fixed.** It was not measured, and a green nobody
  measured is worse than no claim at all.
- **The streak counts consecutive failed runs**, and the body dates the first one. A long streak
  is context, not news.

The headline is also written into `ci-local.log` next to the outcome line, so the "is anything
new?" answer survives an api container that is down and cannot send mail.

Implementation: [`scripts/ci/ci-gate-streak.mjs`](../../scripts/ci/ci-gate-streak.mjs), invoked by
`ci-local.sh` after it writes the outcome line. Guard:
[`tests/unit/ci-gate-streak.spec.ts`](../../tests/unit/ci-gate-streak.spec.ts) — its fixtures are
verbatim lines from the real log, because parsing that real shape is the boundary a wrong summary
would corrupt silently. To see what the current log would produce without waiting for a run:

```bash
node scripts/ci/ci-gate-streak.mjs "$LOCALAPPDATA/oshal/ci-local.log"
```

## BUG-22 — what is done, and how to continue

[BUG-22](../operations/bug-log.md) is the entry for the standing red streak. **Do not treat a red
night as evidence about the code until the work below is finished.**

Done:

- The alert says what changed (above), so a new failure inside the standing failure is visible.
- `secret-scan` — a secret-shaped test fixture was the single finding; removed.
- `local-secret-hygiene` — two plaintext `.env` backups in the repo root; moved to
  `%LOCALAPPDATA%\oshal\env-backups\`. Gitignored files are exactly what a source-only scan
  cannot see, which is why that gate exists.

Open, each a `BACKLOG` entry with done-when criteria:

1. **`trivy`** — a CVE-budget decision, not a code fix. The last report on disk is from
   2026-07-09, so the current finding set is not actually known. Capture a fresh report first.
2. **`unit` + `e2e-green`** — never triaged. No run log preserves *which* specs fail:
   `ci-local.log` keeps only per-gate PASS/FAIL and `ci-local-last-run.log` is overwritten each
   night. Start with one `bash scripts/ci-local.sh --head` on an idle box, keeping the output.
3. **Host contention** — the gate partly measures the host. A run that starts while the full
   swarm, Docker Desktop and an editor are up can find **0.4 GB free of 15.7 GB**: `head-src`
   took 2144 s and failed, skipping seven gates; `secret-scan` logged `cannot allocate memory`
   against files it could not read; `image-build` ran 55+ minutes against 68 s earlier the same
   day. Until resource exhaustion is reported distinctly from gate failure, a red night is not
   evidence about the code.
4. **The purge hang** — `prepare_head_src` can wedge for hours deleting its own previous export.

The suggested order is 2, then 1 — triage is blind without spec-level output, and the trivy
decision needs a current report. 3 gates the trustworthiness of both.

### First kept run — 2026-09-14 (reduced gate, loaded host)

Item 2 above has its first data point. The full classified lists are in
[local-ci-bug22-run-2026-09-14.md](./local-ci-bug22-run-2026-09-14.md); this subsection is the
summary. Evidence only — nothing here names a cause.

- **Command:** `bash scripts/ci-local.sh --head --skip-image` (interactive head mode; HEAD
  `231b76f4` of `feat/store-compatibility-gate`; image build, image-smoke and trivy skipped).
  2026-09-13 23:58:40 → 2026-09-14 00:20:03 local (04:58–05:20 UTC).
- **Conditions — the box was NOT idle:** 22 idle Claude Code sessions (~0.1–0.2 GB each) and
  VS Code open; host free RAM 0.4–1.3 GB of 16 GB; the Docker VM with all 45 stack containers up
  at load1 2–5 on 8 CPUs; e2e ran with `--workers=4 --retries=2`. Item 3 applies to every number
  below.
- **Kept output:** `%LOCALAPPDATA%\oshal\ci-runs\ci-head-skipimage-20260913-2358.out.log`
  (70,156 lines); per-gate lines in `%LOCALAPPDATA%\oshal\ci-local.log`.
- **Outcome lines:** `=== LOCAL CI: FAILED gates: unit lint security-policy e2e-green ===` and
  `no new failures; FIXED: store-compatibility trivy (night 51)`. `store-compatibility` passed.
  `trivy` did not run (no `GATE trivy` line in this run); its `FIXED` is the streak comparison's
  reading of a gate absent from this run against the previous night's failing set.

| Gate | Result | Duration |
|---|---|---|
| head-src / typecheck / store-compatibility | PASS | 43 s / 34 s / 43 s |
| connectors / manifests / kernel-skills / workflow-triggers | PASS | 2 s / 5 s / 18 s / 0 s |
| repo-separation / worktree-strays / secret-scan | PASS | 0 s / 1 s / 74 s |
| local-secret-hygiene / unpushed-commits | PASS | 0 s / 7 s |
| unit | **FAIL** | 496 s |
| lint | **FAIL** | 35 s |
| security-policy | **FAIL** | 10 s |
| e2e-green | **FAIL** | 514 s |
| image-build / image-smoke / trivy | not run (`--skip-image`) | — |

- **unit:** `Test Files 45 failed | 846 passed | 2 skipped (893)` · `Tests 49 failed | 8785 passed |
  47 skipped (8881)` · `Errors 1 error`. The gate's reporter printed per-file `❯` lines and `×`
  title+duration lines only — no assertion messages, and no detail for the `1 error`. Of the 45
  `❯` lines, 27 carry a failed-test count (the 49 tests); the other 18 are failed files with no
  failed-test count and nothing else in the log (14 `*-browser.spec.ts`, two `(0 test)`, two
  all-skipped). Top files by failed tests: `app-store-remote` 9, `site-product-pages` 4,
  `publish-gate` 4, `artifact-dispatch-browser` 3, `invite-reconnect-message` 3,
  `machine-write-identity` 3, `static-surface-glass` 2, `schema-lock-privilege-tolerance` 2,
  nineteen files 1 each. Buckets by first error line (error lines recovered by re-running the 15
  Docker/browser/DB-free files from the same `ci-src` export, one at a time, plus a detail re-run
  of the three security-policy files): assertion 27, environment 3 (`git ls-files` in the
  `.git`-less export ×2, missing `oshal_trading_accounts` table ×1), runtime `TypeError` 2,
  passed on re-run 2 (`any-bot-runtime-containment`, `trading-schwab-account-binding`), detail not
  in the log and not re-run 15 (browser / image / database files). No recovered error line says
  timeout or load-gate.
- **lint:** one warning, and warnings block: `src/app/server.ts 2011:1 File has too many lines
  (1003). Maximum allowed is 1000 max-lines`.
- **security-policy:** `Tests 5 failed | 154 passed (159)` in 3 files — three `/api` mounts at
  `src/app/server.ts:1190-1192` (`/api/authorization/tenant-memberships`, `/api/authorization`,
  `/api/user-directory`) mounted without `requiresAuth / serviceSecretOr / requiresOperator` and
  not on `UNGUARDED_ALLOWLIST`; migrations `127`, `129`–`137` (ten files) self-manage
  `BEGIN;/COMMIT;` without the `-- oshal:no-transaction` pragma; and three machine-write-identity
  cases (a stale `artifact-exchange-core` inventory entry, a `jarvis-service-callers` driver with
  0 observations, a `local-auth` probe answered `403 {"error":"installer setup requires the
  original browser origin"}`). Verbatim assertion text in the companion file.
- **e2e-green:** `59 failed`, `2 skipped`, `3 did not run`, `468 passed (8.2m)` over 532 tests in
  71 curated spec files. Top files: `tool-approval-workflow` 10, `agent-memory-and-swarm-memory`
  8, `orchestration-workstreams-api` 6, `llm-execution-handler` 3, `rls-core-table-coverage-live`
  3, eight files 2 each, thirteen files 1 each. By first error line of the final failure block:
  `expect(...)` assertions 40, spec-authored `Error` messages 8, `Test timeout of 30000ms
  exceeded` 5, `TimeoutError: page.waitForFunction` 4, runtime `TypeError` 2. The string
  `Test timeout of 30000ms exceeded` appears 27 times in the section, all inside those five
  blocks (with their retries): `tool-approval-workflow` ×2 blocks, `ticket-activity-rollup`,
  `agent-profile-persistence`, `optimizer-native-routing`.

## Known constraints

- Port **3456** must be free during the e2e gate (several green-set specs hardcode it);
  the gate aborts with a message if something is listening there.
- The e2e quarantine list lives in [`tests/e2e-green-suite.txt`](../../tests/e2e-green-suite.txt)
  (`agent-profile-persistence` and `firetv-tv-pairing` are commented out with evidence —
  see BACKLOG "CI Playwright e2e suite normalization").
- Docker Desktop must be running (secret-scan, e2e datastores, image build, trivy).
- **Never edit `scripts/ci-local.sh` while a run holds the lock.** Bash reads a script by byte
  offset; an edit mid-run makes the running shell seek into the wrong place and re-execute a
  block. On 2026-09-09 this caused `image-build` and `unpushed-commits` to run twice and four
  gate names to be logged twice. Check first: `ls -d "$LOCALAPPDATA/oshal/ci-local.lock"`. The
  lock protects the *run*; nothing protects the *script*.
- **`prepare_head_src` can wedge for hours on its own cleanup.** Its first line,
  `rm -rf "$GATE_SRC"`, deletes the previous run's `node_modules` export and is **not**
  timeout-bounded (only `npm ci` is). On 2026-09-10 it consumed 9 hours and 16 CPU-seconds with
  zero progress, holding the lock all night, and the run produced no outcome line and no alert.
  It was not a file lock. `robocopy /MIR` from an empty directory cleared the same tree in 39
  seconds. If the nightly looks stuck in `head-src`, look for a long-lived `rm.exe` on `ci-src`.
- **`gitleaks` exits 0 even when it could not read files.** Under memory pressure the
  `secret-scan` gate can pass having skipped files — 5 of 5077 on 2026-09-10. A PASS on a starved
  box is not proof the tree is clean.
- **Running a gate by hand: use a `cygpath -u` path and assert the export is non-empty.** MSYS
  `tar` reads a Windows `C:\...` path as a remote host, silently producing an empty export; the
  scanner then reports on nothing.

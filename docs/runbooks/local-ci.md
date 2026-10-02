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
| store-compatibility | compile every source-bearing public store package against the pinned core types in disposable exports; preserve full diagnostics per run | yes |
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

Around the gates, every run logs its **resource check** first (`resource-check: floor ...` or
`resource-check: NOT CONFIGURED`), and a scheduled run **stops the workers the operator named**
before `head-src` and restores them before its outcome line. A gate the host could not run is
reported **RESOURCE-EXHAUSTED**, not FAIL. See
[Saturated host](#saturated-host-resource-exhausted-and-the-worker-quiesce).

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

### Core/store compatibility release check

From the core checkout, with Node, Git, tar and a local applications checkout:

```bash
node scripts/check-store-compatibility.mjs --store ../oshal-applications
node scripts/check-store-compatibility.mjs --store ../oshal-applications --core-ref <core-sha> --store-ref <store-sha> --prove-rejection
bash scripts/ci-local.sh --store-compatibility-only
```

Both refs default to `HEAD` and resolve to immutable commits before export. Commit your candidate
first: dirty, staged and untracked changes are deliberately excluded. The default Node command
runs `npm ci --ignore-scripts --legacy-peer-deps` in the core export. Optional
`--dependencies <provisioned-core>` reuses that tree's `node_modules` after matching its
`package.json` and lockfile to the pinned commit; the report labels this caller-provisioned mode.
The Bash standalone entry uses this faster mode with the local core dependency installation.

The full local-CI runner uses its provisioned `GATE_SRC` dependencies. Interactive runs use
`OSHAL_STORE_REPO` (default sibling `oshal-applications`) and `OSHAL_STORE_REF` (default `HEAD`).
Scheduled runs fetch and pin store `origin/main`; a failed store fetch fails the gate rather
than checking stale code. The core commit is the same `SOURCE_SHA` used by the other release gates.
Missing repositories, dependencies, compiler or source-bearing packages fail the check.

Every run prints a unique report location containing `result.json`, `compile.log`, and, when
requested, `dependencies.log` and `rejection.log`. The full runner stores these beneath its
state directory's `store-compatibility/`; standalone defaults to the OS temp directory's
`oshal-compatibility-reports/`. Use `--reports <directory>` for a durable location of your choice.
Reports name both commit SHAs and the failing source/package. The optional rejection proof first
requires a green full compile, then adds a dishonest ambient declaration and consumer to the
disposable store; only a real TS2305 diagnostic for that invented export satisfies the proof.

Exports are outside both checkouts and cleaned on normal success/failure. A forcibly killed
process can leave an `oshal-compatibility-*` temp export, but never stages application sources
in the original core or rewrites original package outputs. Remove a reused `node_modules`
junction itself before removing any abandoned export. Compile-only checks do not attest to
legacy JavaScript routes, emitted-output parity, runtime behavior or package audit status.

Windows task **"OSHAL Local CI"** runs daily at 23:30 local, windowless, via
`scripts/ci-local-hidden.vbs` (same zero-window pattern as the trading watchdog):

```
schtasks /create /tn "OSHAL Local CI" /sc daily /st 23:30 /f ^
  /tr "wscript.exe //B //Nologo C:\Projects\oshal\scripts\ci-local-hidden.vbs"
```

- **Green run → no email, no popup.** Summary line in the log only.
- **Red run → one email** via the api container's `oshal-send-alert.js` (the trading
  watchdog's alert rail). If the api container is down, the failure is log-only.
- **Starved run → one email** whose subject starts `OSHAL LOCAL CI RESOURCE-EXHAUSTED` when no
  gate failed on its own merits. The run exits 3, so `LastTaskResult` is 3, not 0 or 1.
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
| `...; host saturated, not judged: <gates>` (on any subject) | Those gates were refused, or failed, while the host was below its free-memory floor. They are not evidence about the code either way, and they are never called NEW or FIXED. |
| `OSHAL LOCAL CI RESOURCE-EXHAUSTED - no code failures (night N); host saturated, ...` | Nothing failed on its own merits; only starved gates. A starved night still counts in the streak and is never used as the baseline for "new". |
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

## Saturated host: RESOURCE-EXHAUSTED and the worker quiesce

The nightly shares the box with the live swarm. On 2026-09-08 it started with 0.4 GB free of
15.7 GB: `head-src` took 2144 s and failed, `secret-scan` logged `cannot allocate memory`, and
`image-build` ran 55+ minutes against 68 s that morning. On 2026-09-30, with the swarm up, eight
gates ran more than ten times slower than on 2026-09-29 with the swarm stopped (`connectors` 2 s to
232 s). A red produced that way says nothing about the code. Two mechanisms address it (operator
decision 2026-09-21). Both read their settings by name from the environment or from the
checkout's `.env` ([.env.example](../../.env.example), "Local CI nightly").

### The resource check: RESOURCE-EXHAUSTED is its own outcome

[`scripts/ci/ci-resource.sh`](../../scripts/ci/ci-resource.sh) reads the host's available memory
from `/proc/meminfo`, which under Git Bash describes the Windows host the `unit` gate's node
workers run on, not the Docker VM. `run_gate` uses it in two places:

- **Before a gate starts.** If free memory is below `OSHAL_CI_MIN_FREE_MB`, the gate waits up to
  `OSHAL_CI_RESOURCE_WAIT_SECONDS` (default 120) for the host to recover. If the host does not
  recover, the gate is not started and is logged
  `GATE x: RESOURCE-EXHAUSTED (Ns; not started: host free ...MB stayed below the ...MB floor ...)`.
- **While a gate runs.** A background sampler records the lowest free memory every
  `OSHAL_CI_RESOURCE_SAMPLE_SECONDS` (default 5). If the gate fails and the host was below the floor
  during it, the gate is logged `RESOURCE-EXHAUSTED (Ns; failed while host free fell to ...)`, not FAIL.
  A gate that passes through a dip is still PASS. The sampler exits when its run ends or dies.

The classification is by measurement only. Words in a gate's output are not used: the `unit`
gate's own output contains `ENOMEM` and `cannot allocate memory` from specs that inject those
faults (`catalog-load-readiness`, `readiness-report`, `ci-local-secret-scan`), so matching words
would turn real failures into exhaustion. A failure on a healthy host stays FAIL.

Resource-exhausted gates go to their own list. They are never a pass, never a silent skip and never
a code failure:

- Skip markers inherit the cause of the gate they depend on. If `head-src` was starved,
  `node-gates-skipped` is RESOURCE-EXHAUSTED. If `image-build` was starved, its three `*-skipped`
  markers are too.
- The outcome line names failures and exhaustion separately:
  `=== LOCAL CI: FAILED gates: a; RESOURCE-EXHAUSTED gates: b ===`, or either section alone.
- A run with only exhausted gates exits **3**. A run with any real failure exits 1.
- No image is published from a run with an exhausted gate.
- The alert subject reads RESOURCE-EXHAUSTED when nothing else failed (see the table above).

With `OSHAL_CI_MIN_FREE_MB` unset, every run logs `resource-check: NOT CONFIGURED` and classifies
nothing. There is no default floor; what counts as starved is the operator's setting.

### The worker quiesce

[`scripts/ci/ci-quiesce.sh`](../../scripts/ci/ci-quiesce.sh) stops the workers named in
`OSHAL_CI_QUIESCE_WORKERS` for a `--scheduled` run (or `--quiesce`) and restores exactly those.
A named container is stopped only if all four of these hold. Anything else is refused, with the
reason in the log:

1. It exists and is running. The restore never starts a container that was not running.
2. It carries `oshal.tier=worker`. The infrastructure tier (db, redis, chromadb, tsdb, vault,
   arangodb, ...) has no tier label, the api is `core`, and the monitoring overlay is unlabelled,
   so none of them can qualify.
3. Its `AGENT_ID` is not in [`scripts/routability-critical-bots.txt`](../../scripts/routability-critical-bots.txt).
   That list covers Jarvis's brain, general-bot, the trading bot, finance and communications. It is
   also the list the stack watchdog uses to decide whether to bounce the api.
4. Its name is a plain compose container name.

A stopped worker fires `SwarmContainerDown` (critical, `intake: auto`). Each firing opens an
incident with unattended RCA, and with `SELF_HEAL_AUTO_APPLY` the container is restarted mid-run.
So before stopping anything, the run creates an Alertmanager silence for exactly those containers
at `OSHAL_CI_QUIESCE_ALERTMANAGER_URL`. If the silence cannot be created, nothing is stopped. Set
the URL to `none` only on a box without the monitoring overlay. The silence initially lasts the
stale-lock window (`CI_LOCK_STALE_SECONDS`, 4 h). After the restore it is shortened to
`OSHAL_CI_QUIESCE_RESUME_GRACE_SECONDS` (default 600). If a worker does not come back, its alert
fires after the grace.

The workers are always restored:

- **At the end of the run**, before the publish decision and the outcome line. A worker that will
  not start makes the run red with `quiesce-resume-failed`.
- **On failure or interruption.** `on_exit` restores them on EXIT, INT and TERM, before the run log
  is copied.
- **After a run killed outright.** `%LOCALAPPDATA%\oshal\ci-quiesce.state` is written before the
  first stop. Every later run that takes the lock restores what it names first. Restoring workers
  that sat down since then makes the run red with `quiesce-leftover-restored`. Workers still down
  stay in the file.
- **By hand:** `bash scripts/ci/ci-quiesce.sh --resume`. It refuses while a run holds
  `ci-local.lock`; `--force` overrides that.

`bash scripts/ci/ci-quiesce.sh --plan [name ...]` shows what a run would stop and why the rest
would be refused. It only runs `docker inspect`. The restore uses `docker start` on exactly the
stopped containers, batched with `scripts/oshal-up.sh`'s `OSHAL_UP_BATCH_SIZE` and
`OSHAL_UP_BATCH_SETTLE` (defaults 5 and 18 s). It does not call `oshal-up.sh` itself, because
that script force-recreates the api and starts every compose service.

### Proving it on the box

```bash
bash scripts/operations/ci-quiesce-live-proof.sh                      # read-only: --resource and --plan
bash scripts/operations/ci-quiesce-live-proof.sh --cycle <worker ...>  # stops and restores, twice
node scripts/ci/ci-run-durations.mjs --baseline 2026-09-08T10:05:19    # the latest scheduled run vs an idle run
```

Run these from the checkout whose `.env` holds the settings: they are read from `$REPO_DIR/.env`
(`scripts/ci/ci-config.sh`). From a clone without one, `--cycle` refuses before stopping anything
(`OSHAL_CI_QUIESCE_ALERTMANAGER_URL is not set ... Nothing stopped.`).

Recorded on the box after the 2026-10-01 deploy of `a6de96c5`: the read-only run printed
`LIVE PROOF: 15 of 15 checks passed`, and `--cycle oshal-local-weather-bot` from `C:/Projects/oshal`
printed `LIVE PROOF: 9 of 9 checks passed` with the alert silence disabled
(`OSHAL_CI_QUIESCE_ALERTMANAGER_URL=none`). No measured scheduled run exists yet.

The duration check reads `ci-local.log` and the run's kept `full.log`. It passes only when the
latest scheduled run completed, has no RESOURCE-EXHAUSTED gate and no `cannot allocate memory`
line, and every gate took at most ten times its time in the baseline run. The 2026-09-08 10:05
manual run is the idle-box run the backlog entry cites. Against it, the 2026-09-30 scheduled run
fails on `lint`, `connectors`, `manifests`, `security-policy` and `repo-separation`.

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

1. **`trivy`** — a CVE-budget decision (operator, 2026-09-21): the gate stays a gate, published
   fixes are taken first, and only what cannot move goes in `.trivyignore` with a reason and an
   `exp:` no more than 90 days out. The posture is written above `gate_trivy` in
   `scripts/ci-local.sh`. The 2026-10-02 nightly report (image from `a88a8a63`) had 29 findings
   outside the budget; all 29 were fixed on branch `trivy-1002` and none was budgeted. Against an
   image built from that branch, the gate's own invocation reports `Total: 3 (HIGH: 3,
   CRITICAL: 0)` without the budget (the three cline `undici` 5.29.0 lines, `exp:2026-12-20`) and
   exits 0 with it. Left: a scheduled nightly that judges `trivy` (not RESOURCE-EXHAUSTED) and
   logs it PASS.
2. **`unit` + `e2e-green`** — never triaged. No run log preserves *which* specs fail:
   `ci-local.log` keeps only per-gate PASS/FAIL and `ci-local-last-run.log` is overwritten each
   night. Start with one `bash scripts/ci-local.sh --head` on an idle box, keeping the output.
3. **Host contention** — the gate partly measures the host. A run that starts while the full
   swarm, Docker Desktop and an editor are up can find **0.4 GB free of 15.7 GB**: `head-src`
   took 2144 s and failed, skipping seven gates; `secret-scan` logged `cannot allocate memory`
   against files it could not read; `image-build` ran 55+ minutes against 68 s earlier the same
   day. The RESOURCE-EXHAUSTED outcome and the worker quiesce are built
   ([Saturated host](#saturated-host-resource-exhausted-and-the-worker-quiesce)). Both stay inert
   until the operator sets `OSHAL_CI_MIN_FREE_MB` and `OSHAL_CI_QUIESCE_WORKERS`. One measured
   scheduled run (`scripts/ci/ci-run-durations.mjs`) is still owed.
4. **The purge hang** — `prepare_head_src` can wedge for hours deleting its own previous export.

The suggested order was 2, then 1 — triage is blind without spec-level output; item 1 now has
its current report (2026-10-02). 3 gates the trustworthiness of both.

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
- **The runner's own code comes from the working tree, and the gates' code comes from
  `origin/main`.** The task runs `C:\Projects\oshal\scripts\ci-local-hidden.vbs`, which starts the
  `scripts/ci-local.sh` beside it. The helpers that script sources come from the same tree. The
  gates then judge the pinned `origin/main` export. So a merged change to the runner, the quiesce
  or the resource check runs only from the first 23:30 run after `C:\Projects\oshal` has that
  commit on disk. Bring the tree forward outside 23:30 to the end of the run (see the next item).
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

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

## Known constraints

- Port **3456** must be free during the e2e gate (several green-set specs hardcode it);
  the gate aborts with a message if something is listening there.
- The e2e quarantine list lives in [`tests/e2e-green-suite.txt`](../../tests/e2e-green-suite.txt)
  (`agent-profile-persistence` and `firetv-tv-pairing` are commented out with evidence —
  see BACKLOG "CI Playwright e2e suite normalization").
- Docker Desktop must be running (secret-scan, e2e datastores, image build, trivy).

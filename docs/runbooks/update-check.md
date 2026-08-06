# Update-check daemon — apps + core (as-built)

The swarm checks itself for updates: every installed store package against its own store source,
and the running core image against the tip of the public repo. Detection is automatic and daily;
**applying is always an explicit operator action** — app updates are one click on
`/applications/`, core updates remain `bash scripts/oshal-deploy.sh`. Shipped 2026-07-26
(PRs #39–#42); lives in [src/app/routes/update-check-cron.ts](../../src/app/routes/update-check-cron.ts).

## What runs, when

| Check | Compares | Source of truth |
|---|---|---|
| **Apps** | each `deployed-apps/<name>/oshal-app.yaml` `version:` | the same manifest at the package's own `source:` block (url/ref/path) on raw.githubusercontent — **never** `marketplace.json` (hand-maintained, known stale) |
| **Core** | the running image's commit (`GIT_SHA`, baked by `oshal-deploy.sh`) | tip of `main` on the public repo via the GitHub API |

Timing: a boot check ~3 minutes after the api starts, then every `UPDATE_CHECK_INTERVAL_HOURS`
(default 24 h). Network cost: two GitHub reads per run plus one raw read per installed package
that has a `source:` block. `version:` is the drift contract — the store bumps it on every
publish (same rule as [app-store-drift.md](./app-store-drift.md), which remains the deeper
volume-vs-store forensic tool; this daemon is the always-on tripwire).

## Surfaces

- `GET /api/version` — **public** (like `/health`): `{name, version, commit}`. The platform's
  runtime self-identity; `commit` is null on images built before 2026-07-25 or outside
  `oshal-deploy.sh`.
- `GET /api/updates` — auth-gated. The cached report: `checkedAt`, `core`, `apps[]` (each with
  `installedVersion` / `latestVersion` / `updateAvailable` true|false|null / `error`).
  `?refresh=1` runs a fresh check inline.
- `POST /api/updates/apps/:name/apply` — auth + **operator** gated. Re-runs
  `scripts/oshal-app.js install` with repo/ref taken from the *installed* manifest (never the
  caller; name is slug-fenced and must already be installed), then hot-reloads the package via
  the swarm-app service with the caller stamped as owner. Detection still reads the source
  manifest directly; apply independently reads the official catalog audit record and enforces
  its app/version/source-SHA binding before replacing files. Returns the installer log tail.
- **Cockpit** (`/applications/`): amber "vX.Y.Z available" badge + operator "Update to vX.Y.Z"
  row action + "Check for updates" button in the admin bar.
- **Notification center**: when a check *first* sees a given update (per app version / per core
  commit) it sends one `notifyOperator` alert. Identical daily re-checks stay silent; a further
  release re-alerts. No-op until a transport (Twilio / Telegram / email) is configured.

## Env knobs

| Variable | Default | Purpose |
|---|---|---|
| `UPDATE_CHECK_ENABLED` | on | `0`/`false` disables entirely (air-gapped / no-phone-home) |
| `UPDATE_CHECK_INTERVAL_HOURS` | `24` | check cadence (min 1) |
| `UPDATE_CHECK_CORE_REPO` | `emeraldcoastsystemsgroup/oshal` | upstream repo for the core check |
| `UPDATE_CHECK_CORE_BRANCH` | `main` | upstream branch |
| `OSHAL_STORE_TOKEN` (fallback `GITHUB_TOKEN`) | unset | **opt-in** GitHub PAT for private-store checks *and* applies — see below |
| `OSHAL_PACKAGE_AUDIT_MODE` | `compatible` | `compatible` warns and grants no pin for a valid pending/failed record; `enforce` permits only a fully passed, evidenced record and checks out its exact SHA |

## Private store: why every app may read "unknown"

A package's check fetches its manifest anonymously from `source.url`. Packages installed from the
**private** `oshal-applications` repo 404 anonymously → `updateAvailable: null` with
`error: "source not anonymously readable"`. That is by design, not a failure — and as of
2026-07-26 it applies to **all 42** installed packages, so out of the box only the core check is
fully active.

To light up the app side before the public-store cutover: create a GitHub PAT with read access to
the store repo (fine-grained, Contents: read-only, that repo only) and set it in `.env` as
`OSHAL_STORE_TOKEN`, then recreate the api. The token authorizes the raw fetches and rides to the
installer **as env only** during apply — it is never a CLI flag, never printed (installer output
shows the clean repo URL), and is scrubbed from captured logs and git error text. Once the store
cutover repoints `source:` blocks at the public repo, the token becomes unnecessary for those
packages.

## Troubleshooting

- **Badge never appears / report empty** — `docker logs oshal-local-api | grep update-check`.
  A healthy boot shows `update-check cron enabled` then `update-check: everything current` (or
  `UPDATES AVAILABLE`) with `appsChecked`.
- **`commit: null` from `/api/version`** — the running image predates the GIT_SHA bake or was
  built by hand. Redeploy with `scripts/oshal-deploy.sh`. The core check returns
  `updateAvailable: null` until then (it can't compare from an unknown commit).
- **Apply returns 502 with a git error** — the store repo isn't reachable with the current
  credentials (usually: private store, no `OSHAL_STORE_TOKEN`). The package on disk is untouched
  — the installer stages to a temp clone before replacing anything.
- **Apply reports an APP-02 audit denial** — fix the official catalog/record structure or publish
  a passed record for enforce mode. Do not switch modes to bypass a malformed, missing, unsafe,
  or SHA-mismatched binding; those are blocking in both modes.
- **Apply returns "installed on disk but hot-reload failed"** — the new files landed but the
  manifest reload errored; load it from the admin bar (`Load manifest` →
  `deployed-apps/<name>/oshal-app.yaml`) or check api logs for the loader error.
- **Dockerfile lesson (PR #40)**: `ARG GIT_SHA` must stay declared + consumed at the label layer,
  END of `Dockerfile.oshal`. An ARG declared before the heavy RUN layers invalidates their cache
  on every value change — the first stamped deploy rebuilt multi-GB from the apk layer up.

Guards: [tests/unit/update-check.spec.ts](../../tests/unit/update-check.spec.ts) — 19 specs
(version-compare incl. the `1.0.10 > 1.0.9` lexical trap and release > pre-release, source-URL
resolution, alert-once-per-version, apply fails closed 400/404, token precedence + scrubbing).

# gha-local — run any GitHub Actions workflow locally

**Script:** [`scripts/gha-local.ts`](../../scripts/gha-local.ts) (`npm run gha:local`) ·
**Decision record:** [ADR-090](../adr/090-github-actions-to-local-ci.md)

Take **any** GitHub Actions workflow file and run the equivalent pipeline on this machine — $0, no
cloud runners, nothing ever billed. Built after the 2026-07-09 Actions billing retirement:
[`ci-local.sh`](./local-ci.md) is the hardened port of *this repo's* pipeline; `gha-local` is the
**generic bridge** for any other workflow config (an imported project's, a new one, an archived one).

## Commands

```bash
# What workflows exist, and their job graphs:
npm run gha:local -- list [workflows-dir]

# Dry-run: every step and EXACTLY how it executes locally (nothing runs):
npm run gha:local -- plan .github/workflows/ci.yml [--job lint] [--input k=v]

# Execute (from a clean `git archive HEAD` export by default — commit first):
npm run gha:local -- run .github/workflows/ci.yml [--job lint] [--strict] \
  [--secrets-file .gha-secrets] [--input k=v] [--in-tree]

# Install the pipeline as a daily WINDOWLESS scheduled task (no console flash):
npm run gha:local -- install .github/workflows/ci.yml --at 10:30 [--task-name "..."]
```

## What maps how

| Workflow construct | Local execution |
|---|---|
| `jobs` + `needs` | topological order; a failed dependency skips its dependents |
| `strategy.matrix` | expanded (product + `include`/`exclude`), one job instance each |
| `services:` | `docker run` with env/ports/options, `--health-cmd` wait, guaranteed teardown |
| `run:` steps | executed under the step's shell (`bash -e` default / pwsh / cmd), merged env, timeouts, `continue-on-error` |
| `if:` | evaluated with `success()` / `failure()` / `always()` + full contexts |
| `GITHUB_OUTPUT` / `GITHUB_ENV` | plumbed; `steps.X.outputs.Y` and job `outputs:` → `needs` resolve live |
| `${{ }}` expressions | env/github/secrets/vars/inputs/matrix/needs/steps contexts; `==` `!=` `&&` `\|\|` `!`, `hashFiles()` — unknowns WARN, never silently wrong |
| `actions/checkout`, `actions/cache` | no-op (you're in a checkout; the workspace persists) |
| `actions/setup-node` | local node version check |
| `actions/upload-artifact` | copied to `.gha-local/artifacts/<name>/` |
| `docker/build-push-action` | **local build — push stripped by design** |
| `docker/login-action` | **skipped by design** (local runs never publish) |
| `aquasecurity/trivy-action` | dockerized trivy scan |
| anything unmapped | reported in `plan`/`run`; fails under `--strict` |

**Secrets** come ONLY from `--secrets-file` (dotenv-style) or `GITHUB_TOKEN` in your env. Nothing is
fetched from GitHub or anywhere else.

## The live-tree rule (learned the hard way)

`run` executes from a **clean `git archive HEAD` export** under `%LOCALAPPDATA%\oshal\gha-local-export\`
by default. This is not paranoia: on 2026-07-12 an in-tree run of the real `lint` job started
`npm ci`, which **deletes `node_modules` first** — it hit a file lock from this multi-agent
workstation's running processes and left the live tree's toolchain half-destroyed (restored with
`npm install`). Jobs mutate workspaces; the live shared tree is not a workspace to mutate.
`--in-tree` exists for read-only workflows and prints a loud warning.

Consequence: **commit before `run`** — the export is committed HEAD, exactly like
[`ci-local.sh --head`](./local-ci.md).

## `install` — the "full CI pipe, locally" button

`install` registers the workflow as a **daily scheduled task** launched through a `wscript //B`
VBS — the zero-window pattern every OSHAL task uses (a bare powershell/cmd task action flashes a
console window; that flash is what got mistaken for a rogue DOS popup on 2026-07-12). Output goes to
`%LOCALAPPDATA%\oshal\gha-local-<workflow>.log`. Remove with
`schtasks /delete /tn "<task name>" /f`. On non-Windows it prints the crontab line instead.

## Limits (honest)

- `runs-on` is ignored — every job runs on this host (a windows-only/macos job needs judgment).
- `hashFiles()` and artifact paths support literal paths; globs warn and skip.
- Composite/reusable workflow calls (`uses: ./.github/...`) are unmapped today.
- Unmapped marketplace actions are one `switch` case away
  ([actions-map.ts](../../scripts/lib/gha/actions-map.ts)).

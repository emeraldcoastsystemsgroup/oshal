# ADR-090: GitHub Actions → local CI (the $0 gate) + gha-local (run any workflow locally)

> **Numbering note:** ADR number 090 is shared by two files — this one (local CI; cited elsewhere as **ADR-090-CI**) and [090-skills-as-first-class-packages.md](090-skills-as-first-class-packages.md) (“ADR-090-skills”). Neither is renumbered, so existing links stay valid.

**Status:** Accepted — as-built (documents 2026-07-09 decisions; gha-local BUILT 2026-07-12)
**Relates to:** [docs/runbooks/local-ci.md](../runbooks/local-ci.md) (the daily gate), [docs/runbooks/ci-cd.md](../runbooks/ci-cd.md) (the retired cloud pipeline), ADR-089 (same absorb-don't-fight thesis)

## Context

Through early July 2026 this repo ran CI on GitHub Actions: per-push, then hourly, then daily cron.
The free-minutes pool was exhausted without anyone noticing; runs kept queuing against a billed
overage and burned real money (~$15) while ALSO failing for weeks — paying for red. On 2026-07-09
The operator retired automatic cloud CI. After the billing hold was paid the same evening, `ci.yml`
was restored **manual-only** and now declares only `workflow_dispatch` — never `push:` or
`schedule:`. No separate deployment workflow or retired-workflow archive exists in this clean
trunk. Its Compose smoke is runner-local image/build validation and is always torn down.

The replacement had to preserve the gates, not just cancel the bill. And it had to fit this machine:
a **shared multi-agent workstation** where the working tree is routinely mid-edit by another agent,
a live trading stack owns several ports, and the operator's real `.env` lives in the tree.

## Decision

### 1. The daily gate is local: `scripts/ci-local.sh`

The same gates the cloud ran (typecheck, unit, lint, secret-scan, e2e green-set, image build + smoke
+ trivy — since extended with the connector and manifest gates), executed on the operator's machine
for $0, daily at 10:00 via a **windowless** scheduled task. The port is not a literal translation —
it is *hardened for this machine* in ways a cloud runner never needed:

- **`--head` mode:** unattended runs judge a clean `git archive HEAD` export, never the mid-edit
  working tree (a co-agent half-typing a file must not page the operator).
- **Single-instance lock** (overlapping runs destroyed each other's e2e datastores), timeouts on
  every external command, CI-scoped container names/ports that can never collide with the live stack.
- **Secret-scan on the HEAD export with `--network none`** — the working tree holds the operator's
  live `.env`; the scanner must never see or exfiltrate it.
- Failure-only email; logs under `%LOCALAPPDATA%\oshal`.

GitHub Actions remains available **manual-only** for a cloud cross-check (`gh workflow run CI`);
nothing triggers it automatically, so a surprise bill is structurally impossible.

### 2. `gha-local`: take ANY workflow file and run the equivalent pipeline locally

`ci-local.sh` is the hardened port of ONE pipeline. The generic bridge — "point it at any GitHub
Actions configuration" — is **[scripts/gha-local.ts](../../scripts/gha-local.ts)**:

- **`list`** — workflows + their jobs/needs. **`plan`** — dry-run: every step and exactly how it
  executes locally. **`run`** — execute. **`install`** — register the workflow as a daily
  **windowless** scheduled task (the `wscript //B` pattern; a bare powershell action flashes the
  console host — root-caused 2026-07-12) or print the cron line on POSIX.
- **Faithful semantics:** jobs topologically ordered by `needs` (failed dependency ⇒ dependents
  skipped), `strategy.matrix` expanded (product + include/exclude), `services:` containers started
  via docker with health-cmd waits and guaranteed teardown, `GITHUB_OUTPUT`/`GITHUB_ENV` plumbed,
  job `outputs:` resolved into the `needs` context, `if:` conditions with
  `success()/failure()/always()`, `continue-on-error`, per-step shell (`bash -e` default / pwsh /
  cmd) and timeouts.
- **Expressions:** a minimal `${{ }}` evaluator (env/github/secrets/vars/inputs/matrix/needs/steps
  contexts, `==`/`!=`/`&&`/`||`/`!`, `hashFiles()`), two-pass: static contexts resolve at plan time,
  `steps.`/`needs.` references defer to live values mid-run. Unknown constructs surface as warnings,
  never silent wrong values.
- **`uses:` actions map to local equivalents** — the philosophy: a local run VERIFIES and BUILDS
  but never publishes. checkout/cache → noop; setup-node → version check; artifacts → local
  `.gha-local/artifacts/`; docker build-push → **local build, push stripped by design**;
  registry login → skipped by design; trivy → dockerized scan; metadata → synthesized local tags.
  Unmapped actions are reported (and fail under `--strict`), never silently dropped.
- **Secrets come ONLY from the caller** (`--secrets-file` / local env). Nothing is ever fetched.
- Acceptance-locked against the repo's real workflows: every action in the live `ci.yml` maps
  (unit test asserts zero `unknown` steps). No nonexistent archived workflow is used as acceptance
  evidence.

### 3. Non-goals

Not a GitHub-hosted-runner emulator (no `act`-style runner images — jobs run on the host, which is
the point); not a service that talks to GitHub; not a replacement for `ci-local.sh` (the hardened
daily gate stays — `gha-local` is the generic bridge for any OTHER workflow, imported or new).

## Consequences

- **Positive:** CI cost is structurally $0 with the same gates; any workflow config — this repo's,
  an imported project's, a future one — can be planned, executed, and installed as a local scheduled
  pipeline in one command. The plan command doubles as a migration audit: it shows exactly what a
  cloud pipeline does and what its local equivalent is.
- **Negative / limits:** `runs-on` is effectively ignored (everything runs on the host — a
  windows-only or macos job needs judgment); glob support in `hashFiles()`/artifact paths is
  minimal (warned, not silent); marketplace actions outside the mapped set need a mapping added
  (one switch case). Composite/reusable-workflow calls (`uses: ./.github/...`) are unmapped today.
- **Reversible:** delete the scripts; `ci.yml` still runs manually in the cloud.

## As-built

- Pure core: [scripts/lib/gha/](../../scripts/lib/gha/) — `expr.ts` (evaluator) · `parse.ts`
  (normalize/matrix/topo) · `actions-map.ts` (uses→local) · `plan.ts` (planner) · `run.ts` (engine).
- CLI: [scripts/gha-local.ts](../../scripts/gha-local.ts) (`npm run gha:local`).
- Tests: `tests/unit/gha-local.spec.ts` (17 — evaluator, parser, mapping, planner + acceptance
  against the real `ci.yml`).
- Runbook: [docs/runbooks/gha-local.md](../runbooks/gha-local.md).

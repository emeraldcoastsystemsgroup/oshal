# CI/CD Runbook

> **Current disposition (verified 2026-08-06): GitHub Actions general CI is MANUAL-ONLY.**
> Automatic runs burned hosted minutes, so the tracked `ci.yml` declares only
> `workflow_dispatch`. This trunk contains no separate deployment workflow and no retired workflow
> archive. Hosted CI validates source, builds/scans the image, may publish that image to the
> registry, and tears down its runner-local smoke stack; it does not change a durable environment.
> **The gate that runs automatically every day is local — see [local-ci.md](./local-ci.md).**
> The migration decision is recorded in [ADR-090](../adr/090-github-actions-to-local-ci.md); to run
> ANY workflow file locally (this one included), use [gha-local](./gha-local.md).
> Historical topology below explains the migration; the tracked workflow is executable truth.

How OSHAL's continuous integration and delivery worked on GitHub Actions: the pipelines, what
each job gated, how to reproduce failures locally, the two-repo publish flow, and the gotchas
that bit us. As-built as of 2026-07-06; retired 2026-07-09.

## Where it ran (historical)

Two GitHub repos, same workflow files (`.github/workflows/`):

- **`emeraldcoastsystemsgroup/open-shal`** — the private working repo. Every push to `main` and
  every PR runs **CI** (`ci.yml`). This is the day-to-day signal.
- **`emeraldcoastsystemsgroup/oshal`** — the clean-history public-track repo. Changes reach
  it only via the gated forward-sync (`scripts/release/openswarm-sync.sh` → a sync PR), so CI
  there runs on the sync branch/PR. See [the openswarm flow](#openswarm-forward-sync) below and
  `docs/release/public-release-checklist.md` §2b.

## The historical CI pipeline shape (`ci.yml`)

Historical triggers were push to `main` and PRs to `main`; those triggers are retired. The current
workflow is manual-only. `concurrency: cancel-in-progress: true` remains (see the
[gotcha](#gotcha-cancel-in-progress-hides-the-e2e-result)).

| Job | What it does | Gate |
|---|---|---|
| **Lint** | `eslint src/` (soft — passes if eslint is unconfigured) | advisory |
| **TypeCheck** | `npm run typecheck` (`tsc --noEmit`) | ✅ required-quality |
| **Test** | `npm run test:unit` (vitest, ~869 tests, no DB) **then** `npm test` (Playwright e2e) | unit ✅ / e2e ⚠️ |
| **Secret Scan** | gitleaks (`zricethezav/gitleaks`) over the working tree, `.gitleaks.toml` allowlist | ✅ |
| **Quickstart Smoke** | builds `oshal-bot:latest`, boots the api on `echo`+`MOCK_OIDC`, asserts `/health`, `/cockpit/`, a ticket create, and that migrations populated `swarm_applications` | ✅ |
| **Build Docker Images** | builds+pushes `oshal-control-plane` + `oshal-bot` (ghcr) | `needs: [typecheck, test]` |
| **Security Scan** | Trivy image scan (CRITICAL/HIGH) + `npm audit` | `needs: [build-docker]` |

**Dependency consequence worth knowing:** `Build Docker Images` needs `test`, and
`Security Scan` needs `build-docker`. So while the **e2e half of the Test job is red, the image
build and Trivy scan are SKIPPED** — decoupling or greening the e2e also unblocks those two.

### Status today (2026-07-06)

Green: **Lint, TypeCheck, Secret Scan, Quickstart Smoke, and the unit step of Test** (~869 tests).
Red: **the Playwright e2e half of the Test job** — see below.

## The Playwright e2e situation

The Test job runs the full Playwright suite (~132 specs under `tests/`, excluding `tests/unit/**`
and `tests/live/**`) after the unit tests. It is a **large, partly-unmaintained suite** and is not
green. Fixes already landed so it at least **boots and connects**:

- **Provider:** the test webServer defaults to `FORCE_LLM_PROVIDER=noop` (playwright.config.ts) —
  otherwise it boots the `claude-code` provider and throws "no ANTHROPIC_API_KEY / OAuth" at boot
  on a keyless runner, so Playwright reports "webServer was not able to start".
- **Database:** the Test job now has **Postgres + Redis service containers**; the Run-tests step
  sets `DATABASE_URL`/`REDIS_URL`/`RUN_MIGRATIONS=true` so DB-dependent specs have a real DB.
- **Port:** `PLAYWRIGHT_PORT=3456` in CI. ~18 specs hardcode `http://localhost:3456`, but under
  `MOCK_OIDC` the webServer defaults to `4458` (chosen to avoid clashing with the operator's live
  runtime — irrelevant in CI), which caused mass `ERR_CONNECTION_REFUSED`.

Even with all three, individual specs still fail on real assertions, and base-URL conventions are
inconsistent across the suite (some `:3456`, one `:35457`, others read `PLAYWRIGHT_PORT`/`baseURL`).
Full green is a **spec-by-spec normalization project** — tracked in `docs/BACKLOG.md`
("CI Playwright e2e suite normalization").

### The green ratchet (LIVE since 2026-07-06)

CI gates on a curated **green set**, not all-or-nothing:

- **`tests/e2e-green-suite.txt`** lists the spec files proven all-passing under the CI e2e env.
  First categorization (full suite, no retries, ~57 min): **66 green files / 87 red**
  (913 tests pass, 527 fail, 42 skip).
- CI's "Run e2e (green ratchet set)" step runs `npm run test:e2e:green -- --retries=1`, which
  invokes `scripts/e2e-green.mjs` → `playwright test <the 66 files>`. Green today, can't silently
  regress.
- **Growing it:** re-categorize periodically (run the full suite locally, recipe below), fix/adopt
  newly-green specs into the list. Add specs only once they pass; **never remove one to hide a
  regression**. Full-suite normalization is tracked in `docs/BACKLOG.md`.
- The full ~132-spec suite still runs via `npm test` (used for local categorization); it is not a
  required CI gate while it's red. The red files are dominated by heavy cockpit-UI interaction
  specs (e.g. `cockpit-bot-interaction`, `cockpit-views`, `tool-management-ui`).

Re-categorize with the local recipe below plus `--reporter=json`, then group by spec file (files
with zero failures are green) and refresh `tests/e2e-green-suite.txt`.

## Reproducing / verifying CI locally

**Do this instead of trusting a CI run for the e2e** — see the [cancel-in-progress gotcha](#gotcha-cancel-in-progress-hides-the-e2e-result). All commands from `C:\Projects\open-shal-swarm-harness-agent-llm` (capital `C:` — a lowercase drive-letter cwd loads `@vitest/runner` twice and fails every unit spec at collection).

**Unit suite** (fast, no DB):
```bash
npm run test:unit          # vitest — ~869 tests
```

**Type + secret gates:**
```bash
npm run typecheck
docker run --rm -v "$PWD:/scan:ro" zricethezav/gitleaks:latest \
  detect --source=/scan --no-git --config=/scan/.gitleaks.toml --redact
```

**e2e, exactly as CI runs it** (Postgres + Redis + aligned port):
```bash
docker run -d --name e2e-pg   -p 127.0.0.1:55499:5432 \
  -e POSTGRES_DB=oshal -e POSTGRES_USER=oshal -e POSTGRES_PASSWORD=oshal postgres:16-alpine
docker run -d --name e2e-redis -p 127.0.0.1:63799:6379 redis:7-alpine
# wait for pg_isready, then:
DATABASE_URL=postgresql://oshal:oshal@127.0.0.1:55499/oshal \
REDIS_URL=redis://127.0.0.1:63799 RUN_MIGRATIONS=true \
FORCE_LLM_PROVIDER=noop MOCK_OIDC=true PLAYWRIGHT_PORT=3456 CI=true \
  npx playwright test --retries=0 --reporter=line
docker rm -f e2e-pg e2e-redis
```
Use `--retries=0` — with retries on, connection/assertion failures each retry twice with timeouts
and the run can balloon to hours.

## Image build and registry publication (`ci.yml`)

The `build-docker` job runs only after typecheck and tests. It builds `Dockerfile.oshal`; a manual
run on `main` may publish the resulting tags to the configured registry. `security-scan` rebuilds
the image without publishing it, and `quickstart-smoke` starts a Compose stack only on the hosted
runner, probes health, routing, ticket creation, and migrations, then tears the stack down with
`if: always()`.

Those jobs are image/build validation, not deployment. They have no persistent target, target
credentials, target rollout step, or post-rollout parity check. A durable environment changes only
through a separately authorized operator or cluster release path, whose own health and image-parity
checks are the deployment evidence.

## Historical Fire TV Android pipeline sketch

No Fire TV workflow file or retired copy is tracked in this clean trunk. The notes below preserve
the earlier private-repository gate shape; they do not describe a runnable current workflow.

The earlier notes described a **path-filtered** workflow for the Android app in
`packages/oshal-firetv/`. It ran only when that package or its former workflow path changed, so it
stayed dark for the TypeScript/JS work that dominated day-to-day pushes.

Single job, `android-unit` on `ubuntu-latest`: checkout → Temurin JDK 17 → Android SDK
(`android-actions/setup-android`) → Gradle (`gradle/actions/setup-gradle`) → **Robolectric unit
tests** via `gradle :app:testDebugUnitTest` in `packages/oshal-firetv`. These run on the **JVM — no
device or emulator** — so they're fast and don't need KVM. The HTML test report
(`app/build/reports/tests/`) is uploaded as the `firetv-unit-test-report` artifact (`if: always()`,
7-day retention) so you can read failures without re-running.

This is a unit gate only; it does not build a signed APK, run instrumented/espresso tests, or
publish. Reproduce locally from `packages/oshal-firetv/` with
`gradle :app:testDebugUnitTest --no-daemon --console=plain` (JDK 17).

## <a id="openswarm-forward-sync"></a>The openswarm forward-sync

The private repo keeps full history; **openswarm** starts from a zero-history, secret-gated
baseline and only ever advances via gated sync PRs. Run from the private repo:

```bash
bash scripts/release/openswarm-sync.sh          # tsc + unit + secret gates → sync branch → PR
```

It gates the tree (`tsc`, unit suite), builds the sanitized snapshot (regex + gitleaks gates — a
leaky commit cannot pass), pushes a `sync/<date>-<sha>` branch to openswarm, and opens a PR.
**Merging that PR is the human approval step**; nothing pushes to openswarm `main` directly.
Full context: `docs/release/public-release-checklist.md` §2b. Auth uses `gh`
(`C:\Program Files\GitHub CLI\gh.exe`); the scripts mint a token from the stored git credential —
no `gh auth login` needed.

## Gotchas / troubleshooting

### <a id="gotcha-cancel-in-progress-hides-the-e2e-result"></a>cancel-in-progress hides the e2e result
`concurrency: cancel-in-progress: true` cancels the running CI when a new push lands. The e2e job
takes ~15 min; when agents push to `main` every few minutes, the e2e run is cancelled before it
finishes and you never see its result (a completed-then-`cancelled` run is *not* a failure —
it just got superseded). **Verify the e2e locally** (recipe above), or push during a quiet window,
or temporarily relax `cancel-in-progress` for a definitive run.

### CI green locally but red in CI (or vice-versa)
Almost always an install/environment divergence. Real cases from 2026-07-05/06:
- **js-yaml** floated `^5.0.0` (ESM-only, no CommonJS default); local `node_modules` had the
  working 4.1.1 so it passed locally, but `npm ci` from the lock installed 5.0.0 and broke every
  `import yaml from 'js-yaml'` in CI. Fix: pinned exact `4.1.1`. Lesson: when CI-only breakage hits
  yaml/module loading, check for a lockfile major that dropped CJS.
- **Dockerfile `COPY vite.config.js`** — the file is an untracked local artifact; a clean CI
  checkout lacks it and the build failed. Fix: `COPY vite.config.*`.
- **dev-console sandbox specs** — `SandboxedAgentRunner.dockerAvailable()` is true on CI, but CI's
  userns-remapped Docker can't write the `mkdtemp` (mode-0700) `/work` bind mount, so the isolation
  self-test fails. They now gate on `sandboxUsable()` (a real write-to-`/work` probe) and skip
  where the sandbox can't run. Making the sandbox writable under userns-remap is a BACKLOG item.

### Misplaced test types
`tests/unit/**` is vitest (globals: `describe`/`it`). `tests/*.spec.ts` is Playwright. A vitest-style
spec in the Playwright dir throws `describe is not defined` and aborts the e2e run; a Playwright spec
under `tests/unit` breaks the unit run. Keep them in the right tree.

### Secret Scan flags an example credential
gitleaks matches credential *shapes*, including dummies like `curl -u admin:admin`. Either rewrite
to an env-var form (`-u "$VAR"`) or add the path to the `.gitleaks.toml` allowlist. `docs/archive/`
is dropped from the public baseline but still scanned in the working tree.

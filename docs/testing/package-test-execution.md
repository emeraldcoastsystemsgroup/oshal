# Installed package test execution

Open `/api/test-lab/app`, select an installed application, and use **Run** on a
runnable package suite. **Cancel** stops the disposable execution. Recent runs
survive page reloads and controller restarts; open a result to see its assertion
output, package version, source revision and runner image. A changed installation
marks earlier evidence stale. A stored pass describes the source that ran.

The first supported recipe is package-scoped `node-test` at unit or integration
level, with `none` or `fixture-write` effects and no live isolation. Supported
prerequisites are `runner:node-test` and `fixture:core-checkout`. The latter exposes
the trusted core image's packaged scripts/dependencies at `/app`, not a developer
checkout. Database, sibling-package, browser, device, AI and outward-action
prerequisites remain pending until their runner fixtures are provided.

Registration on install never executes package code. Starting a suite requires a
current verified swarm administrator who can discover that application. The
controller rechecks the exact issuer and subject, active account, application
access and current registration before, during and after execution. History reads
and cancellation use the same exact owner and current application visibility.
Swarm administrator status does not grant access to business records.

## Execution and evidence boundaries

- Only registered file lists and resource limits are accepted. The HTTP request
  selects a case and its revisions; it cannot supply a shell command or image.
- A bounded source snapshot includes package code, tests, migrations, UI,
  canonical `src-routes/` sources, `tools/` surfaces and
  root metadata. Runtime data, uploads, output, databases, credentials, dotfiles,
  dependencies and links are excluded. Installer provenance contributes to the
  revision but is not sent to the test process. Source and helper changes invalidate
  a selection. Staging does not mount the installed package.
- Docker resolves an already installed core image to its immutable ID without
  pulling. A disposable container runs as a non-root user, without networking or
  host mounts, with a read-only root and bounded temporary storage, CPU, memory,
  process count, time and output. Image environment values are cleared before
  startup; deployment credentials are never forwarded.
- One package execution is admitted globally. Repeated requests with the same
  request UUID return the original receipt; other concurrent starts report busy.
  Timeout, cancellation and output overflow cannot become a pass. Cleanup is
  verified. Interrupted work is retained as interrupted, with no invented result.
- PostgreSQL stores versioned run receipts under an operator-only control-plane
  table, with additional exact-principal predicates in each user operation.
  Uninstall removes executors and current visibility, while preserving history.

API: `POST /api/test-lab/runs` accepts
`{caseId, revision, executionRevision, requestId}`. `GET /runs` lists recent owned
metadata, `GET /runs/:id` reads evidence and `POST /runs/:id/cancel` requests
cancellation. Mutations require the normal authenticated session and the Lab's
same-origin request marker. The existing smoke `/run` endpoint stays separate.

Read-only service smokes started from a verified administrator's browser use that
current session as well as the service credential, so enforced application
permissions still identify and authorize the real caller. The session stays in a
request-bound controller callback, restricted to the selected loopback GET/HEAD
endpoint with redirects refused. It is never stored in a catalog, run receipt,
schedule or Node sandbox. PAT, public, user-required and mutating smokes retain
their existing authentication requirements. A missing application role still
denies the probe; swarm administration does not substitute for that role.

If Docker or the local image is unavailable, execution remains pending with a
reason. A missing runner is not a test failure or a passing installation check.

## Registered regression coverage

Installation verification uses these same registrations. `POST
/api/install-verification/apps` accepts only installed package names and reports
the captured version, source, case revision, registration coverage and stable Lab
link for every selected case. Group reports retain member-owned IDs and deduplicate
shared checks. Legacy packages show `smoke-only` or `not-declared` coverage.

Only eligible read-only installation smokes execute. User-required, AI, mutating
or unavailable checks remain pending with a reason. Registered Node, browser and
other suites are listed as `not-run`; registration and installation verification
do not start them. A failing safe smoke makes the report failed (HTTP 503).
Missing smoke coverage or pending prerequisites cannot make `verified` true.
An app or group replacement during checking invalidates the verification.

JSON reports retain legacy `success` (no failed apps) and add `verified` and
`verificationStatus`. Consumers must use those explicit verification fields:
`success: true` can still mean pending. The shipped `oshal-verify.sh` requests the
server's plain-text format, prints case counts/outcomes/links, and distinguishes
`RESULT: PASS`, `RESULT: PENDING` and `RESULT: FAIL` without requiring Node or jq
on the installer host. Pending preserves the installer's zero exit status while
stating that verification is incomplete; failed or unsupported reports exit 1.
CLI and server must support the same report format. Opening a case link focuses
the current caller-visible Lab card after catalog loading and never starts it.

Run `npm run test:installation-verification` for the real HTTP/CLI report tests,
Chromium link tests and existing smoke/live/installer contract regressions. This
focused command uses synthetic identities, local HTTP and temporary package files;
it does not need Docker, a provider, deployed credentials or business data.

The **Installed application test registration** Lab card links the source-growth,
sandbox, catalog execution, durable history and actual Chromium page suites.
They are included in `npm run test:platform-readiness`. Docker and a locally built
core image are needed for the sandbox cases; PostgreSQL fixtures use disposable
containers. Set `OSHAL_TEST_RUNNER_IMAGE` to an existing core image if its tag differs
from `oshal-bot:latest`. No GitHub Actions or production business data are needed.
The registered installed-application suite also exercises service-smoke sessions
through real local HTTP and application policy, including revoked rights, issuer
collisions, redirect refusal and credential isolation.

## Run a package batch

In **Package runs**, select one application and choose **Run package suites**.
The shortcut shows the current selection and ready/pending counts. It uses the
existing disabled local schedule and **Run now** batch service. It never enables
a recurring schedule or silently changes an existing selector's levels/cadence.
All visible applications remains a history filter; select one package before
starting this shortcut.

Supported installed Node suites run sequentially with a durable batch receipt
and individual results. Browser, framework and other unavailable recipes remain
listed with their prerequisites. A completed batch can contain failures or
pending work; it is not an assertion that all package tests passed.

The **Package runs** history follows the admitted batch on its own. While a
child run is active it refreshes every 1.5 s; between children, when no run is
active yet, it checks the batch through `GET /schedules/:id/history` every 2 s
and keeps going until the batch is terminal, then reads the runs once more and
stops. A transient failure of the runs read while a batch is followed retries
three times, bounded; a 4xx or exhausted retries release the follow and say so
beside the batch status. **Refresh history** remains available but is not
needed to see a batch finish. Clicking **History** on a running batch in the
schedule section starts the same follow. This is proven in real Chromium by
`tests/unit/test-lab-schedule-browser.spec.ts` (a three-child batch with real
gaps, one injected 503, two selection changes, a stopped poll) and on the real
server with the real Create package by
`tests/unit/test-lab-installed-package-batch-follow.spec.ts`.

That second proof is the local-host stand-in for native acceptance, because
the live api admits only a signed-in session to the Lab data routes. It boots
`src/app/server.ts` in `LOCAL_AUTH` mode with a seeded first administrator and
a real cookie session, migrates a disposable pgvector Postgres with the
server's own migration service before boot, exports Create from the store
checkout through git alone, activates it through `POST /api/swarm/apps/load`,
grants the operator through the authorization preview/apply flow, and runs the
five Node suites in the same disposable Docker runners the live Lab uses. It
needs Docker, the `oshal-local-api` container running (its image is what the
runners use) and the store checkout beside the core checkout or named by
`OSHAL_STORE_REPO`; it fails loudly when any of those is missing. Run it alone
with:

```sh
OSHAL_LAB_FOLLOW_REPORT_DIR=temp/lab-follow npx vitest run tests/unit/test-lab-installed-package-batch-follow.spec.ts
```

The report directory receives the page samples, a screenshot, the batch record
and the server log. The mock identity cannot drive this proof: under
`MOCK_OIDC` no login provider is configured, so a server-owned batch cannot
re-derive its operator and cancels itself.

## Batch local Node and UX suites

From the core checkout, preview the package's registered recipes:

```sh
npm run test:package -- --package ../oshal-applications/create --level browser
```

Execute them with one command and retain a single JSON report:

```sh
npm run test:package -- --package ../oshal-applications/create --level browser --run --report temp/create-ux-results.json
```

Repeat `--package` for several local packages, or use repeated `--case` selectors
for a changed integration. Omit `--level browser` to include the other declared
levels. The command reuses the same package catalog validator as installation;
it accepts no shell-command fields and does not invent a test list from filenames.
No `--run` means plan only. Choose a new report filename for each execution.

The supported host adapters are Node test recipes, TypeScript Node recipes using
the installed `tsx`, and registered browser recipes built on Node's test harness.
Chromium suites run serially. Their existing fixtures own the actual pages,
synthetic data and cleanup. The command never downloads dependencies or browsers.
Vitest/Playwright configurations needing another adapter, external services and
missing declared prerequisites remain **pending**, rather than being counted as
readiness passes. Existing core commands such as `test:workspace-theme` continue
to run their configured Vitest browser suites in bulk.

Exit 0 means every selected executed recipe passed, exit 1 reports a failure,
and exit 2 reports remaining prerequisites. Reports include each recipe's
version/revision, result, TAP counts and transcript. These are local checkout
results; they do not replace installed application acceptance. The host runner's
Cancellation and timeouts stop later recipes and bound termination of the owned
child process tree. The report retains failed cleanup and deferred work. Its
own regression suite is `npm run test:package-runner`, registered on the
**Installed application test registration** Lab card.

## Local recurring runs

Use **Scheduled package checks** in the same Lab page. Choose all visible installed
applications or one application, unit/integration levels, and hourly/daily/weekly
cadence. Saving creates a disabled draft. **Run now** tests that selection once;
**Enable** schedules future cycles. **Disable** invalidates current batch authority
and prevents subsequent scheduled work. Enabling starts the first interval from
the current time; a restart runs at most one missed occurrence, without replaying
every missed interval. The controller must be running to execute due work.

Refreshing the catalog during a schedule change waits for that change before
reloading the current list. Older responses cannot erase a newly saved schedule.
Closing the schedule section clears its displayed data; reopening refreshes the
current account and permissions before restoring controls.

Each cycle discovers current registrations again, so new eligible installed cases
are included without maintaining a list. It runs at most 100 suites sequentially
through the same durable Run service. Batch history distinguishes assertion
results, unavailable prerequisites, deferred work and inventory drift. A completed
batch can contain failed suites; completion is not a passing test result.
Canonical `tests/**/*.test.*` and `tests/**/*.spec.*` files missing from package
runner declarations are reported as registration drift. Helper files are excluded
from that comparison. Inventory read errors remain explicit.

A saved schedule retains the exact issuer and subject, selector and cadence. It
stores no session cookie, token, service secret or directory group claims. The
controller refreshes the observed account and current administrator/application
permissions on every cycle and throughout execution. A revoked or disabled owner
cannot continue scheduled work. Each batch links its versioned runs; private
metadata is withheld if application access changes, including idempotent retries.

The local scheduler has its own bounded batch lease and shares the existing global
package runner capacity. Crashed batches become interrupted. An orphaned package
container must be positively removed before another package execution is admitted.
This scheduler does not dispatch the separate golden-ticket workflow.

API: `GET/POST /api/test-lab/schedules`, `PATCH /schedules/:id` for revision-checked
enablement, `POST /schedules/:id/run-now` with `{revision, requestId}`, and
`GET /schedules/:id/history`. New suites and the real browser flow are registered
on the same **Installed application test registration** card and local command.

See [local deployment acceptance](../releases/test-lab-execution-2026-09-11.md) for
the serving revision, regression results and verified browser/schedule behavior.

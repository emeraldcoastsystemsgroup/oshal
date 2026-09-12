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
- A bounded source snapshot includes package code, tests, migrations, UI and
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

If Docker or the local image is unavailable, execution remains pending with a
reason. A missing runner is not a test failure or a passing installation check.

## Registered regression coverage

The **Installed application test registration** Lab card links the source-growth,
sandbox, catalog execution, durable history and actual Chromium page suites.
They are included in `npm run test:platform-readiness`. Docker and a locally built
core image are needed for the sandbox cases; PostgreSQL fixtures use disposable
containers. Set `OSHAL_TEST_RUNNER_IMAGE` to an existing core image if its tag differs
from `oshal-bot:latest`. No GitHub Actions or production business data are needed.

## Local recurring runs

Use **Local schedules** in the same Lab page. Choose all visible installed
applications or one application, unit/integration levels, and hourly/daily/weekly
cadence. Saving creates a disabled draft. **Run now** tests that selection once;
**Enable** schedules future cycles. **Disable** invalidates current batch authority
and prevents subsequent scheduled work. Enabling starts the first interval from
the current time; a restart runs at most one missed occurrence, without replaying
every missed interval. The controller must be running to execute due work.

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

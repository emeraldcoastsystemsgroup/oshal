# Installed Test Lab execution and local schedules

Accepted locally on 2026-09-11 (America/Chicago). The serving core is
`108919e6391c8c9ea1227ed721a3a473cac8fa06`, including the isolated-runner
checkpoint `fcafb865`. This is local deployment acceptance; the branch still
requires independent PR approval before merge.

## Delivered behavior

AI Test Lab runs explicitly registered, supported offline package Node suites in
disposable containers. Run, Cancel and persistent history use current account and
application access. Evidence records the package, source revision and immutable
runner image. A failed or interrupted run cannot become a pass, and uncertain
container cleanup retains execution capacity until verified recovery.

Local hourly, daily or weekly schedules select the current installed catalog.
Drafts begin disabled. Each cycle separates actual test results, unavailable
prerequisites, deferred cases and missing registrations. This implements TLAB-09
for the supported execution slice without GitHub Actions. See the
[execution guide](../testing/package-test-execution.md).

## Verification

- `npm run test:platform-readiness`: **230 tests passed across 22 files**, zero
  skipped. New suites are registered on the existing Installed application test
  registration card and in this command.
- Actual Chromium, Docker and PostgreSQL fixtures exercised an assertion failure,
  corrected source and retained evidence for both versions. Temporary history
  errors retry within a fixed bound without dispatching another execution.
- Docker checks covered credential and runtime-data exclusion, limits, timeout,
  cancellation, controller death, stopped-watchdog recovery and confirmed cleanup.
  PostgreSQL checks covered exact issuer ownership, forced row-level security,
  leases, revision conflicts and schedule replay.
- Source and exported committed-source typechecks, scoped lint, function limits,
  publication gates, image build and kernel-skill image probe passed.
- The API and all 34 workers were refreshed to the same immutable image:
  `sha256:6c48dcc181388b6a360bf5c8142ce08c5c66510def26b53144f7c36e76fe8b5e`.
  All 35 application services are healthy; the deployment parity check passed.
- A genuine signed-in browser used the deployed Lab to run an installed business
  application suite: **3 assertions passed**, cleanup verified. A separate
  catalog-selected batch ran the same eligible suite successfully. Reload retained
  both results and the enabled schedule.
- A daily, unit-only schedule for all currently visible applications was enabled.
  Its first one-off batch selected one eligible suite and passed it, deferred none,
  and reported 48 cases with unavailable runners or fixtures. Inventory detected
  251 unregistered test files across 31 applications, with zero inventory errors.
  These are pending adoption gaps, not passing tests. The next scheduled interval
  is 2026-09-12 at 19:29 America/Chicago while the controller is running; a future
  unattended interval has not yet been observed.
- Read-only preservation checks confirmed unchanged infrastructure containers,
  configuration hashes, installed package metadata and all 70 role assignments.
  Existing business records and documents passed all 37 preservation checks.

The first browser attempt during worker recreation received a request timeout and
was not counted as acceptance. The successful browser runs were performed after
the stack became healthy. Unsupported database, browser and external runners, and
the remaining package registrations, stay open in the
[registration backlog](../backlog/app-test-lab-registration.md).

Raw local evidence is retained in ignored `temp/test-lab-platform-acceptance.log`,
`temp/test-lab-native-acceptance.json`, `temp/test-lab-preservation-proof.json` and
`temp/test-lab-deploy-parity.log`. Private application details and account
identifiers remain outside the public repository.

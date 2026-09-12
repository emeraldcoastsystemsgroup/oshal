# Local connection budget and application backlog rollout

Accepted core source: `8d1abae445097b11b1c5197bdff1212eb176cbf7`.
Immutable image:
`sha256:10933116dc2754b3abb38f6e1482280cef58ae5f4e95bed3caad56600573bc01`.
This follows the [Test Lab adoption cohort](test-lab-adoption-2026-09-11.md),
whose results retain their earlier source and image pins.

## Connection budget

Concurrent installed-test history reads exposed PostgreSQL role-capacity failures.
The API could open up to 104 connections across its main, four optional and RAG
pools, while the application role permits 24. Some evidence reads consequently
returned temporary 503 or 404 responses; stored passing results remained intact.

Local Compose now uses the existing managed-profile defaults: main 8, each
optional pool 2, and RAG 2, for an aggregate ceiling of 18. Explicit deployment
overrides remain supported. Worker settings, database role permissions and the
role limit are unchanged. These defaults are deployment configuration; they do
not introduce a new authorization rule.

Two actual Compose regressions failed before the fix on missing values and
ignored overrides. After the fix, all six pool-budget checks and four Test Lab
registration checks passed. The existing managed-profile Compose check passed
separately. The suite is registered on the installed-application Test Lab card
and included in the local platform-readiness command. Independent review,
scoped lint, publication and exported-source typechecks passed.

## Public application backlog

Sports Edge 0.7.1 completes its coach-source backlog item. It reads current
coaches from ESPN's public roster envelope, verifies team identity, refuses
ambiguous staff, and uses the existing World cooldown and subject budget. It
preserves followed-team ownership and uses no private Fantasy credentials.
Eleven sealed suites passed 165 cases with verified cleanup; all eleven suites
and the preserved readiness smoke register during installation.

Public package source: `7459c157774e98167737d28f6358e0f6f7a05441`.
The standard installer produced 66 exact source files plus its provenance stamp.
On the image above, the authenticated installed Lab passed the new coach suite
with **11/11 tests**, HTTP 200 result retrieval and verified cleanup. The package
readiness GET smoke also passed. The remaining ten suites' evidence comes from
the sealed source runs; this report does not claim eleven native suite runs.
Provider-contract evidence and remaining work are in the package README and
backlog. Private application acceptance stays in its owning repository.

## Platform and deployment acceptance

The final unchanged `npm run test:platform-readiness` passed **281/281 tests
across 25 files**, with zero skips, in 229.77 seconds against the image above.
An earlier run during rollout passed 280 cases and failed one schedule assertion
when the batch finished cancelled instead of completed. That original result is
retained. The exact isolated case passed afterward, followed by the full passing
run; neither its assertions nor its timeouts changed. The cancellation's cause
was not established by this nonreproduction.

The standard preview deployment reported **35/35 healthy app services** on the
exact image and clean parity. Read-only preservation verified **14 infrastructure
identities**, all existing authorization assignments and business data, and the
inventories of **55 unrelated packages** unchanged. The three intended package
updates matched their staged bytes. The API retained **473 non-build environment
values** and all **39 mounts**; only the three pool settings and the verified
build SHA changed. The mounted Docker socket's engine identity matched the host.

After application startup settled, the authenticated browser also read existing
durable test receipts **18/18 times at concurrency six**, all HTTP 200 with their
original passing state and cleanup evidence. This bounded read check dispatched
no tests and is not a sustained-load benchmark.

Evidence: `temp/local-pool-budget-before.log`,
`temp/local-pool-budget-after.log`,
`temp/package-backlog-platform-during-rollout.log`,
`temp/schedule-assertion-diagnostic.json`,
`temp/package-backlog-platform-steady.log`,
`temp/package-backlog-native-initial.json`,
`temp/local-pool-budget-native-reads-final.json`,
`temp/package-backlog-preservation-after-final.json`, and
`temp/package-backlog-parity-final.log`. Counts above are filtered to public
acceptance; private records and source details are not included here.

Preview acceptance does not merge the branch or replace independent PR review.
No GitHub Actions were added or invoked.

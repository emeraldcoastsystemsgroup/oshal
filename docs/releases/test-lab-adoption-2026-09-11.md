# Public package Test Lab adoption

Accepted 2026-09-11 (America/Chicago). Serving core:
`7a22a13067f464b10cf0d0c58e28049aba76ddd8`. Immutable image:
`sha256:2142c427653fbf70afd651d8e6e06b4f13898863a2e8bc05247fa224c9e6ab56`.
The complete platform regression passed **275/275 tests across 24 files** in
243.06 seconds. Publication, exported committed-source typechecks and scoped lint
passed. This report describes the accepted adoption cohort; later package or
configuration changes require separate receipts.

## Delivered scope

Ten public packages install versioned catalogs referencing every shipped suite.
Public source is `ec1482a37848cbe4981af206e89fe9ff8d3563f9`.
The 49 suite-file registrations and ten preserved readiness smokes make **59
catalog cases**. Registration itself performs no suite execution or business action.

| Package | Version | Registered suite files | Isolated suites passed | Pending |
|---|---|---:|---:|---:|
| create | 1.2.1 | 3 | 3 | 0 |
| presentations | 2.11.2 | 3 | 3 | 0 |
| bake-off | 1.1.1 | 1 | 1 | 0 |
| identity | 1.1.1 | 2 | 1 | 1 |
| email-summarizer | 1.2.1 | 1 | 1 | 0 |
| finance | 1.2.1 | 1 | 1 | 0 |
| world | 1.2.1 | 3 | 3 | 0 |
| marketing-engine | 0.4.2 | 4 | 3 | 1 |
| payroll | 2.3.1 | 13 | 13 | 0 |
| venture-plan | 1.4.1 | 18 | 16 | 2 |

The sealed source snapshot includes canonical `src-routes/` and code-only
`tools/` needed by compiled-module tests. Runtime data, generated output, uploads,
credentials, links and dependencies remain excluded. Packages cannot select a
shell command, runner image or host mount.

Four cases need unavailable fixtures: Identity Home needs its PostgreSQL, browser
and core harness; Marketing persona parity needs persona metadata; Venture Plan
needs its dataset and worked-example fixtures. Their prerequisite reasons remain
visible. Passing supported suites does not certify those fixtures or live providers.

## Source and deployed acceptance

Actual catalog-selected Docker execution passed **45 suites / 572 Node test
cases**, with zero failures or skipped tests and verified cleanup for every run.
These are framework test-case counts, not individual assertion-call counts.
The canonical public export passed **15/15 store checks**; all **54 package
audit/catalog records** validated. Audit approval remains a separate status.

Financial and domain suites exercise integer payroll arithmetic, tax/calendar
vectors, ACH/report layout, consent and spending gates, venture cash reconciliation,
evidence confidence and owner-scoped contracts. Synthetic ports remain labelled
unit coverage; actual loopback HTTP remains integration. No payments, filings,
messages or provider jobs were submitted.

On 2026-09-11 (America/Chicago), the authenticated installed Lab completed
**44 public unit suites / 568 Node test cases**, all passed. Create's separate
loopback HTTP integration run passed **4/4**, making **45 native public suites /
572 Node test cases**. Every final durable result read returned HTTP 200, and every
receipt records the exact image above and verified container cleanup. The public
cohort had zero registration drift. All **59 catalog cases** matched their installed
versions and source pins, and all **ten metadata readiness GET smokes passed**.

The existing daily unit schedule remained enabled and unchanged. This acceptance
records an explicit one-off occurrence through that schedule; it does not claim a
future unattended interval. Integration requires an integration-level selection.
Four fixture-dependent cases remain registered and unavailable; they did not run.

Transient result-read failures occurred during the batch. Bounded retries of
reads only (at most three attempts, 1.5 seconds apart) recovered every receipt;
tests were not dispatched again. The original failures remain in the progress
evidence. Local database pool configuration is a separate operational follow-up,
not a claim that the transient failures never occurred.

## Defects reproduced and corrected

An authority-revocation regression exposed a return-boundary race that could mark
a cancelled run pending before the watchdog observed refusal. Deterministic real
sandbox tests reproduced it; the correction retains cancellation and cleanup
evidence while withholding output. Request-bound readiness checks were also
corrected and verified by the ten successful native probes above.

A real browser regression reproduced a saved schedule disappearing when a
catalog refresh completed during its creation: the server returned HTTP 201 and
stored exactly one row while the page displayed none. The page now coalesces
refreshes after mutations, rejects stale reads, and retracts evidence on close.
Reopening refreshes current identity and access. All seven schedule-browser cases
pass, including three new refresh and identity cases, with original timeouts and
mutation assertions retained.

The final full regression includes these corrections. The focused verification
also passed 48 authorization/readiness checks and seven schedule-browser checks.

## Preservation and remaining work

Read-only comparison with the original pre-adoption baseline confirmed **35/35
healthy app services** on the exact image, **14 infrastructure identities** and
**11 configuration hashes** unchanged, and all existing authorization assignments
and business data preserved. All **367 public staged files**, including the ten
installation stamps, matched installed bytes. Unrelated package inventories were
unchanged. Independent deployment parity exited successfully. These checks made
no account, grant or business-data changes.

Continue TLAB-07 for remaining public packages and TLAB-08 in the owning private
repository. Add confined database, browser and reference-data recipes before
advertising their cases as runnable. TLAB-03 still tracks installation-report
linkage and mandatory smoke disposition. Supported Node execution, durable
versioned history and local scheduling already exist.

See the [registration backlog](../backlog/app-test-lab-registration.md) and
[execution guide](../testing/package-test-execution.md). Local source evidence is
`temp/public-seven.json`, `temp/public-business.json` and
`temp/public-business-summary.json`. Final receipts are
`temp/test-lab-adoption-native-unit-evidence-final.json`,
`temp/test-lab-adoption-native-create-final.json`,
`temp/test-lab-adoption-native-final.json`, and
`temp/test-lab-adoption-after-final.json`; public counts above are filtered to
this cohort. Full regression: `temp/test-lab-adoption-platform-release.log`.
Private evidence remains local and is excluded from this public report.

# Application test cases installed into AI Test Lab — backlog

Status: **versioned catalogs and installation lifecycle implemented at core `15dcbbd7`;
Hello and Portrait pilots versioned at store `dc4c0dc`, and Kalshi at `571838a`**.
The execution slice adds isolated package Node suites, durable versioned history and local
catalog-selected schedules, deployed and accepted at core `108919e6` on 2026-09-11.
Ten more public packages have complete catalogs and deployed isolated execution
acceptance at core `7a22a13067f464b10cf0d0c58e28049aba76ddd8`: 45 public suites / 572
Node test cases and all ten readiness smokes passed. Public source is
`ec1482a37848cbe4981af206e89fe9ff8d3563f9`. Additional runner fixtures and remaining
package adoption stay open. Requested on 2026-09-10.

The [enterprise authorization workstream](enterprise-authorization.md) registers its implemented
policy, HTTP/browser, identity, tool, bootstrap and worker-boundary suites; broader directory,
record-isolation and delegated-AI cases remain planned. Register
each suite with its implementation; multi-user and privilege-changing cases require disposable
fixtures and must never run against production merely because a package was installed.

## Outcome

Installing an application installs its test-case catalog into the existing AI Test Lab. No manual core
scenario edit is required per package. The Lab shows the owning app, installed version, test level,
prerequisites and results. Update/reload replaces that app's cases; disable/uninstall removes runnable
registrations while retaining versioned historical evidence. Every application with existing tests is
tracked below, including packages that currently expose only installation smokes.

Registration is part of installation. Executing every test is not: run only explicitly designated safe
installation checks by default. Browser, model, device, connected-account and outward-action cases
remain registered and visibly pending when their runner, environment or approval is unavailable.

## Verified starting point

Inventory taken from tracked manifests and test paths at public store commit
`eaa6106226bd97d3bd78bbee8699421cf795fb06`. The checkout was read, not tested.

- 53 public package manifests; 51 declare installation `smoke:` checks.
- 34 packages have recognizable local test files/runners; 280 matching case/suite files.
- Packages without a matching local file are **coverage-location review**, not "untested"; many already
  have a smoke and may have shared/core or external tests. Group packages inherit member coverage.
- Private packages are included in a separate private-repository inventory; names and case paths stay there.
- Existing smoke definitions, validation and execution live in `SwarmAppSmokeDeclaration`,
  `scripts/oshal-app-smoke.js`, `app-smoke-verifier.ts`, and `install-verification-routes.ts`.
  Reuse these checks and assertions rather than creating a competing smoke runner.
- The interactive Lab combines core-owned `SCENARIOS` with active package smoke and versioned
  suite registrations. Supported package Node suites execute through the sealed runner; other suite references remain
  pending until their runner and fixtures are available.

### First implementation slice

The initial smoke slice introduced a service-owned catalog, activation/reload/update/deactivation/uninstall
reconciliation, app/version/revision metadata, caller-filtered discovery, and execution through the
existing verifier. Safe GET/HEAD probes can run with their declared authority; unavailable credentials,
AI and mutating runners remain visibly pending. The local regression command is
`npm run test:platform-readiness`, including a real Portrait Studio manifest against fixture HTTP.

The subsequent catalog slice implemented the [versioned contract](../testing/package-test-catalog.md), shared
CLI/runtime validation, package/source/content revisions, group member aggregation and lifecycle
compensation. At that catalog checkpoint, three suites passed 19 tests; later regression totals are recorded below.
Local source acceptance for TLAB-01/02 is complete. Later accepted slices, described below,
implemented supported Node execution (TLAB-04), durable versioned history (TLAB-05) and
local catalog-selected scheduling/drift detection (TLAB-09). TLAB-03 installation-report
linkage and broader runner fixtures remain separate open work.

Historical TLAB-06 pilot proof at core `15dcbbd7` / store `dc4c0dc` covered Hello 1.2.0 and Portrait 1.12.0: both existing
smokes pass through the real core verifier; seven local/core suite references remain pending in the
browser. Hello's two HTTP tests, Portrait's existing 324 checks/groups and 23 camera checks, and the
four shared picker tests pass locally. All seven package JavaScript test files are referenced.
At that historical checkpoint, installed deployment proof still awaited core/package promotion;
this sentence does not describe the current deployed runner or pilot versions.

Kalshi 1.5.0 adds its existing smoke and all four package suites to a five-case catalog. Its new
briefing delivery regression exercises the compiled public scan path with isolated provider and
task-store ports; 46 Node cases and five existing Chromium cases pass. Canonical source compilation
and manifest validation pass. No live scan, trade or notification was executed. One private
package also registers its new specialist suite; its scope and evidence remain in the private inventory.

## Work order and acceptance criteria

### Package execution and evidence slice

TLAB-04 now supports explicitly registered offline package Node suites through a
disposable Docker runner. Real fixture tests cover failed assertions, source and
helper changes, credential/data exclusion, revocation, timeout and cancellation.
TLAB-05 adds exact-owner PostgreSQL history, request retry identity, global run
capacity and source-version staleness with browser Run/Cancel controls. Current
account and application access are rechecked for execution and history reads.
The [execution guide](../testing/package-test-execution.md) describes the supported
recipe and prerequisites. Broader database, browser and externally connected
runners remain pending. Installing a catalog alone does not execute these suites.

TLAB-09 adds exact-owner local recurring selection from the installed catalog,
using the same execution authority and evidence, plus shipped-test drift reports.
Schedules begin disabled; an operator can run a draft once and then enable a fixed
hourly/daily/weekly cadence. New eligible cases are discovered every cycle.
Unavailable prerequisites, failed assertions, stale run evidence and unregistered
test files remain distinct. This work does not depend on GitHub Actions.

[Local deployment acceptance](../releases/test-lab-execution-2026-09-11.md) records
230 passing regression tests, a genuine browser run, an enabled daily unit schedule,
and unchanged deployed records and roles. The first installed batch passed its one
eligible suite; 48 suites remained pending runner/fixture support. That initial inventory
reported 251 unregistered test files across 31 apps. TLAB-09's supported slice
is complete; broader runner support and package adoption remain open.

### TLAB-07 public adoption cohort - deployed acceptance

Public source `ec1482a37848cbe4981af206e89fe9ff8d3563f9` registers all 49 shipped suite files
across ten packages, plus their ten preserved smoke identities: **59 catalog cases**.
Actual catalog-selected isolated execution passed **45 suites / 572 Node test cases**,
zero failed or skipped, with every container cleanup verified and no registration
drift in these ten packages. Existing test assertions and application behavior are
unchanged. Core snapshots now include the required canonical `src-routes/` and
code-only `tools/`; runtime data and credentials remain excluded.

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

Four cases remain explicitly pending: Identity Home's PostgreSQL/browser/core
harness, Marketing persona metadata, and Venture Plan's dataset and example
fixtures. Their catalog registration is complete; runner support is not. In-memory
database/router ports are unit tests, not live database or browser acceptance.

On 2026-09-11 (America/Chicago), the authenticated installed Lab completed
**44 public unit suites / 568 Node test cases**, all passed. Create's separate
loopback HTTP integration run passed **4/4**, making **45 native public suites /
572 Node test cases**. Every final durable result read returned HTTP 200, and every
receipt records the cohort image and verified container cleanup. The public
cohort had zero registration drift. All **59 catalog cases** matched their installed
versions and source pins, and all **ten metadata readiness GET smokes passed**.

The existing daily unit schedule remained enabled and unchanged. This acceptance
records an explicit one-off occurrence through that schedule; it does not claim a
future unattended interval. Integration requires an integration-level selection.
Four fixture-dependent cases remain registered and unavailable; they did not run.

The cohort's serving core is `7a22a13067f464b10cf0d0c58e28049aba76ddd8`, image
`sha256:2142c427653fbf70afd651d8e6e06b4f13898863a2e8bc05247fa224c9e6ab56`; the complete regression
passed **275/275 tests across 24 files** in 243.06 seconds. Publication, exported
source typechecks and scoped lint passed. The
[dated acceptance](../releases/test-lab-adoption-2026-09-11.md) records exact source
and image receipts and the successful original-baseline preservation checks.

A real browser regression reproduced a saved schedule disappearing when a
catalog refresh completed during its creation: the server returned HTTP 201 and
stored exactly one row while the page displayed none. The page now coalesces
refreshes after mutations, rejects stale reads, and retracts evidence on close.
Reopening refreshes current identity and access. All seven schedule-browser cases
pass, including three new refresh and identity cases, with original timeouts and
mutation assertions retained.

Transient result-read failures occurred during the batch. Bounded retries of
reads only (at most three attempts, 1.5 seconds apart) recovered every receipt;
tests were not dispatched again. The original failures remain in the progress
evidence. Local database pool configuration is a separate operational follow-up,
not a claim that the transient failures never occurred.

The earlier 251-file installation drift snapshot is historical. The completed
final selection reported 203 unregistered files across 21 apps, 41 unavailable
entries, zero inventory errors and no deferred execution. These installation-wide
totals include apps outside this public cohort; all ten adopted public packages
have zero missing registrations. They do not imply unsupported fixtures ran.

Remaining priorities are other public package owners, confined database/browser
and reference-data recipes, private adoption in its owning inventory, and TLAB-03
installation-report linkage. The local scheduler already selects eligible new
registrations. Future unattended schedule occurrences require their own receipts.

| ID | Priority / owner | Work | Done when |
|---|---|---|---|
| TLAB-01 | P0 / core contract | Add a versioned, package-local test catalog declaration; normalize existing `smoke:` entries into the same Lab case inventory. Document stable app/case IDs, unit/integration/browser/live levels, suite references, expected outcomes, prerequisites, fixture/cleanup, resource limits and side effects. | CLI validation and runtime loading agree; malformed IDs, duplicate cases, absent files, escaping paths and unsupported schema versions are rejected with the app and field named. Existing valid smoke manifests remain compatible. |
| TLAB-02 | P0 / core loader | Register cases during normal package install/activation; wire every installer path through the same lifecycle, including codeless/remote installs and startup reload. | Installing a fixture app makes its cases appear in `/api/test-lab/catalog` with no core edits; reinstall does not duplicate; upgrade removes renamed/deleted cases; disable/uninstall retracts runnable entries; failed install/activation leaves no orphan entries. Group cases resolve members without duplicate registrations. |
| TLAB-03 | P0 / core verification | Connect the existing smoke verifier and installation result to Lab case IDs; define migration behavior for older packages. | An install report names registered case counts and smoke outcomes; a mandatory safe smoke failure cannot be reported as verified success. Missing model/account/device capability is pending with a reason, never passed. Legacy packages show smoke-only or coverage-not-declared status until migrated. |
| TLAB-04 | P1 / core runners | Associate catalogued local suites with approved unit, HTTP integration and browser runners; retain native package commands where supported. Separate registration from execution authority. | Each supported runner executes a real package fixture and produces results; unavailable dependencies are explicit. No arbitrary browser-submitted shell command is executed. Test writes use disposable data and cleanup; timeout/cancel terminates the run. No automatic email, application submission, trade, payment or device actuation occurs on install. |
| TLAB-05 | P1 / core Lab / evidence | Display package/case grouping, installed version, test level, prerequisites, runnable state and last result. Bind results to package version/content and case revision. | The viewer sees only authorized apps/cases/results; install/upgrade/disable refreshes the catalog; old results are labelled stale after version changes; same case IDs in different apps cannot collide; historical results survive uninstall without retaining executors. Existing pass/degraded/gap/fail presentation remains honest. |
| TLAB-06 | P1 / store pilot | Migrate Portrait Studio first (unit, browser, artifact exchange), then hello-oshal as the authoring template (existing smoke plus a real behavior test). | Fresh install, restart, update and uninstall each prove the lifecycle; picker/browser cases reference the shared core suite where appropriate without copying it into the package. Template docs teach test declarations from the start. |
| TLAB-07 | P1 / each public package owner | Work every unchecked package row and its existing test-file inventory below; reconcile local runners, shared/core coverage and live cases. | Every identified file is catalogued or explicitly recorded as a helper/fixture/obsolete test with a reason; each owning app installs its cases automatically; at least one representative existing suite and its installed safe smoke are run with dated results. A failing suite remains registered and red. |
| TLAB-08 | P1 / private package owners | Apply the same contract to the private inventory, in its owning repository. | Private app installs expose only authorized case metadata/results; all existing private suites and coverage gaps have dispositions; no private test names, fixtures or records are copied into the public catalog/docs. |
| TLAB-09 | P2 / local CI / scheduling | Let local CI and the existing Lab scheduler select installed app test cases by level/prerequisites. Add catalog-versus-package drift checks. | A local scheduled run includes newly installed cases without hand-maintained lists; absent prerequisites, stale results and newly failing cases are distinguishable; missing registration of a shipped test is detected. No GitHub Actions dependency is introduced. |

### Accepted manifest shape

`smoke:` remains the existing installation-probe contract. Declare the capability and catalog:

```yaml
uses: [test-catalog]
testing:
  version: 1
  catalog: tests/test-lab.yaml
```

The [contract reference](../testing/package-test-catalog.md) defines the accepted schema. Each case needs a stable ID,
name/purpose, level, suite paths or existing smoke reference, approved runner, expected assertions,
required accounts/devices/AI, data isolation and cleanup, time budget, and installation/default-run
eligibility. References to shared framework suites need an explicit dependency/version contract;
production installations must not assume a sibling source checkout or developer node_modules exists.

### Required lifecycle regression cases

- [ ] Fresh package install registers its cases and runs only opted-in safe installation smokes.
- [ ] Reinstall/reload is idempotent; restart rebuilds the same active catalog.
- [ ] Upgrade replaces case definitions, drops deleted IDs and labels previous results stale.
- [ ] A failed or rolled-back activation leaves the previous valid catalog or no registration.
- [ ] Disable/uninstall removes executable entries and preserves scoped historical evidence.
- [ ] Invalid/escaping/missing fixture references fail validation; one app cannot overwrite another's case.
- [ ] Cross-user reads/runs and result access are denied; missing prerequisites never turn into pass.
- [ ] Unsupported local/browser/live runner is shown as unavailable; registration itself still has an honest status.
- [ ] Cancellation/timeouts stop execution and cleanup is proven on both success and failure.
- [ ] Group packages aggregate member cases; package-owned and shared framework suites are not duplicated.

## Public package worklist

Rows retain the original inventory counts except the ten-package adoption cohort and Sports Edge follow-up, whose
current file counts and deployed acceptance are recorded below. A checked row means registration and supported deployed acceptance are complete;
explicitly pending runner fixtures remain separate obligations. **Adopt** means catalogue local suites plus existing smokes.
**Locate/create** means locate shared/external tests and register the existing smoke; create missing
behavior coverage where needed. Counts describe files, not individual assertions, runnability or passes.

| Open | Package | Matching test files | Existing smokes | Next package task |
|---|---|---:|---:|---|
| [ ] | [aero-lab](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/aero-lab) | 30 | 1 | Adopt existing suites |
| [x] | [bake-off](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/ec1482a37848cbe4981af206e89fe9ff8d3563f9/bake-off) | 1 | 1 | Catalogued 1.1.1; 1 isolated suite passes; installed supported suites and readiness passed; acceptance above |
| [ ] | [brand-graphics](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/brand-graphics) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [calendar](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/calendar) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [camera](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/camera) | 1 | 1 | Adopt existing suites |
| [ ] | [capability-ideator](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/capability-ideator) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [career-hunter](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/career-hunter) | 50 | 1 | Adopt existing suites |
| [ ] | [cloud](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/cloud) | 0 | 1 | Locate/create behavior coverage |
| [x] | [create](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/ec1482a37848cbe4981af206e89fe9ff8d3563f9/create) | 3 | 1 | Catalogued 1.2.1; 3 isolated suites pass; installed supported suites and readiness passed; acceptance above |
| [ ] | [creative-studio](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/creative-studio) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [daily-trade-recap](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/daily-trade-recap) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [dnd](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/dnd) | 47 | 1 | Adopt existing suites |
| [ ] | [drone](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/drone) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [eats](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/eats) | 0 | 1 | Locate/create behavior coverage |
| [x] | [email-summarizer](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/ec1482a37848cbe4981af206e89fe9ff8d3563f9/email-summarizer) | 1 | 1 | Catalogued 1.2.1; 1 isolated suite passes; installed supported suites and readiness passed; acceptance above |
| [ ] | [feeds](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/feeds) | 0 | 1 | Locate/create behavior coverage |
| [x] | [finance](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/ec1482a37848cbe4981af206e89fe9ff8d3563f9/finance) | 1 | 1 | Catalogued 1.2.1; 1 isolated suite passes; installed supported suites and readiness passed; acceptance above |
| [ ] | [game-show](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/game-show) | 17 | 1 | Adopt existing suites |
| [ ] | [games](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/games) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [hello-oshal](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/hello-oshal) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [home](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/home) | 0 | 1 | Locate/create behavior coverage |
| [x] | [identity](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/ec1482a37848cbe4981af206e89fe9ff8d3563f9/identity) | 2 | 1 | Catalogued 1.1.1; 1 isolated suite passes; 1 fixture pending; installed supported suites and readiness passed; acceptance above |
| [ ] | [intelligent-career](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/intelligent-career) | 0 | 0 | Map member coverage through group lifecycle |
| [ ] | [job-apply](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/job-apply) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [kalshi](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/kalshi) | 3 | 1 | Adopt existing suites |
| [ ] | [life](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/life) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [little-monsters](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/little-monsters) | 20 | 1 | Adopt existing suites |
| [ ] | [lora](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/lora) | 3 | 1 | Adopt existing suites |
| [x] | [marketing-engine](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/ec1482a37848cbe4981af206e89fe9ff8d3563f9/marketing-engine) | 4 | 1 | Catalogued 0.4.2; 3 isolated suites pass; 1 fixture pending; installed supported suites and readiness passed; acceptance above |
| [ ] | [movies](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/movies) | 1 | 1 | Adopt existing suites |
| [ ] | [ocean-lab](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/ocean-lab) | 9 | 1 | Adopt existing suites |
| [ ] | [payments](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/payments) | 0 | 1 | Locate/create behavior coverage |
| [x] | [payroll](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/ec1482a37848cbe4981af206e89fe9ff8d3563f9/payroll) | 13 | 1 | Catalogued 2.3.1; 13 isolated suites pass; installed supported suites and readiness passed; acceptance above |
| [ ] | [portrait-studio](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/portrait-studio) | 4 | 1 | Pilot; retain shared artifact/browser suite references |
| [x] | [presentations](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/ec1482a37848cbe4981af206e89fe9ff8d3563f9/presentations) | 3 | 1 | Catalogued 2.11.2; 3 isolated suites pass; installed supported suites and readiness passed; acceptance above |
| [ ] | [print-ingest](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/print-ingest) | 2 | 1 | Adopt existing suites |
| [ ] | [pumpkin](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/pumpkin) | 5 | 0 | Adopt existing suites; define missing installation smoke |
| [ ] | [purchasing](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/purchasing) | 1 | 1 | Adopt existing suites |
| [ ] | [rides](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/rides) | 2 | 1 | Adopt existing suites |
| [ ] | [sat-ops](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/sat-ops) | 3 | 1 | Adopt existing suites |
| [ ] | [social](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/social) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [spaces](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/spaces) | 1 | 1 | Adopt existing suites |
| [x] | [sports-edge](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/7459c157774e98167737d28f6358e0f6f7a05441/sports-edge) | 11 | 1 | 0.7.1: 11 sealed suites / 165 tests passed; native coach 11/11 and readiness smoke passed |
| [ ] | [spotify](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/spotify) | 1 | 1 | Adopt existing suites |
| [ ] | [storage](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/storage) | 1 | 1 | Adopt existing suites |
| [ ] | [switchboard](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/switchboard) | 8 | 1 | Adopt existing suites |
| [ ] | [system](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/system) | 0 | 1 | Locate/create behavior coverage |
| [ ] | [trading](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/trading) | 13 | 1 | Adopt existing suites |
| [ ] | [travel](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/travel) | 0 | 1 | Locate/create behavior coverage |
| [x] | [venture-plan](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/ec1482a37848cbe4981af206e89fe9ff8d3563f9/venture-plan) | 18 | 1 | Catalogued 1.4.1; 16 isolated suites pass; 2 fixtures pending; installed supported suites and readiness passed; acceptance above |
| [ ] | [video](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/video) | 2 | 1 | Adopt existing suites |
| [ ] | [vids](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/vids) | 3 | 1 | Adopt existing suites |
| [x] | [world](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/ec1482a37848cbe4981af206e89fe9ff8d3563f9/world) | 3 | 1 | Catalogued 1.2.1; 3 isolated suites pass; installed supported suites and readiness passed; acceptance above |
| [ ] | [youtube-kids](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/eaa6106226bd97d3bd78bbee8699421cf795fb06/youtube-kids) | 1 | 1 | Adopt existing suites |

## Existing suite inventory by package

Paths are package-relative. These are migration inputs, not validated runner assignments. Runners
and fixture files must be reviewed before calling a suite unit, integration, browser or live.
Discovery matched tracked `*.spec.*`, `*.test.*`, Python `test_*`/`*_test`, test-named scripts,
known test entrypoints and package.json test/proof/smoke commands. Nonstandard names, root-level
shared suites and cross-repository tests are a required reconciliation step in TLAB-07.

### aero-lab

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
engine/tests/test_accepted_state_integration.py
engine/tests/test_aeropolar_robustness.py
engine/tests/test_bemt_convergence.py
engine/tests/test_billing.py
engine/tests/test_electrochem_ecm.py
engine/tests/test_export_mesh_validation.py
engine/tests/test_floors.py
engine/tests/test_harness.py
engine/tests/test_hull_permeation_uv.py
engine/tests/test_mass_closure.py
engine/tests/test_materials_spar_gust.py
engine/tests/test_mission_flight.py
engine/tests/test_no_free_energy.py
engine/tests/test_pack_thermal_aging.py
engine/tests/test_param_bounds.py
engine/tests/test_pv_diode_mppt.py
engine/tests/test_real_drive_authority.py
engine/tests/test_screen_design.py
engine/tests/test_solver_validity.py
engine/tests/test_sweep_integrity.py
engine/tests/test_uiuc_anchor_integrity.py
engine/tests/test_usable_ledger.py
engine/tests/test_validation_gate.py
engine/tests/test_wing_mass.py
tests/aero-engine-adapter.spec.ts
tests/aero-engine-container.spec.ts
tests/aero-lab-routes.spec.ts
tests/aero-live-engine.spec.ts
tests/aero-physics-parity.spec.ts
tests/aero-surface-contract.spec.ts
```

### bake-off

Current source: **1.1.1**, the **1** shipped suite file catalogued; **1** isolated suite passes, no unsupported local suite in this cohort. See the current cohort above. The following file list is the historical discovery input;
`tests/test-lab.yaml` is the authoritative current suite inventory.

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/bake-off-scoring.test.js
```

### camera

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/camera-routes.spec.ts
```

### career-hunter

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
lib/apply-authorization.test.mjs
lib/apply-prompt.test.mjs
lib/automation-gate.test.mjs
tests/board-feed-plan.test.mjs
tests/board-surface.test.mjs
tests/career-application-state.test.mjs
tests/career-apply-claim-lease.test.mjs
tests/career-apply-model-boundary.test.mjs
tests/career-apply-run-binding.test.mjs
tests/career-artifact-zip-limits.test.mjs
tests/career-async-file-transaction.test.mjs
tests/career-autofill-bookmarklet.test.mjs
tests/career-autofill-route.test.mjs
tests/career-board-browse-mode.test.mjs
tests/career-board-dismiss-filter.spec.ts
tests/career-browse-feed.test.mjs
tests/career-convergence-report.test.mjs
tests/career-cross-process-lock.test.mjs
tests/career-digest-pref-routing.spec.ts
tests/career-digest.spec.ts
tests/career-hunter-resume-alias.spec.ts
tests/career-job-guide-actions.test.mjs
tests/career-jobs-graph-ingestion.spec.ts
tests/career-master-resume.test.mjs
tests/career-no-sync-api.test.mjs
tests/career-portal-logins-launcher.test.mjs
tests/career-postings-provenance-view.test.mjs
tests/career-profile-plan-transaction.test.mjs
tests/career-provenance-loader.test.mjs
tests/career-provenance-migration.test.mjs
tests/career-python-provenance.test.mjs
tests/career-python-storage-identity.test.mjs
tests/career-readiness.test.mjs
tests/career-remote-only.test.mjs
tests/career-resume-extraction-limits.test.mjs
tests/career-resume-multipart.test.mjs
tests/career-resume-status.test.mjs
tests/career-resume-studio-bridge.test.mjs
tests/career-route-transactions.test.mjs
tests/career-run-status.test.mjs
tests/career-search-screen.test.mjs
tests/career-storage-contract.test.mjs
tests/career-stories.test.mjs
tests/career-targets-classify.test.mjs
tests/career-targets.test.mjs
tests/career-title-score.spec.ts
tests/career-user-store-path.test.mjs
tests/migration-index-names.test.mjs
tests/resume-preview.test.mjs
tests/session-crypto.test.mjs
```

### dnd

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/dnd-adventure-catalog.test.js
tests/dnd-archive-rolls.test.js
tests/dnd-build-handshake.test.js
tests/dnd-campaign-library.test.js
tests/dnd-character-import.test.js
tests/dnd-character-resources.test.js
tests/dnd-checkpoint-store.test.js
tests/dnd-combat-narration.test.js
tests/dnd-cutaway-deduplication.test.js
tests/dnd-data.test.js
tests/dnd-death-save-guard.test.js
tests/dnd-directives.test.js
tests/dnd-disposable-smoke-contract.test.js
tests/dnd-dm-fast-path.test.js
tests/dnd-engine.test.js
tests/dnd-exploration-service.test.js
tests/dnd-governance.test.js
tests/dnd-human-move-action-integration.test.js
tests/dnd-import-routes.test.js
tests/dnd-lead-cast.test.js
tests/dnd-leads.test.js
tests/dnd-lobby-launch-client.test.js
tests/dnd-monster-movement-path.test.js
tests/dnd-multiplayer-state.test.js
tests/dnd-owner-rls.test.js
tests/dnd-playback-client.test.js
tests/dnd-playback-route.test.js
tests/dnd-presentation-client.test.js
tests/dnd-presentation-gate.test.js
tests/dnd-presentation-timing.test.js
tests/dnd-quest-thread.test.js
tests/dnd-rewind-archive-client.test.js
tests/dnd-roll-directives.test.js
tests/dnd-roll-payload.test.js
tests/dnd-route-assets.test.js
tests/dnd-route-durability.test.js
tests/dnd-seat-release.test.js
tests/dnd-shared-roll-client.test.js
tests/dnd-shared-roll.test.js
tests/dnd-spatial-prompt.test.js
tests/dnd-story-motion.test.js
tests/dnd-tactical-flow-client.test.js
tests/dnd-timeline-rewind.test.js
tests/dnd-turn-clarity-client.test.js
tests/dnd-ui-contract.test.js
tests/dnd-voice-route.test.js
tests/dnd-voice-ui.test.js
```

### email-summarizer

Current source: **1.2.1**, the **1** shipped suite file catalogued; **1** isolated suite passes, no unsupported local suite in this cohort. See the current cohort above. The following file list is the historical discovery input;
`tests/test-lab.yaml` is the authoritative current suite inventory.

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/session-crypto.test.mjs
```

### finance

Current source: **1.2.1**, the **1** shipped suite file catalogued; **1** isolated suite passes, no unsupported local suite in this cohort. See the current cohort above. The following file list is the historical discovery input;
`tests/test-lab.yaml` is the authoritative current suite inventory.

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/session-crypto.test.mjs
```

### game-show

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/browser-jeopardy.test.js
tests/browser-playthrough.test.js
tests/browser-whammy.test.js
tests/browser-wheel.test.js
tests/cutaways.test.js
tests/fast-money.test.js
tests/game-show-engine.test.js
tests/host-guards.test.js
tests/jeopardy.test.js
tests/leaderboard.test.js
tests/npc.test.js
tests/overrides.test.js
tests/speaker-lease.test.js
tests/timers.test.js
tests/whammy-set.test.js
tests/whammy.test.js
tests/wheel.test.js
```

Declared package script names: `package.json:test`, `package.json:test:browser`, `package.json:test:browser:feud`, `package.json:test:browser:jeopardy`, `package.json:test:browser:wheel`, `package.json:test:browser:whammy`, `package.json:test:shots`. Inspect their command bodies before selecting runners.

### identity

Current source: **1.1.1**, all **2** shipped suite files catalogued; **1** isolated suite passes, **1** fixture-dependent case pending. See the current cohort above. The following file list is the historical discovery input;
`tests/test-lab.yaml` is the authoritative current suite inventory.

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/identity-list-contract.test.js
```

### kalshi

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/kalshi-scan-config.test.js
tests/kalshi-settings-alerts-browser.test.js
tests/kalshi-trends.test.js
```

### little-monsters

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/add-class-e2e.spec.ts
tests/demo-mode-browser.spec.ts
tests/education-access-control.spec.ts
tests/education-class-bank-materials.spec.ts
tests/education-e2e.spec.ts
tests/education-teacher-analytics.spec.ts
tests/little-monsters-e2e.spec.ts
tests/little-monsters-pages-browser.spec.ts
tests/lm-authz.test.cjs
tests/lm-calendar-material-progress-security.test.cjs
tests/lm-doc-contract.test.cjs
tests/lm-identity-security.test.cjs
tests/lm-lecture-security.test.cjs
tests/lm-roster-audit.test.cjs
tests/lm-study-authz.test.cjs
tests/lm-toctou-authz.test.cjs
tests/unit/education-serve-file.spec.ts
tests/unit/lm-flashcards-security.spec.ts
tests/unit/lm-logic.spec.ts
tests/unit/lm-rewards-routes.spec.ts
```

### lora

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/lora-dispatch.spec.ts
tests/lora-ownership.spec.ts
tests/lora-scorecard.spec.ts
```

### marketing-engine

Current source: **0.4.2**, all **4** shipped suite files catalogued; **3** isolated suites pass, **1** fixture-dependent case pending. See the current cohort above. The following file list is the historical discovery input;
`tests/test-lab.yaml` is the authoritative current suite inventory.

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/marketing-gates.test.mjs
tests/marketing-model.test.mjs
```

### movies

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/movies-envelope.spec.ts
```

### ocean-lab

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/energy-budget.spec.ts
tests/geometry-mesh-export.spec.ts
tests/ground-thermal-harvest.spec.ts
tests/harvest-routes.spec.ts
tests/marine-power-budget.spec.ts
tests/rotor-airfoil-panel.spec.ts
tests/rotor-bemt.spec.ts
tests/rotor-routes.spec.ts
tests/surface-reachability.spec.ts
```

### payroll

Current source: **2.3.1**, all **13** shipped suite files catalogued; **13** isolated suites pass, no unsupported local suite in this cohort. See the current cohort above. The following file list is the historical discovery input;
`tests/test-lab.yaml` is the authoritative current suite inventory.

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/payroll-ach-returns.test.mjs
tests/payroll-calendar.test.mjs
tests/payroll-checks.test.mjs
tests/payroll-efw2.test.mjs
tests/payroll-engine.test.mjs
tests/payroll-forms.test.mjs
tests/payroll-grossup.test.mjs
tests/payroll-identity.test.mjs
tests/payroll-nacha.test.mjs
tests/payroll-payrun.test.mjs
tests/payroll-routes.test.mjs
tests/payroll-rt6.test.mjs
tests/payroll-settle-routes.test.mjs
```

### portrait-studio

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/capture.spec.js
tests/catalog-invariants.spec.js
tests/export-email.spec.js
tests/ops.spec.js
```

Observed entrypoints: `tests/browser/camera-proof.js`, `tests/run.js`.

### presentations

Current source: **2.11.2**, all **3** shipped suite files catalogued; **3** isolated suites pass, no unsupported local suite in this cohort. See the current cohort above. The following file list is the historical discovery input;
`tests/test-lab.yaml` is the authoritative current suite inventory.

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/presentations-destination.test.mjs
tests/presentations-surface-parse.test.js
```

### print-ingest

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/classify.spec.js
tests/fanout.spec.js
```

Observed entrypoints: `tests/run.js`.

### pumpkin

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/pumpkin-links-and-settings.test.cjs
tests/pumpkin-public-demo.test.cjs
tests/pumpkin-saved-responses.test.cjs
tests/pumpkin-surface-endpoint-contract.test.cjs
tests/pumpkin-swarm-push.test.cjs
```

### purchasing

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/walmart-catalog-policy.spec.ts
```

### rides

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/rides-map-routes.test.js
tests/rides-map-surface.test.js
```

### sat-ops

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/sat-ops-node-fleet.spec.ts
tests/sat-ops-pass-routes.spec.ts
tests/sat-orbit-w3-routes.spec.ts
```

### spaces

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/spaces-surfaces.test.js
```

### sports-edge

- [x] Sports Edge **0.7.1**, source
  [`7459c157774e98167737d28f6358e0f6f7a05441`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/7459c157774e98167737d28f6358e0f6f7a05441/sports-edge/tests/test-lab.yaml),
  registers all eleven shipped suites and the preserved readiness smoke.

All **11 suites / 165 Node tests** passed in the actual sealed package runner,
with zero failures or skips, verified cleanup and no registration drift. The
authenticated installed Lab separately passed the **coach suite's 11 tests** and
the metadata readiness GET smoke; its durable result returned HTTP 200 with cleanup
verified. This is one native suite, not a native rerun of all eleven suites.
Native evidence pins core `8d1abae445097b11b1c5197bdff1212eb176cbf7` and image
`sha256:10933116dc2754b3abb38f6e1482280cef58ae5f4e95bed3caad56600573bc01`.

Coach coverage exercises actual compiled modules with synthetic ESPN, World and
persistence boundaries; no live provider ingestion or betting occurred. This
separate follow-up preserves the ten-package cohort's counts and four pending
fixture cases. Audit status remains pending.

```text
tests/sports-coach.test.js
tests/sports-ensemble.test.js
tests/sports-espn.test.js
tests/sports-fantasy-winprob.test.js
tests/sports-fantasy.test.js
tests/sports-ledger.test.js
tests/sports-line-history.test.js
tests/sports-odds.test.js
tests/sports-ratings.test.js
tests/sports-surface.test.js
tests/sports-world.test.js
```

### spotify

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/spotify-envelope.spec.ts
```

### storage

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/storage-actions.spec.ts
```

### switchboard

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/switchboard-reply-outbox-model.test.js
tests/switchboard-reply-outbox-routes.test.js
tests/switchboard-stage-fanout.test.js
tests/switchboard-stage-routes.test.js
tests/switchboard-streams-model.test.js
tests/switchboard-streams-surface.test.js
tests/switchboard-surface-parse.test.js
tests/switchboard-threads-model.test.js
```

### trading

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/trading-accounts-surface.spec.ts
tests/trading-dated-orders-ui.spec.ts
tests/trading-direct-trade.spec.ts
tests/trading-event-plans.spec.ts
tests/trading-html-syntax.spec.ts
tests/trading-lab-book-scope.spec.ts
tests/trading-performance-fallback.spec.ts
tests/trading-research-lots.spec.ts
tests/trading-settlement-ticket.spec.ts
tests/trading-strategy-studio-refine.spec.ts
tests/trading-surface-expansion.spec.ts
tests/trading-surface-live-gate.spec.ts
tests/trading-ui-loader-guards.spec.ts
```

### venture-plan

Current source: **1.4.1**, all **18** shipped suite files catalogued; **16** isolated suites pass, **2** fixture-dependent cases pending. See the current cohort above. The following file list is the historical discovery input;
`tests/test-lab.yaml` is the authoritative current suite inventory.

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/venture-bom.test.js
tests/venture-channels.test.js
tests/venture-contracts.test.js
tests/venture-currency.test.js
tests/venture-dataset.test.js
tests/venture-example-pumpkin.test.js
tests/venture-financials.test.js
tests/venture-landed.test.js
tests/venture-primitives.test.js
tests/venture-provenance.test.js
tests/venture-purity.test.js
tests/venture-rebaseline-routes.test.js
tests/venture-rebaseline.test.js
tests/venture-routes.test.js
tests/venture-run-rebaseline.test.js
tests/venture-schedule.test.js
tests/venture-sensitivity.test.js
tests/venture-store.test.js
```

### video

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/show-library.test.js
tests/video-manifest-no-graph.spec.ts
```

### vids

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/integration-surface.test.js
tests/vids-dispatch.spec.ts
tests/vids-public.spec.ts
```

### world

Current source: **1.2.1**, all **3** shipped suite files catalogued; **3** isolated suites pass, no unsupported local suite in this cohort. See the current cohort above. The following file list is the historical discovery input;
`tests/test-lab.yaml` is the authoritative current suite inventory.

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/auth-header.test.js
tests/home-summary.test.cjs
tests/surface-parse.test.js
```

### youtube-kids

- [ ] Complete TLAB-07 for this package; register these suites and map their cases during installation.

```text
tests/session-crypto.test.mjs
```

## Completion gate

Close only when TLAB-01 through TLAB-09 and every applicable public/private row are resolved, installed catalogs
match the packages, lifecycle regression tests pass, and real installation/run evidence is attached.
Creating this backlog or adding suite links to the current static Lab does not close registration.

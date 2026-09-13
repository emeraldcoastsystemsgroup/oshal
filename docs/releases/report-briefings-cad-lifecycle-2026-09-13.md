# Recorded-report briefings, CAD lifecycle and Settings — 2026-09-13

The recorded-report, CAD lifecycle and Settings changes are published and deployed.
Core `f4941d2b` completed its standard preview rollout at 06:16:13 UTC with all
35 app containers healthy and package parity clean. CAD Studio 0.1.2 and Daily
Trade Recap 1.2.0 were then copied from exact published source `df348817`, retaining
the package changes published in `a5f39b7d`, and activated by one API restart.
Desktop Settings acceptance and the recorded-report source/schedule registration
are verified. Native phone and CAD 0.1.2 lifecycle checks, live report production
and Jarvis delivery remain pending. The earlier Scan-to-CAD handoff and cleanup
on CAD 0.1.1 remain a separate
[component integration checkpoint](component-integration-2026-09-13.md).

## Recorded reports in Jarvis

Daily Trade Recap 1.2.0 declares one registered briefing source and a separate
fifteen-minute service schedule. Its collector reads existing `daily-report`
entries from the trading report journal. The report generator, after-close host
schedule, media workflow, approval gate and outward delivery tools retain their
existing owners and behavior. This does not implement a new morning report
generator or establish that a report, email or website publication completed.

The recipient comes only from the recorded owner subject. The existing
[Jarvis briefing service](../apps/jarvis-briefings.md) must resolve an unambiguous
current identity and authorize access to the registered source. Current
exact-principal preferences and source lifecycle checks still apply. Missing,
ambiguous, inactive or changed identities are never replaced with an operator,
email address or broadcast audience.

The reusable `saveCompletedBriefing` helper in the
[core task store](../../src/app/routes/jarvis-task-store.ts) admits the completed
result in the existing registered publication transaction. The service supplies
the verified issuer and source identifier. A deterministic owner/report-day ID
and conflict refusal preserve an existing task, including its delivery marker.
A failed transaction leaves no stranded pending task; a later eligible run can
retry. The helper has no ordinary-task fallback, and the package does not own
task-table writes or a second delivery engine.

Messages say **report recorded**. The journal is evidence of that recorded report,
not confirmation of email or site delivery. Only a committed admission counts as
queued; the task remains undelivered until Jarvis's normal claim lifecycle runs.
Missing runtime, unregistered source or journal read failure is unavailable.
Other unconfirmed admissions are reported as deferred or already queued, because
the Boolean admission contract does not distinguish suppression from duplicates
or failed writes. Budget exhaustion is also deferred.

Each fire examines at most the newest 50 eligible rows recorded within 72 hours.
It stops starting further admissions after ten seconds; an in-flight operation
retains the core service's existing authority and timeout boundaries. This is
bounded recent reconciliation, not exhaustive backfill when more rows exist.
Collection does not generate reports, place trades, call providers or send
outward messages.

## Local evidence and registration

| Check | Result | Boundary |
| --- | --- | --- |
| Recorded-report regression | 22/22 Node cases, exit 0 | Actual compiled collector, core completed helper and briefing service/transaction code with explicit synthetic SQL, identity and loopback HTTP ports. No live database or production report. |
| Failure before the change | Existing two-call writer leaves a pending row after a synthetic completion-write failure; its deterministic retry is refused | Preserved proof explains why completed admission needs one transaction; it does not change the legacy helpers. |
| Canonical compilation | Full core and four package source modules compile, exit 0 | Only the new compiled collector is copied. Existing three route files retain their bytes; their prior source-map/EOF differences are recorded. |
| Validation and lint | Package valid with zero warnings; new package files have zero lint findings | Core retains the unchanged 63-line `ensureJarvisSchema` baseline; the new helper meets the 50-line limit. |
| Independent review | Read-only source/test review clear | No duplicate test run or installed acceptance implied. |

The 22 cases include exact-owner admission, journal rewrites, overlapping
collectors, insertion failure and retry, authority revocation after insertion,
disabled and other-issuer preferences, unavailable sources/runtime, malformed
rows, bounded reads, elapsed admission budget and a fixed HTTP entry point whose
body cannot substitute recipients or report results.

The package declares **two AI Test Lab cases**: existing metadata readiness and
the recorded-report regression. The actual in-memory catalog accepts both.
The regression declares `runner:node-test`,
`framework-checkout:oshal-core-dir` and disposable fixture writes. It remains
pending in an installed runner that cannot provide that framework checkout.
Catalog registration is separate from execution. Installed metadata readiness
passes; the framework-dependent producer regression and live briefing delivery
remain pending.

The ignored source receipt is `temp/recap-briefing-release-receipt.json`, SHA-256
`7538c262efa736d2f03b050bed42939a3b4f7348601cabbcefeba4e8830c5281`.
It pins seven source paths, the final 22-case log, canonical build, validation,
lint, catalog observation and preserved failed checks. The legacy partial-write
proof is `temp/recap-briefing-legacy-partial-before.json`. These local receipts
contain synthetic evidence; they are not published source artifacts.

## CAD editor lifecycle

CAD Studio 0.1.2 keeps the selected part, revision and unfinished feature input
current while asynchronous reads and mutations complete. Late detail responses,
STL headers or body, preview errors, revision lists and revision loads cannot
replace another selected part. The same guards cover rebuild, background poll
and deletion responses. Deleting the selected part clears its old geometry;
a late deletion response cannot hide a different part opened afterward.

Current background refresh still updates the actual shared WebGL preview while
preserving unfinished feature input. When a submitted feature completes, newer
input entered during that request remains editable; an unchanged submitted form
still completes and resets normally. The correction is confined to the package
UI lifecycle and its fixture/spec. It does not change the CAD engine, backend
API, model schema or shared STL renderer.

The final actual Chromium suite passes **14/14**, exit 0, in 14.32 seconds.
Twelve before regressions failed against the previous source, while two positive
controls passed. The final run verifies graceful cleanup of its exact owned
browser process in 732 ms. An earlier candidate passed ten assertions but failed
cleanup; that failed run is retained and is not counted as a clean or additional
pass. Syntax, scoped lint at 50 function/800 file code lines and the diff check
pass. Independent source/fixture review is clear.

The fixture serves the actual package HTML/scripts and canonical shared STL
renderer with controlled loopback HTTP responses and memory-only records.
These are real Chromium/WebGL observations, not a CAD-kernel, live database or
native installed workflow test. No provider, physical printer or engine operation
was performed by this suite.

The source catalog now declares **six CAD Test Lab cases**, adding
`surface-lifecycle` with `runner:playwright`,
`framework-checkout:oshal-core-dir` and disposable fixture writes. Those
prerequisites remain explicit; catalog declaration does not claim installed
execution. CAD 0.1.2 is installed. Its metadata readiness and isolated installed
engine-client recipe pass; the native lifecycle and other prerequisite-dependent
recipes remain pending.

The ignored final receipt is `temp/cad-lifecycle-release-receipt.json`, SHA-256
`1c1b9d66b188fd07665f8de21aa27aac1ff24d1901df5404f45b10b21a8fe28d`.
It pins the three source/test files, before evidence, final log and cleanup.
This release therefore records **36 distinct local cases** across recorded
reports (22) and CAD lifecycle (14), with their different proof boundaries intact.

## Global Settings appearance

Global Settings now opens with Appearance: the existing portal theme picker,
optional application colors and navigation layout. Approval preferences remain
available in their own later section. Config Ownership and runtime guidance use
a closed native disclosure, keeping the same information accessible by keyboard
without preceding the everyday appearance controls.

The change retains every control ID and all 39 existing binding, load/save,
provider and authorization function bodies. Only section rendering changes.
The service-worker cache advances from v43 to **v44** so installed shells retire
the previous cache; request, authentication and asset-routing behavior is unchanged.

The final full Settings/theme browser suite passes **20/20**, exit 0: three new
cases and 17 retained theme cases. The new cases use the actual shell and Settings
view with synthetic local HTTP. They measure appearance controls within the first
screen at 1280 and 390 pixels before any automatic scrolling, verify theme and
navigation persistence through reload, and exercise Enter/Space expansion and
focus retention without writing runtime configuration. The three cases failed
against the previous layout. The exact owned browser exits gracefully with a
verified exit in 4,802 ms.

An earlier run passed its assertions but failed browser cleanup; a subsequent
PowerShell wrapper reported failure despite a graceful browser exit. Both remain
recorded separately. The final Node wrapper confirms exit 0. The existing cleanup
protocol remains bounded; only the test teardown hook accommodates that protocol.
The 39 legacy Cockpit cases were enumerated, not run or included in the 20 passes;
their ownership-guidance assertion now opens the native disclosure first.

The existing `cockpit-appearance` AI Test Lab card already links
[`workspace-theme-browser.spec.ts`](../../tests/unit/workspace-theme-browser.spec.ts),
including the three new cases. Its fixed stylesheet readiness checks remain
read-only and do not execute this browser suite. Scoped types, lint and diff
checks pass, and independent source/evidence review is clear.

The ignored source receipt is `temp/settings-appearance-release-receipt.json`,
SHA-256 `0c9ecdd135365883345abbf2d593580d98a1511aef3ce94b710336ee49c798e5`.
It pins the three source/test files, final 20-case log, process and cleanup
receipts, retained failures and desktop/phone screenshots. On the installed
desktop, Appearance was first, the saved Workspace palette and navigation stayed
unchanged, and Config Ownership started closed. Mouse, Enter and Space toggled
the disclosure; closing it retained visible keyboard focus. No settings save or
provider change was performed. Native phone acceptance remains pending; the
390-pixel browser proof above is local fixture evidence.

## Deployment and activation

The published core is `f4941d2bee48504f45ad2859f6565adb0d41aeca`, with image
`sha256:2c71a6c74ef7b8cfa5740f3fe085de20e8c33d6d22db0f493e898da039dc9262`.
The standard preview command exited 0; its retained evidence is
`temp/report-settings-deploy-exit.json` and
`temp/report-settings-deploy-console.log`.

The package copy receipt, `temp/report-cad-next-copy-receipt.json`, passes all
64 exact staged files: 47 for CAD Studio 0.1.2 and 17 for Daily Trade Recap 1.2.0,
both at `df34881754eb169d9d388f3e3dd8584262a1e58e`. Both complete backups were
verified before either package was copied. The API restart began at
06:17:23.534 UTC and returned healthy; auto-load completed at 06:18:01 with
79 loaded and zero failed.

The read-only activation receipt, `temp/report-cad-next-activation.json`, passed
at 06:18:16 UTC, SHA-256
`70552f936f6c18aaa2f4775e04aed57455ebe989636086dee64874db7f1b698a`.
It verifies the exact installed core/image, Daily Trade Recap manifest and
registered source, plus the active indexed Redis schedule and enabled scheduler.
The compiled completed-briefing export was inspected in a separate diagnostic
process without invocation. No collector or task was fired. This establishes
source and schedule registration, not queue processing, report production or
browser delivery. The native Lab catalog loaded 131 scenarios from 75 live apps.
The four selected core checks passed: installed test registration, Cockpit
appearance, workspace navigation and shared STL availability. These are read-only
readiness checks, not execution of their linked browser suites. Registration
reported 47 installed smoke cases and 205 declared suites. The installed CAD
0.1.2 and Recap 1.2.0 cards showed six and two cases respectively, and both
metadata-readiness checks passed.

CAD's installed `engine-client` retry passed seven tests with verified cleanup
in 6,240 ms, on the exact deployed image and package source. Durable run
`8d1e27cf-ff94-4d2f-a97c-e42e784be793` retains that result. The earlier run
`a1f28012-3e74-4496-aa25-d0b4854f9227` remains interrupted after an overlapping
API restart. Neither result implies execution against the real CAD kernel.
The read-only metadata receipt is `temp/report-cad-native-lab-results.json`,
SHA-256 `4eadd6597ab3cb0f6f78a2b856c079b4131c97670f5307bae72ebe2bf912da58`.

Preservation is not a full pass. The core-only comparison at 06:16:59, before
the two package copies, retained exactly two failures: full-row hashes for
`oshal_authorization_applications` and `oshal_verified_principals`. All 61 package
inventories, stable registry fields, business/private data and CAD engine checks
matched; authorization remained revision 81 with 73 assignments and 81 audits.
The raw registry and timestamp hashes differed; only top-level `updated_at` is
excluded from its separately retained stable comparison. The earlier independent
supplement also retains a principal-hash alignment failure between captures.
Neither failure is attributed or converted to a pass. The immutable records are
`temp/report-cad-next-core-only-preservation.json` and
`temp/report-cad-next-supplement.json`.

The final retry remains **FAIL**, retained in
`temp/report-cad-next-preservation-retry.json`, SHA-256
`9d870bb4da118bbed52e4da15810bb310e4c46f244ceb1e5b6900c8ec391d8dc`.
Both target packages match all 64 published files. Business/private data,
authorization assignments and audits, and Jarvis tasks/preferences/cursors remain
unchanged. The separate Embodied package changed concurrently from 0.5.0 to 0.6.0
at `ed9c5fb0`; its registry was inactive in that snapshot. Its authorization
`tool_names` changed, the verified principal's `last_seen_at` changed, and the
registered Recap briefing source was added. Baseline/final cross-capture alignment
failures remain explicit; no allowance was added to manufacture a full pass.
The first final-capture attempt failed before comparison during another restart.
Docker observations establish orderly SIGTERM/restarts at 06:19 and 06:21,
but do not identify the caller. Root's activation restart was at 06:17.

## Remaining acceptance

The matching core helper and Daily Trade Recap package are installed, and source
and schedule registration pass. Verify current recipient preferences, then
observe an eligible owned recorded report reaching the normal Jarvis task
and browser delivery lifecycle. Actual report production and external delivery
remain separate acceptance boundaries; do not create trades or send messages
merely to manufacture a briefing.

[JDX-04](../backlog/jarvis-daily-dashboard.md#september-13-recorded-report-source-checkpoint)
is partially implemented and deployed. Morning-report production/delivery,
communications and other producer adoption remain open, alongside JDX-03 durable
grouping/replay/snooze and JDX-05 selected-record context actions. Record native
CAD 0.1.2 lifecycle acceptance and the prerequisite-dependent Lab recipes
without replacing the earlier CAD 0.1.1 evidence. Preserve the failed final
comparison and concurrent deployment observations. Settings with cache v44 is
deployed and accepted on the native desktop; native phone acceptance remains open.

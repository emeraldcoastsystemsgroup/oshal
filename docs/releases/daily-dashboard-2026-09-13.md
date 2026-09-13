# Compact daily dashboard and Finance navigation

Source published and standard preview deployed on 2026-09-13. Native presentation
and Lab readiness acceptance passed. Preservation results and the registry
comparison limitation are recorded below.

Home now keeps the existing Jarvis conversation beside a bounded daily view:
seven named areas at most, four application summaries and one selected source's
details. Finance is a named area. The searchable **All applications** directory
retains authorized applications hidden from Home and applications without a known
suite. Setup details are collapsed within the selected application.

Jarvis has a compact state indicator and visible text composer. Talk, Add and Stop
remain directly available; secondary controls live in Options. Existing task
records are grouped by source/topic with counts and expandable individual results.
The closed discussion drawer no longer casts a shadow over the compact view.
The old Engineering label belonged to the decorative canvas category display;
this change does not claim to repair a server dispatch defect.

The top-workspace layout now includes admitted Finance. The chevron beside the
OSHAL brand opens Home, All applications, searchable remaining workspaces and
the existing settings/theme controls in either navigation layout. Only explicitly
delegated sidebar entries are removed; unrelated financial tools remain reachable.

## Contracts retained

- Current-user summary probes and application authorization remain the owners of
  visibility and business facts. Missing summaries never become invented zeros.
- Summary refreshes, selected-detail changes, directory use and saved display
  choices retain the mounted Home Jarvis document and unfinished composer.
  Leaving Home follows the existing view lifecycle.
- Theme changes use the existing portal chooser and shared parent-theme observer.
- Group expansion does not mark records read. Individual open/dismiss operations
  retain the existing owner-scoped handlers.
- Focused applications keep their own pages, drafts, themes and permission gates.
  The daily Home embed does not broaden the focused-application surface bridge.

## Verification

`npm run test:daily-dashboard` runs the source browser, lifecycle, directory,
HTTP-asset and registration suites. `npm run test:workspace-navigation` and
`npm run test:workspace-theme` retain the surrounding navigation/appearance checks.
Browser fixtures serve real current components with synthetic local responses;
they do not call live models, providers or business actions.

The independently reviewed source ledger contains **413 distinct passing cases**
across scoped runs, not one combined command:

| Scope | Distinct passing cases |
| --- | ---: |
| Integration and catalog | 47 |
| Retained authorization, navigation and theme core | 122 |
| Shared browser cleanup | 9 |
| Finance and OSHAL navigation | 66 |
| Home | 50 |
| Compact Jarvis | 17 |
| Retained Jarvis clients | 68 |
| Corrected delayed-visual lifecycle fixture | 6 |
| Retained package-tool browser | 11 |
| Final Workspace theme | 17 |

The earlier mixed Jarvis run's 71 passing cases included three delayed-lifecycle
cases; its seven fully passing client files account for 68. The corrected six
lifecycle cases are counted separately. Repeated layout/palette checks and
overlapping registration/cleanup checks are not added again. The ledger is
`temp/daily-dashboard-independent-review.json`; native readiness and preservation
helper checks are excluded from this source total.

An existing delayed-visual lifecycle fixture was reproduced failing on the
previously published source because its SQL double did not recognize current
owner/issuer/source projections and optional preference reads. The fixture now
matches those existing queries; all six original ownership/result cases pass
without production changes or weakened assertions.

Several initial browser runs passed their assertions but hung during shutdown;
these were failed runs. The shared test helper now owns its exact headless process,
bounds graceful shutdown, verifies exit, and reports any scoped forced cleanup.
It rejects premature crashes. Nine host-only tests cover that cleanup contract.

AI Test Lab registers **Jarvis and daily dashboard** with links to these executable
suites. Its three Run steps check installed fixed-asset readiness in the caller's
session. **Cockpit workspace navigation** checks current workspace discovery.
Those readiness steps are separate from executing source browser regressions.

## Deployment checkpoint

Published core source is `0c2872238626cccacc1e517421bee9cc9e054ec9`.
The standard `scripts/oshal-deploy.sh --preview` build verified the committed
source label and kernel-skills probe, then recreated the API and 34 bots.
At **03:45:09 UTC on 2026-09-13**, the final census reported **35/35 healthy**
with registry parity clean on image
`sha256:e92d34689c30de82e5f492605a2cc102925840ca4eb58c1f434117adeaa2ed61`.
The retained deployment log is `temp/daily-dashboard-deploy.log`.

The rollout also encountered slow origin responses and a native HTTP 524 page;
the existing [startup investigation](../backlog/cockpit-startup-resilience.md)
records those observations without assigning a single cause. Initial navigation,
discovery and preference failures remain retained separately from later passing
acceptance. An independently owned Embodied package reload occurred afterward.

Native acceptance found that Cockpit's universal margin reset placed the Home
directory dialog at the upper-left corner. The scoped correction explicitly
centers Home's native dialogs and retains their viewport bounds and scrolling.
Four existing registered Chromium cases now assert populated and unavailable
dialog geometry at desktop and phone widths; all four pass. They are repeat
checks within the 413-case ledger, not four additional cases. This focused run
required the existing exact-owned browser cleanup fallback, with exit verified.
The correction is published in `d8080f563e8a3637420e0c13d60d92d4d20b955c`.
The existing read-only `/app/src/pages` bind serves its exact Git bytes; no second
fleet recreation was needed. Backend/image provenance remains `0c287223`/`e92d3468`.
Native hard reload verified the centered populated directory. Source and mounted
byte receipts are `temp/app-home-modal-centering-release.json` and
`temp/app-home-modal-static-provenance-d8080f56.json`.

## Installed acceptance

Actual native Chrome checks verified the compact Home/Jarvis composition, named
Finance area and top workspace, OSHAL menu placement/filtering, and centered
searchable directory including the independently installed Embodied application.
An unsubmitted message survived Refresh, area selection and directory open/close.
The portal theme reached the embedded assistant; Workspace was restored. Task
group expansion retained the immediate unread count and individual result controls.
Finance opened `/cockpit/?app=finance` with its contextual sidebar; its OSHAL
directory action returned to ordinary Home and opened the directory. Test drafts
were cleared without sending, and Home was left active.

Two native **Run** controls in AI Test Lab passed four readiness steps: three
dashboard assets and workspace discovery with **33 admitted links**. These core
cases use the synchronous `/api/test-lab/run` path and do not create durable
package-run IDs or execute their linked source suites. No provider generation,
outbound message, trading/payment, physical print or role grant was invoked.

Native receipts are `temp/daily-dashboard-native-acceptance-final.json`
(SHA256 `296144e2a2bc8108fa5c66ce52e8f30fb1de8b6bc4f00d06a377b1d3af93e72f`)
and `temp/daily-dashboard-core-lab-native-final.json`
(SHA256 `cb286bfbd0ca9e8d85b834c857a2afe87a3e01c96dd13f31ff12760e9758274d`).
Mobile geometry is established by the registered isolated browser cases, not a
physical-phone run. Later recovery does not close the intermittent startup work.

## Preservation

The original before snapshot and strict comparison remain immutable. The completed
04:09 UTC capture verified 59 unchanged packages, 57 unchanged selected tables,
unchanged authorization revision/assignments/audits (**80/72/80**), and the checked
CRM, Create, Scan and Embodied business records and private files. It also verified
35 healthy application containers on the expected image, unchanged environment
apart from the authorized core `GIT_SHA` update, unchanged mounts and commands,
14 running infrastructure containers and six existing stopped auxiliary containers.

The other bot independently installed Embodied **0.4.0** from
`a31c07720e95d960fb7bf7e6c94438c227e6aa2c`. All 79 published package files plus its
install stamp matched exactly; this package change is attributed separately.

The strict result remains **failed for package and registry differences**, not a
blanket preservation pass. The `swarm_applications` table retained 84 rows and its
row-policy hash, but its whole-row hash changed. A proposed four-field projection
for Embodied's old description/version did not reproduce the baseline and was
rejected. [Migration 022](../../scripts/migrations/022-swarm-applications.sql)
also updates `updated_at` on every row update, including
normal loader upserts. Because the original snapshot retained only full aggregate
hashes, it cannot retrospectively distinguish all registry content changes from
those timestamps. No baseline or comparison was weakened and no user data was
restored or removed to obtain a pass.

Retained receipts include `temp/daily-dashboard-preservation-0c287223-strict.json`
and `temp/daily-dashboard-embodied-attribution.json`. Earlier collection failures
are separate from comparison failures. A reviewed collection wrapper extended
only bulk Docker inspection from 30 to 90 seconds; original data comparisons,
database/read deadlines and the 60-second package collector remained unchanged.

The final partial ledger is `temp/daily-dashboard-final-preservation-ledger-v2.json`
(SHA256 `48a09f7fb30ef85cd679599689aaf92121e1ed5ee275a16908396e5045e21a03`).
At **04:16:02 UTC**, one bounded health request returned HTTP 200 in 103 ms. The
API retained the expected image and was healthy after the independently recorded
package reload; its actual process start was 03:55:14 UTC with one restart and no
reported OOM. This is current responsiveness, not closure of the startup issue.

For the next deployment, capture a stable registry hash excluding only the
source-defined volatile `updated_at`, and retain each row's timestamp separately.
Keep identity, owner, tenant, scope, status, load time and all manifest/tool metadata
in the stable comparison. This improves future evidence; it cannot repair today's
missing baseline detail retrospectively.

## Remaining work

The full [Jarvis daily dashboard backlog](../backlog/jarvis-daily-dashboard.md)
remains open for durable grouping/replay/snooze semantics, additional completed
morning-report and communication producers, and selected-record context with
supported editable-field operations. This checkpoint delivers the presentation
and navigation slice. It does not establish a new LinkedIn integration, trading
execution, or automatic cross-application editing capability.

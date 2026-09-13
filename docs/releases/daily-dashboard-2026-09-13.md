# Compact daily dashboard and Finance navigation

Source published and standard preview deployed on 2026-09-13. Native acceptance
and final preservation remain pending.

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
records those observations without assigning a cause. A successful container
census does not establish native UI acceptance or final preservation. Both
remain pending for this checkpoint; early failed attempts remain retained.

Native acceptance found that Cockpit's universal margin reset placed the Home
directory dialog at the upper-left corner. The scoped correction explicitly
centers Home's native dialogs and retains their viewport bounds and scrolling.
Four existing registered Chromium cases now assert populated and unavailable
dialog geometry at desktop and phone widths; all four pass. They are repeat
checks within the 413-case ledger, not four additional cases. This focused run
required the existing exact-owned browser cleanup fallback, with exit verified.
The correction's installed acceptance remains pending. Its source receipt is
`temp/app-home-modal-centering-release.json`.

## Remaining work

The full [Jarvis daily dashboard backlog](../backlog/jarvis-daily-dashboard.md)
remains open for durable grouping/replay/snooze semantics, additional completed
morning-report and communication producers, and selected-record context with
supported editable-field operations. This checkpoint delivers the presentation
and navigation slice. It does not establish a new LinkedIn integration, trading
execution, or automatic cross-application editing capability.

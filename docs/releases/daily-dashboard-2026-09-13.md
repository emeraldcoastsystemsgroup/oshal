# Compact daily dashboard and Finance navigation

Source checkpoint: implemented; publication and installed acceptance pending.

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

Final source counts, commit/image provenance, native acceptance and preservation
results will be recorded after deployment. Early attempts and any unresolved
baseline failures remain identified separately from passing final runs.

## Remaining work

The full [Jarvis daily dashboard backlog](../backlog/jarvis-daily-dashboard.md)
remains open for durable grouping/replay/snooze semantics, additional completed
morning-report and communication producers, and selected-record context with
supported editable-field operations. This checkpoint delivers the presentation
and navigation slice. It does not establish a new LinkedIn integration, trading
execution, or automatic cross-application editing capability.

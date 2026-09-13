# Jarvis and the daily dashboard

Requested 2026-09-11. Status: **compact presentation delivered; native acceptance passed**.
Recorded-report producer adoption is **partially implemented and locally tested;
publication and installed delivery acceptance are pending**.
The September 13 follow-up addressed the unsatisfactory Jarvis layout as P1:
make the assistant compact, make Finance a named area, and place miscellaneous
applications in the OSHAL menu instead of an `Other` dashboard section.
This work continues the cockpit landing request and the existing briefing and surface-context work.

## September 13 delivered presentation

Home now composes the existing Jarvis page beside at most seven named areas, four
application summaries and one selected source's details. Finance is named. The
complete authorized directory, including hidden and unclassified applications,
remains searchable through **OSHAL menu → All applications**. Dashboard redraws,
summary refreshes, source selection and preference saves retain the mounted Jarvis
document and unfinished composer. Leaving Home follows the existing view lifecycle.

Native acceptance confirmed the actual embedded Jarvis page, seven named areas,
at most four updates and one selected detail, with Finance in the top navigation
and no `Other` shelf. An unfinished message survived Refresh, area selection and
opening/closing **OSHAL menu → All applications**. The centered directory found
the installed Embodied 0.4 application. Jarvis followed the portal palette, and
the original Workspace choice was restored.

The [release record](../releases/daily-dashboard-2026-09-13.md) separates backend
core `0c287223` / image `e92d3468` from the published, bind-mounted modal CSS at
`d8080f56`; that static correction required no second fleet recreation.
Intermittent origin/startup delays remain in the
[startup investigation](cockpit-startup-resilience.md). Presentation acceptance
does not establish that those delays are resolved.

Jarvis uses explicit Ready, Listening, Thinking, Speaking and Stopped feedback,
a visible text composer, Talk/Add/Stop and an Options disclosure. Existing task
records are grouped by their source/topic prefix with expandable individual results
and bounded scrolling. Opening and dismissing retain the existing owner-scoped
handlers; grouping itself does not mark anything read. The ambient Engineering
label came from the canvas category display; removing that background is not a
claim that a server dispatch or task-lifecycle defect was repaired.

This delivers the initial JDX-01/JDX-02 presentation and portions of JDX-03/JDX-06.
Durable grouping/replay/snooze semantics (JDX-03), additional producer adoption (JDX-04),
and selected-record editable-field context actions (JDX-05) remain open. The Home
embed does not broaden the focused-application surface bridge. Sources still own
their data and actions; an unavailable summary is not rendered as a zero count.

`npm run test:daily-dashboard` runs the linked source regressions. AI Test Lab's
**Jarvis and daily dashboard** scenario registers the browser, lifecycle and HTTP
asset suites and separately provides three read-only installed-asset readiness
steps. Running those readiness steps does not execute the linked source tests.
At 04:06–04:07 UTC, the two actual native Run controls for this scenario and
**Cockpit workspace navigation** passed four readiness steps in total; discovery
reported 33 admitted links. These core results are in-page observations, not
durable package-run history or execution of the registered source suites.

## September 13 recorded-report source checkpoint

Daily Trade Recap 1.2.0 adds one producer beyond Kalshi using the existing
registered briefing, exact-owner preferences and task rails. Its separate
fifteen-minute service schedule reconciles existing `daily-report` journal
entries. A reusable core `saveCompletedBriefing` helper commits the completed
result atomically, retaining current source authorization and issuer resolution;
failed transactions leave no pending row to block a later retry. Missing or
ambiguous owners are deferred, never inferred from an email or default operator.

The [next source release](../releases/report-briefings-cad-lifecycle-2026-09-13.md)
records 22 passing local Node cases using the actual collector/helper/service
with synthetic transactional SQL and HTTP ports. It is separate from current
core `59f9c52e` acceptance. The package declares two Lab cases: metadata readiness
and the producer regression. The latter requires a framework checkout and is
not claimed to have run in the installed Lab.

This is **recorded-report notification**, not a new morning report generator or
proof of email/site delivery. Collection examines at most the newest 50 eligible
rows from 72 hours and stops subsequent admissions after ten seconds; it does
not cancel the operation already in flight or guarantee exhaustive backfill.
Only confirmed admissions count as queued, and normal Jarvis browser claims
still determine delivery. Unavailable sources/reads and deferred admissions
remain distinct from a delivered update.

JDX-04 remains open: publish/install this source and verify real eligible report
admission and browser delivery, then adopt communications and other supported
producers. The existing after-close workflow remains unchanged. Actual morning
report production, at least three supported source types, and their source,
freshness and attention presentation still need evidence. JDX-03 durable
grouping/replay/snooze and JDX-05 context actions also remain open.

## Product direction

Provide one useful daily page with application updates and a compact Jarvis conversation area.
The user can scan what changed, open a specific item, and work on it with Jarvis while keeping
the relevant details visible. Jarvis should not occupy the entire page by default. Keep the
complete application directory available as a separate view of all applications.

The default is a daily work page, not the complete application catalog. Keep a
compact Jarvis composer beside the selected update/details on desktop and stack
them accessibly on narrow screens. Use named areas such as Finance for relevant
updates; leave miscellaneous tools and the searchable full directory in the
OSHAL menu. `Other` must not become a large default dashboard bucket. This is
the same navigation follow-up tracked in
[Finance and the OSHAL menu](cockpit-workspace-navigation.md#requested-follow-up-finance-and-the-oshal-menu).

The supplied screenshots show overlapping text around the eye, a long repetitive Kalshi
queue, extensive empty space, a crowded row of assistant controls, and fixture/probe cards
mixed into Home. The user also reports persistent Engineering activity and missing morning
trade updates. The checkpoint above diagnoses the decorative Engineering label and
repairs presentation overlap; missing producer delivery still needs runtime reproduction.
Do not infer that a displayed activity indicator proves a tool was actually dispatched, or
that another application's lack of updates proves its producer ran successfully.

## Work order

| ID | Priority | Deliverable | Done when |
|---|---|---|---|
| JDX-01 | P1 | Repair text overlap and activity feedback; replace the dominant eye with a compact assistant presentation. | Idle, listening, thinking, speaking and stopped states are distinct. Only actual current work animates a destination, and completion/cancellation clears it. Long text, resizing, zoom, theme changes and open detail panels never cover controls or other copy. |
| JDX-02 | P1 | One compact daily dashboard with Jarvis, attention items and recent updates. | The initial page shows a bounded summary and adjacent detail area, with useful empty/unavailable states. Finance is a named area; miscellaneous tools and All applications remain reachable in the OSHAL menu without an `Other` dashboard bucket. Setup details and developer fixtures do not crowd the personal default. Pinned applications and per-user choices survive reload. |
| JDX-03 | P1 | Group related alerts and retain a readable activity history. | Repeated updates are grouped by source and topic, with a count, latest meaningful change and expandable history. Replayed events do not inflate unread counts. Distinct executions or decisions remain distinguishable. Read, dismiss, snooze and resolve have explicit separate semantics and durable user state. |
| JDX-04 | P1 | Adopt the briefing contract beyond Kalshi, beginning with morning trading reports and communications. **Partial source checkpoint:** recorded-report collector/helper passes 22 local cases; publication and installed delivery remain pending. | Each supported producer registers its source, queues an exact-owner result after actual completion and honors preferences. The dashboard identifies source, timestamp, freshness and whether attention is required. Missing connectors, disabled sources and failed collection remain visible as such. Actual production and delivery are tested separately. |
| JDX-05 | P1 | Context-aware navigation and editable drafts beside an update. | From an update, the user can open its authorized application/record, ask Jarvis to navigate or fill supported fields, inspect the changes and continue editing. The surface acknowledges applied operations; unsupported or rejected operations never produce a false completion claim. |
| JDX-06 | P1 | Simplify the assistant controls and prove the complete daily workflow. | Text and voice share a clear composer, Add has an attachment purpose, Stop appears during active work, and New, history, language and appearance controls have predictable locations. Closing/minimizing retains the defined draft/history state. The end-to-end browser and installed-source acceptance below passes. |

The initial JDX-01/JDX-02 presentation is delivered. Continue with durable grouping
and source adoption, then extend context actions against that shared page. The
existing full response stage can remain
available for content that needs more space. The default animation and optional appearance
settings should be reviewed as part of the layout rather than preserving the eye as a constraint.

## Reuse the existing owners and contracts

- `AppsHomeView.js` already reads owning-app summaries in the signed-in session. Compose its
  reusable data and handoff behavior; do not add a second core copy of application business logic.
- [Jarvis briefings](../apps/jarvis-briefings.md) already provide registered sources, exact-user
  preferences, announcement cadence, channel choice and lifecycle controls. Cadence currently
  batches announcements; a grouped dashboard is a separate presentation requirement. Reuse the
  source/task identity and delivery cursors without replaying suppressed or retired events.
- Existing surface context, the validated surface bridge and registered application tools should
  supply the current application, record, selection and supported operations. Revalidate current
  permissions and context after asynchronous work. A model instruction must not become arbitrary
  page JavaScript or an unrestricted field selector.
- Follow the [voice and visuals backlog](jarvis-voice-and-visuals.md) for response rendering,
  narration and lifecycle behavior. This page should integrate those capabilities without making
  every answer a full-screen animation or a second conversation implementation.
- Package owners add their briefing producers and detail/draft actions. Core owns aggregation,
  preferences, context handoffs and presentation. Developer/test-only visibility needs an explicit
  classification; do not hide applications by guessing from their names or remove their records.

## Example workflow

The daily dashboard shows a grouped morning report, a CRM follow-up and a new message from a
connected communication source. The user opens the message and its details appear beside Jarvis.
“Help me reply” supplies the selected thread and current editable draft through the owning
application's supported context. Jarvis proposes text in that draft; the user edits it and uses
the application's normal send control. LinkedIn is the requested example, not a claim that a
working LinkedIn inbox/reply connector is already installed. When an adapter is unavailable,
offer the available source link and an editable draft with honest capability limits.

Navigation retains the originating update, filters and scroll position so the user can return
to the dashboard. A changed account, record or permission invalidates an old pending operation.
Navigation or a delayed model answer must not overwrite newer manual edits.

## Verification and Lab registration

These are full-workstream acceptance cases; the checkpoint above covers only the delivered slice. Add actual executable suites and their existing AI Test Lab
registrations with each implementation slice; do not register placeholders as runnable tests.

- Real browser layout checks at desktop and mobile widths, 200% zoom, both themes, long text,
  keyboard navigation, reduced motion and every listening/speaking/cancellation state.
- Finance appears as a named authorized area, the default dashboard has no `Other`
  catalog section, and the OSHAL menu retains every admitted miscellaneous destination.
  Selecting Finance preserves the compact Jarvis/detail layout and current context;
  navigation styling does not grant access to accounts, payments or trading actions.
- Real current-task events prove destination indicators clear after success, failure, Stop,
  cancellation, reconnect and account/context changes. Idle never displays fabricated work.
- Real database/HTTP grouping tests cover duplicate events, ordering, separate executions,
  concurrent tabs, restart, per-user dismiss/read state, source retirement and permission loss.
- At least three supported source types populate the shared view through their owning adapters.
  Check producer completion, queue admission, grouping and presentation independently. A morning
  report test uses read-only fixtures; it does not place trades to manufacture dashboard activity.
- Real surface-bridge/browser tests open an item, load details, draft into a supported field,
  preserve manual edits, reject stale targets and return to the dashboard. Outbound submission
  remains a separate explicit action and is not part of routine fixture tests.
- Installed acceptance records the actual serving versions, visible source coverage and native
  browser workflow. Fixture results alone do not establish that live source reporting works.

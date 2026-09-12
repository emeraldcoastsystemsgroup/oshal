# Jarvis and the daily dashboard

Requested 2026-09-11. Status: **backlogged; implementation has not started**.
This work continues the cockpit landing request and the existing briefing and surface-context
work. It does not interrupt the current parallel implementation batch.

## Product direction

Provide one useful daily page with application updates and a compact Jarvis conversation area.
The user can scan what changed, open a specific item, and work on it with Jarvis while keeping
the relevant details visible. Jarvis should not occupy the entire page by default. Keep the
complete application directory available as a separate view of all applications.

The supplied screenshots show overlapping text around the eye, a long repetitive Kalshi
queue, extensive empty space, a crowded row of assistant controls, and fixture/probe cards
mixed into Home. The user also reports persistent Engineering activity and missing morning
trade updates. These are reported symptoms; their runtime causes still need reproduction.
Do not infer that a displayed activity indicator proves a tool was actually dispatched, or
that another application's lack of updates proves its producer ran successfully.

## Work order

| ID | Priority | Deliverable | Done when |
|---|---|---|---|
| JDX-01 | P1 | Repair text overlap and activity feedback; replace the dominant eye with a compact assistant presentation. | Idle, listening, thinking, speaking and stopped states are distinct. Only actual current work animates a destination, and completion/cancellation clears it. Long text, resizing, zoom, theme changes and open detail panels never cover controls or other copy. |
| JDX-02 | P1 | One compact daily dashboard with Jarvis, attention items and recent updates. | The initial page shows a bounded, useful summary with progressive disclosure, useful empty/unavailable states and an accessible All applications view. Setup details and developer fixtures do not crowd the personal default. Pinned applications and per-user choices survive reload. |
| JDX-03 | P1 | Group related alerts and retain a readable activity history. | Repeated updates are grouped by source and topic, with a count, latest meaningful change and expandable history. Replayed events do not inflate unread counts. Distinct executions or decisions remain distinguishable. Read, dismiss, snooze and resolve have explicit separate semantics and durable user state. |
| JDX-04 | P1 | Adopt the briefing contract beyond Kalshi, beginning with morning trading reports and communications. | Each supported producer registers its source, queues an exact-owner result after actual completion and honors preferences. The dashboard identifies source, timestamp, freshness and whether attention is required. Missing connectors, disabled sources and failed collection remain visible as such. Actual production and delivery are tested separately. |
| JDX-05 | P1 | Context-aware navigation and editable drafts beside an update. | From an update, the user can open its authorized application/record, ask Jarvis to navigate or fill supported fields, inspect the changes and continue editing. The surface acknowledges applied operations; unsupported or rejected operations never produce a false completion claim. |
| JDX-06 | P1 | Simplify the assistant controls and prove the complete daily workflow. | Text and voice share a clear composer, Add has an attachment purpose, Stop appears during active work, and New, history, language and appearance controls have predictable locations. Closing/minimizing retains the defined draft/history state. The end-to-end browser and installed-source acceptance below passes. |

Start with JDX-01 and a reviewable JDX-02 layout. Then implement grouping and source adoption;
extend context actions against that shared page. The existing full response stage can remain
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

These are planned acceptance cases. Add actual executable suites and their existing AI Test Lab
registrations with each implementation slice; do not register placeholders as runnable tests.

- Real browser layout checks at desktop and mobile widths, 200% zoom, both themes, long text,
  keyboard navigation, reduced motion and every listening/speaking/cancellation state.
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


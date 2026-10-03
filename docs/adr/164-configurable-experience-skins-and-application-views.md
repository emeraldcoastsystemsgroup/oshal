# ADR-164: Configurable experience skins, shell layouts and audience-specific application views over unchanged backends

## Status

Proposed — 2026-09-25. Records the operator's requested product direction and the proposed
implementation contract. Delivery remains **Planned** in the [roadmap](../../ROADMAP.md).
The linked designs are interactive local prototypes, not installed production implementations.
This ADR does not authorize a backend migration, new permission model, deployment or change to
the default login landing page. No existing ADR is superseded.

**Implementation note — 2026-09-27.** Merged pull requests, not installed acceptance. What they
do is described as built in [experience shells](../architecture/experience-shells.md).

- Core ([emeraldcoastsystemsgroup/oshal](https://github.com/emeraldcoastsystemsgroup/oshal)),
  merged 2026-09-26 to 2026-09-27: #831 *Experience shells render the live swarm and are
  selectable*; #833 *Experience skins reach the cockpit and every themed surface*; #836
  *Classroom hosts the Little Monsters tools in place; homebases paint before work data arrives*;
  #839 *Ribbon profile hides tools per caller; visibility loopback forwards token sessions*; #840
  *Experience presets host application assemblies; hosted pages carry the audience view*; #842
  *Shared audience-view kit; hosted pages are asked for an audience*; #843 *Audience-view kit:
  date-only strings are calendar days; headings by role, not tag*; #845 *Document audience views:
  the shared kit, the ?audience= request and the per-package guards*.
- Store ([emeraldcoastsystemsgroup/oshal-applications](https://github.com/emeraldcoastsystemsgroup/oshal-applications)),
  merged 2026-09-26 to 2026-09-27: #271 *Surfaces follow the chosen skin: shared theme bootstrap
  on 18 pages in 18 packages*; #283 *Little Monsters: the Test Lab catalog parses again; a guard
  now parses it*; audience views in #284 Smart Home 1.2.2 (family), #285 Finance 1.2.3 (family
  and company), #286 Switchboard 0.6.2, #287 Payroll 2.3.4, #288 Payments 1.1.3, #289 Identity
  Hub 1.2.2, #290 CAD Studio 0.2.2 and #291 AI Office 2.12.6 (company); #293 *Document the
  audience-view browser harness in the Test Lab adoption guide*.

## Context

The home-design work explored several ways to experience the same swarm: a workbench, a central
assistant, a hub-and-spoke application view and shared team rooms. It also explored a family
homebase, a Little Monsters classroom and a company workspace.

The operator clarified that a skin can select a materially different application screen. Personal
Finance and Business Finance may have different page structures, visible fields, tables, summaries
and controls, while using the same application backend. These are not necessarily the same DOM
with different colors, nor are they separate Finance products with duplicated business logic.

The governing constraint is **backend unchanged**: reuse existing application services, data,
authorization, workflows and provider connections. When a desired screen needs a capability that
is not already available, identify that dependency explicitly; do not hide new backend work inside
the reskin program or put replacement business logic in the browser.

The program must also cover application interiors. A redesigned home screen that opens unchanged
or incompatible application pages is an incremental shell release, not a completed full UX reskin.

## Existing design references

The [design collection](../assets/experience-shells/index.html) and
[collection notes](../assets/experience-shells/README.md) are the visual starting point. The names in
this table identify existing mockups; they are not newly registered production theme or layout IDs.

| Reference | Appearance and interaction | Intended reuse | Inspect |
| --- | --- | --- | --- |
| **Studio** | Graphite and mint; suite navigation, pinned applications, conversation and work side by side | Workbench shell for focused application work | [Clickable](../assets/experience-shells/studio.html), [desktop](../assets/experience-shells/previews/studio-desktop.png), [mobile](../assets/experience-shells/previews/studio-mobile.png) |
| **Jarvis briefing** | Parchment and ember; assistant-led briefing across application suites | Warm, information-first home layout | [Clickable](../assets/experience-shells/jarvis.html), [desktop](../assets/experience-shells/previews/jarvis-desktop.png), [mobile](../assets/experience-shells/previews/jarvis-mobile.png) |
| **Orbit** | Arctic and cobalt; suite hubs, application relationships and drill-down | Hub-and-spoke navigation; an accessible list remains necessary | [Clickable](../assets/experience-shells/orbit.html), [desktop](../assets/experience-shells/previews/orbit-desktop.png), [mobile](../assets/experience-shells/previews/orbit-mobile.png) |
| **Commons** | Aubergine and lilac; suite rooms, people, specialists and shared work | Room-oriented company or collaborative shell | [Clickable](../assets/experience-shells/commons.html), [desktop](../assets/experience-shells/previews/commons-desktop.png), [mobile](../assets/experience-shells/previews/commons-mobile.png) |
| **Family Homebase** | Cozy home treatment; two parents and two children, shared and personal areas | Household preset selecting different parent and child views | [Clickable](../assets/experience-shells/homebase.html) (`?preset=family`), [parent](../assets/experience-shells/previews/homebase-family.png), [child](../assets/experience-shells/previews/homebase-family-child.png) |
| **Little Monsters classroom** | Playful classroom treatment and package mascot; teacher and learner experiences | Education preset with distinct teacher/student screens | [Clickable](../assets/experience-shells/homebase.html) (`?preset=classroom`), [teacher](../assets/experience-shells/previews/homebase-classroom.png), [student](../assets/experience-shells/previews/homebase-classroom-student.png) |
| **Company swarm** | Professional team treatment; projects, people and personal workspace | Company preset with member, lead and separately authorized Finance views | [Clickable](../assets/experience-shells/homebase.html) (`?preset=company`), [operations](../assets/experience-shells/previews/homebase-company.png), [member](../assets/experience-shells/previews/homebase-company-member.png) |
| **Central assistant / Jarvis** | Dark teal particle core; intent composer; conversation beside a dynamically selected task workspace | Assistant-centered shell and contextual application handoff; `nexus.html` is the prototype filename, not a mandated product name | [Clickable](../assets/experience-shells/nexus.html), [home](../assets/experience-shells/previews/nexus-home.png), [results](../assets/experience-shells/previews/nexus-result.png), [speaking](../assets/experience-shells/previews/nexus-speaking.png) |

The warm Jarvis briefing and dark central-assistant design are distinct studies. Do not collapse
them into one reference merely because both currently use the Jarvis name. The central assistant's
display name is editable in its prototype; appearance does not create a new bot identity.

The homebase implementation uses the fixture theme keys `cozy`, `playful` and `professional` in
[homebase-config.js](../assets/experience-shells/homebase-config.js). They are example visual
configurations, not role grants. Its role switcher is a preview, not authentication.

The [central-assistant notes](../assets/experience-shells/CENTRAL-ASSISTANT.md) distinguish real local
interactions from sample calendar windows, fares and tool stages. Its speaking core reacts to an
actual bundled audio waveform, but the voice is prerecorded, not a live reading of the current
answer. The [homebase validation](../assets/experience-shells/HOMEBASE-VALIDATION.md) and
[full-swarm validation](../assets/experience-shells/VALIDATION.md) document prototype evidence only.

These references are packaged under `docs/assets/experience-shells/`. They moved there from a
local `mockups/swarm-home/` directory on 2026-09-27 with the example person and household renamed
to fictional ones and every preview regenerated by the collection's own checks; its
[packaging notes](../assets/experience-shells/README.md#packaging-2026-09-27) record the runs. A
running loopback preview URL is not a durable architecture reference.

## Decision

### D1. One application backend can serve multiple first-class views

Use one application identity, one existing domain implementation and one authoritative set of
records. Permit multiple named, independently testable frontend views for that application.

Personal Finance and Business Finance are separate views when their structures differ. They share
the application client, existing response contracts, reusable widgets, formatting and action
handlers. A small cosmetic difference should be configuration; a substantially different workflow
or composition may justify a separate view module. Do not force every screen through a giant
conditional component, and do not copy the entire application to create a new audience.

Changing views does not move, duplicate or convert records. A user may use Personal Finance in
one context and Business Finance in another if existing authorization permits both. Selecting a
business-looking screen does not change the caller's identity or silently switch the data owner.

### D2. Keep appearance, shell, application view, preset and authority separate

| Concern | Owns | Must not own |
| --- | --- | --- |
| **Skin** | Colors, typography, spacing, radii, icons/mascot treatment and motion styling | Identity, record access, installation or execution authority |
| **Shell layout** | Global navigation and arrangement of conversation, applications, rooms and result panels | Application business rules or a second orchestration engine |
| **Application view** | App-specific screen composition, fields, columns, widgets and presentation of existing actions | A competing database, API, calculation engine or permission model |
| **Experience preset** | A coherent selection of skin, shell, default application views, labels and home modules | New grants, implicit account connections, enrollment or shared-record access |
| **Personal preference** | Allowed display overrides such as density, visible fields and ordering | Another person's settings or a workspace-wide policy change |
| **Access/data context** | Existing authenticated user, authorized workspace, record ownership and current application capabilities | Anything inferred from the selected skin's name |

An end-user chooser may present a single experience such as **Family Homebase**. Internally it
selects these independent concerns. It may default Finance to a personal view and Learning to a
learner view without forcing those applications to share one page layout.

Do not build the Cartesian product of every app, skin, layout and audience as separate codebases.
Define supported combinations. Reuse a view under several skins where the structure is the same;
add a new view only when the audience experience genuinely differs.

### D3. Freeze backend contracts for the initial delivery

The initial implementation may change browser HTML, CSS, JavaScript, assets, frontend components,
display configuration, tests and documentation. Application frontend assets remain packaged through
the existing application delivery mechanism. It does not change:

- Database schemas, migrations, record ownership or retention behavior.
- Domain API routes, request/response schemas, validation, calculations or transaction behavior.
- Authentication, authorization, tenant boundaries or role definitions.
- Bot identity, provider selection, connector credentials, accounting or dispatch policy.
- Workflow definitions, approval requirements, scheduled execution or user enrollment.

Every proposed field/widget/action must map to an existing authorized application contract. If an
existing capability is unavailable or unconfigured, the UI shows the established setup, denial,
empty or unavailable state. It must not manufacture success or substitute fixture data.

If a required capability cannot be expressed through those contracts, document the exact gap and
keep that module out of the backend-frozen release. Any backend work is a separately approved
dependency with its own acceptance evidence. This ADR is not approval to add it automatically.

Deploying different frontend assets can still require a package release and normal installation
approval. Backend unchanged does not mean no build, versioning, release or rollback work.

### D4. Use package-owned view definitions and shared presentation components

The core owns generic shell mechanics, navigation integration, theme contracts and shared UI
primitives. An application package owns its domain-specific view definitions, frontend adapters,
field catalog and screen tests. Finance views belong with Finance, not as hardcoded Finance logic
inside the core shell. This preserves [ADR-085](085-remote-app-packages-and-registries.md).

Use the existing application surface and supported packaging schema for the first views. A
frontend view registry is a bounded map of known IDs to shipped components and mappings; it is not
a new server-side plugin loader. Do not silently add manifest keys or dynamic backend registration
to implement this proposal.

The rendering path is: existing authorized application response → shared application frontend
adapter → selected application view → shared components and skin. Several views consume the same
adapter. Mutations return through existing application action handlers and endpoints.

A view definition should identify its owning app, stable view ID, frontend compatibility version,
supported layout/density, known component slots, field IDs and existing action IDs. References must
resolve to shipped allowlisted definitions. It must not contain executable user-supplied code,
arbitrary HTML, arbitrary network URLs, credentials or invented permissions.

Illustrative frontend configuration, **not an implemented API, accepted manifest extension or
document that can be PUT into the current Home preferences endpoint**:

```json
{
  "schemaVersion": 1,
  "experienceId": "company-default",
  "skinId": "professional",
  "shellLayoutId": "commons",
  "appViews": {
    "finance": {
      "viewId": "business-overview",
      "viewVersion": 1,
      "density": "comfortable"
    }
  }
}
```

These IDs describe the proposed design vocabulary. The first implementation must establish its
actual registered IDs and map only already supported app fields/actions; the example grants no
Finance access and contains no owner or tenant override.

### D5. Resolve presentation without replacing route or ownership authority

Resolution is deterministic:

1. Resolve the existing authenticated context and authorized application through current platform
   navigation. Preserve explicit `?app=` and valid existing deep links.
2. Load the approved experience's display defaults, or platform/package defaults when none exist.
3. Choose the app's preset view or an explicitly requested, supported view for that same app.
4. Apply allowed personal display overrides, retaining any existing app-color opt-in preference.
5. Render only supported components from authorized responses; the server still validates every
   read and action independently.

An explicit view ID is a presentation request, never authority. Unknown or incompatible cosmetic
choices fall back visibly to a compatible default or the original application view. Unauthorized
data access stays denied; it must not fall back to a broader data scope.

Do not persist a selected app name in a new browser preference that overrides bare `/cockpit/`.
The existing URL contract remains authoritative. This program does not replace the existing login
landing behavior with mandatory Jarvis; the new experience starts as an explicit opt-in.

Keep the current owner/workspace context visible when it matters, especially in Finance. Any
existing context-switch operation remains separate from changing appearance. Cancel or invalidate
stale requests on context changes; never reuse another identity's cached result because the view
ID happens to match.

### D6. Different fields are presentation, not different business semantics

The following examples are design requirements to map during the pilot, not claims that every
named field or report is already implemented:

| Application | View A | View B | Shared contract |
| --- | --- | --- | --- |
| Finance | Personal view emphasizing personal accounts, spending and available household-budget information | Business view emphasizing already supported business-account, expense or reporting information; denser tables and different columns | Same Finance identity, supported records, calculations and action APIs; no new invoice/accounting service implied |
| Little Monsters | Learner view with the user's own requirements, work and progress | Teacher view with authorized class requirements, review and class-level controls | Existing class membership, assignment operations and learner privacy |
| Calendar | Personal/family presentation of already shared or personally owned events | Company presentation of already authorized team events and work periods | Existing calendar records, provider scope, time zones and update semantics |
| Engineering | Focused individual project and tool view | Team-oriented review and project-status view | Same supported project/artifact operations and existing membership boundaries |

A view may omit optional fields or use a different visual emphasis. It cannot omit information
necessary for an informed action, remove a mandatory confirmation, reinterpret currency/units,
turn unknown into zero, or relabel a private record as shared. Display the same canonical value for
the same record under every view, with formatting and labels appropriate to the audience.

Hidden fields must not be cleared when a shorter form is saved. Reuse existing partial-update or
form semantics; preserve required fields, validation messages and concurrency behavior. Do not
guess defaults to satisfy an API or add full-record writes that erase fields absent from the view.
If the existing contract cannot safely support the simplified edit, retain the established editor.

Necessary operations remain reachable, even when moved into a detail panel or secondary action.
The default view's complete functionality is not silently lost to a cleaner design. Approved
audience-specific omissions must be explicit in the coverage matrix.

### D7. Reuse the theme and embedded-surface lifecycle

Extend the current theme system rather than introduce a competing global theme manager. Share
semantic tokens and component styles, and preserve intentional application branding where allowed.
The same view must work embedded in the shell and through its supported standalone entry point.

The shell's CSS does not automatically style an embedded document. Migrate package surfaces through
the existing theme bootstrap/inheritance mechanism and test nested pages, dialogs, charts and
editors. Avoid reaching through frames to rewrite arbitrary application DOM.

Preserve routing, browser history, artifact handoff, draft state, keyboard focus, app assistant
visibility and frame teardown. Changing a skin must not reconnect a provider, resubmit a mutation,
start a bot or discard unsaved work. Warn or preserve safely before any layout change requiring a
destructive remount of local form state.

### D8. Keep central-assistant presentation separate from execution

The Jarvis design is a frontend over the existing accountable assistant and application tools, not
a new orchestrator. Reuse conversation identity, current authority, tool receipts and existing
app/artifact navigation rather than inventing a parallel chat store or tool-execution rail.

Render supported result types through known components: calendar availability, comparisons,
documents, artifacts, source details and application handoffs. Never execute arbitrary generated
HTML or JavaScript to make a dynamic workspace. Free text remains escaped or safely rendered through
the established content path.

Show actual states: clarification/setup needed, running, partial, ready, failed and cancelled.
Activity describes observed tool actions, not private reasoning. A summary and its rendered cards
must refer to the same result set and context. Stale completions from a cancelled or newer request
cannot reopen an old workspace. Distinguish opening an application from saving, sending, booking
or scheduling something inside it.

The Vegas example remains a fixture until the already available calendar and Travel contracts are
mapped and exercised together. Existing Travel search alone does not prove calendar availability,
nor does a calendar without access mean a free weekend. If an adapter or result contract is missing,
record that dependency instead of calling the journey a finished skin.

For the speaking core, reuse the current voice path and vendor-neutral interfaces. Connect to the
actual playback signal where available. If only speech lifecycle events are exposed, use and label
lifecycle animation rather than claiming amplitude synchronization. Do not capture the microphone
to obtain a visualization signal. Support explicit stop, replay where applicable, transcript,
reduced motion, audio failure, page hiding and cancellation. Particle animation must not be needed
to understand status or block ordinary keyboard/text interaction.

### D9. Persistence and shared publishing must respect the backend freeze

Use existing preference contracts only for the fields and ownership scopes they actually support.
The current Home preferences route validates a bounded display schema; it is not a generic
workspace-experience store. Unknown keys must not be hidden inside that schema or repurposed into
an unrelated setting.

Initial experience definitions may ship as versioned frontend assets. For display options without
an established server storage contract, explicitly support session-only preview or a scoped local
device preference, with its persistence limitation visible. Store no sensitive application records
or permission grants in that preference. App selection still follows D5's URL rule.

The desired later configuration experience is choose → preview → apply/publish → restore. If a
current supported service can safely persist the required workspace definition, reuse it after
verifying scope, revision conflicts and history. If not, shared multi-user publishing, cross-device
synchronization and durable version restoration are a separately approved configuration dependency,
not an unannounced database/API change in the first reskin delivery.

When shared publishing is supported, only the already authorized configuration owner may publish.
Preview must not write live settings. Show changes, refuse stale revisions, retain personal display
overrides according to a documented merge policy, and restore presentation without restoring revoked
permissions or previous data. A preview-as-role UI is not a way to impersonate another user.

### D10. Existing access and workflow policy always wins

- Only the existing authorized administrator may install applications. A preset can suggest an
  application or show setup status, but selecting it cannot silently install or enable it.
- Parent, teacher, employee and lead labels are presentation context, not grants to bank records,
  another learner's progress, payroll or administrator functions.
- Hidden fields are not a confidentiality boundary. Test direct HTTP reads and actions under the
  existing policy; do not download unauthorized data and merely hide its component.
- A household/team-looking calendar or shopping list does not establish record sharing. Reuse
  proven sharing semantics, or leave the unsupported module out of scope.
- Workflow approval changes remain explicit Workflow Studio authoring/publication. Switching
  skins, views or presets never changes approval behavior.
- Existing user/source ownership, batch enrollment and optional participation remain independent.
  Restoring a visual preset cannot re-enroll a user or start a scheduled process.

This preserves [ADR-036](036-bot-owned-application-architecture.md),
[ADR-149](149-enterprise-application-authorization.md) and existing application enforcement.
No new access model is introduced by this decision.

## Current implementation seams to reuse

These are source-grounding points, not a claim that the proposed view/preset system is implemented.

| Seam | Existing source | Reuse boundary |
| --- | --- | --- |
| Portal and application theming | [theme-manager.js](../../src/pages/cockpit/js/theme-manager.js), [surface-theme.js](../../src/shared/ui/js/surface-theme.js) | Saved appearance, app-color opt-in, transient app skins and embedded-surface inheritance; not arbitrary layout publishing |
| Shell and surface lifecycle | [app.js](../../src/pages/cockpit/js/app.js), [view controller](../../src/pages/cockpit/js/cockpit-view-controller.js), [RibbonNav.js](../../src/pages/cockpit/js/components/RibbonNav.js) | Keep route, frame, chat and artifact behavior while replacing presentation |
| Authorized navigation | [navigation routes](../../src/app/routes/workspace-navigation-routes.ts), [navigation authorization](../../src/app/composition/application-navigation-authorization.ts) | Continue using existing discovery/admission; display configuration is not trusted as authority |
| Home facts and preferences | [Home plan](../../src/features/swarm-apps/services/app-home-plan.ts), [Home preferences](../../src/app/routes/app-home-preferences.ts), [Home model](../../src/pages/cockpit/js/views/app-home-model.js) | Reuse owned facts and bounded hide/order/compact choices; do not claim support for arbitrary shared experience documents |
| App packaging and artifact context | [ADR-085](085-remote-app-packages-and-registries.md), [ADR-139](139-artifact-exchange-send-to-registry.md) | Keep app-domain code in its package; preserve established artifact ownership and handoff |
| Existing voice surface | [chat UI](../../src/pages/chat/ui/chat-app.ts), [voice browser exports](../../src/features/voice/browser/index.ts) | Reuse the voice integration available to the chosen production surface; the prototype's sample is not a production voice service |

The [impact study](../assets/experience-shells/RESKIN-IMPACT-STUDY.md) records additional Finance,
Little Monsters, Shopping, Smart Home and connector-tenancy inspection. Its proposed shared
configuration document is design intent, not existing backend support. D3 and D9 constrain the
initial delivery more narrowly than that broader study.

## Delivery plan and release boundaries

| Phase | Work | Required exit evidence |
| --- | --- | --- |
| **0. Inventory and contract mapping** | Map actual application entry points, existing field/action contracts, audience variants and supported skin/layout combinations. Record current working journeys and known failures. | A bounded pilot matrix; every proposed widget maps to a supported contract or an explicitly deferred gap; measured baseline and named owners |
| **1. Shared foundation and first front door** | Reuse theme/navigation infrastructure; implement shared controls and the opt-in central-assistant shell; initially retain existing app interiors. | Working authenticated navigation/chat, mobile/keyboard behavior, cancellation and return to the original UI; no backend contract changes |
| **2. Representative view pilot** | Build Personal and Business Finance views, teacher/learner Little Monsters views, and a representative dense engineering journey using available capabilities. | Distinct real screens over unchanged services; identical canonical values; correct existing write/permission behavior; component reuse demonstrated |
| **3. Presets and additional shell layouts** | Compose Family, Classroom and Company defaults; evaluate Studio, warm Jarvis, Orbit and Commons using the same components. Add only supported view/layout pairings. | Each included preset/layout has an explicit acceptance matrix; persistence limitations and excluded capabilities are visible; no copied domain backend |
| **4. Remaining application interiors** | Migrate high-use and reusable-template surfaces, then bespoke editors, games and secondary/core tools. | Every inventoried surface is migrated, deliberately retained, out of scope or blocked with a reason; no unexamined screens hidden behind a new home page |
| **5. Installed acceptance and rollout** | Exercise scoped real deployments, register tests, roll out by opt-in and prove rollback. | Installed evidence for the declared scope, permission-negative checks, usable rollback and reconciled documentation |

These are increments, not authorization to ship incomplete screens as finished features. Phases
may overlap only where contracts and file ownership are clear. Package-domain work and core-shell
work must be coordinated independently through the existing shared-worktree process.

The first release does not have to contain every mockup. Each release states which layouts,
application views, presets and surfaces are supported. Unselected alternatives remain available as
design references rather than acquiring fabricated shipped status.

## Impact and estimation model

Estimate the **shared program plus incremental view/layout work**, not a full application rewrite
per skin:

> Shared foundation + reusable application adapters/components + distinct application views +
> distinct shell behaviors + skin/preset configuration + regression and installed acceptance.

Personal and Business Finance count as separate implementation/testable views when their structure
differs, but their shared client, widgets and actions are estimated once. A new color treatment on
the same view is less work than a new app screen. A room-based shell or spatial navigator carries
interaction and accessibility work beyond styling. A new backend capability is estimated outside
this program's frozen-contract scope.

The earlier conversation used the following **provisional planning assumptions**, not measured
delivery velocity, approved budgets or promises:

| Scope discussed | Planning range | Interpretation |
| --- | --- | --- |
| Shared styling and initial Jarvis/home shell | 2–3 engineer-weeks | First front door, not all app interiors or every shell layout |
| Priority application-journey release | 4–8 engineer-weeks total | Bounded pilot reusing existing services; distinct audience views must be inventoried |
| Full inventoried browser-UI migration under a backend freeze | 14–26 engineer-weeks total | Shared-program planning envelope, not a cost multiplied by each skin; all unique layout interactions have not been separately estimated |

The [broader impact study](../assets/experience-shells/RESKIN-IMPACT-STUDY.md) used 6–12 engineer-weeks
for its multi-preset pilot and 16–30 for its full browser program, including configuration work that
may exceed this backend-frozen scope. Do not combine these ranges or present their differences as a
measured saving. Net-new sharing, location or orchestration capabilities were separate there too.

The operator's clarification about genuinely different audience screens adds a view-count dimension
that was not fully sized. Re-estimate after Phase 2 using actual effort per reusable component,
distinct view, layout and regression case. Do not multiply elapsed-time promises by agent count.

Use the generated [surface inventory](../assets/experience-shells/reskin-inventory.json) and its
[inventory script](../assets/experience-shells/inspect-reskin.cjs), not a hand-maintained current app
count. It is a dated static scan, not a count of unique reachable screens or live-accepted apps.
Refresh before planning; include secondary documents and document excluded native/private/external
surfaces explicitly.

## Verification and completion criteria

Prototype screenshots and newly passing fixture tests establish design behavior only. Production
completion requires all applicable levels below; unavailable environments are reported, not silently
converted to a pass.

### Contract and application parity

- Compare old and new views against the same authorized records, stable identifiers and backend
  responses. Verify canonical values, date/time-zone/currency formatting, supported pagination,
  filters, loading, empty, error and partial states.
- Exercise real disposable database/HTTP/browser paths for application operations. After an edit
  in either view, reload and read the persisted result from the other view. Prove hidden fields and
  unrelated record values are not cleared or changed.
- Preserve existing request schemas, validation, revision/conflict behavior, confirmations,
  workflows and action outcomes. Verify that switching appearance alone causes no business mutation.
- Review the implementation diff for unapproved backend/schema/policy changes. Record any existing
  contract defect as separate work instead of changing it to make the new UI test pass.

### Context and permission boundaries

- Use separate authenticated sessions for permitted and denied users, not a client-side role
  dropdown. Include other-owner and other-workspace attempts, direct HTTP access and stale-context
  completions. The selected skin/view must not affect authorization outcomes.
- Verify personal Finance remains private; a company view only displays already authorized business
  data; students cannot fetch classmates' private work; teachers remain limited to authorized classes.
- Verify admin-only installation, workflow approvals and optional enrollment remain unchanged.
  Presentation restore must not restore grants, consent or scheduling state.

### Navigation, presentation and accessibility

- Preserve deep links, back/forward, reload, direct standalone entry, embedded entry, supported
  artifact handoff, conversation context, forms and unsaved drafts.
- Test each distinct application view's complete functionality. Test each shell's unique behaviors.
  Cover supported skin/view/layout combinations with visual and interaction checks; use a documented
  representative combination strategy for reused components rather than pretending every possible
  permutation was exercised.
- Include desktop and narrow/mobile layouts, keyboard-only use, focus restoration, readable contrast,
  zoom, reduced motion, long/localized text and failure-state legibility. Orbit navigation must have
  a non-spatial route to the same supported applications.
- Measure page load, interaction responsiveness, memory/frame lifecycle and animation cost against
  the existing UI on representative devices. Set pilot budgets from that baseline; do not invent
  performance numbers from a screenshot. Pause offscreen motion and avoid repeated data fetching
  from cosmetic changes.

### Assistant and configuration acceptance

- Connect the new shell to real authorized conversation/tool results for its claimed journeys.
  Exercise setup needed, partial failure, cancellation, late result and permission revocation.
  Fixtures remain explicitly labeled and separate from installed evidence.
- Validate response-to-view mappings, source information and application handoff. A spoken completion
  or animated particle state does not prove an application action succeeded.
- Verify audio start/stop/end/failure and reduced motion for the actual production voice path, not
  only the prerecorded demo. No microphone request solely for animation.
- For each supported persistence mode, test reload and scope. If shared publishing is included via
  an approved existing service, also test simultaneous edits, stale revisions, unauthorized authors,
  apply/restore, retained personal overrides and unavailable configuration storage.

### Test manager, release evidence and rollback

- Register executable production scenarios in the existing core test manager/Test Lab catalogs and
  the owning package's `tests/test-lab.yaml` as appropriate. Attach runnable unit/integration/browser
  regression references, update local test commands and verify discovery. A file on disk alone is
  not registration.
- Retain existing functionality tests and add regressions for the new view/layout failure shapes.
  Do not weaken old assertions to match a simplified screen or claim stub-only data as live proof.
- Record the exact tested release, environment, selected experience/view, identity scopes, actions,
  persisted outcomes, screenshots and exclusions. Complete operator-approved installed checks before
  marking the declared production scope shipped.
- Keep the original UI reachable until replacements have parity. Roll back compatible frontend
  assets/display selection without reverting business records, approvals, permissions or enrollment.
  Prove old routes still work and in-flight drafts have a safe handling path.

The roadmap item is complete only for its explicitly declared coverage matrix. A shell pilot may
ship independently; it does not close application views or layouts that remain unmigrated.

## Alternatives considered

| Alternative | Decision |
| --- | --- |
| Global CSS replacement only | Insufficient: cannot express genuinely different Personal/Business or teacher/learner screens and does not migrate embedded documents by itself |
| Separate application/backend per audience or skin | Rejected: duplicates domain behavior and records, multiplies fixes and violates the unchanged-backend constraint |
| One universal screen with conditionals for every audience | Not the default: use configuration for small differences, but separate composed view modules when structure or interaction differs |
| Rewrite the UI framework and backend together | Out of scope: no requirement or demonstrated need for that expansion in this decision |
| Arbitrary generated pages for assistant responses | Rejected: use allowlisted components over validated results, preserving application authority and testability |
| Ship every application under every shell/skin combination immediately | Rejected as an implicit requirement: define supported combinations and phase them, while preserving the original route for retained surfaces |

## Consequences

- Users can experience the same application differently at home, school and work without requiring
  duplicate backends or moving their data between look-alike products.
- Shared adapters/components reduce duplicated frontend behavior, but distinct screens still need
  design, implementation, maintenance and acceptance. More than one skin does not mean free work.
- Presets make setup approachable while keeping appearance independent from current authority.
- The unchanged-backend constraint bounds risk and permits frontend rollback, but it also limits
  which mockup features can honestly ship in the initial release.
- Package ownership and existing navigation/theme seams remain authoritative. The core does not
  become a collection of special cases for individual business applications.
- Coverage and compatibility become explicit deliverables. The full UX is not finished merely
  because the entry page is attractive or prototype assertions pass.

## Implementation choices to settle in the pilot

The product direction is recorded; these choices refine implementation rather than reopen whether
audience-specific views are allowed:

- Final launch names and approved first skin/layout; keep existing prototype alternatives referenceable.
- Exact Personal/Business Finance fields and actions available through current contracts.
- Supported layout/view compatibility and the minimum complete pilot journeys.
- Existing preference storage that can be reused versus clearly labeled device/session-only options.
- Exact production assistant/result/voice integration points and unsupported cross-app journeys.
- Measured performance budgets, migration effort and the release-by-release surface matrix.

Changes to backend behavior, permission policy or shared persistence beyond existing contracts
require separate explicit approval. They are not implicit implementation details of this ADR.

## Amendment — experiences are applications (operator, 2026-10-02)

**Status:** Proposed amendment; slice 1 implemented, slices 2–3 in the backlog.

### Context

The cockpit header carries an **Experiences** menu (Studio, Jarvis, Orbit, Commons, Home · family,
Little Monsters · classroom, Business · company swarm, Central assistant) as hardcoded links in
`src/pages/cockpit/index.html`; the shells live in core `src/experience/` and their presets in
`homebase-config.js`. Every signed-in person on every deployment gets the same menu. On the
G-Squared dev droplet a plain CRM rep could open the operator cockpit from the logo link or the
focused rail's platform hub and find the first-run strip, Workflow Studio, Optimizer, Budgets and
an Explore-apps directory of 54 installed packages, most answering 403.

The operator's direction: an experience is an **application** — a new application installed on
the portal that exposes the experience with a few screens of its own, requires the other
applications it composes, and, with the classic toolbar hidden, shows just its own screens;
experiences are skins that define new and join existing swarm functionality and display it
differently from the out-of-the-box swarm layout. The core swarm is the simple UX; experiences
are deployments on it.

### D11. An experience is a package with an `experience:` block

A developer builds an experience as an ordinary store package (ADR-085): its own screens under
`ui/` served by its routes, its skin as `ui/<id>.css`, its members as `dependencies` (required /
optional tiers), its own authorization catalog (who may **open** the experience), and the ADR-145
`summary:` probe. The new manifest block, behind the kernel skill `experience` (the compatibility
floor, so an older core refuses the package instead of ignoring the block):

```yaml
uses: [application-authorization, experience]
experience:
  version: 1
  entry: /api/home-swarm/app     # the package's own full-page screen
  shell: page                     # page = no rail, hub or logo door; rail = the focused ribbon of its own tiles
  skin: family                    # ui/family.css shipped by the package, or a core theme id
  label: Home
```

The core owns the shell mechanics only (D4): rendering `entry` full-bleed under `shell: page`,
applying the skin, hosting member surfaces in same-origin frames with `?audience=` (D6), the
`app-navigate` message contract, and the data seams members already expose (home-plan, `summary:`
probes, `GET /api/ui/profile?name=<member>`). Member data keeps flowing through the members' own
routes and catalogs; the experience grants nothing (D10).

### D12. Discovery is installation × authorization; the operator cockpit is an operator experience

The switcher, `/portal` and the header list only experiences that are **installed** and that the
caller can **discover** (`canDiscover`, the rule every application already follows). The plain
`/cockpit/` rail and the core-resident entry pages are the operator's experiences and are offered
to operators. One discoverable experience → no switcher and no door. A deployment therefore needs
no flag to be "a single product": a CRM-only install shows the CRM to its staff because that is
the only experience they can see.

### D13. Shell modes and skins are declared, not URL hacks

`shell: page | rail` replaces the `?kiosk=1` approximation (which also hides a package's own
bottom tiles). A packaged skin is registered by the `experience.skin` declaration and offered by
the switcher; `EXPERIENCE_THEMES` stops being a hardcoded list. The built-in presets (Home,
Business, Classroom) and the core entry pages become the first experience packages.

### Delivery slices

1. **Shell lock (implemented with this amendment).** On a deployment whose landing names an
   application (`LANDING_PATH` / `HOST_APP_MAP` → `/cockpit/?app=<name>`), a non-operator is
   redirected from the plain cockpit document and every experience entry page to that landing
   (`src/app/experience-shell-lock.ts`, `cockpit-static-routes.ts`), and the ribbon withholds the
   platform hub, repoints the logo and hides the Experiences menu (`RibbonNav.js`, inputs on the
   `/api/ui/profile` response). Operators, focused `?app=` requests, assets and deployments without
   a focused landing are unchanged. This is D12 for the degenerate case of one experience, not a
   per-deployment flag. Done when: the `experience-shell-lock`, `cockpit-shell-lock-routes` and
   `ribbon-shell-lock` specs are green and a throwaway non-operator on a focused-landing box is
   redirected from `/cockpit/` and `/portal`, sees no hub and no Experiences menu.
2. **The experience contract.** `experience:` block + `experience` kernel skill + loader
   validation; `shell: page`; packaged skin registration; the switcher and `/portal` built from
   installed, discoverable experience packages; `GET /api/swarm/apps` and `/applications`
   discoverable-only for non-operators; developer documentation with a worked example package.
   Done when: a package with only the block above installs, appears in the switcher for a caller
   holding its role and not for one who does not, renders full-bleed in its skin, and the
   hardcoded header links are gone.
3. **Built-in experiences become packages.** Home, Business, Classroom, Studio, Jarvis, Orbit,
   and Commons ship as experience packages (reference implementations); Nexus retains its current
   behavior outside the approved seven-experience migration; `src/experience/`
   keeps only shell engines. Done when: the core cockpit lists no experience it did not install.

Changes to backend behaviour, permission policy or shared persistence remain outside this
amendment, as the ADR states.

## Delivery amendment — seven application experiences (operator, 2026-10-03)

**Status:** Approved delivery direction; declaration validation implemented; package hosting,
discovery, composite-role assignment and installed migration acceptance remain pending.

Scope is Studio, Jarvis, Orbit, Commons, Home/Family, Classroom and Business. Nexus and Simple
chat are preserved outside this migration. The Finance and Education packages are the hosting
baseline: package-owned screens, existing manifest profiles/ribbon, member dependencies and
caller-filtered navigation. Add only demonstrated platform gaps, not another navigation engine.

[The integration contract](../architecture/experience-application-integration.md) records the
source/surface inventory, required/optional dependency decisions, supported member-surface
references, direct-entry/discovery boundaries, operational UX and E1–E6 release criteria.
Experiences remain ordinary applications; member screens, data and resource permissions remain
in their owning packages. Home uses a distinct `home-experience` package; `home` remains Smart Home.

The manifest loader now validates declared experience shape, owned authenticated entry paths,
authorization-catalog declaration and explicit member references. The `experience` compatibility
floor is deliberately not registered until hosting/discovery exist; these checks must not be
misreported as runnable experience packages. Packaged-skin registration remains an E2b deliverable.

Composite-role lifecycle follows the corresponding ADR-149 delivery amendment. The approved
work may extend assignment persistence for provenance and reviewed template upgrades, but does
not change the member applications' resource-sharing policy or bypass their current catalogs.
No human assignments are created by installation, audience selection or household membership.

Home is the reference pilot, then Business, Classroom, Studio, Jarvis, Orbit and Commons. Each
release requires actual installed browser/API/database acceptance and cleanup receipts. Keep the
existing extended-UX backlog open until that evidence exists; preserve preview/gallery styling
while running pages use compact operational headings and useful source-backed status.

E2b implementation now registers the `experience` compatibility floor, resolves named member
surfaces at activation and synthesizes existing focused profiles, with member visibility retained.
The installed experience list and open route use current authorization, require a named
`app.open` entry binding and refuse policy outages or a changed installation. Portal and cockpit
choices consume discovery; package palettes use the existing theme hooks. Local tests cover two
packages, distinct callers, denied entry and private installation scope; the full-swarm browser
suite passes 36 cases. Deployed acceptance, composite assignments and the seven package releases
remain separate open gates in the integration contract.

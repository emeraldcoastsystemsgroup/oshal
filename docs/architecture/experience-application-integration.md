# Experience application integration

Approved delivery scope: **Studio, Jarvis, Orbit, Commons, Home/Family, Classroom and
Business**. Nexus and Simple chat retain their current behavior. This implements the
operator's approved plan and subsequent direction to use Finance and Education as the
application-hosting baseline.

## Delivery status

| Packet | Current state | Completion evidence |
| --- | --- | --- |
| E1 inventory and contracts | Source inventory and delivery contract recorded here | The tables below identify source owners and migration gates |
| E2a declaration validation | Implemented in `src/shared/experience-contract/`, called by the manifest loader | `tests/unit/experience-package-contract.spec.ts` |
| E2b hosting and discovery | Deployed; all seven packages installed | Actual enforce-mode install/update/uninstall/reinstall, authorized discovery, entry refusal and package chooser checks pass; source fixtures separately cover distinct callers and private scope |
| E3 composite roles | Deployed; installed lifecycle checks pass | Atomic assignment and reviewed optional-member upgrade, durable retry receipts, deny precedence, overlap-safe revoke, actual expiry, restart persistence and PostgreSQL RLS refusal checks pass |
| E4 Home pilot | Released and installed | Selected required and optional member screens open; a temporary unpriced list note persists across reload and is removed; existing Smart Home and Education IDs and records are preserved |
| E5 remaining six | All six released and installed | All seven entries pass desktop, phone and keyboard checks; named member views, the package chooser and preserved Central assistant/Simple chat are exercised through the real signed-in browser |
| E6 installed acceptance | Installed checks pass; final cross-user privacy acceptance remains open | Seven installed contract suites and seven real-cookie readiness checks pass; source/version/retry/cleanup, restart, overlap, expiry and final fixture cleanup are verified. Final contextual sidebar wording is deployed and browser-verified. A second real authenticated non-admin identity is qualified; privacy checks await the reviewed boundary fixes and coordinated deployment |

The `experience` compatibility floor now supplies package hosting and discovery:
`GET /api/ui/experiences` lists active scope-visible packages under current authorization;
`GET /api/ui/experiences/:name/open` checks the named entry operation and refuses a
changed installation before redirecting. Page entries use package routes; rail entries
reuse the existing focused cockpit profile. The portal and cockpit menu consume this
catalog. Discovery failure offers no static fallback. Installation and deployed acceptance
are separate gates. The seven packages are released; the remaining E6 items below
keep overall acceptance open.

### Installed verification recorded on 2026-10-03

The seven packages were updated to **1.0.1** through the standard installer with
enforce-mode verified audit stamps. The fresh main-only store checkout preserves all
seven audited package trees and source ancestors, and the normal store gate reports
87 passes with no failures, partial results, skips or blocked checks. Updates preserve
existing assignments exactly; installation creates no role grants.

Actual deployed verification uses core `1782dfb5757ae3fb2132e6bac905cb23631f97d5`.
Its standard rollout passes all 37 app-container health checks, parity verification,
assistant response and ticket dispatch. Seven installed contract runs preserve exact
source/version and execution revisions, reuse the same run for a retried request and
verify runner cleanup. Seven readiness cards pass through the existing authenticated
browser cookie session. PAT forwarding is deliberately unavailable for this smoke
transport. The fourteen external source-fixture cards remain explicitly pending in
the installed runner; they are not counted as live acceptance passes.

All seven desktop, phone and keyboard entry checks were recorded on the 1.0.0
packages; the 1.0.1 update changes readiness bindings and package contracts, with
entry UI bytes unchanged. Updated Business/Classroom context controls and Orbit's
phone/keyboard behavior were also checked on the deployed revision. Existing member
views, Central assistant and Simple chat remain available under their own authority.

Actual restart verification preserves catalogs, assignments, receipt retries and
test history, with all 36 bot containers unchanged. The first check refused an empty
catalog before autoload settled; recovery compares the saved before-state and final
container identity. Because the original snapshot omitted Docker StartedAt, its
restart provenance is qualified as a bounded restart-window correlation.

Final cleanup removes only the owned temporary composite, direct and deny fixtures
and the temporary Home note. Entry refusal is verified again with zero install
grants. Smart Home/Education IDs and exact digests of 19 existing Education/tenant
tables are unchanged.

The final contextual sidebar/access wording is deployed on core
`8c1891ef615747c480f943b07fe9657be1b5c44f`. The real browser verifies Home,
Business and Classroom captions, search labels, phone layout and keyboard focus
restoration. The rollout finishes with all 37 containers healthy, clean parity and
zero API restarts. A transient startup health/Access Review stall and the first
ticket-probe timeout are retained as failed observations; after recovery, the full
standard live gate passes bot-role authority, Jarvis and ticket dispatch on the
unchanged release, without redeployment, timeout changes or skipped checks. The
brief caption-verification assignments are removed, and zero grants plus strict
data preservation are verified again.

One acceptance item remains open: exercise cross-user privacy on the corrected
deployment. The verified directory and recent authentication logs qualify an
existing non-admin identity; no additional account is required. Source fixtures,
the primary operator session and database RLS checks do not substitute for the
actual cross-user acceptance.

The `experience-roles` floor requires migration 185 and the existing Access management
authority. `GET /api/authorization/composites` lists current readable templates and
redacted lifecycle records. The same-origin JSON endpoints `/composites/preview` and
`/composites/apply` bind every constituent to one reserved review and one durable policy
transaction. Ordinary apply cannot split the set. Receipts survive restart; revocation
removes only that assignment's provenance, including retired installation edges.
The Access screen supports explicit optional choices, expiry, member review, existing
approval references, reviewed edits/upgrades and revocation. Unknown apply outcomes retain
the idempotency key for receipt retrieval. The registered Test Lab metadata probe is read-only;
it does not stand in for installed package/lifecycle acceptance.

## Existing mechanisms to reuse

- Finance's `ui.static`, package-owned main page, `ribbon` policy and optional member
  application tabs. Its dependencies explicitly distinguish an absent optional tab
  from failure of its own application.
- Education/Little Monsters' package-owned pages, dynamic class navigation and
  caller-filtered `/api/education/class-tool-keys`. Actual teacher/student permissions
  and roster rules remain in Education's catalog and routes.
- ADR-141's required/optional dependency reader and member/surface resolution; an
  experience remains an ordinary application because it owns routes and screens.
- ADR-145 summaries and existing readiness probes; no duplicated domain database.
- ADR-149 authorization runtime and audited access workflow. Navigation visibility
  cannot establish record authority.

## Seven-experience source inventory

This is an inventory of the current source, not a deployed database inspection.
Member lists below identify current composition; final required tiers are determined
by the minimal journey in each package. Dynamic app catalogs are resolved from installed
manifests, never frozen into a permanent list of applications.

| Experience / proposed package ID | Existing entry and implementation | Package-owned features to migrate | Current member integration |
| --- | --- | --- | --- |
| Home / `home-experience` | `/homebase?preset=family`; `homebase.html`, `homebase.js`, family preset | Home/calendar/shopping/people/personal/routines navigation; Room/Tasks/Files; household, check-ins, assistant and display preferences | Smart Home (`home`), Purchasing, Finance, Little Monsters, Movies, Spotify, Travel, Presentations |
| Business / `business-experience` | `/homebase?preset=company`; company preset | Overview/projects/calendar/people/personal; assistant, search and front-page arrangement | Presentations, Email Summarizer, Calendar, World, Finance, Switchboard, Social, Calling Assistant, Marketing Engine, Venture Plan, Capture CRM, Payroll, Payments, Identity, CAD Studio |
| Classroom / `classroom-experience` | `/homebase?preset=classroom`; `/little-monsters` alias | Classwork/class calendar/personal/community; teacher/learner layout and assistant | Little Monsters, Presentations, Circuit Lab |
| Studio / `studio-experience` | `/studio`; `studio.html`, `shell.js`, `shell-panels.js`, `full-swarm.js`, `live-views.js` | Suite catalog and pins, selected workspace/summary, conversation and operational panels | Caller-admitted installed application catalog and the selected application's profile/summary |
| Jarvis / `jarvis-experience` | `/jarvis`; `jarvis.html`, same shared engines | Assistant briefing/conversation, work views, application panels and agenda | Existing Jarvis, tickets, schedules and admitted member applications |
| Orbit / `orbit-experience` | `/orbit`; `orbit.html`, same shared engines | Suite/application map, inspector, relationships, focus and operational panels | Installed catalog, viewer-scoped app detail/dependencies/assistants and member profiles |
| Commons / `commons-experience` | `/commons`; `commons.html`, same shared engines | Suite/Game rooms, pins, room conversation, work board, household/team and roster | Installed catalog, Jarvis threads, work items, tenant membership and permitted directory reads |

All seven IDs above have released and installed 1.0.1 packages; the remaining E6
acceptance items are recorded above. `home` continues to
mean Smart Home; `little-monsters` continues to mean Education. Neither is renamed.

### Homebase surface and authority matrix

All three homebases use `homebase-config.js`, `homebase-modules.js`,
`homebase-data.js` and `live-data.js`. Every configured module is covered below.

| Surface / module | Current owner and seam | Scope and actions | Migration disposition / dependency |
| --- | --- | --- | --- |
| `room`, `tasks`, `files`, assistant | Jarvis history/ask/results; tickets and tasks through live adapter | Caller-owned work and artifact handoffs; existing approval/cancel boundaries | Retain shared transport; package owns layout and labels |
| `calendar` | Education calendar through live adapter; Business additionally uses Calendar's summary | Authorized personal/class calendar reads; no audience-derived sharing | Retain existing supported source first; calendar replacement needs explicit parity proof |
| `shopping` | Purchasing routes through live adapter | Add/complete items under Purchasing's existing ownership rules | Home minimal journey; Purchasing required in the pilot |
| `people`, `family-admin` | `/api/tenants`, `/:id/members`; household creation | Current tenant membership/administration; never imply Finance or Education authority | Retain; membership effects are enforced by the owner |
| `personal` | Finance reads or Education student dashboard; Business's drafts fallback | Own money, authorized learner records, own drafts; teacher/learner distinction comes from real roles | Optional member capabilities, explicit unavailable state; no automatic parent access |
| `locations` | Location state/device opt-out in `homebase-data.js`, existing reporter | Owner-consented location, authorized visible places; opt-out only through existing control | Optional; preserve Smart Home/location lane's independent boundary |
| `home-facts` | Smart Home facts via existing live adapter | Current Smart Home API authorization; no new actuation right | Optional member; no handler/catalog changes in extraction |
| `routines` | Jarvis briefings and `/api/v1/agent/schedules` | Caller schedules; enable, pause/resume and existing briefing preference writes | Retain platform APIs; no provider selection logic |
| `requirements` | Little Monsters classwork, checklist, calendar | Teacher-created work and admitted learner/class data | Classroom requires Little Monsters; real teacher roster remains required |
| `roster` | Education class activity/teacher analytics | Teacher/admin plus owning class rules | Retain; hidden from learners and refused through APIs |
| `projects` | Tickets and workflow detail | Existing caller visibility and approval operation | Retain; package owns summary and navigation |
| `apps` / hosted screens | Active catalog, `/api/ui/profile?name=...`, caller-filtered tool visibility | Member discovery/open plus each route/resource rule | Replace `hiddenTools` prefixes with supported named surfaces incrementally |
| `updates` | Existing work/education notice adapters | Caller-visible notices; Education mark-read action | Retain real source; absent Education is unavailable, never invented notices |
| Business summary cards | Email Summarizer, Calendar, Presentations, Capture CRM, Payroll, Calling Assistant `summary:` | Owning application's caller-scoped probe and deep link | Optional independently failing cards; sensitive app access explicitly selected |
| Search | `/api/search`, plus local matching over current snapshot | Existing scoped search results only | Retain; package search must not widen the global search authority |
| Display preferences | Existing device storage and theme helpers | Personal presentation only | Retain device-only semantics; no implied shared preferences |

### Full-swarm surface and authority matrix

| Surface family | Existing seam / owner | Migration contract |
| --- | --- | --- |
| Catalog, suite rooms, pins, launch/focus | Home plan, admitted navigation, active apps; local pins | Dynamic member selections reference installed manifests; pins confer no access |
| App inspector, relationships, assistants | Viewer-scoped `/api/swarm/apps/:name`, dependency tiers and declared assistants | Preserve redaction and 404; absence from caller's catalog is not proof of uninstall |
| Hosted application panels | Caller-filtered UI profiles and member iframe routes | Member-owned screens; supported audience hint; navigation/return retain context |
| Work board, ticket/task dialogs, workflow | Current tickets/tasks/workflow adapters | Preserve approval and owner-checked cancellation; status labels share current canonical mapping |
| Schedules and briefings | Caller schedules and Jarvis preferences | Preserve existing administration bounds and pending/running behavior |
| Tenant workspace / roster | Tenant membership and user directory | Preserve administrator/scope refusals; do not invent presence or public team membership |
| Engineering/administration interiors | Existing kernel/application views rendered by `live-views.js` | Keep operator checks and owner APIs; package composition does not copy those backends |
| Conversation, voice and results | Shared Jarvis transport, voice routes, artifact relay | Retain caller propagation; consume ADR-173 provider contract when published |

Existing source coverage is listed in [experience-shells.md](experience-shells.md),
including layout/browser, homebase/data, front-page, dependency-tier and shell-lock suites.
Store page/view browser coverage uses `scripts/audience-views.browser.cjs` and package
`tests/audience-view.fixture.cjs`. Preserve runner sources before installed acceptance;
ephemeral screenshots or a page sweep do not close the extended acceptance backlog.

## E2 package and hosted-view contract

```yaml
name: home-experience
uses: [application-authorization, app-dependencies, experience]
authorization: {version: 1, catalog: authorization.yaml}
dependencies:
  required: {apps: [purchasing]}
  optional: {apps: [calendar, finance, little-monsters, home, presentations]}
experience:
  version: 1
  entry: /api/home-experience/app
  shell: page
  skin: family
  label: Home
  surfaces:
    - {app: purchasing, surface: purchasing-home, audience: family}
```

This is a contract sketch, not an installable package: routes, authorization bindings,
actual Purchasing surface name, assets, summary, readiness and Test Lab declarations
must be resolved from their owning packages before publication. The `surface` value
above is illustrative; it must not be assumed to exist in the current member manifest.

- `entry` is a canonical same-origin document inside a package-declared session route.
  Page mode opens the package's full-page screen; rail mode uses the existing focused
  profile/ribbon. Own route catalogs enforce direct entry as well as menu entry.
- `surfaces` references `ui.static[].toolName` in explicitly declared member packages.
  Activation resolves required references against active manifests; an absent optional
  member omits its surface and reports an unavailable reference without failing the experience.
- Package-owned skins use existing theme hooks. A stylesheet declaration/registration
  must resolve only to package-owned assets; layout defaults must not overwrite a
  person's saved appearance. `experience.skin` selects the palette; an optional
  package-owned `ui/<skin>.css` uses the existing theme route and profile theme hooks.
- Discovery uses active installation, scope visibility and current `canDiscover` for a
  verified issuer/subject. Resolution failure refuses discovery, not static fallback.
  Opening independently checks `app.open`; cached discovery never authorizes a route.
- Replace core header/portal lists only once package discovery is usable. Legacy entries
  redirect to installed authorized packages; revoked/uninstalled landing preferences
  fall back to the admitted chooser or a useful no-access page. Keep focused shell lock.
- Reuse `app-navigate` messages, same-origin validation and existing profiles. An
  audience, theme or density value is presentation. Member apps own unsaved-work handling,
  field visibility, action support and their unsupported-view fallback.
- Installation, configuration/readiness, authorization and display selection remain
  separate states. Installation and membership create no human access assignments.

## E3 composite-role assignment contract

Extend `package-grant-plan.ts` and the existing access workflow. The current
`already-granted` classification recognizes a broad access tier; it cannot prove a
specific template role or record scope. Do not reuse it as an exact-role comparison.

A template is a versioned package declaration mapping a named experience role to
explicit member catalog role IDs. Labels such as Household adult/child/guest,
Teacher/learner/administrator, and Staff/manager/specialist are proposed UX names.
Only Education's actual `student`, `teacher` and `admin` role IDs were verified in
this inventory; each remaining mapping needs its actual catalog. Legacy tier-only
members require an explicit migration/adapter decision, not invented catalog roles.

1. Choose person/group, experience, template and authoritative scope. Optional members
   are explicitly selected. Display actual role/permission/scope changes and refusals.
2. Check assigning administrator authority for every affected application, current
   subject and tenant membership, explicit denies, approval and separation-of-duty rules.
3. Bind review to template digest/version, package/catalog revisions, policy revision,
   target issuer/subject, scope and selections. Recheck before apply; stale review refuses.
4. Use an idempotency key and one atomic authority transaction where possible. If the
   existing batch cannot provide that, persist and expose a recoverable partial result;
   never display a partially applied composite as complete.
5. Persist a composite assignment and its constituent grant-source edges. Effective
   access is the union of independent/composite sources, subject to existing denies.
   Revocation removes only this source; shared and independent grants survive.
6. Template upgrades produce a reviewed diff, including optional and sensitive access.
   Existing assignments stay on their pinned version until reviewed migration. Removing
   or disabling an app cannot silently retarget a template to another role.
7. Expiry, disabled subjects and membership loss retain the existing effective-access
   checks. Audit plan, approval, apply/partial recovery, upgrade and revocation without
   storing private business records in template metadata.

Resource sharing remains in the member owner: parent/child, teacher/class and manager/team
relationships do not imply Finance, school or location access. ADR-149 remains the policy
engine. Schema/migration paths are claimed only when implementation starts.

## E4–E6 implementation and acceptance sequence

1. Finish E2b host/skin/discovery and developer example with two installed synthetic
   experience packages. Exercise session/PAT identity, anonymous and denied direct paths,
   revoked access, optional absence, required reference failure and landing fallback.
2. Implement E3 preview/apply/revoke/upgrade over real catalogs and database boundaries.
   Cover wrong-role existing grants, overlapping composites, independent grants, denies,
   stale review, catalog drift, retries, expiry and interrupted apply recovery.
3. Extract Home into `home-experience`, reusing its design and member views. First prove
   Purchasing add/complete/reload, core household/work navigation, then each optional
   Finance, Education, calendar, check-in and document capability independently.
4. Home acceptance identities: adult, child, guest and unrelated user, each with explicit
   catalog assignments and authoritative relationships. Prove API/database refusals as
   well as browser behavior. No production member grants are needed for synthetic tests.
5. Migrate Business, Classroom, Studio, Jarvis, Orbit and Commons in that order. Each
   package needs owned entry/roles, dependencies, readiness, operational copy and acceptance.
6. Register/run package Test Lab cases and the existing extended desktop/mobile/browser
   sweep. Verify persisted-data parity, deep links, drafts, keyboard/accessibility, revoked
   access mid-session and slow/failed member APIs. Measure Home request/render costs before
   assigning performance budgets to later packages.
7. Record deployed core/package revisions and cleanup/expiry receipts before changing
   roadmap/backlog status to complete. Rollback preserves member records and unrelated grants.

Operational headings prioritize Today, Today's Schedule, Recent Work and Applications.
`Top Items Today` is reserved for a real attention list: authorized overdue/due-today or
human-action-required records, ordered deterministically with owner deep links. A renamed
hero alone does not implement that list. Preview/gallery designs remain reference assets.

## Source acceptance and coordinated release

All seven packages own an entry, configuration, layout assets, skin, own app.open
catalog, readiness and Test Lab declaration. Home requires Purchasing; Classroom
requires Little Monsters. Business uses optional named members. Studio, Jarvis, Orbit
and Commons read the existing dynamic admitted catalog and grant only their own host
role; selecting a suite, room, pin or application does not assign member access.

Source checks: 21 package contracts, 14 actual loader/mounter/policy lifecycle checks,
15 package browser cases and 26 wider Homebase regressions passed. Browser evidence
uses owned package documents over synthetic member APIs; runtime evidence uses the
actual source package and existing authorization machinery. These checks do not claim
installed household/school/business API or database parity. Core PostgreSQL lifecycle
checks separately prove durable receipts, forced RLS and atomic provenance.

Legacy entry and raw legacy HTML routes now redirect through the corresponding
installed package open operation. Seven alias/lock checks and the registered Test Lab
probe cover this transition. The Lab probes actual package entries; missing packages
remain deployment gaps. Nexus, Simple and shared authenticated assets retain their
behavior. Source templates remain for the gallery and explicit renderer fixtures.

Before rollout, the live bind-mounted cockpit document stays aligned with the current
backend. The new dynamic menu is preserved at the published core revision and is
restored only with coordinated backend/package availability. Do not add an outage
fallback that silently serves an unadmitted experience.

Core hosting PR #937 and the later composite lifecycle, operational UX, alias and
chooser changes are merged after independent exact-source reviews and normal gates.
All seven audited 1.0.1 package sources and evidence are released and installed.
The final normal store gate passes all 87 checks with zero failures, partial results,
skips or blocked checks, using disposable Linux/PostgreSQL/physics prerequisites.
No skip acceptance or hook bypass was used. Actual deployed verification, installed
Test Lab results, lifecycle boundaries and cleanup/preservation are recorded in the
delivery status above. Final privacy acceptance remains open. Subsequent route
assessment confirmed unscoped cockpit ticket streams, global escalation reads and
project discovery, plus focused-shell refusal gaps. These core repairs require
independent source review, merge, coordinated deployment and the second real
authenticated non-admin check before the experience work is complete.
Additional route findings from the stopped audit await its fact-checked handover;
the three confirmed repair areas above do not close that broader assessment.

Cockpit private reads use the verified owner, recorded issuer and current protected
result authority. Streams recheck each event and heartbeat and close on refusal.
Project discovery includes only admitted ticket/task records for ordinary callers;
the global registry and escalation list require an operator. Activity details admit
each contributing child and canonical task before exposing messages, counts or
costs. Their costs come from admitted persisted tasks; unqualified direct SQL ticket
totals cannot establish every contributor's read authority and are omitted on this
surface. This can reduce displayed totals when task usage is absent; it does not
change the underlying spend records.

Historical work items correlated only by a unit string are withheld when no
canonical ticket establishes their owner and current result access. A matching
unit name alone cannot authorize output. The regression preserves direct admitted
legacy work and protected work with valid execution lineage; it does not claim
that every historical unit-only fallback remains visible.

The isolated HTTP regression is `tests/unit/cockpit-private-reads-http.spec.ts`,
registered in the protected remote application execution Test Lab scenario and
`npm run test:remote-authorization`. Synthetic authentication and isolated policy
fixtures prove source behavior; they do not replace live non-admin privacy evidence.

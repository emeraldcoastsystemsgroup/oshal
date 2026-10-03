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
| E2b hosting and discovery | Pending | Two installed experiences, distinct authorized callers, refused direct entry, dynamic menus |
| E3 composite roles | Semantics specified; assignment implementation pending | Exact-role preview, provenance, overlap-safe removal and reviewed upgrades |
| E4 Home pilot | Pending; operational headings updated in the existing runtime | Installed household journeys and negative API/database cases |
| E5 remaining six | Pending | Individual package releases and acceptance receipts |
| E6 installed acceptance | Pending | Deployed revisions, fixture cleanup and registered Test Lab results |

E2a deliberately does **not** register `experience` as an available kernel skill.
The current core refuses an experience package until E2b provides its hosting and
discovery semantics. A manifest block must not advertise features this runtime ignores.
Validation is not installation or authorization proof.

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

The IDs above are reserved by this plan, not published packages. `home` continues to
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
  member produces an unavailable tile without failing the experience.
- Package-owned skins use existing theme hooks. A stylesheet declaration/registration
  must resolve only to package-owned assets; layout defaults must not overwrite a
  person's saved appearance. Final packaged-skin schema is part of E2b.
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

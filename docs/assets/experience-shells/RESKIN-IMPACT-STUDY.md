# One platform, three homebases — UX reskin impact study

Assessment date: 2026-09-25. Scope: local source inspection, a reproducible inventory, bounded existing tests, and three standalone design prototypes. No production source, accounts, grants, installation or deployment changed.

## Recommendation

Build **one configurable experience layer**, not three forks of the product. Family, classroom and company are starting configurations over the same authenticated application platform. Keep the four earlier layout directions available as design choices; do not multiply every app into a separate implementation for every audience.

The user-facing setup can be simple: choose a homebase, invite people, review app access, choose a look, preview each person's experience, then publish. That simplicity needs a versioned configuration and permission-aware data sources underneath. A skin alone cannot implement sharing or security.

The highest-value first release is a consistent home, navigation and a few priority application journeys. A complete reskin of every deep application screen is a larger second program. Do not call the shell-only release a full UX migration.

## Clickable examples delivered

- [Family Homebase](homebase.html) (`?preset=family`, the default): two parents and two children; shared calendar and shopping list; independent opt-in whereabouts; personal Finance for parents and independent learning for children. Switch Alex → Jamie → Mia → Leo. Alex is explicitly the swarm administrator; being a parent alone is not administrator authority.
- [Little Monsters](homebase.html) (`?preset=classroom`): a teacher publishes requirements and sees their class's progress; students see the same requirements but their own checklist/submission. The actual package mascot is reused. The lighter lilac treatment is a proposed skin, not a claim to match all current production screens.
- [Company swarm](homebase.html) (`?preset=company`): shared projects and calendar, private workspaces, a lead review action, and Finance only for the separately granted operations user. Administrative and business-data permissions remain distinct.

Use **Configure home** as the example administrator/teacher to change visual skin, density and optional modules, publish a local preview version, then restore. Changing appearance never changes the role or data capabilities. Classroom configuration illustrates a scoped class-layout permission; it does not grant installation authority.

All members, events, money, check-ins and activity are fixtures. “Preview as” is not authentication. Every fixture is bundled in the page code, so hiding a module proves presentation only, not confidentiality. No location device, account or assistant is connected. The classroom is a small illustrative group, not a claim about deployed class size.

## What is already there

| Existing source seam | Evidence inspected | Reuse and limitation |
| --- | --- | --- |
| Shared theme system | [theme-manager.js](../../../src/pages/cockpit/js/theme-manager.js), [surface-theme.js](../../../src/shared/ui/js/surface-theme.js) | Twelve core theme IDs, saved portal preference, optional app colors, transient package skins, same-origin iframe inheritance and stale-load guards. Reuse these rather than introducing another unrelated theme manager. They recolor documents; they do not define arbitrary home layouts. |
| Application shell/profile | [app.js](../../../src/pages/cockpit/js/app.js), [cockpit-view-controller.js](../../../src/pages/cockpit/js/cockpit-view-controller.js), [RibbonNav.js](../../../src/pages/cockpit/js/components/RibbonNav.js) | Profile-selected surfaces, default view, assistant/chat visibility and embedded tool documents already exist. Preserve routing, deep links, artifact handoffs and frame lifecycle while replacing chrome. |
| Authorized navigation | [workspace-navigation-routes.ts](../../../src/app/routes/workspace-navigation-routes.ts), [application-navigation-authorization.ts](../../../src/app/composition/application-navigation-authorization.ts) | Server-side discovery and initial-surface admission are available. Reuse them; a role-specific menu is not a substitute. Browser workspace selection must remain validated, not trusted as authority. |
| Configurable Home | [app-home-plan.ts](../../../src/features/swarm-apps/services/app-home-plan.ts), [app-home-preferences.ts](../../../src/app/routes/app-home-preferences.ts), [app-home-model.js](../../../src/pages/cockpit/js/views/app-home-model.js), [app-home-daily.js](../../../src/pages/cockpit/js/views/app-home-daily.js) | App-owned summaries, bounded metrics, hide/order/compact preferences, caller ownership and optimistic revisions exist. The present preference schema contains display choices, not household/class/company preset definitions or access grants. A shared versioned experience config needs a new explicit contract. |
| Household/org connector tenancy | [connector-tenancy.ts](../../../src/app/routes/connector-tenancy.ts), [connectors-routes.ts](../../../src/app/routes/connectors-routes.ts) | Household/space/org membership and personal versus shared connections exist. This does not establish a universal sharing model for all application records. Avoid duplicating identity or inventing a second household system. |
| Little Monsters | [manifest](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/little-monsters/oshal-app.yaml), [authorization catalog](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/little-monsters/authorization.yaml), [education-access.ts](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/little-monsters/src-routes/education-access.ts), [assignment routes](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/little-monsters/src-routes/education-assignment-routes.ts), [calendar routes](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/little-monsters/src-routes/education-calendar-event-routes.ts) | Teacher/student/admin roles, tenant/class membership, assignments, private learner views and class calendars are concrete reuse points. Do not replace their checks with a generic “teacher” string. Parent access to a child's school records needs an explicitly supported relationship; it is not established by household membership. |
| Finance | [home-summary.ts](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/finance/src-routes/home-summary.ts) | Current summary reads use the authenticated user's subject for saved links, balances and transfers. Reuse for each parent's personal view. A jointly shared parent dashboard needs its own explicit, tested record-sharing decision. |
| Smart Home | [home-routes.ts](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/home/src-routes/home-routes.ts) | Device, scene and caller schedule routes exist. That inspected surface does not itself prove a family location service or collaborative household list. These require a separate source/acceptance assessment. |
| Shopping | [purchasing home-summary.ts](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/purchasing/src-routes/home-summary.ts) | Saved lists and pending items exist, with caller `user_sub` queries. Reuse the Shopping app rather than create a parallel shopping engine; inspect and extend its sharing contract before displaying another family member's list. Checkout handoffs are not purchases. |

The earlier configurable Home delivery document is useful history, not the sole current status source: current manifests declare more summaries than its original execution record. This assessment reads present source and records the limited tests actually run below.

## Size of the migration

The reproducible [inventory script](inspect-reskin.cjs) reads marketplace manifests and source files without modifying either repository. Its [captured output](reskin-inventory.json) records the exact revisions, capture time and per-package counts.

| Static inventory | Count | What this does and does not mean |
| --- | ---: | --- |
| Marketplace entries | 62 | Catalog scope, not 62 live-accepted installations. |
| Declared static UI surfaces | 157 | Manifest entries; not necessarily 157 unique HTML files or distinct visual implementations. |
| Package HTML files | 144 | Tests, vendor and node_modules excluded; includes nested tools, games and secondary documents. |
| HTML explicitly referencing shared theme bootstrap | 66 | Text scan for `surface-theme.js`; other pages may use custom synchronization, shared CSS or host injection. |
| HTML containing literal hex colors | 126 | Review indicator only. Logos, charts and deliberate brand colors can legitimately use literals. Not 126 proven theme failures. |
| Manifests declaring a theme | 38 | Declaration coverage, not proof every nested screen inherits correctly. |
| Manifests declaring Home summaries | 53 | Existing adapter seam, not proof of freshness, suitable role views or correct sharing for these presets. |
| Manifests declaring an authorization catalog | 3 | Specific declaration format only; **does not mean all other apps are unprotected**. Existing route/auth/ownership checks require separate review. |
| Core page HTML / CSS files | 46 / 51 | Additional shell, admin, tool and shared-page work beyond store packages; not a screen count. |

Snapshot anchors: core `d6491f19d782812cc2b4d52f9f71ce4b19c157c7`; store `5d3b55d30945835d4c0d09fd0ef552dbdd6f98b3`. Other work was active in both workspaces; these are commit anchors for a working-tree inspection, not a claim of clean release trees. Private-store apps, remote/native clients, emails, exports and provider-hosted screens are outside the measured inventory.

One important example: Little Monsters has 27 HTML files and no literal reference to the canonical bootstrap in this scan, but `tools/my-day.html` has its own parent-theme observer. Its manifest requests `little-monsters` and bundles education CSS. Therefore the task is to consolidate and verify theme behavior, **not** to conclude that none of its screens supports themes. The current host theme manager also makes app colors optional; new presets must not silently override that saved preference.

## Proposed configuration model

Keep four concerns separate:

| Concern | Examples | Authority |
| --- | --- | --- |
| Visual skin | Color, typography, radius, spacing, mascot, motion | Allowlisted theme assets; no business permissions. |
| Experience preset | Family/class/company labels, navigation, widgets, landing page | Versioned workspace configuration, scoped administrator permission. |
| Personal preferences | Pin/order/hide, density, optional subscriptions | Authenticated user-owned preferences; never change another user. |
| Data/access policy | Household membership, teacher-class relationship, app permission, per-record sharing | Existing server policy plus app-specific checks; evaluated at read and action time. |

Suggested **new**, not currently implemented, experience document:

```json
{
  "schemaVersion": 1,
  "preset": "family",
  "skin": "homebase-sage",
  "workspaceId": "server-validated-workspace",
  "revision": 4,
  "modules": ["shared-calendar", "shared-list", "opt-in-checkins", "personal-apps"],
  "audienceLayouts": {
    "parent": ["calendar", "shopping", "checkins", "personal-finance"],
    "child": ["my-learning", "calendar", "shopping", "checkins"]
  }
}
```

Audience layout names are presentation selectors, not grants. The server intersects a requested module with current capabilities and record scope before returning data. Even an administrator cannot give themselves private banking/student records merely by adding a widget.

Recommended precedence: safe platform defaults → chosen workspace preset → allowed role layout → personal display preferences. Access denial always wins. Skin rollback restores presentation only; it must not undo consent, membership or policy changes. Use optimistic revisions, a preview/diff, audit history and an explicit publish/restore operation for shared configuration. Preserve personal overrides through preset upgrades with a documented merge policy.

Installation remains a separate swarm-admin operation. A preset may suggest apps and show readiness, but publishing it must not silently install packages, connect accounts, enable batch jobs or run workflows. Shared batch jobs need per-user opt-in, source ownership and idempotency; absence of enrollment means no execution for that user. Editing an approval workflow in Workflow Studio remains separate from skin/config publication.

## Work packages and effort

These are engineering estimates from this inspection, **not measured delivery velocity or a fixed bid**. Units are focused engineer-days at five days/week. Assumptions: approved designs, reuse existing platform/auth, no framework rewrite, no deployment surprises, no new provider integrations, and a bounded pilot of roughly 8–12 priority journeys. Confidence is medium-low until a three-screen migration spike; allow about ±40% variation. Parallel engineers do not eliminate policy, review and acceptance dependencies.

| Incremental work package | Engineer-days | Completion boundary |
| --- | ---: | --- |
| A. Shared tokens, shell, components, three visual skins | 6–10 | Header/nav/cards/forms/dialogs, inherited app skin, responsive layout, default preference retained. This is a shell reskin, not all deep screens. |
| B. Experience configuration and setup | 10–18 | Versioned workspace presets, invite/access-review flow using existing identity, personal overrides, scoped publish/restore, route/context preservation. |
| C. Three preset homes and priority app adapters | 8–15 | Family/class/company modules from already supported sources; unavailable/setup states for absent capabilities; 8–12 end-to-end journeys. |
| D. Authorization, accessibility and pilot release evidence | 8–14 | Disposable multi-user database/HTTP/browser acceptance, negative cases, visual checks and phased rollout/rollback. |
| **Usable three-preset pilot (A–D)** | **32–57** | About **6–12 engineer-weeks** of effort, before net-new family capabilities below. |
| E. Remaining package surfaces: token/component/layout migration | 30–60 additional | Triage all 157 declarations, reuse repeated templates, migrate nested pages and package-specific controls without breaking function. |
| F. Remaining core/admin/tool surfaces | 8–15 additional | Consistent navigation, data-dense tools, exceptions documented. |
| G. Expanded visual/functional regression and staged rollout | 8–15 additional | Cross-theme, role, viewport, standalone/embedded and failure-state coverage; installed release proof. |
| **Full inventoried browser UX (A–G)** | **78–147 total** | About **16–30 engineer-weeks**; excludes unmeasured private-store/native/external experiences. |

Likely additional capability budgets, only if gap assessment confirms they are missing:

- **Collaborative household list/calendar adapters and explicit record sharing:** 8–15 engineer-days. Existing shopping/calendar providers are not automatically a multi-user household contract. Avoid duplicating their source of truth.
- **Location/check-in capability:** 15–30 engineer-days for a bounded consented foreground check-in experience with membership, timestamps, expiration, revocation and failure handling. Continuous mobile/background tracking, native distribution and device power/permission behavior require a separate estimate; not included.
- **Guardian access to school data or joint financial records:** estimate only after defining relationships and checking the owning packages. Do not assume parents inherit teacher privileges or each other's bank records. Review child-facing consent and retention requirements with the product owner; this study does not make compliance claims.

The lower end assumes substantial token/template reuse. The upper end accounts for bespoke controls, iframe/theme differences and regression repairs. Simply applying a global stylesheet is cheaper but does not meet “fully reskinned UX.” A wholesale UI framework rewrite is not required by the inspected seams and is not in these estimates.

## Sequence that reduces uncertainty

1. **Three-screen spike within A:** migrate the same shell plus one token-friendly Finance view, one Little Monsters learner/teacher pair, and one dense engineering tool. Prove theme switching, standalone/embedded rendering, app handoff and keyboard access. Record actual per-surface effort; revise E before committing to a date.
2. **One experience contract:** implement config ownership/revisions and authorized module adapters. No raw CSS/JavaScript in user config. Preserve existing Home preferences and navigation semantics.
3. **Pilot the three presets:** publish a Family, Class and Company configuration against fixture-owned accounts, then explicit operator-approved installed examples. Keep unavailable modules honest. Do not hardcode live/demo totals into production.
4. **Migrate packages in waves:** high-use journeys first, then repeated templates, then specialized editors/games/engineering screens. Package owners retain business logic and schema; core owns shared components/contracts.
5. **Release per workspace with rollback:** optional opt-in first. Revert shell/config/assets without rolling back records or access decisions. Preserve old routes until their replacements have verified parity.

## What must be tested before production acceptance

- Parent A cannot query Parent B's personal Finance; children cannot fetch balances via direct HTTP even if they reveal a hidden widget or alter a URL. Test both same-household and other-household cases.
- Students cannot query a classmate's private progress or publish classwide requirements. Teachers see only currently authorized classes. Revocation takes effect without relying on a refresh or stale UI cache.
- Company membership alone cannot read payroll/finance. App installation requires swarm-admin authority, independently of team/teacher/parent labels.
- Check-in opt-out removes fresh and cached visibility; age/expired/offline/unknown are distinct from “at home.” Never request device location on page load without the chosen consent flow. Recheck recipients when membership changes.
- Shared list/calendar edits persist across separate authenticated sessions; optimistic conflicts, missing sources, duplicates and retries are visible and safe. Single-session demo role switching is not this proof.
- Configure/publish/restore survives reload, rejects stale revisions, refuses unauthorized authors and retains personal preferences. Restoring a layout cannot restore revoked grants or turn opt-in back on.
- Each application journey retains route/deep-link behavior, actions, drafts, downloads, assistant context and loading/error/empty states under all chosen skins. Verify accessible contrast, keyboard focus, reduced motion and 320px mobile layouts.
- Add new production suites to the existing core Test Lab scenarios and owning package `tests/test-lab.yaml`, including negative authorization cases. Execute them against real disposable PostgreSQL + HTTP + browser seams; then perform scoped installed acceptance. Passing a newly fabricated UI fixture is not a feature completion claim.

## Evidence from this assessment

- The source inventory is reproducible with `node docs/assets/experience-shells/inspect-reskin.cjs`. Counts are static indicators, not a full app-by-app audit.
- Existing bounded regression command executed:

  `npx vitest run --no-file-parallelism --hookTimeout 30000 tests/unit/surface-theme-inheritance.spec.ts tests/unit/surface-theme-bundled-skin.spec.ts tests/unit/workspace-navigation-model.spec.ts tests/unit/app-home-customization.spec.ts`

  Result: **90 passed, 1 failed across four files**. The three theme/navigation files passed. One Home customization fixture is rejected because its manifest lacks the concierge now required by the loader. The fixture and loader were not changed in this design lane. This is a current baseline issue to resolve before using the whole Home suite as a release gate, not evidence the reskin is ready or that production Home is broken.
- New prototype browser checks and screenshots are documented in [HOMEBASE-VALIDATION.md](HOMEBASE-VALIDATION.md). They validate the delivered design behavior only.

## Bottom line

The “easy configuration” product direction fits the existing architecture. There is useful theme, membership, authorization, classroom and Home infrastructure to reuse. **The easy part is changing the look; the substantial work is consistent navigation across all surfaces and correctly scoped sharing.** Deliver one experience engine with three presets, prove a bounded pilot, then migrate the remaining surfaces using measured evidence.

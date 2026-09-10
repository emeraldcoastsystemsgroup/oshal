# Configurable App Home — delivery plan

Status: approved direction; implementation in slices. Updated 2026-09-09.

## Product decisions

All authorized installed app boxes are visible by default. The user can hide and reorder boxes, reorder/collapse suites, choose and order available data points, choose a compact box, and restore defaults. Hidden boxes remain available in Customize and in the app launcher. A new app or metric defaults on unless its app provides an explicit metric default. Display preferences never enable a connection or authorize an action.

The hierarchy is page highlights → suite highlights → app boxes → source detail. Highlights are deterministic selections of actual visible app facts, with their origin and a drill-down. Warnings and setup blockers precede ordinary updates. Hidden boxes and hidden metrics do not reappear through highlights. Do not invent cross-domain totals or have an LLM summarize summaries on page load.

Apps own extraction and metric meaning; core owns layout, preferences, bounded rendering and navigation. Every endpoint must be a read of existing records, without backfill, token refresh, AI generation, sending, or dispatch. Unknown/unavailable differs from zero. A saved metric id must retain its meaning through label changes and package updates.

## Full assessment and extraction work

The public store's [app-by-app extraction plan](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/docs/apps/app-home-extraction-plan.md) is the package work ledger. Each entry records source seams, proposed facts, prerequisites, missing collection, slice, and acceptance. It distinguishes source inspection from tested extraction and deployed acceptance. Each new package must be added to this ledger before its summary is implemented.

The private Sales package is assessed separately in its own tree. It must use its existing role-transition/audit model and record visibility rules, not query another CRM. “Today” means business-timezone midnight through now. “Five days” means today and the four preceding calendar dates, explicitly labeled. Cohort conversion uses the same acquired-lead cohort in numerator and denominator; zero denominator means unavailable, and new customers excludes repeat wins. Imported history must be verified before publishing historical rates.

Capability Ideation's installed owner has not yet been located under that name in the inspected manifests. Its required output is persisted, sourced tool/integration discoveries tied to business processes, required connections, evaluation state, and review decisions. Locate the runtime owner before adding an extractor; if no owner exists, specify a new store package. Do not relabel generic engineering tickets as qualified discoveries.

Kernel manifests also need a disposition: Jarvis shows recent completed/requested work; DevOps and Intelligent Operations show actionable incidents; Intelligent Processing shows approvals waiting; Security shows last completed scan and unresolved findings; Workflow Studio and Codex Packer show saved drafts/publish or packing results; OSHAL Engineering and OSHAL Dev show active delivery decisions/results; Person Model shows setup gaps only. These are proposed extraction responsibilities, not shipped metric claims. Each requires the same source, authorization and freshness assessment before implementation; no app-owned SQL belongs in the Home renderer.

## Contract extension (slice 1)

Preserve existing `tilesPointer`/`itemsPointer` behavior. Add optional `metricsPointer` for a bounded selectable metric catalog (maximum 24), each with a stable package-local `id`, label, string value, optional tone, and optional `defaultVisible` (defaults true). Four legacy tiles remain the compatibility view for older renderers. New renderers use the metric catalog when declared, with ids namespaced by owning app. Legacy tiles can still render but cannot promise stable preference identity; new extractors must provide ids.

Failure of a declared pointer must be visible even if another pointer succeeds. Invalid ids and duplicate ids do not become selectable. Fix links are constrained to the declaring app's known static surfaces. Each metric must carry its time window in its label or supporting item; query windows must be selected only from explicitly supported app options in a later slice.

Preferences are stored per authenticated subject in the existing owner-scoped `user_preferences` table, in dedicated Home columns. They contain display ids and switches, never data values, connection secrets or impersonation ids. Updates use an optimistic revision to avoid silent multi-tab overwrites. If loading/saving fails, show the failure; do not claim preferences were saved. Old preferences survive missing apps/metrics; new entries default on. Reset changes display preferences only.

## Ordered slices and done-when criteria

| Slice | Scope | Done when |
|---|---|---|
| 1 — configurable shell + Identity | Contract, saved preferences, suite/app order and visibility, metric selection/order, compact mode, suite/page highlights, Identity extractor | Defaults show all apps; preferences survive reload and remain caller-scoped; failed saves are visible; Identity counts are from accessible connection metadata and distinguish renewable tokens from genuine expiry; browser interaction and source boundaries are verified. |
| 2 — Feeds + Communications | Read indexed Slack state and cached mail digest; Switchboard priority/approval data; social-source labeling | No GET backfills or reasons; unknown freshness remains unknown; one conversation is not duplicated in page highlights; standalone apps still work. |
| 3 — Sales + discovery owner | Private CRM extraction, period options, persistent discovery pipeline assessment | Boundary/timezone/cohort/reimport tests pass; no unsupported history or fabricated discovery counts. |
| 4 — Career + business operations | Career group/member outcomes, Marketing, Payments, Payroll, Print | Approvals and outcomes remain distinct; payment/file production is not described as execution; group members preserve their permission scopes. |
| 5 — Finance + intelligence | Finance, Trading, Kalshi, World, Sports | Paper/live and modeled/observed separated; monetary values and timestamps traceable; source freshness labeled. |
| 6 — Production, devices, tools | Remaining creative/device/lifestyle apps and kernel sources | Every ledger entry either has an assessed extractor with acceptance evidence or a documented launcher/session-only decision; all boxes remain on by default. |

Slices are implementation boundaries, not a claim that unbuilt apps already have metrics. Slice 1 does not fabricate metrics for the rest of the catalog. Source-specific period selectors, independently ordered highlights and semantic cross-app event deduplication follow the first working shell.

## Validation and release

Test preference normalization, default-on additions, stable metric ids, hide/order/reset, no cross-user persistence, revision conflict, unknown data, partial pointer failure, rejected navigation, and highlight exclusion. Exercise the real preference query against PostgreSQL and the existing ownership policy; route doubles alone do not prove isolation. Exercise the Identity extractor through Express and the real connection-access helper with a temporary database fixture. Browser acceptance covers mouse/keyboard editing, reload, reset, a hidden box's restoration, mobile layout, and a failed save.

Ship the plan first, then implement and validate the slice. Keep package code in the store and framework code in core. Version the extractor package/catalog together, validate package and catalog, and preserve audit provenance (no fabricated pass). Record actual checks and limitations in the release section below.

## Execution record

- Plan written before implementation. Full store inventory source seams scanned; individual acceptance remains pending unless explicitly marked otherwise.
- Slice 1 implemented and locally verified: catalog pointers, per-user revisioned preferences, default-on layout, box/suite/metric ordering and visibility, compact boxes, resets, and deterministic highlights; Identity supplies the first selectable catalog.
- Validation: core and staged Identity TypeScript pass; 30 Home unit tests pass; real PostgreSQL under a non-superuser role proves preference RLS and revision conflicts; compiled Identity route proves personal/shared access, renewable expiry behavior, no-secret output and unavailable-source failures. The Chromium harness proves hide/order/reset/reload, keyboard focus, collapsed suites, failed-save rollback, desktop and mobile layouts.
- Acceptance uses mock authentication and seeded records on an isolated local database, not live provider accounts. Production deployment/Identity package installation has not been performed by this slice.
- Store catalog and Identity manifest checks pass. The whole-store audit gate remains red for pre-existing audit-version/binding drift (12 errors in exported origin/main) and additional working-tree line-ending checks; Identity's updated pending record has no validation errors. No pending audit was promoted to passed.
- Slices 2-6 remain planned in the package ledger; time-window selection and cross-app semantic deduplication are not implemented.

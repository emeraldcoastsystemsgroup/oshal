# Enterprise authorization implementation and test backlog

Requested 2026-09-10. Status: **core foundation implemented; enterprise adoption in progress**.
Design: [ADR-149](../adr/149-enterprise-application-authorization.md).

The initial implementation includes the strict imported contract, durable policy/audit, central
screen and typed tools, package HTTP enforcement, verified identity provenance, controller execution
guards, remote-node refusal for protected packages, and an atomic local installer-root ceremony.
See [as-built operation](../security/application-authorization.md). The work-order criteria below
remain the complete enterprise target; foundation completion does not close every row.

AUTH-01 is implemented using `uses: [application-authorization]` as the old-core activation floor.
AUTH-02 and AUTH-07 have a working shared service, UI/tool parity and isolated PostgreSQL/browser
proofs; a sensitive approval workflow, scoped-admin provisioning UI, full audit browsing and catalog
migration tooling remain. AUTH-03 covers local proof-based setup; OIDC and all installer variants
remain. AUTH-04 preserves verified claims and maps exact groups, but live refresh/Graph and tenant
proof remain. AUTH-05 has HTTP/controller checks; protected remote bots are deliberately unavailable
pending a live revalidation protocol. Complete artifact/result/queue enforcement, package business
adapters (AUTH-06/08), provisioning (AUTH-09), and deployed canary/adoption (AUTH-10) remain open.

## Work order

| ID | Priority / owner | Deliverable | Done when / evidence |
|---|---|---|---|
| AUTH-01 | P0 core contract | Shared versioned permission/resource/role/binding contract and strict CLI/runtime validator; canonical identity and decision interfaces; compatibility floor | A fixture catalog validates through both rails; malformed/unknown/duplicate/escaping references fail identically; every entry-point binding is covered; unsupported cores refuse adopted packages. Permission/scope/field tuple semantics and deny precedence have executable contract tests. |
| AUTH-02 | P0 core policy | Durable direct grants, restrictions, group mapping references and policy revisions; reuse existing tier/root/identity stores; adapt governance RBAC into one evaluator; scoped management and explain API | Two users/apps/tenants prove allow, deny, app-tier ceiling, expiry, invalid assignment, revocation and no cross-app grant. Legacy RBAC off, admin, or record ownership cannot bypass declared functions. Database failures refuse affected decisions. Concurrent writes conflict safely and every change has transactional audit provenance. |
| AUTH-03 | P0 installer lane | Env exact-identity or one-use installer root ceremony across local/OIDC, Bash/PowerShell and Kubernetes; replace public empty-store inference | Isolated PostgreSQL race produces exactly one root/account winner; failure rolls back and retries safely; wrong identity/origin/secret and completed setup refuse new claims; pending restart retains original expiry; fresh local registration requires installer proof even with a configured subject; existing root/recovery survives upgrade. No default password or mock enterprise deployment. |
| AUTH-04 | P0 directory lane | Verified Entra identity/membership adapter and directory-group/app-role mappings; preserve external evidence through canonical-local linking | Signature/audience/issuer/tenant boundary is exercised; identical group names/subjects across issuers cannot collide; direct/transitive mode, overage, pagination, stale evidence, disable and provider failure behave as specified. No arbitrary claim URL is fetched; no email-derived privilege. Live tenant proof is separately recorded. |
| AUTH-05 | P0 enforcement lane | Shared evaluator at package HTTP, tools, artifacts and bot/queue boundaries; explicit app-admin fallback for missing catalogs; user-scoped Jarvis feed adapter and registered `swarm_authorization` tool | Raw API and direct/queued/MCP alternatives cannot bypass denial; no schema/defaultTier:admin never auto-grants app admin; malformed schemas cannot use fallback. Typed tool registration restores idempotently, authorized invocation reaches the shared handler, and unauthorized operations/targets stay hidden/refused. Revoked queued work never executes; service credentials never widen user grants. |
| AUTH-06 | P0 core + store adapters | Restricted business-data context; canonical ownership migration; package row/field adapters; protected retrieval/caches/streams/files | Real PostgreSQL tests run under runtime roles with FORCE RLS; cross-user/tenant/team rows, counts, aggregates and restricted fields do not leak, including filter/sort/derived-value inference; writes cannot move records outside scope. Revocation/write ordering is transactionally proven. Swarm admin and user-delegated workers lack automatic business-data bypass. |
| AUTH-07 | P1 core installation + UI | Central Access Administration screen linked from Users/Applications/setup; dynamic user/group/app matrix, fallback grants, explain and shared preview/apply API; atomic catalog lifecycle and expansion review; coordinate TLAB-02/05 metadata/history | New apps/roles appear without UI edits; no-schema apps show app-admin/deny only; screen/API/tool yield equivalent decisions and audited changes. Install/update/reload/disable/uninstall reconcile policy and Lab entries; referenced-definition changes cannot widen grants silently; removed/source-replaced grants cannot revive. Scoped admins cannot alter other apps or swarm roles. Policy revisions/history and concurrent edit feedback are verified. |
| AUTH-08 | P1 store pilot | Disposable reference app, then one real business package with declared functions, fields, record scopes and an approval invariant | Public fixtures prove owned/team/tenant reads, restricted fields and prepare/approve/execute separation. Real package installs its catalog and tests automatically; UI/API/Jarvis proofs pass. App-specific code stays in store; private package names and fixtures stay in their repository. |
| AUTH-09 | P1 provisioning | SCIM user/group lifecycle and disable, then separately scoped on-prem directory adapters | Tenant-scoped credentials, idempotent changes, stable external IDs, membership removal, disabled-user revocation and conflict/retry are proven. Native AD/LDAPS support is claimed only after its adapter and live proof exist. |
| AUTH-10 | P1 release + package owners | Enforced canary, safe rollback floor, local regression command, access review/evidence and package adoption inventory | Pinned core/package/policy revisions pass local and deployed canary tests; rollback cannot run a protected app on an unenforcing core; each adopted package has a coverage disposition. No missing fixture/runner/provider is reported as a pass. |

Dependencies: AUTH-01 precedes the three lanes. AUTH-03 can implement against the root/identity
contract independently. AUTH-04 and AUTH-05 use AUTH-02 interfaces and fixture evaluator until their
integration. AUTH-06 is mandatory before claiming business-data separation. AUTH-07/08 integrate the
lanes; AUTH-10 proves release behavior. SCIM/LDAPS completion is not required to prove the initial
Entra/direct-assignment slice and must not be implied by it.

## Test cases and AI Test Lab registration

The existing Lab now registers **`authorization-management`**, with real isolated suite references and
a read-only live catalog check. `npm run test:authorization` runs the implementation suites locally.
The IDs below remain the more granular **planned enterprise cases**, not separate runnable registrations.
Add each implementation's real suite and Lab registration in the same change. Reuse the current core `SCENARIOS` registry and active
installed-package test catalog. The richer suite runner/catalog follows
[TLAB-01/04](app-test-lab-registration.md); until available, register local suite references honestly
and do not invent a browser endpoint that executes arbitrary shell commands.

Suggested local grouping: `tests/unit/authorization-*.spec.ts` for policy contracts;
`tests/unit/authorization-*-integration.spec.ts` for isolated HTTP/worker/PostgreSQL boundaries under
the current Vitest discovery; browser suites use the existing browser runner. Label the actual level
in Lab metadata even where legacy discovery places integration specs under `tests/unit`.

| Planned Lab ID | Level / fixture | Required assertions |
|---|---|---|
| `authorization-catalog-contract` | Unit + installer fixture | Unknown versions/fields, duplicate YAML keys/IDs, traversal/symlink, missing permission/adapter and overlapping route bindings refuse; CLI/runtime agree; core floor enforced. |
| `authorization-policy-matrix` | Unit + isolated DB | Direct/group grants, explicit deny, legacy tier ceiling, effect/tier consistency, grant expiry, namespace isolation; no-schema fallback requires explicit app-admin grant even with defaultTier:admin; malformed catalog never falls back; viewer cannot mutate through any transport; own-details + team-summary never returns team-details. |
| `authorization-bootstrap` | HTTP + disposable PostgreSQL | Concurrent first account/root claims, wrong issuer/secret, timeout, replay, restart, transaction rollback, existing-root/env precedence, sole-root disable protection and upgrade recovery. |
| `authorization-directory` | Signed OIDC/Graph fixtures | Real token-verification integration rejects wrong audience/issuer; filtered presentation user vs verified claims; canonical/external identity preservation; tenant/object identity link; overage and complete pagination; direct/transitive groups; stale/unknown membership; disabled account. |
| `authorization-http-boundary` | Real Express/router | Ordinary viewer/editor/admin, unbound endpoint, guessed URL, GET/HEAD/POST handling, authenticated non-operator 403, scoped management, app/tenant crossing and resource existence concealment. |
| `authorization-data-scope` | PostgreSQL runtime roles | RLS SELECT/INSERT/UPDATE/DELETE, counts/pagination/aggregates, field projection/write filtering, hidden-field query inference, ownership/team moves, transaction approval invariants, synchronized concurrent revoke/write, connection-context reset and operator separation. |
| `authorization-agent-delegation` | Worker/MCP + deterministic model fixture | Direct and queued actions check original user; direct:false, fake body subject, stolen task marker and raw service credential cannot widen; retry/revocation/result-owner checks; narrowed tool scopes. |
| `authorization-artifact-and-context` | HTTP + deterministic retrieval | Source read and target action checks; no restricted record enters a model prompt/search result/citation/file; caches and conversation replay cannot expose another scope; mutation needs current target rights. |
| `authorization-revocation` | Multi-worker + controlled clock | Local commit invalidates decisions on next transaction; delayed invalidation message cannot preserve grants; old token age never resets; disable a linked user during continuous sub-TTL requests; directory failure cannot erase a deny; streams/results recheck. |
| `authorization-lifecycle` | Installer + Lab | Fresh/repeated install, restart, rejected upgrade, accepted expansion including unchanged-role/referenced-field changes, removal, disable, source replacement and rollback reconcile catalog/grants/tests; history is retained with stale revision labels. |
| `authorization-admin-browser` | Browser + fixture identities | Central screen deep-links from Users/Applications/setup, dynamically renders schema/fallback apps, grants/restricts only within admin ceiling, renders provenance and effective deny, rejects stale previews, prevents self-escalation and never exposes business data through explain. |
| `authorization-management-tool` | Registry + typed executor + HTTP/browser fixtures | Repeated startup/restart registers one working tool family with no duplicate operation descriptors; installed/removed apps refresh its targets; semantic metadata loads into permitted Jarvis feeds. Real invocation and screen/API produce equivalent decisions; unauthorized callers, spoofed actor, arbitrary method/header/endpoint inputs, replay/expired/changed previews, revoked grantor, stale revisions, package replacement and model-only confirmation refuse. Existing AUTO/ASK restrictions hold; missing executor/service is unavailable, never successful registration. |
| `authorization-enterprise-canary` | Explicit live isolated tenant | Actual configured directory login/membership removal, protected fixture app and deployed worker end-to-end; reports provider prerequisites, pinned revisions and measured freshness separately from unit proof. |

Each registration includes owning app/core feature, stable case ID, installed app version and policy
revision, suite path, level, identities/roles, expected allow **and** deny, required runner/provider,
side effects, isolation/cleanup and evidence. Feature test files are not silently omitted from the
catalog because their runner is unavailable. Case IDs stay stable; revisions invalidate old passes.

Tests must provision disposable databases/tenants and scoped credentials. The current root-store
tests use configured PostgreSQL; do not simply invoke them against deployment data as a new bootstrap
test. Root races, role changes, directory mutation and payroll-like examples belong to fixtures.
Installation registers these tests but auto-runs only opted-in safe checks. The interactive Lab must
not let a user mint test administrators in the production swarm.

Proposed command after suites exist: `npm run test:authorization`. It must run the meaningful isolated
contract/boundary suites, fail on absent required local fixtures and produce case-linked results.
Live directory tests remain separately selected and visibly pending until credentials and an isolated
tenant exist. No GitHub Actions are required or introduced.

Reuse/extend existing `app-access-tier`, `manifest-route-auth`, `manifest-route-mounter`,
`platform-control-plane-authz`, `bot-node-execute-entitlement`, `mcp-tool-authorization-boundary`,
`workload-delegation-authority`, `entra-local-identity-bridge` and local-auth suites rather than
duplicating their existing cases. Governance claim tests and its Playwright suite need an explicit
legacy/adopted migration matrix. Catalog metadata references the resulting files in their actual
locations; these short names are an implementation inventory, not runnable case registrations.

## Review and release evidence

Keep the following next to the implementation, with no secrets or private records:

- Contract revision and supported minimum core; staged/active package catalog hashes.
- Exact test command, core/package SHAs, case counts/results and fixture isolation proof.
- Example allowed and denied decisions with principal/app/tenant substitutions and reason codes.
- Bootstrap race/rollback evidence and recovery runbook.
- Measured local and directory revocation behavior, including upstream limitations.
- Coverage of every package entry point and data retrieval path, including Jarvis and background jobs.
- Migration/rollback evidence proving no downgrade opens an adopted application.

Completion of this document is specification work only. None of the work orders or planned Lab cases
above is complete until its implementation and recorded evidence satisfy the stated acceptance.

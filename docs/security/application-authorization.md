# Application access administration

The core imports an installed application's permission catalog, enforces its declared HTTP functions,
and exposes the same management service through `/access`, `/api/authorization`, and the registered
`swarm_authorization` tool. Users and Applications link to the screen. This is the initial
implementation of [ADR-149](../adr/149-enterprise-application-authorization.md); the remaining enterprise
work is tracked in [the authorization backlog](../backlog/enterprise-authorization.md).

An installed package without a catalog requires an explicit `@app-admin` assignment by default.
Neither swarm administration nor a manifest's `defaultTier: admin` grants that assignment. Existing
explicit local-account app-admin assignments remain recognized. The kernel's flat manifests retain
their existing platform checks. For a reviewed deployment migration, setting
`OSHAL_APPLICATION_AUTHORIZATION_MODE=legacy` retains the old behavior for packages without catalogs;
the screen labels them **legacy**. Catalog-bearing packages always enforce. Unknown setting values
enforce. Review package access before promoting this change to an existing deployment.

## Package contract

An adopted package declares both fields:

```yaml
uses: [application-authorization]
authorization:
  version: 1
  catalog: authorization.yaml
```

The existing kernel-skill check makes older cores reject this unknown capability. The catalog contains
`resources`, `permissions`, `roles`, and `bindings`; see ADR-149 for the full example. CLI validation and
runtime loading share one strict validator. Unknown versions, unknown fields, missing references,
overlapping HTTP bindings, duplicate YAML keys, and escaping or symbolic-link catalog paths fail load.

During its route factory, a package registers each resource with
`ctx.authorization.registerResource(resource, { authorize })`. The adapter receives the verified actor,
requested operation, and one permitted scope/field tuple. It must look up authoritative relationships
and constrain its actual queries and writes. Missing adapters deny requests. HTTP bindings use the
method and path relative to the package mount; unbound endpoints are denied. Public/service route
declarations do not bypass these checks. Protected routes require `APP_PACKAGE_DYNAMIC_ROUTES=1` and
successful route construction before becoming available.

Browser document and asset GET requests may select a business workspace with `?workspace=<tenant>`;
API calls may use `x-oshal-tenant-id`. Both remain untrusted selectors checked against current
membership and grants. Duplicate, malformed or conflicting selectors are rejected. A query selector
does not authorize a mutation; writes continue using the header. Package links and downloads must
preserve the selected workspace and independently apply the same policy and database scope.

Without an explicit selector, only a GET binding requiring exactly the read permission `app.open`
may open through an existing business membership. This lets a business-only user reach the shell
and choose a workspace. It does not select a data workspace or admit another read/write action.
Packages must offer their currently authorized workspace choices and keep data requests explicit.
An explicit empty selector remains the personal context; it never falls back to another workspace.

Denied browser document navigation to an exact `app.open` GET binding returns a static role-guidance
page with HTTP 403. Verified administrators can follow its Access link; other callers see account
and help links. API, asset and tool errors remain JSON. The page grants no access and runs no package
handler or script.

Resource checks and handlers run with the user's database identity and `isOperator: false`.
This supplies an enforcement boundary; it does not automatically create an application's tenant/team
predicates or field projections. Package authors must implement and test those adapters. Catalogs alone
do not prove isolation of records, aggregates, exports, or derived fields.

## Administration and identity

Select an application and a source-qualified user or directory group, preview an exact change, and
apply that preview. Grants, restrictions, expiry, group mappings, effective access, and explanations use
one service. The server supplies actor identity. Browser writes require the serving origin, JSON, and
the access-request header. Previews bind actor, issuer, application catalog, revision, and expiry;
concurrent edits conflict. Assignment changes and audit receipts commit together in PostgreSQL.

Management uses current root/admin roles and the existing environment recovery allowlists. The primary
provider retains explicitly configured operator continuity; additional provider issuers require
`OSHAL_AUTHORIZATION_ADMIN_ISSUERS`. Email-based operator matching requires a verified email claim.
Local disabled accounts are rejected even with an existing session. Legacy subject-only assignments
belong only to canonical local identities. The selector includes local accounts and exact Google/Microsoft
identities observed through verified login, preserving explicit bridge links. Unqualified historical IDs
are never guessed or merged by email. See [principal adoption](principal-directory.md). For swarm
administrators, each listed account shows its verified email beside its name, so two accounts with the
same display name (a personal and a work Google account, say) can be told apart. The email is shown only;
it never selects, links or merges an identity.

The Access screen and read tool expose [scoped applied-change history](authorization-audit.md).
Each paginated read rechecks current authority, filters app/tenant scope before limiting results, and
omits raw reasons and approval material. An ordinary user cannot browse administration history.

The user roster deep-links the exact identity into Access. The screen shows each declared permission,
whether it is granted, and the applicable record scope/field projection. “Review all visible applications”
reads the selected user's current access across the caller's visible catalog. Explicit deny removes the
affected permission, including a deny for one action within a broader role. Create, update and delete
are distinct named permissions even when all have the `write` effect in the catalog.

The screen asks **What are you giving?** before anything else, and shows one path at a time:

- **One role on one application** (the default) shows **This user's applications**, the application
  picker and **Advanced access**.
- **A composite role** shows only **Application composite roles**, which has its own application list.

The choice is kept across a refresh in the same browser tab.

Each row in **This user's applications** has **Edit roles** for callers with assignment rights.
Choose **Add role** or **Remove direct role**, select the application's imported role and business
tenant when applicable, and enter a reason. Review the exact identity, application, role and action
in that row before applying. Adding a role preserves the user's other roles; removing a direct role
does not remove inherited group access or clear explicit restrictions. Core access-management roles
appear separately from business roles and are available only to current swarm administrators.

An auditor can read the table without changing roles. Row edits use that application's management
scope and the selected business tenant. Changes to the selected user, tenant or catalog discard
pending reviews; a catalog deployment or concurrent policy change requires a fresh review. Sensitive
self-management changes remain pending independent approval. Applications without a catalog in legacy
mode show **Legacy access**, because the central role tier does not describe legacy enforcement.
The registered `authorization-admin-browser.spec.ts` suite exercises these controls with the actual
policy HTTP service and isolated in-memory assignments; it never edits deployed grants.

The application table loads for the selected user, supports application/source search and keeps
long role and permission lists in expandable cells. Advanced permission explanations, restrictions
and audit history remain under **Advanced access**. Each expiry field provides **Choose date** and
**No expiry** controls. The chooser uses local date and time; the reviewed and saved assignment
contains the corresponding exact timestamp.

Select application checkboxes and choose **Edit selected** to review up to twenty applications for
one exact user. The dialog offers each application's own role catalog and business tenant. A shared
role can be selected only when that role ID is available in every selected application. The reason
and optional expiry apply to each explicit grant; removing roles still affects direct assignments only.

Bulk changes save sequentially, with a separate audited transaction for each application. Before
the first write, every selected change is previewed and any independent-approval requirement blocks
the batch. Each subsequent step verifies the current caller, application policy and expected revision;
renewed previews preserve the reviewed change and original review deadline. A conflict or refusal
stops remaining changes while keeping completed changes saved. An ambiguous response is retried once
with the same preview and idempotency key; an unresolved outcome stops the batch and is shown as
unknown for audit reconciliation. This is not an atomic multi-application transaction.

Two core role templates can be assigned per application, optionally within a business tenant:

| Core role | Management rights | Business-data rights |
|---|---|---|
| `@access-admin` | Read access, assign imported business roles and map directory groups | None |
| `@access-auditor` | Read access and scoped audit history | None |

Only a current swarm administrator may grant or revoke these management roles. An application access
administrator cannot delegate management roles or alter swarm root/admin/user roles. Both templates use
the existing assignment store, catalog/source binding, expiry, deny and revision rules. Every operation
derives current management scopes again; revoking a manager before an assignment transaction acquires
the policy writer prevents that assignment. Existing sensitive/self-escalation approval requirements
still apply. `authorization-management-roles.spec.ts` and its PostgreSQL companion cover these boundaries,
including a one-connection pool so account/approval checks cannot deadlock while holding the writer.

External business memberships use exact issuer/subject/tenant tuples introduced by migration 135. The
Users screen exposes existing tenants through the admin-only `/api/authorization/tenant-memberships`
catalog and preview/apply API. Membership alone grants no application action. A verified provider's
directory tenant ID is not an OSHAL business tenant; local issuerless memberships are not inherited.
The actor resolver reads external memberships freshly, and changes share the authorization revision
and audit transaction. Application managers cannot grant business memberships.

The Entra bridge preserves verified directory claims before linking to a local account. Group decisions
match issuer, directory tenant, and group object ID. Missing, stale, incomplete, or overage membership
evidence refuses affected access; no claim URL is fetched. Evidence expires after five minutes, so the
authentication integration must supply fresh verified claims. Live Graph refresh, transitive group
lookup, SCIM lifecycle, and native AD/LDAPS provisioning remain backlog work. A locally authenticated
session or PAT alone does not prove directory membership.

Sensitive self-grants, sensitive group mappings, and restoration of sensitive self-access require a
trusted approval verifier. The server composition wires one verifier, sole-operator self-approval
(`src/app/composition/sole-operator-approval.ts`), into both the access-change and the catalog-migration
hooks. It accepts only when all of these hold:

- the approval reference is `sole-operator-self-approval:<previewId>` for that exact preview, so an
  approval for one change is never accepted for another;
- the caller is active, undelegated, a swarm administrator, and the ADR-148 swarm root;
- no OTHER identity resolves as a swarm administrator. The census reads every source that can make
  one: `swarm_roles` root/admin rows, `OSHAL_OPERATOR_SUBS`, verified provider sign-ins the operator
  policy admits, and active local accounts whose email is in `OSHAL_OPERATOR_EMAILS`. An unreadable
  census refuses.

The moment a second administrator exists, the reference is refused and these changes need an
independent approval again; no second-approver workflow exists yet, so they stay blocked. Access
Administration shows a confirmation field on such a review; typing `approve` sends the bound reference.
Model tool calls cannot apply changes at all (`allowChanges` is false on the bridge). The accepted
reference is stored on the audit event (`approvalReference`) and on an approved catalog migration; the
redacted history projection keeps omitting approval data.

## Jarvis, tools, and workers

The core registers `swarm_authorization` as an ASK typed tool and `swarm_authorization_read` as its
AUTO read-only companion. Keywords include access, permissions, roles, users, groups, and directory
mapping. Jarvis receives caller-filtered structured metadata from the same runtime. Interactive
preview/apply reaches the same handler through `/api/authorization/tool`; the internal bridge permits
only the read companion. Missing server-created actor context fails closed.

Controller bot, inline task, tool, and deterministic schedule boundaries recheck package ownership and
named operations. A service secret or saved subject is not a user principal. Work without the required
verified actor is refused. Direct remote bot ingress also checks durable protected-app ownership before
provider execution. [Protected remote application execution](remote-application-execution.md) supports
direct hosted reasoning without tools using signed delegation and fresh controller permits. It binds
the original issuer/subject, installation generation and effective grant set through result delivery.
Protected agentic, CLI, provider-intent and raw mesh/batch paths remain refused. Persisted ownership
remembers old agent IDs across removal/downgrade so those nodes cannot reopen through a legacy path.

Artifact discovery filters inaccessible apps. Protected remote results now recheck current rights at
task/message history, ticket, Jarvis cache and per-event streaming boundaries; queued tickets capture
immutable initiator provenance. Complete artifact redemption and per-operation agentic/queue support
remain in AUTH-05/06. Discovery alone is not a capability or full business-data/ERP isolation.

## Installation and verification

Fresh local root creation requires a one-use installer proof, bound to the browser origin and expiring
after fifteen minutes. From the API environment with its database configuration, use:

```text
node scripts/oshal-setup-root.mjs --origin https://your-swarm.example
```

Use the resulting transient code at the local login setup form. Account creation, root assignment,
and proof consumption commit atomically. The database stores a hash of the proof. Ordinary first login
cannot claim an empty root role; existing operator recovery remains available. Local setup requires
`LOCAL_AUTH=true` and `MOCK_OIDC=false`.

An identity-provider installation (OIDC sign-in, `LOCAL_AUTH` off) binds the same one-use proof to one
exact issuer and subject:

```text
node scripts/oshal-setup-root.mjs --origin https://your-swarm.example --issuer <exact issuer> --subject <exact subject>
```

While root is unclaimed, `/users` shows a signed-in caller their own verified issuer and subject. The
owner, signed in as exactly that identity, enters the code there under **Swarm root**
(`POST /api/swarm/roles/installer-root`). The proof check, root row and proof consumption commit in one
locked transaction, and migration 172 stores the binding.

The redemption is refused, with nothing written, in each of these cases:
- a different subject or issuer (including a kernel `urn:oshal:*` session);
- another origin, or a cross-site request;
- mock sign-in;
- a local-account proof;
- an expired proof;
- any account, role or verified principal other than the bound one.

A proof bound to an identity cannot complete the local-account ceremony, and completion never reopens.

On Kubernetes the chart's install notes print both forms as `kubectl exec` into the api container, so
the code reaches only the operator's terminal. No rendered object runs the script. The chart's default
`MOCK_OIDC` posture has no root ceremony. See [the chart runbook](../../deploy/helm/oshal/README.md)
("First swarm root").

The Bash/PowerShell installers still offer only their `basic` (local accounts) and `mock` modes. An
identity-provider installation runs the command above by hand.

Evidence for all of the above is isolated and has not been live-accepted against a real identity provider:
- `tests/unit/installer-root-bootstrap.spec.ts`, on disposable PostgreSQL;
- `tests/unit/installer-root-oidc-browser.spec.ts`, the real Users page in Chromium;
- `tests/unit/chart-installer-root.spec.ts`, the real chart render.

Existing accounts, roles, verified external inventory or a completed installation close fresh-root
election. [Users administration](local-account-administration.md) supports local invitations and status
changes; root disable and administrative credential-reset guards remain transactional.

Migrations 127–129 add policy state/audit/app posture, installer proof and verified principal storage
(migration 172 adds the proof's optional bound issuer and subject);
migration 131 indexes scoped audit reads; migrations 132–133 persist remote execution authority and
queued initiator provenance. Migrations 134–135 add reviewed roster registrations and exact external
business-tenant memberships. Migration 173 adds recorded catalogs and reviewable catalog migrations
(see below). Normal schema
initialization supports installation. No deployed accounts or app grants are changed by the source
implementation itself.

### Assign a package to a person

In Access Administration, select the user, choose **Assign a package**, optionally enter the business
tenant, and choose **Review package access**. The read-only plan includes the package's required
application dependencies. Optional applications, tool needs and connection needs are displayed
separately and are never granted automatically. An explicit deny, inactive user/application, missing
dependency, dependency cycle or missing management scope blocks package continuation.

Choose **Choose required roles** to open the existing batch editor. Every missing role starts blank:
choose an application-declared role explicitly, add a reason and review the exact changes before
applying. Existing access stays in place. A batch saves sequentially and stops on a conflict or uncertain
result; completed changes remain saved. Plans with more than 20 missing roles require smaller reviews
in the application table. A changed identity, tenant or catalog invalidates the pending plan.

### Package upgrades that change the catalog

Every assignment is bound to the installation source and to the catalog revision it was granted
under (a hash of application, source and catalog, not the package version). Each activation records
its catalog under that revision (migration 173), so a later upgrade can compare against it after the
old package files are gone. When a package activates with a different catalog while assignments
still carry the previous revision, the installer classifies the change
(`src/features/application-authorization/catalog-diff.ts`):

- **Non-widening.** This covers added resources and operations (HTTP, tool, bot, job or artifact-action
  bindings) that require only permissions the previous catalog already defined. It also covers
  operations that became unbound, or that require more than before. The package loads without an
  operator. In the same policy transaction, the installer moves every assignment onto the new
  revision, records the catalog and writes one `catalog-migration` audit event. The event names the
  installer principal, the time, the from/to revisions and versions, the classified changes and the
  assignment ids it carried.
- **Widening or breaking.** Any new, removed or renamed permission, any changed role (grants, tier or
  sensitivity), any changed resource scope or field set, a lowered requirement on an existing
  operation, a catalog added or dropped, or a previous catalog that was never recorded. Activation
  is refused with `authorization_catalog_migration_required`. The message names one stored review,
  and the installed package keeps serving under its existing grants. An administrator with
  application-wide assign reviews the classified changes with
  `GET /api/authorization/catalog-migrations?app=<app>`. They approve with
  `POST /api/authorization/catalog-migrations/apply` and `{previewId, idempotencyKey}`, which is
  the same body, same-origin gate and idempotency as an access change. The next activation of exactly
  that revision applies the reviewed migration and audits the approver.

HTTP operations are compared by the requests they can match, including mount-stripped paths, not by
binding id. Renaming or re-pathing a binding therefore cannot lower what an existing request requires.
A grant that names a role or permission the new catalog does not define is removed, not carried, so
re-adding that name later cannot revive it. Denies always carry. A different installation source is
still refused with no review. Approving a migration that changes a sensitive grant the approver holds,
or a sensitive group mapping, needs an approval reference, the same as a sensitive access change.
On a single-administrator swarm the root sends `approvalReference: "sole-operator-self-approval:<previewId>"`
with the apply (see Administration and identity).

After staging an upgrade over live assignments, `node scripts/operations/little-monsters-upgrade-proof.js`
(`OSHAL_VERIFY_OPERATOR_PAT`, optional `OSHAL_VERIFY_BASE_URL`, `OSHAL_UPGRADE_PROOF_APP`,
`OSHAL_UPGRADE_PROOF_MIN_VERSION`) reads Access Administration only. It checks that the package is
registered at the new version, that a migration onto the running revision was recorded, and that
every carried assignment is still present.

Evidence is isolated: `tests/unit/authorization-catalog-diff.spec.ts`,
`tests/unit/authorization-catalog-migration-postgres.spec.ts` (disposable PostgreSQL, forced RLS,
non-superuser runtime role), `tests/unit/authorization-runtime.spec.ts` (real package loading and
mounted routes), `tests/unit/authorization-routes.spec.ts` and
`tests/unit/little-monsters-upgrade-proof.spec.ts`. A live staged upgrade has not been run yet.

Do not infer named roles from an old `@app-admin` assignment. Adopting a catalog over fallback
grants is a breaking change that needs a reviewed migration. Little Monsters documents its
student/teacher/admin adoption sequence in its package documentation.

### Pilot package evidence (isolated, not live)

Little Monsters 1.4.5 is the pilot business package. Its store suites run against this core with an
unchanged catalog, and each one is registered in its package test catalog. The Lab status given for
each is what core's own admission rule reports.

- **`authorization-groups-delegation`** (runnable in the Lab).
  - A verified directory group mapped to the non-sensitive `student` role and a direct `teacher`
    grant open different functions over the same HTTP routes.
  - A group-mapped deny wins over a direct grant. Unmapping a group revokes it.
  - Stale, overage, foreign-tenant, future-dated or missing group evidence refuses.
  - A sensitive group mapping needs an approval verifier.
  - The tutor and study bots go through the controller execution guard (`BotNodeClient` and the inline
    orchestrator). They are admitted for a granted learner. They are refused before any endpoint for an
    unassigned actor, a mismatched subject, an explicit deny, and a grant revoked between queueing and
    execution.
- **`authorization-record-rights-postgres`** (pending in the Lab by design: `engine-container:disposable-postgres`).
  The compiled routes run behind the real guard on PostgreSQL 16, as a NOSUPERUSER NOBYPASSRLS role.
  - Teacher class, analytics and roster rows stay inside the teacher's own class and school.
  - Learners read only their own dashboard. Aggregates exclude other classes.
  - Refused actors are stopped before any handler SQL.
- **`authorization-permission-ui`** (pending in the Lab by design: browser runner). The actual
  dashboard, teacher and Tutor pages run in Chromium, with a mid-session revocation.

These suites are not live acceptance. Signed-in multi-user acceptance on an installed swarm, and
directory-group rights from a real identity-provider tenant, have not been run.

Once the package is installed, one automated, read-only check confirms the installed registration. It reads
the live Test Lab catalog as the operator, using the operator's own PAT; the PAT is read by name and never
printed. The check asserts two things: `authorization-management` registers the installer-root suites, and
Little Monsters 1.4.5 or later lists all four pilot cases. It writes nothing. Exit codes are 0 for pass,
1 for fail and 2 for missing input. Run it from the host:

```text
OSHAL_VERIFY_BASE_URL=http://localhost:35457 OSHAL_VERIFY_OPERATOR_PAT=... node scripts/operations/verify-authorization-registration.js
```

Its guard is `tests/unit/verify-authorization-registration.spec.ts`.

Migration 145 keys coarse application access by subject, application and issuer. A legacy NULL issuer
and `urn:oshal:local-auth` identify the same local principal; different external issuers remain separate,
including explicit denies and clears. Owner reads require the subject and verified issuer in the
database request context. Migration 146 records that a legacy NULL-issuer row is also a ceiling for
every other issuer of its subject (a pre-145 deny still denies, a viewer still caps, a grant never
lifts a federated identity above the manifest default), and the tier resolver reads that exact
principal predicate under the system identity so the ceiling reaches the gate, the route mounter and
visibility reads for a federated caller. Both migrations are one-way: there is no down migration, the
deploy's image rollback does not restore the subject-only key, and the pre-145 upsert then fails with
`no unique or exclusion constraint matching the ON CONFLICT spec`; roll forward. Package stop and
uninstall are swarm-operator actions, independent of application business roles.

A fleet service-secret call (`X-Service-Secret`) that carries `X-Oshal-User-Sub-B64` names a subject but
no identity provider, so the tier gate and the dynamic route mounter refuse it with
`403 app_access_identity_required` before any tier is resolved. That is a decision, not a gap: a subject
is unique only inside its issuer, the secret is held by injectable bot processes, and the alternatives
(assume `urn:oshal:local-auth`, or read the subject across every issuer) would let a forwarded string
select a principal. `src/app/server.ts` stamps such a request with no subject and no issuer on its
request identity; `appAccessCallerSub` still resolves the carried subject, `appAccessCallerIssuer`
returns null, and the gate stops there. User-bound automation reaches a declared route through the
workload-delegation rail (verified `principal_iss` on the request identity) or the application service
principal. Pinned at the HTTP boundary by `tests/unit/swarm-app-gate-access.spec.ts` and
`tests/unit/manifest-route-mounter.spec.ts`.

Run `npm run test:authorization` locally. It includes isolated policy/import, identity, loaded-package
HTTP, typed-tool, real Chromium, worker-boundary, and disposable PostgreSQL tests. The existing AI Test
Lab registers their source paths under `authorization-management`; its live catalog step is read-only
and does not apply grants or launch arbitrary tests against deployment data. Package-specific tests
still register through the installed application's existing test catalog.

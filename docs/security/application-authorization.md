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
are never guessed or merged by email. See [principal adoption](principal-directory.md).

The Access screen and read tool expose [scoped applied-change history](authorization-audit.md).
Each paginated read rechecks current authority, filters app/tenant scope before limiting results, and
omits raw reasons and approval material. An ordinary user cannot browse administration history.

The user roster deep-links the exact identity into Access. The screen shows each declared permission,
whether it is granted, and the applicable record scope/field projection. “Review all visible applications”
reads the selected user's current access across the caller's visible catalog. Explicit deny removes the
affected permission, including a deny for one action within a broader role. Create, update and delete
are distinct named permissions even when all have the `write` effect in the catalog.

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
trusted approval verifier. The initial server composition has no such approval workflow and therefore
refuses those changes. A model-supplied confirmation cannot approve them. The UI shows this requirement.

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
`LOCAL_AUTH=true` and `MOCK_OIDC=false`; existing Bash/PowerShell/Kubernetes installation defaults have
not been converted to enterprise OIDC provisioning.

Existing accounts, roles, verified external inventory or a completed installation close fresh-root
election. [Users administration](local-account-administration.md) supports local invitations and status
changes; root disable and administrative credential-reset guards remain transactional.

Migrations 127–129 add policy state/audit/app posture, installer proof and verified principal storage;
migration 131 indexes scoped audit reads; migrations 132–133 persist remote execution authority and
queued initiator provenance. Migrations 134–135 add reviewed roster registrations and exact external
business-tenant memberships. Normal schema
initialization supports installation. No deployed accounts or app grants are changed by the source
implementation itself.

Run `npm run test:authorization` locally. It includes isolated policy/import, identity, loaded-package
HTTP, typed-tool, real Chromium, worker-boundary, and disposable PostgreSQL tests. The existing AI Test
Lab registers their source paths under `authorization-management`; its live catalog step is read-only
and does not apply grants or launch arbitrary tests against deployment data. Package-specific tests
still register through the installed application's existing test catalog.

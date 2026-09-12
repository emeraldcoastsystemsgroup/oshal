# ADR-149: Enterprise authorization for users, applications and delegated AI

Date: 2026-09-10
Status: **Initial core implementation; enterprise rollout and package adoption remain open.**

[As-built behavior and operation](../security/application-authorization.md) records the shipped
boundaries and limits. This ADR also contains target requirements that are not all implemented;
the [work-order status](../backlog/enterprise-authorization.md) is authoritative for remaining work.

Requested outcome: an enterprise swarm can serve CRM, business development, payroll and HR while
each person, group and automation receives only the application functions and records it is assigned.
Installing a package imports its permission vocabulary and tests into the swarm; it does not grant
those permissions to everyone. Jarvis uses the same user's authority as the application UI.

Related: [ADR-118](118-app-access-tiers.md), [ADR-148](148-swarm-root.md),
[ADR-076](076-tenant-aware-rls-and-least-privilege-db-role.md),
[ADR-087](087-access-roles-jarvis-visibility-scoping.md),
[ADR-122](122-model-is-untrusted-principal.md),
[implementation and test backlog](../backlog/enterprise-authorization.md).

## 1. Starting point verified in the code

Audited against core commit `9991ed83`. This is source inspection, not a deployed authorization audit.

| Existing mechanism | What it supplies | What this work adds |
|---|---|---|
| [Swarm roles](../../src/features/swarm-roles/services/swarm-role-store.ts) and [role routes](../../src/app/routes/swarm-roles-routes.ts) | Durable root/admin/user; a unique root; env operator recovery; local first-account root claim | Installer-bound, atomic bootstrap and a separation between managing access and reading business data |
| [App access store](../../src/features/swarm-apps/services/app-access-service.ts) and [method policy](../../src/app/middleware/app-access-policy.ts) | Exact user/app deny/viewer/editor/admin assignment; explicit deny; viewer method restriction | Named permissions, group-derived grants, resource scope and field restrictions |
| [Manifest route mounter](../../src/app/composition/manifest-route-mounter.ts) | Auth and app-tier checks before dynamic package handlers | Mandatory function permission bindings for adopted packages and equivalent checks at non-HTTP entry points |
| [Caller roles](../../src/shared/types/access-roles.ts) | operator/swarm/jarvis classify calling surfaces | Business roles such as payroll preparer; these are distinct concepts |
| [Governance RBAC](../../src/features/governance/rbac/policy.ts) and [claim mapping](../../src/features/governance/rbac/claims.ts) | A second role resolver and seven kernel permission names, with optional enforcement | One decision service and a compatibility adapter; issuer/client-qualified mappings replace global role-name assumptions for adopted apps |
| [Request identity](../../src/shared/services/database/request-identity.ts) | Async identity with subject, verified issuer and operator/system flags | Canonical principal, business tenancy and restricted data context carried through every user task |
| [Entra bridge](../../src/app/middleware/entra-local-identity-bridge.ts) | Verified tenant/issuer/object identity linked to a canonical local account | Trusted directory membership and application role mapping, independently of account linking |
| [Jarvis tool catalog](../../src/app/routes/jarvis-tool-catalog.ts) | Tool descriptions/routing metadata and caller-class filtering | User-specific permission filtering plus authoritative checks at execution |
| [Installed test catalog](../../src/features/swarm-apps/services/installed-app-test-catalog.ts) | Active package smoke registration and lifecycle | Authorization coverage contracts and isolated multi-principal regression cases |

The current `isOperator` request flag also grants broad database visibility. Therefore separating
administration from business records requires data-context and policy changes, not only a Users page
change. Existing app access and several ownership tables use `user_sub`; an issuer carried alongside
a request does not by itself make those tables safe for ambiguous subjects from multiple issuers.

Specific prerequisites found during the audit:

- Governance `can()` permits all operations with its enforcement flag off, and permits arbitrary
  permissions for an admin or a matching owner. Its role resolver does not consult `swarm_roles`.
  These are legacy semantics to contain, not a permission engine to expose unchanged to payroll.
- [Principal issuer extraction](../../src/shared/middleware/principal-issuer.ts) reads the filtered
  OIDC presentation user; the Entra bridge already uses verified `idTokenClaims` to retain issuer.
  Normalize authentication provenance once before access decisions or issuing delegated credentials.
- Entra bridge cache hits currently refresh the cache timestamp. Continuous traffic can postpone
  rechecking the linked account. Absolute freshness and disable-under-traffic tests are prerequisites.
- [Local bootstrap](../../src/app/routes/local-auth-routes.ts) creates the account before a separate,
  nonfatal root claim. The [account insert](../../src/features/local-auth/services/local-user-store.ts)
  uses `WHERE NOT EXISTS`; account creation and root assignment do not share a bootstrap transaction.
  Root's existing unique index alone does not establish atomic account-and-root enrollment.

## 2. Proposed decisions and compatibility boundary

**Recommended policy:** root and swarm admins manage the platform and its access assignments, but
receive no automatic payroll, HR or other business-record access. This is the proposed default,
pending operator preference; it is not a description of today's operator database bypass.

Root remains the recovery/ownership role from ADR-148. App administration is a separate set of
permissions. Managing an app's users need not imply reading salaries, exporting contacts or executing
payments. Hosts and trusted package code remain powerful: this design does not claim to hide data
from the machine owner or sandbox arbitrary installed code that runs inside the controller process.

This ADR proposes a targeted extension of ADR-118: the framework imports and evaluates a package's
declared function grants, while the package defines business resources, data relationships and
transaction invariants. Existing package capability checks remain an additional restriction during
migration. No two independent grants may bypass each other; all applicable restrictions must pass.

It also proposes replacing ADR-148's empty-role-table root claim with installer-bound authority.
Already claimed roots and explicit env recovery access remain valid. Neither accepted ADR is silently
rewritten by this proposal.

One deployed swarm is the initial administrative boundary. Business tenant/company partitions inside
that swarm use explicit membership and IDs. Membership in an identity-provider directory does **not**
automatically grant membership of an OSHAL business tenant. Federation between distinct swarms is
outside this version; a remote swarm's admin has no implicit local rights.

## 3. Authorization model

An authorization decision answers: **may this principal perform this application action on these
resources, in this tenant, through this executor, now?**

| Dimension | Meaning and authority |
|---|---|
| Principal | Immutable internal ID, active state, and verified external identity links; never a display name or unverified email |
| Swarm role | root/admin/user for platform administration and recovery |
| Application | Installed application identity bound to its source and authorization revision |
| App tier | Existing deny/viewer/editor/admin doorway and coarse ceiling |
| Permission | Exact app-owned ID, e.g. `contacts.read`, `contacts.update`, `payruns.approve`, `payruns.execute` |
| App role | Named bundle of explicit permission/scope pairs, assigned directly or through trusted groups |
| Resource scope | `own`, `team` or `tenant`, implemented against authoritative package data |
| Field set | Named readable/writable fields; omitted sensitive fields are not returned or accepted |
| Conditions | Account status, tenant membership, grant expiry, fresh identity evidence, required approval and record state |
| Executor | Human session, PAT, Jarvis, bot or scheduled service; transport credentials can only narrow the business grant |

Permissions are namespaced by application internally, even when two packages both use `records.read`.
No wildcard permission grants, wildcard future roles or automatic role inheritance in v1. Roles are
explicit lists; adding a permission to an existing role is an access expansion requiring review.

Example business assignments, illustrative and not claims about any installed package:

| Person / group | Assigned role | Allowed | Still refused |
|---|---|---|---|
| Sales representative | CRM representative | Read/change owned contacts and opportunities | Another team's records, bulk export, payroll |
| Business development lead | CRM team lead | Read/change the assigned team's opportunities | Other teams, salary fields, app access administration |
| HR case worker | HR case worker | Manage HR cases in assigned business tenant | Execute payroll or read bank details without separate permission |
| Payroll preparer | Payroll preparer | Create and edit a draft pay run | Approve or execute that run |
| Payroll approver | Payroll approver | Review permitted payroll fields and approve someone else's draft | Execute payment without a separate execution grant |
| Auditor | Scoped auditor | Read selected records and audit evidence | Change records or export unrelated data |
| Swarm admin | Platform admin | Install apps, manage users and access | Business records without separately assigned app permissions |

Approval is a second business rule, not a grant. A person cannot approve their own pay run merely by
holding preparer and approver roles. Package transactions enforce actor separation, resource version
and current state; changing the draft invalidates its approval. Jarvis confirmation does not replace
that rule. Export, download, bulk action and payment execution are separately declared permissions.

## 4. Application authorization schema imported at installation

Proposed package syntax below; **not currently supported by the loader or installer**:

```yaml
# In the application's existing manifest
access:
  supported: [deny, viewer, editor, admin]
  defaultTier: deny
authorization:
  version: 1
  catalog: authorization.yaml
```

Example package-local catalog, with route paths relative to this package's existing mount:

```yaml
version: 1
resources:
  contacts:
    scopes: [own, team, tenant]
    fieldSets:
      summary: [id, displayName, companyName]
      details: [id, displayName, companyName, email, phone]
permissions:
  contacts.read:
    resource: contacts
    effect: read
    minimumTier: viewer
  contacts.update:
    resource: contacts
    effect: write
    minimumTier: editor
  contacts.export:
    resource: contacts
    effect: export
    minimumTier: editor
roles:
  representative:
    tier: editor
    grants:
      - { permission: contacts.read, scope: own, fields: details }
      - { permission: contacts.update, scope: own, fields: details }
  team-reader:
    tier: viewer
    grants:
      - { permission: contacts.read, scope: team, fields: summary }
bindings:
  http:
    - { id: contacts-list, method: GET, path: /contacts, allOf: [contacts.read] }
    - { id: contact-update, method: PATCH, path: /contacts/:id, allOf: [contacts.update] }
    - { id: contacts-export, method: POST, path: /contacts/export, allOf: [contacts.export] }
  tools:
    - { id: crm-find-contacts, allOf: [contacts.read] }
  artifactActions:
    - { id: attach-contact-file, allOf: [contacts.update] }
```

The catalog declares data, never executable policy, arbitrary SQL, JavaScript expressions, external
URLs or directory credentials. A package registers vetted code implementing `own`/`team`/`tenant`
resource predicates and field projection. Catalog names do not prove those predicates exist.
Activation verifies the registered resource adapters and supported bindings before admitting traffic.

Contract rules:

- Names, supported versions, referenced permissions/resources/field sets, methods, route patterns,
  duplicate keys and IDs, path containment, symlinks and size limits are validated by one shared
  contract used by CLI and runtime. No empty `allOf`; v1 means all listed permissions are required.
- Effects are the closed vocabulary `read`, `write`, `export`, `execute`, `administer`. Read has a
  viewer floor; write/export/execute have an editor floor; administer requires admin. A declared
  minimum may be stricter, never weaker. Reject role/grant/tier contradictions. Viewer never mutates
  through tools, workers or other transports even when the HTTP method gate is not involved.
- Resource ID/tenant values from the caller identify a requested target only. The server loads and
  validates the actual target relationship; clients cannot assert ownership or team membership.
- Adopted packages must bind all mounted business endpoints, tools, bots, jobs, artifact actions,
  streams and data exports. Health/static/auth endpoints need an explicit classified exemption;
  a missing business binding denies. A read operation over POST still needs a function declaration;
  it does not automatically evade the existing viewer method ceiling.
- HTTP bindings use the actual router's matching rules. Specific literals, parameters, mount prefixes,
  HEAD behavior and overlapping patterns must be unambiguous; coverage checks reject conflicts.
- The import identity includes app, trusted source, installed version, schema version and canonical
  catalog hash. An update stages the new catalog and validates references before atomic activation.
  A failed update preserves the prior active catalog. Disable/uninstall withdraws executors.
- New permissions start unassigned. Changes cannot expand existing grants silently: review the
  transitive meaning of roles, referenced field sets/scopes/conditions, tier floors and operation
  bindings, including changes that leave role text identical. Show a semantic diff, require an
  authorized access administrator to accept the new grant revision, and
  keep the prior active package/policy until that review succeeds. Removed IDs leave inactive audited
  assignments; reusing a removed ID does not revive its old grants automatically.
- Cross-registry replacement does not inherit another publisher's grants without explicit review.
  A group package references members but cannot grant access to its member apps.
- An adopted package requires a core capability/version that actually enforces this contract. Current
  loaders may ignore unknown additive metadata; a deployment floor must be implemented and verified
  before distributing a package that relies on it. Unsupported cores must refuse installation.

Code changes to resource adapters are also access-sensitive package changes: metadata cannot prove
that a predicate still limits rows correctly. Require adapter regression evidence in the package
review; catalog hashing is not an attestation that arbitrary package code preserves authorization.

Importing an external application's permission model means an adapter normalizes it to this catalog.
It does not import database schemas as access rules, infer grants from tool keywords, or turn external
identity-provider role definitions into OSHAL permissions without administrator mappings.

### Applications without an authorization catalog

For the new enforced policy, a missing catalog means **all business operations require explicit
application-admin access**. It never promotes the caller to admin. The core creates an app-scoped
fallback descriptor for the existing registration rather than inventing read/edit permissions or
requiring legacy packages to supply a fabricated catalog.

| Loaded declaration | Enforced behavior |
|---|---|
| Valid supported authorization catalog | Its declared operation permissions and resource policies |
| No authorization catalog, whether or not a coarse `access:` block exists | App-admin required for every business entry point; show `admin-required fallback` in the central screen |
| Malformed, unsupported or broken catalog | Refuse activation; do not downgrade to the missing-catalog fallback |
| Applicable explicit deny | Deny even when an app-admin assignment exists |

An explicit app-admin assignment may come from a direct grant or an administrator-configured,
currently valid directory mapping. `defaultTier: admin`, a swarm-admin role, a model assertion or a
service credential is not that grant. Existing tier restrictions, ownership/tenant policies, token
scopes and workflow approvals still apply. The fallback covers tools, Jarvis, artifacts, jobs and
other business entry points as well as HTTP; framework-owned login/callback/health exemptions remain
explicit and narrow. Unattributed business work cannot fall through to system authority.

Current missing declarations preserve legacy behavior. Enabling the new fallback is therefore a
reviewed migration: inventory affected apps/users, preview access changes and seed only explicitly
approved app-admin assignments before enforcing. A legacy compatibility mode must be visibly labelled
and cannot count as enterprise enforcement. The fallback protects whole-app entry; it does not supply
missing record/field rules or make an unaudited app enterprise-ready. Adding a real catalog later
requires explicit migration of fallback assignments, not a wildcard grant of all new permissions.

## 5. Identity, directory groups and enterprise provisioning

Use one internal principal ID. Preserve existing `user_sub` ownership through explicit identity links
and a reviewed migration; do not rewrite all ownership strings on login. External links are unique by
verified issuer plus subject. Entra directory-object links additionally bind tenant ID and object ID.
Ambiguous legacy links require explicit resolution. Existing canonical local accounts keep their IDs.

Microsoft documents `sub` as application-specific and `oid` as tenant-object identity; display/email
claims are unsuitable as stable permission keys. OSHAL must consume these only after its configured
OIDC library has verified the appropriate token/session, including issuer, audience and lifetime.
[Microsoft ID token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).

Directory configuration belongs to the swarm administrator, not to an app package:

1. Configure the trusted provider/issuer, tenant, accepted token audience and external directory ID.
2. Link verified login identities to internal principals without discarding their external identity
   evidence when the Entra/local bridge replaces the presentation user.
3. Map an immutable group ID to an installed app role, business tenant and optional team constraint.
   A similarly named group in another directory or tenant grants nothing.
4. Alternatively map an exact verified Entra app-role value within the configured issuer/audience
   namespace. Entra directory administrator roles do not automatically become OSHAL admins.
5. Show grant provenance and membership freshness. Rename a group without changing its authorization
   identity. Require an explicit membership mode; direct and transitive membership are not interchangeable.

Entra can emit group IDs or app roles. JWT group claims have a 200-group limit and use an overage
signal when exceeded; token membership is only as fresh as token issuance. Detect overage and use a
configured Microsoft Graph endpoint, not a URL copied from claims. The app-assigned-groups mode has
different nested-membership behavior from transitive Graph lookup, so the connector contract must
declare and test its mode. [Microsoft group claims and app roles guidance](https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles).

The first adapter is Entra OIDC with verified claims plus bounded Graph membership lookup when
configured. On-premises Active Directory can connect through an organization-managed federated
identity provider or synchronized Entra directory. An LDAPS synchronization adapter is a separate
later connector with its own credentials, trust and stable SID mapping; the kernel does not accept
arbitrary LDAP group names from a browser. No native AD/SAML/SCIM support is claimed by this spec.

SCIM is the planned provisioning boundary for users, group membership and disable events, separate
from interactive authentication. Implement standard `/Users` and `/Groups` semantics and authenticated
tenant-scoped provisioning credentials when that phase ships.
[SCIM protocol, RFC 7644](https://www.rfc-editor.org/rfc/rfc7644.html).

Revocation contract (proposed engineering targets):

- Local disable, explicit deny and role changes take effect on the next authorization transaction
  after commit, including queued tasks, PATs and established sessions. Permission caches carry a
  policy version; workers must validate it, not rely solely on an invalidation message.
- Directory evidence has a maximum five-minute age, configurable downward. Age is measured from
  issuance/authoritative observation; reading an old session must not reset the clock. Once stale,
  refresh or refuse decisions dependent on that directory. Token-only integrations may require
  renewed sign-in; Graph/SCIM reduce that limitation.
- An incomplete/failed membership lookup is unknown, never an empty group list. If unresolved groups
  might supply a deny or mandatory condition, refuse the affected app decision rather than falling
  back to a direct allow. Unrelated apps with independent policy can remain available.
- Actual upstream deprovisioning latency includes the provider's consistency and delivery delay;
  five minutes is an OSHAL evidence-age limit, not a promise of instantaneous AD revocation.
- High-impact approval/execution requests require authoritative revalidation of their applicable
  memberships and grants; unavailable evidence prevents execution. In-flight actions recheck before
  commit/dispatch; cancellation cannot undo an external action that already completed.

## 6. Evaluation and storage contract

One policy decision service owns the shared semantics; HTTP handlers, UI catalogs and workers call it
through feature-layer ports. Shared code does not import the feature implementation. Package business
logic may restrict a decision further and never widen it.

Register existing governance kernel permissions in a reserved platform namespace and adapt existing
`can()`/`rbacMiddleware()` callers to the common service. Preserve only explicitly inventoried legacy
compatibility while migrating; the `OSHAL_RBAC_ENFORCE` flag must never disable declared enterprise
app checks. Unknown permission IDs deny, even for an admin. Ownership is a resource condition, never
a substitute for a function grant. Feed the same trusted group information into existing RAG filters;
their legacy admin shortcut cannot bypass an adopted application's data policy.

Evaluate in this order:

1. Authenticate the executor and resolve an active canonical principal or explicit service principal.
   Verify business tenant membership, installed app identity/revision and the delegated subject.
2. Load current direct assignments, applicable directory mappings and required membership evidence.
   Any applicable explicit deny wins over all allow sources, including root/admin and group grants.
3. Resolve the app doorway. An existing explicit user tier is authoritative and caps group-derived
   access. Otherwise use the highest tier from valid assigned roles; only when there are no roles use
   the manifest default. Enterprise-adopted apps default to `deny`. A non-deny tier alone grants no
   named functions. Unsupported/stale assignments fail closed as in ADR-118.
4. Find grants for the exact permission; require its minimum tier and all mandatory conditions.
   Combine grants as a union of **permission + scope + field-set tuples**, not independently unioned
   scopes and fields. Team-summary plus own-details must not become team-details.
5. Intersect that result with tenant/resource predicates, applicable denies, token/tool scopes,
   executor allowlists, package policy and approval conditions. For `allOf`, every permission must
   authorize the actual operation; one permission's broader scope cannot satisfy another's check.
6. Enforce inside the data operation. Lists/aggregates apply authorized predicates before pagination,
   totals, sorting and aggregation. Creates validate destination; updates validate both current and
   proposed ownership/tenant/team, so changing an owner cannot bypass scope. Batch operations fail
   atomically unless the endpoint explicitly documents per-item outcomes without leaking denied rows.
7. Return a stable denial reason and decision ID. Management explanations show grant provenance;
   ordinary callers receive only their own effective permissions, with no other users' identities.

Field policy covers query use as well as output/write projection: filters, sorting, full-text search,
grouping, aggregates, derived values and errors must not reveal restricted fields indirectly. Reject
unauthorized field references or require a separately declared derived-data permission. Package
immutability constraints still apply even if a field appears in a readable/writable field set.

For local database mutations, authorization-version validation and business writes share a transaction
and lock/conditional-version protocol also used by revocation. A revoke committed first prevents the
write; a write serialized first may finish, with that ordering recorded. A pre-write permission lookup
in an unrelated transaction is insufficient. External effects use an authorized outbox/dispatch claim
with current-policy revalidation at the dispatch cutoff and idempotency; revocation after that cutoff
cannot guarantee cancellation of an already submitted provider action. Record this distinction.

Proposed core-owned durable entities (names finalized with migration review):

| Entity | Required keys / behavior |
|---|---|
| Principal and external identity links | Immutable principal; unique `(issuer, subject)` independent of connection labels; Entra `(externalTenantId, oid)` resolves to one canonical principal; active state; reviewed legacy mapping |
| Application authorization catalog | App/source/version/revision; staged/active state; immutable declarations and activation audit |
| App role assignment | Principal or directory-group mapping, app, role revision, business tenant, allowed scope constraint, grantor, reason, expiry |
| Explicit restriction | App or exact permission deny, principal/group, optional resource scope, actor/reason; deny precedence |
| Directory source and membership evidence | Trusted source/tenant/object IDs, direct/transitive mode, observed time, completeness, source revision |
| Policy revision and decision evidence | Monotonic revision, decision ID, actor, delegated user, executor, app/permission/resource reference, outcome/reason |
| Installation bootstrap | One installation, pending/complete state, expiring hashed ceremony secret, allowed provider and atomic root claim |

Reuse `swarm_roles`, `oshal_app_access`, existing tenant memberships and account-link records where
their semantics fit. Add foreign keys/uniqueness, transactional writes and query indexes; do not create
a second independent user registry. Access-management writes require current management permission,
CSRF protection for browser sessions, reason, optimistic concurrency and an audit entry in the same
transaction. General app admins cannot alter swarm roles or another app's grants. A root can delegate
access management scoped to particular apps/tenants; it does not confer business-record permissions.

Policy authoring has a self-grant boundary: designated access administrators can assign ordinary
permissions within their delegated ceiling, with attribution. Sensitive roles (payroll execution,
HR restricted fields, access-management delegation) require a second authorized approver for a
self-affecting change. This is application governance, not protection from a hostile host/root owner.

## 7. Enforcement through applications and Jarvis

| Boundary | Required behavior |
|---|---|
| Ribbon/app list/tool catalog | Show only accessible apps/actions; show a reason for a disabled action where useful; discovery does not authorize execution |
| HTTP/API | Validate bound permission before handler; enforce package resource/field policy before reading or writing |
| Tool selection | YAML keywords and context rank only already-authorized candidates; model output cannot grant permissions or select an alternate user |
| Artifact handoff | Require source read and target action rights; preserve owner binding; confirm export/share separately; handles alone do not grant business access |
| Jarvis prompt/RAG | Fetch and redact under current user/data scope before model ingestion; apply the same policy to search, embeddings retrieval, citations, caches and conversation reload |
| Bot/queue/MCP | Carry original principal, tenant, app, requested permission, resource scope and executor identity; authorize enqueue, execution, retries and result retrieval |
| Scheduled job | Run as an explicitly granted service principal, or a recorded user delegation; missing user identity is never permission to become system |
| Connector/provider | Intersect OSHAL permission with scoped provider account/token rights; provider consent alone does not authorize the business function |
| Stream/download/report | Authorize subscription and revalidate on policy changes; scope payloads, generated files, counts and result ownership |
| Database | Use restricted business-data context and package predicates/RLS; platform management privileges must not stamp a universal business-data bypass |

Reuse existing signed delegation and scoped MCP execution. A `direct: false` marker, internal service
key, `runWithSystemIdentity`, bot caller role or model-generated payload is not sufficient business
authority. Delegation includes expiry and bounded audience/action and is resolved from trusted server
state; replay prevention/idempotency protects mutations. App-to-app work needs authorization for both
ends. A receiving app cannot inherit the sending app's service privileges.

Do not preserve a frozen group list or grant set in durable tickets as authority. The ticket records
intent and provenance; execution looks up current effective rights. If a user is disabled while work
waits, it does not run. Cached/model-generated results are user/tenant/policy scoped and rechecked
before retrieval; unauthorized data must not enter a model context, shared cache or another user's
conversation. Data already delivered to a user/model cannot be retroactively withdrawn.

Existing RLS is defense in depth, not a replacement for named function checks. No enterprise rollout
is complete while adopted package business paths can inherit the operator/system bypass. Trusted
maintenance jobs need explicitly bounded data privileges distinct from interactive root/admin.

## 8. Swarm administrator at installation

No shipped default password and no permanent public "first visitor wins" path. Offer two explicit
installation modes, both creating the durable root role from ADR-148:

1. **Configured identity:** proposed `OSHAL_BOOTSTRAP_ADMIN_ISSUER` and
   `OSHAL_BOOTSTRAP_ADMIN_SUB` identify the exact first root. Validate them as a pair and claim only
   after that configured identity successfully authenticates. Email is a display hint, not the key.
   This mode requires an already-authenticatable identity. On a fresh LOCAL_AUTH store, provisioning
   its first account also requires installer-issued activation/enrollment proof; matching an
   email-derived local subject during public registration is not proof of identity ownership.
2. **Installer ceremony:** the local installer creates a cryptographically random one-use secret and
   short-lived, origin-bound setup session. The person who authenticates/registers through this
   session becomes root. This is the intended "first person to log in during installation" experience.
   A concurrent unrelated login cannot claim root. A copied setup secret is authority, so it is shown
   locally, hashed at rest and excluded from URLs, logs and committed env templates.

Proposed ceremony lifetime: 15 minutes; the local installer can explicitly reissue before completion.
The transaction locks the singleton installation state, verifies unclaimed root and ceremony, creates
or links the account, assigns root, consumes the secret and records completion together. OIDC profile
discovery occurs before the transaction; no remote call is held inside it. Failure leaves a retriable
setup with no half-created root/account. Concurrent attempts have one winner; retries by that winner
return completed status without granting a second identity. Restart cannot reopen a completed setup.
Pending setup survives restart only with its original persisted expiry; restart does not extend it.
An expired pending setup requires explicit local installer reissue.

Both Bash/PowerShell and Kubernetes installers must expose the same choice. Production enterprise
mode refuses mock authentication. Existing `OSHAL_OPERATOR_SUBS`/`OSHAL_OPERATOR_EMAILS` remain the
legacy recovery rail, clearly labelled; upgrade must not silently elect the first entry as root or
silently revoke recovery. Enterprise setup requires an explicitly trusted identity namespace and
shows any unresolved global/email-based legacy recovery configuration for migration.

An existing root is never overwritten by env changes. Root transfer remains explicit and atomic.
An established but rootless legacy installation uses its existing trusted recovery operator plus an
explicit local setup action, not an empty-table inference. Business permission checks still apply to
the recovery operator. Deployment must preserve a tested local recovery path before narrowing the
old broad data bypass.

Account administration must prevent disabling the only usable root/recovery account through the
ordinary Users API. Transfer root or establish tested recovery first. Display "recovery required"
when an external directory independently disables that account; do not bypass a directory disable
or automatically elevate the next user to compensate. Local session issuance follows successful
bootstrap commit, and setup status never reports success for a partial root/account result.

## 9. User and administration experience

Provide one core-owned **Access Administration** screen, proposed route `/access`, linked from the
existing Users and Applications surfaces and from installation setup. Those surfaces deep-link into
the same selected user/application view; they do not maintain separate grant editors or policy stores.
Reuse their account/root controls where appropriate. This is a core administrative surface, not an
additional store package or kernel application manifest.

The screen uses a user/group selector, application selector and business tenant/team scope. Its main
view is an access matrix with roles/functions, effective allow/deny, scope, expiry and source. Detail
panels show directory mappings, catalog revisions, access-change history and decision explanations.
Each installed app appears automatically within the administrator's delegated visibility; update,
reload, disable and uninstall refresh this view without per-app UI code. Removed apps retain authorized
history but cannot receive executable grants. Source-qualified app identity prevents name collisions.

An app without a catalog is visibly `admin-required fallback` and offers only explicit app-admin grant
or deny controls, not invented viewer/editor checkboxes. A schema-backed app renders its own declared
roles, functions and scopes. Public labels/descriptions are escaped as untrusted display content.
Authentication and scoped access-management authorization protect the page and each API; hiding its
ribbon entry is not the guard. Ordinary users retain a separate own-access view without management
controls or access to the administrator's user/group inventory.

- **Installation:** choose identity source, establish root, invite/link users, select an application,
  review its permission catalog, map roles/groups, then run isolated access checks.
- **User access:** list effective applications and roles, business tenant/team constraints, direct vs
  directory provenance, expiry and any explicit deny. A user can inspect only their own access.
- **Application access:** list its declared functions, role bundles, protected fields and adapters;
  compare catalog revisions before updates; assign users/groups within the administrator's ceiling.
- **Directory mappings:** choose a trusted directory and immutable group, app role and tenant/team;
  show membership mode, last observation and refresh failure. Do not present a stale lookup as no members.
- **Explain/test:** evaluate a proposed policy against a nominated fixture identity/resource, with
  audit and appropriate management rights. This returns a decision; it does not impersonate that user
  to retrieve business data. An authorized management API must not turn into a data-reading bypass.
- **Denied action:** state which access is needed and how to request it, without exposing hidden
  records. Jarvis may explain the refusal; it cannot grant itself access or choose an admin identity.

Proposed management routes under `/api/authorization`: catalog read, scoped role-assignment and
restriction writes, directory mappings, `/me` effective access and an audited `/explain` evaluator.
Exact route schemas must be reviewed with the shared contract. Existing role/tier APIs remain
compatible; they feed the same evaluator and cannot bypass fine permissions. Audit payloads carry
references and decision provenance, not salaries, tokens, prompts or full business records.

### Registered authorization management tool

Register one core-owned tool, proposed stable name `swarm_authorization`, through the existing
[tool registry](../../src/features/tool-registry/services/tool-registry-service.ts) and
[executor registry](../../src/features/tool-registry/services/dynamic-tool-executor-registry.ts).
Its typed operations call the same management service as the screen. A package contributes permission
definitions and selectable targets; it cannot replace this tool, supply its executor or register a
second privileged grant path. Startup registration is idempotent and restored after restart. Publish
the callable descriptor only when its executor, policy service and input schemas are ready.

| Operation | Inputs / result | Required boundary |
|---|---|---|
| `catalog` | Installed app identities, declared roles/functions, fallback/enforcement state and revisions | Scoped management read; only visible apps |
| `effective` / `explain` | Exact principal/app/tenant and optional permission/resource reference; effective rights and reason | Own-access read or scoped management read; no business records or impersonation |
| `preview_change` | Typed grant/revoke/deny/clear-deny/group-map action, exact IDs, role/permission, scope, expiry, reason and expected policy revision | Current assignment/directory management permission and delegated ceiling; no mutation |
| `apply_change` | Server-issued preview ID, idempotency key and trusted confirmation/approval reference where required | Recheck caller, management permission, target, revision and applicable approval before an audited transaction |

Read, assignment and directory-management capabilities are separate permissions in the reserved
platform namespace, each constrained to the administrator's assigned apps/tenants. Account/root
bootstrap, root transfer and recovery remain their dedicated flows, not generic tool operations.
Preview binds its initiating principal, exact change, app/source/catalog/policy revisions and expiry;
apply cannot change those parameters. A stale or changed preview requires a new evaluation. A model's
`confirmed: true` is not approval evidence. Preserve the existing sensitive/self-affecting change
approval rules; an authorized administrator can make ordinary changes through the shared save flow.

Tool inputs are a closed schema, not shell commands, raw SQL, arbitrary endpoint URLs or an asserted
acting user. The authenticated/delegated identity comes from the trusted invocation context; a target
user ID is only the subject whose access the administrator proposes to change. Neither Jarvis nor a
background executor receives broader rights because this is an administrative tool. Registered tool
presence, enablement, caller class and keyword matches do not confer access-management permission.

Use a fixed, code-owned handler with runtime schema validation. The current generic API executor's
model-selectable method/header/body options are not this contract, and declared input-schema metadata
alone is not validation. Preserve existing tool consent/exposure restrictions: the current internal
MCP bridge exposes AUTO tools only, so do not mark permission-changing operations AUTO simply to make
them discoverable. A transport may expose separately registered operation descriptors under the same
tool family, with reads and mutations separately gated; unsupported mutation/approval transport is
unavailable until its trusted implementation exists. Every descriptor still calls the same service.

Include semantic discovery metadata: keywords such as **access, permissions, authorization, roles,
users, groups, application admin, directory mapping**; a `useWhen` description for inspecting or
changing application access; and context describing principal/app/tenant selection and preview/apply.
Jarvis's loaded tool feed advertises only currently permitted operations and targets, and execution
checks them again. Tool registry tags and YAML routing hints must refer to the same stable identity.
The current Jarvis YAML parser accepts shell entries only; AUTH-05 must add a validated feed adapter
for this typed core tool, without pretending it is an already supported YAML entry or opening shell
execution. Registration is complete only after a real authorized invocation reaches the handler.

## 10. Rollout, tests and completion

Implement in small slices from [AUTH-01 through AUTH-10](../backlog/enterprise-authorization.md).
First prove a disposable reference package and two tenants with several users; then adopt real store
packages in their owning repositories. Do not infer that every existing package is protected because
the schema loads. Keep an explicit compatibility status: legacy tier-only, schema imported,
admin-required fallback, or function-and-data enforcement verified.

Additive schema/database deployment precedes activation. Shadow evaluation may measure differences
for existing apps but is never advertised as enforced protection. An adopted enterprise app runs
enforced or unavailable. Rollback cannot load an app requiring this contract on an older unguarded
core; pin the compatible core/package/policy revisions or disable the app. Preserve grants and audit
history on uninstall without retaining runnable entries.

Every implementation slice adds meaningful unit, real HTTP/worker, isolated PostgreSQL or browser
tests as appropriate and registers them with AI Test Lab. Installation registers package cases;
privileged/multi-user mutation suites run only in disposable fixtures. A missing runner or directory
credential is pending/unavailable, never passed. Local verification is required; no GitHub Actions.

Completion means proving all of these with dated, pinned results:

1. A valid package imports its catalog and test cases; an invalid or unsupported contract cannot activate.
2. Two users can use one app with different functions; two apps and two business tenants stay isolated.
3. Direct and directory-derived grants work, explicit deny wins, and field/scope combinations do not widen.
4. UI, raw API, tools, artifacts, Jarvis, queued jobs, streams, exports and data retrieval obey the same policy.
5. Revocation reaches sessions, tokens, workers and caches within the stated local/freshness contract.
6. Installer root setup has one authorized winner and cannot reopen; admin management does not imply payroll read.
7. At least one adopted store package proves record predicates, restricted fields and its business approval rule.
8. The Lab displays the installed permission/test revisions and records real results; documentation distinguishes
   fixture proof, live directory proof and production package adoption.
9. The central screen and registered tool discover installed apps dynamically and produce equivalent
   allowed/denied changes through the same service, including the no-schema app-admin fallback.

The initial implementation does not promise arbitrary external ERP adapters, every AD deployment
mode, complete package migration or cryptographic audit export. Those have separate acceptance work;
this specification fixes the contract they must use.

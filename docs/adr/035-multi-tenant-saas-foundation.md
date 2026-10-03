# ADR 035 — Multi-Tenant SaaS Foundation (Schools as Tenants)

Status: **Accepted as amended** (operator decision 2026-09-21, recorded in [BACKLOG.md](../BACKLOG.md) under **"Two-tier tenant provisioning"**: "ISOLATED-ONLY. ADR-035 is amended and ACCEPTED on that basis"). Proposed 2026-06-12. The amendment is at [the end of this ADR](#amendment-2026-09-21-isolated-only); it replaces pillar 1's pooled database with a database per tenant. The isolated tier's provisioning is built (2026-10-01): [`scripts/governance/provision-tenant.sh`](../../scripts/governance/provision-tenant.sh) renders a tenant's database policy (its own role and its own database, closed to every other role) and namespace policy, and a two-tenant proof on a disposable PostgreSQL shows a cross-tenant database connection and a cross-tenant row read both refused ([runbook](../runbooks/tenant-provisioning.md)). The shared tier is not built: `--tenancy=shared` is refused. A shared mode is planned under the backlog enhancement "Tenancy modes: shared, isolated and federated, with per-database, per-set or per-table placement (enhancement, operator 2026-10-01)", which starts with an ADR; none of it is built. (The RLS substrate landed separately as multi-*user* isolation under [ADR-076](076-tenant-aware-rls-and-least-privilege-db-role.md); the tenant root entity, realm-per-tenant provisioning, and seat licensing decided here remain unbuilt.)
Supersedes: none. Related: [ADR 034 config-sync](034-bidirectional-config-ownership-sync.md), [ADR swarm-application-manifests](033b-swarm-application-manifests.md), [ADR 030 home-persona-layer](030-home-persona-layer.md)

## Context

OSHAL / Little Monsters runs today as a **single-tenant** control plane: one Keycloak
realm (`oshal`), one shared Postgres, students and classes with no tenant scoping, and
cost tracked per task but not per customer. To sell Little Monsters to schools
("Benton signs up, wants 100 seats"), we need a **tenant** layer: isolated data, per-tenant
logins, seat licensing, per-tenant cost, and a compliance posture suitable for US K-12
student data.

The single-tenant **per-user isolation** that this layer builds on (connectors hub
identity scoping + `taskId` context isolation) is documented as-built in
[connectors-tenant-isolation.md](../architecture/connectors-tenant-isolation.md). RLS below upgrades
its app-layer `user_sub` scoping into a database guarantee, scoped by `tenant_id`.

The primitives already exist and are reused rather than rebuilt:
- **Auth**: Keycloak/OIDC via `express-openid-connect` (`KEYCLOAK_REALM=oshal` today).
- **Cost data**: `chat_tasks` carries `total_cost`, token counts, `provider_id`, `usage_by_model` per task.
- **RAG isolation**: per-class ChromaDB collections `lm-class-{id}-{textbook|lecture}`.
- **App packaging**: `swarm-apps/*.yaml` manifests already bundle an app (Little Monsters) as a loadable unit.
- **Deploy**: k8s scaffolding under `ops/any-bot-k8s` + `scripts/*k8s*`.

What is missing is the tenant root entity and the scoping/enforcement that hangs off it.

## Decision

Build a multi-tenant SaaS layer with these choices (owner-approved 2026-06-12):

1. **Isolation: pooled + Postgres Row-Level Security (RLS).** One shared Postgres. Every
   tenant-owned table gets a `tenant_id`; RLS policies enforce isolation at the database so
   an application query bug cannot leak across schools. A **siloed** stack (dedicated DB/instance)
   is reserved as a future premium tier for districts that require it contractually — not built now.

2. **Identity: realm-per-tenant on the existing Keycloak.** Each tenant gets its own realm
   (isolated users, branding, SSO). Federate **Clever** and **ClassLink** as identity/rostering
   brokers (the dominant K-12 SSO + provisioning rails). Roles: `district-admin` → `teacher` → `student`.
   Seats = a licensed user cap enforced at provisioning and at login.

3. **Provisioning:** a tenant is created by: insert `tenants` row → create Keycloak realm +
   district-admin user → seed a tenant-scoped Little Monsters config (a parameterized
   `little-monsters` manifest instance) → allocate N seats → issue admin creds → optional
   subdomain `benton.<product>.app`. The swarm-app manifest is the unit of "a tenant's app instance."

4. **Billing: flat per-seat annual**, PO/invoice friendly. `chat_tasks` gains `tenant_id` for
   per-tenant cost rollups; a per-seat usage cap + margin alert guards against a heavy tenant
   eroding margin. Collection via Stripe and/or PO.

5. **Compliance: upfront, gating.** First customers are real US K-12 districts, so FERPA, COPPA
   (school-as-consenting-official), applicable state laws (e.g. SOPIPA), and a signed DPA
   (SDPC standard) are **phase-0 requirements**, not deferred. Anthropic is a disclosed LLM
   **subprocessor**; we require zero-retention/DPA terms and "no training on student data," plus
   encryption at rest/in transit, data retention + deletion, and subprocessor disclosure.

## Consequences

**Positive**
- Reuses Keycloak, `chat_tasks` cost data, per-class RAG isolation, and the manifest system — the build is a tenant *layer*, not a rewrite.
- RLS makes isolation a database guarantee, reducing the blast radius of app bugs.
- Per-seat annual billing matches how schools actually buy; internal metering protects margin.

**Negative / risks**
- RLS touches **every** tenant-owned table (schema migration + policy + a tenant-context GUC set per request). Invasive; must be done before tenant data accumulates.
- Realm-per-tenant adds Keycloak operational overhead (realm lifecycle, federation config per tenant).
- Compliance-upfront adds real non-code work (DPA templates, Anthropic terms, security review) on the critical path to first revenue.
- ChromaDB + the shared `workspace-shared` volume need per-tenant prefixing/partitioning to match the DB isolation.

## Async & workflow infrastructure (broker / "rabbit" question)

Two distinct concerns, kept separate:

- **In-swarm agent mesh** (bot↔bot coordination) → **keep Redis Streams**
  (`oshal:mesh:agent.{id}`). It is low-latency, already polyglot-neutral, and works. No change.
- **Tenant-facing async jobs + multi-step workflows** (lecture processing intake→process→deliver,
  reminders, calendar sync, billing rollups) → introduce a **durable job/workflow layer**, because at
  multi-tenant scale these need durability, retries, dead-letter, and — the new requirement —
  **per-tenant queues with rate limits** so one district cannot monopolize the LLM workers, and so the
  per-seat usage cap (billing pillar) has a real enforcement point.

Options weighed:
- **BullMQ** (Redis-backed): lowest friction — we already run Redis; per-tenant queues, retries,
  per-queue rate limiting. Best if the worker side stays Node-centric.
- **RabbitMQ** ("rabbit"): a language-neutral broker with strong routing, priority, prefetch-based
  fairness, and dead-letter exchanges. Fits the **polyglot swarm** (Cline/Codex/Python sidecars)
  as a vendor-neutral work queue, and isolates tenant-facing job traffic from the Redis mesh. The
  defensible "rabbit" choice when workers are heterogeneous and we want per-tenant vhosts/queues.
- **Temporal / Inngest** (durable workflow-as-code): best for the **multi-step lecture pipeline**
  (long-running, retried, partially human-in-loop) and for closing the current Workflow Studio gap —
  today the studio is design-time only ([CLAUDE.md]; `WorkflowPipelineRegistry` registers manifest
  pipelines but the studio compiler is not wired to runtime). A workflow engine is where authored
  workflows would *execute*.

**Recommendation:** keep Redis Streams for the mesh; add a broker for tenant async jobs with
**per-tenant queues + rate limits** (this is the usage-cap/fairness enforcement point). Start with the
lowest-friction broker that fits the worker topology — RabbitMQ if we lean into the polyglot/neutral-broker
direction (per-tenant vhosts), BullMQ if Node-centric. Layer a durable **workflow engine** over it for the
lecture pipeline once it grows beyond a single LLM pass, and route the Workflow Studio's authored graphs
into that engine to finally make studio output executable. Decide the specific broker in a follow-up ADR;
this ADR commits only to "separate durable per-tenant job layer, mesh stays on Redis."

## Phased plan

1. **Tenant data model + RLS** — `tenants` table; `tenant_id` on core + `lm_*` tables; RLS
   policies + per-request tenant context. Pilot on the `lm_*` tables first.
2. **Auth: realm-per-tenant + seat enforcement** — realm lifecycle, role mapping, login-time seat cap.
3. **Provisioning flow** — admin/self-serve "carve out a tenant" → seats → creds → optional subdomain.
4. **Per-tenant cost rollup + seat billing** — `tenant_id` on `chat_tasks`, rollup views, usage cap, Stripe/PO.
5. **K-12 go-to-market compliance** — Clever/ClassLink federation, DPA, Anthropic subprocessor terms, security baseline.

First three phases yield a working "Benton has an isolated 100-seat instance" demo; phase 5 gates real district sales.

A parallel **async/workflow** track slots alongside: per-tenant job queues land with phase 4 (where the
usage cap + fairness live), and the durable workflow engine for the lecture pipeline is a follow-up once
the pipeline grows beyond one LLM pass. Broker selection (RabbitMQ vs BullMQ) gets its own ADR.

## Amendment (2026-09-21): isolated-only

The operator amended and accepted this ADR on 2026-09-21. The decision is recorded in
[BACKLOG.md](../BACKLOG.md) under **"Two-tier tenant provisioning"**:

> **Decision (operator, 2026-09-21): ISOLATED-ONLY. ADR-035 is amended and ACCEPTED on that
> basis; the shared tier is recorded as a future option with a trigger, not built.**

What that changes in the decision above:

- **Pillar 1 (isolation) is replaced.** Each tenant gets its own database instead of one pooled
  Postgres with `tenant_id` RLS. The decision's words: `provision-tenant.sh` "ships one tenancy —
  `--tenancy=isolated`, a database per tenant — and the flag keeps its name so a second value can
  be added later without changing the interface."
- **The pooled/shared tier becomes a future option, not built.** Its trigger for revisiting is "a
  real customer whose economics require sharing one database; until then an isolated database per
  tenant is both the cheaper build and the stronger boundary".
- **Not approved by this amendment:** the tenant-scoped Postgres service identity under
  [ADR-076](076-tenant-aware-rls-and-least-privilege-db-role.md). The decision says it "is a core
  DB-role change, it is required only by the shared tier, and the shared tier has no customer".
- **The isolation proof** has to attempt a cross-tenant database connection and a cross-tenant row
  read and show both refused. `scripts/governance/verify-tenant-isolation.sh` checks only
  Kubernetes NetworkPolicy, so it does not cover this.

**As built (2026-10-01).** `scripts/governance/provision-tenant.sh <name> --tenancy=isolated`
renders `database.sql` and `namespace.yaml` for one tenant. The SQL gives the tenant its own
`LOGIN` role, with no superuser, no RLS bypass and no memberships either way, and its own
database. It revokes `CONNECT`/`TEMPORARY` from `PUBLIC` and from every other grantee, and revokes
`USAGE`/`CREATE` on the `public` schema from `PUBLIC`. The YAML is the ADR-078 per-tenant
namespace with a ConfigMap that binds the namespace to its own database. `--tenancy=shared` is
refused as not built. `tests/unit/provision-tenant-isolation-postgres.spec.ts` applies two
renderings with the real psql on a disposable PostgreSQL 16. A cross-tenant connection is refused
in both directions. A cross-tenant row read is refused, from the tenant's own session and with
the connection layer deliberately drifted open. Re-applying repairs the drift.
`scripts/governance/accept-tenant-isolation.sh` is the automated cluster acceptance for the
namespace half; its logic is proven against a kubectl stand-in, and it has not yet run on a real
cluster. What is not built:
- running oshal's migrations and runtime roles inside a tenant database;
- tenant isolation on a shared PostgreSQL server. Tenant databases are kept apart from each
  other, but a server shared by tenants, or by tenants and the control plane, is not
  tenant-isolated today, for two reasons. oshal's runtime roles `oshal_app` and `oshal_bot` are
  server-wide (`scripts/governance/provision-app-role.mjs` requires those exact names). And the
  server's other databases keep PostgreSQL's default `PUBLIC` `CONNECT`, which a tenant's role
  can use. The shared mode is planned under the backlog enhancement "Tenancy modes: shared, isolated and federated, with per-database, per-set or per-table placement (enhancement, operator 2026-10-01)";
- pillars 2 to 4.

See the [runbook](../runbooks/tenant-provisioning.md).

The decision does not address pillars 2 to 5, the async/workflow section or the phased plan. It
also records that this ADR's context, "the schools/SaaS path", is one "the operator's 2026-08-01
directive deliberately paused". The done-when is the BACKLOG entry's:
`provision-tenant.sh <name> --tenancy=isolated|shared` renders the correct namespace/database
policy and a two-tenant proof blocks cross-tenant database and row access.

# ADR-076 — Platform-wide tenant-aware RLS + least-privilege database role

- **Status:** **Implemented + live** on the `oshal-local` stack (2026-06-27).
  Migration 060 applied; the API now connects as the least-privilege `oshal_app`
  role and RLS enforces across 84 tables. Verified: the real user sees only their
  own rows (172 tickets / 141 trades / 15,513 predictions, 0 of other users'),
  strangers see 0, the system/bot context sees all, and tenant sharing works.
- **As-built deviation from the original plan:** the `validate-only` runtime
  posture crash-looped because this build performs idempotent schema DDL at
  startup (`createEducationRewardsRoutes`). The shipped approach instead makes
  `oshal_app` the **owner** of all tables/sequences/views (so startup + migration
  DDL runs) while `FORCE ROW LEVEL SECURITY` still subjects the owner to the
  policies. The `SECURITY DEFINER` helper stays owned by the superuser `oshal` so
  it bypasses RLS (no tenant-policy recursion). Moving startup DDL into migrations
  so a pure DML role + `validate-only` works is a follow-up.
- **Supersedes the partial state of** the four-table RLS scaffold in
  `docs/governance/rls-policies-enforce.sql` (tickets / workspaces / chat_tasks /
  access_audit_log), which was applied but inert (see "The bug" below).

## Context

OSHAL is multi-tenant by design with three data classes:

1. **Backend / system** — swarm internals (agents, tools, ticket plumbing, config,
   trading model weights). Shared infrastructure, not user PII.
2. **Tenant-shared** — data a user deliberately shares into a household/org
   (`tenant_id` tables; membership in `oshal_tenant_memberships`).
3. **User-private** — everything tied to one person: resume + application status
   (`career_hunter_applications`), the trades they made (`oshal_trading_*`), email
   (`oshal_inbox_*`, `oshal_email_digests`), and every app surface
   (eats/movies/shop/rides/spotify/travel/finance/content/…).

Application code already filters every query by `user_sub`, so logged-in users do
not see each other's data through the UI. But there was **no database-level wall**:
isolation depended entirely on every query remembering its `WHERE user_sub = …`.
One forgotten filter, one unchecked fetch-by-id (an IDOR already flagged in the
2026-06 security audit), a SQL-injection, or anyone who reaches the database
directly would see **all** users' data. That is a defense-in-depth gap, not a
visible bug — exactly the "could get watched or hacked" risk.

### The bug that made the existing RLS inert

RLS policies *were* present and `FORCE`d on four core tables, but they enforced
nothing, because **the application connects as the `oshal` role, which is
`SUPERUSER` + `BYPASSRLS`**. Postgres skips all RLS for such roles. Verified
empirically: a non-bypass role with a stranger's sub saw 0 ticket rows (RLS works),
while the app's actual role saw all 232 (RLS bypassed). So the per-request GUC
(`oshal.current_sub`) was being set and then ignored for the app's own connection.

## Decision

**1. Extend RLS to every owner/tenant-bearing table** (migration 060), reusing the
established owner-or-operator shape:

- *User-private* tables → `owner_col = current_setting('oshal.current_sub') OR
  is_operator='on'`.
- *Tenant-only* tables → `oshal_is_tenant_member(tenant_id) OR is_operator='on'`.
- *Dual* tables (owner column **and** `tenant_id`) → personal rows
  (`tenant_id IS NULL`) are owner-scoped; shared rows are tenant-scoped. This
  matches the existing access model in `src/app/routes/connector-tenancy.ts`.
- A `SECURITY DEFINER` helper `oshal_is_tenant_member(uuid)` performs the
  membership lookup outside RLS (avoids recursion on the tenant tables), with a
  pinned `search_path`.
- A trusted **system context** (`is_operator='on'`, set by `guc-pool.ts` whenever
  there is no request identity) bypasses every policy, so schedulers, the queue
  manager and bot runtimes are never starved to zero rows.

**2. Stop running the app as a superuser** (provisioning artifact). Introduce a
least-privilege runtime role `oshal_app` (`NOSUPERUSER NOBYPASSRLS`, DML-only).
DDL/migrations continue to run as the owner `oshal`; the runtime app runs with
`OSHAL_SCHEMA_BOOTSTRAP=validate-only` (already supported by
`schema-bootstrap-policy.ts`) so it never attempts DDL it no longer owns. This is
the step that makes the policies actually enforce.

**Why this is low-risk to land:** migration 060 is **inert while the app is still
the superuser** — the policies exist but are bypassed, so committing/applying it is
a zero-behaviour-change step. Enforcement is armed only by the deliberate role
cutover, which has a one-line rollback.

## Tiers as applied

- **Tier 1 (user-private, single owner col):** 58 tables — all eats/movies/shop/
  rides/spotify/travel surfaces, content studio, finance, inbox+email,
  trading (signals/predictions/orders/decisions/peaks/hwm), security center,
  presentations/videos/youtube, LoRA, jarvis_tasks, storage prefs + DEKs,
  `user_preferences`, `swarm_presets`, `tv_token_revocations`.
- **Tier 2 (tenant-shared):** dual tables (`eats_profile`,
  `career_hunter_applications`, `optimize_configs`, `oshal_connections`,
  `rides_profile`, `shop_*` shared subset, `token_chase_optimizer_corpus`,
  `travel_profile`, `vids_jobs`, `swarm_applications`); tenant-only tables
  (`*_tenants`, `lm_classes`, `lm_students`); and the tenant registry
  (`oshal_tenants`, `oshal_tenant_memberships`).
- **Tier 3 (backend/system):** intentionally left shared/operator — `agents`,
  `tools`, `ticket_*`, `config_*`, `oshal_trading_signal_weights` (shared model
  params), etc. Not user PII.

## Deferred (Phase 2, explicitly not yet walled)

These hold user data but lack a direct owner/tenant column, so they need
join-based policies or a schema change. They keep today's app-level filtering —
**no regression**, but they do not yet have the DB safety net, and are called out
so the gap is visible, not silent:

- **`personal_graph_nodes` / `personal_graph_edges`** — the ADR-066 personal
  knowledge graph has **no owner column at all**. Highest-priority follow-up:
  add `owner_sub` (+ backfill) before it can be RLS-scoped. Until then it is a
  single shared graph.
- **`chat_messages` / `agent_memories` / `knowledge_memory_documents`** — keyed by
  `task_id` / `agent_id`; need a policy that joins to the owning ticket/task.
- **`lm_*` student tables** (`lm_quiz_results`, `lm_flashcard_progress`,
  `lm_xp_events`, enrollments, materials, …) — keyed by `student_id`; need a join
  to `lm_students.tenant_id`. (LM also has pre-existing authz follow-ups noted in
  ADR-075.)
- **The TimescaleDB instance (`TSDB_URL` → `oshal_ts`)** is a separate database and
  is out of scope for this migration.

## Cutover (as performed on oshal-local)

1. Apply migration 060 as `oshal` (inert while the app is still superuser).
2. Provision + reassign ownership:
   `psql -v app_pw="$(openssl rand -hex 24)" -f docs/governance/app-role-provisioning.sql`
   (creates `oshal_app`, grants, and reassigns table/sequence/view ownership; the
   helper function stays owned by `oshal`).
3. Record 060 in `app_migrations` so a future image rebuild's boot runner skips it
   (it cannot `CREATE OR REPLACE` the helper it does not own).
4. Set the API's `.env` (gitignored): `DATABASE_URL=postgresql://oshal_app:<pw>@oshal-db:5432/oshal`
   (leave `OSHAL_SCHEMA_BOOTSTRAP` at default/auto — the app's startup DDL runs as
   the table owner). Recreate only the API: `docker compose -p oshal-local up -d --no-deps oshal-api`.
5. Verify: real user sees their rows, a second account sees none of them, strangers
   see 0, system/bot work unaffected, app boots healthy.

**Image-rebuild note:** migration 060 is committed but not in the running image; it
was applied by hand and recorded in `app_migrations`. A rebuilt image will bake it
in and skip it (already recorded). The `oshal_app` password lives only in the
gitignored `.env`.

## Rollback

Repoint the API's `DATABASE_URL` back to the `oshal` superuser role (RLS bypassed
again) or set `OSHAL_DB_GUC=off`. No schema or data change is required; the
policies can remain in place harmlessly.

## Consequences

- Defense-in-depth: a forgotten `WHERE`, an IDOR, or direct DB access can no longer
  cross-read another user's private data on any Tier-1/Tier-2 table.
- Every DB round-trip sets two GUCs (already the case via `guc-pool.ts`); negligible
  overhead, no new round-trips.
- New owner-bearing tables must be added to migration 060's lists (or a successor)
  or they ship unprotected — a posture test should assert coverage.
- (2026-07-05) The `/api/governance/posture` release gate codifies the as-built deviation: `OSHAL_SCHEMA_BOOTSTRAP=auto` with a non-superuser, non-BYPASSRLS runtime role is compliant (informational advisory only, since the owner is FORCE-RLS-scoped); `validate-only` remains the hardened target, and superuser + non-validate-only stays a blocker.

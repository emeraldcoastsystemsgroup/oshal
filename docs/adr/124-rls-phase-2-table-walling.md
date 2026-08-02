# ADR-124 — RLS Phase 2: wall what can be walled, justify what cannot

**Status:** Accepted — migrations 112/113 applied; exception list enforced by a guard
**Date:** 2026-08-02
**Supersedes the residual clauses of:** [ADR-035](035-multi-tenant-saas-foundation.md) tenant scoping,
[ADR-076](076-tenant-aware-rls-and-least-privilege-db-role.md) "Deferred (Phase 2)", [ADR-042](042-iot-connector-tenancy.md) Phase 2
**Builds on:** migration 060 (platform RLS), 094 (derived-owner RLS), 099 (the `oshal_bot`
least-privilege role), PR #74/#76 (`rag_chunks.owner_sub`), PR #99/#100 (machine-owner intake)

## Context

Every prior write-up of "what is left in RLS" was prose, and prose drifted. Three separate
documents named the same five tables as the outstanding residual —
`personal_graph_nodes`, `personal_graph_edges`, `chat_messages`, `agent_memories`,
`knowledge_memory_documents` — and **migration 094 closed all five a month ago**. Meanwhile no
document named any of the tables that were actually open.

So this ADR starts from the database, not from a list.

### The inventory (live stack, 2026-08-02, before this change)

| | tables |
|---|---|
| public tables | **282** |
| RLS enabled **and** FORCEd | 167 |
| RLS enabled, not FORCEd | 1 (`market_bars`, deliberate — a permissive `USING (true)` policy over shared OHLCV data) |
| **RLS off entirely** | **114** |

Of the 114 unwalled tables, **60 are store-package tables** whose `CREATE TABLE` is not in this
repository at all (`dnd_*`, `gameshow_*`, `sales_*`, `lm_*`, `career_*`, `kalshi_scan_*`,
`ps_portraits`, `oshal_lora_*`, `echo_pipeline_snapshots`). Under Rule 0c those ship their own
schema from the store repo and are out of scope here — including `lm_*`, which
[migration 094](../../scripts/migrations/094-derived-owner-rls.sql) already documented as deferred
to the little-monsters package because `lm_students`/`lm_tenants` identity is not an OIDC sub.

That leaves **55 core-owned tables with RLS switched off**. This ADR disposes of all 55.

> **Corrected 2026-08-02, by the guard itself.** The first count said 54. A plain `CREATE TABLE`
> grep cannot see `ticket_governance`, whose DDL is `CREATE TABLE IF NOT EXISTS ${GOVERNANCE_TABLE}`.
> The coverage guard resolves template names against the file's own `const`, so on its first live
> run it failed on exactly one table — the one written up as DEFERRED below and never added to the
> enforced list. That is the drift this guard exists to catch, caught on the change that added it;
> recorded here rather than quietly patched.

## Decision

### 1. Wall the tables that already have an owner — migration 112

Nine core tables carried an owner column and had simply never been ENABLEd. They get the canonical
`<table>_owner_or_operator` policy, byte-identical to `buildOwnerRlsPolicyStatements` and
`docs/governance/rls-policies-enforce.sql`:

`channel_link_codes`, `channel_links`, `connector_action_audit`, `linkedin_profile_plans`,
`social_content_drafts`, `user_notification_prefs`, `voice_user_prefs`,
`oshal_trading_rotation_state`, `oshal_cost_events`.

**The backfill answer, stated rather than assumed.** Eight of the nine declare their owner column
`NOT NULL`, and a live count found zero NULL and zero empty-string owners — there is nothing to
backfill and nothing to guess.

`oshal_cost_events` is the one exception and was decided deliberately: its `owner_sub` is nullable
and **87 of 2332 rows are NULL**. Those NULLs are **not derivable** — every one belongs to a
`chat_tasks` row whose own `owner_sub` is also NULL, so the resolvable count is exactly **0**. They
are therefore **left NULL and denied to non-operators**, which is precisely how `chat_tasks` (this
table's parent ledger, nullable-owner, FORCE-RLS'd since 060) has treated its own 1869 NULL-owner
rows in production for a month. Attributing 87 rows of real spend to a synthetic "system" owner
would have been a guess written into a cost ledger. Fail closed instead.

### 2. Derive the owner where a walled parent already exists — migration 112

Five tables hold user data with no owner column but a `NOT NULL` foreign key to a table that *is*
walled. This is 094's pattern, not a new one: a new `oshal_owns_ticket(uuid)` SECURITY DEFINER
helper (the uuid twin of 094's `oshal_owns_task(text)`) plus the existing `oshal_owns_task`.

| table | rows | key | parent |
|---|---:|---|---|
| `ticket_status_history` | 83,305 | `ticket_id` | `tickets.owner_sub` |
| `ticket_task_links` | 362 | `ticket_id` | `tickets.owner_sub` |
| `ticket_agent_assignments` | 55 | `ticket_id` | `tickets.owner_sub` |
| `ticket_workspace_links` | 32 | `ticket_id` | `tickets.owner_sub` |
| `task_checkpoints` | 3,014 | `task_id` | `chat_tasks.owner_sub` |

`ticket_status_history` alone held 83,305 rows of who-changed-what across 417 distinct owners,
readable in full by any `oshal_bot` connection, while its parent `tickets` had been walled since
060. The child now agrees with the parent instead of leaking around it.

Inherited NULLs are inherited on purpose: 71 of 3355 tickets have `owner_sub` NULL and 9841 history
rows hang off them, so those 9841 become operator/system-visible only — **not a new denial**, since
those 71 tickets are already invisible to non-operators under `tickets`' own policy. Zero orphans
exist in either direction (0 history rows without a ticket, 0 checkpoints without a task).

### 3. The exception list — 42 core tables that stay unwalled, each with a reason

Enumerated and **machine-enforced** in `tests/rls-core-table-coverage-live.spec.ts`. The spec keeps
the list honest in both directions: a new unwalled core table fails, and so does an exception whose
table has since been walled, dropped, or carved to the store.

**CATALOG (13)** — platform-global reference data. An owner column would be meaningless because
every caller is *meant* to see the same rows: `agents`, `agent_config`, `agent_tools`, `tools`,
`runtime_tool_executors`, `persona_layers`, `a2a_agents`, `oshal_trading_params`,
`oshal_trading_param_recommendations`, `oshal_trading_signal_weights`, `kalshi_forecast_log`,
`kalshi_predictions`, `travel_observations`.

**MACHINERY (20)** — scheduler, queue, migration and tool plumbing keyed by a run, unit, provider
or connection. No end user owns a row: `app_migrations`, `app_package_migrations`,
`config_snapshots`, `config_sync_log`, `oshal_intake_cursors`, `oshal_queue_dlq`,
`oshal_webhook_deliveries`, `oshal_free_tier_state`, `routing_audit_log`,
`subtask_lifecycle_parents`, `subtask_lifecycle_subtasks`, `swarm_runs`, `swarm_escalations`,
`work_items`, `tool_install_log`, `tool_verification_results`, `eval_runs`,
`test_lab_golden_runs`, `oshal_budgets`, `oshal_budget_events`.

`work_items` was checked for a derivable parent and has none: its `external_id` matches **zero** of
298 rows against `tickets.external_id`, and `swarm_run_id` resolves only to `swarm_runs`, which has
no owner either. `oshal_budgets`/`oshal_budget_events` carry a `scope_key` that can be a sub, but
the table *is* the operator governance surface — walling it would hide an operator-set cap from the
operator; tamper-proofing is already enforced by `set_by_operator` in `setBudget`.

**PUBLIC (1)** — `market_bars`: RLS enabled with a deliberate permissive `market_bars_public` policy
and deliberately not forced.

**DEFERRED (8)** — these hold user rows and *could* be walled, but a real reader cannot present an
identity yet. Walling first would be an outage, not a hardening. Done-whens below.

### 4. Per-request tenant context — what is actually missing

The ADR-035/076 residual is usually written as "no per-request tenant context". That is not quite
what the code says, and the difference matters:

* the tenant-shared tier **already works without one**. `oshal_is_tenant_member(tenant_id)` (060)
  derives tenant access from `oshal.current_sub` through `oshal_tenant_memberships`, so a caller's
  tenant reach is a lookup, not a request parameter.
* what does not exist is **active-tenant narrowing**: a user who belongs to three tenants sees rows
  from all three. `RequestIdentity` carries `{ sub, isOperator, system }` and no tenant.

Adding a third GUC that no policy reads would be a stub, and rewiring
`oshal_is_tenant_member` to narrow would *hide rows from live surfaces* that have no tenant picker
to re-widen them. It is filed as a done-when below rather than half-built here. The rail to extend
when it is built is `RequestIdentity` → `setIdentityGucs` in `guc-pool.ts` — not a parallel one.

## Consequences

### Findings that contradict the existing backlog entries

1. **The named residual list is a month stale.** `personal_graph_*`, `chat_messages`,
   `agent_memories` and `knowledge_memory_documents` are closed (migration 094) yet still appear in
   `docs/backlog/hardening.md` #1 and BACKLOG item 1 as open. They should be struck.
2. **"84 tables" is stale in the other direction** — the live count is 167 FORCE-RLS'd before this
   change, 181 after.
3. **The residual was under-stated, not over-stated.** No document named any of the 54 core tables
   that were genuinely open, including the 83,305-row `ticket_status_history`.
4. **Systemic, and bigger than this ADR: 43 `scripts/**` CLIs open a raw `pg` Pool on
   `DATABASE_URL`, and not one stamps a GUC.** The operator `.env` sets
   `DATABASE_URL=postgresql://oshal_app` — NOSUPERUSER, NOBYPASSRLS — and FORCE ROW LEVEL SECURITY
   applies to the table owner too. Every one of those scripts therefore reads **zero rows** from any
   walled table. This is why migration 112 does not wall `oshal_trading_daily_equity` or
   `oshal_trading_strategy_journal`: it would have silently emptied the daily oshal report rather
   than raising an error.
5. **The cost ledger could swallow an RLS refusal.** `appendCostLedgerRow` caught *every* insert
   failure at `warn` and continued, so a policy rejection would drop a cost row and the windowed
   budget caps that read this table would fail **open** — the same shape as the ADR-119 intake
   defect. The refusal now logs at ERROR and is distinguishable from a missing table
   (`isRlsRefusal`, guarded by `tests/unit/cost-ledger-rls-refusal.spec.ts`).

### Deferred work — done-when criteria

* **Host CLIs cannot read walled tables.** Give `scripts/**` a shared operator-stamp helper (one
  connect-time `set_config('oshal.is_operator','on')`, the same trusted-operator context
  `runWithSystemIdentity` establishes in-process), migrate the 43 raw-pool scripts onto it, then
  wall `oshal_trading_daily_equity` + `oshal_trading_strategy_journal`.
  **Done when:** the daily report regenerates byte-identically with both tables FORCE-RLS'd, and a
  guard asserts no `scripts/**` file constructs a bare `new Pool` on `DATABASE_URL`.
* **Store packages on device/service auth.** `pumpkin_presets`, `pumpkin_settings`, `kalshi_orders`
  are core-migrated (084 / 074) but read only by carved packages over device or service auth, where
  no caller sub is established.
  **Done when:** those paths establish a caller identity (the machine-write-identity work), a live
  two-role proof covers the packaged surface, and the three tables move out of the exception list.
* **`ticket_governance`.** Its `ticket_id` is TEXT and only **69 of 215** rows still match a live
  ticket — 146 are orphaned queue-manager state. A derived policy would hide two thirds of the table
  from the ops read surface.
  **Done when:** the orphans are reaped (or given an explicit retention rule) and the
  `/api/qm/activity` read path is proven under a non-operator identity; then it takes the 113
  pattern with a `::uuid` cast.
* **`tool_approval_requests`.** Has a `task_id` and would take the `oshal_owns_task` policy, but it
  is the fail-CLOSED approval gate; a scoping mistake hides approval requests from the operator
  resolving them.
  **Done when:** a live spec proves the operator resolve path and the bot poll path both still see
  their rows under the policy.
* **`human_feedback`.** Keyed by `ticket_external_id` (TEXT), not the tickets uuid.
  **Done when:** a stable `external_id -> tickets` mapping exists; then the 113 pattern applies.
* **Active-tenant narrowing (the ADR-035/076 tenant clause).** Extend `RequestIdentity` with an
  active tenant, stamp it in `setIdentityGucs`, and have the tenant-tier policies narrow to it.
  **Done when:** a tenant picker exists on the surfaces that would otherwise lose rows, and a live
  spec proves a multi-tenant member sees only the active tenant's rows while retaining access after
  switching.

### What this change does not do

It does not weaken any existing policy, does not grant `BYPASSRLS`, and does not create, alter or
grant to any role — `oshal_bot`'s least-privilege shape from migration 099 is untouched. Both
migrations are idempotent, fresh-database tolerant, carry no top-level `BEGIN`/`COMMIT` (the
bootstrap runner wraps each file plus its ledger row in one transaction), and document a per-table
break-glass rollback.

### Guards

| guard | proves |
|---|---|
| `tests/rls-two-role-isolation-live.spec.ts` | Real two-identity isolation as the NOBYPASSRLS `oshal_bot` role, over both new policy shapes and the cost ledger: SELECT/UPDATE/DELETE all return zero for the second identity, cross-owner INSERT is refused, and the owner still sees its own row (so a deny-everyone policy fails too). Refuses to run against a role RLS cannot apply to. |
| `tests/rls-core-table-coverage-live.spec.ts` | Every core table (derived from `CREATE TABLE` across the tree, including `${IDENT}` template names) is walled or justified; stale exceptions and reason-less entries fail. |
| `tests/unit/cost-ledger-rls-refusal.spec.ts` | The ledger classifier separates a policy refusal (42501 / "row-level security") from the pre-090 `42703` fallback, a missing table, and ordinary infrastructure errors. |

All three FAIL rather than skip when their environment is missing.

# Row-Level Security (RLS) Runbook

How to apply OSHAL's Postgres RLS policies safely. The GUC identity wrapper is on by
default, but the RLS DDL is still deliberately operator-applied.

> **Status — 2026-06-27 (ADR-076):** RLS is now LIVE and enforced on the `oshal-local`
> stack, platform-wide across **84 tables** in 3 tiers (not just the original four), via
> migration `scripts/migrations/060-platform-rls-tenancy.sql`. The runtime connects as the
> non-superuser `oshal_app` role, which OWNS the tables (so startup/migration DDL still
> runs) while `FORCE ROW LEVEL SECURITY` scopes even the owner; the `SECURITY DEFINER`
> tenant helper stays owned by the superuser to avoid recursion. Provisioning + ownership
> reassignment: `docs/governance/app-role-provisioning.sql`. The 4-table examples and lists
> below are the original scaffold, retained for reference — the authoritative scope is now
> migration 060 / ADR-076.

## Why DDL Is Not Auto-Applied

RLS filters rows by comparing owner columns to session GUCs:

```sql
SET LOCAL oshal.current_sub = '<oidc-sub-of-caller>';
SET LOCAL oshal.is_operator = 'on'; -- or 'off'
```

If enforced RLS is forced while the app is not stamping those GUCs, normal users see zero
rows. That looks like data loss. Apply policies in stages and validate each stage.

## Runtime Contract

The app must set `oshal.current_sub` and `oshal.is_operator` on the same pooled connection
used for each query. `wrapPoolWithGuc()` handles this by proxying `Pool.query()` and
`Pool.connect()`, stamping request identity from `AsyncLocalStorage`, then resetting the GUCs
before the connection returns to the pool.

Current code seams:

- `src/shared/services/database/guc-pool.ts`
- `src/shared/services/database/request-identity.ts`
- `src/app/composition/app-runtime-factory.ts`
- `src/shared/services/database/optional-postgres-pool.ts`
- `src/app/server.ts`
- `src/app/bot-node-server.ts`

`OSHAL_DB_GUC` is on by default. Set `OSHAL_DB_GUC=off` only as a break-glass rollback, and
only after disabling restrictive RLS on affected tables.

## Background Identity & Strictness (`OSHAL_DB_GUC_STRICT`, deny-by-default since 2026-07-20)

Every `/api` request runs under `runWithRequestIdentity` (server middleware), so request DB
access is always scoped to the caller. **Background work has no request in scope** — schedulers,
the queue manager, swarm/bot workers, boot code, cron sweeps, the bot-node execute path. Those
paths must mark themselves trusted by running under **`runWithSystemIdentity`** (the positive
SYSTEM sentinel), which the GUC pool stamps `is_operator='on'` regardless of strict mode.

`OSHAL_DB_GUC_STRICT` governs what happens to a DB access that has **neither** a request identity
**nor** the SYSTEM sentinel (a bare "no context at all"):

| value | identity-less stamp | meaning |
|---|---|---|
| `deny` **(default)** | `is_operator='off'`, `sub=''` | fail-CLOSED — RLS scopes the query to nothing, so an un-migrated background caller fails loudly instead of reading cross-tenant |
| `warn` | `is_operator='on'` (operator) | historical behavior, but LOGS each unique identity-less call site once — the audit tool |
| `off` | `is_operator='on'` (operator) | break-glass rollback to the historical fail-open-to-operator |

Any unrecognized value falls back to `deny`. The SYSTEM sentinel is **always** operator, even
under `deny`. Every legitimate background path is migrated to the sentinel and locked by the
static guard `tests/unit/background-system-identity.spec.ts` (a reverted wrap or a new bare
background caller in a listed seam fails CI).

**Rollout of the deny default (do this before enforcing it live):**

1. Deploy with `OSHAL_DB_GUC_STRICT=warn`. Exercise normal + scheduled/background flows.
2. Grep the logs for `DB access ran with NO request identity` — each unique call site is logged
   once. Confirm every site is either a legitimate background path (migrate it to
   `runWithSystemIdentity`) or does not touch an RLS-scoped table.
3. Once the warn log is clean, remove the pin so the `deny` default enforces.
4. **Break-glass:** on an outage that looks like starved background reads, set
   `OSHAL_DB_GUC_STRICT=off` (immediate) and root-cause the missed seam.

## Rollout

1. Verify the wrapper is active.
   Leave `OSHAL_DB_GUC` unset or truthy. Run normal user flows and confirm task, message,
   cockpit, and ticket reads still work.

2. Provision a non-superuser app/proof role.
   RLS cannot protect a runtime connected as a superuser or `BYPASSRLS` role. Use the current
   database owner/admin connection to create a least-privileged app role, then point the app and
   verifier at that role after the policy rollout.

```bash
node scripts/governance/provision-rls-app-role.mjs
OSHAL_DB_ROLE_APPLY=apply OSHAL_APP_DB_ROLE=oshal_app OSHAL_APP_DB_PASSWORD='<strong-password>' npm run provision:rls-role
```

Runtime adoption note: the current app still has self-healing schema/bootstrap code that runs DDL
through the normal pool. Before recreating a shared/hosted runtime with the non-superuser URL,
make sure migrations/schema bootstrap have already run as the owner/migrator role, or deliberately
split migration credentials from runtime credentials. Do not silently fall back to the superuser
runtime role; that bypasses RLS.

Set `OSHAL_SCHEMA_BOOTSTRAP=validate-only` for the app-role runtime after migrations are applied.
In that mode, shared persistence schemas validate required tables/columns instead of running DDL,
and the normal Postgres pools block runtime `CREATE`/`ALTER`/`DROP` statements. Verify this before
recreating hosted traffic:

```bash
OSHAL_SCHEMA_BOOTSTRAP=validate-only DATABASE_URL='postgres://oshal_app:...' npm run verify:runtime-schema
```

3. Backfill legacy ownership and quarantine rows that cannot be safely inferred.

```bash
node scripts/governance/backfill-owner-sub.mjs
OSHAL_OWNER_BACKFILL=apply node scripts/governance/backfill-owner-sub.mjs
OSHAL_OWNER_QUARANTINE=apply node scripts/governance/backfill-owner-sub.mjs
OSHAL_OWNER_BACKFILL=apply OSHAL_OWNER_QUARANTINE=apply node scripts/governance/backfill-owner-sub.mjs
```

The script assigns `owner_sub` only when a unique linked owner can be inferred
from ticket/task/workspace relationships. Do not guess. Remaining legacy rows
should stay `owner_sub IS NULL` and be tagged in `metadata` with:

```json
{
  "ownerDisposition": "operator_only",
  "ownerDispositionReason": "legacy_unowned_no_safe_backfill"
}
```

Under enforce-stage RLS, those rows are hidden from normal users and visible only
to operators.

4. Apply permissive RLS.

```bash
OSHAL_RLS_APPLY=apply-permissive node scripts/governance/apply-rls.mjs
OSHAL_RLS_VERIFY_STAGE=permissive npm run verify:rls
```

5. Soak and validate.
   Normal users should see only their rows when the GUC is set. Operators should see all rows.
   Legacy `owner_sub IS NULL` rows are still visible in the permissive stage.

6. Apply enforcement.

```bash
OSHAL_RLS_APPLY=apply-enforce node scripts/governance/apply-rls.mjs
npm run verify:rls
```

The enforce stage uses `docs/governance/rls-policies-enforce.sql`, which installs forced
owner-or-operator policies for:

- `tickets.owner_sub`
- `workspaces.owner_sub`
- `access_audit_log.actor_sub`
- `chat_tasks.owner_sub`

## Validation Queries

```sql
SELECT count(*) FILTER (WHERE owner_sub IS NULL) AS unowned, count(*) AS total FROM tickets;
SELECT count(*) FILTER (WHERE owner_sub IS NULL) AS unowned, count(*) AS total FROM workspaces;
SELECT count(*) FILTER (WHERE owner_sub IS NULL) AS unowned, count(*) AS total FROM chat_tasks;
SELECT count(*) FILTER (WHERE metadata->>'ownerDisposition' = 'operator_only') AS operator_only FROM tickets;
SELECT count(*) FILTER (WHERE metadata->>'ownerDisposition' = 'operator_only') AS operator_only FROM workspaces;
SELECT count(*) FILTER (WHERE metadata->>'ownerDisposition' = 'operator_only') AS operator_only FROM chat_tasks;
```

Validation checklist:

- Normal user: sees only owned rows.
- Operator: sees all rows.
- Anonymous stamped request: sees no owned rows.
- Permissive stage: `OSHAL_RLS_VERIFY_STAGE=permissive npm run verify:rls` passes, but this is
  not the public-user gate because table owners and unset GUC rollout behavior may still be open.
- Enforce stage: `npm run verify:rls` passes with a non-superuser/non-`BYPASSRLS` app role.
- Runtime schema stage: `OSHAL_SCHEMA_BOOTSTRAP=validate-only npm run verify:runtime-schema`
  passes with the same app role and proves runtime DDL is blocked.
- Runtime database URL uses that non-superuser role. A passing verifier on a separate proof role
  is useful, but a public-user gate requires the app runtime to stop using a superuser DB role.
- App flows: cockpit, task list, chat messages, ticket activity, and governance posture still load.

`verify:rls` inserts synthetic A/B rows for `tickets`, `workspaces`, `access_audit_log`, and
`chat_tasks` inside a transaction, stamps `oshal.current_sub` / `oshal.is_operator` as user A,
user B, operator, and anonymous, then rolls back. It intentionally fails when the connection role
is a superuser or has `BYPASSRLS`, because that role cannot prove tenant isolation.

## Rollback

Fastest data-safe rollback is to disable RLS on affected tables:

```sql
ALTER TABLE tickets DISABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces DISABLE ROW LEVEL SECURITY;
ALTER TABLE access_audit_log DISABLE ROW LEVEL SECURITY;
ALTER TABLE chat_tasks DISABLE ROW LEVEL SECURITY;
```

After enforced RLS is disabled, `OSHAL_DB_GUC=off` can be used to bypass identity stamping while
you diagnose the wrapper. Do not turn the wrapper off while enforced RLS is still active unless
the intended outcome is zero rows for normal users.

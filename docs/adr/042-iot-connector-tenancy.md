# ADR 042 — IoT / Connector Tenancy (Personal + Shared)

- **Status:** Accepted — **Phase 1 built** (app-layer: schema + personal∪shared resolution + household management API + `/utilities` selector; backward-compatible). Phase 2 (RLS) and Phase 3 (provisioning/invites + per-tenant cost) pending. Migration validated on live Postgres (partial indexes + both ON CONFLICT targets + personal/shared coexistence).
- **Date:** 2026-06-17
- **Owner:** maintainer@emeraldcoastsystemsgroup.com
- **Extends:** [ADR-035 Multi-Tenant SaaS Foundation](035-multi-tenant-saas-foundation.md), [ADR-038 Swarms Bundled by Type](038-swarms-bundled-by-type.md), [ADR-036 Bot-Owned Application Architecture](036-bot-owned-application-architecture.md)
- **As-built it builds on:** [connectors-tenant-isolation.md](../architecture/connectors-tenant-isolation.md)

## Context

The IoT / smart-home bundle (ADR-038) lets a signed-in user connect a hub
(SmartThings OAuth-In, Google Nest) at `/utilities`; the `home-bot` reads and
controls that user's devices via the per-user connector token.

**Multi-user isolation is already built and traced end-to-end** (it is *not* what
this ADR adds):

- `oshal_connections` is keyed **`UNIQUE(user_sub, provider)`** — one row per user.
- The chat path threads the authenticated caller's `sub`:
  `message-routes.ts` → `resolveBotCreds(pool, callerSub, ['google','twitter','smartthings'])`
  → `task-orchestrator` → `agentic-loop` → both bot transports
  (`BotNodeClient`/`bot-node-execution-handler` and the inline
  `base-cli-harness-adapter`) drop `OSHAL_USER_SUB` + `.oshal-cred-<provider>` into
  the per-request workspace.
- `scripts/oshal-smartthings.js` prefers the caller's brokered token, else
  DB-decrypts **scoped to that `user_sub`**, and **fails closed** (refuses to guess)
  when more than one account is connected and no sub is given.

So **Joe's chat uses Joe's hub; Sue's uses Sue's.** Today every connection is
**personal** (implicitly `tenant_id = NULL`).

What's missing is **shared** access. A smart home is inherently both:

1. **Personal** — a person's own connected accounts (today's behavior).
2. **Shared** — a *household* (or a small org) where several people control the
   **same** devices/scenes from **one** connected hub.

ADR-035 commits the platform tenancy mechanism (`tenant_id` on every tenant-owned
table + Postgres **RLS** + realm-per-tenant Keycloak + per-tenant cost), but that
was scoped to **org/district SaaS tenants** and has not been applied to the
connector store. This ADR defines how IoT connectors become **both personal and
tenant-shared**, reusing ADR-035's mechanism, and reconciles a lighter tenant
type (a *household*) with ADR-035's heavier org tenant.

## Decision

### 1. Two tenant *types*, one mechanism

- **`org` tenant** (ADR-035): a customer org (school district). Heavy —
  realm-per-tenant Keycloak, seat licensing, subdomain. Unchanged by this ADR.
- **`space` tenant (household)**: a lightweight membership grouping **inside the
  existing realm** (one shared sign-in). No new realm. This is the IoT unit of
  sharing — a family/household that co-owns hubs.

Both are rows in the ADR-035 `tenants` table, distinguished by a `kind` column
(`'org' | 'space'`). IoT sharing uses `kind='space'`; it does **not** require the
realm-per-tenant lifecycle, which keeps households cheap to create.

### 1b. Multi-account: many labeled connections per provider

A user (or household) may connect **several accounts of the same provider** — two
Gmails, a home and a lake-house SmartThings. Each is its own `oshal_connections` row:

- **Uniqueness is per ACCOUNT** — `account_key` (the real account id, else email) is the
  discriminator, so re-connecting the same account **updates in place** (no duplicate) while
  a different account **adds** a new connection. Unique indexes:
  `(user_sub, provider, account_key) WHERE tenant_id IS NULL` (personal) and
  `(tenant_id, provider, account_key) WHERE tenant_id IS NOT NULL` (shared).
- **`label`** is a mutable nickname and the primary SELECTOR ("work email", "lake house").
  **Not** a unique key — just how the user/bot refers to a connection. `account_email` is
  also a selector. `is_default` marks the one to use when a request names none.
- Resolution (`ConnectionSelector`): `connectionId` > `label` (case-insensitive) > `email`
  > nothing → default → single → household-first. A *named* selector with no match returns
  null so the bot **asks** rather than guessing.

### 2. Data model — `tenant_id` is nullable on `oshal_connections`

```
oshal_connections.tenant_id  UUID NULL  REFERENCES tenants(tenant_id)
  -- NULL      → personal: owned by user_sub (today's behavior, unchanged)
  -- non-NULL  → shared:   owned by the tenant; any member may use it
oshal_connections.connected_by_sub  TEXT  -- who performed the OAuth grant (audit)
```

The existing `UNIQUE(user_sub, provider)` becomes
`UNIQUE(COALESCE(tenant_id::text, user_sub), provider)` (one connection per
provider per *owner*, owner = tenant when shared, else the user).

Membership (reused from ADR-035 if present, else added):

```
tenant_memberships(tenant_id, user_sub, role)   -- role: 'admin' | 'member'
```

`tenant_id` **defaults NULL**, so the migration is **backward-compatible**: every
existing connection stays personal and nothing breaks.

### 3. Access resolution — personal ∪ shared

A caller's visible connections for a provider =

```
personal:  user_sub = :caller AND tenant_id IS NULL
   ∪
shared:    tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_sub = :caller)
```

When a user has both a personal and a shared connection for a provider (the
"Both" case), the bot/CLI selects by explicit target (e.g. "use the home account")
and otherwise defaults to the **shared/household** connection, surfacing which one
it used. The CLI's existing fail-closed behavior is preserved for genuine ambiguity.

### 4. Enforcement — RLS as the DB guarantee (ADR-035 phase, deferred)

Per ADR-035, app-layer scoping is upgraded to a **Postgres RLS** policy on
`oshal_connections`, set from a per-request GUC:

```sql
USING (
  user_sub = current_setting('oshal.user_sub', true)
  OR tenant_id IN (
    SELECT tenant_id FROM tenant_memberships
    WHERE user_sub = current_setting('oshal.user_sub', true)
  )
)
```

This is the invasive, platform-wide step ADR-035 flags ("touches every
tenant-owned table; do it before data accumulates"). This ADR pilots RLS on
`oshal_connections` as part of that initiative — **not** as a connector-only hack.

### 5. Threading to the bot / CLI

- `OSHAL_USER_SUB` (already threaded) identifies the caller.
- Add **`OSHAL_TENANT_IDS`** (the caller's space/household memberships) to the same
  `extraEnv`/workspace-file channel (`user-scoping.js`, `base-cli-harness-adapter`).
- `resolveBotCreds` extends to broker tokens for the caller's **personal *and*
  accessible shared** connections (still best-effort; DB-decrypt fallback remains).
- `oshal-smartthings.js` (and each `oshal-<provider>.js`) resolves the connection
  via personal ∪ shared, honoring an explicit target.

### 6. UI

`/utilities` (IoT category) lets the user connect **personally** or **to a
household they admin** (a small selector on the Connect action). The connection
card shows the owner ("Personal" vs "🏠 Smith Home") and who connected it.

### 7. Cost

`chat_tasks` gains `tenant_id` (ADR-035) so shared-tenant home-bot usage rolls up
to the household/org, while personal usage stays attributed to the user.

## Consequences

**Positive**
- Personal *and* shared both work, on **one** mechanism (ADR-035), not a bespoke one.
- Backward-compatible: `tenant_id NULL` default leaves all existing personal
  connections untouched; no data migration of current rows.
- RLS makes isolation a **database** guarantee, shrinking the blast radius of app bugs.
- Households are cheap (no realm-per-tenant), so sharing a hub is a low-friction feature.

**Negative / risks**
- **RLS is invasive** (every tenant-owned table + a per-request GUC). Must land via
  the ADR-035 initiative, not piecemeal, or the model is half-applied and inconsistent.
- **Shared-token security:** a shared hub token lets *every* household member control
  *all* its devices (incl. locks/garage). Requires explicit consent at connect time,
  visible membership, easy revocation, and an audit trail (`connected_by_sub` + action log).
- Membership + invite UX is new surface (who can join a household, admin vs member).
- Selecting among multiple eligible connections needs a clear default + override, or
  the bot acts on the wrong hub.

**Neutral**
- `space` (household) vs `org` (district) as two `kind`s keeps IoT light while staying
  consistent with the ADR-035 org model.

## Phased plan

1. **Schema + app-layer scoping (backward-compatible) — ✅ BUILT (2026-06-17):**
   `oshal_tenants` (with `kind`), `oshal_tenant_memberships`, nullable `tenant_id` +
   `connected_by_sub` on `oshal_connections`, partial unique indexes (personal vs
   shared) in [connector-tenancy.ts](../../src/app/routes/connector-tenancy.ts);
   personal ∪ shared resolution (household-first) in `getValidAccessToken` →
   automatically flows through the existing token broker to the bot; connect/token
   write paths take a target household; minimal management API
   [tenant-routes.ts](../../src/app/routes/tenant-routes.ts) (`/api/tenants`);
   `/utilities` "Connecting as" household selector + owner labels. No RLS yet.
   **Multi-account (built 2026-06-17):** account-keyed uniqueness + `label`/`is_default`
   selectors; connect/token routes take a label; `/list` returns every labeled
   connection; per-connection relabel / make-default / disconnect routes; `/utilities`
   lists each account with rename/default/disconnect + an "Add account" affordance.
   `getValidAccessToken`/`/access-token` accept a `ConnectionSelector` (label/email/
   connectionId/tenant). Validated on live PG (two Gmails coexist, label selection,
   no-dup-on-reconnect).
   Not yet done in P1: shared-connection disconnect (admin) — see P3.

1b. **Bot selection intelligence (NEXT — Increment 2):** inject the labeled-connection
   **catalog** (provider, label, account, connectionId — no tokens) into the bot's
   per-request workspace; CLIs accept `--label`/`OSHAL_CONNECTION_LABEL`; the broker
   brokers the selected/needed tokens; personas match "open my work email" → the right
   label and **ask when ambiguous**. This is the headline UX ("connect to my lake house
   SmartThings and show the Ring camera").
2. **RLS enforcement** (with the ADR-035 RLS pilot): policy on `oshal_connections`,
   per-request `oshal.user_sub` GUC, then expand to other tenant-owned tables.
3. **Household provisioning + invites + audit + per-tenant cost** (`chat_tasks.tenant_id`),
   plus admin disconnect of a shared hub and the open per-member-scope question.

## Open questions

- Do shared IoT connections need **per-member scope limits** (e.g. a member can read
  device state but not unlock doors)? Or is membership all-or-nothing for v1?
- Default when a user has both personal and shared for one provider — household-first
  (proposed) or last-used?
- Does a household reuse the ADR-035 `tenants` table immediately, or get a minimal
  `spaces` table first and merge later? (Proposed: one `tenants` table with `kind`.)

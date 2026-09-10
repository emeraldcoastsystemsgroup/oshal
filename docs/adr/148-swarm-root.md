# ADR-148 — Swarm root: the first account becomes a role, and the operator gate reads roles

- **Status:** **Accepted — BUILT 2026-09-09** (PR #415, deployed 2026-09-10). Remaining items are
  listed under [Not built](#not-built) and tracked in [BACKLOG](../BACKLOG.md).
- **Date:** 2026-09-09
- **Author:** maintainer@emeraldcoastsystemsgroup.com
- **Related:**
  [ADR-117 (local auth + invited users)](117-local-auth-invited-users.md) — where the first account
  is created;
  [ADR-147 (multi-registry App Loader)](147-multi-registry-app-loader.md) — the admin-only surface
  whose premise check surfaced this gap;
  [ADR-118 (app access tiers)](118-app-access-tiers.md) — who may *use* an app, a separate question
  from who may *administer* the swarm.

---

## Context

Operator direction, 2026-09-09: *"we need a swarm root.. this is what we are missing this is why
default passwords are confusing."*

The report was accurate, and it had a specific cause. The platform ran **two identity systems that
never met**:

| | what it is | who is in it | what it gates |
|---|---|---|---|
| Operator allowlist | `OSHAL_OPERATOR_SUBS` / `OSHAL_OPERATOR_EMAILS`, read by `isOperatorIdentity` in [authz.ts](../../src/shared/middleware/authz.ts) | whoever was typed into the operator-local `.env` | `requiresOperator` — the privilege gate |
| Local accounts | `oshal_local_users`, created by `bootstrapFirstAdmin` in [local-user-store.ts](../../src/features/local-auth/services/local-user-store.ts) | the first person through `/login` on an empty store, then their invitees | who may **sign in** |

There was no role column and no code path between the two. The code described the first local
account as *"the installer is the first admin"*, yet nothing added its subject to the allowlist.
Every `OSHAL_OPERATOR_SUBS` write in the tree was a hand-edited `.env` or a script reading its first
entry as a fallback sending identity.

The three first-run stories therefore disagreed:

| auth mode | how you sign in | who is "admin" | password |
|---|---|---|---|
| `MOCK_OIDC` (what `scripts/oshal-install.sh` configures) | no sign-in page | `OSHAL_OPERATOR_EMAILS`, written from an installer prompt | none |
| `LOCAL_AUTH` | `/login`, first account via `bootstrapFirstAdmin` | **nobody** | the one you set |
| `OIDC` | external identity provider | hand-typed `.env` | the provider's |

Under `LOCAL_AUTH`, the person who set the very first password received no privilege from it, and
every operator-gated page answered them 403.

---

## Decision

### D1 — Root is a row, and "exactly one" is a database invariant

`swarm_roles` holds `root | admin | user`, keyed by subject. A **partial unique index**
(`swarm_roles_single_root … WHERE role = 'root'`) makes "at most one root" a property of the schema:
a concurrent second claim fails as a constraint violation rather than as a lost update, and code
that bypasses the store entirely still cannot create a second root.

The table is not owner-RLS'd. The privileged-identity cache must read every row under the system
identity to answer "who is an admin"; a policy that hid other rows would produce a cache containing
only the reader. Access is fenced in the route layer instead (D5).

### D2 — Root has exactly two doors

- **Claim** — only while root is unclaimed.
- **Transfer** — one transaction; the outgoing root is demoted to `admin` rather than removed, so
  handing the swarm over does not lock its previous owner out of a machine they still run.

`grantRole` cannot mint root and `revokeRole` cannot remove it, so a swarm can never be left rootless.

### D3 — The gate changes in one function, without becoming async

`isOperatorIdentity` is the single chokepoint for every operator check (159 call sites, many inside
Express middleware). It stays **synchronous**. Feature-Sliced Design forbids `shared/` importing
`features/`, so the dependency is inverted:
[privileged-identities.ts](../../src/shared/middleware/privileged-identities.ts) owns a small
replaceable snapshot; `@/features/swarm-roles` loads root + admin into it at boot and after every
role write. A grant or revoke takes effect on the next request with no restart.

A failed role-store read **clears** the snapshot rather than leaving it stale; a stale set would keep
a revoked admin's access until the next successful load.

### D4 — The env allowlist is break-glass, permanently

`isOperatorIdentity` consults database roles first, then the allowlist. The allowlist is never
removed (operator decision): it is how an existing deployment adopts roles with zero configuration
change, and it is the recovery path when the database is unreachable or root has been lost.
`isBreakGlassOnlyOperator` reports when an identity's privilege comes only from the allowlist, so the
Users page can say so instead of leaving that state invisible.

### D5 — First run claims root; claiming is otherwise narrow

- `POST /api/local-auth/bootstrap` claims root for the account it creates. This is safe because
  `bootstrapFirstAdmin` is race-guarded to an empty user store — it is the only identity on the swarm.
  A failed claim (root already held) is logged and does not fail the bootstrap.
- `POST /api/swarm/roles/claim-root` is deliberately **not** behind `requiresOperator` — on a fresh
  swarm nobody passes that gate yet. Its own conditions are the gate: an authenticated caller, root
  genuinely unclaimed, and either no roles exist at all or the caller already passes break-glass.
  The last condition stops a later invited user on an established swarm from claiming an unclaimed
  root.
- Every other role route is `requiresOperator`; transfer is additionally root-only.

### D6 — The Users page

`/users` shows root status (claim, transfer), the role table (grant, change, remove), and — under
`LOCAL_AUTH` only — the local accounts with a one-click "make admin". It is mounted `requiresAuth`
only: it is where a signed-in user learns they are not an admin, and where the first person on a
virgin swarm claims root. The cockpit rail shows **Users** to operators only (the same
`_loadOperatorState` flag as Dead Letters, which reads `isOperator()` and therefore honours roles).

---

## Consequences

- An existing deployment is unchanged on day one: roles load empty, root is unclaimed, and the
  allowlist keeps granting access. The API logs `SWARM ROOT IS UNCLAIMED` at boot until someone
  claims it from `/users`.
- A `LOCAL_AUTH` swarm's first account is now its administrator.
- Operator status can be granted and revoked from a browser; it no longer requires editing a file
  and restarting.

## Not built

- **`MOCK_OIDC` root adoption.** The installer-configured identity remains break-glass-only until
  root is claimed from `/users`; nothing adopts it automatically.
- **Account invite/disable from `/users`.** The page lists local accounts and grants roles; inviting
  and disabling still go through the existing local-auth admin API.
- **A route-level guard through the real middleware chain** proving a signed-in non-operator gets
  403 from an operator-gated route. The shipped guards exercise the store and `isOperatorIdentity`
  against live Postgres; the route 401/200 paths were verified live, the authenticated-non-operator
  403 path was not.

## Guards

[tests/unit/swarm-roles-store.spec.ts](../../tests/unit/swarm-roles-store.spec.ts) — 16 cases against
the live Postgres, including a raw SQL second-root `INSERT` rejected with `23505`, a two-claim race
with exactly one winner, revoked access dropping without a restart, env break-glass with no roles
loaded, and fail-closed with neither source configured. A missing database fails the suite rather
than skipping it.

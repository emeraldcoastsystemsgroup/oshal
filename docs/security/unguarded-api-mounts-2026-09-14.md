# Three `/api` mounts registered without `requiresAuth` — route-by-route evidence

**Date:** 2026-09-14 · **Posture:** read-only audit. No route, middleware or guard was changed.

`src/shared/middleware/oidc.ts` configures `express-openid-connect` with `authRequired: false`, so an
Express mount that omits `requiresAuth` is anonymous-callable by default. Three mounts in
`src/app/server.ts` omit it:

| line | mount |
|---|---|
| `src/app/server.ts:1141` | `/api/authorization/tenant-memberships` |
| `src/app/server.ts:1142` | `/api/authorization` |
| `src/app/server.ts:1143` | `/api/user-directory` |

(Line numbers are the current working tree on `fix/core-lint-cap`. The same three mounts exist
verbatim on `origin/main` at lines 1190-1192; an unrelated concurrent edit to `server.ts` shifted
them. This is a pre-existing condition, not a new regression.)

## The finding in one line

**All three are self-guarded, and the guard is `requiresAuth` itself.** The mount passes
`requiresAuth` into the route factory rather than wrapping the mount, and each factory applies it as
the first router-level middleware. This is the pattern CLAUDE.md explicitly blesses
(`registerFooRoutes(app, requiresAuth, deps)` — "good — accept requiresAuth as a param").

`src/app/server.ts:1139-1140` builds the shared dependency object:

```ts
const authorizationRoutes = { requiresAuth, resolveActor: applicationAuthorization.resolveActor,
  authorizationTool: applicationAuthorization.authorizationTool };
```

`requiresAuth` there is the real guard, destructured at `src/app/server.ts:587` from
`createApplicationAuthMiddlewareSet(ctx.pool)` (`src/app/server.ts:592`) — the identical binding
used by every conventionally-guarded mount in the file (`/api/providers`, `/api/budgets`, …). In
every auth mode the set returns a fail-closed guard (`src/app/middleware/application-auth.ts:187`
returns `local.requiresAuth` for the hybrid posture; the OIDC branches return
`express-openid-connect`'s own `requiresAuth`).

Each factory applies it as the **first** statement after `Router()`, before any route is registered:

| factory | file:line |
|---|---|
| `createAuthorizationRoutes` | `src/app/routes/authorization-routes.ts:57` |
| `createExternalTenantMembershipRoutes` | `src/app/routes/external-tenant-membership-routes.ts:25` |
| `createUserDirectoryRoutes` | `src/app/routes/user-directory-routes.ts:23` |

No route in any of the three routers is registered ahead of that line, so there is no ordering gap.

## Layered guards beneath `requiresAuth`

A session alone is not sufficient for any of these routes. Two further layers apply:

1. **Actor resolution is fail-closed.** `createApplicationAuthorizationActorResolver`
   (`src/app/middleware/application-authorization-identity.ts:50`) throws `status: 401` when no
   verified `sub`/`issuer` is present, and explicitly rejects the guest issuer
   (`application-authorization-identity.ts:64-67`). A guest or anonymous caller could not obtain an
   actor even if `requiresAuth` were removed.
2. **Every handler re-checks authority against freshly refreshed identity**, so a revoked admin
   cannot ride a stale session (`ApplicationAuthorizationService.currentActor`,
   `src/features/application-authorization/service.ts:258-268`).

## Per-route inventory

### `/api/authorization` — `src/app/routes/authorization-routes.ts`

Router guards: `requiresAuth` (L57), `Cache-Control: private, no-store` (L58), and for every
route below L74 also `authorizationSameOrigin` (L29-37: requires matching `Origin`, non-cross-site
`Sec-Fetch-Site`, the `x-oshal-access-request: 1` header, and JSON content type) plus a 32 kb body cap.

| Method + path | Exposes / does | Self-guard (file:line) | Classification |
|---|---|---|---|
| `GET /catalog` (L63) | Full authorization catalog: registered apps, user inventory, group inventory, assignments, revision | `requiresAuth` L57; `service.catalog` requires `platform:authorization.read` (`service.ts:93`) and swarm-admin or per-app management scope, else 403 (`service.ts:94-95`) | self-guarded |
| `GET /me` (L66) | The **caller's own** effective permissions | `requiresAuth` L57; schema omits `targetSub`/`targetIssuer` (L67) so the target is always self (`service.ts:288-289`) | self-guarded |
| `GET /audit` (L70) | Redacted applied-authorization history | `requiresAuth` L57; `readAuthorizationAudit` requires `managementAllowed(...,'read')`, and a global (no-`app`) or external-tenant query requires `isSwarmAdmin`, else 403 (`src/features/application-authorization/audit-history.ts:31-34`) | self-guarded |
| `POST /effective` (L75) | Effective permissions for an **arbitrary** target | `requiresAuth` L57 + same-origin L74; non-self targets hit `requireManagement(actor, app, tenantId, 'read')` → 403 (`service.ts:287-291`) | self-guarded |
| `POST /explain` (L76) | Decision trace for an operation | same as `/effective` (`service.ts:136`, `service.ts:287-291`) | self-guarded |
| `POST /preview` (L77) | Stages a permission change (no write to policy) | `requiresAuth` L57 + same-origin L74; `previewChange` re-resolves the actor and `validateChange` refuses management-role grants unless `isSwarmAdmin` (`service.ts:250`) | self-guarded |
| `POST /apply` (L78) | **Writes** an authorization change | `requiresAuth` L57 + same-origin L74; preview must belong to the same `sub`+`issuer` else 404 (`service.ts:208`), expiry/revision conflict checks (`service.ts:211-213`), self-sensitive changes need approval (`service.ts:216`) | self-guarded |
| `POST /tool` (L81, only when `authorizationTool` is wired) | Same six operations through the registered tool contract, `allowChanges: true` | `requiresAuth` L57 + same-origin L74; `AuthorizationToolRuntime.execute` re-resolves the caller (`src/app/composition/authorization-tool.ts:103`) and refuses an inactive/unverified actor (`authorization-tool.ts:104`); each operation delegates to the same guarded service methods | self-guarded |

One nuance worth recording: `POST /tool` with `operation: 'catalog'` falls back to
`service.ownCatalog(actor)` when the full catalog is denied (`authorization-tool.ts:87-88`).
`ownCatalog` (`service.ts:111-122`) returns only apps the caller personally has non-denied access to,
with `users: []`, `groups: []`, `assignments: []` — a self-scoped view, not a privilege escalation.

### `/api/authorization/tenant-memberships` — `src/app/routes/external-tenant-membership-routes.ts`

Router guards: `requiresAuth` (L25), no-store (L26), and same-origin + 8 kb JSON cap for the POSTs (L31).

| Method + path | Exposes / does | Self-guard (file:line) | Classification |
|---|---|---|---|
| `GET /catalog` (L30) | External business-tenant membership inventory | `requiresAuth` L25; `currentAdmin(actor, false)` requires an active refreshed identity matching the request actor (401) **and** `isSwarmAdmin` + `platform:authorization.read` (403) — `src/features/external-tenant-memberships/service.ts:54-64` | self-guarded |
| `POST /preview` (L32) | Stages a tenant membership grant/revoke | `requiresAuth` L25 + same-origin L31; `currentAdmin(actor, true)` requires `platform:authorization.assign` **and** `.directory` (`service.ts:60-63`) | self-guarded |
| `POST /apply` (L33) | **Writes** a tenant membership change | `requiresAuth` L25 + same-origin L31; `currentAdmin(actor, true)` is called twice — before and after preview resolution (`service.ts:48-51`) so a mid-flight revocation is caught | self-guarded |

### `/api/user-directory` — `src/app/routes/user-directory-routes.ts`

Router guards: `requiresAuth` (L23), no-store (L24), and a **blanket admin gate at L25-28** that runs
`resolveActor` + `requireRosterAdmin(actor)` for every route in the router before any handler.

`requireRosterAdmin` (`src/features/principal-directory/registration-store.ts:36-41`) throws 401
without an active verified identity, 403 without `isSwarmAdmin`, and 403 without
`platform:authorization.read` (or `.assign` + `.directory` for writes).

| Method + path | Exposes / does | Self-guard (file:line) | Classification |
|---|---|---|---|
| `GET /` (L29) | **The full platform user roster** — every known identity's `sub`, `issuer`, display label (which falls back to email, `src/app/composition/application-principal-directory.ts:112`), sign-in source, status, `lastSeenAt`, plus historical principal references and configured providers | `requiresAuth` L23; router-level `requireRosterAdmin` L26; **and again** inside `roster` itself (`application-principal-directory.ts:122`); the roster's assignment-user input comes from `service.catalog(actor)` (`src/app/server.ts:1144-1145`), which re-checks independently | self-guarded |
| `POST /preview` (L34) | Stages a roster metadata import | `requiresAuth` L23; `requireRosterAdmin` L26; `registrations.preview` re-checks with `'assign'` (`registration-store.ts:61`); same-origin + 512 kb cap (L33) | self-guarded |
| `POST /apply` (L37) | **Writes** reviewed roster metadata (labels only — never grants sign-in or access) | `requiresAuth` L23; `requireRosterAdmin` L26; `registrations.apply` re-checks with `'assign'` (`registration-store.ts:74`); actor re-resolved at apply time (L38) | self-guarded |

**Classification summary: 14 of 14 routes are self-guarded. Zero are anonymous-callable. Zero expose
anything to an unauthenticated caller.**

## Why the guards are red anyway

Both route-auth guards currently fail on these three mounts, and the failure is a **classifier
limitation, not a security hole**:

- `tests/unit/server-route-auth-inventory.spec.ts` — `classifyMount` decides posture by testing
  whether the mount's argument text contains the literal substring `requiresAuth`
  (`tests/unit/server-route-auth-inventory.spec.ts:133`). These mounts pass `authorizationRoutes`,
  which does not contain that substring, so they classify as `unguarded` and are not on
  `UNGUARDED_ALLOWLIST` (`tests/helpers/unguarded-route-allowlist.ts:43-115`).
- `src/features/security/route-audit.ts` — the runtime Security Center scanner uses the same
  substring approach (`route-audit.ts:259`:
  `/requiresAuth|requireAuth|ensureAuth|authMiddleware|requiresContext|delegatedUserRouteAuth/`),
  and these paths are absent from `PUBLIC_BY_DESIGN` (`route-audit.ts:50-88`).

Observed (`npx vitest run`, 2026-09-14):

```
x server.ts /api anonymous-by-omission guard > every unguarded /api mount is on the reviewed allowlist
  -> "/api/authorization/tenant-memberships (app.use at src/app/server.ts:1141) ..."
  -> "/api/authorization (app.use at src/app/server.ts:1142) ..."
  -> "/api/user-directory (app.use at src/app/server.ts:1143) ..."

x route-audit ... the Security Center would show these as standing HIGH findings
  -> route_auth:/api/authorization/tenant-memberships (src/app/server.ts:1141)
  -> route_auth:/api/authorization (src/app/server.ts:1142)
  -> route_auth:/api/user-directory (src/app/server.ts:1143)
```

The second one matters beyond CI: the Security Center surface shows three standing HIGH route_auth
findings today, and per CLAUDE.md's guard-per-fix rule ("a red gate nobody acts on trains everyone to
ignore red") that state should not persist either way.

## Recommendation per mount

**`/api/authorization` — allowlist it; do not wrap the mount.** Every route under it applies
`requiresAuth` at `authorization-routes.ts:57` plus same-origin and per-operation permission checks;
wrapping the mount would add a second identical guard and change nothing observable.

**`/api/authorization/tenant-memberships` — allowlist it; do not wrap the mount.** Same reasoning:
`external-tenant-membership-routes.ts:25` guards the whole router, and `currentAdmin` refuses any
non-swarm-admin regardless.

**`/api/user-directory` — allowlist it; do not wrap the mount.** It is the most sensitive of the
three (it returns the full user roster), and it is also the most heavily guarded: `requiresAuth`,
a router-level `requireRosterAdmin`, and a third check inside `roster` itself.

A note on the mechanics of the allowlist option: `isPublicByDesign` matches on exact path **or**
`/`-boundary prefix (`src/features/security/route-audit.ts:92`), so a `/api/authorization` entry
would also cover `/api/authorization/tenant-memberships` and any future `/api/authorization/*` mount.
Listing both paths explicitly keeps each one individually reviewed; note that
`tests/unit/route-audit.spec.ts` cross-checks the two lists for divergence, so both the CI allowlist
and `PUBLIC_BY_DESIGN` need the entries.

The durable fix for the class — teaching both classifiers that `requiresAuth` reaching a factory
through a named options object is a guarded posture — is larger than this decision and belongs in a
`BACKLOG` entry rather than in the allowlist change.

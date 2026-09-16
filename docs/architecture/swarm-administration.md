# Swarm administration and the App Loader — as built, and how to continue

Who may administer a swarm, and how applications get into one. This is the as-built state, the
reasoning that is expensive to rediscover, and the specific next step for every thread that is not
finished.

- **Decisions:** [ADR-148](../adr/148-swarm-root.md) (swarm root),
  [ADR-147](../adr/147-multi-registry-app-loader.md) (multi-registry App Loader; its *As built*
  section is authoritative over its decision text).
- **Deferred work:** [BACKLOG](../BACKLOG.md) — "Swarm root — the three pieces ADR-148 did not
  build", "App Loader — the ADR-147 decisions that did not ship", "One place that answers *what am
  I allowed to do*".
- **Related:** [ADR-117](../adr/117-local-auth-invited-users.md) (local accounts),
  [ADR-118](../adr/118-app-access-tiers.md) and the `application-authorization` feature (per-app
  access — a different axis, see below), [ADR-085](../adr/085-remote-app-packages-and-registries.md)
  (the package format and installer this builds on).

---

## 1. The problem this solves

A swarm had **two identity systems that never met**:

| | what it was | who was in it | what it gated |
|---|---|---|---|
| Operator allowlist | `OSHAL_OPERATOR_SUBS` / `_EMAILS`, hand-typed into the operator-local `.env` | whoever was typed in | `requiresOperator` — the real privilege gate |
| Local accounts | `oshal_local_users`, created by `bootstrapFirstAdmin` | the first person through `/login`, then their invitees | who may **sign in** |

No role column, no code path between them. Under `LOCAL_AUTH` the person who set the very first
password received **no privilege from it** and every operator-gated page answered them 403. Under
`MOCK_OIDC` there is no sign-in page at all and "admin" came from an installer prompt. Three
first-run stories that disagreed — which is why "default passwords" read as confusing.

## 2. What exists now

### Swarm root (ADR-148)

`swarm_roles` holds `root | admin | user`, keyed by subject.

- **At most one root is a DATABASE invariant** — a partial unique index
  (`swarm_roles_single_root … WHERE role = 'root'`). A concurrent second claim loses to a 23505
  rather than to a lost update, and code that bypasses the store still cannot create a second root.
- **Root has exactly two doors**: claim (only while unclaimed) and transfer (one transaction; the
  outgoing root is demoted to `admin`, not removed). `grantRole` cannot mint root and `revokeRole`
  cannot remove it, so a swarm cannot be left rootless.
- **`bootstrapFirstAdmin` claims root**, which is safe *specifically* because it is race-guarded to
  an empty user store.
- **`/users`** manages it: claim, transfer, grant, revoke, and (under `LOCAL_AUTH` only) the local
  account list with a one-click "make admin".

### The App Loader (ADR-147)

`app_registries` rows replaced a single `OSHAL_STORE_REPO` module constant.

- The **built-in row is seeded from that env var and cannot be deleted** — disable or re-point only,
  so a deployment can always return to a known store.
- **Three host adapters**: `github` (raw CDN), `gitlab` (files API, which works for a self-hosted
  instance at any group depth because the project path is URL-encoded), and `generic-git` (a sparse
  clone that assumes **no** raw-file API — this is what makes "any git location" literally true).
- **Adding a source is the trust act**: probed before it can be saved, typed-host confirmation,
  who trusted it recorded, revocable.
- **Install is the second click**: `GET …/preview/:name` reads the manifest at the pinned ref and
  enumerates what activation will do — routes mounted into the controller, migrations run against
  the database, bots, schedule cadences, connectors, dependencies, audit posture.
- **Keys are Vault-first with an encrypted-column fallback**; `secret_backend` records which one
  actually holds each key.

### Administration surfaces

| surface | what it answers | gate |
|---|---|---|
| `/admin` | posture, RLS gate, membership, marketplace governance, audit, budgets — and the **Admin tools** hub | `requireAdminConsoleAccess` |
| `/users` | who administers this **swarm** (root / admin / user) | page `requiresAuth`; every privileged read and write `requiresOperator` |
| `/app-loader` | trusted git sources, and installing from them | same shape as `/users` |
| `/access` | who may use each **installed application** (a different axis) | mounted by `app.use('/access', …)` in `server.ts` |
| `/applications` | installed apps, versions, updates | `requiresAuth` (+ guest mat) |
| Get oshal → **Apps** tile | browse applications; App Loader link revealed for admins only | page open to any signed-in user |

## 3. The three authorization axes — do not merge them by accident

Three systems exist and they are **not** duplicates:

1. **`swarm_roles`** (ADR-148) — who administers the swarm. Feeds `isOperatorIdentity`.
2. **Governance RBAC** (`features/governance/rbac/policy.ts`) — `Viewer | Operator | Admin` plus
   permissions, used by `/admin` and `requirePermission`. **Now reads `swarm_roles` first**, then
   the env allowlists, then IdP claims.
3. **`application-authorization`** (released 2026-09-11) — per-application assignment, surfaced at
   `/access`. It has never consulted swarm roles and does not need to: an app's users are not the
   swarm's administrators.

Axes 1 and 2 were aligned because they answer the *same* question at different layers. Axis 3
answers a different question. Folding it in would make "can administer the swarm" and "may use the
photo app" the same decision, which is wrong.

**They are joined for READING, never for deciding.** `GET /api/access-review` (page:
`/access-review`) reports all three for one identity and names the source of every grant —
`swarm-role` | `idp-claim` | `break-glass` for the swarm axis, `app-assignment` | `app-default` |
`none` per application. It holds no decision of its own: the swarm axis comes from
`resolveSwarmRoleGrant` (the same stores `resolveRole` reads) and each application row is one
`effective()` call through the ADR-149 authority, under that authority's own management checks.
Any signed-in person reads their own; naming another subject is admin-only, and that subject is
described from their SUBJECT IDENTIFIER alone — they have no session here, so no IdP claim and no
email is available and the payload says so (`emailEvaluated: false`) rather than implying an
email-only break-glass entry was checked.

Why provenance is the point: a break-glass operator and an admin granted on `/users` resolve the
**same** role, so without a source label they render identically — and the one that cannot be
audited or revoked from a browser is the one ADR-148 exists to end.

## 4. The constraints that are expensive to rediscover

- **`isOperatorIdentity` is ONE synchronous chokepoint for ~159 call sites**, many inside Express
  middleware, and it lives in `shared/`, which Feature-Sliced Design forbids from importing
  `features/`. Both constraints are answered by inverting the dependency:
  `shared/middleware/privileged-identities.ts` owns a replaceable snapshot, and
  `@/features/swarm-roles` pushes into it at boot and after every role write.
  **Never make `isOperatorIdentity` async.**
- **A failed role-store read CLEARS the snapshot** rather than leaving it stale. A stale privileged
  set would keep a revoked admin's access; cleared, the swarm falls back to break-glass, which is
  the recovery posture.
- **The env allowlist is break-glass FOREVER** (explicit operator decision). It is how an existing
  deployment adopts roles with zero configuration change and how a lost root is recovered. Do not
  "clean it up". `isBreakGlassOnlyOperator()` exists so a surface can say when access is env-only.
- **Boot is non-fatal.** A degraded role store must not stop the swarm starting, because break-glass
  is how you get in to fix it.
- **`POST /claim-root` is deliberately not behind `requiresOperator`** — on a fresh swarm nobody
  passes that gate yet. Its own conditions are the gate: authenticated, root genuinely unclaimed,
  and either no roles exist at all or the caller already passes break-glass.
- **The all-zeros `sourceSha` is a PLACEHOLDER, not an audit.** `parseCatalog` accepts it as a
  well-formed binding, so "has an audit block" never means "audited". Audit posture is the
  tri-state `audited | pending | none`, derived from the SHA, and one function
  (`decideInstallAudit`) decides every install for both the preview and the install route.
- **`oshal-vault` runs `server -dev` — in-memory.** A key written only to Vault evaporates on
  restart. That is why the encrypted column exists and why `secret_backend` is recorded.
- **`src/pages` is bind-mounted; `src/app` and `src/features` are not.** A page edit is live on
  save; an API change needs an image build. Anything a page reads from a new API field must degrade
  honestly in that window — the App Loader derives audit posture itself when the API predates the
  field, and `/admin` renders nothing rather than guessing when `source` is absent.
- **Two registration mechanisms serve pages**: the `server-ui-assets.ts` surfaces list, and a direct
  `app.use('/x', …)` in `server.ts` (which is how `/access` is mounted). A link check that knows
  only the first will call a working link broken.

## 5. How to verify it on a box

```bash
# Roles + the single-root invariant, against the LIVE Postgres (never mocked — the claim is
# about a database index). oshal-local-db publishes no host port, and 55433 is inside a Windows
# reserved range, so bridge it first:
docker run -d --rm --name oshal-pg-forward --network oshal-local_oshal \
  -p 127.0.0.1:45433:45433 alpine/socat "tcp-listen:45433,fork,reuseaddr" "tcp-connect:oshal-db:5432"
SWARM_ROLES_TEST_DSN='postgresql://<user>:<pw>@127.0.0.1:45433/oshal' \
  npx vitest run tests/unit/swarm-roles-store.spec.ts
docker rm -f oshal-pg-forward

# Everything else (no database needed)
npx vitest run tests/unit/app-registries.spec.ts tests/unit/admin-console-access.spec.ts \
  tests/unit/cockpit-tool-surfaces.spec.ts
```

To drive the authenticated endpoints as the operator, mint a PAT with the service secret, use it,
then **revoke it by the id captured at mint time** and confirm `revoked: true` — never sweep by
label. The recipe is in the headless-testing runbook.

Boot evidence that the rails are live, in the api log:
`app registries initialized`, `swarm roles initialized`, and `SWARM ROOT IS UNCLAIMED` until
someone claims it.

## 6. How to continue — the open threads

Each has a BACKLOG entry with done-when criteria. Ordered by what a reader would hit first.

1. **A `MOCK_OIDC` box never adopts root.** The installer-configured identity stays break-glass-only
   until someone claims root on `/users`. Decide whether the installer should promote it explicitly,
   or record that it should not. *Do not* auto-grant root to whoever registers first — that is a
   silent escalation on any box reachable before its first login.
2. **`/users` cannot invite or disable an account.** It lists local accounts and grants roles; the
   invite and disable flows still live in the local-auth admin API.
3. **~~No route-chain guard for the 403 path.~~ CLOSED 2026-09-14** —
   `tests/unit/swarm-admin-route-chain-authorization.spec.ts` mounts the real
   `/api/swarm/roles` and `/api/swarm/registries` routers behind the real deployment auth set
   (`createApplicationAuthMiddlewareSet` in its LOCAL_AUTH shape, signed in through the real
   `POST /api/local-auth/login`) against a disposable PostgreSQL holding the real `swarm_roles`
   table, and asserts all three outcomes: anonymous refused, **signed-in non-operator 403**, and
   200 for an admin granted through a `swarm_roles` row — plus 403 again after the revoke. Both
   break-glass allowlists are stubbed empty, so the row is the only path to operator. Every
   assertion reads the RESPONSE BODY: on a box every unauthenticated `/api/*` path answers an
   identical 401 including paths that do not exist, so a status-only assertion would prove the
   global guard and never the mount.
4. **Cross-registry dependencies.** Dependency *tiers* now exist (required/optional, resolved
   `installed → core manifest → the source's catalog`, refused with "not published by
   <source>", and shown on the confirm screen). Still unbuilt: resolving a dependency from a
   *different* trusted registry, and the fail-closed rule when two registries could satisfy one
   — the substitution attack that rule exists to stop.
5. **The fence does not resolve hostnames.** A public name that resolves to a private address is
   not refused. The durable fix pins the resolved address for the fetch rather than validating
   and then fetching, which is a TOCTOU.
6. **First-run provisioning.** The wizard's trusted-store selection step is still separate work.
7. **~~One place that answers "what am I allowed to do."~~ CLOSED** — `/access-review` and
   `GET /api/access-review` join the three axes read-only for one identity (see section 3).
   `tests/unit/access-review.spec.ts` proves it over the real boundaries: the real `swarm_roles`
   snapshot, the real environment allowlists and the real ADR-149 service over a real policy store
   with a really applied grant. Its load-bearing case is that a break-glass-only operator and a
   swarm-role admin come back with the same role and different sources.

> **Closed by other sessions on this branch since ADR-147 was written, verified in the code on
> 2026-09-13:** a cross-source replacement now returns `409` and requires explicit confirmation
> bound to the observed installed provenance (D6); `/applications` Discover reads the aggregate
> catalog and falls back to the single-store endpoint on a 403 (D6/P3 discovery); and the App
> Loader can revoke trust, requiring typed-host confirmation to restore it. ADR-147's *As built*
> section is the running record.

## 7. Where the code is

| piece | path |
|---|---|
| Role store, claim/transfer/grant/revoke | `src/features/swarm-roles/` |
| The synchronous snapshot the gate reads | `src/shared/middleware/privileged-identities.ts` |
| The operator gate | `src/shared/middleware/authz.ts` (`isOperatorIdentity`) |
| Governance role + permissions | `src/features/governance/rbac/policy.ts` (`resolveRole`) |
| Role API | `src/app/routes/swarm-roles-routes.ts` |
| Registries + host adapters | `src/features/app-registries/` |
| Registry API, preview, install decision | `src/app/routes/app-registry-routes.ts` |
| Grant provenance (which axis granted the role) | `src/features/governance/rbac/grant-sources.ts` (`resolveSwarmRoleGrant`) |
| The joined read-only review | `src/app/routes/access-review-routes.ts` |
| Pages | `src/pages/users/`, `src/pages/app-loader/`, `src/pages/admin/`, `src/pages/access-review/`, `src/pages/cockpit/tools/devices.html` |
| Guards | `tests/unit/swarm-roles-store.spec.ts`, `app-registries.spec.ts`, `admin-console-access.spec.ts`, `cockpit-tool-surfaces.spec.ts`, `swarm-admin-route-chain-authorization.spec.ts` (the route chain end to end), `access-review.spec.ts` (the joined view and its grant sources) |

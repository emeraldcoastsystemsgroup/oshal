# Entra/local hybrid login — operator guide

ADRs: [117-local-auth-invited-users.md](../adr/117-local-auth-invited-users.md),
[126-multi-provider-oidc-login.md](../adr/126-multi-provider-oidc-login.md)

On a [LOCAL_AUTH](local-auth.md) deployment, invited-user password login stays the wall. This
composition adds a second, explicitly opt-in door — a tenant-bound Entra (Microsoft work/school)
account — for an allowlisted set of people. The bridge maps a verified Entra identity onto the
**same canonical `local-…` sub** an invited account already has, so a person's data ownership
never forks between "signed in with a password" and "signed in with Microsoft."

## The two modes

Both are read by [`createApplicationAuthMiddlewareSet`](../../src/app/middleware/application-auth.ts)
and are mutually exclusive; only one composition can be active per deployment. Mode selection
order (first match wins):

| Env flag | Result |
|---|---|
| `ENTRA_LOCAL_AUTH_HYBRID=true` | **Hybrid pilot.** `LOCAL_AUTH` stays on; `/login` keeps the invited-user form and adds "Continue with Microsoft" to `/login/microsoft`; `/login/local` is the explicit recovery door. |
| `ENTRA_LOCAL_IDENTITY_BRIDGE=true` (hybrid flag off) | **Bridge-only, no local fallback.** Ordinary OIDC (whatever `OIDC_ISSUER_URL`/Keycloak/multi-provider config is set) with the bridge appended after it. There is no password door in this posture — an unlinked Entra identity is simply rejected. |
| neither | Unchanged: `LOCAL_AUTH=true` → local-only; otherwise OIDC (mock or real) — the pre-existing choice. |

Use **hybrid** for a LOCAL_AUTH box piloting Microsoft sign-in for some users while keeping the
password door for everyone else, including recovery when Entra is unreachable. Use **bridge-only**
for a later full cutover off `LOCAL_AUTH` once every account that needs one has a durable link —
`ENTRA_LOCAL_IDENTITY_BRIDGE` is meant for that later `LOCAL_AUTH=false` step; the code refuses to
run it standalone while `LOCAL_AUTH=true` without the hybrid flag also being set
(`entra-local-identity-bridge.ts`: *"standalone LOCAL_AUTH must not invoke external identity
mapping"*).

## Setup

### Env vars

| Var | Type / default | Notes |
|---|---|---|
| `ENTRA_LOCAL_AUTH_HYBRID` | bool, default `false` | Enables hybrid mode. Implies the bridge. |
| `ENTRA_LOCAL_IDENTITY_BRIDGE` | bool, default `false` | Enables bridge-only mode. Leave `false` during a hybrid pilot — the hybrid flag already implies it. |
| `MICROSOFT_TENANT_ID` | UUID, required by the bridge | Tenant-specific only. `common` / `organizations` / consumer endpoints are refused — the bridge trusts exactly one directory. |
| `MICROSOFT_OIDC_CLIENT_ID` / `MICROSOFT_OIDC_CLIENT_SECRET` | required | Same Azure app registration the [`MICROSOFT_LOGIN`](../runbooks/microsoft-login-enable.md) provider uses. |
| `MICROSOFT_LOGIN` | bool, required `true` for hybrid | The hybrid composition mounts Microsoft as the `microsoft-secondary-only` OIDC provider (`/login/microsoft`, `/callback/microsoft`, `appSession_microsoft`) — see [oidc-providers.ts](../../src/shared/middleware/oidc-providers.ts). |
| `ENTRA_LOCAL_IDENTITY_EMAILS` | comma-separated email list, required (nonempty) | First-link allowlist — see [Allowlist semantics](#allowlist-semantics) below. |

### Fail-closed boot conditions

`createApplicationAuthMiddlewareSet` and `createEntraLocalIdentityBridgeMiddleware` refuse to
construct (the api will not boot) when:

- **Hybrid without the preconditions.** `ENTRA_LOCAL_AUTH_HYBRID=true` requires both
  `LOCAL_AUTH=true` (so `/login/local` stays available) and `MICROSOFT_LOGIN=true`. Missing
  either throws at boot with the exact reason.
- **`MOCK_OIDC=true`.** Both hybrid and bridge-only refuse to start alongside `MOCK_OIDC` —
  Microsoft sessions must be cryptographically verified, never faked.
- **Non-tenant-specific `MICROSOFT_TENANT_ID`.** Must be a UUID; `common`/`organizations`/personal
  MSA endpoints are rejected at construction, not at request time.
- **Empty or malformed `ENTRA_LOCAL_IDENTITY_EMAILS`.** The bridge will not run with zero
  allowlisted addresses — see below.

### Azure prerequisites

The Azure-side app registration and redirect-URI steps are identical to enabling
`MICROSOFT_LOGIN` on its own — follow
[docs/runbooks/microsoft-login-enable.md](../runbooks/microsoft-login-enable.md) (registration,
`https://<host>/callback/microsoft` redirect URI, the `check-oidc-redirect-uris.sh` verification
step, and the recreate-not-restart note). This doc does not duplicate those steps.

## How identity resolution works

1. A request carrying a valid `appSession_microsoft` cookie reaches the bridge with a
   cryptographically verified `req.oidc` session (issuer, subject, tenant id `tid`, object id
   `oid` all read from the **verified ID-token claims**, never the presentation-filtered
   `req.oidc.user` view).
2. The bridge checks the issuer is exactly `https://login.microsoftonline.com/<MICROSOFT_TENANT_ID>/v2.0`
   and the token's `tid` matches. Anything else is rejected — a non-tenant identity never reaches
   the app.
3. **Link-once:** the bridge looks up `(issuer, external_sub)` in `oshal_external_identity_links`.
   - **Existing link** → returns the linked `local_user_sub` and refreshes `last_seen_at`.
   - **No link yet, asserted email is in `ENTRA_LOCAL_IDENTITY_EMAILS`** → atomically links this
     Entra `(tenant, oid)` to the local account whose email matches, *if that account is
     `active` or `invited`. Linking an `invited` account also accepts it (activates it) — the
     original one-time password invite is left intact as a rollback rail, not consumed. Unique
     constraints on `(issuer, external_sub)` and `(entra_tenant_id, entra_object_id)` make a
     concurrent/conflicting claim fail closed rather than double-link.
   - **No link, email not allowlisted (or no local account matches)** → unprovisioned; the request
     is rejected (see below).
4. On a successful link, the middleware replaces `req.oidc`'s `user`/`idTokenClaims` (via a Proxy
   over the original context, so token-refresh/logout methods stay bound) with the canonical
   identity: `sub` = the local `local-…` sub, `iss` = `urn:oshal:local-auth`
   ([principal-issuer.ts](../../src/shared/middleware/principal-issuer.ts)). Every downstream
   authorization/RLS check — `oshal.current_sub` set from `req.oidc.user.sub` — sees the same
   subject an invited-password login would have produced, so ownership of tickets, connectors,
   and every other `user_sub`-scoped row is identical regardless of which door was used.
5. Resolved identities are cached in-process for 30 seconds (`IDENTITY_CACHE_TTL_MS`) keyed on
   `(issuer, externalSub, oid)` to avoid a database round trip on every request.

### `oshal_external_identity_links` table

Created additively by `ensureEntraIdentityBridgeSchema` (inert while both flags are off):

```
issuer          TEXT NOT NULL
external_sub    TEXT NOT NULL          -- the Entra `sub` claim
entra_tenant_id TEXT NOT NULL
entra_object_id TEXT NOT NULL          -- the Entra `oid` claim
local_user_sub  TEXT NOT NULL REFERENCES oshal_local_users(user_sub) ON DELETE RESTRICT
email_at_link   TEXT NOT NULL          -- audit trail: the email present AT link time
created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
PRIMARY KEY (issuer, external_sub)
UNIQUE (entra_tenant_id, entra_object_id)
UNIQUE (issuer, local_user_sub)        -- one Entra identity per local account, and vice versa
```

Row-level security is applied the same owner-or-operator way as every other `user_sub`-keyed
table (`buildOwnerRlsPolicyStatements`), scoped on `local_user_sub`.

### Allowlist semantics

`ENTRA_LOCAL_IDENTITY_EMAILS` gates **only the first-time link**. Once a `(issuer, external_sub)`
pair has a row in `oshal_external_identity_links`, removing that address from the allowlist does
**not** invalidate the durable link — the row is looked up by issuer+subject first, before email
is ever consulted. The allowlist only prevents a *different, not-yet-linked* Entra principal from
claiming a local account by email going forward. There is no unlink/expiry mechanism; removing a
row (or disabling the underlying `oshal_local_users` account) is the only way to revoke it.

## Operational notes

- **`/login/local` is the recovery door.** In hybrid mode, `GET /login/local` (and `/invite`,
  `/2fa`) always clears any Microsoft session cookies first and serves the plain local-auth login
  page — reachable even when a stale/unprovisioned Microsoft session cookie is present.
- **`/logout/local`** clears both Microsoft and local session cookies and redirects to
  `/login/local`.
- **Plain `/logout`** clears the local cookie and, if there is no Microsoft session either,
  redirects straight to `/login` rather than starting an Entra RP-initiated logout round trip; if
  a Microsoft session is present it defers to the OIDC logout flow (which round-trips Entra's
  end-session endpoint).
- **Selecting Microsoft (`/login/microsoft`) is an explicit principal switch** — it discards any
  local session cookie first, so a browser never holds two authenticated identities at once.
- **A non-allowlisted or otherwise unprovisioned Microsoft login is rejected**, not silently
  provisioned: the bridge answers `403` with
  `{ error: 'identity_not_provisioned', message: 'This Microsoft account is not provisioned for
  this deployment. Contact an administrator.', localLoginPath: '/login/local' }` (the
  `localLoginPath` hint is present only in hybrid mode). A bridge failure (e.g. schema not ready)
  fails closed with `503` and the same local-fallback hint rather than admitting an unverified
  session.
- The shared `/api/local-auth/state` route exposes `microsoftLogin: true` only when the hybrid
  set passed `microsoftLoginEnabled` through — this is what makes `/login` show the "Continue with
  Microsoft" panel on [login.html](../../src/pages/login/login.html); bridge-only mode does not
  touch this page at all, since it doesn't run the local-auth route set.

## Relationship to ADR-117 and ADR-126

[ADR-117](../adr/117-local-auth-invited-users.md) established `LOCAL_AUTH` as its own
self-contained invited-user middleware set. [ADR-126](../adr/126-multi-provider-oidc-login.md)
added multi-provider OIDC login (Google/Microsoft/Outlook.com, chooser page) but explicitly scoped
`LOCAL_AUTH` **out**: *"LOCAL_AUTH (ADR-117) replaces the whole middleware set and is out of scope
here."* This hybrid/bridge composition is what closes that gap — it reuses ADR-126's
`microsoft-secondary-only` provider machinery (`resolveMicrosoftSecondaryLoginProvider` in
[oidc-providers.ts](../../src/shared/middleware/oidc-providers.ts)) inside a new middleware layer
that sits in front of, not instead of, the ADR-117 local-auth set. No dedicated ADR exists yet for
the hybrid/bridge composition itself; the design intent lives in the change-log headers of
[application-auth.ts](../../src/app/middleware/application-auth.ts) and
[entra-local-identity-bridge.ts](../../src/app/middleware/entra-local-identity-bridge.ts) and in
`.env.example`.

## Guards

`tests/unit/entra-local-identity-bridge.spec.ts` (issuer/tenant validation, link-once semantics,
allowlist gating, fail-closed construction) and `tests/unit/application-auth.spec.ts` (mode
selection, hybrid preconditions, middleware ordering, cookie-clearing on door switches and
logout).

# ADR-158: The Entra/local identity bridge — one canonical local subject, linked once

Date: 2026-09-15
Status: **Accepted — as-built.** The composition shipped 2026-08-17
(`src/app/middleware/application-auth.ts`, `src/app/middleware/entra-local-identity-bridge.ts`,
the `oshal_external_identity_links` table) and gained an operator guide 2026-09-09. This record is
written after the fact to capture the decisions that composition already encodes; it asks for no
new code.

Related: [ADR-117](117-local-auth-invited-users.md) (LOCAL_AUTH invited-user login — the
middleware set this composition sits in front of), [ADR-126](126-multi-provider-oidc-login.md)
(multi-provider OIDC login — whose `microsoft-secondary-only` provider the bridge consumes, and
which explicitly scoped LOCAL_AUTH out). Operator guide:
[docs/security/entra-local-hybrid.md](../security/entra-local-hybrid.md).

## Context

[ADR-117](117-local-auth-invited-users.md) made `LOCAL_AUTH` a self-contained invited-user
middleware set for a standalone box with no identity provider: an admin invites, the person sets a
password, and their canonical subject is a `local-…` string minted by the platform.
[ADR-126](126-multi-provider-oidc-login.md) then made login methods configuration rather than code
— Google, Microsoft Entra, personal Outlook, each on its own suffixed routes and session cookie —
but stated the boundary plainly: *"LOCAL_AUTH (ADR-117) replaces the whole middleware set and is
out of scope here."*

The operator ask fell exactly in that gap: a `LOCAL_AUTH` deployment where some people sign in
with their Microsoft work account, while the password door stays for everyone else and as recovery
when Entra is unreachable — and a route to a later full cutover off `LOCAL_AUTH` once every account
that needs one has a durable link.

Naively bolting ADR-126's Microsoft provider onto a `LOCAL_AUTH` box is wrong, and ADR-126 already
says why in its own consequences: **a provider is an identity namespace.** The same human signing
in two ways is two different `sub`s with separate per-user data. On a `LOCAL_AUTH` box that forks a
person's tickets, connectors and every other `user_sub`-keyed row — and the RLS predicates
(`oshal.current_sub`) between "signed in with a password" and "signed in with Microsoft."

Constraints that shaped the design:

1. **The canonical subject cannot move.** Existing rows are owned by a `local-…` sub; any design
   that admits a Microsoft `sub` as the platform principal orphans them.
2. **The password door must survive the pilot.** Entra being unreachable, or a link going wrong,
   must not lock the deployment out of itself.
3. **`express-openid-connect` filters protocol claims out of `req.oidc.user`.** Issuer, tenant and
   object id exist only on the verified `idTokenClaims`, so stable identity must be read there.
4. **No new account-creation path.** Anything that provisions on first sign-in turns a login page
   into a registration page on a box whose whole premise is invitation.

The composition that answered this shipped on 2026-08-17 and was documented for operators on
2026-09-09, but never got a decision record. Its design intent survived only in the change-log
headers of the two middleware files and in `.env.example` — and three of its decisions are not
derivable from the operator guide's description of behavior: link-once with no unlink or expiry
rail, an allowlist that gates only the **first** link, and an invited account being auto-accepted
by the link while its password invite is deliberately left intact.

## Decision

**A cryptographically verified, tenant-bound Entra identity is mapped — once — onto the canonical
`local-…` subject an invited account already has, and every boundary downstream of the mapper sees
only that subject.** The bridge is a post-OIDC trust-boundary mapper, not an authentication method:
its only input is the verified `req.oidc` session produced upstream.

1. **Two opt-in compositions, mutually exclusive, chosen by env in
   `createApplicationAuthMiddlewareSet`** (first match wins):
   `ENTRA_LOCAL_AUTH_HYBRID=true` is the **hybrid pilot** — `LOCAL_AUTH` stays on, `/login` keeps
   the invited-user form and adds Microsoft, `/login/local` is the explicit recovery door;
   `ENTRA_LOCAL_IDENTITY_BRIDGE=true` alone is **bridge-only** — ordinary OIDC with the bridge
   appended and no password door, the later `LOCAL_AUTH=false` step. With neither flag set,
   ADR-117 and ADR-126 behavior is unchanged. The hybrid flag implies the bridge; the bridge
   **refuses to run standalone while `LOCAL_AUTH=true`**, because a local-only deployment must
   never invoke external identity mapping by accident.

2. **Identity comes only from the verified ID-token claims.** Issuer, subject, `tid` and `oid` are
   read from `idTokenClaims`; the presentation-filtered `req.oidc.user` is an email/display
   fallback only and can never supply a stable identifier.

3. **Tenant-bound by construction.** The issuer must be exactly
   `https://login.microsoftonline.com/<MICROSOFT_TENANT_ID>/v2.0` and the token's `tid` must match.
   `MICROSOFT_TENANT_ID` must be a UUID: `common`, `organizations` and the consumer endpoints are
   rejected when the middleware is constructed, not at request time. The bridge trusts exactly one
   directory.

4. **Link-once, keyed on `(issuer, external_sub)` in `oshal_external_identity_links`** — looked up
   *before* email is ever consulted. An existing link returns its `local_user_sub` and refreshes
   `last_seen_at`. A link whose local account is disabled or malformed is never re-bound by email.

5. **`ENTRA_LOCAL_IDENTITY_EMAILS` gates only the first link.** It is a bootstrap gate, not an
   authorization list: once a principal is linked, authorization is the local account's business
   (its status, its roles, its RLS scope), and the allowlist's only remaining job is to stop a
   *different, not-yet-linked* Entra principal from claiming a local account by email. The bridge
   refuses to construct with an empty or malformed list, so the gate cannot be disabled by
   omission.

6. **Linking an `invited` account accepts it, and leaves the password invite intact.** The link and
   the acceptance happen in one statement (`status = 'active'`, `activated_at` coalesced); the
   bounded one-time invite is *not* consumed. That unused invite is the rollback rail — if the
   Entra pilot is turned off, the person can still finish the original invitation. Only `active`
   and `invited` accounts are linkable; a disabled account stays denied.

7. **No unlink and no expiry rail.** Revocation has exactly two administrative levers: delete the
   link row, or disable the underlying `oshal_local_users` account. A self-service unlink is an
   account-takeover primitive on a box where email is the only first-link proof, and an expiry
   would silently drop people back to a password they may never have set.

8. **The bridge never creates or rewrites an account**, and concurrent or conflicting claims fail
   closed rather than double-linking: `PRIMARY KEY (issuer, external_sub)`,
   `UNIQUE (entra_tenant_id, entra_object_id)` and `UNIQUE (issuer, local_user_sub)` make it one
   Entra identity per local account and one local account per Entra identity; a unique violation is
   answered as unprovisioned, with the database detail suppressed.

9. **Fail-closed at construction.** Hybrid requires `LOCAL_AUTH=true` and `MICROSOFT_LOGIN=true`;
   both modes refuse `MOCK_OIDC=true` outright; a non-tenant-specific tenant id or an empty
   allowlist throws at boot. The api does not start in a half-configured identity posture.

10. **Refusal is explicit and says which door to use.** An unlinked or non-tenant principal gets
    `403 identity_not_provisioned`; a bridge failure gets `503 identity_bridge_unavailable`. Both
    carry `localLoginPath: '/login/local'` in hybrid mode only — there is no local door to point at
    in bridge-only mode.

11. **One authenticated principal per browser.** Choosing Microsoft discards the local session
    cookie and `/login/local` clears the Microsoft cookies, so a door switch is a principal switch;
    `/logout/local` clears both.

12. **The schema is additive and inert while the flags are off**, and the link table is owner-scoped
    by the same `buildOwnerRlsPolicyStatements` treatment as every other `user_sub`-keyed table,
    on `local_user_sub`.

13. **A resolved identity is cached in-process for 30 seconds** on `(issuer, external_sub, oid)`
    with absolute freshness, so a per-request database round trip is avoided without a link
    surviving revocation for longer than that window.

## Consequences

- **The identity fork ADR-126 warned about does not happen under this composition** — and only
  under this composition. Plain multi-provider OIDC still mints a distinct subject per provider;
  the bridge is the one place where a second issuer is collapsed onto an existing platform
  principal.
- **Revocation is administrative, and there are exactly two levers.** Removing an address from
  `ENTRA_LOCAL_IDENTITY_EMAILS` revokes nothing, because the link is found by issuer and subject
  first. Documenting the allowlist as an ongoing access control would be wrong; it is a first-link
  gate. `ON DELETE RESTRICT` on `local_user_sub` also means a linked local account cannot be
  deleted until its link row is removed.
- **Rollback is bounded.** Flip both flags off and the deployment is the ADR-117 box again, with
  the invites the links accepted still usable because they were never consumed. Link rows persist
  and are honored again if the flags come back on.
- **Re-pointing an account at a different Entra principal is a deliberate row deletion**, not a
  login-time event — which is the intended cost of link-once.
- **This path cannot be exercised on a `MOCK_OIDC` dev box** by construction, so its correctness
  rests on the unit guards rather than on local manual testing. That is the accepted trade for
  refusing to fake a Microsoft session.
- **Bridge-only mode assumes every account that needs one is already linked.** There is no password
  door in that posture, so the cutover order matters: pilot in hybrid until the link rows exist,
  then drop `LOCAL_AUTH`.
- **The allowlist is per-deployment env, not data**, so it does not travel with a backup or a
  restore; a rebuilt box needs it set before the first link can be made.
- Guards: `tests/unit/entra-local-identity-bridge.spec.ts` (issuer/tenant validation, link-once
  semantics, allowlist gating, fail-closed construction), `tests/unit/application-auth.spec.ts`
  (mode selection, hybrid preconditions, middleware ordering, cookie clearing on door switches and
  logout), and `tests/unit/adr-entra-local-identity-bridge.spec.ts` (this record, its index row and
  its two back-links, and the flags, table and refusal codes it names still being present in the
  middleware it describes).

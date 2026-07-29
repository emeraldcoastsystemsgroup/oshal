# ADR-117: Local invited-user login (LOCAL_AUTH)

Date: 2026-07-28
Status: Accepted

## Context

A standalone client deployment — one box running the swarm plus one application, operated by a
small team — has no identity provider. The platform's two existing auth modes both fail this
shape: real OIDC requires an external IdP the client does not have, and MOCK_OIDC is not
authentication at all (it fabricates one fixed identity and waves every request through). What
the deployment needs is a **controlled** login: the administrator decides who gets an account,
an invitation goes to that person's email, they set a password once through a one-time link,
and nobody else can sign in. SSO can come later; passwords are the floor.

Three platform facts shaped the design:

1. **`req.oidc` is already a seam.** The PAT, TV-pairing, and guest-session injectors all
   fabricate the same `req.oidc` shape from their own token systems, so `requiresAuth`, RLS
   identity stamping, operator checks, and every app consume identity without knowing its
   source. A local credential mode is a fourth sibling, not a new concept.
2. **The installer already derives a deterministic sub.** `scripts/oshal-install.ps1`/`.sh`
   write `MOCK_OIDC_SUB = 'local-' + sha256(lowercase(email)).hex[0..16]`. Reusing that exact
   formula means a deployment can switch from open mock mode to gated login and every
   sub-keyed row survives — and an app can pre-bind a user's records (e.g. a CRM rep row with
   a role) before the invitee has ever logged in.
3. **There is no platform email path.** Every existing sender rides a per-user OAuth connector
   token. Invitations need a platform credential (or no email at all).

## Decision

**`LOCAL_AUTH=true` selects a first-party invited-user login** that replaces the OIDC
middleware set wholesale (same `{authMiddleware, requiresAuth, loginHandler}` contract).

- **Store:** `oshal_local_users` in Postgres (lazy-DDL chokepoint + owner RLS, mirroring
  `oshal_cli_tokens`). Password hashes are **scrypt** (Node built-in, self-describing hash
  strings) and live in the identity database — NOT the Vault surface. Hashes are one-way
  material that belongs next to the identity rows (as Keycloak/AD do); Vault is for
  *reversible* machine secrets, and the login path must not depend on the ADR-040 facade
  whose runtime is not built. Graduating the deployment's machine secrets (SESSION_SECRET,
  SMTP password) into Vault is future Phase-2 work there.
- **Subs are the installer's formula**, verbatim: `local-<sha256(email)[0..16]>`.
- **Sessions:** self-contained HMAC-signed `oshal_local` cookie (guest-session shape), signed
  with SESSION_SECRET; 24h rolling window, 7-day absolute cap; claims carry `token_version`
  so disabling an account or setting a new password kills live sessions at the injector's
  next 30-second store snapshot.
- **Invites:** `oshal_inv_`-prefixed one-time tokens (sha256 at rest, 7-day expiry, spent on
  accept — the PAT trade). Accepting sets the password and signs the user in. Re-inviting is
  also the admin-driven password-reset path. The admin API **always returns a copyable invite
  link**; if platform SMTP (`SMTP_*` env, nodemailer) is configured it also emails the link.
  No SMTP → the flows still work, the admin hands over the link.
- **Bootstrap:** on a fresh install, /login offers "create the administrator account" —
  race-guarded to the single first row. The installer is the first admin (their email should
  be in `OSHAL_OPERATOR_EMAILS`, which the installer already writes).
- **User administration** (`/api/local-auth/users*`) admits an operator session OR a trusted
  service call — so an application's own admin surface gates on ITS capability model
  (e.g. the CRM's `users.manage`) and proxies here with the service secret (ADR-036 shape).
- **Fail-closed at boot:** LOCAL_AUTH with MOCK_OIDC also enabled, or with no SESSION_SECRET,
  throws instead of silently degrading to open auth.
- **Login hygiene:** one generic failure message (no account enumeration; unknown emails burn
  the same scrypt cost as wrong passwords), per-ip+email fixed-window rate limiting, and the
  same API-401-JSON vs browser-redirect split as the OIDC guard (shared implementation).

**Second factor — SHIPPED 2026-07-29 as TOTP (RFC 6238).** Originally deferred pending the
client's choice of factor; the operator's constraint was that it must not need an external
provider, and TOTP does not: a shared secret plus the clock, HMAC-SHA1, verified in-process.
Off by default, per-user opt-in, administrator can require it per account. Secrets are
AES-256-GCM at rest under an HKDF-derived key from `SESSION_SECRET`; the accepted time step is
recorded so a code cannot be replayed; eight single-use recovery codes are minted once at
enrolment. Emailed codes were rejected as the primary factor because email is the same channel
as the invite and reset links, so an attacker holding the mailbox would satisfy both factors.
See [docs/security/local-auth.md](../security/local-auth.md#two-step-sign-in-totp).
Self-service password reset remains deferred — it needs an enumeration-safe response shape.

## Consequences

- A one-box deployment gets real access control with zero external dependencies: Postgres it
  already runs, email optional.
- Switching an existing mock-mode install to LOCAL_AUTH preserves identities (same subs).
- Passwords mean password custody: hashes are scrypt-salted, but operators must set a strong
  SESSION_SECRET and use TLS at the proxy — documented in docs/security/local-auth.md.
- The guards live in tests/unit/local-auth-{crypto,session,routes,middleware}.spec.ts; the
  routes spec is the named guard for the login wall (bootstrap-once, single-use invites,
  disable-kills-login, admin-gate matrix), proven red by mutation.
- Apps that want invite-on-create call the documented admin API — they never touch the table.

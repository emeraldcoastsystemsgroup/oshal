# Local invited-user login (LOCAL_AUTH) — operator guide

ADR: [117-local-auth-invited-users.md](../adr/117-local-auth-invited-users.md)

`LOCAL_AUTH=true` turns a deployment's open door into an invited-guest list: only accounts an
administrator created can sign in, with an email + password of their own. It is the auth mode
for a client box that has no identity provider (no Google Workspace, no Entra, no Keycloak).

## One software, per-deployment auth — an existing swarm is NOT impacted

Auth mode is a `.env` switch on each box, never a global behavior change. A deployment that
does not set `LOCAL_AUTH` keeps exactly its current door:

| Mode | .env | Who signs in |
|---|---|---|
| Open dev box | `MOCK_OIDC=true` (default) | Everyone, as the installer identity — unchanged |
| Dynamic sign-in | real OIDC (Google/Entra/Keycloak) | **Anyone with an account at the IdP** — dynamically provisioned on first login, own RLS-isolated data. This IS the "email=\*, standard user" wildcard; the operator allowlist grants admin on top. Unchanged |
| Invited-only | `LOCAL_AUTH=true` + `MOCK_OIDC=false` | Only invited accounts |

Application data has its own second wall either way: an app like the CRM grants capabilities
only to users its admin created (`resolveActor` hands an unknown login an empty capability
set), so a dynamically-provisioned platform user still sees nothing of an app they were never
added to.

## Turning it on

In `.env` (see `.env.example` for the full commented block):

```bash
LOCAL_AUTH=true
MOCK_OIDC=false            # required — the api refuses to boot with both on
SESSION_SECRET=<openssl rand -hex 32>
APP_URL=https://crm.example.com          # REQUIRED for emailed links (must be absolute)
OSHAL_OPERATOR_SUBS=<your sub>           # also the invitation sender identity
# OPTIONAL — only when this box has its OWN mail server. Without it, invitations
# send through the platform's Gmail connector instead (see below).
# SMTP_HOST= SMTP_PORT=587 SMTP_USER= SMTP_PASS= SMTP_FROM=
```

### How an invitation actually leaves the box

Two rails, tried in this order:

1. **SMTP**, when the deployment configures its own mail server. Explicit beats inherited.
2. **The platform's Gmail connector** — the same OAuth grant every other outbound message in
   the swarm uses. Connect a Google account once on the Connectors screen (the account named by
   `NOTIFY_EMAIL_SENDER_SUB`, else the first `OSHAL_OPERATOR_SUBS` entry) and invitations ride
   that grant with the invitee as recipient. **No mail password anywhere.**

If neither rail is available the invitation is still created and the admin screen shows a
**copyable one-time link** — that is a working state, not a failure. `emailSent` and
`emailDetail` in the API response say which happened and why.

Serve the box behind TLS. The session cookie is HttpOnly/SameSite=Lax and marked Secure in
production, but passwords travel in the login POST — TLS is not optional for a real client.

## The flows

- **Fresh install** — the first visit to `/login` offers *Create the administrator account*.
  That first account is the admin; put its email in `OSHAL_OPERATOR_EMAILS` (the installer
  does this already) so it can also call the platform user-administration API.
- **Inviting someone** — `POST /api/local-auth/users {email, name}` (operator session or a
  trusted service call). The response always contains `invitePath` — a one-time link you can
  paste into any channel — and `emailSent` telling you whether SMTP delivered it. Links work
  once and expire after 7 days.
- **Accepting** — the invitee opens `/invite?token=…`, sets a password (10+ characters), and
  is signed in. The token is spent on use.
- **Forgot password / reset** — two paths, same one-time-link machinery:
  - *Self-service* (2026-07-31): the `/login` page's "Email me a reset link" posts
    `POST /api/local-auth/forgot {email}`. Active accounts get a 60-minute one-time link on
    the same rails as invitations (SMTP, else the operator's Gmail connector). The answer is
    identical whether or not the address exists (no enumeration), delivery never blocks the
    response (no timing oracle), requests are rate-limited per IP (429) and capped per email
    (silently), and a reset **never clears a two-step factor**. A box with no mail rail simply
    sends nothing — the admin path below still works.
  - *Admin-driven* — `POST /api/local-auth/users/:id/reinvite` mints a fresh
    one-time link; accepting it sets the new password and ends every older session.
- **Disable** — `POST /api/local-auth/users/:id/disable` locks the account and kills live
  sessions within ~30 seconds. `/enable` restores it (the old password still stands unless
  you also reinvite).
- **Sign out** — `GET /logout`.

Sessions ride a signed cookie: 24-hour rolling window, 7-day absolute cap.

## Two-step sign-in (TOTP)

A second factor ships with this mode and needs **no external provider** — no SMS gateway, no
vendor, no per-login fee. RFC 6238 is a shared secret plus the clock, so enrolment and
verification both happen on the box, and it works with the network unplugged.

| | |
|---|---|
| **Factor** | A six-digit code from any authenticator app — Google Authenticator, Microsoft Authenticator, Authy, or a password manager that does codes |
| **Enrolment** | `/2fa` — QR rendered locally as a data URI (no external image host), plus the key in text for anyone whose camera will not cooperate |
| **Default** | **Off.** Each user may turn it on; an administrator can require it per account |
| **Recovery** | Eight single-use codes, shown **once** at enrolment. An admin can also clear an enrolment for a lost phone |
| **At rest** | The secret is AES-256-GCM encrypted with a key derived (HKDF) from `SESSION_SECRET` — a stolen database dump alone does not yield working codes |
| **Replay** | The accepted time step is recorded; the same code cannot be used twice inside its own 30-second window |
| **Drift** | ±1 step (90 seconds total), so a slightly wrong phone clock still works |

Set `TOTP_ISSUER` to control the name the app displays (defaults to `oshal`).

**Emailed codes were considered and rejected as the primary factor.** Email is the same
channel as the invite and the admin-driven password reset — an attacker holding the mailbox
would satisfy both factors, so it would have added ceremony rather than security.

Three deliberate behaviours worth knowing before you operate this:

- **Requiring the factor never locks anyone out.** An account that is required but not enrolled
  signs in and is sent to enrolment, rather than refused.
- **Turning it off needs the password again.** A live session is not enough, or an unattended
  browser undoes the control.
- **A deployment that has not run the migration is password-only, not broken.** Only Postgres
  `undefined_column` is forgiven that way; any other read failure refuses the login, because a
  database blip must never become a 2FA bypass.

## What this mode does NOT do (yet)

- **SSO** — when the client gets an IdP, switch to the OIDC mode; identities keyed by email
  will NOT carry over automatically (subs differ) — plan a mapping if that day comes.

## How applications integrate

Apps never touch `oshal_local_users`. An app's admin surface gates on its own permission
model, then proxies to `/api/local-auth/users*` with `X-Service-Secret` + `x-oshal-user-sub`
(the ADR-036 trusted-call shape). Because subs are deterministic from email
(`local-<sha256(email)[0..16]>`), an app can create its own user-bound rows (e.g. a CRM rep
with a role) at invite time — the binding is live the moment the invitee first signs in.

## Guards

`tests/unit/local-auth-crypto.spec.ts` (hashing + the installer-compatible sub formula),
`local-auth-session.spec.ts` (cookie signing, expiry, revocation, absolute cap),
`local-auth-routes.spec.ts` (the login wall: bootstrap-once, generic errors, rate limiting,
single-use invites, disable-kills-login, admin-gate matrix),
`local-auth-middleware.spec.ts` (fail-closed construction, injector, 401/redirect split),
`local-auth-forgot-password.spec.ts` (self-service reset: enumeration-identical answers,
fire-and-forget delivery, per-IP 429 + silent per-email cap, reset survives TOTP, invite
not stomped).

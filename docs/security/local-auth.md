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
APP_URL=https://crm.example.com          # used in emailed invite links
# optional — invitations go out by email when set; copyable links otherwise
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=invites@example.com
SMTP_PASS=...
SMTP_FROM=invites@example.com
```

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
- **Forgot password / reset** — `POST /api/local-auth/users/:id/reinvite` mints a fresh
  one-time link; accepting it sets the new password and ends every older session.
- **Disable** — `POST /api/local-auth/users/:id/disable` locks the account and kills live
  sessions within ~30 seconds. `/enable` restores it (the old password still stands unless
  you also reinvite).
- **Sign out** — `GET /logout`.

Sessions ride a signed cookie: 24-hour rolling window, 7-day absolute cap.

## What this mode does NOT do (yet)

- **2FA** — deferred until the client picks a second factor (BACKLOG entry with done-when).
- **Self-service password reset** — resets are admin-driven by design for now; there is no
  unauthenticated "forgot password" email flow to enumerate or abuse.
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
`local-auth-middleware.spec.ts` (fail-closed construction, injector, 401/redirect split).

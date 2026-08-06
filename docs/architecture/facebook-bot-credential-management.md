# Facebook Bot Credential Management

**Status:** As built (2026-08-06)

**Author:** maintainer@emeraldcoastsystemsgroup.com

This document is the current security contract for Facebook Page authentication. It supersedes the
2026-04-19 implementation proposal, which described browser-managed App Secrets and raw Redis
credential publication. Those paths are retired and must not be restored.

## Trust boundary

Facebook application credentials are deployment-managed server secrets. The browser never accepts,
stores, or returns a Facebook password or App Secret. Page and user tokens produced by OAuth are
stored by the controller through `EncryptedConfigManager`. OAuth start fails before creating state
unless `ENCRYPTION_KEY` is configured, so this route cannot fall back to plaintext persistence.

The authenticated operator starts and manages the connection. The OAuth callback remains public
because Meta must redirect to it, but a callback is accepted only when it presents the single-use
state and HTTP-only browser binding created by that operator's `/start` request.

| Route | Authorization and behavior |
|---|---|
| `GET /api/facebook-auth/app` | Authenticated exact operator only; serves the connection UI. |
| `POST /api/facebook-auth/login` | Authenticated exact operator only; stable HTTP 410 `browser_password_login_disabled`. The body is not used. |
| `POST /api/facebook-auth/credentials` | Authenticated exact operator only; stable HTTP 410 `browser_app_secret_write_disabled`. The body is not used. |
| `GET /api/facebook-auth/status` | Authenticated exact operator only; returns connection metadata, never a token or App Secret. |
| `GET /api/facebook-auth/start` | Authenticated exact operator only; creates bound state and returns the Meta authorization URL. |
| `GET /api/facebook-auth/callback` | Public provider callback; accepted only with fresh, single-use, operator/browser-bound state. |
| `POST /api/facebook-auth/disconnect` | Authenticated exact operator only; removes locally persisted Facebook tokens. |
| `GET /api/facebook-auth/pages` | Authenticated exact operator only; lists redacted page metadata for the connected account. |
| `POST /api/facebook-auth/switch-page` | Authenticated exact operator only; selects a page after verifying it belongs to the connected account. |

An empty operator allowlist grants nobody access. A service secret is not a substitute for the
operator session on these browser/control-plane routes.

## OAuth state lifecycle

1. An exact operator calls `/start`.
2. The server creates a 256-bit random state and a separate random browser binding.
3. The pending record stores the initiating operator subject, callback URI, creation time, and only
   a SHA-256 digest of the browser binding. The binding itself is sent in an HTTP-only,
   `SameSite=Lax` cookie scoped to `/api/facebook-auth`.
4. The callback validates the state shape, removes the pending record before processing any provider
   error or code, clears the cookie, and then checks the ten-minute TTL and binding digest.
5. If the callback also has an authenticated subject, it must equal the initiating operator. The
   callback may otherwise be anonymous because the state plus browser binding carries continuity.
6. Missing, expired, replayed, wrong-browser, or wrong-operator state fails closed without a token
   exchange.

Pending state is process-local and intentionally short lived. A process restart invalidates all
outstanding attempts; the operator starts a new flow.

## Credential lifecycle

```text
deployment secret store / environment
        | FACEBOOK_APP_ID + FACEBOOK_APP_SECRET
        v
operator /start -> Meta consent -> public bound callback
        |                         |
        |                         +-> exchange code server-side
        v
EncryptedConfigManager (page/user tokens + redacted metadata)
        |
        +-> no cross-node credential carrier
```

- `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` are supplied by deployment configuration. The
  compatibility `/credentials` route cannot write them, and the UI does not use `localStorage` for
  secrets.
- OAuth tokens remain in the controller-local encrypted configuration store managed by
  `EncryptedConfigManager`; `ENCRYPTION_KEY` is a prerequisite, not an optional production
  hardening. Tokens are not returned by status routes, placed in model prompts, written to
  model/CLI workspaces, or injected into model/CLI environments.
- Raw Redis publication such as `facebook.credentials.update` is disabled. Redis pub/sub does not
  provide durable ordering or a monotonic revocation tombstone, so a delayed event could restore a
  credential after disconnect.
- There is no HTTP credential import/export or fleet token broadcast. The controller and Facebook
  bot currently mount distinct output volumes, so controller OAuth tokens are not available to the
  bot. Credential-consuming Facebook operations remain unavailable until an exact server-owned
  operation can consume the controller-held token without exporting it. Do not restore raw
  distribution to make the legacy bot tool work.

## Model and connector boundary

A connected Facebook account does not authorize autonomous Cline, Claude Code, Codex, or Gemini CLI
execution. Those unattended CLI paths are operationally disabled until an audited oshal-brokered
sandbox can keep credentials outside the model process and workspace while enforcing immutable
request-start handler generations and exact operation scopes.

Facebook credentials may be consumed only by an exact, schema-bounded server-side operation. The
model receives the redacted operation result, not the credential. For reasoning, use a hosted/BYO
inference rail; for a provider action, use a validated deterministic server provider intent.

## Callback output safety

Callback pages are fixed server templates. Provider error descriptions are not reflected, page names
are HTML-escaped, responses are `no-store`, and the page receives a deny-by-default Content Security
Policy. Never reintroduce arbitrary query-string or provider text into callback HTML.

## Deployment configuration

| Variable | Purpose |
|---|---|
| `FACEBOOK_APP_ID` | Deployment-owned Meta application identifier. |
| `FACEBOOK_APP_SECRET` | Deployment-owned server secret; never browser supplied. |
| `ENCRYPTION_KEY` | Required at-rest key for the controller credential store; `/start` returns HTTP 503 when absent. |
| `FACEBOOK_CONFIG_ID` | Optional Login for Business configuration identifier. |
| `FACEBOOK_SCOPES` | Optional comma/space-delimited scopes when a configuration identifier is not used. |

The platform Docker Compose file can receive `ENCRYPTION_KEY` through its `.env` file. The current
local-swarm Compose environment and Kubernetes secret generator do not yet forward this variable,
so `/start` correctly returns HTTP 503 on those deployment paths until their secret wiring is
completed. Do not work around that refusal by enabling the manager's plaintext compatibility mode.

Register the deployment callback URI as:

```text
https://<deployment-host>/api/facebook-auth/callback
```

Local development may use `http://localhost:35457/api/facebook-auth/callback` only when that exact URI
is registered with the Meta application.

## Regression guard

`tests/unit/facebook-auth-security-boundary.spec.ts` pins operator-only non-callback routes, stable
410 compatibility endpoints, fail-closed OAuth start without `ENCRYPTION_KEY`, single-use
browser/operator-bound state, fixed callback output, the absence of browser App-Secret persistence,
and the absence of raw Redis credential publication.

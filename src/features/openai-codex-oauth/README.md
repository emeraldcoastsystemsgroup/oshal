# OpenAI Codex OAuth Feature

## Purpose

Provides OAuth sign-in and credential diagnostics for the `openai-codex` provider so an exact oshal
user can persist their own OpenAI/ChatGPT authentication instead of entering a manual API key.

## Operational boundary

OAuth/import success proves credential presence; it does not authorize unattended Codex, Cline,
Claude Code, or Gemini CLI execution. Those local CLI paths fail closed before task/workspace setup
until an audited oshal-brokered sandbox enforces immutable request-start handler generations and
exact operation scopes while keeping authentication and connector credentials outside the
model-visible process and workspace. Use hosted/BYO inference or a schema-bounded deterministic
server provider intent for current work.

`POST /import` is an authenticated user-to-own-partition persistence path, not fleet distribution.
It cannot select another subject, grant an oshal role from provider claims, or copy the credential
into a bot request/workspace.

## Backend API

- `GET /api/openai-codex/oauth/start`
  - Starts PKCE flow and returns the OpenAI authorization URL.
  - The callback `redirect_uri` is now derived from the initiating browser-facing request origin when available, so sign-in started on `:3456`, `:3010`, or another routed runtime returns to that same origin instead of a shared fallback port.
- `GET /api/openai-codex/oauth/status`
  - Returns whether stored OpenAI Codex credentials are authenticated (refreshing tokens when needed).
  - Status is observational: becoming an operator later does not promote an existing private
    credential, and an unchanged status read does not rewrite or redistribute platform state.
- `GET /api/openai-codex/oauth/callback`
  - OAuth callback endpoint for OpenAI redirect completion.
- `POST /api/openai-codex/oauth/import`
  - Imports a user's native `codex login` auth.json into that user's exact storage partition.
- `POST /api/openai-codex/oauth/signout`
  - Deletes only the authenticated user's persisted OpenAI Codex credentials.

## Storage

Credentials are stored through `EncryptedConfigManager`, scoped by exact authenticated user id.
`ENCRYPTION_KEY` is mandatory: start, import, callback completion, status, and sign-out return a
stable service-unavailable result before credential work when it is absent. The manager no longer
uses `secrets.json` as a live store; an existing plaintext file blocks normal operations until an
operator performs the explicit one-way encrypted migration, which verifies the new envelope and
removes the plaintext source. A normal user's import, callback, refresh, or sign-out never changes
the shared config seed or Cline runtime files.

Only an identity on the exact operator allowlist may promote its credential into the explicitly
configured live Codex vendor auth file. Promotion writes the native `auth.json` shape atomically
with owner-only file permissions; the CLI harness rotates that same source through guarded
write-back. Operator sign-out removes the live file only when its current credential fingerprint
still matches that operator's credential, preventing one user (or a different operator) from
deleting a newer platform credential. Promotion authority comes from the validated OSHAL session
at start/import/sign-out; decoded claims inside an uploaded provider token are never treated as
OSHAL roles.

Redis credential publication/subscription is disabled. The former unordered update channel had no
monotonic version or revocation tombstone, so a delayed import message could resurrect credentials
after sign-out. There is no controller-to-bot raw HTTP or Redis credential transport. Static
`config-seed` Codex OAuth copies are ignored by active consumers because they cannot rotate or
represent revocation. Any future distribution rail requires an ordered version and monotonic
revocation tombstones.

Secrets key used:

- `openAiCodexOauthCredentials`

## Environment Variables

- `OPENAI_CODEX_CLIENT_ID` (optional)
  - Defaults to the upstream Cline OpenAI Codex OAuth client id.
- `OPENAI_CODEX_REDIRECT_URI` (optional)
  - Overrides callback URI fallback. Defaults to `http://localhost:1455/auth/callback` when no trusted request origin is available.
- `ENCRYPTION_KEY`
  - Required controller-only AES-GCM key for the user-partitioned secrets envelope. When absent,
    credential lifecycle endpoints fail closed with HTTP 503
    `encrypted_secret_storage_required`; they never create a plaintext store.
- `CODEX_AUTH_SOURCE_PATH`
  - Required for web-triggered operator promotion and set to `/root/.codex/auth.json` by local
    compose. This is the single live native auth source the CLI reads and rotates. The OAuth service
    deliberately has no `HOME`/`USERPROFILE` fallback for writes.
- `APP_URL`
  - Used to build the fallback callback URI.

## Multi-runtime callback behavior

The OAuth state cache is held in-memory inside the runtime that handled `/api/openai-codex/oauth/start`. Because of that, callback completion must return to the same runtime that generated the state.

The feature now supports this by:

- persisting the per-attempt `redirectUri` alongside pending OAuth state
- deriving callback origin from the incoming browser-facing request host/proxy headers
- constructing route services inside the router factory so test/runtime-specific env paths are honored per router instance

This avoids the previous failure mode where auth started on one localhost port but completed on another runtime and produced `Invalid or expired OAuth state`.

## UI Integration

Legacy settings page integration is delivered through:

- `src/api/ui-openai-codex-oauth.mjs`

The script is appended to `/ui-logic.js` at runtime by `src/app/server.ts`. That route serves a single concatenated script: `ui-provider-fields.js` + `ui-provider-models.js` + `ui-logic.js` + the OAuth/auth patch scripts (the provider catalogs were split out of `ui-logic.js` in 2026-07 for the 1000-code-line cap).

## Automated verification

- `tests/openai-codex-oauth-service.spec.ts`
  - verifies redirect URI generation and scope contents
- `tests/openai-codex-oauth-callback.spec.ts`
  - verifies exact-operator callback completion, authenticated status, and operator-only
    native live-auth persistence
- `tests/unit/openai-codex-credential-isolation.spec.ts`
  - proves a second user's import/sign-out and a case-alias subject leave live platform auth and
    runtime byte-identical; status cannot promote on a later allowlist change; static seed fallbacks
    stay retired; and no unordered Redis publication/subscription can resurrect a revoked credential

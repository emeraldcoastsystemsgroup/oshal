# OpenAI Codex OAuth Feature

## Purpose

Provides OAuth sign-in support for the `openai-codex` provider so OSHAL users can authenticate with their OpenAI/ChatGPT account instead of entering a manual API key.

## Backend API

- `GET /api/openai-codex/oauth/start`
  - Starts PKCE flow and returns the OpenAI authorization URL.
  - The callback `redirect_uri` is now derived from the initiating browser-facing request origin when available, so sign-in started on `:3456`, `:3010`, or another routed runtime returns to that same origin instead of a shared fallback port.
- `GET /api/openai-codex/oauth/status`
  - Returns whether stored OpenAI Codex credentials are authenticated (refreshing tokens when needed).
- `GET /api/openai-codex/oauth/callback`
  - OAuth callback endpoint for OpenAI redirect completion.
- `POST /api/openai-codex/oauth/signout`
  - Deletes persisted OpenAI Codex credentials.

## Storage

Credentials are stored in the existing encrypted secrets envelope via `EncryptedConfigManager`, scoped by authenticated user id. In Docker swarm mode, the `project-manager` callback also mirrors the Codex credential into the shared `config-seed/secrets.json` file so worker containers can refresh the same login without separate browser auth.

Secrets key used:

- `openAiCodexOauthCredentials`

## Environment Variables

- `OPENAI_CODEX_CLIENT_ID` (optional)
  - Defaults to the upstream Cline OpenAI Codex OAuth client id.
- `OPENAI_CODEX_REDIRECT_URI` (optional)
  - Overrides callback URI fallback. Defaults to `http://localhost:1455/auth/callback` when no trusted request origin is available.
- `OPENAI_CODEX_SHARED_SEED_PATH` (optional)
  - Overrides the shared Docker seed path used to mirror Codex OAuth credentials for worker containers. Defaults to `/app/config-seed/secrets.json`.
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
  - verifies callback completion, authenticated status, and runtime credential sync on the initiating origin

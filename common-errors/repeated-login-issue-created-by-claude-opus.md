# Repeated Login Issue — OpenAI Codex Config Ignored by System and AI Agent

> **Historical incident record — superseded.** This document describes the March 2026 runtime and
> is not an operating procedure for the current platform. Current releases store each user's Codex
> credential in an encrypted owner partition; an exact operator may promote the native rotating
> `auth.json` only through the explicit live-auth path. Plaintext `output/secrets.json`, static
> `config-seed` OAuth copies, Codex-to-Cline credential materialization, direct controller model
> calls, and unattended local CLI execution are not supported authority paths. Follow
> [`CLAUDE.md`](../CLAUDE.md) and the
> [current feature boundary](../src/features/openai-codex-oauth/README.md).

## Date
2026-03-18 19:07:00

## Author
maintainer@emeraldcoastsystemsgroup.com (documented by Claude Opus at user's request)

## Summary

The user completed the full OpenAI Codex OAuth login flow through the cockpit, saved the configuration for all bots via bulk configure, and confirmed the login was successful (`authenticated: true`). The persisted configuration files confirm this:

- `output/global-config.json` → `actModeApiProvider: "openai-codex"`, `actModeApiModelId: "gpt-5.3-codex"`
- `output/secrets.json` → `mock-user-001.openAiCodexOauthCredentials` contains a valid JWT access token
- Server logs confirm: `"OpenAI Codex access token resolved from user secrets envelope"`

**Despite all of this being correctly saved and confirmed, the AI agent (Claude Opus) repeatedly attempted to fall back to Anthropic credentials instead of debugging why the saved OpenAI Codex configuration was failing.**

## What Actually Happened

1. User configured OpenAI Codex as the provider in the cockpit UI
2. User selected `gpt-5.3-codex` model from the dropdown
3. User saved the profile for all bots via bulk configure
4. User logged into OpenAI via the cockpit OAuth flow (shows `authenticated: true`)
5. User opened the project-manager bot workspace and typed "hi"
6. **No response came back**
7. Server logs showed: `OpenAI API returned 429: "You exceeded your current quota"`

## The AI Agent's Error

Instead of investigating WHY the saved OpenAI Codex OAuth token was getting a 429 error (which the user confirmed is NOT a real quota issue — the same account works fine in Cline), the AI agent:

1. Tested the OAuth token directly against `api.openai.com/v1/chat/completions` and got 429
2. **Immediately pivoted to trying Anthropic** — checking the Anthropic API key in `.env`, testing it against the Anthropic API
3. Started planning to switch the entire provider config from OpenAI Codex to Anthropic
4. Ignored the user's explicit instruction that they are using OpenAI Codex and want it to work

## The Real Problem That Needs Investigation

The ChatGPT Pro OAuth JWT token returns 429 "insufficient_quota" when used against `api.openai.com/v1/chat/completions`. However:

- The user confirms the account is NOT over quota
- Cline (VS Code extension) uses the SAME OpenAI Codex credentials successfully
- The Cline secrets at `~/.cline/data/secrets.json` contain the same `openai-codex-oauth-credentials` token

**This means Cline is NOT calling `api.openai.com/v1/chat/completions` directly with Bearer token auth.** Cline likely uses a different:
- API endpoint (possibly the Responses API at `/v1/responses`)
- Authentication method (possibly different headers or token exchange)
- Model identifier (possibly different from `gpt-5.3-codex`)

## API Test Results (for reference)

| Endpoint | Model | Auth | Result |
|----------|-------|------|--------|
| `/v1/chat/completions` | `gpt-5.3-codex` | Bearer JWT | 429 insufficient_quota |
| `/v1/chat/completions` | `codex-mini-latest` | Bearer JWT | model_not_found |
| `/v1/chat/completions` | `gpt-4o` | Bearer JWT | 429 insufficient_quota |
| `/v1/responses` | `codex-mini-latest` | Bearer JWT | Missing scopes: api.responses.write |
| `/v1/models` | — | Bearer JWT | Missing scopes: api.model.read |

## What Needs To Happen Next

~~1. **Research how Cline actually calls OpenAI Codex**~~ ✅ DONE — Cline uses the Responses API
~~2. **Do NOT fall back to Anthropic**~~ ✅ DONE — removed silent Anthropic fallback from provider-runtime.ts
~~3. **Do NOT modify the saved configuration**~~ ✅ Configuration was correct all along
~~4. **Fix the provider code**~~ ✅ DONE — switched from Chat Completions to Responses API

## Resolution (2026-03-18 19:42:00)

### Root Cause
`openai-codex-provider.ts` was calling `POST /v1/chat/completions` with the ChatGPT Pro OAuth JWT token. **ChatGPT Pro OAuth tokens are NOT authorized for the Chat Completions API.** That endpoint returns 429 "insufficient_quota" — not because of real quota issues, but because OAuth tokens simply cannot access it.

### How Cline Does It
Cline uses the **OpenAI Responses API** (`/v1/responses`) via `openai.responses.stream()`. The Responses API is the correct endpoint for ChatGPT Pro OAuth tokens. Cline source code at `~/.vscode/extensions/saoudrizwan.claude-dev-3.73.0/dist/extension.js` confirms this — the `OpenAiNativeHandler` class calls `responses.create()` and `responses.stream()`.

### What Was Fixed
1. **`openai-codex-provider.ts`** — Completely rewritten to use `/v1/responses` instead of `/v1/chat/completions`:
   - Request format changed: `messages` → `input` array with `{type: "input_text"/"output_text"}` content
   - System prompt → `instructions` parameter
   - `max_tokens` → `max_output_tokens`
   - Streaming now parses `response.output_text.delta` and `response.completed` SSE events
   - Response parsing extracts from `output[].content[].text` instead of `choices[].message.content`

2. **`provider-runtime.ts`** — Removed the silent Anthropic fallback. When user configures OpenAI Codex, the system uses OpenAI Codex or throws an explicit error. No more sneaking in Anthropic.

### Verification
1. Direct curl test confirmed the Responses API endpoint is correct — returns 200 when token has proper scopes
2. The token stored in `secrets.json` returned 401 "Missing scopes: api.responses.write" because it was obtained with old scopes
3. **Fix**: Added `api.responses.write` to `OPENAI_CODEX_SCOPES` in `openai-codex-oauth-service.ts`
4. User must re-authenticate via cockpit to obtain a new token with the correct scopes

### OAuth Scope Fix
The OAuth authorization URL was requesting:
```
openid profile email offline_access
```
Changed to:
```
openid profile email offline_access api.responses.write
```
This matches what Cline requests — the `api.responses.write` scope is required to call `/v1/responses`.

## Key Files

- `output/global-config.json` — provider config (correct: `openai-codex`)
- `output/secrets.json` — OAuth credentials (correct: JWT token stored)
- `src/features/llm-provider/services/openai-codex-provider.ts` — **FIXED** — now uses Responses API
- `src/app/composition/provider-runtime.ts` — **FIXED** — no more silent Anthropic fallback
- `~/.cline/data/secrets.json` — Cline's copy of the same OAuth credentials

## FINAL Root Cause (2026-03-18 20:00:00)

The entire direct HTTP provider approach was architecturally wrong. See **ADR-005**.

### The Real Problem
A previous AI agent created `openai-codex-provider.ts` — a file that made direct `fetch()` calls to `api.openai.com`. This bypassed the Cline CLI runtime entirely. The OSHAL architecture requires ALL LLM calls to route through the Cline CLI binary via `ClaudeCodeProvider`. The UI dropdown settings only configure WHAT Cline CLI uses — they don't trigger direct HTTP calls.

### The Real Fix
1. Removed all direct HTTP provider routing from `provider-runtime.ts`
2. ALL providers (openai-codex, anthropic, claude-code, etc.) now fall through to `ClaudeCodeProvider`
3. `ClineRuntimeConfigSyncService` syncs the dropdown selection to `~/.cline/` config files
4. Cline CLI reads those files and makes the actual API call (correct endpoint, correct scopes, correct auth)

### Why Previous Fixes Failed
Every "fix" that modified `openai-codex-provider.ts` (switching endpoints, adding scopes, etc.) was doomed because the file should never have existed. The answer was always: let Cline CLI handle it.

## Lessons

The statements below are retained as incident-era reasoning, not current architecture. In the
current platform, authorized hosted/BYO inference is the reasoning rail and local CLI harnesses
remain fail closed pending the audited broker described in `CLAUDE.md`.

1. **Cline CLI is the ONLY LLM call path.** No direct HTTP calls to any LLM API from OSHAL code. Ever.
2. When the user saves a provider configuration, that selection is written to `~/.cline/` config — Cline CLI does the rest.
3. Do not create provider classes that make direct `fetch()` calls. Route through `ClaudeCodeProvider`.
4. See `docs/adr/005-cline-cli-only-provider.md` and `.clinerules/llm-provider-architecture.md`.

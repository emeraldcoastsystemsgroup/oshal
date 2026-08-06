# Haven Codex CLI — Experiments

This folder contains isolated experiments for wiring Haven home assistant to the OpenAI Codex CLI as its LLM backend.

**Status: RETIRED HISTORICAL EXPERIMENT. No changes were made to the production codebase.**

> Do not apply the patch scripts or commands in this folder. The experiment predates the current
> containment boundary: static `config-seed` OAuth copies are non-executable, Codex credentials are
> never materialized into Cline files, direct controller/local-CLI model calls are disabled, and
> approval/sandbox bypass flags are prohibited. Current Haven reasoning uses an authorized
> hosted/BYO rail through the accountable bot path. See [`CLAUDE.md`](../../CLAUDE.md) and the
> [current Codex credential boundary](../../src/features/openai-codex-oauth/README.md).

---

## What Was Attempted

### Goal
Haven (`/api/haven/chat`) needed a working LLM backend. The swarm workers use OpenAI Codex via the Cline extension. The ask was to wire Haven to call the Codex CLI directly as a subprocess so it uses the same ChatGPT Pro account without requiring a separate API key.

### What Was Tried

| Attempt | Result |
|---|---|
| OpenAI Chat Completions API (`/v1/chat/completions`) | `429 insufficient_quota` — the `sk-svcacct-*` service account has no billing credits |
| OpenAI Codex CLI with `OPENAI_API_KEY` | `500` on Responses API WebSocket, then `401` on REST fallback — service account keys are not compatible with the Responses API |
| `codex login --with-api-key` → `codex exec` | `429` — same service account, same quota |
| JWT from `config-seed/secrets.json` → Chat Completions | `429` — insufficient_quota on that account |
| JWT from `config-seed/secrets.json` → Responses API REST | `401 Missing scopes: api.responses.write` — the OAuth flow that created this token only granted `openid profile email offline_access`, not the scope the Responses API requires |
| Codex CLI with `auth_mode: chatgpt` in `~/.codex/auth.json` | `Token data is not available` — the Codex CLI reads a different token structure than the JWT stored in `config-seed/secrets.json` |
| Anthropic direct HTTP (`/v1/messages`) | `ANTHROPIC_API_KEY=placeholder-set-your-key` in `.env` — key was never set |
| Google Gemini API | Previously attempted in session 32; requires `GEMINI_API_KEY` |

---

## Root Cause

The OAuth token stored in `config-seed/secrets.json.openAiCodexOauthCredentials` was created by the Cline extension's internal OAuth flow. It only has these scopes:
```
openid profile email offline_access
```

The OpenAI Responses API (which `@openai/codex` uses) requires the scope:
```
api.responses.write
```

The Cline extension handles this scope exchange internally before calling the API. The standalone `codex` CLI binary cannot reuse those tokens — it needs its own fresh login that requests the correct scope.

---

## Historical Options Evaluated (Not Supported)

The following alternatives explain what the experiment considered in March 2026. They are not
current setup instructions and must not be executed or wired into production.

**Option A — Host Codex login/direct subprocess:** retired. OAuth presence is diagnostic and may
seed the live vendor file for an authorized operator, but it does not authorize Haven or another
unattended workload to launch Codex. The former approval-and-sandbox bypass test command has been
removed because it violates the current execution boundary.

**Option B — Add billing credits to the OpenAI API account:**
Go to https://platform.openai.com/account/billing — add $5 minimum. Then the direct HTTP call in `scripts/patch-haven-openai.js` will work immediately (no CLI, no subprocess, fastest option).

**Option C — Set the Anthropic API key in `.env`:**
```
ANTHROPIC_API_KEY=sk-ant-api03-...
```
The `scripts/patch-haven-anthropic.js` in this folder is ready to apply. This uses claude-3-5-haiku which is fast and cheap.

---

## Files in This Folder

| File | Description |
|---|---|
| `patch-haven-model.js` | Patches compiled JS to change model selection |
| `patch-haven-direct.js` | Patches Haven to call OpenAI Chat Completions directly |
| `patch-haven-revert.js` | Reverts the container back to original |
| `patch-haven-gemini.js` | Patches Haven to call Google Gemini |
| `patch-haven-gemini-v2.js` | Gemini patch v2 |
| `patch-haven-openai.js` | Final OpenAI direct HTTP patch (works if billing added) |
| `patch-haven-anthropic.js` | Anthropic direct HTTP patch (works if API key added to .env) |

---

## Impact on Main Codebase

**None.** All patch scripts only modify the compiled `/app/dist/` inside the running Docker container. They do not touch `src/`. The container reverts on next `docker-compose up --build`. The source files in `src/features/haven/` were built as part of the intended Phase 1 implementation (see `planning/home-persona-layer-build-plan.md`) and remain intact.

---

## Haven Phase 1 Status

The Haven infrastructure IS built and working:
- ✅ DB migration: `docker/postgres/migrations/002_haven_home_context.sql`
- ✅ HomeContextService: `src/features/haven/home-context-service.ts`
- ✅ Haven route: `src/app/routes/haven-routes.ts` (`/api/haven/chat`)
- ✅ HavenPersonaService: `src/features/haven/haven-persona-service.ts`
- ✅ Haven UI: `src/pages/haven/index.html`
- ❌ LLM backend: blocked — all available API credentials are either quota-exhausted or missing the right scopes

The only thing missing is a working LLM call. Once any one of the three options above is unblocked, Haven will respond.

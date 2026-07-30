# ADR-020: OpenAI Codex Runtime Provider Wiring

## Status
**SUPERSEDED** by [ADR-033: Multi-Harness Execution Framework](033-multi-harness-execution-framework.md). Its implementation is gone.

> **This ADR's decision no longer exists in the tree (recorded 2026-07-29).** `provider-runtime.ts`
> has no `createOpenAiCodexRuntimeProvider()` and no `resolveOpenAiCodexAccessToken()`; provider
> selection happens through `HARNESS_FACTORIES`, and OpenAI Codex is reached by the `codex-cli`
> harness spawning the vendor CLI against mounted OAuth (`~/.codex/auth.json`) rather than by
> calling `/v1/responses` from OSHAL code. The class this ADR wired —
> `src/features/llm-provider/services/openai-codex-provider.ts` — was **deleted 2026-07-29** as
> verified-orphaned: an orphan sweep found zero code references to `OpenAICodexProvider` anywhere in
> this repo or either store repo, only doc mentions. [ADR-005](005-cline-cli-only-provider.md) had
> already called the file architecturally wrong; removing it makes that true in the tree. Item 4
> (the GPT-5.x Codex model entries in `provider-definitions.ts`) is the only part still live.

## Context
The OSHAL provider registry defines 41 providers, but `provider-runtime.ts` only had explicit runtime branches for `anthropic`, `claude-code`, and `echo`. All other providers — including `openai-codex`, `openai-native`, and `openai` — fell through to `claude-code` as a default, which then tried to use Anthropic credentials from `.env`. This caused 401 `authentication_error: invalid x-api-key` failures when users selected OpenAI Codex in the cockpit settings and completed OAuth sign-in.

The any-bot (oshal) handled provider switching via `PUT /api/llm-provider`, which wrote `~/.cline/config.json` and `~/.cline/data/globalState.json`. In OSHAL, the config POST handler (`POST /api/config`) already calls `ClineRuntimeConfigSyncService.syncFromPersistedConfig()` to write these files, but the runtime provider resolver didn't know how to instantiate `OpenAICodexProvider` when it read `openai-codex` from the config.

The `OpenAICodexProvider` class already existed at `src/features/llm-provider/services/openai-codex-provider.ts` and accepts an OAuth `accessToken` from the Codex OAuth flow. The OAuth flow stores credentials in `output/secrets.json` via `EncryptedConfigManager` and syncs them to `~/.cline/data/secrets.json` under the key `openai-codex-oauth-credentials`.

## Decision
1. Added explicit runtime branches for `openai-codex`, `openai-native`, and `openai` in both `createRuntimeProvider()` and `createRuntimeProviderWithManifest()` in `provider-runtime.ts`.
2. Added `resolveOpenAiCodexAccessToken()` which resolves the OAuth access token from three sources in priority order: `output/secrets.json`, `~/.cline/data/secrets.json`, `OPENAI_API_KEY` env var.
3. Added `createOpenAiCodexRuntimeProvider()` which instantiates `OpenAICodexProvider` with the resolved token, failing fast with a clear error when no token is available.
4. Added missing GPT-5.x Codex model entries to `provider-definitions.ts` so the cockpit model dropdown has selectable options instead of requiring manual text entry.

No new dependencies. No changes to LLM provider internals or agent runtime code. The existing config save flow (`POST /api/config` → `syncFromPersistedConfig()`) continues to handle the write path.

## Consequences
- **Positive**: Users who select OpenAI Codex in the cockpit and complete OAuth sign-in will have requests routed to the OpenAI API directly, matching the any-bot behavior.
- **Positive**: The model dropdown now shows `GPT-5.3 Codex`, `GPT-5.2 Codex`, `GPT-5.1 Codex Max`, and `Codex Mini` — no more manual text entry required.
- **Positive**: Fail-fast error messages clearly identify missing credentials instead of silently falling through to the wrong provider.
- **Trade-off**: Providers not in the explicit branch list (`bedrock`, `vertex`, `gemini`, etc.) still fall through to `claude-code`. These should be wired as they become needed.
- **No impact**: K8s YAMLs are not affected — OAuth credentials are dynamic and resolved at runtime from persisted secrets, not baked into container images.
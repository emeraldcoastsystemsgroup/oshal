# ADR-005: Cline CLI Is the ONLY LLM Call Path

## Status
**SUPERSEDED** by [ADR-033: Multi-Harness Execution Framework](033-multi-harness-execution-framework.md) — accepted 2026-03-18, superseded 2026-04-13 (status corrected 2026-07-23).

> **Do not apply this ADR's rules to new code.** They describe the March 2026 single-path runtime and
> are contradicted by the current tree on three points:
>
> 1. **"ALL LLM calls MUST route through the Cline CLI. No exceptions."** — false today. Cline is one
>    of five harnesses (`cline`, `codex-cli`, `claude-code`, `gemini-cli`, `a2a`, plus
>    `noop`), selected per bot through `HARNESS_FACTORIES` in `src/app/composition/provider-runtime.ts`.
> 2. **"`ClaudeCodeProvider` is the single runtime adapter"** — the class in
>    `src/features/llm-provider/services/claude-code-provider.ts` is now `ClineHarnessProvider`, and
>    it is only the Cline harness. The three CLI-spawn harnesses extend `BaseCliHarnessAdapter`.
> 3. **"No direct HTTP calls to any LLM API. Ever."** — `AnthropicProvider` is resolved directly in
>    `provider-runtime.ts`, and `anthropic-provider.ts` / `openai-codex-provider.ts` (which this ADR
>    said MUST NOT exist) are both present.
>
> What survives is the *reason* the rule existed: don't reimplement a vendor's OAuth/endpoint/scope
> quirks in OSHAL code when the vendor's own CLI already handles them. That is why the codex, claude,
> and gemini harnesses spawn vendor CLIs against mounted OAuth rather than calling REST directly.
> The current contract is ADR-033 plus the harness inventory in [CLAUDE.md](../../CLAUDE.md).

## Context

The OSHAL platform allows users to configure different LLM providers (OpenAI Codex, Anthropic, Claude Code, etc.) via the cockpit UI dropdowns. A previous implementation error created **direct HTTP providers** (`OpenAICodexProvider`, `AnthropicProvider`) that made raw `fetch()` calls to LLM APIs, bypassing the Cline CLI runtime entirely. This caused 3+ days of debugging because:

1. The direct `OpenAICodexProvider` called `/v1/chat/completions` instead of `/v1/responses` — wrong endpoint for OAuth tokens
2. When that failed, the system silently fell back to Anthropic — wrong provider entirely
3. The OAuth token scope (`api.responses.write`) was irrelevant because Cline CLI handles scopes internally
4. Every "fix" that modified the direct HTTP provider was doomed to fail because the fundamental approach was wrong

## Decision

**ALL LLM calls in OSHAL MUST route through the Cline CLI binary. No exceptions.**

### Architecture Rules

1. **`ClaudeCodeProvider`** is the **single runtime adapter** — it spawns the Cline CLI subprocess, passes messages, and parses responses.

2. **Provider dropdown selections** (`openai-codex`, `anthropic`, `claude-code`, etc.) only configure **what the Cline CLI uses**. They are written to `~/.cline/` runtime config files by `ClineRuntimeConfigSyncService`.

3. **No direct HTTP calls** to any LLM API (`api.openai.com`, `api.anthropic.com`, etc.) from OSHAL application code. Ever.

4. **`ClineRuntimeConfigSyncService`** is responsible for:
   - Reading `output/global-config.json` (provider, model, mode)
   - Reading `output/secrets.json` (OAuth tokens, API keys)
   - Writing Cline-compatible config to `~/.cline/data/config.json`, `globalState.json`, `secrets.json`
   - Building MCP server settings

5. **`ClineSessionRuntimeService`** creates per-task runtime directories with session-specific settings.

### Call Flow

```
User types message in chat UI
  → OSHAL server receives message
    → ClineRuntimeConfigSyncService syncs provider/model/token to ~/.cline/
      → ClaudeCodeProvider spawns Cline CLI subprocess
        → Cline CLI reads ~/.cline/ config
          → Cline CLI calls the configured LLM API (OpenAI, Anthropic, etc.)
            → Response flows back through Cline CLI → ClaudeCodeProvider → chat UI
```

### What Provider Dropdowns Actually Do

| Dropdown Selection | What Happens |
|---|---|
| `openai-codex` | Written to `~/.cline/` config → Cline CLI uses OpenAI Codex API |
| `anthropic` | Written to `~/.cline/` config → Cline CLI uses Anthropic API |
| `claude-code` | Written to `~/.cline/` config → Cline CLI uses Claude Code API |
| Any other | Written to `~/.cline/` config → Cline CLI uses whatever it maps to |

### Files That MUST NOT Exist (or must not be used at runtime)

- `openai-codex-provider.ts` — Direct HTTP calls to OpenAI. **WRONG.**
- Any future `*-provider.ts` that makes direct `fetch()` calls to an LLM API. **WRONG.**

### Files That ARE Correct

- `claude-code-provider.ts` — Cline CLI adapter. This is the ONLY runtime provider.
- `cline-runtime-config-sync-service.ts` — Syncs config to `~/.cline/`
- `cline-session-runtime-service.ts` — Per-task runtime directories
- `provider-runtime.ts` — Resolves config and creates `ClaudeCodeProvider`

## Consequences

- Simpler architecture: one code path for all LLM calls
- OAuth tokens, API endpoints, scopes, and streaming handled by Cline (which already works)
- No need to reimplement LLM API quirks in OSHAL code
- If Cline supports a provider, OSHAL supports it automatically
- The `AnthropicProvider` direct SDK integration should also be reviewed for removal

## Supersedes

This ADR supersedes the implicit assumption in the 2026-03-18 changelog entries that added direct `OpenAICodexProvider` routing. That approach was architecturally wrong.
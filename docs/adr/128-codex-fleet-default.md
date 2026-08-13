# ADR-128 — Codex is the fleet default: one CLI/API/LLM, model floor gpt-5.5

Status: Accepted — shipped in PR #195 (merge `4ee6ced1`), deployed 2026-08-12
Date: 2026-08-12

## Context

The swarm ran a mixed fleet: most registry bots pinned `claude-code`, twenty-odd pinned
`codex-cli`, one `gemini-cli`, two `cline`, and the compose default (`FORCE_LLM_PROVIDER`) was
`claude-code`. Nothing recorded *why* any bot ran the harness it ran, and three defects hid in the
mix:

- **The compose codex default shipped broken for the install shape we actually recommend.**
  `CODEX_MODEL` defaulted to `gpt-5.3-codex` — the API-key model name, which a ChatGPT-account
  login answers with a 400. Every ChatGPT-plan self-install that flipped a bot to codex got a
  dead bot unless the operator already knew to override the model in `.env` (the 2026-06-12
  "all-codex bots produce no output" incident was exactly this).
- **Reasoning effort rode the host's config into every bot.** Both codex spawn paths seed the
  per-task codex home by copying the host `~/.codex/config.toml` (and only when missing, so each
  workspace freezes whatever the host had at first touch). The operator's interactive config runs
  `gpt-5.6-sol` with `model_reasoning_effort = "ultra"` — legal only for sol. Any fresh workspace
  pinned to gpt-5.5/gpt-5.4 inherited `ultra` and 400'd every turn
  (`Supported values are: none|low|medium|high|xhigh` — verified live). Old workspaces kept
  working off stale copies, which made the failure look random.
- **The deployment pays for one subscription it wants the swarm to use.** This box runs the
  $200/mo ChatGPT Pro plan; the bind-mounted `~/.codex` login is the brain the operator installed
  the product to use (the same reasoning ADR-127 recorded for the mounted CLI logins generally).
  A fleet defaulting elsewhere burns the wrong account.

Operator directive 2026-08-12: codex is the swarm's default CLI, API, and LLM; every bot runs at
least gpt-5.5; cheaper tiers get a documented recommendation rather than a different hardcode.

## Decision

1. **Every LLM-harness bot in both registries is `harnessType: 'codex-cli'` /
   `apiType: 'openai-codex'`** ([swarm-bot-registry.ts](../../src/app/extensions/swarm/swarm-bot-registry.ts)
   + [swarm-bot-registry-local.ts](../../src/app/extensions/swarm/swarm-bot-registry-local.ts)).
   `a2a` keeps its harness — it is an external-agent boundary, not an LLM. Per-bot overrides
   remain the escape hatch for a persona that reasons poorly on codex; the global default does
   not move back for one bot.
2. **The demo CLI ladder is codex-first.** `DEMO_CLI_ORDER = ['openai-codex', 'claude-code']`,
   amending ADR-127's rung 2 (order only — both carve conditions and every other rung are
   untouched). Claude Code stays mounted and is the second rung plus the runtime-failover
   secondary, so a codex blip degrades instead of dead-ending.
   **→ Superseded by Amendment 1 (2026-08-13): codex is the ONLY default rung.**
3. **Model floor gpt-5.5, chosen by plan tier, never hardcoded below the floor.** Compose
   defaults: `FORCE_LLM_PROVIDER=openai-codex`, `CODEX_MODEL=gpt-5.5`, `LLM_PROVIDER/LLM_MODEL`
   to match; the boot-sync and adapter fallbacks likewise. `gpt-5.3-codex` may not reappear as a
   default anywhere. Plan guidance (documented in
   [provider-profiles.md](../runbooks/provider-profiles.md) and `.env.example`): $200 Pro →
   `gpt-5.5` + effort `high` (this deployment); $20 Plus → `gpt-5.4` + `medium` (half the
   per-token burn of 5.5 — 5.5 exhausts a Plus plan's limits fast); `gpt-5.6-sol` is the
   interactive frontier model and is never the fleet default.
4. **Reasoning effort is pinned per spawn.** New env `CODEX_REASONING_EFFORT` (default `high`);
   both codex wrappers ([codex-cli-harness-adapter.ts](../../src/features/llm-provider/services/codex-cli-harness-adapter.ts)
   and [CodexCLIWrapper.js](../../any-bot/server/services/codebase/CodexCLIWrapper.js)) pass
   `-c model_reasoning_effort=…` on every `codex exec`, so a host config tuned for a different
   model can never 400 the fleet, regardless of when a workspace seeded its config copy.

## Consequences

- One default brain means one answer to "what is this bot running" — the cockpit provider picker
  was already inert against registry pins (see the 2026-08-01 precedence finding); now the pin is
  uniform instead of historical accident.
- The fleet's spend rides the Pro subscription's plan limits, not per-token billing; `chat_tasks`
  cost rows for CLI turns remain price-equivalents, not bills (ADR-127's accounting note stands).
- Gemini and cline harness bots no longer exist in the registries. The harness *inventory*
  (`HarnessType`, `HARNESS_FACTORIES`) is unchanged — the compatibility layer and its fail-closed
  posture (SEC-05) are untouched; this ADR moves defaults, not security boundaries.
- Guard: [tests/unit/codex-default-floor.spec.ts](../../tests/unit/codex-default-floor.spec.ts) —
  the registry fleet invariant (with count floors so an emptied registry cannot pass vacuously),
  the model floor on code and compose defaults, the no-`gpt-5.3-codex` rule, and the effort pin
  asserted on the real spawn argv of both wrappers.
- Reopening this decision means editing the guard spec knowingly — a red
  `codex-default-floor.spec.ts` is the signal that someone moved the fleet default without an
  ADR, not a test to appease.

---

## Amendment 1 — codex is the only default rung (2026-08-13)

Status: Accepted — operator directive 2026-08-13. Amends Decision #2.

**Context.** Decision #2 kept Claude Code as the second rung and the runtime-failover secondary,
on the reasoning that "a codex blip degrades instead of dead-ending." The operator is cancelling
the Claude Code subscription. A ladder that silently degrades onto an account that is going away
does not buy resilience — it converts a codex outage into either a billing surprise or a bot that
works today and dies on renewal day, and it does so *invisibly*, because a successful fallback
logs like a success.

The 2026-08-13 sweep also found the claude-code default was wider than Decision #2 described.
Seven sites still defaulted there, and none were listed in the original ADR:

| site | was | now |
|---|---|---|
| `DEMO_CLI_ORDER` | `['openai-codex', 'claude-code']` | `['openai-codex']` |
| `resolveRuntimeProviderName()` env fallback | `'claude-code'` | `'openai-codex'` |
| `manifestBotDefinition` harness/apiType default | `'claude-code'` | `'codex-cli'` / `'openai-codex'` |
| `cline-runtime-config-sync` `DEFAULT_PROVIDER` | `'claude-code'` | `'openai-codex'` |
| bot-node unforced provider order | cline → claude → codex | codex → cline → claude |
| bot-node auto-failover from codex | `['claude-code', 'cline-cli']` | `['cline-cli']` |
| `DEFAULT_MODEL` (generic, `LLM_MODEL` unset) | `'claude-sonnet-4-6'` | `'gpt-5.5'` |

`manifestBotDefinition` is the one worth calling out: **every store package that omits
`harnessType:` was minting a Claude Code bot into a codex fleet** — and omitting it is the norm,
since a package author has no reason to think about the controller's harness at all.

**Decision.**

1. **`DEMO_CLI_ORDER = ['openai-codex']`.** Codex is the only automatic CLI rung. A codex blip
   surfaces as a codex blip.
2. **No automatic chain may fall back to claude-code** — not the demo ladder, not bot-node
   runtime failover, not a manifest default, not a generic model default.
3. **Claude Code remains fully selectable, never default.** An explicit per-user preference
   (`oshal_user_llm_prefs.preferred_provider = 'claude-code'`), an explicit per-bot
   `harnessType`, and an explicit `OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER=claude-code` all still work.
   The harness, its factory, and its adapter are untouched. This amendment moves defaults only.
4. **Persisted `global-config.json` is box state, not code, and must be migrated too.** Every
   volume on the 2026-08-13 box carried `actModeApiProvider: "claude-code"`;
   `FORCE_LLM_PROVIDER=openai-codex` masked it at runtime, which is exactly why it went unnoticed.
   The mask is absent in the self-install shape the product recommends.

**Consequences.**

- With `FORCE_LLM_PROVIDER` unset — the self-install shape — a fresh deployment now lands on codex
  instead of Claude Code. That is the intended change and the reason this is an ADR.
- A deployment that genuinely wants Claude Code must now say so. That is the point: the cost of
  the default was that nobody had to say anything.
- Guard: `tests/unit/codex-default-floor.spec.ts` gains the no-claude-code-default rows. As with
  the parent ADR, a red spec is the signal that someone moved a default without an ADR.

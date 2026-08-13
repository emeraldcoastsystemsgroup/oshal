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

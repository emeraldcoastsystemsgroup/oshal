# ADR-130 — codex-cli storyboard image provider (demo-mode rendering on the swarm's own harness)

**Status:** Accepted
**Date:** 2026-08-22
**Extends:** ADR-082 (storyboard provider family), ADR-127 (demo-mode CLI carve), ADR-036 (bot-owned execution)

## Context

Every image rail the storyboard family had was credential-blocked on the demo box: the `openrouter`
provider's prepaid credit is exhausted (live 402s), the `codex` provider needs a platform
`OPENAI_API_KEY` the deployment does not hold (the ChatGPT-subscription OAuth is rejected by
`/v1/images` — re-verified 2026-08-21, 401 missing scope `api.model.images.request`), `comfyui` is
unwired, and `vertex` bills per image against a Google credential the caller must supply. Meanwhile
the deployment's actual paid-for engine — the bind-mounted ChatGPT Pro codex login that already
powers every bot under ADR-127/128 — sat unused for images, because the July diagnosis ("codex can
never generate images") was only ever true of the **platform API realm**.

Proven live 2026-08-22 on this box: **codex CLI 0.147.0 has native image generation on the
subscription login.** Text-to-image, anchored image-to-image via `-i`, and — decisive for the
wrapper-free design — anchored editing from a **file path in the working directory** all produced
valid PNGs, on both `gpt-5.5` (the ADR-128 fleet model) and `gpt-5.6-sol`.

Two standing rules shape where such a render may run:

1. **The controller never launches a CLI** (two-runtimes doctrine). Portrait Studio's routes run in
   the api container, so the render cannot happen in-process.
2. **SEC-05 is the only door to a CLI spawn**, and its ADR-127 demo carve (`DEMO_MODE` **and**
   exact `OSHAL_OPERATOR_SUBS` match, threaded via `extraEnv.OSHAL_USER_SUB`) already governs
   exactly this case: the operator's own work on the operator's own subscription.

## Decision

**A fifth storyboard sibling, `codex-cli`, renders through a bot node over the existing
swarm-execute rail — and it is the default when the deployment runs in demo mode.**

- **Provider** (`createCodexCliImageProvider(userSub)`): stages the anchor photo in a fresh task
  workspace on the shared volume (`sbimg-<uuid>` — canonical id, visible to api and bots at the
  same path), sends one fixed-contract agentic prompt ("view ./anchor.png, render the brief, save
  ./output.png"), and reads the PNG back from the volume (magic-byte checked). The brief is
  embedded between markers as data; the file contract around it never varies.
- **Executor seam:** the feature never imports the app layer. The app registers a bot-node executor
  at boot (`wireCliStoryboardImageExecutor` → `registerCliStoryboardImageExecutor`, the
  Schwab-resolver pattern); it wraps `BotNodeClient.execute(agentId, …)` with `agenticMode: true`
  and the REAL caller's `userSub`. Bot selection: `STORYBOARD_CLI_IMAGE_BOT_ID`, default
  general-bot (`a0000000-…-0099`) — a dedicated node, because inline (controller-container) bots
  have no endpoint and never spawn CLIs. Timeout: `STORYBOARD_CLI_IMAGE_TIMEOUT_MS`, default 7 min.
- **Authorization is the bot's, not the provider's.** The SEC-05 pair
  (`assertUnattendedProviderPreflight` + `assertCliToolBoundary`) still decides every spawn on the
  threaded sub. The provider's `available()` only mirrors the same predicates
  (executor registered + `demoModeEnabled()` + `isDeploymentOperatorSub(userSub)`) so selection
  fails closed at resolve time with instructions instead of a bot-side refusal mid-render. A
  non-operator or identity-less caller stays refused on both layers.
- **Demo default** (config → swarm env → demo default): explicit `STORYBOARD_IMAGE_PROVIDER` always
  wins; unset, the resolver now defaults to `codex-cli` when `demoModeEnabled()` and `codex`
  otherwise. Fail-closed selection and the no-silent-paid-fallback rule are unchanged.
- **Model:** the render rides the target bot's boot model (fleet `gpt-5.5`, ADR-128). A per-call
  model pin is structurally refused by the ADR-034 authoritative-dispatch check, so choosing
  `gpt-5.6-sol` for renders is a deliberate per-bot override (`CODEX_MODEL` on the render bot), not
  a provider option. Both models render (proven above).
- **Cost:** `costClass: 'free'` — subscription-included, no per-image bill. The bot records its own
  price-equivalent in `chat_tasks`; the provider reports `costUsd: null` so nothing double-records.

## Consequences

- Portrait Studio (and any media-generation consumer that passes `userSub`) renders on the
  operator's own subscription in demo mode, with zero vendor keys and zero marginal spend. The
  portrait-studio package must pass `{ userSub }` to `resolveStoryboardImageProvider` (1.4.1).
- Video Studio's storyboard stage does not yet thread `userSub`, so under the demo default it fails
  closed with the carve hint (it was already dead on this box — exhausted OpenRouter). BACKLOG:
  "Video Studio storyboards on the demo codex-cli rail".
- The render task's workspace (`sbimg-*`, anchor + output PNG) persists on the shared volume like
  every other task workspace; the surface stores its own copy of the deliverable.
- Guard: `tests/unit/storyboard-codex-cli-provider.spec.ts` (demo-aware default, gate mirroring,
  real-filesystem render round-trip, PNG validation, bot-refusal surfacing);
  `storyboard-codex-platform-key.spec.ts` keeps the non-demo default pinned to `codex`.
- The prompt-injection surface is unchanged in kind: briefs reach the same CLI the swarm already
  feeds with chat and ticket text, under the same demo-carve confinement; portrait briefs are
  catalog-built with fail-closed id validation.

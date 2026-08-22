# ADR-082 — Video Series Pipeline

**Status:** Accepted — built and proven end to end; since 2026-07-30 it is driven nightly by the ADR-120 joke-shorts pump (first episode produced with no human in the loop). Graph orchestration, the codex-default key and ComfyUI wiring remain open — see Consequences. (Reconciled 2026-07-31.)
**Date:** 2026-07-08
**Supersedes/extends:** ADR-080 (Creative Studio), ADR-036 (bot-owned domain)

## Context

The Creative Studio (ADR-080) produces one video from a rotating library, on demand or on a
schedule. Over two days of hand-running it we produced five kids' series and learned — at the
cost of real Veo and Vertex credits — exactly what makes an episode watchable and what wastes
money. Those rules are in `docs/creative-studio/kids-video-pipeline-lessons.md`.

The operator asked for the next thing: a **user describes a series**, a bot **writes** the
scripts to those rules, the swarm **renders** the episodes on the remote Vids node, and the
result is **assembled**. The Video Studio (`?app=video`) existed as a single-clip surface
with no ticket type, no series concept, no screenwriter, and no assembly stage.

Two constraints shaped the design:

1. **Cost is asymmetric.** Writing is free, images are cheap, video is expensive. A mistake
   caught late is money; caught early it is nothing.
2. **The graph engine discards bot replies.** `ProcessDefinitionExecutionEngine` runs
   multi-stage graphs, but `EngineServicesAdapter.runExecution` returns only
   `{ dispatched, agentId }`, and each node rebuilds its prompt from the original ticket. No
   data flows *through* the graph.

## Decision

**A four-stage pipeline (write → storyboard → render → assemble), ordered by cost, with the
approval gate on the script.**

- **A state-machine conductor drives it**, not the graph engine. `advanceVideoSeries`
  (`series-orchestrator.ts`) does one safe step per call from the series' own state; the
  approval gate is the one edge it will not cross alone, and a render reconciler advances each
  series as its episodes finish. This is the ADR-036 out-of-band pattern — chosen over the graph
  engine because the engine discards bot replies, so it cannot carry a validated, persisted script
  from one stage to the next.
- **The persona is the quality gate**, not a route-side prompt string. `screenplay-writer`'s
  `perspective` block carries every hard rule; the api validates the bot's output against
  them and *rejects* rather than repairs. (CLAUDE.md: "the persona is the swarm".)
- **Stages hand off through `user_sub`-keyed tables**, keyed by `ticket_id`, because the graph
  cannot carry data. This also makes runs resumable — a retry re-reads a table instead of
  re-rendering.
- **The image vendor is behind an interface**, not welded in. `StoryboardImageProvider` with
  codex (default) / comfyui (free) / vertex (paid) siblings, selected by
  `STORYBOARD_IMAGE_PROVIDER`, failing closed. Same rule as TTS: never hardcode a vendor.
- **Rendering is serialized and node-side.** One episode at a time (the node drives one
  browser); dispatch over `shell.exec` (the gated transport LoRA already uses); assembly on
  the node where the media is.
- **Billing is per-user and opt-in.** Image generation uses the caller's own account; the
  swarm's Vertex service account is reachable only under `VEO_ALLOW_SWARM_BILLING`.

## Alternatives considered

- **Do the work in the route/controller** (fetch, generate, stitch inline). Rejected by
  ADR-036 — it bypasses cost capture, per-bot settings, and per-user ownership.
- **A plain `workerBot` manifest** (no graph). Rejected: it runs exactly one bot, and this is
  inherently multi-stage.
- **Fix the engine to carry stage output** (return `dispatchResult.response`, thread it into
  the next node's context). A good change, but larger and cross-cutting; the table hand-off
  works today and is the ADR-036-aligned path regardless.
- **Reuse `content.produce` for rendering.** Rejected: it splits *prose* into beats and has
  no way to accept one storyboard still per scene.

## Consequences

**Built and verified:** the migration (RLS-forced, constraints biting), the screenwriter bot
(registered in both registries, its rules validated in code), the manifest + graph
registration, the three stage functions, the provider interface (fails closed), the surface,
and the node renderer. **Run end to end once** — a real episode written by the bot,
storyboarded, rendered, assembled, ffprobe-verified (16.94s, h264/aac, 0s silence). A
security bug was caught *by* testing this over localhost with two impersonated users:
`ENABLE RLS` without `FORCE` enforced nothing, because the app role owns the tables.

**Also built + verified since (2026-07-09):** the conductor (`advanceVideoSeries`, `approveSeries`,
`reconcileRenderResult`, and the render reconciler) — exhaustively unit-tested at zero cost, 17/17
transitions: the approval gate holds, the render serializes, a re-run spends nothing, a failed
episode blocks completion, a rejected script fails the series. Deployed live; the reconciler runs on
a timer and the `/approve` + `/advance` routes are mounted and auth-gated.

**Not yet done (honest):**

1. **A live end-to-end run through the conductor** — the state machine is unit-tested and each
   stage was proven live, but one `POST /series` → auto-write → approve → auto-storyboard →
   auto-render → done has not been run as a single flow (it spends image + render credits and needs
   an explicit go). *2026-07-19: the dead `pipeline: graph` block was removed from
   `swarm-apps/video.yaml` (retired, not wired) — the conductor is the live path and the graph
   engine cannot carry the persisted script between stages, so the manifest now registers
   `video-series` as a plain manifest-worker workflow (guard:
   `tests/unit/video-manifest-no-graph.spec.ts`).*
2. **The `codex` image default cannot work — change it to `comfyui`.** Proven 2026-07-13: the
   swarm's OpenAI identity is a ChatGPT *subscription* OAuth, not a platform API key. `codex exec`
   runs fine on that token, but `api.openai.com` returns **403 on `/v1/models`** and **401 on
   `/v1/images`** — recognized and *forbidden*. The ChatGPT/Codex backend and the platform API are
   different auth realms, so codex authenticates the harness but can never generate images. Not a
   bug and not a stale token — a platform fact. The provider abstraction is unaffected and still
   correct; only the *default* is wrong. *2026-08-21: the trap half of this is closed — the codex
   provider now resolves the platform realm only (`getSwarmPlatformApiKey`), so the subscription
   token is never offered to `/v1/images`; an OAuth-only box fails closed at resolve time with the
   paste-a-platform-key hint, and `healthCheck` probes `/v1/models` (200 = platform key, 403 =
   subscription realm). The default stays `codex` and is satisfied by a platform
   `OPENAI_API_KEY`/`openAiApiKey`. ComfyUI as the free default remains open (BACKLOG).*
3. **ComfyUI (the free path) is stubbed to throw**, not wired — and is now the *recommended*
   default: free, needs no new credential, and runs on the GPU box that already does LoRA.
4. **No season-level assembly / intro** through the pipeline yet.

Full walkthrough: [video-series-pipeline.md](../creative-studio/video-series-pipeline.md).
Remaining work, with done-when criteria: [BACKLOG.md](../BACKLOG.md#video-series-pipeline-adr-082--remaining-work).

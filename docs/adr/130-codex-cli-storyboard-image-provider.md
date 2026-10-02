# ADR-130 — codex-cli storyboard image provider (demo-mode rendering on the swarm's own harness)

**Status:** Accepted; amended 2026-10-02 (the demo default follows the swarm default; antigravity-cli rail)
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
- Video Studio's storyboard stage carries the identity too (2026-09-17). It does NOT take it as an
  argument: `storyboardEpisode` selects `s.user_sub` from the `video_series` row it already joins
  and puts it on `StoryboardContext`, so the sub that reaches the resolve is the series OWNER by
  construction — no caller can omit it, and none can name somebody else. That covers both entry
  points at once: the conductor (`advanceVideoSeries` → `storyboardEpisode`) and the `video`
  package's per-episode storyboard route. Guard:
  `tests/unit/series-storyboard-owner-sub.spec.ts`. The live demo-box render through a real bot
  node is still owed and stays in BACKLOG "Video Studio storyboards on the demo codex-cli rail".
- **The render dispatch names the codex harness (2026-09-21).** The "Model" bullet above assumed
  the render bot's boot provider was codex. Since ADR-162 the fleet default is a switch row, and
  the demo box's row is `claude-code` — measured 2026-09-21 on `b1f0f28e`: the storyboard stage
  selected `codex-cli`, general-bot admitted the spawn under the demo carve, but it ran
  `claude -p …` and answered `NO_IMAGE_CAPABILITY`, so every series died at frame 1. The executor
  now stamps `providerId: 'openai-codex'` on the dispatch (the ADR-034 carried record, the same
  mechanism Jarvis's CLI brain uses); the bot reconciles its active provider to codex before the
  spawn or refuses fail-closed (a concurrent execution on another harness refuses rather than
  switching a running task). The model is still not pinned — it rides the render bot's
  `CODEX_MODEL`. Guard: `tests/unit/storyboard-cli-image-wiring.spec.ts`.
- The render task's workspace (`sbimg-*`, anchor + output PNG) persists on the shared volume like
  every other task workspace; the surface stores its own copy of the deliverable.
- Guard: `tests/unit/storyboard-codex-cli-provider.spec.ts` (demo-aware default, gate mirroring,
  real-filesystem render round-trip, PNG validation, bot-refusal surfacing);
  `storyboard-codex-platform-key.spec.ts` keeps the non-demo default pinned to `codex`.
- The prompt-injection surface is unchanged in kind: briefs reach the same CLI the swarm already
  feeds with chat and ticket text, under the same demo-carve confinement; portrait briefs are
  catalog-built with fail-closed id validation.

## Amendment — 2026-10-02: the image default follows the swarm default

Operator decisions, 2026-10-02: "our settings should have swarm default as the default. that is
antigravity", then "Prove first, then build". The proof ran the same day on the render bot
(agy 1.2.8, the wrapper's own unbridged task-turn argv, private HOME): a prompt that names the
`generate_image` tool, with the source image as an absolute `ImagePaths` entry, produced a tool
step `generate_image` ACTIVE → DONE in about 10 s and a 1024 x 1024 JPEG at
`$HOME/.gemini/antigravity-cli/brain/<conversation>/<name>_<epoch-ms>.jpg`, nothing in the work
directory. A prompt that did not name the tool got an image drawn with code instead, and the edit
added a mark nobody asked for.

**Decision.**

- **A sixth sibling, `antigravity-cli`** (`storyboard-antigravity-image-provider.ts`), beside
  `codex-cli`: the same boot-registered bot-node executor, the same availability gates (executor +
  `DEMO_MODE` + an operator caller) and, at the bot, the same single ADR-127 carve — nothing
  broader. Its prompt names `generate_image`, passes the staged anchor's absolute path as
  `ImagePaths`, and forbids code, commands, files and anything the brief does not ask for. Cost
  class `free` (subscription-included), `costUsd: null`, exactly as codex-cli.
- **The demo default follows the swarm default.** `STORYBOARD_IMAGE_PROVIDER` is still the explicit
  override and always wins. With it unset and `DEMO_MODE` on, the fleet-default row of the
  provider switch (ADR-162) picks the rail:

  | Swarm default (fleet-default row) | Image rail |
  |---|---|
  | `antigravity-cli` | `antigravity-cli` |
  | `openai-codex`, `codex-cli` | `codex-cli` |
  | no fleet-default row (or no switch store in the process) | `codex-cli` (this ADR's original default) |
  | any other harness (`claude-code`, `cline`, a Cline-backed id, …) | refused: "the swarm default `<harness>` cannot make images; set STORYBOARD_IMAGE_PROVIDER" |
  | switch not loaded yet | refused, naming the override |

  A refusal never falls back to a paid rail. **The non-demo default is unchanged: `codex`.**
  Selection lives in one function, `selectStoryboardImageProvider`, which the resolver and the
  Test Lab readback both call. The feature does not import the app layer: the app registers a
  reader at boot (`readFleetDefaultHarness` over the installed switch snapshot), and the resolver
  reads it on every call, so a fleet switch moves the image rail at the snapshot's own refresh
  (`OSHAL_PROVIDER_SWITCH_REFRESH_MS`, 30 s by default) with no restart.
- **The render dispatch carries the chosen rail's harness** — `openai-codex` for codex-cli,
  `antigravity-cli` for antigravity-cli — as its ADR-034 record, instead of the fixed
  `openai-codex`. Every render is marked `imageTurn`, and its prompt reaches the bot verbatim (no
  ticket or handover scaffolding), without the host-tools-only marker.
- **Two guards on the bot side** (`any-bot/server/services/codebase/agy-image-turn.js`, run by the
  wrapper before it deletes the private HOME):
  - *Collection.* The image `generate_image` wrote is found through the path the tool reported in
    its own step output, or failing that the newest `<name>_<epoch-ms>` image directly in a
    conversation folder of the private brain; it is copied into the task workspace as `output.png`
    or `output.jpg` by its real bytes, with a receipt (`output.image-turn.json`: tool, state, file,
    mime type, bytes, sha256, locator). The provider accepts exactly one output, checks it against
    the receipt, converts a JPEG to PNG (the frame cropper decodes PNG only) and reports the real
    source format.
  - *Guard A.* Nothing is collected unless the turn's stream shows a `generate_image` tool step
    that reached DONE, the file is a regular PNG or JPEG inside the private brain directory written
    during the turn, and the workspace does not already hold an output or a receipt. An image
    drawn with code, a run_command-only turn, a tool step that ended in ERROR, a file older than
    the turn and a path outside the brain are all refused, and the turn fails.
- **Store Create** accepts the operator-only `antigravity-cli` rail (operator decision
  2026-10-02, "Allow it for me now"): its region edit needs the provider to report itself
  available for the caller, so anyone but the operator is told "not configured" and nothing else
  is tried. The command-line transport still does not carry Create's application permission to the
  bot, so the rail serves the operator only; `codex-cli` stays refused.

**Consequences.**

- With the fleet default `antigravity-cli` and `DEMO_MODE` on, the resolver selects
  `antigravity-cli` for every consumer that passes the caller's sub: Video Studio's storyboard
  stage, Create's region edit, and Portrait Studio, which refuses only `codex-cli` by name. Any
  caller but the operator gets the not-configured refusal. None of these has rendered on the box
  yet (see the live proof below).
- Guards: `tests/unit/storyboard-image-default.spec.ts` (mapping, override, fail-closed, the real
  switch snapshot), `tests/unit/storyboard-antigravity-image-turn.spec.ts` (the real bot-node
  chain and wrapper against a stand-in `agy` child on the real filesystem; Guard A),
  `tests/unit/storyboard-cli-image-wiring.spec.ts` (the carried harness and the real reconcile),
  `tests/unit/storyboard-test-lab-render.spec.ts` (the live card).
- Live proof on the box is the automated case `node scripts/operations/live-acceptance.js
  storyboard-agy` (Lab card `storyboard-swarm-default-render`): one frame on the resolved default,
  `generate_image` DONE, a real PNG, its workspace removed. It has not run on the box yet.

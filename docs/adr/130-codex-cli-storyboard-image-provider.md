# ADR-130 — codex-cli storyboard image provider (demo-mode rendering on the swarm's own harness)

**Status:** Accepted; amended 2026-10-02 (the render bot's own harness picks the image rail; antigravity-cli rail; phase 2 not built; amendment (b): the image-turn prompt framing, the SEC-05 carve for image turns)
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

## Amendment — 2026-10-02: the render bot's own harness picks the image rail

Operator decisions, 2026-10-02: "our settings should have swarm default as the default. that is
antigravity", then "Prove first, then build", then, once the first build showed images being chosen
for the whole deployment, "ok lets go with your recommendation": the bot's own setting wins, for
images exactly as for text. The proof ran the same day on the render bot (agy 1.2.8, the wrapper's
own unbridged task-turn argv, private HOME): a prompt that names the `generate_image` tool, with the
source image as an absolute `ImagePaths` entry, produced a tool step `generate_image` ACTIVE → DONE
in about 10 s and a 1024 x 1024 JPEG at
`$HOME/.gemini/antigravity-cli/brain/<conversation>/<name>_<epoch-ms>.jpg`, nothing in the work
directory. A prompt that did not name the tool got an image drawn with code instead, and the edit
added a mark nobody asked for.

**Decision (phase 1, built).**

- **A sixth sibling, `antigravity-cli`** (`storyboard-antigravity-image-provider.ts`), beside
  `codex-cli`: the same boot-registered bot-node executor, the same availability gates (executor +
  `DEMO_MODE` + an operator caller) and, at the bot, the same single ADR-127 carve — nothing
  broader. Its prompt names `generate_image`, passes the staged anchor's absolute path as
  `ImagePaths`, and forbids code, commands, files and anything the brief does not ask for. Cost
  class `free` (subscription-included), `costUsd: null`, exactly as codex-cli.
- **Image generation is something the render bot does, so the render bot's own harness picks the
  rail.** The render bot is the one this ADR already names (`STORYBOARD_CLI_IMAGE_BOT_ID`, default
  general-bot). Its effective provider is resolved exactly like its text turns: the canonical
  runtime-params record every bot-node dispatch is stamped with (its own provider-switch row, else
  the fleet default, else its `agent_config` record or registry declaration; ADR-034, ADR-162).
  With `STORYBOARD_IMAGE_PROVIDER` unset and `DEMO_MODE` on:

  | Render bot's own effective provider | Image rail |
  |---|---|
  | `antigravity-cli` | `antigravity-cli` |
  | `openai-codex`, `codex-cli` | `codex-cli` |
  | any other harness (`claude-code`, `cline`, a Cline-backed id, …) | refused: "`<bot>` runs `<harness>`, which cannot make images; give that bot an image-capable harness, or set STORYBOARD_IMAGE_PROVIDER to an image API" |
  | no record at all, or the record cannot be read (for example the switch snapshot has not completed its first read) | refused, naming the bot |

  A bot's own row wins over the fleet default in both directions: a render bot on `openai-codex`
  renders on `codex-cli` while the fleet default is `antigravity-cli`, and a render bot on
  `claude-code` is refused although the fleet default could make images. A refusal never falls back
  to a paid rail. **The non-demo default is unchanged: `codex`.** Selection lives in one function,
  `selectStoryboardImageProvider`, which the resolver and the Test Lab readback both call. The
  feature does not import the app layer: the app registers a render-bot reader at boot
  (`createStoryboardRenderBotReader` over the swarm's canonical runtime-params resolver), and the
  resolver reads it on every call, so a switch row write moves the image rail at the snapshot's own
  refresh (`OSHAL_PROVIDER_SWITCH_REFRESH_MS`, 30 s by default) with no restart. In a process with
  no boot wiring the demo default stays `codex-cli`, which then reads unavailable for want of the
  executor.
- **The render never changes the render bot's provider.** The 2026-09-21 consequence above (a fixed
  `providerId: 'openai-codex'` stamp that moved the render bot onto codex for the turn) is replaced:
  the render dispatch is stamped with the render bot's OWN canonical record, the same one its text
  turns carry, so the bot's ADR-034 reconcile is a match on its own setting and never a switch. At
  dispatch the executor reads that record again and refuses, before any network call, when its
  harness's rail is not the rail the render was prepared for (the bot was switched in between, or
  `STORYBOARD_IMAGE_PROVIDER` names the other CLI rail): "`<bot>` runs `<harness>`, whose image
  rail is `<rail>`, but this render was prepared for `<other>`; a render never switches the bot's
  harness". The stamp carries an EMPTY fallback chain, so the bot's post-execution check refuses a
  turn a failover rung ran on another harness. Every render is marked `imageTurn`, and its prompt
  reaches the bot verbatim (no ticket or handover scaffolding), without the host-tools-only marker.
- **`STORYBOARD_IMAGE_PROVIDER` is the explicit deployment override**, not the default: the image
  APIs (`codex` platform key, `comfyui`, `vertex`, `openrouter`), and the CLI ids for compatibility,
  which serve only when the render bot's own harness is that rail's harness.
- **Two guards on the bot side** (`any-bot/server/services/codebase/agy-image-turn.js`, run by the
  wrapper before it deletes the private HOME):
  - *Collection.* The image `generate_image` wrote is found through the path the tool reported in
    its own step output, or failing that the newest `<name>_<epoch-ms>` image directly in a
    conversation folder of the private brain; it is copied into the task workspace as `output.png`
    or `output.jpg` by its real bytes, with a receipt (`output.image-turn.json`: tool, state, file,
    mime type, bytes, sha256, locator). The provider accepts exactly one output, checks it against
    the receipt, converts a JPEG to PNG (the frame cropper decodes PNG only) and reports the real
    source format, the provider the bot ran on and its reconcile action.
  - *Guard A.* Nothing is collected unless the turn's stream shows a `generate_image` tool step
    that reached DONE, the file is a regular PNG or JPEG inside the private brain directory written
    during the turn, and the workspace does not already hold an output or a receipt. An image
    drawn with code, a run_command-only turn, a tool step that ended in ERROR, a file older than
    the turn and a path outside the brain are all refused, and the turn fails.
- **Store Create and Portrait Studio** accept the operator-only `antigravity-cli` rail (operator
  decisions 2026-10-02, "Allow it for me now" and "it should just be the same everywhere"): each
  needs the provider to report itself available for the caller, so anyone but the operator is told
  "not configured" and nothing else is tried. The command-line transport still does not carry the
  application's permission to the bot, so the rail serves the operator only; `codex-cli` stays
  refused by both.

**Not built (phase 2).** A per-bot image setting for a bot whose main harness cannot make images,
and the image APIs (ComfyUI, OpenAI images, OpenRouter, Vertex) selectable at the bot level, which
would retire the deployment-wide `STORYBOARD_IMAGE_PROVIDER` selector. Until then a render bot on a
harness with no image rail is refused, and the env override is the only way to name an image API.
Carrying an application's permission (Create's `project.generate`, Portrait's create) through the
CLI image dispatch is also not built.

**Consequences.**

- With the render bot on `antigravity-cli` (its own row, or the fleet default) and `DEMO_MODE` on,
  the resolver selects `antigravity-cli` for every consumer that passes the caller's sub: Video
  Studio's storyboard stage, Create's region edit and Portrait Studio. Any caller but the operator
  gets the not-configured refusal. None of these has rendered on the box yet (see the live proof
  below).
- Guards: `tests/unit/storyboard-image-default.spec.ts` (the mapping, the override, fail-closed, and
  the real reader over the canonical record and the real switch snapshot: bot row over fleet default
  both ways, registry declaration, unread snapshot, a row write moving the rail),
  `tests/unit/storyboard-cli-image-wiring.spec.ts` (the stamp is the bot's own record with an empty
  chain; the real bot-side parse and reconcile answer `match` with no switch; a mismatched rail, a
  bot that cannot make images, no record and no resolver are refused before dispatch),
  `tests/unit/storyboard-antigravity-image-turn.spec.ts` (the real bot-node chain and wrapper against
  a stand-in `agy` child on the real filesystem; Guard A; one render end to end through the real
  wiring, the route's own provider-authority mapping and the real handler's reconcile),
  `tests/unit/storyboard-test-lab-render.spec.ts` (the live card).
- Live proof on the box is the automated case `node scripts/operations/live-acceptance.js
  storyboard-agy` (Lab card `storyboard-antigravity-render`): one frame on the render bot's
  antigravity rail, `generate_image` DONE, a real PNG, the bot's report that it ran
  `antigravity-cli` with a `match` reconcile, its workspace removed. It has not run on the box yet.

**Amendment (b), 2026-10-02 — the image-turn prompt framing (SEC-05 carve, server-authored
instruction only).** The first live render on the box (main `1848fb4f`, 19:00 UTC) was refused by
Guard A with no `generate_image` step, and the diagnosis showed why: the bot received the persona
prefix and the full Cline system prompt ("1 tools: attempt_completion") in front of the handler's
SEC-05 prompt, in which the whole render instruction sat inside the data-only `UNTRUSTED_CONTENT`
record under an authority rebind of `["attempt_completion"]`; the model's own reasoning named the
contradiction and refused, while the same text rendered in a reproduction after three turns of
deliberation. Operator decision: on image turns the SERVER-authored render instruction is carried as
trusted configuration and the image tool is on that turn's allowed list; user-originated content
stays untrusted; Guard A stays. Built once at the shared choke points, so every caller of the rail
(Video Studio storyboards, the Test Lab render card, Create's region edit, Portrait Studio, and the
Switchboard and D&D surfaces once they pass a `userSub`) is framed the same way:

- The render request separates the server template from the user field: `prompt` is the
  server-authored instruction (tool, inputs, output contract) and `brief` is the user-originated
  text. Both CLI rails' instructions name the brief by reference as the `content` value of the
  `UNTRUSTED_CONTENT` record whose source is `ticket-or-user-body`, to be used as data.
- The dispatch sends `brief` as `text` and `prompt` as `renderInstruction`; `/api/swarm-execute`
  validates `renderInstruction` like `pattern` and accepts it only beside a literal
  `imageTurn: true`.
- The bot-node handler files the instruction under `TRUSTED CONFIGURATION`
  (`[trusted-config source="image-render-instruction"]`), keeps the brief in the data-only record,
  and widens the rebind by the harness's own image tool with its scope: `generate_image` and
  `tool:generate_image` on `antigravity-cli`. The codex CLI's native image tool name was never
  recorded (the 2026-08-22 proof captured images, not the tool), so a codex image turn keeps the
  completion floor alone until it is. An image turn without the carrier is refused before a task
  exists; no other turn reads either field.
- The any-bot agentic loop prepends nothing to an image turn: no persona prefix, no Cline or
  minimal system prompt. Every other turn is framed exactly as before.
- Guard A is unchanged, and the live case `storyboard-agy` now bounds its one blocking call by the
  render dispatch budget (`STORYBOARD_CLI_IMAGE_TIMEOUT_MS`, 420 s) plus 60 s, through the runner's
  new per-call `timeoutMs`; under the 30 s default it crashed before the 19:00 render answered.

Guards: `tests/unit/image-turn-prompt-framing.spec.ts` (the exact text agy receives on an image turn
through the real handler, loop, provider, wrapper and a stand-in `agy` child, and that a direct and
a ticket turn are unchanged), plus the updated `storyboard-antigravity-image-turn`,
`storyboard-cli-image-wiring`, `storyboard-codex-cli-provider`, `bot-node-prompt-carrier`,
`live-acceptance-runner` and `live-acceptance-storyboard-agy` suites. The live proof on the box is
still the `storyboard-agy` case after a deploy of this change.

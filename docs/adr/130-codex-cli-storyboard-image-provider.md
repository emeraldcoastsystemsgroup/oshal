# ADR-130 — codex-cli storyboard image provider (demo-mode rendering on the swarm's own harness)

**Status:** Accepted; amended 2026-10-02 (the render bot's own harness picks the image rail; antigravity-cli rail; phase 2 not built; amendment (b): the image-turn prompt framing, the SEC-05 carve for image turns) and 2026-10-03 (a bot found on a stale default is first corrected onto its own setting; Guard A's refusals say which way the turn failed; amendment (c): a `generate_image` ERROR is retried as up to two fresh turns inside the caller's deadline, and the render bot takes one image turn at a time)
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
- **A render never moves the bot off its own setting; a bot found on a stale default is first
  corrected onto it (ADR-034).** The 2026-09-21 consequence above (a fixed
  `providerId: 'openai-codex'` stamp that moved the render bot onto codex for the turn) is replaced:
  the render dispatch is stamped with the render bot's OWN canonical record, the same one its text
  turns carry, so the bot's ADR-034 reconcile is a match on that setting or, when the bot is found
  running something else, a correction onto it before the turn. At
  dispatch the executor reads that record again and refuses, before any network call, when its
  harness's rail is not the rail the render was prepared for (the bot was switched in between, or
  `STORYBOARD_IMAGE_PROVIDER` names the other CLI rail): "`<bot>` runs `<harness>`, whose image
  rail is `<rail>`, but this render was prepared for `<other>`; a render never switches the bot's
  harness". The stamp carries an EMPTY fallback chain, so the bot's post-execution check refuses a
  turn a failover rung ran on another harness. Every render is marked `imageTurn`, and its prompt
  reaches the bot verbatim (no ticket or handover scaffolding), without the host-tools-only marker.

  *Amended 2026-10-03.* This bullet said "the render never changes the render bot's provider … a
  match on its own setting and never a switch". The first live render after a deploy (00:24 UTC,
  main `44d3a823`) showed why that was wrong: general-bot had booted at 00:14:54 while the api was
  unreachable, fell back to its env seed (`openai-codex`, `gpt-5.5`), and the render's dispatch,
  carrying the bot's own `antigravity-cli` record, corrected it onto that record before the turn
  (ADR-034 `corrected`); the frame rendered, and the Lab card and the live case, which required
  `match`, failed it. Operator decision 2026-10-03: both accept `match` or `corrected` when the render
  ran on the render bot's own harness, and still fail any other reconcile action or a turn that ran
  elsewhere.
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
    the turn and a path outside the brain are all refused, and the turn fails. Since 2026-10-03 a
    refusal says which way the turn failed (`generate_image` never ran, ran and ended in ERROR, ran
    but did not finish, or reached DONE with no acceptable file) and then, behind a fixed marker,
    gives the bot's untrusted diagnostic: the ERROR step's own error text and the model's final
    reply, each with control characters turned into spaces and bounded to 200 characters. The bot
    logs the same. Neither side lets that diagnostic into a message it classifies. On the node the
    Antigravity provider keeps it off the error's message and stderr, which the node's provider
    failover reads (a throttle word in the tool's or the model's text would otherwise send the
    render to the fallback rung), and the handler re-attaches it only where the error leaves the
    node. The api keeps it off the render error's message and carries it beside it as `diagnostic`,
    because the storyboard frame stage and Portrait Studio decide a retry from the message (and
    Switchboard its not-configured answer). The Lab card shows it. What Guard A accepts did not
    change.
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

*Pointer, 2026-10-03:* [ADR-173](173-capability-providers-resolve-per-user.md) (accepted) carries the first two items: the per-bot image setting is the bot rung of its resolution order (D1, D2, D7), the image APIs become providers selectable per user and per bot, and `STORYBOARD_IMAGE_PROVIDER` is retired in its slice S5. Still not built; the application-permission item stays in BACKLOG.

**Consequences.**

- With the render bot on `antigravity-cli` (its own row, or the fleet default) and `DEMO_MODE` on,
  the resolver selects `antigravity-cli` for every consumer that passes the caller's sub: Video
  Studio's storyboard stage, Create's region edit and Portrait Studio. Any caller but the operator
  gets the not-configured refusal. Of these, Create's region edit has rendered on the box on
  `antigravity-cli`: `create-region-edit` passed 2 of 2 on main `44d3a823`, then 10 of 10 on
  `3f06817f` and 10 of 10 on `3642c1f1` (2026-10-03). Video Studio's storyboard stage and Portrait
  Studio have no recorded live run on the box yet; the live proof below renders through the
  provider directly, not through the storyboard stage.
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
  antigravity rail, `generate_image` DONE, a real PNG, the bot's report that it ran its own
  `antigravity-cli` with a `match` reconcile, or a `corrected` one when it was found on a stale
  default (2026-10-03), its workspace removed. On main `44d3a823` (2026-10-03 00:24 UTC) it passed
  0 of 3: the first render produced its frame through `generate_image` and was failed by the then
  match-only check, and the next two were refused by Guard A. On main `3f06817f` (04:41 to 04:47
  UTC) it passed 4 of 10, and on main `3642c1f1` (09:19 to 09:26 UTC, amendment (c)) 9 of 10; each
  PASS line names `generate_image` DONE and the bot's own `antigravity-cli` with a `match`
  reconcile, with cleanup outstanding 0.

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
the `storyboard-agy` case after a deploy of this change. On main `44d3a823` (2026-10-03 00:24 UTC)
it passed 0 of 3: the first render called `generate_image` under this framing and produced its
frame, which the case, then match-only, failed on a `corrected` reconcile, and the next two were
refused by Guard A. It passed 4 of 10 on main `3f06817f` and 9 of 10 on main `3642c1f1`
(amendment (c)).

**Amendment (c), 2026-10-03 — retry a `generate_image` ERROR as fresh turns; one image turn at a
time per render bot.** After amendment 2026-10-03 shipped (main `3f06817f`, deployed 04:41 UTC), the
operator-approved measured run of 10 interleaved pairs (04:41 to 04:47 UTC) passed Create's region
edit 10 of 10 and the storyboard render card 4 of 10. All six failures were Guard A's "`generate_image`
ran and ended in ERROR": the tool's own error was `TOOL_ERROR` "no image generated in response", the
model then replied `NO_IMAGE_CAPABILITY`, and no failover line was logged. It was not throttling:
Create's renders, seconds apart on the same Antigravity login and endpoint, all passed. And a fresh
attempt does not inherit the last one: byte-identical replays in fresh conversations went ERROR, DONE,
ERROR. Operator decision 2026-10-03: "Retry, max 3, fresh turns" and "Throttle image renders".

- **Retry.** The `antigravity-cli` provider runs a render again only when a failed attempt's error
  message ends with Guard A's fixed words, `image turn refused: the event stream shows no
  generate_image tool step that reached DONE: generate_image ran and ended in ERROR`
  (`ANY_BOT_IMAGE_TURN_ERROR_REFUSAL`, pinned equal to `agy-image-turn.js`), alone or followed by
  Guard A's own ` [backoff]`. It never reads the untrusted diagnostic for that, so neither the tool's
  text nor the model's reply can make a render retry or wait longer. Each retry is a fresh turn: a
  new task id and workspace (`<id>-a2`, then `<id>-a3`), the anchor staged again, a new private HOME
  on the bot. The waits are about 3 s and then 8 s, with up to 20 % jitter; with ` [backoff]` they are
  about 20 s and then 45 s. Three attempts in all. Never retried: `generate_image` never ran, ran but
  did not finish, reached DONE with no acceptable file, a missing or mismatched output, and any
  failure that is not Guard A's; such a failure on the first attempt keeps its error exactly as
  before.
- **Guard A's `[backoff]` category.** Guard A appends ` [backoff]` to its ERROR refusal when the
  ERROR step's own error text reads as a quota or rate limit by the provider failover classifier's
  throttle vocabulary (`isProviderThrottle`). Only the tool's error decides it, never the model's
  reply, and it can only lengthen the wait: the attempt limit and the deadline still hold. The token
  is Guard A's own and matches none of the failover classifier's patterns, because the reason reaches
  the error the node's provider failover classifies; the tool's text itself still rides only in the
  diagnostic.
- **Throttle.** The CLI image executor runs every render dispatch through an in-process queue keyed
  by the render bot (`ImageTurnQueue`, `src/app/storyboard-image-turn-queue.ts`): the bot runs one image
  turn at a time and other renders wait their turn in arrival order. The render bot's record is still
  read and checked inside the turn, at dispatch. Text turns never enter the queue. It covers both CLI
  rails.
- **Deadline.** The whole render (its waits for the render bot, every attempt and the waits between
  them) stays inside the caller's own deadline: `deadlineMs`, through `resolveStoryboardImageProvider`
  or the provider's options. Callers that pass none get 90 s: the 120 s that Create's region edit
  (`CREATE_REGION_EDIT_TIMEOUT_MS`) and Portrait Studio (`PORTRAIT_STUDIO_VENDOR_TIMEOUT_MS`) wait by
  default, less one attempt's 30 s. Since an attempt starts only while it is expected to end inside the
  budget, the last one still ends before their own timeout fires even when it runs 30 s longer than the
  longest attempt before it (twice as long while no attempt has taken over 30 s); when Portrait's timeout fires it starts the whole render again. The storyboard frame stage and the Test Lab render card pass the CLI render budget
  (`STORYBOARD_CLI_IMAGE_TIMEOUT_MS`, 420 s), which the live case's one blocking call already carries
  plus its margin. An attempt starts only while the time left still covers one attempt (30 s until
  the render has timed one, then its longest attempt so far, its wait for the render bot included).
  Each dispatch carries that latest start
  time (`startBy`) to the queue, which answers `busy` with nothing dispatched when the bot is still
  taken then. A render that stops says why: "render retries exhausted" (all three attempts failed, or
  the deadline leaves no time for the next) or "image renders are busy". The deadline decides only
  whether an attempt starts; a dispatch already running is bounded by its own dispatch budget, as
  before.
- **Stop messages.** Once a render has retried, or stops at Guard A's ERROR, the error it throws is the
  provider's own words only: Guard A's fixed ERROR words (with ` [backoff]` when it applied), then how
  the retries ended ("render retries exhausted", "render retries stopped" for a retry that failed in
  a way that is never retried, or "image renders are busy"). A retry attempt's own error, such as a
  bot-node 500 or a dispatch timeout, is logged with the attempt but never leads the message, so
  neither the storyboard frame stage nor Portrait Studio, which both retry on a message they read as
  transient, re-runs a render the provider already retried. The first version of this amendment let
  that attempt's words lead: through the real frame stage, a Guard A ERROR followed by a bot-node 500
  on the retry made one frame run 10 image turns (verifier finding on core PR #1033). Now it makes two.
  A first attempt that is never retried keeps its error as before, so a caller still retries one that
  failed transiently (a bot-node 500 before any fresh turn), as it always did, and the turns add up.
  Neither changes here: the provider retries only Guard A's ERROR, and the callers' own retries are
  theirs. The bound per caller is:
  - the storyboard frame stage makes at most its stage retries plus three image turns per frame, at
    most 7 (four transient first attempts, then one render of three), against 5 before this change;
  - Portrait Studio makes at most 5 per portrait (two transient first attempts under its own
    `withRetries`, then one render of three), against 3 before, while each render ends inside its
    120 s timeout, which the 90 s default leaves one attempt of headroom for;
  - Create's region edit and the Test Lab render card have no retry of their own: at most 3.

  Every one of these is a free-class turn on the operator's Antigravity subscription. The frame-stage
  bound is swept through the real `generateStoryboardFrame`: k = 0 to 4 transient first attempts, then
  Guard A's ERRORs, make exactly k + 3 turns (k + 1 when the next render succeeds at once, k + 2 when
  its fresh retry does), and five transient first attempts end the stage at its fifth turn, as before.
- **Observability.** Each failed attempt is logged on the api (`antigravity-cli render attempt
  failed`: `attempt` n/3, `category`, `waitMs`, `outcome`), a rendered frame reports
  `cliRender.attempt`, and the Test Lab card's verdict and the `storyboard-agy` PASS line name the
  attempt that rendered the frame. The card removes the tagged workspace and each attempt's.
- **Not built.** Create and Portrait Studio do not pass their own configured deadline yet, so a
  deployment that sets either below its 120 s default still gets the 90 s default budget, not one
  below its own setting.

Guards: `tests/unit/storyboard-antigravity-render-retry.spec.ts` (the provider over the real Guard A
wording, fake timers measuring every wait: what is and is not retried, the fresh task ids, the waits,
`[backoff]`, the deadline and `startBy`, busy, and that the diagnostic decides nothing; the verifier's
probe through the real `generateStoryboardFrame`, at most three turns and no stage retry once the
provider retried; the sweep of k = 0 to 4 transient first attempts, exactly k + 3 turns and never more
than 7; the 90 s default ending before 120 s when an attempt starts as late as it may and runs twice
its 30 s reserve while no earlier attempt took over 30 s; and every stop message driven out of the provider and checked against the frame stage's
real `STORYBOARD_FRAME_TRANSIENT_ERROR` and against Portrait Studio's `isTransientVendorError`, which,
being store code, is a verbatim copy pinned by the sha256 of the store source),
`tests/unit/storyboard-image-turn-queue.spec.ts` (the queue itself), plus the updated
`storyboard-antigravity-image-turn` (fresh turns through the real chain and a real `agy` child, and
` [backoff]` through the real provider failover with no rung run), `storyboard-cli-image-wiring` (two
concurrent renders reach the bot one at a time; busy at `startBy`; a text turn is not queued),
`storyboard-test-lab-render` and `live-acceptance-storyboard-agy` suites. The live proof is the measured
run of `storyboard-agy` and `create-region-edit` pairs after a deploy of this change.

*Live proof, 2026-10-03.* Main `3642c1f1` was deployed at 09:12 UTC (post-verify PASS). The measured
run of 10 interleaved pairs from 09:19 to 09:26 UTC passed `create-region-edit` 10 of 10 and
`storyboard-agy` 9 of 10, against 4 of 10 before this change: 6 frames rendered on attempt 1, 3 on
attempt 2, and 1 render failed all three ("render retries exhausted: all 3 attempts failed"). The api
logged 6 `antigravity-cli render attempt failed` lines, every one `category: "error"` (none
`[backoff]`): attempt 1/3 with a retry wait of 3.1 to 3.3 s, 2/3 with 9.3 s, and 3/3 with
`outcome: "exhausted"`. Each attempt's diagnostic was again `TOOL_ERROR` "no image generated in
response" and `NO_IMAGE_CAPABILITY`, the render bot logged no failover (`retrying via`) line, and
every run's cleanup was outstanding 0. The throttle check at 09:27:27 UTC started both cases at the
same moment, and both passed, the storyboard on attempt 3 of 3. The api logged `cli storyboard
render waited its turn on the render bot` twice, for the Create render (`waitedMs` 11958) and for the
storyboard's attempt 2 (`waitedMs` 10846), and the render bot's image turns ran strictly one after
another: storyboard attempt 1 from 09:27:27.956 to 09:27:39.953 (refused), Create from 09:27:39.994
to 09:27:53.886, attempt 2 from 09:27:53.950 to 09:28:16.912 (refused), and attempt 3 from
09:28:26.526 to 09:28:40.096 (rendered).

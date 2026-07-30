# Video Series Pipeline

How a user's *series* description becomes finished episodes, and where every piece lives.
This is the swarm-wired version of the hand-run process in
[kids-video-pipeline-lessons.md](./kids-video-pipeline-lessons.md). Read that first — the
rules it describes are what this pipeline enforces in code.

A user describing a series is one way to start this pipeline. The other is the
[joke-shorts pump](./joke-shorts-pump.md) (ADR-120), which drives the same conductor on a schedule —
rotating enrolled shows, refusing to touch the render node while anything else owns it, and resuming
its own interrupted work. Nothing below changes when the pump is the caller.

## The shape

```
describe → WRITE → [approve the scripts] → STORYBOARD → RENDER → ASSEMBLE → deliver
           free                            cheap        expensive
```

The order is a **cost order**. Each stage catches the mistakes the next one would pay for:

- A speaker who is not on screen is rejected in **WRITE**, for nothing.
- Two scenes that are the same shot are rejected in **STORYBOARD**, for pennies.
- Neither ever reaches **RENDER**, which is where the video credits go.

That ordering is the whole point. A night of render credits was once spent because a bad
script and duplicate frames reached the renderer; the gates exist so that cannot recur.

## The parts

| Piece | File | What it is |
|---|---|---|
| Manifest | `swarm-apps/video.yaml` | `ticketType: video-series` as a plain manifest-worker workflow (the dead `pipeline: graph` block was retired 2026-07-19 — the conductor is the runtime) |
| Bot | `ai-lab/bot-personas/screenplay-writer.yaml` | The screenwriter. Reason-only, inline on the api. Its `perspective` block **is** the quality gate. |
| Registry | `swarm-bot-registry.ts` **and** `-echo.ts` | `screenplay-writer` at `a0000000-…-052`, in **both** (echo is the live one). |
| Tables | `066-video-series.sql`, `067-video-episode-scenes.sql` | `video_series` + `video_episodes`. RLS-forced, `user_sub`-keyed. **These are the stage hand-off.** |
| Stages | `src/app/series-pipeline.ts` | `writeSeries`, `storyboardEpisode`, plus validation and the speaker-pointer resolver. |
| **Conductor** | `src/app/series-orchestrator.ts` | `advanceVideoSeries` — the state machine that runs the stages in order; `approveSeries`; `reconcileRenderResult`; and the render reconciler. |
| Node dispatch | `src/app/series-dispatch.ts` | `dispatchStoryboardedEpisode` — hands stills + prompts to the render node over `shell.exec`. |
| Node renderer | `packages/oshal-vids-operator` `episode-render.js` | Runs on the node: downloads stills, animates each in Google Vids, stitches, saves. |
| Assembly | vids worker `episode.assemble` tool | Stitches an episode from its clips, on the node, where the media already is. |
| Image providers | `src/features/video-generation/services/storyboard-image-providers.ts` | Codex / ComfyUI / Vertex behind one interface. |
| Storyboard | `src/features/video-generation/services/storyboard-frames.ts` | Anchor frame, white-margin crop, near-duplicate rejection. |
| Surface | `src/app/routes/bot-video-routes.ts` + `src/api/video.html` | `POST /api/video/series` and the "Make a series" form. |

## The conductor (how it runs as one thing)

`series-orchestrator.ts` is the difference between "a set of parts" and "a thing you submit once
and watch finish". `advanceVideoSeries(ctx, seriesId)` does **exactly one safe step** from the
series' own state and returns:

```
scripting         → WRITE the scripts (LLM), park at awaiting_approval
awaiting_approval → park (the gate — a human approves; nothing paid runs before this)
storyboarding     → storyboard the next un-storyboarded episode; when all done, enter rendering
rendering         → dispatch the next storyboarded episode (ONE at a time); when all rendered, done
done | failed     → terminal
```

Three properties make it safe to leave running:

- **Idempotent & resumable.** State lives in Postgres, so a crash/restart/retry loses nothing and a
  re-run never re-renders what already exists.
- **The gate is absolute.** The one edge the conductor will not cross on its own is
  `awaiting_approval → storyboarding`. That is the last free moment — scripts written, no image or
  clip paid for. `approveSeries` is a human action; after it everything runs, before it nothing that
  costs money does.
- **Serialized render.** `rendering` dispatches one episode, parks on the in-flight render, and the
  **render reconciler** (`reconcilePendingRenders`, on a 20s timer started in `server.ts`) flips each
  finished episode to `rendered` and calls advance again — dispatching the next, or finishing.

The stage functions are injectable, so the whole state machine is tested without spending a cent
(17/17 transitions: gate holds, serialization holds, resume spends nothing, a failed episode blocks
completion, a rejected script fails the series). Routes: `POST /series/:id/approve` (the gate),
`POST /series/:id/advance` (nudge one step), and creating a series auto-runs the first free step.

## How stages hand off (the non-obvious part)

The `ProcessDefinitionExecutionEngine` walks the graph's nodes in order, **but it discards
each bot's reply** — `EngineServicesAdapter.runExecution` returns only `{ dispatched,
agentId }`, and every `execute-agent` node rebuilds its prompt from the *original* ticket.
So nothing a stage produces can travel *through* the graph.

The `video_series` / `video_episodes` tables **are** the hand-off. The writer writes
episodes into them; the storyboard stage reads scenes and writes frame ids; the render
stage reads both. Everything is keyed by `ticket_id`, which also makes a run **resumable** —
a retried run picks up from the last completed episode instead of re-rendering (re-rendering
is real money; re-reading a table is free).

## The stages, concretely

**WRITE** (`writeSeries`, free). Asks `screenplay-writer` to draft the series, then
**validates its output against the persona's hard rules** and rejects rather than "fixes":
- every scene has dialogue; a speaker only appears in a scene whose `camera` text names them;
- consecutive scenes use different shot types; motion lines only say what *changes*;
- lines ≤ 10 words; reactions land after the line;
- the cast's *speaker pointers* are distinct (see below).
A rejected script sets the series `failed` and never reaches an image.

**STORYBOARD** (`storyboardEpisode`, cheap). One still per scene. Scene 1 anchors the rest so
the cast holds. Frames are cropped (the image model draws a white page margin around wide
shots) and **near-duplicates are rejected** — the "one scene over and over" failure,
mechanized. Frames upload to the caller's Drive (the render node fetches by id; the LAN is
firewalled both ways). Provider chosen by `STORYBOARD_IMAGE_PROVIDER` (default `codex`).

**RENDER** (`dispatchStoryboardedEpisode`, expensive). Hands the node one episode's stills
(by Drive id) and the animation prompt per scene, over `shell.exec` — the same gated
transport `lora-train-dispatch.ts` uses for the GPU box. **One episode at a time**: the node
drives a single Chrome, and two chains against one browser re-open the same scene forever
while every retry is billed. `content.produce` cannot serve this — it splits *prose* into
beats and takes no per-scene still.

**ASSEMBLE** (`episode.assemble` on the node). Stitches the clips where they already are.
`concatClips` fails loud on a missing or truncated clip rather than shipping a short episode
as a success.

## The speaker-pointer rule

The video model is told who speaks by a **pointer** — the last words of a character's
description's first clause. `resolveSpeakerPointers` computes it, and WRITE rejects a cast
whose pointers collide.

- `Small round bean with two glow sticks` → pointer `bean` ✓
- `Small bean drummer holding two glow sticks` → pointer `sticks` — **the drumsticks talk.**

Put the character's own noun at the end of the first clause; props go after `with`;
personality after `;`.

## The image providers

`storyboard-image-providers.ts` — siblings behind `StoryboardImageProvider`, selected by
`STORYBOARD_IMAGE_PROVIDER`, ordered by cost:

| id | default | cost | auth |
|---|---|---|---|
| `codex` | **yes** | operator's own OpenAI account (`gpt-image-1` / edits) | `OPENAI_API_KEY` |
| `comfyui` | | **free** — the GPU box that runs LoRA | `COMFYUI_URL` + workflow |
| `vertex` | | **paid**, per image | Google cloud-platform scope |

Selection **fails closed**: an unconfigured provider throws with instructions rather than
falling through to one that bills. A silent fallback to a paid vendor is the bug, not the fix.

## Traps this build hit (don't re-learn them)

- **`executeBotOrInline` needs `userSub`.** The inline path records the call's cost in
  `chat_tasks`, whose RLS `WITH CHECK` matches the row against the caller. Omit it and the
  bot runs, then the cost insert is rejected and the whole call fails.
- **The persona carries *how* to write; the caller must carry the machine-readable
  *contract*.** Without the JSON shape restated in the prompt, the bot writes a good script
  in an invented shape and every field parses as `undefined`. (This is how `video-director`
  works too — the shape is in the prompt, the craft is in the persona.)
- **`ENABLE ROW LEVEL SECURITY` is not enough — you need `FORCE`.** The api applies
  migrations as `oshal_app`, which *owns* the tables, and a table's owner bypasses its own
  RLS unless forced. Without `FORCE` the policy enforces nothing. All 89 other RLS tables
  set it; these two once didn't.
- **Drive and image generation are different scopes.** A user's Google connector carries
  `drive.file`, not `cloud-platform`. Keep frame storage (Drive) and frame generation
  (provider) as separate credentials.
- **The containers run `dist/`, not `src/`.** The deploy step is `npx tsc -p
  tsconfig.server.json && npx tsc-alias -p tsconfig.server.json`, then copy the `.js`.
  Skipping `tsc-alias` leaves `@/…` aliases that crash the container with
  `Cannot find module '@/shared/logger'`.

## State (as of 2026-07-09)

**Run end to end once** — a real episode ("Spread Too Thin", Breakfast Crew) written by the
bot, storyboarded, rendered, and assembled, ffprobe-verified (16.94s, h264/aac, 0s silence).
**The conductor is now built and exhaustively unit-tested** — 17/17 transitions at zero cost:
`advanceVideoSeries` walks a series through every stage, the approval gate holds, the render is
serialized and reconciled, re-runs never re-render. Deployed live (reconciler on a 20s timer,
routes mounted + auth-gated). Still open:

1. **A live end-to-end run *through the conductor*.** The state machine is unit-tested and each
   stage (write / storyboard / render) was proven live, but a single `POST /series` → auto-write →
   approve → auto-storyboard → auto-render → done has not been run as one flow (it spends image +
   render credits, needs an explicit go). The manifest's dead `pipeline: graph` workflow was
   RETIRED 2026-07-19 (the conductor is the out-of-band path per ADR-036, and the engine's
   reply-discard is why) — `video-series` now registers as a plain manifest-worker workflow,
   guarded by `tests/unit/video-manifest-no-graph.spec.ts`.
2. **Codex — the default provider — is not runnable here yet.** `~/.codex/auth.json` is a ChatGPT
   OAuth login, and `api.openai.com/v1/images` rejects it (HTTP 401). It needs a real
   `OPENAI_API_KEY`. The one working image run used `vertex` explicitly.
3. **ComfyUI (the free path) is stubbed to throw**, not wired. Its `generate` deliberately
   fails rather than returning a placeholder. Wiring = the workflow submit + `/history` poll,
   mirroring `providers/comfyui-provider.ts`.
4. **No series intro / no season-level assembly** through the pipeline yet — `episode.assemble`
   exists but the season stitch is not wired.

See [ADR-082](../adr/082-video-series-pipeline.md) for the decision record.

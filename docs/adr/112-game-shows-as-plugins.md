# ADR-112: Game shows are plug-ins — one show-agnostic engine, games as modules

**Status:** Accepted (2026-07-21 — operator instruction: "generalize it, so Wheel of Fortune
and Whammy all follow the same suite"). Documented retroactively 2026-07-22; the code shipped first.
**Amended 2026-07-26** — all four shows shipped, plus AI contestants and a per-show presentation
layer; two Consequences below are now superseded. See [Update 2026-07-26](#update-2026-07-26--four-shows-shipped-and-what-they-cost-the-design).
**Package:** `game-show/` in the oshal-applications store repo ([ADR-085](085-remote-app-packages-and-registries.md)).
**Related:** [ADR-036](036-bot-owned-application-architecture.md) (the host bot owns the domain),
[ADR-038](038-swarms-bundled-by-type.md), [ADR-097](097-app-suites-primary-categorization.md)
(`suite: ai-creative`).

## Context

The AI Game Show app was built Family-Feud-first: an AI host generates the survey, players join
from their phones and take podiums, a generalized buzzer decides the first press server-side, a
cutaway director cues shots, and one synced state renders as five surfaces (`tv` / `stage` /
`clicker` / `host` / `audience`).

The operator's instruction after that first show worked was **generalize it** — game night is not
one game. Wheel of Fortune, Jeopardy, and Whammy must all run on the same suite. The failure mode
to design against is obvious and common: the second game gets built by copying the first app and
editing the rules, and the platform becomes N forked game apps that each have their own buzzer,
their own presence handling, and their own drift.

Almost everything a game show needs is **not** the game: rooms, seats, presence, sync, the buzzer,
the director, the interview beat, host-bot dispatch, judging round-trips, spoken-line sanitizing,
TTS. Only the rules, the board, and the prompts are the game.

## Decision

1. **A show is one module implementing the `Show` interface; the engine knows no game's rules.**
   The contract is the JSDoc typedef in `game-show/lib/shows/show-registry.js` — `initialState`,
   `reduce` (pure, server-authoritative mechanics needing no LLM), `generatePrompt` /
   `ingestGenerated` (content the host bot builds), `judgePrompt` / `applyJudgement`,
   `spokenPrompt`, `scoreboard`, plus optional `canGenerate` / `canAnswer` / `isGameOver`.
   `register()` validates the required members and throws on a partial show, so a modular author
   finds out at load time, not mid-round.

2. **Everything else is shared and untouched when a game is added.** Buzzer (`lib/buzzer.js`),
   cutaway director (`lib/director.js` — shots are data), interview beat (`lib/interview.js`),
   rooms/podiums/presence/`mutate()` (`lib/room-service.js`), host dispatch and judging
   (`lib/host-service.js`), media, and the surfaces are show-agnostic. **Adding a show never forks
   the engine.** Adding Wheel of Fortune = `lib/shows/wheel.js` + one `register()` call + a
   renderer entry.

3. **Show-specific phase names never leak into the engine.** The engine cannot know which phases
   are "mid-round", answerable, or startable for a given game — Feud blocks on `faceoff`/`play`/
   `steal`, Jeopardy blocks mid-board. Those questions are answered by the show
   (`canGenerate` / `canAnswer`) or by a per-show table on the surface, never by a hard-coded
   phase list in shared code.

4. **Each show owns its judge JSON shape and validates it.** The engine guarantees only that
   `applyJudgement` receives parsed JSON (Feud returns `{matchIndex}`, Jeopardy `{correct}`).
   A show MUST reject garbage with `{ ok:false }` — LLM output is untrusted input at this boundary.

5. **Show #2 is the proof, not the design doc.** Jeopardy was implemented specifically to force the
   engine's remaining Feud-shaped assumptions into the open, and it found two. The standing rule
   recorded in the package README: **expect show #3 to find the next one — build it, don't
   theorize.** Generality is demonstrated by a second implementation, never asserted.

## Consequences

- Game night is a platform, not an app per game. Family Feud and Jeopardy share one buzzer, one
  presence model, one host bot, one cost path — a fix to any of them fixes every show.
- The host stays an accountable bot per ADR-036 (inline host node `6a5e0000`); shows contribute
  prompts, never their own LLM calls, so cost capture and per-bot settings hold for every game.
- **Known asymmetry (accepted, not hidden):** the server side registers a show through
  `register()`; the client side registers it through four lookup tables in `ui/gs-surfaces.js`
  (`BOARDS`, `ANSWER_PHASES`, `WAGER_PHASES`, `START_PHASES`) keyed by show id. That is a
  registration point, not a fork, but it is a second place to touch. If show #3 makes the tables
  awkward, collapse them into a per-show renderer module exporting the same four members — do not
  let renderers start branching on `showId()` inside shared surface code.
  **→ SUPERSEDED 2026-07-24: the predicted collapse happened. See the Update below.**
- Presence is already a swappable per-podium video frame (camera / avatar / name), so a motion
  avatar slots in later without touching any show.
- Store-repo specs have **no CI runner** — `tests/game-show-engine.test.js`,
  `tests/jeopardy.test.js`, and `tests/host-guards.test.js` are run by hand. A new show ships its
  own spec file alongside them, and the engine specs must stay show-neutral.
  **→ SUPERSEDED 2026-07-24: `.github/workflows/store-ci.yml` runs the package suites on every
  store-repo PR (`pull_request` + `workflow_dispatch` only, per the repo's manual-CI rule).**

## Update 2026-07-26 — four shows shipped, and what they cost the design

All four shows now run on the one engine: Family Feud (+ Fast Money), Jeopardy (+ Double
Jeopardy), Wheel of Fortune, and Whammy!. The decision held — **no show forked the engine** —
but shows #3 and #4 did what #2 did, and the interface grew in the direction the ADR predicted.

**1. The client-side collapse happened, exactly as Consequence 3 anticipated.** Show #3 made the
four lookup tables awkward and they were collapsed into a per-show client registry:
`ui/gs-shows.js` exposes `GS.registerShowUi({ id, board, answerPhases, wagerPhases, startPhases,
hostKey, controls, hostExtras, canType })` and each show ships ONE `ui/gs-show-<id>.js` that
registers itself. Shared surface code no longer branches on `showId()`. A show's client half is
now symmetric with its server half.

**2. What shows #3 and #4 found (the "build it, don't theorize" rule, still earning its keep):**

- **Whammy has no judged answers at all** — its `judgePrompt`/`applyJudgement` pair is a polite
  no-op that rejects any ruling. The engine tolerating a show with an empty judge path proved the
  judge round-trip is genuinely optional, not merely parameterized.
- **The clock's same-window re-stamp was wrong.** A lapse that resolves into a state where the
  *same* window is open again (one Whammy turn, several presses) kept the dead deadline, so every
  poll re-fired the timeout and machine-gunned an AFK player's remaining presses. An expired
  same-key window now restarts; a live one still never does (`lib/clock.js`, `tests/timers.test.js`).
- **Turn-based shows needed a client-side answer gate.** `canType(seatId)` was added to the client
  registry so the generic answer box is only offered to the seat that may actually use it — Wheel's
  solve belongs to the wheel-holder with no consonant owed, Jeopardy's response to the ring-in
  winner. Without it the UI invited moves the server would refuse.

**3. The interface grew, but only optionally.** `windowFor`/`onTimeout` (the round clock),
`override` (host recovery), `localJudge` (free exact rulings), and `npcMove` (AI contestants) are
all optional members: a show implementing none of them still loads and runs, it simply forgoes the
feature. This is the shape that keeps "add a show" cheap — `register()` still validates only the
required members.

**4. A new plug-in point: AI contestants (`lib/npc.js`).** One-person game night is show-agnostic,
so the engine owns *who* is an NPC, *when* it acts, and *how* the act is applied, while the show
owns *what* the act is via optional `npcMove(state, actor, ctx)`. The division mirrors the clock
exactly (shows declare, engine actuates), including the no-scheduler doctrine: **the sync poll is
the tick**, a due move applies under the room lock, racers no-op. NPC decisions are made against
the board the server already holds, so they cost **zero LLM calls** and are deterministic under
test. The skill tier is encoded in a synthetic `npc:<skill>:<uuid>` seat subject — no schema
change, and the skill travels wherever seats already travel.

**5. A second presentation plug-in point, deliberately parallel to the first.** The broadcast
chrome (`ui/gs-play.js` — set frame, podium characters, WebAudio cues, opening titles) is
show-agnostic; each show dresses it with `ui/gs-set-<id>.css` scoped by `body[data-gs-show=<id>]`.
Adding a show is now three files and no shared-code edits: `lib/shows/<id>.js` (rules),
`ui/gs-show-<id>.js` (board renderer + registry entry), `ui/gs-set-<id>.css` (its set).

**6. The constraint every renderer must respect.** Surfaces re-render wholesale on each changed
poll (~1.4 s). Continuous animation must be ONE module-level ticker repainting existing nodes by
id; one-shot animation must key off a module-level last-seen comparison. A renderer that starts an
interval per render stacks timers until the page dies — this is a *shared* hazard, so it belongs
here rather than in any one show.

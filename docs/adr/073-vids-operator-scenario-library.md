# ADR-073 — Vids Operator scenario library: deterministic checklists over free-form exploration

- **Status:** Accepted — 2026-06-26. Phase 1 (scenario library) is on `main` (`f81a89ec`). **Phase 2
  (tool/function registry) is now built:** `recipes/vids-tools.yaml` (11 tools) + `src/tools/registry.js`
  + `src/tools/executor.js` (real-screen, focused-vision locate) + `src/tools/director.js`
  (function-calling loop) + server wiring (`mode:'tools'`, `tools:` chat, `GET /api/tools`,
  `VIDS_TOOL_MODE`). The director calls named tools; screen capture verifies between calls; it never
  re-derives clicks. **Remaining (backlog):** live-verify each tool against real Vids, panel UI, refactor
  Phase-1 scenarios to emit tool calls, suite bridges.
- **Date:** 2026-06-26
- **Related:**
  [ADR-070 (multi-provider video generation)](070-multi-provider-video-generation.md) — the *in-swarm*
  Video Studio provider layer; ADR-070 lists UI-automation of a browser video tool (Flow) as a
  **non-goal** for that path. This ADR covers the separate `@oshal/vids-operator` package (a
  computer-use bot that drives the **real Google Vids** browser UI). The two are complementary:
  ADR-070 = headless providers + free-first escalation; ADR-073 = drive-the-real-tool operator.

## Context

`@oshal/vids-operator` is a packed-Codex **computer-use** bot: it screenshots the real screen, moves the
real cursor, and clicks Google Vids (Veo) to make video. The live path is `agent.run(goal)` — a
screenshot → Codex vision → one action loop driven by a **loose, natural-language goal** plus ~12k of
`knowledge/` runbook.

Two problems surfaced in real use:

1. **Token burn.** For *every* job the agent re-derives the whole Vids click-path from a vague goal,
   up to 30 vision steps, each a Codex call. Recurring formats (daily stock picks, a new-LLM overview,
   a talking-host clip) pay full exploration cost every single run.
2. **Avatar churn.** A lot of tokens went into "training an avatar." The operator found that **"Animate
   an image"** (Veo image-to-video: one still + a motion/speech prompt → a talking host) just works, and
   reusing one still keeps the host consistent with zero re-training.

A pre-existing `RecipeEngine` + `recipes/google-vids.yaml` exist but are **dormant** — never wired into
the live agent path (they target a CDP driver; the live path is screen-based). So the deterministic
machinery was scaffolding, not in use.

## Decision

**Recurring formats run a deterministic checklist, not free-form exploration.** Introduce a **scenario
library** that pins the option selection (which rail tool, which mode, orientation, placement, captions)
and supplies a fill-in-the-blank script. The agent then executes a tight numbered checklist; it stops
re-deciding the UI, which is where the tokens went.

### The target model — a tool/function registry the director calls (Phase 2)

The end state, refined with the operator (2026-06-26): **every Google Vids operation is a named, callable
tool backed by a deterministic recipe** (the "playwright script" = the click-path). The **director LLM**
that designs the video composes it by **calling tools by name** — it never figures out how to click a
button. Screen capture stays, but its job shifts to **observing/verifying the result and choosing the
next tool**, not locating buttons.

- **Tool registry** (`recipes/vids-tools.yaml` + an executor that elevates the dormant `RecipeEngine`):
  each tool = `name`, a `description` (when to use it, so the LLM can pick it), `params`, and a
  deterministic step sequence targeting **visible label text** (self-heals via the vision fallback only
  when a label moves). Initial tools:
  `open_veo_panel`, `set_mode(create_from_scratch|animate_image)`, `upload_ingredient(image)`,
  `set_orientation`, `generate_clip(prompt)`, `wait_for_render`, `insert_clip`, `extend_clip`,
  `add_caption`, `add_text(words)` (the "box with words"), `add_shape`, `add_image(path)`,
  `add_voiceover(line)`, `add_music`.
- **Director loop:** plan → emit tool calls (function-calling) → each call runs its recipe on the real
  screen → screenshot back to the director to **verify** and decide the next call. This replaces
  "vision decides every click" with "director calls functions; vision verifies."
- **Scenarios become compositions:** a scenario (below) is just an ordered list of tool calls with
  filled params — sugar over the same registry. Both a preset and the live LLM drive the identical tools.
- **Nothing is deprecated.** The free-form vision loop remains as the fallback for operations with no
  tool yet; the cinematic Veo-prompt path stays as `generate_clip`'s prompt input; the three suite
  tools (Operator, Video Studio, LoRA) stay independent (see "Suite integration").

### Phase 1 — scenario library (built; the down payment on the above)

- **`recipes/scenarios.yaml`** — data-only library of presets. Each declares `surface`
  (`animate-image` | `veo-scratch` | `avatar`), `orientation`, `placement`, `captions`, `needsImage`,
  a `motion` description (how the still moves), and a `script` template with `{{blanks}}` + a `vars`
  map (no default = required). Initial set: `animate-image`, `stock-picks`, `llm-overview`,
  `product-spotlight`, `broll`.
- **`src/scenarios/store.js`** — loads the library, fills `{{blanks}}`, reports missing required vars,
  and parses the chat invocation `scenario:<id> key="value" image=<path>`.
- **`buildScenarioGoal()` (server.js)** — emits the ordered checklist naming the exact rail icon, mode,
  and button per step (Veo → "Animate an image" → upload still → type motion+line → orientation →
  Generate → wait for duration badge → Insert → optional Captions). No "explore the UI" language.
- **Wiring** — scenario fields flow `makeJob` → `runJob` (new `job.scenario` branch); chat intercepts
  `scenario:…`; `GET /api/scenarios` lists the catalog; `POST /api/jobs` accepts `{scenario, <blanks>,
  image}`. Raw single-clip and multi-shot `plan` paths are unchanged.

**"Animate an image" is the default talking-host path.** One reused still + a per-video script line is
the proven, cheap way to make a host; the scenario presets bake it in so the operator never re-trains an
avatar.

**Scenarios are data, not code.** New formats are added by editing `recipes/scenarios.yaml`. Phase 2
elevates the dormant `RecipeEngine` into the tool executor (driving the real screen, not the old CDP
path), so tools and scenarios share one deterministic engine.

### Suite integration — three tools, one suite (no coupling forced)

The Vids Operator (this ADR, #3), the in-swarm **Video Studio** (ADR-070, #1), and **LoRA Studio**
(ADR-071, #2) are three distinct tools in one video suite. They stay independent; bridges are added as
*tools*, not hard couplings:

- **LoRA → Operator:** a LoRA-rendered consistent character image becomes the `upload_ingredient` still
  that `animate_image` drives — the consistent LoRA face on the cheap animate-an-image path (no avatar
  re-training, full character control).
- **Studio → Operator:** Video Studio can hand a generated/edited clip to the Operator for Vids-native
  finishing (captions/text/music) through the same tool registry.

## Consequences

- **The director stops paying to re-derive the UI.** With a tool registry, designing a video is
  function calls (`add_caption`, `add_shape`, `generate_clip`) — the LLM reasons about *the video*, not
  about *where the button is*. Vision is spent on verification, where it's actually needed.
- Recurring formats (scenarios) become a one-line invocation that runs fixed tool calls — far fewer
  vision steps per job, so far fewer tokens. `knowledge/vids-ui-runbook.md` documents the
  "Animate an image" path so even the vision fallback is faster.
- **Adding a capability = adding a tool (YAML), not code; adding a format = composing tools.**
- The operator keeps a single avatar still (or a LoRA-rendered face) as the consistent host; no avatar
  training loop required for the cheap path.
- **Honest limit:** tools target visible labels as observed. If Google renames one, the vision fallback
  re-resolves it and the engine records the new label — tools make the happy path cheap, they are not
  brittle macros.

## Status of the build — DONE vs BACKLOG

**Done (Phase 1, uncommitted on working tree as of 2026-06-26):**
- `recipes/scenarios.yaml` (5 presets), `src/scenarios/store.js` (load/fill/parse/resolve).
- `buildScenarioGoal()` + `job.scenario` branch in `src/server.js`.
- Chat trigger, `GET /api/scenarios`, scenario-aware `POST /api/jobs`.
- Runbook "Animate an image" section + README "Scenarios" section.
- Verified: modules load; parser preserves Windows backslash paths; checklist text correct for
  animate-image and veo-scratch.

**Done (Phase 2, 2026-06-26):**
- `recipes/vids-tools.yaml` — 11 tools (`generate_clip`, `animate_image`, `insert_clip`, `extend_clip`,
  `add_caption`, `add_text`, `add_shape`, `add_image`, `add_voiceover`, `add_music`, `set_orientation`),
  each with a when-to-use `description`, `params`, and deterministic `steps`.
- `src/tools/registry.js` — load/catalog/`catalogText`/`resolveSteps` (param interpolation).
- `src/tools/executor.js` — runs a tool's steps on the **real screen**; `locate()` is a single focused
  vision call ("where is THIS control?"), `wait_render` polls for the finished-clip card; one
  verification screenshot per tool. Honors pause/abort.
- `src/tools/director.js` — `ToolDirector` (same run/pause/resume/abort surface as `ComputerUseAgent`):
  screenshot → Codex picks the next **tool call** from the catalog → executor runs it → next screenshot
  verifies. Stops on `blocked`/`done`/unknown-tool/cap.
- Server wiring — `mode:'tools'` per job, `tools: <goal>` chat trigger, `scenario:… mode=tools`,
  `VIDS_TOOL_MODE=1` global opt-in, `GET /api/tools`, `buildToolsGoal()`. Pixel agent stays the default
  and the `plan` (multi-shot) path is unchanged. Verified: all modules `node --check` + load; catalog,
  step-fill, and goal-builder produce correct output.

**Remaining (backlog):**
1. **Live verification** — drive each tool against real Google Vids; confirm `locate` resolves the
   labels (`Animate an image`, `Captions`, `Text`, `Shape`…) and tune prompts/timeouts; record wins.
2. **Locate caching** — cache resolved coords per control to cut repeat vision calls on a stable panel.
3. **Panel UI** — scenario `<select>` + a tool-mode toggle in the Vite surface (`web/src/App.jsx`);
   rebuild `web/dist`; mirror to legacy `src/ui/index.html`.
4. **Scenarios as tool compositions** — have Phase-1 presets emit explicit tool-call sequences instead
   of a prose goal, so presets and the live director share one execution path.
5. **Suite bridges** — `animate_image` consumes a LoRA-rendered still (LoRA → Operator); accept a
   Video-Studio clip for Vids-native finishing (Studio → Operator).

**Done condition:** the director builds a multi-element video (clip + caption + a text/shape box +
music) by **calling named tools** — not by figuring out clicks — using screen capture only to verify,
proven live against real Vids; and a recurring format costs materially fewer tokens than the free-form
path.

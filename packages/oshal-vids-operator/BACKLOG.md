# Vids Operator — backlog (pickup doc)

Working notes for finishing the **tool/function registry** work (ADR-073). Read
this first when you sit back down. Decision/rationale lives in
[`docs/adr/073-vids-operator-scenario-library.md`](../../docs/adr/073-vids-operator-scenario-library.md);
this is the actionable to-do.

## Where we are (2026-06-26)

Built + on `main`:

- **Phase 1 — scenario library** (`f81a89ec`): canned presets + fill-in-the-blank
  scripts. `recipes/scenarios.yaml`, `src/scenarios/store.js`, `buildScenarioGoal()`.
- **Phase 2 — tool registry + director** (`56141d38`): the director calls named
  tools instead of deciding pixels. `recipes/vids-tools.yaml` (11 tools),
  `src/tools/{registry,executor,director}.js`, server wiring (`mode:'tools'`,
  `tools:` chat trigger, `VIDS_TOOL_MODE=1`, `GET /api/tools`).

**Not done:** none of the tool path has been driven against the real Google Vids
UI yet. It loads and the logic is verified; the live behavior (label matching,
timing) is unproven. That's task 1.

How the modes relate:
- **Pixel agent** (`src/agent/loop.js`) — default; decides every click via vision.
- **Tool director** (`src/tools/director.js`) — opt-in; calls tools, vision only
  resolves one control at a time + verifies. This is the token-saver.

## Tasks (in priority order)

### 1. Live-verify the tool director against real Vids  — P0, needs your screen
The whole thing is untested live. Sit at the machine with Google Vids open and run
the simplest path first.

- Run: `node bin/oshal-vids.js`, enable screen control, then in chat:
  `tools: animate the still C:\avatars\host.png saying "testing one two three", portrait`
- Watch the step log: each `call <tool>` then its `tool-step`s. Note where
  `locate()` returns the wrong control or "could not find".
- **Fix loop:** the fix for a bad match is almost always editing the `find:`
  description (or tool `description`) in `recipes/vids-tools.yaml` — data, no code.
- Confirm the panel labels in `knowledge/vids-ui-runbook.md` still match the live
  UI (rail icon names, "Animate an image", "Captions", "Generate").
- **Done when:** a single `animate_image → insert_clip → add_caption` sequence
  completes on real Vids and lands a captioned clip on the timeline.
- **Gotchas:** mixed-DPI monitors (see the DPI fix history); `VIDS_MONITOR=<idx>`
  to target the right screen; the file picker in `upload` steps wants the **full
  absolute path** typed then Enter — verify the dialog actually accepts it.

### 2. Tune locate() reliability  — P0, rolls out of task 1
`src/tools/executor.js → locate()` is one focused vision call. Make it robust:
- Adjust `VIDS_LOCATE_MIN_CONFIDENCE` (default 0.55) if it skips real controls or
  clicks wrong ones.
- Adjust `VIDS_RENDER_TIMEOUT_MS` (default 240s) / `VIDS_LOCATE_TIMEOUT_MS` (45s).
- If a control is consistently missed, make its `find:` text more visual
  ("the blue Generate button at the bottom of the panel") — the model sees pixels.
- **Done when:** each of the 11 tools resolves its controls ≥ ~9/10 on a stable panel.

### 3. Locate caching  — P1, the real token win
Right now every control click costs a vision call. On a stable panel the same
control is in the same place. Cache it.
- Cache resolved coords keyed by `find:` text (per session, optionally persisted to
  the learn store `~/.oshal-vids/healed-selectors.json` — see `src/learn/store.js`).
- On hit, **still take a cheap verify screenshot** before clicking (don't blind-click
  a stale coord); only call vision again if the verify fails.
- **Done when:** a repeat run of the same scenario makes materially fewer vision
  calls than the first (measure via the transcript in `~/.oshal-vids/runs/<id>/`).

### 4. Panel UI — scenario picker + tool-mode toggle  — P1
The active surface (`web/src/App.jsx`) is chat-only. Make scenarios + tool mode
clickable.
- Add a scenario `<select>` (populate from `GET /api/scenarios`) + the blank fields
  for the chosen scenario, and a "tool mode" checkbox that sets `mode:'tools'` on
  the `POST /api/jobs` body. A `GET /api/tools` list can show what the director can do.
- Rebuild: `cd web && npm install && npm run build` (server serves `web/dist`).
- Mirror the same controls into the legacy fallback `src/ui/index.html`.
- **Done when:** you can pick "stock-picks", fill the blanks, tick tool-mode, and
  queue — no typing the `scenario:` string.

### 5. Scenarios as tool compositions  — P2
Today a scenario builds a prose goal (`buildToolsGoal`) and the director re-derives
the tool sequence. Tighten it: let a scenario declare an explicit ordered tool-call
list, so presets and the live director share one execution path.
- Add an optional `calls:` array to a `recipes/scenarios.yaml` entry (e.g.
  `[{tool: animate_image, params: {...}}, {tool: insert_clip}, {tool: add_caption}]`).
- When present, run the executor directly over those calls (skip the director's
  planning entirely — fully deterministic, cheapest path).
- **Done when:** `scenario:stock-picks mode=tools` runs a fixed tool sequence with
  zero planning calls.

### 6. Suite bridges — LoRA + Video Studio  — P2
Make the three tools cooperate (ADR-073 "Suite integration"); keep them independent.
- **LoRA → Operator:** accept a LoRA-rendered character image as the `animate_image`
  still, so you get the consistent LoRA face on the cheap animate path.
- **Studio → Operator:** accept a Video-Studio-produced clip and run Vids-native
  finishing tools (`add_caption`, `add_text`, `add_music`) over it.
- **Done when:** a LoRA-rendered still drives a talking-host clip end to end.

### 7. Token before/after measurement  — P3
Prove the win. Run the same talking-host job through the pixel agent vs the tool
director; compare vision-call count / tokens from the run transcripts. Record the
delta in the ADR.

## How to run / test (no live UI needed)

```bash
cd packages/oshal-vids-operator
node --check src/tools/registry.js src/tools/executor.js src/tools/director.js src/server.js
node -e 'const R=require("./src/tools/registry"); console.log(R.catalogText())'
node -e 'require("./src/server"); console.log("loads")'
```

Live run: `node bin/oshal-vids.js` → http://localhost:8074 → enable screen control
→ `tools: <describe the video>`.

## Env knobs

| Var | Default | Use |
| --- | --- | --- |
| `VIDS_TOOL_MODE` | unset | `1` routes all single-clip vids jobs through the director |
| `VIDS_LOCATE_MIN_CONFIDENCE` | `0.55` | raise to avoid wrong clicks, lower if it skips real controls |
| `VIDS_LOCATE_TIMEOUT_MS` | `45000` | per locate/verify vision call |
| `VIDS_RENDER_TIMEOUT_MS` | `240000` | how long `wait_render` polls for the finished clip |
| `VIDS_MONITOR` | primary/foreground | index of the monitor Vids is on |

## Creative Studio / Extend-story (ADR-080) — LIVE-VERIFIED 2026-07-07

`oshal-vids story --id tortoise-and-hare` ran end-to-end on the render node
(render-node-1 / localhost): 10 scenes, **9/9 transitions via the real Extend
button**, stitched 1:20 / 31.7MB 720p MP4 in `content\fables\` + manifest. Lessons
now baked into `src/agent/story-extend.js`:

- **Grab renders by NEW `src`, never element index** — the Veo panel keeps prior
  `Generated video` elements in the DOM; an index grab re-downloads scene 1 forever.
- **Bloated debug Chrome stalls `connectOverCDP`** (hundreds of contexts + a hung
  target) while /json/version + raw ws still work. Recovery: restart ONLY the
  `oshal-video-chrome` profile chrome processes.
- Extend mode = card's exact-name "Extend" button → panel header "Extend" + a
  "describe what should happen next" box → type + Generate. Each extend yields a
  NEW element with a NEW src. Don't click "Insert" (loose match hits the
  "Insertion" rail menu; the timeline is cosmetic — the product is the local MP4).
- Node needs only Node.js + Chrome + the signed-in profile; stage `src/` +
  `recipes/content/` + npm deps (playwright/js-yaml/ffmpeg-static, `OSHAL_FFMPEG`).

Remaining:
1. **Drive delivery — MOSTLY DONE 2026-07-07.** `drive.file` is now in the Google
   connector's default scopes; the owner re-consented; and the v2 story uploaded
   via the **Drive API** (`storage/drive.js` resumable path) using a broker-minted
   access token — the clean path, replacing the flaky browser-session uploads
   (native file-chooser dialogs blocked the signed-in Chrome repeatedly; LAN pull
   is firewalled both directions — don't retry either).
   **Left to wire:** ongoing token hand-off for the UNATTENDED cycler — the node
   needs a fresh access token per story. Pattern proven manually: in-container
   `getValidAccessToken(pool, sub, 'google', { email })` — MUST set the RLS GUCs
   first (`set_config('oshal.current_sub', sub)` + `oshal.is_operator`, single-
   session pool) or the row is invisible. Build a small service-secret-gated
   token hand-off (or scheduled token push to the node) as a deliberate,
   security-reviewed change — treat like the token broker.
2. **Cycle soak — P1.** `oshal-vids cycle --every 30m --limit 3` on the node to
   prove the unattended loop (same produceStory call the live run proved).
3. **Per-scene narration voiceover — P2.** Each beat carries `narration`; add a Vids
   voiceover / TTS track per scene. See `add_voiceover` in `recipes/vids-tools.yaml`.
4. **Continuity drift tuning — LARGELY DONE in v2/v3** (pinned setting + character
   bible restated per beat fixed the winter drift + hare recolor; v3 adds crayon
   style + voice-over/no-lip-sync + no-quotes rules).
5. **v4a: I2V storyboard mode — BUILT + LIVE-PROVEN 2026-07-06, NOW THE DEFAULT.**
   A/B on tortoise-and-hare settled it: the Extend chain drifted characters even
   with the full text bible (v3: hare morphed, tortoise went yellow/bipedal); the
   hero-frame anchor held the SAME hare + SAME tortoise + SAME world across all
   10 scenes. Mechanics: scene 1 from scratch (wide shot, ALL characters) →
   ffmpeg `extractFrame` mid-clip → every later scene is a FRESH PROJECT TAB
   (the veo-clip.js flow — the reused panel's mode/upload state machine is
   unreliable: rail icon toggles, silent mode-switch failures) running "Animate
   an image" from that SAME frame + MOTION-ONLY prompts (never re-describe over
   an image anchor). Straight-cut stitch, no trims. `produceStory` defaults to
   storyboard; pass mode:'extend' for the chain.
   STYLE STABILITY (Gemini's ranking, keep for pack design): flat-2D cutout
   (South Park-like, solid blocks + bold outlines) = MOST stable; claymation/
   low-poly = high; photorealism = low; STICK FIGURES = WORST (thin lines give
   the model nothing to anchor — never use). Crayon (current) ≈ near flat-2D and
   verified twice live; escalate to explicit flat-2D cutout only if needed.
   OPEN: audio verification by EAR (do the voice-over/mouths-closed rules hold in
   the rendered audio? stills can't tell); v4b per-scene storyboard stills via the
   Gemini image API (varied compositions, hero as reference — needs GEMINI_API_KEY).

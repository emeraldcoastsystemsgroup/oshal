# ADR-080 — Creative Studio: Extend-story pipeline + a self-cycling content library

- **Status:** Accepted — **LIVE-VERIFIED 2026-07-07** on the render node
  (render-node-1, localhost): `oshal-vids story --id tortoise-and-hare`
  produced a 10-scene continuous story — **9/9 transitions used the real Extend
  button** — downloaded per-scene via src-fetch, stitched to one 1:20 / 31.7MB
  720p MP4, and saved to the content folder with its manifest (`drivePending:
  true`, honest — no Drive token on the node yet). Two live-found bugs fixed the
  same session: the bloated-Chrome `connectOverCDP` stall (restart the dedicated
  video profile) and the duplicate-scene grab (renders must be identified by NEW
  `src`, never element index — the panel keeps prior renders in the DOM).
- **Date:** 2026-07-07
- **Related:**
  [ADR-073 (Vids Operator scenario library)](073-vids-operator-scenario-library.md) — the
  `@oshal/vids-operator` package + tool registry this builds on.
  [ADR-074 (Daily trade recap pipeline)](074-daily-trade-recap-pipeline.md) — the remote-node
  dispatch + `vids_jobs` + generic `workflow:<ticketType>` scheduler this reuses.
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md) —
  the bot owns its content domain; the surface is a view.
  [ADR-041 (per-user storage targets)](041-per-user-storage-targets.md) — where generated
  content lands.

## Context

The daily-trade-recap (ADR-074) proved the remote node can drive Google Vids to
produce a real, downloaded MP4. Two things were still missing to make the node a
general **creative content engine**, and both came directly from operator intent
("start creating stories through the Extend button… a creative bot that just
cycles and pushes these vids, downloads them, saves them to my content folder"):

1. **Story via Extend.** Recurring formats and the recap Insert clips as separate
   cuts. A *story* wants one **continuous** video — a ~100-word tale animated
   across ~10 scenes where each shot continues the last (character + style
   continuity). That is exactly what Vids' **Extend** does (it conditions the next
   Veo generation on the previous clip's final frame), and there was no path for it.
2. **Reliable download to configured storage + a cycling loop.** The generic
   generate path leaves the clip on the Vids timeline; only the bespoke recap SOP
   downloaded anything. There was no "save the finished story to my content folder
   / Drive," and nothing that just keeps making content on its own.

A constraint shaped the design: the **full Vids project export stalls** ("Preparing
download" never lands, discovered in `scripts/veo-clip.js`). The only download
proven against live Vids is **fetching each rendered clip's `<video>` src** through
the browser's auth'd request context. So a story cannot be exported as one file
from Vids — it must be assembled locally from per-scene clips.

## Decision

### 1. Extend-story runner on the proven CDP spine (built)

`src/agent/story-extend.js` (`StoryExtendRunner`) drives Vids over CDP reusing the
mechanisms proven in `scripts/veo-clip.js` (Veo card, Mode combobox, hidden file
input, the `video[aria-label^="Generated video"]` render signal, and the reliable
**src-fetch** download). For each beat it generates a Veo clip; from beat 2 it
**prefers the Extend affordance** so Veo continues the previous frame, and **falls
back to a fresh create-from-scratch generation** when Extend isn't present
(continuity then carried by the prompt). Every scene clip is src-fetched to a local
stage dir; `src/media/assemble.js` normalizes + **ffmpeg-concats** them into one
story MP4 (same `imageio_ffmpeg` mechanism as the recap assemble).

This makes the **generate + src-fetch + concat spine the reliable guarantee** (it
always yields a downloadable video) and **Extend a continuity enhancement layered
on top** — never a hard dependency on an unproven click-path or the stalling export.

### 2. A kid-safe, public-domain content library (built, data-only)

`recipes/content/*.yaml` — three packs, 24 stories: **Aesop fables**, **classic
fairytales** (softened for kids — no one is eaten/harmed), and **famous
sayings/idioms** ("it's raining cats and dogs" as a literal-vs-figurative gag).
Each entry is a title + ~100-word narration `script` + a per-pack art style. Adding
content is a new pack file — **no code**. `src/content/library.js` loads all packs
and `pickNext()` **rotates across packs** so the feed stays varied.
`src/stories/script.js` (`buildStoryScript`) splits a script into ~10 continuous
beats and composes each Veo scene prompt (style injected, "continue seamlessly from
the previous shot," and **no on-screen text/logos** because Veo renders words badly).

### 3. Storage: local content folder + Google Drive (built; Drive gated on a token)

`src/storage/store.js` always writes the finished MP4 to the **local content
folder** (`VIDS_CONTENT_DIR`, organised by pack, with a sidecar `.json` manifest —
the source of truth and the "produced" ledger the cycler reads), then best-effort
uploads to **Google Drive** via `src/storage/drive.js` (resumable upload). Drive
token resolution is independent of the gmail-only connector: `VIDS_DRIVE_ACCESS_TOKEN`
or a refresh-token creds file. When no Drive token is configured, the copy stays
local and the result reports `drivePending: true` — **never a fabricated upload**.

### 4. The creative bot that cycles (built, two transports)

- **Node-local:** `oshal-vids cycle [--every 30m] [--limit N] [--loop]` — the
  literal "just cycles" loop: pick the next unproduced story → Extend-animate →
  download → save → pace → repeat. Zero swarm round-trip; runs where Chrome is.
- **Swarm:** `swarm-apps/creative-studio.yaml` (ticketType `creative-story`, the
  `vids-operator` bot) with `creative_produce_next` / `creative_produce` /
  `creative_list` tools that dispatch `content.next` / `content.produce` to the
  registered remote worker via the new `POST /api/vids/story` (mirrors `/jobs`).
  A recurring cron is the ADR-074 generic `workflow:creative-story` schedule.

### 5. Hardened the "soft API" (built)

`src/worker/remote-client.js` — the remote-node worker's poll/heartbeat loop now
**retries with capped exponential backoff** and **auto re-registers when the control
plane forgets it** (401/403/404, e.g. after a server restart — the old loop spun
silently forever), and **best-effort deregisters on shutdown**. New `content.*`
tools registered.

## Consequences

- The node is now a general **creative content engine**, not just a trade-recap
  tool. A new content theme = a new `recipes/content/*.yaml` pack; a new format =
  compose the same runner. The whole thing is BYOK on the node's signed-in Chrome.
- Download is decoupled from the unreliable Vids export: **per-scene src-fetch +
  local concat** is the reliable path; Extend is best-effort continuity on top.
- Storage degrades honestly: always-local + Drive-when-a-token-exists, with
  `drivePending` surfaced rather than faked.
- The hardened worker no longer silently strands itself after a control-plane blip.

## Status of the build — DONE vs DEFERRED

**Done (this ADR, on `main`):** content library (24 stories) + loader + rotation;
StoryScript builder; `StoryExtendRunner`; `assemble.js` (ffmpeg concat,
end-to-end tested with mismatched inputs); `drive.js` + `store.js` + produced
ledger; `produceStory` orchestrator; `oshal-vids story` + `oshal-vids cycle` CLIs;
hardened worker + `content.*` tools; `POST /api/vids/story`; `creative-studio.yaml`;
persona wiring. `npx tsc --noEmit` clean.

**Done (live-verified 2026-07-07, remote node):** the Extend click-path — the panel
switches to an "Extend" header with a "describe what should happen next" box; the
runner chained 9/9 transitions with real visual continuity (screenshot-verified
mid-run: scene 4's sleeping-hare frame carried into scene 5's prompt). Confirmed:
each Extend generation yields a NEW `Generated video` element with a NEW src.
Node staging pattern proven: ship `src/` + `recipes/content/` + deps
(playwright / js-yaml / ffmpeg-static with `OSHAL_FFMPEG`) to the render node; the
node needs only Node.js + Chrome + the signed-in `oshal-video-chrome` profile.

**Deferred:**
1. **Drive scope.** The clean per-user path is adding `drive.file` scope to the
   OSHAL Google connector and brokering the token (partner-app re-consent under the
   business email). Until then, use `VIDS_DRIVE_ACCESS_TOKEN` / a creds file on the
   node, or accept local-only with `drivePending` (the live run's state).
2. **Optional narration voiceover.** Each beat carries its `narration`; adding a
   Vids voiceover / TTS track per scene is a follow-up (kept out of v1).
3. **Unattended cycle soak.** One story is proven end-to-end; `oshal-vids cycle`
   uses the identical `produceStory` call — run a paced multi-story soak
   (`--every 30m --limit 3`) to prove the loop unattended.

**Done condition:** ~~a 100-word story animates across ~10 continuous scenes on real
Vids, downloads as one MP4, and lands in the content folder~~ **MET 2026-07-07**
(+ Drive once a token is configured); and the cycler produces the rotating library
unattended (soak pending).

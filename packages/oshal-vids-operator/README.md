# @oshal/vids-operator

A packed-Codex **computer-use** bot that **operates your real computer** to make
video. You give it an idea — typed or spoken — and it screenshots your screen,
moves your real cursor, and clicks the real buttons to generate a clip in Google
Vids (Veo). There's no Veo API; it just uses the tool the way you would, while you
take your hands off the keyboard and watch.

It is:

1. **A screen-control agent** — sees your screen, decides one action at a time
   (move/click/type), and does it on your actual desktop. Not a fixed script; it
   figures out the app from what's on screen, so it works on Vids or anything else.
2. **A Veo specialist** — sharpens your idea into a strong Veo prompt before it
   operates (prompt-craft + UI runbooks in `knowledge/`), and learns from its runs.
3. **A swarm worker** — deploy to another PC and let the OSHAL swarm/cockpit queue
   background generate-jobs to it.

## How it works

```
your idea ──▶ Codex sharpens it into a Veo prompt
                    │
   ┌────────────────▼────────────────────┐
   │  loop:                               │
   │   screenshot the REAL screen (PS)    │
   │   Codex vision picks ONE next action │
   │   move/click/type on the real desktop│
   │   repeat until the goal is done      │
   └──────────────────────────────────────┘
```

Real screen control is pure PowerShell/.NET (`src/desktop/win.js`) — no native
deps. The agent loop (`src/agent/loop.js`) sends each screenshot to `codex exec -i`
and gets back the next action as normalized coordinates.

## Quick start

```bash
# one-time: build the surface
cd web && npm install && npm run build && cd ..

node bin/oshal-vids.js              # → http://localhost:8074
```

In the surface: click **Enable screen control**, then **type or speak** a command
(e.g. "make an 8-second clip explaining photosynthesis"). The left pane mirrors
your real screen; the step log narrates each action. **Pause / Abort** stop it
instantly — keep your hands off the mouse while it works.

- **Voice** uses the browser's built-in Speech Recognition (Chrome) — no key.
- **Surface dev** (hot reload): `cd web && npm run dev` (proxies to the backend).
- The built surface is served from `web/dist`; if it isn't built, the server falls
  back to the legacy single-file panel in `src/ui/`.

## Scenarios (canned checklists — stop burning tokens)

For repeat formats (daily stock picks, a new-LLM overview, a talking-host clip),
don't make the agent re-derive the Vids click-path every run. A **scenario** in
`recipes/scenarios.yaml` pins the option selection (which rail tool, mode,
orientation, placement, captions) and a fill-in-the-blank script, so the agent
runs a fixed checklist instead of exploring.

Invoke from the command bar (chat):

```
scenario:stock-picks date="June 26" picks="AAPL on a strong cycle; NVDA on data-center demand" image=C:\avatars\host.png
scenario:llm-overview model="Opus 4.8" capability="best-in-class coding" benefit="ships features faster" useCase="agentic dev" image=C:\avatars\host.png
scenario:animate-image line="Welcome back — let's get into it." image=C:\avatars\host.png
```

Quoted values may contain spaces; `image=` is the still to animate. Missing
required blanks come back as a one-line "needs: …" reply. List them at
`GET /api/scenarios`; the panel can also POST `{scenario, <blanks>, image}` to
`/api/jobs`. Reuse ONE avatar still so the host stays consistent — no avatar
re-training. Add scenarios by editing `recipes/scenarios.yaml` (data only).

## Tool director (Phase 2 — the LLM calls tools, not pixels)

Instead of the agent deciding every mouse click, the **director** composes a video by **calling named
tools** from a registry (`recipes/vids-tools.yaml`): `generate_clip`, `animate_image`, `insert_clip`,
`add_caption`, `add_text` (the box of words), `add_shape`, `add_image`, `add_voiceover`, `add_music`,
`set_orientation`. Each tool owns its deterministic click-path; a single **focused vision lookup**
resolves each control ("where is the Captions icon?"), and a screenshot after each tool lets the
director **verify** before the next call. The LLM reasons about the *video*, not the *buttons*.

Turn it on:

```
tools: make a 30s talking-host clip from C:\avatars\host.png saying "markets are up", portrait, with captions
```

- Per job: `POST /api/jobs {prompt, mode:"tools"}`; scenarios: `scenario:stock-picks … mode=tools`.
- Globally: `VIDS_TOOL_MODE=1` routes all single-clip vids jobs through the director.
- `GET /api/tools` lists the catalog. Add a capability by editing `recipes/vids-tools.yaml` (data only).
- The pixel agent (above) stays the default and the fallback for operations with no tool yet.

## Creative Studio — stories, Extend, and the self-cycling library (ADR-080)

Animate a short story across ~10 **continuous** scenes using Vids' **Extend** button,
download it, and save it to your content folder + Google Drive. Content comes from a
kid-safe, public-domain library (`recipes/content/*.yaml`): Aesop **fables**, classic
**fairytales** (softened), and famous **sayings/idioms** ("it's raining cats and dogs").

```bash
# one story from the library (needs the debug Chrome signed into Vids on :9222)
node bin/oshal-vids.js story --id tortoise-and-hare        # or raining-cats-and-dogs, the-three-little-pigs…
node bin/oshal-vids.js story --next                        # the next unproduced story
node bin/oshal-vids.js story --script mytale.txt --title "My Tale"   # your own ~100-word story
node bin/oshal-vids.js story --list                        # what's already produced

# the creative bot that JUST CYCLES — pick next → Extend-animate → download → save → repeat
node bin/oshal-vids.js cycle --every 30m                   # pace 30 min between stories
node bin/oshal-vids.js cycle --limit 3                     # stop after 3 this run
```

How a story is built: `buildStoryScript` splits the ~100-word narration into ~10 beats,
each a Veo scene prompt ("continue seamlessly from the previous shot," no on-screen text).
`StoryExtendRunner` generates scene 1, then **prefers Extend** for each next scene (Veo
conditions on the previous frame → character/style continuity), **src-fetches** each clip
(the full project export stalls), and **ffmpeg-concats** them into one MP4. Storage always
writes a local copy (`VIDS_CONTENT_DIR`, organised by pack, with a `.json` manifest) and
best-effort uploads to Drive; with no Drive token it reports `drivePending` — never faked.

**Drive:** set `VIDS_DRIVE_ACCESS_TOKEN`, or drop `{client_id, client_secret, refresh_token}`
at `~/.oshal-vids/drive-creds.json`, and optionally `VIDS_DRIVE_FOLDER_ID`. Until then,
videos land locally only. The clean path is `drive.file` scope on the OSHAL Google connector.

Swarm side: `swarm-apps/creative-studio.yaml` (ticketType `creative-story`) dispatches
`content.next`/`content.produce` to this worker via `POST /api/vids/story`; cron it with an
ADR-074 `workflow:creative-story` schedule (e.g. `0 */6 * * *`).

## Layout

| Path | What |
| --- | --- |
| `bin/oshal-vids.js` | entry (`panel` / `worker` / `setup`) |
| **`src/desktop/win.js`** | **real screen control: screenshot + cursor/click/type (PowerShell, 0 deps)** |
| **`src/agent/loop.js`** | **computer-use loop: screenshot → Codex vision → action → repeat** |
| `src/server.js` | surface server + job queue + agent lifecycle |
| **`web/`** | **Vite + React surface (live screen, type/voice command bar, history)** |
| `src/bot/operator.js` | Veo prompt-craft advisor + chat router |
| `knowledge/` | preloaded prompt-craft + UI runbooks |
| `src/learn/store.js` | learning store (runs, ratings, examples) |
| `src/worker/remote-client.js` | OSHAL swarm worker (background jobs) |
| `src/driver/`, `src/recipes/` | legacy CDP/recipe driver — superseded by the agent |
| `src/ui/index.html` | legacy single-file panel (fallback when `web/dist` absent) |
| **`recipes/vids-tools.yaml`, `src/tools/`** | **tool registry + director (Phase 2): named tools the LLM calls** |
| **`BACKLOG.md`** | **pickup doc — what's left + how to verify (read this to resume)** |

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `VIDS_PORT` | `8074` | control-panel port |
| `VIDS_CDP_URL` | `http://localhost:9222` | the debug Chrome to attach to |
| `VIDS_CDP_PORT` | `9222` | port `chrome` launches with |
| `VIDS_CHROME_PROFILE` | `~/.oshal-vids-chrome` | dedicated Chrome profile dir |
| `VIDS_CHROME_PATH` | autodetect | override the Chrome executable |
| `CODEX_CLI_PATH` | autodetect | path to the Codex CLI / `bin/codex.js` the bot uses |
| `VIDS_CODEX_SERVICE_TIER` | unset | override Codex `service_tier` (e.g. `fast`) when a global `config.toml` value is rejected |
| `VIDS_DATA_DIR` | `~/.oshal-vids` | where the learning store (runs, healed selectors, examples) lives |
| `VIDS_EXAMPLES_URL` | unset | optional URL of an external Veo-prompt example gallery (JSON) to ground on |
| `VIDS_SWARM_URL` | unset | OSHAL control-plane base URL for `worker` mode *(P4)* |
| `VIDS_SWARM_SECRET` | unset | shared secret for remote-client auth *(P4)* |

## Honesty

Never claims a clip exists until the DOM confirms the render; surfaces real errors
rather than faking a result; paces generation to respect Google's ToS/limits.

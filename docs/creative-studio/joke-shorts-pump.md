# The joke-shorts pump — how to run it

The [video-series conductor](./video-series-pipeline.md) turns a premise into a finished MP4. The pump
is what asks it to, on a schedule, without a human typing a premise each time. Architecture and the
reasoning behind the safety model: [ADR-120](../adr/120-joke-shorts-pump.md).

This is the operator's page: how to switch it on, what each switch means, and how to read it when it
produces nothing.

## The shape

```
every VIDEO_PUMP_INTERVAL_MS (default 20 min)
  │
  ├─ reconcile what finished on the node
  ├─ pick the show that has waited longest and is under its daily cap
  ├─ IS THE NODE FREE?  ── no ──►  record the reason, stop.  ◄── this is most cycles
  │        yes
  ├─ open a real ticket + a video_series row (one episode, four scenes)
  ├─ WRITE the script          (an LLM call — free of render credits)
  ├─ standing authorization?  ── no ──►  park with the scripts ready.
  │        yes
  └─ approve → storyboard → render on the node → assemble → Drive
```

One episode per cycle. Never two chains against the one signed-in Chrome.

## Switching it on

Three switches, all off by default, and they are not the same switch.

**1. The scheduler** — in `.env` on the controller:

```bash
VIDEO_PUMP_ENABLED=true          # off unless this is exactly "true"
VIDEO_PUMP_INTERVAL_MS=1200000   # 20 minutes
```

Without it the pump never runs on its own; the **Run one cycle now** button still works.

**2. The shows** — Video Studio → *The joke pump* → **Import the show library**, then tick **On** for
the shows you want in the rotation. An enrolled show gets *written*, which costs an LLM call and no
render credits.

**3. Auto-approve renders** — this one spends money. It is you standing in for the approval gate, for
that show only, bounded by **Max/day**. Leave it off and the pump writes scripts and parks them for
you to approve by hand; turn it on and that show produces on its own.

Start with one show, `Max/day = 1`, and read the cycle list the next morning.

## Reading a cycle that produced nothing

Most cycles produce nothing, and that is correct. The list shows why:

| what it says | what it means | what to do |
|---|---|---|
| `blackout` | inside the window the nightly recap owns (default 16:45–19:45 CT) | nothing — it will run later |
| `recap-running` | the recap's agent is alive on the node right now | nothing |
| `render-in-flight` | an episode is already rendering | nothing |
| `worker-busy` | the node has another task claimed or queued | nothing |
| `no-browser` | the signed-in Vids Chrome is not running | start it (below) |
| `probe-failed` | the node did not answer in two minutes | check the node is online and not wedged |
| `low-memory` | commit charge ≥ 92%, or under 512MB available | prune stray Chrome (below) |
| `chrome-storm` | more than 40 chrome.exe processes | same |
| `no-worker` | no render node is connected at all | start `oshal-chat` on the node |

Start the signed-in browser on the node:

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\Users\gabec\oshal-video-chrome
```

The Google session persists on disk — it survived a two-week gap — so this needs no human sign-in.

Prune stray Chrome **without killing the automation profile**:

```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -notmatch 'oshal-video-chrome' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## When a show pauses itself

Three consecutive failures pause a show and put the reason on its row. The pump stops choosing it —
a show that cannot render must not keep paying to find that out. Fix the cause, then hit **Resume**.

The most common cause is a script the writer got wrong, and the message says which rule:

- *"both resolve to the pointer …"* — two characters share a noun; fix the cast in the show's YAML and
  re-import.
- *"X speaks but is not named in the camera line"* — the writer put an off-screen voice in a shot.
- *"duplicate shots"* — the storyboard drew the same frame twice; this is the gate that stops the "one
  scene over and over again" failure, and it fires before anything is rendered.

## Adding a show

A show is a file: `shows/<nn>-<slug>.yaml` in the `video` app package. See
[shows/README.md](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/video/shows/README.md)
for the shape and the two cast rules — the ones that decide whether the right character does the
talking. Add the file, re-import in the panel, tick it on.

Shipped: Breakfast Crew, Cardboard Cosmo Crew, Neon Noodle Jam, Detective Dot, Bubblebop Reef, and
Stupid Superheroes.

## One thing that will bite you on a fresh deployment

compose passes an **explicit allowlist** of environment variables into the api, and a variable it has
no value for arrives as an **empty string**, not as `undefined`. Two consequences:

- A knob that is not in the `x-bot-env` block simply does not exist inside the container. All of the
  variables below are in it; a NEW one has to be added there too or it will be silently ignored.
- Read every default with `||`, never `??`. `??` accepts `""` as a deliberate setting — which is how
  an unset `VIDS_NODE_BLACKOUT` once meant "no blackout window at all" instead of the default.

## Environment reference

| variable | default | what it does |
|---|---|---|
| `VIDEO_PUMP_ENABLED` | *(off)* | the scheduler; must be exactly `true` |
| `VIDEO_PUMP_INTERVAL_MS` | `1200000` | cycle cadence |
| `VIDEO_PUMP_FAILURE_LIMIT` | `3` | consecutive failures before a show auto-pauses |
| `VIDEO_PUMP_SKIP_LOG_MIN` | `60` | don't re-log an identical skip more often than this |
| `VIDS_NODE_BLACKOUT` | `16:45-19:45` | windows the pump stays out of (comma-separated, wraps midnight) |
| `VIDS_NODE_BLACKOUT_TZ` | `America/Chicago` | the zone those windows are written in |
| `VIDS_NODE_PKG_DIR` | `C:\oshal-vidsop` | the vids-operator package **on the node** |
| `VIDS_NODE_EXE` | `C:\Program Files\nodejs\node.exe` | node on the node |
| `VIDS_RENDER_CLIENT_ID` | *(auto)* | pin a specific render node |
| `VIDS_NODE_PROBE_TIMEOUT_MS` | `120000` | how long to wait for the node to answer |
| `VIDS_NODE_RECAP_IDLE_MIN` | `10` | treat the recap as running if its log is newer than this |
| `VIDS_NODE_MAX_COMMIT_PCT` | `92` | refuse above this commit charge |
| `VIDS_NODE_MIN_FREE_MB` | `512` | refuse below this available memory — **the operator's node needs 256**: it sits at ~450MB available and 53% commit while perfectly healthy |
| `VIDS_NODE_MAX_CHROME` | `40` | refuse above this many chrome.exe processes |
| `VIDS_NODE_LEASE_MINUTES` | `45` | how long the pump holds the node for one episode |

## What the node needs

`VIDS_NODE_PKG_DIR` must contain `episode-render.js` plus `src/agent/story-extend.js`,
`src/media/assemble.js`, `src/storage/store.js` and `src/storage/drive.js`, with `playwright`
installed and an `ffmpeg` on PATH (or `OSHAL_FFMPEG` set). Verify in one shot:

```powershell
Set-Location C:\oshal-vidsop
node -e "require('./src/agent/story-extend');require('./src/media/assemble');require('./src/storage/store');console.log('LOADS_OK')"
node episode-render.js            # must print: EPISODE_ERR no plan given
```

Both lines answering is the whole check — the render stage shells into exactly this.

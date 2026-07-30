# Coder Bot

A standalone local coding assistant for Windows. It is deliberately not a swarm
worker and does not connect to the OSHAL control plane.

Coder Bot can:

- listen through Chrome/Edge speech recognition and respond in text;
- proactively assess the foreground screen on a continuous loop and recommend what to
  do next (on by default — read [Cost and privacy posture](#cost-and-privacy-posture));
- answer coding questions and provide safe Git command sequences;
- capture the current foreground screen after a three-second switch window;
- explain what an app, website, terminal, or editor is showing;
- suggest a response or the next debugging steps;
- operate the visible screen when **Take control** is explicitly selected.

Screen-control mode can move, click, scroll, and type, but it stops before running
terminal commands or activating consequential Submit/Delete/Deploy/Purchase
actions. The user performs the final action.

## Start

Double-click `Start-Coder-Bot.bat`, or run:

```powershell
cd C:\Projects\oshal\coder-bot
npm start
```

Then open <http://127.0.0.1:8076>. The server binds to localhost only.

The microphone is input-only; the bot never speaks replies aloud. Screen
screenshots are stored in the Windows temporary directory only for the duration
of one analysis call, then removed.

## Controls

- **Send** — ask a coding question.
- **Always listen** — continuously buffer microphone text and assess it every five seconds.
- **Proactive on/off** — enable or pause automatic screen-change recommendations.
- **Read screen** — wait three seconds, capture the foreground screen, and explain it.
- **Take control** — let the bot work toward the typed goal on the visible screen.
- **Stop** — abort the active screen-control loop.

## Cost and privacy posture

Proactive screen assessment is **enabled by default**. It is disabled only when
`CODER_BOT_PROACTIVE` is set to exactly `0`; any other value (including unset)
leaves it on. It starts itself about 2.5 seconds after the server begins
listening — no click is required to arm it.

Each pass does two things: it captures the full monitor holding the foreground
window, and it spawns a Codex CLI process that is given that screenshot. So each
pass is one screen capture plus one model call, and the screenshot leaves the
machine — the Codex CLI sends it to its model provider. Whatever is on screen at
that moment is in the image, including windows unrelated to coding.

`CODER_BOT_PROACTIVE_INTERVAL_MS` (**default 100**) is the gap *after* a pass
finishes before the next one starts — not a fixed interval. The loop never
overlaps itself, so the real cadence is however long a Codex call takes, plus
100 ms. In practice that means it runs continuously, as fast as the model
answers, for as long as the server is up.

Two things it does **not** do: it does not throttle when the screen is
unchanged (the 16x9 screen signature is passed to the model as context, not used
as a skip gate — a static screen you are stuck on is when advice is worth the
most), and it does not stop when you go idle. It does skip while Coder Bot's own
window is in the foreground, while an interactive request or a control run is in
flight, and it backs those skips off to a 2-second retry.

The practical consequence: on a running instance this is a continuous
screen-capture and model-spend loop, not an occasional check. Screenshots
themselves are short-lived — each frame is written to a dedicated directory under
the Windows temp directory and deleted as soon as its analysis ends, pass or
fail.

To turn it off:

```powershell
$env:CODER_BOT_PROACTIVE = '0'
npm start
```

To keep it but slow it down, raise the interval — this waits a minute between
assessments:

```powershell
$env:CODER_BOT_PROACTIVE_INTERVAL_MS = '60000'
npm start
```

Either way it can be toggled at runtime from the **Proactive on/off** control in
the local UI, which takes effect immediately and does not persist across a
restart. Read screen, chat, and Take control are all explicitly user-initiated
and are unaffected by this setting.

## Environment variables

Every variable Coder Bot reads:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODER_BOT_PORT` | `8076` | Local HTTP port. Bound on `127.0.0.1` only |
| `CODER_BOT_PROACTIVE` | on | Continuous screen assessment. Set to exactly `0` to start disabled; any other value leaves it enabled |
| `CODER_BOT_PROACTIVE_INTERVAL_MS` | `100` | Gap after a completed assessment before the next capture — not a fixed interval. Skipped passes retry after 2 s regardless |
| `CODER_BOT_CAPTURE_DELAY_MS` | `3000` | Switch window for `POST /api/screen` when the caller sends no `delayMs`. The bundled **Read screen** button sends `3000` explicitly, so changing this only affects other local callers. Clamped to 0–10000. A chat message that reads as a screenshot request uses a 1500 ms window instead |
| `CODER_BOT_MAX_STEPS` | `20` | Maximum actions in one control run. Clamped to 1–50 in code, so a larger value is capped at 50 |
| `CODER_BOT_CODEX_TIMEOUT_MS` | `90000` | Timeout for one Codex call, after which the child is killed |
| `CODEX_CLI_PATH` | auto-detect | Optional Codex CLI path. Takes precedence over detection; a `.js` path is run under this process's Node binary |

Coder Bot holds no API key of its own. Every model call is
`codex exec --json --ephemeral --skip-git-repo-check -s read-only`, run against
whatever login the Codex CLI already has.

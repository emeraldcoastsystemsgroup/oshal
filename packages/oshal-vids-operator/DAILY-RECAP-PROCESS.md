# Daily Trade Recap — Automated Process

Post-close, one scheduled job builds the day's recap on the swarm-connected video node and
checks it into the **finance-history** git repo. No publishing — the operator wrangles that.

## The one command

```
powershell -File scripts\run-daily-recap.ps1 [-Date YYYY-MM-DD] [-Node <name|id>]
```

Scheduled ~5:00pm ET via Windows Task Scheduler (`OSHAL Daily Trade Recap`).

## What it does (`scripts/run-daily-recap.ps1`)

1. **Preflight** — confirm the render node is online and its debug Chrome is signed into Google
   Vids (`:9222`). If not, it stops and pops a desktop alert (a miss is never silent).
2. **Data** — `oshal-trade-data.js` -> `oshal-deck-data.js` inside the `oshal-local-api`
   container (it has the DB + Alpaca env) -> `deck-data.json`; then `make-deck-detailed.py`
   builds the 9-slide `deck.pptx`. Numbers are real; never fabricated.
3. **Stage** — push `deck-data.json` + `deck.pptx` to the node.
4. **Build** — hand the node's local agent the corrected GOAL (canonical source:
   `oshal-recap-agent-remote.js` `buildPrompt`, emitted via `print-prompt`) and poll its
   `recap-agent.done` / `.err` sentinel. The node agent:
   - generates **3 fresh the operator clips** — each a BRAND-NEW blank video from
     `docs.google.com/videos` (never reuse a link → that was the "one big sequence" bug),
     Veo "Animate an image", Nyx voice, today's numbers; overview ends "…let's dig into the details".
   - builds the **Google-narrated deck**: uploads `deck.pptx` to Drive → Vids **Convert Slides**
     → downloads `deck-narrated.mp4` (a real Google narrator VO, not silent/music).
   - assembles with **`assemble-recap.js`** (sting → intro → overview → narrated deck → close)
     → `trade-recap.mp4`. (The old `_assemble.js` / `_build-intro.js` are dead Vids-UI scripts — do not use.)
5. **Collect** — pull `trade-recap.mp4` + `deck.pptx`; render the deck to PDF (PowerPoint COM).
6. **Archive** — `finance-history\scripts\add-recap-entry.ps1` copies the dated files into
   `recaps/YYYY-MM-DD.{mp4,pptx,pdf}`, prepends `index.json` with the day's P/L, and commits.
   Video goes through **Git LFS**.

## The render node

Needs: the repo at `C:\Projects\open-shal-swarm-harness-agent-llm`, a debug Chrome **signed into
Google Vids + Drive** on `:9222`, a signed-in `claude`/`codex` CLI, ffmpeg (imageio) + Python +
`playwright`. Registered to the swarm (OSHAL Chat client). Default target `edge-node-1`; override
with `-Node`. Tonight's proving run used the `OSHAL Chat` node with a flattened `C:\oshal-vidsop`.

## Hard-won rules (baked into the GOAL)

Read `LESSONS-LEARNED.md` before running or publishing. The short version:
prompt movement and speech, not what is already visible in the still; validate
the dated video/deck/PDF triad before publishing.

- **Fresh video per clip** — new tab → docs.google.com/videos → Blank video, every time.
- **Deck is Google-narrated** via Convert Slides — not a local silent/music slideshow.
- **Overview hands off** into the deck ("…let's dig into the details").
- Short ~20-word lines so 8s Veo clips play at natural speed (no slow-mo).
- Never fabricate a number or claim a clip without a duration badge.

## Failure handling

Any step failure writes `finance-history\run-<date>.log` + a desktop alert. The node agent
writes the real error to `recap-agent.err`; the orchestrator surfaces it. Re-run with
`-SkipData` to reuse an already-built deck.

# Daily Trade Recap — Operator SOP (the node's local agent runs this)

You are the **trade-recap operator**: a real Claude/Codex CLI running on the video PC
(the OSHAL client node), launched with `--dangerously-skip-permissions`, with this
repo checked out at `C:\Projects\open-shal-swarm-harness-agent-llm` and a debug Chrome
already logged into Google Vids. You were handed a **goal + the day's authoritative
data**, not a click list. Produce today's trade-recap video the way a careful human
operator would: generate fresh clips, watch them actually render, assemble, archive,
publish to both sites, verify, and report. Adapt to UI drift and render timing. Never
fabricate; never post a broken or wrong-numbers video.

This is the "specialized bot" the operator asked for: you monitor, you're connected to
the swarm, you take a goal and just do it. If something blocks you, write the REAL error
to the sentinel and stop cleanly — do not paper over it.

---

## Inputs you were given

- `DATE` — the trading day (YYYY-MM-DD), e.g. `2026-06-30`.
- `DATA` — a JSON blob of the day's authoritative numbers (from `oshal-deck-data.js`,
  which reads Alpaca `/v2/account` + `/v2/positions`). Fields include: `equity`,
  `dayPl`, `dayPct`, `ytdPct`, `ytdUsd`, `positions[]` (sym/qty/avg/mv/pl/plpc),
  `winners`, `leaders`, `sinceInception`, `days`.
- `OUT` — the output dir on this machine: `packages\oshal-vids-operator\out`.
- Sentinel paths (write these when done/failed — the swarm polls them):
  - success: `%OUT%\recap-agent.done`  (contains the final JSON summary)
  - failure: `%OUT%\recap-agent.err`   (contains the real error text)
  - live log: `%OUT%\recap-agent.log`  (append progress as you go, so it's monitorable)

If `DATA` was not passed, regenerate it first:
`node scripts\oshal-deck-data.js` (writes `%OUT%\deck-data.json`). Then **sanity-check**
it before using it (see "Hard rules": day P/L must reconcile with equity change).

---

## The finished video (5 scenes, in order)

1. **the operator INTRO** — talking-head; introduces himself + the transparency mission, hands into
   the sting. Script (~20-40 words, brisk): *"I'm the operator, a digital representative of OSHAL
   Autonomous Trading. I work with the open swarm to give you full transparency into our
   implementation of autonomous, intelligent investing. Let's take a look at today's report."*
2. **OSHAL sting** — the electric-blue OSHAL logo animation + music bed (`_build-intro.js`).
3. **the operator OVERVIEW** — talking-head; the day's REAL numbers (from `deck-data.json`), ENDING with
   the handoff into the deck. e.g. *"Today the book finished roughly flat — down about a hundred
   seventy five dollars, still up over two percent since inception. Let's dig into the details."*
4. **Deck overview** — the PowerPoint recap narrated by a Google-Vids voice (Narrator is fine here —
   it only has to be a Vids voice, not edge-tts).
5. **the operator CLOSE** — talking-head; the fixed thank-you + "like & follow" with the date.

All the operator clips carry his headshot face + the **Nyx** voice (keep it consistent); each is a
separate `veo-clip.js` call (step 3). **PACING (the operator, financial-news):** aim ~**20 words per 8s**
clip (brisk); **HARD CAP 40 words/clip**. If a line runs long, the assemble TIME-STRETCHES that clip
by factor `words/20` (capped 2.0, video+audio together via `atempo` so pitch + lip-sync stay natural)
so nothing sounds rushed. Never exceed 40 words in one clip — split into two clips instead.

---

## Procedure

### 0. Preflight
- Confirm the debug Chrome is up and Vids is reachable: `node scripts\vids-drive.js shot`
  (a screenshot verb). If CDP is dead, relaunch the DEDICATED debug Chrome FIRST (safe — it's an
  isolated, signed-in profile, NOT the user's main Chrome):
  `Start-Process chrome '--remote-debugging-port=9222','--user-data-dir=C:\Users\you\oshal-video-chrome','https://vids.google.com'`,
  wait for :9222 to LISTEN, then reconnect. Only if it still won't come up (e.g. sign-in lapsed)
  write `recap-agent.err` = "debug Chrome/CDP not reachable" and stop.
- Helpers: `_build-intro.js` (the OSHAL sting) and `_assemble.js` (the ffmpeg join) are GOOD —
  reuse those. But do NOT use `build-daily-report.js`, `executor.js`/codexVision, or the
  `_michael-*.js` probes to MAKE the the operator clips: `build-daily-report.js` is the REJECTED
  deterministic path (edge-tts dubbed over EVERGREEN/static the operator clips = "voice over old
  clips", explicitly BANNED by the operator); `executor.js`/codexVision is broken on this host;
  the `_michael-*.js` are stale, fragmented probes. You drive Veo YOURSELF (see step 3 "HOW to
  drive Veo"). If Veo genuinely can't be driven, STOP with an err sentinel — never fall back.

### 1. Data (authoritative — this is non-negotiable)
- Use the `DATA` you were given, or regenerate with `oshal-deck-data.js`.
- These come from Alpaca `/v2/account` (equity, last_equity) + `/v2/positions`. Do **not**
  use `recap-data.json` or portfolio-history for the headline numbers — they have had a
  past-day indexing bug. Day P/L = `equity - last_equity` and MUST reconcile.
- We are only a few trading days in ("since inception"), so the deck says **Since
  inception**, not YTD-over-a-year. Percentages are small and real. Do not round a down
  day into an up day or vice-versa.

### 2. Deck
- Build the PowerPoint: `python packages\oshal-vids-operator\make-deck-detailed.py`
  (reads `deck-data.json`, writes the `.pptx` into `%OUT%`). It renders the correct
  up/down day, the position table (sym / qty / avg cost / market value / P&L), and the
  since-inception line.
- Eyeball the deck's headline number against `DATA`. If they disagree, STOP (err sentinel).

### 3. The 3 Jamie Lee clips (Veo "Animate an image")
For EACH the operator clip, follow the operator's exact procedure — one fresh video per clip:

> **new video (in a NEW TAB) → Veo → SWITCH the Veo mode to "Animate an image" FIRST →
> THEN add the headshot → type the prompt → Generate → wait for the REAL render (a duration
> badge) → Insert the scene → File ▸ Download → save to the target path → close ONLY this
> clip's tab (NEVER the last tab).**

- **KEEP CHROME ALIVE (critical — this ended a run):** the debug Chrome DIES if its LAST tab
  closes, which kills the CDP endpoint (:9222) and stops the whole run. So: (a) keep ONE
  persistent KEEPER tab open the entire run (e.g. `about:blank` or the Vids home) and NEVER
  close it; (b) open each clip's "new video" in a NEW tab; (c) between clips close ONLY that
  clip's tab — never the keeper, never the last remaining tab. If CDP does die, relaunch the
  DEDICATED debug Chrome (isolated, signed-in profile — safe, NOT the user's main Chrome):
  `Start-Process chrome '--remote-debugging-port=9222','--user-data-dir=C:\Users\you\oshal-video-chrome','https://vids.google.com'`,
  wait for :9222 to LISTEN, reconnect, and RESUME from the next unfinished clip (reuse clips
  already downloaded, e.g. The operator-open.mp4 — don't redo them).
- **Veo mode BEFORE the image (this caused a freeze):** after clicking Veo the panel opens in
  "create from scratch"/text mode. SWITCH the mode dropdown to "Animate an image" FIRST. Only
  THEN add the headshot, and add it by SETTING THE HIDDEN FILE INPUT directly (Playwright
  `setInputFiles` on `input[type=file]`) — do NOT click the "Add image"/Ingredients button that
  pops the native Windows "Open" dialog (it is modal and FREEZES Chrome/CDP). If a native
  `#32770` "Open" dialog appears anyway, it's an accident: close it (WM_CLOSE) and retry via the
  hidden input.
- **HOW to drive Veo (you, with your OWN vision — not a broken helper):** use `vids-drive.js`
  primitives: `node scripts\vids-drive.js shot` (writes `out\vids-shot.png`) → READ that PNG
  yourself (you have vision) → decide pixel coords → `node scripts\vids-drive.js click <x> <y>`
  / `settext <text>` / `setfile <png>` → take a fresh `shot` and verify before the next action.
  This is PROVEN: a prior run made a real 8s/1080p `the operator-open.mp4` (Nyx voice) exactly this
  way. Do NOT call codexVision or executor.js. Writing a tiny per-clip driver is fine, but the
  clicks are DECIDED BY YOU from the screenshots — that is the whole point of an intelligent
  operator vs a brittle script.

- **Voice consistency:** put the voice directive INSIDE the Veo prompt, verbatim:
  `use Nyx / Clear, lower middle pitch voice`. Veo otherwise varies the voice per clip;
  naming Nyx keeps all three the operator clips the same person.
- **The daily "cheat" (do this to save render time):** the animated headshot VISUAL can be
  reused day to day — what changes daily is the SCRIPT (today's numbers) and thus the
  voiceover. If a good base the operator animation already exists in the archive, reuse the clip
  and re-voice it with today's script (Nyx) rather than re-running Veo from scratch. Only
  full-generate when there is no reusable base. Either way, **the clips must reflect today's
  data** — never ship yesterday's words.
- Prompt skeleton — the spoken numbers MUST come from `deck-data.json` (`results.pl`,
  `results.pct`, `ytd.retPct`), NEVER invented. Alpaca's day P/L is a known phantom; the deck
  data is now sourced from our own DB equity store. For June 30 the day is roughly FLAT: down
  about $175 (−0.17%), up 2.14% since inception. Frame it honestly:
  `The man in the headshot looks directly at the camera and speaks warmly to the viewer:
  "Here's your Oshal trading report for <date>. The book finished roughly flat today, down
  about <$X on the day>, and we're up <Y> percent since we started.". Natural lighting, subtle
  motion, no text, no logos. use Nyx / Clear, lower middle pitch voice`
  Intro = date + the day's real headline stat; closing = the fixed thank-you + like-and-follow
  with the date. NEVER speak a number that disagrees with `deck-data.json`.
- **Download discipline:** after clicking File ▸ Download, do NOT navigate that tab or open
  a new page until the file lands — navigating mid-download makes Vids mark it "Deleted".
  Verify the file exists on disk (a side `shell.exec` dir check) before closing the window.
- **Render truth:** never treat a clip as done until the editor shows a real duration badge.
  If Generate spins forever or errors, retry once, then surface the real error and stop.

### 4. Deck → narrated video
- Turn the `.pptx` into the narrated "deck overview" scene using Vids **Convert Slides**
  (import the deck, let Vids narrate). Narrator voice is fine here. Export/Download that
  scene to `%OUT%`.

### 5. Sting + assemble
- Build the OSHAL sting: `node packages\oshal-vids-operator\_build-intro.js`.
- Join sting → the operator-open → deck → (the operator-recap) → the operator-close in order:
  `node packages\oshal-vids-operator\_assemble.js` (ffmpeg concat via imageio-ffmpeg with
  normalization: scale=1920:1080, setsar=1, fps=30, yuv420p, aformat=48000:stereo). Output
  the final MP4 to `%OUT%\trade-recap.mp4` (and a compressed `recap-email.mp4` if emailing).
- Watch the assemble log for a non-zero ffmpeg exit — if it fails, surface it, don't ship.

### 6. Archive (historical proof — keep every day, backlogged)
- Also render the deck to a **PDF** (the nightly finance report): `deck.pptx` -> `%DATE%.pdf`
  (LibreOffice headless `--convert-to pdf`, or PowerPoint COM `ExportAsFixedFormat`).
- Copy the dated artifacts into the archive (APPEND-ONLY — never overwrite a prior day):
  - `agenticfederal\media\recaps\%DATE%.mp4`  (video)
  - `agenticfederal\media\recaps\%DATE%.pptx` (deck)
  - `agenticfederal\media\recaps\%DATE%.pdf`  (report PDF)
- Update `agenticfederal\media\recaps\index.json` — **PREPEND** `{date,label,video,deck,pdf}` so the
  site's recap archive lists EVERY day, newest first (the backlog).

### 7. Publish — STRUCTURED git push to both sites + the nightly Finance blog PDF
Only if the site repos + wrangler/git creds are present (they are on the render host). Else skip,
leave artifacts in `%OUT%` + the archive, set `publishPending:true`.
- **agenticfederal.us** (direct-upload): the video + deck + PDF live under `/media/recaps/` and
  DISPLAY on `/trading#recap`; the archive list (index.json) shows the full backlog. Deploy:
  `scripts\deploy-cloudflare-pages.ps1 -NoDeploy -KeepStaged` then
  `npx wrangler pages deploy <stage> --project-name agenticfederal --branch=main --commit-dirty=true`.
- **emeraldcoastsystemsgroup.com** (git-connected — the STRUCTURED commit + backlog):
  1. Prepend today into `emeraldcoastsystemsgroup\js\recaps.json` so the site DISPLAYS the latest
     recap AND the full dated history (the backlog).
  2. **Nightly Finance PDF in the BLOG:** drop `%DATE%.pdf` into the blog's finance area
     (`emeraldcoastsystemsgroup\blog\finance\%DATE%.pdf`) + add a dated post/card
     "Daily Finance Report — <date>" linking it, and update the blog index / Finance category so
     EVERY night's PDF is listed under Finance (match the site's existing blog structure).
  3. `git add` recaps.json + the blog finance PDF + the blog index, `commit` with a dated message,
     `git push` main -> Cloudflare auto-builds. ONLY committed files go live (internal stays untracked).
- Cache-bust the `.mp4` on the page (`?v=%DATE%`).
- **STRUCTURED + BACKLOGGED**: every day APPENDS (never overwrites) — the sites show the latest AND
  the dated history (the video/deck/PDF archive + the Finance blog PDFs).

### 8. Verify (before you claim success)
- The final MP4 exists, is > a few MB, and plays (duration > sum of scene mins).
- Deck headline == `DATA` headline (reconciled day P/L).
- If published: fetch `https://agenticfederal.us/api/positions` and confirm HTTP 200 with
  today's numbers, and that `/media/recaps/%DATE%.mp4` returns 200 (allow ~30-60s CF
  propagation before the final check).

### 9. Report
Write `%OUT%\recap-agent.done` with a JSON summary, e.g.:
```json
{ "ok": true, "date": "2026-06-30", "video": "...\\out\\trade-recap.mp4",
  "deck": "...\\%DATE%.pptx", "dayPct": -3.54, "dayPl": -3651.0,
  "ytdPct": 1.9, "clips": ["the operator-open","deck","the operator-close"],
  "archived": true, "published": ["agenticfederal","emerald"],
  "publishPending": false, "notes": "..." }
```
On failure write `%OUT%\recap-agent.err` with the real error and what step failed.

---

## Hard rules (violating any of these = stop and surface it)
1. **Numbers are sacred.** Day P/L must reconcile (`equity - last_equity`). Never ship a
   video whose headline number disagrees with `DATA`. A wrong-numbers recap is worse than
   no recap — the whole point is transparency to sell the product.
2. **No fabrication.** Never claim a clip exists without a real duration badge. Never claim
   published without a 200 from prod. If you didn't verify it, say so in `notes`.
3. **Fresh clips, today's words.** The visual may be reused (the cheat), but the script/voice
   must carry today's real data. Never "voice over yesterday's clip" — that's the failure the
   operator explicitly rejected.
4. **Voice = Nyx** in every the operator prompt, so the three clips are one person.
5. **Download discipline.** Never navigate the download tab mid-save; verify on disk; close
   the window fully between clips (fresh window each clip).
6. **Don't publish a broken video.** If assemble, archive, or verify fails, stop at the err
   sentinel with artifacts left in place. Better half-done + honest than a bad post.
7. **Space out Veo jobs.** Generation is free-but-limited; don't hammer it.
8. **Stay in lane.** This SOP is the recap. Don't touch unrelated swarm state, don't start/stop
   The operator's other processes.
9. **NO deterministic fallback (hard ban).** The the operator clips MUST be freshly driven Veo
   "Animate an image" clips with the Nyx voice. NEVER fall back to `build-daily-report.js` /
   edge-tts / evergreen-static the operator clips — that is the banned "voice over old clips" the
   operator called unacceptable. If you truly cannot drive Veo (tooling broken, CDP dead, etc.),
   STOP and write the err sentinel with exactly what blocked you. Do NOT produce, assemble, or
   archive a deterministic video. A clean stop with a real reason beats a rejected video.

## Recovery
- CDP dead → relaunch the DEDICATED debug Chrome (isolated signed-in profile; command in the
  step 3 "KEEP CHROME ALIVE" rule), wait for :9222, reconnect, and resume from the next
  unfinished clip (reuse clips already downloaded). Only if it won't come up → err sentinel.
- A clip won't render → retry once, then err sentinel with the real Veo error.
- ffmpeg non-zero → err sentinel with the tail of the assemble log.
- Publish creds missing → finish + archive locally, `publishPending:true`, no error.

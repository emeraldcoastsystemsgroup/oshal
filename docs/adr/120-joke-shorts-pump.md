# ADR-120 — The joke-shorts pump: an automated driver for the video-series conductor

**Status:** Accepted (2026-07-29)
**Supersedes nothing. Extends:** [ADR-080](080-creative-studio-extend-story-pipeline.md) (the creative content engine), [ADR-082](082-video-series-pipeline.md) (the conductor is the pipeline),
[ADR-093](093-packaged-app-runtime-placement.md) (engines stay in the kernel, content ships in packages).

## Context

The video-series machine works. A described series becomes a screenplay-writer draft, an approval
gate, a storyboard, a Google Vids render on the operator's remote node, and an assembled MP4 — proven
end to end on 2026-07-08, and eight days earlier a whole season of ten Breakfast Crew episodes was
delivered by hand.

Then it stopped. The last row in `video_series` is dated 2026-07-08. Not because anything broke:
because **nothing ever asked it to run again**. Every episode this project has produced was started by
a human typing a premise. The engine has no driver.

Three things stood between "we have an engine" and "the engine produces":

1. **Nothing schedules it.** `advanceVideoSeries` walks one series when called. Nobody calls it.
2. **The approval gate is absolute, and correctly so.** The conductor will not cross
   `awaiting_approval` on its own, because the next step spends real money. Automation that simply
   deleted that gate would be the wrong fix.
3. **The render node is shared, and it does not announce itself.** One machine (`parentpc`) drives one
   signed-in Chrome, and the nightly trade recap owns it every evening. Two chains against one browser
   do not run slower — they re-open each other's tabs, finish nothing, and every retry is paid. On
   2026-07-28 that machine also showed what "busy" really looks like: 88 stray Chrome processes,
   commit charge at 31.5GB of a 31.8GB limit, and a twenty-minute build that took two hours.

A fourth thing was found while building this and is worth recording: the render dispatch's node
package directory defaulted to `C:\Projects\open-shal-swarm-harness-agent-llm\packages\…`, a path on
the CONTROLLER's disk that has never existed on the node — and `episode-render.js` was not on the node
at all. The render stage could not have run even if something had asked it to.

## Decision

Add a **pump**: a driver over the existing conductor. It changes no stage and replaces no engine.

### 1. Availability is a gate, and it fails closed

`src/app/vids-node-availability.ts` answers one question — *is the render node free?* — and answers
"no" unless it can prove otherwise. In order, cheapest first:

| check | signal |
|---|---|
| `no-worker` | no online client advertising `shell.exec` |
| `worker-busy` | the node has a claimed task, or anything queued |
| `render-in-flight` | ANY `video_episodes` row is `rendering` — one Chrome, one chain |
| `blackout` | inside `VIDS_NODE_BLACKOUT` (default `16:45-19:45 America/Chicago`) |
| `probe-failed` | the node did not answer, or answered unreadably |
| `recap-running` | `out/build.pid` alive, `out/build.log` fresh, or any `claude` process |
| `leased` | somebody holds the node lease |
| `no-browser` | zero Chrome processes on the signed-in Vids profile |
| `low-memory` | commit charge ≥ 92%, or under 512MB available |
| `chrome-storm` | more than 40 chrome.exe processes |

A timed-out probe, an unreachable node and an unreadable time zone all mean **not available**. The
cost of a false "free" is a wasted paid render and a corrupted recap; the cost of a false "busy" is
that the pump tries again in twenty minutes.

The blackout window and the recap probe are deliberately redundant. The recap does not take a lease,
so the clock is the belt and the probe is the braces.

### 2. Standing authorization replaces the human at the gate — per show, and capped

The approval gate survives. What changes is *who can satisfy it, and for what*:

- The operator enrols a show **once**, with `standing_authorization` and a `daily_cap`.
- The pump may then approve episodes **of that show**, up to **that cap per day**, and nothing else.
- Default is `false`. An enrolled show without standing authorization is still written — scripts are
  an LLM call and cost no render credits — and then parks exactly as a hand-made series does.
- The cap is re-checked at approval time as well as at selection, so a concurrent cycle cannot slip an
  episode past it.

This keeps the gate's meaning: **no render spend happens that the operator did not authorize.** What
automation removes is the retyping, not the consent.

### 3. One episode per cycle, rotated, and every cycle is recorded

Selection is least-recently-started first, so six shows advance evenly rather than one show running
away with the node. `video_pump_runs` records **every** cycle including the ones that produced
nothing, with the gate check that stopped it. A quiet night has to be readable as "the recap owned the
node from 17:00" rather than being indistinguishable from a dead pump.

Tuning comes from the same rows: three consecutive failures auto-pause a show with the reason on the
row, and a delivered episode resets the counter.

### 4. Content lives in the store, the engine lives in the kernel

Per ADR-093: `series-pump.ts` and `vids-node-availability.ts` are framework-resident, because they
drive the conductor. The **shows** — six of them, five proven casts plus the new Stupid Superheroes —
are `shows/*.yaml` in the `video` app package, along with the enrolment routes and the operator panel.
Adding a show is a file in the store repo; it is never a kernel change.

Each show carries **joke seeds**: a list of comedic premises walked in order. Left to invent its own
premise every time, the writer converges — ten episodes of the same joke, which is precisely how the
dropped Wonder Creek series failed ("it's just one scene over and over again").

## Consequences

**Good.** The engine produces without a human starting each episode. The node's sharing is explicit
and enforced rather than assumed. Failures are visible, bounded and self-limiting. Adding a show is
content, not code.

**The costs, stated plainly.**

- The pump spends money while the operator is not watching. That is the point of standing
  authorization, and it is why the default is off at three levels: `VIDEO_PUMP_ENABLED` for the
  scheduler, `enabled` per show, and `standing_authorization` per show again.
- The availability gate can be wrong in the safe direction and idle the pump. Under-production is the
  failure mode we chose.
- The gate's recap detection reads markers the recap runner happens to write (`out/build.pid`,
  `out/build.log`). If that runner changes its markers, the gate goes blind to it — the blackout
  window is what keeps that from being a collision. The honest fix, deferred, is for the recap to take
  the same node lease the pump does.

**Not addressed here.** Publishing (nothing is posted anywhere; episodes land in the content folder
and Drive), and the second half of the tuning loop — nothing yet reads a delivered episode back and
judges whether the joke landed.

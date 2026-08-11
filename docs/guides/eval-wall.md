# Eval Wall — user guide (as-built)

Click the dashboard icon labeled **Eval Wall** in the cockpit sidebar's **Optimization** group; it
opens the surface embedded in the cockpit. The same page is served directly at
**`/api/eval-wall/app`** if you prefer a full browser tab, and the **Eval Wall** link in the
[AI Test Lab](./ai-test-lab.md) header goes to the same place. You must be signed in.

This screen is the running record of the graded overnight evaluations — a history, not a live check.
When the nightly loop is switched on (see *Populate an empty wall* — it is not on by default), it
submits a set of complicated requests to the swarm as real tickets, waits for each one to reach a
terminal state or run out of its time budget, grades the result against a fixed expected answer, and
writes one row here. The wall rolls those rows up: how often the platform got it right, what it cost,
how long it took, how many retries it needed, and how good the answers scored.

Nothing on this page starts a run. It reads and reports.

## What you see

### Header

An **EW** badge, the title **Eval Wall** with the eyebrow *AI Test Lab — green wall*, and on the
right a pill reading **last 30 days**. The pill states the window the summary covers; it is a label,
not a control.

### The success-rate hero

One large number — the share of runs in the window that passed — under the label **Success rate**.
Its color is the verdict:

| Color | Meaning |
|---|---|
| Green | 85% or better |
| Amber | 60% up to 85% |
| Red | below 60% |
| Muted dash (`—`) | no rate to show |

Beside it, a line of context: how many runs are in the window, and your security posture — `clean`,
a count like `3 open (1 crit, 2 high)`, or `not measured`.

**Before anything has been recorded** the number is a dash and the line reads *"No eval runs
recorded yet. Run the golden loop or seed history."* That is the honest empty state, not an error.
If the summary itself could not be read, the line reads *"Success rate unavailable."* instead.

### The five tiles

| Tile | Sub-label | What it is |
|---|---|---|
| **Total cost** | (window) | The money the runs in the window actually spent, summed. It is read from the platform's central cost ledger — the same place every model call in the system records into — not re-counted here. |
| **Avg latency** | per run | Mean wall-clock time a run took, end to end, in milliseconds. |
| **Avg retries** | per run | Mean number of re-attempts. The loop re-runs a scenario that did not pass and keeps the best attempt, but it stops at `TEST_LAB_MAX_ATTEMPTS` tries (default 2) — so a single run's retries are 0 or 1 unless an operator raises that, and this average sits between them. |
| **Quality score** | mean final | Mean final score across the runs that reported one. The final score blends a mechanical check (did it complete, are the files there, are the required words present, does the output actually contain tests) with a model judge's rubric score — or is the mechanical score alone when no judge ran. |
| **Security posture** | the finding breakdown, or *not measured* | `clean` in green when your Security Center shows no open critical or high findings; the open-finding count in red when it does; a dash when no scan has completed. |

A tile shows a muted dash whenever nothing in the window reported that figure. A dash means *not
measured* — the wall never substitutes a zero for a number it does not have.

### Success-rate trend

A sparkline of daily success rate, drawn from 0% at the bottom to 100% at the top, with the first
and last dates under each end and the caption *0–100% daily success* between them. One dot per day
that had runs — days with none are skipped, not drawn as zero — colored on the same thresholds as
the hero number; hover a dot to read that day's figure, for example `2026-08-04: 75% (3/4)`. Days
here are grouped in UTC, while the **When** column below is in your local time, so a late-evening
run can sit under the next day's dot.

**This card only appears once at least two separate days have runs.** With a single day of history
there is no line to draw and the card is hidden.

### Recent runs

A table of the most recent runs, newest first, up to a hundred rows. While it is fetching it shows
*Loading…*; with nothing recorded it shows *No runs recorded yet*.

| Column | What it holds |
|---|---|
| **When** | The run's timestamp, in your local time. |
| **Scenario** | The name of the golden scenario that was run. |
| **State** | A colored badge — see the table below. |
| **Final** | The blended final score the run was graded at, 0–100. |
| **Heur** | The mechanical half of that score: terminal status, deliverable count, required keywords, and whether the output contains recognizable test constructs. |
| **Judge** | The model judge's rubric score, 0–100. The judge is optional — when it did not run, or its answer could not be read as a score, the cell is a dash and the run was graded on the mechanical half alone. |
| **Latency** | How long that run took, in milliseconds. |
| **Retries** | How many re-attempts it needed beyond the first. |
| **Cost** | What that run spent. |
| **Tokens** | Input `→` output tokens, abbreviated (`4.1k`). A dash when neither was measured. |
| **Sec** | Security findings recorded against that run — a dash on every row the nightly loop wrote, because the loop does not record findings per run (see below). |

Rows highlight on hover; they are not clickable.

## Reading the four states

Every run lands in one of four states; the badge is upper-cased on screen (PASS, DEGRADED, GAP,
FAIL). Success rate counts **pass** and nothing else.

| State | Meaning |
|---|---|
| **pass** | It scored at or above the scenario's threshold, produced a real deliverable, **and** the swarm actually reached completion. This is the green one. |
| **degraded** | It produced a deliverable and scored above zero, but did not clear the pass bar — most commonly because the work escalated instead of completing. Deliberately not counted as green: escalation is a real gap and the wall keeps it visible rather than rounding it up. |
| **gap** | The run produced no deliverable at all — including an attempt that errored out before producing one. |
| **fail** | It produced something and still scored zero. Backfilled rows whose report recorded a failure also land here. |

## What you can do

### Answer "is the platform still getting it right?"

Read the hero number and its color, then the run count beside it. A green number over a handful of
runs is weaker evidence than the same number over thirty; the count is there so you can weigh it.

### See whether it is getting better or worse

Read the trend line left to right. A dot that drops well below its neighbors names the day to
investigate; hover it for the pass count that produced it.

### Find the scenario that regressed

Scan the **State** column for the amber and purple badges, then read that row across. The split
between **Heur** and **Judge** tells you which half of the grade fell over: a healthy judge score
with a poor heuristic usually means the answer was good but the run did not complete or did not
produce its files, while the reverse means it completed and produced files that did not hold up.

### Check what the evaluations are costing

**Total cost** is the window's real spend; the per-row **Cost** column shows where it went. Pair it
with **Avg retries** — repeated attempts are paid for every time.

### Populate an empty wall

The nightly loop is what fills the wall, one row per scenario per night — but **it is off until an
operator turns it on**. It needs three things on the box: the scheduled task registered
(`scripts/register-test-lab-nightly.ps1` sets up the 04:30 daily run), `SWARM_SERVICE_SECRET` and
`TEST_LAB_OWNER_SUB` set in the instance's `.env`, and the swarm's worker bots online — the
scenarios run as real tickets, so without workers there is no result to grade. Until then the wall
stays empty, and that is the honest state rather than a fault.

An operator can also backfill from Test Lab reports already on the box, with
`node scripts/eval-wall-seed.mjs`. It reads only the **dated** per-day report files
(`YYYY-MM-DD.md`) and deliberately skips `latest.md` and `baseline.json`, so on an instance that
holds only those two — which is what a fresh checkout ships — it inserts nothing and prints that it
found no reports. Backfilled rows carry the scenario, state and scores that were written in those
reports and nothing else, so their latency, retries, cost and token cells are dashes.

## What this screen does NOT do

- **It never starts an evaluation.** There is no Run button anywhere on the page. Runs arrive from
  the overnight golden loop, which runs headless on a schedule an operator has to register, and
  needs `SWARM_SERVICE_SECRET` and `TEST_LAB_OWNER_SUB` configured on the box. If you want to test
  the instance by hand right now, that is the [AI Test Lab](./ai-test-lab.md), a different screen.
- **It is not filtered to you.** The run history, and every number rolled up from it, is
  instance-wide: everyone signed in sees the same rows. The one per-viewer figure on the page is the
  security posture, which reads your own findings.
- **It does not refresh itself.** The page fetches its data once, when it opens. Reload the tab, or
  leave and re-enter the surface, to pick up runs recorded since.
- **You cannot change the window.** The hero, the tiles and the trend always cover the last thirty
  days. Adding a `days=` parameter to the page's own URL changes nothing — the page does not pass
  one on.
- **The runs table is not filtered by that window.** It is simply the most recent hundred runs, so a
  row older than thirty days can sit in the table while being excluded from the number above it.
- **There is no drill-down.** Rows do not open, there is no link to the ticket a run created, and the
  per-run diagnostic note recorded alongside the row is not displayed here.
- **Security posture is not a property of a run.** The tile and the hero line read your live
  [Security Center](./security-center.md) open findings, for your login, and say *not measured* until
  a scan there has completed. The per-run **Sec** column is a separate field that the golden loop
  does not currently fill, so it reads as a dash on rows the loop wrote.
- **It does not show the interactive lab's results.** Those live in that page and are not persisted.
- **It does not grade, re-grade or fix anything.** It renders what was recorded at run time.

## If something looks wrong

**The whole wall is dashes and it says "No eval runs recorded yet."**
Nothing has been written to the history on this instance — the expected state on a fresh install.
The overnight loop is not on by default: it has to be registered as a scheduled task, given
`SWARM_SERVICE_SECRET` and `TEST_LAB_OWNER_SUB`, and run with the swarm's worker bots online. Ask an
operator to turn it on, then wait for tonight. Backfilling only helps if dated per-day Test Lab
reports already exist on the box.

**The success rate is 0% (or far lower than it looks like it should be) and most rows are amber.**
That is `degraded` doing its job. Those runs produced good work but escalated instead of completing,
and escalation is currently the dominant outcome for the golden scenarios. Counting them green would
paper over a real swarm gap, so the wall does not. Read the **Final** column on those rows — the
quality is usually fine; the completion is what failed.

**Security posture says "not measured" and every Sec cell is a dash.**
Two different things, both expected until you act. The tile needs a completed security scan on your
own login — run one in the Security Center and this fills in. The column needs the runner to record
findings per run, which it does not do today, so those cells stay dashes regardless.

**Some rows have latency, cost and tokens; older ones have dashes.**
Rows backfilled from dated Test Lab reports only ever carried the scenario, state and scores — their
latency, retries, cost and token cells are dashes, because the wall refuses to invent the rest. Rows
written live by the loop carry the full set, and even there cost and tokens stay dashes when nothing
was recorded for that ticket (a local or free model spends nothing to report).

---

For the design rationale — why escalation is surfaced as `degraded`, and where cost is read from —
see [ADR-063](../adr/063-ai-test-lab.md); the feature-level notes and the nightly runner's setup are
in [test-lab.md](../test-lab.md).

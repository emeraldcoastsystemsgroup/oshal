# Optimizer (Token Chase) — user guide (as-built)

Click the rocket icon labeled **Optimizer** in the bottom section of the cockpit ribbon; it opens the
surface embedded in the cockpit. The same page is served directly at **`/api/token-chase/ui`** if you
prefer a full browser tab. You must be signed in — every read and action on this screen is scoped to
your own captured calls.

The rocket sits on the rail itself on a plain `/cockpit/`. On an app-scoped cockpit (`?app=<name>`)
the platform tools come off the rail and are reached through the rail's **Settings** (gear) button
instead, unless that app asks for them back on the rail. The Optimizer is not offered at all on a
student/kiosk rail.

The Optimizer lets you take a real LLM call your bots already made, re-run it, and see what it would
have cost on a different provider or model. It shows cost, latency and answer-similarity side by
side, keeps a record of every comparison you run, and lets you approve a cheaper lane as the new
baseline for that call. Replays are real calls to real providers, so they spend real tokens.

## What you see

**Header** — the title **OPTIMIZER**, a one-line description, and four links:

| Link | What clicking it does |
|---|---|
| **Demo comparison** | Loads a sample baseline-vs-variant comparison in the right column, and parks the Frames column on *demo comparison - no token spend* until you pick a run again. No provider is called and no tokens are spent — it exists so you can see the comparison math and layout before you have captured calls. |
| **Savings report** | Replaces the right column with the corpus-backed savings table (see below). Reads recorded results; re-runs nothing. |
| **Promotions** | Lists the approved lane switches for the currently selected run, plus the audit trail. Asks you to select a run first if none is selected. |
| **↻ refresh** | Re-reads the list of captured runs. It does **not** clear your selection — the selected run stays selected and the Frames/Inspector columns stay as they are. (The savings report's own hint suggests using it to deselect a run; it doesn't. Reload the page to get back to whole-corpus scope.) |

The body is three columns: **Runs**, **Frames**, **Inspector**.

### Runs (left column)

One row per captured run, newest first, showing the run id and `<N> calls · <date modified>`. A run
is one bot task, and the run id is that task's workspace name — every LLM call the task made is a
frame inside it. Click a run to load its frames. If nothing has been captured yet you get a **No
captured runs yet** card with a three-step setup note, a **Show demo comparison** button and a
**Refresh runs** button, and the demo comparison loads automatically so the screen is never blank.

### Frames (middle column)

One row per captured LLM call in the selected run, in call order. Each row shows:

| Element | Meaning |
|---|---|
| `#N` | The call sequence number within the run. |
| Provider badge | The provider/harness that actually fired the call (falls back to the requested provider, or `—`). |
| `non-replayable` (amber) | This call depends on a live or unpinned read, so it cannot be replayed. |
| `N recorded` (green) | This call already has N recorded replay/variant/grade results waiting in the Inspector. |
| `123→456 tok` | Input and output tokens. Shows `in-flight` instead when the call had not finished when it was captured. |
| Second line | `<N> msgs in · <latency>ms · <N> tools` — how much history was sent, how long the original call took, how many tools it carried. |

Click a row to open it in the Inspector.

### Inspector (right column)

Top to bottom:

1. **Inspector - call #N** with a `← prev call` / `next call →` stepper, so you can walk the run one
   call at a time without going back to the middle column.
2. **Four summary cards** — *Provider* (and model), *Tokens* (input → output), *Latency* (the captured
   baseline), *Replay* (`ready` or `blocked`, with the call's phase underneath).
3. **Replay determinism check** button, with a hint beside it. When the button is disabled the hint
   tells you why: the call is still in flight, or the frame is marked non-replayable.
4. **Verdict area** — empty until you run a replay, then filled with the verdict badge and numbers.
5. **Recorded results (replays · variants · grades)** — the table of everything you have already run
   against this call. The first row is the captured baseline; each following row is one recorded
   result with columns *lane, model, cost, Δ cost, latency, accuracy, judge, verdict, when*. Click any
   row to expand a detail line showing the baseline lane and price, the variant lane and price, the Δ
   in dollars and percent, whether it was judged equivalent, the lexical accuracy score, the judge
   score and mode, the query type and the harness. Variant response *text* is not kept — the table
   holds metrics; re-run the lane in the Optimizer panel if you want to read its output again.
6. **Keep winner — approved routing switch** — part of the recorded-results block, so it appears
   once this call has at least one recorded result (and is absent while that read is failing). Holds
   the **★ Promote winner** button and the **also apply to the owning bot's config** checkbox.
7. **Optimizer — try a different provider / model** — the provider dropdown, **▶ Run**, and
   **▶▶ Run all available lanes**, above the live comparison table (*label, model, cost, Δ cost,
   latency, accuracy, verdict*). This whole panel is absent on a frame that cannot be replayed
   (still in flight, or marked non-replayable) — there is nothing to re-fire, so nothing to compare.
8. **Captured payload** — three collapsible blocks: *Response (baseline)* (open by default),
   *System prompt*, and *Sent history (N messages)*.

## What you can do

### Look at what a call actually cost

Pick a run, pick a frame, read the summary cards and the captured payload. This costs nothing and
calls no provider.

### Check whether a call is reproducible

Click **Replay determinism check**. The captured prompt is re-fired once, unchanged, on a bot node.
**This makes a real LLM call and spends real tokens.** (After the first run the button re-labels
itself **▶ Replay (no-edit determinism check)** — same button, same action.) The verdict area then
shows one of:

| Verdict | Meaning |
|---|---|
| **DETERMINISTIC** | The replay reproduced the captured answer byte-for-byte. |
| **EQUIVALENT** | The answer differs but stays within tolerance — comparisons built on this call are trustworthy. |
| **DIVERGENT** | The answer drifted past tolerance. Any cost comparison for this call is unreliable, because the model does not reproduce itself here. |
| **NON-REPLAYABLE** | Excluded: the call depends on a live or unpinned read. |
| **NO BOT NODE** | There is no reachable bot node to run the replay on. Start a worker bot and try again. |
| **IN FLIGHT** | The call had no captured response yet, so there is nothing to compare against. |
| **REPLAY ERROR** | The replay was attempted and failed; the reason is shown underneath. |

Below the badge you get byte-exact yes/no, the similarity score, baseline→replay token counts and the
token delta percent, plus the replay's model, cost and latency and a collapsible **Replayed response**.

### Run the same call on a different provider

In the **Optimizer** panel, choose a lane from the dropdown and click **▶ Run**. The exact captured
prompt is fired once on that lane. What appears in the dropdown depends on what your instance and
account already hold:

| Entry | What it is |
|---|---|
| `<Provider> (current)` | The bot's own current provider and model — the default entry. It runs on the bot's existing login; every other entry hands the bot a key for that one call. |
| `Free-provider rotation (N eligible lanes)` | An aggregate selector that picks among free lanes probed live at replay time (its "model" column reads *health-qualified at replay time* because the pick is made when you press Run). If a provider wall is hit it rotates to another free lane or stops; it does not fall through to a paid key. |
| A provider label | A framework provider that has a usable key on this instance **and** speaks an OpenAI-compatible API. Providers that don't (or that are OAuth-only) never appear here — they can still be the baseline via `(current)`, but they can't be replayed as an alternative lane. |
| `<name> (your key)` | One of your own Bring-Your-Own-LLM connections. |

Each entry is shown as `<label> · <model>`. A provider you expected but don't see has no usable key
on this instance, or isn't replayable as an alternative lane from here.

**▶▶ Run all available lanes** repeats that for every entry in the dropdown, one at a time, for the
current call. It is enabled when there are at least two lanes. Each finished lane fills a row:

| Verdict badge | Meaning |
|---|---|
| **SWAP ✓ cheaper, same answer** | Equivalent answer at a lower cost — the result worth acting on. |
| **same answer, costs more** | Equivalent answer, higher cost. Keep the baseline. |
| **answer differs** | The answer drifted past tolerance. Treat it as a trade-off, not a swap. |

A `*` after a cost means that figure was estimated from token counts rather than reported by the
provider. Every graded run is also written to **Recorded results** in the background, so you can
come back to it later — that table is built when the frame opens, so step away and back (or use the
`← prev call` / `next call →` stepper) to see the new row appear.

### Read the savings report

Click **Savings report** in the header. It reads what you have already recorded and calls no provider.
If a run is selected the report is scoped to it; otherwise it covers your whole recorded history (the
hint under the controls tells you which). To widen a run-scoped report back to your whole corpus,
reload the surface and open the report before selecting a run — the hint's suggestion to deselect
with **↻ refresh** does not work. The **quality bar** input plus **Apply** re-scores the report at a
different judge threshold.

Four cards headline it:

| Card | Meaning |
|---|---|
| **Verified savings** (LLM-judged) | Dollars saved on frames where the quality judge confirmed the cheaper answer held the bar. The number to lead with. |
| **Proxy savings** (lexical fallback) | Dollars saved on frames scored by the deterministic word-overlap fallback, used when the judge lane was unavailable. Reported separately and never blended into the verified number. |
| **Baseline vs variant** | Total baseline cost → total variant cost across all graded frames. |
| **Raw delta** | The unfiltered difference, with the percentage of baseline. Ungraded frames are excluded from both headline numbers and counted here. |

The table below breaks it down per lane: *lane (provider / model), frames, baseline $, variant $,
Δ saved, LLM held, verified $, lexical held, proxy $, ungraded*. "Held" means the judge score met or
exceeded the bar; frames bank savings when they are both held and cheaper.

### Promote a winner (the approved switch)

Once a call has recorded results, use **★ Promote winner**. It runs the promotion bar over that
call's recorded results and pins the winning lane as the call's preferred lane. The bar is strict:

- the result must be **LLM-judged** — lexical-fallback and ungraded results never promote;
- its judge score must meet the minimum quality threshold;
- it must be **strictly cheaper** than the baseline by at least the minimum-savings threshold.

Both numbers are deployment settings, not per-user ones: `TOKEN_CHASE_PROMOTE_MIN_QUALITY` (falls
back to the report's quality bar, `TOKEN_CHASE_JUDGE_BAR`, else 80) and
`TOKEN_CHASE_PROMOTE_MIN_SAVINGS_USD` (defaults to 0, meaning "any strictly positive saving"). The
panel prints the values actually applied whenever nothing clears the bar.

When something clears the bar you get a **PROMOTED — provider / model** badge with the savings, the
judge score and the source. From then on the promoted lane is what this call is priced *against*:
comparisons you run afterwards with **▶ Run** / **▶▶ Run all available lanes** are measured against
the promoted lane rather than the original capture, and the rows they record carry that baseline into
the savings report. Rows already recorded keep the baseline they were measured against — the report
is not rewritten retroactively — and **Replay determinism check** still compares against the captured
response.

When nothing clears the bar you get **NO WINNER — nothing clears the bar** plus the thresholds applied
and a per-candidate rejection table. That answer is evidence, not an error:

| Rejected because | Meaning |
|---|---|
| `ungraded` | The result has no judge score. |
| `lexical-fallback-judged` | Scored by the word-overlap proxy, not the judge. |
| `below-quality-bar` | Judged, but under the minimum quality score. |
| `missing-cost-pair` | Baseline or variant cost was not recorded, so savings cannot be computed. |
| `missing-variant-model` | The result does not name the model that produced it. |
| `below-min-savings` | Not strictly cheaper, or cheaper by less than the minimum-savings floor. |

**Nothing re-routes on its own.** A promotion changes what the Optimizer treats as that call's
baseline. It does not change how your bot runs unless you tick **also apply to the owning bot's
config** before promoting — that pushes the winning provider and model to the bot that owns the call
through the framework's config-ownership path, with a version bump and an audit entry. The result is
reported back to you either as *Bot config updated …* with the new version, or as *Bot config NOT
changed* with the reason. Common honest refusals: the winning lane is one of your own keys or a raw
endpoint (a per-user key never becomes shared bot config), the captured call no longer resolves an
owning bot, or config sync is not available on this deployment.

### Review and undo promotions

Select a run, then click **Promotions**. The table lists *frame, lane, model, saves, judge, source,
status, when*, with a **revert** button on active rows.

| Column value | Meaning |
|---|---|
| source `manual` | You clicked Promote winner. |
| source `auto` | An operator-enabled automatic pass promoted it after a whole-run savings loop. It re-baselines this screen only; it never pushes a bot config. |
| status `active` | Currently in force as that call's baseline. |
| status `reverted` | You undid it. |
| status `superseded` | A later promotion for the same call replaced it. |

Underneath, the **Audit trail** table records every promote, auto-promote and revert with a timestamp,
the frame, the action and its detail. Clicking **revert** demotes the promotion and reloads the view.

## What this screen does NOT do

- **It does not capture calls on its own.** Frames are written by the bot processes, and only when
  `TOKEN_CHASE_CAPTURE=true` is in their environment; the flag is read once at startup, so changing
  it needs a restart. The shipped local compose stack already sets it to `true` — put
  `TOKEN_CHASE_CAPTURE=false` in `.env` to switch capture off — while a bot started without the
  variable at all captures nothing. With capture off, the Runs column stays on the "No captured runs
  yet" card (whose step 1 is exactly this flag) and the demo comparison is what you can explore.
- **It does not re-route traffic by itself.** There is no background learner picking cheaper models.
  The one thing that changes how a bot actually runs is ticking the apply-to-bot-config box on a
  promotion you make yourself. The operator-gated automatic keep-winner pass
  (`TOKEN_CHASE_AUTO_PROMOTE`, off by default, does nothing at all when unset, and only runs at the
  end of a whole-run savings loop) promotes baselines *inside this screen* — it never pushes a bot
  config.
- **Reverting does not roll back a bot config push.** Revert flips the promotion to `reverted` so the
  call falls back to its captured baseline; the row stays listed and the revert itself is *added* to
  the audit trail — nothing is erased. If you also applied the winner to the bot's configuration,
  change that back through the bot's provider settings.
- **The spend ceilings are real, but not all of them apply on this screen.** Every **▶ Run** is
  checked against the platform's own budget governance before it spends, and a tripped operator cap
  or runaway halt refuses the replay instead of running it. The per-run replay ceiling
  `TOKEN_CHASE_BUDGET_USD` (default $25 when unset) and the judge-grading ceiling
  `TOKEN_CHASE_JUDGE_BUDGET_USD` (default $5 when unset) accumulate across a **whole-run savings
  loop**, which is an API call and not a button here — each **▶ Run** you click starts its own count,
  so those two ceilings will not stop it on their own, and **Replay determinism check** consults no
  Token Chase ceiling at all. Treat every button on this page as real money.
- **There is no one-click "optimize this whole run" button here.** You work call by call with **▶ Run**
  and **▶▶ Run all available lanes**. Replaying every frame of a run in one pass, and the forward tail
  replay, are available through the Token Chase API, not from this screen.
- **It does not show other people's calls.** You see your own captured calls plus calls with no
  recorded owner. An operator can list specific accounts in `TOKEN_CHASE_ADMIN_SUBS` to give them a
  view across everyone's captured calls; there is no other way to widen that scope.
- **It does not keep variant response text.** Recorded results hold metrics. To read a lane's output
  again, re-run that lane.
- **The quality bar is a quality gate, not a spend gate.** Raising or lowering the bar in the savings
  report changes what counts as "held"; it does not change what anything cost.

## If something looks wrong

**The provider dropdown says "no connected providers".**
This instance has no LLM login your account can use for a replay. Add an API key in Settings, or
connect one under **Connections → Bring Your Own LLM**, then reload the surface. **▶▶ Run all
available lanes** also stays disabled until there are at least two lanes to compare.

**A lane row reads `failed: Token Chase budget exhausted — the variant replay was not run.`**
That is the spend gate, not a failure, and nothing was spent. On this screen the refusal comes from
the platform's budget governance — an operator hard cap or the runaway halt — rather than from the
per-run `TOKEN_CHASE_BUDGET_USD` ceiling, which only accumulates inside a whole-run savings loop.
Wait for the budget window, or ask an operator about the platform budget caps.

**"Promote winner" is nowhere on the frame.**
The keep-winner panel appears once the call has at least one recorded result, and it is built when
the frame loads. Run a variant with the Optimizer panel, then re-open the frame (click it again, or
step away and back) — the recorded-results table and the panel will both be there.

**Promote answers "NO WINNER" even though a lane was clearly cheaper.**
Read the rejection table. The two usual causes are a `lexical-fallback-judged` grade — the judge lane
was unavailable when you ran it, and a proxy score is never allowed to re-baseline a call, so re-run
the lane once the judge lane is back — and `below-quality-bar`, where the cheaper answer did not hold
up on quality.

**"Recorded results are unavailable right now."**
The captured call above is still complete; the stored history could not be read this time. Reload the
frame. If it persists, the recorded-results store is having trouble — the captured payload and the
Replay/Optimizer actions still work, but **★ Promote winner** lives inside that same block, so it is
gone until the read succeeds.

**Replay says "NO BOT NODE".**
A replay runs on an accountable bot node, never on the controller. If no worker bot is up, start one
and try again.

---

For the design rationale behind capture, determinism replay, the judged savings corpus and
keep-winner promotion, see
[ADR-046](../adr/046-token-chase-checkpoint-replay-optimization.md).

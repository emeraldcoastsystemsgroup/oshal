# Strategy log — every adjustment, and the backtest that justified it

The append-only record of production trading-config changes and the backtest evidence behind
each one. **Rule (operator, 2026-07-10): no config change without a row here, and no row
without fixed-harness numbers.** Newest entries at the bottom.

> ⚠️ **Numbers dated before 2026-07-09 are void.** The walk-forward harness had a critical bug
> (`resample()` fed the engine time-reversed weekly/quarterly views — ~60% of the score and the
> entire regime gate) fixed in `cad41dc5`. This includes the "aggressive +19.7% beat SPY +8.2%"
> claim still visible in [advisor.md](./advisor.md) — kept there as a historical artifact.

## Harnesses (all reuse the live engine's pure functions; fills at daily close, no slippage)

| Script | What it varies | Window |
|---|---|---|
| `scripts/oshal-trading-backtest.ts` | posture (original harness) | ~150d (barsBatch cap) |
| `scripts/oshal-trading-core-blend-backtest.ts` | + SPY core %, take-profit override | ~150d |
| `scripts/oshal-trading-gap-stop-backtest.ts` | + exit execution (close vs venue-resident), multi-horizon tails | ~548d (direct OHLC fetch) |
| `scripts/oshal-trading-rotation-backtest.ts` | the rotation sleeve (production `rankUniverse`), rank/cadence/topN/weighting | ~548d |
| `scripts/oshal-trading-adx-exhaustion-backtest.ts` | trend-exhaustion exits (ADX/RSI gate) — event study + matched random-time control, then a 6-book walk | ~1290d (deep OHLCV) |

## The log

### 2026-06-22 — initial deploy: scan sleeve, `balanced` → `active` posture
Multi-timeframe scan sleeve (decideSymbol + money manager). `active` posture adopted 06-23 for
The operator's downside-first mandate. Evidence at the time: broken-era harness (void).

### 2026-06-30 — gravity sleeve rotation enabled (`TRADING_SLEEVE_ROTATION=true`, blend/1d/top12)
**Deployed with no backtest** (the rotation path wasn't testable until 2026-07-10). In
hindsight: paper equity peaked this exact day; July bled while SPY rallied. Root causes found
07-10: (a) the active posture's 3% per-name cap × top-12 bounds the rotation book to ~36%
deployed — structural cash drag in a rally; (b) the July stretch was a genuinely bad regime for
fast rotation (confirmed by sim: the same config loses the last-5d window too).

### 2026-07-07/08 — incident fixes (not strategy changes)
Stranded-sell lockout (`freeStaleSells`), stale-print ext-hours decline, live cap scoping,
request-id book scoping. See the change logs in `trading-schedule-dispatch.ts`.

### 2026-07-09 — CRITICAL harness fix voids all prior backtest numbers
`resample()` time-reversal (`cad41dc5`). Corrected 5.5-year verdict: engine +55.5% total,
Sharpe 1.02, maxDD −10% — beats SPY risk-adjusted, lags absolute (~9%/yr vs ~11%).

### 2026-07-10 (afternoon) — sweep #1: posture × SPY-core × take-profit (27 runs, 150d window)
Incumbent (active/no-core/tp8): **+4.9% vs SPY +9.7%** — churn from clipping winners at +8%.
Winner **active/core35/tp25**: +8.1/8.0/12.3% across three window starts, DD ~4.5%, Sharpe
1.9–4.6. Armed at ~16:20 CT with `TRADING_SLEEVE_ROTATION=false` (rotation was unbacktested).
Levers shipped: per-symbol core targets (`SPY:35,SKHYV:0`), `TRADING_TAKE_PROFIT_PCT`.

### 2026-07-10 (evening) — sweep #2: venue-resident stops → verdict WEAK, not built
548-day OHLC harness, close vs venue execution, 4 configs × 4 window starts. 7-pair average
**−1.0pp return / −0.02 Sharpe / +0.8pp DD**; wins don't survive a realistic gap-fill haircut.
First-print exits lock in whipsaw ≈ as often as they save bleed. BACKLOG holds the
tail-insurance-only residual case. **Do not rebuild on performance grounds.**

### 2026-07-10 (evening) — sweep #3: ALL implemented strategies × 5 horizons (18 configs)
The first-ever rotation backtest (production `rankUniverse` exported). Findings:
- **Rotation alpha is real**: gravity/momentum/blend independently cluster at **+8 to +10 pts
  over SPY at 126d** (ensemble dilutes it); deployment scales it linearly; top-20 scales too.
- Judged best row on the board: **rotation-gravity/1d/top12/active** — +38.1% full-window
  (beats SPY +37.6), maxDD 6.8%, Sharpe 2.36, and beats SPY at 21/63/126d.
- Full-deploy variants (aggressive 10%/name): blend **+117.9%**, momentum +70.0% — but DD
  19.9–27.2% and −4%+ weeks. Rejected for DD discipline.
- July reconciliation: rotation also loses the last-5d segment in sim (−1.5% vs SPY +1.35) —
  the live July bleed was regime, not a broken strategy. Turning rotation off in sweep #1's
  aftermath was premature; this sweep reversed it.
- The "beat SPY by 30–40%" memory: traces to the void July-4 numbers; coincidentally, only the
  full-deploy aggressive rotations actually deliver that margin on the fixed harness (at 2–3×
  the drawdown).
- Harness note: at active posture the 3% per-name cap binds before conviction weighting can
  differentiate — `equal` and `conviction` produce identical books at cadence 5 (not a bug).

### 2026-07-10 (~18:10 CT) — ARMED: "gravity + core" + universe 106 → 140
- `TRADING_SLEEVE_ROTATION=true`, `TRADING_ROTATION_RANK=gravity`, cadence 1, top-12,
  posture `active` (sleeve structurally ≤ ~36% deployed).
- `TRADING_CORE_SYMBOLS=SPY:60,SKHYV:0,SKHY:0` — the cash the sleeve never touches becomes a
  held SPY core; `:0` names stay exemption-only holds (the SK Hynix IPO position).
- `TRADING_TAKE_PROFIT_PCT` unset — the rotation rows were tested with posture-default exits;
  the tp25 evidence belongs to the scan sleeve only.
- Universe: +34 up-and-comers (AI/semis, growth software, fintech, consumer growth,
  defense/space, AI-power; new `industrial` + `ai-power` sector buckets; world-pulse press
  names shipped same commit). Validation on the 140-name pool: gravity sleeve **+38.6%
  full-window / +20.9% vs SPY +10.1% at 126d / beats SPY at 21d and 63d too**; maxDD 10.2%
  (up from 6.8 — the newcomers are more volatile), Sharpe 2.09.
- Expected combined shape: sleeve alpha on ~36% + SPY beta on ~60% ≈ SPY + 8–10 pts/126d at
  a blended DD estimated 9–13% (assume up to ~15% out-of-sample; single-regime caveat: all of
  this is one AI-led bull tape, and the alpha lives in DAILY rebalancing — slippage-sensitive).
- Live-book note: the SKHYV hold (~40%) displaces most of live's SPY core until it converts /
  is trimmed; paper is the clean reference for the combo.

### 2026-07-10 (night) — sweep #4: pop-catcher intraday test → verdict REJECT, not armed
First-ever intraday (5-min tape) test: `scripts/oshal-trading-pop-backtest.ts`, last 7 trading
days (07-01 → 07-10), production rule + threshold/exit sweeps (7 runs). Findings:
- **The entry signal has no discrimination**: ~40 names qualify per 5-min step (21.9K signals/wk,
  ~99.9% skipped because the 5 slots are permanently full); thresholds 0.34 and 0.6 produce
  byte-identical trades. It samples market noise, not surges.
- Production dials: +$53.64/week on a $100K book, avg hold 2.2 DAYS (not fast). Best variant
  (thr 0.8, tp 3%/stop 2%/out-by-day): +$224/week, ~0.25%/trade after slippage — the only run
  clearing the cost bar, on one bullish week, with only 16% take-profit exits (36% drift-riding
  time-stops) and overnight carries the time-stop didn't prevent (late entries gap past it).
- Judge: statistically indistinguishable from long-beta noise; plausibly negative in a flat week.
  **Fix is signal rework** (a selector that thins 20K/wk to a handful + hard session-end close),
  not dial tuning. Arming bar (if ever): ≥4 paper weeks incl. a non-bull week, ≥200 trades,
  ≥0.4%/trade gross, no overnight carries, skippedFull <20%, net ≥0 in the flat week.
- `TRADING_POP_CATCHER` stays **false**.

### 2026-07-10 (late night) — pop MISS AUDIT: what a news-aware detector would need
`scripts/oshal-trading-pop-miss-audit.ts` — top-25 intraday surges (≥2.5%/30min) of the last 7
sessions, joined against world_items as-of each move. Findings (evidence for the EVENT-pop build):
- **Coverage hole (fixed going forward):** 13/25 surges were in the 34 names added to the world
  index only tonight — zero news history before today, so their "no news" rows are blind, not
  bearish. The expansion closes this from Monday.
- **Count-velocity is the WRONG axis:** the burst gate (items ×2 baseline) caught 0/25. Mega-caps
  run 100-870 items/day at baseline; the real events hid inside normal volume: MRNA FDA-approval
  headline **66 min before** an +11.9% surge (ratio 0.4!), META $9B-datacenter headline 13 min
  before +7.2%, INTC/AMD/QCOM headlines 2-9 min before their moves. **The signal is headline
  MATERIALITY** (event class × direct-subject proximity × dollar size vs market cap × outlet
  reliability) — one headline, read correctly, was worth more than every count metric we store.
- **Price-only pop confirmed blind:** fired on 6/25 at thr 0.34; 19/25 surges had NO warning from
  either system as built.
- **Tape-quality trap:** several "surges" (LRCX/KLAC +10%/30min on 07-08 with the day NEGATIVE)
  are IEX thin-print artifacts clustering 15:35-15:55 ET — any detector needs VOLUME confirmation.
- **Blocker:** WORLD_CLASSIFY_DISABLED=true — headline classification is off, and materiality
  scoring needs classification AT INGEST (5-min pulse), not the batch path. Sizing adjustment per
  operator: tranche scales with materiality (size-of-story / effect / proximity), capped ~3×.
No config armed; this row is the evidence record for the BACKLOG EVENT-pop design.

### 2026-07-11 (early AM) — sweep #5: news-materiality blind-forward test → deterministic scorer KILLED
`oshal-trading-news-materiality-backtest.ts` — the tier-3 event-pop design, blind-forward over 18
trading days of real world_items headlines (388K streamed, pub_date-ordered, next-bar entries,
5-min latency) × the real 5-min tape. Chain of evidence:
- **v1 scorer:** −$1,481. Trade list exposed 4 defects (listicle false-M&A, seeks≠approval,
  acquirer-side buys, overnight-gap cohort). Fixed in v2.
- **v2 full window (6-config sweep):** classification genuinely improved (like-for-like loss
  halved, WR 32→39%) but best config (thr 0.7, RTH-only, scaled) made only **+$96 on 89 trades
  ($1.08/trade — under the 0.2% slippage bar; 53% WR = <1σ from coin flip)**.
- **v2 CLEAN PERIOD (Jun 16–Jul 3, cutoff arg, keywords untouched by this stretch): −$228 on 49
  trades.** The full-window profit was entirely the tuned week. Judge's pre-registered kill
  condition triggered: **no shadow mode, no capital — the keyword-regex materiality approach is
  dead.**
- **What SURVIVED as durable findings:** (1) never hold news trades overnight — RTH-only was
  better in every one of 7 runs; (2) "big dollar figure in headline" is a NOISE class — negative
  in all 7 runs (−$60..−$430), and it was 55% of volume; (3) M&A-target + approval are the only
  classes positive in all full-window RTH configs — downgraded to hypothesis after the clean-period
  tiny-n result (+$12/+$25); (4) aggregator pub_dates lag the original wire — a structural edge
  eater the Google/Bing scrape cannot fix.
- **Surviving path (BACKLOG updated):** structurally-material feeds first (SEC 8-K stream, DoD
  daily contracts — importance by definition, precise timestamps), the Benzinga/Alpaca wire we
  already have keys for (tier 2), and an LLM reader instead of regexes — pre-registered on the
  M&A-target/approval hypothesis, RTH-only, judged against the sweep-#4 arming bar.
No config armed. TRADING_POP_CATCHER remains false; nothing news-driven trades.

### 2026-07-12 — ⚠️ SURGE DETECTOR BUG: the pop research was measuring OVERNIGHT GAPS. All pop-era conclusions VOID.
`scripts/oshal-trading-pop-miss-audit.ts` `findSurges()` filtered bars to RTH and then compared them
by **array index** (`bars[i]` vs `bars[i-6]`). The RTH filter *deletes the overnight bars*, so
adjacent array slots straddle a session boundary — and an **overnight gap was reported as a
30-minute intraday surge.** Proven on MU: the audited "+8.27%/30min surge" is an **18-hour gap**
(07-08 15:50 ET $948.59 → 07-09 09:50 ET $1025.31). This is why every audited surge clustered at
**15:35-15:55 ET** — those are the last bars of a session, and the "next" array slot is tomorrow.
**Same bug class as the `resample()` time-reversal (`cad41dc5`) that voided the pre-07-09 numbers.**

**Second defect, independent:** the pop work ran on **`feed=iex`** — roughly **2% of consolidated
volume**. On the real tape MU moved **+0.03%** over the hour IEX showed as **+0.58%** (9.0M shares
vs IEX's 189K). **The paper key carries full SIP entitlement** — verified live 2026-07-12 — so there
was never a reason to hunt surges on the thin tape. The audit's "IEX thin-print artifact" note was
directionally right and *understated*: it wasn't a few names, it was the whole dataset.

**VOIDED by this (do not cite):** the 2026-07-10 pop-miss audit's headline conclusions — "19/25
surges had no warning", "count-velocity caught 0/25", the top-25 surge list itself, and the
inference that *headline materiality* is the axis. They were computed over overnight gaps on 2% of
the tape. The *sweep #4* REJECT of the price-only pop-catcher stands on its own (no discrimination,
21.9K signals/wk) and the *sweep #5* KILL of the keyword-regex scorer stands (clean-period −$228).

### 2026-07-12 — news-wire RECALL test on the corrected tape (the gate before any LLM reader)
New: `scripts/oshal-trading-news-wire-recall.ts`. Bypasses the scraped `world_items` entirely and
asks **Alpaca's Benzinga wire** (real publisher timestamps, keys we already own) whether a headline
about the name existed *before* each surge. Motivated by a measured killer: **`world_items` has a
median detection lag of 5.3 HOURS** (84,342 items/7d; p25 37min · p50 320min · p75 777min · p90
2,941min) while these moves complete in minutes. *No reader, however good, can trade a 5-hour-old
feed.* Evidence: news-wire-recall-2026-07-12.md.

Corrected surges (SIP tape, same-session contiguous window) are **real intraday moves of ~3.5-4%**
clustered at the **open**, not phantom 8% moves at the close. Recall against the wire:

| Lead time | Surges with a prior headline |
|---|---|
| ≤ 5 min | 3/25 (12%) |
| ≤ 30 min | 6/25 (24%) |
| **≤ 60 min (actionable)** | **7/25 (28%)** |
| ≤ 24 h | 16/25 (64%) |
| no news at all | 9/25 (36%) |

**Verdict: MARGINAL** (pre-registered bar was ≥30% to PROCEED). But the *content* of the leading
headlines is the real finding, and it is **not** the class the old work chased:
- **RKLB** — "B of A Maintains Buy, **Raises Price Target**" — 60 min ahead.
- **KLAC** — "Cantor Fitzgerald Maintains Overweight, **Raises Price Target**" — **5 min ahead**.
- Noise, clearly separable: listicles ("…And Other Big Movers"), and *reactive* stories that
  post **after** the move ("What's Going on With AMD Stock Monday?", 107 min "lead").

**New hypothesis (pre-register before testing): ANALYST ACTIONS — upgrades and price-target raises —
are the recurring pre-move class**, not M&A/approval. Narrow, structured, and machine-readable.
Nothing armed. `TRADING_POP_CATCHER` remains false.

### 2026-07-12 — scope of the IEX defect: DAILY work is SAFE, INTRADAY work is not
Before anyone over-corrects and voids good numbers, the divergence was measured directly
(NVDA, 07-01 → 07-10, `adjustment=all`):

| Timeframe | IEX vs SIP | Consequence |
|---|---|---|
| **1Day closes** | max **0.16%**, typically **0.02%** | **The rotation backtest and the live engine's daily signals are NOT materially affected. The armed config's evidence (+20.9% vs SPY +10.1% @126d, Sharpe 2.09, maxDD 10.2%) STANDS.** |
| **5Min bars** | MU: 189K shares vs **9.0M**; +0.58% vs **+0.03%** | **All intraday/pop research on IEX is invalid.** |

Why: the daily bar's close tracks the consolidated close closely, but a 5-minute IEX bar samples
~2% of the tape and its prints wander. **Rule going forward: daily-timeframe work may stay on IEX;
anything intraday MUST use `feed=sip`.**

**Open, unresolved (flagged 2026-07-12):** `/v2/stocks/{sym}/trades/latest?feed=iex`
(`market-data.ts:306` — the *live pricing* path) returned **403 Forbidden** on both `iex` and `sip`
with the paper key during this check. Either the entitlement differs for the latest-trade endpoint
or the call is failing silently in production. **This prices live orders — verify before the next
live session.** Logged in BACKLOG.

### 2026-07-12 — the 403 was MY probe, not the engine. But it exposed a real structural defect.
**CONFIG CHANGE: `TRADING_EXTENDED_HOURS=false`** (was unset → defaulting to **true**).

**The 403 is closed — not a bug.** `trades/latest?feed=iex` (the production path) returns **200**.
The 403 fires only on `feed=sip`, with the message `"subscription does not permit querying recent
SIP data"` — I had exported `ALPACA_DATA_FEED=sip` for the recall audit. The live pricing path never
touched SIP. **But the entitlement it revealed matters: the paper key gets SIP *historical* (which is
why the recall backtest worked) and NOT SIP *real-time*. So "move everything to SIP" is true for
backtests ONLY — live pricing cannot leave IEX without a paid plan.**

**What that surfaced instead: IEX is a VENUE, and it operates 08:00–17:00 ET.** Print coverage,
measured over 07-08/09/10 × 18 symbols (share of consolidated symbol-minutes with an IEX print):

| ET hour | IEX coverage |
|---|---|
| 04:00–07:59 (pre) | **0.0%** — zero prints, 8,854 consolidated |
| 08:00 | 5.6% |
| 10:00–15:59 (regular) | **85–93%** — healthy |
| 16:00 | 1.3% |
| 17:00–19:59 (post) | **0.0%** — zero prints, 5,388 consolidated |

Extended-hours orders are converted to a **marketable limit priced off `latestTrade()`**
(`trading-routes.ts:139-161`). Outside 08:00–17:00 ET **there is structurally nothing to price them
against.** Confirmed in the order ledger (not inferred):

| session | orders | fill rate |
|---|---|---|
| REGULAR 09:30–16:00 | 390 | **97%** (live: 95.5%) |
| EXTENDED (all) | 593 | **10.8% — 529 never filled** |
| 17:00–19:59 | 89 | **0.0%** |

The 2026-07-08 staleness guard already stopped the bleeding (ext orders/day **434 → 1**), but it does
so by *declining*. This change makes the intent explicit: the engine no longer burns 5-min fires on
pre/post orders that cannot be priced, and the 1–2/day that still slipped through — priced off the
**thinnest, most divergent prints available** (16:00 ET, 1.3% coverage) — stop too.

**Blast radius: none on live.** All 66 live orders were regular-session (95.5% filled); the live book
never placed an extended-hours order. The 529 dead orders were entirely paper.

**Secondary measurement (why the 16:00 stragglers were the worst ones to keep):** IEX-vs-consolidated
divergence on the last RTH minute is a median of **5.6 bps** — but the tail runs to **RGTI 54 bps,
SOUN 45, IONQ 30, SMCI 29**, exactly the thin, volatile names rotation selects. The ext-hours slippage
buffer is **30 bps** (`TRADING_EXT_LIMIT_SLIPPAGE_PCT`), so a 54 bps adverse divergence produces a
**non-marketable limit that never fills** — the MRNA cancel/re-place failure mode, but caused by *feed
divergence* rather than a stale print, which the 07-08 staleness guard does **not** catch. Now moot
while extended hours is off; **re-check this before ever turning it back on.**

**Kill condition / reversal:** re-enable only with real-time SIP (Alpaca Algo Trader Plus, ~$99/mo).
If re-enabled on IEX, expect ≤11% fill outside RTH. Regular-session behaviour is unchanged.

### 2026-07-12 — flat-overnight ("sell at close, re-enter at open") KILLED at the market-structure level
Operator proposal after the ext-hours shutdown: dodge overnight kills by going flat at every close.
Decomposition added to the gap-stop harness (daily OHLC, valid on IEX per the 07-12 scope ruling),
~25-month window: **SPY total +41.4% = overnight +33.2% + intraday +6.1%.** Five-sixths of the
market's entire return accrues close→open — overnight is where the RETURN lives, not just the risk.
After the 0.2%/day round-trip cost of exiting every close and re-entering every open, the
intraday-only holder compounds to **−62.1%**. Combined with sweep #2 (dodging gaps costs ≈ what it
saves), the overnight-avoidance family is closed: ride the overnight, protect from 9:30, size so a
gap can't kill the book. No config change.

### 2026-07-13 — advisor universe brought current: 101 → 140 (operator-approved); Strategy Lab leg activated
Found during the ADR-092 Strategy Lab live proof: the RUNNING per-user advisor schedule still
carried the 101-name universe it was created with, while the armed config of record (2026-07-10
sweep #3, universe expansion 106 → 140 in commit 055b1212 + the 07-10 SECTOR additions) says 140 —
the schedule's `taskData.universe` is frozen at enable time and nobody had re-enabled since the
expansion. Operator approved on 2026-07-13 ("yes we should have the expanded universe");
re-enabled via POST /api/trading/autopilot with defaults: **universe 140, cron unchanged
(*/5 RTH loop)**, all legs recreated, and the new seventh leg `trading-lab:<sub>` (nightly
21:45 UTC weekdays) is now active — every saved lab strategy forward-walks after each close and
the armed baseline is regression-replayed (drift tolerance 0.5 pt return / 0.5 pt maxDD / 3
trades). Evidence for the 140-universe shape is sweep #3 itself (it ranked the 140-name universe);
the lab's pinned-baseline run (452 sessions, +36.41% vs SPY +35.36%, Sharpe 1.47, maxDD 13.9%,
feed=sip) now regression-locks the engine's behavior on exactly those names.
**Kill condition:** if the expanded names degrade the live rotation (new-sector crowding, thin
fills), shrink via TRADING_SYMBOL_BLOCKLIST or re-enable with an explicit universe — either way,
new row here.

### 2026-07-13 (~12:40 CT, intraday) — schedule universe pins REMOVED (live traded the open on the old 101 pool)
Found by the pre-market audit, confirmed at the open: the scheduler pins `taskData.universe` at
schedule-creation time and dispatch prefers the pin over `DEFAULT_UNIVERSE`. The paper legs had
been re-armed at 140, but the **live** autopilot row still pinned the pre-expansion **101** pool
(trading-swing was on an even older 100). Result at the combo's first open: paper rotated the
140 pool (HOOD/ANET/DASH/AXON/AFRM entered) while live rotated the 101 pool
(META/DHR/BAC/AMAT/PANW/GE/ABBV/TMO/IBM) — the books diverged.

**Operator-approved fix:** removed the `universe` key from all 9 `oshal:scheduler:schedule:trading-*`
Redis rows; every leg now falls back to `DEFAULT_UNIVERSE` (140) and auto-tracks future universe
changes (a `POST /api/trading/autopilot` re-arm would re-pin statically — prefer editing
DEFAULT_UNIVERSE). Crons/cadence untouched; effective at tomorrow's rotation (today's daily
rotation already ran). XOM/CVX are in the 140 pool, so a persistent oil move (today's Hormuz
spike) can now gravity-rank into the live book.

### 2026-07-14 — analyst-actions event study (pre-registered 07-12) → verdict KILL
`scripts/oshal-trading-analyst-actions-study.ts` — 12 months of the Benzinga wire × the 140-name
universe: 51,037 items → 7,491 classified → **4,600 deduped events** (pt-raise 2,597 · pt-cut 1,174 ·
upgrade 404 · downgrade 221 · initiations 204). Entry at the first post-publication close,
market-adjusted 1/5/25-session drift, **same-symbol seeded permutation null** (1,000 iters),
date-split robustness, Bonferroni/6. Evidence:
analyst-actions-study-2026-07-14.md.
- **The trap the null caught:** raw means LOOK tradeable (pooled-UP +0.23% @5d, +1.23% @25d) — but
  random entry times on the SAME symbols produce equal-or-larger means 99.5–100% of the time
  (p=0.995/1.0). The momentum-selected universe beats SPY at random times; the analyst event adds
  ~zero incremental information. A naive study would have shipped this as "+1.2% alpha."
- Date halves DISAGREE on 5/6 cells (first half negative, second positive — regime, not signal).
- No contrarian edge either: downgrades ran POSITIVE +0.56% @5d (n=216, p=0.20).
- **KILL per the pre-registered rule.** No sizing overlay on analyst actions. What remains: the
  deterministic classifier (`classifyAnalystHeadline`, unit-tested) + the event-study harness —
  the reusable template for the NEXT event stream (earnings/FOMC/jobs; the forward calendar is
  already ingested in `world_events`, the missing input is a consensus/surprise source).
No config change; nothing armed.

### 2026-07-14 — news-READER gate study (LLM materiality reader) → no edge; and the WIRE-CEILING diagnostic that explains it
Two runs, same 30-day window, same corrected-SIP surge set (206 surges, **132 volume-confirmed**).

**1. The reader** (`scripts/oshal-trading-news-reader-gate.ts` — the sweep-#5 surviving path: stage-1
deterministic prefilter + an LLM materiality reader, batched strict-JSON, replayed offline):
3,994 wire items → 3,342 kept → 372 material → **120 deduped clear-direction alarms (6.3/day)**.
The *volume* problem is solved (sweep #4's 21,900 signals/week → 6/day). The *signal* is not:
- **Recall: 1/132** volume-confirmed surges had a material UP alarm ≤60 min before the move (5/132 ≤24h).
- **Capture: +0.02%/trade** over 120 alarms (1-bar latency, +3%/−2% brackets, flat by close), 47% win,
  18% follow-through ≥1.5% within 2h. Zero, and negative after the 0.2% slippage bar.

**2. Why — the wire-ceiling diagnostic** (`oshal-trading-news-wire-recall.ts` re-run over the same
window, top-60 surges): **13/60 (22%) have ANY headline ≤60 min before** — consistent with the 07-12
28% on top-25. **But the composition is the finding:** most of that 22% is **REACTIVE COVERAGE — the
wire reporting the move as it happens**: `AXON +3.9% — "…And Other Big Movers" (2 min)`,
`INTC +3.9% — "What's Going On With Intel Stock Friday?" (9 min)`, `MU +4.5% — "…Are Tanking On Korea
Selloff" (3 min)`. **These are unusable, and our prefilter correctly deletes them — which is exactly
why the reader's recall collapsed to 1/132.** The filter did not fail; it removed the fake signal that
made the raw recall number look tradeable. **The 22% ceiling is not a 22% opportunity.**
- Also: **25/60 surges had NO wire item at all in 24h**, and the pops cluster at the OPEN (9:30–9:40 ET
  for ~2/3 of them) — driven by overnight/pre-market information already in the gap.
- The only genuinely-LEADING machine-readable class left: **analyst PT-raises/upgrades** (INTC 47min,
  RKLB 60min, MRVL 51min, KLAC 5min). Tested separately (next row).
No config change; nothing armed. `TRADING_POP_CATCHER` remains false.

### 2026-07-14 — analyst intraday-POP test → KILL. **The event-pop family is CLOSED.**
`scripts/oshal-trading-analyst-pop-test.ts` — the last surviving hypothesis, isolated and tested
deterministically (no LLM): every UP analyst action (PT-raise / upgrade / bull initiation) published
9:35–15:30 ET over 60 days, entry ONE 5-min bar after publication (latency), +3%/−2% bracket on 5-min
closes, flat by the session close. Judged against a **same-symbol random-time control**, not zero.
Evidence: analyst-pop-test-2026-07-14.md.

| | value |
|---|---|
| trades | **318** |
| avg %/trade | **−0.023%** (win 49%, 27 targets vs 46 stops) |
| same-symbol random-time control | −0.012%/trade |
| **edge over control** | **−0.012pp** (p = 0.56) |

**It loses money, and it loses to buying the same names at random moments.** Before slippage.

**WHY — the finding that closes the family: analysts FOLLOW price, they do not lead it.** The
"leading" headlines are catch-up notes on stocks already running — the winners list is literally
`Wells Fargo Maintains EQUAL-WEIGHT on Texas Instruments, Raises Price Target` (a neutral-rated house
raising its target *after* the move). The 5–60 min "lead time" measured on 07-12 is real in wall-clock
terms and worthless in information terms.

**The event-pop family is now closed by five independent measurements:** sweep #4 (price-only
pop-catcher: no discrimination, 21.9K signals/wk) · sweep #5 (keyword-regex materiality: clean-period
−$228) · 07-14 reader gate (LLM materiality reader: recall 1/132, +0.02%/trade on 6.3 alarms/day) ·
07-14 wire ceiling (the 22% pre-surge "lead" is mostly REACTIVE coverage of the move) · 07-14 analyst
pop (318 trades, negative, loses to random). **Do not reopen without a genuinely new information
source** (a structurally-material, timestamped feed that PRECEDES price — e.g. the SEC 8-K stream or
DoD contract awards — not a commentary wire).

**What survives and is worth having:** the deterministic classifier + the noise prefilter (which
*works*: 21,900 signals/week → 6/day) + the event-study harness with the same-symbol permutation null.
That null is now house doctrine: **no event claim ships without beating a same-symbol random-time
control.** Nothing armed; `TRADING_POP_CATCHER` remains false. The remaining fundamental-overlay path
is the SCHEDULED-event one (earnings/FOMC/jobs — known in advance, no latency race), which none of
this touches.

---

## 2026-07-14 — ROTATION ENTRY GUARDS (`TRADING_ROTATION_MAX_GAP_DOWN_PCT=8`, new)

**Trigger — a live bug, not a study.** At today's 09:30 live open the autopilot **stopped IBM out at
−23.8% and re-bought it in the same fire** (sell 5 @ stop → buy 1 @ $225.82). IBM had pre-announced a
Q2 revenue miss and gapped ~22% overnight — its worst day since 1961.

**Root cause — two independent holes, neither of them a news problem:**
1. **The stop was not respected by rotation.** `runAutopilot` builds an `exiting` set for the
   protective leg (stop/TP/trailing) and then **never passed it to `rotateSleeve`**. Rotation had no
   idea the stop was selling IBM, so it happily re-bought it. This voids the stop *and* books a wash
   sale (a loss sale re-bought within 30 days is disallowed for tax).
2. **The ranker is blind to today's gap.** It scores on `1Day` closes, which **predate** the gap — so
   IBM still ranked top-12 on yesterday's data while it was down 22% in front of us.

**Change.** New pure module `src/features/trading/services/entry-guards.ts`, applied to **both**
rotation paths (`rotateSleeve` + `rotateBlendSleeve`). The leaderboard is now split:
- **HOLD set (drives drop-out sells) — unchanged and deliberately UNGUARDED.** Guarding it would make
  rotation place a *second* full-qty sell on a name the protective leg is already exiting (a double
  sell), and would force-sell a held gap-down name that the stop should be the one to judge.
- **BUY set — guarded.** `entryBlock` refuses a candidate that is (a) `exiting-this-fire`, or
  (b) `gap-down` ≥ `TRADING_ROTATION_MAX_GAP_DOWN_PCT` below its **prior-session** close. Refused
  leaders **backfill from the next-best candidate**, so a block costs the sleeve no deployment
  (honoring the 2026-07-07 lesson: an open that buys nothing burns the day's only buy window).

Prior close comes from the **dated** daily series (`barsBatchSince`), not the plain close series — the
last element of the latter is today's own forming bar mid-session, which would compute the gap as ~0
and no-op the guard on exactly the day it matters. **Fails OPEN** on missing data.

**Why this is not a re-opening of the closed event-pop family.** That family died because a *commentary
wire* does not precede price. This guard reads **no wire and no LLM** — it is price-only and
deterministic. A gap cannot lag price; it **is** price. It makes no claim that gaps mean-revert or
continue; it only refuses to let a ranker buy on a price that no longer exists.

**Setting:** `TRADING_ROTATION_MAX_GAP_DOWN_PCT=8` (default 8 in code; `0` = OFF). Applies to LIVE and
PAPER identically. Protective exits are unaffected in both books.

**Tests:** `tests/unit/trading-entry-guards.spec.ts` — 28 cases, incl. the IBM fire reproduced
end-to-end. Typecheck clean.

**Open / not done:** the ledger did **not** reconcile 2 of today's 20 live fills (IBM sell 5, ANET buy
8 sat at `accepted` while Schwab showed them filled), so today's realized number understates the loss.
That is a separate reconciliation bug — **not** fixed here.

### 2026-07-14 — EARNINGS-PROXIMITY study → **GATE** (the first scheduled-event rule the evidence earned). Built, flag-gated, NOT armed.
`scripts/oshal-trading-earnings-proximity-study.ts` — the first SCHEDULED-event test, and the path that
survives the event-pop closure: a **calendar, not a latency race** (we know the date months ahead, so
there is nothing to race). Needs **no consensus data**. 505 earnings events / 12 months / universe 140,
Nasdaq calendar × SIP dailies, market-adjusted, judged against the **same-symbol random-time control**
that killed every other candidate. Evidence:
earnings-proximity-2026-07-14.md.

| window | n | mean | stdev | 5th pct |
|---|---|---|---|---|
| **THROUGH the print** (−2 → +2 sessions) | 505 | **−0.070%** | **9.64** | **−14.07%** |
| same names, **random 4-session hold** | 505 | +0.132% | 5.11 | −7.50% |
| AFTER the print (+1 → +6) | 505 | −0.521% | 5.80 | — |

**Holding through a print costs 1.89× the volatility and 1.87× the left tail, and pays LESS than
random (−0.20pp, p=0.81).** It is **uncompensated risk** on a binary event we can see coming. Note the
post-print drift is *also* negative (−0.52%) — there is no "buy the reaction" consolation either.

**BUILT (flag-gated, default OFF — nothing armed):** `TRADING_EARNINGS_GATE=true` +
`TRADING_EARNINGS_BLACKOUT_DAYS` (default 3) → names printing inside the window are added to the
no-buy set at **all three entry points** (scan / rotation / blend), exactly like the operator
blocklist. **Exits are never gated** (you always get to leave), and a held name that drops off the
rotation leaderboard is sold — which *is* the "don't hold through the print" rule. Reads the world
calendar we already ingest (68 earnings in the next 30 days). World layer off / read fails → empty set
→ today's behavior exactly.

**Arming decision (operator):** flip `TRADING_EARNINGS_GATE=true`. Expected effect: fewer entries in
the days before a print; the sleeve rotates that capital into names without an imminent event. Kill
condition: if the gate measurably starves the rotation (entries down >25% with no DD improvement over
a month), turn it off and revisit with surprise scoring.

### 2026-07-14 — sentiment STRAINED (`sentiment_clean`) — the veto stops drinking reaction sentiment
The autopilot's only live world input is a sentiment veto/tilt, and it was computed over **every**
headline — including the reactive commentary the same-day wire-ceiling study proved is journalism
*about* a move ("What's Going On With Intel Stock Friday?"), not information. The world ingest now
writes **`sentiment_clean` in parallel** with `sentiment`: only headlines passing the shared real-news
gate (`src/shared/utils/headline-noise.ts`) contribute. **The baseline series is untouched** — the two
accrue side by side, so this is a live A/B. `TRADING_WORLD_SENTIMENT_CLEAN=true` (default false =
byte-identical) points the veto at the strained series. **Not armed:** flip it only after the clean
series has a month of coverage and a row here compares the two.

---

## 2026-07-14 (later) — FAIL CLOSED ON A BROKER POSITIONS-READ FAILURE

**Found while cleaning up after the IBM fix, and it is the bigger bug of the two.**

`runAutopilot` read the book with `broker.getPositions().catch(() => [])` — one line below the
account read, which *does* fail closed ("engine would size against $0; skipping this fire", added
after the 07-07 zombie fires). The positions read quietly did the opposite.

**Why an empty array is worse than a null account:** an empty book is a *legitimate* state, so the
engine cannot tell "the read failed" from "I am genuinely flat" — and on a failed read it runs the
**whole fire** believing it owns nothing:
- `ensureCore` sees `cur = 0` for SPY and **re-buys the entire core** with all available cash;
- `computeExits` has no positions, so **no stop-loss can fire**;
- `rotateSleeve` sees an empty sleeve and re-buys names already held.

**Live proof (today, 16:55 UTC):** a failed read topped the SPY core up by **14 shares (~$10.5K)**
against a real shortfall of **~$680**. Order rationale: *"Beta core — deploying idle cash into SPY."*
That single fire took the live core from **58.7% → 79.2% of equity**.

**Fix:** a throw is unambiguous where an empty array is not, so a failed positions read now **skips the
fire**, exactly like the account read. A genuinely-empty *successful* read still proceeds.

### Consequence still on the book (NOT auto-corrected)

The core is **exempt from sleeve sells** and `ensureCore` only ever *buys* — so **nothing will ever
trim the core back down.** The live book closed today at:

| | actual | design target |
|---|---|---|
| SPY core | **$40,592 — 79.2%** | 60% |
| active sleeve (7 names) | $9,760 — 19.1% | 40% |
| cash | $877 | — |

Restoring the 60/40 shape needs a **~13-share SPY trim (~$9.9K)**. That is a live order on a real
account and is **an operator decision, not a bug fix** — the sleeve it would refund is the same sleeve
running a 24% win rate and −$733 over 30 days, so "ratify the drift and stay 79% beta" is a defensible
answer too. **Left as-is pending the operator.**

### Correction to an earlier claim in this session

I reported a *ledger reconciliation bug* (2 of 20 live fills stuck at `accepted`). **There is no such
bug.** `reconcileOpenOrders` runs at the top of each autopilot fire and had simply not run yet when I
looked, ~2 minutes after the orders were placed. It caught up on the next fire. End-of-day the ledger
is **25/25 filled**, and realized today books correctly at **−$592.29** including IBM's **−$354.18**.

---

## 2026-07-19 — LIVE SIZING PRICES NOW COME FROM THE EXECUTING VENUE (data-integrity fix, not a strategy change)

**Found:** the LIVE book **sized off raw Alpaca IEX prices while executing at Schwab.** Three sizing
sites in `trading-schedule-dispatch.ts` called the raw `latestPrice` (Alpaca IEX) free function
directly — the core top-up (`ensureCore`) and both rotation `priceOf` closures (`rotateSleeve` +
`rotateBlendSleeve`, which additionally fell back to a stale Alpaca daily close when the tick was
missing). The `getMarketData(mode, sub)` seam (ADR-052, built 07-06) already routed the manual rail's
reads (`/quote`, `/recommendations`, `algoEnsembleDecision`) per book; the autopilot's sizing never
adopted it. Why it matters: the 2026-07-12 divergence study measured last-RTH-minute IEX-vs-consolidated
tails of **RGTI 54 bps / SOUN 45 / IONQ 30 / SMCI 29** — exactly the thin, volatile names rotation
selects — so live share counts were derived from a venue the order never touches.

**Change (deterministic plumbing only — no strategy logic, knobs, stops, or schedule pins touched):**
new exported `sizingPrice(mode, sub, symbol, fallbackClose?)` routes all three sites through
`getMarketData(mode, sub)` — Schwab quotes for the live book, Alpaca for paper. **Fail-closed for
live** (the 07-14 positions-read doctrine applied to prices): a name the executing venue cannot price
(read throws, or no positive price) is **SKIPPED for this fire with a log** — never silently sized off
the wrong venue, and the live path never uses the daily-close fallback. **Paper is unchanged:** Alpaca
feed first, and the rotation paths keep their daily-close fallback exactly as before.

**Blast radius:** sizing-input plumbing only; entry/exit *decisions* are untouched (the ranker's bars,
the scan, and the entry guards keep their existing feeds — `buildEntryGuard` stays deliberately
fail-OPEN per the 07-14 design). A Schwab data outage now means the live book skips affected names for
a fire instead of trading them on IEX prints — the safe direction.

**Guard:** `tests/unit/trading-sizing-venue.spec.ts` — proves live sizing reads the routed source (a
poisoned raw `latestPrice` is never consulted), a venue failure skips the name without killing the
fire, and paper behavior is byte-identical. Typecheck + trading unit corpus green.

---

## 2026-07-22 — "ADX ≥ 40 + RSI extreme → jettison the winner" — TESTED, REJECTED as an exit; the same gate is a REGIME-CONDITIONAL signal

**Claim tested** (operator-relayed, from a trader friend): RSI alone is a poor mean-reversion
trigger because a strong tape stays pinned high for weeks — but when **ADX ≥ 40** confirms a
genuinely extended trend, an RSI extreme marks *exhaustion*, so a profitable position should be
sold on the **first break** (indicator rolls over) and re-entered on a looser trigger if the trend
resumes.

**Harness:** `scripts/oshal-trading-adx-exhaustion-backtest.ts` (new). Needed a new data primitive —
`barsBatchSinceOhlcv()`, deep-history dailies that KEEP high/low, since `barsBatchSince` returns
closes only and the ADX/+DI/−DI family cannot be built from closes. Window 2021-06-01 → 2026-07-21,
1290 sessions, 136 names. **Pre-registered before the run:** ADX_HOT 40, RSI_HOT 75, MIN_GAIN +5%,
break = RSI ticks down AND lower close, re-entry = RSI back over 55 with +DI > −DI inside 15
sessions. No knob was searched. Wilder ADX cross-checked against the trusted ADR-096 shadow `adx`
indicator (27.09 vs 27 on AAPL; every sub-25 name correctly silent).

**Part 1 — event study (n=787 triggers), vs a same-symbol matched-count random-time control:**

| horizon | after the "exhaustion break" | random-time control | verdict |
|---|---|---|---|
| +5d | **+1.18%** | +0.86% | no reversion |
| +10d | **+2.24%** | +1.43% | no reversion |
| +20d | **+3.24%** | +2.66% | no reversion |

**The premise is backwards in aggregate.** Price after the break does not revert — it *rises*, and
slightly faster than a random day in the same name. Only 40-43% of events were negative. Ablations
(RSI-only n=1883, ADX-only n=1609) land on the control: **neither half of the gate carries an edge
on its own**, so the combined gate isn't adding one either.

**But the regime split is the real finding:**

| regime | n | +5d | +10d | +20d | vs control (+20d) |
|---|---|---|---|---|---|
| RISK-ON (SPY > 200dma) | 734 / 49 mo | +1.35% | +2.64% | +3.86% | +1.00 pts (t 1.24) |
| **RISK-OFF (SPY < 200dma)** | **53 / 13 mo** | **−1.11%** | **−3.31%** | **−5.32%** | **−7.29 pts (t −4.33)** |

In a risk-off tape the rule is not just right, it's *emphatic*: 75% of events negative at +20d, a
−5.2% median, and a 7.3-point gap under a control that was itself positive. **The friend's rule is a
bear-market rule that his (bullish) sample generalised into an always-on rule.**

**Part 2 — portfolio walk (6 books, identical entries/sizing/rotation, exit overlay only):** a null,
for a structural reason worth recording. Book B fired **24 rule-exits in 5 years across ~5,100
trades** (0.47% of eligible lot-days). Returns: A (live engine control) +77.9%, B +76.7%, C (+eased
re-entry) +80.9%, **D (random-time placebo at B's realised hazard) +80.2%**, E (RSI-only) +77.2%,
F (ADX-only) +79.8% — the placebo beat the rule, and the whole spread is noise. **Why so few
triggers: our engine's +8% take-profit and 5/3 trailing exit a winner long before a lot can sit at
≥+5% and then meet ADX ≥ 40 + RSI ≥ 75 + a break.** The rule was designed for a wide chandelier-ATR
trend book that holds for months; bolted onto this engine it is unreachable by construction.

**Decision: no live change.** Not adopted as an exit rule. Do not re-litigate the always-on version —
the aggregate reversion does not exist in this window.

**Open, NOT claimed as evidence:** the risk-off result is a *generated hypothesis*, not a validated
one — 53 events in 13 distinct months (≈2 episodes), and overlapping forward windows inflate those
t-stats. Testing "gate the exhaustion exit on SPY < 200dma" against this same data would be fitting
the split we just discovered. Done-when for a real answer: pre-register the regime-gated variant and
walk it on a window this study did not touch (pre-2021 tape, or a non-US universe).

---

## 2026-07-22 (later) — the ADX+RSI risk-off lead FAILED out-of-sample; it does not generalize

Follow-up to the entry above. The 2026-07-22 study left one open thread: the risk-off cohort (SPY <
200dma) looked strongly negative (−5.32%/20d, t −4.33), flagged explicitly as a *generated
hypothesis* needing an untouched window. Tested it. It failed.

**Method — same code, new data (the only honest OOS design).** Parameterized the harness (window +
feed via `ADX_START_ISO` / `ADX_REPORT_FROM` / `ADX_END_ISO` / `ADX_FEED` / `ADX_EVENT_ONLY`) so the
*identical* trigger, indicator and control code runs on a tape the discovery never touched. Needed
Alpaca's SIP consolidated feed (reaches 2016-01; IEX floors ~2020) — daily SIP-vs-IEX diverge
≤0.16%, immaterial here. Also added an `endIso` cap to `barsBatchSinceOhlcv` (a start→now fetch over
~140 names for 10y overran the 20-page/200k-bar budget and starved SPY). Window **2017-06-01 →
2021-05-28** (1006 sessions, 123 names) — contains the **2018 Q4** and **2020 COVID** selloffs. All
constants frozen. Pre-registered pass bar: risk-off +20d significantly negative vs control, t ≤ −2.

**Result — failed on both counts:**

1. **The risk-off gate didn't replicate — it barely fired.** 9 events (vs 53), +20d **+10.44%**,
   vs control t **0.08**. The 2022 result was a *slow-grind* bear (stocks rally to overbought, then
   roll over — what the trigger wants); 2018/2020 were *fast crashes* (stocks oversold, not
   overbought), so the trigger almost never arms. The "risk-off edge" was a property of one bear
   *shape*, not of downtrends.
2. **The whole signal flipped sign.** Discovery: break → continuation, event *beats* control
   (+0.3/+0.8/+0.6 pts at 5/10/20d). OOS: break → underperformance, event *trails* control
   (−1.01/−1.65/−3.27 pts, Welch t −2.92/−3.64/**−4.50**). Same rule, opposite conclusion, by window
   alone. In OOS it's the risk-ON cohort carrying the negative-vs-control (−2.44 pts/20d, t −3.66).

**Verdict: no stable edge; the sign is period-dependent → not tradeable.** Had we only seen 2017-2021
we'd have called it a great mean-reversion exit; only 2021-2026, a continuation signal. Both would be
overfitting. **Rule NOT adopted, always-on or regime-gated. Do not revive it by hunting a third cut —
that is the fitting the OOS test just exposed.** The step-2 plan (build a chandelier-ATR base to give
the exit room to fire) is **cancelled**: there is no validated signal to build a book around. The
"widen exits before testing any hold-the-trend overlay" structural note from the prior entry stands
on its own and is unaffected. Full writeup: [adx-rsi-exhaustion-study.md](./adx-rsi-exhaustion-study.md) §5.

### 2026-07-26 — ARMED: regime-change reweight — core basket replaces SPY:60; universe 140 → 159 (PR #46)

Operator call, Sunday night for the Monday 07-27 open: "we are in a regime change — materials,
energy, Pelosi, storage are trending; too much SPY." The 2-week tape agreed (Jul 10–24, SIP):
SPY **−2.12%** while XLE **+8.24%**, XLB +0.73%, BRK.B +0.25%.

**Core** (`TRADING_CORE_SYMBOLS`, prior value commented above the line in `.env`):
`SPY:20,BRK.B:12,NANC:8,XLE:8,XLB:6,SKHYV:0,SKHY:0` — 54% basket, was SPY:60. SPY 20 keeps index
beta; BRK.B 12 parks with the Berkshire book (Q1-26 13F: AAPL/AXP/KO/BAC/CVX ≈ 68%); NANC 8 is the
congressional-disclosure tracker ETF (+18.9% 1yr — but tech-heavy: **−3.26% in this window**, eyes
open); XLE 8 / XLB 6 are the sector tilts. First Monday fire trims SPY toward target (symmetric
trim, live book = realized gains, operator-approved) and tops up the slugs cash-only.

**Universe 140 → 159**: +9 materials (own sector bucket), +5 data-storage (own bucket; MU + SKHY
moved in so memory crowding caps as one trade), +3 Buffett-13F gaps (MCO/VRSN/KHC), +2
politician-disclosure gaps (TEM/AB). Sector map + press names in the same commit.

**Evidence** (`scripts/trading-regime-reweight-backtest.ts`, committed): lab-sim A/B/C over an
11-session walk — the 19 adds did NOT crack the gravity top-12 in-window (A ≡ B: +0.04pts alpha,
50 trades; rotation exposure accrues only as trends persist — the core slugs are the immediate
tilt), core-54 variant modestly better (C: alpha +0.12pts, maxDD 2.07% vs 2.15%). Core basket
walked at +0.09% vs SPY −2.12% (**edge +2.21pts**); book-level core contribution −1.27pts (old) →
+0.05pts (proposed). HONEST LIMIT: an 11-session walk is a regime probe, not a validation — the
lab's nightly forward walks remain the real A/B.

**Venue landmine found + fixed en route**: Schwab's Trader/Market-Data APIs REJECT the engine's
dot class-share notation (`"invalidSymbols":["BRK.B"]`) and require `BRK/B` — Alpaca is the
reverse. `toSchwabSymbol`/`fromSchwabSymbol` now translate at the wire boundary (orders out;
positions/orders/transactions/quotes in), guard `tests/unit/schwab-symbology.spec.ts`. Watch the
first live BRK/B order Monday — maiden run of the translation. Also fixed:
`schwab-live-smoke.js` envelope-crypto v2 decrypt (the recap-email drift's unaudited sibling).

Deployed 2026-07-26 21:27 CT: image `fb7fec0aad71` = main `0b9a4da`, api + 33 bots, parity clean,
env verified in-container (universe 159, new core string), all legs dispatching. Revert = restore
the commented `.env` line + recreate api.

# Futures intraday backtester — ADR-116, as built (2026-07-27)

The piece that makes the ported futures strategy *measurable*. It walks completed intraday bars,
drives the ported entry evaluator and stop engine, simulates fills with NinjaTrader's replay
semantics, scores the result with the source trader's own optimization objectives, and draws the
overlaid multi-market equity curve NinjaTrader does not provide.

Code: `src/features/trading/services/futures-backtester.ts` (simulator) and
`futures-fitness.ts` (the nine NT8 `OptimizationFitness` ports). Runner:
[`scripts/oshal-futures-backtest.ts`](../../../scripts/oshal-futures-backtest.ts). Strategy logic
itself lives in the modules described in [futures-stop-engine.md](./futures-stop-engine.md).

## Running it

```bash
# Machinery proof on synthetic bars — proves wiring, says NOTHING about edge
npx tsx scripts/oshal-futures-backtest.ts --roots ES,NQ,YM --tf 1Hour --months 6 --equity 500000

# REAL bars from the local Kibot bulk downloads (see "Data" below) — the canonical form:
npx tsx scripts/oshal-futures-backtest.ts --roots ES --source kibot-file \
  --start 2021-01-01 --end 2025-12-15 --equity 500000

# The trader's stage-1 entry-optimization harness: hold N bars, no stops, score AvgMFE/AvgMAE
npx tsx scripts/oshal-futures-backtest.ts --roots ES --source kibot-file \
  --start 2021-01-01 --end 2025-12-15 --equity 500000 --stage1 25

# Inspect raw roll seams (turns OFF back-adjustment; not a results run)
npx tsx scripts/oshal-futures-backtest.ts --roots CL --source kibot-file --adjust none ...

# OUT-OF-SAMPLE at frozen constants — 24-month train, the 6 unseen months after it, step 6
npx tsx scripts/oshal-futures-backtest.ts --roots ES,CL --source kibot-file \
  --start 2021-01-01 --end 2025-12-15 --equity 500000 \
  --walk-forward --is-months 24 --oos-months 6 --step-months 6 --out wf.json

# Parameter sweep — cartesian grid, series built once per market, NAMED objective, CSV out
npx tsx scripts/oshal-futures-sweep.ts --roots ES,CL --source kibot-file \
  --start 2021-01-01 --end 2025-12-15 --equity 500000 \
  --grid scripts/futures-grids/ensemble-entry.json --fitness entry-logic --out sweep.csv
```

Flags: `--roots` (comma list) · `--tf` / `--ltf` (chart and higher-timeframe bar sizes) ·
`--start` / `--end` (ISO dates; else `--months` back from now) · `--source mock|kibot|kibot-file` ·
`--data-dir` (kibot-file root, default `C:\MarketData\kibot`, env `KIBOT_DATA_DIR`) ·
`--adjust panama|none` (default **panama**) · `--min-volume` (default 1) · `--stage1 N` ·
`--slippage-ticks` · `--commission` · `--equity` · `--risk-pct`.

**Evidence flags** (ADR-116 Phase 1): `--config <file.json>` deep-merges a partial `BacktestConfig`
over the runner's literal — a key the file omits keeps its default, a key written as `null` is
REFUSED rather than becoming `NaN` · `--out <file.json>` writes the run machine-readable so nothing
downstream has to re-parse stdout; it deliberately carries no timestamp, so two runs of the same
command over the same archive produce byte-identical files and `diff` is the harness self-check ·
`--walk-forward` with `--is-months` / `--oos-months` / `--step-months` replaces the single
whole-archive run with rolling in-sample/out-of-sample windows at FROZEN constants.

**The sweep runner** (`scripts/oshal-futures-sweep.ts`) shares those series and cost flags and adds
`--grid <file.json>` (required — dotted config key → the values to try on that axis), `--fitness`
(a name from the `FITNESS_FUNCTIONS` registry; an unknown name exits 2 rather than picking a
default nobody stated), `--config` (a base overlay applied under the grid), `--top` and `--out`
(CSV of every combination, not just the ranked head). An axis with no values is an error, not an
empty sweep.

**Mock data prints a banner saying results are meaningless as strategy evidence.** That is
deliberate: the runner should never be quotable as a result unless it ran on real bars.

## Data — the local Kibot bulk downloads

`--source kibot-file` reads `C:\MarketData\kibot\` (moved out of `~/Downloads` 2026-07-27):
`minute/` and `daily/` hold per-contract files (`ESZ25.txt`, `CLF17.txt`, …), `raw/` the original
archives (the two ~3 GB ES **tick** archives stay unextracted until needed), `lists/` Kibot's
symbol lists. Coverage today: **ES** (62 minute contracts ≈ 2010→2025-12, daily to 2008) and
**CL** (242 minute contracts ≈ 2012→2025-11, daily to 2013). GC/6E/NQ/YM/ZC are NOT present.

Three facts about this data the code now enforces, learned the hard way:

- **Per-contract files span the contract's whole listed life**, most of it as an illiquid back
  month (ESZ25: 1–3 contracts/bar for 20 months, then 600–1,200 as front). The front-month clamp
  in `KibotFileDataSource` is therefore ON by default; without it the stitched series is fiction.
- **Three file formats coexist**: ES minute `MM/DD/YYYY,HH:MM,O,H,L,C,V`; ES/CL daily
  `YYYYMMDD;O;H;L;C;V`; CL minute `YYYYMMDD HHMMSS;O;H;L;C;V`. `parseKibotCsv` infers the shape
  per row — never from the requested timeframe (see "How it was verified" for why that rule is
  written in blood).
- **Timestamps are exchange-local wall time carried in UTC fields.** This makes the evaluator's
  default 09:30–15:45 entry window mean exactly the US day session on real data. The mock still
  emits true UTC, so session-dependent behavior is not comparable across the two sources.

## Continuous series — roll seams and panama adjustment

`buildContinuousSeries()` (futures-continuous.ts) owns stitching: each contract fetched only over
its active front-month window, every roll seam measured — preferred method reads the basis off
bars with **identical timestamps** in the 72h pre-roll overlap (median of close differences, via
an unclamped probe source), falling back to adjacent-bar measurement when no overlap exists — and
**panama (difference) back-adjustment applied by default**: the most recent contract keeps its
true prices, every earlier segment is shifted by the cumulative later seams, snapped to the tick
grid. Point differences (P&L, ATR, stop distances) are exact within each contract; historical
absolute LEVELS are fictional and percentage returns on deep history are distorted — the standard
panama trade-off, and the same convention NinjaTrader's difference-adjusted continuous contracts
use, so results are comparable to the trader's. On the 5-year ES run, un-adjusted seams were worth
about **+$29K of phantom stage-1 P&L**.

One refusal is deliberate: when an **intermediate contract contributes no bars** (missing file,
dead market), the boundary between its neighbors is classified a `gap` seam — the level difference
there is months of market drift, not a roll basis, so it is reported loudly and **never** folded
into the adjustment. The discontinuity stays visible rather than silently relocating all earlier
history.

## The fill rules (why results are comparable to his NinjaTrader runs)

These are the difference between a comparable backtest and a flattering one:

- **Signals fill at the NEXT bar's open.** A signal computed on bar *i*'s close becomes a market
  order that fills at bar *i+1*'s open — but the sizing and the initial stop are computed from
  the **signal** bar's indicator values, matching NT's `OnExecutionUpdate` seeing `[0]` as the
  signal bar.
- **Resting stops trigger intrabar.** For a long, the moment `low <= stop`. The fill is
  `min(stop, open)` — a gap through the level fills at the open, *not* at the stop price.
- **The Strangle close-breach and the stage-1 timed exit are market orders** submitted at a bar's
  close, so they fill at the next bar's open, gaps included.
- **Excursions update before the stop can close the trade**, so a stopped trade's MAE reflects the
  bar that stopped it.
- **Costs are explicit**: `slippageTicks` widens every fill against the trader on both sides;
  `commissionPerContract` is charged per contract per side. Both default to 0 — a study that
  reports P&L without setting them is reporting fiction, so the CLI defaults them to realistic ES
  values (1 tick, $2.50).

## Scoring — the trader's own objectives

`futures-fitness.ts` ports all nine NT8 fitness classes as pure functions over the trade list, so
optimization here maximizes exactly what his Strategy Analyzer maximizes:

| Function | Stage | Note |
|---|---|---|
| `maxAvgMfeMinAvgMae` | 1 — entries | **Percent**-basis `AvgMFE/AvgMAE`; his stage-1 objective |
| `entryLogicFitness` | 1 | edge ratio + expectancy + win rate + stability |
| `stopLossMaeFitness` | 2 — stops | stop efficiency − tail MAE − winners stopped |
| `trailingStopFitness` | 3 — trail | MFE capture − giveback |
| `targetOrderFitness` | 4 — targets | MFE utilization + payoff + hit rate |
| `emergencyExitFitness` | 5 | all-penalty |
| `positionSizingFitness` | 6 — sizing | RoMaD / MAR / smoothness |
| `maxNetProfitMinTrades` | gate | `-1e10` sentinel below the trade minimum |

Documented quirks in his originals are **preserved, not fixed** (the `mfeCapture ≡
runupRetention` duplication, `|worstTrade|` penalizing large winners, trade-count-as-day-count,
`ulcerIndex = |maxDD|`, and the two fitnesses that round their tail counts differently — one
banker's, one truncating). They are his shipped objectives; parity is the requirement. Each is
flagged in JSDoc.

## The multi-market overlay

`overlayEquityCurves()` sums per-market curves on a shared time axis, stepping each market's
equity forward between its own trades. This models **independent accounts traded concurrently** —
the view he has been assembling by hand because NinjaTrader won't draw it. It is not a
margin-aware portfolio model: no cross-margining, no shared risk budget, no correlation haircut.
Read it as "what the combined book would have looked like", not as a capital-efficiency claim.

## What his answers did to the numbers

> **HISTORY — measured 2026-07-28, do not quote.** Two cells below are already stale against the
> re-measurement in [Current honest numbers](#current-honest-numbers-re-measured-2026-09-16): row B's
> CL stage-1 reads −$115,660 where it now measures **−$113,245**, and its CL full-stack reads
> −$74,504 where it now measures **−$77,544**. Row A's +$42,115 is the figure this document declares
> superseded further down. Kept because the A→B→C comparison is what the answers changed, not because
> the cells are current.

The source trader answered the five open questions on 2026-07-28, and three of those answers move
defaults that the backtester consumes. Same 5-year panama-adjusted front-month series, same costs
(1 tick/side, $2.50/contract/side), $500K, 2% risk, hourly chart with a daily LTF filter:

| Configuration | ES stage-1 net | ES MFE/MAE | ES full-stack net | ES win% | CL stage-1 net | CL MFE/MAE | CL full-stack net |
|---|---|---|---|---|---|---|---|
| **A** pre-answer defaults (ATR×1.5, all waves, shipped gate) | −$36,273 | 1.026 | **+$42,115** | 70.3% | −$92,895 | 0.924 | −$31,177 |
| **B** his answers (ATR×3 floor, MACD wave only, ADX+LagRSI gate) | −$44,928 | 0.965 | +$23,367 | 66.7% | −$115,660 | 0.924 | −$74,504 |
| **C** his ensemble entries | −$36,758 | 1.004 | −$50,236 | 37.7% | −$127,270 | 0.999 | −$67,514 |
| **C2** ensemble entries, confirmation exit disabled | — | — | +$4,400 | 66.7% | — | — | −$98,213 |

(The ensemble rows are the post-review numbers: a pre-land adversarial pass caught two contributors
being graded with the Export chain's formulas where his ensemble uses different ones — DMI requiring
ADX rising, the Laguerre filter upgrading on an up close. An earlier draft of this table, produced
before that fix, showed the ensemble as the best entry signal on both markets; that result was an
artifact of the mis-graded scores and never shipped.)

Three things worth saying out loud, all in-sample and un-optimized:

1. **His answers make results worse at otherwise-default settings, and the attribution was
   MEASURED, not guessed** (each answer run alone): the stop answer (ATR×3 floor + MACD-wave-only
   source) costs ~$19K on BOTH markets (ES +$42.1K→+$23.3K alone; CL −$31.2K→−$50.2K alone) — NOT
   by risking more dollars, since risk-percent sizing normalizes stop width (average loss is ~flat,
   ES −$8,980 → −$9,199); the cost is ~3 points of win rate from different initial-stop placement.
   The gate answer ('adx-laguerre' alone) is market-split: +$6.3K on ES, −$23.9K on CL — a rarer
   Strangle latch let ES trends run and cost crude its banked spikes. The two effects are
   near-additive. None of this says he is wrong — he tunes per market on 15/30/45/60-minute charts;
   transplanting two constants into foreign defaults measures the transplant. **Mixed constants are
   meaningless** and his optimized per-market sets are the missing input.
2. **His ensemble entries at the default 70% threshold act as a homogenizer, not an edge.** By his
   own stage-1 objective they pull BOTH markets toward neutral: CL lifts from clearly negative
   (0.924 → 0.999, the real improvement) while ES dilutes (1.026 → 1.004), on ~75% more trades.
   Entry quality ≈ 1.0 means the threshold and the membership flags are doing no selection work at
   these defaults — they are precisely the constants his optimizer sweeps (62–78), so this is a
   measurement of un-tuned machinery, not a verdict on the model.
3. **The dual-floor confirmation exit at his documented 90/93 dominates everything on hourly bars** —
   it takes ~99% of exits on both markets (367 of 369 on ES, 373 of 378 on CL), leaving the stop
   stack almost no role. On ES it costs about $55K (+$4K without it → −$50K with it); on CL it
   *saves* about $31K (−$98K → −$68K) by cutting losers fast. Market-dependent, and his own spec
   gives ranges (85–95 / 90–96) — so those two percentages are optimizer inputs, not constants.

Stage-1 sanity check worth noting: on CL, configurations A and B produce an *identical* stage-1 book (125 trades when measured 2026-07-28; the 2026-09-16 re-measurement puts it at **126** — the point is that the two configurations agree, not the count)
and identical MFE/MAE while differing in net P&L. That is exactly right — stage-1 suppresses stops
but still sizes from the estimated stop, so a wider stop changes contracts, not entries.

## Current honest numbers (re-measured 2026-09-16)

**Posture: PAPER, simulated fills. No live futures rail exists.** Every figure in this document and in the sweeps below is simulated; none of it is a live track record.

**Posture: PAPER, simulated fills, no live futures rail exists.** Every figure in this document and in the sweeps below is simulated; none of it is a live track record.

Defaults everywhere (no per-market optimization), 1 tick slippage/side, $2.50/contract/side,
$500K equity, 2% risk, hourly chart / daily LTF, panama-adjusted front-month series. Measured on
core `5f31219` with the commands under "Running it":

| Run | Trades | Win% | Net | MaxDD | AvgMFE/AvgMAE |
|---|---|---|---|---|---|
| ES 2021→2025 stage-1 (25-bar hold, no stops) | 117 | 47.0% | **−$44,928** | $124,733 | 0.965 |
| ES 2021→2025 full stop stack | 123 | 66.7% | **+$23,367** | $50,767 | — |
| CL 2021→2025 stage-1 | 126 | 49.2% | −$113,245 | $161,675 | 0.932 |
| CL 2021→2025 full stop stack | 126 | 64.3% | −$77,544 | $126,502 | — |

Read: at DEFAULT parameters the entries still carry essentially no fixed-horizon edge
(AvgMFE/AvgMAE below 1 on both markets) — which is exactly why the trader's pipeline optimizes
entry constants per market as stage 1. The stop stack still **adds** value over the raw hold on both
markets (ES −$45K → +$23K; CL −$113K → −$78K) while lifting win rate by roughly 15–20 points. Every
number here is in-sample, un-optimized and un-walk-forwarded; the out-of-sample section below is the
one that speaks about the strategy rather than about the archive.

### Why the 2026-07-27 block no longer reproduces

The 2026-07-27 second-pass table published **ES stage-1 119 / −$36,273 / 1.026, ES full-stack
118 / 70.3% / +$42,115, CL stage-1 125 / −$92,895 / 0.924, CL full-stack 122 / 68.0% / −$31,177**,
and said row A reproduced it bit-for-bit. Re-running the same command on 2026-09-16 does not: the
table above is what the code produces now. Nothing was lost — two merged changes moved it, both
deliberately:

- **#82 (2026-07-31) replaced the 24h session fiction with the real Globex calendar.** Sessions,
  the expected-bar count and the gap detector all changed, so the bar set the evaluator walks is
  not the same bar set.
- **#114 added the margin model, the Target-1 partial and the daily-ADX regime gate.** The last two
  ship default-OFF and the gate stayed unfed until this change, but the margin/notional accounting
  runs on every trade.

The lesson is the one this file already teaches in "How it was verified", applied to itself: a
hand-typed results block is a snapshot, and a snapshot with no re-runnable artifact behind it decays
silently. That is what `--out` is for. The old numbers are recorded here as history; do not quote
them. ⚠ The first-pass numbers published on 2026-07-27 before the second pass (ES stage-1
+$135,978 / full +$17,318) remain **void**: that run's LTF series was column-shift misparsed minute
data and its 19 roll seams were unadjusted.

## Walk-forward at frozen defaults (OOS) — 2026-09-16

**The first out-of-sample numbers this project has ever had.** One frozen configuration (the
defaults above — `dynstops` entries, the full stop stack, no per-market tuning) run over rolling
24-month in-sample / 6-month out-of-sample windows stepping 6 months, so consecutive out-of-sample
periods are contiguous and never overlap. No optimizer is involved: the OOS column measures the
STRATEGY, not a parameter search.

```bash
npx tsx scripts/oshal-futures-backtest.ts --roots ES,CL --source kibot-file \
  --start 2021-01-01 --end 2025-12-15 --equity 500000 \
  --walk-forward --is-months 24 --oos-months 6 --step-months 6 --out wf.json
```

**ES** — paper, in-sample column measured (nothing is trained — no optimizer is involved), out-of-sample column unseen:

> The in-sample **all** row below is a SUM OVER OVERLAPPING WINDOWS, not a period: five 24-month windows stepped by 6 months = 120 window-months across a 48-month span, with 2023-01..2023-07 counted four times. The single-pass 2021→2025 figure for the same span is 123 trades / +$23,367. The out-of-sample **all** row IS a contiguous sum — the windows do not overlap, and the runner refuses a step smaller than the out-of-sample length so they cannot. The degradation ratio normalises per month on both sides, so it is unaffected.

| win | in-sample period | IS trades | IS net | out-of-sample period | OOS trades | OOS net | OOS maxDD |
|---|---|---|---|---|---|---|---|
| 0 | 2021-01→2023-01 | 43 | +$39,794 | 2023-01→2023-07 | 6 | +$7,186 | $9,855 |
| 1 | 2021-07→2023-07 | 42 | +$4,950 | 2023-07→2024-01 | 16 | +$13,683 | $29,513 |
| 2 | 2022-01→2024-01 | 51 | +$19,254 | 2024-01→2024-07 | 9 | +$6,695 | $20,899 |
| 3 | 2022-07→2024-07 | 52 | +$1,454 | 2024-07→2025-01 | 7 | −$1,004 | $15,487 |
| 4 | 2023-01→2025-01 | 50 | −$1,230 | 2025-01→2025-07 | 10 | −$33,166 | $42,877 |
| **all** | 2021-01→2025-01 | **238** | **+$64,222** | 2023-01→2025-07 | **48** | **−$6,606** | worst window $42,877 |

Degradation (OOS $/month ÷ IS $/month): **−0.411**.

**CL** — same split, same frozen config:

> The in-sample **all** row below is a SUM OVER OVERLAPPING WINDOWS, not a period: five 24-month windows stepped by 6 months = 120 window-months across a 48-month span, with 2023-01..2023-07 counted four times. The single-pass 2021→2025 figure for the same span is 123 trades / +$23,367. The out-of-sample **all** row IS a contiguous sum — the windows do not overlap, and the runner refuses a step smaller than the out-of-sample length so they cannot. The degradation ratio normalises per month on both sides, so it is unaffected.

| win | in-sample period | IS trades | IS net | out-of-sample period | OOS trades | OOS net | OOS maxDD |
|---|---|---|---|---|---|---|---|
| 0 | 2021-01→2023-01 | 51 | −$26,348 | 2023-01→2023-07 | 5 | +$18,343 | $8,780 |
| 1 | 2021-07→2023-07 | 45 | −$40,854 | 2023-07→2024-01 | 12 | +$11,016 | $17,685 |
| 2 | 2022-01→2024-01 | 44 | −$28,140 | 2024-01→2024-07 | 13 | −$45,203 | $45,203 |
| 3 | 2022-07→2024-07 | 50 | −$60,650 | 2024-07→2025-01 | 9 | −$46,597 | $46,760 |
| 4 | 2023-01→2025-01 | 51 | −$45,956 | 2025-01→2025-07 | 11 | −$18,719 | $34,999 |
| **all** | 2021-01→2025-01 | **241** | **−$201,948** | 2023-01→2025-07 | **50** | **−$81,160** | worst window $46,760 |

Degradation: **n/a** — the in-sample half never made money, so the ratio would be meaningless and
the driver reports null rather than a number that reads like a result.

**Read, plainly:** across 30 months of bars the frozen constants never saw, ES lost $6,606 on 48
trades and CL lost $81,160 on 50. ES's in-sample profit does not survive the walk forward; CL is
negative in both columns. **At default constants this system has no demonstrated out-of-sample
edge on either market with bars on disk.** That is the starting point Phase 2's optimizer has to
beat, and it is now a re-runnable number rather than an opinion.

Three properties of the measurement, so nobody has to infer them:

- **Each window's series is sliced cold.** Indicators warm up from scratch inside every window (the
  longest warmup in the stack is the 100-bar wave-stops RMS). Both halves are treated identically,
  so the comparison is fair, but a 6-month OOS window carries proportionally more warmup than a
  24-month IS window — part of why OOS trade counts are low.
- **Each window is an independent account.** The drawdowns are per-window; the report gives the
  worst one and never adds them into a portfolio claim.
- **The split is guarded, not asserted.** `tests/unit/futures-walk-forward.spec.ts` drives the real
  ES daily archive through the driver's own slicer and proves no bar reaches both halves of a
  window — mutation-checked (swapping the halves turns it red).

## Sweeps (in-sample, un-optimized) — 2026-09-16

Both grids the ADR-116 Phase 1 plan owed. **Every number in this section is in-sample**: a sweep by
definition saw the data it is ranked on, so a winner here is a hypothesis for the walk-forward, not
a result.

### Stop buffer: ticks vs percent-of-ATR

```bash
npx tsx scripts/oshal-futures-sweep.ts --roots ES,CL --source kibot-file \
  --start 2021-01-01 --end 2025-12-15 --equity 500000 \
  --grid scripts/futures-grids/stop-buffer.json --fitness trailing-stop --out sweep-stop.csv
```

| market | stopBufferMode | strangleBufferAtrPercent | trades | win% | net | maxDD | trailing-stop |
|---|---|---|---|---|---|---|---|
| ES | ticks | 5 / 7 / 10 (inert) | 123 | 66.7% | +$23,367 | $50,767 | −1211.49 |
| ES | atr-percent | 5 | 123 | 66.7% | −$4,708 | $61,353 | −1270.15 |
| ES | atr-percent | 7 | 123 | 66.7% | +$20,900 | $51,722 | −1223.56 |
| ES | atr-percent | 10 | 122 | 68.0% | **+$49,529** | $53,232 | −1196.12 |
| CL | ticks | 5 / 7 / 10 (inert) | 126 | 64.3% | −$77,544 | $126,502 | −1456.87 |
| CL | atr-percent | 5 | 126 | 63.5% | −$80,337 | $128,645 | −1455.54 |
| CL | atr-percent | 7 | 126 | 63.5% | −$81,190 | $129,130 | −1459.60 |
| CL | atr-percent | 10 | 125 | 64.0% | −$78,101 | $125,973 | −1459.45 |

The ATR-percent axis is **inert under `stopBufferMode: 'ticks'`** — the mode does not read it — so
three of the six combinations per market are duplicates by construction. That is a property of the
grid, not a bug, and it is exactly the kind of wasted axis a staged optimizer must avoid paying for.
Reading: on ES a 10%-of-ATR Strangle buffer more than doubles in-sample net over the shipped tick
buffer; on CL nothing in the grid escapes a large loss. Neither has been walk-forwarded, and the
ES row is one market, one grid, one period.

### Ensemble entry: threshold and the dual-floor confirmation

```bash
npx tsx scripts/oshal-futures-sweep.ts --roots ES,CL --source kibot-file \
  --start 2021-01-01 --end 2025-12-15 --equity 500000 \
  --grid scripts/futures-grids/ensemble-entry.json --fitness entry-logic --out sweep-ensemble.csv
```

45 combinations per market (`entry.generation: ensemble` × threshold 62/66/70/74/78 ×
`retentionPct` 85/90/95 × `drawdownPct` 90/93/96).

| market | combinations | positive net | net range | best row |
|---|---|---|---|---|
| ES | 45 | **0** | −$58,829 → −$31,270 | thr 78, drawdownPct 96 — 162 trades, 39.5%, −$31,270, maxDD $48,645 |
| CL | 45 | **0** | −$90,834 → −$28,574 | thr 78, drawdownPct 96 — 173 trades, 37.0%, −$28,574, maxDD $51,179 |

Average net by entry threshold (mean over the nine confirmation combinations at each threshold):

| threshold | ES trades | ES avg net | CL trades | CL avg net |
|---|---|---|---|---|
| 62 | 433 | −$54,473 | 454 | −$87,065 |
| 66 | 433 | −$54,473 | 454 | −$87,065 |
| 70 | 371 | −$50,208 | 379 | −$75,703 |
| 74 | 288 | −$46,575 | 300 | −$59,878 |
| 78 | 159 | −$32,655 | 170 | −$29,487 |

Three readings, all in-sample:

- **Not one of the 90 ensemble runs is profitable.** The shipped `dynstops` default (+$23,367 on ES)
  beats every ensemble combination on both markets. On this archive, at these constants, the
  ensemble generation is worse than what it was meant to replace.
- **Thresholds 62 and 66 produce identical books on both markets.** The ensemble score is a
  percentage of a discrete contributor count, so those two thresholds fall between the same pair of
  achievable scores. The grid's effective entry axis is four values, not five — a real finding for
  whoever sizes Phase 2's grids, since a staged optimizer would otherwise pay full runtime for a
  duplicate column.
- **Loss shrinks monotonically as the threshold tightens**, entirely by trading less: ES goes 433
  trades / −$54K at 62 to 159 trades / −$33K at 78. That is a pattern consistent with entries that
  carry no edge, which is the same thing the AvgMFE/AvgMAE ≈ 1 stage-1 number says.


## Known limits (read before quoting any number)

- **Panama levels are fictional in deep history.** Adjustment removes roll seams (default on), but
  absolute price levels before the last contract are shifted; percentage-based reasoning on early
  history is distorted. Ratio adjustment is not implemented (the trader's NT continuous contracts
  use difference — parity is the point).
- **Sessions are the real Globex week** *(since 2026-07-31 — `futures-session-calendar.ts`)*: the
  ~23h Sun-18:00→Fri-17:00 wall-clock session with the 17:00–18:00 maintenance halt and rule-computed
  US holidays drives the expected-bar count, the gap detector, and the mock source. Honest residue:
  per-year one-off exchange notices (special closures, shortened Good Friday sessions) are not
  modeled; the completeness threshold absorbs them. The entry-window filter still bounds trade hours
  inside the session.
- **Mock and real bars share ONE clock convention** *(since 2026-07-31)*: `FuturesBar.t` is the
  bar-OPEN stamp whose UTC fields carry EXCHANGE-LOCAL WALL TIME — Kibot's shape, now documented on
  the type and emitted identically by the mock (Sunday-18:00 opens, no 17:00-hour bars). The
  simulator derives the CLOSE stamp from the next bar. Session-dependent behavior (the 09:30–15:45
  entry window included) is comparable across sources.
- **MFE on a stopped bar uses the full bar range.** If a long's bar rallies before reversing through
  the stop, that high counts as favorable excursion — which is what NT's trade tracker does, but it
  means MFE on the exit bar is bar-resolution, not tick-resolution.
- **No margin model.** Sizing is risk-percent based; contract margin is not checked, so a
  backtest can hold a position a real account could not fund.
- **Single position at a time, per market** (`EntriesPerDirection = 1` in the source). No
  pyramiding, no scale-outs — his Target-1 partial is not yet modeled.
- **The walk-forward driver exists; the staged optimizer does not.** `--walk-forward` runs FROZEN
  constants over rolling in-sample/out-of-sample windows (numbers above). What is still missing is
  the six-stage locked-winner optimizer running INSIDE those windows — Phase 2 in
  [futures-phasing.md](./futures-phasing.md), and the point at which an optimized constant set could
  be judged on bars it did not choose. Until then, every "winner" in the sweep tables is in-sample.
- **Walk-forward windows are sliced cold.** Indicators restart inside each window, so the first
  ~100 chart bars of each half are warmup rather than tradable. Identical treatment either side, but
  it depresses out-of-sample trade counts relative to a continuously-run book.
- **The mock source is not a market.** It is a random walk with drift; it will happily produce a
  profitable-looking curve. Only `--source kibot` runs are evidence.

## How it was verified

Alongside the unit specs, a three-area adversarial review (fill semantics + look-ahead, engine
wiring, accounting integrity) ran before this shipped. It found **19 defects, 3 of them critical**,
every one now fixed with a regression guard:

- the contract-stitching defect above (would have fabricated P&L on every real-data run),
- a **look-ahead leak** — the LTF index returned the last-*opened* higher-timeframe bar rather than
  the last-*closed* one, feeding entry decisions a bar that was still forming,
- a **doubly-deferred Strangle exit** (engine and backtester each deferred a bar, so it filled two
  bars late with the position unprotected),
- exit fills missing from MFE/MAE, letting a gap-open exit book more profit than its own recorded
  maximum favorable excursion — which silently corrupted the stage-1 objective,
- the entry window evaluated on bar-OPEN stamps, shifting the tradable session a full bar,
- a missing LTF series silently downgrading to an unfiltered run instead of gating,
- `'Strangle'` exits not matching the fitness module's `'Stop'` substring, so stop efficiency never
  counted them (resting-stop fills are now labelled `StrangleStop`).

The fitness module got the same treatment and the review there was **mutation-proven**: swapping
banker's rounding for truncation, or loosening the breakeven comparison, left the original suite
fully green. Those guards were rewritten at values where the wrong rule produces a different
number, then re-mutated to confirm they go red.

**The 2026-07-27 second pass proved the doctrine again.** A re-verification of the first real-data
run found its LTF series had been **column-shift misparsed**: `parseKibotCsv`, told `1Day`, read
7-column minute rows with the daily column map — open ← the time string (NaN), close ← the low,
volume ← the close price — and served them unresampled at minute cadence as the "daily" trend
filter. The headline numbers built on it were void. The parser now infers row shape per line, the
file source refuses to serve a daily file at an intraday timeframe, and regression guards pin both
(`futures-data-completeness.spec.ts`, `futures-kibot-file-source.spec.ts`). Second lesson, same
day: **a backtest number is not a finding until the series that produced it has been audited
end-to-end** — bars, both timeframes, and seams.

The continuous-series + hardened-parser delta then got its own two-reviewer adversarial round
before landing, which caught three more (all fixed + mutation-proven guards): the gap-seam blocker
above, a trailing delimiter flipping a daily row into the intraday column map (volume became the
closing price), and blank OHLC fields parsing as $0 prices via `Number('') === 0`. The re-run
after those fixes reproduced the results table bit-for-bit — the defects were live traps for
future data, not contributors to these numbers.

## Next

The walk-forward driver is built (above). Next is the staged optimizer — Entry → StopLoss → Trail →
Targets → EmergencyExit → Sizing, prior-stage winners locked, each scored by its own fitness above —
running INSIDE those windows, which is Phase 2 and the ADR-116 evidence gate: it is where "no edge
at defaults" either turns into per-market constants that survive unseen bars, or is confirmed, and
confirming it closes the live items as "do not build live". Then the `futures_backtest` tool on the
trading-analyst bot, so the source trader can iterate parameters conversationally. Scope, sizes and
done-whens: [futures-phasing.md](./futures-phasing.md); status: the BACKLOG futures section.

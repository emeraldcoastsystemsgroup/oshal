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
```

Flags: `--roots` (comma list) · `--tf` / `--ltf` (chart and higher-timeframe bar sizes) ·
`--start` / `--end` (ISO dates; else `--months` back from now) · `--source mock|kibot|kibot-file` ·
`--data-dir` (kibot-file root, default `C:\MarketData\kibot`, env `KIBOT_DATA_DIR`) ·
`--adjust panama|none` (default **panama**) · `--min-volume` (default 1) · `--stage1 N` ·
`--slippage-ticks` · `--commission` · `--equity` · `--risk-pct`.

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

## Current honest numbers (2026-07-27, second pass)

Defaults everywhere (no per-market optimization), 1 tick slippage/side, $2.50/contract/side,
$500K equity, 2% risk, hourly chart / daily LTF, panama-adjusted front-month series:

| Run | Trades | Win% | Net | MaxDD | AvgMFE/AvgMAE |
|---|---|---|---|---|---|
| ES 2021→2025 stage-1 (25-bar hold, no stops) | 119 | 47.1% | **−$36,273** | $108,005 | 1.026 |
| ES 2021→2025 full stop stack | 118 | 70.3% | **+$42,115** | $37,829 | — |
| CL 2021→2025 stage-1 | 125 | 48.0% | −$92,895 | $124,490 | 0.924 |
| CL 2021→2025 full stop stack | 122 | 68.0% | −$31,177 | $114,883 | — |

Read: at DEFAULT parameters the entries carry essentially no fixed-horizon edge (AvgMFE/AvgMAE ≈ 1)
— which is exactly why the trader's pipeline optimizes entry constants per market as stage 1. The
stop stack **adds** value over the raw hold on both markets (ES −$36K → +$42K; CL −$93K → −$31K)
while roughly tripling win rate. All numbers are in-sample, un-optimized, no walk-forward; they
are machinery-grade evidence, not edge claims. ⚠ The first-pass numbers published earlier the
same day (ES stage-1 +$135,978 / full +$17,318) are **void**: that run's LTF series was
column-shift misparsed minute data and its 19 roll seams were unadjusted.

## Known limits (read before quoting any number)

- **Panama levels are fictional in deep history.** Adjustment removes roll seams (default on), but
  absolute price levels before the last contract are shifted; percentage-based reasoning on early
  history is distorted. Ratio adjustment is not implemented (the trader's NT continuous contracts
  use difference — parity is the point).
- **Sessions are approximated as continuous 24h weekdays** (inherited from the instrument model).
  A real CME session + holiday calendar is BACKLOG; until then the entry-window filter is the only
  thing keeping trades inside sensible hours.
- **Mock and real bars use different clock conventions.** `FuturesBar.t` is the bar-OPEN stamp; the
  simulator derives the CLOSE stamp from the next bar. Kibot carries exchange-local wall time in
  the UTC fields (making the default entry window the real US day session); the mock emits true
  UTC. Mock-vs-real comparisons of session-dependent behavior are invalid until the mock adopts
  the wall-time convention (BACKLOG).
- **MFE on a stopped bar uses the full bar range.** If a long's bar rallies before reversing through
  the stop, that high counts as favorable excursion — which is what NT's trade tracker does, but it
  means MFE on the exit bar is bar-resolution, not tick-resolution.
- **No margin model.** Sizing is risk-percent based; contract margin is not checked, so a
  backtest can hold a position a real account could not fund.
- **Single position at a time, per market** (`EntriesPerDirection = 1` in the source). No
  pyramiding, no scale-outs — his Target-1 partial is not yet modeled.
- **No walk-forward driver yet.** Constants are frozen per run; the staged optimizer and its
  out-of-sample harness are the next build. His own repo documents walk-forward as policy but
  never implemented it — this port should not inherit that gap.
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

The staged optimizer (Entry → StopLoss → Trail → Targets → EmergencyExit → Sizing, prior-stage
winners locked, each scored by its own fitness above) plus a walk-forward driver that freezes
constants and re-runs on unseen periods — that is where "no edge at defaults" is supposed to turn
into per-market constants worth quoting. Then the `futures_backtest` tool on the trading-analyst
bot, so the source trader can iterate parameters conversationally. See the BACKLOG futures
section.

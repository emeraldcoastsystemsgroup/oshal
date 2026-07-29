# Futures stop engine + entry side — the ADR-116 strategy port, as built (2026-07-28)

> **Status update, same day:** the ENTRY side shipped in the follow-up PR —
> `futures-entry-indicators.ts` (Laguerre oscillator/filter, MFI, adaptive Laguerre filter),
> `futures-wave-tracking.ts` (the shared wave-cycle machine, MACD/DMI/Ehlers wave trackers with
> their deliberate unwritten-slot artifacts, Laguerre wave stops + patterns), and
> `futures-entry-evaluator.ts` (ten graded states, threshold-0 exclusion, the hard oscillator
> clause, entry window, same-direction re-entry latch, generation-specific LTF filter, sizing
> incl. the DynStops LTF weight). The wave trackers double as the newest-generation initial-stop
> candidates (`IsBullish` + `lastBearWaveLow` feed `resolveInitialStop`). What remains for a
> runnable strategy: the intraday backtester (fills), then the staged optimizer.

The exit half of the futures strategy port ([ADR-116](../../adr/116-futures-extension-layer.md)):
a three-layer stop system recreated from the source trader's NinjaTrader 8 code, shipped as pure
TypeScript in `src/features/trading/services/` — `futures-indicators.ts` (indicator math),
`futures-trail-stops.ts` (trail-level generators), `futures-stop-engine.ts` (the per-trade state
machine). No NinjaTrader, no Kibot desktop app, no UI automation — the dependency-drop ADR-116
exists to deliver.

Source of truth for the port: the trader's `NT8Custom` repo (private; operator holds a zip in the
private tree) — `atcATRCalc.cs`, `atcDMI.cs`, `atcLaguerreRSICalc.cs`, `atcChandelierBands.cs`,
`atcSuperTrendM11.cs`, `atcParabolicSARCalc.cs`, and the newest strategy generation
`ATCEntryCountDynStops.cs` (plus `ATCEntryCountExport.cs` for the older initial-stop mode). Parity
target is **completed-bar replay** (`Calculate.OnBarClose`): every warmup, seed, and edge rule is
ported as-is, including the non-textbook ones. Do not "correct" the math to classic forms —
backtest parity with the trader's NinjaTrader results is the point.

## The three layers

**1. Initial stop (on entry)** — `resolveInitialStop`. Candidate levels (SuperTrend dot + PSAR in
the older generation; wave extremes in the newest) are admitted per generation
(`initialStopCandidateFilter`: the older gen requires candidates strictly beyond the entry bar's
extreme; the newest gen accepts every regime-vetted finite candidate — validation clamps at
placement) and combined **widest**; with no survivor, fallback =
anchor − ATR-multiple·ATR (anchor `low` in the newest gen and the trader's dictation, `close` in
the older gen — a config knob). A tick buffer widens either path; optional min-risk floor (widen
to ≥ multiple·ATR from entry) and max-risk ceiling (cap at 4× the floor distance — the ES
far-wave sizing guard) mirror the newest generation.

**2. Chandelier base trail with the breakeven gate** — the engine consumes
`chandelierBands().stopLong/stopShort` (reset-on-violation trail, ATR floored at one tick) and
arms it as the active stop **only once the band is better than entry by ≥ 1 tick** — the literal
breakeven gate from every strategy generation. Optional risk-goal arming
(`trailMode: 'ts-with-risk-goal'`) additionally waits for open profit > `pctOrigRisk` × initial
risk. The resting stop only ever tightens.

**3. The Strangle exhaustion trail** — the tight higher-close/lookback-low stop the trader
described as his new layer, ported from `UseStrangleTrail`:

- **Level tracking runs every bar** the close is beyond entry, latch or no latch. First
  profitable close seeds level = swing extreme of entry-bar→now ∓ 2 ticks; each **new higher
  close** (long) re-scans the *inclusive* prior-extreme→now span (N bars between higher closes →
  N+1 bars scanned, capped at 255) and tightens by ≥ 1 tick — the extreme marker advances even
  when the level doesn't tighten.
- **The gate latches once per trade**: profitable AND ADX ≥ threshold (default 30, the trader
  optimizes 30–40) AND the second condition. The latch never un-latches; it resets only when flat.
- **Enforcement is profit-conditional**: while the trade is underwater the Strangle stands down
  and the chandelier resumes — the port of the trader's May-11/June-7 live-trade fixes.
- **A CLOSE breach of the level cancels the resting stop and market-exits the next bar** (gaps
  fill at market; intrabar touches that close back inside do *not* exit).

Every emitted stop passes the source's `ValidateAndAdjustStopPrice` clamp (≥ 2 ticks outside the
current bar's range, 5-tick conservative fallback).

## Dictation-vs-code divergences — ANSWERED by the source trader (2026-07-28)

His spoken spec and his shipped code disagreed in five places. Every one shipped as a config knob
so optimization could arbitrate rather than us guessing — and he has now answered all five. The
knobs stay (they are how a parity run reproduces the old behaviour), but the DEFAULTS now encode
his stated intent:

| Question | His answer | Default now | Knob (all still available) |
|---|---|---|---|
| Second gate condition: LagRSI ≥ 80, or DI/ADX-falling? | "activate the Strangle gate with **both conditions**" | `'adx-laguerre'` — ADX ≥ 30 **and** LagRSI ≥ 80 | `strangleGateMode: 'adx-di-or-falling' \| 'adx-laguerre' \| 'adx-any' \| 'adx-all'` |
| Strangle enforcement: close-breach market exit, or resting stop? | **both, in sequence** — track the level all trade; once gated, a close beyond it exits at market, otherwise create/update the resting trailing stop | `'close-breach-market'` (unchanged — his answer confirms it) | `strangleExitMode` |
| Which ATR-multiplier model is canonical? | "the dynamic trailing stop (**DTAM**) **was removed** as it had not shown to be helpful" | single optimizer-swept static, 2.0 | `chandelierMultiplier`; DTAM **retired, not deferred** |
| Initial-stop anchor + buffer? | stop = **lowest low of the most recent bearish MACD wave** (`atcMACDWaveStops`), with a **floor minimum of ATR × 3** | `initialStopAtrMultiple: 3`, `initialStopWaveSource: 'macd'` | both, plus the anchor/buffer knobs as fallbacks |
| Entry model of record: graded-state or scalar ensemble? | he is **refactoring to the ensemble** — "wouldn't require specific indicators to create a signal but would require a minimal score" | graded-state stays the parity default; `generation: 'ensemble'` now exists | `EntryGeneration: 'export' \| 'dynstops' \| 'ensemble'` |

Two notes on reading those answers:

- **"Both conditions" is taken as ADX + Laguerre RSI** (the two terms his dictation named, which the
  question quoted back to him). He also said he would re-check his own code, so the stricter reading
  — his RSI clause **and** the coded DI/ADX-falling clause — ships as `'adx-all'`. One line from him
  settles which is canonical; both are one config value away.
- **"Floor minimum" is implemented as a minimum stop DISTANCE**: a wave low closer than 3·ATR is
  pushed out to it. The alternative reading (a bound on the stop price, i.e. a cap on distance) is
  what `initialStopMaxRiskAtrFactor` already does separately, so the two together bracket risk.

Beware the coupling this creates: the max-risk ceiling is a multiple of the floor, so moving the ATR
multiple from 1.5 to 3 doubled both, and at 3 × 4 the ceiling sits at 12·ATR. Wider stops mean
smaller risk-percent positions and more zero-quantity skips — measured, with numbers, in
[futures-backtester.md](./futures-backtester.md#what-his-answers-did-to-the-numbers).

## The scalar ensemble entry model (`generation: 'ensemble'`)

His newer entry model, ported from `ATCEnsembleGen.cs` + `EntryEnsemble.md` into
`futures-entry-ensemble.ts`. It replaces unanimous-AND confluence with a score:

- **Nine contributors** — DMI, MACD, MFI, LagOsc, LagFilter, Ehlers IT, SuperTrend, LagRSI, wave
  pattern — each grading to the same {−2…+2} scaler the other generations already compute. The
  adaptive-Laguerre-filter state is graded but takes **no part**. (His spec doc lists seven and a
  ±14 range; the shipped code carries nine and computes the maximum from the enabled `Use*` flags,
  so the port derives `maxPossible = enabledCount × 2` and never hardcodes it.)
- **Entry** when `score ≥ 70% × maxPossible` (long) or `≤ −threshold` (short). He optimizes 62–78.
- **No indicator is mandatory** — this is the point of the model, and the single biggest behavioural
  difference from the unanimous-AND generations, whose hard `LagOsc > 0 AND rising` clause has no
  exclusion parameter.
- **Three gates his ensemble does NOT have**, and which the port therefore skips for this generation
  only: the `close > prevClose` submission test, the zero-cross same-direction re-entry latch, and
  the fixed 09:30–15:45 window (his ensemble uses a session-close cutoff instead — reproduce it with
  a pass-through window). It **does** keep the Export-style **binary** LTF rule
  (`close > superTrend && lagOsc > 0`), not the DynStops graded gate.
- **A dual-floor confirmation exit**: track the peak score in the trade's direction and flatten at
  market when `|current| < MAX(90% × |entry|, 93% × |peak|)`. He flags the peak floor as "this is the
  key". It is a SIGNAL exit that coexists with the stop stack, and his code cancels working
  stop/target orders and returns before evaluating entries on that bar.

Why he moved: his own notes record that unanimous-AND plus an indicator-count exit **cannot fire**
when few indicators are enabled — with 2 of 7 used for entry and a 3-indicator exit threshold, the
early exit is unreachable (`EntryEnsemble.md:10-11`).

## Indicator fidelity notes (the traps)

- **ATR** is `EMA(TR, 2p−1)` seeded at bar 0's high−low — Wilder's recursion with an EMA seed,
  *not* an SMA warmup. All atc consumers use this variant.
- **DMI/ADX** keeps atcDMI's warmups: smoothed TR is a raw passthrough until bar `diLength`;
  smoothed DM warms up on a cumulative average, takes an SMA-seeded carry step *at* bar
  `diLength`, then the Wilder carry; DX passes through into ADX until bar `adxSmoothing`.
- **SuperTrend M11** computes bar-t stops from bar-(t−1) baseline (moving median) and ATR, flips
  on the close, and continues the ratchet from the *opposite side's* prior value on a flip. The
  chandelier bands use bar-t close values. That [1]-vs-[0] split is deliberate in the source.
- **PSAR** seeds at bar 3 *near the high extreme* (the S&C v11:11 formula); the two-bar clamp
  pulls it onto the real trail a bar later. AF rises once per bar; reversal emits the prior
  extreme.
- A frictionless one-way test trend saturates ADX at exactly 100 (−DM ≡ 0) — expected, not a bug.

## What consumes this

The engine is order-management-agnostic: `onEntry(...)` → initial decision,
`onBar(indicator inputs)` → `{ restingStop, exitAtMarket, events }`. The ADR-116 intraday
backtester (BACKLOG) is the intended first consumer — it owns fills; the engine owns levels and
decisions. The live/paper rail wires the same interface later.

Guards: `tests/unit/futures-indicators.spec.ts`, `futures-trail-stops.spec.ts`,
`futures-stop-engine.spec.ts` (hand-computed fixtures; the Strangle lifecycle scenarios encode
the latch/stand-down/breach semantics above). A 7-module adversarial parity review against the
.cs sources ran at port time; its two real findings — the PSAR two-prior-bars clamp loop and the
per-generation initial-stop candidate filter — were folded back (with regression guards) before
landing; the remaining findings were sub-ulp float ordering and out-of-scope NaN/warmup paths.

## Still owed (BACKLOG, "Futures extension layer")

The %ATR buffer variant, margin modelling, the Target-1 partial exit, and the six-stage
optimization pipeline with its walk-forward driver (stage-1 fixed-bar-exit MFE/MAE fitness first).

**Retired rather than owed:** the DTAM regime scaler (`ATCDynStop.cs`) and the never-coded 1.5–4.0
score-binned multiplier ladder. Their author tested DTAM and removed it as unhelpful (2026-07-28),
so the static optimizer-swept multiplier is canonical and porting DTAM would be reviving something
its own designer rejected.

**Now delivered rather than owed:** the entry-side port (ten graded states + LTF filter + re-entry
filter), the wave indicators as initial-stop candidates, the intraday backtester, and the scalar
ensemble generation above. The five open questions are ANSWERED — see the table.

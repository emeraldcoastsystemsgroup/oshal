# Futures stop engine + entry side — the ADR-116 strategy port, as built (2026-07-27)

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

## Dictation-vs-code divergences = config knobs

The trader's spoken spec (2026-07-27) and his shipped code disagree in five places. The engine
makes each an explicit option so optimization arbitrates instead of us guessing:

| Divergence | Shipped code | Dictation | Knob |
|---|---|---|---|
| Second gate condition | DI < ADX **or** ADX falling | Laguerre RSI ≥ 80 | `strangleGateMode: 'adx-di-or-falling' \| 'adx-laguerre' \| 'adx-any'` |
| Strangle enforcement | close-breach → market exit next bar | (unspecified — resting stop implied) | `strangleExitMode: 'close-breach-market' \| 'resting-stop'` |
| Initial-stop fallback anchor | `close` (older gen) / `low` (newest) | `low` | `initialStopFallbackAnchor` |
| Buffers | fixed 2–3 ticks | X% of ATR | tick counts (`initialStopBufferTicks`, `strangleBufferTicks`) — %ATR variant deferred |
| Chandelier multiplier family {1.5, 2, 2.5, 3} | one optimizer-swept static (default 2.0); regime map lives in a sibling fork | dynamic by "risk parameters" | static per instance now; DTAM regime scaling deferred (BACKLOG) |

The Laguerre RSI itself (`laguerreRsi`, Ehlers 4-stage filter, native 0–100 scale, alpha 0.5,
EMA-7 average line) ships so the dictated gate mode is testable from day one.

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

Entry-side port (the 10 graded indicator states + LTF filter + re-entry filter), wave-stop
indicators as initial-stop candidates, the DTAM regime scaler (`ATCDynStop.cs`), the %ATR buffer
variant, the intraday backtester that drives all of this over `market_bars`, and the six-stage
optimization pipeline (stage-1 fixed-bar-exit MFE/MAE fitness first). The five open questions for
the source trader are logged in the ADR-116 BACKLOG section.

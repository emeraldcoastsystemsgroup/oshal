# ADR-092: Trading Strategy Lab — persistent strategies, forward testing, automated regressions

Date: 2026-07-12
Status: Accepted

## Context

The trading stack (ADR-052/053/054) has a rigorous but **ephemeral** evidence pipeline: nine CLI
backtest harnesses print a `RESULT {json}` line and exit, verdicts live in
[backtest-regression-suite.md](../apps/trading/backtest-regression-suite.md) as prose, and the
computed equity curves are discarded after the summary stats print. Three operator asks
(2026-07-12) exposed the gaps:

1. **Strategy variations are not first-class.** A "strategy" today is a set of env vars + a
   strategy-log row. You cannot save a variation, compare it against the armed config, or see how
   a configuration you rejected in June would have done in July.
2. **No forward testing.** Backtests are in-sample by construction. The honest test of a saved
   config is walking it forward on bars it has never seen, accruing an out-of-sample curve over
   weeks — per variation, not just for the one deployed book.
3. **Regressions are manual.** The resample bug (`cad41dc5`) silently voided two weeks of numbers.
   Nothing re-runs the armed configs against pinned windows to detect engine-behavior drift.
4. **Results are invisible.** The trading surface shows the live book but none of the evidence.

## Decision

Build the **Strategy Lab** as a thin persistence + replay layer over the *existing* engine — the
sim walks reuse `decideSymbol`, `rankUniverse`, and the portfolio money-manager verbatim (the same
"measure the real strategy, not a re-implementation" rule the CLI harnesses follow).

1. **Persistent strategies** (`trading_strategies`): a named, user-owned config
   (`kind: rotation | ensemble` + posture / SPY-core % / take-profit / rank / cadence / topN /
   weighting / universe knobs) with a lifecycle (`candidate → armed → retired`). The armed
   production config is seeded as a strategy so it is regression-locked from day one.
2. **Persistent runs** (`trading_strategy_runs`): every backtest / forward step / regression
   stores its config snapshot, data window, feed, git SHA, full metrics
   (return, CAGR, Sharpe, max drawdown, win rate, trades, SPY benchmark, alpha) **and the full
   dated equity curve** — so past configurations can be charted over time, not re-derived.
3. **Forward testing** (`trading_strategy_state`): each strategy keeps a serialized walk state
   (book, cash, bar counter, high-water mark). A daily post-close step marks the book on the new
   session's bars and applies the strategy's own exits/rotation/entries — an out-of-sample curve
   that grows every trading day. Backtest and forward segments chart as one timeline.
4. **Automated regressions**: each strategy pins a **baseline run**. A regression re-runs the
   config over the baseline's *fixed* window and diffs the metrics. The sim is deterministic and
   the window immutable, so any drift beyond a small tolerance (split/dividend restatements under
   `adjustment=all`) means the engine changed behavior — the resample-bug class, caught the same
   day. Runs nightly via the `trading-lab:<sub>` scheduler leg (created with the advisor's other
   legs) and on demand via `scripts/trading-regression-suite.ts` (exit 1 on drift, CI-friendly).
5. **Better data on the same keys**: lab fetches use `feed=sip` **historical** daily bars
   (consolidated tape — free on the existing paper key) with automatic IEX fallback; the feed is
   recorded on every run. Live/realtime stays IEX until a realtime-SIP decision (BACKLOG).
6. **Surface**: a **Strategy Lab** tab on `?app=trading` — strategy table with lifecycle +
   latest metrics, overlaid equity curves (lightweight-charts), a variation editor where every
   knob is labeled with its meaning, the exact algorithm formulas from `algorithms.ts`, and a
   "describe it in words" box that has the trading-analyst bot translate prose into knobs
   (`POST /api/trading/lab/draft`) — the operator reviews the filled form before saving; the AI
   does the math, the human sees every dial.

## Consequences

- The evidence base becomes queryable and chartable; strategy-log.md remains the narrative
  record, now pointing at persisted run IDs instead of console output.
- Regression drift is detected nightly instead of by the next human re-run.
- Forward curves make "the config we didn't deploy" an observable fact, at the cost of one
  batched daily-bars fetch per day per user with active strategies.
- Backtests run in-process on the api container (10–30 s for a 140-name, ~2-year walk); acceptable
  for v1, revisit if concurrent operators appear.
- The sim inherits the harnesses' honest limits: daily bars only (no 5-min exit legs), close
  fills, no slippage/commission. These are printed on every run row.

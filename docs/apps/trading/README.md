# Trading app docs

The trading advisor / autopilot stack (`?app=trading`). Decision workflow is ADR-053; the
gravity model is ADR-054; the swarm itself is ADR-052.

- [active-strategy.md](./active-strategy.md) — **the current production strategy, as built**:
  gravity rotation + SPY core, every knob with its evidence, the risk envelope, a trading day,
  and the standing rules. Start here.
- [backtest-regression-suite.md](./backtest-regression-suite.md) — the evidence base: every
  harness with its command, the verdict table (armed / rejected / killed / void), the feed rules
  (daily-on-IEX ok, intraday-needs-SIP), and how to add a new experiment.
- **Strategy Lab** ([ADR-092](../../adr/092-trading-strategy-lab.md)) — the persistent, in-product
  sibling of the CLI harnesses: save strategy variations, backtest them (runs persist with full
  equity curves), let each accrue a nightly **out-of-sample forward curve**, and auto-regress
  pinned windows so engine drift is caught the same day. Surface: the **Strategy Lab tab** on
  `?app=trading`; API: `/api/trading/lab/*`; CLI: `scripts/trading-regression-suite.ts`.
- [strategy-log.md](./strategy-log.md) — **the append-only record of every production config
  change and the backtest evidence behind it** (operator rule 2026-07-10: no change without a
  row here). Includes the void-before-2026-07-09 harness-bug notice.
- [adx-rsi-exhaustion-study.md](./adx-rsi-exhaustion-study.md) — **self-contained study writeup**
  (2026-07-22): does an ADX ≥ 40 + RSI extreme mark trend exhaustion? Rejected as an always-on exit
  (price *rises* after the break and beats a matched random-time control); strongly negative
  risk-off, logged as a generated hypothesis with an out-of-sample criterion. Also documents the
  structural finding that the 8% take-profit / 5-3 trail makes **any** hold-the-trend overlay
  unreachable. Written to stand alone outside the repo.
- [futures-stop-engine.md](./futures-stop-engine.md) — **the ADR-116 futures stop stack, as
  built** (2026-07-27): the three-layer exit system ported from the source trader's NT8 code
  (initial stop → breakeven-gated chandelier trail → the ADX-gated "Strangle" tight stop), the
  dictation-vs-code divergences shipped as config knobs, and the indicator-fidelity traps.
- [futures-backtester.md](./futures-backtester.md) — **the ADR-116 intraday backtester** — how to
  run it, the NinjaTrader fill rules that make results comparable (next-bar-open entries, intrabar
  stop triggers, gap fills), the trader's nine optimization objectives, the multi-market overlay,
  and the honest limits list to read before quoting any number.
- [advisor.md](./advisor.md) — the trading advisor: what it does and how to operate it.
- [advisor-deep-dive.md](./advisor-deep-dive.md) — deep dive into the advisor pipeline
  ([HTML](./advisor-deep-dive.html)).
- [gravity2-design.md](./gravity2-design.md) — Gravity-2 model design.
- [intraday.md](./intraday.md) — intraday / swing dispatch.
- [signal-dataset.md](./signal-dataset.md) — the trading signal dataset contract (consumed by
  `src/features/world-data/`).

Related: [../../backlog/trading-advisor.md](../../backlog/trading-advisor.md) — open work.
[../../runbooks/daily-trade-recap-pipeline.md](../../runbooks/daily-trade-recap-pipeline.md) —
the post-close recap pipeline (ADR-074).

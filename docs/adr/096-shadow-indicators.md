# ADR-096: Shadow indicators — the standard technical base earns weight before it votes

Date: 2026-07-13
Status: Accepted — Phase 1 implemented

## Context

The live ensemble votes with four algorithms (momentum, gravity, donchian, meanrev — ADR-052/054).
The 2026-07-13 strategy discussion (operator + trading friend) set a two-layer direction: a wider
*standard-indicator* base as the systematic foundation, with a deterministic fundamental-event
overlay to be layered on top later. The friend's key discipline, which the platform already
practices for its four live algos: **a signal earns its bet size from its measured record**.

Adding indicators straight into the voting ensemble would change live trading behavior with zero
evidence. The platform already has the honest pattern: `gravity2` is computed and recorded
head-to-head every night but deliberately excluded from the vote.

## Decision

1. **A second registry** in [algorithms.ts](../../src/features/trading/services/algorithms.ts):
   `SHADOW_ALGORITHMS` — six standard indicators as pure functions of daily OHLCV bars:
   - `macd` (12/26/9 histogram, price-relative noise floor)
   - `bollinger` (20/2σ band mean-reversion)
   - `atr-channel` (SMA20 ± 2×ATR14 volatility breakout)
   - `adx` (Wilder 14 trend-strength gate, ≥25 to fire, +DI/−DI direction)
   - `stochastic` (14/3 oversold/overbought *turns*, not levels)
   - `volsurge` (volume z ≥ 2 *confirming* a real price move — the 07-12 tape-quality lesson:
     volume required, price provides direction; heavy-but-flat tape is a no-call)
2. **Recorded, never voting**: `scoreSymbolShadow` runs them in the nightly assess batch
   ([trading-assess-dispatch.ts](../../src/app/trading-assess-dispatch.ts)) beside the live algos
   and gravity2; predictions land in the same `oshal_trading_predictions` ledger. The overnight
   review is generic (`GROUP BY algo`), so hit-rate / expectancy / mass accrue automatically and
   appear in `/api/trading/algo-stats`. The live vote path (`scoreSymbol` → `ensemble`,
   `ALGORITHMS`, `algoNames`) has **zero diffs** — separation is by construction, unit-tested.
3. **Data**: additive `barsBatchOhlcv` (same fetch as `barsBatch`, keeping o/h/l/v). Daily
   timeframe only, per the 07-12 feed ruling. Shadow recording is best-effort — a failed OHLCV
   fetch never blocks the live-algo recording.
4. **Promotion discipline**: after the record accumulates (guideline: ≥4 weeks, ≥100 resolved
   predictions, hit-rate/expectancy visibly non-random next to the incumbents), promoting an
   indicator = moving its function into `ALGORITHMS` in a reviewed commit **plus a strategy-log
   row** — the same bar as any config change. The learned masses then weight it like any voter.
   Demotion is the same move in reverse.

## Consequences

- Six new columns of evidence start accruing with tonight's assess run, at zero live risk.
- The library's "Fundamental event overlay + wider indicator base (design)" candidate advances:
  the indicator half of the prerequisite is built; the event-overlay work can proceed once the
  shadow record demonstrates the loop end-to-end.
- Shadow signals also become candidate rotation-rank material later (a `macd` rank in the Strategy
  Lab, blendable per ADR-095) — deliberately out of scope until the nightly record justifies it.
- Cost: one extra batched OHLCV fetch per assess run (~1 request); ~6 extra prediction rows per
  firing symbol per night.

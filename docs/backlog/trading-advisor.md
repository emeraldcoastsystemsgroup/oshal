# Trading Advisor — Backlog & Signal Tuning

A prioritized, tracked list of tuning and improvement work for the trading advisor
(ADR-052/053/054). Reference: **[apps/trading/advisor.md](../apps/trading/advisor.md)** (as-built). All items are
**paper-only** until live sign-off; none of this lifts the live gate.

Source of truth for the signal/money layers:
- Signals: [algorithms.ts](../../src/features/trading/services/algorithms.ts),
  [multi-timeframe.ts](../../src/features/trading/services/multi-timeframe.ts)
- Money: [portfolio.ts](../../src/features/trading/services/portfolio.ts)
- Learning loop: [trading-review-dispatch.ts](../../src/app/trading-review-dispatch.ts) +
  [trading-signal-weights.ts](../../src/app/trading-signal-weights.ts)
- Live consumption: [trading-schedule-dispatch.ts](../../src/app/trading-schedule-dispatch.ts),
  [trading-research-dispatch.ts](../../src/app/trading-research-dispatch.ts)

---

## Backlog — HIGH (correctness / dead tuning surfaces)

1. **`proximity` is learned but never used in the live vote (dead signal).** The overnight review
   computes and stores a per-algo `proximity` (recent reliability) and prints it on the "🧠 Overnight
   signal review" ticket — but [trading-signal-weights.ts:48-56](../../src/app/trading-signal-weights.ts#L48)
   `loadAlgoMasses` selects **only `mass`**, and the live ensemble
   ([trading-schedule-dispatch.ts:329](../../src/app/trading-schedule-dispatch.ts#L329) → `multiTimeframeScan`)
   consumes only that. So "how reliable a signal has been LATELY" influences nothing a trade does.
   **Fix:** either fold proximity into the effective weight (`weight = mass * proximity`, the gravity
   model's own intent — mass × proximity is exactly the `displacement` formula) or stop advertising it
   as a live dial. Recommended: wire it in; it's the system's only recency mechanism (see #5).

2. **Learning optimizes hit-rate, not expectancy.** `massFromEdge`
   ([trading-review-dispatch.ts:43](../../src/app/trading-review-dispatch.ts#L43)) rewards *direction
   accuracy* only. An algo that is right 55% of the time but whose 45% wrong calls are large losers
   gets `mass > 1` and pulls *harder*. This is the classic "high win-rate, negative expectancy" trap and
   directly contradicts the operator's "minimize the downside, don't bleed micro-losses" mandate.
   **Fix:** weight mass by realized per-prediction P&L / magnitude (average signed return when the algo
   fired), not just `hit`. Requires recording the realized move, not just the boolean, on prediction
   resolution.

3. **Vol-normalized sizing is inconsistent across legs.** The autopilot computes 14-day realized vol and
   passes it to `sizeEntry` ([trading-schedule-dispatch.ts:284-293](../../src/app/trading-schedule-dispatch.ts#L284)),
   so high-vol names get smaller positions. But the **research/fast legs** call `sizeEntry` with **no
   `volPct`** ([trading-research-dispatch.ts:102](../../src/app/trading-research-dispatch.ts#L102)) → `volScale = 1`
   → full-size. News-driven entries (the most volatile by definition) are exactly the ones sized without
   the downside-risk normalization. **Fix:** compute and pass `volPct` in the research/fast path too
   (extract the vol calc into a shared helper).

4. **The deployed posture is the worst performer in the only backtest we have.** Per
   [apps/trading/advisor.md](../apps/trading/advisor.md), the recent-window backtest: balanced +10.5%, aggressive
   +19.7%, **`active` (the deployed default) +5.6%** vs SPY +8.2% — i.e. the live posture *underperforms
   buy-and-hold* and every other posture in-sample. The high-turnover `active` profile churns away its
   edge (tight 8% TP + 5%/3% trail exits winners early; 5% stop + 3% daily halt whipsaws). **Fix:**
   treat posture choice as a tuning experiment — backtest `active` against the items below before keeping
   it as the live default, or move the live book to `balanced` until `active` is shown to beat it.

## Backlog — MEDIUM (signal quality)

5. **Mass is regime-blind and never decays.** `mass` is an all-history hit-rate shrunk toward neutral; a
   signal that worked in a bull regime keeps its inflated mass into a bear regime. `proximity` was meant
   to be the recency correction but it's dead (#1). **Fix:** wiring #1 gives recency for free; optionally
   add a half-life decay on stale predictions so the masses track the current regime.

6. **One mass per algo — not per timeframe.** The ensemble runs per-timeframe (5Min…3Month) but applies
   the **same** `algoWeights` to every timeframe ([multi-timeframe.ts:97](../../src/features/trading/services/multi-timeframe.ts#L97)).
   Momentum may be excellent on 1Day and noise on 5Min, yet gets one number. **Fix:** learn mass per
   `(algo × timeframe)` once sample volume supports it (predictions would need a timeframe column).

7. **Mean-reversion structurally fights the trend algos.** `meanrev` votes *buy* on RSI < 35 while
   `momentum`/`donchian`/regime all say *down* in the same selloff ([algorithms.ts:102](../../src/features/trading/services/algorithms.ts#L102)).
   Mean-reversion in a trending regime is the classic loss-maker; here it just dilutes the vote toward
   HOLD. **Fix:** gate `meanrev` to apply only in range-bound regimes (e.g. a low ADX / low trend-strength
   filter), and let the trend algos own trending regimes. This is the highest-leverage signal change.

8. **Hand-picked, uncalibrated confidence multipliers.** `momentum` confidence = `|gap| * 12`
   (saturates at an ~8.3% gap), `gravity` = `|d| * 2`, `donchian` = a flat `0.7`, `meanrev` scales off
   RSI distance ([algorithms.ts:99-102](../../src/features/trading/services/algorithms.ts#L99)). These
   constants aren't on a common scale, so momentum (which always fires and scales fast) dominates the
   blend while donchian (rare, fixed 0.7) barely tilts it — and `sizeEntry` then scales *position size*
   off this miscalibrated confidence. **Fix:** calibrate each algo's confidence to its own historical
   hit-rate (Platt-style), so "confidence 0.7" means the same thing across algos and feeds sizing honestly.

9. **No volume confirmation on breakouts.** `donchian` fires on a 20-day high/low close with no volume
   filter — breakouts on thin volume are the textbook fakeout. **Fix:** require above-average volume
   (already fetchable via `barsBatch`) to confirm a donchian vote.

10. **Non-standard RSI (simple average, not Wilder's).** `rsi()`
    ([algorithms.ts:52](../../src/features/trading/services/algorithms.ts#L52)) uses a simple sum over the
    window rather than Wilder's smoothing, so values won't match any charting platform and the 35/65
    thresholds are effectively bespoke. Low priority (it's self-consistent and the learning loop adapts),
    but worth a note before anyone tunes the thresholds against TradingView.

11. **Frozen timeframe weights.** `TF_WEIGHTS` (0.10/0.15/0.30/0.25/0.20) are hand-set and never learned,
    even though per-algo masses are ([multi-timeframe.ts:35](../../src/features/trading/services/multi-timeframe.ts#L35)).
    For a high-turnover `active` strategy, 5Min at 0.10 may be under-weighted on the *entry* decision.
    **Fix:** make timeframe weights learnable on the same predictions ledger, or at least posture-aware
    (a fast posture should lean shorter).

## Backlog — MEDIUM (money management)

12. **Trailing-stop giveback isn't vol-scaled.** `exitsToRun`/`trailingExits` widen the *hard stop* and
    *trail* by `stopMult`/`givebackMult` in thin sessions, but the giveback isn't scaled by the name's
    own volatility ([portfolio.ts:155](../../src/features/trading/services/portfolio.ts#L155)). On a volatile
    name the `active` 3% giveback = normal intraday wiggle → premature exit (feeds the #4 churn). **Fix:**
    scale `trailGivebackPct` by the same `volPct` already computed for sizing.

13. **Stop + daily-halt interaction can lock the book out of the bounce.** `active` = 5% hard stop + 3%
    daily-loss halt + up to 85% deployed across 32 names. A broad ~5% down-day stops out many names *and*
    trips the 3% daily halt, which then blocks re-entry on the recovery. **Fix:** model this in a backtest;
    consider a re-entry cooldown rather than a hard halt, or a wider stop paired with vol-sizing (#3).

14. **Rotation thresholds are hand-tuned magic numbers.** `ROTATION_HOT 0.30 / COLD 0.15 / MARGIN 0.25`
    ([portfolio.ts:206-208](../../src/features/trading/services/portfolio.ts#L206)) are unvalidated. Each
    rotation is a realized round-trip (cost in the live book later). **Fix:** sweep these in the backtest;
    confirm rotation adds expectancy net of its turnover before keeping it on the `active` default.

## Backlog — LOW / roadmap (from HANDOVER — needs external feeds or keys)

15. **CEO / X-timeline signal** — rail built; blocked on X API paid credits (402 CreditsDepleted).
16. **International pre-positioning** (overnight Asia/Europe → US pre-market bias) — needs an
    international index/futures feed (Alpaca is US-equities only).
17. **Pre-market increment scalp** (0.25 dip → sell/rebuy) — needs a sub-minute tick beyond the 2-min fast leg.
18. **Longer / multi-regime backtest** — needs a paid history feed (free IEX ≈ 149 daily bars, one regime).
    This is the prerequisite that makes #4, #13, #14 actually decidable.
19. **EDGAR FY alignment** — fundamentals can mispair revenue/net-income fiscal years for some names.
20. **Cockpit on/off toggle** on the trading page calling `POST/GET/DELETE /api/trading/autopilot`.

---

## Suggested sequencing

The cheap, high-confidence wins first (no new data feed needed): **#1 (wire proximity), #3 (vol-size the
research legs), #7 (gate mean-reversion to range regimes), #12 (vol-scale the trail).** Then the
expectancy rework **#2/#8** (needs recording realized move on resolution). Everything posture/backtest-
gated (**#4, #11, #13, #14**) waits on #18 — a longer history feed — to be decided honestly rather than
overfit to one 7-month regime.

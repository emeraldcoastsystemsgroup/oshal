# Trading Advisor (`?app=intelligent-trades`)

An autonomous, **paper-only** equities advisor: it reads the market across five timeframes plus news
and fundamentals, manages a book with diversification + stop/trailing/drawdown protection, rotates
capital to the strongest names, trades pre-/regular/post-market, learns overnight which signals
actually predict, and forecasts the next session — all through the swarm's accountable bot rails
(ADR-052 / ADR-053), so every order chains back to the signal that justified it.

> **Paper-only by contract.** Autonomous live trading is refused everywhere; a live book stays behind
> `TRADING_LIVE_ENABLED` + an explicit per-order confirm (ADR-052). Nothing here can place a real order.

## How it runs — five scheduled legs

The advisor is five per-user schedules on the shared agent scheduler (`trading-*:<sub>`). Enable them
all with one switch (below). Each leg runs in the controller — deterministic, no LLM on the technical
path; the news leg is the only one that calls the `trading-analyst` LLM.

| Leg | taskType | cadence | What it does | Hours |
|---|---|---|---|---|
| **Autopilot** | `trading-autopilot` | every 5 min | Multi-timeframe trend → portfolio-sized trades + protective exits + rotation | pre/regular/post |
| **Research** | `trading-research` | every 15 min | Fresh news + EDGAR fundamentals → `trading-analyst` LLM → portfolio-sized trade | pre/regular/post |
| **Fast** | `trading-fast` | every 2 min | Same as research but only <3-min-old headlines (rides the continuation) | pre/regular/post |
| **Assess** | `trading-assess` | every 2 h | Forecast: writes next-session predictions + a ranked plan; records raw per-algo predictions | always (incl. overnight) |
| **Review** | `trading-review` | overnight (06:30 UTC) | Scores each signal's hit-rate → learns per-signal **mass + proximity** for the ensemble | always |

A run that trades posts a `trading-decision` ticket (the journal). The autopilot self-skips when there's
no tradable session; assess + review ignore market hours.

## The decision engine

- **Multi-timeframe ensemble** ([multi-timeframe.ts](../../../src/features/trading/services/multi-timeframe.ts)):
  each ticker is scored across **5Min / 1Hour / 1Day / 1Week / 3Month** bars by the deterministic algo
  ensemble (momentum / gravity / donchian / mean-reversion), weighted toward the longer trends. A
  **regime-alignment gate** blocks buying into a bearish weekly/quarterly trend (and vice-versa) — the
  primary risk control. Output: buy/sell/hold + score + confidence + regime per name.
- **Default universe**: ~100 liquid US large-caps across tech / financials / blue-chip / energy / pharma.
- **News + fundamentals** ([trading-research-dispatch.ts](../../../src/app/trading-research-dispatch.ts)): the
  research/fast legs pull symbol-tagged Alpaca news + SEC EDGAR fundamentals (revenue YoY, net margin)
  and hand both to the `trading-analyst` LLM, which reasons a justified decision; the money-manager
  then sizes it. (CEO/X-timeline signals are a planned add — blocked on X API credits, see Limits.)

## Money management ([portfolio.ts](../../../src/features/trading/services/portfolio.ts))

The "how to manage the money" layer above execution. Risk **posture** (`TRADING_RISK_POSTURE`, default
`balanced`; the deployed bot runs `active`) sets every dial. All cap %s are of account equity.

| Posture | per-name | per-sector | deployed | max names | stop | take-profit | trail (arm/give) | daily-loss halt | max drawdown |
|---|---|---|---|---|---|---|---|---|---|
| conservative | 3% | 12% | 30% | 12 | 5% | 12% | 6% / 3% | 2% | 8% |
| balanced | 5% | 22% | 60% | 16 | 9% | 20% | 8% / 4% | 4% | 12% |
| aggressive | 10% | 40% | 95% | 12 | 15% | 35% | 12% / 7% | 7% | 25% |
| **active** (deployed) | 3% | 25% | 85% | 32 | 5% | 8% | 5% / 3% | 3% | 10% |

Each fire: **(1)** protective exits — hard stop, take-profit, trailing stop, intraday breakdown;
**(2)** **rotation** (coach the team) — bench a cold held name (even a usual starter) to free capital
when a meaningfully hotter name is on the bench; **(3)** new entries — ranked by conviction, sized to
the tightest cap, screened by the regime gate, falling-knife filter, and world-sentiment veto.

## Protection stack

In order of escalation:

1. **Regime-alignment gate** — never buy into a falling higher-timeframe trend.
2. **Falling-knife / short-timeframe breakdown** — don't catch a name crashing on 5Min+1Hour; exit a held one that is.
3. **Per-trade stops** — hard stop-loss + take-profit + trailing stop (locks gains on a reversal).
4. **Daily-loss halt** — pause new buys when the open book is down past the posture's daily threshold.
5. **Account-drawdown circuit breaker** ([trading-equity-guard.ts](../../../src/app/trading-equity-guard.ts)) —
   persistent equity high-water-mark; halts **all new entries** while equity is `maxDrawdownPct` below
   its peak (exits still run) until it recovers. Catches a sustained bleed the per-trade stops miss.
6. **World-sentiment veto** — skip a buy the press/influencers are actively souring on.
7. **Global kill-switch** — `TRADING_HALT=true` stops every trade leg instantly.
8. **Paper-only** — the whole thing cannot place a live order.

## Extended-hours trading

Trades **pre-market (04:00–09:30 ET), regular, and post-market (16:00–20:00 ET)** — weekends/holidays
are correctly closed (Alpaca clock + calendar; see `tradingSession`/`tradableSession` in
[market-data.ts](../../../src/features/trading/services/market-data.ts)). Alpaca rejects market orders
off-hours, so in pre/post sessions `placeDecisionOrder` converts the order to a **marketable limit**
(day) with `extended_hours=true`; the slippage buffer crosses the wider spread to fill.

## Overnight learning loop (mass + proximity)

The gravity model tunes itself. The **review** leg ([trading-review-dispatch.ts](../../../src/app/trading-review-dispatch.ts)):
resolves matured predictions, scores each signal (algo) by hit-rate from the predictions ledger, and
writes a learned **MASS** (predictive edge, sample-shrunk toward neutral) and **PROXIMITY** (recent
reliability) per signal ([trading-signal-weights.ts](../../../src/app/trading-signal-weights.ts)). The live
ensemble loads the masses so a proven signal pulls harder and a useless one fades. It's additive and
self-tuning — **no data → mass 1.0 → raw engine** — and sharpens over the first several days as
predictions mature (18-h horizon). Each run posts a "🧠 Overnight signal review" ticket.

## Backtest

[scripts/oshal-trading-backtest.ts](../../../scripts/oshal-trading-backtest.ts) walks the **same** pure
functions the live bot uses over Alpaca daily bars and reports return / max-drawdown / Sharpe /
win-rate vs SPY buy-&-hold:

```bash
npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-trading-backtest.ts [posture] [warmupDays]
```

**Honest limits**: free IEX history is ~149 daily bars (~7 months, one regime); daily-only (the
intraday legs aren't modeled); fills at close, no slippage/commission. It's a **logic + risk sanity
check**, not a return promise. ~~Recent-window result: balanced +10.5% / aggressive +19.7% beat SPY
+8.2% with max drawdown ≤ 6.4%; the high-turnover `active` default churned to +5.6%.~~
**⚠️ Those numbers are VOID** — measured before the 2026-07-09 resample-bug fix (`cad41dc5`) that
invalidated all prior harness output. Current, fixed-harness numbers and every config change since
live in [strategy-log.md](./strategy-log.md).

## Operating it

**Prereqs:** `ENABLE_AGENT_SCHEDULER=true`, Alpaca paper keys (`ALPAKA_KEY` / `ALPAKA_SECRET` /
`ALPAKA_ENDPOINT` — the `ALPAKA_*` spelling is the accepted alias), Redis.

**Enable / stop the whole advisor:**
```bash
# Headless (writes all 5 schedules to Redis for a user):
REDIS_URL=redis://localhost:16379 npx ts-node -r tsconfig-paths/register --transpile-only \
  scripts/enable-trading-autopilot.ts <user_sub>
# Or via the API (caller-scoped, auth-gated):
POST   /api/trading/autopilot     # enable all legs   { cron?, universe?[] }
GET    /api/trading/autopilot     # status (per-leg)
DELETE /api/trading/autopilot     # stop all legs
```

**Watch it:** `GET /api/trading/recommendations` (live ranked plan), `GET /api/trading/algo-stats`
(per-signal hit-rate), the `trading-decision` tickets (journal), and `oshal_trading_predictions` /
`oshal_trading_signal_weights` tables.

### Tunable knobs (env)

| Var | Default | Effect |
|---|---|---|
| `TRADING_RISK_POSTURE` | `balanced` (deployed `active`) | conservative / balanced / aggressive / active |
| `TRADING_EXTENDED_HOURS` | **off** (2026-07-12) | trade pre/post-market. **Off because it cannot be priced:** the free Alpaca plan is IEX-only and IEX operates 08:00–17:00 ET, printing *zero* trades 04:00–07:59 and 17:00–19:59. Measured: 529 of 593 extended-hours orders never filled, vs 97% in the regular session. Needs real-time SIP to re-enable — see the [strategy log](./strategy-log.md). |
| `TRADING_EXT_LIMIT_SLIPPAGE_PCT` | 0.3 | how hard ext-hours limits cross the spread |
| `TRADING_HALT` | off | **kill-switch** — stop every trade leg |
| `TRADING_MAX_QTY` / `TRADING_MAX_NOTIONAL_USD` | 100 / 1000 | hard per-order guardrails |
| `TRADING_SYMBOL_ALLOWLIST` | (all) | restrict to a symbol set |
| `TRADING_ALGO_QTY` | 1 | fixed qty for the deterministic algo path |
| `TRADING_LIVE_ENABLED` | off | the (separately-gated) live book |

## Limits / roadmap

- **CEO / X-timeline signals** — the rail is built ([oshal-x-read.js](../../../scripts/oshal-x-read.js) reads
  your connected account's home timeline), but X's API now meters reads behind paid credits (live test
  returned `402 CreditsDepleted`). Wires the instant the X API account is funded. News already catches
  much of the CEO/market-moving signal for free.
- **International pre-positioning** (overnight Asia/Europe → US pre-market bias) — needs an
  international index/futures data feed (Alpaca is US equities only).
- **Pre-market increment scalp** (e.g. 0.25 dip → sell/rebuy) — needs a sub-minute tick beyond the
  2-minute fast leg.
- **Longer / multi-regime backtest** — needs a paid history feed.

## Source map

- Engine: [src/features/trading/services/](../../../src/features/trading/services/) — `multi-timeframe`, `portfolio`, `algorithms`, `market-data`, `fundamentals`, broker adapters
- Legs (app layer): [src/app/](../../../src/app/) — `trading-schedule-dispatch` (autopilot), `trading-research-dispatch`, `trading-assess-dispatch`, `trading-review-dispatch`, plus the `trading-equity-guard` / `trading-signal-weights` / `trading-peaks-store` stores and `trading-reconcile`
- Scheduler wiring: [schedule-runtime.ts](../../../src/app/schedule-runtime.ts)
- Routes (carved to the store package per ADR-085): [trading-routes.ts](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/trading/src-routes/trading-routes.ts) (the app) + [trading-autopilot-routes.ts](https://github.com/emeraldcoastsystemsgroup/oshal-applications/blob/main/trading/src-routes/trading-autopilot-routes.ts) (control)
- Manifest: [trading store package](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/trading) (carved per ADR-085) · ADRs: [052](../../adr/052-stock-trading-swarm.md), [053](../../adr/053-trading-decision-workflow.md)

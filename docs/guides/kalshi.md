# Kalshi — monitoring wins, reading reports, and cross-referencing the ledger

The Kalshi app (`/cockpit/?app=kalshi`, or the **Kalshi Edge** tile) scans every open event
contract on an hourly cadence, announces hands that clear your alert floor to Jarvis, and
records every one of them as a prediction that reality grades at settlement. This guide is
how to watch that record, where the reports are, and how to ask your own questions of it.
Design and verdicts live in [docs/apps/kalshi/](../apps/kalshi/README.md).

One rule underlies everything below: **a strategy earns the right to stake by beating the
market's own Brier score on settled predictions.** Until then its suggested stake is 0%, the
hands are still shown, and nothing is ordered without your confirmation.

## Where wins and losses show

| I want to see… | Where |
|---|---|
| Whether each strategy is winning, and whether it may stake | **Scorecard** tab — status (UNPROVEN / FAILING / PROVEN), graded and pending counts, our Brier vs the market's, hit rate, P&L per contract. One row per strategy, including the zero-stake forward tests. |
| The outcome of every hand Jarvis actually announced | **Alerts** tab — each announced hand carries WIN / LOSS (or *open* until it settles) and the one-contract P&L, with a **Record** line above the table: W – L, hit rate, average and total P&L, how many are still open. Paper numbers: an alert never places an order. |
| What the scan believes right now | **Scan** tab — the ranked hands from the last snapshot, with true P, price, net edge, suggested stake, risk flags, and the snapshot's age. |
| Real money: balance, positions, resting and past orders | **Account** tab, and `GET /api/kalshi/orders/history`. Every order attempt is audited, refusals included. |
| The same, from Jarvis | Ask *"what did the Kalshi scan find?"* — Jarvis answers from the announced hands in his feed, not a fresh scan. Alerts arrive summarized ("16 new updates from Kalshi") and are read out only when you ask. |

## The reports

**Daily grading run.** Every day at 07:30 the "OSHAL Kalshi Forward Test" scheduled task runs
the grader and the weather forward test from this checkout. Its log is
`output/kalshi/forward-<date>.log`. The grader prints the forward-test scorecard (hit rate, our
Brier, the market's Brier, verdict, P&L) and the measured forecast-error model per city.

**The cross-reference report.** One command, read-only, over the whole ledger:

```bash
npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-report.ts
# options: --strategy weather-enso    --flip-spread 6    --json
```

It prints, in order:

1. **Scorecard** — the staking gate, same numbers as the tab.
2. **Forward tests in progress** — strategies with fewer than 30 graded rows: registered, graded/30, Brier so far.
3. **Hands Jarvis announced** — the W – L record of what was actually surfaced to you.
4. **By price paid** — each strategy in five bands (longshot, 20–40¢, even money, 60–80¢, favorite): hit rate, average price, **breakeven** (price plus fee), P&L before fee, fees, after fee. A cell only pays when hit beats breakeven.
5. **By our confidence** — the same, cut by how sure the model was. This is where you check whether "80% confidence" actually wins 80%.
6. **What if we had taken the other side** — every as-bet total against the flip, priced at one minus our bid plus the spread you pass (default 3¢), fees included.
7. **Real orders** — every attempt in the audit table by exchange and status.

`--json` emits the same sections as one object for anything downstream.

## Cross-referencing yourself

Everything the app knows is in five Postgres tables, and the report above is only SELECTs over
them. From the host:

```bash
docker exec oshal-local-db psql -U oshal -d oshal
```

| Table | What a row is |
|---|---|
| `kalshi_predictions` | **The ledger.** One pre-registered prediction per (strategy, ticker), immutable once made: `side`, `predicted_prob` (ours), `market_prob` (the ask paid), `edge_net`, `stake_fraction`, `rationale` (JSON: what the model used), then at settlement `settled`, `settled_yes`, `brier`, `market_brier`, `pnl_per_contract`, `graded_at`. |
| `kalshi_scan_alerts` | Every hand announced to a user, once, with the hand as it looked (`detail`). Join to the ledger on `ticker` with `strategy = 'calibration'` for its outcome. |
| `kalshi_orders` | Every order attempt, including refusals and exchange rejections, with the justifying hand snapshot. |
| `kalshi_forecast_log` | Each NWS forecast the weather strategy used and, once known, the observed high — the forecast-error model is measured from these. |
| `kalshi_scan_snapshots` | The last scan result the Scan tab serves. |

The one join that answers most questions — a strategy's settled record cut any way you like:

```sql
SELECT strategy,
       count(*)                                              AS n,
       round(100.0 * avg(((side='yes') = settled_yes)::int), 1) AS hit_pct,
       round(100 * avg(market_prob), 1)                      AS price_pct,
       round(100 * avg(market_prob + 0.07*market_prob*(1-market_prob)), 1) AS breakeven_pct,
       round(sum(pnl_per_contract), 2)                       AS pnl
FROM kalshi_predictions
WHERE settled
GROUP BY strategy;
```

Add `AND predicted_prob >= 0.8`, or `AND market_prob BETWEEN 0.4 AND 0.6`, or
`AND rationale->'riskFlags' ? 'wide-spread'` to cut it. `pnl_per_contract` is the grader's
number: one contract bought at the ask, fee included, so sums are "had I bought one of each".

For scripting against the running app rather than the database, the same data is served
caller-scoped at `/api/kalshi/scorecard`, `/api/kalshi/alerts` (rows plus `record`),
`/api/kalshi/orders/history`, `/api/kalshi/portfolio`, and `/api/kalshi/status` — all behind
your cockpit session.

## Running an algorithm through the judge

Any new idea is a **strategy**, and a strategy is a set of pre-registered predictions. The
grader and the Scorecard tab are generic: a new `strategy` name in `kalshi_predictions` is
graded the next morning and appears on the tab with no other change.

- **The rule is written before the first prediction**, with a date. Each prediction stores
  `predicted_prob`, `market_prob` (the ask you would pay for the side you take), `side`,
  `close_time`, and a `rationale` that makes a loss diagnosable. `stake_fraction` is 0 until
  the Scorecard says PROVEN.
- **30 graded rows** before the verdict means anything (`KALSHI_MIN_GRADED`). Beating the market's
  Brier is the bar; hit rate alone is not, because a 90% hit rate on 93¢ contracts loses money.
- **Two live templates:** `contrarian-extreme` (the kalshi package pre-registers the opposite
  side of every extreme scan hand) and `contrarian-weather-disagree`
  (`scripts/kalshi-contrarian.ts`, the opposite side of every weather pick that disagrees with the
  market by 30+ points). Both are zero-stake hypotheses that came out of the report above.
- **What can be back-tested.** Anything that depends on our model can only be scored on our own
  record (the ledger, from July 13). Rules that depend only on price can be walked over the
  exchange's candle history per market (`getCandles` in the public client) — blind-forward, the
  way `scripts/oshal-trading-news-materiality-backtest.ts` walks the trading tape.
- **Don't try many variants and keep the winner.** Fourteen contrarian variants were scored on
  the same data and two looked good; that is what dredging finds. Register one, wait for the
  judge. The full reasoning and the variant table are in
  [strategy-verdict.md](../apps/kalshi/strategy-verdict.md).

## Placing a bet, when a strategy has earned it

Orders are limit-only (1–99¢), confirm-gated, capped at 100 contracts / $50, and audited. The
API key lives in the Kalshi connector card on `/utilities`, never in `.env`. A **demo** key made
default routes orders to the demo exchange with no flag; the **live** key needs
`KALSHI_LIVE_ENABLED=true` in `.env` and a redeploy. The Bet dialog's limit price is yours to
set: posting at the bid instead of taking the ask pays no taker fee on ordinary series and earns
the spread rather than paying it, at the cost of waiting for a fill. Details in
[edge-engine.md](../apps/kalshi/edge-engine.md).

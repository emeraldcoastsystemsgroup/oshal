# Kalshi edge engine — as built

`?app=kalshi` (also pinned in the default cockpit ribbon's **Money** group as "Kalshi Edge").
Read-only in this phase: no Kalshi account is required to browse the edge scan, because Kalshi's
market data — order books, trade tape, candlesticks, settled markets with results — is fully
public. Only portfolio/order endpoints need credentials, and those aren't wired up yet (see
Phase 2 below).

## What it does

Every open Kalshi contract is evaluated like a poker hand:

- **Hand strength** = a calibrated true probability, learned from Kalshi's own settled-market
  history (not a hardcoded model, not vibes).
- **Pot odds** = the side's ask price plus Kalshi's real taker fee for that series.
- **Play/fold** = the hand is only playable when strength beats pot odds by a margin the
  evidence supports; everything else folds. An empty result table means the engine folded
  everything — that's the system working, not an outage.
- **Sizing** = quarter-Kelly, halved per risk flag (wide spread, thin book, low open interest,
  thin calibration sample, long-dated), capped at 5% of bankroll.

**Read [calibration-verdict.md](./calibration-verdict.md) before trusting any number the scan
shows you.** The first calibration run looked like a strong edge and was NOT — see that doc.

## Architecture

| Piece | File | What it does |
|---|---|---|
| Public data client | [kalshi-public-client.ts](../../../src/features/prediction-markets/services/kalshi-public-client.ts) | Markets (paged + in-stream filtered), series metadata, candlesticks, exchange status. Throttled ~3rps (the public tier 429s near 5rps sustained); `KALSHI_API_BASE` switches prod ↔ `demo-api.kalshi.co`. |
| Fee math | [kalshi-fees.ts](../../../src/features/prediction-markets/services/kalshi-fees.ts) | Kalshi's quadratic taker fee — `ceil_cents(0.07·mult·C·P·(1−P))` — read from each series' own `fee_type`/`fee_multiplier`, not a hardcoded schedule. |
| Calibration | [calibration.ts](../../../src/features/prediction-markets/services/calibration.ts) | Buckets settled-market (price, outcome) samples by category × horizon, beta-shrinks the empirical rate toward the market price so **no history ⇒ no edge, by construction**. Includes a contradiction guard: a category's own thin bucket can veto a pooled-fallback edge that disagrees in sign. |
| Bet evaluator | [bet-evaluator.ts](../../../src/features/prediction-markets/services/bet-evaluator.ts) | Two-sided evaluation, net-of-fee edge, Kelly sizing, risk flags, poker-style strength classes. Hard-folds anything more than 48h from close (no measured calibration horizon covers it) and keeps only one hand per event (same-event strikes are correlated, not independent bets). |
| Auth (Phase 2 groundwork) | [kalshi-auth.ts](../../../src/features/prediction-markets/services/kalshi-auth.ts) | RSA-PSS request signing per Kalshi's spec, PEM normalization for pasted keys, an authed balance probe. |
| Types | [types.ts](../../../src/features/prediction-markets/types.ts) | `KalshiMarket`, `KalshiSeriesMeta`, `KalshiCandle`, `CalibrationTable`, `BetHand`. |
| Routes | `kalshi/src-routes/kalshi-routes.ts` in the [oshal-applications store](https://github.com/emeraldcoastsystemsgroup/oshal-applications) (carved 2026-07-19, ADR-085 Wave 3) | `GET /` (surface), `GET /scan` (cached ranked hands, 2-min TTL), `GET /calibration`, `GET /status`, plus the Phase-2 portfolio/orders layer. Package-mounted at `/api/kalshi` (auth: service-or-oidc); handlers also self-gate via `callerSub`. |
| Surface | `kalshi/tools/kalshi.html` in the store package (carved with the routes) | The ranked-hand table: strength badge, side, price, calibrated true probability, net edge, stake, confidence bar, risk flags, time-to-close. Filterable by category/strength/text. |
| App manifest | `kalshi/oshal-app.yaml` in the store package (was `swarm-apps/kalshi.yaml` before the carve) | Registers `?app=kalshi` (own ribbon, midnight theme) per the eats/trading pattern. |
| Default-ribbon pin | [config-seed/profiles/oshal-framework.json](../../../config-seed/profiles/oshal-framework.json) | `tool-kalshi-home` in the `Money` group, so the tile is visible on plain `/cockpit/` without `?app=`. |
| Connector card | [connectors-routes.ts](../../../src/app/routes/connectors-routes.ts) / [connector-account-lookup.ts](../../../src/app/routes/connector-account-lookup.ts) | Two-value paste on `/utilities`: API Key ID + the downloaded RSA private-key PEM, stored `keyId:PEM`. Validated by RSA-PSS-signing a real `GET /portfolio/balance` call (there is no bearer token to check against — every Kalshi request is signed). Broker key `OSHAL_CRED_KALSHI`. |
| Scripts | [oshal-kalshi-calibration.ts](../../../scripts/oshal-kalshi-calibration.ts) / [oshal-kalshi-scan.ts](../../../scripts/oshal-kalshi-scan.ts) | Run the calibration study (writes `config-seed/kalshi-calibration.json` + a dated evidence doc) and the live scan (writes a dated snapshot for later grading against settlements). |
| Tests | [kalshi-edge-engine.spec.ts](../../../tests/unit/kalshi-edge-engine.spec.ts) | 9 unit specs pinning the fee ceiling/multiplier, calibration shrinkage (incl. the no-history-⇒-price-back case), Kelly sizing, risk-flag discounts, event dedup. |

## Running the study and scan yourself

```bash
# Rebuild the calibration table from Kalshi's settled-market tape (no credentials needed)
npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-calibration.ts

# Scan today's open markets against that table, print ranked hands, write a gradeable snapshot
npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-scan.ts
```

The flat `/markets` feed is >99% auto-generated multivariate parlay legs with empty books — both
the calibration study and the scan walk/filter the feed rather than paging it blind
(`listMarketsFiltered` / per-series `listSeries` discovery in the public client).

## Phase 2 (BUILT): portfolio + confirm-gated orders

Connect an account on `/utilities` (kalshi.com → Settings → API keys; a paper account lives at
demo.kalshi.co) and the surface gains an account strip (balance, open positions, resting orders
with one-click cancel) and a **Bet** button on every playable hand. The button opens a confirm
dialog pre-sized to the engine's Kelly stake against your real balance, showing cost, estimated
fee, payout, and max loss before you commit.

**Which exchange a key belongs to is auto-detected** — the live registry is tried first, demo on
a 401, cached per key id. There is no environment variable to set, and none to get wrong: a key's
exchange is a property of the key, not of process config. (`KALSHI_API_BASE` exists only to
override the *market-data* base and should normally stay unset — pointing market data at the demo
book would poison the edge scan.)

**Four guards stand between the UI and a real bet** — all live-verified against the exchange:

| Guard | Behavior |
|---|---|
| Live-money gate | The server reads the key's **detected** exchange (never a client-supplied flag) and refuses live orders unless `KALSHI_LIVE_ENABLED=true`. Default: demo only. |
| Explicit confirm | `confirm` must be exactly `true` — not merely truthy — so a UI bug can't fabricate consent. |
| Limit-only | Prices bounded to 1..99¢. No market orders (a footgun on thin prediction-market books). |
| Size + cost caps | 100 contracts / $50 per order (`KALSHI_MAX_CONTRACTS`, `KALSHI_MAX_ORDER_COST_DOLLARS`). |

Every order — **including exchange rejections** — is written to `kalshi_orders` (migration 074)
with the `BetHand` snapshot that justified it. A bet with no recorded justification is
unrepresentable, and that audit trail is what makes grading picks against settlements possible.

Endpoints: `GET /api/kalshi/portfolio`, `POST /api/kalshi/orders`, `DELETE /api/kalshi/orders/:id`,
`GET /api/kalshi/orders/history`.

**Before you enable live orders**, read [calibration-verdict.md](./calibration-verdict.md) — the
edge the scan currently shows did not survive adversarial review. Paper-trade first; the demo
exchange exists precisely so fake money absorbs the mistakes.

## Known limitation: deploy lag

`config-seed/profiles/oshal-framework.json` is bind-mounted, so the Money-group tile appears on a
running cockpit immediately after a hard refresh. The `/api/kalshi` route itself is baked into
the Docker image, so the tile 404s until the next image rebuild + parity recreate.

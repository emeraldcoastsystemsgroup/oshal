# ADR-094: Kalshi Prediction-Markets App — calibration-based edge before execution

## Status

Accepted — 2026-07-13. **Phase 1 (edge engine + app surface + connector card) and Phase 2
(portfolio + confirm-gated order placement) are both BUILT and live-verified.** Live orders
remain hard-gated off (`KALSHI_LIVE_ENABLED`, default false) — the demo exchange is the only
order target until the calibration re-study lands.

**Verification note (same night):** a 4-skeptic adversarial review judged the first calibration
tables **not tradeable as measured** (stale-price basis without spread, series pseudo-replication,
multiplicity; the edge vanishes in Sports where fills exist). Guards were landed immediately
(>48h hard fold, one-hand-per-event, pooled-contradiction veto, 10-lot fee basis) and the
re-study spec is in BACKLOG. The sole surviving candidate cell — YES at 0.50–0.60 — awaits an
ask-priced, cluster-robust, out-of-sample pre-registered re-test. See the verification section of
`docs/evidence/kalshi-calibration-2026-07-13.md`.

## Context

Operator ask (2026-07-13 session): integrate Kalshi (CFTC-regulated event-contract exchange) as a
dedicated trading platform inside OSHAL, with the explicit priorities "this is about winning, not
easy-to-use", "we need predictive market indicators", and "identify the bets and weigh the risk —
like a poker hand but with probability".

Facts that shaped the design:

- **Kalshi's market data is fully public** — markets, order books, trade tape, candlesticks,
  series metadata, and (critically) **settled markets with results** need no credentials. Only
  portfolio/order endpoints require auth (API-key-ID + RSA-PSS-signed requests; there is no
  bearer token).
- **Fees decide viability.** The taker fee is quadratic — ceil-to-cent of `0.07·mult·C·P·(1−P)` —
  and the per-series `fee_type`/`fee_multiplier` are exposed by the API itself. Any "indicator"
  that ignores fees will happily recommend −EV bets near 50¢ where the fee peaks (~1.75¢).
- **Prediction markets have a documented favorite-longshot bias** (longshots overpriced, heavy
  favorites underpriced). Whether and where it exists on Kalshi is measurable from Kalshi's own
  settled tape rather than assumed from literature.
- The flat settled-market feed is >99% auto-generated multivariate parlay legs; usable history
  must be collected per real series (discovered via `/series?category=`).
- Robinhood was evaluated and rejected for the same slot: no sanctioned public API for equities
  (their agentic-trading MCP is a possible future connector; their event contracts are Kalshi
  under the hood anyway).

## Decision

1. **An application-framework add-on, not a bolt-on.** `swarm-apps/kalshi.yaml` registers
   `?app=kalshi` (own ribbon, midnight theme) exactly like eats/trading; `createKalshiRoutes`
   serves the surface + JSON feeds at `/api/kalshi` behind `serviceSecretOr(requiresAuth)` with
   per-handler `callerSub` gates; the domain logic lives in a proper FSD slice,
   `src/features/prediction-markets/`.

2. **Edge is empirical or it doesn't exist.** The only probability model in Phase 1 is
   **calibration**: settled-market history bucketed by (category, time-to-close horizon, price)
   giving the observed settle-YES rate per bucket (`scripts/oshal-kalshi-calibration.ts`,
   refreshable; table lands in `config-seed/kalshi-calibration.json` + an evidence doc). Lookups
   are **beta-shrunk toward the market price** (k pseudo-observations), so a bucket with no
   history returns the market's own probability — **no history ⇒ no edge ⇒ fold, by
   construction**. The engine cannot manufacture conviction from thin air.

3. **The poker-hand frame is the product.** Every open market is evaluated two-sided
   (`bet-evaluator.ts`): hand strength = calibrated true probability off the book mid; pot odds =
   the side's ask **plus the taker fee** (per-series fee model from the API); sizing =
   quarter-Kelly, halved per risk flag (wide-spread / thin-book / low-oi / low-sample /
   long-dated), capped at 5% of bankroll; classes `monster / strong / playable / fold`. The
   surface is a ranked hand table — an empty table is the system folding, which is correct
   behavior, not an error state.

4. **Credentials follow the connector rails (ADR-042), with a signed-probe validation.** Kalshi
   is a two-value paste card (API Key ID + downloaded private-key PEM, stored `keyId:PEM`);
   validation **signs a real `/portfolio/balance` call** (fails closed). `OSHAL_CRED_KALSHI`
   brokers it to bots. PEM normalization tolerates newline-mangled pastes. BYOK — never a
   platform key.

5. **Execution starts on the demo exchange, and real money is gated off by default.** (Built
   2026-07-13.) Four independent guards, each live-verified against the real exchange:
   - **The live gate reads the key's DETECTED exchange, never a client-supplied flag.** Auth
     env is a property of the KEY (auto-detected: live registry first, demo on 401, cached per
     key id) — an earlier `KALSHI_API_BASE` env switch was wrong twice over: compose never
     forwards `.env` into containers, *and* a global switch would have pointed public market
     data at the thin demo book. Live orders additionally require `KALSHI_LIVE_ENABLED=true`.
   - **Limit orders only** (1..99¢) — market orders are a footgun on thin books.
   - **Explicit confirmation**: `confirm` must be exactly `true`, not merely truthy.
   - **Size + cost caps** (100 contracts / $50 per order, env-tunable).
   Every order — *including exchange rejections* — is audited to `kalshi_orders` (migration 074)
   with the `BetHand` snapshot that justified it: a bet with no recorded justification is
   unrepresentable, the same principle as ADR-052's decision-FK. That audit trail plus the scan
   snapshots (`docs/evidence/kalshi-scan-*.json`) are what make grading picks against settlements
   possible before real money moves.

Reader-facing as-built docs: [docs/apps/kalshi/edge-engine.md](../apps/kalshi/edge-engine.md)
(architecture) and [docs/apps/kalshi/calibration-verdict.md](../apps/kalshi/calibration-verdict.md)
(the verification verdict, in full).

## Consequences

- Indicators beyond calibration (cross-venue divergence vs Polymarket, orderbook imbalance,
  news-latency signals reusing the trading app's news pipeline) plug in as additional
  probability estimators feeding the same evaluator — they must move `trueProb`, not bypass the
  fee/Kelly/risk machinery. Backlogged.
- The calibration table is a point-in-time artifact; it must be re-run periodically (and the
  scan degrades toward "fold everything" as it stales — safe failure direction). A scheduled
  refresh is backlog work.
- 15-minute crypto churn markets never accumulate calibration samples at the 1h+ horizons and
  are therefore effectively untradeable by this engine — intentional; that cadence is a
  market-maker's game, not a calibration edge.
- The one-market-at-a-time Kelly ignores correlation across same-event markets; the evaluator
  flags but does not net exposures. Known limitation, revisit before live sizing.

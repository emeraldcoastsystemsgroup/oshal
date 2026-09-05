# Kalshi app docs

Prediction-markets edge engine (`?app=kalshi`, and a **Kalshi Edge** tile in the default cockpit's
Money group). Design decision is [ADR-094](../../adr/094-kalshi-prediction-markets-app.md).

- [Operating guide](../../guides/kalshi.md) — **monitoring wins, the reports, cross-referencing the
  ledger, and running a new algorithm through the judge.** Includes the one-command cross-reference
  report (`scripts/oshal-kalshi-report.ts`).
- [edge-engine.md](./edge-engine.md) — what's built, as-built: the public data client, the fee
  math, the price→outcome calibration, the poker-hand bet evaluator, the surface, the connector.
  Start here.
- [strategy-verdict.md](./strategy-verdict.md) — **START HERE before proposing a new strategy.**
  Three families tested (calibration / structural arbitrage / naive information edge), three
  falsified. Records the four self-caught errors that each briefly looked like free money, and
  what winning would actually require.
- [calibration-verdict.md](./calibration-verdict.md) — the honest state of the edge claim: the
  first study looked like a strong favorite-longshot bias; a 4-skeptic adversarial review found
  it **not tradeable as measured**, and this records why, what was fixed same-night, and what the
  re-study needs before any cell is trusted.

Related: [docs/BACKLOG.md](../../BACKLOG.md) ("Prediction markets (event contracts) — Kalshi
lane") for the open re-study work and Phase 2 (portfolio + orders, blocked on an operator
Kalshi account).

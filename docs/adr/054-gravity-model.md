# ADR-054 — The Gravity Model: event-driven, time-decayed speculative displacement

- **Status:** Accepted — implemented (reconciled 2026-07-31): `gravity` is a live member of the confidence-weighted ensemble in `scripts/oshal-algos.js` (importing the engine `scripts/oshal-gravity.js`), with the gravity2 head-to-head backtest (`scripts/oshal-gravity2-backtest.ts`) and its prediction-ledger pattern generalized by ADR-096
- **Date:** 2026-06-18
- **Related:** [ADR-052 (stock-trading swarm)](052-stock-trading-swarm.md),
  [ADR-053 (trading-decision workflow)](053-trading-decision-workflow.md),
  [ADR-037 (communications / sensing service)](037-communications-swarm.md)

## Context

The operator's first proprietary trading algorithm. The thesis: there is an **underlying stable
market value** that is fairly predictable from financials — the *baseline*. On top of that sits
**speculation**, driven by "masses" (influencers and events) that pull the price line up or down by
their **gravity**. A mass's pull depends on its **mass** (reach × magnitude), its **polarity** (up
or down), its **proximity** to the specific stock (a lawsuit naming the company vs a correlated-
industry spillover), and it **decays over time** ("as the ticker moves away from the mass the
gravity has less pull"). Some bodies are **anti-gravity** — they float between the influencer and
the stock and stabilize it (AI as a broad stabilizer; capital rotating out of a toxic sector into a
good one). Examples the operator gave: FDA approval/denial (direct), a lawsuit (direct, slow decay),
a "POTUS comment" (high mass, fast decay), correlated-market moves (indirect proximity), and weather
(a tornado → roofing/generator demand → Home Depot positive; calm → fade).

## Decision

Model price as a **baseline displaced by a decaying, damped sum of event masses**, and trade the
displacement. Built as `scripts/oshal-gravity.js` (pure Node), the research bot supplies the masses.

**Math.**
```
contributionᵢ(t) = polarityᵢ · massᵢ · proximityᵢ · 0.5^((t − t0ᵢ)/halfLifeᵢ)     (0 before t0)
displacement(t)  = clamp( (Σ gravity contributions) · (1 − Σ |anti-gravity contributions|),  ±MAX_SWING )
fair(t)          = baseline · (1 + displacement(t))
```
- **Decay** is per-mass half-life: a tweet ~days, an FDA ruling ~months. As all masses age,
  `displacement → 0` and `fair → baseline` — the built-in mean-reversion to fundamental value.
- **Anti-gravity** masses damp the net swing (a volatility shield), modeling stabilizers / rotation.
- `MAX_SWING` caps speculation (price can't displace infinitely).

**The mass contract** (what the research bot emits per event/influencer):
`{ source, label, mass(0..1), polarity(±1), proximity(0..1), halfLifeDays, t0Day, antigravity }`.
- `mass` = reach × magnitude (an influencer's audience × how strong the statement is).
- `proximity` = relevance to *this* ticker: 1 = directly names it; lower = correlated-industry
  spillover ("indirectly impacted by other market"). Industry linkage comes from D&B + price
  correlation.
- Influencers are **classified** (who they are, their gravity) by the research bot.

**Signal.** Two lenses off the same field: **ride** (trade in the gravity direction while it builds)
and **fade** (when `|displacement|` is extreme, bet on reversion to baseline — the half-life gives a
natural exit). If a market price is known, also **model-vs-market** (model says where price *should*
be). The engine emits these today; promotion to a live order goes through the ADR-052/053 path
(mass-set → gravity signal → `POST /api/trading/signals` → `/trigger` → paper book).

**Feeds (operator-provided, per the connector model + partner-app rule).**
| Gravity source | Feed | Status |
|---|---|---|
| News events (lawsuit, FDA, M&A) | a news API + existing `scripts/oshal-research.js` RSS | research script exists; events API pending |
| Weather / disasters | NWS/NOAA (free, keyless) or OpenWeather | **pending — new connector** |
| Social influencers + classification | X (reads paywalled), inbox-ingest | partial |
| Correlated-industry proximity | **Dun & Bradstreet** linkages + price correlation | **pending — needs D&B login** |
| Baseline fair value | fundamentals (financials) | **pending — own sub-problem** |

## Consequences

- **Interpretable & auditable.** Every displacement decomposes into named masses with a pull value —
  fits the ADR-052 provenance spine exactly (each mass is a captured signal; the decision shows the
  field). Unlike a black-box model, you can point at *why* the line moved.
- **Self-exiting.** Decay means positions don't need a separate exit rule; the gravity fades.
- **Quality lives in classification.** The model is only as good as the research bot's mass
  estimates (mass/polarity/proximity/half-life). That estimation — and the **baseline fundamental
  value** — are the real work; the gravity arithmetic is the easy part.
- **Feeds are the dependency.** Weather + D&B are new connectors; news-events and a fundamentals
  source are needed. None can live in a build queue (keys/logins) — same operator-gated pattern as
  every connector.

## Addendum (2026-06-18) — per-ticker coupling (the 3-D deflection)

A mass does not hit every name the same way. The single `polarity × proximity` is generalized to a
**coupling matrix**: each mass carries `coupling: { TICKER: signed[-1..1] }`, so one event radiates
into a cohort and each name deflects on its own trajectory. The canonical case: a negative mass on
Home Depot (lawsuit / hostile influencer post) couples **−0.9 to HD but +0.5 to Lowe's** —
substitution, money rotating to the competitor — while a disaster mass lifts the generator/roofing
names hardest and a rate-spike mass sinks new-construction (BLDR) worst. Per-ticker displacement is
`clamp( Σ massᵢ · coupling[i][T] · decayᵢ(t) · (1 − anti-gravity), ±MAX_SWING )`. Implemented as
`oshal-gravity.js sim` (worked home-improvement cohort: HD/LOW/GNRC/BLDR) → a multi-line trajectory
report + a "same event, different deflection" bar + the coupling matrix. The research bot's job grows
by one column: estimate each mass's coupling to each name in the watched universe (direct hit vs
substitution vs supply-chain vs macro), grounded in D&B industry linkage + price correlation.

## Built vs pending

- **Built:** the gravity engine + a graphical HTML report (fair-value-vs-baseline, per-mass decaying
  pull, signal panel) with a worked demo scenario. `oshal-gravity.js demo <TICKER>` /
  `run <masses.json>`.
- **Pending:** research-bot mass extraction + classification; the weather and D&B connectors; a
  fundamentals→baseline estimator; wiring the gravity signal into the `/signals → /trigger` loop;
  calibrating half-lives/proximity against the backtest data (ADR-053 engine).

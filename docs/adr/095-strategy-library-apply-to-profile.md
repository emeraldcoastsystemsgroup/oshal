# ADR-095: Strategy Library — notes/lessons journal, historical catalog, apply-to-profile overrides

Date: 2026-07-13
Status: Accepted (round 2 — blend allocations — same day)

## Context

ADR-092 made strategy variations first-class (persistent configs, persisted backtest/forward/
regression runs with equity curves, a Strategy Lab tab). Three operator asks (2026-07-13) remained
unmet:

1. **No notes or lessons learned.** ~30 tested strategies/configurations existed only as prose in
   [strategy-log.md](../apps/trading/strategy-log.md); a lab strategy carried a 500-char
   description and nothing else. "I need to see the backtested history and notes and lessons
   learned on each."
2. **The tested history was invisible in the product.** Sweeps #1–#5, the killed builds
   (venue-resident stops, pop-catcher, news-materiality scorer, flat-overnight) and the open
   hypotheses lived nowhere a user could browse.
3. **"Armed" was just a label.** The live autopilot read its knobs exclusively from env vars
   (`TRADING_ROTATION_*`, `TRADING_CORE_SYMBOLS`, `TRADING_RISK_POSTURE`,
   `TRADING_TAKE_PROFIT_PCT`), so switching the profile onto a tested configuration meant editing
   `.env` and bouncing a container. The operator asked to "switch to this model for part or all of
   my profile at any time" — from the UI, reversibly.

## Decision

1. **Per-strategy journal** (`trading_strategy_notes`, migration 073): dated `note | lesson |
   decision` entries per strategy, CRUD via `/api/trading/lab/strategies/:id/notes`, rendered as a
   journal drawer under each strategy's runs. Lesson/note counts chip the catalog table.
2. **Historical catalog import** ([scripts/trading-lab-import-history.ts](../../scripts/trading-lab-import-history.ts)):
   a curated, idempotent seed of every tested configuration from strategy-log.md — each entry
   carries its verdict as notes/lessons (e.g. "tp8 clipped winners", "full-deploy rejected for DD
   discipline", "keyword-regex materiality is dead", "overnight is where the return lives").
   Record-only entries (intraday/execution-layer experiments the daily-bar sim cannot walk) are
   imported for their lessons and excluded from `--backtest`. The armed production strategy is not
   duplicated — its history attaches to the ADR-092-seeded row.
3. **Apply-to-profile** (`trading_config_overrides`, migration 073): ONE active override per user —
   a snapshot of a lab `StrategyConfig` + `applyPct` — read once per autopilot fire by
   `dispatchTradingSchedule` and overlaid on the env defaults:
   - `riskPolicy(mode, override)` — the strategy's posture beats both env postures; its
     `takeProfitPct` (including an explicit `null` = posture default) beats
     `TRADING_TAKE_PROFIT_PCT`.
   - `rotationConfig(override)` — a `rotation` strategy owns the sleeve (rank/cadence/topN/
     weighting, enabled); an `ensemble` strategy turns rotation off. `extHours` stays
     env-controlled (execution safety, not a strategy knob).
   - `coreConfig(override)` — the strategy owns the core TARGET at
     `effectiveCorePct = 100 − (100 − corePct) × applyPct/100`; operator `SYM:0` exemption holds
     always survive (the SKHY/SKHYV rule).
   - Universe precedence: override's explicit universe > schedule pin > `DEFAULT_UNIVERSE`
     (an applied strategy with universe `[]` deliberately tracks the default — the 07-13 pin
     lesson).
   - **No override row → byte-identical env behavior.** Read failures degrade to env defaults and
     never block a fire.
4. **`applyPct` = "part of my profile"**: it scales the strategy's *designed sleeve share*; the
   remainder parks in the core symbol. 100 = the strategy exactly as designed; 25 on a full-deploy
   strategy = 25% sleeve / 75% core. One book, one formula, honest to the existing
   core-plus-sleeve architecture.
5. **Guardrails**: `POST /strategies/:id/apply` requires `confirm:true` and returns the effective
   knobs + a ready-to-paste strategy-log.md row (the "no config change without a row" rule
   survives the UI path; apply/revert history is also queryable in `trading_config_overrides`).
   Revert (`POST /apply/revert`) resumes env defaults on the next fire. Everything logs.
6. **Visibility**: a hub **strategy strip** on `?app=trading` always shows APPLIED-vs-ENV-DEFAULTS
   with a one-click jump to the lab; `?tab=lab` deep-links. The lab tab gains a Profile panel
   (active override, env comparison, history, Revert, copy-log-row).

## Consequences

- The lab is now the **strategy library** the operator asked for: every tested configuration,
  its curves, its verdict and its lessons in one browsable place — and the on-ramp for new model
  families (the standard-indicator expansion and the fundamental event overlay land here as
  candidates first).
- Applying a strategy changes REAL autopilot behavior on the next fire, on both books. The
  confirm guard, the strip banner, the audit history and one-click revert are the compensating
  controls; the TRADING_HALT kill switch, equity guard, caps and the live double-opt-in are
  unaffected and still outrank any override.
- Env vars remain the substrate and the default. Operators who never touch Apply see zero change;
  the override is additive, per-user, and RLS-scoped like every lab table.
- Scope: the override drives the MAIN autopilot leg (scan/rotation/exits/universe). The swing
  (Donchian ETF), intraday-scan, research and lab legs keep their own knobs — extending overrides
  to them is future work if ever wanted.
- The applied strategy's forward walk keeps accruing independently in the lab — out-of-sample
  evidence continues even while the strategy also drives the live book.

## Round 2 (same day): blend allocations — "30% into this one, 20% into that one"

The single-override model was one-strategy-at-a-time; the operator asked for multi-strategy
allocation. Decision: a **blend** is itself a library strategy (`kind: 'blend'`) — 2–6 weighted
**rotation** components embedded as config snapshots at save time (editing a source strategy never
silently mutates a blend), with `corePct` derived as the unallocated remainder. Because a blend is
just a strategy, backtest / nightly forward walk / pinned regression / Apply / Revert all work on
it unchanged.

- **Sim semantics** ([trading-strategy-lab-sim.ts](../../src/app/trading-strategy-lab-sim.ts)):
  each component walks as an INDEPENDENT sub-book on weight% × 100k (its own posture/exits;
  component `corePct` deliberately ignored — the blend's remainder is the core) and the curves
  sum. Matches the operator's mental model of "moving 30% of the money into" a strategy. Forward
  continuation persists per-component states under `WalkState.parts`.
- **Live semantics** ([trading-blend.ts](../../src/app/trading-blend.ts) plans,
  `rotateBlendSleeve` executes): each component ranks its own universe with its own
  rank/topN/weighting inside its weight-share of the sleeve budget (per-name capped at ITS
  posture's book-level %); overlapping picks **merge by summing goals**, capped at the
  most-conservative component's book per-name cap so buys never fight the cap-breach trims.
  Book-level exits/caps run on the **most-conservative composite policy** (tightest stop,
  earliest take-profit). Execution reuses rotateSleeve's discipline verbatim (drop-out sells →
  trims → 6 s settle + real-cash re-read → strongest-merged-score buys).
- **Sim vs live disclosure**: the sim's independent sub-books and live's netted merged book are
  economically equivalent on net exposure; per-lot stops differ slightly (component-local vs
  conservative-composite). Disclosed here and in the honest-limits line; per-component live P&L
  attribution is approximated by weight (a full per-fill sleeve ledger is future work if ever
  needed).
- **Ensemble (scan) components are rejected** in v1 — scan is signal-driven, not target-state,
  so it cannot merge into one rebalance. A scan strategy still applies solo via round 1.
- The whole path is **inert until a blend is applied**; env-default behavior remains
  byte-identical.

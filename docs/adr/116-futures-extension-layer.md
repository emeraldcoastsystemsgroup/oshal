# ADR-116 — Futures extension layer: recreate a futures strategy + execution inside oshal

**Status:** Accepted (foundation shipped 2026-07-24; strategy port + live rail deferred — see BACKLOG)

## Context

An external NinjaTrader/Kibot trader wants to stop babysitting a fragile Windows stack. His pipeline is
a chain of *platform dependencies*: a Kibot desktop downloader driven by FlaUI UI-automation, a
NinjaTrader historical import (also FlaUI), a rollover-aware gap checker + a 3-pass re-download loop to
repair the incomplete downloads that UI-automation kept producing, and NinjaTrader's Strategy Analyzer
for optimization — all glued with brittle Windows UI scripting. The operator's directive: **don't
automate his stack, recreate the strategy and execution inside oshal and delete the platform
dependencies.**

oshal already owns most of what NinjaTrader was providing, but for **cash equities only** (ADR-052
execution, ADR-092 backtest/forward/optimizer, ADR-095 strategy library + apply-to-profile, ADR-096
shadow indicators, the portfolio money-manager). A survey confirmed there is **no futures anything** —
no contract/rollover model, no persistent bar store (equities are fetched live from Alpaca and never
stored), no intraday backtester, and both wired brokers hardcode `assetType:'EQUITY'`, long-only.

## Decision

Add a **futures extension layer** to the trading feature, modeled on the ADR-045 graph-tier pattern
(additive, off by default, engine-agnostic). The equities surface is untouched. Five pieces:

- **F1 — Instrument model** (`futures-contract.ts`): root registry (ES/MES/NQ/MNQ/YM/MYM/RTY/M2K with
  multiplier/tick), month codes, third-Friday expiry + configurable roll, contract enumeration that
  **tiles a date range with no gaps**, and an expected-bar count. The friend's "how many hourly buckets
  must a whole contract have, given its rollover" becomes a *property of the model*, not a downstream
  patch. **Shipped.**
- **F2 — Data connector + bar store** (`futures-data-source.ts`, `src/app/trading-bar-store.ts`,
  migration `096`): a `FuturesDataSource` with a deterministic **mock** (runs the whole pipeline with no
  vendor) and a real, credential-gated **Kibot HTTP** client that deletes the desktop downloader and
  integrity-checks bytes on read. Bars land in a persistent, instrument-agnostic `market_bars` table
  (equities can backfill there too). **Shipped** (Kibot needs credentialing — BACKLOG).
- **F3 — Completeness validation** (`futures-completeness.ts`) + **ingest orchestrator**
  (`src/app/trading-futures-ingest.ts`): the gap checker moved *upstream* — a fetched bar set is graded
  on arrival (expected vs received, weekend-discounted interior gap runs), and a bounded re-fetch loop
  terminates on convergence ("all the vendor has"). This collapses his download→import→gap-check→patch
  chain into one pass. **Shipped.** A full **intraday backtester** over the store is **deferred**
  (today's sim is daily-bar).
- **F4 — Paper futures broker** (`paper-futures-broker-adapter.ts`): a built-in, vendor-neutral
  simulator implementing the same `BrokerAdapter` contract — market/limit fills against an injected
  mark, shorting, and multiplier-scaled realized/unrealized P&L. `BrokerProviderType` gains `'paper'`
  (the simulator) and `'tradovate'` (the intended live rail, declared not-yet-wired). **Shipped
  (in-memory); durable persistence + a live rail deferred.**
- **F5 — Futures risk semantics** (margin, point value, session/roll calendars in the portfolio
  manager): **deferred.**

**The strategy itself is a separate input.** The friend's edge is his regime/entry/exit logic, which he
has never written down; the Lizard indicators he uses are standard math already present as oshal shadow
indicators. F1–F4 are the rails; his rules drop into the ADR-095 strategy library once supplied.

## Consequences

- The external stack's fragile parts — FlaUI UI-automation, the desktop downloader, the NinjaTrader
  import, and the elaborate patch loop — **disappear**. The only things kept are his *data entitlement*
  (Kibot, now over HTTP) and his *strategy logic* (pending).
- `market_bars` is the first persistent bar store in oshal; it is shared **reference** data (no
  `user_sub`), RLS-enabled-but-open per migration 096, and benefits equities too.
- Extending `BrokerProviderType` is the only change to shared equities types; equity order semantics are
  unchanged and the futures adapter carries its own multiplier/short handling.
- **Honest limits (all tracked in BACKLOG):** sessions are approximated as continuous 24h weekdays until
  a real exchange session/holiday calendar lands (which also teaches the gap detector to discount the
  maintenance break); the paper book is in-memory; stop/trailing orders are accepted-working but not
  trigger-simulated; there is no intraday backtester or live futures rail yet; and the actual strategy
  must come from the friend.

## Amendment 2026-07-28 — the strategy arrived, and its author answered

The "actual strategy must come from the friend" limit above is CLOSED. His NT8Custom source was
obtained, reconciled, and fully ported (indicators, wave tracking, entries, the three-layer stop
stack, sizing, all nine optimization objectives, an intraday backtester with NT8 fill semantics, and
panama-adjusted continuous contracts). It has run on five years of real ES and CL.

Five reconciliation questions went back to him; he answered all five on 2026-07-28. Three moved
defaults, one retired planned work, one added a whole entry generation:

1. **Strangle gate = both conditions** (ADX + Laguerre RSI) → default `'adx-laguerre'`, plus a
   stricter `'adx-all'` for the reading where both candidate second clauses are ANDed.
2. **The Strangle's dual mechanism is confirmed**: the level is tracked all trade; once gated, a close
   beyond it exits at market, otherwise the resting trailing stop is created/updated. The port already
   modelled exactly this.
3. **DTAM is retired, not deferred** — its author tested the dynamic multiplier and removed it as
   unhelpful. The single optimizer-swept static multiplier is canonical. This is the first item in this
   ADR's scope killed by *evidence from its designer* rather than by our prioritization, and the
   distinction matters: a future reader must not resurrect it as "unfinished".
4. **Initial stop = the lowest low of the most recent bearish MACD wave, floored at ATR × 3** →
   `initialStopAtrMultiple: 3`, new `initialStopWaveSource: 'macd'`.
5. **He is refactoring entries to a scalar ensemble** — no mandatory indicator, entry on a minimum
   accumulated score. Shipped as `generation: 'ensemble'` (`futures-entry-ensemble.ts`), ported from
   his `ATCEnsembleGen.cs`, which turned out to be working code rather than the spec-only sketch our
   earlier reconciliation assumed.

Consequence worth recording for the extension-layer pattern generally: **every dictation-vs-code
divergence was shipped as a config knob instead of a guess, and when the author's answers arrived not
one of them required rewriting logic** — three were default changes, one was a confirmation, and one
was additive. The knobs also preserve the pre-answer behaviour, so the comparison that quantified each
answer's effect was a config sweep rather than an archaeology exercise. Treat "ship the ambiguity as
configuration" as the default tactic when porting someone else's system.

Measured effect of his answers (in-sample, un-optimized, hourly bars) is in
[docs/apps/trading/futures-backtester.md](../apps/trading/futures-backtester.md#what-his-answers-did-to-the-numbers).
The remaining open input is no longer the strategy — it is **his optimized per-market constants**.

## References

ADR-045 (extension-layer pattern), ADR-052 (BrokerAdapter/execution), ADR-092 (Strategy Lab),
ADR-095 (strategy library / apply-to-profile), ADR-096 (shadow indicators).

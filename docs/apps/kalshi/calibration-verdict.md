# Kalshi calibration — the honest verdict

**Bottom line: the first calibration table is NOT tradeable as measured.** Read this before
trusting any specific number the edge scan shows you.

## What happened

The first calibration run (2026-07-13) sampled 4,778 price/outcome observations from 3,455
settled Kalshi markets across 9 categories. Read at face value, it looked like a real favorite-
longshot bias: contracts priced 50–60¢ settled YES 68.3% of the time (24h before close) — a
claimed +12.1¢ edge net of fees — and 10–15¢ longshots settled YES only 1.2% of the time, an
apparent +9.8¢ edge fading them.

Before shipping those numbers as a live signal, a 4-skeptic adversarial review (selection bias,
statistical significance, code correctness, execution realism — each an independent pass over the
actual study code and the actual JSON output) was run against the claim. All four independently
converged on the same verdict: **edge-overstated**.

## Why the headline numbers don't survive

- **Wrong price basis.** The study measured edge against the candle mid or last trade price, with
  no spread cost. A live taker pays the ask. Combined with the calibration price preferring stale
  trade closes (up to ~25h stale at the 24h horizon), the measurement mechanically inflates
  favorite edge.
- **Pseudo-replication.** Settled markets were collected by walking each category's series in API
  list order with a 60-per-series cap. Bucket sample sizes (`n`) look large but are dominated by a
  handful of series — the *effective* sample size (accounting for within-series correlation) is
  roughly an order of magnitude smaller than the reported `n`.
- **Fails multiple-comparison correction.** Across the ~48 pooled price/horizon cells, only 2
  survive a Bonferroni correction — and both of those are themselves artifact-suspect (one is the
  same longshot cell that flips sign at the 1-hour horizon).
- **Sign instability.** The 10–15¢ longshot-overpriced claim reverses at the 1-hour horizon (that
  bucket settles 22.9% there, versus 1.2% at 24h) — the signature of bucket noise, not a real bias.
- **Vanishes where it matters.** Sports — the one category with reliably fillable order books —
  shows favorites at 50–60¢ settling only 47.1% (slightly *overpriced*, the opposite of the
  headline claim). The pooled "edge" is being carried by thin, harder-to-fill categories.
- **One regime, no date stratification.** The settled sample is drawn from a single recent window
  (the most recent ~60 settles per series), so what looks like calibration bias could just as
  easily be a one-time drift/momentum effect in that window.

Full per-lens findings are in the verification section appended to
docs/evidence/kalshi-calibration-2026-07-13.md.

## What's left standing

One cell survived every check applied: **buying YES at 50–60¢ is positive at all three measured
horizons (24h/6h/1h), even at the conservative statistical lower bound (+3.3¢ to +9.3¢), and is
Benjamini-Hochberg significant.** That's a candidate, not a conclusion — it still needs an
ask-priced, cluster-robust, out-of-sample re-test (see below) before anyone sizes a real bet on it.

## Guards shipped the same night (in the evaluator, not just the docs)

These don't fix the measurement — they stop the evaluator from acting past what the (flawed)
evidence actually supports:

- **Hard fold beyond 48h-to-close.** No calibration horizon covers markets that far out; before
  this, `nearestHorizon` would silently price a 3-month market off 24h-before-close evidence.
- **One hand per event.** `rankHands` now deduplicates by `eventTicker` — a temperature ladder
  (`KXTEMPCHIH-...-T71.99`, `-T72.99`, `-T73.99`, ...) is one correlated outcome, not several
  independent bets, and was previously staking each rung separately.
- **Pooled-fallback contradiction veto.** If a category's own (even thin, ≥12-observation) bucket
  disagrees in sign with the pooled table that would otherwise drive the estimate, the lookup
  backs off to zero edge instead of transplanting an edge the category's own tape refutes. This is
  the direct fix for the Sports finding above.
- **Realistic fee basis.** `feePerContract` moved from a 100-contract to a 10-contract clip size —
  the 100-lot basis understated the ceil-to-cent rounding by roughly 3× at extreme prices, exactly
  where the smallest claimed edges lived.

Live effect on the scan: before the guards, a snapshot of the open book showed 9 "playable" hands;
after, 2, both with sub-0.5% stake recommendations. That drop is the system correctly refusing to
act on a measurement it can no longer defend, not a bug.

## What the re-study needs (tracked in BACKLOG, not yet built)

1. **Ask-basis pricing** — record the candle's `yesAskClose` / `1 − yesBidClose` as the entry
   cost, and each sample's staleness; drop samples more than ~2 candle periods stale.
2. **Break the pseudo-replication** — randomize series iteration order, cap at ~10 markets per
   series, deduplicate to one observation per event per horizon.
3. **Cluster-robust intervals** — series- or event-level bootstrap, not naive binomial CIs.
4. **Date stratification** — pull settles across 6–12 months via `min_close_ts`/`max_close_ts`
   and keep only cells that are stable across sub-windows.
5. **Smooth calibration curve** — isotonic regression instead of 16 fixed price buckets, to kill
   the step-function discontinuity right at 0.50.
6. **One pre-registered hypothesis test** — specifically, "YES at 0.50–0.60 beats ask+fee" on a
   fresh out-of-sample settled window — before that cell (or any other) is trusted for sizing.

Until that re-study lands, treat the scan's output as a demonstration of the mechanism (fee-aware,
calibration-gated, Kelly-sized, risk-flagged), not a source of real trading signal.

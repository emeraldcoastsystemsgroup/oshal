# Backtest regression suite — the evidence base and how to re-run it

Every harness that produced the [active strategy](./active-strategy.md), the exact commands, the
verdicts (including the voided ones), and the rules that keep future experiments honest. The
chronological record with full numbers is [strategy-log.md](./strategy-log.md).

> **Automated since 2026-07-13 ([ADR-092](../../adr/092-trading-strategy-lab.md)):** strategies
> saved in the **Strategy Lab** persist every run (metrics + full equity curve) and are
> re-regressed nightly over their PINNED windows by the `trading-lab:<sub>` leg — drift beyond
> tolerance logs at ERROR and shows as a red `DRIFTED` run on the Strategy Lab tab. On-demand /
> CI: `npx ts-node --transpile-only scripts/trading-regression-suite.ts` (exit 1 on drift).
> The CLI harnesses below remain the lane for NEW experiment designs; once a design is worth
> keeping, save it as a lab strategy so it gets a curve, forward testing, and regression cover.

## Ground rules (learned the hard way — each one has a scar)

1. **Blind-forward or it doesn't count.** Decisions at simulated time *t* may use only data
   published/printed strictly before *t*; entries fill at the NEXT bar. Scorers must be
   deterministic or pre-registered — a keyword list written after reading the test window makes
   that window an upper bound, never a result (sweep #5 died exactly this way in its clean period).
2. **Hold out a clean period the design never saw** and report it before quoting any number.
3. **Feed rules (2026-07-12 scope ruling):** daily bars on IEX are fine (max 0.16% divergence vs
   consolidated); **5-minute work on IEX is invalid** (~2% of tape; MU printed +0.58% on a flat
   hour) — intraday backtests MUST use `feed=sip` (the paper key has SIP *historical*, not
   real-time). Late-day IEX prints are the thinnest (16:00 coverage 1.3%).
4. **The two resident bug classes — check for them in every new harness:**
   - *Series-direction*: `resample()` fed the engine time-reversed weekly/quarterly views for two
     weeks (`cad41dc5`, 2026-07-09). **All numbers produced before that fix are void**, including
     the "aggressive +19.7% beat SPY" claim still visible (struck through) in advisor.md.
   - *Filtered-adjacency*: filtering bars (e.g. to RTH) and then comparing by array index makes
     adjacent slots straddle session boundaries — the 07-10 pop-miss audit reported **overnight
     gaps as 30-minute surges** this way and its surge-level conclusions are void (2026-07-12).
5. **Adversarial judging.** Sweeps get judged by an agent instructed to refute: consistency across
   windows/configs, per-trade edge vs the ~0.2% round-trip slippage bar, regime sensitivity,
   in-sample contamination. Single-cell wins are treated as luck (the venue-stop smoke pair looked
   like a strict win and averaged negative across 7 pairs).

## Harness inventory

All run from repo root; all print a machine-readable `RESULT {json}` final line.

| Harness | Tests what | Command shape |
|---|---|---|
| `scripts/oshal-trading-backtest.ts` | posture, scan sleeve (original) | `npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-trading-backtest.ts [posture] [warmup]` |
| `scripts/oshal-trading-core-blend-backtest.ts` | + SPY core %, take-profit override | `… [posture] [corePct] [tpPct\|-] [warmup]` |
| `scripts/oshal-trading-gap-stop-backtest.ts` | exit execution (close vs venue stops), multi-horizon tails, overnight/intraday split | `… [close\|venue] [posture] [corePct] [tpPct\|-] [warmup] ["5,21,63,126"]` |
| `scripts/oshal-trading-rotation-backtest.ts` | the production rotation (`rankUniverse`): rank/cadence/topN/weighting/posture | `… [rank] [cadence] [topN] [weighting] [posture] [warmup] [tails]` |
| `scripts/oshal-trading-pop-backtest.ts` | pop-catcher on the 5-min tape (+ fast-win exit dials) | `POP_BARS_CACHE=… … [days] [thr] [tranche] [maxPos] [tp] [stop] [maxHoldMin]` — **must move to SIP before reuse** |
| `scripts/oshal-trading-pop-miss-audit.ts` | surge ↔ news join ("what did we miss") | fixed 07-12 (session-contiguous windows); **must use SIP tape** |
| `scripts/oshal-trading-news-materiality-backtest.ts` | blind-forward headline scoring vs the tape | `NEWS_BARS_CACHE=… … [days] [thr] [scaled\|flat] [tp] [stop] [rthOnly] [cutoffIso]` |
| `scripts/oshal-trading-news-wire-recall.ts` | Benzinga-wire headline lead-time vs corrected SIP surges | see script header (2026-07-12) |
| `scripts/trading-afterhours-backtest.ts` | replay the real exit engine on one session's AH tape | `… --date=YYYY-MM-DD` (positions from that session's deck data) |

Alpaca data keys come from `.env` (`ALPACA_PAPER_*`). Caches make sweeps cheap — fetch once, run many.

## Verdict table — what was tested and what stood

| # | Question | Verdict | Status |
|---|---|---|---|
| 1 | Posture × SPY-core × take-profit (27 runs) | tp 8→25 real for the scan sleeve (+2.5pts, zero DD cost); 35% core best blend | superseded by #3 for production; tp dial kept |
| 2 | Venue-resident stops / act-at-first-print | wash to negative across 7 pairs; wins die under fill haircuts | **not built** (tail-insurance variant untested, BACKLOG) |
| 3 | ALL strategies × 5 horizons (18 configs) | **rotation alpha real** — gravity best (Sharpe 2.36, beats SPY full-window + 21/63/126d); full-deploy aggressive rejected (20–27% DD) | **ARMED** as gravity + SPY:60 core (2026-07-10) |
| 4 | Price-only pop-catcher (intraday) | no discrimination — ~40 names/step qualify, thresholds 0.34≡0.6 | **REJECT**; note: ran on IEX 5-min — directionally safe (reject), do not reuse numbers |
| 5 | Keyword-regex news materiality (blind-forward, 388K headlines) | full-window +$96 was entirely the tuned week; clean period **−$228** | **KILLED**; durable: no overnight news holds; big-dollar class = noise |
| 6 | Pop-miss audit ("19/25 no warning", surge list) | overnight-gap + thin-tape measurement defects | **VOID** (2026-07-12) — do not cite |
| 7 | News-wire recall on corrected SIP surges | 28% of surges had a wire headline ≤60 min ahead (bar was 30%) — marginal; leading class = **analyst actions** (upgrades / PT raises) | **hypothesis pre-registered**, nothing armed |
| 8 | Extended-hours trading | order ledger: 10.8% ext fill rate, 0% after 17:00; IEX venue has zero prints outside 08:00–17:00 | **OFF** (`TRADING_EXTENDED_HOURS=false`); re-enable needs real-time SIP |
| 9 | Flat-overnight (sell close, re-enter open) | SPY 25-month split: overnight +33.2% vs intraday +6.1%; −62% after daily round-trip costs | **KILLED** at market-structure level |
| 10 | Short side (pre-dates this suite, 07-08/09) | no edge, survived the resample fix | closed — don't revisit without new evidence |

## Adding a new experiment

1. Pre-register the hypothesis and entry/exit spec in [BACKLOG](../../BACKLOG.md) *before* running.
2. Build on an existing harness where possible; keep the `RESULT` json line convention.
3. Blind-forward; clean-period holdout; adversarial judge; slippage bar 0.2%/round trip.
4. Wins must clear the **arming bar**: ≥4 paper weeks incl. a non-bull week, ≥200 trades,
   ≥0.4%/trade gross, no overnight carries, net ≥0 in the flat week.
5. Whatever the outcome, write the [strategy-log](./strategy-log.md) row. Kills are results.

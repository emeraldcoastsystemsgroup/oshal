# Does an ADX + RSI extreme mark trend exhaustion? A backtest

**Study date:** 2026-07-22
**Analyst:** oshal maintainers, Emerald Coast Systems Group
**Subject:** an exit rule proposed in conversation — sell a profitable position when ADX confirms an
extended trend and RSI is at an extreme, on the first break
**Status:** complete. **No production trading configuration was changed as a result.**

This document is self-contained. Every number in it comes from one harness run; the reproduction
recipe is in §9 and every source is listed in §10.

---

## Summary for the person who proposed the rule

Thank you for this one — it was a good, specific, testable idea, and it turned out to be more
interesting than a simple yes/no.

**Four results, and the fourth is the one that decides it:**

1. **As an always-on rule, the premise is backwards in the first window.** In 2021-2026, after the
   break fires, price does not revert — it *rises*, slightly faster than a random day in the same
   stock. Only 40% of events were negative at ten days.
2. **In that window it looked strong in a downtrend.** With the S&P below its 200-day average, the
   same trigger produced −5.3% at twenty days with 75% of events negative. That looked like the
   salvageable idea — a regime-gated defensive rule.
3. **So I tested it out-of-sample — and it did not hold up.** On a completely separate 2017-2021
   tape (containing the 2018 and 2020 selloffs, which the first window never saw), **the downtrend
   effect vanished** (9 events, wrong direction) and **the whole signal flipped sign**: the break
   now *underperformed* a random day by 3+ points. A signal that reverses direction between periods
   has no stable edge. This is the honest verdict: **the rule does not generalize.**
4. **The most useful thing I learned had nothing to do with the rule working.** My engine takes
   profit at +8% and trails at 5/3, so a position is *gone* long before it can become extended
   enough to trigger this — the rule fired **24 times in five years across ~5,100 trades**. Any
   "let the winner run until it's exhausted" idea — including your chandelier cascade — is
   structurally unreachable in my system until I widen the exits first. That's a real finding about
   my own book I wouldn't have gone looking for.

None of this is a knock on the idea or the instinct behind it — the market read underneath it is
sharp, and it took a genuine out-of-sample test to separate "real edge" from "true only in one
window." The rest of this document is the evidence, the method, and everything I got wrong along the
way.

---

## 1. The claim, formalized

Translating the proposal into testable form. The left column is the proposal as stated; the right
column is what the code does.

| As proposed | As tested |
|---|---|
| "whenever you get above forty on the ADX, that's a very high trending market" | Wilder ADX(14) **≥ 40**, with +DI > −DI (confirming an *up* trend) |
| "when the relative strength is near a hundred" | Wilder RSI(14) **≥ 75** |
| "you got a good profit on that position" | unrealized P/L **≥ +5%** |
| "sell at that first break" | RSI(t) < RSI(t−1) **AND** close(t) < close(t−1) |
| "a little bit easier entry logic... if that was in the same direction" | RSI back **≥ 55** and rising, +DI > −DI, and an up close — within **15 sessions** of the exit |

Two mechanical details that matter:

- **Arming is sticky.** Once ADX and RSI are both hot, the position stays flagged until a break
  fires. This matches "once you get above forty and you got a good profit, I'm gonna jettison that
  thing" — the sell doesn't require both conditions to still be true on the exit bar.
- **A break consumes the arm** whether or not it converted to a sale. A position that breaks while
  below the +5% profit gate is not a trigger, and must re-arm before it can produce one.

**The break requires two-of-two confirmation** (indicator rolls over *and* price confirms) rather
than RSI alone. A single flat bar inside a strong trend should not eject a position — that was the
whole complaint about naive RSI mean reversion, and it would have been unfair to rebuild it here.

All seven constants were written into the source file and committed **before the first run**.
Nothing was tuned afterward. That distinction is the difference between a test and a search for a
number that flatters the hypothesis.

---

## 2. Method

### 2.1 Data

- **Source:** Alpaca Market Data API, daily bars, IEX feed, `adjustment=all` (split- and
  dividend-adjusted).
- **Universe:** the trading system's standing 140-symbol universe plus SPY. 136 names had the ≥260
  bars required for indicator warmup and were used.
- **History:** fetched from 2020-07-01 for warmup; results reported **2021-06-01 → 2026-07-21**, a
  window of **1,290 trading sessions** (just over five years).
- **The tape ends at the last completed session.** Today's in-progress bar is excluded — see §7.

### 2.2 Two tests, because they answer different questions

**Part 1 — event study.** *Does the reversion exist at all?* Independent of any portfolio, scan
every (symbol, day) where the trigger fires and record the forward return at +5, +10 and +20
sessions.

The comparison is not "is this number positive." It's against a **same-symbol, matched-count
random-time control**: for each stock, draw exactly as many random days as that stock produced
triggers, so the control matches the event set in both sample size and name mix. This is a standing
rule in this project — an earlier family of event-driven signals was retired specifically for
producing impressive-looking absolute returns that a random-time control matched. An event claim has
to beat the control or it isn't a claim.

Two **ablation cohorts** isolate which half of the gate does the work: RSI-only (no ADX filter) and
ADX-only (no RSI filter). If the combined gate has an edge, at least one half should show it.

A **regime split** then partitions events by whether SPY closed above or below its 200-day average.

**Part 2 — portfolio walk.** *Even if the reversion is real, does trading it beat the exits I
already run?* Six books walk the same tape with **identical entry signals, position sizing and
rotation logic** — one shared decision set per session — so the *only* difference between books is
the exit overlay.

| Book | Exit rule |
|---|---|
| **A** | The live engine: 5% hard stop, 8% take-profit, trailing stop (arms at +5%, exits on 3% giveback), signal-flip sell, rotation. **Control.** |
| **B** | A + the exhaustion exit |
| **C** | B + the eased re-entry |
| **D** | A + exits at **random times**, at book B's realized hazard rate. **Placebo.** |
| **E** | Exhaustion exit, RSI gate only |
| **F** | Exhaustion exit, ADX gate only |

Design constraints worth stating:

- **The overlay can only add exits, never mask a protective one.** Stop, take-profit, trailing and
  signal-sell all evaluate first. A rule that "improved" returns by suppressing a stop-loss would be
  measuring the wrong thing.
- **Book D is the honesty check.** It sells winners at random, at the same rate book B sells them by
  rule, over the same eligible population. If the rule can't beat "sell a winner at an arbitrary
  moment," it has no content. Its hazard rate is book B's *realized* rate (rule-exits per eligible
  position-day), measured in a first pass and applied in a second.
- Fills at the daily close, no slippage or commission. Scratch trades count as wins, matching the
  convention in this project's other harnesses.

### 2.3 Statistics

Forward-return cohorts are summarized with mean, median, share-negative, and a one-sample t-statistic.
Cohort-vs-control comparisons use **Welch's t-test** (unequal variances). Both cohorts and controls
are reported so the reader can check the arithmetic rather than trust a single difference.

---

## 3. Result 1 — the aggregate premise is backwards

**787 triggers** over 1,290 sessions.

| Horizon | After the break | Median | % negative | Random-time control | Δ (Welch t) |
|---|---|---|---|---|---|
| +5 days | **+1.18%** | +0.78% | 43% | +0.86% | +0.32 (t 0.88) |
| +10 days | **+2.24%** | +1.61% | 40% | +1.43% | +0.81 (t 1.58) |
| +20 days | **+3.24%** | +1.61% | 43% | +2.66% | +0.58 (t 0.78) |

Price after the "exhaustion break" does not fall. It rises, marginally faster than a random day in
the same stock, and fewer than half of all events were negative at any horizon. If anything, this
gate is a weak *continuation* signal.

**The ablations rule out the possibility that one half of the gate is carrying an edge the other is
diluting.** Neither does:

| Ablation cohort | n | +5d Δ vs control | +10d Δ | +20d Δ |
|---|---|---|---|---|
| RSI ≥ 75 + break only | 1,883 | −0.03 (t −0.11) | +0.11 (t 0.27) | −0.33 (t −0.54) |
| ADX ≥ 40 + break only | 1,609 | +0.28 (t 0.89) | +0.25 (t 0.56) | −0.11 (t −0.17) |

Every one of those is indistinguishable from the control.

**Note what this does *not* say.** The underlying diagnosis — that RSI stays pinned at the high end
in a strong tape, so naive RSI mean reversion fails — is correct, and this data supports it. The
error is in the correction: the extended-and-overbought state resolves *upward* far more often than
it reverts, so the right response is not to sell it.

---

## 4. Result 2 — it is a bear-market rule

Splitting the same 787 events by market regime changes the picture completely.

| Regime | n (distinct months) | +5d | +10d | +20d | % neg @20d | Control @20d | Δ (Welch t) |
|---|---|---|---|---|---|---|---|
| SPY **above** 200-day avg | 734 (49) | +1.35% | +2.64% | +3.86% | 40% | +2.85% | +1.00 (t 1.24) |
| SPY **below** 200-day avg | **53 (13)** | **−1.11%** | **−3.31%** | **−5.32%** | **75%** | +1.97% | **−7.29 (t −4.33)** |

In a risk-off tape the rule is not merely correct, it is emphatic: a −5.20% *median* at twenty days,
three-quarters of events negative, and a 7.3-point gap beneath a control that was itself positive.

**The honest reading:** this is a conditional rule that was generalized into an unconditional one,
most likely because the sample it was developed on was predominantly a bull market — where, as
Result 1 shows, it does the opposite of what's intended.

### Why I am not calling this validated

Three reasons, and I would rather state them than have them found later:

1. **53 events across 13 distinct months is roughly two market episodes**, not 53 independent
   observations.
2. **The forward windows overlap.** Events cluster inside a selloff, so their +10 and +20 day
   windows cover much of the same price action. This inflates the t-statistics materially — treat
   −4.33 as directionally strong, not as a literal significance level.
3. **I found this split by looking.** Testing a regime-gated version against the same data that
   suggested the regime gate is circular. That's how a real effect and a fitted one become
   indistinguishable.

This is a **generated hypothesis**, not a validated result — so I went and tested it. **§5 reports
what happened, and it is the section that decides this study.**

---

## 5. Out-of-sample test — the regime gate did not replicate (the deciding result)

Result 2 was a lead, not a fact: 53 events in one bear episode, found by slicing the data after the
fact. The only honest way to know whether it's real is to run the **exact same trigger, with the
constants frozen, on data the discovery never touched** and see if the same thing happens.

**The test.** I re-ran the identical code on a **2017-06-01 → 2021-05-28** tape (1,006 sessions, 123
names) — a window with two risk-off episodes the first study never saw: the **2018 Q4 −20% selloff**
and the **2020 COVID crash**. This required a deeper data feed (Alpaca's consolidated SIP tape, which
reaches back to 2016; daily SIP vs IEX differ by ≤0.16%, far too little to matter here). Nothing about
the rule was changed or re-tuned. Success criterion, **written down before the run:** the risk-off
cohort should again be significantly negative versus its control (t ≤ −2).

**What happened — two findings, both bad for the rule:**

**(a) The risk-off gate did not replicate. It didn't even fire.**

| | discovery (2021-2026) | out-of-sample (2017-2021) |
|---|---|---|
| risk-off events | 53 | **9** |
| +20d mean | −5.32% | **+10.44%** |
| vs control (Welch t) | −7.29 pts (t −4.33) | +0.64 pts (t 0.08) |

Nine events, pointing the wrong way. The reason is instructive: the 2022 bear that produced the
original result was a **slow grind down**, which gives stocks time to rally back to overbought and
then roll over — exactly what the trigger looks for. The 2018 and 2020 selloffs were **fast crashes**,
where stocks are oversold, not overbought, so the trigger almost never fires. The "risk-off edge" was
a property of *one specific shape of bear market*, not of downtrends in general.

**(b) The whole signal flipped sign.** This is the real verdict.

| horizon | discovery: event vs control | out-of-sample: event vs control |
|---|---|---|
| +5d | +0.32 pts (continuation) | **−1.01 pts (t −2.92)** |
| +10d | +0.81 pts | **−1.65 pts (t −3.64)** |
| +20d | +0.58 pts | **−3.27 pts (t −4.50)** |

In the first window, the break preceded *continuation* — price kept rising, so selling was the wrong
move (Result 1). In the second window, the break preceded *underperformance* — the stock trailed a
random day by more than three points over 20 sessions, so selling would have *helped*. **Same rule,
opposite conclusion, depending only on which years you look at.**

**Why this is decisive.** A tradeable edge has to have a stable sign. This one doesn't: had I only
ever seen 2017-2021 I'd have called it a great mean-reversion exit; had I only seen 2021-2026 I'd have
called it a continuation signal and told you never to sell. Both would have been overfitting to a
period. The out-of-sample test is precisely the thing that exposes that, and it did its job.

**Conclusion:** the rule — always-on *or* regime-gated — is **not adopted and not pursued further.**
There is no validated signal here to build a strategy around. The market intuition underneath it is
still sound (Result 1 confirms RSI pins in trends); what doesn't survive is turning it into a
mechanical rule with a fixed sign.

---

## 6. Result 3 — the structural finding (the one that matters most)

The portfolio walk is a null. *Why* it's a null is the most valuable output of the whole study.

Benchmark: SPY buy-and-hold over the same window returned **+91.4%**.

| Book | Return | Max DD | Sharpe | Trades | Win rate | Stop-outs | Rule exits |
|---|---|---|---|---|---|---|---|
| **A** live engine (control) | +77.9% | −13.0% | 1.11 | 5,092 | 37% | 861 | 0 |
| **B** exhaustion exit | +76.7% | −12.7% | 1.10 | 5,106 | 37% | 852 | **24** |
| **C** + eased re-entry | +80.9% | −12.8% | 1.14 | 5,107 | 37% | 852 | 22 (6 re-entries) |
| **D** random-time placebo | **+80.2%** | −13.0% | 1.14 | 5,094 | 37% | 845 | 24 |
| **E** RSI-only | +77.2% | −12.9% | 1.10 | 5,132 | 37% | 861 | 81 |
| **F** ADX-only | +79.8% | −12.9% | 1.13 | 5,135 | 37% | 855 | 63 |

Two things to read here.

**First: the placebo beat the rule.** Book D — which sells winners at *arbitrary* moments — returned
more than book B. The entire spread across all six books is noise. Nothing in this table supports
adopting the rule.

**Second, and more important: the rule fired 24 times in five years.** Twenty-four, across roughly
5,100 trades — **0.47% of eligible position-days.** The overlay is a rounding error, which means
books B through F are largely just re-running book A.

**The mechanism:** the live engine takes profit at +8% and trails with a 3% giveback once a position
is +5%. For the exhaustion rule to ever fire, a position must sit at ≥+5% profit *and* reach ADX 40
*and* reach RSI 75 *and* then break — all before the take-profit or the trailing stop closes it. That
sequence almost never survives.

**The generalization, which applies well beyond this rule:** any strategy of the form *"hold a winner
until the trend is exhausted"* — chandelier ATR trailing stops, pyramiding, wide volatility-scaled
trailing — is **unreachable by construction** in this engine. The correct experiment order is to
widen the profit-taking and trailing exits *first*, establish that positions can be held long enough
for a trend rule to have something to act on, and only then test the overlay. Testing the overlay
against the current exits will produce a null every time, regardless of the overlay's merit.

This reframes the original proposal: it was designed for a wide-stop trend-following book that holds
for months. That is a different machine than the one it was being tested against.

---

## 7. What I got wrong, and how the indicators were verified

Three corrections were made during construction. All three affected the numbers, and all three were
found before the results were treated as final.

1. **Today's partial bar was polluting the tape.** Results drifted between runs on the same day
   (book A moved +80.5% → +81.3%) because the in-progress session's incomplete bar was being fed to
   the indicators and used for final position marks. Fixed by truncating the tape to the last
   *completed* session — which is why the window ends 2026-07-21 rather than 07-22. **A backtest
   whose results change between runs on unchanged code is broken**, even if the drift looks small.
2. **The placebo was only approximately matched.** The first version estimated book D's exit rate
   from a proxy population (all symbol-days with a prior 10-day gain ≥5%), which is not the same
   population as "held positions currently at ≥+5%." Restructured into a two-pass walk so book D
   runs at book B's *realized* hazard over the *identical* population.
3. **The sticky-arm bookkeeping was tangled** — the profit gate and the arm reset were interacting
   incorrectly. Rewritten so arming tracks the *tape* (a position can become extended before it is
   +5% in profit) while only the sale requires the profit gate.

**Indicator verification.** The entire study rests on the ADX implementation being correct, so it was
cross-checked against an independently written ADX already in production in this system:

| Symbol | This study's ADX | Production indicator |
|---|---|---|
| AAPL | 27.09 | 27 |
| MSFT | 12.94 | (below 25 — correctly silent) |
| NVDA | 12.58 | (below 25 — correctly silent) |
| AMD | 15.83 | (below 25 — correctly silent) |
| TSLA | 13.77 | (below 25 — correctly silent) |
| JPM | 18.70 | (below 25 — correctly silent) |

Match, including every case where the production indicator correctly declines to signal.

---

## 8. Limits

**Limits of this study:**

- Alpaca daily history: IEX for the 2021-2026 window (floor ~2020-07), the consolidated SIP tape
  for the 2017-2021 out-of-sample window (floor ~2016-01). The two feeds differ by ≤0.16% on daily
  bars — negligible next to the effects measured.
- **Survivorship bias:** the universe is today's symbol list, so names that failed out of it are
  absent, and newer names simply have fewer bars in the earlier window (123 names vs 136).
- Fills at the daily close, with no slippage or commission modeled.
- **Each window contains only ~2 bear episodes**, and out-of-sample those were *fast crashes* rather
  than the slow grind of 2022 — which is itself part of the finding (§5a), not just a limitation.
- Overlapping forward-return windows inflate the reported t-statistics; read them as directional.
- Books diverge in holdings over time (different exits produce different portfolios) — inherent to
  comparing full simulations rather than isolated trades.

The out-of-sample test in §5 is what turns "single-window study" from a fatal limitation into a
resolved question: the discovery-window results were checked on independent data, and the regime
lead did not survive.

---

## 9. Exactly what was run

### Reproduction

```bash
# Type check
npx tsc --noEmit

# The in-sample study (2021-2026 IEX): event study + regime split + six-book portfolio walk
npx ts-node -r tsconfig-paths/register --transpile-only \
  scripts/oshal-trading-adx-exhaustion-backtest.ts

# The out-of-sample test (2017-2021 SIP, §5): same code, new data, event study only.
# The window and feed are env-overridable so the identical trigger/indicator/control code runs
# unchanged — an out-of-sample test must change the DATA, never the CODE.
ADX_START_ISO=2016-01-05 ADX_REPORT_FROM=2017-06-01 ADX_END_ISO=2021-06-01 \
  ADX_FEED=sip ADX_EVENT_ONLY=1 \
  npx ts-node -r tsconfig-paths/register --transpile-only \
  scripts/oshal-trading-adx-exhaustion-backtest.ts
```

Requires Alpaca Market Data API credentials in the environment. Runtime is a few minutes, dominated
by re-deriving the entry signal across ~1,000-1,300 sessions per run.

The run prints, in order: the event study with its random-time control, both ablation cohorts, the
regime split, and (in-sample only) the measured placebo hazard rate and the six-book portfolio table.

### Code written for this study

| File | Change |
|---|---|
| `scripts/oshal-trading-adx-exhaustion-backtest.ts` | **New.** The harness: Wilder RSI/ADX/DMI as full series, the event study with matched random-time control, ablations, regime split, and the six-book walk. Window and feed are env-overridable so the out-of-sample run reuses the identical code. |
| `src/features/trading/services/market-data.ts` | New `barsBatchSinceOhlcv()` — deep-history daily bars retaining high/low/open/volume (the existing deep fetch returns closes only, and ADX/+DI/−DI cannot be reconstructed from closes), later given an explicit `endIso` cap so a windowed multi-year fetch over ~140 names doesn't overrun the pagination budget. Purely additive. |
| `src/features/trading/index.ts` | Module export for the above. |
| `docs/apps/trading/strategy-log.md` | The permanent record: rule tested, both verdicts (in-sample and out-of-sample), and the numbers. |

Committed as `5eb3e3d4` (study), `0c7c7d15` (project log), and the out-of-sample follow-up — all with a passing type check.

### Pre-registered constants (fixed before the first run, unchanged for the out-of-sample run)

```
ADX_HOT        = 40      RSI_HOT         = 75
MIN_GAIN       = 5%      REENTRY_RSI     = 55
REENTRY_WINDOW = 15 sessions
FWD_HORIZONS   = 5, 10, 20 sessions
PRIOR_RUN_DAYS = 10      (the event study's stand-in for "a good profit")
break          = RSI(t) < RSI(t-1) AND close(t) < close(t-1)
```

---

## 10. References

### Technical indicators

1. **Wilder, J. Welles Jr.** *New Concepts in Technical Trading Systems.* Trend Research, 1978. The
   original definitions of RSI, ADX, the Directional Movement Index (+DI/−DI), Average True Range,
   and Wilder's smoothing. All indicators in this study use Wilder's smoothing as specified there,
   not simple or exponential moving averages — this matters, because the three differ materially at
   the extremes where this rule operates.
2. **Chandelier Exit** — an ATR-multiple trailing stop measured from the highest high since entry,
   generally attributed to Chuck LeBeau and popularized in later trend-following literature. Referenced
   in the original proposal (the "1.5 / 2 / 2.5 / 3 ATR cascade"). Not implemented in this study; see
   Result 3 for why it would be the *next* thing to test rather than something to test alongside.
3. **200-day moving average as a regime filter** — a long-standing convention for separating risk-on
   from risk-off market states. Used here for the regime split in Result 2.

### Statistics

4. **Welch, B. L.** "The generalization of 'Student's' problem when several different population
   variances are involved." *Biometrika* 34 (1-2), 1947, pp. 28-35. The unequal-variance t-test used
   for every cohort-vs-control comparison.
5. **Matched random-time control design** — the standard defense against an event study measuring
   ambient drift rather than the event. Adopted as a standing requirement in this project after an
   earlier family of event-driven signals produced strong absolute forward returns that a
   same-symbol random-time control matched exactly.

### Data

6. **Alpaca Market Data API** — daily OHLCV bars, IEX feed, split- and dividend-adjusted
   (`adjustment=all`). Free-tier historical depth for daily bars reaches approximately 2020-07.

### Project documents referenced

These live in the OSHAL repository and are cited for provenance; they are not required to evaluate
this study.

7. `docs/apps/trading/strategy-log.md` — the append-only record of every production trading
   configuration change and the evidence behind it. This study's entries, dated 2026-07-22, are the
   canonical short-form verdict, including the out-of-sample resolution in §5.
8. `docs/apps/trading/backtest-regression-suite.md` — the full catalog of backtest harnesses in this
   project, each with its command and standing verdict.
9. `docs/apps/trading/active-strategy.md` — the production strategy as built, including the 5% stop
   / 8% take-profit / 5-3 trailing exits that Result 3 identifies as the binding constraint.
10. `scripts/oshal-trading-stop-width-backtest.ts` — the sibling harness that established the
    current stop and take-profit settings. This is the study that would need to be revisited first
    if the exits were widened to make trend-holding rules reachable.

---

## Appendix — a note on what "no live change" means

The production trading configuration was not modified by this study, and the rule was not adopted.
The promising Result 2 was treated as a hypothesis and tested out-of-sample (§5), where it failed —
which is exactly why it was never allowed near live capital in the first place. The reason for the
discipline: a rule that *appears* profitable in one regime but reverses in another is *more*
dangerous than a rule that never works, because the losing half arrives quietly, during the regime
where positions are already under pressure — and you'd only find out which half you were in
afterward. The out-of-sample test is what tells you before, not after.

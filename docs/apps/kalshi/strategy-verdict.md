# Strategy verdict — three families tested, three falsified

**Bottom line: no mechanical edge was found on Kalshi. The market is efficient against every
strategy tried. The system's correct behavior is to fold — and it does.**

This is the honest record of what was tested (2026-07-13), why each idea failed, and what would
actually be required to win. Read it before proposing a "new strategy" — odds are it belongs to
one of the families already refuted here.

## The scoreboard

| Family | The question it asks | Verdict |
|---|---|---|
| **Calibration** | Is the market's *price* systematically wrong? | ❌ Refuted — measurement artifact |
| **Structural arbitrage** | Do the market's *own prices* contradict each other? | ❌ Zero fillable opportunities |
| **Naive information** | Does the market ignore *free public data*? | ❌ Already priced in |

## 1. Calibration — refuted by adversarial review

The first study looked like a strong favorite-longshot bias (+12¢ on 50–60¢ favorites). A
4-skeptic adversarial review found it was measurement artifact: stale-price basis with no spread
charged, heavy series clustering inflating apparent sample sizes, only 2 of 48 cells surviving
multiple-comparison correction, and — fatally — **the edge vanished in Sports, the one category
with fillable books**. Full detail: [calibration-verdict.md](./calibration-verdict.md).

## 2. Structural arbitrage — sound math, no fillable opportunities

Rather than predicting outcomes, ask whether the market's prices are *internally inconsistent*.
Three sub-strategies were implemented ([arbitrage.ts](../../../src/features/prediction-markets/services/arbitrage.ts)):

- **Overround** — buy NO on every leg of a mutually-exclusive event. At most one can resolve YES,
  so at least *n−1* legs must pay. Sound *without* assuming the outcome set is exhaustive.
- **Ladder inclusion** — a higher strike is a strict subset ("above 95°" ⊂ "above 90°"), so its
  probability can never exceed the lower strike's. An inverted book is locked by arithmetic.
- **Underround** — Σ(asks) < $1. Reported as a *candidate only*: Kalshi's `mutually_exclusive`
  flag does **not** imply exhaustive, so an unlisted outcome can make the basket pay $0.

Live sweep of **4,000 events / 32,956 markets** — and the path to the answer was three
self-caught bugs, each of which invented free money:

| Reported | Reality |
|---|---|
| **594 locks** | `between` **bucket** markets ("0 seats" / "1 seat") carry a `floor_strike` exactly like a real ladder does. Feeding *disjoint* outcomes into *subset* logic manufactures arbitrage out of coherent prices. Only a genuine one-sided threshold (`greater`/`greater_or_equal`) nests. |
| **18 locks** | **Same-strike, different-deadline** ladders (IShowSpeed 100M subs: identical `floor_strike`, deadline encoded only in `close_time`). Sorting by strike was a no-op that silently swapped subset for superset — producing a basket that pays **$0** if the event lands in an in-between year. |
| **6 locks** | Structurally sound, but +$0.005/basket on markets whose order book is **empty** (`liquidity_dollars: 0`, orderbook returns null). Not fillable at any size. |
| **0** | **Actual actionable arbitrage.** |

Time-ladders are now permanently demoted to *candidates*: inclusion holds for first-passage
markets ("when will X **first** reach Y") but **not** for level-at-date markets ("will X **be
above** Y **on** date D") — and that distinction lives in the rules text, not in any API field.
Eight regression tests pin every phantom class ([kalshi-arbitrage.spec.ts](../../../tests/unit/kalshi-arbitrage.spec.ts)).

## 3. Naive information edge — the market already reads the forecast

Kalshi runs daily temperature markets; the National Weather Service publishes official forecasts
for free. If the market ignored them, that would be an edge requiring no cleverness at all.

It doesn't. For NYC high temp on 2026-07-14:

| NWS official forecast (Central Park) | Kalshi's modal bucket |
|---|---|
| **94°F** | **94–95° @ 46%** |

The market's implied distribution sits squarely on the official forecast. **There is no free lunch
in reading public data — the market has already read it.**

⚠️ **The most important lesson of the night is buried in this test.** An initial run used the
*wrong NWS grid cell* (33,37 instead of Central Park's 34,45), which returned 91°F and made the
market look wildly mispriced — an apparently enormous edge. It was entirely a self-inflicted data
error. **Had that been trusted, it would have driven real money into a fabricated signal.** Four
times tonight, an apparent edge dissolved on verification. That base rate is the finding.

## What would actually be required to win

The families above are the *easy* ones, and easy edges do not survive on a regulated exchange with
professional participants. A genuine edge needs one of:

- **A better model than NWS itself** — ensemble forecasts, intraday station observations,
  nowcasting. Not "read the forecast" but "beat the forecast." Real, hard, uncertain.
- **Speed** — reacting to news/data releases faster than the book reprices. Competing directly
  with professionals on infrastructure.
- **Genuine domain expertise** in a niche the market prices lazily — and then the edge is your
  knowledge, not the algorithm.

None of these are a weekend project, and none are guaranteed. That is what an efficient market
looks like from the inside.

## So what did we build?

A system that **correctly refuses to bet** when it has no edge — verified end-to-end, with real
money hard-gated off. Given that every edge tested was an illusion, *not betting is the winning
move*, and the machinery reliably arrives at it. The infrastructure (calibration engine, fee math,
Kelly sizing, order placement, audit trail, paper-trading path) is sound and ready if a real edge
is ever found. What it will not do is manufacture one.

## Addendum 2026-09-04 — "bet against ourselves at the extremes?"

Operator question, verbatim intent: if the model is extremely wrong, is it extremely right on the
other side? Scored on the graded record (2,447 settled predictions, spread proxied at 2¢/6¢ from the
wide-spread flag, fees included), the answer is *slightly*, not extremely:

| Variant (flip our pick to the other side) | Bets | Flipped, proxy spread | If spread 2¢ worse |
|---|---|---|---|
| Everything, scan strategy | 828 | −$11.85 | −$28.41 |
| Everything, weather strategy | 1,619 | +$5.34 | −$27.04 |
| Scan picks with our P ≥ .90 or ≤ .10 | 79 | +$5.13 | +$3.55 |
| Weather picks disagreeing with the market by 30+ pts | 153 | +$12.37 | +$7.78 (6¢ spread) |
| Our longshots (price ≤ .20), either strategy | 1,077 | −$7.61 | −$29.15 |
| Our mid-range (.40–.60), either strategy | 681 | −$3.64 | −$17.26 |

Why the flip cannot be big: our loss was mostly fees + spread + being a few points optimistic. The
mirror of "slightly overconfident, minus costs" is "slightly right, minus the same costs", and
flipping means paying the OTHER side's ask — one minus our bid, not one minus our ask. Buying the side
the market favours at the market's price is agreeing with the market, which the scorecard scores at
zero by definition.

Two of fourteen variants survive a 2¢ haircut, at 6–8¢ a contract. That is what dredging a losing
record usually finds, so they are **pre-registered as zero-stake forward tests**, rules fixed today:

- `contrarian-extreme` (kalshi package 1.1.2, `kalshi-scan-config.ts`): for every scan hand with our
  P ≥ .90 or ≤ .10, the opposite side at its own ask (= 1 − our bid), claimed +.10 over the market.
- `contrarian-weather-disagree` (`scripts/kalshi-contrarian.ts`): for every weather pick disagreeing
  with the market by ≥ .30, the opposite side at its own ask, claimed +.10 over the market.

Both are graded by the same daily grader against the market's Brier and appear on the Scorecard tab.
Until one is PROVEN there it stakes nothing. The scheduled task that grades them had been running from
the stale pre-cutover checkout since the trunk cutover; it now runs from this tree.

# Gravity 2 — world-intelligence mass model (design spec)

_Created 2026-06-26. The faithful ADR-054 gravity model: price is displaced by **masses** derived from
real-world events (news, insider, congress, …), each with a **calculated proximity** (how directly it
hits THIS stock) and a **half-life** (time decay). Gravity 1 (live today) is a price-only shadow of this;
Gravity 2 fuses the world-intelligence layer in as the masses it was always meant to use._

Builds on: [advisor-deep-dive.md §6](advisor-deep-dive.md) (gravity), §15 (world layer),
[adr/054-gravity-model.md](../../adr/054-gravity-model.md). **Paper-only; additive; off by default.**

> **Status (2026-06-26): BUILT + DEPLOYED, eval-only.** The assess leg records `gravity2` predictions
> next to `gravity`; the overnight review scores them head-to-head. It trades nothing — live trading
> waits behind a (specced, not-wired) `TRADING_GRAVITY2` flag until the head-to-head earns it. A real
> historical backtest is **not possible yet** (insider/congress data started today; raw stories go back
> ~6 days) — the forward head-to-head over the next 1–2 weeks is the test. See §10 for the per-story
> follow-up (deferred).

---

## 1. The physics

A mass pulls a stock's price by an amount proportional to its **mass** and its **proximity**, in the
direction of its **polarity**, decaying over time by its **half-life** — exactly Newtonian intuition:
*a huge force far away barely moves you; a large force close by moves you a lot.*

```
contribution = polarity × mass × proximity × decay          decay = 0.5 ^ (age / halfLife)
displacement = clamp( Σ contributions × (1 − antigravity_damp), −MAX, +MAX )
```

- **polarity** (+1 / −1): pull **up** or **draw down**. Insider buying = +; a lawsuit = −.
- **mass** (0..1): *how big* the force is — magnitude × reach. A unanimous, loud, large event = high mass.
- **proximity** (0..1): *how close* the force is to THIS stock — **a calculated value, not a constant**
  (see §3). A market-wide rumor co-mentioned across 50 tickers is "far"; a filing about this exact
  company from reliable sources in tight agreement is "close."
- **half-life**: a tweet decays in days, an FDA ruling in months.

The existing `displacement()` in `algorithms.ts` already implements this engine. Gravity 2 just feeds it
**world masses** alongside the price masses Gravity 1 already uses.

## 2. Mass sources (the world-intelligence → mass mapping)

Each source maps a `world:ticker:<sym>` metric set to one mass. Every dial is **configurable** (§4).

| Source | Polarity | Mass = magnitude × reach | Half-life | Notes |
|---|---|---|---|---|
| **News sentiment** | sign(sentiment) | abs(sentiment) × saturation(mention_velocity) | 5 d | the loud, fast force; reach = how much it's being talked about |
| **Insider** | sign(insider_net) | abs(insider_net) × saturation(insider_buys+sells) | 21 d | direct smart-money; a cluster of buys is a strong, slow pull |
| **Congress** | sign(congress_net) | normalize(congress_notional) | 30 d | slow, direct; size of trades = reach |
| **Short interest** | − (bearish) | scale(short_vol_ratio) | 10 d | configurable; ambiguous (squeeze risk), default small + can be disabled |
| **Events** (earnings/M&A/legal/guidance) | — | — | — | not a directional mass in v1; instead **modulates** proximity + shortens half-life near an event (a catalyst makes everything more "in orbit") |

Each source returns `null` when it has no data — it only votes when it fires, like every other signal.

## 3. Calculated proximity (the centerpiece)

Proximity is **computed per signal**, in [0,1], as the product of four factors (each itself in (0,1]):

```
proximity = clamp( directness × focus × reliability × saturation , proxFloor , 1 )
```

| Factor | What it captures | Computed from |
|---|---|---|
| **directness** | Is the force about THIS stock, or a diffuse market-wide one? | `1 / (1 + k_co · comention_degree)` — entangled with many other tickers ⇒ "farther". Insider/congress are about the company itself ⇒ directness ≈ 1. |
| **focus** | Tight agreement vs scattered noise | `consensus / (1 + k_d · dispersion)` — high `sentiment_consensus`, low `sentiment_dispersion` ⇒ "closer". |
| **reliability** | Trustworthy sources vs rumor | alignment of `reliability_weighted_sentiment` with raw `sentiment` — reliable sources agreeing ⇒ "closer". |
| **saturation** | Enough evidence to be real | `min(1, volume / volRef)` — a handful of data points ⇒ uncertain ⇒ "farther". |

So a mass can be **huge but far** (big sentiment swing, but scattered, low-reliability, co-mentioned
everywhere → low proximity → small pull) or **small but close** (a modest but unanimous, reliable,
company-specific signal → high proximity → real pull). That is the physics you asked for.

## 4. Configurable mass calculation

All of it is config-driven — a `Gravity2Config` object with sensible defaults, overridable by env
(`GRAVITY2_*`) so it can be tuned without a code change:

```
perSource:  { enabled, massScale, halfLifeDays }        // turn a source on/off, scale its mass, set decay
proximity:  { kComention, kDispersion, volRef, floor }  // the §3 factor weights
windowDays:  number                                     // recency window for the world read (default 7)
maxWorldDisplacement: number                            // cap the total world pull so it can't dominate price
```

`massScale` is the literal "how its mass is calculated" knob per source: raise it to let insider buying
pull harder, lower it to mute noisy news. Defaults ship conservative.

## 5. How Gravity 2 combines with Gravity 1

`gravity2` is a **new algorithm alongside** `gravity` (not a replacement):

```
priceMasses = deriveMasses(symbol, closes, spy)      // exactly Gravity 1
worldMasses = deriveWorldMasses(symbol, snapshot, cfg) // §2/§3, this spec
gravity2.displacement = displacement(priceMasses ++ worldMasses)
```

When there's no world data, `worldMasses = []` and **gravity2 == gravity** — so the head-to-head is
clean: any difference is purely the world contribution.

## 6. How we test it (no historical backtest needed)

The predictions ledger + overnight review already score every algo's hit-rate **and** expectancy
head-to-head. Gravity 2 plugs straight in:

1. The **assess leg** records a `gravity2` prediction next to the `gravity` one every run.
2. The **overnight review** scores `gravity` vs `gravity2` on the same names, same window — you read the
   winner straight off the "🧠 signal review" ticket (hit-rate + expectancy per algo).
3. After ~1–2 weeks of sessions you can see whether the world masses actually add edge. No assumptions.

Live trading on gravity2 stays behind a flag (`TRADING_GRAVITY2`) you flip only once the head-to-head
earns it.

## 7. Backtest — and its honest limits

We can replay gravity-vs-gravity2 over the world data we **have**, but be clear-eyed about how thin it is:

| Input | Usable history |
|---|---|
| price masses | full (Alpaca daily bars) |
| news sentiment | dense only from **June 2026**; sparse Jan–May |
| insider / congress | **started today** — effectively no history |

So a backtest exercises mostly the **sentiment** masses over **~one month, one (rising) regime**, with
insider/congress contributing ~nothing (no past data). It's a **wiring + sanity check**, not an edge
proof — the real evidence is the **forward** head-to-head (§6), because the data we're collecting now is
the history a proper backtest will use in a few months.

## 8. Rollout

- **2026-06-26 (done):** spec + build + deploy. The assess leg now records `gravity2` head-to-head. The
  day-by-day backtest ran and found **0 gravity1-vs-gravity2 disagreements** over the available history —
  news masses are too small to flip a price-dominated signal, and the strong movers (insider/congress)
  have no past. Confirmed forward-only.
- **This coming week:** every assess run records `gravity2`; the overnight "🧠 signal review" ticket
  scores `gravity` vs `gravity2` (hit-rate + expectancy) on the same names.
- **~2 weeks out:** read the review ticket. If gravity2's expectancy beats gravity, wire + flip
  `TRADING_GRAVITY2` to let it influence trades (still paper). If not, the world masses didn't earn it.

Confirm it's recording:
```bash
docker exec oshal-local-db psql -U oshal -d oshal -tAc \
 "SELECT algo, count(*), max(created_at) FROM oshal_trading_predictions WHERE algo IN ('gravity','gravity2') GROUP BY algo"
```

## 10. Per-story masses (v1.1 — deferred)

The current build reads the **aggregated** per-ticker sentiment (an average of all RSS/news stories in
the window) as ONE news mass. The purer ADR-054 model is **one mass per story/event**: each classified
story in `world_items` (title, outlet, lean, reliability, sentiment, pub_date) becomes its own named mass
— polarity = its sentiment, mass = magnitude × outlet reach, proximity = outlet reliability × how directly
it names the ticker, half-life = decay from its own `pub_date`. More faithful, more interpretable (you'd
see "Reuters: FDA approval +0.8" instead of an averaged number), more powerful.

**Deferred on purpose.** Raw `world_items` only goes back ~6 days, so per-story **cannot be backtested**
meaningfully yet, and it's more complex. Decision: let the deployed aggregate gravity2 prove (forward)
that world masses add edge *at all* first; if it does, build per-story then — by which point there's
enough raw-story history to actually validate it. Prove the simple version before building the complex one.

## 9. Files

- `src/features/trading/services/gravity-world.ts` — `deriveWorldMasses`, `Gravity2Config`, calculated proximity (pure, unit-testable).
- `src/features/trading/services/algorithms.ts` — export `Mass`; `AlgoContext.worldMasses`; the `gravity2` algorithm.
- `src/app/trading-world-masses.ts` — `readGravityWorldSnapshot` (batched world read → per-symbol snapshot).
- `src/app/trading-assess-dispatch.ts` — record `gravity2` predictions head-to-head.
- `scripts/oshal-gravity2-backtest.ts` — gravity vs gravity2 over available data.

# Trading signal dataset — what we need World Intelligence to record

> **Why this exists.** Price-only backtests keep failing because the real driver is *news/events*, and
> we have no historical news to test against. The fix: **record a rich, timestamped signal vector for
> every name now, self-label it with the realized forward return, and accumulate.** In a few weeks we
> own a proprietary labeled dataset and can finally test "when signal X fired, what did price do" — for
> real, on our own data. This is also the data the **Gravity model** (ADR-054) needs: these features ARE
> the masses (reach × magnitude × polarity × proximity).
>
> Pairs with [docs/apps/trading/intraday.md](intraday.md) (why price-only failed) and the World
> service [src/features/world-data/world-intelligence-service.ts](../../../src/features/world-data/world-intelligence-service.ts).

## What already exists (reuse, don't rebuild)
- **`world_items`** — every pulled news item per entity: outlet, **lean**, **reliability**, title/body,
  `pub_date`, **sentiment**, extracted **entities**, classifier model/version, `first_seen_at`, `seen_count`.
  Idempotent by content hash. (The raw substrate.)
- **`world_metrics`** (TimescaleDB hypertable) — `(entity, metric, ts, value, source)` time-series.
  Today it mainly carries `sentiment` per outlet. **This is where every feature below lands.**
- **`sentimentBreakdown()`** — bias-aware: naive / balanced / reliability-weighted / by-lean / **consensus**.
- **`pullStats()`** — `freshRate = new/fetched` per source (= novelty).
- **Graph** — `world:<type>:<key>` nodes + `moves_with` / `correlates_with` / `in_sector` / co-mention edges.
- Coverage: 15 macro topics always-on + per-ticker subjects added from the trading universe; 6-hourly refresh.

## What to add — the recording spec

### 1. Coverage: the 100 names + the markets around them
Record all of these as `world:` entities so signals have context, not just single stocks:
- **Stocks (~100):** the trading `DEFAULT_UNIVERSE` (`world:ticker:<sym>`).
- **Index/breadth:** SPY, QQQ, IWM, **VIX** (`world:index:*`).
- **Sectors:** XLK/XLF/XLE/XLV/XLY/XLI/XLP/XLU/XLB/XLRE/XLC (`world:sector:*`) — for sector rotation + the
  per-stock "is my sector hot?" feature.
- **Commodities:** CL, ES (have minute data), GC (gold), NG, HG (copper) (`world:commodity:*`).
- **Rates / FX / crypto:** US10Y, US02Y, DXY, BTC, ETH (`world:macro:*`, `world:crypto:*`).
- **Macro topics:** already covered (Fed, inflation, jobs, energy…). Keep.

### 2. Per-entity FEATURE metrics (write into `world_metrics`, one row per metric per pull)
Most are derivable by rolling up `world_items` we already archive — they just need to be *computed and
written as metrics* so they're a queryable time-series.

| metric | meaning | why it predicts |
|---|---|---|
| `mention_count` | # items in the window | attention level |
| `mention_velocity` | mention_count vs trailing-N baseline (z-score) | **acceleration = "something is happening"** (the event detector) |
| `novelty` | fresh / total (freshRate) | new news vs recycled — real events are novel |
| `sentiment_mean` | bias-aware mean (balanced) | direction of the narrative |
| `sentiment_shift` | sentiment vs trailing baseline (Δ) | **the change matters more than the level** |
| `sentiment_dispersion` | stdev across outlets | disagreement / uncertainty |
| `sentiment_consensus` | do left/center/right agree | agreement = conviction (from `sentimentBreakdown`) |
| `reliability_weighted_sentiment` | trust factual sources | filters noise outlets |
| `event_*` | per-type intensity flags (below) | the *kind* of catalyst |
| `comention_degree` | # co-mentioned tickers/people (graph degree) | contagion / who-moves-with-whom |
| `sector_sentiment` / `sector_mention_velocity` | the entity's sector roll-up | is the whole sector moving? |

**`event_*` types** (the analyst bot classifies each item; store the tag on `world_items`, roll to metrics):
`event_earnings`, `event_guidance`, `event_ma` (M&A), `event_rating` (up/downgrade), `event_legal_reg`,
`event_product`, `event_exec` (leadership), `event_macro`, `event_supply` (disaster/supply shock → ties
weather feed). Each as an intensity in [0,1] so "earnings + positive sentiment_shift + high novelty" is a
queryable combination.

### 3. PRICE + OUTCOME LABELS (so the dataset is self-labeling — the part that makes it testable)
Write price into the same store, then a daily **labeler** back-fills realized forward returns onto each
past signal timestamp:

| metric | meaning |
|---|---|
| `price` | last/close per entity (from Alpaca bars) — aligns price with signals in one store |
| `ret_session`, `gap_overnight`, `rel_volume`, `realized_vol` | market-state features |
| `fwd_ret_30m`, `fwd_ret_eod`, `fwd_ret_1d`, `fwd_ret_3d`, `fwd_ret_5d` | **the labels (y)** — realized return at each horizon after the signal time |

A signal row + its `fwd_ret_*` = one labeled training example. Accumulate thousands of these and we can
mine "which feature combinations actually precede a move," walk-forward, on our own recorded data.

### 4. Cadence
- **Intraday pulse (market hours):** every **15–30 min** for the 100 names + indices/sectors — fast enough
  to catch intraday catalysts (today's 6-hourly refresh is too slow for trading). Light pull, deterministic
  sentiment for known items; LLM-classify only **novel, high-attention** items (cost control — `usedLlm` already tracks this).
- **Deep refresh:** keep the 6-hourly bias-balanced (left/center/right) pull for macro + a daily deep per name.
- **Labeler:** once daily after the close — compute `fwd_ret_*` for all matured signal timestamps.

### 5. Provenance & cost
- Every metric row carries `source` (feed/bot) — already supported.
- News feeds are free (RSS/Yahoo); the only real cost is LLM classification → gate it to novel/high-attention
  items, and store `classifier_version` so we can re-score history when the classifier improves.

## Build order (proposed)
1. **Feature-rollup job** — read `world_items`, compute §2 metrics per entity per window, write to `world_metrics`. (Mostly reuses existing data; biggest immediate win.)
2. **Coverage expansion** — add the index/sector/commodity/rate/FX/crypto entities (§1) to the refresh set.
3. **Price + labeler job** — write `price`/state features from Alpaca bars; daily back-fill `fwd_ret_*` (§3).
4. **Intraday pulse** — 15–30 min market-hours refresh for the trading universe (§4).
5. **Event-type classifier** — extend the analyst bot to tag `event_*` on each item (§2).
6. **(Later) Mining harness** — once weeks of data exist, a script (sibling to `oshal-intraday.js`) that
   walk-forward tests feature→`fwd_ret` rules and feeds the winners to the Gravity model + live bot.

## Status — my lane (label & test) is BUILT (2026-06-24)
The trading side of the split is live; it runs against whatever the world layer is recording (today:
`sentiment` + `mentions`) and sharpens automatically as richer features land (the miner auto-discovers
every metric in `world_metrics` — no code change to pick up `mention_velocity`, `sentiment_shift`, `event_*`).

- **`scripts/oshal-signal-label.js`** — for every `world:ticker:*` signal day, pulls Alpaca adjusted daily
  bars and writes realized forward returns (`fwd_ret_eod/1d/3d/5d`) to **`trading_signal_labels`** (our own
  table in the TSDB — never `world_metrics`). Idempotent, only labels matured horizons. **Run daily.**
  `node scripts/oshal-signal-label.js [years]`
- **`scripts/oshal-signal-mine.js`** — joins features (`world_metrics`) to labels, quantile-buckets each
  feature vs the forward return, and shows the gradient IN-SAMPLE and on a held-out later slice (temporal
  70/30). A signal is real only if |corr|>0, the bucket gradient is monotone, AND it holds OOS.
  `node scripts/oshal-signal-mine.js [horizon] [buckets]`

**First read (≈2 weeks of data — indicative only, samples thin):** `mentions` (attention) is *negatively*
related to next-day return and holds sign OOS (high news volume → a dip); `sentiment` shows an in-sample
same-day gradient that does NOT survive OOS. Verdict: keep accumulating — too young to trust, but the
gate works. Re-run weekly as the dataset grows and features expand.

**Still mine to build:** intraday horizons (`fwd_ret_30m`) once their intraday pulse lands (needs minute
bars at the signal timestamp); promote the labeler+miner to a scheduled dispatch leg; feed confirmed
signals to the Gravity model + live bot.

## What I need from you / the running World layer
- Confirm `ENABLE_WORLD_INTELLIGENCE=true` + `TSDB_URL` + `ARANGO_URL` are set on the running instance
  (the service is start-param gated; it's already read by the trading autopilot's world-sentiment veto).
- The universe list to lock coverage to (default: the trading `DEFAULT_UNIVERSE` 100 names + the markets in §1).
- Green-light the build order above; #1 (feature rollup) + #3 (labeler) are what turn the *already-recording*
  news archive into a *testable* dataset.

## Status — World layer (record & enrich) is BUILT (2026-06-24)
The world side now records the rich feature vector your miner auto-discovers. Confirmations + deliverables:

- **Env confirmed** on the running `oshal-local-api`: `ENABLE_WORLD_INTELLIGENCE=true`, `TSDB_URL`, `ARANGO_URL`,
  `ENABLE_AGENT_SCHEDULER=true`. **Coverage locked to** `DEFAULT_UNIVERSE` (100) + the §1 markets.

- **#1 Feature rollup — BUILT.** `WorldIntelligenceService.rollupFeatures(entity)` runs after every refresh and
  writes these §2 metrics into `world_metrics` (`source='feature-rollup'`, 24h window vs 7d baseline):
  `mention_count`, `mention_velocity` (ratio vs baseline — not yet a z-score), `novelty`, `sentiment_mean`
  (bias-balanced), `sentiment_shift`, `sentiment_dispersion`, `sentiment_consensus`,
  `reliability_weighted_sentiment`, `comention_degree`. Pure rollup over the existing archive — your miner
  picks them up automatically.

- **#2 Coverage — BUILT.** `src/features/world-data/market-subjects.ts`: SPY/QQQ/IWM/VIX, 11 SPDR sectors,
  CL/ES/GC/NG/HG, US10Y/US02Y/DXY, BTC/ETH — all as `world:` entities riding the pulse, so signals have
  market context (`world:index:vix`, `world:sector:xlk`, …).

- **#4 Intraday pulse — BUILT, every 5 min** (`*/5 8-23 * * 1-5`), tighter than the 15–30 spec. All names get a
  lean 3-source pull; a rotating 12/fire slice gets the full finance fan-out. Dedup-by-hash means only novel
  items classify (cost control). **This is the signal-timestamp source for your `fwd_ret_30m`** — though that
  horizon needs minute bars at the timestamp, which is your Alpaca side.

- **#3 Price + labeler — YOURS, already built** (`oshal-signal-label.js` → `trading_signal_labels`). Correct call
  keeping labels out of `world_metrics`. Nothing needed from me there.

- **#5 `event_*` catalyst classifier — BUILT (2026-06-24).** The analyzer pass now also tags each item with its
  dominant catalyst + intensity (one LLM call, no extra cost): `event_earnings`, `event_guidance`, `event_ma`,
  `event_rating`, `event_legal_reg`, `event_product`, `event_exec`, `event_macro`, `event_supply`. Stored on
  `world_items` (`event_type`/`event_intensity`, additive columns) and rolled into `world_metrics` (max intensity
  per type per window, only types that occurred). Classifier bumped to `world-analyze-v2`. Your miner auto-picks
  these up — so "earnings + positive `sentiment_shift` + high `novelty`" is now a queryable combination.

**Caveat (shared infra):** the schedule runner dispatches due schedules **serially** in a single-flight cycle, so
a long `trading-analyst` research task can delay the pulse within a cycle. Both world handlers are bounded so they
don't hog it; if pulses lag during heavy research windows, the fix is making `dispatchDueSchedules` concurrent — a
cross-cutting change worth doing together.

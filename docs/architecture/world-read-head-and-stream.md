# World layer: the head and the running stream

The world-intelligence layer stores two different things and they want different storage. Conflating
them is what made World Intelligence unusable as a UX and made the trading autopilot's world read
cost ten seconds every five minutes.

- **The running stream** — `world_metrics`, `world_items`, `world_pulls`. Every observation, kept
  forever. The substrate for backtests, drift analysis, and deep history.
- **The head** — the small, current, pre-aggregated answer interactive readers actually want: the
  autopilot's influence gate, the cockpit surface, Jarvis' brief.

Before this split, every head read was computed by re-scanning the stream.

## What was measured (live stack, 2026-07-29)

`world_metrics` held 8.88M rows, `world_items` 1.09M rows / 1.36 GB, `world_pulls` 1.70M rows.

| read | before | after |
|---|---|---|
| trading basket — 100 tickers × 12 metrics × 30d, **runs every 5 min** | 10,483 ms | 164 ms |
| `listEntities` — the surface's FIRST request, everything else queues behind it | 7,757 ms | 11 ms |
| `sentimentBreakdown` | 2,966 ms | 133 ms |
| `pullStats` | 2,033 ms | 81 ms |

## The three causes

**1. The pre-aggregation was appended back into the stream it was meant to replace.**
`rollupFeatures` already computes the signal vector per subject per pulse — but it writes the results
into `world_metrics`. Those rollup rows became **6.0M of the 6.8M rows** written in the last 30 days
(88%), so readers re-aggregated the pre-aggregated answers. The stream grows ~6M rows/month, so every
read got slower every month. A rollup that lands in the stream is not a head.

**2. Chunk fan-out from real publication dates.** Archived articles carry their actual `pubDate`, so
the metric hypertable spans ~50 years (CNN 1995, CNBC 2000). At a 7-day chunk interval that is **798
chunks, 739 of which hold 0.7% of the rows**. A wide query then paid a 798-chunk planning fan-out:
the sentiment read spent **1,098 ms in PLANNING** to touch three buffers of data. This is a
chunk-sizing problem, not a data-quality problem — the old rows are real history and nothing was
deleted. The chunk interval is now 30 days for new chunks.

**3. The surface asked for `days=3650` on every panel.** "All history" is the worst possible default
here, because it is precisely what maximises the chunk fan-out. The window is now a visible control
defaulting to 90 days, which covers ~98% of the archive.

## The head

`world_metrics_daily` — a continuous aggregate bucketing the stream to `(day, entity, metric, source)`
with `sum(value)` and `count(*)`. 8.88M stream rows collapse to 538K head rows.

Readers recover the mean as **`sum(sum_v) / sum(cnt)`**. This is arithmetically identical to
`avg(value)` over the same rows — verified across 6,714 `(entity, metric)` pairs: **zero** row-count
mismatches, maximum average difference 3.8e-06 (float summation order). That exactness is what makes
it safe to put under a money path.

> Do **not** "simplify" this to `avg(sum_v/cnt)`. That is an unweighted mean of daily means, a
> different number whenever observations-per-day varies — which for a market-hours feed is always.

`world_subjects` — one row per tracked subject (label, item count, last seen), maintained
incrementally by `archiveItem`. Only a genuinely new item bumps the count, so the head's `items`
matches `count(*)` over the archive rather than counting re-sightings.

### `materialized_only = false` is a correctness setting

TimescaleDB 2.13+ **defaults `materialized_only` to `true`** (verified on 2.28). With it true, a
continuous aggregate that has not been materialized yet returns **zero rows** — not the correct
answer computed from the stream. The trading gate cannot distinguish that from "this subject has no
world coverage", so it would silently drop the signal.

With `materialized_only = false`, an unmaterialized head returns the **correct** answer (TimescaleDB
computes the un-materialized span from the raw hypertable) and is merely as slow as the old path until
the refresh lands. A fast wrong number under an autopilot is far worse than a slow right one.

Measured on a fresh aggregate over 8.88M rows: 0 rows with `materialized_only=true`, the full correct
538,333 with it false.

### Refresh policy

`start_offset => NULL` — the whole history, deliberately. Archived articles arrive with old
publication dates, so invalidations land in buckets years back; a bounded window would leave those
permanently stale. A full-range refresh only processes *invalidated* ranges, so it is incremental in
practice: **49 s** for the initial build, **~0.85 s** per run after.

### Indexes

TimescaleDB auto-creates `(entity, bucket)`, `(metric, bucket)`, `(source, bucket)` — one per GROUP BY
column. Every hot read filters on entity **and** metric together, so none of those is selective
enough alone. The added `(entity, metric, bucket DESC)` composite is worth 3× on the sentiment read
(442 ms → 133 ms).

## Window alignment

The head buckets by day, so read windows are aligned with `date_trunc('day', now())`. Besides being
required for an exact head read, this makes a window **reproducible**: "the last 30 days" is 30 whole
days rather than a trailing 30×24h that shifts every second, so two reads a minute apart agree and a
replayed backtest matches the live read.

**This is a behaviour change to disclose:** a window now reaches back to midnight of its first day, so
it can include up to one extra day of observations at the far edge compared to the old
`now() - N days`.

## What deliberately still reads the stream

`perSourceSentimentHours` serves `rollupFeatures`' 24h and 168h windows — below day granularity, so
the daily head cannot answer it. It reads `world_metrics` directly via the
`(entity, metric, ts DESC)` index. Do not "optimize" it onto the head. `archivedItems` (backtest
replay) and `pullStats` likewise read their raw tables; the latter got the
`world_pulls (entity_id, ts DESC)` index it had been missing, which is why it was
sequential-scanning every chunk.

## Guards

`tests/unit/world-preaggregate.spec.ts` pins the properties whose violation would not raise an error,
only change numbers: sum/count is not a mean-of-means, the window stays day-aligned,
`materialized_only` stays false, the refresh policy stays full-range, the catalog head is not
re-aggregated from the archive, and the sub-day rollup window stays on the stream. Both the
"revert a read to the raw stream" and "flip materialized_only to true" mutations were confirmed to
turn it red.

# ADR-061 — World-Intelligence layer (Layer B): shared, bias-aware, a swarm service + registered app

- **Status:** Accepted — built + verified 2026-06-20; extended 2026-06-22 (deterministic refresh) and
  2026-06-24 (finance coverage + 5-min intraday pulse + feature rollup + `event_*` catalyst classifier — the
  capture half of the trading signal dataset; see the dated Updates at the end). The shared world graph +
  series + classified archive, the bias-aware multi-axis sentiment read, multi-source query plans,
  archive/pull-rate/backtest, and the framework registration (tools + `world-analyst` bot + cockpit surface)
  are all live on `oshal-local-api`. Outlet ratings are oshal's own, observed from its stored coverage
  (2026-10-01 update at the end; the seed table and any external rating license are retired).
- **Date:** 2026-06-20
- **Related:** [ADR-058 (Personal-Intelligence Service)](058-personal-intelligence-service-and-ingestion.md)
  (the *personal* sibling — this is the deferred "world graph, its own ADR"),
  [ADR-057 (personal data schema)](057-personal-data-schema.md),
  [ADR-056 (ticketed data-access broker)](056-ticketed-data-access-broker.md),
  [ADR-045 (two-tier graph + connector)](045-two-tier-graph-database-and-connector.md),
  [ADR-049 (OSHAL as aggregation platform)](049-oshal-as-aggregation-platform.md),
  [swarm application manifests](033b-swarm-application-manifests.md).

## Context

ADR-058 split the world cleanly into **personal** (private, per-user, key-holding *service*) and
**shared world** data, and deferred the latter to "its own ADR." This is that ADR.

World data — news, market, sentiment about public entities (companies, people, topics) — is **shared,
public, and machine-fed** (feeders/cron), not per-user. So it does NOT carry the personal layer's
privacy/tenancy constraint. Its discipline is different and just as important:

> A sentiment number is meaningless without the source's **bias**. "Fox negative + CNN positive" tells
> you nothing — both are being themselves. Feeds must carry **ratings and classifications**, and the
> reader must read sentiment *through* them.

So the world layer's non-negotiables are **bias-awareness** and **provenance**, the way the personal
layer's are privacy and least-discretion.

## Decision

### 1. The rule: feeders propose, the service disposes (mirrors ADR-058)

Feeders (the news fetcher / cron / any bot) emit `WorldContribution`s. The deterministic
`WorldIntelligenceService` is the **sole writer** of the shared `world` graph tenant (ArangoDB,
`getTenantGraph('world')`), the `world_metrics` series (TimescaleDB), and the `world_items` archive.
Canonical ids `world:<type>:<key>` make upsert idempotent and resolution free. No LLM inside the writer.

### 2. Multi-source, classified, query-planned feeds

`feed-sources.ts` is a registry of free/keyless query-driven RSS feeds, each tagged with a `category`
(news/social/legal/regulatory/medical/web) so a Federal-Register hit, a Reddit post, and a news article
are weighed differently. A subject expands into a **query plan**: Google News and Bing News fan into
base + recency + one `site:<domain>` query per cross-spectrum outlet — so the bias read gets **balanced
input by construction**, not whatever the default ranking surfaces. Reddit (one community) fans by sort.

### 3. Classification on the swarm's own creds

Sentiment + entity extraction run in ONE batched Claude call via `ClaudeCodeCliProvider` (the host
OAuth the whole swarm runs on — never a placeholder API key). Lexicon fallback only if that call fails.

### 4. Bias-aware sentiment is the product, not a naive average

Every source carries an **observed lean** and an **observed reliability**, computed by oshal from its
own stored coverage (the 2026-10-01 update below; there is no hand-typed or licensed rating).
`/api/world/sentiment` returns the structure a naive average destroys: the lean axis
`lean{byLean{below,near,above},balanced,spread,consensus}`, `reliabilityWeighted`, and per-source
values, each with its rating, observation count and date range. Whether sources that usually read
below, near and above the others agree on a subject is the signal.

### 5. Record accurately: archive + pull-rate + backtest

Every pulled item is stored in `world_items` with its classification + model + `classifierVersion`,
deduped by a **per-entity** content hash (so one article counts for each subject it's relevant to). Only
NEW items hit the LLM and the series (append-only integrity). `world_pulls` records fetched vs unique vs
new per source (pull-rate). `backtest()` replays archived items through the current model and reports
sentiment drift / directional agreement / entity-extraction stability — making classification quality
measurable instead of assumed.

### 6. Registered as a framework app (not bolt-on routes)

The capability is exposed the framework way (`swarm-apps/world.yaml`): six `world_*` cli tools
(`world_sentiment/_ingest/_neighbors/_metric/_pulls/_entities`, backed by `scripts/oshal-world.js` over
the local `/api/world`, reads open + ingest token-injected), the `world-analyst` reason+tool bot, a
cockpit surface (`/api/world/app`), and route ownership. Per the build-your-own-swarm-app
"compiles-but-fails" rule, the three core-code wirings are also done: the bot is in
`swarm-bot-registry-local.ts` (inline `port:3010, container:oshal-api, claude-code`), the router is
mounted in `server.ts`, and the surface is in `config-seed/profiles/oshal-framework.json`.

## Consequences

- **Shared context any bot/Jarvis can query** — "what's the press saying about X" routes to
  `world-analyst` and returns a bias-contextualized read, not a misleading number.
- **Auditable + backtestable** — the archive keeps what we saw and what we said, with the model/version.
- **Joins the personal layer** — a personal `worldRef` resolves to a real `world:company:*` node with
  sector edges + a sentiment series (the relate-join RAG can't do).

**Risks / sharp edges:**
1. **Outlet ratings are relative to oshal's own coverage.** An observed lean says a source reads
   persistently above or below the other sources oshal pulled on the same subjects; it is not a
   political left/right rating, and reliability measures agreement with the other sources, so a
   source that is right against the crowd scores low. A rating is only as broad as the coverage
   behind it, which is why each carries its counts and dates and below the minimums shows as
   insufficient data.
2. **Classification is nondeterministic** (Claude run-to-run; backtest measured ~0.17 mean drift, ~0.84
   sign agreement) — treat a single score as noisy; trust the aggregates.
3. **Writes are token-guarded** (`WORLD_INGEST_TOKEN`); the router mounts without OIDC for machine
   feeders, so the cockpit **surface is read-only** (the browser can't hold the token). Ingest is the
   `world_ingest` tool run by the bot/Jarvis, or a future session-authed cockpit action.
4. **A source's history is keyed by its world id.** Ratings are computed on read from the stored
   facts under each source id, so `outletSourceId` must keep resolving a publisher to the same id;
   a renamed id splits that publisher's history into two sources.
5. **Entity-extraction quality gates graph value** — the world analogue of ADR-058's resolution risk.

## Reuses (no new runtime)

- Graph → ADR-045 `getTenantGraph('world')`; series → TimescaleDB (`oshal-tsdb`).
- Classification → `ClaudeCodeCliProvider` (host OAuth), the same creds every bot runs on.
- App/tool/surface registration → the swarm-app manifest framework + the `oshal-feeds.js` cli-tool pattern.
- Start-flag gating → `ENABLE_WORLD_INTELLIGENCE`.

## Deferred

- Finance-targeted query plans (`CROSS_SPECTRUM_FINANCE` is built, not yet wired to a finance topic path).
- More feed sources — GDELT (global news + tone), SEC EDGAR (filings), FRED (macro series into the join).
- Surface "ingest a new subject" via a session-authed cockpit endpoint (calls the service server-side).
- Correlation edges between world metrics and personal data (the cross-layer join).

## Update — automated refresh is deterministic (2026-06-22)

The manifest declares a framework schedule `world-refresh` (cron `0 */6 * * *`). Originally it dispatched
the saved prompt to the `world-analyst` bot via the generic orchestrator path. That never pulled: the
prompt named no subject, and `world_ingest` requires `{q, entity}` — so the bot read stale data and
summarized instead of ingesting (the `world_pulls` ledger stopped growing after the initial seed).

The refresh is now a **deterministic scheduler branch** ([src/app/world-schedule-dispatch.ts](../../src/app/world-schedule-dispatch.ts)),
mirroring the trading-autopilot pattern. On each fire it enumerates the tracked subjects
(`svc.listEntities`) and re-pulls + classifies each through the same `ingestFeeds` core the
`/api/world/ingest-news` route uses — no LLM decides whether to loop. Bounded to 30 subjects and 15
items/variant per fire; classification still runs the swarm Claude creds inside `ingestFeeds`. Wired in
[src/app/schedule-runtime.ts](../../src/app/schedule-runtime.ts) ahead of the orchestrator fallback
(`isWorldSchedule` → `dispatchWorldSchedule`). Live-verified: a forced fire repopulated `world_pulls`
across the tracked subjects.

## Update — finance coverage, intraday pulse, feature dataset (2026-06-24)

Driven by the trading swarm ([ADR-052/054](054-gravity-model.md) and
[docs/apps/trading/signal-dataset.md](../apps/trading/signal-dataset.md)): the world layer is now the **capture half**
of a self-labeling trading signal dataset. The autopilot's influence gate already read world sentiment per
ticker; the gap was thin, slow ticker coverage and no derived feature vector. All deployed + verified live on
`oshal-local-api`.

### Finance-targeted coverage (resolves the deferred "finance query plans")
- [ticker-names.ts](../../src/features/world-data/ticker-names.ts) — symbol→press-name map for the trading
  `DEFAULT_UNIVERSE`, so feeds search "Apple", not the dead-end "AAPL stock".
- [feed-sources.ts](../../src/features/world-data/feed-sources.ts) — a `finance` category + **Yahoo Finance**
  per-symbol headline RSS (`symbolUrl`), a finance query plan (`headline/earnings/analyst/corporate/catalyst/
  ticker` + recency angles), `FINANCE_FEED_IDS`, and `tickerFeedPlan(...lean?)` with a lean subset.
- [market-subjects.ts](../../src/features/world-data/market-subjects.ts) — §1 **market context** as `world:`
  entities: index/breadth (SPY/QQQ/IWM/VIX), the 11 SPDR sectors, commodities (CL/ES/GC/NG/HG), rates/FX
  (US10Y/US02Y/DXY), crypto (BTC/ETH) — so a stock signal has context (is the sector hot? is VIX spiking?).
- [news-fetcher.ts](../../src/features/world-data/news-fetcher.ts) — plan variants now fetch **concurrently**
  (bounded pool) with a per-request 12s timeout, so wider search criteria become throughput, not a slow crawl.

### Dual schedule — bounded handlers so neither starves the other
The manifest declares two framework schedules (both → `dispatchWorldSchedule`, keyed off `taskType`):
- **`ticker-pulse`** (`*/5 8-23 * * 1-5`) — the trading universe + market context. Every name gets a **lean
  3-source pull** (`PULSE_FEED_IDS`: Yahoo symbol + Google 2-day recency + Reddit-new); a **rotating slice**
  (`deepTickerSlice`, 12/fire, time-derived, no cursor) additionally gets the full finance fan-out, so deep
  breadth runs continuously while any single pulse stays short. Universe refreshed concurrently.
- **`world-refresh`** (`0 */6 * * *`) — DEPTH: macro/topics + tracked **non-ticker** subjects only (tickers are
  owned by the pulse). The 100-name blast was removed from depth so it can't hog the cycle.

Why bounded matters: `ScheduleRunner` is **single-flight** and `dispatchDueSchedules` runs handlers
**serially**, so a long handler delays everything due that cycle. Keeping both world handlers short avoids the
world side starving itself; a long external agentic schedule (e.g. a trading research task) can still delay the
pulse within a cycle — the real fix (concurrent `dispatchDueSchedules`) is a cross-cutting change tracked with
the trading swarm. Cron note: `cron-parser` fires in the **process timezone**, so the window is deliberately
wide (`8-23` weekdays), not a tight UTC market box.

### Concurrency correctness — Arango write-write retry
Concurrent ingests race on **shared** graph nodes (outlet nodes, co-mentioned entities); Arango aborts the
loser with a write-write conflict (`errorNum 1200` / HTTP 409). `WorldIntelligenceService.ingest` now wraps the
graph upserts in `withWriteConflictRetry` (jittered backoff, conflict-only). Required for any concurrent world
ingest; pulse subject-concurrency is also kept modest (3) to limit contention.

### Feature rollup — the signal vector (dataset §1/§2)
`WorldIntelligenceService.rollupFeatures(entity)` runs after every refresh (pure DB rollup of `world_items` +
the sentiment series, concurrent, TSDB-only) and writes the queryable feature vector into `world_metrics`
(`source='feature-rollup'`, 24h window vs 7d baseline): `mention_count`, `mention_velocity`, `novelty`,
`sentiment_mean` (balanced across the observed lean buckets), `sentiment_shift`, `sentiment_dispersion`,
`sentiment_consensus`, `reliability_weighted_sentiment` (observed reliability), `comention_degree`. The trading miner auto-discovers every `world_metrics`
metric, so these light up its analysis with no change on its side.

### `event_*` catalyst classifier — the kind of news (dataset §2)
The analyzer pass now also tags each item's **dominant catalyst + intensity** in the SAME batched Claude call
(no extra cost): `event_earnings/guidance/ma/rating/legal_reg/product/exec/macro/supply`. Stored on
`world_items` (`event_type`/`event_intensity`, additive guarded columns + index — `world_items` is
runtime-created, so changes use `ADD COLUMN IF NOT EXISTS`); `classifierVersion` bumped to `world-analyze-v2`;
`rollupFeatures` writes `event_<type>` (max intensity per type per window) to `world_metrics`. Makes "earnings +
positive `sentiment_shift` + high `novelty`" a queryable, testable combination. Verified live on NVDA
(items tagged product/rating/ma/earnings/…; `event_earnings 0.8`, `event_guidance 0.7`, … written).

### Division of labor with the trading swarm
World layer (this ADR) = **capture**: coverage + feature rollup + event tags. The trading swarm owns
**label & test**: `oshal-signal-label.js` writes realized forward returns to its own `trading_signal_labels`
table (NOT `world_metrics`), and `oshal-signal-mine.js` joins features→labels and reports which features predict.
Together: news features → forward-return labels → predictive verdict, accumulating hands-off. See
[docs/apps/trading/signal-dataset.md](../apps/trading/signal-dataset.md) for the full contract + status.

**Deploy note:** the image (`Dockerfile.oshal`) compiles the whole `src/` tree, so a concurrent agent's
uncommitted broken WIP can break the build — build from a clean `git worktree` at HEAD, then recreate only
`oshal-api` (`docker compose -p oshal-local -f docker-compose.oshal-local.yml up -d --no-deps --force-recreate
oshal-api`).

## Operations & tuning — the classify (deep-dive) cost

The two-tier ingest is **speed-read** (cheap, every feed, lexicon) plus **deep-dive** (metered LLM
classify: real sentiment + entities + `event_*` catalyst). Deep-dive spawns one LLM CLI subprocess
per chunk and is the only meaningful CPU cost in the world layer. Everything below is env-tunable on
`oshal-api` (no rebuild) and lives in `docker-compose.oshal-local.yml`.

### Classify provider — Codex by default, never a billed API

`WORLD_CLASSIFY_PROVIDERS` selects the backend (`codex` default, or `claude`, comma-separated to spread
across both). It must stay on a **CLI provider whose creds are already mounted** — `codex` runs on the
operator's ChatGPT plan creds (`~/.codex/auth.json`), so classify is **$0 in API billing**. Do **not**
route classify to a direct-API provider (Anthropic/OpenAI key) without an explicit cost decision — that
turns a free background job into per-token spend.

> **Codex gotcha — writable home.** Modern Codex initializes an in-process app-server that writes PATH
> aliases and refreshes its token, so `~/.codex` **must be mounted read-write**. The shared compose
> anchor `x-codex-auth-volume` is `:/root/.codex:rw`. If it regresses to `:ro`, every classify dies with
> `exited 1` / `failed to initialize ... Read-only file system (os error 30)` and silently falls back to
> lexicon (no LLM value). Codex is slower than a hosted API (~30–40 s/chunk incl. its ~11 K-token
> preamble), so the classify timeout is 120 s (`WORLD_CLASSIFY_CODEX_TIMEOUT_MS`, `news-fetcher.ts`) —
> a stale image built with the old 30 s default cuts every call off; rebuild from current source.

### Throttle knobs (highest-leverage first)

| Env | Effect | Default |
|---|---|---|
| `WORLD_CLASSIFY_BUDGET_PER_HOUR` | **The hard ceiling** — max LLM classify calls per clock hour across ALL world paths (per-subject ingest + deep-dive + backtests). Exhausted → lexicon until the window rolls. Explicit `0` = no LLM. | `60` |
| `WORLD_CLASSIFY_BUDGET_PER_DAY` | Same bucket's per-UTC-day backstop — bounds even a day of catch-up storms. | `400` |
| `WORLD_PULSE_DEEP_SLICE` | **The dominant steady-state cost** — how many names get the full classify fan-out per pulse (rotates, so all are still covered over more pulses). `0` = all-lean (minimal classify). | `2` |
| `WORLD_DEEPDIVE_BUDGET` | Max deep-dive items classified per cycle. | `3` |
| `WORLD_FIREHOSE_EVERY_N_PULSES` | Run the publisher firehose (+ its classify) every Nth pulse. | `8` |
| `WORLD_FIREHOSE_LIMIT` | Firehose feeds pulled per run. | `6` |
| `WORLD_DEEPDIVE_ENABLED` | `false` kills deep-dive entirely (world intel falls back to lexicon — zero LLM cost). | `true` |

> **`WORLD_CLASSIFY_CONCURRENCY` does NOT bound total LLM load** — it only limits per-subject chunk
> concurrency; total concurrent CLI calls = subjects × chunks via `PULSE_SUBJECT_CONCURRENCY` /
> `FEATURE_ROLLUP_CONCURRENCY` in `world-schedule-dispatch.ts`. What bounds total CALLS is the
> global classify budget above (2026-08-01, `classify-budget.ts` + `analyzeBatch`, guard
> `tests/unit/world-classify-budget.spec.ts`): every LLM classify call takes a token from one shared
> hour/day bucket, fail-closed to lexicon, denials logged once per window and counted in the pulse
> completion record (`classifyBudget` in the `world refresh complete` line). This is the guard the
> 2026-06-29 burn (27 CLI spawns/min for 9 h) proved missing. Two companion changes made each call
> cheap enough to fit the pulse window: `MAX_THINKING_TOKENS=0` on the classify spawn + a minified
> JSON instruction (measured on an in-container 8-item haiku chunk: 39.3 s / 4,277 output tokens →
> 5.1 s / 414, same classification quality — the answer was the final ~350 tokens all along).

### "oshal-api is grinding" — triage

Deep-dive is a **continuous schedule**, not a finite job; it never "finishes." Tuned (slice 2) it sits
mostly idle (<5 % CPU) with brief ~150 % bursts per cycle. If it's pinned high instead:
`docker logs oshal-local-api | grep -E 'timed out after|exited 1|batch analyze failed|Read-only file system|Schedule dispatch timed out'`.
- `Read-only file system` → the Codex home mount regressed to `:ro` (or a recreate dropped the rebuilt image).
- Repeated `timed out` + `Schedule dispatch timed out`, climbing CPU/mem → classify volume too high:
  lower `WORLD_PULSE_DEEP_SLICE` (→ 1 or 0) first, then `WORLD_DEEPDIVE_BUDGET`.
- Mem oscillating (not climbing) is the concurrent CLI processes, not a leak.

### Known follow-ups

- **Global classify-concurrency cap.** `WORLD_CLASSIFY_CONCURRENCY` only bounds per-subject chunks;
  total concurrent CLI calls = subjects × chunks via the hardcoded `PULSE_SUBJECT_CONCURRENCY` /
  `FEATURE_ROLLUP_CONCURRENCY`. Make both env-configurable and add a single global semaphore so total
  classify load has one principled knob instead of relying on `WORLD_PULSE_DEEP_SLICE` to throttle volume.
- **Classify parser robustness.** Occasional `CodexCliProvider: no agent_message in output` (Codex returns
  a shape the JSONL parser doesn't match) drops that chunk to lexicon. Low rate, non-fatal, but the parser
  in `codex-cli-provider.ts` should tolerate more output shapes (e.g. fenced/code-block JSON, reasoning-only
  turns) before falling back.
- **Pin the deployed image to a SHA.** `oshal-bot:latest` is rebuilt by multiple operators/bots, so a
  recreate can silently jump the running container to a different build. For reproducible deploys, pin
  `OSHAL_BOT_IMAGE` to a specific image digest and bump it deliberately, rather than floating on `:latest`.

## Update — oshal's own outlet ratings (2026-10-01)

Operator decision 2026-09-22: no external rating license, ever; oshal pulls public information and ranks
it itself. The hand-typed seed table in `outlet-ratings.ts` (lean, economic lean, kind and reliability per
outlet, "replace with AllSides/Ad Fontes") is deleted, and with it the political axis, the economic axis
and the outlet-kind breakdown it was the only source of. `outlet-ratings.ts` keeps outlet **identity**
(canonical id, name, domain, aliases) so a publisher's items keep landing under one id, and the fixed
cross-spectrum `site:` query lists.

**How a source is rated** (`rateOutlets` in `outlet-ratings.ts`, statistics read by
`outlet-observations.ts`). Over a trailing window of whole days of the daily sentiment head
(`world_metrics_daily`, metric `sentiment`), every subject-day that two or more sources scored is a
comparison. For each comparison the source's divergence is its mean sentiment minus the mean of the
other sources' means (leave-one-out, so a source never agrees with itself). Then:

| Field | Definition |
|---|---|
| `lean` | Mean divergence (sentiment units). Above 0: the source reads persistently more favourable than the others on the same subjects and days; below 0: more critical. |
| `leanBucket` | `above` / `below` when the mean divergence is more than 2 standard errors from 0, else `near`. |
| `reliability` | `1 − mean |divergence| / 2`, in [0, 1]: how closely the source tracks the other sources. |
| `comparisons`, `subjects`, `observations` | Compared subject-days, distinct subjects among them, and the source's sentiment points behind them. |
| `firstObserved`, `lastObserved` | First and last compared day. |
| `status` | `insufficient` (no lean, no reliability) below the minimums; `rated` otherwise. |

Defaults, overridable per deployment: `WORLD_OUTLET_RATING_WINDOW_DAYS=90`,
`WORLD_OUTLET_RATING_MIN_COMPARISONS=20`, `WORLD_OUTLET_RATING_MIN_SUBJECTS=3`; the rating set is
reused for `WORLD_OUTLET_RATING_TTL_MS` (default 30 minutes, the head's refresh interval). Every
rating set records its method id (`consensus-divergence-v1`), parameters and computation time, and
`/api/world/sentiment` returns them as `ratings` beside the per-source ratings, so a reading can be
reproduced from the stored rows. Ratings are computed on read, so nothing is stamped at ingest:
`world_items.lean`/`reliability` are written NULL, and outlet graph nodes are written with the retired
rating props set to null (an Arango UPDATE merges props, so each re-ingested outlet sheds the seeded
numbers; `POST /api/world/seed-outlets` now seeds identity only and clears the known outlets at once).

**Breakdown shape.** `lean{byLean{below,near,above},balanced,spread,consensus}`, `reliabilityWeighted`
(observed reliability), `naive`, `bySource[]` (each with `rating`), and `ratings` (method). The
top-level `balanced`/`byLean`/`spread`/`consensus` fields keep their names and now describe the lean
axis, so the feature rollup's `sentiment_mean`, `sentiment_consensus` and
`reliability_weighted_sentiment` are computed from the observed ratings. The `political`, `econ` and
`byKind` keys are no longer returned.

**Not derivable from stored data yet.** The operator's reliability definition also names how often a
source's items are contradicted or vanish. Nothing stored records either (an item missing from a later
feed pull is ordinary rotation, not a retraction), so reliability is consensus agreement only. Guards:
`tests/unit/world-outlet-ratings.spec.ts` (the pure arithmetic and minimums) and
`tests/unit/world-outlet-ratings-postgres.spec.ts` (the aggregate on TimescaleDB with a real daily head).

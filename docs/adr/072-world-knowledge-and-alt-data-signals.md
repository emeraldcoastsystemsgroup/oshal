# ADR-072 — World Knowledge: universal contribution inbound + alt-data signal collectors

- **Status:** Accepted — built + verified live on `oshal-local-api` (2026-06-24/25). Extends ADR-061
  (World-Intelligence Layer) from a news-only sensor into the shared **World Knowledge** layer the whole
  swarm reads *and writes*, plus a set of free alt-data signal collectors feeding the trading dataset.
- **Date:** 2026-06-25
- **Related:** [ADR-061 (World-Intelligence layer)](061-world-intelligence-layer.md),
  [docs/apps/trading/signal-dataset.md](../apps/trading/signal-dataset.md) (the consumer — the trading miner
  auto-discovers every `world_metrics` metric), [ADR-052/054 (trading + Gravity model)].

## Context

ADR-061 stood up the world layer as a **news** sensor (multi-source RSS → bias-aware sentiment graph +
series). Two gaps surfaced once the trading swarm started consuming it:

1. **Coverage + freshness** — per-name keyword search (O(names×terms)) was request-heavy, brushed rate
   limits, and the 6-hourly cadence was far too slow for an every-5-min trading loop.
2. **Breadth of signal** — sentiment alone is weak. The dataset needs *event* context (what's coming),
   *informed-money* flow (who's buying), and a way for **any** source — not just the news fetcher — to
   contribute knowledge into the shared graph. "World Knowledge is the world of the AI sphere": where
   everyone sends their data.

## Decision

### 1. Two-tier, fluent firehose (collect wide, classify selectively)
- **Per-name search** stays for precision; added a **firehose** path: pull each publisher RSS *once*,
  entity-tag every item, fan it to the names it mentions + a `world:market:us` bucket — **O(feeds)**, no
  per-name hammering. ~30 live endpoints (CNBC/WSJ/MarketWatch sections, Yahoo, BBC/NYT/Guardian,
  ZeroHedge, SEC 8-K + all-filings, Fed, BLS…). Fully env-configurable (`WORLD_FIREHOSE_FEEDS` replaces the
  list).
- **Speed read** (every pulse, all feeds): lexicon + cheap universe entity-match, **no LLM** — captures
  volume + attention + breaking news instantly (~420 fresh items in ~20s). Items queue `used_llm=false`.
- **Deep dive** (metered): the LLM classify runs on the freshest un-deepened items, the budget allocated
  across feeds by a learned **novelty bandit** (`firehose-meter.ts`, exploration floor). Writes the
  authoritative sentiment fact once (no double-count).
- **Isolation:** per-feed wall-clock budget, chunked classify (a slow/failed chunk loses only its items),
  per-source circuit-breaker (429/503). **Load spread over Codex + Claude** via a global round-robin cursor.
- **Cadence:** a 5-min `ticker-pulse` (trading universe + market context, lean + rotating deep slice +
  attention-metered movers) and the 6h `world-refresh` depth cycle. Both handlers bounded so the
  single-flight scheduler can't starve either (the runner is now fire-and-forget — see scheduling fixes).

### 2. World Knowledge — the universal contribution inbound
The shared world graph is now write-open to the whole swarm, not just the news fetcher:
- **`world_contribute`** tool (manifest-registered, cli → token-guarded `POST /api/world/contribute`): any
  bot/app/source pushes a `WorldContribution` — `{source, entities[], edges?, facts?}` with provenance —
  into the shared graph + series. This is "where everyone sends their data."
- Guarded by `WORLD_INGEST_TOKEN` (fail-closed when unset; dev default in compose, real secret in prod).
- Reads come back through the existing `world_sentiment/_metric/_neighbors/_entities` tools.

### 3. Forward market-events calendar (vs the reactive `event_*` tags)
`market-events.ts` writes a forward calendar to a new `world_events` table + `days_to_*` metrics:
- **Earnings** — Nasdaq earnings-calendar API (browser UA), filtered to the universe.
- **FOMC** — published decision schedule (`WORLD_FOMC_DATES`).
- **Jobs** — Employment Situation, first Friday (computed).
So the gate can stand aside into earnings and the miner can test event-proximity.

### 4. Informed-money flow signals (free, per-ticker → `world_metrics`)
Each isolated, on the 6h depth cycle; the miner auto-discovers them:
- **Congress** (`political-trades.ts`) — Quiver live congress-trading (keyless): `congress_buys/sells/net/
  sentiment/notional`. ~45-day disclosure lag (positioning, not catalyst).
- **Insider Form 4** (`insider-trades.ts`) — openinsider purchase+sale pages (direction per row):
  `insider_buys/sells/net/sentiment`. Timeliest informed tell.
- **Short interest** (`short-interest.ts`) — FINRA RegSHO daily short volume, universe-filtered:
  `short_vol_ratio/short_volume`.
- **Gov contracts** (`gov-contracts.ts`) — USAspending federal awards per company: `gov_award_notional/
  count`. The "free money from the gov" signal; first gov-contracting contributor to World Knowledge.

## Consequences

- **A shared, writable knowledge layer.** Any agent contributes durable, attributable knowledge; everyone
  reads it. The gov-contracting CRM (and future sources) feed through the same `world_contribute` inbound.
- **A rich, free feature set for trading.** News sentiment + catalyst tags + forward calendar + congress +
  insider + short + gov-awards — all per-ticker metrics the miner tests against forward returns, no key,
  no per-signal code on the consumer side.
- **Bounded cost.** Speed read is free; the LLM deep dive is metered + spread over two providers; dedup
  means steady-state only classifies genuinely-new items.

**Verified (live):** firehose ~30 endpoints / ~420 fresh per pass; deep dive alternating Codex+Claude;
calendar (NKE 6/30, banks 7/14, FOMC 7/29, jobs 7/3); congress 277 tickers, insider 133, short 98/100,
gov 63/100 ($29.4B/180d); `world_contribute` round-trip (node + fact landed).

**Risks / sharp edges:**
1. **Alt-data sources are scraped/3rd-party** (openinsider HTML, Quiver keyless, Nasdaq browser-UA): they
   can change or block. Each is isolated + circuit-broken; failures degrade, never cascade. Quiver insiders
   and a clean Congress JSON both need keys/are gone — current paths are best-available-free.
2. **FOMC dates are a hardcoded list; jobs = first-Friday** (approximation). Override / exact-source later.
3. **`WORLD_INGEST_TOKEN` dev default** — must be a real secret in prod (the contribute route mounts without
   OIDC for machine senders).
4. **Slow/positioning signals** (congress especially is lagged) — features to mine, not fast catalysts.

## Deferred / next
- **Gov-contracting CRM → World Knowledge bridge — BUILT (2026-06-25).** `crm/world_bridge.py` (in the
  gov-contracting repo) reads only non-PII tables (opportunities.agency/value, sam_notices.agency/naics/
  set_aside — never contacts/activities/tasks) and pushes federal-demand signal (agencies, NAICS demand,
  agency→NAICS edges, set-aside mix) through `world_contribute`, chunked. Verified: 50 agencies / 15 NAICS /
  386 edges / 122 facts landed. Full dockerization of the CRM *app* as a registered add-on is the larger
  follow-up (needs a pinned dependency set + PII segregation first).
- CPI/PPI/GDP release dates; SEC 13F institutional; openFDA approvals.
- Per-entity (not per-article) firehose sentiment; promote the calendar/flow collectors to their own
  cadence if the 6h depth cycle gets heavy.

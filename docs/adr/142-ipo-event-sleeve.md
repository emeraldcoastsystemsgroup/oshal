# ADR-142 — IPO event sleeve: what D6 already is, the five gates it lacks, and the paper study that must pass first

- **Status:** Proposed — design and study definition only. **No code is built against this ADR**; the shipped D6 v1 executor (`src/app/trading-event-plans.ts`, core #284) is unchanged. Acceptance = the operator ratifies the acceptance bar in D6 below with a strategy-log row.
- **Date:** 2026-09-06
- **Depends on:** [ADR-136](136-trading-surface-information-architecture-and-direct-trades.md) D6/D9 (the event playbook and the one-order-path rule), [ADR-134](134-multi-account-trading-books.md) (books, guardrails), [ADR-052](052-stock-trading-swarm.md) (no justification, no trade; paper-only by default)
- **Closes the design half of:** BACKLOG "IPO event-play design" ([BACKLOG.md](../BACKLOG.md) lines 573-575). The neighbouring "IPO playbook, Anthropic first (ADR-136 D6)" entry (lines 802-804 — the COTP reminder sequence) is a separate item and is **not** touched by this ADR.

---

## Context

### The backlog item, and what "distinct sleeve" means

The BACKLOG entry asks for two things: keep the rejected generic pop-catcher closed, and design *only* the distinct IPO-event sleeve "with data availability, allocation, halt, spread, and same-day exit constraints", done when "an ADR and replayable paper study define the event universe and risk gates, and no live order is possible before paper acceptance."

Between the entry being written and today, ADR-136 D6 v1 shipped (2026-09-04, core #284 `8197d9c7`, trading 1.7.0). This ADR therefore starts by reconciling the item against what D6 already is, file and line, instead of designing a second sleeve beside it.

### What D6 v1 already delivers (verified in `src/app/trading-event-plans.ts`)

| Sleeve property | D6 v1 as built | Where |
|---|---|---|
| **Event universe** | one issuer per plan; the ticker and IPO price come from the EDGAR 424B4 pricing prospectus (`efts.sec.gov` full-text search, forms `S-1,F-1,424B4,424B1`) or are operator-supplied | lines 48, 301, 324-328 (`parsePricingProspectus`), 374-393 (`stepWatching`) |
| **Entry** | no market-on-open; a **day LIMIT at IPO × (1 + maxPremiumPct)** placed on the first fresh regular-session print | 396-402 (`stepPriced`), 405-424 (`stepListed`), line 413 |
| **Allocation** | `sizePctOfEquity` (clamped 0.5-100, default 10) **or** `notionalUsd`; capped by the fleet guardrail `TRADING_MAX_NOTIONAL_USD` | 98-99, 415-417 |
| **Exits** | take-profit SELL LIMIT GTC at IPO × (1 + tp); STOP SELL GTC at IPO × (1 − sl); the sibling is cancelled on a fill; a time stop (`timeStopDays`, clamped **1**-365) sells at market in a regular session | 453-464 (`stepFilled`), 467-489 (`stepExitsPlaced`), 101 |
| **One order path** | every order is an `event-playbook` decision through `placeDecisionOrder` (guardrails, live gate, reservation arbiter) | 421-422, 458-460, 484, 493-505 (`mintDecision`); `trading-engine.ts` 387-425 |
| **Executor gate** | the per-user `trading-events:<sub>` leg steps plans every 5 minutes on ET weekdays (v1 at HEAD: cron `*/5 9-16 * * 1-5`, 09:00-16:55; the in-flight ADR-136 D4 follow-up — SEQ 3 in the working tree — makes the leg fire every minute 07:00-19:59 via `TRADING_EVENTS_CRON` and steps plans on `TRADING_EVENTS_FULL_TICK_MINUTES=5` full ticks, so the **plan cadence stays 5 minutes** either way) and refuses to act unless `TRADING_EVENT_PLANS=true` | HEAD 44, 51, 515-518 |
| **Arming gate** | arming is 428 confirm-gated in the store route | `oshal-applications/trading/src-routes/trading-event-plan-routes.ts` 258-265 |
| **Evidence** | a real-Postgres spec drives armed → priced → listed → entry → fill → exits → close with a fake venue, asserting the `event-playbook` decision row and its book | `tests/unit/trading-event-plans.spec.ts` 92-160 |

That is the skeleton of the sleeve the backlog item describes: a single-issuer event universe fixed by a filing, a sized limit entry, bracketed exits, one accountable order path, paper-first.

### What D6 v1 does NOT have — the five named constraints, with evidence of absence

1. **Data availability (opening window).** `stepPriced` (396-402) marks the plan `listed` and calls `stepListed` on the **very first** non-stale print of a regular session. Two facts about that print, measured 2026-09-06 against the Alpaca data API with the repo's paper key (`ALPACA_PAPER_*`, historical consolidated tape `feed=sip`, 1-minute bars):
   - **IPO first prints arrive late in the session** — the opening auction, not 09:30. First SIP bar: ARM 2023-09-14 **16:08Z (12:08 ET)**; RDDT 2024-03-21 **17:15Z (13:15 ET)**; CRWV 2025-03-28 **17:14Z (13:14 ET)**. The executor's 5-minute plan cadence therefore detects listing up to 5 minutes after the first print, hours into the day, and enters into the thinnest, most volatile minutes of the issue's life.
   - **The paper book prices off IEX, a venue-only feed.** `defaultDeps().latestTrade` (295) resolves through `getMarketData(book.kind)`; for the paper book that is `market-data.ts` `latestTrade` = `/stocks/{sym}/trades/latest?feed=iex` (line 475). In ARM's first minute the IEX bar carried **21,520** shares against **13,926,962** on the consolidated tape (≈0.15%; RDDT 38,825 vs 4,188,098; CRWV 22,820 vs 4,981,266). Bar counts depend on the window, so both are stated: over the full day (`08:00Z-23:59Z`) SIP/IEX 1-minute bars were ARM **472/238**, RDDT **393/164**, CRWV **362/168**; over the regular session only (`13:30Z-20:00Z`) ARM 233/233, RDDT 166/164, CRWV 167/165 — the venue tape thins out mostly in the extended hours, and in regular hours it is thin in *size*, not in minutes. The live (Schwab) book reads the consolidated `lastPrice` (`schwab-market-data.ts` 140-150). So the two books see *different* first prints on the same listing, and the paper book's is the thinner one. (Recent SIP is not on this key: `quotes/latest?feed=sip` → HTTP 403 "subscription does not permit querying recent SIP data", same probe.)
2. **Allocation cap.** The only ceiling is the fleet guardrail (`TRADING_MAX_NOTIONAL_USD`, compose default 1000 at `docker-compose.oshal-local.yml` HEAD line 488 — 498 in the working tree, shifted by a sibling item; the operator box runs 50000 per ADR-136 line 27). `sizePctOfEquity` clamps to **100** (line 98) and sizing reads **`equity`**, not cash (415; `EventBroker.getAccount` returns `{ equity }` only, 274). The dry run *tells* the operator "a cash (IRA) account cannot buy on margin" (264) but nothing enforces it.
3. **Halt handling.** Nothing. No halt flag reaches the kernel from either vendor: Alpaca `trades/latest` yields `p`/`t` only (475-480); the Schwab twin reads `lastPrice`/`tradeTime`/`quoteTime` (142-149). A grep of the repo for `securityStatus|bidPrice|askPrice` returns nothing — a Schwab halt/status field has never been observed in this codebase and must not be assumed. The one adjacent mechanism is the stale-print rule (`isTickStale`, `market-data.ts` 64-67, `TRADING_EXT_QUOTE_MAX_AGE_SEC` default 120 s), applied at `latestTrade` (295) — it refuses to *detect listing* off an old print but is never re-checked at entry time or during exits. A post-halt reopen gap can fill the GTC STOP below its price; that is how a stop order works and is stated, not solved, here.
4. **Spread guard.** There is no bid/ask anywhere in the kernel market-data rail: `MarketDataSource` exposes `latestPrice`, `latestTrade`, `dailyCloses`, `closesForTimeframe`, `barsBatch` (`market-data-source.ts` 30-45) and nothing else. Two separate facts, which this ADR keeps apart:
   - **Not available in real time on the paper book.** IEX `quotes/latest` for FIG after the 2026-09-04 close returned `bp: 22.88, ap: 0` — a one-sided venue book; consolidated recent quotes (`quotes/latest?feed=sip`) are HTTP 403 on this key. A live spread gate on the paper book would therefore read a single-venue, often one-sided quote; on the Schwab book the quote fields are unverified (item 3).
   - **Replayable against the past.** The historical consolidated NBBO **is** on this key. (The first draft of this ADR recorded "historical quotes `null` on both feeds"; that probe used a timestamp without seconds — `start=2023-09-14T16:00Z` — which Alpaca rejects with HTTP 400 "Invalid format for parameter start … as RFC3339", and the missing `quotes` key was misread as `null`. Re-probed 2026-09-06 with RFC3339 timestamps.) `/stocks/ARM/quotes?start=2023-09-14T16:08:00Z&end=2023-09-14T16:09:00Z&feed=sip` → 200, **1,166** quotes in ARM's first minute, **1,165** two-sided; RDDT `2024-03-21T17:15:00Z`+1 min → 1,918 / 1,917; CRWV `2025-03-28T17:14:00Z`+1 min → 1,022 / 1,021. `feed=iex` for the same ARM minute → 164 quotes, 155 two-sided, but a single-venue book with placeholder width at the open (first two-sided IEX quote `bp 0.9999 / ap 500.01`; first two-sided SIP quote `bp 54.5 / ap 71`, tightening to `55.68 / 55.79` by 16:10Z). So a spread rule **can** be replayed on the SIP quote stream (D5), and the IEX quote stream can be measured beside it; what cannot be done today is enforce it live on the paper book.
5. **Same-day exit.** `timeStopDays` clamps to a minimum of **1** (101) and the time-stop branch (481-487) compares whole days; there is no "flat by the close" path.

**And the done-when's "no live order is possible before paper acceptance" is false today.** `defaultDeps().place` calls `placeDecisionOrder(..., confirm = true)` (296). With `TRADING_EVENT_PLANS=true` and `TRADING_LIVE_ENABLED=true` (`broker-provider.ts` 89-90; `trading-engine.ts` 410-412 — 410 the condition, 411 the `live_blocked` throw), an armed plan on a live book places real orders the moment the issuer lists; the only human gate is the 428 at arm time, days or weeks earlier. `tickEventPlans` (349) merely *waits* while the live flag is off. The event-playbook agent is also on the operator-authored list that may buy a **disabled** (view-only) book (`trading-engine.ts` 406 the `operatorAuthored` list, 408 the `book_disabled` throw it bypasses) — by design for D6, but it means "Stop trading" on the account is not a wall either.

### The generic pop-catcher, and why it stays closed

`TRADING_POP_CATCHER` (default `false`) is read per fire by `popCatcherConfig()` — at HEAD in `src/app/trading-schedule-dispatch.ts` (comment 464-470, function 471-476, consumed by the `pop.enabled && book.enabled` branch at 1318-1319); the sibling dispatch-decomposition item in flight moves it, unchanged, to the untracked `src/app/trading-dispatch-exits-entries.ts` (`popCatcherConfig` 47, `placePopCatches` 223) — cite whichever has landed when this ADR is next touched. Compose passes it through as `${TRADING_POP_CATCHER:-false}` (`docker-compose.oshal-local.yml` HEAD 532, working tree 542). Its record:

- strategy-log **2026-07-10 sweep #4 → REJECT** (lines 90-104): "the entry signal has no discrimination — ~40 names qualify per 5-min step (21.9K signals/wk)"; `TRADING_POP_CATCHER` stays false.
- backtest-regression-suite verdict table **row #4 — REJECT** (line 63), with the note that it ran on IEX 5-minute bars, which is "directionally safe (reject), do not reuse numbers".
- active-strategy.md line 32 pins the knob at `false` with the sweep #4 citation.
- strategy-log **2026-07-14** (380-386): "the event-pop family is now closed by five independent measurements … Do not reopen without a genuinely new information source."

The IPO sleeve is **not** a reopening of that family, for the reason the same log entry gives (391-393): the surviving path is the *scheduled* event — "known in advance, no latency race". An IPO is the purest scheduled event there is: the universe is one name, fixed by a public filing days ahead; nothing is detected from the tape; there is no market-wide surge scan. The pop-catcher is a price-only, market-wide, latency-racing detector and remains off. This ADR adds no code path that reads `TRADING_POP_CATCHER` or `isShortTermPop`.

### Kernel placement (why the gates cannot live in the store package)

Market data, broker adapters and the trading engine stay in the framework — the store README states it under "What stays in the OSHAL framework (ADR-093)" (`oshal-applications/trading/README.md` 209-214), and ADR-136 D6 (107-109) records that the event-plan state machine is `src/app/trading-event-plans.ts` in core, with D9 (131-133) fixing that new entry points add no second execution rail. A gate that must run before `deps.place`, and a hold that must be unreachable by any route, therefore belong in core; the store surface can only display them. (ADR-136 D8, lines 127-129, names the dated-order module and the D5 watcher; it is not the placement authority for D6 and is not cited as such.)

---

## Decision

### D1. Verdict: (b) — a narrow addition on top of the shipped D6, not a second sleeve and not "done"

D6 v1 **is** the IPO event sleeve's skeleton (universe, entry, allocation knobs, exits, one order path, paper-first flag). The distinct work is exactly the five constraints above plus the live hold, each as an *optional* knob whose default reproduces today's behaviour byte-for-byte for every stored plan row. Option (a) "already delivered" is refuted by the done-when being false today (live orders are possible); option (c) "not worth building" is refuted by the Anthropic plan being armed for real money on this executor. The generic pop-catcher stays closed (Context, above); nothing here re-enables it.

### D2. The event universe

One plan = one issuer with an EDGAR pricing prospectus (424B4/424B1) from which the ticker and IPO price are parsed by the shipped `parsePricingProspectus`, or operator-supplied. The universe is never derived from the tape, a screener, a news wire, or a surge. This is D6 v1 unchanged and is restated here so the sleeve has a definition independent of the Anthropic brief.

### D3. The gates (kernel, `src/app/trading-event-plans.ts` + one new pure module), all default-off or default-equal-to-today

| Gate | Knob (plan `params`) | Env default (config → env → default) | Behaviour when it fires |
|---|---|---|---|
| **Opening window** (data availability) | `openingWindowMinutes` 0-120 | `TRADING_EVENT_IPO_OPEN_WINDOW_MIN=0` (= today: enter on the first print) | `stepListed` records `gate:opening_window` with minutes remaining and returns; the entry deadline clock (`entryDeadlineDays`) keeps running from `listedAt` |
| **Stale/halt proxy** | none (always on) | reuses `TRADING_EXT_QUOTE_MAX_AGE_SEC` (default 120 s) | at **entry time** — not only at listing detection — a missing or stale print records `gate:halted_or_stale` and returns. A **proxy**: no venue halt flag exists in the rail (Context, item 3); the ADR does not claim halt *detection* |
| **Spread cap** | `maxSpreadPct` 0-10 | `TRADING_EVENT_IPO_MAX_SPREAD_PCT=0` (**disabled**) | requires a `latestQuote(bid, ask, asOf)` on `MarketDataSource` that does not exist yet. The gate **is replayable** on historical SIP quotes (Context item 4; D5 puts it in the grid) — what is missing is a **real-time** consolidated quote for the paper book (recent SIP is 403 on the key; IEX top-of-book is single-venue and routinely one-sided) and a verified Schwab quote payload for the live book. So it ships disabled and **stays disabled in production until the "Market-data stream decision" BACKLOG item (577-579) names a real-time consolidated quote source**, even if the study says a cap helps; the study result then sets the default the flip adopts. An absent or one-sided quote (`ap: 0`) is "no quote", never a refusal. The plan's earlier 1.0% default is withdrawn: with IEX top-of-book it would refuse entries a consolidated book would allow |
| **Sleeve ceiling** (allocation) | `sizePctOfEquity` upper clamp | `TRADING_EVENT_IPO_MAX_PCT_EQUITY=100` (= today's clamp) | the operator lowers it (10 for the "401k 10% plan") as a **config action with a strategy-log row**, never a code default — a code default of 10 would silently shrink stored plans on their next normalize and contradict "byte-identical" |
| **Cash cap** (allocation) | none | consumes the settled-cash fields the "cash accounts trade like margin accounts" item (BACKLOG 818-820, ADR-134 D8 work in flight) adds to `BrokerAccount` | sizing takes `min(equity × pct, notional, settledCash)` and records `cappedBy`. **Sequenced after that item lands** — no parallel cash model is built here; until then the dry run's manual step (264) remains the only cash guidance |
| **Same-day exit** | `exitByClose` boolean | `TRADING_EVENT_IPO_CLOSE_EXIT_ET=15:50` | on the fill's ET day at/after the wall-clock, in a regular session: cancel both exits, market SELL, `result.reason = 'close_exit'`. Default `false` (the Anthropic brief is +10 % / −10 % / 30 days and keeps that) |

Every gate refusal is written to the plan timeline (`gate:<reason>` + detail) **and** to the existing per-day evidence store `oshal_trading_gate_blocks` (`src/app/trading-gate-block-store.ts`) under gate `ipo-<reason>`, so the paper period produces countable evidence, not log lines. `dryRunEventPlan` states each active gate in words in its `assumptions`.

Fleet guardrails are unchanged and still bind downstream: `TRADING_MAX_NOTIONAL_USD` and `TRADING_MAX_QTY` are enforced in `placeDecisionOrder` regardless of any knob here.

### D4. The live hold — the paper-acceptance wall

New flag **`TRADING_EVENT_PLANS_LIVE`** (default `false`, read per tick, config → env → default). While it is false, a plan on a **live** book in an **entry-placing status** (`priced`, `listed`) records one `live_hold` timeline event (not repeated every fire) and does not reach `deps.place`. This makes the BACKLOG done-when true: with the flag absent, no live entry order is possible, regardless of arm state, `TRADING_LIVE_ENABLED`, or book enablement.

**Scope rule (the critique's correction, adopted):** the hold blocks **new risk only**. A live plan already at `entry_placed`, `filled` or `exits_placed` continues to be managed — entry polling, exit placement after a fill, sibling cancel, time stop, close exit — whatever the flag says. Freezing those steps would leave a filled position with no exits or a filled TP with a live STOP still working (the "BOTH exits filled — position may be short" path at 471). Flipping the flag off is therefore always safe; it never orphans a position. This is pinned by a real-DB spec case in both directions (D7).

Three flags now sit on one leg; their exact scopes, to be copied into `active-strategy.md` and `.env.example` when the code lands:

| Flag | Scope |
|---|---|
| `TRADING_EVENT_PLANS` | whether the `trading-events:<sub>` leg acts at all (plans, pinned lots, dated orders) — paper and live |
| `TRADING_LIVE_ENABLED` | whether **any** live-book order may be placed by anyone (`placeDecisionOrder`, `trading-engine.ts` 410-412) |
| `TRADING_EVENT_PLANS_LIVE` | whether an event plan may place a **new entry** on a live book — the paper-acceptance wall of this ADR |

### D5. The replayable paper study

**Script (to be built):** `scripts/oshal-trading-ipo-event-study.ts`, following the suite conventions (`RESULT {json}` last line; blind-forward; a cache env so sweeps fetch once; pre-registered in the strategy log before it runs — `backtest-regression-suite.md` 71-78).

**Fixture** — `ticker, issuer, pricingFileDate[, ipoPrice]`, where `pricingFileDate` is the 424B4/424B1 `file_date` from the same EDGAR full-text endpoint the executor uses. Looked up 2026-09-06 (`efts.sec.gov/LATEST/search-index?q="<issuer>"&forms=424B4`; the registrant name in `display_names` matched the issuer):

| Ticker | Issuer (EDGAR display name) | 424B4 file_date | Ticker | Issuer | 424B4 file_date |
|---|---|---|---|---|---|
| NXT | Nextracker Inc. | 2023-02-10 | LOAR | Loar Holdings Inc. | 2024-04-26 |
| KVUE | Kenvue Inc. | 2023-05-04 | VIK | Viking Holdings Ltd | 2024-05-02 |
| CAVA | CAVA Group, Inc. | 2023-06-16 | WAY | Waystar Holding Corp. | 2024-06-07 |
| ODD | Oddity Tech Ltd | 2023-07-20 | TEM | Tempus AI, Inc. | 2024-06-17 |
| CART | Maplebear Inc. | 2023-09-20 | LINE | Lineage, Inc. | 2024-07-26 |
| KVYO | Klaviyo, Inc. | 2023-09-20 | TTAN | ServiceTitan, Inc. | 2024-12-12 |
| BIRK | Birkenstock Holding plc | 2023-10-12 | VG | Venture Global, Inc. | 2025-01-24 |
| BTSG | BrightSpring Health Services, Inc. | 2024-01-26 | CRWV | CoreWeave, Inc. | 2025-03-31 |
| AS | Amer Sports, Inc. | 2024-02-02 | ETOR | eToro Group Ltd. | 2025-05-15 |
| RDDT | Reddit, Inc. | 2024-03-21 | HNGE | Hinge Health, Inc. | 2025-05-23 |
| ALAB | Astera Labs, Inc. | 2024-03-21 | CRCL | Circle Internet Group, Inc. | 2025-06-05 |
| ULS | UL Solutions Inc. | 2024-04-15 | CHYM | Chime Financial, Inc. | 2025-06-12 |
| IBTA | Ibotta, Inc. | 2024-04-18 | FIG | Figma, Inc. | 2025-07-31 |
| RBRK | Rubrik, Inc. | 2024-04-26 | BLSH | Bullish | 2025-08-13 |
| | | | KLAR | Klarna Group plc | 2025-09-10 |
| | | | GEMI | Gemini Space Station, Inc. | 2025-09-15 |
| | | | VIA | Via Transportation, Inc. | 2025-09-15 |
| | | | STUB | StubHub Holdings, Inc. | 2025-09-17 |
| | | | NTSK | Netskope Inc | 2025-09-18 |

ARM (Arm Holdings plc) is in the fixture too — its first SIP bar is verified at 2023-09-14 16:08Z — but the name search matched a different registrant, so its 424B4 row is resolved by CIK before the run. Firefly Aerospace returned an EDGAR 500 and is retried at run time. Any issuer whose 424B4 the shipped `parsePricingProspectus` cannot price is reported as `unparsed`, never hand-filled — an unparsed row is a finding about the parser the executor relies on.

**Listing day is derived from the tape, not typed.** The 424B4 `file_date` can trail the first trade (CRWV: filed 2025-03-31, first SIP bar 2025-03-28) or lead it. `listDate` = the first session in `[file_date − 3 sessions, file_date + 3 sessions]` with a 1-minute SIP bar for the ticker; a row with none is `no_tape` and excluded, counted.

**Data and what "free" means here.** The paper key carries the **historical** consolidated tape (`feed=sip`; strategy-log 2026-07-12, line 163; re-confirmed by the 2026-09-06 probe over the full-day window `08:00Z-23:59Z`: 472 one-minute SIP bars for ARM's first day, 393 for RDDT, 362 for CRWV; regular session `13:30Z-20:00Z` only: 233 / 166 / 167) but **not** recent SIP (403). The IEX feed does serve intraday 1-minute bars on the same key (full day 238 / 164 / 168; regular session 233 / 164 / 165) — so "free IEX bars are end-of-day" is not accurate as a statement about *bars*; what is end-of-day-only in this platform is the daily-bar consumers (e.g. the movers report, BACKLOG 815). The consequence for a day-one study is different and sharper: **on daily bars a listing day is one o/h/l/c bar, on which a limit entry, an intraday stop and a same-day exit cannot be placed — a day-one study is impossible on daily bars and must run on 1-minute SIP bars.** No kernel fetcher can do that today: `Timeframe` has no `1Min` (`market-data.ts:34`), `barsBatchOhlcv` is now-relative (194-196), and both `barsBatchSince*` hard-code `timeframe=1Day` (246, 289). The pop harness's `fetchBars` (`scripts/oshal-trading-pop-backtest.ts` 57-80) does not do it either: its signature is `(symbols, timeframe, lookbackDays)`, `start`/`end` are computed from `Date.now()` (59-60) and `feed=iex` is hard-coded in the URL (66). The study therefore adds a **genuinely new** dated fetch — `(symbol, timeframe, start, end, feed)` — reusing only that function's pagination loop shape (`limit=10000`, `next_page_token`, 61-76): 1-minute bars for the listing day with `feed=sip`, the `/stocks/{sym}/quotes` stream for the same day with `feed=sip` (Context item 4 — the spread replay input), 1-day SIP bars for the multi-day exits, all cached under `IPO_DATA_CACHE=<dir>` so sweeps fetch once. It also fetches the same day's bars and quotes on `feed=iex` and replays **both**, because the paper book will trade the IEX tape — the fill-rate and first-print-time gap between the two feeds *is* the data-availability constraint, measured rather than assumed.

**Replay rules (blind-forward, `backtest-regression-suite.md` rule 1):** the plan is `priced` before the open; `listed` at the first bar; gates evaluated per bar exactly as production evaluates them per fire, using the *same* pure gate functions the executor will call (the study imports them; it does not re-implement them). The day LIMIT fills at the first bar after the gate opens whose low ≤ limit, at the limit price (conservative — never the bar's open when it is better). TP fills when a later bar's high ≥ tp, at tp; the STOP fills when a bar's low ≤ stop, at `min(stop, bar open)` (a gap through the stop fills below it, as a real GTC STOP does); both in one bar → stop first (pessimistic). `exitByClose` fills at the close of the bar at the exit time; the time stop fills at the daily close `timeStopDays` sessions later. Slippage 0.1 %/side on every fill (the pop harness's `SLIP`, line 39) — an **assumption**, stated in the RESULT. A halt is a **proxy**: an in-session gap of ≥ `IPO_HALT_GAP_MIN` minutes (default 5) between consecutive bars, counted and reported; a fill is never assumed inside a gap.

**Sweep grid** (CLI args / env, defaults stated in RESULT — nothing hard-coded): `openingWindowMinutes ∈ {0, 15, 30, 60}`, `maxPremiumPct ∈ {5, 10, 20}`, `takeProfitPct = 10`, `stopLossPct = 10`, `exitByClose ∈ {off, on}`; the off case runs `timeStopDays = 30`. **The spread gate is in the grid on the SIP replay only:** `maxSpreadPct ∈ {0, 1, 2}`, where the spread at a bar is `(ask − bid) / bid` of the last two-sided SIP quote at or before that bar's open (a one-sided or absent quote is "no quote" → the gate passes, exactly as D3 specifies for production). The IEX replay runs with `maxSpreadPct = 0` and **reports** the IEX spread distribution at the same instants as a measurement — the IEX book is single-venue and one-sided at the open (Context item 4), so a gate on it would measure the venue, not the issue. The RESULT labels this `spread: replayed_sip_only`.

**Metrics per cell:** plans replayed; fill rate (SIP and IEX); `missed` (no bar ever touched the limit); first-print time distribution (ET); minutes from first print to fill; SIP spread at the first print and at the fill (median, p90) with the IEX spread beside it; bars refused by `gate:spread` per cell; P&L per plan in % of the IPO price (mean, median, worst, share positive); exit-reason mix; halt-gap count; and the two benchmarks every cell is judged against — **first-print market buy** with the same exits (the thing D6 refuses to do) and **no trade** (0).

**Holdout (pre-registered here):** design on rows with `file_date < 2025-01-01`; report the `≥ 2025-01-01` rows separately as the clean period the design never saw (rule 2). Knobs are chosen on the design set only.

### D6. The acceptance bar — what must be true before `TRADING_EVENT_PLANS_LIVE` may be `true`

1. The study has run and its RESULT row is in `docs/apps/trading/strategy-log.md`, with `n ≥ 20` listing days replayed across design + holdout and the IEX replay reported beside the SIP one.
2. The chosen knobs beat the first-print benchmark after slippage on the design set **and** are ≥ 0 on the holdout; a cell that wins only on the design set is luck (suite rule 5) and does not qualify.
3. Zero replayed plans end in an unmanaged state (a fill with no exit by the horizon) — a state-machine completeness check, not a return metric.
4. At least **one real paper plan** has closed end-to-end on a real listing on the paper book with the new gates recorded on its timeline and its `oshal_trading_gate_blocks` rows present.
5. The flip is an operator config action (compose env) with a strategy-log row citing 1-4 — never a code default — and `TRADING_LIVE_ENABLED`, the arm-time 428, book enablement and the fleet guardrails all still apply afterwards.

**This bar deliberately departs from the standing new-sleeve arming bar** (active-strategy.md 64-65 / suite 76-77: ≥ 4 paper weeks incl. a non-bull week, ≥ 200 trades, ≥ 0.4 %/trade gross). A sleeve that trades one name on one day per listing cannot produce 200 trades in any honest window; applying that bar would either forbid the sleeve forever or invite gaming it with tiny plans. The substitute above is stated as an **operator decision to ratify** in the pre-registration row — until ratified, the standing bar governs and the flag stays false.

### D7. Guards that ship with the code (when built — not part of this ADR's delivery)

- `tests/unit/trading-event-gates.spec.ts` (pure): each gate's `ok/false` reason; `maxSpreadPct = 0` disables; an undefined/one-sided quote is "no quote", not a refusal; `sizeIpoEntry` caps by notional guardrail, `TRADING_MAX_QTY`, the sleeve ceiling and settled cash, each with the right `cappedBy` label; `sameDayExitDue` true only on the fill's ET day at/after the wall-clock.
- `tests/unit/trading-event-plans.spec.ts` (extended, real Postgres, `--no-file-parallelism`): **live hold** — a `legacyBook(SUB,'live')` plan at `priced`, session regular, flag unset → status unchanged, `live_hold` on the timeline once, the fake `place` never called, zero `event-playbook` decisions for that book; flag `true` → the same tick reaches `place`. **Hold scope** — a live plan at `exits_placed` with the flag off and a TP fill → the STOP is still cancelled and the plan closes (the flag must never orphan a position). **Gates** — a stale tick at entry → `gate:halted_or_stale` + an `ipo-halted_or_stale` row in `oshal_trading_gate_blocks`; `exitByClose` at 15:50 ET same day → both exits cancelled and a real market SELL decision row with `close` in its rationale. `EventPlanDeps` gains `latestQuote?` as **optional** so every existing spec literal that builds it keeps compiling. The set of such literals is whatever `grep -l "latestTrade:" tests/unit/*.spec.ts` returns on the day the code lands — not a number typed here: on 2026-09-06 it was five tracked files at HEAD (`trading-event-plans`, `trading-dated-orders`, `trading-pinned-lots`, `trading-duplicate-submission`, `trading-sizing-venue`) plus three more in the working tree from sibling items (`trading-dispatch-golden-plan`, `trading-settlement`, `trading-event-reminders`), and it will have moved again by then.
- A real-boundary audit row for any vendor quote parse, recording the payload shape actually observed — the Schwab quote fields are **unverified** today and are not written into code from memory.

### D8. What is explicitly not decided or built here

- No change to the Anthropic plan's knobs (+10 % / −10 % / 30 days, `exitByClose` off).
- No consolidated real-time quote purchase; the spread gate waits on the market-data stream decision.
- No halt *detection* claim; the proxy is named as such everywhere it is reported.
- The COTP reminder sequence (BACKLOG 802-804) — a separate item.
- Store surface work (the live-hold pill, the three knobs in the Studio prompt, and the prerequisite move of the event-playbook section out of `tools/ui/view-strategies.js`, which is past the 800-code-line threshold) — sequenced after the core lands, owned by the store item.

---

## Consequences

**Gained.** The backlog item's done-when becomes true in code rather than by convention: with `TRADING_EVENT_PLANS_LIVE` absent, no event plan can open a live position. The sleeve has a definition (D2), five named gates with defaults equal to today (D3), a study whose fixture, data, mechanics, holdout and metrics are fixed before it runs (D5), and an acceptance bar written down before anyone has a number to argue for (D6). The pop-catcher's closure gets one more citation and no new code path.

**Costs and risks.**
- The paper book and the live book see different tapes on listing day (IEX vs consolidated); the study measures the gap, but a paper acceptance on IEX is weaker evidence for a Schwab live plan than a same-feed study would be. The RESULT must say which feed each number came from.
- The halt proxy is a print-gap heuristic; a post-halt reopen can fill the GTC STOP well below its price. Unchanged from D6 v1, now stated.
- The spread gate ships disabled in production even though the study can replay it on historical SIP quotes: the paper book has no real-time consolidated quote (recent SIP 403; IEX single-venue, one-sided) and the Schwab quote payload is unverified. Enabling it live needs a real-time quote source, a live-payload audit row and its own strategy-log row — the study can only say what cap *would have* helped, not supply the quote to enforce it.
- Three flags on one leg is one more than is comfortable; the scope table in D4 is the mitigation, and it must appear in `active-strategy.md` and `.env.example` when the code lands (`.env.example` currently documents `TRADING_LIVE_ENABLED` at line 332 and no `TRADING_EVENT_*` flag at all).
- The acceptance bar in D6 is smaller than the house arming bar and says so; if the operator does not ratify the substitute, the sleeve stays paper-only indefinitely, which is the correct default.
- The cash cap depends on another item landing first; until then a CASH IRA plan can still be sized past settled cash and rejected at the venue rather than refused here.

## Status / open items

Proposed 2026-09-06. Nothing in core or the store is changed by this ADR. Next steps, in order: pre-register the study (strategy-log row citing D5/D6) → build the gates + hold + study script with the D7 guards → run the study, append the RESULT row → arm one paper plan on the next real listing → operator ratifies D6 and flips `TRADING_EVENT_PLANS_LIVE` by config. The BACKLOG "IPO event-play design" entry narrows to that sequence.

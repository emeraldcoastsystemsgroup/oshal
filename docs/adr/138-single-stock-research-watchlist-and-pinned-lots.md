# ADR-138: Single-Stock Research, Watchlist, and Pinned Lots

- **Status:** Accepted (operator direction 2026-09-04; D1-D5 shipped 2026-09-04)
- **Date:** 2026-09-04
- **Depends on:** ADR-052 (no justification, no trade), ADR-134 (multi-account trading books — the book a manual purchase and a lot are scoped to), ADR-136 (trading surface information architecture and direct trades — the Research top-level view this ADR fills in, and the `POST /api/trading/decisions/manual` path a pinned purchase rides)

---

## Context

ADR-136 gave the trading surface (store package `intelligent-trades`, `oshal-applications/trading`) a Research top-level view and a direct-trade ticket, but Research was still a placeholder and the ticket had no concept of "buy this and protect it, then leave it alone." The operator wanted both closed in the same pass: research a single stock on one screen, keep a watchlist, buy quickly with a limit/account/session choice and floor/ceiling exits — and, the architectural piece, make a manually purchased position immune to the autopilot.

The autopilot does not account per share today. Every fire of the kernel dispatcher (`src/app/trading-schedule-dispatch.ts`, ~1500 lines) reads the broker's positions for the book and treats every share of a symbol as fungible: rotation sells a whole position that falls off the leaderboard (`qty: p.qty`), protective exits (stops, trailing stops, breakdown exits) size from the broker-reported position, and capacity counts positions. The only "untouchable" concept that exists is symbol-level — a core hold declared `SYMBOL:0` is exempt from sleeve sells and never bought — there is no per-lot equivalent. That means a manual purchase of a name the autopilot also trades would be sold by rotation or stopped out by the autopilot's own policy the next time it fires, and a manual purchase of a name the autopilot does not otherwise trade would still be swept by protective exits, which act on any open position in the book. `freeStaleSells` additionally cancels working sell orders for any symbol the fire is exiting, which would cancel a manual position's own protective orders if they happened to share a symbol.

Operator direction (2026-09-04, verbatim intent): buy one stock and keep a watchlist; when researching a single stock, show the articles, the 10-K and other reports, the earnings schedule, major events, and the price bars on one screen; buy a stock into the portfolio quickly and easily with the limit, the account, pre/post-market, and buy/sell floors and ceilings; and — the architectural ask — when a stock is manually purchased the shares become immutable from the autotrading and only follow the buy/sell rules set during the purchase (sell for profit at this price, sell at loss at this price, trailing stop); the single purchase config covers those specific shares while the rest of the portfolio trades on the autopilot's configured rules.

**Rails already in place, verified in code, that this ADR builds on rather than replaces:**

- Quotes and OHLCV bars are already served per book (Alpaca/Schwab), the same feed the D1 chart route in ADR-136 uses.
- `recentNews(symbols, sinceMinutes, limit)` pulls the Alpaca news API — headline, source, url, time.
- `fundamentalsSummary` (SEC EDGAR, keyless, `src/features/trading/services/fundamentals.ts`) computes revenue YoY and net margin from XBRL companyconcept data, off the same ticker→CIK map ADR-136 D5/D6 already rely on.
- EDGAR's `submissions/CIK##########.json` lists every filing with form type, date, items, and primary document — 10-K/10-Q/8-K, with 8-K `items` coded to material-event categories (`2.02` results of operations, `1.01` material agreement, `5.02` officer/director change, `8.01` other events, and the rest of the standard set).
- The ingested world calendar carries `days_to_earnings` per symbol (the same field the earnings blackout gate reads).
- Every order — autopilot or manual — passes the single engine order path (`placeDecisionOrder`): guardrails, live gate, reservation arbiter, and disabled-book BUY refusal apply with no exception. Manual decisions already carry `agent_id = 'operator'` (ADR-136 D3).
- The Schwab adapter supports `market`/`limit`/`stop`/`stop_limit`/`trailing_stop`, `day`/`gtc`, and a `session: SEAMLESS` flag for extended-hours orders; Alpaca accepts extended-hours `LIMIT` orders. Decisions do not yet carry an extended-hours flag — that is new in this ADR (D4).

---

## Decision

### D1. Single-stock research — one screen — SHIPPING NOW

`GET /api/trading/research/:symbol` (store route, auth-gated, book query-first per the ADR-134 D3.9 convention) aggregates, for the selected account's data rail:

- **Quote** — current price/change, off the same feed the chart uses.
- **Fundamentals** — the EDGAR `fundamentalsSummary` (revenue YoY, net margin).
- **News** — `recentNews`, last 7 days, headline/source/url/time.
- **Filings** — from EDGAR submissions: the latest 10-K, the latest 10-Q, and the last 12 8-Ks with their item codes decoded into plain words ("Results of operations", "Material agreement", "Officer/director change", "Other events", …) and links to the primary documents.
- **Earnings schedule** — the next expected print from the world calendar when present, plus the dated history of past-results 8-Ks (item `2.02`) as the observed reporting cadence.
- **Bars** — the same series the D1 chart route (ADR-136) already serves.

Nothing is fabricated: any section whose source call fails reports "unavailable" rather than a placeholder value or a stale cache.

UI: a Research view, reached by symbol search or by "Focus →" from any symbol elsewhere in the surface, showing chart, quote/fundamentals, news, filings, and events on one screen, with **Buy** and **Add to watchlist** actions.

### D2. Watchlist — per-user, cross-account — SHIPPING NOW

A new table `oshal_trading_watchlist` (owner RLS; `symbol`, `note`, `added_at`) is per-user, not per-account — a watched stock is a research interest, not a position, so it does not belong to a book. Routes: `GET`/`POST`/`DELETE /api/trading/watchlist`. The UI shows quote and day change per symbol, with Research and Buy buttons, on both the Accounts landing tile grid and the Research view.

### D3. Pinned lots — the ring-fence — SHIPPING NOW

A manual purchase (ADR-136 D3's `POST /api/trading/decisions/manual`) may now declare protection rules at purchase time: take-profit (price or percent), stop-loss (price, percent, or a trailing-stop percent), and an optional time stop. The route records a **pinned-lot intent** keyed to the manual decision, rather than placing exits itself.

A new kernel leg, `trading-pinned-lots`, riding the existing per-user `trading-events` schedule (the same 5-minute ET cadence D6/event playbooks already use — no new schedule kind), watches the entry order. On fill it:

1. Records the lot — book, symbol, qty, avg fill price — in a new lots table.
2. Places the declared exits as venue-resident GTC orders through the same `placeDecisionOrder` path every other order uses: a take-profit SELL LIMIT, and either a STOP SELL or a TRAILING_STOP SELL. Lot orders carry a `lot-` request-id prefix.
3. When one exit fills, cancels the sibling.
4. A time stop, if declared, sells the lot at market when it elapses.

**The overlay is the ring-fence.** Before the autopilot's fire uses broker positions for anything — rotation, protective exits, trims, capacity counting — `trading-schedule-dispatch.ts` subtracts each symbol's pinned quantity from the broker-reported quantity. A partially pinned symbol shows the autopilot only its own remaining shares; a fully pinned symbol disappears from the autopilot's view of that book entirely. `freeStaleSells` is changed to skip any working order whose request id carries the `lot-` prefix, so it can never cancel a lot's own exits while cleaning up the autopilot's stale sells for the same symbol.

Releasing a lot (an explicit operator action) cancels its outstanding exit orders and returns the shares to the autopilot's view on the next fire. Lots are scoped per book — the same symbol can be pinned in one book and traded freely by the autopilot in another, because the overlay only ever looks at broker positions within the fire's own book.

Guards: a pure spec for the overlay math (partial pin, full pin, no pin — broker qty in, autopilot-visible qty out, no I/O); a real-DB spec for the lot state machine (entry → filled → exits placed → one fills → sibling cancelled / time stop → closed) against injected venue fakes; and a source guard asserting the dispatcher calls the overlay before broker positions reach rotation, protective-exit, trim, or capacity logic — the shape of guard this codebase requires whenever a fix touches the most load-bearing kernel loop.

### D4. Pre/post-market on manual orders — SHIPPING NOW

The manual decision gains an `extended_hours` flag. The engine passes it to the venue for `limit` orders only — Alpaca's extended-hours support is LIMIT-only, and Schwab's `session: SEAMLESS` flag is passed the same way. The buy ticket offers "Eligible pre/post-market" as a checkbox on limit orders. Market orders are unaffected and keep the existing session conversion (market orders are session-restricted; ADR-136's existing fix for that stands).

### D5. Scope boundary and what does not change — SHIPPING NOW

Unchanged: the engine's single order path, guardrails, live gate, and reservation arbiter; strategy/lab semantics; event playbooks (ADR-136 D6), which keep their own executor and their own state machine, sharing only the fill-cancels-sibling pattern with pinned lots — they are not the same mechanism. No new schedule kind is introduced; the pinned-lot leg rides the existing `trading-events` cadence. Application code for all of D1-D4 stays in the store package (Rule 0c); the only kernel touch is the position overlay and the `freeStaleSells` prefix skip inside `trading-schedule-dispatch.ts`, both covered by the D3 guards.

---

## Consequences

**Gained.** A human can research a single stock — filings, news, earnings cadence, chart — and place a protected buy in under a minute, without leaving one screen. Protection set at purchase time survives every subsequent autopilot fire, because the autopilot is architecturally unable to see pinned shares rather than merely instructed to leave them alone. Two owners of the same symbol — the operator's manual pick and the autopilot's own rotation pick — coexist correctly by share count within a book, not by a symbol-level flag that would force an all-or-nothing choice. The watchlist gives the operator a place to track names before committing capital, cross-account since interest in a stock isn't account-scoped.

**Costs / risks.** Per-lot accounting adds a table and an overlay step inside the most load-bearing loop in the kernel — every dispatcher fire now does one more read and one more subtraction before touching broker positions, mitigated by keeping the overlay a pure function with its own spec rather than folding the logic inline. Venue-resident exits mean two live sell orders sit on the venue per lot until one fills, which is why the sibling-cancel step exists and why it has to be reliable — an uncancelled sibling that later fills would sell shares the operator thought were already gone. A lot's shares are, by design, invisible to the autopilot's own risk caps and capacity counting while pinned — that is the ring-fence working as intended, not a gap, but it means the autopilot's book-level exposure view is deliberately incomplete during the life of a lot. News in D1 is the Alpaca feed only, not every outlet, and is labelled as such rather than presented as complete coverage. "Next earnings" in D1 is either the world calendar's stated expectation or a cadence estimate derived from past 8-K/2.02 dates — the UI labels which one it is showing rather than presenting an estimate as a confirmed date. EDGAR access is keyless and subject to SEC's fair-use rate limits, same constraint the fundamentals/filings rails already operate under.

## Status / open items

D1-D5 shipped 2026-09-04. Guard specs: the D3 overlay pure-function spec, the D3 lot-state-machine real-DB spec against injected venue fakes, and the D3 source guard on overlay ordering in `trading-schedule-dispatch.ts` — all three are the closure evidence for the ring-fence claim; no part of D3 is considered done without them passing. Nothing in this ADR is deferred to a later phase.

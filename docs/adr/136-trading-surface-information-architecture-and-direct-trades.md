# ADR-136: Trading Surface Information Architecture and Direct Trades

- **Status:** Accepted (operator direction 2026-09-03; D1-D3 and D7 shipped 2026-09-03; D6 v1 shipped 2026-09-04 — core #284 + trading 1.7.0; D4-D5 DESIGNED for phase 2)
- **Date:** 2026-09-03
- **Depends on:** ADR-052 (no justification, no trade), ADR-085/093 (kernel/store carve), ADR-095 (Strategy Library apply-to-profile), ADR-134 (multi-account trading books — the N-book model this IA finally surfaces correctly)

---

## Context

The trading surface (store package `intelligent-trades`, `oshal-applications/trading/tools/trading.html`, one ~1700-line single-file SPA) grew tab-by-tab around a single account: Trade journal, All accounts, Accounts & books, Strategy Lab, Strategy Studio, Tuning, Performance, Recommendations, Algorithms, Capture & signals — ten tabs in one row, account-level and platform-level concerns mixed together.

ADR-134 turned the two-book world (`paper`/`live`) into N account-scoped books. The operator connected three Schwab accounts plus the paper book and found the UI unusable for that shape:

- The landing view drops straight into the paper account's detail — there is no "all accounts" summary to land on.
- The same 10-tab bar renders twice (top and bottom of the positions hero).
- A "connected accounts" strip sits in the middle of the account detail, competing with the account's own KPIs.
- Strategy configuration (Set/Reset, Strategy Lab, Strategy Studio, Tuning) is buried as one tab among ten, indistinguishable from platform-wide research tabs.

Operator direction (2026-09-03, verbatim intent): landing = a summary of all accounts in tiles, click into an account; the single-account KPI tiles are right and stay; the trade journal belongs to the account; strategy/lab/studio/tuning/all-accounts belong at the top level, never inside an account; one top-level "all accounts" place to click into details and run cross-account reports; never bury the strategy configuration. Separately: "simple trades" — pick an individual stock and just buy it while researching, on the selected account, with a simple workflow, including setting price points and dates/times; event-driven rules such as "listen for the earnings report — if it beats, buy more; if it underperforms, sell immediately"; and an IPO playbook for the Anthropic listing ("I want my 10% bump on my entire 401k").

The ten tabs being sorted are: Trade journal, All accounts, Accounts & books, Strategy Lab, Strategy Studio, Tuning, Performance, Recommendations, Algorithms, Capture & signals. Every one of them is real, shipped functionality — the problem this ADR solves is placement, not feature gaps. Nothing described below removes a capability; D1 relocates each tab into exactly one of four top-level views or into account detail, and nothing is dropped.

**Rails already in place, verified in code, that this ADR builds on rather than replaces:**

- Every order requires a `decisionId` (`POST /orders` → `placeDecisionOrder` — "every trade must be justified", ADR-052). Decisions carry `order_type` (`market`/`limit`/`stop`/`stop_limit`/`trailing_stop`), `limit_price`, `stop_price`, `trail_price`, `trail_percent`, `time_in_force` (`day`/`gtc`), and the Schwab adapter maps every one of them (`schwab-broker-adapter.ts`; shorting is not wired).
- Guardrails are env (`TRADING_MAX_QTY`, `TRADING_MAX_NOTIONAL_USD` — the operator box runs 100000 / 50000) and stay fleet-wide floors regardless of book (ADR-134 D3.9).
- The generic scheduling feature (`src/features/scheduling`) supports `once: true` schedules — a cron that fires and then pauses itself — and per-user schedules dispatched by `taskType` through the kernel's `trading-schedule-dispatch`.
- The earnings blackout gate (`TRADING_EARNINGS_GATE`, `trading-schedule-dispatch.ts`, `trading-gate-block-store.ts`) already reads the ingested world calendar's `days_to_earnings` per symbol.
- SEC EDGAR is already integrated keyless with a descriptive User-Agent (`src/features/trading/services/fundamentals.ts`). `data.sec.gov/submissions/CIK##########.json` exposes `filings.recent` as parallel arrays (`form`, `filingDate`, `acceptanceDateTime`, `items`, `accessionNumber`, `primaryDocument`) — an earnings release is an 8-K whose `items` include `2.02`; the document itself is fetchable at `sec.gov/Archives/edgar/data/<cik>/<accession>/<primaryDocument>`.
- The surface is served as one file by the kernel `servePage` helper from the package's `tools/` directory (`oshal-applications/trading/routes/trading-routes.ts`); there is no static mount for sibling JS files today.

**Anthropic IPO (press reports, September 2026, cited for D6 only):** a confidential S-1 was submitted June 1 2026; the public S-1 is expected around end of August 2026; press targets an October 2026 Nasdaq listing raising over $60B (some forecasters point later, ~November 30); the last private round was a $65B Series H at roughly $965B post-money. Retail access paths: (1) Schwab's own IPO program — a per-offering eligibility questionnaire, a minimum liquid-net-worth threshold (press reported $100K including IRAs for the SpaceX offering), a Conditional Offer to Purchase (COTP) submitted before 4pm ET the day before pricing and confirmed after pricing; (2) pre-IPO exposure via the ARK Venture Fund (ARKVX — interval fund, quarterly liquidity, ~3% Anthropic weight, ~3.5% expense ratio, retail access only via SoFi/Titan) — a poor fit here; (3) day-one secondary-market entry. Allocation at the IPO price is not something software can guarantee; the platform's honest contribution is making the COTP window un-missable and executing a disciplined day-one plan.

---

## Decision

### D1. Information architecture — four top-level views, account detail holds only account concerns — SHIPPING NOW

The header nav gets four top-level views, replacing the Paper/Live switch + dropdown as primary navigation:

- **Accounts** — the landing page. One tile per account: label/type/masked number, equity, day P&L, the strategy it runs, TRADING vs view-only, Start/Stop. Plus a consolidated total, a cross-account positions rollup, and "Discover accounts". Clicking a tile opens account detail. Paper is one tile like any other, labelled "Paper (reference book)".
- **Strategies** — the per-account strategy roster, with Set/Reset controls first, then Strategy Lab, Strategy Studio, and Tuning as sub-sections. The configuration screen is never buried behind account detail.
- **Research** — Recommendations, Algorithms, Capture & signals: market-wide, not account-scoped.
- **Reports** — Performance and Trade journal across accounts, with an account filter.

**Account detail** (reached from a tile; a back link plus an inline account switcher) holds only account-level concerns: a header with the account's strategy line, an inline change-strategy control, and Start/Stop; the KPI tiles (unchanged — the operator confirmed these are right); a **Buy a stock** button (D3); positions; the focus pane (chart, signal model, order ticket); and account-scoped Trade journal + Performance.

Removed from account detail: the duplicate tab row, the connected-accounts strip, and every platform-level tab.

Deep links: `?view=accounts|strategies|research|reports` and `?view=account&book=<ref>`. Legacy `?tab=` links map onto the new views so existing bookmarks keep working:

| Old tab | New location |
|---|---|
| All accounts, Accounts & books | **Accounts** (landing) |
| Strategy Lab, Strategy Studio, Tuning, Set/Reset | **Strategies** |
| Recommendations, Algorithms, Capture & signals | **Research** |
| Performance, Trade journal (cross-account view) | **Reports**, with an account filter |
| Trade journal, Performance (single-account view) | account detail, unchanged |

The four top-level views sit where the Paper/Live switch and its dropdown used to be — that switch stops being primary navigation because "which account" is now a landing-page decision, not a header toggle.

### D2. Code shape — thin shell plus ES modules, served same-origin — SHIPPING NOW

The SPA splits into a thin shell (`tools/trading.html`) plus ES modules under `tools/ui/` — app/router/state/api, one module per view, plus the trade ticket — served by a new same-origin static mount `/api/trading/ui/*` in the package routes, auth-gated the same way the surface itself is.

Existing tab code moves verbatim into view modules; the panel-render contract is preserved (each panel renders into a host element). The inline `<script>` shrinks to a bootstrap, which incidentally removes the CSP inline-script reports the current single-file shape generates.

Module layout under `tools/ui/`:

- `app.js` — bootstrap, mounts the active view into the shell
- `router.js` — reads `?view=`/`?book=`/legacy `?tab=`, resolves the D1 mapping
- `state.js` — the account/book list, selected book, cached summary
- `api.js` — the fetch layer every view calls through (one place to add `&book=` scoping, matching the ADR-134 `resolveBook` query-first convention on the server side)
- `views/accounts.js`, `views/strategies.js`, `views/research.js`, `views/reports.js`, `views/account-detail.js`
- `ticket.js` — the D3 trade ticket, shared by account detail

A guard spec parses every module — the 2026-09-03 blank-page regression was a raw newline inside a string literal, and the guard exists so that class of break fails a test instead of shipping. `trading-surface-live-gate.spec.ts` and `trading-accounts-surface.spec.ts` must keep passing against the split surface untouched.

### D3. Direct trades ("Buy a stock") — SHIPPING NOW

A new route `POST /api/trading/decisions/manual` mints an operator-authored decision: `agent_id = 'operator'`, a `manual` signal row carrying the operator's rationale, book-scoped via `resolveBook` (query-first, ADR-134 D3.9), with `symbol`, `side`, `qty` OR `notional` (notional resolves to `qty` from the latest price), `orderType` (`market`/`limit`/`stop`/`stop_limit`/`trailing_stop`), the matching limit/stop/trail parameters, and `timeInForce` (`day`/`gtc`). The existing `POST /orders` executes it through the identical guardrails, live gate, reservation arbiter, and disabled-book refusal as every engine-originated order.

Price points *are* order types — nothing new is invented at the venue: "buy if it drops to X" is a limit GTC order; "buy on a breakout above X" is a stop GTC order; "protect with a trailing stop" is a `trailing_stop` order.

UI is a 3-step ticket: pick a symbol (search plus a research card — price, chart, signal model, fundamentals) → size and price rule → confirm (names the account; live requires an explicit confirm, matching every other live-order path).

Validation on the route: exactly one of `qty`/`notional` is required, never both; `symbol` is checked against the same allowlist/lookup the engine already uses before quoting a price; a missing or unresolvable `orderType` parameter set (e.g. a `limit` order with no `limit_price`) is a `400`, not a silently-defaulted `market` order — a manual ticket that quietly changes order type on a typo is worse than one that refuses. The route returns the minted `decisionId` and the resulting order status in one response so the ticket's confirm step can show the operator what actually happened, not just that a request was accepted.

### D4. Dated/timed orders — DESIGNED (phase 2)

A manual decision (D3) paired with a per-user `once: true` schedule (`taskType trading-order:<sub>:<decisionId>`) fired by the kernel's trading dispatcher, which calls `placeDecisionOrder` and then pauses. The account view shows pending dated orders with a cancel action.

Done-when: a dated paper order placed from the ticket fires at the chosen ET time and appears in the ledger.

### D5. Event rules — earnings reaction — DESIGNED (phase 2)

A per-position standing rule stored in a new `oshal_trading_event_rules` table (`book_id`, `symbol`, `event = earnings`, `on_beat` action, `on_miss` action, sizing, expiry). A kernel watcher polls EDGAR submissions for held CIKs only, inside the world-calendar earnings window (`days_to_earnings <= 1`), and detects a new 8-K carrying item `2.02`; it fetches the primary document, and the trading-analyst bot (hosted/BYO rail, cost-attributed via `chat_tasks`) extracts revenue/EPS versus prior-year and versus the company's own prior guidance and classifies beat/miss/inline. The rule fires the mapped action as an operator-approved decision — paper auto-executes, live follows the book's confirm policy — with the first-print price reaction as a second gate.

Explicitly **not** a consensus-estimate service: there is no free keyless consensus-estimate source, and this design does not pretend otherwise — beat/miss is judged against the company's own filed numbers and guidance, not against Street consensus.

Done-when: a paper rule on a held name fires within N minutes of a real 2.02 filing, with the classification and the filing URL recorded in the decision rationale.

CIK resolution reuses whatever lookup `fundamentals.ts` already relies on to address a symbol at EDGAR — no new symbol→CIK mapping is introduced. Polling cadence is deliberately narrow: only symbols the operator currently holds, only inside the earnings window the world calendar already flags, so this is a handful of EDGAR calls per held name per week, not a market-wide crawl. The rule's UI lives on the account's position row in account detail (it is inherently account- and position-scoped), with the roster of active rules also visible from Strategies, since a standing rule is a form of strategy configuration.

### D6. IPO playbook (Anthropic first) — SHIPPED v1 (2026-09-04)

As built: `src/app/trading-event-plans.ts` stores one plan per account (FORCE-RLS) and runs it as a state machine on a per-user `trading-events:<sub>` schedule leg (every 5 minutes, 09:00–16:55 ET, weekdays), gated by `TRADING_EVENT_PLANS`: armed → watching (EDGAR full-text search for the issuer's public S-1/F-1, then the 424B4 pricing prospectus, from which the IPO price and ticker are parsed; the operator may also supply both) → priced → listed (first fresh trade in a regular session) → entry placed (day LIMIT at IPO × (1 + premium cap), sized as a percent of equity or in dollars, guardrail-capped) → filled → exits placed (take-profit SELL LIMIT GTC at IPO × (1 + tp); STOP SELL GTC at IPO × (1 − sl)) → closed (a fill cancels its sibling; a time stop sells at market) or missed/cancelled/error. Every order is an `event-playbook` decision through the engine's single order path. The Strategy Studio recognises an event request and designs the plan against the IPO research findings, saving it and returning a dry-run (orders at example IPO prices) instead of a backtest; plans are armed (confirm-gated), disarmed and deleted from Strategies → Event playbooks or the account page. Not automated, by design: the Schwab Conditional Offer to Purchase and its post-pricing confirmation — the dry-run lists them as manual steps. Not yet built: the COTP reminder sequence (T-3/T-1/T-0), which stays in BACKLOG.

Original design (kept for the record):

Three pieces, all expressed through rails that already exist:

- **Event watch** for the public S-1 — an EDGAR full-text-search poll for the issuer, surfaced as an alert with a link.
- **COTP reminder sequence** keyed to the pricing date. The platform cannot submit a Conditional Offer to Purchase — Schwab requires the client to do that on schwab.com and confirm after pricing — so this is a reminder, not an order.
- **Day-one plan** expressed as ordinary order types: no market-on-open; a sized entry as limit orders relative to the first-30-minute range/VWAP; a trailing stop after fill; a position cap (the operator's stated 10% of the IRA, roughly $46K, inside the existing $50K notional guardrail).

Done-when: the watch fires on the public S-1 filing, and the playbook's orders are dry-run-listable for the chosen account.

The event watch itself is market-wide, not account-scoped, so it surfaces from **Research** (D1) as an alert; running the day-one plan is account-scoped and happens from account detail, the same way a D3 manual ticket does. This is the same split D5's event rules make between "detecting the event" (market-wide) and "acting on a position" (account-scoped) — the IA in D1 is what makes that split renderable instead of another item competing for space in a single tab row.

### D7. Server truths the new views rely on — SHIPPING NOW (already shipped)

`/status` returns `bookConfigured` + `bookEnabled` per book; `/summary` dedupes the legacy-live/discovered-account double count; arming a live book is 428-gated server-side. All shipped 2026-09-03 (trading 1.5.x, core #272) and D1's Accounts view is built directly on these responses rather than a new aggregation.

### D8. Scope boundary

Application code stays in the store package (Rule 0c). The only kernel touches in this ADR are the dated-order `taskType` (D4) and the EDGAR event watcher (D5) — both phase 2, and each gated by an env flag defaulting off.

### D9. What is not changing

The engine's order path, guardrails, live gate, reservation arbiter, and book-disabled refusal (ADR-134); the strategy library/lab semantics; per-book overrides (ADR-134 D4). Direct trades and event rules are new *entry points* into that same path — they add no second execution rail.

### Guard specs (D1-D3, shipping now)

- Module-parse guard (D2) — every file under `tools/ui/` parses as valid JS; catches the class of break that produced the 2026-09-03 blank page.
- Route mapping guard (D1) — every legacy `?tab=` value resolves to a `?view=` target with no `404`/blank render.
- Manual-decision guard (D3) — `POST /api/trading/decisions/manual` against a real book: `qty`+`notional` together is rejected; a live order without `confirm` is refused the same way the existing live gate refuses one; the minted decision is retrievable by the same `decisionId` the resulting order references.
- Existing `trading-surface-live-gate.spec.ts` and `trading-accounts-surface.spec.ts` pass unmodified against the split surface — the refactor changes file layout, not behavior.

---

## Consequences

**Gained.** Multi-account state is legible at a glance from one landing tile grid instead of an account-detail page the operator has to already be inside; strategy configuration can never again be mistaken for a buried tab; every direct trade — including the phase-2 dated and event-driven ones — still passes through the identical accountable decision → order path as every autopilot-originated trade, so ADR-052's justification chain and ADR-134's per-book guardrails apply without exception; the CSP inline-script violation this surface currently generates goes away as a side effect of the module split.

**Costs / risks.** This is a large UI refactor of a ~1700-line single file with real regression risk — mitigated by the D2 module-parse guard and the existing surface specs (`trading-surface-live-gate.spec.ts`, `trading-accounts-surface.spec.ts`), which must keep passing untouched. Direct trades (D3) bypass the strategy engine's signal generation but not its guardrails — an operator can place a bad trade faster than before, by design, since the whole point is "buy while researching." Event rules (D5) add an LLM read step per detected filing, cost-attributed to the trading-analyst bot; a busy earnings week with several held names filing on the same morning multiplies that cost. Consensus-estimate beat/miss is explicitly out of scope for D5 — no free keyless source exists, and the design does not fake one. The static mount (D2) is new attack surface in the auth sense — it is auth-gated like the rest of the surface, but it is one more route to keep in that inventory rather than zero. The legacy `?tab=` mapping (D1) has to be maintained until every bookmark and external link into the surface has had a realistic chance to update; it is not a one-release throwaway.

## Status / open items

D1-D3 and D7 shipped 2026-09-03 (trading 1.5.x-1.6.0, core #272). D6 v1 shipped 2026-09-04 (core #284, trading 1.7.0) with the COTP reminder sequence left in BACKLOG. D4 and D5 are designed but not built — each has its own BACKLOG entry with the done-when criteria stated above (see [BACKLOG.md](../BACKLOG.md)); neither is scheduled by this ADR.

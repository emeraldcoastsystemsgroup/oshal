# ADR-143 — Market-data stream: the real-time source, entitlement/staleness guards, and the poll → stream relay

**Status:** Accepted — decision recorded 2026-09-06. **Nothing is built in this pass** (docs only): the
Buy ticket still polls `GET /api/trading/quote` every 5 s. The implementation is a later wave; its
files, sizes and guard specs are named in D9 so the wave is a build, not a design.

**Date:** 2026-09-06

**Related:** [ADR-052](052-stock-trading-swarm.md) (the trading swarm; paper = Alpaca, live = Schwab),
[ADR-092](092-trading-strategy-lab.md) (the Strategy Lab backtests on SIP-historical dailies),
[ADR-134](134-multi-account-trading-books.md) (books; `resolveBook` query-first; readers from the loaded
book), [ADR-136](136-trading-surface-information-architecture-and-direct-trades.md) (D3 — the 3-step
ticket whose price this ADR streams), [ADR-138](138-single-stock-research-watchlist-and-pinned-lots.md)
(D1 quote/chart "off the same feed"), [ADR-036](036-bot-owned-application-architecture.md) (the surface
is a view; credentials never reach it).

---

## Context

Two BACKLOG entries ask for the same decision from two directions. *Market-data stream decision*
(BACKLOG.md, "Market-data stream decision", currently at :577-579): exhaust the already-owned
Alpaca/Schwab data, quantify the consolidated real-time quote gap before buying another feed, and
have an ADR name the source, guard entitlement and staleness, and cite one intraday backtest with
its exact feed and coverage. *The ticket's live price is a 5-second poll, not a stream* (currently at
:810-812): terminate the venue websocket inside the kernel's market-data service and relay prints to
the surface, never a venue socket or credential in the browser, with reconnect-after-drop and a spec
proving it. A third entry, *market movers are bounded to the oshal universe + the caller's watchlist*
(:814-816), depends on whether whole-market movers can ride the chosen source — decided here (D5).

### What exists today (re-verified in the tree, 2026-09-06)

**Kernel — Alpaca REST, IEX feed, order-pricing staleness guard.**
[`src/features/trading/services/market-data.ts`](../../src/features/trading/services/market-data.ts)
is `fetch`-based against `https://data.alpaca.markets/v2` (`DATA_BASE`, :29). `latestTrade()` (:474)
requests `/stocks/{sym}/trades/latest?feed=iex` and returns `{ price, asOf }` with the exchange
timestamp; `latestPrice()` (:484-490) is the freshness-blind wrapper the algo path may use.
`maxTickAgeSec()` (:53, env `TRADING_EXT_QUOTE_MAX_AGE_SEC`, default 120 s) and `isTickStale()` (:64)
are the order-pricing guard: the CHANGE LOG's SEQ 3 records why (MRNA: 97 orders at one hours-old IEX
price across 17.3 h). The credential is resolved by `keys()` (:90-95) via `envFirst` over
`ALPACA_PAPER_KEY_ID` / `ALPACA_KEY_ID` / `ALPACA_KEY` / `ALPAKA_KEY` (and the matching secret names) —
module-private, never exported. SEQ 5 records the entitlement that matters here: the paper key gets
SIP **historical** bars (`feed=sip`) with the most recent 15 minutes withheld (`end` capped 16 min
back, :196/:241/:282), and not SIP real-time.

**Kernel — per-book vendor selection.**
[`market-data-source.ts`](../../src/features/trading/services/market-data-source.ts) `getMarketData(mode,
userSub)` (:67-72) returns the Schwab source when `brokerProviderFor(mode)`
([`broker-provider.ts`](../../src/features/trading/services/broker-provider.ts) :100, env
`BROKER_PROVIDER_LIVE` / `BROKER_PROVIDER_PAPER` / `BROKER_PROVIDER`, default `alpaca`) says
`schwab`, otherwise the Alpaca singleton. It selects by **mode**, not by the loaded book's `broker`
field (`TradingBook.broker: 'schwab' | 'alpaca' | null`,
[`broker-adapter.ts`](../../src/features/trading/services/broker-adapter.ts) :58; `null` = legacy env
resolution). The relay in this ADR must not repeat that shortcut (D2).

**Kernel — Schwab is REST-only.**
[`schwab-market-data.ts`](../../src/features/trading/services/schwab-market-data.ts) polls
`/marketdata/v1/quotes` with the caller's own OAuth bearer (per-user resolver, :4-9); `latestTrade()`
(:140-150) pairs `lastPrice` with Schwab's `tradeTime`/`quoteTime` epoch-ms stamp and deliberately
never falls back to `mark`/`closePrice` (SEQ 2). A case-insensitive search of `src/` for
`userPreference`, `streamer`, `LEVELONE` and `wss://` returns nothing: **no Schwab streamer
integration exists in the code base.**

**Kernel — who prices orders.** `src/app/trading-engine.ts` :494-495 (`latestTrade` → `isTickStale` →
decline) and `src/app/trading-event-plans.ts` :295 (same pair). Both read REST. Neither will read the
stream (D7).

**Store — the poll.** `oshal-applications/trading/tools/ui/ticket.js` header :6 ("GET /quote (last
trade, re-polled every 5s + a Refresh button)"), `tktStartTick()` :352 (`setInterval(tktTick, 5000)`),
`tktRefreshQuote()` :360 and `tktLookup()` :520 both call `api('/quote?symbol=…')`. The route,
`oshal-applications/trading/src-routes/trading-manual-order-routes.ts` :265-269, resolves
`getMarketData(book.kind, sub)`, calls the freshness-blind `latestPrice()`, and answers
`asOf: new Date().toISOString()` — the **request** time, not the print time. A displayed "as of" on
the ticket today is therefore always "now", even when the last IEX print is hours old.

**Store — movers today.** `oshal-applications/trading/src-routes/trading-research-routes.ts` :365-374
`GET /reports/movers` ranks the platform universe plus the caller's watchlist from daily bars and
labels that bound (:77).

**Rails that exist for pushing to a surface, and why none is the relay.**
- [`src/features/streaming/services/stream-manager.ts`](../../src/features/streaming/services/stream-manager.ts)
  is the kernel's SSE helper, **keyed by task id** (`registerClient(clientId, taskId, res)` :66; the
  header set at :89-98). A quote relay is keyed by (book, symbol set) and has no task; reusing it
  would mean inventing pseudo-tasks.
- [`src/features/surface-bridge/index.ts`](../../src/features/surface-bridge/index.ts) is the
  bot ↔ cockpit-surface **postMessage** contract (:4-7) — a same-window event vocabulary, not a server
  push channel. The BACKLOG entry's phrase "the existing surface-bridge/SSE rail" conflated the two;
  there is no SSE in surface-bridge.
- The pumpkin projector SSE route was carved to the store (`src/app/server.ts` SEQ 114); its
  `attachRoomStream()` in `oshal-applications/pumpkin/src-routes/pumpkin-routes.ts` :468-500 is the
  shape to copy (status decided **before** `writeHead`; `retry: 5000`; `drop()` on `writableEnded ||
  destroyed`, write-callback error, `req 'close'`, `res 'error'`). The core keeps the client-side
  lesson at `src/pages/pumpkin/pumpkin-app.js` :628-630: an EventSource that receives a non-2xx is
  CLOSED and never retries on its own.

**Dependencies already in the image.** `ws` `^8.21.0` (`package.json` :228), used today by
`src/app/routes/ringcentral-screen-pop.ts` :18. The runtime is `node:20-alpine`
(`Dockerfile.oshal` :71) — `ws` needs nothing newer.

### What the venues entitle (sources named per figure)

| Fact | Value | Source |
|---|---|---|
| Alpaca **Basic** (free) real-time source | IEX only | docs.alpaca.markets/docs/about-market-data-api, fetched 2026-09-06 |
| Basic websocket symbol limit | 30 symbols | same page |
| Basic REST rate / historical delay | 200 calls/min; latest 15 minutes withheld | same page (matches market-data.ts SEQ 5 and the 403 below) |
| **Algo Trader Plus** | $99/month; all US exchanges (SIP) real-time; unlimited websocket symbols; 10,000 calls/min; no historical delay | same page (price as published there on the fetch date) |
| Stream endpoints | `wss://stream.data.alpaca.markets/v2/{iex\|sip\|delayed_sip}` | docs.alpaca.markets/docs/real-time-stock-pricing-data, fetched 2026-09-06 |
| Concurrent stream connections | "limited based on the user's subscription, but in many subscriptions (or without one) this limit is 1"; exceeding → error 406 | docs.alpaca.markets/docs/streaming-market-data, fetched 2026-09-06 |
| Stream error codes | 400 invalid syntax · 401 not authenticated · 402 auth failed · 403 already authenticated · 404 auth timeout · 405 symbol limit exceeded · 406 connection limit exceeded · 407 slow client · 409 insufficient subscription · 410 invalid subscribe action for this feed · 500 internal error | same page |
| Trade frame | `{T:'t', S, p, s, t (RFC-3339, ns), x, c[], z}`; subscribe `{action:'subscribe', trades:[…]}`; confirmation `{T:'subscription', trades:[…]}` | same two pages |
| `trades/latest?feed=iex` with the paper key | **200** (AAPL print `t=2026-09-04T20:34:14Z`) | read-only probe from this checkout, 2026-09-07 00:56 UTC |
| `trades/latest?feed=sip` with the paper key | **403** `"subscription does not permit querying recent SIP data"` | same probe (reproduces strategy-log.md :225-230) |
| `/v1beta1/screener/stocks/movers?top=5` with the paper key | **200** (gainers/losers, whole-market — micro-cap warrants at the top) | same probe |
| `/v1beta1/screener/stocks/most-actives?by=volume&top=5` with the paper key | **200**, `last_updated: 2026-09-04T23:59:00Z` | same probe; the reference page (docs.alpaca.markets/reference/mostactives-1) describes the data as "Real time SIP data" and states no plan restriction — treat the plan scope as **Alpaca's statement, not a measured guarantee** |
| Schwab streamer | `GET /trader/v1/userPreference` returns `streamerInfo` (socket URL, customer/correlation ids); the socket takes a `LOGIN` with the account's access token and a `LEVELONE_EQUITIES` subscription | **Assumption from the Schwab developer portal's Streamer Guide**, which is login-gated and was not fetched here; nothing in the tree implements it |
| Schwab REST quotes for a live account | real-time last trade with `tradeTime` (verified in code: `schwab-market-data.ts` :146-149) | code; the entitlement itself is the account holder's, per Schwab's terms (assumption) |

### What the IEX gap costs (measured, `docs/apps/trading/strategy-log.md`)

Measured 2026-07-12 and recorded in the strategy log; the line ranges below exist in the file today.
(The log's :179 cites an evidence file `news-wire-recall-2026-07-12.md` that is **not** in the tree — this
ADR cites the log's own tables and nothing behind them.)

| Measurement | Result | Where |
|---|---|---|
| 1Day closes, IEX vs SIP (NVDA, 07-01→07-10) | max 0.16 %, typically 0.02 % — daily signals and the rotation backtest unaffected | strategy-log.md :207-209 |
| 5Min bars, IEX vs SIP (MU) | 189 K shares vs 9.0 M; +0.58 % vs +0.03 % — "all intraday/pop research on IEX is invalid" | :210-214 |
| IEX print coverage by ET hour (share of consolidated symbol-minutes with an IEX print, 07-08/09/10 × 18 symbols) | 04:00-07:59 **0.0 %** · 08:00 5.6 % · 10:00-15:59 **85-93 %** · 16:00 1.3 % · 17:00-19:59 **0.0 %** | :232-241 |
| IEX-vs-consolidated divergence on the last RTH minute | median **5.6 bps**; tail RGTI 54, SOUN 45, IONQ 30, SMCI 29 bps | :261-267 |
| Kill condition recorded then | "re-enable [extended hours] only with real-time SIP (Alpaca Algo Trader Plus, ~$99/mo)" | :269 |

So: during regular hours IEX prints exist for ~85-93 % of symbol-minutes and trail the tape by
single-digit basis points in the median; outside 08:00-17:00 ET there is **nothing** to stream. A
display fed by IEX is honest during RTH and must say "stale" off-session; an order must never be
priced off it without the existing `isTickStale` guard (D7).

---

## Decision

### D1. The v1 real-time source, per book

| Book | Executing broker (from the loaded book) | v1 source | Cadence / label on the surface |
|---|---|---|---|
| Paper, and any book whose `broker` resolves to `alpaca` | Alpaca | **Alpaca IEX v2 trades stream** (`wss://stream.data.alpaca.markets/v2/iex`), the free entitlement already owned | prints as they arrive; pill "live · IEX"; greys to "stale · last IEX print <time>" after `TRADING_STREAM_STALE_SEC` |
| Live, and any book whose `broker` resolves to `schwab` | Schwab | **No stream in v1.** Today's 5-second REST poll of Schwab `/quotes` through `getMarketData` stays | "Schwab quote · polled"; `asOf` becomes the venue's `tradeTime`, not request time |

The broker is decided from the **loaded book**: `book.broker ?? brokerProviderFor(book.kind)` — the
row's binding first, the mode-derived env resolution only for a `null` (legacy) binding. This is the
ADR-134 rule ("broker readers only from `loadBook()`; never a bare mode") applied to data, and it is
the correction to `market-data-source.ts` :68's mode-only selection, which the relay does not copy.

**No feed is purchased for v1.** The stream is display-only (D7), and during regular hours the
owned IEX feed carries the ticket and the positions table with a median divergence of 5.6 bps
(measured, above). The named candidate if a purchase is ever warranted is the same vendor's
Algo Trader Plus (SIP real-time; $99/month per the plan page on the fetch date) — a URL change
(`ALPACA_STREAM_URL` → `/v2/sip`) and a cap change (`TRADING_STREAM_MAX_SYMBOLS`), no code. The
**purchase triggers**, any one of which re-opens this decision: (a) `TRADING_EXTENDED_HOURS` is turned
back on (strategy-log :269 kill condition); (b) any intraday strategy is armed for real orders (the
:210-214 ruling); (c) an order path is ever allowed to price off the stream. Whole-market movers are
**not** a trigger — D5.

### D2. Where the socket terminates and how prints reach the surface

```
Alpaca IEX websocket ──(kernel: market-data-stream.ts, ONE process-wide connection,
                         key read inside the kernel only)──▶ refcounted per-symbol fan-out
   ──▶ store route GET /api/trading/stream?book=&symbols=  (same-origin SSE, cookie/OIDC auth,
        book resolved QUERY-FIRST via resolveBook, payload ALLOWLISTED)
      ──▶ tools/ui/quote-stream.js (one EventSource per (book, symbol set); patches the ticket
           quote + positions cells in place; falls back to the 5 s poll when not streaming)
```

- **The venue socket terminates in the kernel**, in a new
  `src/features/trading/services/market-data-stream.ts` — a process singleton because the venue
  allows one connection per key (source above) and because a store router can be re-mounted by
  `docker cp` + restart and must not own a venue session. It authenticates with the credential
  obtained from `market-data.ts` through a new kernel-internal `alpacaDataCredentials()` that is
  **not** re-exported from `src/features/trading/index.ts`; a store module has no path to the key.
- **The relay is store code** (Rule 0c — application-shaped): a new `trading-quote-stream-routes.ts`
  under `oshal-applications/trading/src-routes/`, mounted in the same `service-or-oidc` router as
  `/quote` (`trading-routes.ts` :126-141 registration block). Book resolution is
  `resolveBook(ctx.pool, sub, (req.query.book) ?? (req.query.mode))`
  (`src/app/routes/trading-routes-helpers.ts` :65 — a garbage ref is a 400, never a remap).
  `callerSub` 401, `resolveBook` 400 and any refusal are answered **before** `writeHead`, because an
  EventSource treats a non-2xx as terminal (`pumpkin-app.js` :628-630) and "200-then-end" is read as
  a drop and retried forever (`pumpkin-routes.ts` :456-461).
- **Why a new route rather than an existing rail:** `stream-manager.ts` is keyed by task id (:66) and
  `surface-bridge` is a postMessage contract, not server push (Context). The pumpkin route's transport
  shape is copied, not its registry.
- **Frames.** `hello` → `{streaming, feed, staleAfterSec, symbols (accepted), dropped, book: book.ref,
  source: 'alpaca-stream' | 'alpaca-poll' | 'schwab-poll', reason?}`; `print` → **exactly**
  `{symbol, price, size, asOf, feed}` built by an allowlisting `printFrame()` (never a spread, so a
  field added to the kernel type later cannot leak); `status` → `{state, lastError, lastPrintAt}`;
  `: ping` comments every `TRADING_STREAM_SSE_HEARTBEAT_MS`. A book whose broker is Schwab, a
  disabled stream, or an `entitlement_blocked` kernel state all answer **200 SSE with
  `hello {streaming:false}` and a held connection** — the client keeps polling and nothing goes blank.
- **The browser sees prints and nothing else.** No `wss://` URL, no `APCA-*` header, no `ALPACA_*`
  name, no bearer, no token in the query string — the EventSource URL is a same-origin path and auth
  rides the session cookie, exactly as `/quote` does today. Guarded by the store spec in D9.

### D3. Entitlement, reconnect and staleness guards (all env-tunable; config → env → default)

| Guard | Behaviour | Env (default) |
|---|---|---|
| Armed off by default | The kernel module opens **no socket** unless enabled; the relay answers `hello {streaming:false, reason:'stream_disabled'}` | `TRADING_STREAM_ENABLED` (`false`) |
| Feed URL | Last path segment is the `feed` label shown on the surface; a paid plan flips it to `/v2/sip` | `ALPACA_STREAM_URL` (`wss://stream.data.alpaca.markets/v2/iex`) |
| Symbol cap | `planSubscription(requested, cap)` — insertion order kept, **the ticket symbol first** so the cap never drops it, the tail returned as `dropped` (in `hello`); dropped symbols keep polling | `TRADING_STREAM_MAX_SYMBOLS` (`30`, the Basic plan's limit) |
| Venue 402 / 406 / 409 | `state = 'entitlement_blocked'`, `lastError` set, **no reconnect until the cooldown elapses**; clients get a `status` frame and fall back to the poll | `TRADING_STREAM_AUTH_COOLDOWN_MS` (`300000`) |
| Venue 405 | Trim the desired set to the cap and emit status; no subscribe/unsubscribe loop | (uses the cap above) |
| Socket close / error | Exponential backoff while listeners exist; on `authenticated` the **union** of live subscriptions is re-sent (the BACKLOG "relay reconnects after a drop") | `TRADING_STREAM_RECONNECT_MS` (`1000`) / `TRADING_STREAM_RECONNECT_MAX_MS` (`30000`) |
| Idle close | Venue socket closed when no SSE client is subscribed | `TRADING_STREAM_IDLE_CLOSE_SEC` (`120`) |
| Display staleness | Carried in `hello`; the client greys any patched cell whose last print is older and rewrites the as-of line to "stale · last IEX print <time>" | `TRADING_STREAM_STALE_SEC` (`60`) |
| SSE keepalive | `: ping` comment cadence, so a buffering proxy or half-open socket is detected | `TRADING_STREAM_SSE_HEARTBEAT_MS` (`15000`) |
| **Order-pricing staleness (unchanged)** | `latestTrade()` + `isTickStale()` on REST, `maxTickAgeSec()` | `TRADING_EXT_QUOTE_MAX_AGE_SEC` (`120`) — governs orders, not the display |

Compose passthrough follows the Kalshi precedent: `x-bot-env` gains
`TRADING_STREAM_ENABLED: ${TRADING_STREAM_ENABLED:-false}` plus the URL/cap/stale names, and a text pin
in the style of `tests/unit/compose-kalshi-live-gate.spec.ts` (:6, :14-29) keeps the `false` default
red-on-regression. Every reader is a per-call `process.env` read (no module-level constant), so specs
can point the module at a local server.

### D4. The gap, quantified — and why it does not justify a purchase for a display

The tables in Context are the record. Restated as the decision they support: **daily** work stays on
IEX (0.16 % max close divergence); **intraday research** must use SIP-historical (`feed=sip`, 15
minutes withheld — the Strategy Lab already does); **display** during regular hours may stream IEX
(85-93 % coverage, 5.6 bps median divergence) provided the feed is named and staleness is shown;
**off-session display** freezes on IEX and is labelled stale rather than fabricated; **order pricing**
keeps REST `latestTrade` + `isTickStale` regardless of feed. A $99/month SIP subscription would buy
basis points and after-hours prints for a *display* whose order path would still refuse to use them —
that is the wrong purchase for v1.

### D5. Whole-market movers ride the owned key's REST screener, not the websocket

A 30-symbol websocket cannot rank the market. The read-only probe above answered **200** on both
`/v1beta1/screener/stocks/movers` and `/v1beta1/screener/stocks/most-actives` with the paper key, so
whole-market movers **can** be served from the owned Alpaca key over REST with no purchase. Decision:
the movers BACKLOG entry narrows from "needs a paid screener feed" to "add the screener as a second,
labelled source behind `GET /api/trading/reports/movers`" — kind `winners`/`losers` from
`screener/stocks/movers`, `active` from `screener/stocks/most-actives?by=volume` (and `by=trades`),
each response carrying the vendor's `last_updated` and the label "Alpaca screener" verbatim, with
today's bounded board as the fail-soft fallback when the screener returns non-200. Two honesty
constraints are part of the decision: the reference page's "Real time SIP data" is Alpaca's statement
(the plan page does not name which plan the screener belongs to), so the surface prints the vendor's
`last_updated` rather than claiming consolidated freshness; and the raw board is dominated by
micro-cap warrants (the probe's top gainers were sub-$1 symbols), so the report keeps its
`isMoverKind` ranking and adds a minimum-price/asset-directory filter with the filter stated on the
surface. `volatile` stays on the bounded daily-bar computation — the screener has no such kind.

### D6. The Schwab streamer is deferred, with a done-when

Live books poll in v1 (D1). The streamer needs a per-login `userPreference` → `streamerInfo` resolve,
a per-user socket (the bearer is the caller's, not the box's — one socket per connected login, not
one per process), `LOGIN` + `LEVELONE_EQUITIES` framing, and a translation of Schwab's field set into
the same `MarketPrint`. None of that exists (Context). It is **narrowed, not dropped**: the
"5-second poll" BACKLOG entry becomes "live (Schwab) books still poll" with done-when — *streamerInfo
resolved per login through the existing Schwab token resolver; LEVELONE_EQUITIES prints relayed on the
same `/api/trading/stream` route and frame shape; a spec proving the Schwab bearer never reaches the
browser; the live ticket updates within a second of a print during RTH.*

### D7. What does not change

The order path (`placeDecisionOrder`, guardrails, live gate, reservation arbiter, 428 confirm gates,
disabled-book refusal); `trading-engine.ts` :494-495 and `trading-event-plans.ts` :295 keep pricing
from REST `latestTrade` + `isTickStale`; `GET /api/trading/quote` stays (it is the fallback), gaining
the venue print time as `asOf` in place of request time; `getMarketData` for signals/bars; the
Strategy Lab's SIP-historical backtests; every existing env name. The stream is **display-only in
v1** — guarded by a source pin that `trading-engine.ts` and `trading-schedule-dispatch.ts` contain no
`subscribeMarketPrints`.

### D8. The intraday backtest the BACKLOG done-when asks for — cited with its feed

The done-when reads "one intraday backtest cites the exact feed and coverage". Two exist in the tree
and are cited here with their feed; **neither ran on the stream** (the stream is display-only and did
not exist), and this ADR does not pretend otherwise:

- **News-wire recall test, 2026-07-12** (`strategy-log.md` :173-190; script
  `scripts/oshal-trading-news-wire-recall.ts`): surge detection on the **SIP-historical** tape
  (`feed=sip`, paper key, most recent 15 minutes withheld — the entitlement recorded at :228-230),
  same-session contiguous windows; 25 surges, 7/25 with a headline ≤ 60 min ahead — MARGINAL. Its
  2026-07-14 rerun (:334) used the same corrected-SIP set (206 surges, 132 volume-confirmed).
- **Intraday cross-sectional momentum** (`docs/apps/trading/intraday.md` :36-43, script
  `scripts/oshal-intraday.js`): 1-minute bars **straight from the Alpaca IEX feed** — the doc itself
  states "for SIP-quality fills or pre/post bars use a paid feed", and the IEX coverage figures in
  Context (0 % pre/post, 85-93 % RTH) are the quantitative form of that caveat.

Under the 2026-07-12 ruling (:213-214) the second is a valid study of *relative* returns on a
daily-anchored signal but not a fill-quality study; any future intraday strategy work cites `feed=sip`
historical by rule and, if armed for orders, trips purchase trigger (b) in D1.

### D9. Phased implementation (a later wave; exact files, estimated sizes)

Sizes are estimates in code lines (comments/blank excluded), every function under 50 lines.

**Phase 1 — kernel (one core PR).**
- `src/features/trading/services/market-data.ts` — add `alpacaDataCredentials(): { id; secret }`
  returning `keys()`; JSDoc marks it kernel-internal; **not** added to the barrel. ~8 lines, SEQ 9.
- NEW `src/features/trading/services/market-data-stream.ts` — ~260 lines: types `MarketPrint`,
  `MarketStreamState` (`disabled | idle | connecting | authenticated | backoff | entitlement_blocked`),
  `MarketStreamStatus`; per-call env readers for every name in D3; `subscribeMarketPrints(symbols,
  onPrint, onStatus?) → unsubscribe` (refcounted `Map<symbol, Set<listener>>`, subscribe/unsubscribe
  **diffs** to the venue); `marketStreamStatus()`; pure `planSubscription()`; `resetMarketStreamForTests()`;
  `ws` imported as in `ringcentral-screen-pop.ts` :18; frame dispatch per the venue table (`success:
  authenticated` → resend the union; `error` 402/406/409 → blocked+cooldown, 405 → trim; `subscription`
  → record; `t` → normalize `{S,p,s,t}`, reject non-finite/≤ 0 price, fan out). Logs `info` on
  authenticated/closed and `error` on entitlement codes; **never** the key.
- `src/features/trading/index.ts` — export `subscribeMarketPrints, marketStreamStatus, planSubscription`
  and the three types. SEQ +1.
- `docker-compose.oshal-local.yml` `x-bot-env` (beside `TRADING_EXT_QUOTE_MAX_AGE_SEC` :473) +
  `.env.example` (Alpaca block after :325) + `docs/apps/trading/advisor.md` env table: the four
  operator-facing names with defaults and the one-connection-per-key note.
- Guard specs: NEW `tests/unit/trading-market-data-stream.spec.ts` (~240 lines) and NEW
  `tests/unit/compose-trading-stream-gate.spec.ts` (~40 lines) — contents in "Guard specs".
- Docs in the same PR: this ADR's Status → "Phase 1 shipped"; the real-boundary audit row.

**Phase 2 — store (trading package; after Phase 1 is deployed — the twin imports the new barrel names).**
- NEW `src-routes/trading-quote-stream-routes.ts` (~150 lines) — `registerTradingQuoteStreamRoutes(router,
  ctx, deps = { subscribe, status, resolveBook })`; express types imported **type-only** so the compiled
  twin resolves like `trading-manual-order-routes.ts`; `GET /stream` per D2; venue chosen by
  `book.broker ?? brokerProviderFor(book.kind)`.
- `src-routes/trading-routes.ts` — one registration line after `registerTradingManualOrderRoutes` (:135).
- `src-routes/trading-manual-order-routes.ts` — `/quote` answers the venue print time via `latestTrade`
  (falling back to `latestPrice` + `asOf:null` when the venue has no stamped trade). ~6 lines.
- NEW `tools/ui/quote-stream.js` (~170 lines, classic script, `qs*` globals): `qsSync()` (debounced;
  ticket symbol first, then `STATE.positions` symbols), one `EventSource('/api/trading/stream?…')`,
  `qsApplyPrint()` patches `TKT.quote` + `tktApplyQuote()`, and the positions row fields
  `price / marketValue / unrealizedPl / retPct` with `UNIVERSE[sym].price / mktValue / uPl / retPct`
  (the names `shared-positions.js` :34-38 and :66-69 actually use), `qsStaleTick()` DOM-only greying,
  `qsIsStreaming(sym)`, `qsClose()`.
- `tools/ui/ticket.js` (+~12 lines; 851 total today, kept under the 800-code-line threshold by placing
  all stream logic in the new file): `tktTick()` no-ops while `qsIsStreaming(TKT.symbol)`;
  `openTicket`/`tktLookup`/`closeTicket` call `qsSync()`; `tktAsOf()` prefers the print time;
  a "live · IEX" pill when `TKT.quote.live` and fresh.
- `tools/ui/shared-positions.js` (+~6: `qsSync()` after `renderPortfolioTable()`; `data-col` on the
  Last / Mkt value / Total $ / Total % cells so the patch needs no index arithmetic — Today $/% stay the
  broker's values, stated in the table footer), `tools/ui/app.js` (+1: `qsClose()` on `navigate()`),
  `tools/trading.html` (+1 `<script>` after app.js, before shared-positions.js).
- Movers (D5): `src-routes/trading-movers.ts` or `trading-research-routes.ts` gain the screener source
  (~60 lines) behind the existing `GET /reports/movers`, labelled, fail-soft.
- `oshal-app.yaml` version bump (whatever is next when it lands — several program items bump it),
  `README.md` "Using the surface" step 1 as-built + "API added" entry for `GET /api/trading/stream`.
- Guard spec: NEW `tests/trading-quote-stream.spec.ts` (~180 lines) — contents below. The store tree has
  **no `node_modules`** (verified: `trading/node_modules` is empty and `vitest.config.mjs` aliases only
  `@`), so the HTTP seam is a `node:http` harness invoking the registered handler, or an added
  `resolve.alias` for `express` pointing at `<framework>/node_modules` — never a bare `import express`.
- Deploy: `docker cp` the package into `deployed-apps/trading` + api restart (a package importing a NEW
  kernel module needs the core deploy first — router 404s otherwise).

**Phase 3 — operator.** Set `TRADING_STREAM_ENABLED=true` in the box `.env` after confirming nothing
else streams with the paper key; recreate the api; `docker exec oshal-local-api env | grep
TRADING_STREAM_ENABLED` as the in-container probe; during regular hours open a paper account, pick a
held symbol, watch the pill and the positions row move on prints, restart the api once and confirm the
relay reconnects. Date the observation in the real-boundary audit row and COLLABORATE.md.

**Phase 4 — deferred.** The Schwab streamer (D6).

### Guard specs (named now; shipped with the wave that builds each layer)

- `tests/unit/trading-market-data-stream.spec.ts` — **real local protocol seam**: a `ws`
  `WebSocketServer` on 127.0.0.1 speaking the venue's frames (`[{T:'success',msg:'connected'}]`, expects
  `{action:'auth',key,secret}`, authenticates only the spec-set `ALPACA_PAPER_KEY_ID`/`_SECRET_KEY`
  — the aliases `ALPACA_KEY_ID`/`ALPACA_KEY`/`ALPAKA_KEY` and their secrets are unset in `beforeEach`
  and restored after, because `keys()` resolves them in that precedence — records subscribe frames,
  emits `[{T:'t',S:'AAPL',p:189.5,s:100,t:<iso>}]`); `ALPACA_STREAM_URL=ws://127.0.0.1:<port>/v2/iex`,
  `TRADING_STREAM_RECONNECT_MS=10`, `_MAX_MS=50` so no case sleeps a second. Cases: (1) a subscriber
  receives a normalized `MarketPrint` (`asOf = new Date(t)`, `feed 'iex'`); (2) two subscribers on one
  symbol → ONE venue subscribe, the last unsubscribe → the venue unsubscribe; (3) server-side close →
  reconnect with backoff AND the union re-subscribed; (4) a 402 frame → `entitlement_blocked`,
  `lastError` set, no reconnect inside the cooldown; (5) a 405 frame → the desired set trimmed to the
  cap and **≤ 2 subscribe frames after it** (no loop); (6) `planSubscription` keeps insertion order and
  returns the dropped tail; (7) **`TRADING_STREAM_ENABLED` unset/false → the fake venue records zero
  connections** (the default-off posture); (8) `JSON.stringify` of every `MarketPrint` and
  `MarketStreamStatus` contains neither the key nor the secret, and a wrapped logger's captured lines
  contain neither. Source pins in the same file: the barrel does not contain `alpacaDataCredentials`;
  `market-data-stream.ts` reads `TRADING_STREAM_ENABLED` inside a function, not a module constant;
  `trading-engine.ts` and `trading-schedule-dispatch.ts` contain no `subscribeMarketPrints`.
- `tests/unit/compose-trading-stream-gate.spec.ts` — the Kalshi text-pin pattern: `x-bot-env` carries
  `TRADING_STREAM_ENABLED: ${TRADING_STREAM_ENABLED:-false}`, the api service inherits the anchor, and
  the code side reads the literal `'true'`.
- `oshal-applications/trading/tests/trading-quote-stream.spec.ts` — (a) **no credential reaches the
  browser**: every `tools/ui/*.js` and `tools/trading.html` contains none of `wss://`,
  `stream.data.alpaca`, `APCA-API`, `ALPACA_`, `schwabapi.com`, `Authorization`, `access_token`, and
  `quote-stream.js` opens exactly `new EventSource('/api/trading/stream` (a path, no host); (b) the route
  module imports only the allowlisted kernel names, never `alpacaDataCredentials` or
  `process.env.ALPACA`, resolves the book query-first, and answers 401/400 before `writeHead`;
  (c) **real HTTP seam** through the `node:http` harness with injected deps (a fake `subscribe`, a
  `status()` of `{enabled:true, state:'authenticated', feed:'iex', maxSymbols:30, …}`, and a
  `resolveBook` returning a fake built **from the exported `TradingBook` type**, so `accountType` /
  `settlementPolicy` additions cannot break it): the fake print carries an extra field `secret:'x'`
  and the received frame decodes to exactly `symbol/price/size/asOf/feed`; `hello` precedes it;
  closing the client invokes the fake unsubscribe exactly once; (d) `status.enabled=false` and a
  Schwab-broker book each answer 200 SSE with `hello {streaming:false}` and **stay open**: with
  `TRADING_STREAM_SSE_HEARTBEAT_MS=20` the client holds ≥ 2 heartbeat periods, sees at least one
  `: ping`, and `res.writableEnded` is false; (e) with more symbols than `maxSymbols`, `hello.dropped`
  is non-empty and the first-listed (ticket) symbol is in `accepted`; (f) `trading-html-syntax.spec.ts`
  keeps parsing the new file because it lives under `tools/ui`.
- `docs/governance/real-boundary-regression-audit.md` — one row: boundary "Venue data-stream relay
  (Alpaca IEX websocket → kernel → store SSE)"; the store spec doubles the books resolver and the
  kernel subscribe; real companions are the kernel spec's real local `WebSocketServer` and a dated RTH
  observation of prints on the deployed paper ticket after Phase 3.

---

## Consequences

**Gained.** A ticket and a positions table that move on prints during regular hours for Alpaca-backed
books, with the feed named and staleness visible, at no data cost; a single kernel owner of the venue
session (one connection per key is a venue rule, enforced by architecture rather than convention);
a relay whose payload is an allowlist, so the credential boundary is a spec rather than a review note;
`/quote` finally reports the venue's print time instead of the request time; whole-market movers
become possible from the owned key (D5) without the paid screener the BACKLOG assumed; a written
purchase threshold instead of an open question.

**Costs and risks.** One data-stream connection per key: another process streaming with the paper
key (or a second api replica) gets 406 and the kernel enters `entitlement_blocked` — mitigated by
default-off, the cooldown, the `status` frame and the client's automatic return to the poll (never a
blank price). The 30-symbol cap: a book with many positions plus the ticket symbol exceeds it —
mitigated by ticket-first ordering (guarded server-side), the `dropped` list, and polling for the
dropped tail. IEX is a venue, not the tape: a displayed print can trail by basis points and freezes
outside 08:00-17:00 ET — the label and the stale greying carry that, and the order path never reads
the stream. Positions' Today $/% cannot be recomputed from prints without a prior close on the client
and stay the broker's values — stated in the footer. Live (Schwab) books do not stream in v1 and an
operator may expect parity — the as-of text names the source and D6 carries the follow-up. An api
restart drops the venue socket and every EventSource — `retry: 5000` plus kernel backoff recover it,
and resubscription is bounded by the refcounted union. Two more store files and one more kernel module
to keep under the size limits.

**Rejected.** Opening the venue websocket from the browser (needs the key in the page — the
done-when forbids it); a second kernel SSE registry (stream-manager is task-keyed; a bespoke,
book-keyed route is smaller); buying SIP real-time for a display whose order path would still refuse
it (D4); a paid screener for movers when the owned key's screener answers 200 (D5); pricing orders
from the stream in v1 (D7).

## Status / open items

Decision recorded 2026-09-06; **no code shipped in this pass** — the ticket polls exactly as before.
Open for the implementing wave: Phase 1 and Phase 2 of D9 with their named guard specs; the operator
decision to arm `TRADING_STREAM_ENABLED` (requires that nothing else streams with the paper key — the
code base has no other consumer; external tools on the same key are the operator's knowledge); the
D5 screener source behind the movers report; the deferred Schwab streamer (D6, BACKLOG). Purchase
triggers are named in D1 — none is met today (`TRADING_EXTENDED_HOURS=false` since 2026-07-12; no
intraday strategy armed; the order path does not read the stream).

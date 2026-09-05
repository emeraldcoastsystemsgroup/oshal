# Intelligent Trades (`trading/`)

Signal-justified stock trading (ADR-052) — carved out of OSHAL core 2026-07-20
(ADR-085 Wave 3, "skill with a surface"). **Install by directory name:**
`node scripts/oshal-app.js install trading` — the app's registered NAME stays
`intelligent-trades` (the exact identity the kernel manifest carried), so
`?app=intelligent-trades` URLs, the default tile, guest-tier records, and the
`intelligent-trades` queue id survive unchanged.

## What this package is

- The four route surfaces the kernel used to hard-mount, byte-identical bodies:
  - `/api/trading` (`service-or-oidc`) — surface + book reads, signal → decision →
    order flow, `POST /trigger` (its route-level live-approval gate ships verbatim:
    live tickets park in `backlog`; paper auto-approves), algo + tuning routes.
  - `/api/trading/autopilot` (`service-or-oidc`) — the operator switch over the
    kernel-resident advisor schedules (the loops themselves stay kernel).
  - `/api/trading/lab` (`service-or-oidc`) — the ADR-092 Strategy Lab (backtests,
    forward walks, regressions, ADR-095 apply/revert with its confirm guard) plus
    the **Strategy Studio** conversational endpoints (`POST /draft`, `POST /studio`).
  - `/api/trading-charts` (`public`, self-guarded) — the vendored chart lib
    (public MIT asset from `tools/vendor/`) + `GET /bars` (callerSub 401).
- `tools/trading.html` + `tools/vendor/lightweight-charts.js` (the surface).
- Registrar COPIES of the three personas (trading-analyst, trading-research-analyst,
  weather-analyst) — the kernel registry entries + ai-lab personas stay framework-resident.
- The five `trading_*` cli tools over the KERNEL-resident `scripts/oshal-trade-ops.js`.
- `tests/` — the guards that carved WITH their subjects:
  `trading-performance-fallback.spec.ts` (the /performance SPY-base regression),
  `trading-surface-live-gate.spec.ts` (the surface's live/confirm gates), and
  `trading-strategy-studio-refine.spec.ts` (the Studio refine-in-place contract).

## Using the surface (ADR-136)

The surface (`tools/trading.html` + `tools/ui/*.js`, served at `/api/trading/`) has four top-level
views — **Accounts · Strategies · Research · Reports** — in the header nav, plus one account-detail
screen reached by clicking a tile. There is no ten-tab bar and no "Accounts & books" tab; every tab
the surface used to carry lives in exactly one of the five screens below.

The cockpit's bottom status bar (bots / tickets / cost / queue depth) is hidden while this app is
focused: the manifest sets `ribbon.hideStatusBar: true` (1.9.1) because that bar is swarm-operator
telemetry, not trading state. A plain `/cockpit/` still shows it.

- **Accounts (landing).** One tile per account: equity, day P&L, the strategy it runs (or
  "Production baseline" if none is set), a TRADING / VIEW-ONLY pill, and Start/Stop for a live
  account. Above the tiles: a consolidated total value and day change across every account. Below:
  a cross-account open-positions rollup (which account each position is held in) and the discovered
  Schwab accounts roster with **Discover accounts**. Click a tile to open that account; Paper is one
  tile like any other, labelled "Paper (reference book)".
- **Account detail** (a tile, or the header's account switcher/`← All accounts`). Holds only that
  account's concerns: KPI strip; **Buy a stock**; open positions; the focus pane (chart, signal
  model, order ticket — opens when you click a position); and the account's own Trade journal +
  Performance sub-tabs. The header shows the account's strategy line with an inline **Set** /
  **Reset** control next to it — changing strategy never requires leaving the account.
- **Strategies.** The **Account strategies** roster is the first sub-tab — one row per account, what
  it runs, and Set/Reset — because this is where you choose what each account trades. Every account
  always runs exactly one strategy: a saved one from the Strategy Library, or the Production
  baseline by default. Strategy Lab, Strategy Studio, and Tuning follow as the remaining sub-tabs
  (design/backtest/apply and the conversational Studio described below).
- **Research** (market-wide, not account-scoped). Recommendations, Algorithms, and Capture &
  signals. A signal or decision made from here files against the account currently selected in the
  header's account switcher.
- **Reports.** Performance and Trade journal, each with its own account selector so you can flip
  accounts without leaving Reports. Cross-account positions live on the Accounts landing page, not
  here.

Deep links: `?view=accounts|strategies|research|reports` for the four top-level views, and
`?view=account&book=<ref>&sub=journal|perf` for a specific account's journal or performance sub-tab.
Legacy `?tab=` links (`journal`, `perf`, `lab`, `studio`, `tuning`, `accounts`, `reco`, `algos`,
`capture`, `summary`) still resolve — they map onto the view above that now holds that content.

### Buy a stock (direct trades, ADR-136 D3)

**Buy a stock** on an account's detail page opens a 3-step ticket:

1. **Pick the stock** — type a ticker and look it up (`GET /api/trading/quote`); the chart and
   signal model open alongside while you size the order.
2. **Size & price rule** — shares or a dollar amount (rounded down to whole shares), and a
   plain-word price rule that maps onto the same order types the broker already runs:
   - *Buy now at market* → `market`
   - *Only if it drops to a price* → `limit`
   - *Only once it breaks above a price* → `stop`
   - *Break above, but not more than* → `stop_limit`
   - *Protect with a trailing stop* (sell-side only) → `trailing_stop`
   Time in force is **Today only (day)** or **Until cancelled (GTC)**.
3. **Confirm** — names the account and shows the order in one sentence plus the estimated total. A
   live account requires an explicit confirm before anything is sent.

Direct trades do **not** follow the account's strategy — there is no signal generation involved —
but they pass through the identical guardrails, live gate, submission-reservation arbiter, and
disabled-book refusal as every strategy-originated order; there is one order path, not two.

### API added in 1.6.0

- `GET /api/trading/quote?symbol=` — latest price for the selected account's book (Alpaca for paper,
  Schwab for a live account); 503 if market data isn't connected for that book.
- `POST /api/trading/decisions/manual` — mints the operator-authored decision the ticket then
  executes with the existing `POST /api/trading/orders`. Body: `symbol`, `side` (`buy`/`sell`),
  exactly one of `qty` or `notional`, `orderType` (`market`/`limit`/`stop`/`stop_limit`/
  `trailing_stop`), the matching `limitPrice`/`stopPrice`/`trailPercent`/`trailPrice`,
  `timeInForce` (`day`/`gtc`), optional `rationale`, and `book`/`mode` (also accepted as query
  params, query wins). Returns `decisionId`, `refPrice`, `estNotional`, and `requiresConfirm`.
- Static UI modules at `/api/trading/ui/*` (`app.js`, `ticket.js`, `shared-positions.js`,
  `view-accounts.js`, `view-account.js`, `view-strategies.js`, `view-research.js`,
  `view-reports.js`) — same-origin, auth-gated the same way as the rest of the surface.

## Strategy Studio (conversational design + refine-in-place)

The **Strategy Studio** tab is a chat (typed or spoken) with the trading-analyst bot.
A message becomes a research-grounded design: the analyst cites the curated corpus in
`src-routes/trading-strategy-research.ts` (invented citations are dropped at parse),
drafts a `StrategyConfig`, saves it to the caller's Strategy Lab as a candidate, runs
a real ~2-year backtest, and narrates the result (shown + spoken via `/api/voice`).

Follow-up messages **refine the SAME strategy in place** (the workflow-assistant
contract): the current config feeds back into the prompt, only what was asked
changes, and the store resets the forward walk + baseline on the config change.
An unmappable or ambiguous ask returns `{ needsInput, message }` — a clarifying
question in the chat — never an error. Blends are refused conversationally (their
components are embedded snapshots; rebuild them in the Lab). Prompt + parse live in
`src-routes/trading-strategy-studio-prompt.ts`.

Going live stays human-gated: the studio result's **Apply live…** button runs the
same percent-of-profile prompt + `confirm:true` gate as the Lab's Apply, and refining
a strategy that is currently applied never touches the live override (it keeps its
embedded snapshot until re-applied — the response says so explicitly).

## What stays in the OSHAL framework (ADR-093)

The ENGINE and the autopilot: `src/features/trading` (broker adapters, market data,
algorithms, sizing, risk policies), every `src/app/trading-*.ts` module —
`trading-engine.ts` (`placeDecisionOrder` with the env-level `live_blocked` gate:
`TRADING_LIVE_ENABLED` + explicit confirm — kernel-guarded by
`tests/unit/risky-write-guards.spec.ts`), `trading-schema.ts`, the 8
dispatch/reconcile loops, the strategy-lab sim/ops/store, config overrides,
strategy params, the equity/rotation/peaks stores — plus
`trading-routes-helpers.ts`, the bot containers + registries, migrations
034/035/072, all `TRADING_*` env, the schedule pins, `strategy-log.md`, the
watchdog + daily-recap CLIs, and the default ribbon tile.

## Build

```bash
node scripts/oshal-app.js build trading --framework <oshal-checkout>
node scripts/oshal-app.js validate trading
```

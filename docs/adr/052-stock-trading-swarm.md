# ADR-052 — Stock-trading swarm: signal-justified execution with dual ledgers (Alpaca)

- **Status:** Accepted — implemented and extended far past this ADR (reconciled 2026-07-31): the trading stack is a live feature slice (`src/features/trading/` + the `scripts/oshal-*` trading CLI suite, incl. the shared ensemble engine `scripts/oshal-algos.js`); see ADR-053 (“built out well past this ADR”), ADR-092 (strategy lab), ADR-095 (strategy library), ADR-096 (shadow indicators)
- **Date:** 2026-06-18
- **Related:** [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-037 (communications swarm — the social/news sensing service)](037-communications-swarm.md),
  [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md),
  [ADR-048 (read-only finance aggregation — the bundle this was split off from)](048-finance-aggregation-swarm.md)

## Context

ADR-048 drew a hard line: Finance is **read-only aggregation**, and "trade execution (SnapTrade /
broker APIs) is broker-dealer territory, a separately-regulated later bundle." This is that bundle.
The operator is now ready to build it as its own app, not an add-on to Finance.

The triggering capability already exists on the **sensing** side and is running today:

- **News feed engine** ([scripts/oshal-research.js](../../scripts/oshal-research.js)) pulls 11+ keyless
  sources (HN, Reddit, and RSS incl. Yahoo Finance / CNBC / WSJ Tech). It is already a market/topic
  sensor — e.g. Yahoo Finance single-ticker stock items — and needs no paywall.
- **X/Twitter** identity + posting work ([scripts/oshal-x.js](../../scripts/oshal-x.js)); the timeline
  **read** sensor is built ([scripts/oshal-x-read.js](../../scripts/oshal-x-read.js)) but X's free tier
  returns HTTP 402 on reads — it lights up only with X Basic (~$100/mo). Free-tier sensing comes from
  the news stream and the email-notification ingest pipe (`inbox-ingest.ts`, `oshal_inbox_messages`).

The BACKLOG (social-sensing vision, 2026-06-15/16) names this exact app: the **stock-trading bot**
subscribes to the sensing service ("notify me if @realDonaldTrump tweets something market-moving"); a
match XADDs a signal to `oshal:mesh:agent.{tradingBot}`; the bot then *considers a trade*. That
mesh/selector "subscribing bots" layer was deferred **until the trading-trigger feature was on the
table.** It is now.

The operator set three non-negotiable requirements that shape everything below:

1. **Both modes, two ledgers, both first-class.** The system must paper-trade against a *pretend
   ledger* **and** live-trade against a *real ledger* — not paper-as-a-test-mode-flag, but two
   parallel books that are each complete and queryable.
2. **Snapshot the data streams.** When a signal is read, the system retains a financial snapshot of
   the stream at that moment (the tweet, the headline, the price/indicator values it saw) — not a
   live re-fetch later.
3. **Every trade is justified and traceable.** Each trade carries a recorded decision tree linking
   the order → the indicators that triggered it → the exact source artifact (e.g. the tweet) → the
   bot's reasoning. Nothing executes without that justification persisted first. "If it reads a tweet
   and decides the market could move, it keeps a document of the decision tree with the trade and a
   reference to the tweet."

## Decision

Build a **trading** swarm app on the same bundled-by-type, bot-owned shape as Finance (ADR-038 /
ADR-036 / ADR-048), with a rail-neutral broker adapter and a strict **signal → decision → order**
provenance chain enforced at the data layer.

### 1. Rail-neutral `BrokerAdapter` (Alpaca first)

Mirror the `PaymentAdapter` pattern from ADR-048's addendum. The rest of OSHAL depends on a
broker-neutral interface; `getBrokerAdapter()` selects the concrete broker from `BROKER_PROVIDER`.
Adding a broker (Schwab/SnapTrade, IBKR) = a sibling adapter, nothing else.

- Interface (in `src/features/trading/`): `placeOrder` / `getOrder` / `cancelOrder` / `getPositions`
  / `getAccount` / `configured` / `mode()` (`'paper' | 'live'`).
- **First broker = Alpaca** (`alpaca-broker-adapter.ts`), `fetch`-based (no SDK). Alpaca exposes two
  fully separate base URLs — `paper-api.alpaca.markets` and `api.alpaca.markets` — with **distinct key
  pairs**. The adapter is instantiated per mode; the paper instance and live instance never share
  credentials or a base URL. This is what makes "both ledgers" real rather than a label: each mode
  talks to a physically different Alpaca account.
- Deterministic HTTPS I/O on the controller (same as `finance-plaid.ts` / SmartThings in
  `home-routes`) — **no LLM in the execution path.**

### 2. Dual ledger as a first-class `mode` dimension

Every trading store is keyed by `(user_sub, mode)` where `mode ∈ {paper, live}`. Both books use the
same schema and the same code path; queries filter by mode. The two ledgers are independent: a paper
fill never touches the real book and vice-versa. The UI always shows which book it is reading and
**defaults to `paper`**; switching to `live` is an explicit, separately-gated action.

### 3. The provenance chain (the heart of this ADR)

Three owner-scoped, `(user_sub, mode)`-keyed stores, with the chain enforced by foreign keys and a
hard guard:

- **`oshal_trading_signals`** — the captured snapshot. One row per ingested sensor event: `source`
  (`news` | `x` | `inbox` | `manual`), the **raw artifact** (tweet text + tweet id/url, or headline +
  link), a `content_hash` for dedup, the symbols/entities extracted, any indicator values observed at
  that instant (price, %move, volume), and `observed_at`. Immutable once written. This is the
  "financial snapshot of the data stream."
- **`oshal_trading_decisions`** — the decision tree. References one or more `signal_id`s, and records
  the bot's structured rationale: the hypothesis ("@X tweeted Y → ticker Z may move"), the indicators
  weighed, confidence, the proposed action (symbol/side/qty/limit), and the guardrail checks applied.
  Produced by the **`trading-analyst`** bot (reasoning only). A decision can resolve to *no trade* —
  those are kept too (a justified non-action is auditable).
- **`oshal_trading_orders`** — the order/ledger entry. **Every order row REQUIRES a non-null
  `decision_id`** (FK + a route-level guard that refuses an order with no decision). Carries `mode`,
  the broker order id, side/qty/type/limit, status, fills, realized P&L, and timestamps. Positions and
  P&L are derived per `(user_sub, mode)` from this table.

Result: from any order you can walk back order → decision → signal → the exact tweet/headline and the
indicator values that were true when the call was made. From any tweet you can find every decision and
trade it drove. Nothing executes that isn't already justified in writing.

### 4. Reasoning on the accountable bot; sensing via the mesh

- **`trading-analyst`** bot (persona `ai-lab/bot-personas/trading-analyst.yaml`), **reason-only,
  inline on the api container** (claude-code, new agentId), invoked via `BotNodeClient.execute` with
  `direct:true` so per-call cost lands in `chat_tasks` under its own id — same path as
  finance-analyst / kid-lens. It never holds broker keys and never calls the broker; it emits a
  decision, the controller executes.
- **Sensing reuses ADR-037's service, not a new scraper.** This finally builds the deferred mesh
  layer: a bot registers a watch (account / keyword / ticker / topic); the sensing service matches
  ingested events (news stream free today; X sensor when Basic is enabled) and XADDs to
  `oshal:mesh:agent.{tradingBot}`. The trading controller consumes that stream, snapshots the event
  into `oshal_trading_signals`, and asks `trading-analyst` for a decision.

### 5. Surface + CLI harness

- **Surface** `src/api/trading.html` (manifest `swarm-apps/trading.yaml`, theme distinct from
  Finance's evergreen): a prominent **PAPER / LIVE** book switch, positions + P&L for the active book,
  the signal feed, and — per decision — an expandable **"why" panel** showing the full
  signal→decision→order tree. Live orders require an explicit confirm with a live-mode banner.
- **`scripts/oshal-trading.js`** is the canonical data-access CLI **and** the localhost test harness:
  it drives the full pipeline against **Alpaca paper** with no UI, satisfying the human-testability
  gate before any live keys exist. Paper keys are instant; live is operator-gated (below).

## Consequences

- **Auditability is structural, not best-effort.** Because `orders.decision_id` is NOT NULL and
  decisions reference signals, an unjustified trade is *unrepresentable*. Every fill has a paper trail
  to a source artifact and the indicators that moved the bot.
- **Paper and live are genuinely isolated.** Distinct Alpaca accounts + a `mode` partition on every
  store means a bug in the paper path cannot place a real order, and the real book is a true record,
  not a simulation with a flag.
- **Cost + ownership accounting hold** (ADR-036): the only LLM work (the decision) runs on the bot;
  execution is deterministic controller I/O; every store is `(user_sub, mode)`-keyed and auth-gated.
- **The deferred mesh layer ships here.** This is the first concrete consumer of the BACKLOG
  social-sensing "subscribing bots" design; it should be built as the general watch→notify capability,
  with trading as its first subscriber, so other bots can reuse it.
- **Regulatory + security gating is the gate, not a footnote.** Read-only finance was ~10% of the
  risk; placing live orders with someone else's money is broker-dealer / investment-adviser territory.
  v1 must ship **paper-only by default**; live mode stays dark until: (a) the operator creates the
  Alpaca app under the business email (partner-app rule) and sets live keys; (b) a documented review
  of the compliance posture (who is the adviser of record, suitability, disclosures, who bears
  loss) — analogous to Plaid production access and the Stripe money-movement review in ADR-048. **This
  ADR does not authorize live trading; it authorizes the architecture and a paper-only v1.**
- **No crypto, no options, no margin in v1** — cash equities, long only, market/limit orders.
  Each is a later, separately-scoped expansion.
- **Honest v1 limits / deferred:** real-time market-data subscription (v1 uses Alpaca's bundled data +
  the news stream, not a paid L1/L2 feed); backtesting the decision logic against history; portfolio
  risk limits beyond per-order guardrails; multi-broker; tax-lot accounting on the real ledger.

## Addendum (2026-06-18) — paper-scope expansion: full order-type matrix + shorting

The original decision scoped v1 to market/limit, long-only. To let the test harness exercise the
full trade matrix on the **paper** book, the operator widened paper scope (this does NOT change the
live posture — live stays gated and is the subject of the open questions below):

- **Order types:** the complete Alpaca equity set — `market`, `limit`, `stop`, `stop_limit`,
  `trailing_stop` — carried on both the decision (what the bot proposed) and the order (what was
  placed). New columns `stop_price` / `trail_price` / `trail_percent` / `time_in_force` (migration
  035, idempotent; routes `ensureSchema` self-heals).
- **Direction:** long AND short. A `sell` with no/short position opens/extends a short
  (`shorting_enabled` is true on the paper account). The route's long-only assumption was removed.
- **Credential aliases:** the Alpaca adapter resolves `ALPACA_PAPER_*` first, then aliases
  (`ALPACA_KEY`/`ALPACA_SECRET`, the misspelled `ALPAKA_*`, and an `ALPACA_ENDPOINT` whose trailing
  `/v2` is stripped) → the paper book, so an existing operator `.env` works unchanged. These pass
  into the container via the compose `*bot-env` anchor.
- **Self-test harness:** `scripts/oshal-trading.js selftest <sub> [symbol]` places one of every
  order type (long + a short) on paper with far-from-market prices so they rest, proves each is
  accepted through the real signal→decision→order chain, then cancels them so the account is left
  flat. This is the human-testability gate for "can it execute all the trade types."
- **Still gated:** live execution is unchanged — `TRADING_LIVE_ENABLED` + per-order confirm, and
  the long-only/instrument questions below should be re-confirmed before any live order. Shorting
  and stop/trailing on the LIVE book are explicitly out of scope until that review.

## Operator sign-off — answered as built (reconciled 2026-08-02)

This section was written as *"open questions for operator sign-off (before any code)"*. The code
shipped; two of the three were answered **in the implementation**, and leaving them framed as
pre-code questions misread a live system as unstarted. The third is genuinely still open and stays
marked as such — it is the gate on live mode leaving the operator's own account.

1. ✅ **Autonomy — the proposal was adopted, and live took a second lock.** Paper may auto-execute
   within the guardrails; live needs **both** an environment arm and a per-order confirm:
   `placeDecisionOrder` refuses with `403 live_blocked` unless `TRADING_LIVE_ENABLED === 'true'`
   *and* the caller passed `confirm: true` ([trading-engine.ts](../../src/app/trading-engine.ts)).
   The autonomous path is stricter still — a scheduled live leg needs the **double opt-in**
   `TRADING_LIVE_ENABLED` **and** `TRADING_AUTOPILOT_LIVE`, both defaulting off in
   `docker-compose.oshal-local.yml`, so the cron stays on the paper book even on an armed box. A
   global `TRADING_HALT=true` kill switch refuses every leg. Reads were deliberately split from the
   arm (`getBrokerReader` vs `getBrokerAdapter`): a connected live account stays *readable* —
   balances, positions, order status, and reconciliation — while trading is disarmed, because
   halting must not stop the ledger from syncing.
2. ✅ **Guardrails — defaults set, enforced on the order path, and recorded on every decision.**
   `guardrails()` / `guardrailViolation()`
   ([trading-routes-helpers.ts](../../src/app/routes/trading-routes-helpers.ts)) enforce
   `TRADING_MAX_QTY` (default **100** shares), `TRADING_MAX_NOTIONAL_USD` (default **$1,000**), and
   an opt-in `TRADING_SYMBOL_ALLOWLIST` (default empty = no allow-list restriction). A breach is a
   `422 guardrail_blocked` **before** the broker is called, and the active guardrail set is written
   into the `guardrails` column of `oshal_trading_decisions` so an audit can see the bounds each
   decision was made under. The trading-hours window is enforced separately by session logic in
   [market-data.ts](../../src/features/trading/services/market-data.ts) (extended hours are their
   own opt-in), not by this guardrail struct. **Deliberately NOT built:** a max-daily-orders cap —
   the sizing bound is notional, not order count.
3. ⬜ **Adviser of record + live-mode disclosure — STILL OPEN, and still the gate.** No adviser of
   record has been named and no disclosure copy has been written; a repo-wide search for one finds
   nothing. The posture this holds in place is unchanged from the original decision: live mode is
   the operator's **own** account, `TRADING_LIVE_ENABLED` defaults false, and **this ADR still does
   not authorize live trading for anyone else's money.** Until this question is answered by a human,
   the compliance review named in Consequences has not happened, and the environment arm is the only
   thing standing between the two states.

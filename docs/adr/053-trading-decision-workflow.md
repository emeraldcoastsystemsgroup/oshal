# ADR-053 — Trading-decision workflow: signal → ticket → tool-bound bot → trade

- **Status:** Accepted — built out well past this ADR (see below)
- **Date:** 2026-06-18

> **As-built (2026-06-24):** this ADR captured the original signal→ticket→bot→trade workflow. The
> advisor has since grown into a five-leg autonomous system (autopilot / research / fast / assess /
> overnight review) with a portfolio money-manager, rotation, extended-hours trading, a protection
> stack (drawdown breaker + kill-switch), a backtest, and an overnight signal-learning loop
> (per-signal mass + proximity fed back into the ensemble). The current, maintained reference is
> **[docs/apps/trading/advisor.md](../apps/trading/advisor.md)** — read that for what runs today; the sections
> below are the historical design record.

- **Related:** [ADR-052 (stock-trading swarm)](052-stock-trading-swarm.md),
  [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-025 (dynamic tool executor registry)](025-dynamic-tool-executor-registry.md),
  [ADR-037 (communications swarm — sensing service)](037-communications-swarm.md)

## Context

ADR-052 built the execution layer + the interactive capture→decide→execute path and the
signal→decision→order provenance chain. The operator now wants the trades to flow through the
**swarm's own ticket queue** as a first-class workflow, not just the interactive route:

> "a new ticket queue that the trades run through … the signal triggers the workflow ticket, the
> stock bot runs his tools (even if we don't have the tools yet) — they're loaded by the tool
> factory so he knows what tool goes with what signal when the tools load at prompt time. And
> there'll be cron jobs and heuristics run on the data to trigger signals, plus sentiment and
> political-paper feeds."

That decomposes into three layers on top of ADR-052's execution core:

1. **Workflow** — a captured signal opens a `trading-decision` ticket; the queue routes it to the
   trading-analyst bot, which runs tools and decides.
2. **Tools (tool-factory bound)** — the bot's tools (fetch quote, place order, etc.) are registered
   with the dynamic tool registry and loaded into the bot's prompt at dispatch time, so the bot
   picks "the tool that goes with this signal" without code per signal type.
3. **Signal generation** — cron jobs + heuristics over the data, plus sentiment + political-paper
   feeds, emit signals that fire the trigger.

## Decision

Reuse the existing swarm plumbing (ticketing → queue-manager → manifest-worker dispatch → bot;
dynamic-tool-executor-registry for tools; scheduling runtime for cron) rather than build a parallel
trading runtime. The trading domain contributes a ticketType, a trigger, tools, and signal
generators — the framework does the routing, dispatch, and prompt assembly.

### 1. Workflow (BUILT this iteration)

- `swarm-apps/trading.yaml` declares `ticketType: trading-decision` and `workflow: { pipeline:
  trading, workerBot: trading-analyst }`. A custom `pipeline` value (≠ `incident-rca`/`swarm`) with
  a `workerBot` routes via `chooseDispatchPath → dispatchManifestWorkerTicket`, which resolves the
  persona name to the agentId (`…0045`) and invokes it through `BotNodeClient.execute`.
- **`POST /api/trading/trigger`** (in `trading-routes.ts`): body `{ mode?, signalIds[] }`. It loads
  the caller's captured signals and creates a `trading-decision` ticket (via
  `ctx.ticketService.createTicket`, schema-parsed for defaults) whose **payload carries the
  signalIds**, so the bot reasons over the SAME artifacts the provenance chain already stores.
- The ticket is created in `backlog` (needs approval). **Auto-approval is the ADR-052 autonomy
  gate**: paper may later auto-approve within guardrails; live always requires sign-off. Until then
  an operator approves it and the queue-manager dispatches it.

### 2. Tools, loaded by the tool factory at prompt time (PENDING)

- Tools register through `RuntimeToolRegistrationService.registerRuntimeTool` (descriptor =
  `builtin | cli | api | mcp`) and attach to the trading-analyst via
  `CapabilityExpansionService.expand`. At dispatch the bot's `allowed_tools`/capabilities resolve
  through the `DynamicToolExecutorRegistry` into the LLM tool list (capped at MAX_PROMPT_TOOLS),
  assembled in `tool-runtime-context.ts`. So a tool added to the registry simply appears in the
  bot's prompt — no per-signal code.
- **First tools to register** (each an `api` descriptor over the existing routes, so they reuse the
  provenance chain): `trading.quote` (latest price), `trading.place_order` (→ `POST /orders` against
  a decision), `trading.positions`, `trading.account`. "Which tool goes with which signal" is the
  bot's job at reason time, given the tool descriptions — not a hard-coded map.
- **Honest gap:** these tools are not registered yet. Today the bot, when dispatched a
  trading-decision ticket, can *reason and record a decision* but cannot place the order itself
  (the interactive route still does execution). Wiring `place_order` as a registered tool is the
  next discrete step.

### 3. Signal generators — cron + heuristics + sentiment/political (PARTIALLY BUILT)

- **BUILT — the every-5-minutes multi-timeframe autopilot.** The scheduling runtime
  (`schedule-runtime.ts`, `ENABLE_AGENT_SCHEDULER`, `SCHEDULER_POLL_INTERVAL_MS`) now has a
  **trading-autopilot dispatch branch** (`trading-schedule-dispatch.ts`) that mirrors the home
  branch: a per-user `trading-autopilot:<sub>` schedule (default cron `*/5 * * * *`) fires the
  deterministic loop in the controller. Each fire reads every watched ticker's trend across FIVE
  timeframes — 5-minute, hourly, daily, weekly, and quarterly (3-month) bars — via the
  multi-timeframe engine (`multi-timeframe.ts`: the existing `scoreSymbol`/`ensemble` run per
  timeframe, weighted toward the longer trends, with a **regime-alignment risk gate** so the bot
  never buys into a bearish higher-timeframe trend). Actionable names are sized by conviction
  within the guardrails and placed through the SAME `placeDecisionOrder` core the interactive route
  uses, so the **signal → decision → order** provenance chain holds end-to-end. The
  controller-side deterministic path is consistent with `/scan` + `/decide-algo` (no LLM here).
  **PAPER-ONLY**: autonomous live trading is refused from the cron — live stays behind the ADR-052
  manual sign-off. Operator switch: `POST/GET/DELETE /api/trading/autopilot`
  (`trading-autopilot-routes.ts`). Default universe is ~100 names across tech / financials /
  blue-chip / energy / pharma. **Requires Alpaca paper keys + `ENABLE_AGENT_SCHEDULER=true`**; runs
  self-skip when the market is closed or keys are absent.
- **PENDING — event/sentiment/political signal sources.** Heuristics over the news stream
  (`scripts/oshal-research.js`), the inbox-ingest store, sentiment scoring, and political-paper/poll
  feeds calling `POST /api/trading/signals` → `POST /api/trading/trigger` (the LLM-reasoned path)
  remain the next sources, feeding the same capture→trigger pipeline.
- This reuses ADR-037's deferred mesh "watch → notify" idea, but lands it concretely as
  scheduled-job → trade rather than a bespoke mesh subscriber first.

## Consequences

- **One queue, one audit trail.** Trades flow through the same ticket lifecycle as everything else
  (approval, cost rollup, status), and the signalIds in the payload keep the ADR-052 provenance
  chain intact end-to-end: ticket → decision → order → signal.
- **Tools are additive.** New capabilities are registry entries + a capability-expansion call; the
  bot discovers them at prompt time. No trading-specific branching in the dispatcher.
- **Autonomy stays gated.** Tickets default to needing approval; auto-approve (paper) and any live
  flow remain behind the ADR-052 sign-off. The cron can *propose* (open tickets) before the loop is
  allowed to *act*.
- **Built vs pending is explicit** (per the as-built-honesty rule): the workflow routing + trigger
  are built; the registered execution tool and the cron/sentiment signal generators are the next
  steps and are not yet wired.

## Next steps (discrete, each verifiable)

1. Register `trading.place_order` (+ quote/positions/account) tools and attach to trading-analyst;
   confirm they appear in the bot's prompt and a dispatched ticket can place a paper order.
2. Decide the paper auto-approve policy and wire it (live stays manual).
3. ~~Add the first scheduled signal generator~~ **DONE** — the every-5-minutes multi-timeframe
   autopilot (deterministic, paper-only) is built; see section 3 above.
4. Add sentiment scoring + a political-paper/poll feed as additional (LLM-reasoned) signal sources.
5. Add a "scheduled trade" surface on the trading page that calls `POST /api/trading/autopilot`
   (the route exists; the cockpit toggle is the remaining UI work).

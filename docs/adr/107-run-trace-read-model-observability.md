# ADR-107: Run-trace read-model observability

**Status:** Accepted (2026-07-16) — BUILT + DEPLOYED in the 2026-07-15/16 gap-list round2.
Feature slice `src/features/run-trace`, routes `/api/trace/:ticketId(.html)` + `/api/trace/app`,
surface `tool-run-trace`. No migration. As-built:
[platform-shared-services.md](../architecture/platform-shared-services.md).

## Context

Every incident session (jarvis-visuals, the event-loop wedge, trading-watchdog triage) reconstructed
the same thing by hand from `docker logs`: what did this ticket *do* — which phases, which bots,
which LLM calls, what did each cost, and where did the time go. There was no single view of a
ticket's execution timeline.

The obvious implementation — thread a correlation ID through the controller → mesh → bot → LLM-call
boundary — is **invasive and risky**: it touches the hot dispatch path and the JS execution layer,
across the very controller/bot boundary the two-runtimes rule keeps clean. The insight that avoided
it: the data **already exists**, persisted in separate tables. A trace is a *read-model*, not new
instrumentation. (The Token Chase debugger view covers *captured* runs; this generalizes to *any*
ticket.)

## Decision

1. **Assemble from existing rows — no new instrumentation.** `TraceService.getTrace` joins what's
   already there: phase spans from `ticket_status_history`, bot spans from `ticket_task_links ⋈
   chat_tasks`, per-LLM-call cost spans from `oshal_cost_events`. Spans merge into one array sorted
   by time. **Never fabricate a span** — no history ⇒ no phase spans; the ledger has no per-event
   token/duration ⇒ those fields are left `undefined` (real tokens live on the bot span).
2. **Totals reconcile with budgets.** `totals.costUsd` sums the same `oshal_cost_events` ledger the
   ADR-104 budget query uses, so the trace total equals the budget number (not the `chat_tasks`
   lifetime rollup).
3. **Authorize before reading children, no existence leak.** Ownership is checked on `owner_sub`
   *before* any child query; a non-owner, a missing id, and a malformed id all return the **same**
   null, so ticket ids aren't oracle-able. Operator sees any.
4. **A platform tool, not an app.** Ribbon entry `tool-run-trace` + auth-gated `/api/trace`; no bot,
   no concierge, no manifest — tracing isn't owned by any one app and involves no LLM reasoning.

## Consequences

- Zero blast radius on the dispatch path — nothing new is written at runtime; the trace is pure read.
- If the `oshal_cost_events` ledger was never populated for old tasks, the ledger sum can read lower
  than the bot rollup — honest surfacing of a real data gap, consistent 0/0 on the empty case, not a
  bug.
- **Deferred (BACKLOG):** per-LLM-call tokens + durations on llm-call spans — purely additive (add
  columns to `oshal_cost_events` + have `recordCost` write them + populate the span); the trace
  already leaves those fields `undefined` so it's forward-compatible.
- Establishes the "observability = read-model over existing rows" pattern for future cross-cutting
  views.

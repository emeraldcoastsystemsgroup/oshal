# ADR-023: Dispatch Circuit Breaker and Work Item Dedup for Completed Rounds

## Status
Accepted — 2026-03-25

## Context
During Session 109 monitoring, we observed an infinite re-dispatch loop on ticket `550c19db`. The ticket had 252 timeline events — 125 "Work item created" and 125 "Assigned to" — spanning 3+ hours, all for subtasks that had already been approved. No source code changed during this period; bots were re-running `npm test`, writing QA reports saying "approved", and then the pipeline re-assigned the same work items.

Two gaps caused this:

1. **No dispatch attempt limit.** The QueueManagerService would roll failed tickets back to `approved`, causing the next poll cycle to re-dispatch them indefinitely. There was no upper bound on how many times a ticket could be dispatched.

2. **Completed work items not blocked from re-creation.** The multi-round dispatch dedup guard in `MultiRoundDispatchService.dispatchRound()` checked for `pending` or `assigned` work items before creating a new one. But once a work item reached `completed` or `failed`, the guard let a new duplicate through — re-creating work for rounds that were already done.

## Decision

### Circuit Breaker (QueueManagerService)
- Track dispatch attempts per ticket in a `dispatchCounts` Map
- `MAX_DISPATCH_ATTEMPTS = 3` — after 3 dispatches, escalate instead of re-dispatching
- Applied in three places:
  - `pollCycle()` candidate filtering — skip tickets at the limit, escalate them
  - `rollbackTicket()` — refuse to roll back to `approved` if attempts exhausted, escalate instead
  - `dispatchTicket()` — log attempt number for observability
- Clear the counter on successful completion so legitimate retries aren't penalized

### Work Item Dedup for Completed Rounds (MultiRoundDispatchService)
- Extended the dedup guard to also check for `completed` and `failed` work items with matching `roundUnitId`
- If a completed/failed item exists for the same round, skip creation entirely and log the dedup hit
- This prevents re-creating work items for rounds that already produced output

### Ticket Terminal Check (SwarmAgentWorker)
- Added `isTicketTerminal` callback to the worker options
- Before processing any Redis stream envelope, the worker queries Postgres for the ticket's current status
- If the ticket is `complete` or `escalated`, the envelope is ACKed and skipped — no cline spawned
- This prevents stale Redis stream messages (which survive container restarts) from resurrecting dead tickets
- The check is non-fatal: if the DB query fails, execution proceeds normally

### Failed Round Abort (MultiRoundDispatchService)
- After each round completes, the output is inspected for `{ status: 'failed' }`
- If the round output indicates execution failure (cline exit code 1), the phase is **aborted** instead of advancing to the next round
- Previously, failed output was passed through `completeRound()` which treated it as success and advanced the pipeline

### Work Item Completion Cascade (QueueManagerService)
- When `dispatchTicket()` marks a ticket as `complete`, it now cascades to all associated work items
- Any work items in non-terminal states (`pending`, `assigned`, `executing`) are marked `completed`
- This prevents the worker's XAUTOCLAIM from re-claiming stale work items after ticket completion

## Consequences
- Tickets that fail 3 times get escalated for operator review instead of looping forever
- Token/compute waste from infinite re-dispatch loops is eliminated
- Completed rounds cannot be re-created, preventing duplicate QA churn
- Stale Redis stream messages cannot resurrect completed/escalated tickets
- Failed cline runs abort the phase instead of advancing with broken output
- Work item status stays consistent with ticket status after completion
- The dispatch count is in-memory (resets on container restart) — this is acceptable because a restart already breaks the in-flight pipeline loop
- Legitimate retry scenarios (e.g., transient network failure) still get 2 retries before escalation

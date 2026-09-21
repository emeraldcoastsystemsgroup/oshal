# ADR-163: The canonical escalation record is the transition, not `swarm_escalations`

## Status

Accepted — 2026-09-21. The store half and the cockpit half below are built in this change. There is
no backfill and no migration: the decision is about which of two existing records answers the
question, not about producing a new one.

## Context

Two tables record that a ticket escalated, and only one of them can see every escalation.

**`ticket_status_history`** holds one row per status transition. Every path that escalates a ticket
goes through `TicketService.updateStatus` or `updateStatusAs`
([ticket-service.ts](../../src/features/ticketing/services/ticket-service.ts)), and both route the
caller's metadata through `buildStatusTransitionMetadata`. Its `escalated` branch fills `reason`,
`source`, `severity`, `nextAction`, `previousStatus`, `ticketId` and `escalatedAt` whether or not the
caller named them, so an escalating transition that explains nothing is structurally impossible. The
same object is mirrored onto the ticket row as `metadata.lastStatusTransition`, for a reader that
cannot join history. Twenty-six call sites across seven services escalate a ticket this way
(`call-out-endpoint-routing`, `dispatch-graph-worker`, `dispatch-incident-worker`,
`dispatch-manifest-worker`, `parent-assembly-service`, `queue-manager-service`,
`queue-manager-sweeps`), and the cockpit's own status PUT adds an operator park on top of them.

**`swarm_escalations`** has exactly one writer. `persistEscalationRecord`
([swarm-ticket-lifecycle-helpers.ts](../../src/features/swarm-orchestration/services/swarm-ticket-lifecycle-helpers.ts))
is called from one place — `SwarmExecutionLifecycleService.finalizeTicketProcessing` — and it takes a
`runId` as its first argument. An escalation raised outside a swarm run has no run id, so it cannot
produce a row: not because the write is missing, but because the record has no value to put in a
`NOT NULL run_id` and nothing to put in `target`, `retry_class` or `attempt_state`, which are the
verification policy's own outputs.

The measurement that opened the backlog entry: on the operator box the table held 100 rows whose
newest was dated 2026-07-19, while tickets had escalated since.

The cockpit was built on the assumption that the durable store was the escalation log. It looked a
record up by ticket id (`GET /api/swarm/escalations?ticketExternalId=…`) and rendered it, so an
escalation raised by a dispatch failure or an operator park rendered as "no escalation reason was
recorded" while `ticket_status_history` held the reason all along. Two repairs have already landed
against that assumption — the activity payload now projects the recorded transition detail, and
`selectEscalationDetail` stopped letting an empty durable lookup erase it — but the *precedence* was
never revisited: the durable record still won whenever it named a reason. That left the cockpit
leading with the record that answers a strict subset of escalations, and it produced a second,
subtler failure that needed its own repair: the by-ticket lookup returns the ticket's newest row, not
one scoped to the escalation on screen, so a ticket that escalated, was de-escalated and escalated
again was explained by a closed run's record until the record was dated against the transition.

What was unresolved is what the durable store is *for*. Left undecided, it reads as a half-populated
escalation log, which is the worst of the two readings: an operator who queries it sees a fraction of
the escalations and no indication that the rest exist.

## Decision

**D1. The canonical escalation record is the `escalated` transition in `ticket_status_history`,**
mirrored on the ticket row as `metadata.lastStatusTransition`. It is the record every escalating path
writes, it carries the closed-vocabulary `reason` and the `nextAction` derived from it, and it is the
record any surface, report or query about "why did this ticket escalate" reads.

**D2. `swarm_escalations` is a run-scoped verification-attempt record, not an escalation log.** It
records what a swarm run's execution policy knew at the moment it gave up: the escalation target, the
retry class, and the attempt snapshot (`verificationAttempt`, `buildRegressionCount`,
`designRegressionCount`). A run id is therefore part of what the record *is*, and
`SwarmEscalationStore.save` refuses a record without one instead of writing a row that claims to be a
run's attempt state while naming no run. The refusal is raised to the caller;
`persistEscalationRecord` already logs and swallows store failures, so a swarm cycle is not broken by
it.

**D3. The cockpit stops treating `swarm_escalations` as its primary escalation lookup.**
`selectEscalationDetail` ([ticket-view-helpers.js](../../src/pages/cockpit/js/views/ticket-view-helpers.js))
leads with the canonical transition detail and lets a current run record contribute only the fields a
run knows — `target`, `retryClass`, `attemptState`. A ticket with no durable record is the normal
case, not a gap; a durable record that predates the escalation on screen is still discarded before
any of this applies.

**D4. Explicitly not done.** No new writer, no nullable `run_id`, no backfill, no new table, and no
change to `GET /api/swarm/escalations` — the by-ticket filter stays, because "which run gave up on
this ticket, and after how many attempts" is a real question. It is simply not the question the
escalation panel asks first.

### Why not the other branch

The alternative was to declare `swarm_escalations` canonical and make every escalating path write
one. That means a second write at twenty-six call sites; a `run_id` that has to become nullable,
which contradicts both the column and the table's three run-only columns; and the same fact recorded
twice with two chances to disagree — which is the failure the cockpit already hit from the other
direction. The canonical record is the one that already exists everywhere.

## Consequences

- An operator reading an escalation always gets the reason, whatever raised it, because the record
  that answers is the one every path writes. That was already true of the text on screen; it is now
  true of which record the cockpit *asks* first.
- A swarm-run escalation is not poorer for it: the run record still supplies target, retry class and
  the attempt snapshot as chips beside the canonical reason.
- `swarm_escalations` stops being a half-populated log. Its row count is a count of runs that gave
  up, not of escalations, and an empty result for a ticket means "no run gave up on it", which is a
  fact rather than a hole.
- A caller that passes an empty `runId` now gets an error where it previously got a row. There is one
  such caller in the tree and it supplies a real run id; the refusal exists so a future one cannot
  quietly reintroduce the ambiguity.
- The fact stays in one place, so nothing has to keep two records agreeing.

## Guards

- [tests/unit/escalation-record-canonical-postgres.spec.ts](../../tests/unit/escalation-record-canonical-postgres.spec.ts)
  — a real `postgres:16-alpine` under `DisposablePostgres` running `100-ticket-family-base-schema.sql`
  and the escalation schema as shipped, a real `PostgresTicketStore` and `TicketService`. It escalates
  a ticket the way a non-run path does, reads the `ticket_status_history` row back off the table, and
  proves the run-scoped store refuses a record with no run id while still accepting one that has it.
- [tests/unit/ticket-escalation-detail.spec.ts](../../tests/unit/ticket-escalation-detail.spec.ts)
  — pins D3's precedence: the canonical detail explains the escalation and the run record enriches it.

# ADR-026: Canonical Ticket Interaction Intent Separation

## Status
Accepted — 2026-03-27

## Context
Three distinct operator actions on a ticket were conflated across multiple routes and handlers with no canonical processing path:

- **Update** — operator adds a note/instruction to the ticket thread (should persist durably, visible to agent on next pick-up)
- **Chat** — operator starts a bot conversation in the context of a specific ticket (should route to orchestrator with ticket workspace awareness)
- **Intake** — operator re-submits a ticket through the intake classifier (should route through PM/swarm intake logic)

The cockpit reply endpoint (`POST /api/v1/tickets/:id/reply`) was SSE-only: it set `replyResult = null` and emitted an SSE activity event. No message was written to `chat_messages`. On the agent's next task pick-up, the operator's note was invisible.

`ticket-routes.ts` had a separate `/:ticketId/chat` path that partially handled the chat intent but did not have access to the same workspace context as the cockpit routes. Intent detection was split across three files.

## Decision

Introduce `TicketInteractionService` as the single canonical handler for all ticket interaction intents:

```
processInteraction({ ticketId, text, intent: 'update'|'chat'|'intake', source })
  → TicketInteractionResult { success, intent, taskId, messageId, activityEntry }
```

**`update` intent:** The service saves the operator text as a durable `chat_messages` row against the ticket's primary task thread via `messageStore.save({ taskId, role: 'user', type: 'say', text, metadata: { ticketId, source, intent: 'update' } })`. The `activityEntry` is returned for the SSE emit. If no primary task is found, the result is `{ success: true, taskId: null, messageId: null }` — the update is acknowledged but not anchored.

**`chat` and `intake` intents:** The service resolves the primary task ID and returns context. The route handler is responsible for dispatching to the orchestrator. This keeps orchestration concerns out of the service and makes the service testable without LLM calls.

Primary task ID resolution: `ticketService.getTasksForTicket(ticketId)` returns task links; the first with `role === 'primary'` is used. Errors are swallowed and logged — resolution failure degrades gracefully.

`TicketInteractionService` is wired into `AppContext` and instantiated in `composition-root.ts`. The cockpit reply endpoint now calls `processInteraction({ intent: 'update' })` before emitting SSE.

## Consequences

- Operator replies via cockpit are now durable: stored in `chat_messages` and queryable via `/api/tasks/:taskId/messages`.
- The agent sees operator guidance in its message history on the next pick-up (task resume or new orchestration call).
- SSE-only behavior is preserved as a fallback: if no primary task is found, the SSE still emits — the operator sees their message in the UI even if it could not be anchored to a task thread.
- `chat` and `intake` intents are resolved-but-not-dispatched by the service — callers must invoke the orchestrator themselves. This is intentional: it avoids the service knowing about orchestration lifecycle and keeps it testable.
- Future: the `intent: 'chat'` path in cockpit routes can be wired to `processInteraction` + orchestrator dispatch to unify ticket-aware chat across all surfaces.

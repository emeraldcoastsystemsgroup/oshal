# ADR-027: Swarm Cost Rollup — Per-Bot Task Linking and Cost Aggregation

## Status
Accepted (Partially Implemented — Session 18)

## Date
2026-03-29 (proposed) / 2026-03-30 (implemented)

## Context

The OSHAL cost rollup framework (documented in `docs/cost-rollup-and-estimation-framework.md`) defines a layered pipeline for tracking token usage and cost from LLM calls through to the cockpit UI. The pipeline works correctly for **chat orchestration** tasks (single-user → single-agent conversations) but **fails to aggregate costs across multiple bots** in swarm execution scenarios.

### Problem Statement

When a ticket is processed by the swarm (multiple bots executing across phases/rounds), the cockpit only shows token usage from one bot instead of the combined usage from all participating bots.

### Root Cause Analysis

The cost rollup relies on `ticket_task_links` to connect `chat_tasks` cost records back to tickets. The cockpit's `queryCostByTicket(ticketId)` method performs:

```sql
SELECT ct.agent_id, ct.total_cost, ...
FROM ticket_task_links ttl
JOIN chat_tasks ct ON ct.task_id = ttl.task_id
WHERE ttl.ticket_id = $1
```

**Three interconnected bugs were identified:**

#### Bug 1: Missing `linkTask()` in Swarm Execution Path

The swarm execution path (`llm-execution-handler.ts` → `costTrackingService.recordCost()`) writes cost events to `chat_tasks` but **never calls `ticketService.linkTask()`** to create the corresponding `ticket_task_links` entry.

Evidence:
- `grep -rn "linkTask" features/swarm-orchestration/ app/extensions/swarm/` returns **zero results**
- `linkTask()` is called in `project-manager-ticket-intake.ts:94` (PM task only) and `task-orchestrator.ts:393` (chat orchestration only)
- Swarm bot tasks are orphaned in `chat_tasks` with no link back to the ticket

#### Bug 2: Shared `taskId` Across All Bots on Same Ticket

In `llm-execution-handler.ts`, the `taskId` is resolved as:
```typescript
const taskId = workspaceTaskId || originalExternalId || ticketExternalId || `swarm-${correlationId}`;
```

When `workspaceTaskId` is set (standard for swarm), **all bots on the same parent ticket share the same taskId**. This means:
- All bots write to the same `chat_tasks` row
- The `agent_id` column retains the first bot's ID (UPDATE preserves existing)
- `usage_by_model` merges correctly (JSON merge)
- Per-agent cost breakdown is lost at the DB level

#### Bug 3: Per-Agent Cost Attribution Loss in `persistCostEvent()`

The `persistCostEvent()` UPDATE query uses:
```sql
agent_id = $2  -- where $2 = existing.agent_id || event.agentId
```

This preserves the **first** agent's ID. Subsequent bot cost events merge their token/cost totals into the same row but the `agent_id` stays locked to the first writer, making per-agent aggregation impossible from the `chat_tasks` table alone.

### Impact

- Cockpit shows cost from only one bot (whichever created the initial link or ran first)
- `usageByAgent` map in ticket activity response contains only one agent
- `contributingBots` array shows incomplete participation
- Operators cannot see the true cost distribution across the swarm

## Decision

### Fix 1: Create `ticket_task_links` in Swarm Execution

The `llm-execution-handler.ts` (or `swarm-agent-worker.ts`) must call `ticketService.linkTask(ticketId, taskId, 'swarm-execution')` after successful bot execution. This requires:
- Passing `ticketService` into the execution handler deps
- Using the `ticketExternalId` from the envelope payload as the ticket ID
- Adding a new link role `'swarm-execution'` to distinguish from `'primary'`

### Fix 2: Use Per-Bot Task IDs

Instead of sharing `workspaceTaskId` across all bots, construct unique per-bot task IDs:
```typescript
const taskId = `${workspaceTaskId || ticketExternalId}::${agentId}::${Date.now()}`;
```

This ensures each bot gets its own `chat_tasks` row, preserving per-agent cost attribution.

### Fix 3: Update `persistCostEvent()` for Multi-Agent Rows

If Fix 2 is not adopted (shared row approach retained), modify the UPDATE to accumulate a `usage_by_agent` JSONB field alongside `usage_by_model`, preserving per-agent breakdown within a single row.

### Recommended Approach

Implement **Fix 1 + Fix 2** together. Per-bot task IDs with proper ticket linking gives the cleanest data model and requires minimal changes to the rollup query logic (which already handles multiple tasks per ticket correctly).

## Consequences

### Positive
- All bot costs visible in cockpit for swarm tickets
- Per-agent cost breakdown works correctly
- `contributingBots` accurately reflects all participants
- Cost rollup totals reflect true swarm expenditure
- Existing `queryCostByTicket()` SQL works without modification (already handles multiple linked tasks)

### Negative
- More rows in `chat_tasks` (one per bot per ticket instead of one shared row)
- `ticketService` dependency added to swarm execution handler
- Existing orphaned `chat_tasks` rows from prior swarm runs remain unlinked (one-time migration may be needed)

### Neutral
- Chat orchestration path is unaffected
- Fallback memory-backed rollup path continues to work
- `usage_by_model` merge logic remains valid

## Implementation Status (Session 18)

### Implemented
- **Fix 1**: `linkSwarmTaskToTicket()` in `llm-execution-handler.ts:212` — creates `ticket_task_links` with role `swarm-execution` after every bot execution
- **Fix 2**: Per-bot task ID format `${baseTaskId}::${agentId}` in `llm-execution-handler.ts:142`
- **CHECK constraint**: `ticket_task_links.role` expanded to include `swarm-execution`
- **Recursive rollup view**: `ticket_cost_rollup_with_children` — WITH RECURSIVE CTE aggregates costs from parent through all descendants

### Not Yet Implemented
- Fix 3 (usage_by_agent JSONB) — not needed since Fix 1+2 adopted
- Migration for orphaned `chat_tasks` from pre-Session-17 runs

## Related Documents
- `docs/cost-rollup-and-estimation-framework.md` — framework specification
- `ralf/phase-11-session-133-child-activity-rollup-completion.md` — child rollup implementation
- `ralf/phase-11-session-19-persistent-history-and-usage-completion.md` — initial telemetry pipeline
- `ralf/2026-03-30-session-18-swarm-completion.md` — Session 18 completion brief
# ADR-021: Per-Round Output Tracking in Multi-Round Dispatch

## Status
Accepted — 2026-03-23

## Context
The multi-round dispatch service executes 2 rounds per phase (primary agent + quality agitator). Both rounds dispatched to the same ticket, and the output polling used the ticket's `externalId` to find completed work items. This caused a race condition: Round 1 completed → poll immediately found it → returned Round 1's output as Round 2's result. Round 2's actual output was never collected.

The root cause: both rounds shared the same `externalId` in the `work_items` table. The poll couldn't distinguish Round 1 output from Round 2 output.

## Decision
Each round gets a unique `unitId` in the work_items table: `{ticketId}-phase-{N}-round-{N}`.

Specifically:
1. `executeOneRound()` creates a per-round work item with `unitId = roundUnitId` before dispatching
2. The `roundUnitId` is injected into the envelope payload so the worker can match it
3. `awaitRoundOutput()` filters by `unitId` instead of `externalId`
4. `swarm-agent-worker.recordResult()` matches on `roundUnitId` from the envelope, falling back to any non-completed item if no match

## Consequences
- Round 1 and Round 2 outputs are tracked independently — no cross-contamination
- The poll correctly waits for Round 2 (which contains `## SUBTASK DECOMPOSITION`) instead of returning Round 1's preliminary output
- Work items table grows by 1 extra row per round (acceptable — 2 items per phase instead of 1)
- The `roundUnitId` field is an envelope convention, not a schema change — no DB migration needed

## Alternatives Considered
- **Marker check in poll**: Poll could check if output contains `## SUBTASK DECOMPOSITION` before accepting. Rejected because it couples the poll to decomposition-specific logic.
- **Sequence counter on work item**: Track a round counter on existing items. Rejected because it requires schema changes and complex update logic.

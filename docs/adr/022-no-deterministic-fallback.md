# ADR-022: Escalation Instead of Deterministic Fallback on PM Parse Failure

## Status
Accepted — 2026-03-23

## Context
When the PM agent's LLM planning output could not be parsed for `## SUBTASK DECOMPOSITION`, the decomposition service silently fell back to a deterministic regex-based body parser. This produced generic "Step 1-5" children from the ticket description text — ignoring the PM's actual reasoning.

The fallback was worse than a failure: it gave the appearance of working while producing inaccurate decomposition. The PM had already done the work, but the pipeline threw it away.

## Decision
Remove the deterministic fallback from `decomposeFromPlanningOutput()`. When the PM produces output but it cannot be parsed (neither inline JSON, nested `content.files[]`, nor workspace deliverable files contain the `## SUBTASK DECOMPOSITION` marker):

1. Throw `PlanningDecompositionError` with diagnostic context
2. QM catches it and transitions the ticket to `escalated` status
3. The `escalated` state is a dead-end — it doesn't get polled, retried, or rolled back
4. The operator reviews the workspace and logs to diagnose why the PM's output wasn't parseable

## Consequences
- No more silent deterministic fallback — if the PM fails to produce parseable output, the operator knows immediately
- The `escalated` status acts as a human review queue
- Workspace and logs are preserved for debugging
- If the PM consistently fails to include the marker, the phase dispatch prompt needs tuning — not a silent workaround
- The deterministic decomposer (`decompose()`) still exists for Phase 1 complexity scoring preview — it's just no longer used as a fallback for Phase 2 planning

## Alternatives Considered
- **Retry the PM round**: Re-dispatch with a more explicit prompt. Rejected for now — adds complexity. The 30-minute poll window already gives the PM ample time.
- **Use deterministic but flag it**: Keep the fallback but add a warning badge. Rejected — the user explicitly stated "fallbacks are worse than failures."

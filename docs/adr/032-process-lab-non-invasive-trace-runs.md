# ADR-032: Process Lab for Non-Invasive Swarm Trace Runs

**Status:** Accepted  
**Date:** 2026-04-02  
**Deciders:** oshal maintainers

---

## Context

OSHAL already had enough runtime visibility to inspect tickets, work items, swarm runs, and runtime traces after the fact, but there was no single operator surface dedicated to replaying a known workflow and collecting that evidence into one place.

That created a few recurring problems:

- validating the full ticket lifecycle required manual terminal work, repeated API calls, and log chasing
- it was difficult to compare how low, medium, and high complexity requests behaved under the same swarm runtime
- lifecycle regressions, such as missing approval gates or routing failures, were visible only by stitching together multiple screens and raw logs
- the system needed a safer way to observe the runtime without adding instrumentation that changed the execution path being evaluated

The requirement for this feature was explicit: create a trace-and-review surface that is operationally useful, but non-invasive to the runtime path under test.

---

## Decision

Introduce **Process Lab** as a separate operator-facing surface for scenario-based swarm trace runs.

### Core behavior

- Process Lab creates its own root tickets using the existing `TicketService`
- those tickets enter the normal ticket lifecycle in `approved`
- Process Lab does not replace or shortcut the queue manager, routing, verification, or trace analysis services
- Process Lab observes the run by polling the ticket, its history, linked work items, related swarm runs, and runtime trace artifacts after and during execution

### Non-invasive contract

- Process Lab does not modify the traced execution path
- it does not rewrite queue manager behavior
- it does not cancel, restart, or mutate unrelated tickets
- it only updates the traced parent ticket when the scenario is explicitly configured to auto-approve the build gate

### Scenario model

- ship built-in scenario presets for low, medium, and high complexity tickets
- allow limited per-run overrides for title, description, priority, wait budgets, and build-gate behavior
- treat the runtime as the system under test, not as an implementation detail to script around

### Run outputs

Each Process Lab run captures:

- a preflight snapshot of current queue pressure
- per-step execution state and event timeline
- parent ticket and child tickets
- ticket status history
- linked work item summaries
- related swarm processing runs
- runtime trace summary with anomaly and regression counts when available
- heuristic assessment and optional AI summary

### Persistence model

- keep Process Lab run state in memory inside the API process for v1
- do not introduce new persistence tables or benchmark schemas yet

---

## Rationale

This decision creates a repeatable validation tool without contaminating the behavior it is supposed to explain.

### Why a separate surface?

The cockpit, queue manager admin, ops dashboard, and runtime trace tools are all valuable, but they are not organized around one reproducible experiment. Process Lab turns those existing runtime contracts into a scenario runner and evidence package.

### Why non-invasive instead of deeper instrumentation?

The point of the feature is to answer, "what did the real system do?" Adding a special execution path for lab runs would make the trace less trustworthy and blur the line between observation and intervention.

### Why scripted scenarios plus AI assessment?

The scenario runner handles deterministic actions well:

- create the ticket
- wait for state changes
- optionally approve the build gate
- collect artifacts

AI is better used after the fact, once the evidence is assembled, to summarize what happened and call out likely issues.

### Why in-memory run storage first?

The first goal is operator usefulness, not a benchmark product. In-memory storage keeps the feature additive and low-risk while the scenario model and output shape stabilize.

---

## Consequences

**Positive**

- operators get a repeatable way to trace the full lifecycle from approval through outcome
- low, medium, and high complexity requests can be compared using the same runner
- lifecycle gaps such as missing approval gates, routing failures, escalations, and trace anomalies are surfaced in one place
- the feature reuses existing ticket, run, and trace infrastructure instead of creating a parallel orchestration stack

**Negative**

- Process Lab runs are not durable across API process restarts
- the feature creates real tickets and therefore depends on the health of the live runtime
- v1 does not collect external container logs or run automated policy tuning; it is a trace-and-assess surface, not a full optimization harness

**Neutral**

- Process Lab is additive and does not replace cockpit, queue manager admin, ops dashboard, or runtime trace tooling
- AI assessment is optional and may be skipped when a provider is unavailable

---

## Implementation Notes

Primary implementation points:

- `src/features/process-lab/services/process-lab-service.ts`
- `src/app/routes/process-lab-routes.ts`
- `src/pages/process-lab/index.html`
- `src/pages/process-lab/process-lab.css`
- `src/pages/process-lab/process-lab.js`
- `src/app/server.ts`

Primary routes:

- page: `/process-lab`
- API: `/api/process-lab/scenarios`
- API: `/api/process-lab/runs`
- API: `/api/process-lab/runs/:runId`

Related runtime dependencies:

- `TicketService`
- `WorkItemRepository`
- `SwarmTicketProcessingService.listRuns()`
- `RuntimeTraceAnalyzerService`
- `WorkspaceService`

Documentation added with this ADR:

- `docs/process-lab-guide.md`
- `docs/README.md`
- `docs/adr/README.md`

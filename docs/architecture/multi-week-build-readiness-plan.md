# Multi-Week Build Readiness Plan

## Goal

Move OSHAL from a strong short-horizon ticket runner into a system that can reliably deliver a built product over multiple days and weeks.

The target is not just "better answers" or "longer plans." The target is a control plane that can:

- do deeper research before execution
- produce richer planning artifacts up front
- persist program context across many sessions
- manage milestones, dependencies, and regressions over time
- drive toward a built product, not just a completed hour-long work burst

## What The Current Runtime Already Does Well

The current runtime already has important building blocks:

- planning orchestration with optional architecture pre-round
- implementation-plan artifact handling
- child ticket creation from planning decomposition
- workspace artifact generation and handovers
- queue governance, regression handling, and escalation paths
- worker execution, routing, and review/testing phases

Relevant seams:

- `src/features/swarm-orchestration/services/planning-round-orchestrator.ts`
- `src/features/swarm-orchestration/services/ticket-decomposition-service.ts`
- `src/features/swarm-orchestration/services/queue-manager-service.ts`
- `docs/architecture/complex-ticket-reference-gap-plan.md`

This means the system is not starting from zero. It already has "complex ticket" behavior. The issue is horizon and product-shape depth.

## Main Gaps Blocking Multi-Week Builds

### 1. Planning Is Stronger Than Before, But Still Too Narrow

The planning path can produce decomposition and implementation artifacts, but it still centers on "what should happen next" more than "what is the full product build strategy."

Missing planning outputs for multi-week work:

- product scope definition
- milestone breakdown
- dependency map
- risk register
- research agenda
- explicit acceptance plan for the final built product

### 2. Research Is Not A First-Class Gate

For large builds, research should not be optional background work hidden inside planning prompts. It should be a required artifact-producing phase for tickets above a complexity threshold.

Needed artifacts:

- `RESEARCH-BRIEF.md`
- `DECISION-LOG.md`
- `OPEN-QUESTIONS.md`
- `SOURCE-INVENTORY.md`

### 3. The System Thinks In Tickets More Than Programs

A multi-week build needs program state:

- milestones
- dependencies between streams
- rollout order
- unresolved decisions
- remaining product gaps

Today the system is much closer to ticket lifecycle management than program lifecycle management.

### 4. Context Persistence Needs To Be More Deliberate

Workspaces and handovers exist, which is good, but multi-week delivery needs durable, compact program memory rather than only per-run artifacts.

Needed long-lived memory objects:

- product brief
- architecture decisions
- milestone ledger
- current build status
- unresolved blockers
- prior research summaries

### 5. "Built Product" Exit Criteria Are Not Strong Enough

For larger efforts, success cannot be "ticket processed" or even "phase complete."

The runtime needs release-level completion checks:

- core functionality built
- integration paths wired
- validation complete
- operator docs present
- deployment/runbook artifacts present
- known-gap list explicit

### 6. Scheduling And Replanning Are Too Session-Oriented

The system needs a deliberate loop for:

- plan
- research
- execute
- validate
- replan
- continue next day

That loop should survive many sessions without losing the plot.

## Product Direction

To handle multi-week builds, OSHAL should evolve from:

- `ticket orchestrator`

into:

- `program delivery orchestrator`

That means adding explicit support for:

1. research-first intake for large work
2. milestone-aware planning
3. persistent product state
4. weekly re-planning loops
5. release-readiness gates

## Recommended Improvement Tracks

### Track 1. Add A Research Phase Before Planning For Complex Work

Rule:

- medium and high complexity tickets should be allowed to enter a dedicated research phase before final planning

Required outputs:

- `RESEARCH-BRIEF.md`
- `SOURCE-INVENTORY.md`
- `OPEN-QUESTIONS.md`
- `RECOMMENDED-APPROACH.md`

Why this matters:

- planning quality rises sharply when architecture and implementation choices are made after evidence gathering
- the system stops improvising foundational decisions too early

### Track 2. Upgrade Planning From "Implementation Plan" To "Program Plan"

Required planning package for large builds:

- `PRODUCT-BRIEF.md`
- `TECHNICAL-SPECIFICATION.md`
- `IMPLEMENTATION-PLAN.md`
- `MILESTONE-PLAN.md`
- `RISK-REGISTER.md`
- `ACCEPTANCE-PLAN.md`

New planning expectations:

- milestone sequencing
- dependency mapping
- phased delivery slices
- explicit "not in scope yet"
- final acceptance criteria for the product, not just the ticket

### Track 3. Add Program-State Persistence

Introduce a long-lived program or initiative record above tickets.

Core state should include:

- initiative id
- product goal
- milestone list
- current milestone
- dependency graph
- build health
- unresolved decisions
- release blockers

Without this, each ticket run has to reconstruct too much context.

### Track 4. Add Replanning And Continuation As A First-Class Loop

At the end of every major cycle, the system should generate:

- what changed
- what remains
- what assumptions changed
- whether the plan should be updated
- what the next execution slice should be

Artifacts:

- `STATUS-SUMMARY.md`
- `NEXT-SLICE.md`
- `BLOCKERS.md`
- `PLAN-DELTA.md`

### Track 5. Make Validation Product-Oriented

For multi-week builds, validation must answer:

- is the product actually usable now
- what critical paths are complete
- what integrations are still stubbed or missing
- what operational setup remains

Add final-phase checks for:

- product completeness
- integration completeness
- deployment readiness
- documentation completeness
- known-gap visibility

### Track 6. Add Operator Surfaces For Long-Horizon Work

The cockpit/operator layer should show:

- active initiative
- current milestone
- major blockers
- research status
- architecture status
- execution status
- testing/review status
- release readiness

This is what makes a multi-week system manageable by humans.

## Concrete Gaps In Current Seams

### `planning-round-orchestrator.ts`

Current strength:

- optional architecture pre-round
- implementation plan artifact handling

Needed next:

- explicit research round
- milestone-plan requirement
- acceptance-plan requirement
- final "program package complete" gate before decomposition

### `ticket-decomposition-service.ts`

Current strength:

- parses PM output into work units and agent assignments

Needed next:

- milestone-aware decomposition
- dependency extraction
- stream labeling such as platform, backend, frontend, qa, docs, release
- distinction between "research tasks" and "build tasks"

### `queue-manager-service.ts`

Current strength:

- background polling, child creation, workspace setup, escalation, stuck-loop handling

Needed next:

- initiative-level scheduling
- milestone progression rules
- replanning checkpoints
- continuation budgeting across days/weeks

## Suggested Delivery Sequence

### Phase A. Research-First Upgrade

Deliver:

- research phase for medium/high complexity tickets
- research artifact gates
- explicit source inventory capture

### Phase B. Planning Package Upgrade

Deliver:

- milestone plan
- risk register
- acceptance plan
- required planning package validation

### Phase C. Program-State Model

Deliver:

- initiative/program entity
- milestone persistence
- dependency tracking
- build health summary

### Phase D. Continuation Loop

Deliver:

- status summary artifact
- plan delta artifact
- next-slice generation
- periodic replanning checkpoints

### Phase E. Release Readiness

Deliver:

- built-product completion checklist
- release blocker registry
- operator-facing readiness status

## Recommendation

If the goal is a system that can deliver a real product over multiple weeks, the most important immediate change is this:

> make research and planning produce a full program package before execution starts for complex work

That is the highest-leverage improvement because it raises the quality of everything downstream:

- decomposition
- routing
- execution quality
- testing quality
- continuation quality
- final product completeness

## Short Version

The current system is already becoming a serious orchestration shell, but it still optimizes for "process a hard ticket."

To support multi-week builds, it needs to optimize for:

- persistent program context
- research-first planning
- milestone delivery
- continuation over time
- product-level completion

# ADR-031: Phase 0 Discovery and Build Approval Gate

**Status:** Accepted  
**Date:** 2026-04-01  
**Deciders:** oshal maintainers

---

## Context

OSHAL already had a strong execution pipeline, but structured project work was still too easy to push directly from approval into build-oriented processing without a clean planning checkpoint.

That created a few practical problems:

- discovery and planning were not clearly separated from build execution in the ticket lifecycle
- structured root tickets could look like they were already in build-adjacent work even when the real job was still planning and decomposition
- child build tickets could be created and picked up too quickly, before a human had reviewed the plan package
- direct-execution and quick-answer work needed to stay fast, while serious project work needed a more professional gate

The platform needed a truthful lifecycle for serious work:

1. discover and plan
2. stop for human review
3. explicitly release build work

At the same time, low-ceremony paths needed to remain intact for quick answers and lightweight execution.

---

## Decision

Introduce a formal **Phase 0** and a **human build gate** for structured root tickets.

### New canonical states

- `in_process_discovery`
  - Phase 0 for discovery and planning
- `approval_required`
  - planning complete, waiting for human review/approval before build

### Dispatch behavior

- structured root tickets enter `in_process_discovery`
- PM planning/decomposition happens during this phase
- when planning creates child build tickets, the parent moves to `approval_required`
- approved child build tickets do **not** dispatch while the parent remains in `approval_required`
- child build tickets may dispatch only after the parent is explicitly moved into `in_process_build`

### Paths preserved

- `instant-answer` root tickets still bypass PM planning and go straight to direct execution
- `direct-execution` root tickets still bypass PM planning and go straight to direct execution
- child tickets still bypass PM planning and route directly to specialists once the parent build gate is open

### Operator meaning

- `in_process_discovery` means planning is in progress
- `approval_required` means planning is done and human review is required
- `in_process_build` means build has been approved and execution may proceed

---

## Rationale

This decision makes the lifecycle match the real project shape.

### Why Phase 0?

Planning is real work and should be visible as its own phase. Serious delivery needs a truthful discovery/planning state instead of being implicitly treated as early build work.

### Why a human build gate?

Serious projects need one explicit checkpoint between planning and execution:

- verify the artifact package
- verify the plan is good enough
- verify the swarm should spend tokens and create build work

This is especially important now that the planning contract can generate a large professional artifact set.

### Why not gate everything?

Quick answers and lightweight execution lose value if they are forced through heavyweight process. The gate is only for structured root tickets.

---

## Consequences

**Positive**

- the ticket lifecycle now tells the truth about planning vs build
- structured work gets a real operator checkpoint before build begins
- child build tickets no longer race ahead of planning review
- direct-execution and instant-answer paths stay fast
- cockpit/status views can distinguish planning from execution more clearly

**Negative**

- operators now need one explicit state transition from `approval_required` to `in_process_build`
- lifecycle/state-transition logic becomes slightly more complex
- older documentation and UI assumptions that equated planning with `in_process_design` needed cleanup

**Neutral**

- `in_process_design` still exists for other flows and backward compatibility
- this decision is additive to the existing swarm execution model, not a rewrite of it

---

## Implementation Notes

Primary implementation points:

- `src/entities/ticket/types.ts`
- `src/features/swarm-orchestration/services/planning-round-orchestrator.ts`
- `src/features/swarm-orchestration/services/queue-manager-service.ts`
- `src/features/swarm-orchestration/services/queue-manager-workspace-helpers.ts`
- `src/pages/cockpit/js/views/ticket-view-helpers.js`

Documentation updated:

- `docs/ticket-lifecycle-flow.md`
- `docs/architecture/outcome-first-delivery-framework.md`
- `src/features/swarm-orchestration/README.md`

Validation coverage:

- `tests/planning-entry-mode-contract.js`
- `tests/task-brief-prep-packet-contract.js`
- `tests/queue-phase-zero-contract.js`

---

## Amendment — 2026-07-18: the build gate auto-opens (children are not blocked in `approval_required`)

**As-built correction.** The **Dispatch behavior** section above states that "approved child build tickets do **not** dispatch while the parent remains in `approval_required`" and "may dispatch only after the parent is explicitly moved into `in_process_build`." **That manual gate is no longer enforced by the running code, and has not been since at least 2026-06-22.**

`PARENT_READY_FOR_CHILD_DISPATCH_STATES` in `src/features/swarm-orchestration/services/queue-manager-sweeps.ts` **includes `approval_required`**, so `isDispatchBlockedByParentState()` returns *not blocked* the moment a parent has been planned. The relaxation is **deliberate** — the predecessor code carried the inline rationale *"Parent has been planned and children created — let them dispatch"*, preserved through commit `6a376cb6` ("fix(queue): align task routing and parent gating", 2026-06-22). In effect, `approval_required` is now a **planning-complete marker**, not a blocking gate: children auto-dispatch on the next poll cycle with **no operator action**.

**Verified live 2026-07-18.** A `build` root ("smart-home automation controller") decomposed into 4 child tickets, and those children executed to `in_process_build` without any manual `approval_required → in_process_build` transition. (Companion runs: a low-complexity build ran as a single unit; a medium build produced no decomposition — the decompose decision is LLM-driven and non-deterministic. See `src/features/swarm-orchestration/README.md` → "Decomposition depth and limits".)

**Open item (unresolved, flagged for separate investigation).** In the same run the parent ticket reached `complete` while 2 of its 4 children were still executing. Parent-assembly / terminal-state gating looks looser than intended — a parent should not report `complete` before its children terminate and assemble. This amendment documents the child-dispatch reality only; it does not change or bless the parent-completion behavior.

**Decision status.** The Phase-0 discovery/planning split (`in_process_discovery`, planning as its own phase) **stands**. The *human build gate* portion of the original decision is **superseded** by autonomous auto-release. If a true operator approval checkpoint between planning and build is still wanted (e.g. cost control on large decompositions), it must be re-introduced as a **new** decision with an explicit blocking state — it is not in effect today, and the prose above should be read as historical intent, not current behavior.

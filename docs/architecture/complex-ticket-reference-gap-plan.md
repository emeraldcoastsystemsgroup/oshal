# Complex Ticket Reference Gap Analysis and Improvement Plan

## Purpose

This document compares:

- the **current OSHAL complex-ticket baseline** documented in `docs/architecture/complex-ticket-process-ascii.md`
- the **legacy sibling reference process** documented in `docs/architecture/reference-sibling-complex-ticket-process-ascii.md`

It then turns that comparison into a staged OSHAL improvement plan.

## Project Context

The current repository already contains three useful layers of context:

1. **Current runtime contract**
   - `docs/architecture/swarm-processing-design-contract.md`
2. **Current runtime flow and operational truths**
   - `docs/architecture/swarm-orchestration-process-flow.md`
3. **Current complex-ticket baseline**
   - `docs/architecture/complex-ticket-process-ascii.md`

The reference behavior came from the legacy sibling queue-manager runtime under `any-bot/server/services/queue-manager/`.

> Important correction carried forward from recent pipeline audit work:
> the current OSHAL runtime already reaches **Cline-backed execution** through the worker path.
> The main gap is **not** “provider call vs Cline CLI.”
> The main gap is the **depth of queue governance, multi-round orchestration, handover enforcement, and operator-visible process control** around that execution.

---

## 1) What the Reference Process Gets Right

The reference runtime feels stronger because it treats the ticket as a governed story, not just a dispatched work item.

### Strong reference traits

- **Queue Manager as operational governor**
  - polling, cooldowns, reroutes, circuit breakers, approval-required flow, stuck-agent handling, parent assembly
- **Explicit PM / QA role ownership**
  - project-manager owns planning/decomposition
  - task-manager / reviewers own validation and rejection
- **Mandatory round discipline**
  - multiple rounds across planning/execution/testing/review instead of one “happy path” pass
- **Workspace-first artifact contract**
  - notes, deliverables, handovers, meta, transcripts, shared-root inheritance
- **Continuation-aware execution**
  - partial-work carryover when sessions stall or timeout
- **Operator-visible states**
  - Todo, Routing, In Progress, In Review, Approval Required, Customer Action tell a human what is happening
- **Failure governance**
  - regression, revision, reroute, approval, circuit breaker, stale-ticket recovery, stuck-agent watchdog

Those are the behaviors OSHAL should target.

---

## 2) Current OSHAL vs Reference — Gap Matrix

| Dimension | Current OSHAL baseline | Reference behavior | Gap severity | Recommended direction |
|---|---|---|---|---|
| Queue-manager scope | QueueManagerService does strong prep, decomposition, workspace seeding, and post-pipeline enrichment | Queue manager governs the whole operational lifecycle, including cooldowns, reroutes, approvals, circuit breakers, and parent assembly | High | Expand OSHAL queue management from prep service into an operational governor without importing the old monolith wholesale |
| Phase ownership | OSHAL has 7 phases and complexity gates, but phase execution is still concentrated in `SwarmTicketProcessingService` | Distinct PM / specialist / tester / reviewer ownership is explicit and operator-visible | High | Make role ownership and phase boundaries first-class in runtime state, APIs, and docs |
| Multi-round behavior | Partial; review and round services exist, but the full lifecycle still trends toward single-dispatch execution | Planning, execution, testing, and review all support structured multi-round flow | High | Make `PhaseRoundOrchestrator` authoritative for phases 2-5 and keep review consensus specialized |
| Routing depth | Current routing has meaningful services and policy hooks | Reference stack layers PM assignment, LLM router, mesh bids, capability weighting, round-robin history, and reroute protocol | Medium-High | Preserve OSHAL routing seams but carry over explicit per-phase/per-round selection rules and thread-visible reroutes |
| Handover and continuation | OSHAL writes rich workspace artifacts and some handovers, but enforcement is still uneven | Reference stack treats handover as required bot memory, with continuation prompts on timeout/stall | High | Promote handovers from “useful artifact” to “enforced contract” for multi-round and multi-session flows |
| Workspace story | OSHAL already seeds `_meta.json`, `TASK-BRIEF.md`, routing decisions, deliverables, notes, and handovers | Reference stack uses shared-root workspaces, deeper file recovery, explicit deliverable/notes separation, parent assembly, and round handover files | Medium | Keep OSHAL artifact model, but add stronger inheritance, enforcement, and parent-assembly behavior |
| Failure governance | OSHAL has retries, escalations, and verification services | Reference stack adds cooldown rules, stale-loop circuit breaker, approval-required flow, stuck-agent watchdog, and workspace recovery scan | High | Port the guardrails that keep the runtime honest under non-happy-path conditions |
| Human/operator checkpoints | Current cockpit and runtime docs are improving but still incomplete | Reference loop uses ticket states/comments as explicit human checkpoints | Medium-High | Surface queue state, current phase, current round, escalation reason, and approval requirements directly in OSHAL operator APIs/UI |
| Metrics / memory / audit | OSHAL has strong foundations and some feature slices already | Reference behavior tightly couples routing log, metrics, memory, watchdogs, and queue governance | Medium | Finish wiring existing OSHAL services into the real processing path and operator views |
| Execution truth | OSHAL already reaches worker -> Cline-backed execution | Reference stack also uses session-style execution, but with richer governance around it | Medium | Focus improvement effort on orchestration shell, not on replacing the current execution engine unnecessarily |

---

## 3) The Most Important Structural Gap

```text
Current OSHAL is strongest at:
  - typed service boundaries
  - intake adapters
  - run/work-item persistence
  - worker execution plumbing
  - prompt-layer composition

The reference runtime is strongest at:
  - operational governance around the ticket
  - explicit phase/round ownership
  - thread + workspace continuity
  - defensive controls when work goes sideways
```

### Practical interpretation

OSHAL should **not** port the old queue-manager JS as-is.

OSHAL **should** port these behaviors onto its current seams:

- queue governance rules
- PM/QA role semantics
- multi-round dispatch discipline
- handover/continuation enforcement
- shared-workspace artifact enforcement
- failure-control loops
- operator-facing visibility

---

## 4) Staged OSHAL Improvement Plan

## Stage 1 — Documentation and Contract Alignment

**Goal:** make the target process explicit before changing behavior.

### Work

- align `swarm-processing-design-contract.md` with the real current execution truth and the desired complex-ticket contract
- use the current and reference ASCII docs as the canonical comparison pack
- define which reference behaviors are **mandatory parity targets** vs **optional legacy conveniences**
- document PM/QA/tester/reviewer responsibilities as OSHAL contract language, not legacy implementation language

### Central files/services

- `docs/architecture/swarm-processing-design-contract.md`
- `docs/architecture/swarm-orchestration-process-flow.md`
- `src/features/swarm-orchestration/services/queue-manager-service.ts`
- `src/features/swarm-orchestration/services/swarm-ticket-processing-service.ts`

### Risk

- **Low** — documentation and contract work only

### Why first

Without this stage, implementation will keep oscillating between “current reality,” “legacy memory,” and “planned parity.”

---

## Stage 2 — Queue Governance Alignment

**Goal:** make OSHAL queue management responsible for more than ticket prep.

### Work

- extend queue governance to include explicit processing states and operator-visible checkpoints
- add support for:
  - reroute requests
  - approval-required state for risky commands
  - parent waiting / assembly state
  - stalled-ticket and stuck-agent handling
  - circuit-breaker / stale-loop detection
- make queue state inspectable from cockpit APIs

### Central files/services

- `src/features/swarm-orchestration/services/queue-manager-service.ts`
- `src/features/swarm-orchestration/services/swarm-writeback-handler.ts`
- `src/features/swarm-orchestration/services/postgres-swarm-escalation-store.ts`
- cockpit/server routes that project swarm state to the operator UI

### Risk

- **Medium** — state-model changes and UI/API projection changes

### Expected payoff

- humans can tell whether a ticket is waiting, progressing, blocked, or requiring approval

---

## Stage 3 — Phase and Round Orchestration Alignment

**Goal:** make multi-round execution the norm for complex tickets rather than an exception.

### Work

- make `PhaseRoundOrchestrator` authoritative for phases 2-5
- keep `ConsensusReviewService` / review-cycle logic specialized for the review phase
- ensure each phase can intentionally route to different agents by role:
  - planning -> PM / planner reviewer
  - specialist_input -> domain specialists
  - execution -> executor + improver/reviewer
  - testing -> different tester(s)
  - review -> QA gatekeeper + domain reviewer
- persist current phase, round, assigned agent, prior verdicts, and regression targets for operator visibility

### Central files/services

- `src/features/swarm-orchestration/services/swarm-ticket-processing-service.ts`
- `src/features/swarm-orchestration/services/phase-round-orchestrator.ts`
- `src/features/swarm-orchestration/services/consensus-review-service.ts`
- `src/features/swarm-orchestration/services/swarm-routing-handler.ts`
- `src/features/swarm-orchestration/services/subtask-lifecycle-service.ts`

### Risk

- **High** — this changes the runtime’s core control flow and will affect work-item persistence, retries, and testing

### Expected payoff

- current OSHAL finally gains the reference process’s biggest strength: governance around each phase, not just one dispatch plus verification

---

## Stage 4 — Artifact, Handover, and Continuation Enforcement

**Goal:** make workspace artifacts and handovers part of the execution contract.

### Work

- enforce required outputs for complex-ticket flows:
  - `_meta.json`
  - `TASK-BRIEF.md`
  - routing decision log
  - notes
  - deliverables
  - developer handovers
- summarize prior handovers into next-round prompts automatically
- add continuation-brief generation when an execution session times out or stalls
- improve shared-root workspace inheritance and parent assembly behavior
- ensure final operator surfaces link to actual deliverables and handover story

### Central files/services

- `src/features/swarm-orchestration/services/task-folder-service.ts`
- `src/features/swarm-orchestration/services/llm-execution-handler.ts`
- `src/features/swarm-orchestration/services/swarm-agent-worker.ts`
- `src/features/swarm-orchestration/services/queue-manager-service.ts`

### Risk

- **Medium-High** — prompt contract and artifact expectations will change for bots and tests

### Expected payoff

- multi-session and multi-agent work becomes explainable and resumable instead of fragile

---

## Stage 5 — Failure Governance and Operator Controls

**Goal:** port the defensive controls that make the reference runtime survivable in production-like use.

### Work

- add stale-loop detection and circuit-breaker policy for repetitive non-progress outputs
- add approval-required flows for risky actions
- add stuck-work-item / stuck-agent watchdog visibility to operator APIs
- add workspace recovery scans when execution output is empty but files exist
- make regressions to planning or execution explicit after failed testing/review

### Central files/services

- `src/features/swarm-orchestration/services/swarm-execution-policy-runner.ts`
- `src/features/swarm-orchestration/services/swarm-verification-service.ts`
- `src/features/swarm-orchestration/services/queue-manager-service.ts`
- escalation and run-store services
- cockpit routes / dashboards for surfacing failures

### Risk

- **Medium** — mostly policy and state transitions, but touches the unhappy-path core

### Expected payoff

- fewer silent failures, fewer “stuck but invisible” tickets, better operator trust

---

## Stage 6 — Metrics, Memory, and Parity Validation

**Goal:** close the loop with evidence and make the upgraded process measurable.

### Work

- finish wiring routing audit, cost, agent metrics, and swarm memory through the main path
- expose real queue/run/escalation/phase metrics to cockpit
- add scenario-driven tests for:
  - complex ticket with decomposition
  - failed testing causing regression
  - review cycle causing revision
  - approval-required command path
  - parent assembly after child completion
- document localhost validation steps with mock auth available

### Central files/services

- metrics and audit services already present in OSHAL
- cockpit APIs and screens
- Playwright / integration test suites

### Risk

- **Low-Medium** — mostly wiring, validation, and operator surfaces

### Expected payoff

- parity claims become testable and inspectable from localhost

---

## 5) Priority Order for Immediate Work

If the goal is the shortest path to meaningful improvement, the next implementation order should be:

1. **Contract alignment** — lock the target process and remove ambiguity
2. **Queue governance expansion** — states, approvals, reroutes, parent-child visibility
3. **Multi-round phase dispatch** — make phases 2-5 structurally richer
4. **Artifact + handover enforcement** — make the workspace story reliable
5. **Failure governance** — circuit breaker, stuck detection, regression clarity
6. **Metrics + cockpit exposure** — show the process to humans

---

## 6) Low-Risk vs High-Risk Changes

### Low-risk / should happen first

- documentation and contract updates
- cockpit/read-model APIs that expose existing run/phase/escalation state
- stronger artifact scaffolding in the workspace
- routing audit and metrics exposure
- operator-facing improvement-plan documentation

### High-risk / schedule carefully

- making `PhaseRoundOrchestrator` authoritative across phases 2-5
- changing parent/child lifecycle semantics mid-pipeline
- adding approval-required flow to live queue transitions
- enforcing handover rejection/retry if current prompts are not yet stable
- changing regression loops without corresponding operator/read-model updates

---

## 7) What to Emulate, Not Copy

Do **not** copy the old queue-manager monolith directly.

Do emulate these reference properties:

- ticket-state discipline
- PM/QA ownership model
- multi-round orchestration
- continuation-aware execution
- workspace-first artifact production
- explicit human approval checkpoints
- operator-grade failure visibility

OSHAL should keep its stronger boundaries:

- typed services
- cleaner persistence seams
- feature-sliced runtime organization
- better separation of intake, orchestration, execution, and persistence

---

## 8) Definition of Done for This Improvement Plan

The improvement effort can be considered substantively closed when a complex ticket in OSHAL can do all of the following from localhost:

1. enter the queue with a visible operator state
2. move through the correct complexity-gated phases
3. use distinct agents across planning/execution/testing/review where appropriate
4. persist round state, handovers, routing history, and deliverables in a shared workspace
5. regress cleanly when testing or review fails
6. surface approval-required / stuck / escalated states honestly in cockpit
7. allow a human to inspect the full ticket story — thread, workspace, handovers, deliverables — from localhost without hidden dependencies

That is the practical shape of “reference-quality” complex-ticket orchestration for OSHAL.
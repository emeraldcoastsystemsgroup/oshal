# Complex Ticket Process Comparison — Executive Summary

## Short Answer

If you want the blunt version:

- **The legacy sibling is better at running the work.**
- **Current OSHAL is better at hosting the work.**

That is the core difference.

The older sibling process is stronger in **queue governance, phase discipline, handovers, review loops, and human/operator checkpoints**.

Current OSHAL is stronger in **architecture quality, separation of concerns, typed services, persistence seams, transport plumbing, and modern runtime structure**.

---

## What Is Better In the Legacy Sibling

These are the things the older sibling does better **today** from a process perspective.

### 1. The Queue Manager is much stronger

In the legacy sibling, the Queue Manager is not just a prep step.
It actively governs the ticket through the whole lifecycle:

- cooldown rules
- reroute handling
- approval-required flow
- stuck-ticket recovery
- circuit breakers for looping agents
- parent/child completion assembly

In plain English: **it behaves like an operations lead, not just a dispatcher.**

### 2. PM and QA roles are clearer

The legacy sibling makes these roles very obvious:

- **Project Manager** = planning, decomposition, assignment intent
- **Task Manager / QA** = validation, rejection, review discipline
- **Specialists** = execute and test

In plain English: **it is clearer who is supposed to think, who is supposed to do, and who is supposed to reject weak work.**

### 3. It has better multi-round discipline

The older sibling expects multiple rounds across important phases:

- planning round 1 + round 2
- execution round 1 + improvement/review round 2
- testing by a different agent
- review with consensus / revision loop

In plain English: **the work gets challenged more before it is considered done.**

### 4. Handovers are more central to the process

The legacy sibling uses handovers as part of the actual process, not just as nice-to-have files.

That means:

- later agents inherit context better
- retries can continue prior work
- timeouts do not automatically destroy the story

In plain English: **it remembers better across agents and across sessions.**

### 5. It has better unhappy-path controls

The older sibling is better when things go wrong:

- agents looping
- tickets getting stuck
- reviewers rejecting work
- risky commands needing human approval
- children finishing before parents can assemble deliverables

In plain English: **it fails more honestly and more visibly.**

---

## What Is Better In Current OSHAL

These are the things current OSHAL does better **today** from a platform / engineering perspective.

### 1. The architecture is cleaner

OSHAL has a better overall shape:

- cleaner TypeScript service boundaries
- clearer separation between intake, orchestration, execution, and persistence
- less reliance on one giant monolithic queue-manager file for everything

In plain English: **it is easier to extend safely than the old sibling.**

### 2. Persistence seams are better

OSHAL already has stronger runtime building blocks for:

- work-item persistence
- run persistence
- escalation persistence
- agent profile persistence
- persona layer storage

In plain English: **the data model is more modern and more maintainable.**

### 3. The transport/runtime plumbing is better

OSHAL already has strong modern runtime pieces:

- Redis-backed mesh transport
- worker-based execution
- persona-layer composition
- Cline-backed execution through the worker path

In plain English: **the engine room is better built than the old sibling.**

### 4. The deployment/runtime shell is better positioned for the future

OSHAL is already set up around:

- modern control-plane architecture
- clearer extension points
- better feature-level separation
- better long-term maintainability

In plain English: **the foundation is stronger even though the process still needs work.**

### 5. The localhost/dev model is more deliberate

OSHAL has a clearer path for local validation and browser-facing operator work:

- cockpit as operator shell
- mock-auth/dev-mode support patterns
- Playwright-driven validation approach

In plain English: **the local product shell is closer to a real maintainable application, even if the swarm process inside it still needs parity work.**

---

## The Real Tradeoff

```text
Legacy sibling:
  weaker architecture
  stronger process governance

Current OSHAL:
  stronger architecture
  weaker process governance
```

That is why the legacy sibling can feel “more robust” even though OSHAL is technically cleaner.

---

## What Is Missing In Current OSHAL Right Now

These are the specific things that still make OSHAL feel less mature during complex-ticket handling:

1. **Queue governance is too thin** compared to the reference process.
2. **Multi-round execution is not yet authoritative** across the full lifecycle.
3. **Handovers are not yet enforced strongly enough** as process memory.
4. **Approval / reroute / stuck / circuit-breaker controls** are not yet first-class in the live path.
5. **Operator-visible phase and round state** still needs to be clearer in cockpit/read models.
6. **Parent/child shared-workspace assembly behavior** still needs stronger alignment.

---

## What To Improve First

If we want the shortest path to a noticeably better OSHAL complex-ticket process, the first priorities should be:

### Priority 1 — Make queue state more honest

Add stronger live support for:

- reroute requests
- approval-required state
- stuck detection
- circuit-breaker visibility
- parent waiting/assembly state

### Priority 2 — Make rounds real

Use `PhaseRoundOrchestrator` as a real controller for phases 2-5, not just as partial support.

### Priority 3 — Enforce handovers and continuation

Make handover output part of the complex-ticket contract so later agents and later sessions inherit reliable context.

### Priority 4 — Improve cockpit/operator visibility

Make current phase, round, blocker reason, escalation reason, and approval status easy to inspect.

### Priority 5 — Finish failure governance

When something goes wrong, OSHAL should clearly say:

- what failed
- who owns the next step
- whether it regressed, rerouted, escalated, or is waiting for approval

---

## One-Line Recommendation

Do **not** copy the old sibling monolith.

Do **port the old sibling’s process discipline** onto OSHAL’s cleaner architecture.

That gives us the best end state:

- **legacy sibling robustness**
- **OSHAL maintainability**

---

## Is This Pretty Much a Direct Port?

**No.**

It should be a:

- **direct port of process ideas** in some places
- **rewrite/adaptation** in a lot of places
- **hard no** for the old monolithic implementation shape

### Port directly in concept

These are the parts that should come over with very little conceptual change:

- 7-phase lifecycle
- PM / QA / specialist role split
- multi-round planning / execution / testing / review
- handover-driven continuity
- approval / reroute / stuck / circuit-breaker governance
- shared-workspace artifact discipline

### Adapt / rewrite for OSHAL

These should be rebuilt on OSHAL services, not copied verbatim:

- queue-governance service behavior
- phase orchestration wiring
- routing and state projection
- cockpit/operator APIs and views
- handover enforcement and continuation handling
- parent/child ticket assembly behavior

### Do **not** port as-is

These are the parts we should explicitly avoid copying wholesale:

- the giant legacy `QueueManagerService.js`
- old comment-thread-driven control flow
- old HTTP/container dispatch assumptions
- old monolithic routing logic
- old dashboard/UI structure

### The right mental model

```text
Port the workflow discipline.
Do not port the monolith.
```

---

## If You Only Read Three Things

1. **Legacy sibling is better at process control.**
2. **OSHAL is better at platform architecture.**
3. **The job now is to move the old process discipline onto the new platform.**

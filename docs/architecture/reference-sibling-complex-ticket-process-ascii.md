# Legacy Sibling Reference Complex Ticket Process — ASCII Flow

## Purpose

This document gives a **single-screen ASCII map** of the legacy sibling queue-manager path that current OSHAL work should emulate selectively.

It focuses on the stronger reference behavior found under:

- `control-plane/OSHAL/any-bot/server/services/queue-manager/QueueManagerService.js`
- `control-plane/OSHAL/any-bot/server/services/queue-manager/TicketPhaseManager.js`
- `control-plane/OSHAL/any-bot/server/services/queue-manager/PhaseRoundOrchestrator.js`
- `control-plane/OSHAL/any-bot/server/services/queue-manager/PhaseReviewCycle.js`
- `control-plane/OSHAL/any-bot/server/services/queue-manager/RALFHandoverManager.js`
- `control-plane/OSHAL/any-bot/server/services/queue-manager/ClineIntegration.js`
- `control-plane/OSHAL/any-bot/server/services/queue-manager/AgentInstructions.js`

Project context for comparison:

- current OSHAL baseline: `docs/architecture/complex-ticket-process-ascii.md`
- current OSHAL runtime contract: `docs/architecture/swarm-processing-design-contract.md`
- current OSHAL runtime flow: `docs/architecture/swarm-orchestration-process-flow.md`

> Scope note:
> This is a **reference-behavior map**, not a claim that every legacy detail should be ported one-for-one. The goal is to document the robust process shape that made the sibling runtime operationally effective.

---

## 1) High-Level End-to-End Flow

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ LEGACY SIBLING COMPLEX TICKET LIFECYCLE                                     │
└──────────────────────────────────────────────────────────────────────────────┘

Plane ticket enters Todo
    │
    ▼
QueueManagerService poll loop
    │
    ├─ detect stalled In Progress tickets and recover them
    ├─ respect cooldown / re-processing windows
    ├─ inspect reroute requests and recent completions
    ├─ apply concurrency pacing to avoid provider saturation
    └─ select next ticket to govern
    │
    ▼
Queue-manager governance pass
    │
    ├─ root ticket?        -> route to project-manager first
    ├─ child ticket?       -> route to specialist path directly
    ├─ approval granted?   -> inject approved-command context
    ├─ stale loop?         -> trip circuit breaker -> Customer Action
    └─ assign / attribute Plane ticket to selected bot user
    │
    ▼
Shared workspace resolution
    │
    ├─ reuse parent workspace when ticket is a child
    ├─ create shared task/workspace when missing
    ├─ write _meta.json
    ├─ ensure notes/, deliverables/, developer-handovers/
    └─ preserve child -> root workspace mapping across decomposition depth
    │
    ▼
TicketPhaseManager lifecycle
    │
    ├─ Phase 1: intake            (automated)
    ├─ Phase 2: planning          (project-manager)
    ├─ Phase 3: specialist_input  (high complexity only)
    ├─ Phase 4: execution
    ├─ Phase 5: testing
    ├─ Phase 6: review
    └─ Phase 7: delivery          (automated)
    │
    ▼
Per-phase round governance
    │
    ├─ PhaseRoundOrchestrator enforces mandatory rounds for phases 2-5
    ├─ PhaseReviewCycle runs consensus / revision loops for review phase
    ├─ RALFHandoverManager writes + summarizes round handovers
    └─ Queue Manager routes the next round/next phase agent explicitly
    │
    ▼
Agent execution session
    │
    ├─ previous thread summarized
    ├─ attachments + linked issues injected
    ├─ swarm memory queried
    ├─ phase prompt added
    ├─ workspace file listing injected
    ├─ round context injected
    └─ HTTP dispatch or Cline-backed session executes real work
    │
    ▼
Post-execution governance
    │
    ├─ detect decomposition requests
    ├─ create child issues when appropriate
    ├─ enforce depth / duplicate / active-subtask caps
    ├─ evaluate completion vs Todo / Customer Action / Approval Required
    ├─ regress failed testing to planning or execution
    ├─ route review feedback back to executor when needed
    └─ assemble parent deliverables when all children complete
    │
    ▼
Human/operator checkpoint
    │
    ├─ Customer Action for done / blocked / circuit-breaker cases
    ├─ Approval Required for dangerous tool actions
    └─ full thread + workspace + handovers available for inspection
```

---

## 2) Queue Manager Responsibilities

```text
The legacy QueueManagerService is not just a dispatcher.
It is the operational governor for the whole ticket story.

It owns:
  1. polling Todo queues (single or multi-workspace)
  2. cooldown and re-processing rules
  3. concurrency pacing / provider pressure control
  4. stalled-ticket recovery
  5. reroute request detection via comment protocol
  6. completion evaluation and human escalation
  7. shared workspace creation/reuse
  8. phase lifecycle initialization and advancement
  9. multi-round routing and review-cycle coordination
 10. child ticket decomposition + shared-workspace inheritance
 11. approval-required gating for sensitive commands
 12. stuck-agent watchdog + force release
 13. routing audit logging, metrics, and memory side effects
```

### Plane state model the operator can see

```text
Todo
  -> Routing
    -> In Progress
      -> In Review          (parent waiting on children, or review cycle in play)
      -> Approval Required  (human must approve a command)
      -> Customer Action    (done, blocked, escalated, or human review required)
```

---

## 3) Complexity Gate and 7 Phases

```text
TicketPhaseManager paths:

low complexity
  intake -> planning -> execution -> testing -> delivery

medium complexity
  intake -> planning -> execution -> testing -> review -> delivery

high complexity
  intake -> planning -> specialist_input -> execution -> testing -> review -> delivery
```

### Round discipline by phase

```text
Phase 1  INTAKE            -> 1 automated pass
Phase 2  PLANNING          -> 2 rounds (planner + reviewer/improver)
Phase 3  SPECIALIST_INPUT  -> 2 rounds (specialist perspectives)
Phase 4  EXECUTION         -> 2 rounds (executor + improver/reviewer)
Phase 5  TESTING           -> 2 rounds (tester + cross-check tester)
Phase 6  REVIEW            -> consensus cycle (2+ reviewers, revisions, max rounds)
Phase 7  DELIVERY          -> 1 automated pass
```

### Role ownership model

```text
Queue Manager
  - governs queue state, phase transitions, reroutes, escalations, approvals

Project Manager
  - planning authority
  - may emit AGENT_ASSIGNMENTS for execution order
  - decomposes large work into subtasks when justified

Task Manager / QA gatekeeper
  - verification / review authority
  - rejects outlines, TODOs, low-effort work

Specialists
  - execute, test, review, and provide domain input

Human operator
  - approves risky commands
  - resolves blocked/circuit-broken tickets
  - reviews final ticket output in Customer Action
```

---

## 4) Routing Decision Stack

```text
ROOT TICKET ROUTING
  root ticket
    -> project-manager first
    -> planning output may include AGENT_ASSIGNMENTS block
    -> Queue Manager prefers PM-assigned agents when present

SUBTASK ROUTING
  child / decomposed ticket
    -> LLM router primary
    -> mesh bid / self-nomination secondary
    -> capability matcher tertiary
    -> catch-all fallback if needed
```

### Selection signals used by the reference stack

```text
1. explicit PM assignment
2. LLM semantic routing over selector descriptors
3. mesh bid / self-claim confidence
4. capability overlap + specialist weighting
5. routing_keywords from agent persona metadata
6. round-robin penalty for agents already used on this ticket
7. project-manager demotion for non-PM work
8. worker-general catch-all when no specialist scores well
```

### Reroute protocol in the thread

```text
An agent can request re-routing by posting a structured comment:

@queue-manager
REQUEST: route to @agent:<agent-id>
COMPLETED: <what is done>
REMAINING: <what still needs to happen>
REASON: <why another specialist is required>

Queue Manager validates workspace scope and then returns the ticket to Todo
with preserved context for the next agent.
```

---

## 5) Prompt Stack and Execution Story

```text
PROMPT LAYERS IN THE REFERENCE STACK

1. Full Cline system prompt
   - tool contract
   - runtime behavior
   - shell / workspace expectations

2. Multi-perspective analysis frame
   - PerspectiveEngine overlays domain viewpoints

3. Collaboration and swarm-governance frame
   - specialist roster
   - reroute protocol
   - workspace and deliverable expectations
   - decomposition SOP

4. PM assignment directive (PM only)
   - requires AGENT_ASSIGNMENTS table in the plan output

5. Environment awareness block
   - kubectl/aws/docker/npm/etc availability
   - deployment expectations when relevant

6. Ticket assignment block
   - ticket/workspace/project metadata

7. Phase prompt
   - planning vs execution vs testing vs review role framing

8. Conversation / artifact context
   - summarized previous comments
   - attachments
   - linked issues
   - swarm memory
   - workspace file listing
   - round context
   - approval-granted context when relevant
```

### Execution path

```text
Queue Manager
  -> processWithAgent()
    -> HTTP dispatch to bot container when available
       OR
    -> ClineIntegration / Front Door / Cline CLI session
         -> workspace-aware execution
         -> file writes into shared workspace
         -> handover content returned inline and/or written to files

Important reference trait:
  execution is not treated as an isolated provider call.
  It is a workspace-first, thread-aware, continuation-capable session.
```

---

## 6) Workspace and Artifact Story

```text
shared workspace
├── _meta.json
├── notes/
├── deliverables/
├── developer-handovers/
└── mesh-transcripts/      (when peer collaboration is used)
```

### Artifact roles

```text
_meta.json
  - ticket ids
  - parent/child relationships
  - agents involved
  - last agent / last ticket / timestamps

notes/
  - working notes, research, investigation detail

deliverables/
  - final artifacts, code, documents, polished outputs

developer-handovers/
  - round and session handoffs
  - RALF memory trail for subsequent agents

mesh-transcripts/
  - extracted peer-to-peer communication records
```

### Shared workspace inheritance

```text
parent ticket creates or owns workspace
    │
    ├─ child tickets reuse parent workspace
    ├─ deeper descendants are mapped back to ROOT workspace
    └─ parent assembly later scans the same shared folder for outputs
```

### Parent completion assembly

```text
parent ticket in In Review
    │
    ├─ waits for all children to reach Done / Customer Action / Cancelled
    ├─ scans shared workspace for produced files
    ├─ gathers child deliverable summaries
    └─ posts assembled result + workspace link on parent ticket
```

---

## 7) Multi-Round, Review, and Continuation Behavior

```text
PHASE ROUND ORCHESTRATION
  round 1 output
    -> handover written
    -> orchestrator advances to round 2
    -> next agent receives summary of prior work

REVIEW CYCLE
  reviewer A verdict
  reviewer B verdict
    -> all approve?         yes -> consensus -> advance
    -> any revise?          yes -> route back to executor
    -> max rounds hit?      yes -> advance with warning / best effort
```

### Handover memory model

```text
Agent finishes round
  -> writes Developer Handover
Queue Manager
  -> reads all handovers from developer-handovers/
  -> builds executive summary
  -> injects summary into next agent prompt
Returning same agent?
  -> previous personal handover is injected as context recall
```

### Session continuation on stalls/timeouts

```text
ClineIntegration detects:
  - inactivity stall
  - hard timeout
  - retryable transient failures

Then it:
  1. extracts partial work summary from prior attempt
  2. builds a continuation prompt
  3. retries with explicit "continue from previous session" context
```

---

## 8) Failure Recovery and Governance Guardrails

```text
COOLDOWN + REPROCESSING
  - dynamic cooldown by complexity
  - new comment activity can break cooldown early

CIRCUIT BREAKER
  - hard cap on routing attempts
  - stale-loop detection by identical response hashes
  - escalates to Customer Action when bots are looping

STALL RECOVERY
  - stale In Progress tickets returned to Todo
  - StuckAgentWatchdog force-releases truly silent busy agents

APPROVAL GATING
  - dangerous tool action -> Approval Required
  - human moves ticket back to Todo to grant approval

WORKSPACE RECOVERY
  - if response is thin/default, Queue Manager scans workspace files
    and recovers the best substantive artifact

DECOMPOSITION GUARDRAILS
  - duplicate sibling detection
  - sentinel-title rejection
  - active-subtask caps
  - depth cutoff to stop recursive explosion

PARENT TIMEOUT ESCALATION
  - parents stuck waiting on children escalate visibly to human review
```

---

## 9) Full Complex Task Story in One Chain

```text
Todo ticket
  -> Queue Manager poll
  -> cooldown / stall / lock checks
  -> root ticket routed to project-manager
  -> shared workspace created or reused
  -> _meta.json + folders seeded
  -> intake
  -> planning round 1
  -> planning round 2
  -> optional specialist-input rounds
  -> execution routed to best specialist
  -> execution round 2 improvement / review
  -> testing by different agent
  -> review cycle with multiple reviewers
  -> revision loop if needed
  -> delivery packaging
  -> parent assembly if subtasks exist
  -> Customer Action with full thread + workspace evidence
```

---

## 10) Why This Reference Felt More Robust

```text
The legacy sibling runtime did not rely on one successful execution call to tell
the whole story.

It wrapped execution inside a richer governance shell:
  - queue-state discipline
  - explicit PM / QA role ownership
  - mandatory round structure
  - workspace-first artifact production
  - handover-driven context carryover
  - regression / reroute / approval / watchdog loops
  - operator-visible ticket state transitions

That governance shell — more than any one model/provider detail — is the real
reference behavior OSHAL still needs to close.
```
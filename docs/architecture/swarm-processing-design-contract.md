# Swarm Processing Design Contract

## Purpose

This document is the current design contract for swarm ticket processing in OSHAL.

Use it to answer four questions clearly:

1. What is the swarm process supposed to do?
2. How is it supposed to be called?
3. What technical dependencies are required for it to work?
4. Does the current code actually match that design?

This contract describes the active runtime model as of 2026-03-14 and the **target complex-ticket governance model** established by the Stage 1 contract alignment work on 2026-03-21.

Unless explicitly called out as a host-process shortcut, "local" means the local Docker Compose deployment of OSHAL.

> **Stage 1 addition (2026-03-21):**
> This document now includes sections on complex-ticket governance, role responsibilities, mandatory parity targets, and queue-manager lifecycle scope. These sections describe the **target contract** — what the runtime must evolve toward. Sections describing the **current runtime** are unchanged and marked accordingly.

---

## Canonical Design Decisions

The active swarm-processing design is:

- route-driven
- synchronous from the caller perspective
- auth-protected
- readiness-gated before execution
- seven-phase internally
- infrastructure-backed for real success today

That means:

- callers invoke HTTP routes and wait for orchestration to complete or fail
- the server must reject execution early when critical dependencies are unavailable
- the internal ticket lifecycle uses a 7-phase model with complexity-based phase skipping
- decomposition, routing, verification, and retry policy now share coarse work-intent signals
- a real successful run currently requires Postgres and a resolvable provider configuration
- Redis is optional for transport durability, not a hard boot requirement

---

## Complex-Ticket Governance Contract (Target)

> Added 2026-03-21 as part of Stage 1 contract alignment.
> This section defines the governance behaviors the runtime must support for complex (high-complexity) tickets.
> It is derived from the reference gap analysis in `docs/architecture/complex-ticket-reference-gap-plan.md`.

### Governance Principles

1. **The ticket is a governed story, not just a dispatched work item.**
   Every complex ticket must move through explicit phases with operator-visible state, role-based ownership, and structured progression — not a single dispatch with a pass/fail outcome.

2. **The queue manager is an operational governor, not just a prep service.**
   Beyond intake normalization, workspace seeding, and decomposition, the queue manager must track ticket lifecycle state, enforce cooldowns, handle reroutes, surface approval requirements, detect stuck/stale tickets, and coordinate parent/child assembly.

3. **Multi-round execution is the norm for complex tickets.**
   Each phase (planning, specialist_input, execution, testing, review) may require multiple rounds with different agents. Single-dispatch-per-phase is acceptable only for low-complexity tickets.

4. **Handovers are enforced contracts, not optional artifacts.**
   When a phase completes or a session stalls/times out, a structured handover must be written and injected into the next round's prompt context. This is what makes multi-session and multi-agent work resumable.

5. **Failure governance is explicit, not silent.**
   Regressions (failed testing → back to execution), revisions (failed review → back to execution), stale-loop detection, approval-required flows, and stuck-agent watchdog behavior must be first-class runtime states, not hidden retry loops.

6. **Operator visibility is a requirement, not a nicety.**
   Current phase, current round, assigned agent, queue state, escalation reason, and approval requirements must be inspectable from cockpit APIs and UIs.

### Queue Manager Lifecycle Scope (Target)

The queue manager's responsibilities extend beyond the current prep/enrichment model:

| Responsibility | Current state | Target state |
|---|---|---|
| Poll for approved tickets | Yes Implemented | Yes Keep |
| Workspace directory creation | Yes Implemented | Yes Keep |
| Ticket decomposition into subtasks | Yes Implemented | Yes Keep |
| `TASK-BRIEF.md` and `_meta.json` seeding | Yes Implemented | Yes Keep |
| Post-pipeline enrichment (routing decisions, handovers) | Yes Implemented | Yes Keep |
| Ticket lifecycle state tracking (Todo → Routing → In Progress → In Review → Done) | ⬜ Not implemented | 🎯 Mandatory parity target |
| Cooldown rules between processing attempts | ⬜ Not implemented | 🎯 Mandatory parity target |
| Reroute request handling | ⬜ Not implemented | 🎯 Mandatory parity target |
| Approval-required state for risky/destructive commands | ⬜ Not implemented | 🔶 Recommended |
| Parent waiting / child assembly coordination | ⬜ Not implemented | 🔶 Recommended |
| Stalled-ticket detection and recovery | ⬜ Not implemented | 🎯 Mandatory parity target |
| Circuit-breaker / stale-loop detection | ⬜ Not implemented | 🎯 Mandatory parity target |
| Stuck-agent watchdog | ⬜ Not implemented | 🔶 Recommended |

### Role Responsibilities (Target)

Complex-ticket processing requires distinct agent roles. These are OSHAL contract-level role definitions, not legacy implementation carryovers.

#### Project Manager (PM) / Planner

- **Owns:** planning phase, decomposition review, task-brief generation
- **Responsibilities:**
  - Assess ticket scope and complexity
  - Decompose into subtasks with acceptance criteria
  - Assign specialist roles to subtasks
  - Write initial `TASK-BRIEF.md`
  - Review decomposition quality before execution begins
- **Phase activity:** Phases 1-2 (intake, planning)

#### Domain Specialist

- **Owns:** specialist_input phase contributions
- **Responsibilities:**
  - Provide domain-specific guidance and constraints
  - Review decomposition from domain perspective
  - Flag risks or missing requirements
- **Phase activity:** Phase 3 (specialist_input)

#### Executor / Developer

- **Owns:** execution phase work
- **Responsibilities:**
  - Implement the work described in the task brief and subtask specifications
  - Write deliverables to workspace
  - Write developer handover notes
  - Report completion status honestly
- **Phase activity:** Phase 4 (execution)

#### Tester / QA Agent

- **Owns:** testing phase
- **Responsibilities:**
  - Validate deliverables against acceptance criteria
  - Run tests or verification checks
  - Report pass/fail with specific evidence
  - Trigger regression to execution if testing fails
- **Phase activity:** Phase 5 (testing)

#### Reviewer / QA Gatekeeper

- **Owns:** review phase, consensus review
- **Responsibilities:**
  - Assess overall quality and completeness
  - Check deliverables, handovers, and workspace artifacts
  - Approve for delivery or request revision
  - Trigger regression to execution if review fails
  - Provide structured review verdict with evidence
- **Phase activity:** Phase 6 (review)

### Phase Governance Rules (Target)

Each phase in the complex-ticket lifecycle must satisfy these governance rules:

| Phase | Min rounds (complex) | Role ownership | Required outputs | Regression target |
|---|---|---|---|---|
| 1. intake | 1 | System | Normalized `ExternalWorkItem`, complexity assessment | — |
| 2. planning | 1-3 | PM / Planner | `TASK-BRIEF.md`, subtask specs, acceptance criteria | — |
| 3. specialist_input | 0-2 | Domain specialists | Domain notes, constraint flags | planning |
| 4. execution | 1-3 | Executor / Developer | Deliverables, developer handovers | planning |
| 5. testing | 1-2 | Tester / QA Agent | Test results, pass/fail verdict | execution |
| 6. review | 1-3 | Reviewer / QA Gatekeeper | Review verdict, approval/revision | execution |
| 7. delivery | 1 | System | Final workspace assembly, provider write-back | — |

Regression rules:
- Failed testing → regress to execution (not planning)
- Failed review → regress to execution with reviewer feedback injected
- Failed specialist_input → regress to planning with specialist notes injected
- Maximum regression count per ticket: configurable, default 3

### Handover Enforcement Rules (Target)

| Trigger | Required handover behavior |
|---|---|
| Phase completion | Write phase handover summary to workspace |
| Round completion within a phase | Carry forward round output as next-round context |
| Session timeout or stall | Generate continuation brief with partial progress |
| Agent switch (different agent for next round) | Inject prior agent's handover into new agent's prompt |
| Regression (phase sent backward) | Include regression reason and reviewer/tester feedback in regressed-phase prompt |

Handover artifacts must be written to `workspace/{ticketId}/developer-handovers/` and referenced in `_meta.json`.

---

## Mandatory Parity Targets vs Optional Behaviors

> Added 2026-03-21 as part of Stage 1 contract alignment.

### 🎯 Mandatory Parity Targets

These behaviors must be implemented to achieve reference-quality complex-ticket processing. They are the minimum governance shell required around the existing execution engine.

1. **Queue-manager lifecycle state tracking** — tickets must have operator-visible states beyond "submitted" and "done"
2. **Multi-round phase dispatch** — `PhaseRoundOrchestrator` must be authoritative for phases 2-5, not just review
3. **Role-based agent selection per phase** — different agent roles for planning vs execution vs testing vs review
4. **Handover enforcement** — phase completions and session timeouts must produce structured handovers
5. **Regression loops** — failed testing/review must regress to execution with feedback, not just fail the ticket
6. **Cooldown and stale-ticket detection** — prevent infinite reprocessing of stuck tickets
7. **Circuit-breaker for looping agents** — detect and halt non-progress execution loops
8. **Operator-visible phase/round/agent state** — cockpit APIs must expose current processing state

### 🔶 Recommended (Port When Practical)

These behaviors improve operational quality but are not blocking for initial reference parity.

1. **Approval-required flow** — operator checkpoint before risky commands execute
2. **Parent/child assembly** — wait for child completions before assembling parent deliverable
3. **Stuck-agent watchdog** — background process that detects agents that stop responding
4. **Workspace recovery scan** — detect orphaned workspace artifacts from crashed sessions
5. **Cost and token metrics per phase/round** — detailed consumption tracking

### ⛔ Not Porting

These are legacy implementation details that should not be carried into OSHAL.

1. **Monolithic QueueManagerService.js** — the 2500+ line single-file coordinator pattern
2. **Redis-based agent registry with watchdog** — OSHAL uses Postgres-backed agent profiles
3. **Raw `console.log` logging** — OSHAL uses structured JSON logging (Pino)
4. **Hardcoded prompt templates** — OSHAL uses persona layers and prompt composition services
5. **Single-process polling loop** — OSHAL should keep its service-boundary architecture

---

## Functional Specification

### Supported Entry Points

#### Direct Submission

Route:

- `POST /api/swarm/tickets`

Intent:

- accepts caller-supplied tickets
- normalizes them into canonical `ExternalWorkItem` records
- runs them through the full swarm orchestration path

Caller contract:

- request is authenticated
- body contains `tickets[]`
- response is a completed run summary or a dependency/error response

#### Provider Pull and Process

Route:

- `POST /api/swarm/providers/:provider/process`

Intent:

- pulls provider-backed items through intake adapters
- normalizes them into canonical `ExternalWorkItem` records
- runs them through the same internal swarm orchestration path

Caller contract:

- request is authenticated
- provider is valid
- provider configuration exists when the provider path requires it
- response is a completed run summary or a dependency/error response

#### Queue Manager Background Path

> Added 2026-03-21: documents the existing queue-manager polling path.

Entry:

- `QueueManagerService` 60-second polling loop picks up approved internal tickets

Intent:

- applies workspace seeding, decomposition, and enrichment before dispatch
- feeds normalized tickets into the same swarm processing pipeline
- writes post-pipeline artifacts (routing decisions, handovers, deliverables)

Contract:

- only processes tickets in "approved" state
- creates workspace directory structure before dispatch
- decomposes tickets into subtasks with parent linkage
- enriches workspace with `TASK-BRIEF.md`, `_meta.json`, routing decisions
- **target:** must also track ticket lifecycle state and enforce governance rules listed above

### Functional Behavior Rules

1. Swarm processing is synchronous at the HTTP boundary.
2. A mounted route is not proof of successful end-to-end execution.
3. Direct and provider entry points must converge into the same internal orchestration model.
4. Provider processing is ticket-mode only.
5. Failure to satisfy critical runtime prerequisites must return `503` before execution starts.
6. Successful completion must produce a run record and ticket-level lifecycle output.
7. **Target:** Complex tickets must produce operator-visible phase/round progression, not just a final run summary.
8. **Target:** Failed phases must trigger structured regression, not silent failure.

## Technical Specification

### Required Runtime Dependencies for Real Execution

| Dependency | Required now | Reason |
|------------|--------------|--------|
| Auth | Yes | `/api/swarm/*` is protected |
| OIDC/Keycloak | Yes in normal mode | Needed for real auth |
| `MOCK_OIDC=true` | Local-only alternative | Enables protected-route access without real OIDC |
| Postgres | Yes for real success today | Work items, agent profiles, persona layers, run state, output polling |
| LLM provider resolver | Yes | Worker execution reuses main app provider resolver |
| Seeded agents/persona data | Yes | Routing and execution depend on them |
| Redis | No | Optional durable transport only |

### Transport Rules

- `SWARM_MESH_TRANSPORT=redis` forces Redis transport
- `REDIS_URL` also selects Redis transport when no explicit transport is set
- otherwise the runtime uses in-memory mesh transport

### Failure Rules

- missing auth in normal mode returns `401`
- missing or failed readiness dependencies return `503`
- missing Postgres currently blocks real completion, not just persistence niceties
- absence of Redis must not prevent the swarm extension from booting

### Current Response Boundary

The current public contract for failed readiness is:

```json
{
  "error": "Swarm processing cannot start because Postgres is unavailable",
  "details": {
    "dependency": "postgres",
    "error": "connect ECONNREFUSED 127.0.0.1:6543"
  }
}
```

That is the correct current route-level behavior for missing Postgres.

## Architectural Specification

### Layered Responsibility Model

#### Route Layer

Responsibilities:

- auth-protected HTTP entrypoints
- request validation
- direct-vs-provider entry normalization
- dependency failure translation into HTTP responses

Primary code:

- `src/app/extensions/swarm/routes/swarm-orchestration-routes.ts`
- `src/features/swarm-orchestration/controllers/swarm-orchestration-controller.ts`

#### Orchestration Layer

Responsibilities:

- run creation
- phase progression
- decomposition
- routing
- execution-policy coordination
- verification and escalation handling
- write-back coordination
- **target:** multi-round dispatch per phase
- **target:** role-based agent selection
- **target:** regression handling on failed testing/review
- **target:** handover enforcement between rounds and phases

Behavioral note:

- retry reasons and escalation routing should reflect the failure class when known, including work-intent-specific evidence gaps and infra-style timeout/resource conditions
- consensus review prompts should also carry work-intent review focus so reviewers judge the correct evidence class instead of using one generic QA frame
- consensus review parsing should normalize reviewer findings into stable evidence-gap signals so downstream policy/reporting can reason about testing, documentation, integration, analysis, and generic review misses

Primary code:

- `src/features/swarm-orchestration/services/swarm-ticket-processing-service.ts`
- `src/features/swarm-orchestration/services/swarm-execution-policy-runner.ts`
- `src/features/swarm-orchestration/services/ticket-cycle-state-machine.ts`
- `src/features/swarm-orchestration/services/swarm-writeback-handler.ts`
- `src/features/swarm-orchestration/services/phase-round-orchestrator.ts`
- `src/features/swarm-orchestration/services/consensus-review-service.ts`

#### Queue Governance Layer (Target)

> Added 2026-03-21 as part of Stage 1 contract alignment.

Responsibilities:

- ticket lifecycle state management (Todo → Routing → In Progress → In Review → Approval Required → Done)
- cooldown enforcement between processing attempts
- reroute request handling
- stalled-ticket and circuit-breaker detection
- parent/child coordination
- operator-visible state projection to cockpit APIs

Primary code:

- `src/features/swarm-orchestration/services/queue-manager-service.ts`
- `src/features/swarm-orchestration/services/swarm-writeback-handler.ts`
- `src/features/swarm-orchestration/services/postgres-swarm-escalation-store.ts`

#### Execution Layer

Responsibilities:

- mesh transport publish/consume
- worker execution
- provider resolution
- prompt/persona composition
- work-item output recording

Primary code:

- `src/app/extensions/swarm/index.ts`
- `src/features/swarm-orchestration/services/swarm-agent-worker.ts`
- `src/features/swarm-orchestration/services/llm-execution-handler.ts`
- `src/features/swarm-orchestration/services/swarm-ticket-processing-support.ts`

#### Persistence Layer

Responsibilities:

- run records
- work items
- escalations
- subtask lifecycle
- agent profiles
- persona layers

Primary code:

- `src/features/swarm-orchestration/services/postgres-swarm-run-store.ts`
- `src/entities/work-item/repositories/work-item-repository.ts`
- `src/features/swarm-orchestration/services/postgres-swarm-escalation-store.ts`
- `src/features/swarm-orchestration/services/postgres-subtask-lifecycle-store.ts`
- `src/entities/agent/repositories/agent-profile-repository.ts`
- `src/features/agent-management/services/persona-layer-store.ts`

## Canonical Internal Process Flow

### Current Flow (As-Is)

```text
Authenticated caller
   │
   ├── POST /api/swarm/tickets
   │      or
   └── POST /api/swarm/providers/:provider/process
          │
          ▼
SwarmOrchestrationController
   │
   ├── validate request
   ├── normalize direct/provider entry
   ├── invoke readiness-gated processing service
   └── translate readiness failure to 503
          │
          ▼
SwarmTicketProcessingService
   │
   ├── create run record
   ├── process each ticket through 7-phase lifecycle
   └── persist run result
          │
          ▼
7-Phase Lifecycle
   1. intake
   2. planning
   3. specialist_input
   4. execution
   5. testing
   6. review
   7. delivery
          │
          ▼
Worker / provider / persistence path
   │
   ├── publish envelope
   ├── resolve provider
   ├── execute
   ├── persist output
   ├── verify / escalate
   └── optional provider write-back
```

### Target Flow (Complex Ticket with Governance)

> Added 2026-03-21 as part of Stage 1 contract alignment.

```text
Approved ticket (queue-manager path or direct submission)
   │
   ▼
QueueManagerService / SwarmOrchestrationController
   │
   ├── normalize into ExternalWorkItem
   ├── assess complexity (low / medium / high)
   ├── create workspace directory structure
   ├── seed TASK-BRIEF.md, _meta.json
   └── set ticket state: "Routing"
          │
          ▼
SwarmTicketProcessingService
   │
   ├── create run record
   ├── set ticket state: "In Progress"
   └── enter phase loop ──────────────────────────────────────┐
          │                                                    │
          ▼                                                    │
   ┌─ Phase Gate ─────────────────────────────────────────┐   │
   │  Check: is this phase active for this complexity?     │   │
   │  If skipped → advance to next phase                   │   │
   │  If active → enter round loop                         │   │
   └───────────────────────────────────────────────────────┘   │
          │                                                    │
          ▼                                                    │
   ┌─ Round Loop (PhaseRoundOrchestrator) ────────────────┐   │
   │  1. Select agent by role for this phase               │   │
   │  2. Build prompt: persona + handover + task context    │   │
   │  3. Dispatch execution envelope                       │   │
   │  4. Wait for output                                   │   │
   │  5. Record round result                               │   │
   │  6. If more rounds needed → loop                      │   │
   │  7. If phase complete → write phase handover           │   │
   └───────────────────────────────────────────────────────┘   │
          │                                                    │
          ▼                                                    │
   ┌─ Phase Verdict ──────────────────────────────────────┐   │
   │  Testing failed? → regress to execution               │   │
   │  Review failed?  → regress to execution + feedback    │   │
   │  Regression limit hit? → escalate                     │   │
   │  Phase passed? → advance to next phase                │   │
   └───────────────────────────────────────────────────────┘   │
          │                                                    │
          ├── next phase ──────────────────────────────────────┘
          │
          ▼
   delivery phase
   │
   ├── assemble final workspace artifacts
   ├── write completion handover
   ├── optional provider write-back
   ├── set ticket state: "Done" / "Customer Action"
   └── return run summary
```

### Complexity Gate Rules

- low complexity: `intake -> planning -> execution -> delivery`
- medium complexity: `intake -> planning -> execution -> testing -> review -> delivery`
- high complexity: all 7 phases

## How To Call It

### Direct Submission

```bash
curl -s -i -X POST http://localhost:3456/api/swarm/tickets \
  -H 'Content-Type: application/json' \
  --data '{
    "tickets": [
      {
        "title": "Create hello world endpoint",
        "body": "Node 20 Express app with /health and README",
        "labels": ["demo", "backend"],
        "priority": "medium"
      }
    ],
    "policy": {
      "maxRunDurationMs": 120000
    }
  }'
```

### Provider Pull and Process

```bash
curl -s -i -X POST http://localhost:3456/api/swarm/providers/plane/process \
  -H 'Content-Type: application/json' \
  --data '{
    "interactionMode": "ticket",
    "limit": 10,
    "includeSubtickets": false,
    "useStoredCursor": false,
    "persistCursor": false,
    "policy": {
      "maxRunDurationMs": 120000
    }
  }'
```

### Local Container Diagnostic Access

For local container protected-route access without real OIDC:

- start the server with `MOCK_OIDC=true`

Important:

- this enables auth bypass at the server
- it does not create a true local execution mode
- it only removes OIDC as a blocker

## Design-To-Code Alignment Check

### Matches Design

- swarm routes are mounted behind auth
- direct and provider routes converge on the same processing service
- runtime readiness failures now surface as `503`
- mesh transport can fall back to memory when Redis is absent
- the internal lifecycle is 7-phase with complexity gating
- queue-manager polling loop picks up approved tickets and seeds workspace

### Partially Matches Design

- the code cleanly distinguishes route readiness from deep execution failure, but only at the entry boundary
- the system has a diagnostic/local-auth mode, but not a true reduced-capability local execution mode
- verification is structured and policy-aware, but not yet domain-specific enough to count as business acceptance testing
- `PhaseRoundOrchestrator` exists but is not yet authoritative for phases 2-5
- queue-manager does prep/enrichment but does not yet govern ticket lifecycle state

### Does Not Yet Meet Target Contract

1. Real successful execution still depends on Postgres.
2. There is no infrastructure-light local execution mode.
3. The operator/debug surfaces are diagnostic, not an operator-grade production control plane.
4. Multi-round dispatch is not yet the default for complex tickets.
5. Role-based agent selection per phase is not yet enforced.
6. Handover enforcement is not yet automatic on phase completion or session timeout.
7. Regression loops (failed testing → execution) are not yet structured.
8. Queue-manager does not yet track ticket lifecycle states beyond prep.
9. Cooldown, circuit-breaker, and stale-ticket detection are not yet implemented.
10. Operator-visible phase/round/agent state is not yet exposed in cockpit APIs.

## Current Engineering Rule

Any future swarm change must keep these boundaries explicit:

- auth access is not execution readiness
- route registration is not end-to-end proof
- local mock auth is not local execution
- Redis optionality does not remove Postgres dependence
- architecture docs, feature docs, and ADRs must be updated together when the contract changes
- **target governance behaviors listed in this contract are the implementation roadmap for Stages 2-6**

## API Reference

| Method | Route | Request | Response |
|--------|-------|---------|----------|
| `POST` | `/api/swarm/tickets` | `{ tickets: [{ title, body?, labels?, priority? }], policy? }` | run summary after synchronous processing |
| `POST` | `/api/swarm/providers/:provider/process` | `{ limit, cursor?, policy?, includeSubtickets? }` | provider run summary after synchronous processing |
| `GET` | `/api/swarm/runs` | `?limit=50` | recent run records |
| `GET` | `/api/swarm/runs/:runId` | — | run detail |
| `GET` | `/api/swarm/work-items` | `?runId=X` or `?externalId=X` or `?limit=100` | work-item records |
| `GET` | `/api/swarm/escalations` | query params optional | escalation records |
| `GET` | `/api/swarm/smoke` | — | provider smoke result |
| `POST` | `/api/swarm/agents` | `AgentSpecification` | agent creation result |
| `GET` | `/api/swarm/agents` | — | agent list |
| `DELETE` | `/api/swarm/agents/:agentId` | — | delete result |

## Database Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `work_items` | Work unit state tracking | `work_item_id`, `swarm_run_id`, `status`, `execution_output`, `verification_result` |
| `swarm_runs` | Run lifecycle persistence | `run_id`, `provider`, `status`, `lifecycle_snapshot` |
| `swarm_escalations` | Failed ticket records | `run_id`, `ticket_id`, `target`, `severity`, `reason` |
| `agents` | Agent profile definitions | `agent_id`, `name`, `persona`, `base_capabilities`, `metadata` |
| `persona_layers` | Multi-layer prompt composition | `layer_type`, `priority`, `prompt_fragment` |
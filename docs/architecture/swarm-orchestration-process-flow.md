# Swarm Orchestration — Process Flow & Architecture

## Purpose

This document describes the swarm process as it works today and the **target complex-ticket lifecycle** established by Stage 1 contract alignment (2026-03-21). It separates:

- routes that exist
- runtime dependencies required for success
- observed failure modes
- **target governance behaviors** (marked with "Target:" prefix)

Unless explicitly stated otherwise, "local" here means the Docker Compose runtime on the developer machine.

For the current authoritative contract, also read:

- `docs/architecture/swarm-processing-design-contract.md`
- `docs/adr/018-swarm-processing-runtime-contract.md`

For the reference comparison and improvement plan:

- `docs/architecture/complex-ticket-reference-gap-plan.md`
- `docs/architecture/complex-ticket-reference-executive-summary.md`

## Reality Summary (2026-03-21)

- The swarm API routes are mounted and protected by auth.
- The `/ui` page can call those routes and inspect results.
- Redis is no longer mandatory to boot the swarm extension because transport can fall back to memory.
- Postgres is still effectively required for a successful end-to-end swarm execution in the current wiring.
- The direct route and the provider route are both synchronous process calls. They do not just enqueue work and return immediately.
- The queue-manager polling loop picks up approved internal tickets, seeds workspaces, decomposes into subtasks, and feeds them into the swarm pipeline.
- `PhaseRoundOrchestrator` exists with multi-round state tracking but is not yet authoritative for phases 2-5.
- Execution reaches Cline-backed worker path through `SwarmAgentWorker` → `LocalHostAgent` → `ClineCliTransport`.

## Process Preconditions

### Required Before Calling Swarm Processing

| Dependency | Current requirement | Why it matters |
|------------|---------------------|----------------|
| Auth | Required | `/api/swarm/*` routes are protected |
| Keycloak/OIDC | Required in normal mode | Needed for real auth unless `MOCK_OIDC=true` |
| `MOCK_OIDC=true` | Optional local bypass | Only for local development; bypasses real auth |
| Postgres | Required for reliable end-to-end success today | Work items, agent profiles, persona layers, and output polling depend on it |
| LLM provider config | Required | Worker execution reuses the app's provider resolver |
| Seeded agents/persona data | Required | Routing and execution expect agent definitions |
| Redis | Optional | Durable transport when available; otherwise in-memory fallback |
| Plane config | Required only for Plane path | Needed for intake and write-back against Plane |

### Important Operational Truth

Today, "the route exists" does not mean "the process works." A real swarm result depends on the preconditions above.

## Auth and Entry Rules

- All swarm routes are protected by `requiresAuth`.
- In normal mode, unauthenticated API calls return `401`.
- In local development, starting the server with `MOCK_OIDC=true` bypasses OIDC and allows protected routes without a real identity provider.
- Browser `localStorage` does not enable mock auth. The server environment variable does.
- When runtime readiness checks fail, swarm processing routes return `503` before execution starts.

## Entry Point A — Direct Submission

### Route

`POST /api/swarm/tickets`

### Request Shape

```json
{
  "tickets": [
    {
      "title": "Create a hello-world Express server",
      "body": "Node 20, include one health route and a README",
      "labels": ["demo", "backend"],
      "priority": "medium"
    }
  ],
  "policy": {
    "maxRunDurationMs": 120000
  }
}
```

### Process Flow

```text
Authenticated caller
   │
   ▼
POST /api/swarm/tickets
   │
   ▼
SwarmOrchestrationController.submitTickets()
   │
   ├─ validates request body
   ├─ converts each ticket into ExternalWorkItem(provider='direct')
   └─ calls SwarmTicketProcessingService.processTickets(...)
   │
   ▼
SwarmTicketProcessingService.processOneTicket(...)
   │
   ├─ intake / normalize
   ├─ decompose into work units
   ├─ persist work items
   ├─ select agent(s)
   ├─ dispatch execution envelope on mesh transport
   ├─ wait for execution output by polling work items
   ├─ verify outcome
   └─ return run summary
```

### What the Caller Must Understand

- This is a synchronous orchestration request.
- The request can block while the service waits for execution output.
- The output wait loop is capped by policy and currently polls every 2 seconds.
- If Postgres or provider readiness fails, the route now returns `503` before execution starts.
- If infrastructure disappears after the readiness check passes, deeper runtime failures are still possible.

## Entry Point B — Provider Pull and Process

### Route

`POST /api/swarm/providers/:provider/process`

### Request Shape

```json
{
  "interactionMode": "ticket",
  "limit": 10,
  "includeSubtickets": false,
  "useStoredCursor": false,
  "persistCursor": false,
  "policy": {
    "maxRunDurationMs": 120000
  }
}
```

### Process Flow

```text
Authenticated caller
   │
   ▼
POST /api/swarm/providers/plane/process
   │
   ▼
SwarmOrchestrationController.processProvider()
   │
   └─ calls SwarmTicketProcessingService.processProvider('plane', input)
      │
      ├─ IntakeService.pull('plane', input)
      │  └─ PlaneWorkItemFeedAdapter fetches provider items
      ├─ normalizes provider items into ExternalWorkItem[]
      └─ processes each item through the same internal swarm path
```

### Plane-Specific Preconditions

- `PLANE_API_URL`
- `PLANE_API_TOKEN`
- project/workspace identifiers, or explicit intake/write-back URLs

If those are missing, the route cannot produce a real provider-backed result.

## Entry Point C — Queue Manager Background Path

> Added 2026-03-21 as part of Stage 1 contract alignment.

### Entry

`QueueManagerService` 60-second polling loop picks up approved internal tickets.

### Process Flow (Current)

```text
QueueManagerService.pollAndDispatch()
   │
   ├─ query for tickets in "approved" state
   ├─ for each approved ticket:
   │    │
   │    ├─ TaskFolderService.ensureWorkspaceDir(ticketId)
   │    ├─ TicketDecompositionService.decompose(ticket)
   │    │    └─ creates subtasks with parent_ticket_id linkage
   │    ├─ seed TASK-BRIEF.md, _meta.json, ROUTING-DECISIONS.md
   │    ├─ feed into SwarmTicketProcessingService.processTickets(...)
   │    └─ post-pipeline: write routing decisions, handovers, deliverables
   │
   └─ wait POLL_INTERVAL_MS (default 60000) → repeat
```

### Target Governance Additions

The queue-manager path must evolve to include:

- **Ticket lifecycle state tracking:** set state transitions (Todo → Routing → In Progress → In Review → Done) at each processing stage
- **Cooldown enforcement:** prevent reprocessing a ticket within a configurable cooldown window
- **Stale-ticket detection:** flag tickets stuck in "In Progress" beyond a threshold
- **Circuit-breaker:** halt processing for tickets that have been attempted and failed N times
- **Reroute handling:** accept reroute requests that reassign a ticket to a different agent/role

## Internal Runtime Flow

The public routes above converge into the same internal process.

### Phase-Level View (Current)

```text
1. Intake
   normalize external item into OSHAL ticket shape

2. Decompose
   split work into units and prepare acceptance criteria

3. Persist
   create work items and initial state

4. Select
   choose agent(s) from explicit candidates, bids, or stored agent profiles

5. Execute
   send mesh envelope to worker
   resolve agent profile + persona layers
   invoke LLM provider
   persist execution output

6. Verify
   inspect output, retries, regressions, escalation policy

7. Write back
   optional provider update such as Plane lifecycle comment/state transition
```

### Target Phase-Level View (Complex Ticket with Governance)

> Added 2026-03-21 as part of Stage 1 contract alignment.

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ COMPLEX TICKET LIFECYCLE — TARGET GOVERNANCE MODEL                       │
└──────────────────────────────────────────────────────────────────────────┘

Phase 1: INTAKE (System)
   ├─ normalize external item into ExternalWorkItem
   ├─ assess complexity: low / medium / high
   ├─ set ticket state: "Routing"
   └─ output: normalized ticket, complexity rating

Phase 2: PLANNING (PM / Planner role, 1-3 rounds)
   ├─ round loop via PhaseRoundOrchestrator:
   │    ├─ select PM agent
   │    ├─ build prompt: persona + ticket context
   │    ├─ dispatch execution → collect output
   │    ├─ if more rounds needed → inject prior round output → loop
   │    └─ write phase handover on completion
   ├─ required outputs: TASK-BRIEF.md, subtask specs, acceptance criteria
   └─ output: decomposed plan with acceptance criteria

Phase 3: SPECIALIST_INPUT (Domain Specialist role, 0-2 rounds)
   ├─ skipped for low/medium complexity
   ├─ round loop via PhaseRoundOrchestrator:
   │    ├─ select domain specialist agent(s)
   │    ├─ build prompt: persona + plan + domain context
   │    ├─ dispatch execution → collect domain notes
   │    └─ write phase handover on completion
   ├─ regression: if specialist flags critical issues → regress to planning
   └─ output: domain notes, constraint flags, risk flags

Phase 4: EXECUTION (Executor / Developer role, 1-3 rounds)
   ├─ round loop via PhaseRoundOrchestrator:
   │    ├─ select executor agent
   │    ├─ build prompt: persona + task brief + prior handovers + subtask spec
   │    ├─ dispatch execution via Cline-backed worker → collect output
   │    ├─ if more rounds needed → inject prior round output → loop
   │    └─ write phase handover + developer handover on completion
   ├─ required outputs: deliverables in workspace, developer handover notes
   └─ output: implemented deliverables

Phase 5: TESTING (Tester / QA Agent role, 1-2 rounds)
   ├─ round loop via PhaseRoundOrchestrator:
   │    ├─ select tester agent (different from executor)
   │    ├─ build prompt: persona + acceptance criteria + deliverables reference
   │    ├─ dispatch execution → collect test results
   │    └─ write phase handover on completion
   ├─ verdict: pass or fail with specific evidence
   ├─ regression: if testing fails → regress to execution with tester feedback
   ├─ regression limit: configurable, default 3
   └─ output: test results, pass/fail verdict

Phase 6: REVIEW (Reviewer / QA Gatekeeper role, 1-3 rounds)
   ├─ round loop via PhaseRoundOrchestrator + ConsensusReviewService:
   │    ├─ select reviewer agent(s) (different from executor)
   │    ├─ build prompt: persona + deliverables + test results + acceptance criteria
   │    ├─ dispatch execution → collect review verdict
   │    ├─ consensus check: if multiple reviewers, aggregate verdicts
   │    └─ write phase handover on completion
   ├─ verdict: approve or request revision with evidence
   ├─ regression: if review fails → regress to execution with reviewer feedback
   ├─ regression limit: configurable, default 3
   └─ output: review verdict, approval/revision decision

Phase 7: DELIVERY (System)
   ├─ assemble final workspace artifacts
   ├─ write completion handover to workspace
   ├─ optional provider write-back (Plane state transition, comment)
   ├─ set ticket state: "Done" / "Customer Action"
   └─ output: run summary, final workspace state
```

### Regression Flow (Target)

```text
Testing fails
   │
   ├─ regression count < limit?
   │    ├─ YES → regress to execution phase
   │    │         inject tester feedback into executor prompt
   │    │         increment regression count
   │    │         re-enter execution round loop
   │    │
   │    └─ NO  → escalate ticket
   │              set ticket state: "Escalated"
   │              surface in cockpit
   │
Review fails
   │
   ├─ regression count < limit?
   │    ├─ YES → regress to execution phase
   │    │         inject reviewer feedback into executor prompt
   │    │         increment regression count
   │    │         re-enter execution round loop
   │    │
   │    └─ NO  → escalate ticket
   │              set ticket state: "Escalated"
   │              surface in cockpit
```

### Handover Flow (Target)

```text
Phase completion
   │
   ├─ PhaseRoundOrchestrator marks phase complete
   ├─ RALFHandoverManager writes phase handover summary
   │    └─ written to workspace/{ticketId}/developer-handovers/phase-{N}-handover.md
   ├─ _meta.json updated with handover reference
   └─ next phase prompt includes handover summary

Session timeout / stall
   │
   ├─ execution policy detects timeout
   ├─ RALFHandoverManager generates continuation brief
   │    └─ includes: work completed, remaining work, key context
   ├─ continuation brief written to workspace
   └─ next session prompt includes continuation brief

Agent switch (different agent for next round)
   │
   ├─ prior agent's output recorded as round result
   ├─ new agent's prompt includes prior agent's output as context
   └─ handover injection is automatic, not opt-in
```

### Current Dependency Hotspots

- Work-item persistence and output polling are Postgres-dependent in practice.
- Agent profile and persona composition are Postgres-dependent.
- LLM execution depends on the same provider resolver used by chat.
- Redis improves delivery durability but is not currently required just to boot the swarm extension.

## Transport Behavior

### Current Selection Logic

- `SWARM_MESH_TRANSPORT=redis` forces Redis transport
- `REDIS_URL` with no explicit transport also selects Redis transport
- otherwise the app uses in-memory mesh transport

### What This Means

- Missing Redis no longer blocks swarm boot by itself.
- Missing Postgres still blocks a real successful execution path in the current runtime.

## Real Test Cases

### Test Case 1 — Auth Enforcement

Purpose: confirm protected swarm and operator routes are not public.

Expected result:
- unauthenticated `/api/swarm/*` returns `401`
- unauthenticated `/api/v1/agent/*` returns `401`
- `/cockpit` is not publicly served

### Test Case 2 — Local Diagnostic Mode

Setup:
- start server with `MOCK_OIDC=true`
- no Redis configured

Expected result:
- protected routes are callable because mock auth is enabled
- swarm transport falls back to in-memory
- UI surfaces load

Important limitation:
- this does not prove end-to-end swarm execution unless Postgres and provider config are also valid

### Test Case 3 — Real Direct Swarm Run

Setup:
- authenticated request
- reachable Postgres
- seeded agents/persona data
- valid LLM provider config
- optional Redis

Call:
- `POST /api/swarm/tickets`

Expected result:
- run record returned
- work items persisted
- execution output available through `/api/swarm/work-items?runId=...`

### Test Case 4 — Plane Pull and Process

Setup:
- everything from Test Case 3
- valid Plane configuration

Call:
- `POST /api/swarm/providers/plane/process`

Expected result:
- provider items pulled
- processed count returned
- optional write-back visible in Plane

### Test Case 5 — Complex Ticket with Governance (Target)

> Added 2026-03-21 — this test case describes the target behavior after Stages 2-4 are implemented.

Setup:
- everything from Test Case 3
- high-complexity ticket submitted

Call:
- `POST /api/swarm/tickets` with a complex ticket

Expected result:
- ticket progresses through all 7 phases with operator-visible state
- multiple rounds occur in planning, execution, and review phases
- different agents are selected for different phase roles
- handovers are written between phases
- if testing fails, ticket regresses to execution with tester feedback
- if review fails, ticket regresses to execution with reviewer feedback
- final workspace contains: deliverables, handovers, test results, review verdicts
- cockpit API shows current phase, round, agent, and ticket state

### Test Case 6 — Stale Ticket Detection (Target)

> Added 2026-03-21 — this test case describes the target behavior after Stage 2 is implemented.

Setup:
- ticket enters "In Progress" state
- execution does not complete within threshold

Expected result:
- queue-manager detects stale ticket
- ticket state updated to reflect stall
- continuation brief generated
- operator can see stale ticket in cockpit

## Observed Failure Modes

### Missing or Unreachable Postgres

Observed current behavior:
- swarm entry routes now return `503` before execution starts when readiness checks detect the failure
- the execution-completion path still depends on Postgres-backed work-item lookup polling
- there is still no true no-Postgres execution mode

Verified local smoke test on 2026-03-14:

- server started with `MOCK_OIDC=true`
- Postgres pointed at `127.0.0.1:6543`
- direct call made to `POST /api/swarm/tickets`
- observed response:

```json
{
  "error": "Swarm processing cannot start because Postgres is unavailable",
  "details": {
    "dependency": "postgres",
    "error": "connect ECONNREFUSED 127.0.0.1:6543"
  }
}
```

Interpretation:

- this is the correct current behavior for missing Postgres at the route boundary
- it is a cleaner failure mode than the previous late `500`
- it still confirms the runtime has no reduced-capability execution path when Postgres is absent

### Missing OIDC in Normal Mode

Observed current behavior:
- protected API calls return `401`
- protected page requests enter the auth flow and depend on reachable OIDC discovery

### Missing Redis

Observed current behavior:
- swarm transport falls back to in-memory
- boot succeeds
- this alone does not guarantee successful execution

## Cockpit and Bot-Scoped UI Flows

### Bot-Scoped Chat Session Boot

```text
Cockpit /cockpit
   │
   ├─ bot selector change
   ▼
CockpitEmbeddedChatPanelController
   │
   ├─ builds /swarmbot/chat?embed=cockpit&agentId=...
   └─ loads iframe and posts context updates
   ▼
/swarmbot/chat
   ├─ GET /api/agents/:agentId/profile
   ├─ POST /api/tasks
   ├─ GET /api/:taskId/messages
   └─ SSE /api/stream/:taskId
```

### Bot-Scoped Settings Flow

```text
Cockpit Settings action
   │
   ▼
/config/?agentId=<selected>&scope=agent#agentConfigSection
   │
   ├─ GET /api/agents/:agentId/profile
   ├─ GET /api/agents/:agentId/tools
   └─ PUT profile/tool updates
```

These cockpit flows are real UI flows, but they are separate from the swarm ticket-processing routes.

### Target: Operator Governance Surfaces

> Added 2026-03-21 — these describe cockpit capabilities needed after Stages 2-3.

The cockpit must expose:

- **Queue state dashboard:** list of tickets with current lifecycle state (Todo, Routing, In Progress, In Review, Escalated, Done)
- **Ticket detail view:** current phase, current round, assigned agent, regression count, handover history
- **Escalation list:** tickets that hit regression limits or are stuck
- **Phase progression timeline:** visual history of phase transitions for a ticket
- **Approval queue:** tickets requiring operator approval before proceeding

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

### Target API Additions

> These routes are needed after Stage 2 queue governance implementation.

| Method | Route | Request | Response |
|--------|-------|---------|----------|
| `GET` | `/api/swarm/queue` | `?state=in_progress&limit=50` | tickets with current lifecycle state |
| `GET` | `/api/swarm/tickets/:ticketId/phases` | — | phase progression history for a ticket |
| `POST` | `/api/swarm/tickets/:ticketId/reroute` | `{ targetAgentId, reason }` | reroute confirmation |
| `POST` | `/api/swarm/tickets/:ticketId/approve` | `{ decision, notes }` | approval decision result |

## Database Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `work_items` | Work unit state tracking | `work_item_id`, `swarm_run_id`, `status`, `execution_output`, `verification_result` |
| `swarm_runs` | Run lifecycle persistence | `run_id`, `provider`, `status`, `lifecycle_snapshot` |
| `swarm_escalations` | Failed ticket records | `run_id`, `ticket_id`, `target`, `severity`, `reason` |
| `agents` | Agent profile definitions | `agent_id`, `name`, `persona`, `base_capabilities`, `metadata` |
| `persona_layers` | Multi-layer prompt composition | `layer_type`, `priority`, `prompt_fragment` |

### Target Database Additions

> These columns/tables are needed after Stage 2-3 implementation.

| Table/Column | Purpose | Notes |
|---|---|---|
| `work_items.lifecycle_state` | Operator-visible ticket state (Todo, Routing, In Progress, etc.) | New column on existing table |
| `work_items.current_phase` | Current phase index | New column on existing table |
| `work_items.current_round` | Current round within phase | New column on existing table |
| `work_items.regression_count` | Number of regressions from testing/review | New column on existing table |
| `work_items.assigned_agent_id` | Currently assigned agent | New column on existing table |
| `phase_rounds` | Round-level state tracking | New table, managed by PhaseRoundOrchestrator |
| `ticket_handovers` | Handover artifact references | New table or workspace-only with _meta.json references |
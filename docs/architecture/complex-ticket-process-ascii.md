# Complex Ticket Process — ASCII Flow

## Purpose

This document gives a **single-screen ASCII map** of how a **complex/high-complexity ticket** moves through the current OSHAL swarm pipeline when it comes through the **approved-ticket / QueueManagerService path**.

It focuses on:

- phase progression
- queue-manager assignments
- prompt construction
- envelopes/messages sent
- files written into the shared workspace
- review / verification / handover points

> Scope note:
> This map describes the **queue-manager-driven path** because that is the path that writes the richer workspace story (`TASK-BRIEF.md`, routing decisions, handovers, deliverables, notes). Direct `POST /api/swarm/tickets` submission uses the same swarm execution core, but it bypasses some queue-manager workspace seeding.

---

## 1) High-Level End-to-End Flow

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ COMPLEX TICKET LIFECYCLE (QUEUE-MANAGER PATH)                               │
└──────────────────────────────────────────────────────────────────────────────┘

Approved internal ticket
    │
    ▼
QueueManagerService poll loop
    │
    ├─ listTickets(status='approved')
    ├─ claim ticket
    └─ update ticket status -> in_process_design
    │
    ▼
QueueManagerService workspace prep
    │
    ├─ TaskFolderService.createTaskFolder(ticketId)
    ├─ WorkspaceService.createWorkspace(...)
    ├─ TicketDecompositionService.decompose(...)
    ├─ create child tickets for decomposed work units
    ├─ SubtaskLifecycleService.registerParent(...)
    ├─ TaskFolderService.updateMeta(...childTicketIds...)
    ├─ TaskFolderService.appendRoutingDecision(...)
    └─ write TASK-BRIEF.md
    │
    ▼
SwarmTicketProcessingService.processTickets([workItem])
    │
    ├─ Phase 1: intake
    ├─ Phase 2: planning
    ├─ Phase 3: specialist_input         (high complexity only)
    ├─ Phase 4: execution
    ├─ Phase 5: testing / verification   (medium+ complexity)
    ├─ Phase 6: review / consensus       (high complexity only)
    └─ Phase 7: delivery
    │
    ▼
QueueManagerService post-pipeline enrichment
    │
    ├─ update _meta.json with selected agents/status
    ├─ append ROUTING-DECISIONS.md
    ├─ write <bot>-context.md
    ├─ write deliverables/<bot>/README.md
    └─ write developer-handovers/<bot>-handover.md
    │
    ▼
ticket status -> complete
```

---

## 2) Complexity Gate for a “Full” Complex Task

```text
resolvePhaseGateConfig(...)
    │
    ├─ score 1-3   -> low    -> intake, planning, execution, delivery
    ├─ score 4-6   -> medium -> intake, planning, execution, testing, review, delivery
    └─ score 7-10  -> high   -> ALL 7 PHASES ACTIVE

For a truly complex ticket, the target path is:

  intake
    -> planning
      -> specialist_input
        -> execution
          -> testing
            -> review
              -> delivery
```

---

## 3) Queue Manager Responsibilities

```text
QueueManagerService owns the PRE-SWARM prep work:

  1. poll approved tickets
  2. claim / mark in_process_design
  3. create shared workspace folder
  4. create/link workspace DB record
  5. decompose parent ticket into work units
  6. create child tickets from work units
  7. register subtask lifecycle state
  8. seed workspace docs/files
  9. call swarm processing core
 10. enrich workspace after pipeline completion
 11. mark ticket complete
```

### Queue-manager written artifacts before swarm dispatch

```text
{workspaceTaskId or ticketId}/
├── _meta.json
├── ROUTING-DECISIONS.md
├── TASK-BRIEF.md
├── deliverables/
├── developer-handovers/
└── notes/
```

### What those files mean

```text
_meta.json
  - taskId
  - parentId
  - childTicketIds
  - agents
  - status
  - createdAt / updatedAt

ROUTING-DECISIONS.md
  - chronological routing log
  - records queue-manager and swarm routing decisions

TASK-BRIEF.md
  - ticket description
  - decomposition summary
  - instructions for the next bot(s)
  - acceptance criteria seed text
```

---

## 4) Phase-by-Phase Complex Ticket Flow

```text
PHASE 1 — INTAKE
  Owner:
    SwarmTicketProcessingService
  Does:
    - normalize ticket
    - preview decomposition
    - calculate complexity score
    - activate all 7 phases when score is high
  Writes:
    - lifecycle state snapshot / writeback events


PHASE 2 — PLANNING
  Owner:
    SwarmTicketProcessingService + SwarmRoutingHandler
  Does:
    - decompositionService.decompose(ticket)
    - register parent/subtask lifecycle
    - select initial agent
    - persist work items
  Writes:
    - work_items rows
    - routing details


PHASE 3 — SPECIALIST_INPUT
  Owner:
    SwarmRoutingHandler
  Does:
    - choose specialist distinct from primary winner when available
    - inject specialist-enrichment context
  Writes:
    - lifecycle details for specialist agent and enrichment type


PHASE 4 — EXECUTION
  Owner:
    SwarmExecutionPolicyRunner + MeshCommunicationService + SwarmAgentWorker
  Does:
    - buildExecutionEnvelope(...)
    - send envelope to selected worker agent
    - optionally dispatch subtasks sequentially
    - wait for execution output via work_items polling
    - apply bounded retry/regression policy
  Writes:
    - work_items.execution_output
    - work_items.status -> completed / failed
    - policy / retry / escalation state


PHASE 5 — TESTING / VERIFICATION
  Owner:
    SwarmVerificationService
  Does:
    - structural verification first
    - optional task-manager verification request
    - verification prompt reviews existing execution output
  Writes:
    - verification work item(s)
    - verification findings / regression target


PHASE 6 — REVIEW / CONSENSUS
  Owner:
    ConsensusReviewService + PhaseRoundOrchestrator
  Does:
    - round 1 reviewer = task-manager (qa-gatekeeper)
    - round 2 reviewer = executor/domain-specialist-review
    - each reviewer judges the existing output
    - reviewer verdicts are converted to consensus
  Writes:
    - developer-handovers/{agentId}_PHASE_6_ROUND_{n}.md
    - review findings / verdict summary


PHASE 7 — DELIVERY
  Owner:
    SwarmTicketProcessingService + SwarmWritebackHandler
  Does:
    - finalize lifecycle
    - persist escalation if needed
    - emit completion writeback
    - store swarm learnings (when verification passed)
  Writes:
    - final lifecycle snapshot
    - completion metrics / escalation records
```

---

## 5) Envelope / Worker / Prompt Flow

```text
SwarmTicketProcessingService
    │
    └─ buildExecutionEnvelope(runId, toAgentId, externalId, workUnits, workspaceTaskId)
            │
            ▼
      MeshCommunicationService.send(...)
            │
            ▼
      Mesh transport (Redis or in-memory)
            │
            ▼
      SwarmAgentWorker.consume(...)
            │
            ▼
      createLLMExecutionHandler(...)
            │
            ├─ load agent profile
            ├─ load DB persona layers
            ├─ load filesystem persona YAML
            ├─ write persona context file to workspace
            ├─ inject handover summary layers
            ├─ inject swarm memory layer (if available)
            ├─ build task layer
            └─ build user message
            │
            ▼
      createAgent(...)
            │
            ▼
      agent.processMessage(userMessage, taskId)
            │
            ▼
      provider.sendRequest(...taskId/workspaceTaskId...)
```

---

## 6) Prompt Stack for a Complex Task

```text
PROMPT STACK (highest importance first)

1. Filesystem persona layer
   - generated from persona YAML
   - explicitly tells the bot to read <bot-name>-context.md first

2. DB persona layers
   - loaded from PersonaLayerStore

3. Handover summary layer
   - executive summary of previous rounds' handovers
   - optional context recall if the same agent touched the ticket before

4. Swarm memory layer
   - relevant prior experience / organizational memory

5. Task layer
   - ticket id
   - work unit count
   - acceptance criteria
   - workspace execution notes
   - minimal-workspace guidance when applicable

6. User message
   - mode-specific payload
```

### User message mode by stage

```text
EXECUTION MODE
  - Ticket: <externalId>
  - Work Units:
      * title
      * description
      * work type
      * acceptance criteria
  - Final instruction:
      complete all work units and return structured results

VERIFICATION MODE
  - Verification Ticket: verify:<ticketId>
  - Original Ticket: <ticketId>
  - Original description
  - Work units and acceptance criteria
  - Execution output to review
  - Final instruction:
      REVIEW EXISTING OUTPUT ONLY
      return Verdict: APPROVED / REJECTED / NEEDS REVISION

CONSENSUS REVIEW MODE
  - Consensus Review Ticket: review:<ticketId>:r<n>
  - Reviewer Role: qa-gatekeeper or domain-specialist-review
  - Review Focus: testing/docs/review/integration/analysis evidence
  - Original description
  - Work units and acceptance criteria
  - Execution output to review
  - Final instruction:
      REVIEW EXISTING OUTPUT ONLY
      return Verdict + Findings + Summary in deterministic format
```

---

## 7) Files Written Across the Complex-Ticket Lifecycle

```text
QUEUE-MANAGER SEED FILES
  _meta.json
  ROUTING-DECISIONS.md
  TASK-BRIEF.md

BOT CONTEXT FILES
  <bot-name>-context.md

DELIVERABLE FILES
  deliverables/<bot-name>/README.md

HANDOVER FILES
  developer-handovers/<bot-name>-handover.md
  developer-handovers/{agentId}_PHASE_6_ROUND_{n}.md   <-- review rounds

NOTES FILES
  notes/<bot-name>-notes.md   (directory scaffold exists for bot notes)
```

### Which files are explicitly used by prompt construction today?

```text
Explicitly injected/read by current prompt logic:
  YES  -> <bot-name>-context.md
  YES  -> previous handovers (summarized/injected)
  YES  -> execution output in verification/review prompts

Seeded into workspace for bot/human workflow, but not directly injected by the
current execution handler as prompt text:
  AVAILABLE -> TASK-BRIEF.md
  AVAILABLE -> ROUTING-DECISIONS.md
  AVAILABLE -> deliverables/
  AVAILABLE -> notes/
```

---

## 8) Review / Verification Round Ownership

```text
VERIFICATION (Phase 5)
  reviewer target:
    task-manager

CONSENSUS REVIEW (Phase 6)
  Round 1:
    task-manager
    role = qa-gatekeeper

  Round 2:
    execution winner / domain specialist
    role = domain-specialist-review

  Handover chain:
    reviewer 1 verdict -> handover file -> reviewer 2 context
```

---

## 9) “Full Complex Task” Story in One ASCII Chain

```text
approved ticket
  -> QueueManagerService poll
  -> claim + in_process_design
  -> workspace folder created
  -> _meta.json
  -> ROUTING-DECISIONS.md
  -> TASK-BRIEF.md
  -> decomposition into work units
  -> child tickets created
  -> parent/subtask lifecycle registered
  -> swarm process starts
  -> intake
  -> planning
  -> specialist_input
  -> execution envelope sent
  -> worker loads persona/profile/handover/task layers
  -> provider call executed in shared workspaceTaskId
  -> execution output persisted to work_items
  -> testing/verification prompt sent to task-manager
  -> review round 1 (task-manager)
  -> review handover written
  -> review round 2 (domain reviewer / executor)
  -> consensus built
  -> delivery
  -> queue-manager enriches workspace
  -> deliverable README written
  -> handover stub written
  -> ticket marked complete
```

---

## 10) Important Current-State Note

```text
This ASCII map shows the CURRENT queue-manager-driven complex-ticket flow.

It does NOT claim that every optional multi-round helper is active on every phase.
It DOES show the active queue-manager prep, the 7-phase swarm lifecycle, the
verification/review prompt modes, and the actual workspace files that are seeded
or written during current execution.
```
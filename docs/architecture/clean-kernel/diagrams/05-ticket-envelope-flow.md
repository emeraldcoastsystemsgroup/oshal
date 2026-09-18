# 05 — Ticket → envelope → accountable bot

The swarm loop. One envelope type, four transports chosen by the bot's posture. Spec:
[01 §4.7](../01-high-level-spec.md#47-swarm-integration), requirements B-01, B-06, B-07, C-06.

```mermaid
flowchart TB
  T["Ticket (type, workflow, principal)"] --> W{"Workflow loaded<br/>for this type?"}
  W -- no --> WAIT["wait for next poll<br/>never guess (B-07)"]
  W -- yes --> PH["Phase n of the workflow"]
  PH --> B{"Budget check<br/>(same ledger as cockpit)"}
  B -- over --> REF["Refusal recorded (C-07)"]
  B -- ok --> ENV["Envelope<br/>ticket · phase · bot · scopes · generation"]
  ENV --> TR{"Transport by posture"}
  TR -- inline --> IP["in-process stream"]
  TR -- node --> DS["durable stream<br/>consumer group"]
  TR -- remote --> RN["oshal-node claim<br/>device-bound token"]
  TR -- external --> A2["A2A gateway<br/>default-off"]
  IP --> BOT["Accountable bot"]
  DS --> BOT
  RN --> BOT
  A2 --> BOT
  BOT --> DOOR["admit as the bot principal (P4)"]
  DOOR --> ART["artifacts · CostEvents · status-history row"]
  ART --> NEXT{"more phases?"}
  NEXT -- yes --> PH
  NEXT -- no --> DONE["ticket closed<br/>trace assembled from rows (ADR-107)"]
```

## Phase dispatch as a sequence

```mermaid
sequenceDiagram
  autonumber
  participant Q as orchestration::dispatcher
  participant R as workflow registry
  participant C as control (budget · grants)
  participant M as mesh (transport)
  participant B as bot
  participant L as ledger (cost · history · audit)

  Q->>R: workflow for ticket type
  alt not loaded
    R-->>Q: none → leave ticket queued
  else loaded
    R-->>Q: phases
    Q->>C: admit dispatch (ticket principal, budget)
    C-->>Q: Ctx or Refusal
    Q->>M: publish Envelope(phase, bot, scopes, generation)
    M-->>B: deliver (transport by posture)
    B->>C: admit as bot principal
    B->>L: artifacts · CostEvent(Metered or Reported)
    B-->>Q: phase complete
    Q->>L: status-history row
  end
```

## Invariants

- The envelope carries capabilities for this phase only, never a credential value (B-11).
- Transport is chosen after admission; admission never depends on transport (ADR-161).
- Every phase transition is a row; a trace is never fabricated from nothing (ADR-107).
- A bot's output re-enters the door as the bot itself; it can propose a write but only a confirmed
  context performs one (ADR-122, ADR-105).

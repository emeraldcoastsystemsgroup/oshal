# 03 — Kernel object model

The complete set of kernel objects. Anything not here is a package's domain. Spec:
[01 §4.3](../01-high-level-spec.md#43-kernel-object-model); Rust sketches in
[02 — Rust object model](../02-rust-object-model.md).

```mermaid
classDiagram
  direction LR

  class Principal {
    +PrincipalId id
    +PrincipalKind kind
    +Subject subject
    +Issuer issuer
    +TenantId tenant
  }
  class PrincipalKind {
    <<enumeration>>
    Person
    Service
    Bot
    Root
  }
  class Tenant {
    +TenantId id
    +TenantKey key
  }
  class Grant {
    +PrincipalId principal
    +PackageId package
    +Tier tier
  }
  class Tier {
    <<enumeration>>
    Deny
    Viewer
    Editor
    Admin
  }
  class Ctx~M: Mode~ {
    +Principal principal
    +Tenant tenant
    +Grants grants
    +Budget budget
    +TraceSpan span
    +store() ScopedStore
    +inference() ScopedInference
    +intents() ScopedIntents
    +files() ScopedFiles
    +notify() ScopedNotify
  }
  class Package {
    +PackageId id
    +Manifest manifest
    +Version version
    +SdkRange sdk
    +PackageState state
  }
  class Capability {
    +CapabilityName name
    +Scope scope
  }
  class Bot {
    +BotId id
    +Principal identity
    +Posture posture
    +BrainRecords brain
    +Set~Capability~ capabilities
  }
  class Posture {
    <<enumeration>>
    Inline
    Node
    Remote
    External
  }
  class Provider {
    <<trait>>
    +complete(ScopedInference, Request) Response
  }
  class Intent {
    <<trait>>
    +schema() Schema
    +run(SecretRef, Input) Normalized
  }
  class Connector {
    +ConnectorId id
    +PrincipalId owner
    +SecretRef secret
    +Set~IntentName~ intents
  }
  class SecretRef {
    +opaque id
    no Serialize · no Display
  }
  class Tool {
    +ToolName name
    +Schema input
    +PackageId owner
  }
  class Ticket {
    +TicketId id
    +TicketType kind
    +WorkflowId workflow
    +Status status
    +StatusHistory history
  }
  class Envelope {
    +EnvelopeId id
    +TicketId ticket
    +Phase phase
    +BotId bot
    +Transport transport
    +Set~Capability~ scopes
    +Generation generation
  }
  class Transport {
    <<enumeration>>
    InProcess
    DurableStream
    RemoteNode
    A2a
  }
  class Workflow {
    +WorkflowId id
    +Stages or NodeGraph definition
    +PackageId source
  }
  class Activation {
    +ScheduleId schedule
    +PrincipalClass class
    +PrincipalId activated_by
  }
  class Node {
    +NodeId id
    +PrincipalId owner
    +NodeKind kind
    +Option~HarnessKind~ harness
    +Generation generation
  }
  class Surface {
    +SurfaceId id
    +PackageId owner
    +StaticRoot assets
  }
  class CostEvent {
    +CostKind kind
    +Usd amount
    +BotId bot
    +TicketId ticket
  }
  class CostKind {
    <<enumeration>>
    Metered
    Reported
  }
  class TraceSpan
  class AuditEvent

  Principal --> PrincipalKind
  Principal --> Tenant : belongs to
  Grant --> Principal
  Grant --> Package
  Grant --> Tier
  Ctx --> Principal : derived once
  Ctx --> Grant : resolved at the door
  Ctx ..> CostEvent : emits
  Ctx ..> TraceSpan : emits
  Ctx ..> AuditEvent : emits
  Package "1" *-- "*" Capability : declares
  Package "1" *-- "*" Bot : provides
  Package "1" *-- "*" Tool : provides
  Package "1" *-- "*" Intent : provides
  Package "1" *-- "*" Workflow : declares
  Package "1" *-- "*" Surface : ships
  Package "1" *-- "*" Activation : offers schedules for
  Bot --> Posture
  Bot --> Provider : brain resolves to
  Connector --> SecretRef : holds
  Connector --> Intent : authorizes
  Intent ..> SecretRef : resolves, never returns
  Ticket "1" *-- "*" Envelope
  Ticket --> Workflow
  Envelope --> Bot : addressed to
  Envelope --> Transport
  Envelope ..> CostEvent
  Node --> Bot : bound identities
  Node --> Principal : owner
  CostEvent --> CostKind
```

## Ownership and construction summary

| Object | Constructed only by | Tenant-scoped |
|---|---|---|
| Principal, Ctx | `control` | yes |
| Grant, Tenant, Activation | `control` on an admin or person action | yes |
| Package, Capability, Surface | `packages` loader | per install |
| Bot, Tool, Intent, Workflow | registries, from a manifest | per package |
| Connector, SecretRef | `control` on a person's authorization | yes (owner) |
| Ticket, Envelope | `orchestration` | yes |
| Workspace, Claim, Commit, Artifact | `orchestration`, store-backed | yes (owner + tenant) |
| Node | enrollment | yes (owner) |
| CostEvent, TraceSpan, AuditEvent | the door | yes |

# Platform Capability Flows

## Scope and evidence standard

This is an **as-built map**, not a roadmap. Every solid arrow below has a corresponding
runtime route, schema, or service implementation in the repository. A diagram does not
claim that every deployment enables the feature, that an external provider is configured,
or that device-only code has passed physical-device validation.

Use this guide to understand the main control and data flows; use the linked source paths
as the contract when details differ from older design documents.

## Ticket execution and dead-letter recovery

The ticket state model separates the generic `in_process` state used by chat tickets from
the phase-specific states used by swarm execution. The queue manager pulls `approved`
tickets. A poison ticket can be quarantined as `dead_letter`, which is terminal, requires
human review, and is grouped under `escalated` for existing board/report compatibility.

```mermaid
stateDiagram-v2
    [*] --> backlog
    backlog --> approved
    approved --> in_process_discovery
    approved --> in_process_design
    approved --> in_process_build
    approved --> in_process: chat ticket
    in_process_discovery --> in_process_build
    in_process_design --> in_process_build
    in_process_build --> in_process_deploy
    in_process_build --> in_process_test
    in_process_deploy --> in_process_test
    in_process_test --> in_process_release
    in_process_release --> complete
    in_process --> complete

    in_process_discovery --> approval_required
    in_process_design --> approval_required
    approval_required --> approved
    approval_required --> in_process_build

    in_process_discovery --> customer_action
    in_process_design --> customer_action
    in_process_build --> customer_action
    in_process_deploy --> customer_action
    in_process_test --> customer_action
    in_process_release --> customer_action

    approved --> escalated
    in_process_discovery --> escalated
    in_process_design --> escalated
    in_process_build --> escalated
    in_process_deploy --> escalated
    in_process_test --> escalated
    in_process_release --> escalated

    approved --> dead_letter
    in_process_discovery --> dead_letter
    in_process_design --> dead_letter
    in_process_build --> dead_letter
    in_process_deploy --> dead_letter
    in_process_test --> dead_letter
    in_process_release --> dead_letter
    approval_required --> dead_letter
    escalated --> dead_letter
    dead_letter --> approved: operator requeue
    dead_letter --> backlog: operator reset
    dead_letter --> cancelled: operator cancel

    approved --> paused
    paused --> approved: resume
    backlog --> cancelled
    approved --> cancelled
    complete --> [*]
    cancelled --> [*]
```

The service enforces a larger set of recovery transitions than the primary path shows
(for example, build can return to discovery and test can return to build). The canonical
transition table, rather than this readability-focused diagram, is authoritative.

```mermaid
sequenceDiagram
    actor Operator
    participant API as Ticket API
    participant Service as TicketService
    participant Store as PostgreSQL ticket store
    participant Task as Linked chat task
    participant History as Status history/events

    Operator->>API: PUT status / pause / resume / cancel
    API->>Service: normalize and validate transition
    Service->>Store: updateStatus(ticketId, state, metadata)
    Store->>Store: derive state_group and execution_phase
    alt complete
        Store->>Task: mark completed
    else escalated or dead_letter
        Store->>Task: mark failed
    else cancelled
        Store->>Task: mark cancelled
    end
    Store->>History: record actor, reason, source, next action
    Store-->>API: committed ticket state
    API-->>Operator: updated state
```

Evidence:

- `src/entities/ticket/types.ts` — canonical states, groups, execution phases, aliases,
  and `dead_letter` semantics.
- `src/features/ticketing/services/ticket-service.ts` — complete valid-transition table
  and required quarantine/escalation metadata.
- `src/features/ticketing/services/ticket-store-postgres.ts` — transactional persistence
  and linked-chat-task terminal-state projection.
- `src/app/routes/ticket-routes.ts` and `src/app/routes/queue-dlq-routes.ts` — operator
  lifecycle, status history, DLQ list/export/requeue, task/workspace links, and sync.

## Workflow Studio: design to executable process

Workflow Studio persists versioned definitions and compiles them into executable process
definitions. Compilation covers phase order, routing, planning, handovers, retries,
conditional edges, error branches, output bindings, and an optional executable DAG.

```mermaid
flowchart LR
    Template[Template or blank definition] --> Edit[Edit versioned definition]
    Edit --> Validate{Validate}
    Validate -->|issues| Edit
    Validate -->|valid| Compile[Compile]
    Compile --> Preview[Preview phases, routes, warnings]
    Preview --> Activate[Activate compiled definition]
    Activate --> Execute[Execution engine traverses graph]
    Execute --> History[Run and node history]
    Edit --> Duplicate[Duplicate definition]
    History --> Fork[Fork a historical version]
    Fork --> Edit
```

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> active: activate
    active --> inactive: deactivate
    inactive --> active: activate
    draft --> inactive: deactivate
```

```mermaid
stateDiagram-v2
    [*] --> running
    running --> completed
    running --> escalated
    running --> suspended
    running --> error
    suspended --> running: resume and increment resumed_count
    completed --> [*]
    escalated --> [*]
    error --> [*]
```

Evidence:

- `src/app/routes/workflow-studio-routes.ts` — catalog/templates, version CRUD,
  validation, compile, duplicate, and fork endpoints.
- `src/features/workflow-studio/schemas/process-definition-schema.ts` — executable
  definition contract and `draft` / `active` / `inactive` lifecycle.
- `src/features/workflow-studio/engine/process-definition-execution-engine.ts` —
  executable traversal.
- `src/features/workflow-studio/services/workflow-run-history-store.ts` — persisted
  run/node history, suspension, completion, and resume accounting.

Caveat: a successfully compiled definition is not proof that its selected agents,
providers, or connector credentials are healthy in a particular deployment.

## Remote node and desktop execution mesh

The control plane can register remote clients, monitor health, queue and claim work,
exchange swarm messages, conduct chat turns, and expose only the held task's workspace.
The desktop worker mirrors that workspace locally and pushes changed files additively.

```mermaid
sequenceDiagram
    participant Node as OSHAL desktop node
    participant CP as Control plane
    participant Registry as Remote-client registry
    participant WS as Scoped task workspace
    participant Tool as Codex / Claude / MCP / shell

    Node->>CP: register identity and capabilities
    CP->>Registry: create or refresh binding
    loop every heartbeat interval
        Node->>CP: online heartbeat and tool count
        CP->>Registry: update health and last seen
    end
    Node->>CP: claim next task
    CP->>Registry: queued to claimed
    CP-->>Node: task and held workspace identity
    Node->>CP: request workspace manifest/files
    CP->>WS: enforce device and held-task access
    WS-->>Node: scoped files
    Node->>Tool: execute in local mirror
    Node->>CP: PUT changed files additively
    alt successful
        Node->>CP: complete task
        CP->>Registry: claimed to completed
    else failed
        Node->>CP: fail task with error
        CP->>Registry: claimed to failed
    end
```

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> claimed: node poll
    claimed --> completed: result accepted
    claimed --> failed: error accepted
    completed --> [*]
    failed --> [*]
```

Evidence:

- `src/app/routes/remote-client-routes.ts` — registration, heartbeat, task, swarm,
  chat, owner, and workspace APIs.
- `src/features/remote-client/services/remote-client-registry.ts` — queue and result
  lifecycle.
- `packages/oshal-chat/src/main/mesh-client.ts` — heartbeat/poll loops and automatic
  re-registration after a missing binding.
- `packages/oshal-chat/src/main/worker.ts`, `local-tools.ts`, and `workspace-sync.ts`
  — execution gate, held-workspace pull, and additive push.

Caveat: the registry shown here is an in-process implementation. Availability across
control-plane restarts or multiple replicas depends on the deployment's surrounding
runtime design; do not infer durable queueing from this diagram alone.

## Connector marketplace, OAuth, actions, and webhooks

The repository contains 308 connector YAML specifications. A specification is catalog
coverage, not evidence that a user has enabled it or supplied valid credentials.

```mermaid
flowchart TB
    Specs[Connector YAML specifications] --> Catalog[Marketplace catalog]
    Catalog --> Org{Organization enabled?}
    Org -->|no| Disabled[Unavailable]
    Org -->|yes| User{Enabled for user?}
    User -->|no| Disabled
    User -->|yes| Connect[OAuth or token connection]
    Connect --> Vault[Owner-scoped credential persistence]
    Vault --> Runtime[Generated resource/action runtime]
    Runtime --> Provider[External provider API]
    Provider --> Webhook[Provider webhook]
    Webhook --> Ingress[Provider/event ingress]
    Ingress --> Handler[Connector event handler]
```

```mermaid
sequenceDiagram
    actor User
    participant Hub as Connector Hub
    participant Provider as OAuth provider
    participant Store as Connection store
    participant Runtime as Connector runtime

    User->>Hub: GET provider/start
    Hub-->>User: redirect with state
    User->>Provider: authorize
    Provider-->>Hub: callback with code and state
    Hub->>Provider: exchange code for token
    Hub->>Store: save owner-scoped connection
    User->>Runtime: invoke resource/action
    Runtime->>Store: resolve authorized connection
    Runtime->>Provider: authenticated API request
    Provider-->>Runtime: provider result
    Runtime-->>User: normalized result
```

Evidence:

- `swarm-apps/connectors/*.yaml` — 307 declarative specifications at this audit.
- `src/app/routes/connector-marketplace-routes.ts` — organization and per-user
  enablement, remove, audit refresh, and audit export.
- `src/app/routes/connectors-routes.ts` — OAuth callback/token connection lifecycle,
  multiple connections, labels, and disconnect.
- `src/app/connectors/runtime/spec-routes.ts`,
  `src/app/routes/connector-action-routes.ts`, and
  `src/app/connectors/webhooks/webhook-ingress.ts` — resource/action execution and
  provider webhook ingress.
- `src/app/routes/connector-plaid-link.ts` — Plaid Link token and exchange flow.

Caveat: connector count is repository-state evidence and can change as manifests are
added or removed. Provider availability also depends on credentials, scopes, network,
and provider API behavior.

## Standards-facing A2A gateway

The inbound gateway advertises A2A protocol version `0.3.0`, publishes an agent card at
the standard well-known path, and accepts JSON-RPC task operations at the gateway
boundary. Internal ticket states are mapped to the A2A task-state vocabulary.

```mermaid
sequenceDiagram
    participant Agent as External A2A agent
    participant Card as Well-known agent card
    participant Gateway as JSON-RPC gateway
    participant Tickets as OSHAL ticket service

    Agent->>Card: GET /.well-known/agent-card.json
    Card-->>Agent: skills, endpoint, protocol 0.3.0
    Agent->>Gateway: message/send
    Gateway->>Gateway: authenticate, scope, rate-limit, validate
    Gateway->>Tickets: create or continue mapped work
    Tickets-->>Gateway: internal ticket state
    Gateway-->>Agent: A2A task and mapped state
    Agent->>Gateway: tasks/get
    Gateway->>Tickets: read visible task
    Gateway-->>Agent: current task
    opt cancellation
        Agent->>Gateway: tasks/cancel
        Gateway->>Tickets: validate cancellable transition
        Gateway-->>Agent: canceled task or A2A error
    end
```

Evidence:

- `src/features/a2a-gateway/types.ts` — protocol pin, discovery path, JSON-RPC
  envelope, task states, and standard/A2A error codes.
- `src/features/a2a-gateway` — gateway controller/service and internal state mapping.

Caveat: this is the non-streaming JSON-RPC boundary implemented by the current gateway;
it does not imply support for every optional transport or feature in later A2A versions.

## Authenticated local speaker diarization

Speaker diarization runs as a separate FastAPI service using pinned local models. It
accepts only allowlisted raw-audio content types, bounds the request, performs inference
off the event loop, and wipes the encoded audio buffer afterward. A single inference
gate returns `429` before reading a concurrent request body.

```mermaid
flowchart TD
    Request[Raw audio request] --> Auth{Service key valid?}
    Auth -->|no| Unauthorized[401]
    Auth -->|yes| Type{Allowed content type and no content encoding?}
    Type -->|no| Unsupported[415]
    Type -->|yes| Busy{Inference already active?}
    Busy -->|yes| Reject[429 service_busy]
    Busy -->|no| Read[Bounded raw-audio read]
    Read --> Model[Lazy or warmed pinned local model]
    Model --> Thread[Inference in worker thread]
    Thread --> Result[Speaker profiles and turns]
    Result --> Wipe[Zero encoded byte buffer]
    Wipe --> Response[JSON response]
```

Evidence:

- `services/speaker-diarization/speaker_service/api.py` — authentication, validation,
  concurrency admission, inference, error mapping, safe logging, and wiping.
- `services/speaker-diarization/speaker_service/audio.py` and `engine.py` — bounded
  input and local processing.
- `services/speaker-diarization/tests` — API, contract, and engine coverage.

Caveat: health/readiness proves that configured models load; accuracy for a particular
room, microphone, language, or speaker set still requires representative audio testing.

## Security findings, alerts, RCA, and operator recovery

Security scans persist findings that can be reviewed, assessed, and promoted into
tickets. Separately, signed Alertmanager ingress can feed incident handling and RCA.
Generated remediation remains subject to the ticket lifecycle and human controls.

```mermaid
flowchart LR
    Scan[Run security scan] --> Finding[Persist finding]
    Finding --> Review[Inspect and update]
    Review --> Assess[Assess severity and disposition]
    Assess --> Ticket[Create ticket]
    Alert[Signed Alertmanager webhook] --> Incident[Incident intake]
    Incident --> RCA[Root-cause analysis]
    RCA --> Ticket
    Ticket --> Swarm[Swarm investigation or remediation drafting]
    Swarm --> Gate{Human approval required?}
    Gate -->|yes| Approval[Operator review]
    Approval --> Resume[Resume or cancel]
    Gate -->|no| Complete[Complete]
    Resume --> Complete
    Ticket --> DLQ[Dead-letter quarantine]
    DLQ --> Requeue[Operator DLQ requeue]
    Requeue --> Ticket
```

Evidence:

- `src/app/routes/security-routes.ts` — status, scan, findings, assess, and
  finding-to-ticket routes.
- `src/app/routes/alertmanager-routes.ts` — guarded/HMAC-validated webhook ingress.
- `src/app/routes/rca-routes.ts` — RCA analysis API.
- `src/app/routes/queue-dlq-routes.ts` — operator-only list/export/requeue.
- `src/app/routes/devops-routes.ts` — super-admin trace stream and Vault broker
  status/KV/policy/issue/revoke/setup operations.

Caveat: these APIs implement the control flow. They do not authorize unattended
production changes, and provider-specific scanning or remediation quality depends on
the configured tools and access.

## Scheduling and tool verification

Schedules have an explicit active/paused lifecycle and can also be triggered manually.
The verification scheduler is separately controllable and retains per-tool latest and
historical results.

```mermaid
stateDiagram-v2
    [*] --> active: create
    active --> paused: pause
    paused --> active: resume
    active --> active: scheduled execution
    active --> active: manual trigger
    paused --> paused: update
    active --> [*]: delete
    paused --> [*]: delete
```

```mermaid
sequenceDiagram
    actor Operator
    participant API as Schedule API
    participant Scheduler
    participant Task as Scheduled task
    participant Verify as Verification service
    participant Results as Verification history

    Operator->>API: create schedule
    API->>Scheduler: persist active schedule
    Scheduler->>Task: execute at due time
    opt manual run
        Operator->>API: trigger schedule
        API->>Task: execute now
    end
    Operator->>Verify: start, stop, or run verification scheduler
    Verify->>Verify: verify one or all tools
    Verify->>Results: store result
    Operator->>Results: read latest or history
```

Evidence:

- `src/features/scheduling/types/schedule.ts` — `active` / `paused` contract.
- `src/app/routes/schedule-routes.ts` — CRUD, pause, resume, trigger, and execution.
- `src/app/routes/verification-routes.ts` — verification scheduler controls and
  single/all/latest/history result APIs.

## Adjacent implemented flows and validation boundaries

These additional source-backed capabilities merit their own focused guides or diagrams:

- RAG upload/ingest, collections, retrieval, deletion, health, and embedding-model
  catalog: `src/app/routes/rag-routes.ts`.
- Knowledge graph node/edge writes, query, neighbors, and path traversal:
  `src/app/routes/graph-routes.ts`.
- Per-agent and shared memory remember/recall/bootstrap/context:
  `src/app/extensions/swarm/routes/memory-routes.ts`.
- Ambient transcript settings, segments, day review, and deletion, plus speaker
  assignment/merge/delete/audio processing:
  `src/app/routes/ambient-listening-routes.ts` and `ambient-speaker-routes.ts`.
- User-taught facts and suggestion resolution: `src/app/routes/user-model-routes.ts`.
- The Windows installer presents two explicit roles — run the swarm or join a swarm —
  then launches the corresponding child installer and streams its log:
  `installer/install.ps1`, `installer/lib/install-swarm.ps1`,
  `installer/lib/install-node.ps1`, and `installer/lib/connect-ai.ps1`.

The native iOS Spaces scanner is deliberately **not** labeled production-validated here.
Its source implements QR/PAT pairing, Keychain storage, ARKit LiDAR capture, PLY and pose
sidecar export, and multipart upload, but `clients/ios-spaces-scanner/README.md` states
that it is a buildable scaffold not compiled in this Windows repository. It still needs
Mac/Xcode signing and real-device validation. Fire TV, Roku, and Samsung TV source
packages likewise should not be described as shipped binaries without build/release
evidence.


<!--
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Layer 1 architecture documentation
-->

# Layer 1: Tools Framework Architecture

## Overview

Layer 1 is the **Tools Framework** — the system that enables AI agents to discover, authorize, execute, and verify external tools. It comprises four major subsystems: **Tool Registry**, **Switch Framework**, **Selector Composition**, and **Tool Verification**.

## High-Level Architecture

```mermaid
graph TB
    subgraph "UI Layer — Admin Pages"
        CAT[Catalog Page<br/>Browse & Register Tools]
        AGT[Agent Config Page<br/>Per-Agent Authorization]
        INS[Installation Page<br/>Verify Installations]
    end

    subgraph "API Layer"
        TAPI["/api/tools/*<br/>Tool Management"]
        VAPI["/api/tools/verify/*<br/>Verification"]
    end

    subgraph "Feature Layer — tool-management"
        TR[ToolRegistryService<br/>CRUD + Search]
        SW[SwitchFramework<br/>Auth Mode Enforcement]
        SC[SelectorComposition<br/>Capability Aggregation]
        VS[VerificationService<br/>Installation Checks]
        SCHED[VerificationScheduler<br/>Periodic Checks]
    end

    subgraph "Entity Layer — tools"
        REPO[ToolRepository<br/>Database Access]
        VR[VerificationRepository<br/>Results Storage]
        TYPES[Tool Types & Schemas]
    end

    subgraph "Shared Layer"
        DB[(PostgreSQL<br/>tools + verification tables)]
        SSE[SSE Manager<br/>Real-time Events]
        LOG[Pino Logger]
    end

    CAT --> TAPI
    AGT --> TAPI
    INS --> VAPI
    TAPI --> TR
    TAPI --> SW
    TAPI --> SC
    VAPI --> VS
    VAPI --> SCHED
    TR --> REPO --> DB
    VS --> VR --> DB
    SW --> SSE
    TR --> LOG
    VS --> LOG
```

## Subsystem 1: Tool Registry

The **Tool Registry** is the central catalog of all tools available in the system. It stores tool metadata, capabilities, categories, and installation status.

### Tool Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Registered: Seed or Manual Add
    Registered --> Configured: Set auth_mode
    Configured --> Active: auth_mode = auto
    Configured --> AskMode: auth_mode = ask
    Configured --> Disabled: auth_mode = off
    Active --> Verified: Verification passes
    Active --> VerificationFailed: Verification fails
    AskMode --> ApprovalPending: Tool invoked
    ApprovalPending --> Executed: User approves
    ApprovalPending --> Denied: User denies / timeout
    Verified --> Active: Re-verification
    VerificationFailed --> Active: Re-verification passes
    Disabled --> Configured: Re-enable
```

### Tool Data Model

```mermaid
classDiagram
    class Tool {
        +uuid id
        +string name
        +string display_name
        +string description
        +string category
        +string version
        +ToolCapability[] capabilities
        +AuthMode auth_mode
        +boolean is_enabled
        +timestamp last_verified_at
        +VerificationStatus last_verification_status
        +timestamp created_at
        +timestamp updated_at
    }

    class ToolCapability {
        +string name
        +string description
        +JsonSchema input_schema
        +JsonSchema output_schema
    }

    class AuthMode {
        <<enumeration>>
        AUTO
        ASK
        OFF
    }

    class VerificationStatus {
        <<enumeration>>
        PASSED
        FAILED
        ERROR
        SKIPPED
        PENDING
    }

    Tool --> ToolCapability
    Tool --> AuthMode
    Tool --> VerificationStatus
```

### Registry API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tools` | List all tools (filterable by category, status) |
| `GET` | `/api/tools/:id` | Get tool details |
| `POST` | `/api/tools` | Register a new tool |
| `PUT` | `/api/tools/:id` | Update tool metadata |
| `DELETE` | `/api/tools/:id` | Remove tool from registry |
| `PUT` | `/api/tools/:id/auth-mode` | Change tool auth mode |
| `GET` | `/api/tools/categories` | List tool categories |
| `GET` | `/api/tools/search` | Search tools by name/capability |

## Subsystem 2: Switch Framework

The **Switch Framework** controls how tools are authorized for execution during chat sessions. Each tool has an `auth_mode` that determines the authorization flow.

### Auth Modes

```mermaid
flowchart TD
    INVOKE[Agent Invokes Tool] --> CHECK{auth_mode?}
    
    CHECK -->|AUTO| AUTO[Execute Immediately<br/>No user interaction]
    CHECK -->|ASK| ASK[Send SSE Approval Request<br/>to User]
    CHECK -->|OFF| OFF[Block Execution<br/>Tool Disabled]
    
    ASK --> WAIT{User Response?}
    WAIT -->|Approve| EXEC[Execute Tool]
    WAIT -->|Deny| DENY[Skip Tool<br/>Inform Agent]
    WAIT -->|Timeout 30s| TIMEOUT[Skip Tool<br/>Timeout Response]
    
    AUTO --> RESULT[Return Result to Agent]
    EXEC --> RESULT
    DENY --> AGENT[Agent Continues<br/>Without Tool Result]
    TIMEOUT --> AGENT
```

### SSE Approval Flow (ASK Mode)

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant SW as SwitchFramework
    participant SSE as SSE Manager
    participant UI as Chat UI
    actor User

    Agent->>SW: requestToolExecution(toolId, params)
    SW->>SW: checkAuthMode(toolId)
    
    Note over SW: auth_mode = ASK
    
    SW->>SSE: sendApprovalRequest(userId, toolId, params)
    SSE->>UI: SSE event: tool_approval_request
    UI->>User: Display approval dialog<br/>"Allow [tool] to run?"
    
    alt User Approves
        User->>UI: Click "Approve"
        UI->>SW: POST /api/tools/approve/:requestId
        SW->>SW: executeTool(toolId, params)
        SW-->>Agent: ToolResult {output, status: "approved"}
    else User Denies
        User->>UI: Click "Deny"
        UI->>SW: POST /api/tools/deny/:requestId
        SW-->>Agent: ToolResult {status: "denied", reason: "user_denied"}
    else Timeout (30s)
        SW->>SW: Timeout expires
        SW-->>Agent: ToolResult {status: "timeout", reason: "approval_timeout"}
    end
```

## Subsystem 3: Selector Composition

The **Selector Composition** engine aggregates tool capabilities into a unified tool manifest that is provided to the LLM at chat time. It determines which tools are available to each agent based on auth mode and configuration.

### Composition Flow

```mermaid
flowchart LR
    subgraph "Input"
        AGENT[Agent Config<br/>agentId]
        TOOLS[(Tool Registry<br/>All Tools)]
    end

    subgraph "Filtering"
        F1[Filter: is_enabled = true]
        F2[Filter: auth_mode != OFF]
        F3[Filter: agent authorization]
    end

    subgraph "Composition"
        MAP[Map to OpenAI<br/>Tool Format]
        MERGE[Merge Capabilities<br/>into Tool Array]
    end

    subgraph "Output"
        MANIFEST[Tool Manifest<br/>for LLM API Call]
    end

    AGENT --> F3
    TOOLS --> F1 --> F2 --> F3
    F3 --> MAP --> MERGE --> MANIFEST
```

### Tool Manifest Format

The composed tool manifest follows the OpenAI function-calling schema:

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "description": "Search the web for information",
        "parameters": {
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "Search query" }
          },
          "required": ["query"]
        }
      }
    }
  ]
}
```

## Subsystem 4: Tool Verification

The **Verification System** (Sprint 4) validates that tools are properly installed and functional. It supports single-tool verification, batch verification, scheduled checks, and historical tracking.

### Verification Architecture

```mermaid
graph TB
    subgraph "Triggers"
        BTN[UI: Verify Button]
        BATCH[UI: Verify All]
        CRON[Scheduler<br/>Configurable Interval]
        API_T[API: POST /verify/:id]
    end

    subgraph "Verification Service"
        VS[VerificationService]
        CHECK[runVerification<br/>Per-Tool Check]
        HEALTH[healthCheck<br/>Endpoint Test]
    end

    subgraph "Storage"
        VR[VerificationRepository]
        DB[(tool_verification_results)]
        TOOLS_T[(tools table<br/>denormalized status)]
    end

    BTN --> API_T --> VS
    BATCH --> VS
    CRON --> VS
    VS --> CHECK --> HEALTH
    CHECK --> VR
    VR --> DB
    VR --> TOOLS_T
```

### Single Tool Verification Flow

```mermaid
sequenceDiagram
    actor User
    participant UI as Installation Page
    participant API as /api/tools/verify
    participant VS as VerificationService
    participant TOOL as Tool Endpoint
    participant DB as PostgreSQL

    User->>UI: Click "Verify" on tool card
    UI->>API: POST /api/tools/verify/:toolId
    API->>VS: verifyTool(toolId, userId)
    
    VS->>VS: loadToolConfig(toolId)
    VS->>TOOL: Health check request
    
    alt Tool Responds OK
        TOOL-->>VS: 200 OK
        VS->>DB: INSERT tool_verification_results<br/>(status: PASSED, response_time_ms)
        VS->>DB: UPDATE tools SET<br/>last_verified_at, last_verification_status = PASSED
        VS-->>API: {status: PASSED, responseTime: 45ms}
    else Tool Fails
        TOOL-->>VS: Error / Timeout
        VS->>DB: INSERT tool_verification_results<br/>(status: FAILED, error_message)
        VS->>DB: UPDATE tools SET<br/>last_verification_status = FAILED
        VS-->>API: {status: FAILED, error: "Connection refused"}
    end
    
    API-->>UI: Verification result
    UI->>UI: Update status badge<br/>Show response time
    UI-->>User: Green ✓ or Red ✗
```

### Batch Verification Flow

```mermaid
sequenceDiagram
    actor User
    participant UI as Installation Page
    participant API as /api/tools/verify
    participant VS as VerificationService
    participant DB as PostgreSQL

    User->>UI: Click "Verify All"
    UI->>API: POST /api/tools/verify/all
    API->>VS: verifyAllTools(userId)
    
    loop For each enabled tool
        VS->>VS: verifyTool(toolId)
        VS->>DB: Store result
    end
    
    VS-->>API: {results: [{toolId, status}...], summary}
    API-->>UI: Batch results
    UI->>UI: Update all status badges
    UI-->>User: Summary: 8/10 passed, 2 failed
```

### Scheduler Operation

```mermaid
sequenceDiagram
    participant SCHED as VerificationScheduler
    participant VS as VerificationService
    participant DB as PostgreSQL
    participant LOG as Pino Logger

    Note over SCHED: Interval: VERIFICATION_INTERVAL_MS<br/>(default: 3600000ms = 1 hour)

    loop Every interval
        SCHED->>LOG: info("Scheduled verification starting")
        SCHED->>VS: verifyAllTools("scheduler")
        VS->>DB: Run all verifications
        DB-->>VS: Results
        VS-->>SCHED: Summary
        SCHED->>LOG: info({passed, failed, total}, "Scheduled verification complete")
    end
```

### Verification API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/tools/verify/:id` | Verify single tool |
| `POST` | `/api/tools/verify/all` | Verify all enabled tools |
| `GET` | `/api/tools/verify/:id/history` | Get verification history for tool |
| `GET` | `/api/tools/verify/:id/latest` | Get latest verification result |
| `GET` | `/api/tools/verify/summary` | Get verification summary stats |
| `POST` | `/api/tools/verify/scheduler/start` | Start verification scheduler |
| `POST` | `/api/tools/verify/scheduler/stop` | Stop verification scheduler |
| `POST` | `/api/tools/verify/scheduler/run-now` | Run scheduler immediately |
| `GET` | `/api/tools/verify/scheduler/status` | Get scheduler status |
| `GET` | `/api/tools/verify/config` | Get verification configuration |

## Database Schema

```mermaid
erDiagram
    TOOLS {
        uuid id PK
        varchar name UK
        varchar display_name
        text description
        varchar category
        varchar version
        jsonb capabilities
        varchar auth_mode "auto|ask|off"
        boolean is_enabled
        timestamp last_verified_at "Denormalized"
        varchar last_verification_status "Denormalized"
        timestamp created_at
        timestamp updated_at
    }

    TOOL_AGENT_CONFIG {
        uuid id PK
        uuid tool_id FK
        varchar agent_id
        varchar auth_mode_override
        boolean is_authorized
        timestamp created_at
        timestamp updated_at
    }

    TOOL_APPROVAL_REQUESTS {
        uuid id PK
        uuid tool_id FK
        varchar user_id
        varchar agent_id
        varchar session_id
        jsonb tool_params
        varchar status "pending|approved|denied|timeout"
        timestamp requested_at
        timestamp resolved_at
        varchar resolved_by
    }

    TOOL_VERIFICATION_RESULTS {
        uuid id PK
        uuid tool_id FK
        varchar status "PASSED|FAILED|ERROR|SKIPPED|PENDING"
        integer response_time_ms
        text error_message
        jsonb metadata
        varchar triggered_by "user|scheduler|api"
        varchar triggered_by_user_id
        timestamp created_at
    }

    TOOLS ||--o{ TOOL_AGENT_CONFIG : "configured for"
    TOOLS ||--o{ TOOL_APPROVAL_REQUESTS : "approval requests"
    TOOLS ||--o{ TOOL_VERIFICATION_RESULTS : "verification history"
```

## UI Pages

### Catalog Page (`catalog.html`)

```mermaid
flowchart LR
    subgraph Catalog
        BROWSE[Browse Tools<br/>by Category] --> DETAIL[Tool Detail<br/>View]
        DETAIL --> REG[Register Tool<br/>in System]
        BROWSE --> SEARCH[Search by<br/>Name/Capability]
    end
```

**Features:** Tool cards with category badges, capability list, registration button, search/filter

### Agent Config Page (`agent-tools.html`)

```mermaid
flowchart LR
    subgraph AgentConfig
        SELECT[Select Agent] --> VIEW[View Authorized<br/>Tools]
        VIEW --> TOGGLE[Toggle Auth Mode<br/>per Tool]
        TOGGLE --> SAVE[Save Agent<br/>Configuration]
    end
```

**Features:** Agent selector dropdown, tool authorization toggles (auto/ask/off), bulk actions

### Installation Page (`installation.html`)

```mermaid
flowchart LR
    subgraph Installation
        DASH[Dashboard<br/>Overview] --> VERIFY[Verify Single<br/>Tool]
        DASH --> BATCH[Verify All<br/>Tools]
        DASH --> HIST[View History<br/>Modal]
        DASH --> SCHED[Scheduler<br/>Controls]
    end
```

**Features:** Status badges (PASSED/FAILED/PENDING), verify buttons, history modal with timeline, scheduler start/stop/run-now

## File Map

```
src/
├── entities/
│   └── tools/
│       ├── index.ts                    # Barrel export
│       ├── tool-repository.ts          # CRUD operations
│       ├── verification-repository.ts  # Verification results
│       └── types.ts                    # Tool, ToolCapability types
├── features/
│   └── tool-management/
│       ├── index.ts                    # Barrel export
│       ├── services/
│       │   ├── tool-registry-service.ts     # Registry orchestration
│       │   ├── switch-framework.ts          # Auth mode enforcement
│       │   ├── selector-composition.ts      # Tool manifest building
│       │   ├── verification-service.ts      # Verification logic
│       │   └── verification-scheduler.ts    # Periodic scheduler
│       └── types.ts                    # Service-level types
├── app/
│   └── routes/
│       ├── tool-routes.ts              # Tool CRUD routes
│       └── tool-verification-routes.ts # Verification routes
├── pages/
│   └── tools-admin/
│       ├── catalog.html                # Tool catalog page
│       ├── agent-tools.html            # Agent config page
│       ├── installation.html           # Installation dashboard
│       └── js/
│           ├── catalog.js              # Catalog page logic
│           ├── agent-tools.js          # Agent config logic
│           └── installation.js         # Installation + verification logic
└── shared/
    ├── db/
    │   └── postgres.ts                 # Database pool
    └── utils/
        └── sse-manager.ts              # Server-Sent Events
```

## Integration with Layer 0

```mermaid
flowchart TB
    subgraph "Layer 1 — Tools Framework"
        SC[Selector Composition]
        SW[Switch Framework]
    end

    subgraph "Layer 0 — Provider Framework"
        PR[Provider Registry]
        CFG[Config Service]
    end

    subgraph "Chat Flow"
        CHAT[Chat Service]
    end

    CHAT --> SC
    SC -->|Tool manifest| CHAT
    CHAT --> CFG
    CFG -->|Provider credentials| CHAT
    CHAT --> PR
    PR -->|Provider definition| CHAT
    CHAT --> SW
    SW -->|Auth decision| CHAT
```

Layer 1 provides the **tool capabilities** that are sent alongside the user's message to the LLM provider (resolved by Layer 0). When the LLM responds with a tool call, the Switch Framework (Layer 1) enforces authorization before execution.
# Swarm Pipeline Architecture Diagrams

Updated: 2026-03-30 (Session 18)

## 1. Phase Lifecycle Flow

```mermaid
flowchart TD
    START([Ticket Submitted]) --> P1[Phase 1: INTAKE]
    P1 -->|classify complexity| GATE{Complexity?}

    GATE -->|high score >= 7| P8[Phase 8: ARCHITECTURE PRE-ROUND]
    GATE -->|medium/low| P2
    P8 -->|TECHNICAL-SPECIFICATION.md| P2[Phase 2: PLANNING]

    P2 -->|PM produces plan| DECOMP{Multi-subtask?}
    DECOMP -->|yes| CHILD[Create Child Tickets]
    CHILD -->|each child| P1
    DECOMP -->|no / single unit| P3{High complexity?}

    P3 -->|yes| SP[Phase 3: SPECIALIST INPUT]
    P3 -->|no| P4
    SP --> P4[Phase 4: EXECUTION]

    P4 --> P5{Testing active?}
    P5 -->|medium+| T[Phase 5: TESTING]
    P5 -->|low| P7

    T --> TRESULT{Test result?}
    TRESULT -->|pass| P6{Review active?}
    TRESULT -->|regress| P4
    TRESULT -->|escalated| ESC([Escalated])

    P6 -->|high| R[Phase 6: REVIEW]
    P6 -->|skip| P7
    R --> RRESULT{Review result?}
    RRESULT -->|pass| P7[Phase 7: DELIVERY]
    RRESULT -->|regress| P4
    RRESULT -->|escalated| ESC

    P7 --> DONE([Complete])

    style P8 fill:#f9f,stroke:#333
    style ESC fill:#f66,stroke:#333
    style DONE fill:#6f6,stroke:#333
```

## 2. Agent Routing Decision Tree

```mermaid
flowchart LR
    REQ[Phase Dispatch Request] --> CAP{ROLE_CAPABILITY_MAP}
    CAP --> MESH[Mesh Bid Broadcast]
    MESH -->|bids received| LLM[LLM Competency Score]
    MESH -->|no bids| LLM
    LLM --> RANK[CompetencyRanker Phase Weighting]
    RANK --> WINNER[Select Top Agent]

    WINNER --> PM_CHECK{Is PM for Phase 4+?}
    PM_CHECK -->|yes, reject| FALLBACK[Capability Matcher Fallback]
    PM_CHECK -->|no| DISPATCH[Dispatch to Agent]
    FALLBACK --> DISPATCH
```

## 3. Cost Rollup Architecture

```mermaid
flowchart TD
    BOT[Bot Executes LLM Call] --> COST[TokenCapturingProvider]
    COST --> CT[chat_tasks table]
    CT -->|per-bot task ID: baseId::agentId| LINK[ticket_task_links]
    LINK -->|role: swarm-execution| VIEW1[ticket_cost_rollup view]

    PARENT[Parent Ticket] --> CHILDREN[Child Tickets]
    CHILDREN --> LINK
    PARENT --> LINK
    VIEW1 --> DIRECT[Direct Costs Per Ticket]

    PARENT --> RECURSIVE[ticket_cost_rollup_with_children view]
    RECURSIVE -->|WITH RECURSIVE ticket_tree| AGGREGATE[Aggregate: parent + all descendants]

    style RECURSIVE fill:#ff9,stroke:#333
```

## 4. Credential Propagation Flow

```mermaid
sequenceDiagram
    participant User
    participant API as API Server
    participant Redis
    participant PM as PM Bot
    participant Worker as Worker Bots
    participant Seed as config-seed/secrets.json

    User->>API: OAuth Callback (code, state)
    API->>API: Exchange code for tokens
    API->>API: EncryptedConfigManager.saveSecrets()
    API->>Seed: writeSharedSeedCredentials()
    API->>Redis: PUBLISH swarm.codex-credentials.update

    Redis-->>PM: message (credentials JSON)
    PM->>PM: Write to local seed path
    PM->>PM: syncOpenAiCodexCredentials()

    Redis-->>Worker: message (credentials JSON)
    Worker->>Worker: Write to local seed path
    Worker->>Worker: syncOpenAiCodexCredentials()
```

## 5. Docker Container Topology (Swarm)

```mermaid
graph TB
    subgraph Infrastructure
        PG[(PostgreSQL)]
        REDIS[(Redis)]
        CHROMA[(ChromaDB)]
    end

    subgraph API Layer
        API[API Server :3456]
    end

    subgraph Bot Containers
        PM[project-manager]
        TM[task-manager]
        CD[code-developer]
        TB[tester-bot]
        QA[qa-gatekeeper]
        ARCH[architect-bot]
        RCA[rca-specialist]
        DOT3[... 10+ more bots]
    end

    subgraph Shared Volumes
        SEED[config-seed :ro]
        CLAUDE[claude-auth]
    end

    API --> PG
    API --> REDIS
    PM --> PG
    PM --> REDIS
    PM --> CHROMA
    CD --> REDIS
    TB --> REDIS
    QA --> REDIS
    ARCH --> REDIS

    SEED -.->|bind mount| PM
    SEED -.->|bind mount :ro| CD
    SEED -.->|bind mount :ro| TB
    CLAUDE -.->|shared volume| PM
    CLAUDE -.->|shared volume| CD
```

## 6. Metrics Collection Flow

```mermaid
flowchart TD
    PROC[processOneTicket] --> EXIT1{Planning only?}
    EXIT1 -->|yes| REC1[recordTicketMetrics: completed]
    EXIT1 -->|no| EXEC[Execute Phase 4-6]

    EXEC --> TEST{Testing escalated?}
    TEST -->|yes| REC2[recordTicketMetrics: escalated]
    TEST -->|no| REV{Review escalated?}
    REV -->|yes| REC3[recordTicketMetrics: escalated]
    REV -->|no| DEL[Phase 7: Delivery]
    DEL --> REC4[recordTicketMetrics: completed]

    REC1 --> COLL[SwarmMetricsCollector]
    REC2 --> COLL
    REC3 --> COLL
    REC4 --> COLL

    COLL --> AGG[getAggregatedMetrics]
    COLL --> PERF[getAgentPerformance]
    AGG --> COCKPIT[Cockpit Dashboard API]
    PERF --> COCKPIT
```

# Core Runtime Overview

This document describes the core OSHAL runtime that we actually want new reviewers to understand first.

It leaves out the secondary screens and historical migration clutter on purpose.

## System Context

```mermaid
flowchart TD
    Operator[Operator or Product Team]
    Browser[Browser UI]
    API[OSHAL API Server]
    DB[(Postgres)]
    Redis[(Redis)]
    Chroma[(ChromaDB)]
    Workspace[(Shared Workspace)]
    Factory[Agent Factory]
    Swarm[Swarm Orchestrator]
    Tools[Tool Registry and Switch Framework]

    Operator --> Browser
    Browser --> API
    API --> DB
    API --> Redis
    API --> Chroma
    API --> Workspace
    API --> Tools
    API --> Factory
    API --> Swarm
    Factory --> DB
    Swarm --> DB
    Swarm --> Redis
    Swarm --> Workspace
```

## Runtime Layers

```mermaid
flowchart LR
    UI[UI Surfaces] --> Routes[Express Routes]
    Routes --> Composition[Composition Root]
    Composition --> Provider[Provider Resolver]
    Composition --> Registry[Tool Registry]
    Composition --> Profiles[Agent Profiles]
    Composition --> Orchestrator[Task and Swarm Orchestrators]
    Orchestrator --> Storage[Postgres, Redis, Chroma, Workspace]
```

## Core Request Flow

```mermaid
sequenceDiagram
    participant U as User
    participant S as OSHAL Server
    participant P as Postgres
    participant R as Redis
    participant W as Workspace

    U->>S: Open UI or send API request
    S->>S: Resolve auth mode and provider context
    S->>P: Load agent, tool, and runtime state
    S->>R: Publish or consume swarm transport work
    S->>W: Read or write shared artifacts
    S->>P: Persist run status and outputs
    S-->>U: Return response and updated state
```

## Deployment Modes

### Docker-first core mode

This is the primary path for evaluation and onboarding.

- `docker-compose.core.yml`
- mock auth enabled by default
- self-contained Postgres, Redis, and Chroma
- no external Docker network requirement

### Localhost dev mode

This runs the server on the host while reusing the same backing services from Docker.

- `bash scripts/start-localhost.sh`
- useful for TypeScript iteration
- same core runtime dependencies as Docker mode

### Kubernetes mode

This is the packaging path, not the first-time onboarding path.

- `bash scripts/install-k8s.sh`
- wraps `scripts/setup-oshal-k8s.sh`
- renders bundle output under `output/k8/oshal/`

## Current Product Truth

The core control plane is real and runnable.

The biggest missing product loop is still autonomous self-registration and self-learning for new bots. Bot creation and provisioning are in place, but the final closed-loop growth path is still pending.

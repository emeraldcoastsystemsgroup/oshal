# ADR-018: Swarm Processing Runtime Contract

## Status
Accepted

## Context

The swarm-processing implementation has accumulated multiple overlapping descriptions:

- historical implementation notes
- feature README summaries
- architecture process-flow documents
- runtime handover entries

The result was design drift. Some material described mounted routes as if that alone proved end-to-end functionality. Other material still described an older 5-cycle model after the implementation moved to a 7-phase lifecycle with readiness gating.

We need one explicit runtime contract for swarm processing so contributors can tell:

- what the swarm process is
- how it is called
- which dependencies are actually required
- which failure mode is correct when dependencies are missing

## Decision

### 1. Treat swarm processing as a synchronous orchestration API

The canonical public entrypoints are:

- `POST /api/swarm/tickets`
- `POST /api/swarm/providers/:provider/process`

These routes are synchronous orchestration calls. They do not merely enqueue work and return immediately.

### 2. Use the 7-phase lifecycle as the active internal design

The active lifecycle is:

1. `intake`
2. `planning`
3. `specialist_input`
4. `execution`
5. `testing`
6. `review`
7. `delivery`

Complexity gating may skip some phases, but the 7-phase model is the canonical internal contract.

### 3. Enforce readiness at the route boundary

If critical runtime dependencies are unavailable, swarm processing must fail before execution starts.

Current correct failure mode:

- return `503 Service Unavailable`
- include dependency-specific details when available

### 4. Separate auth access from execution readiness

- auth success means the caller may reach the route
- it does not mean the runtime can successfully execute a swarm process

`MOCK_OIDC=true` is a local auth bypass only. It is not a reduced-capability execution mode.

### 5. Record current dependency truth explicitly

For real successful swarm execution today:

- Postgres is effectively required
- provider resolution is required
- seeded agent/persona data is required
- Redis is optional for durability only

### 6. Keep active swarm docs synchronized as one contract set

When the swarm runtime contract changes, contributors must update together:

- `docs/architecture/swarm-processing-design-contract.md`
- `docs/architecture/swarm-orchestration-process-flow.md`
- `src/features/swarm-orchestration/README.md`
- relevant ADR index entries

## Consequences

### Positive

- clearer distinction between design intent and observed runtime truth
- fewer ambiguous claims about readiness
- one current source of truth for technical, functional, and architectural expectations
- lower chance of future drift between routes, docs, and operational understanding

### Negative

- more discipline is required when swarm behavior changes
- historical handover notes become less reliable unless clearly marked as history
- contributors must maintain multiple coordinated documentation surfaces when changing the contract

## Per-Bot Container Extension (ADR-019)

> **Added 2026-03-16** — Sessions 55-58 introduced per-bot Docker containers (see [ADR-019](019-per-bot-container-architecture.md)).

In per-bot container mode, the runtime contract above still applies **within each container**, but with these key differences:

1. **Each bot runs its own Express server** — the synchronous orchestration routes (`POST /api/swarm/tickets`, etc.) exist in every container, but only the project-manager container (PM) is the canonical orchestration entrypoint.
2. **Inter-bot communication uses Redis Streams** — delegation from PM to specialist bots (task-manager, code-developer, code-reviewer, documentation-writer) happens asynchronously via Redis Streams channels (`agent.{botName}`), not in-process function calls.
3. **Infrastructure gating is per-container** — PM sets `ENABLE_AGENT_SCHEDULER=true`, `ENABLE_QUEUE_MANAGER=true`, `RUN_MIGRATIONS=true`; worker bots set all three to `false`.
4. **Readiness is per-container** — each bot validates its own dependencies (Postgres, Redis, ChromaDB, provider config) independently at startup via the bot-entrypoint.sh script.
5. **The 7-phase lifecycle remains canonical** — the phases execute within the PM's orchestration, with specialist work delegated to other containers.

This does not supersede ADR-018; it extends the contract to a distributed deployment topology.

## Operational Rule

No swarm feature should be called production-ready unless:

- auth behavior is verified
- readiness behavior is verified
- one real end-to-end execution path is validated against current infrastructure assumptions
- the design contract and process-flow docs reflect that verified state

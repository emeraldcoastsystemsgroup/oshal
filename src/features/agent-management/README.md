# Agent Management Feature

## Purpose

Owns runtime agent identity, routing, mesh delivery, persona composition, and knowledge-memory services that sit between the app shell and the swarm orchestration feature.

## Public API

- `AgentRouter`
- `SelectionBidService`
- `MeshCommunicationService`
- `RedisMeshTransport`
- `AgentRuntimeRegistryService`
- `PersonaLayerComposer`
- `PersonaLayerStore`
- `AgentFactoryService`
- `CapabilityExpansionService`
- `AgentConfigService`
- `AgentMemoryService`
- `SwarmMemoryService`

## Runtime Notes

- Redis mesh transport remains the embedded transport for swarm delivery.
- Live worker availability now uses Redis heartbeat keys under `oshal:runtime-agent:<agentId>`.
- Orchestration can filter candidates down to online workers before routing.
- Compatibility alias channels remain important while bot-name identities are still present in Docker/runtime wiring.

## Primary Files

- `services/mesh-communication-service.ts` — channel contract and helper APIs
- `services/redis-mesh-transport.ts` — Redis Streams transport implementation
- `services/agent-runtime-registry-service.ts` — live runtime heartbeat registry
- `services/agent-router.ts` — final routing decision logic
- `services/persona-layer-store.ts` — persisted persona layer retrieval
- `services/agent-memory-service.ts` — per-agent vector-memory management
- `services/swarm-memory-service.ts` — shared swarm memory extraction and retrieval

## Current Limitations

- Runtime heartbeats and the legacy `bot:<name>:status` key path both exist today; only the heartbeat registry is authoritative.
- Static compose bot definitions can still drift from the canonical seeded agent roster.
- Routing correctness still depends on seeded agent profiles being aligned with running containers.

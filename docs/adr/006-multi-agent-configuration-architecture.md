# ADR-006: Multi-Agent Configuration Architecture

## Status
**Accepted** — 2026-03-08. **Superseded in part by [ADR-034](034-bidirectional-config-ownership-sync.md)** (2026-06-08).

The *model* below (controller owns the golden config, central-wins conflict resolution, config versioning, audit trail, offline seed→pull→cache) was kept and is live. The *mechanism* was never built as sketched here — `src/features/config-sync/` sat as an empty placeholder for ~3 months — and ADR-034 is what actually shipped. When these disagree, ADR-034 wins. Specifically superseded:

- Broadcast-up is the Redis Streams mesh channel `swarm.config-change`, **not** the REST `POST /api/sync/override/:agentId` sketched below.
- Push-down is the bot's own `PUT /api/llm-provider` (`BotNodeClient.switchProvider`) **plus** config stamped on every dispatch, **not** a bespoke `POST /api/v1/config/update`.
- The authoritative record lives on the Postgres `agent_config` record (`AgentConfigService`); `config_version` rides on it — no dedicated config store.
- The controller never writes a bot's internal files (`~/.cline`); that behind-the-bot rewrite was retired.

The migration-001 data model (`agents`, `tools`, `agent_tools`, `config_sync_log`, `config_snapshots`) survives, and `config_sync_log` is actively written by the ADR-034 sync service.

## Context

oshal is a 23+ agent AI swarm platform where each bot runs the same Node.js codebase (`any-bot/server/app.js`) with different persona YAML files and environment variables. The configuration management that supports this swarm has several critical pain points that caused a 3-day production escalation:

1. **Config sprawl**: 50+ `.env` files scattered across directories with conflicting defaults between `config.js` (singleton with hardcoded values) and `SettingsStore` (SQLite key-value per-user).
2. **Credential chaos**: API keys stored in plaintext `configs/.env`, different bots needing different credentials, no encryption at rest.
3. **MCP tool misconfiguration**: Hardcoded MCP server definitions in `config.js`, manual `mcp_settings.json` editing — the 3-day escalation was caused by incorrect tool counts due to stale MCP config.
4. **No central management**: No dashboard to view/edit agent configs, no way to push config changes without redeploying containers.
5. **Persona management**: YAML files in `ai-lab/bot-personas/` with no validation, no versioning, and manual editing only.

oshal is being built as the **control plane** for oshal's **data plane** — providing centralized, persistent, encrypted configuration management with UI screens for all operations.

## Decision

### Architecture: Three-Tier Config Hierarchy

```
Controller (oshal) → Agent (oshal bot) → API Provider (LLM config)
```

1. **Controller (oshal control plane)** holds the "golden" configuration for every agent. Configs are stored in PostgreSQL with JSONB columns for flexible metadata. Secrets are encrypted with AES-256-GCM per user/agent.

2. **Agents (oshal bots)** pull their initial config from the controller at startup via `GET /api/agents/:id/bootstrap`. They cache the config locally for offline resilience. Local overrides are allowed but tracked.

3. **API Providers** are a sub-config within each agent — which LLM provider, model, and credentials to use. Providers can be set centrally (all agents use anthropic) or overridden per-agent.

### Communication Protocol: REST API

- **Agent bootstrap**: `GET /api/agents/:id/bootstrap` — agent pulls full config on startup
- **Config push**: `POST http://agent:port/api/v1/config/update` — controller pushes changes to agent
- **Heartbeat**: `POST /api/agents/:id/heartbeat` — agent reports status + config version
- **Local override**: `POST /api/sync/override/:agentId` — agent reports a local config change

### Conflict Resolution: Central-Wins Default

When controller and agent have different config versions:
- **Default**: Controller's version wins (safety-first for multi-agent environments)
- **Configurable per-agent**: Can be set to `local-wins` or `manual` review
- **Audit trail**: Every sync operation logged to `config_sync_log` table

### Config Versioning

- Every agent config has an integer `config_version` that increments on each change
- Both controller and agent track their current version
- Point-in-time snapshots stored in `config_snapshots` table for rollback

### Data Model

Core PostgreSQL tables (see `scripts/migrations/001-multi-agent-foundation.sql`):
- `agents` — Agent definitions, persona, provider link, metadata, config version
- `tools` — Persistent tool registry with typed descriptors (MCP, API, CLI)
- `agent_tools` — Many-to-many agent ↔ tool assignments with per-agent config
- `config_sync_log` — Audit trail for all sync operations
- `config_snapshots` — Point-in-time full config snapshots

### Feature-Sliced Design Structure

```
src/shared/types/     — Zod schemas for AgentConfig, ToolDescriptor, ConfigSyncRecord
src/shared/logger/    — Pino structured JSON logger
src/entities/agent/   — Agent data model and DB operations
src/entities/tool/    — Tool data model and descriptor validation
src/entities/config/  — Refactored ConfigManager
src/features/agent-management/  — Agent CRUD service
src/features/tool-registry/     — Tool registration and discovery
src/features/config-sync/       — Sync engine and conflict resolution
src/features/tool-loader/       — Dynamic tool loading and execution
```

## Consequences

### Positive
- Single source of truth for all agent configurations (eliminates .env sprawl)
- Encrypted credential storage with per-agent partitioning
- Full audit trail for every config change across 50+ agents
- UI-managed agent lifecycle (no more manual YAML editing)
- Rollback capability via config snapshots
- Offline resilience (agents cache last-known-good config)

### Negative
- Adds network dependency: agents must reach controller for bootstrap (mitigated by local cache)
- REST-based sync may not scale past ~200 agents (acceptable for current 50-agent target; can add message queue later)
- Migration effort: oshal `AgentBootstrap` must be adapted to call oshal API instead of reading local YAML/env
- Two PostgreSQL instances in play (oshal uses SQLite via SettingsStore, oshal uses PostgreSQL) during transition

### Risks
- Config push to unresponsive agents: mitigated by retry logic + heartbeat monitoring
- Stale local cache: mitigated by config version comparison on every heartbeat
- Schema migration on live system: mitigated by `IF NOT EXISTS` guards and versioned migrations

## Alternatives Considered

| Alternative | Why Rejected |
|------------|-------------|
| **Message queue (Redis/RabbitMQ)** for sync | Over-engineered for 50 agents; REST is simpler to debug, monitor, and already used by oshal's MeshBroadcastNetwork |
| **etcd/Consul** for config distribution | Adds infrastructure dependency; PostgreSQL already running in Docker Compose |
| **Git-based config** (GitOps) | Too slow for real-time config changes; no encrypted secret support |
| **Keep .env files** with better tooling | Fundamental limitation: no encryption, no versioning, no UI management |
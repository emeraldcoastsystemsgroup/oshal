# ADR-034: Bidirectional Config Ownership and Sync

## Status
Accepted — 2026-06-08

Implements the configuration model declared in [ADR-006](006-multi-agent-configuration-architecture.md) (accepted but never built — `src/features/config-sync/` shipped as an empty placeholder) and completes the control/runtime boundary described in [any-bot-swarm-separation-design.md](../research/any-bot-swarm-separation-design.md). Extends the runtime contract of [ADR-018](018-swarm-processing-runtime-contract.md).

## Context

An any-bot's runtime parameters (provider, model, mode, timeout, credentials, MCP set, behavior flags) have no single owner today. An audit on 2026-06-08 found the same logical value scattered across 4–5 uncoordinated stores with no arbiter:

- OSHAL Postgres `agent_profiles` (provider/model only — what the cockpit edits)
- OSHAL filesystem `global-config.json` / `secrets.json` (what `/api/config` edits)
- the any-bot's own Redis key `config:llm-provider:{agentId}`
- the any-bot's own `~/.cline/config.json` + `data/globalState.json` + `data/secrets.json`
- env-var overrides (`ANTHROPIC_API_KEY`, `FORCE_LLM_*`) that beat all of the above at boot

Sync between them is one-way file-writes that race by container lifecycle (last-writer-wins), plus a behind-the-bot filesystem rewrite (`WorkspaceConfigSyncService`) whose failures are swallowed. There is no live OSHAL→bot control edge (`BotNodeClient.switchProvider` is dead code), the dispatch path drops the `providerId`/`model` OSHAL sends (`swarm-node.js`, `bot-node-server.ts`), and there is no path for a bot to report a locally-originated config change back to OSHAL. This is the concrete mechanism behind "any-bot and OSHAL fight over who owns who."

ADR-006 already prescribed the correct model (controller holds golden config, agents pull on bootstrap and cache for offline resilience, controller pushes changes, agent reports local overrides, central-wins conflict resolution, config versioning + audit). It was never implemented. This ADR makes that model concrete and adds the missing trigger.

## Decision

### 1. Ownership: OSHAL owns the record; the any-bot owns the mechanics

OSHAL is the **single source of truth** for every any-bot's runtime parameter *record* (which provider/model/mode/timeout/flags an agent should run with), stored in Postgres (`agent_config`, the already-Postgres-backed `AgentConfigService`). The any-bot owns the **mechanics** of applying them — credential field mapping, `~/.cline` file writes, CLI spawning — via its existing `PUT /api/llm-provider` (`LLMProviderRegistry.buildClineConfig/buildGlobalState`). OSHAL never writes the bot's internal files directly (this retires the behind-the-bot `WorkspaceConfigSyncService` rewrite). All other stores (the bot's Redis key, SQLite SettingsStore, `~/.cline` files) are **derived caches**, never authorities.

### 2. Push down (OSHAL → any-bot): API-driven, two edges

- **On config change:** an OSHAL-side config update (cockpit/profile/agent-config save) calls the bot's `PUT /api/llm-provider` via `BotNodeClient.switchProvider` (previously dead code, now wired). The bot applies and persists to its derived caches.
- **On dispatch:** every `BotNodeClient.execute` carries the authoritative `providerId`/`model` from the OSHAL record (and a `configVersion`). The bot's `/api/swarm-execute` applies them for that execution instead of dropping them. The runback in `BotNodeResponse` is **telemetry only** — OSHAL records its own intended provider/model against the task, never adopts the bot's self-resolved value as truth.

### 3. Broadcast up (any-bot → OSHAL): the missing trigger, over the mesh

When a bot's bot-level config changes locally (its own UI hits `PUT /api/llm-provider`, or a swarm-owning bot changes a sub-bot), the bot **broadcasts a config-change envelope** on a dedicated Redis-mesh channel `swarm.config-change` (`MESH_CHANNELS.configChange`). The OSHAL controller subscribes to this channel and **reconciles** the change into the authoritative record:

- **Central-wins (default):** OSHAL records the reported change, bumps `config_version`, writes an audit row, and MAY re-push the authoritative value back to the bot if it disagrees.
- A swarm-owning any-bot pushes its sub-swarm's changes to the OSHAL swarm controller via the same channel — "if an any-bot has a swarm, it pushes its changes to the controller."

The mesh is used (not the REST `POST /api/sync/override/:agentId` ADR-006 sketched) because the Redis Streams mesh is already the durable, working swarm bus, it matches the "broadcast" semantics, and it naturally carries the swarm-of-swarm case to the controller. Wire format is the existing `MeshEnvelope` JSON on `oshal:mesh:swarm.config-change`.

### 4. Standalone resilience: seed → pull → cache

An any-bot runs standalone. On boot it uses its cached config (env seed + last-known `~/.cline`/Redis) so it works with OSHAL unreachable. When OSHAL is reachable it **pulls** its authoritative record (bootstrap) and overwrites its caches; env vars (`ANTHROPIC_API_KEY`, `FORCE_LLM_*`) become **first-boot seeds only**, deferring to the pulled record once OSHAL answers. No reachable-OSHAL change is silently lost: a bot that changed config offline broadcasts on reconnect.

### 5. Versioning and audit

The authoritative record carries an integer `config_version` (stored on the `agent_config` record) that increments on every change (push or reconciled broadcast). Every sync operation is written to the **existing `config_sync_log` audit table** (migration 001 / ADR-006): direction (`push`/`pull`), `config_version_before`/`after`, `changes`, `status`, `synced_at`. Dispatch stamps the version; the bot echoes the applied version so OSHAL can detect drift.

## Consequences

### Positive
- One owner for an any-bot's params; the 4–5 competing stores become caches of the OSHAL record.
- OSHAL can change a live bot without respawn, and what runs on dispatch matches OSHAL's intent.
- Locally-originated bot changes flow back to OSHAL (the previously-missing trigger); OSHAL stays system-of-record without reaching into bot internals.
- Standalone operation preserved; reconnect reconciles.
- Auditable, versioned config with drift detection.

### Negative / risks
- The legacy localhost `/api/send-message` fallback does not carry params yet — partial coverage until updated; OSHAL intent can still be dropped on that fallback route.
- Credentials now flow through dispatch/push payloads and the mesh — must not be logged and must stay on the internal network; mesh config-change envelopes carry references/version, not raw secrets, where possible.
- Demoting `ANTHROPIC_API_KEY` from steady-state authority must not regress the auth-failure fix (`app.js`) where a stale Redis Bedrock config overwrote working Anthropic creds — the OSHAL record must hold correct creds before that override is removed.
- Central-wins re-push must surface failures explicitly, never fall back to the swallowed file rewrite, or the ownership fight returns.

### Coordinated docs (per ADR-018 §6)
On change to this contract, update together: `docs/architecture/swarm-processing-design-contract.md`, `docs/architecture/swarm-orchestration-process-flow.md`, `src/features/swarm-orchestration/README.md`, and this ADR's index entry.

## Rollout (incremental, each typecheck-clean)
1. Add `perAgentRuntime` to the config ownership contract.
2. Thread `providerId`/`model`/`configVersion` through dispatch; bot applies them.
3. Add `MESH_CHANNELS.configChange` + the OSHAL `config-sync` subscriber (reconcile/central-wins/version/audit).
4. Bot broadcasts on local config change.
5. Wire `switchProvider` into the OSHAL config-update path; retire the behind-the-bot file rewrite.
6. Bootstrap pull + env-as-seed. Audit reuses the existing `config_sync_log` table (ADR-006); `config_version` lives on the `agent_config` record (no new migration).

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ADR for per-bot container architecture
 */

# ADR-019: Per-Bot Docker Container Architecture

---

## Status
Accepted — supersedes aspects of ADR-004 (single api-server container) and ADR-018 (in-process swarm orchestration)

## Context

### The Problem
OSHAL inherited a single-process architecture from early development phases where one Express server on port 3456 handled everything: chat, configuration, tool registry, and swarm orchestration. All agents were database records processed within a single Node.js event loop.

This created fundamental limitations:
1. **No identity isolation** — every agent used the same hardcoded "You are Cline" system prompt
2. **No config isolation** — one `global-config.json` shared across all agents
3. **No fault isolation** — one agent crashing or blocking the event loop affected all agents
4. **No independent scaling** — couldn't scale code-developer independently of project-manager
5. **No per-agent credentials** — API keys, tool authorizations, and memory were global

### The Reference: oshal's Working Model
The predecessor project oshal runs 50+ bots as individual Docker containers, each with:
- Its own Express server on its own port (3010–3071)
- Its own persona loaded from YAML at startup
- Its own private settings volume (`/app/.cline`)
- Shared workspace volume for project files
- Redis for inter-bot communication (task queuing, capability announcements)

This model is proven in production with real multi-agent workflows: ticket decomposition, parallel code generation, automated QA gating, and coordinated delivery.

### ADR-004 (Containerization Strategy) Established
ADR-004 containerized the api-server as a single container alongside Keycloak and Postgres infrastructure. This was correct for the initial development phase but insufficient for multi-agent swarm execution.

### ADR-018 (Swarm Processing Runtime Contract) Assumed
ADR-018 defined swarm processing as synchronous in-process orchestration via routes like `POST /api/swarm/tickets`. This worked for single-server mode but cannot support true per-bot fault isolation or independent scaling.

## Decision

### Adopt the legacy codebase's per-bot container model for OSHAL swarm execution

Each bot runs as its own Docker container with:
1. **Same Docker image** — a single Dockerfile builds the image; bots are differentiated by environment variables only (`BOT_NAME`, `BOT_PERSONA_FILE`, `AGENT_ID`, `BOT_ROLE`)
2. **Own Express server** — each bot listens on port 5000 internally, mapped to unique host ports (3010–3016+)
3. **Own persona** — loaded from YAML at container startup, injected as the Level-0 system prompt
4. **Own private settings** — per-bot named Docker volumes for config, secrets, and memory
5. **Shared workspace** — all bots mount the same workspace directory for project file access
6. **Redis for inter-bot communication** — task routing, capability announcements, status updates
7. **Hot-swap development** — source code bind-mounted for live reload via nodemon + ts-node

### What this supersedes

| Previous Decision | New Reality |
|---|---|
| ADR-004: Single `api-server` container | Each bot is its own container; standalone mode still available |
| ADR-018: Synchronous in-process swarm | Bots communicate via Redis Streams across container boundaries |
| Hardcoded "You are Cline" prompt | Per-bot persona loaded from YAML → JSON at startup |
| Global `global-config.json` | Per-bot private settings volumes |

### What this preserves

- **Standalone mode** — the original docker-compose.yml with a single api-server on port 3456 remains available for non-swarm use cases
- **FSD architecture** — the same codebase runs in both modes; the per-bot compose simply runs N instances with different env vars
- **Tool registry and agent profiles** — shared Postgres database across all bots
- **MOCK_OIDC dev mode** — each bot runs with mock auth in development

## Implementation

### Compose File: `docker-compose.swarm-local.yml`
- `x-bot-common` YAML anchor for shared configuration (mirrors oshal's pattern)
- 5 initial core bots: project-manager, task-manager, code-developer, code-reviewer, documentation-writer
- Infrastructure: Redis 7 + Postgres 16

### Startup Chain: `scripts/bot-entrypoint.sh`
1. `setup-cline-auth.sh` — Cline CLI auth (same as oshal)
2. Persona YAML → JSON conversion via `yq` + `jq`
3. Redis registration
4. Dev mode: nodemon + ts-node | Prod mode: compiled JS

### Persona Loading: `provider-runtime.ts`
- `resolveLevel0SystemPrompt()` reads `bot-persona.json` written by entrypoint
- Falls back to default Cline prompt when no persona file present

## Consequences

### Positive
- **True fault isolation** — one bot crashing doesn't affect others
- **Independent scaling** — can run multiple code-developer instances
- **Per-bot identity** — each bot has its own persona, not "You are Cline"
- **Per-bot config** — API keys, model selection, tool authorizations are private per bot
- **Architectural alignment** — matches the proven oshal production model
- **Hot-swap development** — edit source on host, all bots auto-reload

### Negative
- **Higher resource usage** — N containers vs. 1 (each bot loads the full Node.js image)
- **Inter-bot communication complexity** — Redis Streams instead of in-process function calls
- **Database connection count** — each bot opens its own Postgres connection pool
- **Build time** — single Docker image build, but N container starts

### Risks
- Redis becoming a single point of failure for inter-bot communication
- Postgres connection exhaustion with many bots (mitigated by connection pooling)
- Dev machine resource constraints with 5+ containers running simultaneously

## Related ADRs
- **ADR-004**: Containerization Strategy — partially superseded (single-server mode preserved)
- **ADR-011**: Agent Framework Architecture — extended (agents now run in separate processes)
- **ADR-018**: Swarm Processing Runtime Contract — partially superseded (async Redis vs. sync in-process)
- **ADR-015**: Swarm Phase Inheritance Pack — unaffected (lifecycle phases apply within each bot)
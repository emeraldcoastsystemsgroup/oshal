# ADR-010: Layer 1 Tools Framework - Database-Backed Switch System

**Status:** Accepted  
**Date:** 2026-03-09  
**Deciders:** Project Team  
**Technical Story:** Phase 6 - Layer 1 Tools Framework Implementation

---

## Context

The oshal system requires a flexible, scalable approach to managing tool availability and authorization for agents. Previously, tool authorization was managed through environment variables, which had significant limitations:

- **No per-agent granularity**: All agents shared the same tool authorization
- **No runtime changes**: Tool availability required application restart
- **No audit trail**: No record of tool installations or authorization changes
- **No conditional installation**: Tools were either globally available or not
- **No capability composition**: Agent capabilities were static, not dynamically composed from tools

The system needed a framework that would:
1. Allow per-agent, per-tool authorization control
2. Support runtime authorization mode changes without restart
3. Provide three authorization modes: auto (execute immediately), ask (require approval), off (not available)
4. Track tool installation state and verification
5. Dynamically compose agent capabilities from enabled tools
6. Support auth groups for bulk tool authorization
7. Provide a complete audit trail of tool changes

---

## Decision

We implemented a **database-backed tool switch framework** with the following architecture:

### Core Components

#### 1. Tool Registry (Catalog)
A central registry of all available tools in the system, stored in the `tools` table:

```sql
CREATE TABLE tools (
  tool_id UUID PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  type VARCHAR(50) NOT NULL,  -- mcp, api, cli
  install_spec JSONB NOT NULL,
  skills TEXT[] NOT NULL,
  selector_fragment TEXT,
  routing_tags TEXT[],
  auth_group VARCHAR(100),
  default_auth_mode VARCHAR(10),
  -- ... additional metadata fields
);
```

#### 2. Switch Framework (Authorization)
Per-agent, per-tool authorization management via the `agent_tools` table:

```sql
CREATE TABLE agent_tools (
  agent_id UUID REFERENCES agents(agent_id) ON DELETE CASCADE,
  tool_id UUID REFERENCES tools(tool_id) ON DELETE CASCADE,
  auth_mode VARCHAR(10) NOT NULL CHECK (auth_mode IN ('auto', 'ask', 'off')),
  installed BOOLEAN NOT NULL DEFAULT false,
  install_verified BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (agent_id, tool_id)
);
```

**Authorization Modes:**
- `auto`: Tool executes immediately without approval
- `ask`: Tool execution requires explicit user approval
- `off`: Tool is not available/installed for this agent

#### 3. Selector Composition (Dynamic Capabilities)
Agents have computed capabilities that combine base fields with enabled tool capabilities:

```sql
ALTER TABLE agents ADD COLUMN base_capabilities TEXT[] DEFAULT '{}';
ALTER TABLE agents ADD COLUMN computed_capabilities TEXT[] DEFAULT '{}';
-- computed_capabilities = base_capabilities ∪ Σ(enabled_tool.skills)
```

The composition algorithm:
1. Read agent base fields (base_capabilities, base_selector_descriptor, base_routing_keywords)
2. Query enabled tools (auth_mode != 'off')
3. Aggregate tool skills, selector_fragments, routing_tags
4. Compute union: `computed = base ∪ tool`
5. Update agents.computed_* fields
6. Return ComposedSelector object

#### 4. Auth Groups
Tools can be grouped for bulk authorization management:

```typescript
// Example: Kubernetes tool group
authGroup: 'kubernetes'  // kubectl, helm, argocd share authorization state
```

Setting auth mode for a group updates all tools in that group atomically.

### Implementation Layers (FSD Architecture)

#### Entities Layer (`src/entities/tool/`)
- **Repositories**: `ToolRepository`, `AgentToolRepository`
  - Data access layer with PostgreSQL queries
  - Field name mapping (camelCase ↔ snake_case)
  - Dynamic filtering, pagination, full-text search
- **Schemas**: Zod validation for all operations
  - `CreateToolSchema`, `UpdateToolSchema`, `ToolFiltersSchema`
  - `SetAgentToolAuthModeSchema`, `SetGroupAuthModeSchema`

#### Features Layer (`src/features/`)
- **tool-registry**: Tool catalog management
  - `ToolRegistryService`: Business logic for tool CRUD
  - `ToolController`: HTTP API endpoints
- **tool-switch**: Authorization mode management
  - `SwitchFrameworkService`: Auth mode transitions, tool installation orchestration
  - `AgentToolController`: HTTP API for agent-tool operations
- **selector-composition**: Dynamic capability composition
  - `SelectorCompositionService`: Selector composition algorithm

#### API Routes
- **Tool Registry**: `/api/tools/*`
  - GET `/api/tools` - List all tools with filtering
  - POST `/api/tools` - Register new tool
  - GET `/api/tools/:id` - Get tool by ID
  - PUT `/api/tools/:id` - Update tool
  - DELETE `/api/tools/:id` - Delete tool
  - GET `/api/tools/metadata/categories` - Get categories
  - GET `/api/tools/metadata/auth-groups` - Get auth groups
  - GET `/api/tools/search?q=term` - Full-text search

- **Agent-Tool Management**: `/api/agents/*`
  - GET `/api/agents/:agentId/tools` - Get agent tools with auth modes
  - GET `/api/agents/:agentId/tools/enabled` - Get enabled tools
  - PUT `/api/agents/:agentId/tools/:toolId` - Set auth mode for tool
  - PUT `/api/agents/:agentId/tools/groups/:groupName` - Set auth mode for group
  - GET `/api/agents/:agentId/selector` - Get composed selector
  - POST `/api/agents/:agentId/selector/recompose` - Force recomposition

### State Transitions

**Auth Mode Transitions:**
```
off → ask:   Install tool, mark as ask
off → auto:  Install tool, mark as auto
ask → auto:  No installation change
auto → ask:  No installation change
ask → off:   Uninstall tool
auto → off:  Uninstall tool
```

**Selector Recomposition:**
Triggered automatically after any auth mode change to keep computed fields synchronized.

---

## Consequences

### Positive

1. **Per-Agent Flexibility**: Each agent can have different tool authorization configurations
2. **Runtime Changes**: Tool availability can be changed without application restart
3. **Audit Trail**: Complete history of tool installations and auth mode changes
4. **Dynamic Capabilities**: Agent selectors automatically reflect enabled tools
5. **Bulk Operations**: Auth groups enable efficient management of related tools
6. **Installation Orchestration**: Automatic tool installation/uninstallation on auth mode changes
7. **Type Safety**: Zod schemas provide runtime validation and type inference
8. **Scalability**: Database-backed approach scales with system growth
9. **Clean Architecture**: FSD pattern provides clear separation of concerns
10. **Testability**: Each layer can be tested independently

### Negative

1. **Database Dependency**: Requires PostgreSQL connection for all tool operations
2. **Complexity**: More complex than environment variable approach
3. **Migration Required**: Existing tool configurations need migration
4. **Performance Overhead**: Database queries add latency vs in-memory lookup
5. **Eventual Consistency**: Brief window where computed fields may be stale

### Mitigations

- **Connection Pooling**: PostgreSQL connection pool (max 20) minimizes connection overhead
- **Indexed Queries**: Proper indexing on tools and agent_tools tables
- **Caching Strategy**: Future optimization can add Redis cache for tool metadata
- **Async Recomposition**: Selector recomposition runs in background
- **Migration Script**: Automated migration from env vars to database

---

## Alternatives Considered

### 1. Environment Variables (Status Quo)
**Rejected**: No per-agent granularity, no runtime changes, no audit trail

### 2. Configuration Files (YAML/JSON)
**Rejected**: File system I/O overhead, no transactional updates, difficult to query

### 3. In-Memory Store
**Rejected**: Data lost on restart, no persistence, no audit trail

### 4. Redis-Only Approach
**Rejected**: No relational queries, no foreign key constraints, limited transaction support

### 5. Hybrid (Redis + PostgreSQL)
**Future Consideration**: Redis for hot data, PostgreSQL for source of truth. May implement in future for performance optimization.

---

## Dockerfile Alignment

### Decision: Tool Catalog Synchronized with Dockerfile Baseline

**Date:** 2026-03-09  
**Context:** During tool catalog seeding, we discovered a mismatch between documented tools (12) and actual tools installed in the baseline Docker image (`any-bot/Dockerfile`, ~31 tools).

**Resolution:**
- Tool catalog expanded from 12 to **31 tools**
- Removed tools not in Dockerfile: `gh` (GitHub CLI), `podman`
- Added 21 tools from Dockerfile baseline:
  - **Cloud**: `gsutil` (Google Cloud Storage utility)
  - **Development**: `cline`, `claude-code`, `python3`, `uv`
  - **Infrastructure**: `vault` (HashiCorp Vault)
  - **Containers**: `docker-compose`
  - **Data Processing**: `jq`, `yq`
  - **System Utilities**: `bash`, `curl`, `wget`, `make`, `openssh-client`, `openssl`, `tar`, `gzip`, `unzip`, `sqlite`, `graphviz`, `fzf`

**Principle:**
> The Dockerfile is the source of truth for available tools. All tools installed in the container must be registered in the tool catalog so the LLM agent knows about them and can invoke them.

**Tool Categories (Final Count):**
- devops: 3 tools
- cloud: 4 tools
- development: 5 tools
- infrastructure: 3 tools
- containers: 2 tools
- data-processing: 2 tools
- system-utilities: 12 tools
- **Total: 31 tools**

**Install Method:**
All tools use `InstallMethod.NONE` because they are pre-installed via Dockerfile. Install specifications serve as documentation and verification commands only.

**Future Enhancement:**
Dynamic tool installation at runtime is planned as a backlog item. The switch framework will control both installation and visibility, but currently controls only visibility.

**Synchronization Process:**
1. Tool added to Dockerfile → 
2. Tool definition added to `scripts/seed-tools.ts` → 
3. Documentation updated in `docs/tool-catalog.md` → 
4. Seed script executed → 
5. Tool available to agents via switch framework

**Version Alignment:**
Tool versions in the catalog must match Dockerfile versions exactly:
- Terraform: 1.9.8 (was 1.6.0, updated to match Dockerfile)
- Vault: 1.18.5 (new addition)
- Python3: 3.11.0 (explicitly documented)

**References:**
- Dockerfile Baseline: `any-bot/Dockerfile`
- Tool Catalog: `docs/tool-catalog.md` (version 2.0.0)
- Seed Script: `scripts/seed-tools.ts`

---

## Implementation Notes

### Database Schema Version
- Migration script: `scripts/migrations/002-layer1-tools-framework.sql`
- Schema version: 2
- Backward compatible: No (requires migration from 001)

### Key Design Patterns
- **Repository Pattern**: Data access abstraction
- **Service Layer**: Business logic isolation
- **Controller Pattern**: HTTP request handling (extends BaseController)
- **Composition Root**: Dependency injection via AppContext
- **Feature-Sliced Design**: Strict layer separation (app → features → entities → shared)

### Future Enhancements
1. **Tool Installation Verification**: Automated verification after installation
2. **Conditional Tool Activation**: Enable tools based on runtime conditions
3. **Tool Dependencies**: Tools that require other tools to be installed
4. **Tool Versioning**: Support multiple versions of the same tool
5. **Usage Analytics**: Track tool usage frequency and success rates
6. **Redis Caching**: Cache tool metadata for performance optimization

---

## References

- Task Brief: `ralf/phase-6-layer1-tools-framework-task-brief.md`
- Implementation Plan: `docs/layer1-tools-switch-framework-implementation-plan.md`
- Handover Document: `src/entities/tool/HANDOVER.md`
- Database Migration: `scripts/migrations/002-layer1-tools-framework.sql`
- FSD Architecture: `.clinerules/architecture.md`

---

## Related ADRs

- [ADR-001: Migration from oshal to FSD](./001-migration-oshal-to-fsd.md)
- [ADR-002: Encrypted Config Storage](./002-encrypted-config-storage.md)
- [ADR-006: Multi-Agent Configuration Architecture](./006-multi-agent-configuration-architecture.md)
- [ADR-009: API Tool Framework](./009-api-tool-framework.md)

/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ADR for agent framework architecture
 */

# ADR-011: Agent Framework Architecture with Cline CLI Integration Layer

---

## Naming and Migration Policy

- All new code, objects, endpoints, and documentation must use the `OSHAL` namespace and naming.
- No `oshal` naming, objects, or legacy conventions are allowed.
- See `.clinerules/naming.md` for the full rule and enforcement policy.

---

## Status
Accepted

## Context

As the OSHAL project evolved from a single chatbot to a multi-agent orchestration system, we needed to establish a clear architectural boundary between the **agent execution layer** and the **orchestration framework layer**.

The current implementation uses Cline CLI as the primary agent for code generation and file manipulation. However, the system was built organically without explicitly defining where the agent's responsibilities end and the framework's responsibilities begin.

This lack of clarity creates several challenges:
- **Tight coupling**: Agent logic mixed with orchestration logic
- **Limited extensibility**: Difficult to swap or add new agent types
- **Testing complexity**: Cannot test framework and agent independently
- **Scalability constraints**: No clear path to multi-agent workflows

## Decision

We establish the **Cline CLI Integration Layer** as the **agent interface boundary**, with clear separation of responsibilities:

### Agent (Cline CLI or Replacements)
**Responsibilities:**
- Execute within a scoped workspace boundary
- Read/write files only within assigned workspace
- Run commands and interact with tools
- Communicate with LLM providers
- Provide status updates and logs

**Inputs from Framework:**
- Workspace path: `/workspaces/{task-uuid}/`
- Task ID: UUID
- User prompt/instructions
- Optional: Tool permissions, cost limits, timeout constraints

**Outputs to Framework:**
- Modified files in workspace
- Status updates (progress, completion, errors)
- Structured logs
- Cost/token usage metrics

### Framework (any-bot / Layer 1 System)
**Responsibilities:**
- Task lifecycle management (create, monitor, complete, archive)
- Workspace provisioning and isolation
- UUID generation for task identification
- Multi-agent orchestration (if needed)
- Authentication/authorization (OIDC/Keycloak)
- UI (cockpit for monitoring/interaction)
- Cost tracking, rate limiting, governance
- Tool registry and management

**Does NOT Handle:**
- Actual code generation
- File manipulation within workspace
- LLM interaction
- Tool execution within workspace

### The Integration Layer Contract

```typescript
interface Agent {
  execute(context: AgentContext): Promise<AgentResult>;
}

interface AgentContext {
  workspacePath: string;        // /workspaces/{task-uuid}/
  taskId: string;                // UUID
  prompt: string;                // User's request
  toolPermissions?: string[];    // Which tools the agent can use
  costLimit?: number;            // Max spend for this task
  timeoutMs?: number;            // Max execution time
}

interface AgentResult {
  status: 'success' | 'failure' | 'partial';
  modifiedFiles: string[];       // Paths relative to workspace
  logs: LogEntry[];              // Structured logs
  cost?: number;                 // Actual spend
  durationMs: number;            // Execution time
}
```

### Workspace Mapping

The framework maintains workspaces at:
```
../../workspaces/
  ├── {task-uuid-1}/          ← Framework creates this
  ├── {task-uuid-2}/
  └── {task-uuid-3}/
```

The agent sees:
```
/workspace/                    ← Agent's normalized view
```

The framework handles the path translation and enforces workspace boundaries.

### Agent Invocation Pattern

For Cline CLI:
```bash
# Framework creates workspace
mkdir -p /workspaces/{uuid}

# Framework invokes agent
cline-cli --workspace=/workspaces/{uuid} --task={uuid} --prompt="..."

# Framework monitors process and collects results
```

For a different agent (e.g., custom `codex-bot`):
```bash
# Same workspace creation
mkdir -p /workspaces/{uuid}

# Different agent invocation
codex-bot --workspace=/workspaces/{uuid} --task={uuid} --prompt="..."

# Same monitoring and result collection
```

The framework code **does not change** when swapping agents—only the invocation command changes.

## Consequences

### Positive
- **Clean separation of concerns**: Agent and framework have clearly defined responsibilities
- **Hot-swappable agents**: Can replace Cline CLI with custom agents, different AI assistants, or even human developers for testing
- **Independent testing**: Framework can be tested with mock agents; agents can be tested with mock frameworks
- **Parallel innovation**: Framework improvements (orchestration, workspace management) are independent from agent improvements (better prompts, tool use)
- **Multi-agent workflows**: Framework can orchestrate multiple agents working in parallel or sequentially
- **Task isolation**: Each task gets its own workspace, preventing cross-contamination
- **Auditability**: UUID-based task tracking provides complete traceability

### Negative
- **Interface maintenance**: Need to maintain backward compatibility at the integration layer
- **Path mapping complexity**: Framework must handle workspace path translation
- **Additional abstraction**: One more layer to understand for new developers
- **Documentation overhead**: Must document agent interface contract clearly

### Risks
- **Cline CLI changes**: If Cline CLI changes its interface, we need adapter layer
- **Workspace boundary enforcement**: Agents must respect workspace limits (requires enforcement mechanisms)
- **Performance overhead**: Path mapping and workspace isolation may add latency
- **State persistence**: Need clear strategy for handling long-running tasks that span multiple sessions

## Implementation Notes

### Current State (2026-03-09)
- any-bot framework already implements task management, workspace creation, and orchestration
- Cline CLI integration exists but boundary is implicit, not formalized
- UUID-based task IDs already in use
- Workspace folder structure exists organically

### Required Work
1. Formalize the agent interface contract (TypeScript types or OpenAPI spec)
2. Implement workspace boundary enforcement (prevent file access outside workspace)
3. Create adapter layer for Cline CLI invocation
4. Document agent development guide for creating custom agents
5. Build framework lifecycle hooks (`onTaskStart`, `onTaskComplete`, `onTaskFail`)
6. Implement workspace archival and cleanup policies

### Migration Path
This ADR documents the **target architecture**. Current code may not fully align yet. The migration should be incremental:
1. **Phase 1**: Formalize interface types and contracts
2. **Phase 2**: Refactor existing Cline CLI integration to use adapter pattern
3. **Phase 3**: Implement workspace boundary enforcement
4. **Phase 4**: Build multi-agent orchestration support

## Related ADRs
- ADR-001: Migration from oshal to OSHAL with FSD
- ADR-006: Multi-Agent Configuration Architecture
- ADR-009: API Tool Framework
- ADR-010: Layer 1 Tools Framework

## References
- `any-bot/` - Framework implementation
- `.clinerules/architecture.md` - FSD pattern enforcement
- `ralf/` - RALF methodology for task documentation
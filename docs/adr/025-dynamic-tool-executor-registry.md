# ADR-025: Dynamic Tool Executor Registry

## Status
Accepted — 2026-03-27

## Context
`ToolExecutorService.dispatchTool()` uses a hardcoded `switch` statement to route tool names to handler methods. Adding a new executable tool requires:
1. Adding a `case` to the switch (modifying a file at 909 lines, past the 800-line governance trigger)
2. Adding a handler method to the same class
3. Rebuilding and redeploying the control plane

This creates friction for the planned MCP and CLI tool integrations in Phase 13+. It also makes it impossible for external code (tests, plugins, per-environment overrides) to register execution strategies without modifying core files.

Two approaches were considered:

1. **Decompose `ToolExecutorService` now** — split the switch into a dispatcher + separate handler modules, then add a dynamic lookup step. High immediate value but requires governance-safe decomposition first.

2. **Add an in-memory registry alongside the existing switch** — the registry is consulted by new/external callers; the existing switch remains untouched for now. Low risk, no decomposition required.

## Decision

Implement `DynamicToolExecutorRegistry` as an in-memory extension point alongside the existing hardcoded dispatch. The registry maps tool names to `ToolExecutorDescriptor` objects describing execution strategy:

```
ToolExecutorDescriptor {
  toolName: string
  executorType: 'builtin' | 'cli' | 'api' | 'mcp'
  builtinKey?: string        // maps to existing switch case name
  cliCommand?: string        // template with {input.*} placeholders
  apiEndpoint?: string       // base URL for HTTP tool integrations
  mcpServerName?: string     // name in active MCP runtime config
  runtimeRegistered: boolean // false = startup-seeded, true = runtime-registered
  registeredAt: string
}
```

At startup, `seedBuiltinDescriptors()` registers all current builtin tools with `executorType: 'builtin'` and `runtimeRegistered: false`. These entries document which tool names the hardcoded switch handles — making the implicit explicit.

Runtime callers can register new descriptors via `register()`. Only runtime-registered descriptors can be removed via `deregister()` — builtin descriptors are permanent for the process lifetime.

The registry is wired into `AppContext.dynamicToolExecutorRegistry` so routes and services can register CLI/API/MCP tools at startup without touching `ToolExecutorService`.

**Phased hookup:** Connecting the registry to `ToolExecutorService.dispatchTool()` requires decomposing that file. This is tracked as tech debt. In the interim, the registry serves as the source of truth for which tools are registered and what their execution strategy is — useful for the schema-driven config UI and operator tooling.

## Consequences

- No change to `ToolExecutorService` — zero risk of regressions in the existing dispatch path.
- The registry is process-scoped and reset on container restart; startup seeding (`seedBuiltinDescriptors()`) restores baselines.
- Future: when `ToolExecutorService` is decomposed, the switch cases become registry lookups and the registry becomes the single dispatch source.
- Future: CLI tools registered at runtime can template `{input.path}` etc. into shell commands without code changes.
- Future: MCP tools registered at runtime can be dispatched to the correct server without hardcoding server names.

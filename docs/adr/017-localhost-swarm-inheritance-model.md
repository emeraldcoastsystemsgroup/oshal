# ADR-017: LocalHost / Swarm Inheritance Model

## Status
Accepted

## Supersedes

- ADR-016: Swarm Agent Type and Inheritance Model

## Context

ADR-016 moved the project in the right direction by making swarm a specialization instead of a disconnected runtime, but it still gave too much conceptual weight to flags such as mode/type.

The clarified developer expectation is simpler:

- all agents run the same core interfaces
- all agents share the same provider/API, tools, skills, memory, and lifecycle plumbing
- TypeScript inheritance should be the primary model at runtime
- if a flag/switch exists, it should exist mainly for persistence, factory selection, UI wiring, or infrastructure enablement

The next multi-bot phase also introduces a second major runtime branch:

1. **LocalHost** — the first real host runtime
2. **Swarm** — an extension of LocalHost with deeper persona layering, multi-tenant behavior, delegation, and coordination

This means the real runtime model must be inheritance-first, not switch-first.

## Decision

### 1. Use real TypeScript inheritance as the primary runtime model

The active runtime hierarchy is:

```text
BaseAgent
  ├── LocalHostAgent
  │     └── SwarmAgent
  └── NoopAgent
```

This means:

- `BaseAgent` owns shared contracts and plumbing
- `LocalHostAgent` is the first concrete host runtime
- `SwarmAgent` inherits LocalHost behavior and then adds distributed / multi-bot behavior

### 2. Keep one common interface across all agents

All agents should continue to implement the same core runtime contract:

```ts
interface IAgent {
  processMessage(input: Message): Promise<Response>
  useTool(call: ToolCall): Promise<ToolResult>
  getSkills(): Skill[]
}
```

The system should rely on polymorphism and overridden methods instead of switch-heavy business logic.

### 3. Treat flags as boundary hints, not the primary model

A small discriminator is still allowed where it is operationally useful.

Examples:

- persistence (`topology: 'localhost' | 'swarm'`)
- factory/composition-root instantiation
- enabling swarm-only infrastructure
- UI/config surfaces

But the discriminator is secondary. The runtime should not depend on scattered `if (isSwarm)` checks when normal method overriding can express the same behavior more cleanly.

### 4. Separate persona layering from class inheritance

Swarm adds more persona depth, but persona layering is a separate architectural axis from class inheritance.

The target layering order is:

1. **Platform base layer**
2. **Host/runtime layer** (`LocalHost` vs `Swarm`)
3. **Tenant layer**
4. **Role/persona layer**
5. **Task/session override layer**

This allows swarm to add two or three more layers of persona and multi-tenant behavior without breaking the shared base-agent contract.

### 5. Multi-tenant concerns build on the base agent instead of replacing it

Provider access, tools, skills, and memory remain rooted in the base agent contract.

Multi-tenant behavior should be expressed by:

- tenant-scoped profile/config resolution
- persona layer composition
- tenant-aware tool/provider context
- swarm coordination policy

It should not require a separate incompatible agent interface.

## Consequences

### Positive

- The runtime model now matches normal TypeScript/OOP expectations
- LocalHost becomes a meaningful first-class implementation, not just a fallback mode
- Swarm remains additive and inherits real behavior instead of duplicating it
- Persona layering can expand independently of the base runtime contract
- Factory hints remain available without dominating the design

### Negative

- The docs must now distinguish between inheritance, topology hints, and persona layering
- Some earlier mode/type framing becomes historical rather than current
- The implementation will need a clean factory/composition boundary to avoid ad hoc instantiation

### Operational Rule

New swarm implementation work should prefer:

- overridden methods
- shared interfaces
- layered persona/context composition

and should use flags only where they help construction, persistence, or infrastructure wiring.
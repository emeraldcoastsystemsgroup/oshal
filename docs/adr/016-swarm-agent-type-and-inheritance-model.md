# ADR-016: Swarm Agent Type and Inheritance Model

## Status
Accepted

## Context

The OSHAL swarm transition uncovered an important ambiguity around the word **inheritance**.

There are at least three different inheritance concepts in play:

1. **Context inheritance** — future sessions inherit a compressed project summary instead of replaying all historical documents.
2. **Configuration inheritance** — a new bot/profile can start from an existing bot's provider, tools, persona, and then override selected values.
3. **Runtime/code inheritance** — a swarm bot should inherit normal bot behavior and extend it with coordination, delegation, and routing logic.

The user expectation is the coder-facing one: a swarm bot should not be a completely separate model. It should be a specialized bot type that extends the normal bot implementation.

The previous inheritance-pack work solved the **context inheritance** problem, but it did not yet make the **runtime inheritance** model explicit enough.

## Decision

We will model swarm behavior as an **agent specialization**, not as a disconnected parallel runtime.

### 1. Keep platform enablement separate from bot identity

The platform keeps a runtime-level flag:

- `SWARM_MODE=single | swarm`

This flag answers:

- is swarm orchestration enabled in this runtime?

It does **not** by itself determine what kind of bot a specific agent instance is.

### 2. Every bot/profile gets an explicit mode/type contract

Each bot must carry its own runtime identity:

```ts
type AgentMode = 'single' | 'swarm'

type AgentType =
  | 'standard'
  | 'swarm-coordinator'
  | 'swarm-worker'
  | 'specialist'
  | 'noop'

interface AgentProfile {
  id: string
  mode: AgentMode
  agentType: AgentType
  inheritsFromAgentId?: string
  providerProfileId: string
  enabledToolIds: string[]
  systemPrompt: string
  swarmConfig?: AgentSwarmConfig
}
```

This is the practical answer to: **"is this bot a swarm bot?"**

### 3. Runtime class hierarchy must be coder-friendly

The runtime inheritance model is:

```text
BaseAgent
  ├── StandardAgent
  │     └── SwarmAgent
  │           ├── AnyBotSwarmAgent
  │           ├── DevOpsSwarmAgent
  │           └── CustomSwarmAgent
  └── NoopAgent
```

This means:

- `BaseAgent` owns shared lifecycle, provider, tool, profile, and prompt infrastructure
- `StandardAgent` owns normal single-bot behavior
- `SwarmAgent` inherits all standard behavior first, then adds delegation, routing, and worker coordination

### 4. Use configuration inheritance separately from class inheritance

If a new swarm bot wants to reuse an existing bot configuration, it should do so through profile inheritance:

- `inheritsFromAgentId`

This allows a swarm bot to begin from a standard bot's prompt/tools/provider setup while still being instantiated as a swarm-capable runtime class.

### 5. Agent creation must go through a factory/composition boundary

The system must create agents from profile data through an explicit factory or composition-root decision:

```ts
function createAgent(profile: AgentProfile): IAgent {
  switch (profile.agentType) {
    case 'swarm-coordinator':
      return new SwarmAgent(profile)
    case 'noop':
      return new NoopAgent(profile)
    default:
      return new StandardAgent(profile)
  }
}
```

This keeps the runtime honest:

- the platform flag enables swarm features
- the profile decides what the bot is
- the factory decides what class gets instantiated

### 6. Do not reduce this to a lone boolean

`isSwarm: boolean` is acceptable only as a temporary migration aid.

The durable model should use `mode` and `agentType`, because the system is expected to grow beyond a single true/false distinction.

## Consequences

### Positive

- The runtime model now matches how developers think about inheritance
- Swarm behavior is additive, not a replacement for the standard bot
- Standard and swarm agents can share provider, tool, and prompt infrastructure
- Profile inheritance and class inheritance are separated cleanly
- Future worker/specialist roles fit naturally without redesigning the model

### Negative

- There are now two related but distinct flags to understand: platform runtime mode and bot mode/type
- Agent creation needs a factory/composition layer instead of ad hoc instantiation
- Migration code may temporarily need adapters while older profile shapes still exist

### Operational Rule

Any new swarm implementation work must align with this hierarchy:

- `BaseAgent -> StandardAgent -> SwarmAgent`

If a future design deviates from that, it must be documented in a superseding ADR.
# OSHAL Sales Deck Outline

## Slide 1: OSHAL

**Title:** OSHAL: A Live Swarm Application Framework

**Subtitle:** Build agent-backed applications where tools, agents, workflows, and UI surfaces can expand at runtime.

Speaker note:

"OSHAL is the control plane for running agent swarms as application infrastructure."

## Slide 2: The Problem

Teams can build impressive agent demos, but production falls apart when they need:

- Multiple specialized agents.
- Tool permissions per agent.
- Runtime observability.
- Workflow lifecycle.
- Containerized execution.
- App packaging.
- Repeatable validation.

Speaker note:

"The gap is not prompting. The gap is runtime."

## Slide 3: The OSHAL Answer

OSHAL provides:

- Swarm application manifests.
- Dynamic tool registry.
- Agent factory API.
- Bot-node runtime containers.
- Redis mesh communication.
- Runtime heartbeat registry.
- Cockpit and operator surfaces.
- Docker and Kubernetes deployment paths.

Speaker note:

"OSHAL treats agents like live platform resources, not hardcoded helpers."

## Slide 4: Framework Contract

A swarm app can declare:

- Bots.
- Tools.
- UI ribbon entries.
- Route ownership.
- Workflow routing.
- Runtime configuration.
- Lifecycle status.

Speaker note:

"A domain app is configuration first. The platform loads it, gates it, and wires it into the swarm."

## Slide 5: Runtime Expansion

Validated flow:

1. Register tool.
2. Create agent.
3. Assign tool.
4. Generate persona.
5. Launch bot container.
6. Publish heartbeat.
7. Appear in registry.
8. Subscribe to mesh.
9. Cleanly remove artifacts.

Speaker note:

"This is the live expansion loop. It is the difference between a starter repo and a framework."

## Slide 6: Benchmark Proof

Latest aggressive pass:

- 18 runtime tools.
- 18 dynamic agents.
- 18 dynamic bot containers.
- All healthy.
- All heartbeating.
- All registry-visible.
- All mesh-subscribed.
- Completed in about 52 seconds.
- Cleanup left zero residue.

Speaker note:

"The demo claim is repeatable and measurable."

## Slide 7: Why It Is Different

OSHAL is not:

- A single chatbot.
- A wrapper around one model.
- A static workflow demo.
- A collection of untracked scripts.

OSHAL is:

- A control plane.
- A runtime mesh.
- A configurable app framework.
- A bot-node execution layer.
- A benchmarkable platform.

## Slide 8: Use Cases

Strong initial use cases:

- Engineering delivery swarms.
- Incident response and RCA.
- Internal automation tools.
- Domain-specific copilots.
- Education/workflow apps.
- Enterprise agent sandboxes.

## Slide 9: Current Status

Ready:

- Swarm apps framework.
- Runtime tool registration.
- Dynamic agent creation.
- Dynamic bot launch.
- Registry and mesh discovery.
- Repeatable live Docker benchmark.

In progress:

- One-call create-and-launch.
- Workflow Studio publish-to-runtime.
- Full LLM task-completion benchmark.
- Generic node-pool hot-loading.
- Remote client production proof.

## Slide 10: Close

**Claim:** OSHAL makes agent swarms operational.

**Demo line:** "We can insert 18 new tool-backed bot capacities into a live swarm in about 52 seconds and prove it from API to Redis to Docker."

**Ask:** Benchmark the platform on a real task workload with valid model credentials.

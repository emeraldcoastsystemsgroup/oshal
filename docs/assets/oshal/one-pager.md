# OSHAL One-Pager

## One-Line Pitch

OSHAL is a live swarm application framework for building agent-backed systems where apps, tools, agents, workflows, and UI surfaces can be configured and expanded at runtime.

## What It Does

OSHAL turns an operator request into coordinated work across a containerized swarm of specialist agents. It provides the control plane, app framework, tool registry, runtime bot insertion path, Redis mesh, and operational cockpit needed to build real agent applications instead of one-off demos.

## Why It Matters

Most agent systems are either a single chatbot with tools or a brittle pile of scripts. OSHAL is different: it treats agents as runtime infrastructure.

With OSHAL, a team can:

- Package a domain application as a manifest.
- Register new executable tools without rebuilding the platform.
- Create new agents from an API.
- Launch new bot-node containers into a running swarm.
- Watch new bots publish live heartbeats and routing metadata.
- Route work over Redis mesh with observable lifecycle state.
- Gate app routes, UI, tools, and bot activation from framework config.

## Validated Proof

The dynamic insertion path has been validated against the local Docker swarm:

- Runtime CLI tools registered through `/api/tools/runtime/register`.
- Dynamic agents created through `/api/swarm/agents`.
- Per-agent tool assignments persisted with `authMode=auto`.
- Persona YAML generated into the host-mounted persona directory.
- `/api/agents/:agentId/launch` generated dynamic Docker Compose services.
- Dynamic bot containers launched from `oshal-bot:latest`.
- Bot health endpoints returned OK.
- Redis heartbeats included role, capabilities, and internal endpoint.
- `/api/swarm/bots/registry` reflected the dynamic bots.
- Bot-node workers subscribed to direct, alias, broadcast, and capabilities mesh channels.
- Cleanup removed all test agents, tools, runtime executors, containers, persona files, mesh keys, and compose overlays.

The aggressive validation pass launched 18 dynamic tools and 18 dynamic bot containers in one run. All 18 were healthy and discoverable in about 52 seconds.

## Product Shape

OSHAL has four main surfaces:

- **Framework:** swarm application manifests, route gates, UI registration, workflow registration, bot lifecycle.
- **Runtime:** bot-node containers, Redis mesh, heartbeats, dynamic compose insertion.
- **Tools:** registry metadata, per-agent auth modes, runtime executor descriptors.
- **Operations:** cockpit, app list, health, status, and traceable lifecycle state.

## Who It Is For

- Platform teams building internal agent applications.
- AI engineering teams that need multi-agent execution with observability.
- Enterprises that need configurable agents and tools without hardcoding every domain.
- Demo-to-production teams that need the jump from "agent script" to "agent runtime."

## Honest Status

Ready to benchmark:

- Dynamic runtime tool registration.
- Dynamic agent creation.
- Dynamic bot container launch.
- Registry and mesh discovery.
- Repeatable live Docker validation.

Still future work:

- One-call create-and-start transaction.
- Workflow Studio publish-to-runtime.
- Generic node-pool hot-loading.
- Remote Cline/client production proof.
- Full LLM task-completion benchmark with valid model credentials.

## Demo Line

"Watch this: we register 18 tools, create 18 new agents, launch 18 new bot containers, and the swarm discovers them live in about 52 seconds."

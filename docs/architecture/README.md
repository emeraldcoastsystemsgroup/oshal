# Architecture Index

## Purpose

This folder collects architecture documents that explain OSHAL using the same control-plane and feature-flow framing used in the old any-bot runtime.

The guiding model is:
- OSHAL is the control plane and runtime shell
- the agent adapter executes inside that shell
- tools, MCP, RAG, memory, and personalization are framework-governed capabilities
- UI surfaces expose and persist that capability state

## Current Documents

### Core Runtime
- [platform-shared-services.md](./platform-shared-services.md)
  - as-built reference for the cross-cutting services every app rides on (budgets, connector write-actions, global search, LLM-judge, persona-evals, notifications, data export/delete, queue DLQ, bot-node auth, run tracing) from the 2026-07 gap-list build
- [core-runtime-overview.md](./core-runtime-overview.md)
  - fastest architecture read for reviewers who only need the core runtime
- [OSHAL-agent-runtime-design-and-implementation-plan.md](./OSHAL-agent-runtime-design-and-implementation-plan.md)
  - full target runtime design and corrected responsibility boundary

### Layer Architecture
- [layer0-provider-framework.md](./layer0-provider-framework.md)
  - provider config, model selection, secrets, and runtime provider resolution
- [layer1-tools-framework.md](./layer1-tools-framework.md)
  - tool registry, switch framework, selector composition, and verification
- [dynamic-bot-tool-runtime-plan.md](./dynamic-bot-tool-runtime-plan.md)
  - detailed implementation plan for dynamic tool registration, dynamic bot registration, schema-driven `/config/`, and switch-framework/runtime parity
- [deployable-agent-contract.md](./deployable-agent-contract.md)
  - canonical definition of done for new agents
  - covers routing, runtime path, config, knowledge, smoke tests, and operator handoff

### Swarm Orchestration
- [complex-ticket-reference-executive-summary.md](./complex-ticket-reference-executive-summary.md)
  - plain-English answer to: what the legacy sibling does better, what OSHAL does better, and what to fix first
  - best first read if you want the comparison without the dense process maps
- [swarm-processing-design-contract.md](./swarm-processing-design-contract.md)
  - current authoritative swarm-processing contract
  - defines the functional, technical, and architectural rules the code is expected to meet
  - **updated 2026-03-21:** now includes complex-ticket governance contract, role responsibilities, mandatory parity targets, and target process flow
- [swarm-orchestration-process-flow.md](./swarm-orchestration-process-flow.md)
  - canonical swarm architecture rules, process flow diagrams, API surface, agent roster, and adapter pattern
  - covers both direct ticket submission and Plane intake paths through the current 7-phase pipeline
  - **updated 2026-03-21:** now includes target complex-ticket lifecycle with multi-round governance, regression flows, handover flows, queue-manager background path, and target API/database additions
- [linkedin-content-swarm-workflow.md](./linkedin-content-swarm-workflow.md)
  - target queue-backed LinkedIn content workflow using mesh handoffs to email, research, drafting, approval, and publishing agents
- [complex-ticket-process-ascii.md](./complex-ticket-process-ascii.md)
  - current OSHAL complex-ticket baseline through the queue-manager-driven path
  - focuses on workspace seeding, 7 phases, prompt composition, and files written today
- [reference-sibling-complex-ticket-process-ascii.md](./reference-sibling-complex-ticket-process-ascii.md)
  - reference map of the stronger legacy sibling queue-manager process
  - captures the richer governance shell: rounds, handovers, approvals, circuit breakers, and parent assembly
- [complex-ticket-reference-gap-plan.md](./complex-ticket-reference-gap-plan.md)
  - direct comparison of current OSHAL versus the reference process
  - staged improvement plan for bringing OSHAL closer to reference-grade process robustness
- [multi-week-build-readiness-plan.md](./multi-week-build-readiness-plan.md)
  - focused plan for moving from strong ticket execution to multi-week product delivery
  - centers on research-first planning, persistent program state, milestone tracking, and built-product completion
- [swarm-execution-pipeline.md](./swarm-execution-pipeline.md)
  - the as-built swarm execution pipeline, verified against live E2E tickets
- [swarm-subsystems.md](./swarm-subsystems.md)
  - deep reference for the swarm subsystems; companion to swarm-execution-pipeline.md
- [swarm-pipeline-architecture.md](./swarm-pipeline-architecture.md)
  - pipeline architecture diagrams (Session 18 era)
- [swarm-container-topology.md](./swarm-container-topology.md)
  - container topology for the swarm runtime
- [ticket-workspace-and-routing-contract.md](./ticket-workspace-and-routing-contract.md)
  - the two runtime contracts operators must be able to trust: ticket workspaces and routing
- [knowledge-owner-routing-config-checklist.md](./knowledge-owner-routing-config-checklist.md)
  - execution checklist for ADR-083 (route Jarvis tasks via the queue manager's bid call-out to
    knowledge owners); 16-bot readiness matrix + per-phase config actions (online / tools / declarations)
- [jarvis-architecture-and-flow.md](./jarvis-architecture-and-flow.md)
  - the as-built Jarvis picture with Mermaid diagrams: component architecture, one-turn sequence
    (converse vs file-one-ticket), the ADR-083 call-out routing lanes, durable bot-node result
    delivery, delayed-work-only typed visual materialization/Discussion replay, mobile response
    containment, ambient listening boundaries, and the knowledge-owner roster
- [jarvis-native-background-wake.md](./jarvis-native-background-wake.md)
  - the as-built Windows OSHAL Node wake-only companion: exact local grammar, microphone ownership,
    short-lived OIDC Jarvis handoff, privacy invariants, verification, and the still-open signing,
    physical-device, macOS, and Linux release work

#### Jarvis release-evidence cutoff (2026-07-11)

- The final automated baseline is 219 passing Vitest tests across 18 suites and 29 passing
  Playwright tests across the three Jarvis rich-response, response-stage, and audio-lifecycle files.
- The phone-width browser checks include a `320x568` reply with a long unbroken token and an equally
  hostile visual caption. Neither grows the document, clips past its response container, shifts the
  controls, or changes page scroll height when the reply arrives.
- The OSHAL Node package build and Windows in-memory wake-grammar smoke passed. That smoke uses
  synthesized audio; it does not open or validate a physical microphone.
- Provider-intent routing is a bounded weather/priority-inbox phrase guard, not a general semantic
  router. Redacted live runs passed both a named-US-location request and “weather where I live” →
  bounded city clarification/follow-up → weather worker → trusted NWS record → fact-locked SVG →
  plain-yes reveal/Discussion replay, including owner-only artifact reads. Unsupported locations and
  unrecognized paraphrases retain the normal handoff/model behavior.
- Gmail reads are bounded to `newer_than:1d`, at most 25 messages, and at most six priority rows in
  the visual summary. No seeded OSHAL Gmail worker-to-visual E2E has been completed.
- Physical assistive-technology, device/microphone, Windows signing/SmartScreen, and speaker
  calibration remain manual/open gates. Provider records cross a trusted control-plane boundary;
  they are not cryptographic attestations from NWS or Gmail.

### Current Update Slice
- [chat-agent-profile-runtime-architecture.md](./chat-agent-profile-runtime-architecture.md)
  - exact architecture for the new dedicated chat-agent profile persistence path
  - how the update affects `/chat`, selector composition, prompt assembly, and startup manifest generation
- [end-to-end-runtime-architecture.md](./end-to-end-runtime-architecture.md)
  - full runtime path from UI -> control plane -> persistence -> session artifacts -> Cline-backed execution
  - ties together provider, tools, MCP, memory, RAG, and agent-profile flow in any-bot-style control-plane language
- [operator-runtime-view.md](./operator-runtime-view.md)
  - shortest operator-facing architecture document
  - explains the main moving parts, persisted data, and failure lookup points
- [deployment-runtime-topology.md](./deployment-runtime-topology.md)
  - Docker Compose and Kubernetes deployment/runtime topology
  - includes the deploy-ready testing checklist for runtime verification
- [remote-client-architecture.md](./remote-client-architecture.md)
  - endpoint-side remote client that runs a local MCP server on a PC or Mac
  - describes the Headscale + A2A + local MCP bridge used for remote endpoint control

### Feature & Data-Plane Architecture

- [platform-capability-flows.md](./platform-capability-flows.md)
  - code-backed Mermaid maps for ticket/DLQ lifecycle, Workflow Studio, remote nodes, connectors, A2A, diarization, security/ops, and scheduling, with explicit validation boundaries
- [alert-triage-and-consolidation-spec.md](./alert-triage-and-consolidation-spec.md)
  - functional SPEC (target, not as-built): noise gate → consolidation → bundling → dispatch gates
    for the intelligent-processing self-healing intake, mined from the retired SRE platform's
    production-proven behavior and its documented traps (ADR-069 §2a source); done-when in BACKLOG
- [connectors-and-graph-architecture.md](./connectors-and-graph-architecture.md)
  - connector runtime + personal knowledge graph architecture
- [connectors-tenant-isolation.md](./connectors-tenant-isolation.md)
  - connectors hub and per-user token isolation (as-built)
- [model-gateway.md](./model-gateway.md)
  - LLM model-gateway governance layer
- [human-in-the-loop.md](./human-in-the-loop.md)
  - approval gates plus super-admin / dev access
- [personal-data-change-impact.md](./personal-data-change-impact.md)
  - personal-data schema + ticketed broker change impact (ADR-056/057)
- [admin-console.md](./admin-console.md)
  - admin console surface and contracts
- [edge-agent-architecture.md](./edge-agent-architecture.md)
  - the OSHAL edge bot-node (ADR-047): device-resident agent embedding Home Assistant Core
- [devops-cockpit-connectivity.md](./devops-cockpit-connectivity.md)
  - DevOps cockpit (ADR-040): Phase-1 Vault broker console (shipped) + the topology-discovery / node-deploy / specialist / connectivity-matrix design that identifies the connectivity choices per environment
- [workflow-studio-framework.md](./workflow-studio-framework.md)
  - Workflow Studio: design-time canvas + executable publish on the graph engine
- [token-chase-capture-and-debugger-spec.md](./token-chase-capture-and-debugger-spec.md)
  - Token Chase capture + debugger build spec (first shippable slice of ADR-046)
- [spatial-mapping-pose-persistence.md](./spatial-mapping-pose-persistence.md)
  - ADR-111 follow-on: pose persistence (increment A) + RF coverage overlay (increment B) SHIPPED per
    this spec; drone relocalization still forward-looking. Research-verified formats, frames, and
    honesty guardrails
- [spatial-capture-playbook.md](./spatial-capture-playbook.md)
  - make a 3D map with the gear you have: the import lane (iPhone/iPad LiDAR, depth cameras, drone →
    `.ply`/`.splat`, no GPU) vs the reconstruct lane (video→3DGS), per-device steps + honest caveats
- [kernel-vs-app-packages.md](./kernel-vs-app-packages.md)
  - what is Tier-0 kernel (always-on: 4 DBs + Redis + Vault + code-server + diarization + the
    controller/API + 19 default bots) vs. what a Tier-2 app package declares; the cross-app
    ref-counted `dependencies.apps` rule vs. kernel-skill `uses[]`; known manifest violations to
    fix; and the anti-drift checklist so core DBs/queue/default bots are never declared as app
    dependencies and no "minimal" swarm gets invented (ADR-085/036/038)
- [platform-feature-catalog.md](./platform-feature-catalog.md)
  - the platform feature catalog derived from codebase inspection, ADRs, and live validation
- [facebook-bot-credential-management.md](./facebook-bot-credential-management.md)
  - Facebook bot credential-management spec

### Plans & Historical (kept for context; see docs standard on as-built vs plan docs)

- [little-monsters-on-oshal-plan.md](./little-monsters-on-oshal-plan.md)
  - original Little Monsters sprint plan (as-built note at top points to current docs)
- [outcome-first-delivery-framework.md](./outcome-first-delivery-framework.md)
  - outcome-first triage framework for incoming work
- [phase-12-last-mile-project-plan.md](./phase-12-last-mile-project-plan.md)
  - phase-12 last-mile project plan

## Recommended Reading Order

1. `OSHAL-agent-runtime-design-and-implementation-plan.md`
2. `layer0-provider-framework.md`
3. `layer1-tools-framework.md`
4. `deployable-agent-contract.md`
5. `complex-ticket-reference-executive-summary.md`
6. `swarm-processing-design-contract.md`
7. `swarm-orchestration-process-flow.md`
8. `linkedin-content-swarm-workflow.md`
9. `complex-ticket-process-ascii.md`
10. `reference-sibling-complex-ticket-process-ascii.md`
11. `complex-ticket-reference-gap-plan.md`
12. `multi-week-build-readiness-plan.md`
13. `chat-agent-profile-runtime-architecture.md`
14. `end-to-end-runtime-architecture.md`
15. `operator-runtime-view.md`
16. `deployment-runtime-topology.md`
17. `remote-client-architecture.md`

The reading order is the core-runtime spine only; the sectioned index above is the complete
inventory (feature/data-plane and plan-era docs are deliberately not in the spine).

# OSHAL Implementation Fulfillment Ledger

## Purpose

This ledger records the framework work item by item, with the implementation path, execution path, proof, and remaining boundary.

Use it when someone asks what was actually built, what was only documented, and what still needs a later benchmark.

## Validation Snapshot

Latest validated run:

```text
date=2026-05-10
baseUrl=http://127.0.0.1:35457
command=DYNAMIC_INSERTION_COUNT=18 DYNAMIC_INSERTION_CONCURRENCY=3 npm run benchmark:dynamic-insertion
runId=20260510032043
result=PASS
durationMs=51845
```

Verified in that run:

- 18 runtime tools registered.
- 18 dynamic agents created.
- 18 persona files generated.
- 18 tool assignments persisted.
- 18 dynamic bot containers launched.
- 18 bot health endpoints returned OK.
- 18 Redis runtime heartbeats included role, capabilities, status, and internal endpoint.
- 18 registry entries were visible through `/api/swarm/bots/registry`.
- 18 bot-node containers showed direct ID, direct name, and `swarm.capabilities` mesh subscriptions.
- Cleanup left zero stress agents, tools, runtime executor rows, containers, compose overlays, persona files, or dynamic mesh keys.

Additional checks:

```text
node --check scripts/dynamic-insertion-benchmark.mjs
npm run typecheck
npm run test:framework-contracts
npx playwright test tests/dynamic-registration-framework.spec.ts --reporter=line
npx playwright test tests/remote-client-framework.spec.ts tests/workflow-runtime-boundary.spec.ts --reporter=line
```

All passed after the 18x validation. `npm run test:framework-contracts` reported `10 passed`.

## Gap Closure Snapshot

| Gap | Closed now | Remaining boundary |
|---|---|---|
| Dynamic tool and bot insertion | Yes. 18x Docker benchmark passed. | None for the benchmarked dynamic-compose path. |
| Framework contract tests | Yes. `npm run test:framework-contracts` passed with 10 tests. | Keep expanding as new framework contracts are added. |
| Workflow registration | Yes for manifest workflows, built-in override protection, and Workflow Studio **Publish** (compiles an authored canvas to a live caller-scoped workflow). | Only agentic NL authoring of brand-new agents remains. |
| Workflow Studio | Yes — design-time authoring/validation plus **Publish to runtime** (single-shot, staged, and branching/parallel graph). | Agentic authoring that composes brand-new agents from natural language remains future work. |
| Remote client | Yes for config, registry, heartbeat, task lifecycle, swarm-message queueing, and live stdio MCP task execution. | No real remote network/Headscale endpoint E2E is claimed yet. |
| Generic node pool | No. | Dynamic compose insertion is proven; always-on node-pool hot-loading remains future work. |
| Full LLM task benchmark | No. | Requires provider credentials and a defined task-completion workload. |
| Managed cluster benchmark | No. | Local Docker swarm is proven; managed Kubernetes still needs a fresh run. |

## Status Key

| Status | Meaning |
|---|---|
| Implemented and executed | Code exists and a live or automated validation was run. |
| Implemented, not freshly benchmarked | Code/docs exist, but this ledger does not claim a recent end-to-end production proof. |
| Documented boundary | The path is named clearly, but the feature remains future work or design-time only. |

## Item 1: Framework Shape And Documentation

Status: Implemented and executed for the dynamic insertion framework slice.

### Subitems Fulfilled

- OSHAL is documented as a framework, not just a starter repo.
- Swarm applications are described as manifest-packaged products.
- Runtime deployments are separated from app manifests.
- Operator benchmark assets exist for demo, sales, validation, and runbook use.

### Implementation

- `docs/framework-developer-guide.md`
- `docs/swarm-apps-framework.md`
- `docs/assets/oshal/README.md`
- `docs/assets/oshal/one-pager.md`
- `docs/assets/oshal/benchmark-brief-dynamic-insertion.md`
- `docs/assets/oshal/operator-benchmark-runbook.md`
- `docs/assets/oshal/demo-script.md`
- `docs/assets/oshal/messaging-kit.md`
- `docs/assets/oshal/sales-deck-outline.md`

### Execution Path

- Read the developer guide for how to add apps, tools, UI, workflows, agents, OIDC, and runtime deployments.
- Run the operator benchmark runbook to prove dynamic insertion.

### Proof

- 18x dynamic insertion benchmark passed on 2026-05-10.
- Documentation now names the validated claim and the boundaries.

## Item 2: Three Configuration Categories

Status: Implemented, not every deployment target freshly benchmarked.

### Subitems Fulfilled

- Product/app configuration exists through swarm app manifests.
- Local/core runtime configuration exists.
- Local swarm runtime configuration exists.
- Cluster/Kubernetes deployment files and docs exist.

### Implementation

- App manifests: `swarm-apps/*.yaml`
- Core runtime: `docker-compose.core.yml`
- Local swarm runtime: `docker-compose.oshal-local.yml`
- Platform/Kubernetes path: `ops/deployment/`
- Guide: `docs/framework-developer-guide.md`

### Execution Path

- Load an app manifest through `/api/swarm/apps/load`.
- Start the local swarm with `docker compose -f docker-compose.oshal-local.yml up -d`.
- Use Kubernetes deployment files for cluster installation.

### Proof

- Local swarm was running and used for the 18x benchmark.
- Cluster files are present, but this ledger does not claim a fresh cluster E2E.

### Boundary

- A single cluster environment matrix for Docker Desktop, kind/k3d, managed Kubernetes, and remote nodes is still needed.

## Item 3: Add Tools

Status: Implemented and executed.

### Subitems Fulfilled

- Runtime tool metadata can be registered by API.
- Runtime executor descriptors can be registered by API.
- CLI/API/MCP/builtin executor descriptor shapes are validated.
- Runtime executor descriptors persist in Postgres.
- Runtime executors restore into the in-memory registry.
- Runtime tools are exposed to the prompt resolver.
- Runtime CLI tools execute through `ToolExecutorService`.
- Manifest-owned tools can be declared under `tools[]`.

### Implementation

- `src/app/routes/tool-routes.ts`
- `src/features/tool-registry/services/runtime-tool-registration-service.ts`
- `src/features/tool-registry/services/dynamic-tool-executor-registry.ts`
- `src/features/chat-orchestration/services/tool-executor-service.ts`
- `src/app/composition/tool-runtime-context.ts`
- `src/features/swarm-apps/types.ts`
- `src/features/swarm-apps/services/swarm-app-service.ts`
- `scripts/migrations/023-runtime-tool-executors.sql`

### Execution Path

```bash
curl -X POST http://localhost:35457/api/tools/runtime/register \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": {
      "name": "my-cli-tool",
      "displayName": "My CLI Tool",
      "description": "Runs my CLI tool.",
      "category": "my-app",
      "defaultAuthMode": "auto"
    },
    "executor": {
      "executorType": "cli",
      "cliCommand": "node scripts/my-tool.js {input.message}"
    }
  }'
```

### Proof

- `tests/dynamic-registration-framework.spec.ts` covers runtime CLI execution, prompt exposure, and dynamic compose service generation.
- `npx playwright test tests/dynamic-registration-framework.spec.ts --reporter=line` reported `3 passed`.
- 18x benchmark registered and cleaned up 18 runtime tools.

## Item 4: Configure Clusters

Status: Implemented, not freshly benchmarked end to end.

### Subitems Fulfilled

- Core/local compose configuration exists.
- Local swarm compose configuration exists.
- Kubernetes deployment examples exist.
- Secret examples exist.
- Environment examples exist.

### Implementation

- `docker-compose.core.yml`
- `docker-compose.oshal-local.yml`
- `ops/deployment/docker-compose.platform.yml`
- `ops/deployment/kubernetes/oshal-stack.yaml`
- `ops/deployment/kubernetes/oshal-secrets.example.yaml`
- `ops/deployment/oshal-k8s.env.example`
- `ops/any-bot-k8s/secrets.example.yaml`

### Execution Path

- Local swarm benchmark path uses `docker-compose.oshal-local.yml`.
- Cluster path uses the files under `ops/deployment/`.

### Proof

- Local swarm was verified during the 18x benchmark.

### Boundary

- No fresh managed-cluster or remote-node benchmark is claimed here.

## Item 5: Dynamic Node Loading

Status: Implemented and executed for dynamic compose bot insertion; documented boundary for generic node-pool hot-loading.

### Subitems Fulfilled

- Agent creation is API-driven.
- Dynamic compose service generation exists.
- Dynamic bot containers launch from `oshal-bot:latest`.
- Dynamic bot containers run `BOT_RUNTIME=bot-node`.
- Dynamic bots join the `oshal` network.
- Dynamic bots mount persona, workspace, and config paths.
- Dynamic bots publish Redis runtime heartbeat metadata.
- Dynamic bots subscribe to mesh channels.

### Implementation

- `src/features/agent-management/services/dynamic-compose-service.ts`
- `src/app/bot-node-server.ts`
- `src/app/routes/agent-management-routes.ts`
- `tests/dynamic-agent-live-e2e.spec.ts`
- `scripts/dynamic-insertion-benchmark.mjs`

### Execution Path

```bash
curl -X POST http://localhost:35457/api/swarm/agents ...
curl -X POST http://localhost:35457/api/agents/<agent-id>/launch
```

### Proof

- 18x benchmark launched 18 dynamic bot containers and verified health, Redis heartbeats, registry visibility, and mesh subscriptions.
- `tests/dynamic-registration-framework.spec.ts` verified dynamic compose service generation uses bot-node worker wiring.

### Boundary

- Generic always-running node-pool hot-loading is not the default runtime yet.
- The current proven insertion model is dynamic compose service creation plus container launch.

## Item 6: Create And Register A Workflow

Status: Implemented and executed for manifest-driven workflow registration and Workflow Studio publish-to-runtime (single-shot, staged, and branching/parallel graph compiled to a live queue).

### Subitems Fulfilled

- App manifests can declare `ticketType`.
- App manifests can declare `workflow`.
- App workflows register into `WorkflowPipelineRegistry`.
- Built-in workflow ticket types cannot be overridden by apps.
- App workflows unregister when apps deactivate or unload.

### Implementation

- `src/features/swarm-apps/types.ts`
- `src/features/swarm-apps/services/swarm-app-service.ts`
- `src/features/swarm-orchestration/services/workflow-pipeline-registry.ts`
- `docs/framework-developer-guide.md`

### Execution Path

Add this to a manifest:

```yaml
ticketType: my-ticket-type
workflow:
  name: My Workflow
  pipeline: my-single-worker
  workerBot: my-worker
  phases:
    - intake
    - execute
    - deliver
```

Then load the manifest:

```bash
curl -X POST http://localhost:35457/api/swarm/apps/load \
  -H 'Content-Type: application/json' \
  -d '{"path":"swarm-apps/my-app.yaml"}'
```

### Proof

- `tests/workflow-runtime-boundary.spec.ts` verifies that manifest workflows register with `WorkflowPipelineRegistry`.
- `tests/workflow-runtime-boundary.spec.ts` verifies built-in ticket types cannot be overridden by app workflows.
- `tests/workflow-runtime-boundary.spec.ts` verifies Workflow Studio compile previews stay `design_time_only`.
- Typecheck passed with the app workflow registration code.

### Boundary

- Workflow Studio Publish is live (single-shot, staged, branching/parallel graph); the remaining boundary is agentic authoring that composes brand-new agents from natural language.

## Item 7: Configure OIDC And Dev Bypass

Status: Implemented, not freshly benchmarked end to end.

### Subitems Fulfilled

- Real OIDC mode is configured through Keycloak env vars.
- Local development bypass exists through `MOCK_OIDC=true`.
- Session secret behavior is documented.
- Middleware has explicit mock vs real OIDC behavior.

### Implementation

- `src/shared/middleware/oidc.ts`
- `.env.example`
- `docker-compose.core.yml`
- `ops/deployment/oshal-k8s.env.example`
- `docs/adr/008-mock-oidc-development-mode.md`
- `docs/framework-developer-guide.md`

### Execution Path

Real OIDC:

```bash
MOCK_OIDC=false
KEYCLOAK_URL=http://keycloak:8080
KEYCLOAK_REALM=oshal
KEYCLOAK_CLIENT_ID=oshal-swarm
SESSION_SECRET=<long-random-secret>
```

Development bypass:

```bash
MOCK_OIDC=true
```

### Proof

- Typecheck passed.

### Boundary

- No fresh browser login/OIDC provider E2E is claimed in this ledger.

## Item 8: Add A UI Element

Status: Implemented, not freshly benchmarked through browser UI in this ledger.

### Subitems Fulfilled

- Static cockpit ribbon entries can come from app manifests.
- Dynamic per-row ribbon entries can come from app manifests.
- App profile synthesis supports focused app UI.
- Dynamic tool UI registration and deregistration exists.
- Unsafe dynamic UI SQL source and where clauses are constrained.

### Implementation

- `src/features/swarm-apps/types.ts`
- `src/features/swarm-apps/services/swarm-app-service.ts`
- `src/app/routes/tool-routes.ts`
- `src/pages/applications/index.html`
- `docs/framework-developer-guide.md`

### Execution Path

Static UI:

```yaml
ui:
  static:
    - toolName: my-dashboard
      label: Dashboard
      icon: codicon-dashboard
      iframeUrl: /my-app/dashboard
      section: top
```

Dynamic row UI:

```yaml
ui:
  dynamic:
    source: classes
    where: "status = 'active'"
    toolNameTemplate: "class-{class_id_prefix}"
    labelField: name
    icon: codicon-book
    iframeUrlTemplate: "/education/classes/{class_id}"
    section: top
```

### Proof

- Typecheck passed.

### Boundary

- This ledger does not claim a fresh Playwright screenshot/browser validation for new UI surfaces.

## Item 9: Add An Agent

Status: Implemented and executed.

### Subitems Fulfilled

- Manifest-owned agents are supported through `bots[]`.
- Runtime dynamic agents are supported through `POST /api/swarm/agents`.
- Tool assignments are accepted during dynamic agent creation.
- Persona YAML files are generated for dynamic agents.
- Dynamic agents can be launched into containers.

### Implementation

- `src/features/swarm-apps/services/swarm-app-service.ts`
- `src/features/swarm-apps/types.ts`
- `src/app/routes/agent-management-routes.ts`
- `src/features/agent-management/services/dynamic-compose-service.ts`
- `tests/dynamic-agent-live-e2e.spec.ts`
- `scripts/dynamic-insertion-benchmark.mjs`

### Execution Path

```bash
curl -X POST http://localhost:35457/api/swarm/agents \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "my-worker",
    "systemPrompt": "You are a focused worker.",
    "role": "Domain Worker",
    "topology": "swarm",
    "capabilities": ["my-domain"],
    "routingKeywords": ["my-domain"],
    "toolAssignments": []
  }'
```

Then launch:

```bash
curl -X POST http://localhost:35457/api/agents/<agent-id>/launch
```

### Proof

- 18x benchmark created and launched 18 dynamic agents.

## Item 10: Workflow Designer

Status: Implemented and executed for design-time authoring/validation plus runtime **Publish** (single-shot, staged, and branching/parallel graph compiled to a live workflow).

### Subitems Fulfilled

- Workflow Studio route exists.
- Visual authoring exists.
- Node palette, graph editing, validation, version history, compile preview, JSON export, and live agent roster compatibility notes are documented.

### Implementation

- `docs/architecture/workflow-studio-framework.md`
- `/workflow-studio/`
- `/api/workflow-studio/*`

### Execution Path

- Use `/workflow-studio/` to author a graph, then **Publish** it to a live runtime workflow (`POST /api/swarm/apps/publish`).

### Proof

- `tests/workflow-runtime-boundary.spec.ts` verifies the seeded design compiles to current runtime bindings without taking execution ownership.
- Typecheck passed for the repo.

### Boundary

- Publish is live (single-shot, staged, and branching/parallel graph); agentic authoring that composes brand-new agents from natural language remains future work.

## Item 11: Existing Agents And Bot Runtime

Status: Implemented and executed for bot-node runtime.

### Subitems Fulfilled

- Static swarm bots run as bot-node containers.
- Dynamic bots run as bot-node containers.
- Bot-node runtime resolves identity from env/persona.
- Bot-node runtime initializes AnyBot/Cline/Claude provider surfaces where available.
- Bot-node runtime publishes heartbeats.
- Bot-node runtime subscribes to direct, alias, broadcast, and capability mesh channels.

### Implementation

- `src/app/bot-node-server.ts`
- `src/app/bot-node-execution-handler.ts`
- `src/app/extensions/swarm/swarm-bot-registry.ts`
- `src/features/agent-management/`
- `any-bot/`

### Execution Path

- Static bots start from `docker-compose.oshal-local.yml`.
- Dynamic bots start from `/api/agents/:agentId/launch`.

### Proof

- 18x benchmark proved dynamic bot-node startup, health, heartbeat, registry, and mesh subscriptions.

## Item 12: AnyBot Incorporation

Status: Implemented, not fully unified as a clean product boundary.

### Subitems Fulfilled

- `any-bot/` runtime code remains incorporated.
- Bot-node server initializes AnyBot task, message, checkpoint, tool, stream, and agentic controller surfaces.
- Cline and Claude Code provider hooks are present when credentials/runtime are available.

### Implementation

- `any-bot/`
- `src/app/bot-node-server.ts`
- `src/app/bot-node-execution-handler.ts`

### Execution Path

- Bot-node runtime loads AnyBot modules during startup.

### Proof

- Dynamic bot containers reached healthy status and published runtime metadata.

### Boundary

- A single canonical AnyBot runtime wrapper guide is still needed.
- Full parity between old AnyBot surfaces and OSHAL tool/provider registries is not claimed here.

## Item 13: Remote Cline / Remote Client

Status: Implemented and regression-tested for config, registry, task lifecycle, heartbeat, swarm-message queueing, and live stdio MCP task execution.

### Subitems Fulfilled

- Remote client feature code exists.
- Remote client routes exist.
- Remote client script exists.
- Architecture documentation exists.

### Implementation

- `src/features/remote-client/`
- `src/app/routes/remote-client-routes.ts`
- `scripts/remote-client.ts`
- `docs/architecture/remote-client-architecture.md`

### Execution Path

- Use remote client routes and script according to the architecture guide.

### Proof

- `tests/remote-client-framework.spec.ts` verifies env configuration loading.
- `tests/remote-client-framework.spec.ts` verifies remote endpoint registration as a swarm-visible agent.
- `tests/remote-client-framework.spec.ts` verifies task queue, claim, complete, and fail lifecycle.
- `tests/remote-client-framework.spec.ts` verifies heartbeat state and inbound swarm-message queueing.
- `tests/remote-client-live-mcp-e2e.spec.ts` starts an actual stdio MCP child process, registers it through a control-plane shim, executes a queued `mcp.call-tool` task, posts the completion result, and verifies heartbeat tool count.
- Typecheck passed.

### Boundary

- No fresh production-grade remote Cline/client E2E across a real remote network or Headscale endpoint is claimed in this ledger.

## Item 14: Dynamic Bot Creation With Dynamic Bot Insertion

Status: Implemented and executed.

### Subitems Fulfilled

- Dynamic tool registration.
- Dynamic agent creation.
- Tool assignment persistence.
- Persona YAML generation.
- Dynamic compose generation.
- Dynamic container launch.
- Bot health verification.
- Redis heartbeat verification.
- Registry overlay verification.
- Mesh subscription verification.
- Cleanup verification.

### Implementation

- `scripts/dynamic-insertion-benchmark.mjs`
- `tests/dynamic-agent-live-e2e.spec.ts`
- `src/app/routes/tool-routes.ts`
- `src/features/tool-registry/services/runtime-tool-registration-service.ts`
- `src/features/agent-management/services/dynamic-compose-service.ts`
- `src/app/bot-node-server.ts`

### Execution Path

```bash
OSHAL_E2E_BASE_URL=http://127.0.0.1:35457 \
DYNAMIC_INSERTION_COUNT=18 \
DYNAMIC_INSERTION_CONCURRENCY=3 \
npm run benchmark:dynamic-insertion
```

### Proof

```text
PASS register runtime tools - 18 tools registered
PASS create dynamic agents with tool assignments
PASS verify persona files and tool assignments - 18 personas and assignments verified
PASS launch dynamic containers - 18 launch calls returned success
PASS verify containers running and healthy - 18 containers healthy
PASS verify Redis heartbeats with routing metadata - 18 heartbeats profile-backed
PASS verify registry overlay and mesh subscriptions - 18 registry entries and mesh subscriptions verified
PASS cleanup completed
```

## Item 15: Benchmark Harness

Status: Implemented and executed.

### Subitems Fulfilled

- Repeatable benchmark script exists.
- Count cap supports 18 by default.
- Bounded concurrency exists.
- API request timeout exists.
- Registry fetch retry exists.
- Registry overlay wait exists.
- Mesh subscription wait exists.
- Debug log limit exists.
- Cleanup is automatic unless artifacts are explicitly kept.

### Implementation

- `scripts/dynamic-insertion-benchmark.mjs`
- `package.json` script: `benchmark:dynamic-insertion`

### Execution Path

```bash
npm run benchmark:dynamic-insertion
```

Useful environment variables:

```text
DYNAMIC_INSERTION_COUNT=1..18
DYNAMIC_INSERTION_CONCURRENCY=1..18
DYNAMIC_INSERTION_MAX_COUNT=18
DYNAMIC_INSERTION_REQUEST_TIMEOUT_MS=30000
DYNAMIC_INSERTION_REQUEST_RETRY_ATTEMPTS=6
DYNAMIC_INSERTION_REQUEST_RETRY_DELAY_MS=2000
DYNAMIC_INSERTION_DEBUG_LOG_LIMIT=3
KEEP_DYNAMIC_AGENT_ARTIFACTS=true
ALLOW_EXISTING_DYNAMIC_COMPOSE=true
```

### Proof

- 18x benchmark passed.
- Post-run cleanup verification passed.

## Final Claim

The implemented and executed claim is:

> OSHAL is a benchmarked swarm application framework for dynamic runtime tool registration, dynamic agent creation, dynamic bot-node insertion, registry discovery, Redis mesh subscription, and clean lifecycle removal.

The claims not made yet are:

- Full LLM task-completion benchmark.
- Workflow Studio publish-to-runtime.
- Generic node-pool hot-loading as the default runtime.
- Fresh production-grade remote Cline/client benchmark across a real remote network or Headscale endpoint.
- Fresh managed Kubernetes cluster benchmark.

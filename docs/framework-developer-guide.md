# OSHAL Framework Developer Guide

## Purpose

OSHAL is now a framework for building swarm-backed applications, not only a jump-start repository.

The framework lets a builder compose an application from:

- a manifest in `swarm-apps/`
- bot identities in `ai-lab/bot-personas/`
- registered tools and per-agent tool switches
- workflow routing through ticket types
- cockpit ribbon UI entries
- optional runtime config schemas
- Compose or Kubernetes deployment profiles

This guide is the practical map for adding to the framework without having to reconstruct the rules from ADRs, old handoff notes, or chat history.

## The Framework Contract

The main unit of application packaging is a swarm application manifest:

```text
swarm-apps/<app-name>.yaml
```

A manifest can declare:

- `bots[]`: agent identities the app contributes
- `ui.static[]`: fixed cockpit ribbon entries
- `ui.dynamic`: per-row cockpit ribbon entries from database rows
- `routes[]`: route prefixes the app owns, used for active/inactive gating
- `ticketType` and `workflow`: how tickets route into the swarm
- `toolsDir`: app-owned tool source location, currently informational/runtime-specific
- `theme`, `sharedCss`, `migrations`: declared app assets, partially wired today

The implementation lives mainly in:

- `src/features/swarm-apps/`
- `src/app/routes/swarm-app-routes.ts`
- `src/app/middleware/swarm-app-gate-middleware.ts`
- `src/features/swarm-orchestration/services/workflow-pipeline-registry.ts`
- `src/pages/applications/index.html`

The detailed manifest contract is in [swarm-apps-framework.md](./swarm-apps-framework.md).

## Proof Configurations

As of 2026-07-19 the repo ships 33 app manifests. They show the same framework contract being reused for different products. A representative slice of the roster:

`capture-crm`, `codex-packer` (Bot Forge), `federal-capture`, `intelligent-operations`,
`jarvis` (OSHAL Assistant), `oshal-engineering`, `presentations`, `security` (Security
Center), `social`, `storage`, `trading` (Intelligent Trades), `world`.

The exact roster shifts over time as apps carve out to the `oshal-applications` store repo
(ADR-085) — `ls swarm-apps/*.yaml` is the source of truth for the current set.

A representative sample of what individual manifests prove:

| Manifest | Status in YAML | What it proves |
|---|---:|---|
| `swarm-apps/oshal-engineering.yaml` | active | Build-swarm configuration with engineering bots, workflow studio UI, task/routing surfaces, and the built-in `build` workflow. |
| `swarm-apps/federal-capture.yaml` | active | A whole business process packed into one bot (harness packing) — qualify → research → win-themes → pricing → proposal. |
| `swarm-apps/intelligent-operations.yaml` | active | The base ticket system with the RCA process enabled — triage → root-cause analysis → remediation scripts for human review, on the built-in `incident` workflow. |
| `swarm-apps/social.yaml` | active | A connector-backed composer: listen to feeds, draft posts + replies with AI on the comms bot, then publish to LinkedIn/Facebook via per-user connector tokens (nothing posts without a human Publish click). |
| `swarm-apps/trading.yaml` | active | Intelligent Trades — a scheduled/decisioning app on the `trading-decision` ticket type over brokered market/broker connectors. |
| `swarm-apps/security.yaml` | active | Security Center — an app that self-scans the platform (ADR-055). |
| `swarm-apps/jarvis.yaml` | active | OSHAL Assistant — conversational front door; batches tool work into the build queue, routed by selector (ADR-050). |

The important framework point is that each application is data/configuration first. The framework reads the manifest, upserts bots, registers UI, gates routes, and registers workflow routing where allowed.

## Runtime Configurations

There are also three deployment/runtime configurations to keep separate:

| Runtime | Main file or guide | Use |
|---|---|---|
| Core/standalone | `docker-compose.core.yml`, [setup/core-setup.md](./setup/core-setup.md) | Small local stack for cockpit/chat/API with mock auth by default. |
| Local swarm | `docker-compose.oshal-local.yml`, `docker-compose.swarm-local.yml` | Multi-bot local swarm with Redis, Postgres, ChromaDB, and bot containers. |
| Kubernetes/AnyBot | [k8/any-bot-kubernetes-setup.md](./k8/any-bot-kubernetes-setup.md), `ops/deployment/` | Cluster deployment path with rendered manifests, secrets, gateway, and optional Headscale access. |

Do not mix these concepts with app manifests. A deployment runtime answers "where does OSHAL run?" A swarm app manifest answers "what product/workflow is installed into OSHAL?"

## Add A New Application

1. Create `swarm-apps/<name>.yaml`.
2. Add root fields:

```yaml
name: my-app
displayName: My App
version: 0.1.0
status: active
```

3. Add bots:

```yaml
bots:
  - agentId: 11111111-1111-1111-1111-111111111111
    name: my-worker
    persona: ai-lab/bot-personas/my-worker.yaml
    role: Worker
    capabilities:
      - my-domain
      - investigation
```

4. Add UI entries, workflow, and route ownership as needed.
5. Hot-load the manifest:

```bash
curl -X POST http://localhost:35457/api/swarm/apps/load \
  -H 'Content-Type: application/json' \
  -d '{"path":"swarm-apps/my-app.yaml"}'
```

6. Verify:

```bash
curl http://localhost:35457/api/swarm/apps
curl http://localhost:35457/api/ui/profile?name=my-app
```

## Add A UI Element

For a fixed cockpit ribbon entry, add `ui.static[]`:

```yaml
ui:
  static:
    - toolName: my-dashboard
      label: Dashboard
      icon: codicon-dashboard
      iframeUrl: /my-app/dashboard
      section: top
```

The framework registers it through `registerDynamicToolUI()`. In focused mode, it appears at:

```text
/cockpit?app=my-app
```

### Ribbon anatomy: trays and groups

The cockpit left rail ([RibbonNav.js](../src/pages/cockpit/js/components/RibbonNav.js)) has three
trays, driven by each ribbon item's `section`:

- **`home`** — pinned at the top, never scrolls (Jarvis in the framework profile). Tinted
  `--bg-tertiary`.
- **`top`** — the scrollable middle. Items may carry a `group` label; groups render in order of
  first appearance with a header that collapses to a thin divider when the rail is at its 48px
  width and expands with the text on hover.
- **`bottom`** — pinned at the base, same tint as `home`.

The framework-default profile ([config-seed/profiles/oshal-framework.json](../config-seed/profiles/oshal-framework.json))
groups the middle rail by app bundle (Little Monsters, Career Placement, Communications, Money,
Everyday, Create, …) and ends with three platform groups — **Connections** (Connectors, Cloud,
Identity Hub, Files), **Security** (Security Center, DevOps + Vault) and **Optimization**
(Optimizer, AI Test Lab, Eval Wall) — split out of the former "Cloud & Ops" catch-all
(2026-07-07). The pinned bottom tray is just the essentials: Tickets, Calendar, Swarm Messages,
Settings, Operations.

Two behaviors worth knowing:

- RibbonNav force-pins the platform views (Operations, Connectors, Optimizer, Workflow Studio) to
  the bottom tray of **every** profile — unless the profile already declares the same id, in which
  case the profile's placement wins. That is how the framework profile relocates Connectors and
  Optimizer into their scrollable groups while focused apps (`?app=<name>`) keep the full pinned
  platform tray.
- Profile JSON edits are **not hot**: the api caches profiles in memory. Restart the api container
  (or `POST /api/ui/profile/reload` outside production) and hard-refresh the cockpit — the ribbon
  itself is also cached client-side.

For per-row UI, use `ui.dynamic`:

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

Current limitation: `ui.dynamic.source` is database-backed and source table names are validated. It is not a general plugin renderer.

## Add A Workflow

Add `ticketType` and `workflow` to the manifest:

```yaml
ticketType: my-ticket-type
workflow:
  name: My Ticket Workflow
  pipeline: my-single-worker
  workerBot: my-worker
  phases:
    - intake
    - execute
    - deliver
```

Runtime behavior:

- Built-in `build` and `incident` ticket types cannot be overridden.
- `incident-rca` uses the incident RCA handler.
- `swarm` uses the default build/decomposition swarm path.
- A non-built-in ticket type with another pipeline label routes through the manifest-worker path to `workerBot`.

Key files:

- `src/features/swarm-orchestration/services/workflow-pipeline-registry.ts`
- `src/features/swarm-orchestration/services/queue-manager-service.ts`
- `src/features/swarm-apps/services/swarm-app-service.ts`

Workflow Studio publishes to runtime: its **Publish** action (`POST /api/swarm/apps/publish`) compiles a definition into a caller-scoped manifest and loads it as a live ticket queue — single-shot → `manifest-worker`, staged → the `staged` executor (approval gates), or a full branching/parallel graph → an executable nodeGraph. Manifest workflows remain the other runtime registration path.

## Add An Agent

There are two supported paths.

### Path 1: Manifest Agent

Add the bot to `bots[]` in a swarm app manifest. On load, the framework upserts the bot into the `agents` table and toggles its status with the app.

Use this for app-owned bots that should appear/disappear with the app.

### Path 2: Agent Factory API

Use `POST /api/swarm/agents` for dynamic agent creation:

```bash
curl -X POST http://localhost:35457/api/swarm/agents \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "my-worker",
    "systemPrompt": "You are a focused worker for my domain.",
    "role": "Domain Worker",
    "topology": "swarm",
    "constraints": ["Return verifiable output."],
    "capabilities": ["my-domain"],
    "routingKeywords": ["my-domain"],
    "selectorDescriptor": "Use for my-domain tasks.",
    "toolAssignments": [],
    "configFields": [],
    "configValues": {},
    "configGuide": {
      "docPath": "docs/setup/my-worker-runtime-setup.md"
    }
  }'
```

This creates a persona-backed/routable agent and can also attach tool assignments, config schema, config values, and setup docs.

If the agent needs its own container, launch it after creation:

```bash
curl -X POST http://localhost:35457/api/agents/<agent-id>/launch
```

This path was validated end-to-end on 2026-05-09 against `docker-compose.oshal-local.yml`: runtime tool registration, dynamic agent creation, tool assignment, persona YAML generation, dynamic compose service creation, `bot-node` container launch, `/health`, Redis runtime heartbeat with role/capabilities/internal endpoint, bot registry overlay, and mesh/direct-channel subscriptions.

`POST /api/swarm/agents` uses persona-only deployment by default, and container insertion exists through `/api/agents/:agentId/launch` and dynamic compose. Since 2026-07-19 there is also a single closed transaction: `POST /api/swarm/agents/create-and-start` creates the agent and starts its container in one call, rolling back the created profile and dynamic-compose entry when the launch fails (502 with `rolledBack: true`; 201 success, 409 duplicate, 400 validation). The two-step flow remains supported for staged control.

See [architecture/deployable-agent-contract.md](./architecture/deployable-agent-contract.md) and [setup/agent-factory-runtime-setup.md](./setup/agent-factory-runtime-setup.md).

## Pack A Business Process Into One Bot (Harness Packing)

Harness packing is the pattern where an entire business process is encapsulated in a
**single self-contained bot**. The persona embeds the full quality gate (mode
classification, citation rules, artifact set, side-effect rules), so the process *is* the
agent — no external reviewer, no multi-phase decomposition. This is the same idea as the
"one bot per ticket-type workflow" default, applied deliberately to a whole workflow.

A packed bot is just the three framework artifacts produced together:

1. a persona YAML in `ai-lab/bot-personas/<slug>.yaml`,
2. a swarm-app manifest in `swarm-apps/<slug>.yaml` (ticket type + single-worker workflow + UI), and
3. an optional knowledge-base seed the operator ingests.

You can write those by hand, or use the **`codex-packer`** persona, which interviews an
operator and emits all three, then registers them live:

```bash
# codex-packer writes the artifacts, then hot-loads the new app:
curl -X POST http://localhost:35457/api/swarm/apps/load \
  -H 'Content-Type: application/json' \
  -d '{"path":"swarm-apps/<slug>.yaml"}'
```

Worked example: `swarm-apps/federal-capture.yaml` + `ai-lab/bot-personas/capture-specialist.yaml`
pack a government-contracting capture pipeline (qualify → research → win-themes → pricing
→ proposal) into one bot, with company facts and honesty rules baked into the persona so
output is correct by construction.

## App Composition Patterns In The Current Roster

Beyond the harness-packing pattern above, the active roster demonstrates a few recurring
composition patterns worth naming when you design a new app:

- **Data app with an inline reason-only bot (ADR-036 split).** An app declares its own
  `routes[]` and `migrations[]`, the **controller does the deterministic I/O**
  (DB writes, external API calls), and an **inline bot only reasons over the captured
  data** — it does not perform side effects. `trading`, `finance`, `security`,
  `payments`, and `purchasing` use this shape. (`payments` is the degenerate case: the
  reasoning step is dropped entirely, leaving a deterministic adapter app with no bot —
  see [connector-backed-apps.md](./connector-backed-apps.md).)
- **Platform self-scan (ADR-055).** `security` (Security Center) is an app that scans the
  OSHAL platform itself rather than an external domain.
- **Conversational front door + build-queue routing (ADR-050).** `jarvis` (OSHAL Assistant,
  `jarvis-bot`) is a purely conversational bot — it talks, gathers context, and **batches**
  any tool work into the build queue rather than running it (a single-threaded bot running a
  tool would lock the chat). The queue-manager routes each ticket **by selector**
  (`CapabilityMatcher`) to the owning bot (e.g. `rides-concierge`) or decomposes a build into
  a team on the fly. (Supersedes the original route-layer orchestrator.)
- **Desktop worker node.** `packages/oshal-chat` lets a laptop join the swarm as a worker
  node: it pulls swarm tasks and runs `codex`/`claude` locally using the user's own CLI
  credentials, then pushes results back.

## Add A Tool

There are three layers. Be explicit about which layer you are changing.

| Layer | What it does | Status |
|---|---|---|
| Tool registry | Metadata, category, auth group, default auth mode | Working through `/api/tools` and seed services. |
| Switch framework | Per-agent `auto`, `ask`, or `off`, plus tool config | Working through `/api/agents/:agentId/tools`. |
| Runtime executor | Actually runs the tool | Working for built-in, CLI, API, and MCP descriptor registration. MCP execution still belongs to the Cline runtime path. |

For normal framework work:

1. Register or seed the tool in `src/features/tool-registry/services/tool-registry-baseline-tools.ts` or through `/api/tools`.
2. Assign it to an agent through switch framework APIs or the config admin UI.
3. Set auth mode:
   - `auto`: execute without asking
   - `ask`: require approval
   - `off`: disabled
4. If the tool needs code execution, register an executor descriptor.

Runtime executable registration is now data-driven:

```bash
curl -X POST http://localhost:35457/api/tools/runtime/register \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": {
      "name": "my-cli-tool",
      "displayName": "My CLI Tool",
      "description": "Runs my app-specific CLI check.",
      "category": "my-app",
      "inputSchema": {
        "type": "object",
        "properties": { "target": { "type": "string" } },
        "required": ["target"]
      }
    },
    "executor": {
      "executorType": "cli",
      "cliCommand": "node scripts/my-tool.js {input.target}"
    }
  }'
```

Manifest-owned tools can be declared directly in `swarm-apps/<app>.yaml`:

```yaml
tools:
  - name: my-cli-tool
    displayName: My CLI Tool
    description: Runs my app-specific CLI check.
    category: my-app
    defaultAuthMode: ask
    inputSchema:
      type: object
      properties:
        target:
          type: string
      required: [target]
    executor:
      executorType: cli
      cliCommand: "node scripts/my-tool.js {input.target}"
```

The framework persists descriptors in `runtime_tool_executors`, restores them at boot, exposes them to the prompt resolver, and dispatches them through `ToolExecutorService`.

Key files:

- `src/features/tool-registry/`
- `src/features/tool-switch/`
- `src/features/tool-approval/`
- `src/features/chat-orchestration/services/tool-executor-service.ts`
- `docs/workflows/tool-management-workflow.md`
- `docs/workflows/tool-approval-workflow.md`

## Configure Clusters

Use these docs depending on the target:

- Local/core: [setup/core-setup.md](./setup/core-setup.md)
- Kubernetes/AnyBot: [k8/any-bot-kubernetes-setup.md](./k8/any-bot-kubernetes-setup.md)
- General topology: [architecture/deployment-runtime-topology.md](./architecture/deployment-runtime-topology.md)
- Headscale/remote overlay design: [adr/013-headscale-self-hosted-overlay-network.md](./adr/013-headscale-self-hosted-overlay-network.md)

Minimal Kubernetes render flow:

```bash
cp any-bot-k8s/setup.env.example any-bot-k8s/setup.env
npm run k8:install:any-bot -- --env-file any-bot-k8s/setup.env
```

Apply when the kube context is correct:

```bash
npm run k8:install:any-bot -- --env-file any-bot-k8s/setup.env --apply
```

Current limitation: cluster deployment docs exist, but there is not yet a single environment matrix for Docker Desktop, kind/k3d, managed Kubernetes, and remote Headscale nodes.

## Configure OIDC

For real OIDC/Keycloak, set:

```bash
MOCK_OIDC=false
KEYCLOAK_URL=http://keycloak:8080
KEYCLOAK_EXTERNAL_URL=http://localhost:8080
KEYCLOAK_REALM=oshal
KEYCLOAK_CLIENT_ID=oshal-swarm
KEYCLOAK_CLIENT_SECRET=<client-secret-if-confidential-client>
SESSION_SECRET=<long-random-secret>
APP_URL=http://localhost:35456
```

`SESSION_SECRET` is required unless `KEYCLOAK_CLIENT_SECRET` is used as the fallback session secret.

For local development without Keycloak:

```bash
MOCK_OIDC=true
```

Mock mode injects a development user and bypasses real login. It is for local development and tests only.

Key files:

- `src/shared/middleware/oidc.ts`
- `.env.example`
- `docker-compose.core.yml`
- `ops/deployment/oshal-k8s.env.example`
- `docs/adr/008-mock-oidc-development-mode.md`

## Use Workflow Studio

Workflow Studio is available at:

```text
/workflow-studio/
```

API:

```text
/api/workflow-studio/*
```

It currently supports:

- visual graph authoring
- node palette
- drag/connect/edit
- save definitions
- version history
- validation
- compile preview
- JSON export
- live agent roster compatibility notes

Beyond the preview, the canvas **Publishes to runtime**: `POST /api/swarm/apps/publish` compiles the definition into a caller-scoped manifest and loads it as a live queue-manager workflow — single-shot, staged (approval gates), or a full branching/parallel graph. Manifests remain the other runtime registration path.

The canvas is the intended end-state representation of a workflow. A natural-language
**talk-to-build** assist already drafts the canvas graph from a prompt; the remaining
roadmap item is an **agentic studio** that composes brand-new agents, goals, and personas
from natural language (the `codex-packer` idea applied to whole workflows, not just the
graph over existing bots). See [ROADMAP.md](../ROADMAP.md) and [BACKLOG.md](BACKLOG.md).

See [architecture/workflow-studio-framework.md](./architecture/workflow-studio-framework.md).

## AnyBot, Remote Client, And Cline Runtime

AnyBot is incorporated as a runtime pattern and partial implementation, not as a fully unified product boundary.

What exists:

- bot-node execution and dispatch paths
- per-bot containers in local swarm compose
- AnyBot-style runtime wrapper concepts
- Cline-backed execution paths
- cost/session trace infrastructure
- `any-bot/` server code retained as reference/runtime surface

What is still not clean:

- one canonical "AnyBot is the node runtime" developer guide
- full parity between old AnyBot runtime and OSHAL tool/provider registries
- fully closed create-agent-and-start-container transaction

Remote client support exists as a bridge for endpoint-side MCP:

- `src/features/remote-client/`
- `src/app/routes/remote-client-routes.ts`
- `scripts/remote-client.ts`
- [architecture/remote-client-architecture.md](./architecture/remote-client-architecture.md)

Current limitation: the remote-client architecture and code are present, but the docs do not yet show a recent end-to-end validation proving it is production-ready.

## Dynamic Node Loading And Dynamic Bot Insertion

Use precise names:

- Dynamic bot creation: working through `POST /api/swarm/agents`.
- Dynamic bot config: working through `agent_config` and `/config/` schema rendering.
- Dynamic bot UI/routing: working for manifest apps and persisted agents.
- Dynamic compose launch: working through `/api/agents/:agentId/launch`; generated services run `BOT_RUNTIME=bot-node`, use the `oshal-bot` image path, mount shared workspace/config/personas correctly, join the `oshal` network, and publish profile-backed heartbeats.
- Dynamic tool insertion: working through `/api/tools/runtime/register` and manifest `tools[]`.
- Generic node pool hot-loading: proposed, not implemented as the default runtime.

The proposed node-pool design is documented in [research/generic-node-pool-hot-loading-architecture.md](./research/generic-node-pool-hot-loading-architecture.md).

### Live Validation Command

The Docker-backed dynamic insertion path is covered by an opt-in test because it creates and removes real containers:

```bash
RUN_DYNAMIC_AGENT_E2E=true \
OSHAL_E2E_BASE_URL=http://127.0.0.1:35457 \
PLAYWRIGHT_REUSE_SERVER=true \
PLAYWRIGHT_PORT=35457 \
npx playwright test tests/dynamic-agent-live-e2e.spec.ts --reporter=line
```

Before running it, build and start the local stack:

```bash
docker build -f Dockerfile.oshal -t oshal-bot:latest .
COMPOSE_PROFILES=build SWARM_APPS_DIR=./swarm-apps-build UI_PROFILE=oshal-framework OSHAL_BOT_IMAGE=oshal-bot:latest \
  docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --remove-orphans
```

## Current Truth Matrix

| Question | Current answer |
|---|---|
| Is this a framework? | Yes. Swarm apps, route gates, bot upsert, UI registration, workflow registry, and app lifecycle are framework behaviors. |
| Do we have clear docs? | Better after this guide, but some old ADR/setup docs still need consolidation. |
| How do we add tools? | Use `/api/tools/runtime/register` for runtime CLI/API/MCP descriptors, or manifest `tools[]` for app-owned tools. |
| How do we configure clusters? | There are setup docs for core and K8s; a full cluster matrix is still missing. |
| Is dynamic node loading up? | Generic node hot-loading is not the default runtime yet. |
| How do we create/register workflows? | Use manifest `ticketType` + `workflow`, or author in Workflow Studio and **Publish** (compiles to a live caller-scoped queue — single-shot, staged, or full branch/parallel graph). |
| How do we configure OIDC? | Use Keycloak env vars; use `MOCK_OIDC=true` for dev. |
| How do we add UI? | Use manifest `ui.static` or `ui.dynamic`. |
| How do we add an agent? | Use manifest `bots[]` or `POST /api/swarm/agents`; launch container separately if needed. |
| Is Workflow Designer working? | Yes — as an editor and as executable deployment: **Publish** compiles the canvas to a live workflow (single-shot, staged, or branch/parallel graph). |
| Is AnyBot incorporated? | Partially. It is in the runtime architecture and codebase, but the unification story is not fully closed. |
| Is remote Cline/client working? | Code and architecture exist; recent end-to-end production proof is not documented. |
| Is dynamic bot creation/insertion working? | Yes for the two-step flow: create/configure with `POST /api/swarm/agents`, then launch with `/api/agents/:agentId/launch`. Live Docker E2E passed on 2026-05-09. The one-call create-and-start transaction is still future work. |

## What To Improve Next

The next documentation fixes should be:

1. Add a cluster environment matrix for local, Docker Desktop, kind/k3d, managed Kubernetes, and Headscale-connected nodes.
2. Add a deeper "new executable tool" guide with examples for CLI, API, MCP, and approval modes.
3. Turn the validated dynamic-agent happy path into a shorter operator runbook with screenshots/log examples.
4. Document the remaining Agentic Workflow Studio gap (natural-language authoring that composes brand-new agents/goals) — canvas Publish-to-runtime already shipped.
5. Add an AnyBot runtime wrapper guide that names the boundary between OSHAL controller, bot node, Cline, and remote client.

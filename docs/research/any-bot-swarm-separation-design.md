# Any-Bot / Swarm Separation Design

## The Problem We Created

**Date:** 2026-04-18  
**Author:** oshal maintainers / Claude Opus 4.6  
**Status:** Critical Design Correction

> **As-of note (2026-07-11):** file sizes below describe the April 2026 tree. The monoliths named
> here were since decomposed under the 1000-code-line cap (`app.js` → `app-modules/`,
> `QueueManagerService.js` → 8 stage modules, `LLMProviderRegistry.js` → `llm/registry/`) with
> identical interfaces; the architectural narrative is unchanged.

---

## What Went Wrong

On March 8, 2026, the original repository was created with two things:

1. **any-bot/** — a working bot runtime (`server/app.js`, 3800+ lines) with `ClineProvider.js`, `ClaudeCodeProvider.js`, `LLMProviderRegistry.js` (22 providers), `AgenticController.js`, full credential management, and a proven `/chat` UI.

2. **src/** — a new FSD TypeScript codebase intended to be the swarm orchestration layer.

An AI agent on March 8 reimplemented the any-bot's `ClineProvider.js` as `claude-code-provider.ts` in the FSD code — **the same day**. On March 12, the any-bot server code was deleted. From that point, 161 commits built the entire swarm on top of the reimplementation. No one brought the any-bot back.

The result: every bot node runs the swarm's reimplemented LLM layer, which is missing the any-bot's credential management, provider registry, and config safety nets. The swarm tries to configure Cline CLI by writing to `~/.cline/config.json` and `globalState.json` and `secrets.json` — reaching into the agent's internals instead of letting the bot runtime handle it.

---

## The Correct Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    SWARM CONTROLLER                         │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │  Queue    │  │ Routing  │  │  Phase   │  │   Redis    │ │
│  │ Manager  │  │ Handler  │  │  Gates   │  │   Mesh     │ │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘ │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │  Node    │  │  Cost    │  │ Workflow │  │  Cockpit   │ │
│  │Allocator │  │ Rollup   │  │ Registry │  │    API     │ │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘ │
│                                                             │
│  Owns: orchestration, routing, phases, metrics, UI          │
│  Does NOT own: provider config, credentials, CLI spawning   │
│                                                             │
│  Communicates with bots via:                                │
│    - POST /api/send-message (task execution)                │
│    - PUT /api/llm-provider (provider configuration)         │
│    - GET /api/health (liveness)                             │
│    - Redis mesh envelopes (async work dispatch)             │
└────────────────────────┬────────────────────────────────────┘
                         │
                    HTTP / Redis
                         │
┌────────────────────────▼────────────────────────────────────┐
│                    BOT NODE (any-bot runtime)                │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              any-bot/server/app.js                    │   │
│  │                                                      │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │   │
│  │  │   Cline      │  │  Claude Code │  │  Provider  │ │   │
│  │  │  Provider    │  │   Provider   │  │  Registry  │ │   │
│  │  │  .js         │  │   .js        │  │  (22 prov) │ │   │
│  │  └──────┬───────┘  └──────┬───────┘  └────────────┘ │   │
│  │         │                 │                          │   │
│  │  ┌──────▼───────┐  ┌─────▼────────┐  ┌───────────┐ │   │
│  │  │  Cline CLI   │  │  Claude CLI  │  │  Agentic  │ │   │
│  │  │  Wrapper     │  │  Wrapper     │  │Controller │ │   │
│  │  │  .js         │  │  .js         │  │  .js      │ │   │
│  │  └──────┬───────┘  └──────┬───────┘  └───────────┘ │   │
│  │         │                 │                          │   │
│  │  ┌──────▼───────┐  ┌─────▼────────┐                 │   │
│  │  │  cline CLI   │  │  claude CLI  │                  │   │
│  │  │  subprocess  │  │  subprocess  │                  │   │
│  │  └──────────────┘  └──────────────┘                  │   │
│  │                                                      │   │
│  │  Owns: provider config, credentials, CLI spawning,   │   │
│  │        persona loading, tool management, cost capture │   │
│  │                                                      │   │
│  │  API surface:                                        │   │
│  │    POST /api/send-message    (execute task)          │   │
│  │    POST /api/process-ticket  (execute ticket)        │   │
│  │    GET  /api/llm-provider    (current provider)      │   │
│  │    PUT  /api/llm-provider    (switch provider)       │   │
│  │    GET  /api/llm-provider/registry (all 22 provs)    │   │
│  │    PUT  /api/settings        (config)                │   │
│  │    GET  /api/health          (liveness)              │   │
│  │    GET  /api/mcp/servers     (tool config)           │   │
│  │    POST /api/tasks           (create task)           │   │
│  │    POST /api/tasks/:id/messages (add message)        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Also has: /chat UI, persona YAML loading, workspace mgmt   │
└─────────────────────────────────────────────────────────────┘
```

---

## What Each Side Owns

### Swarm Controller Owns

| Component | File/Service | Purpose |
|-----------|-------------|---------|
| Queue management | `queue-manager-service.ts` | Poll tickets, dispatch, circuit breaker |
| Routing | `swarm-routing-handler.ts` | Select which bot handles which task |
| Phase gates | `phase-gate-config.ts` | 7-phase lifecycle, complexity scoring |
| Workflow registry | `WORKFLOW_PIPELINES` | incident-rca, build, multi-harness |
| Redis mesh | `redis-mesh-transport.ts` | Durable envelope delivery |
| Agent worker | `swarm-agent-worker.ts` | Consume envelopes from Redis streams |
| Node allocator | `node-allocator-service.ts` | Pool management, hot-loading |
| Cost rollup | `usage-cost-resolver.ts` | Aggregate costs across bots/tickets |
| Bot registry | `swarm-bot-registry.ts` | Persona catalog (NOT provider config) |
| Cockpit UI | `/cockpit`, config-admin | Operator dashboard |
| Ticket management | `ticket-service.ts` | CRUD, status, lifecycle |

### Any-Bot Runtime Owns

| Component | File/Service | Purpose |
|-----------|-------------|---------|
| Provider registry | `LLMProviderRegistry.js` | 22 providers, model groups, credential mapping |
| Provider switching | `PUT /api/llm-provider` | Switch provider + write correct Cline config |
| Cline provider | `ClineProvider.js` | Spawn cline CLI, persona injection, output parsing |
| Claude Code provider | `ClaudeCodeProvider.js` | Spawn claude CLI, real cost from JSON output |
| Cline CLI wrapper | `ClineCLIWrapper.js` | Subprocess management, timeouts, concurrency |
| Claude CLI wrapper | `ClaudeCodeCLIWrapper.js` | Subprocess, `-p` mode, `--output-format json` |
| Credential management | `_ensureModelConfig()` | Safety net before every CLI spawn |
| Config builder | `buildClineConfig()` | Per-provider credential field mapping |
| GlobalState builder | `buildGlobalState()` | Per-provider state key mapping |
| Agentic controller | `AgenticController.js` | Multi-turn agentic loop |
| Task management | `TaskController.js` | Task CRUD, message store |
| Cost calculator | `CostCalculator.js` | Per-provider per-model pricing |
| MCP management | `MCPServiceV2.js` | Tool server lifecycle |
| Persona loading | `_messagesToTask()` | YAML persona to agent context file |
| Chat UI | `/chat` | User-facing chat interface |

### Neither Side Owns (Shared Infrastructure)

| Component | Purpose |
|-----------|---------|
| Redis | Message bus, node registry, credential broadcast |
| PostgreSQL | Tickets, agent profiles, cost tracking |
| Persona YAMLs | `ai-lab/bot-personas/*.yaml` |
| Dockerfile.bot | Generic image (both any-bot + swarm code) |

---

## What Stays, What Moves, What Gets Deleted

### STAYS in swarm (src/features/, src/app/)

```
src/features/swarm-orchestration/     — ALL of it (queue, routing, phases, execution handler)
src/features/agent-management/        — mesh, registry, router, allocator
src/features/ticketing/               — ticket CRUD, Plane sync
src/features/tool-registry/           — tool catalog (swarm-level)
src/features/tool-switch/             — tool auth modes
src/app/extensions/swarm/             — swarm boot, worker, mesh wiring
src/app/routes/cockpit-*              — cockpit UI routes
src/app/routes/node-pool-routes.ts    — node pool API (Phase 1)
src/app/composition/provider-runtime.ts — harness factory registry (stays for routing decisions)
```

### MOVES to any-bot (or gets replaced by any-bot)

```
DELETE: src/features/llm-provider/services/claude-code-provider.ts
        (reimplementation of ClineProvider.js — 942 lines replacing 425)
        
DELETE: src/features/llm-provider/services/cline-cli-wrapper.ts  
        (reimplementation of ClineCLIWrapper.js)

DELETE: src/features/llm-provider/services/cline-runtime-config-sync-service.ts
        (reimplementation of LLMProviderRegistry.buildClineConfig/buildGlobalState)

DELETE: src/features/llm-provider/services/cline-session-runtime-service.ts
        (session config that should be any-bot internal)

KEEP:   src/features/llm-provider/services/provider-catalog.ts (Phase 0 — USE as reference data)
KEEP:   src/features/llm-provider/services/cline-config-builder.ts (Phase 0 — but any-bot should use)
KEEP:   src/features/llm-provider/services/harness-adapter.ts (interface for harness factory)
KEEP:   src/features/llm-provider/services/usage-cost-resolver.ts (swarm-level cost aggregation)
KEEP:   src/features/llm-provider/services/noop-provider.ts (testing)
```

### BRINGS BACK from oshal/any-bot/

```
any-bot/server/app.js                    — the runtime (3800+ lines)
any-bot/server/services/llm/             — ALL providers (Cline, ClaudeCode, Bedrock, OpenAI, etc.)
any-bot/server/services/codebase/        — CLI wrappers (ClineCLIWrapper, ClaudeCodeCLIWrapper)
any-bot/server/controllers/              — TaskController, AgenticController, etc.
any-bot/server/stores/                   — message store, task store
any-bot/server/utils/                    — logger, messageTypes
```

---

## How the Swarm Talks to Any-Bot

### Current (broken): Swarm IS the bot runtime

```
Envelope arrives via Redis
  → LLMExecutionHandler receives it
  → resolveProvider() returns ClineHarnessProvider
  → ClineHarnessProvider writes ~/.cline/config.json (WRONG: swarm reaching into agent internals)
  → ClineHarnessProvider writes ~/.cline/data/globalState.json (WRONG)
  → ClineHarnessProvider writes ~/.cline/data/secrets.json (WRONG)
  → ClineHarnessProvider spawns cline CLI subprocess
  → Parses output
  → Returns result
  
  Problem: swarm manages credentials, config files, CLI args — all any-bot responsibilities
```

### Correct: Swarm calls any-bot API

```
Envelope arrives via Redis
  → SwarmAgentWorker receives it
  → Formats as HTTP request
  → POST http://bot-node:5000/api/send-message
      { text, taskId, agentId, providerId, model }
  → Any-bot receives request
  → Any-bot resolves provider from its own LLMProviderRegistry
  → Any-bot writes its own Cline config (it knows how)
  → Any-bot spawns its own CLI subprocess
  → Any-bot captures tokens, cost, output
  → Any-bot returns response
      { success, response, usage: { inputTokens, outputTokens }, cost, model, provider }
  → Swarm records the cost/metrics
  → Swarm routes the output to the next phase
  
  Clean: swarm sends tasks, any-bot handles execution
```

### For the node pool model

```
1. Swarm allocator picks idle node
2. POST http://node:5000/api/llm-provider
     { provider: "gemini", model: "gemini-3.1-pro-preview", credentials: {...} }
   Any-bot configures itself (it knows how to buildClineConfig for gemini)
3. POST http://node:5000/api/send-message
     { text: "research security vulnerabilities", taskId: "sec-audit-p1" }
   Any-bot executes via its own ClineProvider/ClaudeCodeProvider
4. Response comes back with real token counts and cost
5. Swarm records metrics, routes output to next phase
6. When done, node releases identity
```

---

## The Execution Handler Change

The key code change is in `llm-execution-handler.ts`. Instead of:

```typescript
// CURRENT (wrong): swarm spawns CLI directly
const baseProvider = agentHarness ?? resolveProvider();
const capturingProvider = new TokenCapturingProvider(baseProvider);
const agent = await createAgent({ getProvider: () => capturingProvider, ... });
const rawContent = await agent.processMessage(userMessage, workspaceFolderId);
```

It becomes:

```typescript
// CORRECT: swarm calls any-bot API
const nodeEndpoint = await resolveNodeEndpoint(agentId);
const response = await fetch(`${nodeEndpoint}/api/send-message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text: userMessage,
    taskId,
    agentId,
    source: 'swarm-dispatch',
  }),
});
const result = await response.json();
// result has: { success, response, usage, cost, model, provider }
```

The swarm doesn't need `ClineHarnessProvider`, `ClineRuntimeConfigSyncService`, `ClineSessionRuntimeService`, or any of the credential plumbing. The any-bot handles all of that internally.

---

## What the Swarm's LLM Execution Handler SHOULD look like

```typescript
interface BotNodeResponse {
  success: boolean;
  response: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWrites: number;
    cacheReads: number;
  };
  cost: number;
  model: string;
  provider: string;
  latency: number;
}

// The execution handler becomes a thin HTTP client
async function executeOnBotNode(
  nodeEndpoint: string,
  envelope: MeshEnvelope,
): Promise<BotNodeResponse> {
  const payload = envelope.payload as Record<string, unknown>;
  
  const response = await fetch(`${nodeEndpoint}/api/send-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: payload.message || payload.task,
      taskId: payload.workspaceTaskId,
      agentId: envelope.toAgentId,
      source: 'swarm-dispatch',
    }),
  });
  
  return response.json() as Promise<BotNodeResponse>;
}
```

---

## Migration Plan

### Step 1: Bring any-bot back into the image

Add `any-bot/server/` back to the repo (from `oshal/any-bot/server/`). Update `Dockerfile.oshal` / `Dockerfile.bot` to include it. The image now has both:
- `dist/app/server.js` (swarm controller — runs on the API/PM container)
- `any-bot/server/app.js` (bot runtime — runs on bot nodes)

### Step 2: Change bot-entrypoint.sh

Bot containers run `node any-bot/server/app.js` instead of `node dist/app/server.js`. The swarm controller container still runs `node dist/app/server.js`.

### Step 3: Change the execution handler

`LLMExecutionHandler` calls `POST /api/send-message` on the bot node's HTTP endpoint instead of resolving a local provider and spawning CLI directly. The `SwarmAgentWorker` already knows the bot's endpoint via the registry.

### Step 4: Remove the reimplemented LLM layer

Delete `claude-code-provider.ts`, `cline-cli-wrapper.ts`, `cline-runtime-config-sync-service.ts`, `cline-session-runtime-service.ts`. The any-bot handles all of this.

### Step 5: Node pool mode

The any-bot's `PUT /api/llm-provider` endpoint already supports provider switching at runtime. The node allocator calls this when assigning a bot identity — the any-bot reconfigures itself. No swarm-side credential management needed.

---

## Why This Works

The any-bot's `/api/send-message` already:
- Loads persona from YAML
- Resolves the correct provider (ClineProvider or ClaudeCodeProvider)
- Writes correct Cline config via `_ensureModelConfig()` before every spawn
- Manages concurrency (max 5 concurrent CLI processes)
- Handles timeouts (inactivity + hard max)
- Captures real token usage from CLI output
- Returns structured response with cost, tokens, model

The swarm doesn't need to reimplement any of this. It just needs to call the endpoint and record the results.

---

## What the Any-Bot's /chat and the Swarm's /cockpit Become

- `/chat` on a bot node: direct human conversation with that bot (any-bot handles it entirely)
- `/cockpit` on the swarm controller: operator dashboard showing all bots, tickets, costs, workflows
- The swarm controller's `/api/send-message` routes to the appropriate bot node's `/api/send-message`
- The cockpit's provider dropdown calls `PUT /api/llm-provider` on the bot nodes to configure them

---

## File Inventory

### oshal/any-bot/server/ (the bot runtime — 3800+ lines)

```
app.js                          — Express server, all routes, initialization (3800+ lines)
controllers/
  AgenticController.js          — Multi-turn agentic loop
  TaskController.js             — Task CRUD, message processing  
  MessageController.js          — Message store operations
  StreamController.js           — SSE streaming
  VoiceController.js            — STT/TTS
  ScheduleController.js         — Self-scheduling
services/
  llm/
    ClineProvider.js            — Cline CLI agent (425 lines, battle-tested)
    ClaudeCodeProvider.js       — Claude Code CLI agent
    BedrockProvider.js          — Direct AWS Bedrock API
    OpenAIProvider.js           — Direct OpenAI API
    AnthropicProvider.js        — Direct Anthropic API
    LLMProviderRegistry.js      — 22 providers, buildClineConfig, buildGlobalState (1300 lines)
    LLMService.js               — Base class
    CostCalculator.js           — Per-provider pricing
    PromptManager.js            — Prompt assembly
    TokenTracker.js             — Token counting
  codebase/
    ClineCLIWrapper.js          — Cline subprocess management
    ClaudeCodeCLIWrapper.js     — Claude subprocess management
  MCPServiceV2.js               — MCP server lifecycle
  AgentConfigManager.js         — Per-agent config
  AgentBootstrap.js             — Agent initialization
stores/
  (message store, task store, etc.)
```

### src/ (the swarm — keeps its orchestration, loses its LLM reimplementation)

```
KEEP:
  src/features/swarm-orchestration/   — queue, routing, phases, execution, decomposition
  src/features/agent-management/      — mesh, registry, allocator, factory
  src/features/ticketing/             — ticket CRUD
  src/features/tool-registry/         — tool catalog
  src/features/tool-switch/           — tool auth
  src/app/extensions/swarm/           — boot, worker, routes
  src/app/routes/                     — cockpit, config, API routes
  
DELETE (reimplemented any-bot code):
  src/features/llm-provider/services/claude-code-provider.ts     (942 lines)
  src/features/llm-provider/services/cline-cli-wrapper.ts        (91 lines)
  src/features/llm-provider/services/cline-runtime-config-sync-service.ts (850 lines)
  src/features/llm-provider/services/cline-session-runtime-service.ts     (250 lines)
  src/features/llm-provider/services/claude-code-cli-provider.ts
  src/features/llm-provider/services/codex-cli-provider.ts
  src/features/chat-orchestration/services/agentic-loop.ts       (reimpl of AgenticController)

KEEP (swarm-level, not any-bot duplicates):
  src/features/llm-provider/services/harness-adapter.ts          (interface)
  src/features/llm-provider/services/usage-cost-resolver.ts      (swarm cost aggregation)
  src/features/llm-provider/services/noop-provider.ts            (testing)
  src/features/llm-provider/services/provider-catalog.ts         (Phase 0 — reference data)
```

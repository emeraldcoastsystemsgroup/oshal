# Generic Node Pool with Hot-Loading Bot Identity

## Proposal: OSHAL Swarm Architecture v2

**Author:** oshal maintainers / Claude Opus 4.6  
**Date:** 2026-04-18  
**Status:** Proposed  

---

## 1. Executive Summary

This proposal replaces the current 22 static bot containers — each permanently bound to a single bot identity — with N generic "node pool" containers (target: 5) that hot-load bot identities on demand. A node can become any bot, execute work, then release its identity and become available for the next assignment. This eliminates ~75% of idle resource consumption, removes the scaling ceiling imposed by the static swarm bot registry, and solves the provider/harness override confusion by cleanly separating five independent concepts: bot, agent, model, provider, and node.

The infrastructure stays: Redis Streams for the mesh, PostgreSQL for state, the existing `Dockerfile.bot` image, and the existing harness adapter contracts. The any-bot runtime wrapper becomes the standard execution layer on every node — it's what gives raw agent CLIs their persona, tools, metrics, and cost tracking. The proposal is additive to the infrastructure, not a rewrite.

---

## 2. Conceptual Model — Five Axes

The current codebase conflates several concepts. This proposal establishes clean vocabulary:

### 2.1 Bot
**What:** Persona + role + tools + capabilities.  
**Defined in:** Persona YAML files (`ai-lab/bot-personas/*.yaml`), agent profiles in PostgreSQL.  
**Examples:** code-reviewer, documentation-writer, rca-specialist, devops-bot.  
**Key point:** A bot is NOT a container. A bot is an identity that can be loaded onto any node.

### 2.2 Agent
**What:** Autonomous execution engine — the CLI tool that does the thinking.  
**Examples:** cline, claude-code, codex, codex-oss, gemini-cli.  
**Key point:** The agent is NOT the bot. Cline is an agent that any bot can use. The agent has its own config surface, auth mechanism, output format, and model constraints.

Agent constraint classes:
- **Open agents** (cline, codex-oss) — accept any model on any supported provider. The adapter translates the assignment into the agent's native config format.
- **Locked agents** (claude-code) — Anthropic models only, via its own CLI auth. The adapter validates and rejects incompatible assignments.
- **Partially open** (codex official) — OpenAI models only. The open-source fork removes this constraint.

### 2.3 Model
**What:** The neural network being called.  
**Examples:** claude-sonnet-4-6, claude-opus-4-6, gpt-5.3-codex, llama-3.3-70b, deepseek-r1, gemini-3-pro.  
**Key point:** The same model can be available on multiple providers with different auth and pricing.

### 2.4 Provider
**What:** Where the model is hosted / who serves the API.  
**Examples:** anthropic, bedrock, groq, openai-native, vertex, azure, ollama, together, fireworks, openrouter.  
**Key point:** Provider is NOT agent. Cline is an agent that supports 22 providers. Anthropic is a provider that can be used by multiple agents (cline, claude-code).

### 2.5 Node
**What:** Generic execution container from the pool. Runs the any-bot wrapper + any agent CLI.  
**Key point:** A node has no permanent identity. It receives an assignment of `(bot, agent, model, provider)`, configures itself, executes, releases.

### 2.6 Agents as Execution Engines

All agents follow the same contract from the OSHAL swarm's perspective: envelope in, result out, cost recorded.

- **Cline, claude-code, codex** are LLM-based single-task execution engines — one agentic loop, one result.
- The OSHAL swarm is the ONLY external orchestrator. Agents don't orchestrate each other across nodes — the swarm does.

**Not every agent is an LLM.** The `HarnessAdapter` interface (`run(task) -> result`) has no LLM requirement. Non-LLM agents are first-class:
- **Image generation agent** (stable-diffusion, dall-e) — receives prompt, returns image path + description. Model = sdxl. Provider = local-gpu or API.
- **Compute agent** (python-script, data-pipeline) — receives data task, runs pandas/numpy, returns structured analysis. Model = none. Provider = none.
- **Integration agent** (API caller, webhook handler) — receives action, calls external system, returns result. No LLM involved.

The swarm composes LLM agents with non-LLM agents seamlessly. A python data-bot produces analysis tables, an LLM bot reads them and writes prose, an image-bot generates charts, a documentation-bot assembles the final deliverable. Real agent-to-agent collaboration, not LLM-to-LLM.

### 2.7 Tools Stay Native to Agents — The Swarm Routes to Capabilities

Each bot has tools native to its agent. The swarm does NOT translate tools between agent formats or inject tools into agents that don't natively support them. Instead, the swarm routes work to the bot that has the right capability natively.

```
Swarm capability index:
  "google-search"  -> google-bot (gemini-cli, native google tools)
  "code-review"    -> code-reviewer (claude-code, native code analysis)
  "kubectl"        -> devops-bot (cline, kubectl MCP)
  "web-browsing"   -> research-bot (cline, playwright MCP)
  "chart-gen"      -> image-bot (chart-generator, matplotlib/d3)
  "data-analysis"  -> data-bot (python-script, pandas/numpy)
```

When any bot needs a capability it doesn't have, the swarm dispatches a sub-task to the bot that DOES have it. The requesting bot gets the RESULT as context — not the tool itself. This means:

- A cline bot running ollama locally can use google search results from a gemini-cli bot running on Google's API
- A claude-code bot doing code review can reference data analysis from a python compute bot
- Neither bot knows about the other's tools — the swarm is the bridge

This is why the architecture is powerful: it composes capabilities across heterogeneous agents, models, providers, and even LLM vs non-LLM runtimes.

### 2.8 Example Combinations

```
LLM agents:
{ bot: "code-reviewer", agent: "cline", model: "claude-sonnet-4-6", provider: "bedrock" }
{ bot: "code-reviewer", agent: "claude-code", model: "claude-opus-4-6", provider: "anthropic" }
{ bot: "research-bot", agent: "gemini-cli", model: "gemini-3-pro", provider: "google" }
{ bot: "devops-bot", agent: "cline", model: "gpt-5.3-codex", provider: "openai-native" }
{ bot: "rca-specialist", agent: "cline", model: "deepseek-r1", provider: "fireworks" }
{ bot: "documentation-writer", agent: "codex-oss", model: "llama-3.3-70b", provider: "groq" }

Non-LLM agents:
{ bot: "data-analyst", agent: "python-script", model: "none", provider: "none" }
{ bot: "diagram-bot", agent: "chart-generator", model: "none", provider: "none" }
{ bot: "image-bot", agent: "stable-diffusion", model: "sdxl", provider: "local-gpu" }
```

Same bot can use different agents. Same agent can serve different bots. Same model can run on different providers. LLM and non-LLM agents collaborate through the swarm. All independently configurable per assignment.

---

## 3. Any-Bot as Bot Runtime Wrapper

The any-bot is NOT just another bot. It's the **runtime wrapper** that sits between the swarm and raw agent CLIs:

```
Swarm (orchestrator)
  |
  v
Any-bot wrapper (on the node)
  |-- receives assignment from swarm
  |-- loads persona (bot identity -> context files the agent reads)
  |-- configures tools (MCP server assembly, tool auth modes from DB)
  |-- sets up provider credentials (writes to agent-native config)
  |-- spawns the agent CLI subprocess
  |-- captures output (JSONL events, completion_result)
  |-- captures metrics (real token counts via TokenCapturingProvider)
  |-- resolves cost (per agent + model + provider via usage-cost-resolver)
  |-- writes handovers (RALF context files for next phase)
  |-- reports result back to swarm via Redis mesh
  |
  v
Agent CLI (cline, claude-code, codex, gemini-cli)
  |
  v
Model via Provider (claude on bedrock, gpt on openai, etc.)
```

Without the any-bot wrapper, a raw agent CLI has no metrics, no persona, no tool auth, no cost tracking, no mesh communication. **The node pool doesn't eliminate the any-bot — the any-bot IS the node runtime.**

Current implementations:
- `ClineHarnessProvider` (`src/features/llm-provider/services/claude-code-provider.ts`) — wrapper for cline agent
- `ClaudeCodeCliHarnessAdapter` (`src/features/llm-provider/services/claude-code-cli-harness-adapter.ts`) — wrapper for claude-code agent
- `CodexCliHarnessAdapter` (`src/features/llm-provider/services/codex-cli-harness-adapter.ts`) — wrapper for codex agent
- `GeminiCliHarnessAdapter` (`src/features/llm-provider/services/gemini-cli-harness-adapter.ts`) — wrapper for the gemini CLI agent

Each wrapper handles: persona injection, credential setup, subprocess spawning, output parsing, token capture — specific to its agent CLI.

---

## 4. Problem Statement

### 4.1 Twenty-two containers running at all times
`docker-compose.oshal-local.yml` defines ~19 active bot services using `x-bot-common` anchor. Each runs its own Express server on port 5000. At rest, 22 Node.js processes consume ~3.3-7.7GB RAM while only 2-3 are active at any given time.

### 4.2 Static identity binding
`scripts/bot-entrypoint.sh` reads persona YAML once at startup, writes `bot-persona.json`, and never reloads. A bot is permanently its persona until container restart. `SwarmBotRegistry.resolveRuntimeIdentity()` in `src/app/extensions/swarm/swarm-bot-registry.ts` reads env vars once and caches.

### 4.3 Provider / agent / model conflation
`SwarmBotDefinition` mixes `harnessType` and `apiType` as optional compile-time fields. The `resolveHarnessForAgent()` function in `src/app/composition/provider-runtime.ts` does a static registry lookup. The cockpit dropdown configures the "provider" but this actually controls both the provider AND model, while the agent (called "harness") is hardcoded per bot. Changing a bot's agent requires a code change, rebuild, and redeploy.

### 4.4 Scaling ceiling
Adding a new bot requires: adding an entry to `SWARM_BOT_REGISTRY` array, creating a persona YAML, adding a service block to docker-compose, assigning a unique host port. The 56 persona YAML files in `ai-lab/bot-personas/` show ambition beyond the 19 currently wired bots.

### 4.5 Online agent filtering fragility
`SwarmRoutingHandler` uses `resolveOnlineAgentIds` to filter routing candidates. With static containers, a stopped container means a permanently offline bot. With node pools, "offline" just means "not currently loaded" — a meaningful distinction the routing layer doesn't understand.

---

## 5. Codebase Forensics — The Split That Must Be Resolved First

### 5.1 What Happened

Both repos trace to the same GitHub remote (`oshal-maintainer/oshal`) and share the same initial commit (`f2489dd`, Mar 8 2026).

```
Mar 8:   oshal initial commit — any-bot with full runtime (90 files)
         Both repos start from this point.

Mar 12:  open-shal commit 618a520 — "chore: reorg workspace"
         DELETES all 90 any-bot files from open-shal.
         any-bot/ becomes empty (just .DS_Store).
         oshal/any-bot/ remains frozen at Mar 8.

Mar 12 → Apr 13:  open-shal builds 161 commits of new code:
         - Swarm framework (mesh, routing, envelopes)
         - Multi-harness adapters (cline, claude-code, codex, noop)
         - FSD restructure (src/features/*, src/app/*, src/entities/*)
         - ClineHarnessProvider, ClineSessionRuntimeService — partial reimpl of any-bot
         - Tool registry, switch framework — partial reimpl of any-bot
         - Redis streams mesh, agent worker, queue manager — new
         - Cockpit UI, cost tracking, metrics — new

Meanwhile: oshal/any-bot sits frozen at 6 commits, last touch Mar 12.
```

### 5.2 What Each Codebase Has

| Capability | oshal any-bot | open-shal |
|-----------|----------------|-----------|
| Provider registry (22 providers) | `LLMProviderRegistry.js` (1300 lines, complete) | `provider-registry.ts` (partial, focuses on pricing) |
| Cline config builder | `buildClineConfig()` + `buildGlobalState()` per-provider | `ClineRuntimeConfigSyncService` (reimplemented) |
| Cline agent wrapper | `ClineProvider.js` (full persona injection, workspace README) | `ClineHarnessProvider` (reimplemented differently) |
| Claude Code agent wrapper | `ClaudeCodeProvider.js` | `ClaudeCodeCliHarnessAdapter` (reimplemented) |
| Multi-harness framework | NO — only cline + claude-code, no pluggable interface | YES — `HarnessAdapter` interface, `HARNESS_FACTORIES` registry, 5 adapters |
| Swarm orchestration | NO | YES — full mesh, routing, phases, envelopes |
| Redis streams mesh | NO | YES — `RedisMeshTransport`, consumer groups, XAUTOCLAIM |
| Tool switch framework | YES — `SwitchFrameworkService` equivalent in any-bot | YES — `SwitchFrameworkService` (reimplemented) |
| UI config / cockpit | YES — full cockpit with provider dropdown, model picker | YES — reimplemented cockpit |
| Cost tracking | `CostCalculator.js`, `TokenTracker.js` | `usage-cost-resolver.ts`, `TokenCapturingProvider` |
| Agentic controller | `AgenticController.js` (multi-turn loop) | `agentic-loop.ts` (reimplemented) |
| Persona loading | `_messagesToTask()` with YAML fallback paths | `bot-entrypoint.sh` + `resolveLevel0SystemPrompt()` |
| Bot-specific metrics | YES — per-bot token/cost tracking through the wrapper | YES — `CostRecordFn`, `MetricsRecordFn` |

### 5.3 The Core Problem

The any-bot is the runtime wrapper that makes raw agent CLIs useful — it provides persona injection, tool config, metrics, cost tracking. But it only has TWO agents (cline, claude-code) and NO swarm framework.

Open-shal has the swarm framework and FIVE agents, but its runtime wrapper is a reimplementation that diverged from the any-bot. And the original any-bot code was deleted from this repo on Mar 12.

**Neither codebase is complete alone.** The node pool architecture requires BOTH:
- The any-bot's runtime wrapper quality (full provider registry, persona injection, tool management)
- Open-shal's multi-harness framework and swarm orchestration

### 5.4 Phase 0 — Codebase Unification (prerequisite for everything else)

Before any node pool work, the any-bot runtime must be reconciled with open-shal:

**Option A: Port any-bot runtime INTO open-shal (recommended)**
- Bring `LLMProviderRegistry.js` (22-provider catalog with `buildClineConfig`/`buildGlobalState`) into `src/features/llm-provider/` as the canonical provider registry
- Validate that open-shal's reimplemented services (`ClineRuntimeConfigSyncService`, `ClineSessionRuntimeService`, `ClineHarnessProvider`) cover what the any-bot's `ClineProvider.js` does
- Fill gaps where open-shal's reimplementation is incomplete
- The any-bot's `AgenticController.js` maps to open-shal's `agentic-loop.ts` — validate parity
- Archive the frozen `oshal/any-bot/` as reference, not source of truth

**Option B: Rebuild any-bot on top of open-shal (larger effort)**
- The any-bot becomes a deployment profile of open-shal — same codebase, different docker-compose
- Any-bot deployment = single node, no swarm, cline agent only
- Swarm deployment = N nodes, full swarm, all agents

Option A is faster. Option B is cleaner long-term.

---

## 6. Proposed Solution — The Node Pool Model (requires Phase 0 completion)

### 5.1 Node Pool
N generic containers (target: 5) running the same `Dockerfile.bot` image. Each starts idle — no `BOT_NAME`, no `AGENT_ID`, no `BOT_PERSONA_FILE`. They register with Redis as idle nodes and subscribe to the `swarm.broadcast` channel.

### 5.2 Node Allocator
New service in the Swarm Controller (main OSHAL app). Responsibilities:
- Track node availability via Redis (idle set, active hash)
- Match incoming work to available nodes
- Assign bot identities + agent + model + provider to idle nodes
- Detect unconsumed Redis Stream messages and trigger hot-loading of target bots
- Maintain affinity cache (prefer re-assigning same bot to same node for warm state)

### 5.3 Node Identity API
Three HTTP endpoints on each node:

**`POST /node/assign`**
```typescript
interface NodeAssignmentRequest {
  agentId: string;              // bot identity UUID
  personaFile: string;          // path to persona YAML
  agent: string;                // "cline" | "claude-code" | "codex" | "gemini-cli"
  model: string;                // "claude-sonnet-4-6"
  provider: string;             // "bedrock"
  credentials?: Record<string, string>;  // provider-specific auth
  toolAuthorizations?: string[];         // tool IDs with auth modes
  ttlSeconds?: number;          // auto-release after idle period
}

interface NodeAssignmentResponse {
  nodeId: string;
  status: "active";
  subscribedChannels: string[];
}
```

**`POST /node/release`** — clears persona, unsubscribes from agent channel, returns to idle pool.

**`GET /node/status`** — returns current assignment or `idle`, with metrics snapshot.

### 5.4 Assignment Flow
1. Swarm receives work for `code-reviewer` bot
2. Allocator checks `node:pool:active` hash — is `code-reviewer` already loaded?
3. If yes: publish envelope directly to `agent.{code-reviewer-uuid}` stream
4. If no: pop node from `node:pool:idle` set, call `POST /node/assign`, wait for ready, publish envelope
5. Node loads persona, configures agent, subscribes to Redis stream, picks up work
6. Node executes via any-bot wrapper -> agent CLI -> model via provider
7. Result envelope published back to mesh, swarm records cost/metrics
8. If no more work after TTL: node auto-releases, returns to idle pool

---

## 6. Detailed Architecture

### 6.1 Node Lifecycle State Machine
```
IDLE --> ASSIGNING --> ACTIVE --> RELEASING --> IDLE
                         |
                         v
                       FAILED --> IDLE (after cleanup)
```

### 6.2 Redis Registry Schema
```
node:pool:{nodeId}:status          -> "idle" | "assigning" | "active" | "releasing"
node:pool:{nodeId}:assignment      -> JSON { agentId, agent, model, provider, assignedAt }
node:pool:{nodeId}:heartbeat       -> timestamp (EXPIRE-based liveness)
node:pool:idle                     -> Redis SET of idle nodeIds (O(1) SPOP)
node:pool:active                   -> Redis HASH { agentId -> nodeId } (routing lookup)
node:pool:history:{nodeId}         -> Redis LIST of recent assignments (forensics)
```

### 6.3 Node Allocator Service
New file: `src/features/agent-management/services/node-allocator-service.ts`

```typescript
interface NodeAllocatorService {
  assignNode(agentId: string, config: NodeAssignmentRequest): Promise<NodeAssignment>;
  releaseNode(nodeId: string): Promise<void>;
  findNodeForAgent(agentId: string): Promise<string | null>;
  getIdleNodes(): Promise<string[]>;
  detectPendingMessages(): Promise<PendingMessageInfo[]>;
}
```

### 6.4 Hot-Loading Mechanism
The assignment handler replicates what `bot-entrypoint.sh` does at startup, but at runtime:
1. Write persona JSON to `$CONFIG_DIR/bot-persona.json`
2. Reload system prompt (currently cached at module load in `provider-runtime.ts` — needs to become callable)
3. Load tool authorizations from DB via `SwitchFrameworkService.getAgentTools(agentId)`
4. Assemble MCP server config via `ClineSessionRuntimeService.prepareSessionRuntime()`
5. Configure provider credentials for the assigned agent's native config format
6. Create the LLMService instance from the assigned agent's `HARNESS_FACTORIES` entry and config.
7. Rebuild `SwarmAgentWorker` with new channel subscription `agent.{agentId}`
8. Update Redis registry: move nodeId from idle set to active hash
9. Begin consuming from the agent's Redis stream

### 6.5 SwarmAgentWorker Channel Hot-Swap
Current: channels set at construction time, `start()`/`stop()` methods exist.
Required: `stop()` -> rebuild with new channel -> `start()`. The primitives exist — just need a `reassign(newChannel)` method that wraps stop/reconstruct/start.

---

## 7. Tool Architecture

### 7.1 Principle: Tools Stay Native, Swarm Routes to Capabilities

The swarm does NOT inject tools into agents or translate tool formats between agent types. Each bot has tools native to its agent. When a bot needs a capability it doesn't have, the swarm routes a sub-task to the bot that DOES have it and passes the result back as context.

This means a claude-code bot never needs google-search MCP — the swarm sends the search task to a gemini-cli google-bot and feeds the results back. Agent-to-agent collaboration, not tool translation.

### 7.2 Tool Layers Within a Single Agent

Within one bot assignment, tools are configured at three layers:

**Layer 0 — System CLIs:** kubectl, terraform, aws, gcloud, helm, ansible, docker, playwright, etc. Baked into `Dockerfile.bot`. Always available on every node. No per-assignment setup.

**Layer 1 — MCP Servers:** filesystem, fetch, playwright, chroma, plane, google-search, splunk, servicenow. Configured per-session via `ClineSessionRuntimeService.prepareSessionRuntime()` and `buildSessionMcpSettings()`. Already dynamic and per-invocation.

**Layer 2 — Tool Registry Auth Modes:** Per-agent tool authorizations (auto/ask/off) stored in PostgreSQL via `SwitchFrameworkService`. On assignment, the node reads the bot's tool authorizations from the DB.

### 7.3 Agent-Specific Tool Surfaces

Each agent has its own native tool config — the any-bot wrapper translates:
- **Cline:** MCP settings in `~/.cline/mcp_settings.json`
- **Claude Code:** `--allowedTools` CLI flag or `.claude/settings.json`
- **Codex:** `CODEX_INSTRUCTIONS.md` in workspace
- **Non-LLM agents:** Tool = the runtime itself (python interpreter, image generator, API client)

### 7.4 Cross-Agent Tool Access via Swarm Routing

```
code-reviewer (claude-code) needs search results:
  1. code-reviewer asks swarm: "I need web search for CVE-2026-1234"
  2. Swarm routes to research-bot (cline + playwright MCP)
  3. research-bot searches, returns results as text
  4. Swarm feeds results back to code-reviewer as context
  5. code-reviewer never needed playwright — it got the data

data-analyst (python-script) produces charts:
  1. rca-specialist (cline) needs latency visualization
  2. Swarm routes chart request to data-analyst
  3. data-analyst runs matplotlib, returns image path
  4. Swarm feeds path back to rca-specialist
  5. rca-specialist embeds chart reference in RCA document
```

This is why heterogeneous agents work — each excels at its native capabilities, and the swarm composes them.

---

## 8. Metrics, Cost Tracking and Telemetry

### 8.1 Current Implementation
- `TokenCapturingProvider` proxy in `llm-execution-handler.ts` captures real token counts
- `resolveUsageCost()` in `usage-cost-resolver.ts` resolves cost with provider-reported -> model-pricing-fallback chain
- `CostRecordFn` records `{ taskId, agentId, providerId, modelId, inputTokens, outputTokens, cost }`
- `MetricsRecordFn` records `{ agentId, durationMs, outcome, retryCount }`

### 8.2 Node Pool Additions
- Add `nodeId` to all cost and metrics events
- Add `agent` (execution engine) to cost events — distinct from `providerId`
- Telemetry shape becomes:
```typescript
{
  nodeId: string;        // which physical node
  agentId: string;       // which bot identity
  agent: string;         // which execution engine (cline, claude-code, etc.)
  providerId: string;    // which API provider (bedrock, anthropic, groq)
  modelId: string;       // which model (claude-sonnet-4-6, gpt-5.3-codex)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  actualCost: number;
  durationMs: number;
  pricingSource: "provider" | "provider-registry" | "fallback-map" | "none";
}
```
- Broadcast cost summaries via `swarm.broadcast` channel for cockpit dashboard

### 8.3 Pricing Resolution
`usage-cost-resolver.ts` already handles:
- Real cost from provider response (preferred)
- Model-specific pricing from `ProviderRegistry` (fallback)
- Hardcoded fallback maps for Claude and Codex families (last resort)
- Agent provider ID canonicalization (e.g., `harness:codex-cli` -> `openai` for pricing lookup)

No changes needed — just ensure the `agent` field is included so cost dashboards can slice by execution engine.

---

## 9. ADR-034: Generic Node Pool with Hot-Loading Bot Identity

**Status:** Proposed

**Context:**
The per-bot container model (ADR-019) creates 22 always-on containers with ~75% idle time. The provider/harness split (ADR-033) requires registry changes for each new combination. The codebase conflates five independent concepts (bot, agent, model, provider, node) causing override confusion. The `AgentFactoryService` already spawns containers dynamically but at full per-container cost.

**Decision:**
Replace static per-bot containers with a pool of N generic nodes that hot-load bot identities on demand. Establish clean separation: bot (persona), agent (execution engine), model (neural network), provider (API host), node (physical container). The `SWARM_BOT_REGISTRY` becomes a persona catalog, not a container topology. Identity assignment moves from startup env vars to runtime API. Agent/model/provider selection moves from static registry to assignment payload. The any-bot wrapper remains the standard node runtime — it provides metrics, persona injection, tool auth, and cost tracking around raw agent CLIs.

**Consequences:**
- Supersedes ADR-019 per-bot container deployment model
- ADR-033 harness framework preserved but resolution changes from static lookup to assignment-driven
- ADR-005 (Cline CLI as default agent) unchanged — cline remains the default, now explicitly as "default agent" not "default harness"
- `docker-compose.oshal-local.yml` shrinks from ~19 bot service blocks to N generic node blocks
- 56 persona YAMLs in `ai-lab/bot-personas/` all become immediately usable without container provisioning

---

## 10. Impact Analysis

### Files That Change

| File | Change |
|------|--------|
| `src/app/extensions/swarm/swarm-bot-registry.ts` | `SWARM_BOT_REGISTRY` becomes persona catalog. `SwarmBotDefinition` loses `port`, `container`. Gains `defaultAgent`, `defaultProvider`. |
| `src/app/composition/provider-runtime.ts` | `resolveHarnessForAgent()` replaced by assignment-driven factory lookup. `runtimeDefaults.level0SystemPrompt` becomes dynamic (re-evaluated on assign). |
| `scripts/bot-entrypoint.sh` | Gains "pool mode" branch: when `NODE_POOL_MODE=true`, skip persona loading, start server idle, expose `/node/assign` and `/node/release`. |
| `src/features/swarm-orchestration/services/swarm-agent-worker.ts` | Add `reassign(newChannel)` method wrapping stop/reconstruct/start for channel hot-swap. |
| `src/features/swarm-orchestration/services/llm-execution-handler.ts` | Add `nodeId` and `agent` to `CostRecordFn` and `MetricsRecordFn` event shapes. |
| `docker-compose.oshal-local.yml` | Replace ~19 bot service blocks with N `node-{1..N}` generic services. |
| `src/app/server.ts` | Register `/node/assign`, `/node/release`, `/node/status` routes (guarded by `NODE_POOL_MODE`). |

### Files That Stay The Same

| File | Why |
|------|-----|
| `src/features/llm-provider/services/harness-adapter.ts` | `HarnessAdapter`, `HarnessTask`, `HarnessResult`, `HarnessLLMBridge` unchanged. |
| All agent adapter files | All agent adapters unchanged — they already accept config at construction. |
| `src/features/agent-management/services/mesh-communication-service.ts` | `MESH_CHANNELS`, `MeshEnvelope`, `MeshTransport` interface unchanged. |
| `src/features/agent-management/services/redis-mesh-transport.ts` | Redis Streams transport unchanged. `subscribe()`, `consume()`, `ack()` already support dynamic channels. |
| `Dockerfile.bot` | Generic mega-image unchanged. Same image used by pool nodes. |
| `ai-lab/bot-personas/*.yaml` | All persona files unchanged. |
| `src/features/llm-provider/services/usage-cost-resolver.ts` | Cost resolution logic unchanged — just receives new fields. |
| `src/features/tool-registry/services/tool-registry-service.ts` | Tool catalog unchanged. |
| `src/features/tool-switch/services/switch-framework-service.ts` | Tool auth mode service unchanged — called per-assignment instead of per-startup. |
| `src/features/llm-provider/services/cline-session-runtime-service.ts` | `prepareSessionRuntime()` unchanged — called per-assignment instead of once. |

---

## 11. Communication Model

### 11.1 Task Dispatch (swarm to bot)
Allocator checks `node:pool:active` for target agentId. If found, envelope goes directly to `agent.{agentId}` Redis stream. If not found, allocator pops a node from `node:pool:idle`, calls `POST /node/assign`, waits for ready, publishes envelope.

### 11.2 Bot-to-Bot (both loaded)
Direct via `MESH_CHANNELS.agentDirect(targetAgentId)` — identical to today. Both bots are active on nodes, both subscribed to their streams. No change.

### 11.3 Bot-to-Bot (cold target)
Message published to `agent.{targetAgentId}` stream. It sits unconsumed (Redis Streams are durable — `appendonly yes`). Allocator's `detectPendingMessages()` poll scans streams with pending entries and no active consumer. Allocator hot-loads the target bot on an idle node. Target bot's `SwarmAgentWorker` picks up the waiting message via `XREADGROUP`. No message lost.

### 11.4 Broadcast
Published to `swarm.broadcast`. Nodes subscribe to broadcast even when idle — they receive config changes, credential updates (e.g., OpenAI Codex OAuth broadcast via Redis pub/sub), and alerts. Active bot channels (`agent.{agentId}`) are subscribed only when loaded.

### 11.5 Orphan Recovery
`XAUTOCLAIM` already implemented in `redis-mesh-transport.ts`. When a node crashes mid-assignment, messages claimed by its consumer but not ACKed are recovered. Consumer names include nodeId so orphaned messages are attributed correctly.

---

## 12. Workflow Integration

Workflow phases can mix agents, models, and providers freely:

```
Workflow: "Security Audit"
  Phase 1: { bot: "code-reviewer", agent: "cline", model: "claude-opus-4-6", provider: "anthropic" }
           -> scans the repo for vulnerabilities
           
  Phase 2: { bot: "research-bot", agent: "gemini-cli", model: "gemini-3-pro", provider: "google" }
           -> runs the research pass natively on Google's API
           -> OSHAL sees: one envelope in, one result out
           
  Phase 3: { bot: "code-developer", agent: "claude-code", model: "claude-sonnet-4-6", provider: "anthropic" }
           -> applies security patches
           
  Phase 4: { bot: "documentation-writer", agent: "cline", model: "gpt-5.3-codex", provider: "openai-native" }
           -> updates the ADR
```

The swarm handles phase handoffs identically regardless of what agent/model/provider ran inside each phase.

---

## 13. Migration Path

### Phase 0 — Codebase Unification (prerequisite — GATE)
Reconcile frozen any-bot runtime (`oshal/any-bot/`, 6 commits, frozen Mar 12) with open-shal (167 commits, active). Port the any-bot's `LLMProviderRegistry.js` 22-provider catalog into open-shal. Validate that open-shal's reimplemented runtime services (`ClineRuntimeConfigSyncService`, `ClineHarnessProvider`, `agentic-loop.ts`) cover any-bot parity. Fill gaps. Archive frozen any-bot as reference. **Nothing else works until the runtime wrapper is complete in one codebase.**

Key deliverables:
- Canonical 22-provider registry with `buildClineConfig()` / `buildGlobalState()` per provider
- Validated persona injection parity (any-bot `_messagesToTask()` workspace README pattern vs open-shal context file pattern)
- Validated cost/token tracking parity
- Single codebase that can run as standalone any-bot OR as swarm node

### Phase 1 — Node Identity API
Add `/node/assign`, `/node/release`, `/node/status` endpoints to the bot Express server. Guard behind `NODE_POOL_MODE=true` env var. When active, `bot-entrypoint.sh` skips persona loading and starts idle. Purely additive — existing static bots work unchanged.

### Phase 2 — Node Allocator Service
Build `NodeAllocatorService` in the Swarm Controller. Redis registry for node state. Allocator assigns nodes on demand. Run alongside existing static bots for testing.

### Phase 3 — Hybrid Mode
Run 3-5 pool nodes alongside existing static bots. Allocator handles overflow and on-demand bots. Static bots handle their usual personas. Validate that routing, mesh transport, and agent adapters work identically.

### Phase 4 — Full Migration
Remove static bot services from `docker-compose.oshal-local.yml`. Replace with N pool nodes. Update `SWARM_BOT_REGISTRY` to persona catalog only. Update cockpit UI to show node assignments instead of container status.

### Phase 5 — Dynamic Scaling (future)
Kubernetes HPA based on pending message count. Auto-scale node pool up/down. Headscale overlay network (ADR-013, already deployed) enables cross-host node distribution.

---

## 14. Benefits

1. **Resource efficiency** — 5 nodes vs 22 containers = ~75% memory reduction at rest (0.75-1.75GB vs 3.3-7.7GB)
2. **Infinite bot scaling** — 56 personas in `ai-lab/bot-personas/` served by 5 nodes. Adding a new bot = adding a YAML file.
3. **Clean conceptual model** — bot, agent, model, provider, node are five independent axes. No conflation, no override confusion.
4. **Dynamic agent switching** — same node can be cline one minute, claude-code the next. Agent choice per task, not per container.
5. **Operational simplicity** — one compose file with 5 identical services vs 19 unique service blocks. One image to build and deploy.
6. **Cold-start as feature** — rarely-used bots (presentation-bot, business-plan-bot) consume zero resources until summoned.
7. **Workflow flexibility** — phases can mix agents/models/providers freely. gemini-cli in Phase 2, cline in Phase 3, claude-code in Phase 4.

---

## 15. Risks and Mitigations

### 15.1 Cold start latency
**Risk:** Hot-loading persona + tools + subscribing to Redis adds ~2-5 seconds.  
**Mitigation:** Pre-warm frequently-used bots (project-manager, queue-bot always loaded). Allocator maintains affinity cache — prefer re-assigning same bot to same node.

### 15.2 Node starvation
**Risk:** All N nodes busy when new work arrives.  
**Mitigation:** Configurable pool size. Priority-based preemption (release low-priority bot to serve high-priority work). Queue-based backpressure — work waits in Redis stream until a node frees up.

### 15.3 Debugging complexity
**Risk:** Which node was running code-reviewer when the bug happened?  
**Mitigation:** Structured logging includes `{ nodeId, agentId, agent, model, provider }` in every log line. Redis assignment history list (`node:pool:history:{nodeId}`) for forensics.

### 15.4 Persona loading failures
**Risk:** Corrupt YAML, missing file, invalid agent type.  
**Mitigation:** Assignment endpoint validates everything before switching state. Return error to allocator, node stays idle, allocator tries another node.

### 15.5 Message ordering during reassignment
**Risk:** Bot released and re-assigned to different node mid-conversation.  
**Mitigation:** `XREADGROUP` with consumer group ensures messages are not redelivered. Node release ACKs all pending messages. For multi-turn conversations, workspace files and Redis maintain state continuity.

---

## 16. Resource Estimation

| Metric | Current (22 containers) | Proposed (5 pool nodes) |
|--------|------------------------|------------------------|
| RAM at rest | ~3.3-7.7 GB | ~0.75-1.75 GB |
| Node.js processes | 22 | 5 |
| Health check endpoints | 22 | 5 |
| Redis stream consumers | 22 (static) | 5-10 (dynamic) |
| Host port mappings | 22 (3010-3026+) | 5 |
| Docker compose service blocks | 19 | 5 |
| Deploy time (image rebuild) | 22 container restarts | 5 node restarts |
| Bot capacity | 19 wired (of 56 defined) | 56 (all personas usable) |

---

## 17. Open Questions

1. **Affinity vs round-robin:** Should the allocator prefer re-assigning a bot to the same node (warm cache, credentials loaded)? Or pure availability-based?

2. **Pre-warming policy:** Which bots should always be loaded? How many nodes reserved for pre-warmed bots vs available for on-demand?

3. **TTL auto-release:** Should bots auto-release after N minutes of inactivity? What timeout? How does this interact with ongoing ticket conversations where a bot might be idle between phases?

4. **Per-bot settings volumes:** Current model uses per-bot named volumes (`project-manager-settings`, etc.). Node pool nodes share volumes per node. How are per-bot settings preserved across assignments? Options: Redis-backed, shared NFS, per-bot subdirectories on node volume.

5. **Kubernetes deployment model:** Pool nodes as Deployment with HPA, or StatefulSet? HPA scales on pending Redis stream message count.

6. **AgentFactoryService interaction:** `deployWithContainer()` currently creates a new Docker container. In node pool model, factory creates persona + assigns to pool node. `deployPersonaOnly()` becomes the default path.

7. **Cockpit UI:** Current cockpit shows per-bot container status. Node pool needs: node status view (which bot is loaded where), bot catalog view (all personas, currently loaded or not), assignment history.

8. **Open-source codex fork:** Which fork? How to integrate alongside official codex? Same node image or separate node class?

9. **Agent adapter interface formalization:** Should `HarnessAdapter` be renamed to `AgentAdapter`? Should it gain `validateAssignment(model, provider)` and `configureCredentials(provider, credentials)` methods?

# OSHAL Reference

Operational and architectural reference. The [README](../README.md) is the
landing page; this is the detail you reach for once you're running.

- [Architecture](#architecture)
- [Authentication & Credentials](#authentication--credentials)
- [Bot Registry & Mix-Mode](#bot-registry--mix-mode)
- [Workflow Pipelines](#workflow-pipelines)
- [Docker Compose Services](#docker-compose-services)
- [Project Structure](#project-structure)
- [Envelope Lifecycle](#envelope-lifecycle)
- [Cost Tracking](#cost-tracking)
- [Environment Variables](#environment-variables)
- [Testing](#testing)
- [Key Design Decisions](#key-design-decisions)

---

## Architecture

```
LAYER 4: UI
  Cockpit (operator dashboard)     http://localhost:35457
  Code Server (workspace browser)  http://localhost:8444

LAYER 3: SWARM CONTROLLER (oshal-api container, BOT_RUNTIME=swarm)
  Queue Manager      — polls tickets, dispatches to pipeline
  Phase Routing      — selects bot per phase (capability + competency ranking)
  Mesh Transport     — Redis Streams (XADD/XREADGROUP) for envelope delivery
  Ticket Service     — CRUD, status, lifecycle, cost rollup
  Cockpit API        — REST surface for the UI

  Runs: node dist/app/server.js
  NEVER calls an LLM. Orchestrates only.

LAYER 2: BOT NODES (worker containers, BOT_RUNTIME=bot-node)
  SwarmAgentWorker   — consumes envelopes from agent.{agentId} Redis channel
  BotNodeHandler     — assembles prompt (persona + handovers + awareness)
  Any-bot Providers  — ClineProvider, ClaudeCodeProvider (credential mgmt, CLI spawning)
  TaskController     — routes to active provider, captures cost/tokens
  Heartbeat          — registers at oshal:runtime-agent:{agentId} every 30s

  Runs: node dist/app/bot-node-server.js
  Owns ALL LLM execution. Self-sufficient.

LAYER 1: AGENT HARNESSES
  Cline CLI          — provider catalog via LLMProviderRegistry
  Claude Code CLI    — Anthropic models (OAuth or API key)
  Codex CLI          — OpenAI models
  Gemini CLI         — Google Gemini models

LAYER 0: API PROVIDERS
  Anthropic, OpenAI, Bedrock, Gemini, Groq, Azure, Vertex,
  Mistral, DeepSeek, xAI, Together, Fireworks, Ollama, ...
  Provider catalog resolved by the active harness registry.
```

---

## Authentication & Credentials

### Claude Code (Anthropic models)

**Option A — Browser OAuth (recommended for local dev):**
1. Open cockpit: http://localhost:35457
2. Go to Settings > Provider Configuration
3. Select "Claude Code" from the provider dropdown
4. Click "Sign In" — opens browser auth flow
5. After auth, all claude-code harness bots can use Anthropic models

**Option B — API key:**
```bash
# In .env or docker-compose environment:
ANTHROPIC_API_KEY=sk-ant-...
```

**Status check:**
```bash
curl http://localhost:35457/api/claude-code/auth/status
# Returns: { authenticated: true/false, email, orgName, ... }
```

### OpenAI / Codex

```bash
# In .env:
OPENAI_API_KEY=sk-...
```

Codex CLI reads `~/.codex/auth.json` (mounted read-only into containers via `x-codex-auth-volume`).

### Provider switching at runtime

The cockpit provider dropdown switches all bots. Per-bot overrides use the `harnessType` field in the bot registry.

```bash
# Switch provider via API
curl -X PUT http://localhost:35457/api/config/provider \
  -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","model":"claude-sonnet-4-6"}'
```

---

## Bot Registry & Mix-Mode

Each bot declares its harness type and API provider in `src/app/extensions/swarm/swarm-bot-registry.ts`:

| Bot | Harness | Provider | Role |
|-----|---------|----------|------|
| project-manager | (process default) | — | Planning, decomposition |
| code-developer | codex-cli | openai-codex | Implementation |
| code-reviewer | claude-code | anthropic | Code review, security |
| test-engineer | cline | openai-native | Testing, validation |
| documentation-writer | cline | gemini | Docs, READMEs |
| architect-bot | claude-code | anthropic | Architecture, design |
| research-bot | gemini-cli | gemini | Research, analysis |
| rca-specialist | cline | (process default) | Incident investigation |
| queue-bot | (process default) | — | Quality review |

Bots without `harnessType` use the process-level `FORCE_LLM_PROVIDER` (default: openai-codex).

---

## Workflow Pipelines

### Build Pipeline (`ticketType: 'build'`)

7-phase lifecycle with gated progression:

```
Phase 1  INTAKE       — ticket analysis, complexity scoring
Phase 2  PLANNING     — PM decomposes into subtasks (2-7 children)
Phase 3  SPECIALIST   — domain expert injects context
Phase 4  EXECUTION    — worker bot builds the deliverable
Phase 5  TESTING      — tester bot validates against acceptance criteria
Phase 6  REVIEW       — consensus review (APPROVED / NEEDS REVISION)
Phase 7  DELIVERY     — status update, cost aggregation
```

Low-complexity tickets skip phases 3, 5, 6 (4 phases: intake, planning, execution, delivery).

### Incident Pipeline (`ticketType: 'incident'`)

3-phase RCA with worker + reviewer:

```
Phase 1  WORKER       — rca-specialist investigates, writes deliverables
Phase 2  REVIEW       — queue-bot reviews (APPROVED / REVISION-REQUIRED)
Phase 3  REVISION     — worker addresses feedback (if needed)
```

Deliverables: `RCA-REPORT.md`, `IMPACT-ASSESSMENT.md`, `REMEDIATION-STEPS.md`, `scripts/diagnose.sh`, `scripts/remediate.sh`, `scripts/rollback.sh`.

---

## Docker Compose Services

### Infrastructure

| Service | Port | Purpose |
|---------|------|---------|
| oshal-db | 55433 | PostgreSQL — tickets, agents, work items, cost |
| oshal-redis | 56380 | Redis — mesh transport, heartbeats, config |
| oshal-chromadb | 58001 | ChromaDB — RAG, swarm memory |
| code-server | 8444 | Workspace file browser |

### Swarm Controller

| Service | Port | Runtime |
|---------|------|---------|
| oshal-api | 35457 | `BOT_RUNTIME=swarm` — queue manager, cockpit, API |

### Bot Nodes

| Service | Port | Harness |
|---------|------|---------|
| task-manager | 3040 | (default) |
| code-developer | 3041 | codex-cli |
| devops-bot | 3042 | (default) |
| code-reviewer | 3043 | claude-code |
| documentation-writer | 3044 | cline/gemini |
| rca-specialist | 3045 | cline |
| system-architect | 3047 | claude-code |
| test-engineer | 3048 | cline/openai |
| queue-bot | 3055 | (default) |

---

## Project Structure

```
src/
  app/
    server.ts                    — swarm controller entrypoint
    bot-node-server.ts           — bot node entrypoint (slim, ~200 lines)
    bot-node-execution-handler.ts — bridges TS envelope to JS any-bot provider
    composition-root.ts          — DI container for swarm controller
    extensions/swarm/            — swarm boot, worker, routes, bot registry
    routes/                      — cockpit, config, API routes

  features/
    swarm-orchestration/         — queue manager, phase routing, execution handler
    agent-management/            — mesh transport, heartbeat, bot registry, router
    llm-provider/                — harness adapter interface, provider catalog
    ticketing/                   — ticket CRUD, cost rollup
    operational-intelligence/    — cost tracking, metrics, competency ranker
    intake/                      — ticket intake from Plane and GitHub
    chat-orchestration/          — /chat direct + agentic modes
    tool-registry/               — MCP tool catalog, DB migrations

  entities/
    agent/, ticket/, tool/, work-item/, workspace/

  pages/
    cockpit/                     — operator dashboard
    chat/                        — standalone chat UI
    swarm-control/               — swarm control panel

any-bot/server/
  services/llm/
    ClineProvider.js             — Cline CLI agent (registry-backed providers)
    ClaudeCodeProvider.js        — Claude Code CLI agent
    LLMProviderRegistry.js       — buildClineConfig/buildGlobalState per provider
  services/codebase/
    ClineCLIWrapper.js           — subprocess management
    ClaudeCodeCLIWrapper.js      — subprocess management
  controllers/
    TaskController.js            — message routing, workspace management
    AgenticController.js         — multi-turn agentic loop
  stores/                        — TaskStore, MessageStore (SQLite)

scripts/
  bot-entrypoint.sh              — BOT_RUNTIME switch (swarm | bot-node | any-bot)
  setup-cline-auth.sh            — Cline CLI credential setup
  migrations/                    — Postgres schema migrations

ai-lab/bot-personas/             — 68 persona YAML files
config-seed/                     — shared config (global-config.json, secrets.json)
```

---

## Envelope Lifecycle

How work flows from ticket to execution:

```
1. QueueManagerService polls for approved tickets (15s dev / 60s prod)
2. SwarmTicketProcessingService decomposes ticket, selects agents
3. meshService.send(envelope) → Redis XADD to oshal:mesh:agent.{agentId}
4. Bot node's SwarmAgentWorker polls XREADGROUP on its channel
5. BotNodeExecutionHandler assembles prompt (persona layers + user message)
6. any-bot TaskController.processMessage() routes to ClineProvider/ClaudeCodeProvider
7. Provider spawns CLI subprocess, captures output + tokens + cost
8. Worker ACKs envelope (XACK), records result to work_items table
9. Swarm controller detects completion, advances to next phase
```

---

## Cost Tracking

Every LLM call records cost to the `chat_tasks` table. The cockpit cost tab shows total cost, tokens, requests, cost-by-bot (with provider column), and cost-by-model.

```bash
# Query cost for a ticket
curl http://localhost:35457/api/tickets/{ticketId}/activity
```

---

## Environment Variables

### Required

| Variable | Default | Purpose |
|----------|---------|---------|
| `REDIS_URL` | `redis://oshal-redis:6379` | Redis for mesh + heartbeats |
| `DATABASE_URL` | — | Postgres connection string |
| `BOT_RUNTIME` | `swarm` | `swarm` (controller) or `bot-node` (worker) |

### LLM Providers

| Variable | Default | Purpose |
|----------|---------|---------|
| `FORCE_LLM_PROVIDER` | `openai-codex` | Default provider |
| `FORCE_LLM_MODEL` | `gpt-5.3-codex` | Default model |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `CLAUDE_CODE_MODEL` | `claude-sonnet-4-6` | Model for claude-code bots |

### Bot Identity

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_ID` | — | Bot UUID (must match registry) |
| `BOT_NAME` | — | Bot display name |
| `BOT_PERSONA_FILE` | — | Path to persona YAML |

### Update Check ([runbook](runbooks/update-check.md))

| Variable | Default | Purpose |
|----------|---------|---------|
| `UPDATE_CHECK_ENABLED` | on | `0` disables the daily update-check daemon |
| `UPDATE_CHECK_INTERVAL_HOURS` | `24` | check cadence (min 1) |
| `UPDATE_CHECK_CORE_REPO` | `emeraldcoastsystemsgroup/oshal` | upstream repo for the core check |
| `UPDATE_CHECK_CORE_BRANCH` | `main` | upstream branch for the core check |
| `OSHAL_STORE_TOKEN` | — | opt-in GitHub PAT: private-store version checks + applies (fallback: `GITHUB_TOKEN`) |
| `GIT_SHA` | baked | running commit, baked by `oshal-deploy.sh` — surfaced at `GET /api/version` |

---

## Testing

```bash
# Type check
npx tsc --noEmit

# All tests
FORCE_LLM_PROVIDER=noop npx playwright test

# Specific suite
npx playwright test tests/swarm-e2e-pipeline.spec.ts
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Bot nodes run their own SwarmAgentWorker | Each bot consumes its own Redis envelopes — no proxy bottleneck |
| Any-bot providers (JS) for LLM execution | ClineProvider backed by the runtime provider registry |
| Swarm controller never calls an LLM | Clean separation: orchestration vs execution |
| One Docker image, runtime switch | `bot-entrypoint.sh` reads `BOT_RUNTIME` to select entrypoint |
| UUID-based agent IDs everywhere | Compose, registry, Redis, DB — same UUID, no mismatch |
| No AWS Polly in bot nodes | TTS is a future pluggable harness, not hardcoded to one vendor |

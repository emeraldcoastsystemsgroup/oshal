# OSHAL Product Architecture

**Date:** 2026-04-18  
**Status:** Validated foundation, full design defined

---

## The Product

A user defines a workflow. A ticket is assigned to that workflow. OSHAL creates a unique bot swarm for that ticket, executes the workflow phases, and delivers the result.

Each bot in the swarm can use a different agent harness (cline, claude-code, codex, gemini-cli) with a different API provider (OpenAI, Anthropic, Google, Groq, etc.) and a different model. The bots collaborate via A2A mesh communication. The swarm controller manages the lifecycle.

---

## Layer Model

```
┌─────────────────────────────────────────────────────────┐
│ LAYER 4: USER INTERFACE                                 │
│                                                         │
│  Cockpit UI          Workflow Designer    Chat UI        │
│  (operator view)     (define workflows)  (talk to bots) │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│ LAYER 3: SWARM CONTROLLER                               │
│                                                         │
│  Workflow Engine     Queue Manager     Phase Gates       │
│  (per-ticket swarm)  (generic queue)   (gating logic)   │
│                                                         │
│  Ticket Service      Cost Rollup       Bot Registry     │
│  (CRUD, lifecycle)   (per-ticket)      (capabilities)   │
│                                                         │
│  Node Allocator      Redis Mesh        Cockpit API      │
│  (pool management)   (infrastructure)  (REST surface)   │
│                                                         │
│  Runs: node dist/app/server.js                          │
│  NEVER calls an LLM. Orchestrates only.                 │
└────────────────────────┬────────────────────────────────┘
                         │
                   HTTP + Redis Mesh
                         │
┌────────────────────────▼────────────────────────────────┐
│ LAYER 2: BOT NODES (any-bot runtime)                    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Any-bot runtime (node any-bot/server/app.js)    │    │
│  │                                                 │    │
│  │  Agent Harnesses:                               │    │
│  │    ClineProvider      → any of 22 providers     │    │
│  │    ClaudeCodeProvider → Anthropic               │    │
│  │    (future) CodexProvider, GeminiProvider        │    │
│  │                                                 │    │
│  │  Self-managed:                                  │    │
│  │    Provider config    (LLMProviderRegistry)     │    │
│  │    Credentials        (_ensureModelConfig)      │    │
│  │    Persona loading    (YAML → context files)    │    │
│  │    Tool management    (MCP, built-in, dynamic)  │    │
│  │    Cost/token capture (per-task metrics)         │    │
│  │                                                 │    │
│  │  Mesh-aware:                                    │    │
│  │    A2A communication  (Redis mesh envelopes)    │    │
│  │    Registry client    (discover other bots)     │    │
│  │    Workspace access   (shared deliverables)     │    │
│  │                                                 │    │
│  │  API surface:                                   │    │
│  │    POST /api/tasks, /api/tasks/:id/messages     │    │
│  │    PUT  /api/llm-provider, /api/settings        │    │
│  │    GET  /api/health, /api/llm-provider/registry │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  Runs: node any-bot/server/app.js                       │
│  Owns ALL LLM execution. Self-sufficient.               │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│ LAYER 1: AGENT HARNESSES                                │
│                                                         │
│  cline CLI         claude CLI       codex CLI           │
│  (22 providers)    (Anthropic)      (OpenAI)            │
│                                                         │
│  gemini-cli        (future agents)                      │
│  (any API)                                              │
│                                                         │
│  Each harness wraps an agent. The agent calls the API.  │
│  The any-bot runtime wraps the harness.                 │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│ LAYER 0: API PROVIDERS                                  │
│                                                         │
│  Anthropic   OpenAI    Google Gemini                   │
│  Bedrock     Azure     Groq          DeepSeek           │
│  Vertex      Mistral   xAI           Ollama (local)     │
│  OpenRouter  Together  Fireworks     Cerebras           │
│  SambaNova   Nebius    AskSage       LiteLLM            │
│  Requesty                                               │
│                                                         │
│  22 providers. Any model on any provider.               │
└─────────────────────────────────────────────────────────┘
```

---

## Workflow Lifecycle

```
1. USER DEFINES WORKFLOW
   "Security Audit" with 3 phases:
     Phase 1: research-bot    / gemini-cli  / gemini
     Phase 2: code-reviewer   / claude-code / anthropic
     Phase 3: rca-specialist  / cline       / openai

2. TICKET ASSIGNED TO WORKFLOW
   "Audit the node pool API for vulnerabilities"
   → ticket.ticketType = "security-audit"
   → ticket.status = "approved"

3. SWARM CONTROLLER CREATES SWARM INSTANCE
   → unique swarm run ID
   → provisions queue for this ticket
   → hot-loads (or finds) the 3 bots from the node pool
   → configures each bot via any-bot API:
       PUT /api/llm-provider → set agent harness + API + model
       PUT /api/settings     → set persona + workspace
   → bots are now autonomous for this ticket

4. PHASE EXECUTION (gated)
   Phase 1:
     → controller sends task to research-bot via HTTP
     → research-bot executes via gemini-cli + gemini
     → result written to workspace: PHASE-1-RESEARCH.md
     → controller gate: Phase 1 complete → unlock Phase 2

   Phase 2:
     → controller sends task to code-reviewer
     → includes Phase 1 output as context
     → code-reviewer executes via claude-code + anthropic
     → result: PHASE-2-ANALYSIS.md
     → during execution, code-reviewer may A2A to research-bot:
         "Can you search for CVE-2026-1234 details?"
       → mesh envelope, research-bot responds, code-reviewer continues

   Phase 3:
     → controller sends task to rca-specialist
     → includes Phase 2 output as context
     → rca-specialist executes via cline + openai
     → result: PHASE-3-REMEDIATION.md

5. TICKET COMPLETION
   → all phases done
   → controller aggregates costs across 3 bots
   → deliverables in workspace
   → ticket status = "complete"
   → bots release back to pool (or continue serving)
```

---

## Vocabulary

```
Bot             = persona + role + capabilities (who to be)
Agent Harness   = execution engine (cline, claude-code, codex, gemini-cli)
Model           = neural network (claude-sonnet-4-6, gpt-5.3-codex, gpt-4.1)
Provider        = API host (anthropic, openai-native, gemini)
Node            = generic container running any-bot runtime
Swarm           = orchestrator managing bots for a workflow
Workflow        = user-defined sequence of phases with bot assignments
Swarm Instance  = one execution of a workflow for one ticket
OSHAL           = the swarm orchestrator (not a harness, not a bot)
```

---

## What Was Validated (2026-04-18)

```
PROVEN:
  ✓ Any-bot runtime runs on nodes (node any-bot/server/app.js)
  ✓ 3 different agent harnesses in one pipeline
  ✓ 3 different API providers in one pipeline
  ✓ OpenAI / gpt-4.1                         → completed, 150 tokens
  ✓ Claude Code / claude-sonnet-4-6           → completed, 150 tokens
  ✓ OpenAI Native / gpt-5.3-codex            → completed, 150 tokens
  ✓ Any-bot self-configures provider from env + seeds
  ✓ OAuth token extraction from macOS Keychain → container
  ✓ Persona loading from YAML → agent context files
  ✓ Provider catalog (26 providers) ported and tested
  ✓ Per-provider config builders (buildClineConfig/buildGlobalState)
  ✓ Node pool API (assign/release/status)
  ✓ Node allocator service (Redis registry)
  ✓ Multi-harness workflow definition (WORKFLOW_PIPELINES)

NOT YET CONNECTED:
  - Swarm persona layers → any-bot HTTP request body
  - MCP server configuration on any-bot nodes
  - Switch framework tool auth on any-bot nodes
  - Swarm memory / RALF handovers → any-bot prompts
  - A2A mesh client in any-bot runtime
  - Per-ticket swarm instances
  - Full cost reporting from any-bot → swarm
  - All 13 remaining bots retrofitted to any-bot runtime
  - Workflow designer UI
```

---

## Key Files

```
Any-bot runtime:
  any-bot/server/app.js                          — the runtime entry (~314 code lines; startup + route groups in app-modules/)
  any-bot/server/services/llm/ClineProvider.js   — cline agent harness
  any-bot/server/services/llm/ClaudeCodeProvider.js — claude-code agent harness
  any-bot/server/services/llm/LLMProviderRegistry.js — 22 providers
  any-bot/server/services/codebase/ClineCLIWrapper.js — CLI subprocess management
  any-bot/server/controllers/AgenticController.js — multi-turn execution

Swarm controller:
  src/features/swarm-orchestration/              — queue, routing, phases
  src/features/agent-management/                 — mesh, registry, allocator
  src/app/extensions/swarm/                      — boot, worker, routes
  src/app/composition/provider-runtime.ts        — harness factory (legacy, being deprecated)

Infrastructure:
  scripts/bot-entrypoint.sh                      — BOT_RUNTIME switch
  Dockerfile.oshal                               — both runtimes in one image
  docker-compose.oshal-local.yml                 — container definitions
  config-seed/secrets.json                       — shared credentials
  ai-lab/bot-personas/*.yaml                     — persona definitions
```

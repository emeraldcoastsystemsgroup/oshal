# Any-Bot Migration Impact Assessment

**Date:** 2026-04-18  
**Scope:** Every LLM touchpoint in the swarm, mapped to migration impact

---

## Executive Summary

There are **8 direct LLM call sites** in the swarm codebase. Of these:
- **1 is already HTTP** (incident RCA pipeline — proof the pattern works)
- **4 are direct `provider.sendRequest()` calls** (must migrate)
- **3 are CLI subprocess calls** (already abstracted, similar migration)

The critical path is **ONE function**: `LLMExecutionHandler` at `llm-execution-handler.ts:222`. Every build ticket, every child task, every verification, every consensus review flows through this single call to `agent.processMessage()`. Migrating this one touchpoint covers the entire ticket pipeline.

---

## All LLM Touchpoints

### TIER 1 — Must Migrate (Direct LLM Calls)

| # | Touchpoint | File | What It Does | Covers |
|---|-----------|------|-------------|--------|
| 1 | **LLMExecutionHandler** | `llm-execution-handler.ts:222` | `agent.processMessage()` | ALL ticket work: build, child tasks, verification, review |
| 2 | **TaskOrchestrator.processDirect** | `task-orchestrator.ts:219` | `provider.sendRequest()` | /chat direct mode (single-shot) |
| 3 | **AgenticLoop.callProvider** | `agentic-loop.ts:194` | `provider.sendRequest()` | /chat agentic mode (multi-turn tool use) |
| 4 | **ProcessLabService** | `process-lab-service.ts:774` | `provider.sendRequest()` | Trace AI assessment (optional) |

### TIER 2 — Should Migrate (CLI Subprocess Calls)

| # | Touchpoint | File | What It Does | Covers |
|---|-----------|------|-------------|--------|
| 5 | **HavenPersonaService** | `haven-persona-service.ts:208` | `provider.sendRequest()` | Haven voice fallback (priority 3) |
| 6 | **codexQuickCall** | `codex-quick-call.ts:48` | `spawn(codex exec)` | Agent routing LLM selection |
| 7 | **FastIntakeService** | `fast-intake-service.ts` | `codex exec` subprocess | Quick ticket intake |

### ALREADY HTTP (No Migration Needed)

| # | Touchpoint | File | What It Does | Covers |
|---|-----------|------|-------------|--------|
| 8 | **Incident RCA Pipeline** | `queue-manager-service.ts:1330+` | `fetch(/api/send-message)` | Incident worker + reviewer dispatch |

---

## Impact on Each Process

### Build Pipeline (ticketType: 'build')

```
Phase 1 INTAKE        → codexQuickCall (Tier 2) — agent routing
Phase 2 PLANNING      → LLMExecutionHandler (Tier 1) — PM decomposes
Phase 3 SPECIALIST    → LLMExecutionHandler (Tier 1) — domain expert
Phase 4 EXECUTION     → LLMExecutionHandler (Tier 1) — specialist builds
Phase 5 TESTING       → LLMExecutionHandler (Tier 1) — verification
Phase 6 REVIEW        → LLMExecutionHandler (Tier 1) — consensus review
Phase 7 DELIVERY      → No LLM call (status update, writeback)
```

**Impact:** Migrating LLMExecutionHandler (#1) covers Phases 2-6. Migrating codexQuickCall (#6) covers Phase 1 routing. Phase 7 has no LLM call. **Full build pipeline covered by 2 migrations.**

### Incident Pipeline (ticketType: 'incident')

```
Phase 1 WORKER        → Already HTTP (/api/send-message)
Phase 2 REVIEWER      → Already HTTP (/api/send-message)
Phase 3 REVISION      → Already HTTP (/api/send-message)
```

**Impact: NONE. Already migrated.** The incident pipeline already calls `/api/send-message` via HTTP. This is the proof that the pattern works in production.

### Multi-Harness Pipeline (ticketType: 'security-audit')

```
Phase 1 RESEARCH      → dispatchMultiHarnessTicket → HTTP /api/send-message
Phase 2 ANALYSIS      → dispatchMultiHarnessTicket → HTTP /api/send-message
Phase 3 REMEDIATION   → dispatchMultiHarnessTicket → HTTP /api/send-message
```

**Impact: NONE.** The multi-harness pipeline we built in this session already uses HTTP calls. It was designed correctly from the start.

### Chat (/chat UI)

```
Direct mode   → TaskOrchestrator.processDirect (Tier 1)
Agentic mode  → AgenticLoop.callProvider (Tier 1)
```

**Impact:** Migrating TaskOrchestrator (#2) and AgenticLoop (#3) covers chat. BUT — the /chat UI is served by the any-bot itself, so when the any-bot runs on the node, /chat goes directly to the any-bot's own TaskController. **No swarm involvement needed for /chat.**

### Haven Voice

```
Priority 1: Codex exec (subprocess — Tier 2)
Priority 2: Claude Code CLI (subprocess — Tier 2)
Priority 3: Cline fallback (direct call — Tier 1)
```

**Impact:** Haven can call the any-bot's `/api/send-message` endpoint instead. One HTTP call replaces three fallback paths.

---

## Will Hot-Loading Still Work?

**Yes.** The any-bot has these endpoints:

| Endpoint | Purpose | Hot-Load Use |
|----------|---------|-------------|
| `PUT /api/llm-provider` | Switch provider + model | Allocator calls this when assigning a bot to a provider |
| `PUT /api/settings` | Update bot config | Allocator calls this to push persona/config |
| `GET /api/llm-provider` | Current provider status | Allocator checks what provider the node is running |
| `GET /api/llm-provider/registry` | All 22 providers | Cockpit populates dropdown from this |
| `POST /api/send-message` | Execute task | Swarm dispatches work here |
| `GET /api/health` | Liveness check | Allocator monitors node health |

The hot-load flow becomes:

```
Allocator assigns node:
  1. PUT  /api/settings      → push persona YAML / bot identity
  2. PUT  /api/llm-provider  → switch to assigned provider/model
     Any-bot internally:
       → LLMProviderRegistry.buildClineConfig()
       → LLMProviderRegistry.buildGlobalState()
       → _ensureModelConfig() safety net
       → Cline CLI config updated
  3. POST /api/send-message  → execute first task
     Any-bot internally:
       → ClineProvider._messagesToTask()
       → ClineCLIWrapper.executeTask()
       → Token/cost capture
       → Response returned

Allocator releases node:
  1. PUT /api/settings       → clear persona
  2. Node returns to idle pool
```

The swarm never touches `~/.cline/config.json`. The any-bot handles all of it.

---

## What Changes in Each Process

### Build Pipeline Changes

| Phase | Before (broken) | After (correct) |
|-------|-----------------|-----------------|
| Routing | codexQuickCall spawns subprocess | POST to any-bot `/api/send-message` on any available node |
| Planning | LLMExecutionHandler → agent.processMessage → ClineHarnessProvider → spawn cline | POST to PM node `/api/send-message` |
| Execution | Same broken chain | POST to worker node `/api/send-message` |
| Testing | Same broken chain | POST to tester node `/api/send-message` |
| Review | Same broken chain | POST to reviewer node `/api/send-message` |

### Incident Pipeline Changes

**NONE.** Already uses HTTP.

### Chat Changes

| Before | After |
|--------|-------|
| TaskOrchestrator → getProvider → ClineHarnessProvider → spawn cline | User hits /chat on the bot node directly. Any-bot handles it end-to-end. No swarm involvement. |

If chat goes through the swarm controller (cockpit routes), the swarm just proxies to the bot node's `/api/send-message`.

---

## Migration Effort Estimate

### Minimal Viable Migration (covers all ticket processes)

| Change | Effort | Covers |
|--------|--------|--------|
| Modify `LLMExecutionHandler` to POST to bot node HTTP instead of `agent.processMessage()` | 1 function, ~50 lines | All build/ticket phases |
| Modify `SwarmAgentWorker` to resolve bot node endpoint from registry | 1 function, ~20 lines | Node endpoint resolution |
| Keep incident pipeline as-is | 0 lines | Already HTTP |
| Keep multi-harness pipeline as-is | 0 lines | Already HTTP |

**Total: ~70 lines of code change to migrate all ticket processes.**

### Full Migration (covers chat + haven + routing)

| Change | Effort | Covers |
|--------|--------|--------|
| Proxy `/api/send-message` on swarm controller to bot nodes | 1 route, ~30 lines | Chat through swarm |
| Modify `codexQuickCall` to POST instead of subprocess | 1 function, ~20 lines | Agent routing |
| Modify Haven to POST instead of direct call | 1 function, ~15 lines | Voice interface |
| Bot nodes run any-bot (`node any-bot/server/app.js`) | `bot-entrypoint.sh` change, ~5 lines | Node runtime |
| Bring any-bot/server/ back into repo | Copy from oshal, 0 new code | Bot runtime |

**Total: ~140 lines of code change + any-bot copy.**

### What Gets DELETED

| File | Lines | Why |
|------|-------|-----|
| `claude-code-provider.ts` | 942 | Reimplementation of ClineProvider.js |
| `cline-cli-wrapper.ts` | 91 | Reimplementation of ClineCLIWrapper.js |
| `cline-runtime-config-sync-service.ts` | 850 | Reimplementation of LLMProviderRegistry |
| `cline-session-runtime-service.ts` | 250 | Session config that any-bot owns |
| `claude-code-cli-provider.ts` | ~200 | Reimplementation |
| `codex-cli-provider.ts` | ~200 | Reimplementation |
| `agentic-loop.ts` | ~400 | Reimplementation of AgenticController.js |
| **TOTAL DELETED** | **~2,933** | Reimplemented any-bot code |

**Net: delete ~2,933 lines, add ~140 lines. The codebase gets simpler.**

---

## Risk Assessment

### Low Risk
- **Incident pipeline**: Already HTTP. No change.
- **Multi-harness pipeline**: Already HTTP. No change.
- **Build pipeline Phases 2-6**: All flow through one function (LLMExecutionHandler). One change.

### Medium Risk
- **Chat (/chat UI)**: Currently runs in the swarm process. After migration, runs in the any-bot process on the node. The chat experience should be identical, but routing changes (user hits the bot node directly, or swarm proxies).
- **Provider switching**: Currently done by writing config files. After migration, done by calling `PUT /api/llm-provider` on the any-bot. The any-bot already supports this — tested and proven.

### Things to Validate
- Any-bot's `POST /api/process-ticket` — does it handle the full ticket payload format the swarm sends?
- Any-bot's persona loading — does it read the same `ai-lab/bot-personas/*.yaml` format?
- Any-bot's MCP server management — does it support the same tools the swarm configures?
- Any-bot's response format — does `{ success, response, usage, cost }` match what the swarm expects?

---

## Conclusion

The migration is **small in code** (~140 lines changed, ~2,933 deleted) and **large in impact** (fixes the credential management problem, the provider/harness confusion, and the hot-loading architecture). The incident pipeline already proves the pattern works. The build pipeline flows through one function that needs one change. Chat moves to the any-bot where it belongs.

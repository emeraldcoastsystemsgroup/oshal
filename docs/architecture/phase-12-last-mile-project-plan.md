/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Phase 12 Last Mile project plan
 */

# Phase 12 — Last Mile Project Plan

## Purpose

Define the end-state delivery plan for making the OSHAL swarm production-ready with:
- Stable 14-bot default swarm
- Switch framework integration per bot
- Dynamic bot on/off from cockpit
- Dynamic tool loading and registration
- Schema-driven config UI

This plan supersedes ad-hoc feature requests and consolidates all remaining work into ordered sessions.

## Baseline (Session 1 — Complete)

- 14 bots running by default on ports 3010–3025 (minus 3019, 3024)
- 2 bots commented out as on-demand extras (incident-response-bot, business-plan-bot)
- Infrastructure: Redis, Postgres, ChromaDB, Google Search MCP, code-server
- Compose config validated

## Session Plan

### Session 2: Switch Framework Audit & Wiring

**Goal**: Verify what switch framework work already exists in the legacy codebase and OSHAL, then wire it end-to-end.

**Pre-work**: Read the battle-tested any-bot layer (inherited from the legacy codebase):
- `any-bot/server/services/ToolRegistry.js`
- `any-bot/server/services/queue-manager/DynamicToolManager.js`
- `any-bot/server/services/AgentConfigManager.js`

**OSHAL existing code**:
- `src/features/tool-switch/services/switch-framework-service.ts`
- `src/features/tool-switch/controllers/agent-tool-controller.ts`
- `src/app/routes/agent-tool-routes.ts`

**Work**:
1. Audit switch framework completeness — what's wired, what's dead code
2. Verify `auto|ask|off` state persists and restores
3. Wire default tool assignments per bot persona
4. Ensure selector recomposition fires on switch changes
5. Verify switch state appears in `/config/` UI per bot

**Acceptance**: Every bot in the 14-bot swarm has correct default switch settings and they persist across restart.

---

### Session 3: Bot Enable/Disable API + Cockpit Toggle

**Goal**: Operator can turn bots on/off from the cockpit.

**Work**:
1. Add `enabled` field to bot registry (Postgres `agents` table or new `bot_registry`)
2. API endpoints:
   - `GET /api/swarm/bots` — list all personas with enabled status
   - `PATCH /api/swarm/bots/:botId/enable`
   - `PATCH /api/swarm/bots/:botId/disable`
3. Cockpit bot management panel with toggle switches
4. Show health status per bot (up/down/starting)
5. Seed 14 core bots as `enabled: true`, extras as `enabled: false`

**Acceptance**: Operator can see all bots and toggle them on/off in the cockpit.

---

### Session 4: Dynamic Bot Container Spawning

**Goal**: When a bot is enabled via cockpit, it actually starts a container.

**Work**:
1. Bot spawner service — `docker compose up <bot-name>` for registered bots
2. On enable → spawn container with stem-cell pattern + correct persona YAML
3. On disable → graceful container stop
4. Port assignment from pool (3010–3050)
5. Container lifecycle monitoring

**Acceptance**: Enabling a disabled bot in cockpit starts its container within 60s.

---

### Session 5: Dynamic Config UI (Schema-Driven)

**Goal**: `/config/` renders per-bot settings from schema, not hardcoded UI.

**Work**:
1. Wire `config-admin.js` to `GET/PUT /api/swarm/agents/:agentId/config`
2. Schema-driven field rendering (string, password, url, number, boolean, select, textarea)
3. Every bot has config capability, even if schema empty
4. Empty state: "No special runtime settings required for this bot"

**Acceptance**: Any factory-created bot with config fields renders correctly with no UI code changes.

---

### Session 6: Dynamic Tool Registration

**Goal**: Tools registered via API become executable without code changes.

**Work**:
1. Add execution descriptors to tool registry (`handler_key`, `execution_mode`, `executable`)
2. Replace hardcoded whitelist in `tool-runtime-context.ts`
3. Registry-driven executor dispatch in `tool-executor-service.ts`
4. `DynamicToolRegistrationService` for runtime tool registration
5. Port priority-1 oshal tool families (file, CLI, browser/fetch)

**Acceptance**: `POST /api/tools/register-runtime` → tool appears in switch UI → tool executes.

---

### Session 7: Hardening & Recovery

**Goal**: Dynamic registration survives restart, everything observable.

**Work**:
1. Startup recovery: reload all executable tools from registry
2. Bot startup: load agent + tool config, warn on missing required fields
3. Operator endpoints: bots/tools with unresolved config
4. Full e2e test: create bot → assign tools → configure → execute → restart → verify

**Acceptance**: Cold restart preserves all dynamically created bots and tools.

---

## 800+ Line File Backlog

These files exceed the 800-line refactoring trigger. They should be decomposed before or during relevant sessions:

| File | Lines | Session to Address |
|------|-------|--------------------|
| `docker-compose.swarm-local.yml` | 929 | S4 (when dynamic spawning replaces static compose) |
| `llm-execution-handler.ts` | 921 | Standalone refactor session |
| `queue-manager-service.ts` | 865 | ✅ Decomposed 2026-07-11 (dispatch-helpers / sweeps / incident-worker siblings) |

## Dependencies

- the legacy sibling codebase (private, out-of-repo) — reference for switch framework, tool registry, provisioning patterns
- Docker Desktop running locally
- Postgres, Redis, ChromaDB containers healthy

## Definition of Done (Phase 12)

All of the following must be true:
- [ ] 14-bot default swarm starts and runs stable
- [ ] Switch framework wired with correct defaults per bot
- [ ] Operator can toggle bots on/off from cockpit
- [ ] Enabling a bot spawns a real container
- [ ] `/config/` renders schema-driven bot settings
- [ ] Tools can be registered dynamically via API
- [ ] Restart preserves dynamic state
- [ ] All files under 1000 lines
# ADR: Swarm vs Agent Code Separation Plan

## Status: Phase 1 Complete
## Date: 2026-03-30

---

## Context

The oshal codebase is a monorepo where **every container** (swarm controller + 14 bot workers) runs the same compiled `dist/app/server.js`. Environment variables (`SWARM_MODE`, `BOT_NAME`, `ENABLE_QUEUE_MANAGER`, etc.) determine runtime behavior. This means:

- A 400MB bot image ships with 60+ swarm orchestration files it never uses
- `src/app/composition-root.ts` wires both controller and worker concerns in one function
- `src/app/extensions/swarm/index.ts` mixes controller-only and worker-only bindings
- No compile-time enforcement of layer boundaries — a bot can accidentally import queue manager code

**Goal:** Separate swarm orchestration code from agent worker code at the folder level while keeping the monorepo. Both should share common infrastructure (entities, shared utilities, auth) but have clear boundaries.

---

## Current Feature Module Classification

### Swarm Controller Only (runs in project-manager)
| Module | Purpose |
|--------|---------|
| `swarm-orchestration/` | Queue management, phase routing, ticket decomposition, consensus review, escalation, writeback (~60 files) |
| `scheduling/` | Agent scheduler, cron-style task scheduling |
| `intake/` | Ticket intake pipeline, approval workflows |
| `selector-composition/` | Bot selection and routing logic |
| `agent-management/` | Bot lifecycle, container spawning, runtime registry |
| `operational-intelligence/` | Swarm metrics, runtime analysis |

### Agent Worker Only (runs in each bot container)
| Module | Purpose |
|--------|---------|
| `chat/` | Chat session management |
| `chat-orchestration/` | Agentic loop, tool execution, task orchestration |
| `llm-provider/` | LLM API calls (Claude, OpenAI, etc.) |
| `streaming/` | SSE/WebSocket streaming to clients |
| `memory/` | Conversation memory layer |
| `rag/` | RAG vector search and retrieval |
| `tool-loader/` | MCP tool loading |
| `tool-registry/` | Tool catalog management |
| `tool-approval/` | Tool approval workflows |
| `tool-verification/` | Tool output verification |
| `tool-switch/` | Dynamic tool switching |
| `tool-integrations/` | Built-in tool implementations |
| `voice/` | Voice integration |
| `presentation-generation/` | Slide/report generation |
| `rca-analysis/` | Root cause analysis |
| `claude-code-auth/` | Claude Code CLI auth |
| `openai-codex-oauth/` | OpenAI Codex OAuth |

### Shared (used by both)
| Module | Purpose |
|--------|---------|
| `config-sync/` | Config propagation |
| `remote-client/` | Inter-bot HTTP communication |
| `workspace-bootstrap/` | Workspace directory setup |
| `ticketing/` | Ticket CRUD, workspace stores |
| `edge-agent/` | Edge agent protocol |
| `agent-profile/` | Agent profile data |

### Shared Infrastructure (already separated)
| Path | Purpose |
|------|---------|
| `src/shared/` | Logger, auth middleware, UI components |
| `src/entities/` | Domain types (ticket, task, workspace, tool, agent, etc.) |

---

## Proposed Folder Structure

```
src/
├── app/
│   ├── server.ts                    # Shared entrypoint (stays)
│   ├── composition-root.ts          # SPLIT → swarm-root.ts + agent-root.ts
│   ├── extensions/
│   │   └── swarm/
│   │       ├── index.ts             # SPLIT → controller-bindings.ts + worker-bindings.ts
│   │       └── ...
│   └── routes/                      # Tag routes as swarm-only or agent-only
│
├── swarm/                           # NEW — Swarm controller layer
│   ├── orchestration/               # ← from features/swarm-orchestration/
│   ├── scheduling/                  # ← from features/scheduling/
│   ├── intake/                      # ← from features/intake/
│   ├── selector/                    # ← from features/selector-composition/
│   ├── lifecycle/                   # ← from features/agent-management/
│   ├── intelligence/                # ← from features/operational-intelligence/
│   └── index.ts                     # Barrel: swarm-only exports
│
├── agent/                           # NEW — Agent worker layer
│   ├── chat/                        # ← from features/chat/
│   ├── orchestration/               # ← from features/chat-orchestration/
│   ├── llm/                         # ← from features/llm-provider/
│   ├── streaming/                   # ← from features/streaming/
│   ├── memory/                      # ← from features/memory/
│   ├── rag/                         # ← from features/rag/
│   ├── tools/                       # ← merged from features/tool-*/ (6 modules)
│   ├── voice/                       # ← from features/voice/
│   ├── presentation/                # ← from features/presentation-generation/
│   ├── rca/                         # ← from features/rca-analysis/
│   ├── auth/                        # ← from features/claude-code-auth/ + openai-codex-oauth/
│   └── index.ts                     # Barrel: agent-only exports
│
├── features/                        # KEEP — Shared feature modules
│   ├── config-sync/
│   ├── remote-client/
│   ├── workspace-bootstrap/
│   ├── ticketing/
│   ├── edge-agent/
│   ├── agent-profile/
│   └── index.ts                     # Barrel: shared-only exports
│
├── shared/                          # KEEP — Cross-cutting concerns
│   ├── logger/
│   ├── auth/
│   ├── services/
│   ├── state/
│   └── ui/
│
├── entities/                        # KEEP — Domain types
│   ├── agent/
│   ├── ticket/
│   ├── workspace/
│   ├── tool/
│   └── ...
│
└── pages/                           # KEEP — UI pages
    ├── chat/
    └── cockpit/
```

---

## Implementation Phases

### Phase 1: Create `src/swarm/` and `src/agent/` barrels (non-breaking)
**Effort:** 2 hours | **Risk:** None

1. Create `src/swarm/index.ts` that re-exports from `src/features/swarm-orchestration/`, `src/features/scheduling/`, etc.
2. Create `src/agent/index.ts` that re-exports from `src/features/chat/`, `src/features/llm-provider/`, etc.
3. Update `src/features/index.ts` to only export shared modules
4. Update imports in `composition-root.ts` and `extensions/swarm/` to use new barrels
5. **No file moves yet** — just barrel re-exports as aliases

### Phase 2: Split composition root (non-breaking)
**Effort:** 3 hours | **Risk:** Low

1. Extract `createSwarmControllerContext()` from `composition-root.ts`
2. Extract `createAgentWorkerContext()` from `composition-root.ts`
3. `composition-root.ts` becomes a thin dispatcher that calls one or the other based on `SWARM_MODE` / `BOT_ROLE`
4. Split `extensions/swarm/index.ts` into `controller-bindings.ts` and `worker-bindings.ts`

### Phase 3: Move files to new locations (breaking, batch)
**Effort:** 4-6 hours | **Risk:** Medium (import path updates)

1. Move `src/features/swarm-orchestration/` → `src/swarm/orchestration/`
2. Move `src/features/scheduling/` → `src/swarm/scheduling/`
3. Move `src/features/intake/` → `src/swarm/intake/`
4. Move `src/features/selector-composition/` → `src/swarm/selector/`
5. Move `src/features/agent-management/` → `src/swarm/lifecycle/`
6. Move `src/features/operational-intelligence/` → `src/swarm/intelligence/`
7. Move `src/features/chat/` → `src/agent/chat/`
8. Move `src/features/chat-orchestration/` → `src/agent/orchestration/`
9. Move `src/features/llm-provider/` → `src/agent/llm/`
10. Move remaining agent features
11. Update all `@features/*` path aliases in `tsconfig.server.json`
12. Add `@swarm/*` and `@agent/*` path aliases
13. Run `npx tsc` to verify all imports resolve
14. Update Dockerfiles if needed

### Phase 4: Separate build targets (optional, future)
**Effort:** 4 hours | **Risk:** Low

1. Create `tsconfig.swarm.json` — includes `src/swarm/`, `src/features/`, `src/shared/`, `src/entities/`
2. Create `tsconfig.agent.json` — includes `src/agent/`, `src/features/`, `src/shared/`, `src/entities/`
3. Update `Dockerfile` to build with `tsconfig.swarm.json`
4. Update `Dockerfile.bot` to build with `tsconfig.agent.json`
5. Result: bot containers no longer ship with swarm orchestration code → smaller images

---

## Import Rules (enforced by convention, optionally by lint)

```
src/swarm/**  → CAN import from: src/shared/, src/entities/, src/features/
              → CANNOT import from: src/agent/

src/agent/**  → CAN import from: src/shared/, src/entities/, src/features/
              → CANNOT import from: src/swarm/

src/features/** → CAN import from: src/shared/, src/entities/
                → CANNOT import from: src/swarm/, src/agent/
```

---

## Decision

**Phase 1 COMPLETE** (2026-03-30) — Barrel re-exports created, path aliases added, TypeScript compilation verified.

Phases 2-4 are **backlogged** for future sessions:
- Phase 2: Split composition root (3h, low risk)
- Phase 3: Move files to new locations (4-6h, medium risk)
- Phase 4: Separate build targets (4h, low risk, deferred until folder structure validated)

## Consequences

- **Positive:** Clear architectural boundaries, smaller bot images (Phase 4), easier onboarding, prevents accidental cross-layer coupling
- **Positive:** Monorepo preserved — shared entities, shared infra, single package.json
- **Negative:** One-time import path churn across ~100+ files
- **Negative:** Docker build cache invalidation for the first build after move
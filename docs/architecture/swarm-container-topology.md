/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial swarm container topology diagram
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Full rewrite for multi-harness topology: 16 bots, harness types
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Documented the canonical workspace-root contract + code-server artifact browsing (fix: RALF handovers / continuation briefs / artifact validation no longer diverge onto the unmounted /tmp/oshal-workspace)
 */

# OSHAL Per-Bot Container Swarm — Topology

## Overview

The OSHAL local swarm (`docker-compose.oshal-local.yml`) runs 16 bot containers, all sharing a single Docker network (`oshal`).

All bot containers use the `any-bot:latest` image. Harness and provider selection is declared per-bot in `swarm-bot-registry-local.ts` (the default active registry) and materialized into DB on every API startup via boot sync.

---

## Container Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     oshal network (Docker bridge)                             │
│                                                                              │
│  ╔══════════════════════ SHARED INFRASTRUCTURE ═══════════════════════════╗  │
│  ║                                                                        ║  │
│  ║   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐             ║  │
│  ║   │  Redis 7     │   │ Postgres 16  │   │  ChromaDB    │             ║  │
│  ║   │  :56380      │   │  :55433      │   │  :58001      │             ║  │
│  ║   │              │   │              │   │              │             ║  │
│  ║   │ • Streams    │   │ • Agent DB   │   │ • RAG vectors│             ║  │
│  ║   │ • Scheduler  │   │ • Tools DB   │   │ • Embeddings │             ║  │
│  ║   │ • Pub/Sub    │   │ • Swarm runs │   │              │             ║  │
│  ║   │              │   │ • Work items │   │              │             ║  │
│  ║   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘             ║  │
│  ╚══════════╪══════════════════╪══════════════════╪════════════════════╝  │
│             │                  │                  │                        │
│  ╔══════════╪══════════════════╪══════════════════╪════════════════════╗  │
│  ║  BOT CONTAINERS (any-bot:latest — harness selected via env)          ║  │
│  ║          │                  │                  │                    ║  │
│  ║  ┌───────┴──────────────────┴──────────────────┴────────────┐      ║  │
│  ║  │ ★ oshal-api / project-manager :1455 [cline → openai]      │      ║  │
│  ║  │   OWNS: ENABLE_QUEUE_MANAGER=true                         │      ║  │
│  ║  │         ENABLE_AGENT_SCHEDULER=true                       │      ║  │
│  ║  │         RUN_MIGRATIONS=true                               │      ║  │
│  ║  └──────────────────────────────────────────────────────────┘      ║  │
│  ║                                                                     ║  │
│  ║  ┌─────────────────────┐  ┌─────────────────────┐                  ║  │
│  ║  │ task-manager :3040  │  │ code-developer :3041 │                  ║  │
│  ║  │ [cline→openai]      │  │ [cline→openai]       │                  ║  │
│  ║  │ QA Gatekeeper       │  │ Sr. Engineer         │                  ║  │
│  ║  └─────────────────────┘  └─────────────────────┘                  ║  │
│  ║                                                                     ║  │
│  ║  ┌─────────────────────┐  ┌─────────────────────┐                  ║  │
│  ║  │ devops-bot :3042    │  │ code-reviewer :3043  │                  ║  │
│  ║  │ [cline→openai]      │  │ [claude-code→anthro] │                  ║  │
│  ║  │ Infrastructure      │  │ claude-sonnet-4-6    │                  ║  │
│  ║  └─────────────────────┘  └─────────────────────┘                  ║  │
│  ║                                                                     ║  │
│  ║  ┌─────────────────────┐  ┌─────────────────────┐                  ║  │
│  ║  │ documentation-      │  │ rca-specialist :3045 │                  ║  │
│  ║  │ writer :3044        │  │ [cline→openai]       │                  ║  │
│  ║  │ [cline→openai]      │  │                      │                 ║  │
│  ║  └─────────────────────┘  └─────────────────────┘                  ║  │
│  ║                                                                     ║  │
│  ║  ┌─────────────────────┐  ┌─────────────────────┐                  ║  │
│  ║  │ incident-response   │  │ system-architect     │                  ║  │
│  ║  │ :3046               │  │ :3047                │                  ║  │
│  ║  │ [cline→openai]      │  │ [cline→openai]       │                  ║  │
│  ║  └─────────────────────┘  └─────────────────────┘                  ║  │
│  ║                                                                     ║  │
│  ║  ┌─────────────────────┐  ┌─────────────────────┐                  ║  │
│  ║  │ test-engineer :3048 │  │ research-bot :3049   │                  ║  │
│  ║  │ [cline→openai]      │  │ [cline→openai]       │                  ║  │
│  ║  └─────────────────────┘  └─────────────────────┘                  ║  │
│  ║                                                                     ║  │
│  ║  ┌─────────────────────┐  ┌─────────────────────┐                  ║  │
│  ║  │ tester-bot :3050    │  │ graph-analyst   │                  ║  │
│  ║  │ [cline→openai]      │  │ :3051                │                  ║  │
│  ║  └─────────────────────┘  │ [cline→openai]       │                  ║  │
│  ║                           └─────────────────────┘                  ║  │
│  ║                                                                     ║  │
│  ║  ┌─────────────────────┐  ┌─────────────────────┐                  ║  │
│  ║  │ incident-remediation│  │ queue-bot :3055      │                  ║  │
│  ║  │ :3054               │  │ [cline→openai]       │                  ║  │
│  ║  │ [cline→openai]      │  │ Quality Reviewer     │                  ║  │
│  ║  └─────────────────────┘  └─────────────────────┘                  ║  │
│  ║                                                                     ║  │
│  ║  ┌─────────────────────┐                                            ║  │
│  ║  │ advisor-bot    │                                            ║  │
│  ║  │ :3056               │                                            ║  │
│  ║  │ [cline→openai]      │                                            ║  │
│  ║  └─────────────────────┘                                            ║  │
│  ╚═════════════════════════════════════════════════════════════════════╝  │
│                                                                            │
│  ╔══════════════════════ SHARED VOLUMES ═══════════════════════════════╗  │
│  ║  oshal_workspace    → /app/workspace-shared (all bots, rw)         ║  │
│  ║  config-seed        → /app/config-seed (all bots, ro)              ║  │
│  ║  ~/.claude          → /root/.claude (all bots, ro) — OAuth session ║  │
│  ║  ~/.kube            → /root/.kube (api + remediation, ro)          ║  │
│  ╚═════════════════════════════════════════════════════════════════════╝  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Harness Types

Two execution harnesses are active in this topology:

| Harness | How it works | Bots |
|---------|-------------|------|
| `cline` | Spawns `cline --json` subprocess; reads token data from `ui_messages.json` after completion | project-manager, most workers |
| `claude-code` | Spawns `claude --print` one-shot subprocess; reads JSON output for tokens | code-reviewer |

Bot-level harness is declared in `src/app/extensions/swarm/swarm-bot-registry-local.ts` via `harnessType` + `apiType` fields.

The active registry defaults to the local lineup; `docker-compose.oshal-local.yml` sets `SWARM_REGISTRY=local`.

---

## Communication Flows

```
┌─────────────┐    Redis Streams          ┌─────────────┐
│     PM      │ ─────────────────────────▶ │   Workers   │
│  (dispatch) │  swarm.ticket.execute      │  (consume)  │
└─────────────┘                            └─────────────┘

┌─────────────┐    Direct Channel         ┌─────────────┐
│   Any Bot   │ ─────────────────────────▶ │ Specific Bot│
│             │  agent.{botName}           │             │
└─────────────┘                            └─────────────┘

┌─────────────┐    subprocess             ┌─────────────────────┐
│ code-       │ ─────────────────────────▶ │ claude --print      │
│ reviewer    │  (claude-code harness)     │ (Anthropic direct)  │
└─────────────┘                            └─────────────────────┘
```

---

## Infrastructure Ownership

| Resource | Owner | Workers |
|----------|-------|---------|
| Queue Manager | oshal-api only (`ENABLE_QUEUE_MANAGER=true`) | `false` |
| Scheduler | oshal-api only (`ENABLE_AGENT_SCHEDULER=true`) | `false` |
| Migrations | oshal-api only (`RUN_MIGRATIONS=true`) | `false` |
| Boot sync (registry→DB) | oshal-api only (runs at startup) | `false` |
| Redis Streams | All (consumer groups) | All |
| Postgres | All (read/write) | All |
| ChromaDB | All (RAG query/ingest) | All |
| Workspace (`/app/workspace-shared`) | All (shared rw) | All |
| Settings (`/app/output`) | Per-bot (private volume) | Per-bot |

---

## Workspace Artifacts & code-server

Every bot reads and writes task artifacts under **one** shared workspace root. A
task folder holds the deliverables, RALF developer-handovers, continuation
briefs, and `_meta.json` produced across the 7-phase lifecycle.

### The canonical root

All services resolve the root through `resolveSharedWorkspaceRoot()`
(`src/shared/workspace-root.ts`). The first non-blank value wins, in this order:

1. `OSHAL_WORKSPACE_ROOT` — explicit override (pinned to `/app/workspace-shared` in compose)
2. `SHARED_WORKSPACE_ROOT` — canonical compose value
3. `CLINE_WORKSPACE_ROOT`
4. `WORKSPACE_ROOT`
5. `/app/workspace-shared` if present, else `/app/workspace`, else `<cwd>/workspace-shared` (local dev)

A blank/whitespace value is skipped, so an empty higher-priority var never
shadows a valid lower-priority one.

### Browsing artifacts in code-server

`code-server` (host port `8444`) mounts the `oshal_workspace` volume at
`/app/workspace-shared` **read-write** and is rooted there, so operators can
open *and edit* artifacts in the browser. The cockpit `/code` route
([`code-server-bridge-routes.ts`](../../src/app/routes/code-server-bridge-routes.ts))
rewrites OSHAL paths onto this root and redirects to the configured
`CODE_SERVER_URL`.

> Security note: code-server runs with `--auth none` and is bound to
> `127.0.0.1` for local-dev only. Do not expose its port or relax the bind
> without first adding authentication.

### Historical foot-gun (fixed 2026-06-22)

`RALFHandoverManager`, `WorkspaceArtifactEnforcer`, and
`FailureGovernanceService` previously defaulted to
`process.env.OSHAL_WORKSPACE_ROOT || '/tmp/oshal-workspace'`, and that env var
was never set. So while bots wrote deliverables to `/app/workspace-shared`,
handovers / continuation briefs / artifact validation diverged onto
`/tmp/oshal-workspace` — a path inside the API container that **nothing
mounts**. The result: those artifacts were invisible in code-server and wiped on
restart, and the enforcer reported "No completed work artifacts detected" even
when deliverables existed. All three now resolve through
`resolveSharedWorkspaceRoot()`. Covered by
[`tests/unit/workspace-root-resolution.spec.ts`](../../tests/unit/workspace-root-resolution.spec.ts).

---

## Port Map

| Service | Host Port | Container Port | Image | Harness |
|---------|-----------|----------------|-------|---------|
| oshal-api (project-manager) | 1455 | 5000 | any-bot | cline |
| task-manager | 3040 | 5000 | any-bot | cline |
| code-developer | 3041 | 5000 | any-bot | cline |
| devops-bot | 3042 | 5000 | any-bot | cline |
| code-reviewer | 3043 | 5000 | any-bot | claude-code |
| documentation-writer | 3044 | 5000 | any-bot | cline |
| rca-specialist | 3045 | 5000 | any-bot | cline |
| incident-response-bot | 3046 | 5000 | any-bot | cline |
| system-architect | 3047 | 5000 | any-bot | cline |
| test-engineer | 3048 | 5000 | any-bot | cline |
| research-bot | 3049 | 5000 | any-bot | cline |
| tester-bot | 3050 | 5000 | any-bot | cline |
| graph-analyst | 3051 | 5000 | any-bot | cline |
| incident-remediation-bot | 3054 | 5000 | any-bot | cline |
| queue-bot | 3055 | 5000 | any-bot | cline |
| advisor-bot | 3056 | 5000 | any-bot | cline |
| code-server | 8444 | 8080 | codercom/code-server | — |
| Postgres | 55433 | 5432 | postgres:16-alpine | — |
| Redis | 56380 | 6379 | redis:7-alpine | — |
| ChromaDB | 58001 | 8000 | chromadb/chroma | — |

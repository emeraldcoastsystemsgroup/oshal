# ADR 036 — Application architecture: the bot owns the domain, the surface is a view

Status: **Accepted** (2026-06-14)
Related: [ADR 033 multi-harness](033-multi-harness-execution-framework.md), [ADR 035 multi-tenant](035-multi-tenant-saas-foundation.md), [connectors-tenant-isolation](../architecture/connectors-tenant-isolation.md), [swarm-app-manifests](033b-swarm-application-manifests.md)

## Context

A swarm application (`swarm-apps/*.yaml`) usually has two parts: a **bot** that does the
work, and a **cockpit surface** (ribbon toolbar) the operator sees. The tempting shortcut
is to make the **API/controller** do the real work — fetch the data, call the LLM — and
let the bot be a registry stub. That shortcut silently breaks four framework guarantees:

- **Cost capture.** Spend is metered per bot execution into `chat_tasks`. Controller-side
  LLM calls never hit that ledger — the spend is invisible.
- **Per-bot settings.** A user can change a bot's **harness/model** from its settings, and
  the framework applies it at execution. Controller calls ignore those settings entirely.
- **Per-user ownership + isolation.** The accountable bot should **store** what it pulls,
  keyed by OIDC `user_sub`, isolated and encrypted (the `oshal_connections` pattern). The
  controller path owns and stores nothing.
- **Scale/consistency.** When every app follows the same shape, a new one (new channel,
  new domain) is cheap. Ad-hoc controller code is not reusable.

It also violates the core separation ([CLAUDE.md](../../CLAUDE.md)): the swarm controller
**orchestrates and never calls an LLM**; **bot nodes own execution**.

## Decision

**Every application follows one rule: the bot owns its domain, the surface is a view, and
all reasoning runs on the bot.** Two orthogonal distinctions drive the wiring.

### 1. Data-access vs reasoning — separate them
- **Data-access** (fetch an inbox, read a record) is cheap authenticated I/O — **no LLM,
  nothing to meter, no harness/model to apply.** The bot performs it (via its tools + the
  per-user connector token) and **caches it into its own per-user store.** The surface
  reads that cache — fast, no LLM round-trip.
- **Reasoning** (summarize, draft, triage, decide) is LLM work. It **always runs on the
  bot**, so cost lands in `chat_tasks` and the bot's harness/model setting applies.

Ticketing a raw read, or running an LLM call in the controller, are both wrong.

### 2. Transport: sync vs async — chosen per interaction, not fixed
- **Interactive** (toolbar click) → a **direct synchronous call** to the bot:
  `BotNodeClient.execute(agentId, prompt)` → bot `POST /api/swarm-execute` → response.
  **Still cost-tracked** (`recordCost` → `chat_tasks`). **No queue, no workflow** — a
  `chat_tasks` row is the ledger entry; it does not need to be a workflow ticket to be metered.
- **Scheduled** (cron) or **swarm-initiated** (another bot needs the work) → a **dedicated
  ticket queue + workflow** → the same bot endpoint. Queued, retriable, rate-limitable,
  tracked as a ticket **and** in `chat_tasks`.

Both transports hit the **same `/api/swarm-execute` endpoint on the same accountable bot.**
The queue/workflow is just the *tracked, retriable wrapper* for background work.

### The existing rails (reuse — do not reinvent)
| Rail | Where |
|---|---|
| `BotNodeClient` → `http://{bot}:5000/api/swarm-execute`, returns `{response, cost, model, provider}` | [bot-node-client.ts](../../src/features/agent-management/services/bot-node-client.ts) |
| Bot `/api/swarm-execute` — runs the bot's configured harness, returns cost | [swarm-node.js](../../any-bot/server/swarm-node.js) |
| `CostTrackingService.recordCost` → writes `chat_tasks` | [cost-tracking-service.ts](../../src/features/operational-intelligence/services/cost-tracking-service.ts) |
| `HARNESS_FACTORIES` — per-bot harness/model resolution | [provider-runtime.ts](../../src/app/composition/provider-runtime.ts) |
| Per-user store — `user_sub`-keyed, AES-256-GCM encrypted (like `oshal_connections`) | [connectors-tenant-isolation](../architecture/connectors-tenant-isolation.md) |

The bot must be a **first-class node**: its own container in compose, a registry entry
(with `harnessType`), a persona YAML, heartbeating on the mesh — **not an inline stub.**

## Anti-patterns (do NOT)
- **Do NOT** fetch data or call an LLM in the controller/API for app features — it bypasses
  cost + settings and orphans ownership.
- **Do NOT** wrap interactive reads in tickets — direct sync call; tickets are for
  background / scheduled / swarm work.
- **Do NOT** reuse `pipeline: incident-rca` for non-incident work — define a real
  `ticketType` + workflow for the app's background jobs.
- **Do NOT** store app data outside a `user_sub`-keyed store — per-user isolation is mandatory.
- **Do NOT** leave the bot as a registry stub — give it a container so it heartbeats, is
  chat-selectable, and the swarm can reach it.

## Worked example — Intelligent Communication (email)
- **Bot:** `email-summarizer`, a real bot-node container (compose + registry + persona),
  owns Gmail/Calendar via the per-user connector token.
- **Surface:** cockpit ribbon (Inbox / My Day / Social) = views over the bot's cached
  per-user store.
- **Interactive:** "draft reply" → `BotNodeClient` → email bot `/api/swarm-execute` →
  cost in `chat_tasks`, the bot's harness applies.
- **Scheduled:** cron → `email-digest` ticket on the email queue → workflow → same bot →
  digest stored per-user.

## Checklist for a new application
1. **Connector(s)** for external data — per-user OAuth, `user_sub`-keyed (connectors hub).
2. **Bot as a real node** — compose service + registry entry (`harnessType`) + persona YAML;
   verify it heartbeats (`oshal:runtime-agent:{agentId}` exists).
3. **Per-user store owned by the bot** — `user_sub`-keyed, encrypted.
4. **Surface** (`ui.static` ribbon) = views over the bot's store; set the app's `chatAgent`
   to the bot so the cockpit chat preselects it.
5. **Reasoning** via `BotNodeClient` → `/api/swarm-execute` (interactive) — cost auto-tracked.
6. **Background** via a dedicated `ticketType` + workflow → the same bot endpoint.
7. **Never** do data-fetch or LLM work in the controller.

## Consequences

**Positive**
- Cost, settings, isolation, storage, and scale all work *by construction*.
- Consistent across apps; a new channel/domain is "add a connector + a bot," not new plumbing.
- Honors the controller/bot separation and the per-bot configurability the framework promises.

**Negative / notes**
- Each app requires its bot to be a **running node** (a container per bot — the framework's
  model) and a **per-user store** for its domain.
- Interactive reasoning adds a network hop to the bot node — accepted, because that hop is
  exactly where cost capture and per-bot settings live.
- Background work needs a real workflow definition (not the borrowed `incident-rca` pipeline).

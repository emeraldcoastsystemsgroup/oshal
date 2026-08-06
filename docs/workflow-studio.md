# Workflow Studio — talk-to-build workflow authoring

Describe a process in words (typed or spoken) and watch the workflow draw itself on a canvas;
refine it by talking; publish it as a **deterministic ticket-type queue**. Works on web and mobile.

This is the operator-facing surface for OSHAL's workflow engine. The design rationale and the
history of how it was built are in [ADR-039](adr/039-bot-driven-workflow-authoring.md); this doc is
what works today and how to use it.

## How to reach it

- **Ribbon tile** — "Workflow Studio" (a platform tool, available from every cockpit).
- **`/cockpit/?app=workflow-studio`** — the focused app surface.
- **`/workflow-studio/`** — the page directly (also what the ribbon tile embeds).

All three are the same page. API calls under `/api/workflow-studio/*` are auth-gated (`requiresAuth`),
so you must be signed in (locally, `MOCK_OIDC=true`).

## The two ways to use it

### 1. Interactive — talk-to-build (the main path)

Open the surface. In the **"Describe Your Workflow"** panel, type or speak what you want:

> *"Onboard a new employee: collect their details, create their accounts in parallel, then a manager
> approval, then send a welcome email."*

The `workflow-assistant` bot reasons over your words and the current graph, and the canvas **redraws
live** with the workflow — nodes, branches, gates, parallel sections. Keep talking to refine
("add a verification step before delivery", "make stage 2 use the finance bot"). When you're happy,
hit **Publish** and it becomes a live ticket-type queue (see Publish below).

- **Voice**: the 🎙 button dictates your description (browser Web Speech API); the bot's replies are
  spoken back via `/api/voice/synthesize` (with a browser-voice fallback) — the framework-standard
  voice path. Mic/replies are optional; text works everywhere.
- **Manual touch-ups**: you can still drag nodes, wire edges, and edit properties on the canvas — the
  conversation and the manual editor operate on the same definition.

### 2. By ticket — the `workflow-build` queue

A **ticket** whose `ticketType` is `workflow-build` routes to the same `workflow-assistant` bot over
the swarm queue (intake-classified "build me a workflow" requests, scheduled re-designs, or external
triggers). This is the [ADR-036](adr/036-bot-owned-application-architecture.md) rule: interactive →
direct call; scheduled/swarm-initiated → a dedicated `ticketType` + the same accountable bot. The bot
answers with the workflow graph; the interactive surface is where it's persisted and rendered.

## Architecture (why it's shaped this way)

The bot **reasons**, the authenticated **surface persists**. The `workflow-assistant` is a *reason-only
concierge* (inline on the api, like `movies`/`finance`) — it emits exactly one fenced ` ```workflow-graph `
JSON block per turn and calls no API. The surface (`POST /api/workflow-studio/chat`) runs the bot via the
orchestrator, parses the block, auto-lays-out node positions, and **saves the graph server-side where it
is Zod-validated** before the canvas renders it. A bad graph fails loudly back into the chat for the bot
to fix — robustness comes from server-side validation, not from trusting free-form chat.

This avoids every wall earlier attempts hit (LLM tool round-trips, provider ghosting, chat-text
parsing, and a bot→api auth seam). The workflow assistant now follows the same fail-closed inference
boundary as every other bot: a mounted Cline/Claude Code/Codex/Gemini OAuth file is credential
presence, not autonomous-execution authority. Unattended CLI execution is disabled pending an
audited oshal-brokered sandbox. The chat route must have an authorized hosted/BYO inference rail; if
none is available it fails closed, while manual canvas editing and the published deterministic
runtime remain usable. Successful reasoning cost lands in `chat_tasks` under agent `…051`.

Underneath, a published workflow runs on the existing **`ProcessDefinitionExecutionEngine`** (the `graph`
pipeline) — the deterministic runtime for the node graph.

```
you (web/mobile, type or speak)
      │  POST /api/workflow-studio/chat  { description, definitionId }
      ▼
workflow-assistant (reason-only concierge, agent …051, swarm default login)
      │  emits one  ```workflow-graph  { nodes, edges }  block
      ▼
/chat route → parse → auto-layout → saveDefinition (Zod-validated) → return definition
      │
      ▼
canvas redraws the saved definition   ──Publish──►  live ticketType + deterministic graph queue
```

## The bot

- Persona: [ai-lab/bot-personas/workflow-assistant.yaml](../ai-lab/bot-personas/workflow-assistant.yaml)
  (V2 = reason-only emit-a-graph contract).
- Registered (both registries) as agent `a0000000-0000-0000-0000-000000000051`, container `oshal-api`
  (concierge form — see [docs/building-a-bot.md](building-a-bot.md)).
- Reachable three ways: the studio `/chat` route, the general cockpit `/chat` (it's a registered,
  selectable swarm bot), and the `workflow-build` ticket queue.

## Node catalog

The bot composes from 15 node types: `start`, `intake-source`, `planner`, `route-agent`, `ai-decision`,
`logic-gate`, `execute-agent`, `agent-cluster`, `parallel-split`, `parallel-join`, `approval-gate`,
`verify-output`, `review`, `deliver`, `escalate`. (Full descriptions: `GET /api/workflow-studio/catalog`.)

- **`agent-cluster`** — one step, a *ranked cluster* of agents. It dispatches every member in
  `config.agents` on the same work **concurrently**, then an optional `config.reviewer` gates the
  candidates (`PASS <n>` picks a winner, `FAIL <reason>` rejects) before the step advances. This is the
  differentiator competitors don't have: multiple cooperating agents + a quality gate inside a single node.

## Publish → a deterministic queue

**Publish** compiles the canvas definition into a `SwarmAppManifest` and registers it live via
`POST /api/swarm/apps/publish` — creating a new `ticketType` + queue backed by the `graph` execution
engine. A linear chain publishes as `single-shot`/`staged`; a graph with **branches, parallel splits, or
decisions** publishes as a full `graph` spec that runs as drawn (the compiler validates it server-side).
From then on, tickets of that type run your workflow deterministically. (The one-shot, no-gate
alternative is `codex-packer`, which packs a single-purpose bot instead of a gated ticket-type workflow.)

- **Auto-start** (Publish toggle): when set, tickets of the published type auto-approve on arrival and
  run immediately — any human-in-the-loop lives in the graph's own `approval-gate` nodes. Default off
  keeps the manual backlog-approval gate. (Manifest flag `workflow.autoStart`; the queue manager promotes
  matching backlog tickets each poll.)

## Runtime — what a published workflow actually does

Published graphs run on the **`ProcessDefinitionExecutionEngine`** (the `graph` dispatch path via
`dispatch-graph-worker`). The engine is a real runtime, not a preview:

- **Branches** — `logic-gate` (expression over run variables) and `ai-decision` (the bound bot picks an
  outcome) set the next edge by label.
- **Parallel** — `parallel-split` fans out to **every** branch **concurrently** and rejoins at
  `parallel-join`; a failed branch escalates the workflow rather than silently completing.
- **Approval gates** — `approval-gate` **suspends** the run; the ticket parks at `approval_required` and
  operator approval resumes past the gate with state intact.
- **Agent-cluster steps** — a ranked cluster of agents + a reviewer gate inside one node (see catalog).
- **Durable / resumable execution** — the engine checkpoints before each node (resume point + accumulated
  state, in the ticket's `workflowCheckpoint` metadata). A crash or restart **resumes at the in-flight
  node** instead of restarting the whole graph, so completed steps (and their expensive bot/LLM work) are
  not redone.
- **Regression loops** — a re-visited execution/cluster node counts against a bounded regression budget,
  escalating when exhausted.

## Registration (how it's wired as a proper tool + app)

[swarm-apps/workflow-studio.yaml](../swarm-apps/workflow-studio.yaml) is the manifest. It:

1. **Registers the UI surface as a tool** — `ui.static` → `registerDynamicToolUI`, so the ribbon tile +
   `?app=workflow-studio` work the documented way (not a hardcoded hack).
2. **Registers the ticket route** — `ticketType: workflow-build` → `workerBot: workflow-assistant`, so
   workflow-build tickets dispatch to the bot via the queue.
3. **Declares the bot** so it's a real swarm participant.

The manifest auto-loads at boot (`swarmAppService.autoLoadAll()`); the ticketType lands in the
`WorkflowPipelineRegistry` and the dispatcher routes it via `dispatchManifestWorkerTicket`.

## Mobile + web

The page is responsive. On phones (≤640px) it goes single-column with the **"Describe Your Workflow"**
panel leading, the action bar becomes a horizontal scroll strip, the canvas pans/scrolls both axes, and
inputs use 16px text + 44px tap targets (no iOS zoom-on-focus). Voice dictation works on mobile browsers
that support the Web Speech API. The viewport meta is set, and the cockpit embeds the same responsive
page in its iframe tool view.

## Verified

Smoke-tested live (2026-06-22, rebuilt image, `MOCK_OIDC=true`):

- `POST /api/workflow-studio/chat` with a plain-English RCA process → a saved, validated definition
  (`start → intake → execute-agent(RCA) → approval-gate → deliver / escalate`, labeled edges).
- Browser (Playwright): typed an onboarding description on the real page → the canvas redrew to
  *"Employee Onboarding: Collect → Provision → Approve → Welcome"* (10 nodes / 11 edges, with a
  parallel-split/join for concurrent account provisioning).

Runtime live-proven (2026-07-05, deployed image):

- **Full graph** — published a branching/parallel graph → both branches dispatched concurrently to real
  bots → join → deliver → complete.
- **Durable resume** — killed the api mid-run; the ticket resumed from its checkpoint (`resumeFromNodeId`)
  and re-ran only the in-flight node + downstream, not the whole graph.
- **Agent-cluster** — a 2-member cluster dispatched concurrently, a reviewer gated the candidates, and the
  step advanced.

Not yet exercised by ear: voice dictation + spoken replies (wired, untested with real audio).

## See also

- [ADR-039 — bot-driven workflow authoring](adr/039-bot-driven-workflow-authoring.md) (design + build spec)
- [docs/building-a-bot.md](building-a-bot.md) (the concierge form this bot uses)
- [ADR-036 — bot-owned application architecture](adr/036-bot-owned-application-architecture.md)
- [build-your-own-swarm-app.md](build-your-own-swarm-app.md) (app manifests)

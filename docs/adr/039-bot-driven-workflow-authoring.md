# ADR 039 — Bot-driven workflow authoring: the Studio is a view of a builder-bot conversation; Packer is the one-shot option

Status: **Proposed** (2026-06-15). Design pass for BACKLOG "Workflow Studio — bot-driven"
and "Codex Packer ↔ Workflow Studio are ONE flow". Builds on:
[ADR 038 swarms bundled by type](038-swarms-bundled-by-type.md),
[ADR 036 bot-owned application architecture](036-bot-owned-application-architecture.md).

## Context

Two things are wrong with workflow authoring today:

1. **Workflow Studio is a hand-edit, design-time canvas.** `/workflow-studio/` authors and
   validates a graph; its compile preview is descriptive, not executable (per CLAUDE.md).
   Runtime workflows actually come from `swarm-apps/*.yaml` manifests via
   `WorkflowPipelineRegistry`. So the canvas and the thing that runs are disconnected, and
   the canvas is edited by hand — which is the wrong altitude for a non-engineer operator.

2. **Codex Packer is split and half-broken.** The working builder is the **swarmbot chat**
   (`/swarmbot/chat?agentId=a0000000-0000-0000-0000-000000000030`) — `codex-packer` interviews
   an operator and emits a packed bot (persona + `swarm-apps/*.yaml` manifest), registered live
   via `POST /api/swarm/apps/load` (see the store-side [federal-capture package](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/federal-capture)).
   But the `?app=codex-packer` tile opened the **default app + legacy toolbar** (wrong, can't ship).

Owner direction (2026-06-15 walkthrough): *"workflow studio … should only be modified by a bot
you talk to and the workflow is just a representation of what you discuss … click available bots
… then it shows you the process flow and then creates it in either a packed bot with no approval
steps (single shot workflow) or … a new ticket type with the approval gates. codex packer same
issue … it and the workflow studio really should go hand and hand … packer is just an option to
one-shot it."*

## Decision

**Workflow authoring is a conversation with a builder bot. The Studio canvas is a read-only
*view* of that conversation. Codex Packer is not a separate app — it is the one-shot option of
this single flow.**

1. **One builder bot, one entry.** The builder is the `codex-packer` bot (agent
   `…030`), reached via the swarmbot chat. Both the **Workflow Studio "Build"** action and the
   **/applications → Codex Packer** tile launch that chat. `?app=codex-packer` (default app +
   legacy toolbar) is removed.

2. **The conversation drives the canvas.** As you talk, the builder: surfaces **available bots**
   (click to add), helps you pick **stages**, and emits a structured **workflow spec** (below).
   The Studio renders that spec as the process-flow graph — a *visualization of the discussion*,
   not a hand editor. The human edits by talking, not by dragging.

3. **Two emit targets, chosen at the end:**
   - **Packed single-shot bot** — a `swarm-apps/*.yaml` with one `workerBot`, **no** `reviewerBot`
     / approval gates. The "one-shot" / packer path (matches today's codex-packer output).
   - **Ticket-type workflow** — a manifest declaring a new `ticketType` + `workerBot` +
     `reviewerBot` + `maxRevisions` (approval gates), per ADR-038's "one bot per ticket-type
     workflow, opt-in reviewer."

4. **Compile = register live.** The chosen artifact is written to `swarm-apps/` and registered
   via `POST /api/swarm/apps/load` (the path codex-packer already uses). No separate
   studio-compiler-to-runtime contract is needed — the manifest *is* the runtime contract.

## The workflow spec (the contract between bot, canvas, and compiler)

The builder bot emits a JSON spec alongside its prose; the canvas renders it and the compiler
turns it into a manifest:

```jsonc
{
  "name": "partner-outreach",            // app/manifest id
  "displayName": "Partner Outreach",
  "mode": "one-shot" | "ticket-type",    // → no gates  |  ticketType + reviewer + maxRevisions
  "ticketType": "partner-outreach",      // ticket-type mode only
  "bots": [{ "id": "...", "role": "worker" | "reviewer", "persona": "..." }],
  "stages": [{ "id": "intake", "bot": "...", "approval": false }, ...],
  "tools": ["..."],
  "surface": { "label": "...", "iframeUrl": "..." }   // optional cockpit tab
}
```

## Incremental path (build order)

1. **Unify the entry.** Studio "Build" + `/applications` Codex Packer → the builder chat.
   *(Done 2026-06-15 for /applications; Studio "Build" button next.)*
2. **Builder emits the spec.** Teach the codex-packer persona to emit the JSON spec above.
3. **Canvas renders the spec** (read-only) — the Studio subscribes to the chat's spec output.
4. **Compile** the spec → manifest (one-shot vs ticket-type) → `POST /api/swarm/apps/load`.
5. **Remove** the `?app=codex-packer` cockpit-toolbar path.

## Consequences

- Workflow Studio becomes a conversation **visualizer + compile target**, not a manual editor —
  the right altitude for operators. The roadmap "agentic authoring that produces the canvas"
  becomes the default path, not a side feature.
- Packer and Studio converge into one flow; "one-shot vs ticket-type with gates" is the only
  fork. The broken cockpit-toolbar entry is gone.
- Risk: the builder must emit a spec the canvas and compiler both accept — pin the schema (above)
  before wiring, and validate on `/api/swarm/apps/load` so a bad spec fails loudly, not silently.

---

## 2026-06-22 — Build spec revision (supersedes the "inline JSON in chat" design)

A walk of what's actually on `main` (not the dead `feature/workflow-studio-engine` branch, which is
685 commits behind and carries only unrelated deletions) found the feature is **far more complete than
this ADR assumed**, and the original design above named the *wrong* contract. This section is the
authoritative build spec; where it conflicts with the prose above, this wins.

### What already works on `main`

- **Canvas** ([src/pages/workflow-studio/workflow-studio.js](../../src/pages/workflow-studio/workflow-studio.js)):
  full graph editor — load a definition by id, `render()`/`renderCanvas()`, drag, edges, inspector,
  validate, compile, and a working **Publish** button (`buildPublishSpecFromDefinition` →
  `POST /api/swarm/apps/publish`) that registers a **live queue + ticketType**.
- **Builder bot persona** ([ai-lab/bot-personas/workflow-assistant.yaml](../../ai-lab/bot-personas/workflow-assistant.yaml)):
  "Workflow Orchestration Specialist", explicitly instructed to *build a compilable WorkflowDefinition
  via the `workflow-studio` tool* (create / save / validate / compile). **Not registered** (no agentId).
- **`workflow-studio` tool** is wired into the TS chat tool-executor
  ([tool-executor-service.ts:194](../../src/features/chat-orchestration/services/tool-executor-service.ts#L194)),
  hitting `127.0.0.1/api/workflow-studio` (the api itself).
- **Compiler + execution engine**: `compileWorkflowSpec` →
  [process-definition-execution-engine.ts](../../src/features/workflow-studio/engine/process-definition-execution-engine.ts)
  (the deterministic `graph` pipeline) already runs published workflows.
- **STT/TTS** is a standard pluggable barrel (`@/features/voice/browser` → `STTService`/`TTSService`,
  `/api/voice/*`) — already used by the chat page. Voice is a drop-in, not a phase.

### The correct contract: the bot edits the canvas's *native* WorkflowDefinition (not chat-text JSON)

The "builder emits a JSON spec alongside its prose, the canvas parses it from chat" design (steps 2–3
above) is **abandoned**. The framework already has the better, bot-owns-the-store path (ADR-036): the
builder bot calls the `workflow-studio` *tool* to write the WorkflowDefinition (server-validated), and
the canvas renders by **reloading that definition** (`GET /api/workflow-studio/definitions/:id`). No
fragile chat-text parsing.

### Why prior attempts hit the wall (root cause)

`getProvider(agentId)` ([provider-runtime.ts:699](../../src/app/composition/provider-runtime.ts#L699)):
**if an agent has a `harnessType` in the registry, it resolves to that CLI harness** (claude-code /
codex). CLI harnesses run their *own internal* one-shot agentic loop and return final text — they do
**not** surface `tool_use` blocks to the TS `agentic-loop`. So the loop sees zero tool calls and the
`workflow-studio` tool is a **ghost** (the same failure documented for Jarvis: "inline = claude-code
one-shot that can't round-trip tool_use"). **Every** registry bot carries `harnessType: claude-code`,
so any bot wired this way silently no-op'd its canvas edits. Stacked on top of the chat-text-JSON
parsing, the loop never closed.

### How LLM credentials actually work here (the part I got wrong first)

OSHAL does **not** read a global vendor key from `.env` for bot reasoning. The LLM credential is
resolved **per logged-in user** — the framework's active configured provider (`listConfiguredProviders`)
or the user's **BYO-LLM** connection (`byo-llm-routes.ts`, an OpenAI-compatible `{baseUrl, apiKey, model}`)
— and **injected into the bot for that call** (the `creds` / `OSHAL_CRED_*` rail; `byoLlmConnection`).
So "which vendor key is in `.env`" is the wrong question.

Two execution paths inside the any-bot runtime ([TaskController.js](../../any-bot/server/controllers/TaskController.js)):

- **Agentic (tool) loop** — `this.agenticController` runs the bot's CLI harness (claude-code) and its
  `ToolUseParser` parses the CLI's textual tool calls, executing **JS-side toolkits**
  (`any-bot/server/services/tools/`, auto-discovered per ADR-025). **This is the path that round-trips
  tools.** Per-user tokens arrive as `OSHAL_CRED_*` files for the tools.
- **BYO-LLM reasoning** — `_buildByoLlm` runs inference on the caller's own endpoint, but
  `useAgenticMode = !byoLlm && …` deliberately **skips the tool loop** (a raw BYO endpoint emits
  unparseable tool calls). So the injected-key path alone **cannot** edit the canvas.

Net: a bot that must *edit the canvas* needs the **agentic tool loop** → it must be a **dedicated
bot-node** with a **JS-side `workflow-studio` toolkit**. The TS-side tool + TS chat `agentic-loop`
only round-trips for an API provider that returns `tool_use`, which is not the credential model here.

### The fix (build spec — final: the bot reasons, the authenticated surface persists)

Two facts collapse the design to its simplest, seam-free shape:
- **No `oshal-*.js` script calls the internal api** — they all hit *external* providers with connector
  tokens. The `requiresAuth` `/api/workflow-studio` routes have no bot-auth seam, and adding one is a new
  auth surface (against the CLAUDE.md auth rule). So a bot-node curling the api is the wrong primitive.
- **The studio page is already an authenticated browser context that already calls these exact routes**
  (`workflow-studio.js` create/save/validate/compile). So the surface, not the bot, should do the I/O.

Therefore: **the bot is reason-only; the surface persists.** Every wall the prior attempts hit (tool
round-trip, provider ghosting, chat-text parsing, bot→api auth) disappears.

1. **`workflow-assistant` = a registered concierge node** *(done 2026-06-22)*. Reason-only, so it takes
   the **concierge form** (inline on the api, brain via `ctx.orchestrator`) like `movies`/`spotify` — NOT
   a bespoke inline shortcut. Registered in **both** registries (agentId `…051`), BYOK on the **swarm
   default login**, reached via the standard concierge **`POST /api/workflow-studio/chat`** and selectable
   on the general `/chat` path. Persona output contract: a short prose line + exactly one fenced
   ` ```workflow-graph ` block with the WHOLE `{name, description, nodes, edges}` graph (catalog node types
   only); it calls no API and writes no files. Cost → `chat_tasks` (ADR-036). See
   [docs/building-a-bot.md](../building-a-bot.md) for the two sanctioned bot forms.
2. **Studio surface** — a chat panel beside the canvas. The surface posts the operator's words + the
   current graph to `POST /chat`; that route runs the bot via `executeBotOrInline`, parses the single
   `workflow-graph` block, and **saves it (server-side Zod-validated via `saveDefinition`) then returns the
   saved definition; the canvas reloads + redraws** — so the graph appears and animates **as you talk**.
   Invalid graphs fail loudly back into the chat for the bot to correct. Manual drag stays for touch-ups.
3. **Voice** — drop the standard `STTService` mic + `TTSService` into that chat panel (speak the workflow,
   hear the bot).
4. **Reachable surface** — `?app=workflow-studio` ribbon entry. Publish (already built) closes the loop
   into a live ticketType + deterministic `graph` queue. (Packer remains the no-gate one-shot option.)

Robustness comes from **server-side validation** (the existing `/validate` + `PUT` Zod schemas), not from
trusting free-form chat — the earlier "fragile chat-JSON" objection is answered by validating every emit
and only rendering a graph that passes.

### Notes / open details

- Definitions today are **global, not user-scoped** (`requiresAuth` only). Fine for single-user; flag for
  the public-launch isolation work (per-user scoping of `/api/workflow-studio`).
- Placement is **settled**: concierge node (inline), BYOK on the swarm default login — the right form for a
  reason-only bot. (An earlier note speculated a dedicated bot-node "for the user's injected key"; the
  credential model is the swarm default login, which the inline concierge already uses, so a dedicated
  container would be needless infra here.)

# ADR-050: Unified Assistant ("Jarvis") — a route-layer orchestrator over the app swarm

- **Status:** Accepted
- **Date:** 2026-06-17
- **Supersedes / relates to:** ADR-036 (bot-owned application architecture), ADR-038 (swarms bundled by type), ADR-049 (OSHAL as aggregation platform)

## Context

OSHAL had grown to ~14 single-purpose apps (career-hunter, finance, smart-home, cloud, communications/email, social, presentations, kid-lens, identity, storage, …), each an accountable bot behind its own cockpit surface, selected with `?app=<name>`. The user experience was app-switching: to ask about jobs you opened `?app=career-hunter`; to ask about money you opened `?app=finance`. There was no single place to "just ask" and have the request land on the right specialist.

The natural shape is one conversational front door — a "Jarvis" — that understands the request and routes it to the right app bot(s), then answers as one voice.

The obvious implementation (an LLM with a `delegate_to_agent` tool calling other bots mid-conversation) is **not feasible on this runtime**:

- The live harness is the **claude-code CLI** (`FORCE_LLM_PROVIDER=claude-code`, no `ANTHROPIC_API_KEY`), a one-shot subprocess that runs its own internal agent loop. It does **not** surface `tool_use` blocks back to the server-side `runAgenticLoop`, so a server-side builtin tool would never be invoked.
- claude-code-as-root **cannot shell out** (it blocks `--dangerously-skip-permissions`), so the persona can't `curl` a delegation endpoint either; and codex-cli is broken on this host.

So in-conversation LLM tool-calling delegation is off the table here.

A second constraint: the **reason-only inline bots** (finance, kid-lens, identity, storage) follow the ADR-036 split where the **route** assembles the data context (Plaid aggregate, Takeout upload, connection inventory, storage target) before the bot reasons. They cannot answer a bare free-text prompt — only the **self-sufficient bots** (communications, home, cloud, career-advisor, social-writer, deck-builder) fetch their own data from a prompt.

## Decision

Build Jarvis as a **route-layer orchestrator** — the same place the swarm already coordinates multi-bot work — not as an LLM holding delegation tools. `POST /api/jarvis/ask` runs three steps:

1. **Classify** — the reason-only `oshal-assistant` bot (`a0000000-…-0050`, inline on the api container, claude-code) reads the app catalog + the user's message and returns strict JSON: which specialist(s) to consult, the focused instruction for each, and any data-apps to hand off to.
2. **Delegate** — for each **self-serve** target, call the accountable bot, in parallel, by the correct transport for where it runs:
   - **Dedicated-container bots** (communications/email-bot, home-bot, cloud-ops-bot) → `BotNodeClient.execute` over HTTP to `http://<container>:5000/api/swarm-execute` (verified working against the live stack).
   - **Inline bots** (the Jarvis brain itself, career-advisor, social-writer, deck-builder) → **`ctx.orchestrator.processMessage(agentId, …)` in-process** — the same path the cockpit chat uses. This is required, not stylistic: the controller (`server.ts`) does **not** host `/api/swarm-execute`, so an HTTP call to itself hits the OIDC catch-all 401. `NODE_AGENTS` in `jarvis-routes.ts` is the set of dedicated-container agent IDs.

   Either way `userSub` + brokered `creds` are threaded and each call's cost lands in `chat_tasks` under **that bot's** `agent_id` (ADR-036 accountability preserved).

   > **Finding (2026-06-17 access test):** finance/identity/kid-lens/deck-builder/social-writer call `BotNodeClient.execute` on **inline** bots, which 401s on this topology — they were never actually exercised end-to-end. They need the same orchestrator-for-inline routing. Tracked in BACKLOG.
3. **Synthesize** — `oshal-assistant` composes the specialists' replies into one answer in Jarvis's voice.

**Delegate vs. handoff.** Each catalog entry declares `mode`. `delegate` bots are consulted directly. `handoff` bots (the reason-only data-apps) are **not** asked a bare question — Jarvis returns a deep link (`/cockpit/?app=<name>`) inviting the user to open that app so it can build its data context first. This keeps every app represented honestly with **no thin, data-less answers** (the no-mock rule).

Jarvis itself **owns no domain and fetches no data** — it only classifies and synthesizes. The surface (`/api/jarvis/`, `?app=jarvis`) is a chat view over `POST /ask`.

## Consequences

**Positive**
- One chat box over the whole non-monster app roster, working on the live claude-code runtime with no new infra and no provider change.
- Accountability and cost attribution unchanged: every delegated call is a normal `BotNodeClient.execute` to the real accountable bot; Jarvis's own classify+synthesize cost lands under `…-0050`.
- Per-user isolation preserved: `userSub` + brokered `creds` (google/twitter/smartthings/gcp) are threaded into every delegation, exactly like the chat path (`message-routes`).
- Non-invasive: a new route + persona + manifest + one registry entry. No change to the shared chat orchestrator or tool registry.

**Negative / limits**
- Latency is additive: classify + (parallel delegations) + synthesize — each a claude-code one-shot. Acceptable for an interactive assistant; the surface shows progress.
- The classifier is an LLM returning JSON; parsing is defensive (first balanced object; falls back to treating the text as a direct answer).
- **Data-apps are handoff-only in v1.** Finance/kid-lens/identity/storage can't be answered inline because Jarvis can't pre-assemble their data context. Closing this needs each app to expose a callable "answer" service (fetch + reason) that Jarvis can invoke with the caller's identity — tracked in BACKLOG. When OSHAL runs on a tool-capable server-side provider (real `ANTHROPIC_API_KEY`), the in-conversation `delegate_to_agent` tool becomes viable as an alternative path.

## Excluded

- **Education ("little-monsters")** is intentionally out — it has its own multi-bot cockpit and audience.
- Jarvis never sends, publishes, trades, or actuates on its own; those remain deliberate actions in the owning app.

## Update — 2026-06-18: voice-first surface, async delivery, theme-native UI

The Jarvis surface (`src/api/jarvis.html`, `?app=jarvis`) was reworked from a plain chat log into a **voice-first, theme-native cockpit surface**. Behaviour and the three-step orchestrator are unchanged; this is the surface + delivery layer.

- **Voice-first orb.** The surface leads with an audio-reactive orb + browser voice I/O (Web Speech API: `SpeechRecognition` for input, `speechSynthesis` for output). You talk or type; Jarvis speaks the answer and renders the full markdown / GFM tables / Mermaid diagrams / "Open ↗" handoff chips below. Heavy content (a diagram/table) is summarised verbally since it's shown on screen. The embedded tool iframe gained `allow="microphone"` (`cockpit-view-controller.js`).
- **Theme-native.** The surface no longer hardcodes a palette — it runs the standard cockpit **theme-sync** script (same as email/home/social surfaces), mirroring the live cockpit CSS tokens (`--bg-*`, `--accent-primary`, `--status-*`, …) into local vars; the orb reads `--accent` so it matches the active theme (purple in midnight) and switches with it. Layout is one width-constrained column (orb hero → Command Center → conversation), with `min-width:0` / `overflow-wrap` guards so long strings never force a horizontal scrollbar.
- **Command Center = stat-first.** The glance (`GET /api/jarvis/overview`) renders as four stat cards (big number + one supporting line; Swarm gets a health bar) instead of pill clouds and raw rows. Fixed: `buildCalendar` referenced a non-existent `due_date` column — now `event_date` only.
- **Right-rail chat panel hidden for jarvis.** Jarvis *is* the chat surface, so the cockpit's generic right-rail panel is dropped here. Manifest flag `ribbon.hideChatPanel: true` (synthesised into the profile); the cockpit also matches by `profile.name === 'jarvis'` so it works before a controller rebuild.

### Async delivery (the important one)

The orchestrator's additive latency (classify + parallel delegations + synthesize, each a claude-code one-shot) routinely runs **2–3+ minutes** (a single career-advisor delegate was observed at 127s). The surface is served behind a **Cloudflare tunnel (`oshal.agenticfederal.us`), which 524s any request held ~100s** with no response headers — so the original synchronous `POST /ask` (which awaited the whole flow) timed out at the edge and the surface showed "offline" even though the backend completed the work.

Fix: `POST /api/jarvis/ask` now returns **`{ jobId }` (202)** immediately and runs `orchestrate()` in the background into an in-memory `askJobs` map (caller-scoped, GC'd after 10 min). The surface polls **`GET /api/jarvis/ask/result?jobId`** every 2.5s (one-shot read) until `done | error | expired`, keeping the orb in a "Working on it… Ns" state. No single request is held past the edge limit. Any future long-running surface behind Cloudflare must follow the same pattern.

### Operability

- The Jarvis app now shows as a **working, openable** entry under a new **"Assistant"** category (first) in the Swarm Applications panel (`src/pages/applications/index.html`).
- Deploy note: `src/api/` and `src/pages/cockpit/` are bind-mounted into `oshal-api` (hot-swap — surface edits go live on refresh); the orchestrator routes (`jarvis-routes.ts`, compiled `dist/`) require an image rebuild + `oshal-api` recreate.

## Update — 2026-06-20: Jarvis is an in-framework bot with two-tier hand-off (supersedes the route-orchestrator)

The classify → delegate → synthesize route-orchestrator above is **superseded**. Jarvis now runs as a real
framework bot (`jarvis-bot` container, any-bot runtime, `FORCE_LLM_PROVIDER=openai-codex`) in **one continuous
session per user** (stable `sessionId` from the orb → reused bot task = memory). Each turn it decides:

- **ANSWER NOW** — reply inline from the conversation / what it knows (no tool).
- **BATCH (Tier 1, `"simple"`)** — a quick tool/data task it does itself in a background job
  (the route re-invokes it with an `EXECUTE NOW:` prompt); the result returns via the durable Tasks list +
  a voice-gated "I've got an update on X" announcement (never while the user is speaking/recording).
- **FILE WITH THE SWARM (Tier 2, `"complex"`)** — a real build / multi-step / needs-specialists task is filed
  as a `status:'approved'` task ticket; the queue-manager pipeline decomposes it and dispatches the specialist
  bots (the same path as the intake flow). Jarvis returns **instantly** and never blocks on a2a.

The **decision turn runs `agenticMode:false`** (a single tool-less completion) so it cannot hang on tools or
agent-to-agent calls — that was the cause of the multi-minute inline hangs. The hand-off directive
(```handoff {json}```) carries `complexity`; `jarvis-routes.ts dispatchHandoffs` branches on it.

**Persistence:** conversation turns (`messageStore`) + a `jarvis_tasks` table (Tier-1 status via `finishTask`,
Tier-2 status mapped live from the linked ticket) so a returning user sees their history (`GET /history`,
`GET /tasks`) — surfaced by the orb's Conversations + Tasks lists.

**Deploy note (Windows Docker):** the persona is bind-mounted (restart `jarvis-bot` to reload it);
`jarvis-routes.ts` needs an image rebuild. `compose up --force-recreate` intermittently wedges a container
in "marked for removal" — use `docker build … && docker rm -f oshal-local-api oshal-local-jarvis-bot &&
docker compose up -d --no-deps oshal-api jarvis-bot`. App surfaces serve from `any-bot/server/services/tools/`
(now COPYed into the image + bind-mounted) — without that the surfaces 404.

## Update — 2026-06-20: conversational/worker split (the session-lock fix) + decision-turn correction

Two corrections to the 2026-06-20 two-tier design above.

**1. `agenticMode:false` for the decision turn was wrong — reverted.** The codex provider has **no plain-LLM
path**, so a tool-less decision turn errored `activeLlm.generateResponse is not a function` (caught only by a
live test). The decision turn now runs **`agenticMode:true`** — the only working codex path — and Jarvis is
held back from grinding by (a) the persona (answer-now-vs-batch rule), (b) `DECISION_TIMEOUT_MS` (75s) racing
the turn so a request that ignores the rule and starts building is auto-filed as a complex ticket instead of
hanging, and (c) `buildToolsBlock()`, which injects the live `/app/scripts/oshal-*.js` capability list every
turn so Jarvis routes to the right tool instead of "searching the web" for something a tool covers.

**2. Tier-1 "simple" work no longer runs on jarvis-bot — a dedicated worker does.** `jarvis-bot` is
**single-threaded**: if the bot the user is *talking to* executes a tool, the whole conversation locks for the
tool's duration (minutes→hours). So Jarvis is now **purely conversational** — it talks, reads its OPEN WORK /
incident view, gathers context, and **batches** anything that needs a tool; it never executes one itself. A new
headless executor runs the tools:

- **`oshal-worker`** (registry `a0000000-…-0099`, container `worker-bot`, port 3099, codex) — same image,
  CLIs, and sandbox as jarvis-bot but it never converses. Registry entry in `swarm-bot-registry-local.ts`,
  persona `ai-lab/bot-personas/oshal-worker.yaml`, service in `docker-compose.oshal-local.yml`.
- `jarvis-routes.ts`: `runJarvisBot(..., botAgentId)` takes a target bot; `runWorkItem` dispatches the
  `EXECUTE NOW:` turn to `WORKER_AGENT_ID` (over `BotNodeClient` → `http://worker-bot:5000/api/swarm-execute`),
  so a long tool run never touches the conversation. Complex work still goes to the PM/swarm pipeline.

**Ticket process & quality gates (v1).** Route (Jarvis files an auto-approved task **with context**) → Execute
(one worker runs the tool) → Quality gate (non-empty result; **actuating** steps — order/send/publish/trade —
stop and ask the user to confirm rather than self-executing) → **Enrich + deliver** in Jarvis's voice: complex
tickets via `summarizeComplexTask` (reads the deliverable, re-narrates with rich markdown — table / Mermaid /
image — when it helps); simple tasks already return rich worker output and Jarvis re-narrates from the OPEN
WORK result block when asked. One worker to start; no separate reviewer bot in v1.

**Cost-rollup FK guard.** `bot-node-execution-handler.ts` links a finished task to its ticket for cost rollup
(ADR-027) by parsing a UUID out of the task's `externalId` (which is `body.taskId`). The ticketless Jarvis
flows (`jarvis-work-*`, session turns) carry a UUID that is **not** a real ticket, so the link threw a caught
but noisy `ticket_task_links_ticket_id_fkey` violation on every such task. Fixed with an existence guard
(`if (await getTicket(uuid)) linkTask(...)`) — the simple flow skips the link cleanly; cost recording itself
(`recordCost`) was always unaffected; the complex flow (real `approved` ticket) links normally.

**Deploy:** `docker build -t oshal-bot:latest . && docker rm -f oshal-local-api oshal-local-jarvis-bot
oshal-local-worker-bot && docker compose -f docker-compose.oshal-local.yml up -d --no-deps oshal-api
jarvis-bot worker-bot`. Validate: a "order food / check email / pull jobs" request returns a fast ack, the CLI
runs in `oshal-local-worker-bot` logs, and a second Jarvis message answers immediately during it.

## Update — 2026-06-20: the executor IS the build queue (oshal-worker removed)

The dedicated `oshal-worker` above was the wrong instinct — a generic catch-all that ran any CLI itself,
bypassing the selector-based routing the swarm was built for (and it accidentally reused agent id `…-0099`,
which already belongs to the `everything-default` general/fallback bot). **Removed** (registry entry, compose
service, persona, `WORKER_AGENT_ID`/`runWorkItem`).

Jarvis now files **every** tool/work hand-off as a `status:'approved'` ticket into the **build queue** — the
existing, general queue-manager pipeline (`QueueManagerService` → `TicketProcessor` → `CapabilityMatcher` /
`CompetencyRanker` / `LLMAgentRouter`). That pipeline IS the selector: `CapabilityMatcher` scores every bot by
capability match (specialists-first), so a ride routes to **`rides-concierge`** (caps `ride-estimate`,
`ride-options`, …), food to **`eats-concierge`**, etc., and a build decomposes into a team spun up on the fly
(`AgentFactoryService`). The owning app already declares its selector — bot capabilities + `ticketType` +
`workerBot` + its tool/route (e.g. `swarm-apps/rides.yaml` → `rides-routes.ts` runs the CLI, the concierge
reasons). `dispatchHandoffs` is now a single path (no simple/complex branch); `complexity` is a hint only.
Jarvis stays purely conversational and reports the result back, enriched, on delivery (`summarizeComplexTask`).

This also keeps work off the single-threaded jarvis-bot — the queue/concierge routes don't run on it — which
was the original reason for the worker, achieved properly through the framework instead of a side path.

**Resolved for rides (2026-06-20):** the build queue HTTP-dispatches only when a bot has its OWN container
endpoint ([QueueManagerService.js:2001](../../any-bot/server/services/queue-manager/QueueManagerService.js));
the concierges ran **inline** (`container: oshal-api`), so the queue fell back to in-process execution on the
controller — losing isolation + the standard path (unacceptable for FedRAMP traceability). Fix:
`rides-concierge` is now a **real bot-node** in its own `rides-bot` container on CODEX (shells out to
`scripts/oshal-uber-rides.js`), mirroring `home-bot` — registry container flipped to `rides-bot`
(`codex-cli`/`openai-codex`), a `rides-bot` compose service, persona rewritten to shell-out + rich markdown,
and `rides-routes.ts` `/chat` dispatches via `BotNodeClient` (the same path the queue uses). So Jarvis's ride
tickets and the surface both hit one isolated, traceable bot. **`eats-concierge` got the same treatment**
(→ `eats-bot` container, codex, shells out to `oshal-uber.js`; `eats-routes.ts` `/chat` via `BotNodeClient`).
The other inline reason-only bots (finance-analyst, identity-advisor) serve only their own surfaces, not the
build queue, so they stay inline for now. Rich result rendering is heading toward a **Shared Response
Renderer** (BACKLOG) — markdown now, typed blocks (map/chart/doc) later.

**Deploy:** `docker build -t oshal-bot:latest . && docker rm -f oshal-local-api oshal-local-jarvis-bot &&
docker compose -f docker-compose.oshal-local.yml up -d --no-deps oshal-api jarvis-bot`.

## Implementation note — 2026-07-11: visual response plane and mobile containment

The voice-first surface now treats the center cloud as the response plane rather than opening a
generic result window. A trusted backend-supplied image can materialize out of the particle field,
remain visible while Jarvis narrates it, and reverse into the cloud afterward. The authoritative text
and exact artifact remain in Discussion and can rematerialize without model regeneration. Text-only
answers stay on the orb surface; this presentation change does not alter `/ask`, delayed-work visual
eligibility, artifact ownership, persistence, or queue routing.

The center copy is also a bounded responsive slot. At mobile widths (`<=700px`) it reserves one user
line plus two answer lines, so an asynchronous reply fills existing space instead of moving the voice
controls or increasing page scroll height. Center replies and response-stage captions hard-wrap
unbroken tokens inside their containers. Discussion suppresses incidental outer horizontal overflow,
while tables and fenced code retain intentional scrolling inside their own local elements.

A `320x568` browser regression pins document width, reply width, hard-token caption containment,
stable control position, and stable scroll height during reply arrival. This closes the automated
mobile-containment part of JVV-004; physical-device, safe-area/dynamic-browser-chrome, and real
assistive-technology validation remain release gates.

The earlier note that typed response blocks were wholly future work is now historical. Jarvis has a
server-owned 15-kind visual slice: `weather`, `priority-email`, `table`, `chart`, `summary`,
`timeline`, `diagram`, provider-bound `gallery`, `map`, `gauge`, `checklist`, `agenda`,
`comparison`, `profile`, and trusted-receipt `image`. Completed delayed work may use any of the 15
bounded schemas. Timeline and diagram are deterministic structural SVGs; the diagram contract accepts
bounded nodes and edges, with no Mermaid, raw-SVG, HTML, URL-fetch, or executable-content field.

The delayed-only eligibility rule is narrowed, not removed. Direct turns remain text/orb-only by
default. The server may materialize a direct `timeline` or `diagram` only when the original user turn
explicitly asks for that exact presentation, no hand-off is attempted, the model supplies no source
claim, and every visible title, label, detail, node, and relationship is already stated in the
authoritative answer. The API replaces the empty source list with its own answer reference. Weather,
priority email, table, chart, summary, and every implicit or mismatched direct request remain
ineligible.

Model-authored Markdown image syntax is not trusted artifact metadata and never auto-loads. It is
rendered as an inert image-link notice; ordinary links remain click-only. The response stage and
Discussion replay accept only backend metadata for the exact same-origin, owner-scoped SVG artifact
URL matching its artifact UUID, MIME type, dimensions, and alt text. This keeps arbitrary remote,
data, and root-relative image URLs outside the automatic network/materialization path.

The `gallery` kind does not weaken that rule. It is delayed-work-only and is rebuilt from a bounded
`walmart-catalog` record. An explicit read-only Walmart ask is parsed by the authenticated Jarvis
route into a server-authored `product-search` intent, pinned to the Shopping bot, executed directly
against the request-scoped Walmart connector, and returned with provider `deterministic-provider`
and model `none`. It never depends on Shopping Codex choosing the connector instead of web search.
The legacy exact-command capture path remains fail-closed compatibility coverage. The
model-facing gallery spec has no URL or byte field. The API accepts only the approved Walmart CDN,
checks public resolution, forbids redirects, bounds time/stream bytes/pixels, verifies MIME and magic,
and transcodes the source to a metadata-free PNG. It embeds those bytes as `data:` inside the
server-owned sandboxed SVG and stores hash-only receipt provenance. The outer browser URL remains the
same authenticated owner artifact; a failed receipt falls back to the grounded result table/text.
Automatic provider summaries and galleries additionally require the matching server-authored intent
persisted with the completion, so a Walmart record captured during mixed/action work cannot replace
the full outcome with a read-only result. Immutable retries validate the grounded-spec digest and
reuse stored bytes before contacting the mutable image CDN again.

A DOM-free shared response component registry now provides the portability foundation: exact bounded
keys, duplicate rejection, per-surface capability filtering, ordered async execution, cancellation,
and safe fallback descriptors. Jarvis and the other cockpit/native/TV surfaces do not consume that
registry yet. Those adapters, plus generalized trusted source-byte ingestion for image/gallery/document responses
and any separately sandboxed HTML preview, remain open in JVV-006 and JVV-007:
[Jarvis voice and visuals — next steps](../backlog/jarvis-voice-and-visuals.md).

## Update — 2026-07-18: media input (image→text describe pre-pass)

Jarvis gained a new **primary input modality** — attach a photo (phone camera via `<input capture>`, or
upload) or a text document to a prompt. Because Jarvis's brain is the text-only Codex CLI, image
understanding is a controller-side transform, the visual analog of `/api/voice/transcribe`: `POST
/api/vision/describe` captions the photo via the swarm OpenRouter vision model *before* `/ask`, and that
description feeds the same turn — reasoning + cost stay on the accountable bot (ADR-036), and base64
pixels never ride the size-capped `/ask` body. The 2026-06-18 "Voice-first orb" note above enumerated
input as talk/type; attached photos + documents are now a third way in. Documents are text-based files
today (PDF/DOCX extraction is a BACKLOG follow-up). Full design + consequences:
[ADR-110](110-jarvis-media-input-vision-as-transcription.md).

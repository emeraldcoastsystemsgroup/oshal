# OSHAL Platform Feature Catalog

**Updated:** 2026-06-19 | **Derived from:** codebase inspection, ADRs, 150+ RALF sessions, live E2E validation

---

## What OSHAL Is

OSHAL is a multi-agent orchestration control plane that turns operator-submitted tickets into working software. It manages 46+ specialist bots across an 8-phase pipeline with built-in quality gates, cost tracking, and governance. Every bot runs in its own Docker container, communicates via Redis mesh, and writes to a shared workspace.

---

## 1. Multi-Agent Swarm Architecture

- **46+ specialist bots** defined as YAML personas in `ai-lab/bot-personas/`
- **Per-bot Docker containers** — each bot runs isolated with its own process, config, and Cline CLI instance (ADR-019)
- **Redis mesh transport** — agent-to-agent messaging via Redis Streams with consumer groups, request/reply, broadcast, and direct channels
- **Shared workspace** — all bots on a ticket tree read/write the same filesystem directory (PVC-mounted)
- **Per-agent Cline config isolation** — `.oshal/cline-runtime/{agentId}/` prevents concurrent config stomping
- **Hot-pluggable bot containers** — `BotContainerSpawnerService` creates isolated Docker containers on demand
- **Swarm bot registry** with Redis heartbeat tracking and online/offline status
- **Agent runtime registry** — central registry of all active agents and their capabilities

## 2. 8-Phase Execution Pipeline

Every ticket flows through a complexity-gated pipeline:

| Phase | Name | What Happens |
|-------|------|-------------|
| 1 | Intake | Score complexity (1-10), determine which phases run |
| 2 | Planning | PM bot decomposes ticket into subtasks with acceptance criteria |
| 3 | Specialist Input | Domain expert reviews plan (high complexity only) |
| 4 | Execution | Specialist bot writes code/docs to shared workspace |
| 5 | Testing | Structural verification + task-manager quality judgment |
| 6 | Review | 2-agent consensus review (high complexity only) |
| 7 | Delivery | Finalize, record metrics, store cross-ticket learnings |
| 8 | Architecture | System architect pre-round for technical specification (high complexity only) |

- **Complexity-driven phase gates** — low (score 0-3) skips phases 3/5/6/8; medium (4-6) skips 3/8; high (7-10) runs all
- **Regression loops** — testing/review failures loop back to execution with injected feedback (up to 3 retries)
- **Lifecycle state machine** — per-ticket phase tracking with guards preventing out-of-order execution

## 3. Agent Routing and Selection

- **4-tier routing cascade:** mesh bid auction → LLM routing → keyword match → score fallback
- **Phase-specific overrides:** PM always handles planning; architect always handles architecture; testers excluded from own code
- **PM-suggested agent assignment** — PM can suggest which specialist handles each subtask during planning
- **Capability gap detection** — if no online agent has required capabilities, auto-creates a specialist via `AgentFactoryService`
- **Adaptive rerouting** — classifies 12 failure types (offline, timeout, capacity, policy) and reroutes when possible
- **Routing audit log** — every decision dual-written to memory + Postgres with full candidate scoring, tiers attempted, and winner rationale
- **Competency ranker** — phase-weighted scoring blends base capability (30%) with phase-specific confidence (70%)

## 4. Agent Identity and Persona System

- **YAML persona definitions** — each bot has a persona file defining role, perspective, capabilities, system prompt, and routing keywords
- **Persona layer composer** — stacks multiple prompt layers by priority (identity, situation, history, memory, task, instructions)
- **Phase override layers** — review tasks get a different persona to prevent planning-SOP misbinding
- **Persona authorization seeder** — seeds tool authorization into persona definitions
- **File-based identity loading** — bots read `{agentId}-context.md` from workspace as their first action
- **7-layer prompt composition:**
  - Priority 5: Identity (persona YAML)
  - Priority 8: Situation (phase, role, round, colleagues)
  - Priority 30: History (executive summary of prior handovers)
  - Priority 31: Recall (agent's own prior work on this ticket)
  - Priority 35: Memory (organizational learnings from past tickets)
  - Priority 40: Task (work units, acceptance criteria)
  - Priority 45: Instructions (mandatory handover format)

## 5. Handover and Memory System

- **RALF developer handovers** — every agent writes a structured handover document after each round with sections: What I Did, What I Produced, Decisions Made, Open Concerns, What's Left, Key Context
- **Handover naming convention:** `{agentId}_PHASE_{n}_ROUND_{n}.md` in `developer-handovers/`
- **Scope-isolated handovers (IMP-2)** — child/review tickets use scoped filenames (`{scopeId}--{agentId}_PHASE_{n}_ROUND_{n}.md`) to prevent context bleed between siblings
- **Executive summary generation** — QM reads all prior handovers and generates a summary for the next agent
- **Context recall** — if an agent previously worked on this ticket, its prior handover is injected as "You worked on this before"
- **Cross-ticket organizational memory** — `SwarmMemoryService` stores learnings in ChromaDB (`swarm-memory` collection), queries relevant past experiences for new tickets
- **Swarm awareness prompt** — every agent gets situational context: phase position, role, round, colleagues, escalation protocol

## 6. Workspace and Deliverables

- **Shared workspace per ticket tree** — root ticket ID is the directory name, all children share it
- **Task folder service** — creates standardized workspace structure: `deliverables/`, `developer-handovers/`, `notes/`, `_meta.json`, `ROUTING-DECISIONS.md`, `TASK-BRIEF.md`
- **Code-server integration** — browser-based VS Code at port 8443 for viewing/editing workspace contents
- **Workspace file explorer** — `TaskExplorerWorkspaceService` provides file tree and content reading for the cockpit
- **PM preparation artifacts** — PM writes `IMPLEMENTATION-PLAN.md`, `ARCHITECTURE.md`, `PROJECT-PLAN.md`, `README.md` to workspace before execution begins
- **Workspace bootstrap service** — initializes shared workspace directories and mounts

## 7. Ticket System

- **Internal ticketing** — full CRUD with Postgres persistence and in-memory fallback
- **Parent-child hierarchy** — root tickets decompose into children; children share root workspace
- **Ticket lifecycle states:** backlog → approved → in_process_design → in_process_build → customer_action → complete / escalated / paused / cancelled
- **Project assignment** — tickets belong to projects with metadata inheritance
- **Parent assembly** — when all children complete, parent auto-assembles and transitions to `customer_action`
- **Escalation propagation** — if any child escalates, parent escalates too
- **External provider sync** — bidirectional Plane integration plus push-first GitHub issue intake

## 8. Intake System

- **Multiple intake channels:**
  - Cockpit UI direct submission (`POST /api/v1/tickets`)
  - Chat-based conversational intake (PM interprets chat as tickets)
  - Signed GitHub `issues` webhooks with optional cursor-backed REST reconciliation
  - Plane issues intake via work item feed adapter
  - API ticket endpoint (`POST /api/tickets`)
- **L1 intake processor** — assesses effort tier, planning mode, outcome type before queuing
- **Intake assistant service** — consulting-style conversational ticket creation
- **Intake cursor management** — tracks polling cursors for incremental intake from external systems

## 9. Verification and Quality

- **Structural checks (deterministic, no LLM):**
  - Design: work units have titles, acceptance criteria exist
  - Workspace: files exist in `deliverables/`, at least one > 50 bytes
  - Build: execution output exists, no errors, relevant content
  - Work-type evidence: keyword matching (code patterns for implementation, test patterns for testing, etc.)
- **Task-manager LLM judgment** — dispatches verification envelope to task-manager agent for quality assessment
- **Consensus review** — two independent reviewers (task-manager + domain specialist) must both approve
- **No-mock-builds enforcement** — stub/placeholder code is flagged as automatic failure in testing and review
- **Workspace artifact enforcer** — validates phase deliverables against artifact rules

## 10. Cost Tracking and Rollup

- **Token-level cost capture** — `TokenCapturingProvider` intercepts real token usage from every LLM call
- **Per-bot task IDs** — `{ticketId}::{agentId}` gives per-agent cost attribution within a single ticket
- **Real vs estimated pricing** — uses provider-reported costs when available, falls back to model-family pricing tiers
- **Ticket-task linking (ADR-027)** — `ticket_task_links` table connects bot tasks to tickets for cost rollup
- **Recursive tree aggregation** — `ticket_cost_rollup_with_children` Postgres view aggregates parent + all descendant costs
- **Per-model breakdown** — `usage_by_model` JSONB field stores per-model cost/token stats
- **Cockpit cost display** — ticket hierarchy enriched with `estimatedCost`, `actualCost`, `totalTokens`, `totalRequests`
- **Cline session token capture** — overrides initial dispatch tokens with accumulated session totals from Cline CLI

## 11. Governance and Failure Handling

- **Queue governance service** — ticket lifecycle state machine with cooldown enforcement, circuit-breaker detection, and stale-ticket detection
- **Stuck-agent watchdog** — escalates tickets stuck > 15 minutes in active dispatch
- **Dispatch timeout** — 12-minute pipeline timeout guard prevents hung slots
- **Circuit breaker** — after 3 failed dispatch attempts, escalate instead of retrying
- **Failure classification** — 12 failure types with reroutable/non-reroutable classification
- **Escalation severity levels** — low/medium/high/critical with target routing (human_review, team_lead, ops_channel)
- **Execution policy** — configurable budgets: max verification attempts (3), max build regressions (1), max design regressions (1), max total cycles (15), max run duration (30 min)
- **Stale-loop detection** — 0.85 similarity threshold prevents agents from repeating the same failed approach
- **Approval-required flows** — governance gate for destructive operations

## 12. Communication

- **Redis mesh transport** — Redis Streams with consumer groups for reliable agent-to-agent messaging
- **Mesh communication service** — request/reply, broadcast, and direct messaging patterns
- **Bid broadcasting** — tickets broadcast bid requests to all online agents; agents respond with confidence scores
- **SSE streaming** — Server-Sent Events for real-time UI updates (chat, ticket activity)
- **Agent-to-agent on-demand messaging** — bots can communicate directly via mesh channels
- **Comment formatter** — 10 comment types (progress, decision, blocker, etc.) for external system writeback

## 13. Security and Authentication

- **Keycloak OIDC integration** — Keycloak 26.0 with realm `oshal` and client `oshal-swarm`
- **Claude Code OAuth** — PKCE OAuth flow with credential persistence and CLI login orchestration
- **OpenAI Codex OAuth** — OAuth callback handling and credential exchange
- **Encrypted configuration storage (ADR-002)** — AES-256-GCM encryption for secrets
- **Tool auth interceptor** — intercepts tool calls for auth validation and encrypted credential injection
- **Auth middleware** — Express middleware for OIDC/OAuth authentication gates
- **Auth propagation** — propagate Claude Code session credentials across all bot containers
- **Mock OIDC mode (ADR-008)** — development mode bypassing auth for localhost testing

## 14. Operator UI (Cockpit)

- **15 pages** across the cockpit ecosystem:

| Page | Purpose |
|------|---------|
| Welcome | 5-step onboarding wizard with config health checker |
| Cockpit | Main control hub — ribbon nav, dynamic views, embedded chat, 11 themes |
| User Dashboard | Personal metrics, throughput chart, live activity feed (SSE) |
| Config Admin | Shared config, service runtimes (Presentron, RAG, Google Search MCP), per-bot settings |
| Task Explorer | Ticket hierarchy tree, search/filter/sort/group, detail tabs (Activity, Process, Cost, Files) |
| Queue Dashboard | Real-time queue visualization, schedules, work items, runs |
| Queue Manager Admin | Agent load, dispatch events, model usage, project usage, flow cards |
| Ops Dashboard | Runtime health, flow cards, agent status, attention items |
| Mesh Dashboard | Mesh channels, participants, ticket-to-channel linkage |
| Health Dashboard | Runtime diagnostics, agent health, run history, logs |
| RAG Center | Query lab, collection management, document browser, vector health |
| Swarm Bot Chat | Per-bot chat with auth controls, workspace actions, tool switching |
| Swarm Control | Bot selector, telemetry cards, status toggle, auth propagation |
| Redis Visibility | Redis key inspection, schedule/work-item/run state |
| Haven | Personal assistant conversational interface |

## 15. Tools and MCP Integration

- **Dynamic tool registry** — database-backed tool management with baseline and per-persona tools (ADR-010)
- **Switch framework** — per-agent tool enablement with auth mode switching (ADR-009)
- **Google Search MCP** — external MCP server for web search capabilities
- **Tool integrations:** Google Workspace CLI, Presentron (slides), RAG ingestion, personal finance, knowledge enhancement
- **Tool verification service** — validates tool execution and output
- **Tool approval system** — operator approval flow for sensitive tool operations

## 16. RAG (Retrieval-Augmented Generation)

- **ChromaDB vector store** — document ingestion with sentence-aware chunking and tiered overlap profiles
- **4 default namespaces:** swarm-tickets, swarm-messages, swarm-knowledge, swarm-memory
- **RAG Center UI** — query lab with relevance scoring, collection rollup, document detail inspector
- **Embedding model selection** — configurable embedding provider and model
- **Chunking strategies** — tiered or sentence-based with configurable chunk size and overlap

## 17. External Integrations

- **GitHub** — signed issue-webhook intake; optional REST recovery; comment writeback when separately credentialed; release-policy-controlled issue closure
- **Plane** — bidirectional kanban sync (intake + status/comment writeback)
- **Presentron** — presentation/slide generation
- **Google Workspace** — CLI tools for Google services
- **Code-server** — browser-based VS Code for workspace viewing at port 8443

## 18. Provider and Model Configuration

- **Per-bot model selection** — each bot can use a different provider/model via its agent profile
- **Provider resolution chain** — agent config → persisted global config → environment variables → defaults
- **Cline runtime config sync** — syncs provider/model selection to each bot's Cline CLI instance
- **Multiple providers:** Anthropic (Claude Code), OpenAI (Codex), OpenRouter
- **Auto-approve settings** — per-bot Cline auto-approval for file edits, command execution
- **Uncapped token limits** — `maxRequests: 0` (unlimited) for swarm bots

## 19. Infrastructure

- **4 Docker Compose stacks:** main (api-server + infra), core (standalone), dev (hot-reload), swarm-local (14 bot containers)
- **Dockerfile with full toolchain** — Node.js 20, Cline CLI, Claude Code CLI, kubectl, helm, argocd, terraform, vault, aws, gcloud, gh, glab, yq, docker-compose
- **Separate bot Dockerfile** — `Dockerfile.bot` for per-container swarm architecture
- **PostgreSQL persistence** — tickets, workspaces, agents, work items, cost events, persona layers, governance state
- **Redis** — mesh transport, schedule storage, agent heartbeats, subtask lifecycle
- **ChromaDB** — vector store for RAG and swarm memory
- **Keycloak** — OIDC identity provider
- **Headscale** — VPN/gateway configuration for external agent nodes (proposed)
- **Edge agent server** — distributed execution at edge nodes

## 20. Scheduling

- **Schedule service** — CRUD with Redis persistence and cron-based next-run computation
- **Schedule runner** — background dispatcher for due schedules
- **Recurring automation** — bots can be scheduled for periodic tasks

## 21. Observability

- **Structured JSON logging** — pino-based with child loggers per module
- **Routing audit log** — dual-write (memory + Postgres) with full decision context
- **Swarm metrics collector** — processing duration, regressions, attempts, compliance, handovers, approval rates
- **Agent metrics service** — per-agent execution KPIs (success rate, duration, retries)
- **Runtime trace analyzer** — per-ticket phase/round execution history and anomaly detection
- **Escalation records** — Postgres-persisted escalation history with target, severity, and reason
- **Config health scoring** — API endpoint that scores platform configuration completeness

## 22. Special Domains

- **Haven** — smart home assistant with home context aggregation, persona management, and direct LLM execution
- **RCA engine** — automated root cause analysis for incident response
- **Voice** — speech-to-text and text-to-speech services with voice orchestration
- **Presentation generation** — PowerPoint/slide deck creation via Presentron integration
- **Personal finance** — finance tools integration

## 23. Development and Governance

- **28 Architecture Decision Records** — formal decision documentation with status tracking
- **150+ RALF session briefs** — detailed session documentation with task briefs and completion reports
- **Master status list** — comprehensive project tracker (milestones, gates, sessions, issues, debt, risks)
- **Governance rules** — 1000-line file cap, 50-line function limit, RALF brief for every session, real data only
- **Unit tests (vitest)** — `npm run test:unit`; the concierge envelope/normalizer + shared-store logic suites (33 passing as of 2026-06-20). Playwright drives the E2E suite (`npm test`)
- **TypeScript strict mode** — 0 compilation errors
- **Change log headers** — every source file has a dated change log

## 24. Security Center (ADR-055, `/api/security`)

- **Active posture scan** — checks for committed secrets, unauthenticated routes, and vulnerable dependencies
- **Runtime threat detection** — flags anomalous bot/tool activity
- **Ledger anomalies** — inspects trading/purchase ledger rows for irregular entries
- **Access/audit** — reviews the dispatch trail
- **Reason-only triage** — a security-analyst (reasoning only, no remediation actions) triages each finding into a verdict, an attack scenario, and a proposed fix, then escalates it to a ticket
- **Observe / triage / escalate only** — the Security Center does NOT auto-remediate; remediation is left to operators/tickets
- Backed by migration 039

## 25. Payments (`/api/payments`)

- **Connected merchant account** — takes payments via a connected Square or PayPal merchant account using per-user brokered tokens
- **Deterministic, no bot** — the payment path is deterministic; no LLM/bot is in the loop
- **Sandbox by default** — runs in sandbox mode unless explicitly configured for live
- **PayPal caveat** — PayPal is a hosted invoice (the customer pays via a hosted page), not a direct charge

## 26. Purchasing — "Shopping" (`/api/purchasing`)

- **AI shopping concierge** — a concierge bot searches products and deals over the Walmart I/O provider (search/deals)
- **Preference learning** — learns user preferences over time
- **Checkout caveat** — checkout is a tracked affiliate deep-link handoff to the merchant; the platform NEVER takes payment in this flow
- **Amazon caveat** — Amazon PA-API is the next provider; it is NOT yet integrated
- Backed by migrations 035-038

## 27. Intelligent Operations / Self-Healing (`/api/alerts/alertmanager`)

- **Self-monitoring stack** — Prometheus + Alertmanager + cAdvisor watch the swarm's own containers
- **Alert-to-incident** — alerts open incident tickets
- **RCA pipeline** — proposes fixes for the incident
- **Self-healing-bot** — the only bot holding the Docker socket, with restart scope whitelisted to `oshal-*` / `swarm-*` containers; it APPLIES a fix only after operator approval (no autonomous remediation)
- **Consolidation** — unifies the former incident-remediation and issue-rca apps

## 28. Trading — "Intelligent Trades" (ADR-052/053, `/api/trading`)

- **Signal-justified trades** — every order is FK-bound to a decision, which is bound to a signal
- **Dual ledgers** — separate paper and live ledgers
- **Paper-only by default** — live execution is off unless explicitly enabled
- **Gravity Model research engine** — a research engine (ADR-054, `scripts/oshal-gravity.js`)

## 29. Token-Chase Optimizer, steps 3–4b (ADR-046)

- **Cross-model replay** — replays one captured LLM call on a different model/provider lane and compares cost, latency, and accuracy
- **Mounted and auth-gated** — `app.use('/api/token-chase', requiresAuth, …)` in `server.ts`. Surface: run/frame reads, frame inspect, `POST /runs/:id/replay` + `tail-replay`, and the step-3 optimize path `POST /runs/:id/frames/:seq/variant`
- **Savings report API exists** — `GET /savings`, `GET /savings/report` (the step-4b judged report), `POST /runs/:id/savings`
- **Step 4 — LLM-judge assessor** — grades baseline vs variant replay output via `JudgeService`, persisting `{judgeScore, dimensions, mode}` into the corpus with Jaccard retained as a comparable fallback. The 4b report **separates llm-judged from lexical-fallback frames** and never blends them into one "verified" number
- <sub>Corrected 2026-08-02 (BUG-1 under-claim). This entry carried a "Caveat — not wired to HTTP: the HTTP optimize routes are NOT yet mounted in `server.ts`, and there is no savings-report API yet." Both halves were false against the tree — the mount and all three savings endpoints exist. See [platform-shared-services.md](./platform-shared-services.md) "Token Chase step 4 / 4b".</sub>

## 30. Jarvis / OSHAL Assistant (ADR-050, `/api/jarvis`)

- **In-framework conversational bot** — `jarvis-bot` (codex), one continuous session per user; talks, reads its OPEN WORK / incident view, gathers context. It is **purely conversational** and never runs a tool itself (a single-threaded bot running a tool would lock the chat)
- **Batches tool work to the build queue, routed by selector** — the moment a request needs a tool, Jarvis files an auto-approved ticket into the build queue; `CapabilityMatcher` routes it to the owning bot (a ride → `rides-concierge`, food → `eats-concierge`) or decomposes a build into a team on the fly, while the conversation stays free
- **Enrich-on-delivery** — the result is reported back in Jarvis's voice with rich markdown (table / Mermaid / image) when it helps; actuating steps (order/send/publish/trade) stop for the user to confirm
- **Async** — `POST /ask` returns immediately; the surface polls, and finished work is announced (voice-gated) via the durable Tasks list
- _(Superseded: the original classify → delegate → synthesize route-orchestrator — see ADR-050 updates.)_

## 31. Unified Cockpit Home

- **Default profile** — `UI_PROFILE=oshal-framework` produces a grouped "everything" sidebar: Jarvis pinned as the hero on top, app groups in the middle, base essentials pinned to the bottom
- **Landing path** — `LANDING_PATH=/cockpit/`

## 32. OSHAL Node Desktop Worker (`packages/oshal-chat`)

- **Electron Jarvis orb** — a desktop app surfacing the Jarvis orb
- **Laptop as swarm worker** — pulls tasks and runs codex/claude locally using the user's own `~/.` CLI credentials, pushing results back
- **Off by default** — system screen/shell/input control is OFF by default (opt-in)

## 33. Unreal Engine MCP Worker (ADR-051)

- **GPU worker over MCP** — a GPU PC running UE 5.5 plus a C++ plugin is driven over MCP (port 55557) via the remote-client
- **Referenced upstream, NOT vendored (de-vendored 2026-07-23 for licensing)** — the worker clones `chongdashu/unreal-mcp` into `./unreal-mcp/` at bring-up; the MCP is registered as `unrealMCP` in `config-seed/claude-code-mcp.json`. Nothing Unreal is tracked in this repo (verified 2026-08-02: `git ls-files` matches only ADR-051 and its next-steps doc)
- **Caveat — not run live** — wired by inspection only: the plugin is unbuilt, the 55557 bridge is unverified end-to-end, and no GPU worker endpoint is provisioned. See [unreal-mcp-worker-next-steps.md](../apps/unreal-mcp-worker-next-steps.md)

## 34. Music — "Music" (`/api/spotify`)

- **AI music concierge over the user's OWN Spotify** — search tracks, see now-playing, list playlists, and BUILD a playlist on the user's account via the Spotify Web API (a real consumer API, not a curated catalog). Connector `spotify` (OAuth), `spotify-concierge` bot + `scripts/oshal-spotify.js` CLI + `spotifyToolKit.js` (agentic tools)
- **Playback is a deep-link handoff** — starting playback in-app needs Spotify Premium + the Web Playback SDK (not driven by OSHAL); "Open in Spotify" deep-links the track/playlist to the user's own app
- **Per-app concierge with durable memory** — the surface concierge keeps a stable, client-persisted conversation that resumes after navigating away (Jarvis-style persistence; turns saved in `spotify_messages`)
- **Caveat — Spotify dev-mode gate** — a non-published Spotify app is capped at **5 Premium test users** on an owner-managed allowlist; Extended Quota needs a registered org + 250k MAU (not attainable for a demo), so Music is **demo-grade**

## 35. Movies & TV — "Movies & TV" (`/api/movies`)

- **AI what-to-watch concierge over TMDB (free)** — search films + shows, trending, details, trailers, recommendations, and where-it-streams (JustWatch data). Connector `tmdb` (token-paste), `movies-concierge` bot + `scripts/oshal-tmdb.js` CLI + `moviesToolKit.js`
- **Watch + tickets are deep-link handoffs** — "Where to watch" opens TMDB's JustWatch page; "Tickets" opens a Fandango search; OSHAL never streams or sells
- **Per-viewer watchlist + durable concierge** — saves titles to the user's `movies_watchlist`; the concierge keeps a stable, client-persisted conversation (Jarvis-style)
- **TMDB key is operator-level** — a v3 API key OR a v4 read-access-token (client detects which), with a `TMDB_API_KEY` / `THEMOVIEDB_*` env fallback; **no per-user gate, so Movies is public-ready**

> **Music + Movies now ship from the store (ADR-085 Wave 2), not from core.** `server.ts` unmounted
> `/api/movies` (carve #1) and `/api/spotify` (carve #2); the installed packages
> ([`movies/`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/movies),
> [`spotify/`](https://github.com/emeraldcoastsystemsgroup/oshal-applications/tree/main/spotify))
> mount the same paths via `ManifestRouteMounter`. What stays core per ADR-093's interim tier: the
> `spotify-concierge` / `movies-concierge` bot-node quadruples and the `scripts/oshal-spotify.js` /
> `scripts/oshal-tmdb.js` CLIs. Install them with `node scripts/oshal-app.js install <name>` — a
> core image rebuild neither ships nor updates these two.
>
> <sub>Replaced 2026-08-02 — the "Go-live pending (Music + Movies, as of 2026-06-20)" banner that
> stood here listed a **cache-busted core rebuild** as blocker 1, which stopped being the deploy path
> for these apps at the carve, and repeated the Spotify allowlist gate already stated in the Music
> caveat above. The one item that was neither dated nor duplicated is kept as a real residual:</sub>
>
> **Open residual — concierge chat round-trip.** Discovery + the CLI tools are verified live; the
> LLM-envelope reply path (`/chat` → orchestrator → `{say, show, playlist|watchlist, remember}`) has
> not been exercised end-to-end on these two. The identical path is proven on rides, so this is
> unverified rather than known-broken.

## 36. Travel — "Travel" (`/api/travel`)

- **AI trip-planning concierge with REAL flight search** (ADR-059) — flights, hotels, and cars in one surface. Flights are live via the **Duffel** air API (a real consumer API); connector `duffel` (token-paste, `duffel_test_…`/`duffel_live_…`, env fallback `DUFFEL_ACCESS_TOKEN`), `travel-concierge` bot + `scripts/oshal-duffel.js` CLI. Routes `/api/travel`, migrations 050–051
- **Swarm-wide price intelligence** — every search + quote is recorded ANONYMIZED in `travel_observations` (no `user_sub`), so the concierge gives an honest "good / typical / high price — book now or wait" read computed from the route's recent history; improves for everyone with use
- **Fare watches** — a fare-watch cron (`startTravelFareWatchCron`) re-prices each saved route on an interval, grows the price DB, and flags a drop below the traveller's target
- **Booking is a deep-link handoff** — flights open a Google Flights search, hotels Booking.com, cars Kayak; OSHAL never takes payment or places an order (Duffel API booking is intentionally not wired — demo)
- **Caveats** — **hotels + cars are demo + deep-link** (Duffel has no car product; Stays needs geocoding); **rewards/account-linking is deferred** to the ADR-056 data-access broker; **no per-user gate, so flights are public-ready** once a token is connected
- **Per-traveller profile + durable concierge** — home airport/cabin/airlines/avoid in `travel_profile`; the concierge keeps a stable, client-persisted conversation (Jarvis-style; turns in `travel_messages`)

## 37. Eats — "Eats" (`/api/eats`)

- **AI Uber Eats concierge** — restaurant + dish search and order-building. Connector `uber` (food), `eats-concierge` bot + `scripts/oshal-uber.js` CLI
- **Ordering is a deep-link handoff** — no consumer order API, so the app builds the order and hands the diner off to Uber Eats; never takes payment
- Routes `/api/eats`, migrations 040–041

## 38. Rides — "Rides" (`/api/rides`)

- **AI Uber Rides concierge** — fare estimate + ride options. Connector `uber-rides` (transportation), `rides-concierge` bot + `scripts/oshal-uber-rides.js` CLI
- **The ride is a deep-link handoff** to the user's own Uber app; never books or charges
- Routes `/api/rides`, migrations 042–043

## 39. Feeds — "Feeds" (`/api/feeds`)

- **Slack feed intelligence** (ADR-037) — indexes the user's OWN Slack messages into a deduped `feed_messages` store (cron + on-view sync) via connector `slack`; the `feeds-curator` bot summarizes hot areas, trends, and "what did I miss"
- **Sentiment columns reserved** for the sentiment team (`sentiment` / `sentiment_label` / `sentiment_at` on `feed_messages`)
- Routes `/api/feeds`, migration 045

## 40. Standards-facing A2A gateway (ADR-109, `/api/a2a`)

- **External, non-OSHAL agents can join the swarm** — distinct from the operator's-own-devices `remote-client` rail. An agent card at `GET /.well-known/agent-card.json` (protocol `0.3.0`), JSON-RPC `message/send` / `tasks/get` / `tasks/cancel` at `POST /api/a2a`
- **Inbound work is real work** — `message/send` files an actual ticket on the ADR-083 call-out rails under a synthetic `a2a:<agentId>` owner, so budgets, DLQ and run-trace all apply. The controller never names a bot and never calls an LLM (the two-runtime rule holds)
- **Outbound is a first-class harness** — the `a2a` `harnessType` dispatches to an external agent as an ADR-033 harness sibling; cost lands real-or-honestly-flagged, never a silent `$0`
- **Default-off and A2A-native auth** — the whole surface is a hard 404 unless `A2A_GATEWAY_ENABLED=true`; per-agent hashed credentials with capability scopes, never a global secret, and never OIDC (an external agent has no browser session). `/api/a2a/agents` credential management is `requiresAuth` + operator-only. Per-agent inbound ceiling `A2A_MAX_INBOUND_PER_HOUR` (default 20 tickets/agent/hour) **fails closed** to 429 when the count itself can't be read
- **The published card leaks nothing** — skills are curated twice: the ADR-087 accessibility predicate (the same scoping that hides internal machinery from Jarvis) plus a defense-in-depth denylist over trading/dev/queue/factory/judge/packer/operator bots, so a drifted `accessRole` still can't publish one. Skill ids are name slugs — never agentIds, containers or ports — and the only URL on the card is the public JSON-RPC endpoint
- **The Redis mesh stays internal** — this is the only path an external agent rides
- **Honest residual** — deployment/interop items are tracked in BACKLOG "Plan F"; the gateway is not yet proven against a third-party vendor's agent

## 41. Personal knowledge graph (ADR-066, `/api/personal-graph`)

- **Connect → Pull → Ingest → Reverberate → Query, end-to-end** — `POST /api/personal-graph/ingest/:provider` pulls a provider's list through the ADR-065 spec client with credentials resolved per-caller via the ADR-056 broker, runs the provider's mapper, folds fragments into the store, then reverberates (cross-source entity dedup). `GET /api/personal-graph/*` serves stats / nodes / neighbors. Both routers are mounted `requiresAuth`
- **Four ingest mappers** — google-calendar, gmail, github, strava — plus the `reverberate()` pass, covered by 16 unit specs
- **Owner-scoped Postgres store is built** — migration `057-personal-graph.sql`; ADR-076 Phase 2 threaded owner scoping through `PgGraphStore` (required `ownerSub`, `user_sub` on every query, composite `(user_sub, id)` PK from migration `094` with matching RLS)
- **Default-off** — routes mount only when `PERSONAL_GRAPH_ROUTES=on`
- **Honest residuals** — `server.ts` still constructs `InMemoryGraphStore`, so the live graph is process-lifetime (wiring `PgGraphStore` is a composition change, not new code); there is no ingest scheduler (ingest is caller-triggered); and nothing surfaces the graph to Jarvis yet
- <sub>Added 2026-08-02 (BUG-1 under-claim). This capability was absent from the catalog while `connectors-and-graph-architecture.md` described it as an unimported library — see the correction there.</sub>

---

## By the Numbers

| Metric | Value |
|--------|-------|
| Specialist bots | 46+ |
| Swarm apps | 30 |
| Pipeline phases | 8 |
| UI pages | 15 |
| ADRs | 63 (latest ADR-061) |
| Session briefs | 150+ |
| Docker containers (swarm) | 14 active + infra |
| Database tables | 30+ |
| Unit tests (vitest) | 33 passing (concierge envelope + store) |
| TypeScript errors | 0 |
| Proven E2E cost | $0.71/execution |

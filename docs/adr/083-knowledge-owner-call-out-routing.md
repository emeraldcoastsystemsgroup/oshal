# ADR-083: Knowledge-owner call-out routing for Jarvis tasks (kill the semantic regex)

- **Status:** Accepted — implemented (2026-07-09). Operator decision: since Jarvis is the default
  concierge on every screen, the per-screen concierges are **classic any-bot nodes** (own container,
  heartbeating, biddable) — all 11 inline concierges promoted, plus `general-bot` as the fallback
  owner. Implementation: `task-call-out.ts` + `dispatch-manifest-worker` call-out/promotion,
  `resolveTaskBotAgentId` deleted, explicit `platform` handoff flag, name-boost de-weighted,
  boot seeders read persona declarations. Amended 2026-07-11 after the mixed-domain commerce
  incident: focused handoffs may fan out to a bounded set of near-leading qualified bidders, with
  credentials scoped and results attributed per owner. Amended again 2026-07-12 after the live
  Walmart trace proved that resolving a credential is not enough: every bot-node transport and
  workspace materializer must admit the same explicit broker allowlist, and parallel owners must
  use separate workspaces so cleanup cannot erase a sibling's credential. See the companion
  checklist's "Decisions — LOCKED".
- **Amends / relates to:** ADR-050 (Jarvis, in-framework bot with hand-off), ADR-036 (bot-owned application architecture), ADR-038 (swarms bundled by type), ADR-081 (which patched the same misroute class), ADR-079 (Haven), ADR-025 (tool auto-discovery)
- **Companion:** [docs/architecture/knowledge-owner-routing-config-checklist.md](../architecture/knowledge-owner-routing-config-checklist.md) — the per-bot config actions to execute this decision.

## Context

Operators reported Jarvis "coming back with no answer, or routed to the wrong person." The tickets tell the story exactly:

| Ticket | Ask | Went to | Why |
|---|---|---|---|
| `c597e227` | "Audit why trading stopped near $20k" | **shopping-concierge** | description contains "**target** exposure"; the shopping regex matches `target` |
| `7e9a53ba` / `ab985e3a` | "broken jobs board resume link" | **oshal-developer** | description contains the URL `oshal.agenticfederal.us`; the platform-dev regex matches the substring `oshal` |
| `1486c49d`, `3c04f8cf` | trading checks | project-manager (claude-code) | no keyword matched → PM default → **401 auth escalation** |

### This is a regression, not a missing capability

As of the **2026-06-20** update to ADR-050, Jarvis hand-offs were *already* designed the right way: *"Jarvis now files every tool/work hand-off as a `status:'approved'` ticket into the build queue… That pipeline **IS the selector**: CapabilityMatcher scores every bot by capability match."* Between then and 2026-07-06 it **regressed**: to avoid running the 7-phase build decompose on simple assistant tasks, a lightweight `task` ticketType was introduced ([dispatch-routing.ts:100-113](../../src/features/swarm-orchestration/services/dispatch-routing.ts)) — but in dropping the decompose it **also dropped capability routing** and substituted a free-text regex, [`resolveTaskBotAgentId`](../../src/app/routes/jarvis-routes.ts). The 7-phase bathwater was thrown out with the routing baby.

### The machinery already exists (and is live for `build`)

- **Call-out:** [`MeshBidBroadcaster.broadcastBidRequest`](../../src/features/agent-management/services/mesh-bid-broadcaster.ts) sends a `BID_REQUEST` to every online agent; each self-scores a confidence and replies `BID_RESPONSE`; the highest bidder is the "lead."
- **Decide:** [`AgentRouter`](../../src/features/agent-management/services/agent-router.ts) (4-tier: bid → LLM → keyword → capability-score) and [`PhaseRoutingService`](../../src/features/swarm-orchestration/services/phase-routing-service.ts); plus an [`AdaptiveComplexityService`](../../any-bot/server/services/queue-manager/AdaptiveComplexityService.js) (1–10 score from keywords + history + escalation rate).
- **Fast execution tier:** the pipeline already runs a **direct, single-bot, no-decompose, no-PM-planning** path for depth-1+ child tickets and incidents ([queue-manager-service.ts:1857](../../src/features/swarm-orchestration/services/queue-manager-service.ts)).
- **Register:** bots register via Redis heartbeats (`oshal:runtime-agent:{id}`); a `swarm.capabilities` channel exists but is unused.

The `task` path uses **none** of it — it pins a regex-guessed agent or falls back to project-manager.

### The knowledge-owner audit (2026-07-09)

A 16-bot audit ([companion checklist](../architecture/knowledge-owner-routing-config-checklist.md)) found the owners themselves aren't ready for a call-out:

- **11 of 16 owners are OFFLINE** (inline-on-api, no heartbeat) — they can never receive or answer a `BID_REQUEST`. This is a per-bot seeding gap, not an inline limitation: sibling `codex-packer` (also inline-on-api) *does* heartbeat.
- **home-bot is online but silently broken** — its `computed_*` bidding fields are empty, so it bids ~0 on its own smart-home domain.
- **Declarations are unusable for matching:** `routing_keywords` are verbatim copies of hyphenated capability tags (or empty); `selector_descriptor` is the entire multi-paragraph persona prompt (the router reads only the first line — a mid-sentence fragment).
- **Generic tags cause cross-domain over-bidding:** `preference-learning` (4 concierges), `checkout-handoff` (2), `compute`/`devops`/`cost`/`audit`; concrete keyword collisions include `target`, `order`, `scene`, `switch`, `cost`.
- **Reason-only owners depend on controller pre-fetch:** finance/identity/social/trading are handed a pre-assembled data context (Plaid aggregate, connection metadata, market context) — a bare `BID_REQUEST` prompt would let them *win* but not *do* the work.

## Decision

### 1. Routing is a call-out to knowledge owners, not a text match

Delete `resolveTaskBotAgentId` and the free-text `metadata.targetAgentId` pin. Jarvis files a ticket — **the ticket is the workflow trigger** — and the queue manager broadcasts a `BID_REQUEST`; the owners self-score and the queue manager **decides** from the ranked bids. Reuse `MeshBidBroadcaster` + `AgentRouter`; do not build a new router.

**"Non-semantic" means:** the bid self-score must weight the bot's **sharpened one-line selector + domain-scoped declared capabilities**, not raw bot-name / keyword token overlap. The current `+0.2` name-token boost ([extensions/swarm/index.ts:557-587](../../src/app/extensions/swarm/index.ts)) is *itself* semantic and is exactly what relocates the misrouting — **de-weight it** so a request containing "target" or "oshal" doesn't hand the ticket to whoever's name/keywords happen to overlap.

### 2. Three turn outcomes, assessed — the flexibility

```
Converse (no ticket)  — Jarvis answers from context/knowledge. Preserved.
Fast lane             — ONE knowledge owner, direct execution, NO decompose/PM planning
                        (the existing depth-1+/incident tier). Default for assistant tasks.
Multi-owner fast lane — TWO OR THREE independently qualified near-leading owners, each restricted
                        to its own domain and connector scope; one durable aggregate result.
Build lane            — depth-0 root → PM decomposes → specialist team. For real builds.
```

**Who decides the lane — both, layered:**
- **Jarvis hints** the shape (it already emits `complexity: simple|complex`), biasing the initial lane. Jarvis stays conversational and never runs the tool itself.
- **The queue manager has final say** — from `AdaptiveComplexityService` + the bid outcome. It **promotes fast → build** when no single owner claims the ticket, a capability gap is detected, or the ask is build-shaped; it keeps fast when one owner claims it cleanly. Neither Jarvis's guess nor a rigid `ticketType` locks the lane in.

This preserves the reason the `task` type was created (no 7-phase decompose on "check my email") *without* losing capability routing.

#### Mixed-domain fast tasks

A request can be small while still crossing owner boundaries: for example, an Uber Eats item plus a
Walmart item. Treating that as one auction silently drops whichever domain loses by a few confidence
points. Jarvis should emit one focused handoff per independent provider/domain when it can see that
shape. The queue remains the authority and supplies a second guard: on a bid-tier decision, it may
fan out to at most three registry-backed bidders that cleared the normal confidence threshold and
remain within a narrow margin of the lead.

Each selected owner receives the same authoritative request plus an instruction to handle only its
declared domain. Connector credentials are resolved independently for that owner; credentials are
never unioned or shared across workers. The controller persists one combined completion with the
actual `workerBots` and `workerAgentIds`, while retaining per-owner headings in the result. If the
bounded fan-out cannot be performed safely (for example, an owner has no dedicated endpoint), the
existing single-winner path remains the fallback. This is still a fast task lane, not the software
build/decomposition pipeline.

Credential scoping is an end-to-end contract, not merely a controller lookup. The controller's
provider-to-environment-key map, the canonical bot-node request sanitizer, the legacy any-bot
sanitizer, and both workspace materializers must share the same finite allowlist. An unknown
`OSHAL_CRED_*` key is rejected. Every selected owner receives only its own resolved keys. Parallel
owners use distinct workspace folder IDs, including distinct `.oshal-cred-*` files, so one
invocation's `finally` cleanup cannot delete another invocation's live credential. The 2026-07-12
incident violated this contract: the controller resolved `OSHAL_CRED_WALMART`, but the bot-node
boundary admitted only Google, Twitter, and SmartThings and silently discarded Walmart. The
Shopping bot therefore saw demo mode even though the owner's Walmart connection and signing key
were valid.

### 3. An owner must be biddable, equipped, and cleanly declared

Three preconditions for an owner to **win and complete** a call-out — all **configuration** (see the checklist):
- **ONLINE** — heartbeating in the mesh. (11 owners are not.)
- **EQUIPPED** — holds the tools to execute, *or* is a reason-only owner served by the preserved pre-fetch route (§4). `cloud-ops-bot` needs a `bash` grant; `movies` needs its TMDb tools registered; reason-only bots correctly hold zero tools.
- **DECLARED** — a crisp one-line `selector_descriptor`, domain-scoped `capabilities`, and natural-language `routing_keywords`, with cross-domain collisions removed. `computed_*` must be hydrated from `base_*` for every owner (home-bot is silently broken today).

### 4. Preserve the reason-only pre-fetch route and cost accountability (ADR-036)

Reason-only inline owners must **not** be handed a bare `BID_REQUEST` prompt they can't fulfill. Keep the "**controller pre-fetch → bot reasons**" path for them (win the routing decision, but execute via the existing inline/`BotNodeClient` path that pre-folds their data context) — or give them callable data tools. Whatever transport wins, `recordCost → chat_tasks` under the owning bot's `agent_id` must still fire (ADR-036 accountability is non-negotiable).

### 5. A defined low-confidence fallback, and named missing owners

When no owner bids above threshold, route to a **defined general, tool-capable fallback owner** or return **one** clarifying question — never `project-manager` (a planner, not a doer) and never a silent escalate. Domains with **no owner** today (a "who bids?" gap): video/creative, payments/merchant/selling, devops/Vault + RCA/IT-ops, and general web research / world intelligence. And two disambiguations the sharpened selectors must enforce: career **advisor** (advice) vs career-hunter **worker** (scrape/score/PDF), and the social **read** (communications-bot signals) vs **draft** (social-writer) vs **publish** (communications-bot) three-way.

## Consequences

**Positive**
- The misroutes ("target" → shopping, "oshal" → dev bot, unmatched → PM/401) are eliminated at the root: no free-text guessing.
- The queue manager **engages** on every task, exactly as the operator's mental model expects, reusing live machinery — mostly configuration, not new processes.
- Jarvis's job **shrinks** (a deletion): describe the work + hint complexity; it stays conversational and sometimes files no ticket at all.
- One coherent model spans converse / quick-task / build with the queue manager free to re-decide the lane.
- Mixed-domain requests no longer lose a valid second claimant, and the stored worker label reflects
  the bot that actually ran instead of the task workflow's `general-bot` fallback declaration.

**Negative / cost**
- Bringing 11 inline owners online and normalizing declarations is real config surface (the checklist) that must be done before the call-out helps — a half-done owner still loses its bids.
- A call-out adds a bid-window (~default 10s, tunable) of latency to the first routing decision vs. an instant regex; acceptable for an async assistant task, and skippable when Jarvis's hint + a single obvious owner allow a direct fast-lane dispatch.
- The bid self-score is still heuristic; the payoff depends on clean declarations (§3). If declarations stay dirty, the call-out just relocates the misrouting.
- A near-tie can execute more than one specialist. The owner count and confidence margin are bounded
  to control cost, and each worker keeps its own least-privilege connector scope.

**What this is NOT**
- Not a new routing engine — it wires `MeshBidBroadcaster` + `AgentRouter` + `AdaptiveComplexityService` + the existing fast/decompose tiers into the task lane.
- Not "Jarvis picks the bot" — Jarvis names no owner; it files a well-described ticket and hints complexity.
- Not a change to the reason-only data-app contract (ADR-036) — that route is explicitly preserved.

## Rollout

Execute via the companion **[knowledge-owner routing config checklist](../architecture/knowledge-owner-routing-config-checklist.md)**: Phase 0 biddability (the unblock) → Phase 1 declarations → Phase 2 the routing wiring (delete the regex, call-out on the task lane, lane selection) → Phase 3 reason-only pre-fetch + accountability + fallback. The two orthogonal infra fixes (Claude-token refresh, dev-bot git auth) are tracked in [BACKLOG.md](../BACKLOG.md), not here.

# ADR-087: Access roles — scoping bots and tools out of Jarvis's world

- **Status:** Accepted — implemented
- **Date:** 2026-07-10
- **Relates to:** ADR-050 (Jarvis), ADR-079 (Haven), ADR-081 (oshal-developer), ADR-083 (knowledge-owner call-out)

## Context

Jarvis discovers its world dynamically, and by default that world is **everything**:

- The **auto tool-feed** (`buildToolsBlock` in `jarvis-routes.ts`) enumerates every mounted
  `/app/scripts/oshal-*.js` each turn — deliberately, so a new CLI is never invisible. By 2026-07-10
  that was **51 scripts**, including the trading-research/backtest suite, the live-autopilot
  watchdog and trade-ops rails, the 5PM recap pipeline, the DevOps Vault CLI, the raw Gmail sender,
  the watchdog alert sender, and `oshal-apply.js` — which submits **real job applications**.
- The **app catalog** (`APP_ROUTES` + dynamic discovery over `swarm_applications`) is what the
  classifier may delegate/hand off to.
- Every hand-off becomes a `task` ticket the queue manager routes by **call-out** (ADR-083):
  a BID_REQUEST broadcast that every online bot receives and self-scores.

From a user's perspective (the operator, 2026-07-10): *they may not want Jarvis to see everything* — there
should be a way to keep specific bots and tools **invisible to Jarvis and uncallable from it**. And
it should be **a role, not a per-bot flag**: Jarvis is one caller among several, and "who may see
this" is an access-model question, not a boolean to sprinkle per assistant. The precedent is the
guest-capability matrix — one shared definition that both enforcement and UI read, so they never
drift. The existing `CALL_OUT_EXCLUDED_AGENT_IDS` hardcoded-ID set in `task-call-out.ts` was the
flag-shaped version of this need.

## Decision

A **caller-role access model** (`src/shared/types/access-roles.ts`):

```ts
type SwarmAccessRole = 'operator' | 'swarm' | 'jarvis';
roleCanAccess(accessRoles, caller)   // absent/empty declaration = open to every caller
```

Bots and tools **declare** which roles may discover/call them; enforcement surfaces identify
themselves by role. Scoping is always a deliberate opt-in — an undeclared bot/tool keeps its
current reach, so nothing changed behavior except the deliberately scoped set below.

**Declaration points**

1. `SwarmBotDefinition.accessRoles?: SwarmAccessRole[]` in the bot registries (both variants).
   `isBotAccessibleTo(agentId, role)` resolves against the ACTIVE registry; unknown agents
   (e.g. manifest-installed app bots) default to accessible.
2. `TOOL_CATALOG` entries in `jarvis-routes.ts` are now `{ usage, accessRoles? }`. A script on disk
   that must stay out of the assistant's feed gets a catalog entry whose roles exclude `'jarvis'`.

**Enforcement surfaces (caller role `'jarvis'`)**

- `buildToolsBlock` — role-filtered; the feed also now states the listed tools are the ONLY tools.
- `loadEffectiveRoutes` — curated + dynamically-discovered app routes are filtered through
  `isBotAccessibleTo`, which covers the classifier's catalog, delegation (`byKey` miss), and
  hand-off deep links in one place.
- `GET /api/jarvis/catalog` — same filter, so the surface's "what I can do" chips match reality.
- **Queue call-out** (`task-call-out.ts`) — a ticket with `metadata.source === 'jarvis'` is Jarvis
  calling: role-blocked bots are dropped from the candidate set AND added to the BID_REQUEST
  exclusion list, so they never even see the broadcast. The checker is **injected at composition**
  (`extensions/swarm/index.ts`) because the feature slice must not import the app-layer registry
  (FSD layering). Non-jarvis tickets are untouched.

**Scoped as of this ADR**

- Bots → `['operator', 'swarm']`: `project-manager`, `task-manager`, `queue-bot`,
  `oshal-developer` (privileged; the superadmin-gated `oshal-dev` lane is its only doorway),
  `codex-packer`, `agent-factory` (full registry), and `oshal-assistant` itself (Jarvis's brain is
  invoked directly by id from `jarvis-routes` — that is not discovery — but it must never appear as
  its own delegation target).
- Tools → `['operator', 'swarm']`: `oshal-apply.js`, `oshal-gmail-send.js`, `oshal-send-alert.js`,
  `oshal-vault.js`, `oshal-vids.js`, `oshal-tools-mcp.js`, and the trading research/pipeline suite
  (`oshal-backtest*.js`, `oshal-gravity.js`, `oshal-bars.js`, `oshal-equity-bars.js`,
  `oshal-intraday.js`, `oshal-algos.js`, `oshal-pick.js`, `oshal-monitor.js`, `oshal-optimize.js`,
  `oshal-signal-mine.js`, `oshal-signal-label.js`, `oshal-trade-ops.js`, `oshal-trade-recap.js`,
  `oshal-trade-data.js`, `oshal-deck-data.js`, `oshal-recap-*.js`).
  User-facing domain tools (gmail read/triage, trading paper portfolio, plaid, smartthings, …)
  stay open — hiding those is one `accessRoles:` line whenever wanted.

## Consequences

**Positive**

- One declaration removes a bot/tool from everything Jarvis sees AND every path Jarvis-sourced work
  can take — catalog, tool feed, surface chips, bid broadcast, candidate set.
- The model generalizes: a future `'guest'` or `'edge'` caller role reuses the same declarations;
  `CALL_OUT_EXCLUDED_AGENT_IDS` can migrate to roles over time instead of growing.
- Backward compatible: undeclared = unrestricted, so app bots (including manifest-installed ones)
  keep working with zero changes.

**Negative / limits**

- **Tool enforcement is at the prompt/routing layer, not the sandbox.** The jarvis-bot container
  still mounts `/app/scripts`; a model that ignores "these are your ONLY tools" could still shell
  out to a hidden script. Hard enforcement needs per-container mount scoping or an exec-guard in
  the bot sandbox — deferred (BACKLOG) until the soft gate proves insufficient.
- The Command Center **swarm map** (`GET /overview`) intentionally still shows all registered bots —
  it is the human's ops glance, not the assistant's brain. Revisit if operators want role-filtered
  maps per surface.
- **Not yet per-user.** Roles are platform declarations (registry/catalog). A user-level "Jarvis
  privacy" toggle (per-user allow/deny over the same role model) is the natural next layer — BACKLOG.
- Manifest-installed bots can't declare roles from their manifest yet (they default to accessible);
  adding an `accessRoles:` manifest field that flows into the loaded registry entry is a small
  follow-up if a scoped store app ever needs it.

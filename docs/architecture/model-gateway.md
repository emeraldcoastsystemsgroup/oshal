# LLM Model-Gateway Governance Layer

An ADDITIVE, OFF-BY-DEFAULT governance layer for LLM model calls: budgets (spend
caps), quotas (request/token windows), and cost-aware fallback routing (model
downshift). It sits in front of the existing, passive cost-tracking and
provider-runtime machinery and changes nothing until a maintainer opts in.

## Off by default (the core guarantee)

When `OSHAL_LLM_BUDGETS` is unset or off:

- `checkBudget(...)` returns `allowed: true`, `remainingUsd: Infinity` and never
  touches the database.
- `checkQuota(...)` returns `allowed: true` (unlimited); `recordUsage(...)` is a
  no-op.
- `selectModel(...)` returns the requested model UNCHANGED.
- `governLlmCall(...)` returns `{ allowed: true, model: requestedModel,
  downshiftedFrom: null, reason: 'enforcement-off' }` with no DB access.

Merging these files therefore changes no runtime behavior. The layer activates
only when the master switch is turned on and caps/policies are configured.

## Files

| File | Purpose |
| --- | --- |
| `src/features/llm-provider/governance/budget-service.ts` | Spend caps per scope. Reads today's spend READ-ONLY via the existing `CostTrackingService.queryCostFromDB`; small in-memory cache. |
| `src/features/llm-provider/governance/quota-service.ts` | Sliding-window request + token quotas per scope/key (in-memory; Redis-swappable). |
| `src/features/llm-provider/governance/fallback-routing.ts` | Pure, cost-aware model downshift (the ladder). |
| `src/features/llm-provider/governance/index.ts` | `governLlmCall(...)` facade composing budget + quota + routing. |
| `src/features/llm-provider/governance/gate.ts` | Process-wide gate: SHARED Quota/Budget singletons + `gateLlmCall()` + `recordGateUsage()` + projected-cost estimator. The shared singletons are what make the quota window actually accumulate (and, via `/check`, fleet-wide). |
| `src/features/llm-provider/services/governed-provider.ts` | Decorator that runs the gate before delegating `sendRequest`; wraps the controller's provider at the composition root. |
| `any-bot/server/services/llm/llmGate.js` | any-bot pre-flight: every provider `generateResponse()` calls this, which POSTs the controller's `/api/llm-governance/check`. Fail-open, off until enforcement is on. |
| `src/app/routes/llm-governance-routes.ts` | `GET /api/llm-governance/status` (read-only) + `POST /api/llm-governance/check` (the gate pre-flight bots call; internal-token guarded). |
| `scripts/migrations/055-chat-tasks-owner-sub.sql` | `chat_tasks.owner_sub` — per-user spend attribution for the `owner_sub` budget scope. |
| `tests/unit/llm-budget.spec.ts`, `tests/unit/llm-fallback-routing.spec.ts` | Vitest unit tests. |

## Environment flags + defaults

Master switch (shared by all three sub-systems):

| Env var | Default | Meaning |
| --- | --- | --- |
| `OSHAL_LLM_BUDGETS` | off | Master switch. Truthy = `on`/`true`/`1`/`yes`/`enabled`. Off = entire layer is a pass-through. |

Budget caps (USD/day; unset = no cap for that scope):

| Env var | Default | Meaning |
| --- | --- | --- |
| `OSHAL_BUDGET_GLOBAL_DAILY_USD` | unset | Cap for the `global` and `day` scopes. |
| `OSHAL_BUDGET_PER_OWNER_DAILY_USD` | unset | Cap for the `owner_sub` scope. |
| `OSHAL_BUDGET_PER_BOT_DAILY_USD` | unset | Cap for the `bot` scope. |
| `OSHAL_BUDGET_CACHE_TTL_MS` | 30000 | Spend-lookup cache TTL. |

Quotas (per scope/key per window; unset cap = unlimited):

| Env var | Default | Meaning |
| --- | --- | --- |
| `OSHAL_QUOTA_WINDOW_MS` | 60000 | Sliding window length. |
| `OSHAL_QUOTA_MAX_REQUESTS` | unset | Max requests per window. |
| `OSHAL_QUOTA_MAX_TOKENS` | unset | Max tokens per window. |

Routing:

| Env var | Default | Meaning |
| --- | --- | --- |
| `OSHAL_ROUTING_POLICY` | `auto` | `auto` (downshift only near cap), `cheapest` (always cheapest rung), `never` (honor requested model). |
| `OSHAL_ROUTING_NEAR_CAP_PCT` | `0.85` | Budget pressure (spent/cap) at/above which `auto` downshifts. Clamped to [0,1]. |

## Scopes

A budget/quota decision is keyed by `(scope, key)`:

- `global` — one shared cap across the deployment (key ignored).
- `owner_sub` — per end-user, keyed by OIDC `sub`. Enforced against THAT user's
  attributed spend via `chat_tasks.owner_sub` (Phase 2 — migration
  `055-chat-tasks-owner-sub.sql`; requires a DB migration run, not hotswap).
  Cost rows are attributed where the dispatch carries a `userSub` (the per-user
  bot routes — email/finance/security/trading — via the worker path); system /
  swarm tasks stay unattributed and fall under `global`/`bot` caps only.
- `bot` — per bot/agent, keyed by `agentId` (matched against the `byAgent`
  rollup in `chat_tasks`).
- `day` — a daily global window, keyed by ISO date.

## Fallback ladder

Pricing knowledge mirrors `usage-cost-resolver.ts` (whose `CLAUDE_CODE_FALLBACK_PRICING`
and `CODEX_FALLBACK_PRICING` are module-private). `fallback-routing.ts` defines a
PARALLEL ladder constant; KEEP IN SYNC if prices/families change.

Ladders are ordered most-expensive first; `auto` steps down exactly one rung,
`cheapest` jumps to the bottom:

- Anthropic (Claude): `opus` ($15/$75) -> `sonnet` ($3/$15) -> `haiku` ($1/$5)
- OpenAI Codex/GPT: `gpt-4.5` ($75/$150) -> `gpt-5.4` -> `gpt-5.3` -> `gpt-5.2`
  -> `gpt-5.1` (the gpt-5.x family is uniformly $2/$8, so steps inside it are
  capability downshifts at equal cost; gpt-4.5 sits far above).

Unknown families (e.g. `gemini-*`) are never downshifted.

## Wiring (as-built)

The gate is wired at TWO chokepoints — between the bots and the providers — so
every LLM call passes through it. Both are off until `OSHAL_LLM_BUDGETS` is set.

1. **Worker / all-bots path (the primary one).** Every bot is an any-bot, so the
   universal chokepoint is the any-bot provider's `generateResponse()`. The
   Cline / ClaudeCode / Codex providers call `llmGate.js` at the top of
   `generateResponse`, which POSTs the controller's
   `POST /api/llm-governance/check` with `{requestedModel, scope, key, estTokens}`.
   The controller runs `gateLlmCall()` (budget + quota + cost-aware downshift),
   estimates projected cost from `estTokens + model` (pricing stays on the
   controller), records the projected usage against the SHARED quota window, and
   returns `{allowed, model}`. On `!allowed` the provider throws; otherwise it
   uses the (possibly downshifted) `model`. Because the check runs on the
   controller, the quota window is **fleet-wide** across all worker nodes.
   `/check` is internal-token guarded (`x-oshal-internal`) and **fail-open** — a
   gate error never breaks the call path.

2. **Controller chat / form path.** `GovernedProvider` wraps the provider handed
   out by `createProviderResolver` (composition root), so `TaskOrchestrator` /
   PM-bot calls pass through `gateLlmCall()` on `sendRequest` and record usage
   against the same shared window.

**Per-user attribution.** `chat_tasks.owner_sub` (migration 055) is set by the
worker `recordCost` (from `userSub`) and at chat-task creation, so the
`owner_sub` budget scope reads only that user's spend.

**Deliberately NOT built: provider failover.** Switching a failed call to a
different provider was scoped, built as a foundation, then **removed by owner
decision** — a call must not silently run on a provider you didn't choose, and no
response is ever faked. On failure the gate/provider surfaces the real error.
(`NoopProvider` is a deploy-time stand-in when no real LLM is configured — not
failover.) The only retry is any-bot's pre-existing narrow "empty/unparsable
response" same-provider retry.

## Registering the admin route

`registerLlmGovernanceRoutes` is exported but NOT self-registered. A maintainer
adds it alongside the other route registrations in `src/app/server.ts`:

```ts
import { registerLlmGovernanceRoutes } from './routes/llm-governance-routes';

// near the other register*Routes(...) calls, after `app` + `ctx` exist:
registerLlmGovernanceRoutes(app, ctx, requiresAuth);
// GET /api/llm-governance/status -> enforcement on/off, caps, today spend vs cap
```

## Multi-replica note (quotas)

Quota usage is recorded on the **controller** (the `/check` endpoint uses the
shared `gate.ts` singletons), so it is already fleet-wide across all *worker*
nodes. The remaining limit is multiple *controller* replicas: each controller
process has its own in-memory window. To make quotas correct across controller
replicas, back the sliding window with Redis (sorted sets keyed by `scope:key`,
scored by timestamp, trimmed by window). The `QuotaService` surface
(`checkQuota`, `recordUsage`) is store-agnostic so a Redis impl drops in behind
the same methods. Budgets already read shared DB spend, so they are replica-safe
as-is (modulo the per-replica cache TTL). This Redis backend is **not built**.

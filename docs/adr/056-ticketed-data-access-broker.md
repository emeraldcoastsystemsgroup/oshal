# ADR-056 — Ticketed data-access broker: the reasoner never touches the data

- **Status:** Proposed
- **Date:** 2026-06-19
- **Related:** [ADR-045 (two-tier graph database + connector)](045-two-tier-graph-database-and-connector.md),
  [ADR-049 (OSHAL as aggregation platform)](049-oshal-as-aggregation-platform.md),
  [ADR-053 (trading-decision workflow)](053-trading-decision-workflow.md),
  [ADR (swarm application manifests)](033b-swarm-application-manifests.md),
  the intelligent-processing / self-healing backlog-gate work (2026-06-19)

## Context

The platform is becoming **an AI portal into a person's whole world** — home (IoT), money
(holdings/transactions), career (jobs), comms (email), plus a shared **world/deep-data** layer
(market, sentiment, demographics, polling, historical). The differentiator is not retrieval; it is
**graph-grounded reasoning that *relates* two datasets** (the thing RAG/Copilot structurally can't
do — see GraphRAG). That reasoning runs over a **tri-store** that shares one set of entity IDs:

- **Graph** (ADR-045) — entities + relationships (multi-hop joins)
- **Vector** (Chroma) — unstructured evidence (email, docs, articles)
- **Feature/metric store** (Postgres/Timescale) — numbers + historical time-series

The operator's architectural constraint, verbatim in spirit:

> "The backend is reasoning — it's never going to directly access the graph. That's a bot that
> isn't for chat. It all goes through ticketed channels to pull data — fully auditable and
> approvable. And it's on its own ticket under a super-user profile."

That is OSHAL's ticket pattern turned on the **data plane itself**: the conversational reasoner holds
**zero** data credentials; every pull is a brokered, logged, approvable swarm operation.

## Decision

Introduce a **deterministic data-access broker** as a non-chat swarm worker, the *only* identity
with credentials to the tri-store. The reasoner emits a structured **intent**; a `data-access`
ticket carries it; the broker authorizes → scopes → runs a parameterized template → returns only the
scoped result + provenance. Reuse the existing spine (ticketing, queue-manager dispatch, approve/close
gate, the backlog-vs-auto-approve dial) rather than build a parallel data runtime.

### 1. Separation of duties (three roles, none dangerous alone)

| Role | Can | Cannot |
|---|---|---|
| **Reasoner** (chat / Jarvis) | reason, propose an intent | hold DB creds, run a query, cross tenants |
| **Data-broker** (graph bot, non-chat worker) | reach the tri-store, run validated templates | reason, chat, accept free-form queries, cross tenants |
| **Data-steward identity** (the "super user") | the *only* credential holder | exercise discretion — it runs templates, nothing else |

The broker is **powerful in reach, near-zero in discretion**. Intelligence lives in the reasoner
(proposing intent) and the gate policy — never in an LLM holding a DB connection.

### 2. The `data-access` ticketType + intent schema

The reasoner cannot emit raw Cypher/SQL. It emits a **typed intent**:

```jsonc
{
  "ticketType": "data-access",
  "requestedBy": "<reasoner agentId>",
  "ownerSub": "<the user this is for>",     // tenancy — enforced by the broker, not trusted
  "purpose": "relate job leads to portfolio sector exposure",
  "intent": {
    "resolve": ["holdings", "job_leads"],    // entity sets to anchor on
    "traverse": [                            // graph hops (named templates, not free queries)
      { "from": "holding", "edge": "in_sector", "to": "sector" },
      { "from": "job_lead", "edge": "at_company", "to": "company", "then": "in_sector" }
    ],
    "metrics": [                             // precomputed numbers — math never goes to the LLM
      { "name": "sector_exposure_pct", "window": "current" },
      { "name": "sector_sentiment_trend", "window": "90d" }
    ],
    "evidence": { "query": "recent news on <sector>", "k": 5 }   // vector retrieval
  }
}
```

Intents are **readable** (auditable) and **template-bound** (the broker maps each `traverse`/`metric`
to a parameterized query — no injection surface).

### 3. The broker contract: authorize → scope → template → return

```
authorize(intent, ownerSub):
  - is requestedBy allowed to act for ownerSub?            (tenancy / confused-deputy guard)
  - does the policy class for this intent require a gate?  (see §4)
scope(intent, ownerSub):
  - every query is rewritten to be CONSTRAINED to ownerSub's private graph
    + the shared world graph. The steward can REACH the store; it can never CROSS tenants.
template(intent):
  - map each resolve/traverse/metric/evidence to a parameterized query; reject anything
    that doesn't map to a known template.
return(result):
  - hand back ONLY the assembled, scoped context (subgraph + passages + metrics)
    + provenance (sources, timestamps, the data-access ticket id). No store handle.
```

### 4. Fast-path vs gated (the latency answer — reuse the backlog dial)

Ticketing *every* read kills UX. So: **every pull is logged; the sensitive ones become gated
tickets.** Same hinge as the intelligent-processing `ALERT_DEFAULT_INTAKE` backlog dial.

| Class | Examples | Handling |
|---|---|---|
| **Fast-path** | read-only, single-domain, **own data** (portfolio value, today's calendar) | auto-fulfilled inline, sub-second, **logged** as a data-access event |
| **Gated** | cross-domain joins (finance × health), anything leaving the boundary, sensitive categories | opens an **approvable** `data-access` ticket, waits for approve/close |
| **Act** (writes) | place a trade, send email, change a device | **always** the approve/close gate (ADR-053 path) |

Default sensitive→gated; policy can auto-approve low-risk classes per user. Cache identical intents
per session to avoid pull spam.

### 5. Provenance round-trips

The broker's result carries the **data-access ticket id + sources + timestamps**. When the reasoner
says "your exposure to that sector is 22%," it traces to the ticket and the rows — **end-to-end
citation**, so the reasoning is trustable, not merely plausible.

### 6. The two-memory split this enforces

- **Private data store** — the user's tri-store, encrypted, in their boundary. The broker only ever
  scopes to it for that user.
- **Distilled personal memory** — what the AI learned (preferences/conclusions); separate, small.
- **Shared world memory** — Layer-B deep data; read-only, common, cited.

The broker is the membrane: private never leaks across users; world is read-only; every crossing is a
ticket.

## Consequences

**Why it's the moat.** Copilot/ChatGPT/Palantir log access in *admin* tooling the user never sees. A
**per-pull, user-visible, approvable** trail is a trust primitive none of them expose — and it's what
makes "give an AI your whole life" defensible for regulated / gov / privacy-sensitive buyers. A
prompt-injected reasoner can't exfiltrate the graph; the worst it can do is **file a ticket that gets
reviewed**.

**Risks to hold (the sharp edges):**
1. **Confused deputy** — the steward identity is the single most dangerous component. It must enforce
   the requesting user's tenancy on *every* query rewrite. Powerful reach, zero discretion.
2. **Keep the broker deterministic** — no LLM with raw DB creds, or the injection hole reopens.
3. **Approval fatigue** — over-gating → rubber-stamping. Sensitivity-tier hard; gate only what matters.
4. **Entity resolution** (upstream, ADR-045 ingest) is the make-or-break: "Apple" must be one node
   across email, holdings, and news, or the joins are garbage.

## Reuses (no new runtime)

- `data-access` ticketType → `entities/ticket/types.ts` enum (4-step checklist).
- Dispatch → existing queue-manager → manifest-worker to the broker bot.
- Gate → the approve/close lifecycle already shipped.
- Fast-path/gated dial → the backlog-default pattern from intelligent-processing.
- Tri-store → ADR-045 graph + Chroma + Postgres.

## Deferred

- The world/deep-data (Layer B) ingestion + correlation-edge precompute (sentiment/demographic/poll
  feeds with provenance) is its own ADR.
- Policy DSL for per-user sensitivity classes (start with a hardcoded class table).

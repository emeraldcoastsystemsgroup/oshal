# ADR-045 — Two-tier graph database + an engine-agnostic connector (and the "add-a-DB → management-bot" pattern it establishes)

- **Status:** Accepted — connector + both tiers + `/api/graph` + the swarm operational graph BUILT
  and LIVE; two of three domain carve-outs (jobs, capture) shipped. The RCA-persona rewiring and
  `subgraph()` were never built — see [Implementation — as built](#implementation--as-built).
- **Date:** 2026-06-17 (status reconciled 2026-07-26)
- **Related:** [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-041 (per-user storage targets / home base)](041-per-user-storage-targets.md),
  [ADR-042 (personal vs tenant tenancy)](042-iot-connector-tenancy.md),
  [ADR-043 (bot-scoped store)](043-presentation-studio-bot-store-and-guided-flow.md);
  the RCA bots carry no product prefix (the dead-product prefix was dropped in a bot rename refactor).

## Context

The RCA / topology bots (`graph-analyst`, `advisor-bot`, `remediation-writer`, `alert-intake-bot`)
reason over relationship-heavy data — "what did this outage touch", "what's central to this
failure", "shortest path between these two incidents". That is graph-shaped, and graph beats
relational for it. Their old graph access (the legacy graph routes) pointed at an **external Memgraph
that is gone** (the compose file strips it; the legacy routes were archived). So OSHAL has **no graph
database today** — this ADR adds the tier that replaces it.

It must follow OSHAL's existing isolation model — the same two tiers every data store uses:

- **Person level** — each user's own graph, isolated to their `user_sub` (like connector tokens
  and the home-base Files store, ADR-041).
- **Tenant/system level** — a shared graph per tenant (the personal-vs-shared model, ADR-042).

Constraints from the operator: **step it up** (a real, powerful graph engine — not an embedded
toy — so the graph-data-science algorithms RCA needs are available), **keep it cheap** (no per-seat
or Enterprise licensing), **keep it flexible** (not locked to one engine; flexible data shapes),
and **simplify it for users** (nobody writes a query or sees a connection string).

## Decision

**1. Two tiers, mirroring the storage/tenancy pattern.** A per-person graph and a shared
per-tenant graph. A user has exactly two concepts: *"my graph"* and *"the shared graph."*

**2. Engine: ArangoDB Community — cheap + flexible + powerful enough.**
- **Cheap:** Community edition is free and self-hostable, and — unlike Neo4j/Memgraph — its
  **multiple-databases-per-instance** is *not* paywalled. So per-person and per-tenant isolation is
  one database each inside one managed instance, with zero licensing.
- **Flexible:** multi-model (graph + document + key-value), so non-graph facets of the same data
  don't need a second store; and AQL traversals + the bundled graph algorithms (shortest path,
  k-shortest-paths, centrality, community detection) cover the RCA/impact/topology needs.
- **Not lock-in:** the engine sits behind the connector interface (point 3), so it can be swapped
  (to Neo4j+GDS for a heavy tenant, say) without touching a bot.

**3. The `graph-connector` — engine-agnostic, the only way in.** A thin interface that hides
everything, mirroring `resolveStorageTarget`/`saveContent`:
- `graph(sub)` → the caller's **person database**; `graph(tenant)` → the **shared tenant database**.
- It owns connection, auth, and **isolation** (a caller can only reach their own person DB + the
  tenants they belong to). Bots never see a URL, a credential, or a database name.
- Engine-specific code lives only here; the interface is plain (`upsertNodes`, `upsertEdges`,
  `query`, `neighbors`, `shortestPath`, `subgraph`). Swapping engines = one new adapter.

**4. Simplify for users — three layers of hiding.**
- **Natural language, never a query.** The user asks `graph-analyst` in plain English; the bot
  writes the AQL/traversal, runs it through the connector, and answers in plain language. Users
  never see the query language. (ADR-036: the bot reasons, the connector acts.)
- **Automatic ingestion.** The graph builds itself — incidents, connector data, and topology are
  upserted by the bots/intake on the way in; no manual modeling step.
- **Two concepts only.** "My graph" / "the shared graph." No connection settings, no schema knobs.

**5. The renamed RCA bots use the connector** in place of the dead legacy graph route — which is
what makes them functional again after the retired monitoring platform was decommissioned.

**6. This generalizes to "add a DB → get a bot that manages it."** The pairing of an
engine-agnostic connector + a per-domain NL bot is not graph-specific. **Adding any database** —
bring an existing one, or ask OSHAL to provision one — registers it behind a connector adapter and
**mints a management bot** (via `codex-packer`, [ADR-039](039-bot-driven-workflow-authoring.md)) that
*owns* it per ADR-036: provisioning, schema, NL queries, maintenance, all behind the same
"chat box, no connection strings" simplification. The graph database + `graph-analyst` is simply the
**first instance** of this. So "add your DB" becomes a self-service flow, and every DB arrives with
its own NL-speaking owner bot — the "bot owns its domain" rule turned into a repeatable capability.
Build the graph instance first to prove the pattern; generalize the onboarding flow + an adapter SDK
after it's real (see Consequences).

## Consequences

- **Positive:** a real graph platform (powerful algorithms) at zero licensing cost; per-person +
  per-tenant isolation consistent with every other OSHAL store; engine swappable behind the
  connector; users get a chat box, not a database. Multi-model means one store for graph + the
  document/kv facets.
- **Trade — "home base" becomes logical, not physical.** With a *server* engine the person graph
  is a **dedicated database in the OSHAL graph instance keyed to their `sub`**, not a file in their
  Dropbox/GitHub home base. Same isolation guarantee; the data lives in OSHAL's managed instance,
  not the user's cloud drive. (The file-in-your-drive model needs an *embedded* engine — the
  lightweight option deliberately not chosen here.)
- **Negative / cost:** a new stateful service in compose (ArangoDB) to run, back up, and secure;
  AQL is not native Cypher, so the NL→query layer targets AQL (fine — users never see it, and the
  connector could expose openCypher later); the isolation guarantee is only as strong as the
  connector's enforcement, so that code is security-sensitive (treat like the token broker).
- **Deferred:** cross-tenant / cross-person graph queries (privacy boundary — out of scope);
  swapping a heavy tenant to Neo4j+GDS (the connector makes it possible, not now); a visual graph
  explorer surface (the NL answer is the v1 interface).
- **Generalization (decision #6), deferred to after the graph instance:** the self-service
  "add-a-DB" onboarding flow + a connector-adapter SDK + auto-minting the management bot is a real
  framework piece, larger than the one graph instance. Prove the connector + management-bot shape on
  graph first; only then generalize, so the SDK is designed against a working example rather than
  speculatively.

## Adoption — which bots benefit (and which don't)

Not every app needs a graph; forcing it where relational/document fits is the trap. Three layers:

1. **Per-person graphs (built).** Any bot can already hand a user a private graph via the connector
   — opt-in, no schema mandate.
2. **A general swarm operational graph (the "layered general one") — built.** The swarm is itself a graph:
   agent ↔ ticket ↔ work-item ↔ phase ↔ artifact ↔ cost. A shared **tenant-tier** graph populated
   from swarm events lets any bot answer "what touched this ticket," "blast radius of a failing
   bot," cost-by-subgraph, and routing/competency over real history. General — every app's tickets
   flow through it; highest-leverage shared use.
3. **Domain carve-outs (same connector, richer ingested schema — NOT new infra):**
   - **Jobs (`career-hunter`) — strongest; built.** jobs ↔ companies ↔ recruiters ↔ skills ↔ applications ↔
     profile. The migrated 807k postings + 192 recruiters are a graph in waiting: "jobs two hops
     from companies I've interviewed at," recruiter-placement paths, skill-overlap ranking, the
     application funnel.
   - **Capture (`federal-capture` / `capture-crm`) — strong; built** (promoted leads mirror into the
     tenant graph from `gov-contracting-cron.ts`). opportunities ↔ agencies ↔
     incumbents ↔ teaming partners ↔ NAICS ↔ vehicles. Capture *is* a relationship-discovery problem
     ("who teams with whom," partner/prime discovery) — the likely "matters" carve-out.
   - **Communications / social — moderate.** people ↔ threads ↔ topics ↔ orgs; entity/topic
     networks. Useful, secondary.
4. **Skip — relational/document fits better:** presentations, storage, education
   (class-tutor/lecture-scribe/quiz-master/…), youtube-kids, finance (transactional), smart-home
   (small topology). The honest "maybe no one" for these.

The pattern: a carve-out is **domain ingestion + NL queries over the same `/api/graph` connector** —
no new database, no new service. That is why "add a graph to X" is cheap.

## Implementation — as built

Reconciled against the tree 2026-07-26. This section previously read "(planned)" long after most of
it shipped — the under-claiming failure mode CLAUDE.md's anti-drift rule 4 names.

### Shipped

- **Engine.** `oshal-arangodb` (ArangoDB 3.11 Community), volume-backed on the `oshal` network,
  host port 58529 — `docker-compose.oshal-local.yml`. `ARANGO_URL` unset is a supported state:
  the connector returns `null` and `/api/graph` returns 503.
- **The slice.** `src/features/graph/` — `graph-connector.ts` (`getPersonGraph(sub)` /
  `getTenantGraph(tenant)`, ensure-DB-on-first-use), `arango-graph-adapter.ts` as the single engine
  adapter, `graph-keys.ts` (the isolation boundary), `graph-types.ts`, `graph-ingestion.ts`.
- **The route.** `/api/graph` mounted `serviceSecretOr(requiresAuth)` in `src/app/server.ts` —
  caller-scoped AQL query, neighbors, shortest path, node/edge upsert. Bots never see DB creds.
- **Kernel skill.** Registered as `graph` in `src/shared/kernel-skills/registry.ts`, so packages
  reach it through `uses:` rather than copying platform code (ADR-090).
- **Adoption layer 2 — the swarm operational graph.** `startTicketGraphIngestion()` is wired at
  `src/app/composition-root.ts`; `TicketService` emits sanitized ticket-created / agent-assigned
  events (ids only) on the shared ticket bus.
- **Adoption layer 3 — two of three carve-outs.** *Jobs* — the `career-hunter` store package
  (`career-graph-routes`, cron mirror, insights AQL). *Capture* — `gov-contracting-cron.ts` mirrors
  each promoted lead into the tenant graph. *Communications/social* was never carved.
- **Guards.** `graph-keys`, `graph-ingestion`, `graph-route-degradation`, `data-lifecycle` unit
  specs, plus `scripts/graph-smoke.ts` against a live engine.

### Not built

- **The RCA-persona rewiring.** The personas were never pointed at the connector. `graph-analyst`,
  `advisor-bot` and `alert-intake-bot` — named in Context — do not exist in `ai-lab/bot-personas/`.
  `remediation-writer.yaml` still listed the dead **Memgraph** as a component until this change.
- **`subgraph()`.** The shipped `GraphHandle` is `upsertNodes` / `upsertEdges` / `neighbors` /
  `shortestPath` / `rawQuery`. Planned `query` shipped as `rawQuery`; `subgraph` was never added.
- **An incident/intake auto-ingestion hook.** Ticket-lifecycle ingestion covers the general case;
  no incident-specific hook exists.

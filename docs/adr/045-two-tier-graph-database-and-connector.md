# ADR-045 — Two-tier graph database + an engine-agnostic connector (and the "add-a-DB → management-bot" pattern it establishes)

- **Status:** Accepted — connector + both tiers + `/api/graph` + the swarm operational graph BUILT
  and LIVE; two of three domain carve-outs (jobs, capture) shipped; the RCA/capture persona rewiring
  DONE 2026-07-29 and `subgraph()` decided WON'T BUILD. One item is an open operator decision
  (`world-data` is not a kernel skill). See
  [Resolved 2026-07-29](#resolved-2026-07-29--the-ambiguous-middle-closed).
- **Date:** 2026-06-17 (status reconciled 2026-07-26; closure pass 2026-07-29)
- **Related:** [ADR-036 (bot-owned application architecture)](036-bot-owned-application-architecture.md),
  [ADR-041 (per-user storage targets / home base)](041-per-user-storage-targets.md),
  [ADR-042 (personal vs tenant tenancy)](042-iot-connector-tenancy.md),
  [ADR-043 (bot-scoped store)](043-presentation-studio-bot-store-and-guided-flow.md);
  the RCA bots carry no product prefix (the dead-product prefix was dropped in a bot rename refactor).

## Context

> **Editorial note (2026-07-29):** three of the four bot names below turned out to be phantoms —
> registry/catalog rows with no persona and no container. The real owners are `rca-specialist` and
> `capture-coordinator`; see [Resolved 2026-07-29](#resolved-2026-07-29--the-ambiguous-middle-closed).
> The original text is kept as written because the *problem* it states is unchanged.

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
- **The GDPR person-graph exporter.** `src/features/data-lifecycle/services/arango-person-graph-exporter.ts`
  exports and deletes a person's whole graph, backed by `personGraphExists(sub)` (an existence probe
  that deliberately does NOT provision) and `dropPersonGraph(sub)` on the connector. It closes the
  `arangodb_person_graph` export gap. *(Added to this list 2026-07-29 — it shipped and the list
  omitted it. Under-claiming costs the same credibility as over-claiming, CLAUDE.md anti-drift rule 4.)*
- **Guards.** `graph-keys`, `graph-ingestion`, `graph-route-degradation`,
  `graph-route-tenant-boundary`, `graph-adapter-read-only`, `data-lifecycle` unit specs, plus
  `scripts/graph-smoke.ts` against a live engine.

### Not built

- **An incident/intake auto-ingestion hook.** Ticket-lifecycle ingestion covers the general case;
  no incident-specific hook exists. The `rca-specialist` persona now upserts incident topology
  itself, which is the ADR-036 shape (the bot owns its domain) — a controller-side hook would be a
  second writer.

## Resolved 2026-07-29 — the ambiguous middle, closed

Everything below was either "planned" with no owner or "not built" with no decision. Each item is
now decided, and the two that are decisions rather than work say so.

### `subgraph()` — WON'T BUILD

`rawQuery` + `neighbors` cover every shipped consumer, verified against the code rather than assumed:

- the **data-lifecycle exporter** wants a FULL dump, not a subgraph — two `rawQuery` calls,
  `FOR n IN nodes RETURN …` and `FOR e IN edges RETURN …`;
- **career-hunter's insights** want AGGREGATES — `COLLECT … WITH COUNT INTO`, `SORT … LIMIT` over
  `edges` (`career-graph-routes.js`), which a vertices+edges subgraph would not answer any better;
- **`world`** delegates straight to `neighbors` (`WorldIntelligenceService.neighbors` → `g.neighbors`).

A third traversal primitive with no caller is dead API on the interface every future adapter has to
implement. **Revisit trigger:** the deferred visual graph explorer, or the first consumer that needs
vertices AND edges in one bounded response (a subgraph is not "a dump with a filter" — the bound is
the point). Until then `GraphHandle` stays `upsertNodes` / `upsertEdges` / `neighbors` /
`shortestPath` / `readQuery` / `rawQuery`.

### The RCA-persona rewiring — DONE

Done by this change. The three personas the ADR's Context named were **phantoms**: `graph-analyst`,
`advisor-bot` and `alert-intake-bot` had registry/catalog rows but no persona YAML and no compose
service, so none could ever be personified or dispatched. Their rows are removed (from
`swarm-bot-registry-local.ts`, `swarm-bot-registry.ts`, and the default `oshal` catalog in
`agent-profile-controller.ts`). The graph recipe went to the personas that do the work:

- **`rca-specialist.yaml`** — incident topology: node kinds `incident|service|host|alert|change`,
  edges `caused|depends_on|runs_on|touched`, read (`neighbors`/`path`/AQL `query`) before theorizing
  about blast radius, write only what the ticket evidence supports.
- **`capture-coordinator.yaml`** — capture teaming (this ADR's other named case): `opportunity`,
  `agency`, `contact`, `team`, `incumbent`, `naics`, `vehicle` with `solicited_by`, `teams_with`,
  `incumbent_on`, `contact_at`, `classified_as`, `awarded_via`. Facts only — an assumed
  `teams_with` becomes a past-performance claim someone repeats to a contracting officer.
- **`remediation-writer.yaml`** — the graph mention was REMOVED rather than upgraded. That persona
  writes fix scripts from the RCA's findings; topology is the rca-specialist's deliverable, and a
  second source of topology truth is how the two come to disagree. A component-list mention with no
  recipe read as "done" while nothing was wired.

Both personas already had `bash: auto` and `fetch: auto`, so no capability or tool grant changed.
Persona YAML is bind-mounted — this reaches a running swarm without a rebuild.

### `/api/graph/query` is now read-ONLY enforced

The endpoint documented itself as "run a raw AQL read" while calling `rawQuery`, which hands the
string to `db.query` — so a `REMOVE`/`INSERT` went through. Caller-scoped, so never a cross-tenant
hole; a contract the code contradicted, and a bot that mis-writes its own topology poisons the next
investigation. `GraphHandle.readQuery` now asks the ENGINE to plan the query (`db.explain`, whose
plan carries `isModificationQuery`) and refuses a modifying one with `400 graph_read_only` before
anything executes. Deliberately **not** an AQL keyword denylist (bypassable, and it rots with each
AQL release) and deliberately **not** a read-only streaming transaction: arangojs attaches the
transaction id to a single request, so a multi-batch cursor would silently fetch its later batches
outside the transaction. `rawQuery` stays the trusted in-process escape hatch the exporter dumps
through.

### The tenant tier is HTTP-unreachable, on purpose

`graph-routes.ts` only ever resolves `getPersonGraph(callerSub)`; `getTenantGraph` is in-process
only (the swarm operational graph, the world tier). The connector's own doc comment defers tenant
MEMBERSHIP to "upstream" — **and there is no upstream check today**, which is safe only because no
HTTP path reaches that tier. `tests/unit/graph-route-tenant-boundary.spec.ts` now fails if a route
starts honouring a `?tenant=` (or a tenant in the body or a header). Building that membership check
is the prerequisite for ever exposing the shared tier over HTTP.

### Open decision for the operator — `world-data` is not a kernel skill

`world` reaches the graph TRANSITIVELY: the store package imports
`@/features/world-data/world-intelligence-service` (a DEEP path, not even the barrel), and
`world-data` is **not** a registered kernel skill. It survives in `dist/` only because unrelated
app-layer core files happen to import it — `jarvis-brief-sections.ts` and the trading
assess/research/schedule/strategy-lab dispatchers. That is precisely the documented silent-prune
failure class (`tsconfig.server.json` excludes `src/features/**`; a re-export is the only pin), and
the day trading's dispatchers carve out, the installed `world` package fails at mount.

Two ways out, and it is the operator's call:

1. **Promote `world-data` to a kernel skill** — declare it in `src/shared/kernel-skills/registry.ts`
   and anchor it in `src/app/composition/kernel-skills.ts`. Cheap, but it also means committing to
   the modules the package deep-imports (`world-intelligence-service`, `news-fetcher`,
   `outlet-ratings`, `world-types`) or making the package import the barrel instead.
2. **Move the slice into the `world` package** — ADR-093 kept the Layer-B engine core because core
   callers exist; if those callers are the only reason, the honest resolution may be the reverse.

Not decided here because it is a kernel-boundary question (ADR-093), not a graph question.

### The `uses:` declaration gap — now gated

`swarm-app-loader.readManifest` validates a declared `uses:` list but never REQUIRES declaration
(the check is guarded on `uses !== undefined`), while `docs/apps/kernel-skills.md` says "declare what
your code actually imports". So five installed packages imported a kernel skill invisibly.
`scripts/check-kernel-skills.ts` grew **Phase 3**: for every store package, scan the COMPILED js for
the declared kernel specifiers and assert each resolved skill id appears in `uses:`. Three details
are load-bearing:

- **compiled `.js`, never `.ts`** — TypeScript erases `import type`, so a `.ts` scan reports
  `trading`'s `import type { ScheduleRecord } from '@/features/scheduling'` as a runtime dependency
  it is not;
- **declaration ⊇ imports, not equality** — `dnd` and `game-show` legitimately over-declare
  (`tool-registry`); requiring equality would turn healthy packages red;
- **`readManifest` was NOT changed.** That path runs at mount on live boxes; making it throw would
  fail-closed five already-installed packages the moment they mount. A gate belongs before the ship,
  not at the customer's boot.

Absent a store checkout the phase prints `PHASE 3 SKIPPED` and why — loudly, even under `--quiet`.

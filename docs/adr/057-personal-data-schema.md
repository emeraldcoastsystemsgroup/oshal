# ADR-057 — Personal data schema: the user model on their own storage

- **Status:** Accepted — core BUILT + verified 2026-06-19 (ontology + `SqliteVaultStore` + entity
  resolution + non-destructive dedup + the relate join, end-to-end green via `_verify.ts`). Vectors/
  unstructured, the shared world graph, and live app-wiring deferred.
- **Date:** 2026-06-19
- **Related:** [ADR-056 (ticketed data-access broker)](056-ticketed-data-access-broker.md),
  [ADR-045 (two-tier graph database + connector)](045-two-tier-graph-database-and-connector.md),
  [ADR-049 (OSHAL as aggregation platform)](049-oshal-as-aggregation-platform.md)

## Context

Everything else depends on this. The broker (ADR-056) gates access *to* a data shape; ingestion
writes *into* it; the reasoner relates *across* it. So the **personal schema comes first** —
**dependency order: schema → ingestion → broker.**

Principle the operator set: **the user is number one, and their data lives on their storage.** This
schema is therefore (a) **per-user / sovereign** — namespaced, encrypted, exportable, accessible only
through the broker; and (b) **tri-store** — the same entity IDs span graph + vector + metric so a
fuzzy email and a hard portfolio number are the *same* node.

## Decision

Define a small, extensible **personal ontology** (entities + relationships), a **per-user tri-store
layout** (the Personal Data Vault), an **ID + provenance convention**, and the **link rule** to the
shared world graph. Start with ~12 core entities spanning home / money / career / comms; grow the
ontology, never the architecture.

### 1. Core entities (v1 nodes)

| Entity | Is | Key attrs |
|---|---|---|
| **Person** | the user (`:self`) + contacts | name, handles |
| **Account** | a connected account = a connector instance (email, brokerage, bank, device-cloud, job board) | provider, label, status |
| **Organization** | employer, stock issuer, merchant, prospective employer | name, `world_ref` |
| **Security** | a tradable instrument | symbol, `world_ref` |
| **Holding** | a position (Person→Account→Security) | qty, cost basis |
| **Transaction** | a money movement | amount, ts, direction |
| **Opportunity** | job lead / application | title, status, fit_score |
| **Device** | an IoT device | type, room, state ref |
| **Message** | a comm (email, etc.) — unstructured anchor | subject, ts |
| **Event** | a calendar item | start, end, attendees |
| **Document** | resume / file / note — unstructured anchor | kind, ts |
| **Skill** | a career skill | name |
| **Place** | home / work location | label, geo |

*(Sector/Category is **not** a personal node — it's a world node; personal nodes reference it. See §5.)*

### 2. Core relationships (v1 edges)

```
Person  -owns->        Account, Device
Person  -holds->       Holding -of-> Security -issued_by-> Organization
Person  -applied_to->  Opportunity -at-> Organization
Person  -has_skill->   Skill
Person  -sent/recv->   Message -mentions-> (Org | Person | Security | ...)
Person  -attended->    Event -with-> Person
Transaction -from->    Account   -to-> Organization
Device  -located_at->  Place
(Organization | Security) -in_sector-> world:sector:*     # the JOIN to world data
```

Edges that span personal→world (`in_sector`, `world_ref`) are the seams the reasoner traverses to
relate private data to market/sentiment/demographic context.

### 3. The tri-store, per user (one ID across three stores)

| Store | Holds per user | Keyed by |
|---|---|---|
| **Graph** (ADR-045) | the user's nodes + edges (their personal subgraph) | entity id |
| **Vector** (Chroma) | a per-user collection: chunks of every Document/Message | `{entityId, type, source, ts}` metadata |
| **Feature/metric** (Postgres/Timescale) | numbers + time-series (holding value, sentiment-felt, spend, fit_score) | `(ownerSub, entityId, metric, ts)` |

Unstructured **dual-writes**: a Message/Document becomes a graph node *and* vector chunks *and* its
extracted mentions become edges — so fuzzy text participates in hard traversals.

### 4. ID + provenance convention (sovereignty + the broker's scope handle)

- **IDs are user-namespaced:** `user:<ownerSub>:<type>:<localId>` (e.g. `user:abc:holding:7`). This is
  exactly what lets the broker (ADR-056) **scope every query to one user** and never cross tenants.
- **World refs are global:** `world:company:apple`, `world:sector:semis` — referenced, never copied
  into personal storage.
- **Every node + edge carries provenance:** `source` (connector / data-access ticket id), `ingestedAt`,
  `confidence`. This is what makes a reasoned answer citable and auditable end-to-end.

### 5. Personal ↔ world link rule

Personal storage **never copies** world data. An `Organization`/`Security` holds a `world_ref` to a
node in the shared world graph. The reasoner joins at query time (your `Holding -of-> Security
{world_ref: world:company:apple} -in_sector-> world:sector:semis -> sentiment_trend`). Private stays
private; world stays read-only; the broker is the only thing that touches both.

### 6. Storage & sovereignty — the Personal Data Vault

- Each user has a **vault** rooted at a storage root — default the platform's **per-tenant encrypted
  partition** (`{STORE_ROOT}/{tenant}/{ownerSub}/`, the existing career-hunter / `ownerSub` pattern),
  **pluggable** to the user's own storage (their device, their bucket) without schema change.
- **Encrypted at rest, keyed to the user.** Sole accessor is the broker (ADR-056). No bot holds vault
  creds directly.
- **Exportable** — the vault is a portable bundle (graph dump + vector export + metric rows +
  manifest). Portability *is* the sovereignty promise: the user can take their world and leave.

### 7. Maps onto what exists (no new infra)

- Per-user dir + `ownerSub` scoping → already the career-hunter / ticket pattern.
- Graph → ADR-045 two-tier graph (the personal partition is the per-user tier).
- Vector → Chroma (per-user collection).
- Metrics → Postgres (add a Timescale-style metric table).

## Consequences

- The broker's tenancy guard (ADR-056 §2) becomes trivial and safe **because** IDs are
  user-namespaced — scope = "ids prefixed `user:<sub>:` + any `world:*`."
- "Relate two datasets" works the moment two personal entities share a `world_ref` or a sector edge.
- Sovereignty is structural, not a promise: encrypted per-user vault + export bundle.

**Risks / sharp edges:**
1. **Entity resolution** is the make-or-break (already flagged): one `Security`/`Organization` node
   per real-world thing, or joins are garbage. Needs a resolver on ingest (symbol/domain/email match).
2. **Ontology creep** — keep v1 to these ~12; add types only when a connector needs one.
3. **World_ref drift** — resolving personal entities to world nodes must be versioned/auditable.

## Deferred

- **Ingestion** (connector → dual-write into the vault) — next ADR; this defines the *target* shape.
- The shared **world graph** schema (Layer B) — its own ADR.
- Per-user vault encryption-at-rest key management.

# ADR-066 — Personal knowledge graph: turning connected data into a user-owned graph

- **Status:** Proposed — foundation BUILT 2026-06-21 (in-memory store + 4 ingest mappers +
  reverberation + tests); off by default, NOT wired into `server.ts` or any running path. The library
  lives at `src/features/personal-graph/`: a typed graph schema (`graph-types.ts`), a pluggable
  `GraphStore` with an `InMemoryGraphStore` impl (`graph-store.ts`), pure
  `(rawItem) => GraphFragment` ingest mappers for **google-calendar, gmail, github, strava**
  (`ingest/*`), a cross-source `reverberate()` pass (`reverberate.ts`), and a barrel (`index.ts`).
  16 unit tests green (`tests/unit/personal-graph/*.spec.ts`); typechecks clean.
- **Date:** 2026-06-21
- **Related:** [ADR-065 (connector runtime + declarative spec)](065-connector-runtime-and-spec.md),
  [ADR-056 (ticketed data-access broker)](056-ticketed-data-access-broker.md),
  [ADR-057 (personal data schema)](057-personal-data-schema.md)

## Context

ADR-065 turned ~35 connectors into live clients that return **normalized JSON** about the user's own
world — calendar events, emails, repos, activities, transactions, media. That is the raw material.
But normalized JSON, per source, is still just retrieval: ask a question, fetch some rows. The
incumbents do that — ChatGPT/Copilot retrieve over documents; Palantir/Glean build an *enterprise*
graph the company owns.

The productization plan names the missing piece: *"a portal into YOUR world you own"* where bots
**reverberate over the user's own data to auto-build a personal knowledge graph** (people, orgs,
events, places, activities, documents, transactions) that the user owns. The graph — not any one
connector — is the compounding moat: the same person you met on a calendar invite, who emailed you,
who owns the repo you contribute to becomes **one entity** linked across every source. Value compounds
as more sources connect; nobody else builds a *self-hosted, user-owned* cross-source graph.

The defect a foundation must avoid: a graph that duplicates the same person per source (no dedup), or
one welded into the running app before the schema settles. We want a clean, additive, well-tested
library that proves the shape, with deterministic ids so re-ingest is idempotent.

## Decision

Build the foundation as an additive library under `src/features/personal-graph/`, off by default.

### Schema (`graph-types.ts`)

- **Node types:** `Person, Org, Event, Place, Activity, Document, Message, Transaction, Repo, Media`.
  Each node has a stable `id`, `type`, display `label`, a `sources[]` list (every provider it was seen
  in, merged on dedup), and a narrow `props` field set per type. The raw provider item is intentionally
  not stored on the node — only the small fields needed to be useful and to dedup.
- **Edge types:** `attended, organized, located-at, authored, mentions, related-to, owns, paid,
  participated-in` — directed `from`→`to`, with their own `sources[]`.
- **Deterministic ids** are the linchpin of idempotence and cross-source merge: `person:<email>` (or
  `person:<provider>:<handle>` when no email), `event:google-calendar:<id>`, `message:gmail:<id>`,
  `repo:github:<owner>/<name>`, `activity:strava:<id>`, etc. Edge id = `<type>:<from>->-<to>`.

### Store (`graph-store.ts`)

`GraphStore` is the pluggable persistence seam (`upsertNode`, `upsertEdge`, `getNode`, `neighbors`,
`nodesByType`, `allNodes`, `allEdges`). The shipped `InMemoryGraphStore` enforces the trust contract:
**upsert merges, never duplicates** — by node id (sources accumulate, props shallow-merge with new
non-undefined values winning), and by edge `(type, from, to)`. A Postgres-backed impl (the user's own
store, ADR-057) is future work behind the same interface.

### Ingest (`ingest/*`)

Each mapper is a **pure function** `(rawItem) => { nodes, edges }`, no I/O, taking the exact normalized
item an ADR-065 resource returns:

- **google-calendar** (`gcal-list-events` event): Event node; organizer/attendee Person nodes;
  `organized`/`attended` edges; a `location` string → Place node + `located-at` edge.
- **gmail** (`gmail-get-message`): Message node; From person `authored` → Message; To/Cc people
  `mentions` (Message → Person). Header parsing handles `Name <email>` and bare addresses, comma lists.
- **github** (`github-list-repos`): Repo node; owner Person (email-keyed when present, else
  `github:<login>`) with `owns` + `authored` edges.
- **strava** (`strava-activities`): Activity node; start coords/city → Place + `located-at`; athlete →
  `participated-in` (email-keyed when the connected user's email is supplied, else `strava:<id>`).

### Reverberation (`reverberate.ts`)

The "connect things" pass over a whole store, idempotent and storage-agnostic:

1. **People dedup across sources.** Email-keyed person ids are already unified by the store's upsert,
   so a person seen in both calendar and gmail is one node carrying edges from both. Additionally,
   *handle-keyed* people (e.g. `person:github:octocat`) are folded into an email-keyed canonical person
   via two routes: the handle person learned an email of its own, **or** another email-keyed person
   carries the same provider handle (the handle→email bridge). Their edges are re-pointed onto the
   canonical id, with a `related-to` breadcrumb left for auditability.
2. **Org derivation.** Each person's non-consumer email domain seeds an `Org` node (created if absent)
   and a `related-to` Person→Org edge. Consumer domains (gmail/outlook/icloud/...) are skipped.

## Consequences

- **Positive:** the cross-source, user-owned graph — the moat — exists as a clean, tested foundation.
  Deterministic ids make re-ingest idempotent (no duplicate explosion on re-sync). The store interface
  keeps a Postgres/user-owned-store swap as a drop-in. Mappers are pure, so they are trivial to test
  and to extend to the remaining ADR-065 connectors.
- **Cost / next steps:** this is the foundation only. Still to come: more mappers (transactions via
  stripe/coinbase, documents via drive/dropbox, media via spotify/tmdb), a persistent `GraphStore`
  impl on the user's own store (ADR-057), wiring an ingest scheduler that pulls via the ADR-056 broker
  (so every read is ticketed/approvable), entity-resolution beyond email/handle (fuzzy name match),
  and surfacing the graph to bots/Jarvis.
- **Additive + off by default:** nothing imports this from `server.ts` or any running path; it is a
  library exercised only by its unit tests until a future ADR wires it in behind a flag.

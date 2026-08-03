# ADR-125 — Operations Stream: the event-to-action pipeline gets a durable memory

**Status:** Accepted — migrations 104–109 applied, pipeline landing live on the local stack
(2026-08-02). The consolidation cutover is **not** done; see "What is not yet true" below.
**Date:** 2026-08-02
**Builds on:** [ADR-119](119-autonomous-health-ticket-processing.md) (the autonomy ladder),
[ADR-045](045-two-tier-graph-database-and-connector.md) (the graph tier),
[alert-triage-and-consolidation-spec.md](../architecture/alert-triage-and-consolidation-spec.md)
**Implemented by:** [src/features/alert-pipeline/](../../src/features/alert-pipeline/),
[ops-pipeline-routes.ts](../../src/app/routes/ops-pipeline-routes.ts),
[alertmanager-routes.ts](../../src/app/routes/alertmanager-routes.ts)

## Context

Prometheus and Alertmanager were healthy, the scrape targets were correct, and the identity gate
worked: a ticket's `external_id` was already `SwarmContainerRestartLoop::oshal-local-devops#0`,
protected by a unique constraint. What did not exist was any **store** around that.

Measured against the live stack before this change:

| what you would expect to query | where it actually lived |
|---|---|
| the raw webhook payload | a request-handler local — gone on error, nothing replayable |
| the normalized alert | canonicalized in memory, then discarded |
| the incident record | inside a ticket's `metadata` JSONB |
| which alerts belong to one incident | a capped array in that same blob, truncated silently at 50 |
| alerts dropped as noise | an in-process counter that reset with the api |
| infrastructure topology | a hardcoded `Set` of container names in one TypeScript file |
| the evidence behind a grouping | nowhere |
| budget reservations | an array on one gate instance |

Three consequences followed from that, and all three are the reason this ADR exists:

1. **Nothing was replayable.** An alert that failed mid-processing left no trace at all, and the
   endpoint answered `200` for work it had not durably accepted — so the sender never retried.
2. **The noise allowlist could never be tuned**, because "what fired that no rule wanted" was not
   a question the system could answer.
3. **Incident state was a read-modify-write of a JSON blob**, so two concurrent writers silently
   lost each other's updates, and the dedup lookup was a scan over `tickets`.

## Decision

### 1. Thirteen tables, and two guarantees moved into the database

Migrations 104–109. The full column list lives in the migrations; what matters architecturally is
that **two invariants stopped being process-local**:

- a **partial unique index** on `oshal_incident (dedup_key) WHERE state IN ('open','resolved')`.
  This is the exactly-one-open-incident-per-identity guarantee. It holds across restarts and
  across replicas, which an in-process promise-chain lock never did — so that lock was deleted.
- a **CHECK** that a dispatch row is `attempted` XOR `suppressed`, keeping the three outcome
  buckets disjoint and exhaustive. A missing failed bucket is how a surface ends up rendering
  "10 attempts (0 sent / 0 deduplicated)" for a broken handler: it reads as a display bug while
  being load-bearing data that is simply not shown.

Retention is declared at table creation rather than bolted on: envelopes 7 days, events 30,
dead-letters 30, funnel 90, dispatch 180, snapshots **365** — the snapshot deliberately outlives
both the events and the incident row.

### 2. Identity is a hash over (alerting node, alert type), with a sentinel

`dedup_key = <deployment-id>:<sha256(identity_source)[0..32]>` over the normalized `target` and
`alertname`. Two rules carry the whole design:

- **A field that resolves empty becomes the literal sentinel `<fieldname>`, never an empty
  string.** Without it, every alert missing that field collapses into one identity: the first
  fires and every later one is suppressed forever.
- **`identity_source` is stored in plain text beside the hash.** A wrong key is otherwise
  undiagnosable, and the admin screen renders it live so a key can be tuned before an incident
  rather than after one.

Annotation text is deliberately excluded — wording drift would mint a new key per tick and
produce storms instead of suppression. So is the claiming rule: this pipeline is single-claim, so
including it would buy no isolation and would only re-fire everything whenever a rule is edited.

### 3. The reopen rule has exactly three arms

| arm | condition | behaviour |
|---|---|---|
| A | live and `open` | refire bumps `occurrence_count`, advances `last_seen`, escalates severity **upward only**, touches no ticket status |
| B | auto-closed, inside the reopen window | reopens the **same** incident and the **same** ticket; `reopen_count++` |
| C | operator-closed, or older than the window | archives the row, opens a new instance linked by `recurrence_of` |

Arm C exists because **a person's close is a decision.** Overriding it silently is worse than one
extra ticket. Arms A and B are one atomic `INSERT … ON CONFLICT … DO UPDATE` carrying a `CASE`, so
a burst cannot race two rows in.

### 4. Topology: reachability and transit are different questions

Topology is a graph problem and the graph tier is the system of record; these tables are the
mirror the pipeline reads, written at decision time so the incident write, the correlation it
used, and the snapshot that freezes it all commit together.

Traversal is undirected, depth-capped, bind-parameterised, with a path-array cycle guard. Two
node-level controls are load-bearing and are **not** interchangeable:

- **`traverse_via`** gates which edge types may *enter* a node.
- **`transit_allowed`** gates whether the walk may *continue out of* it.

The second was added after seeding the real compose graph. In a star topology every worker
depends on one control-plane node, so two hops through that hub connects every worker to every
other worker — one failure correlates the entire estate into a single component. Using
`traverse_via` to stop it removes the hub from the answer entirely, discarding the one
relationship that actually explains the incident. `transit_allowed = false` keeps the node
reachable at its true hop count and stops the walk there.

The same collapse reappears one layer up: component partitioning must bridge **only on
transit-permitted nodes**, or two peers that merely *reach* a marked hub are grouped anyway.

Correlation is **decoration, never a gate** — the admission decision already happened at the
claim stage, so a topology outage degrades incident quality instead of stopping paging. It fails
open to same-target grouping and increments a counter that is itself alarmed.

Loader sweeps are scoped to their own `loader_tag` and **refuse when they would delete half the
slice**. That proportional brake is the only thing between a truncated discovery feed and total
topology deletion, after which correlation silently finds nothing forever.

### 5. The intake contract: 202 after the commit, 503 on failure

The webhook lands the delivery verbatim before anything parses it, and answers `202` only after
that commit. A landing failure answers `503` so the sender retries. An unreadable body writes a
dead-letter row and answers `400`. Nothing is ever acknowledged that was not durably accepted.

### 6. Autonomy is a per-rule switch

`oshal_alert_claim_rule.autonomy_level`: **A0** parks for a human, **A1** writes the root cause
and the remediation plan and stops, **A2** applies it under the ADR-119 bounds. There is no A3 —
unbounded autonomy is a non-goal, not a future default.

### 7. Alarms are absence-shaped

Zero envelopes in ten minutes; any stage at zero while its predecessor is non-zero; pending events
older than five minutes; rising fallback rates. Threshold alerting only ever fires on data, so a
dead pipeline produces none — **absence detection is the only thing standing between a wedged
pipeline and a silent one.**

### 8. Two surfaces

- **System Health** (`/system-health`, read-only) — targets first, because "is anything even
  watching" must be answered before any other number means anything; then what is firing now with
  each alert's path through the pipeline, so "my alert vanished" is answerable on one screen.
- **Pipeline Admin** (`/alert-pipeline-admin`, operator) — claim rules saved as **one
  transactional full reconcile** (upsert the set, delete the remainder) so a disabled-but-still-
  matching rule cannot survive a save; a live dedup-key preview beside that identity's suppression
  ratio; the topology editor; drop counters; replay; and every knob with its effective value **and
  its source**.

Bots are reused, not minted: `intelligent-processing.yaml` declares `intelligent-operations` as a
dependency and references its incident bots by name.

## Consequences

### What is true now

Live on the local stack: envelopes land, events normalize and are decided, `0` pending and `0`
dead-letters under real Alertmanager traffic. Both surfaces serve and are auth-gated. 100 tests
across 8 spec files, each mutation-tested.

### What is not yet true

**`oshal_incident` is not being populated by the intake.** Consolidation still runs through the
existing ticket-metadata path; the new incident, member, dispatch and snapshot tables are written
only by the replay route. The stores, API and screens are live, but the headline change — incident
state *out* of ticket metadata — is **not cut over**. That is the next unit of work: replace the
consolidation call in the intake path and backfill in-flight tickets.

The discovery drivers that would populate topology from real estates (hypervisors, clusters) do
not exist. The tables and the graph model are ready for them; each driver is a connector plus a
`scripts/oshal-<platform>.js` CLI, following the `cloud-ops-bot` pattern.

### A trap this shipped with, and the guard that now holds it

Deploying found what testing could not: the five-second straggler sweep is background work with no
request in scope, and `OSHAL_DB_GUC_STRICT=deny` **refuses an unidentified connection outright**.
The timer kept firing and the logs stayed busy while the retry path was dead — "retried on the
next tick" had silently become "never retried". The in-request drain masked it entirely, because
it inherits the webhook's machine identity.

**Any background loop that touches the database must declare `runWithSystemIdentity`.** Guarded in
`tests/unit/alert-landing-durability.spec.ts`, which asserts the sweep both issues a claim and
declares an identity.

### Correlation depth is deployment-specific

The compose topology is a star. At depth 2 every bot already correlates with every other bot
through the api. Depth and hub marking are tuning inputs per deployment, not universal constants —
mark the hubs before raising the depth.

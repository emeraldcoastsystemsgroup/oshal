# Operations Stream — running and debugging the event-to-action pipeline

The path from a Prometheus rule firing to a ticket, and what to check when a link in it goes
quiet. Architecture and rationale live in
[ADR-125](../adr/125-operations-stream-event-to-action-pipeline.md).

```
Prometheus rule fires
  → Alertmanager groups by (alertname, container)
  → POST /api/alerts/alertmanager        [bearer, fail-closed]
  → LAND the body verbatim               → oshal_alert_envelope   → 202 (503 if this fails)
  → normalize + expand                   → oshal_alert_event
  → identity + dedup key                 → event.dedup_key
  → claim match                          → event.claim_decision
  → consolidate                          → oshal_incident (see "Not yet cut over")
  → correlate over topology              → oshal_topology_{node,edge}
  → freeze evidence                      → oshal_incident_snapshot
  → ticket → RCA → action                → oshal_alert_dispatch
```

## Surfaces

| what | where | who |
|---|---|---|
| live pipeline state | `/system-health` | any authenticated user |
| rules, keys, topology, replay | `/alert-pipeline-admin` | operator only |
| read API | `/api/ops/alert-pipeline/*` | authenticated; mutations operator-gated |

## First question: is anything even watching?

Check scrape targets **before** anything else. Every downstream number is meaningless if the
swarm is not being scraped.

```bash
curl -s http://localhost:9091/api/v1/targets?state=any \
  | grep -o '"health":"[a-z]*"' | sort | uniq -c
curl -s http://localhost:9091/api/v1/alerts     # what is firing right now
```

Prometheus is on host port **9091**, Alertmanager on **9093**. The swarm scrapes *itself* — every
runtime serves `/metrics` — so a target being down names an actual container.

## Second question: where did the alert stop?

Each stage writes a row, so the answer is a query rather than a log trawl.

```sql
select 'envelopes' stage, count(*) from oshal_alert_envelope
union all select 'events',        count(*) from oshal_alert_event
union all select 'pending',       count(*) from oshal_alert_event where claim_decision='pending'
union all select 'incidents',     count(*) from oshal_incident
union all select 'dispatch',      count(*) from oshal_alert_dispatch
union all select 'deadletters',   count(*) from oshal_alert_deadletter;
```

**A stage at zero while the stage above it is non-zero is the alarm condition.** The System Health
funnel renders that state on the card itself; `/api/ops/alert-pipeline/health` returns it in
`alarms`.

What fired that no rule wanted — the query that finds a coverage gap before an outage does:

```sql
select alertname, unclaimed_reason, count(*)
  from oshal_alert_event
 where claim_decision in ('noise','dropped')
   and received_at > now() - interval '24 hours'
 group by 1,2 order by 3 desc;
```

## Symptom → cause

| symptom | look at |
|---|---|
| envelopes rising, events flat | normalize failing — check `oshal_alert_envelope.normalize_error` and `oshal_alert_deadletter` at stage `normalize` |
| events stuck `pending` | the drain is not running. **Check the api log for `DB access with NO request identity DENIED`** — any background loop touching the DB must run under `runWithSystemIdentity`, or it is refused and claims nothing while the timer keeps firing |
| everything lands as `noise` | no claim rule matches. An **empty** rule table means *unconfigured* and accepts everything; rules present but non-matching records `no_rule_match` |
| one ticket per refire | the dedup key is too granular — preview it on the admin screen and compare `identity_source` |
| one ticket for unrelated alerts | the key is too coarse, **or** correlation is over-grouping. Check the suppression ratio on the admin screen |
| every alert in one incident | topology hub collapse — see below |
| nothing arrives at all | the receiver is fail-closed: with no `ALERT_WEBHOOK_TOKEN` it rejects every POST |

## Topology: hubs, depth, and the collapse

Correlation walks the topology undirected from the alerting node. Two node controls do different
jobs and are not interchangeable:

- `traverse_via` — which edge types may **enter** this node
- `transit_allowed` — whether the walk may **continue out of** it

In a star topology (which the compose stack is — everything depends on the api), leaving the hub
transitable means every worker reaches every other worker in two hops and the whole estate becomes
one incident. That failure does not look like a bug; it looks like correlation working unusually
well.

Mark the hubs, then set depth:

```sql
update oshal_topology_node set transit_allowed = false
 where node_key in ('oshal-local-api','oshal-local-redis');
```

The hub stays reachable at its true hop count — you still see "the api is the dependency" — but it
stops bridging its dependents. Check what a node actually reaches from the admin topology panel.

**Depth is deployment-specific.** Mark hubs before raising it.

Loader freshness — stale topology silently degrades correlation into false negatives:

```sql
select loader_tag, loader_scope, count(*), max(refreshed_at)
  from oshal_topology_node group by 1,2;
select * from oshal_topology_loader_run order by ran_at desc limit 10;
```

A run with `sweep_refused = true` means the proportional brake fired: a loader tried to delete
half its own slice, which looks like a truncated feed rather than a real decommission, so nothing
was deleted. Investigate the feed — do not relax the brake.

## Claim rules

Edited as a **set** and saved as one transactional full reconcile: the submitted rules are
upserted and every rule not in the set is deleted, in one transaction. Never skip-if-exists — that
silently freezes an edited rule while the surface reports success.

Rejected at save, with a reason per field:

- any **time or freshness predicate** — it is evaluated against the event's own timestamp and
  silently kills an entire lane while the rule sits visibly registered
- **free-text or timestamp identity fields** (`summary`, `description`, `startsAt`, …)
- an **empty identity field list**, and a predicate that can never match

`autonomy_level` is the switch: **A0** parks for a human, **A1** writes the root cause and the
remediation plan and stops, **A2** applies it under the ADR-119 bounds.

> Making a key **more granular is correct** and it **raises ticket volume**. Warn anyone alerting
> on ticket rate before such a change lands.

## Replay

Replay an envelope, a dead-letter row, or a time range from the admin screen. It is idempotent by
construction: the same identity lands on the same incident and bubbles it rather than duplicating.
Range replays are bounded and report how many were skipped.

## Not yet cut over

Consolidation still runs through the existing ticket-metadata path, so **`oshal_incident` is not
populated by live intake** — only by replay. Landing, normalize, identity and the decision record
are live; incident state has not moved out of ticket metadata yet. Until it does, read live
incident state from `tickets` (`external_provider = 'prometheus'`) and use `oshal_alert_event` for
the intake funnel.

## Related

- [self-healing-monitoring.md](./self-healing-monitoring.md) — the RCA and self-heal loop
- [deploy-parity.md](./deploy-parity.md) — after any manual container recreate
- [ADR-119](../adr/119-autonomous-health-ticket-processing.md) — the autonomy ladder

# Alert Triage & Consolidation — Functional Specification (intelligent-processing intake)

**Status: SPEC (target behavior — not yet built).** This document specifies the noise-gate,
deduplication/consolidation, and bundling behavior for the self-healing alert intake. Nothing in it
describes shipped code except the "As-built baseline" section; the build phases and their done-when
criteria live in [BACKLOG.md](../BACKLOG.md) ("Alert triage & consolidation").

- **Operator directive (2026-07-28):** non-noisy alerts get put into the queue; duplicates get
  bundled and consolidated. This is the analyst + self-healing portion of the platform.
- **Source of functional truth:** the operator's retired production SRE alerting platform — the
  14-microservice pipeline referenced in [ADR-069 §2a](../adr/069-operations-and-secops-connectors.md)
  (private, out-of-repo). Its behavior, constants, and — just as
  valuable — its own postmortem ADR trail were mined on 2026-07-28. Citations of the form
  "source ADR-NNN" refer to that platform's internal ADRs, not this repo's.
- **As-built baseline this spec extends:**
  [alertmanager-routes.ts](../../src/app/routes/alertmanager-routes.ts) (webhook intake),
  [intelligent-processing.yaml](../../swarm-apps/intelligent-processing.yaml) (queue + pipeline),
  [self-healing-monitoring.md](../runbooks/self-healing-monitoring.md) (the loop),
  [alert-rules.yml](../../ops/monitoring/alert-rules.yml) (the four current rules).

## 1. Problem

Today's intake is per-alert, and the analyst pays for it:

1. **Dedup is a silent skip.** A refire while a ticket is open is dropped with only a log line.
   The ticket shows no count and no last-seen, so a 50-refire crash loop and a one-shot blip are
   indistinguishable on the ticket surface.
2. **No bundling.** One failing container fires `SwarmContainerDown` + `SwarmContainerRestartLoop`
   — and if it is the api, `SwarmApiUnreachable` too. Three tickets for one incident, three RCA
   dispatches, three approve gates, three LLM bills.
3. **Noise handling is a binary allowlist.** `ALERT_APPROVED_NAMES` either opens a ticket or makes
   the alert vanish uncounted. There is no record of what was dropped, so the allowlist can never
   be tuned from evidence.
4. **Resolved is a no-op.** A ticket whose alert self-recovered looks identical to one still
   burning.
5. **Nothing meters the analyst.** Every auto-flowed ticket dispatches RCA — a duplicate storm is
   an unbounded LLM spend.

## 2. What the source platform proved — and what it didn't

The retired platform ran this problem in production for real infrastructure. Its lessons split
cleanly into *proven — adopt*, and *attempted — adopt the design, fix the documented flaw*. This
spec is built from both lists; §9 restates the flaws as do-not-repeat requirements.

**Production-proven (adopt):**

| # | Behavior | Provenance |
|---|---|---|
| P1 | **Subscription noise gate.** An alert proceeds only if a registered rule claims it; zero claims = noise, dropped **and counted** per alertname. Match means *route*, never suppress. | the percolate stage |
| P2 | **Identity-based consolidation.** One durable record per *incident key* (deterministic ID), preserving `first_seen` and separating `delivery_count` (real notifications) from `update_count` (suppressed refires). | the post-processor upsert |
| P3 | **Layered suppression with a reservation.** Atomic reserve-before-act so a burst cannot race N notifications through; release-on-failure so a retry can proceed; an in-memory TTL layer backed by a persistent probe that survives restarts; fail-open on probe errors. | the sender dedup gate |
| P4 | **24-hour suppression TTL.** Raised from 900s after real duplicate storms proved short TTLs re-notify all day. | source ADR-019 |
| P5 | **Dedup BEFORE the analyst.** A refactor once moved dedup after LLM enrichment; one incident produced ~270× amplification of a ~$0.035-per-call enrichment before it was gated again. | source ADR-018, ADR-016 |
| P6 | **Cost guard with a visible skip.** Hourly LLM spend cap over a sliding window, estimated cost reserved before the call and trued-up after; when capped, the record visibly says analysis was skipped — never a silent absence. | the enricher cost guard |
| P7 | **Incident-key granularity discipline.** A rule matching more than one alertname must include the alertname in its key; free-text message fields are forbidden in keys; an empty rendered key means every alert shares one key = silent mass suppression. | source ADR-031 |
| P8 | **Matchers answer "is this mine", never "is this recent".** Time predicates inside match rules silently killed all matching; freshness belongs to intake windows and TTLs, not claims. | source ADR-026 |

**Attempted / half-shipped (adopt the design, fix the flaw):**

| # | Design | The flaw, per its own docs |
|---|---|---|
| A1 | **Topology correlation** — graph BFS from alerting objects over a dependency graph, weakly-connected components = one incident, depth 3–5, with a plain field-grouping fallback ladder. | Correlation ran per-message against only the arriving batch; a batch of one alert can never correlate with anything, so the graph path degenerated and the fallback always ran. **Fix: correlate arrivals against OPEN incidents, not the batch.** |
| A2 | **Group composition.** Groups carried only a member *count*; membership was reconstructed after the fact by a time-window query the dashboard itself labeled "visibility, never a guarantee". | **Fix: record membership on the incident at attach time.** |
| A3 | **Root-cause candidate.** The emitted "leading event" was literally dict-iteration-first — arbitrary. The designed-but-legacy `leading_event_filter` (ordered filter list, first match wins) never made it to the streaming pipeline. | **Fix: port the ordered-policy design (§4, FR-D4).** |
| A4 | **Auto-resolve.** Configured in 18 alert rules, implemented in zero services — a silent no-op knob. | **Fix: implement resolved-handling narrowly, or do not offer the knob (FR-E4).** |

## 3. Scope and boundaries

- **This spec covers the intake stage only** — everything between the Alertmanager webhook payload
  and the `intelligent-processing` ticket queue. The incident-rca pipeline, the approve-or-close
  gate, and the self-healing-bot are unchanged. Every remediation stays human-gated.
- **oshal scale = one in-process stage** in the api ahead of ticket creation. No new services, no
  queue tech, no OpenSearch/NATS/graph-engine dependencies. Postgres tickets are the durable
  consolidated record. The controller/LLM boundary holds: triage is pure logic; the cost guard
  reads `chat_tasks` actuals, it never calls a model.
- **Enterprise scale stays ADR-069 §2a.** A deployed instance of the retired platform's pipeline
  can sit in front of this same webhook and the contract does not change — we respecify the
  *function* at swarm scale, we do not rebuild the 14 services, and where that pipeline exists we
  consume its output rather than re-derive it.
- **Engine-agnostic correlation.** The default dependency source is a static map; the ADR-045
  graph tier is an optional backend behind the same question ("are these two targets connected
  within N hops?"), never a requirement.

## 4. Functional model

```
webhook payload
   │
   ▼
[A. canonicalize + identity]  → drop (counted) if no identity
   │
   ▼
[B. claim gate]               → noise (counted per alertname) if no rule claims it
   │
   ▼
[C. consolidate]              → refire of an active incident? update it, don't create
   │
   ▼
[D. bundle]                   → related to an open incident? attach, don't create
   │
   ▼
[E. dispatch gates]           → budget / flap / resolved handling
   │
   ▼
ticket queue (backlog or auto-flow → incident-rca)   [unchanged from here on]
```

### Stage A — canonicalize + identity

- **FR-A1** A canonical alert is `{alertname, target, severity, status, firedAt, fingerprint,
  labels}`. Target resolves by the existing ladder (`container` > `container_name` > `name` >
  `pod` > `instance` > `job`).
- **FR-A2 Identity gate.** An alert with no resolvable target AND no alertname is dropped and
  counted (`reason=no_identity`). (The source platform's ingest bridges dropped identity-less
  alerts at the door; an alert nothing can act on is noise by definition.)
- **FR-A3 Every intake decision is counted.** `created | consolidated | bundled | noise |
  resolved | dropped`, queryable via an intake-stats read (per alertname for `noise`, so a
  "top noise sources" report exists and the claim registry can be tuned from evidence). Noise is
  *measured*, never invisible — this replaces today's uncounted vanish.

### Stage B — claim gate (the noise filter)

- **FR-B1 A claim registry decides "is this alert one we care about".** A claim rule is
  `{match, incidentKey?, intake?, bundleHints?}` where `match` is an exact alertname or a set of
  label matchers. Rules come from (in precedence order): per-alert labels in
  [alert-rules.yml](../../ops/monitoring/alert-rules.yml) (the SRE who writes the rule owns its
  routing — the existing `intake:` label pattern), a claims file/env
  (`ALERT_APPROVED_NAMES` remains valid as a pure-claim shorthand), and manifest-registered claims.
- **FR-B2 Unclaimed = noise.** Dropped and counted per alertname (never silently). Compatibility
  default preserved: with **no** registry configured, all firing alerts are accepted (today's dev
  default). With any registry configured, `ALERT_UNCLAIMED_POLICY` = `drop` (default) | `backlog`
  (park unclaimed as backlog tickets instead — the cautious migration setting).
- **FR-B3 No time predicates in matchers** (P8). Registry validation rejects a claim rule whose
  matcher references timestamps/ranges; freshness is exclusively the business of TTLs and windows
  in stages C–E.
- **FR-B4 First match wins.** Rules evaluate in declared order; one claim per alert. (Deliberate
  deviation from the source platform, which fanned one alert out once per matching rule because
  each rule addressed a different delivery target. Here there is exactly one queue; fan-out would
  recreate the duplicate-ticket problem this spec exists to kill.)

### Stage C — consolidate (identity dedup — the core)

- **FR-C1 Incident key.** Per-rule template, default **`{alertname}::{target}`**. Discipline
  (P7): a rule whose matcher can claim more than one alertname MUST include `{alertname}` in its
  key template; free-text fields (summaries, messages) are forbidden in key templates; a key that
  renders empty falls back to the alert fingerprint and logs a warning — distinct alerts must
  never silently share an "empty" key.
- **FR-C2 Exactly one active ticket per incident key.** Creation is an atomic claim (P3): reserve
  the key, create, release on failure so a retry can proceed. A burst of N identical firing alerts
  yields exactly one ticket, under concurrency (DB-enforced, not in-memory — see §9.7).
- **FR-C3 A refire on an active incident is a consolidation update, not a skip.** `updateCount`
  increments, `lastSeen` advances, and the member entry for that fingerprint records its own
  count. The ticket surface shows `first seen / last seen / ×N`. This *replaces* today's
  silent `skipped++`.
- **FR-C4 Severity only escalates.** Consolidated severity = max over members; a higher-severity
  refire raises the ticket's priority (never lowers it) and records the escalation. (Gap A-class
  fix: the source platform had no severity rollup at all.)
- **FR-C5 Recurrence within the TTL links, after it starts fresh.** A refire whose incident key
  matches a ticket that went terminal within `ALERT_CONSOLIDATION_TTL` (default 24h — P4) opens a
  NEW ticket carrying `recurrenceOf: <prior ticketId>` and an incremented recurrence count.
  Recurrence is signal for the analyst, not a fresh mystery.
- **FR-C6 Genesis fields are write-once.** `firstSeen` and `createdAt` are never overwritten by
  later updates (P2 — the upsert preserved genesis explicitly).

### Stage D — bundle (correlating *related* alerts into one incident)

- **FR-D1 Correlate arrivals against OPEN incidents, never only the arriving batch** (fix for
  A1). On arrival (after C), an alert that did not consolidate is checked against open
  intelligent-processing tickets with activity inside `ALERT_CORRELATION_WINDOW` (default 15m).
- **FR-D2 Same-target bundling.** Different alertnames on the same target within the window are
  one incident. (`SwarmContainerDown` + `SwarmContainerRestartLoop` on one container = one
  ticket.)
- **FR-D3 Dependency bundling.** A dependency map answers "are these two targets connected within
  `ALERT_CORRELATION_DEPTH` (default 3 — the depth the source platform actually deployed) hops?"
  Default map: static, derived from the compose topology (api → db/redis/chroma; bots → api/redis)
  plus operator overrides in a declared file. An alert on X bundles into an open incident on a
  dependency of X (and vice versa).
- **FR-D4 Root-cause candidate is an ordered policy** (port of A3's designed-but-unshipped
  selector): (1) an explicit per-rule root filter if declared, (2) the deepest dependency among
  members, (3) earliest `firstSeen`. Recorded on the ticket as `rootCandidate` + the reason it
  won. The RCA prompt receives it as a *hint*, never a verdict.
- **FR-D5 Composition is recorded at attach time** (fix for A2). The ticket carries its members —
  `{fingerprint, alertname, target, severity, firstSeen, lastSeen, count, attachReason}` — capped
  at `ALERT_MAX_MEMBERS` (default 50) with an overflow counter. The RCA bot reads the full
  picture from the ticket; nothing is reconstructed after the fact.
- **FR-D6 Graph tier optional.** When the ADR-045 graph tier is present and populated, FR-D3's
  question MAY be answered by a depth-bounded `/api/graph` neighbors read instead of the static
  map. Identical semantics (connected within depth ⇒ same incident); absent graph ⇒ static map.
  Never a hard dependency.
- **FR-D7 Attaching never restarts or promotes work by itself.** Attach to a backlog ticket keeps
  backlog; attach to an approved/in-flight ticket never re-dispatches RCA. If an attaching member's
  rule says `auto` while the bundle sits in backlog, the ticket gets a needs-attention flag for
  The operator rather than silently auto-promoting. Conservative by default; the human gate stays
  where it is.

### Stage E — dispatch gates

- **FR-E1 RCA runs once per incident.** Consolidation (C) and bundling (D) structurally prevent
  re-dispatch. Members attaching after RCA completed set a needs-attention flag ("new evidence
  after analysis"); re-running is an operator action, never automatic.
- **FR-E2 Analyst cost guard** (P5 + P6). Auto-flow dispatch respects
  `ALERT_RCA_HOURLY_BUDGET_USD` (default 10) over a sliding 1-hour window: reserve the recent p95
  per-RCA cost from `chat_tasks` actuals before dispatch, true-up after. Over budget → the ticket
  parks in backlog with a **visible** `analysis-skipped:budget` label; an operator promote always
  overrides. Never a silent skip. (Backlog-parked tickets never spend.)
- **FR-E3 Flap damping.** `updateCount` ≥ `ALERT_FLAP_THRESHOLD` (default 5) within
  `ALERT_FLAP_WINDOW` (default 30m) marks the incident `flapping`; if RCA has not yet run, dispatch
  defers until the incident is quiet for `ALERT_FLAP_QUIET` (default 10m) or an operator promotes.
  Flapping is surfaced as state, not silently suppressed (the source platform only *narrated* flap
  patterns inside enrichment context; nothing acted on them).
- **FR-E4 Resolved handling** (fix for A4 — implement narrowly, honestly). A `resolved`
  Alertmanager event marks the matching member resolved with a timestamp. Auto-close happens ONLY
  when `ALERT_AUTO_RESOLVE=true` (default **false**) AND the ticket is still `backlog` AND every
  member is resolved → ticket completes with a `self-resolved` label. A ticket at `approved` or
  beyond never auto-closes — if the analyst is already engaged, a human decides.

## 5. Data model — the consolidated incident record

The ticket IS the consolidated record (the platform equivalent of the source's one-doc-per-key
upsert). All triage state rides `metadata.incident`; the existing
`findActiveTicketByMetadataKey('alertFingerprint', …)` lookup generalizes to the incident key.

| Field | Semantics |
|---|---|
| `incident.key` | Rendered incident key (FR-C1). Unique among active tickets (FR-C2). |
| `incident.firstSeen` / `lastSeen` | Genesis (write-once) / last activity of any member. |
| `incident.updateCount` | Suppressed-refire count (P2's `update_count`). |
| `incident.members[]` | `{fingerprint, alertname, target, severity, firstSeen, lastSeen, count, attachReason, resolvedAt?}` — capped, with `membersOverflow` counter (FR-D5). |
| `incident.rootCandidate` | `{target, reason}` (FR-D4). |
| `incident.recurrenceOf` / `recurrenceCount` | Terminal-predecessor link (FR-C5). |
| `incident.flags[]` | `flapping`, `analysis-skipped:budget`, `needs-attention`, `self-resolved`. |

Intake counters (FR-A3) are served by an auth-gated stats read on the alerts route family; they are
operational telemetry, not ticket data.

## 6. Configuration

| Knob | Default | Meaning / provenance |
|---|---|---|
| `ALERT_APPROVED_NAMES` | unset | Existing create-allowlist; becomes a pure claim shorthand (FR-B1). |
| `ALERT_UNCLAIMED_POLICY` | `drop` (when a registry exists) | `drop` \| `backlog` (FR-B2). No registry at all ⇒ accept-all dev default, unchanged. |
| `ALERT_CONSOLIDATION_TTL` | `86400` (24h) | Recurrence window (FR-C5). P4: 900s TTLs re-notified all day; 24h is the battle-tested value. |
| `ALERT_CORRELATION_WINDOW` | `900` (15m) | Open-incident bundling window (FR-D1). |
| `ALERT_CORRELATION_DEPTH` | `3` | Dependency hops (FR-D3) — the deployed depth at the source, not its default 5. |
| `ALERT_DEPENDENCY_MAP` | derived static map | Override file for FR-D3 edges. |
| `ALERT_MAX_MEMBERS` | `50` | Member-list cap with overflow counter (FR-D5). |
| `ALERT_RCA_HOURLY_BUDGET_USD` | `10` | Sliding-hour analyst cap (FR-E2) — the source's shipped default. |
| `ALERT_FLAP_THRESHOLD` / `_WINDOW` / `_QUIET` | `5` / `1800` / `600` | Flap damping (FR-E3). |
| `ALERT_AUTO_RESOLVE` | `false` | Backlog-only auto-close on full resolution (FR-E4). |
| `ALERT_TICKET_TYPE`, `ALERT_DEFAULT_INTAKE`, `ALERT_BACKLOG_NAMES`, `ALERT_WEBHOOK_TOKEN` | unchanged | Existing intake knobs keep their exact behavior. |

Defaults live in one constants module. (§9.8 — the source shipped a config whose documented default
and read-site default disagreed; one source of truth prevents that class.)

## 7. Acceptance criteria (the guards, per the guard-per-fix doctrine)

Each phase ships these as named specs that go red if the behavior regresses:

1. **Burst → one.** 10 identical firing alerts POSTed concurrently ⇒ exactly 1 active ticket,
   `updateCount=9`. (FR-C2/C3)
2. **Refire is visible.** A second firing of an active incident changes `lastSeen` and
   `updateCount` on the ticket — not merely a log line. (FR-C3)
3. **Noise is counted.** An unclaimed alertname increments the noise counter for that name and
   creates nothing. (FR-B2, FR-A3)
4. **The api-down drill bundles.** `SwarmApiUnreachable` + `SwarmContainerDown{oshal-local-api}` +
   a dependent-bot alert inside the window ⇒ ONE ticket, `rootCandidate.target` = the api,
   3 members recorded with attach reasons. (FR-D2/D3/D4/D5)
5. **RCA once.** The bundled drill above dispatches exactly one RCA run. (FR-E1)
6. **Budget skip is visible and promotable.** With the sliding-hour spend ≥ cap, an auto-flow
   ticket parks in backlog carrying `analysis-skipped:budget`, and a promote dispatches it. (FR-E2)
7. **Flap defers, surfaces.** 6 refires in 30m ⇒ `flapping` flag, no dispatch until quiet or
   promoted. (FR-E3)
8. **Resolved closes only from backlog, only when enabled.** With `ALERT_AUTO_RESOLVE=true`, a
   fully-resolved backlog ticket completes as `self-resolved`; the same events on an `approved`
   ticket change nothing but member state. Default-off proven too. (FR-E4)
9. **Matcher hygiene.** A claim rule containing a time predicate is rejected at registry load.
   (FR-B3)
10. **Key hygiene.** An empty-rendering incident key falls back to fingerprint + warning; a
    multi-alertname rule without `{alertname}` in its key is rejected. (FR-C1)
11. **Severity never lowers.** A lower-severity refire leaves priority; a higher one raises it.
    (FR-C4)

## 8. Phasing

- **P1 — Consolidation.** Stages A/C + counters (A3) + FR-E1. Touches the intake route +
  ticket-service metadata only; highest value for the smallest diff (kills silent skips and
  duplicate-storm tickets). Guards 1–3, 10, 11.
- **P2 — Bundling.** Stage D + root candidate. Guards 4–5.
- **P3 — Dispatch gates.** Stage B registry hardening + E2/E3/E4. Guards 6–9.

Each phase ships its guards in the same change (2026-07-19 hardening doctrine). Done-when criteria:
[BACKLOG.md](../BACKLOG.md).

## 9. Traps inherited from the source — do-not-repeat requirements

1. **No time predicates in claim matchers** (source ADR-026): a freshness clause inside a matcher
   silently rejects everything and the only symptom is "no matching rules". Enforced by FR-B3
   validation, guard 9.
2. **No orphanable rule store** (source ADR-038): the source registered rules into a persistent
   store with no GC — a *disabled* rule kept matching, a renamed one left a live orphan. Our
   registry is declarative and rebuilt on load; there is no persisted rule store to orphan.
3. **Never correlate only within the arriving batch** (A1): that is the degenerate mode that made
   the source's graph path a no-op in production. FR-D1 correlates against open incidents.
4. **Never reconstruct composition after the fact** (A2): attach-time membership or nothing.
5. **No silent suppression anywhere**: every drop, skip, dedup, and budget-cap is counted and — 
   where a ticket exists — visible on it. (The source's silent-skip surface is today's oshal
   behavior; this spec removes it.)
6. **Key discipline** (source ADR-031): catch-all rules carry `{alertname}` in the key; no free-text
   key fields; empty keys never merge distinct alerts.
7. **No process-local-only dedup state**: the source's TTL caches pinned every service to one
   replica and reset on restart. The atomic claim in FR-C2 is DB-enforced; in-memory layers are
   optimization only.
8. **One constants module** for defaults: the source shipped `86400` in its defaults dict and
   `3600` at the read site for the same knob.
9. **No configured-but-unimplemented knobs** (A4): if a setting exists, a guard proves it does
   something; `ALERT_AUTO_RESOLVE` ships with guard 8 or ships not at all.

## 10. Non-goals

- **Not a rebuild of the 14-service pipeline** — no NATS, no percolation engine, no new
  containers. At swarm scale this is one in-process stage.
- **Not the ADR-069 product surface** (per-user pull connectors for Dynatrace/ServiceNow/etc.).
  This is the swarm's own self-monitoring lane; the two meet only at the RCA engine and graph
  tier, exactly as ADR-069 §2a bounds it.
- **No change to remediation authority.** RCA proposes; the approve-or-close gate and the
  self-healing-bot's whitelisted container actions are untouched.
- **No windowed *delay* of first notification.** Consolidation and bundling attach *subsequent*
  alerts to an already-open ticket; the first alert of an incident opens its ticket immediately.
  (The source platform considered and never shipped an accumulate-then-flush buffer; deferring
  the first signal to "collect a nicer group" trades detection latency for tidiness — wrong trade
  for a self-healing loop.)

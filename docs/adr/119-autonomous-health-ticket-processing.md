# ADR-119: Autonomous health ticket processing — the alert stream drives the RCA resolution stream

Date: 2026-07-29
Status: Accepted — BUILT. The rails shipped first; P1 (consolidation), P2 (bundling) and P3
(claim registry + budget/flap/resolved dispatch gates) landed 2026-07-31, and P4 — the ladder
itself — landed 2026-08-01: A1 via `intake: auto` on the four container-health rules
(analysis-only, per-rule, removable), A2 as the bounded auto-apply engine
(`src/features/alert-triage/services/auto-apply.ts` behind `SELF_HEAL_AUTO_APPLY`, default
false) with every bound below implemented and guard-named in
`tests/unit/alert-triage-autonomy.spec.ts`. The live container-kill drill — P4's remaining
done-when half — RAN on the deployed stack 2026-08-01 and PASSED: stopping
`oshal-local-research-bot` produced one ticket (`34e1a1c8-b31b-469c-910c-53112a6f7f99`,
`owner_sub=alert:prometheus`, urgent) that reached `customer_action` with the action gated,
and FR-E4 marked its members resolved when the container returned. Getting there needed two
fixes the unit guards could not have caught, both live-found and shipped as PRs #99/#100 —
see "What the drill found" below. A3 remains not granted.

## Context

Operator direction (2026-07-29): the monitoring alert stream must eventually connect to the RCA
issue-resolution stream so health tickets process automatically — detect, analyze, and (within
bounds) resolve without a human driving every step.

**The connection already exists end-to-end as shipped rails.** Nothing below is new:

```
Prometheus + Alertmanager + cAdvisor        docker-compose.monitoring.yml (overlay)
        │ webhook (fail-closed bearer token)
        ▼
POST /api/alerts/alertmanager               src/app/routes/alertmanager-routes.ts
        ▼
intelligent-processing ticket               swarm-apps/intelligent-processing.yaml
        │ backlog → (operator promote) → approved
        ▼
incident-rca pipeline                       rca-specialist worker, queue-bot reviewer
        │ MODE A/B/C on line 1 of RCA-REPORT.md
        ▼
disposition finalizer                       ADR-069 §2b: A/B → customer_action, C → escalated
        │ approve-or-close gate (human)
        ▼
self-healing-bot applies the fix            whitelisted container restart (docker socket,
                                            TOOL_AUTH_DOCKER_SOCKET, ENABLE_SELF_HEALING_SCHEDULER)
```

What is missing is not the wiring — it is **safe autonomy**. The deployed posture parks every
alert in backlog for hand-promotion, and rightly so, because the intake is still per-alert
(see the problem list in the
[alert triage & consolidation spec](../architecture/alert-triage-and-consolidation-spec.md)):
duplicate storms would mean unbounded RCA dispatches, one incident opens N tickets, noise is
uncounted, and nothing meters analyst spend. Auto-flowing that intake as-is would be an
unattended cost and noise amplifier.

Two standing constraints shape the answer:

- **Automation is opt-in, default OFF** (operator directive). Self-healing acts inward — on the
  swarm's own containers — but the same conservative posture governs anything that *applies*
  changes unattended.
- **The bootstrap caveat** ([self-healing runbook](../runbooks/self-healing-monitoring.md)): if
  the control-plane api is down, the ticket path cannot open its own ticket. Core infra recovery
  (api / db / redis) belongs to the external watchdog, never to this loop.

## Decision

**An autonomy ladder, assigned per alert rule — never one global switch.** Each level adds one
kind of unattended behavior and has a named precondition to enter.

| Level | Behavior | Gate to enter |
|---|---|---|
| **A0 — Observe** | Claimed alerts open consolidated tickets that park in `backlog`; a human promotes, approves, closes. | Today's posture. Default for every rule, forever. |
| **A1 — Auto-analyze** | Consolidated incidents auto-flow into `incident-rca`; the RCA proposal still stops at the approve-or-close gate. Analysis is unattended; action is not. | Triage **P1** (consolidation — one ticket per incident, storm-safe) and **P3** (budget cap + flap damping) are live with their guards green. Per-rule opt-in via the existing `intake: auto` label; the four container-health rules move to A1 once the preconditions hold. |
| **A2 — Auto-apply (bounded)** | A Mode-A proposal whose action is in the sanctioned class — restart of a **non-core worker container** (the existing self-healing whitelist; never api/db/redis/chroma, which are watchdog territory) — auto-approves, executes, then **verifies** (target healthy within a bounded window) before the ticket completes. Failed verification reopens the ticket and escalates to a human. | `SELF_HEAL_AUTO_APPLY=true` — explicit per-deployment opt-in, default **false** (kill switch). Plus all A1 preconditions. |
| **A3 — Not granted** | Autonomous code-change remediation (routing RCA output into the build queue / developer-bot lane) is out of scope. Mode B (human action needed) and Mode C (escalation) always land on a human, at every level. | — (recorded as a non-goal, not a future default). |

Bounds on A2, all mandatory:

1. **One auto-apply per incident key per consolidation TTL.** A recurrence inside the TTL
   escalates to a human instead of re-applying — the loop must never trade a crash loop for a
   restart loop.
2. **A global hourly auto-apply cap** across all incidents, so a correlated failure (one bad
   image everywhere) becomes one escalation, not a fleet-wide restart storm.
3. **Verification-after-apply is required, not decoration** — the action is not "done" because
   the command exited 0; the ticket completes only when the target is observed healthy.
4. **Full audit on the ticket**: what was applied, when, verification result, and which autonomy
   level authorized it.
5. **The kill switch reverts A2 to A1 semantics** — proposals queue at the gate, nothing applies.

Every level change is configuration, observable on the ticket surface, and ships with guards
(guard-per-fix doctrine). The done-when criteria and named guards live in BACKLOG
"Alert triage & consolidation" **P4**; the roadmap row tracks today/target honestly.

## Consequences

**Positive**

- The boring majority of container-health incidents — a wedged worker, a restart loop, resource
  pressure — can detect → consolidate → analyze → restart → verify → close unattended at A2,
  while every consequential judgment (anything Mode B/C, anything core-infra, anything repeated)
  still lands on a human.
- Analyst spend is bounded by construction (consolidation kills duplicate dispatches; the P3
  budget caps the rest), so A1 cannot become an unattended bill.
- The per-rule ladder gives the operator a dial, not a leap of faith: any rule can be walked back
  to A0 by config alone.

**Negative / costs**

- Autonomy cannot ship before triage does — A1 is structurally blocked on P1+P3. That ordering is
  the point, but it makes this a later deliverable, not a quick flag-flip.
- A2's bounds add real implementation surface (verification probes, caps, escalation paths), and
  a wrong bound is worse than no autonomy — hence the one-per-TTL rule, the fleet cap, and the
  default-off kill switch are part of the decision, not tuning left for later.
- Deliberate friction remains: fresh deployments observe (A0) until the operator opts rules in.
  That is the automation directive applied, and it is not to be optimized away.

## What the drill found (2026-08-01)

Every P1-P4 guard was green and the ladder still could not work on a real box. Three
independent breaks, none of which a stubbed test can see:

1. **The intake could not write a ticket.** A real, authenticated Alertmanager POST
   consolidated and then died on `new row violates row-level security policy for table
   "tickets"` — the machine-write identity class. The specs all stub the ticket gateway,
   which is precisely why it shipped. Fixed by stamping a machine identity
   (`ALERT_INTAKE_OWNER_SUB = 'alert:prometheus'`, `isOperator:false`) on both the connection
   and the row, following the `a2a:<agentId>` precedent — which hit the identical defect in
   July. Guarded by a REAL insert against a REAL RLS-enforcing table
   (`tests/alert-intake-rls-live.spec.ts`), not a stub.
2. **The rules watched nothing.** cAdvisor emits zero series for any oshal container on
   Docker Desktop 29's containerd image store, so `name=~"oshal-local-.+"` never matched:
   `absent()` fired permanently, making `SwarmContainerDown` a standing false alarm with no
   target. Both runtimes now expose `/metrics` and each container is its own scrape target.
3. **`ALERT_WEBHOOK_TOKEN` was never forwarded into the api by compose.** The receiver is
   fail-closed, so the entire ladder was unreachable while merely looking quiet.

A fourth was caught by re-running the drill against the fix itself: a jittery start-time gauge
made the restart-loop rule count scrapes, pushing all 34 bots into a pending restart-loop.
**P3's budget gate contained it** — all 32 false tickets parked in backlog at zero analyst
spend, which is the ladder's cost bound doing exactly its job.



## What the A2 legs found (2026-08-02)

A1 was proven on 2026-08-01. The A2 legs ran the next night and found **two more breaks that
made unattended apply impossible**, plus three behaviours nobody had written down. Neither break
was visible to any of the 32 P1–P4 guards, for the same reason as last time: every one of them
substitutes the `RemediationExecutor`, and both breaks were in what the executor talks to.

1. **`POST /api/self-heal/apply` did not exist on any bot that runs.** It was registered from
   `any-bot/server/app.js` — the `BOT_RUNTIME=any-bot` legacy server, which nothing in compose
   runs. Every bot container, `oshal-local-self-healing` included, runs `BOT_RUNTIME=bot-node`
   → `dist/app/bot-node-server.js`, which never mounted it. Proven before the fix: a POST from
   the api container answered `Cannot POST /api/self-heal/apply` in HTML. Every unattended apply
   would have escalated `auto-apply:apply-failed`. Fixed by mounting the SAME registrar on the
   bot-node runtime (`src/app/bot-node-self-heal-route.ts`) — two implementations of a
   container-restarting endpoint is how a whitelist or a fail-closed gate silently diverges.
2. **The docker inspect template was invalid on every container.** `_inspectContainer` asked for
   `{{.State.RestartCount}}` — not a field; docker answers `map has no entry for key
   "RestartCount"` and emits nothing — and dereferenced `{{.State.Health.Status}}` unguarded,
   which also errors on a container with no healthcheck. Every observation therefore threw and
   returned `status:'not-found'` **with `success:true`**. A2's verification loop cannot observe
   health through that, so a *successful* restart would still have escalated `verify-failed`.
   The catch path now reports `inspectOk:false` instead of a clean-looking "not-found".

With both fixed, the A2 legs behaved:

| leg | evidence | outcome |
|---|---|---|
| **A2 auto-apply** | tickets `27e3805e` (incident-remediation), `703279ce` (cloud-ops-bot), `01b2c1ef` (home-bot) | **PASS ×3** — each `complete` / `auto_applied_verified` / `applied-and-verified`, container observed `running` before the ticket closed |
| **hourly cap (bound 2)** | the 4th and later Mode-A proposals | **PASS** — `reason: hourly-cap-reached`, parked visibly at `customer_action`, no 4th restart |
| **recurrence (bound 1)** | ticket `0f1e314c`, `recurrenceOf: 01b2c1ef` | **PASS** — `escalated`, flags `auto-apply-blocked:recurrence` + `needs-attention`, **no** `autoApply` record, so no second restart |
| **core-infra (absolute)** | see below | **NOT EXERCISED** — the incident never reached the gate |

**The core-infra leg did not get to run, and the reason is worth more than the leg.** Stopping
`oshal-local-chromadb` and delivering its alert did **not** open a chromadb ticket: Stage-D
bundling attached it to the open `oshal-local-research-bot` incident (`hops: 2` — chromadb ← api
← research-bot), which is correct, and made chromadb that incident's `rootCandidate`
(`reason: deepest-dependency`) and therefore its would-be apply target. But the RCA classified
that incident **Mode B**, and Mode B never consults the auto-apply hook at all. So the absolute
bound was never asked the question. To exercise it, a future drill needs a **Mode-A** proposal on
an incident whose `rootCandidate` is core infra. Until then the bound's only proof is its unit
guard (`core-infra-never-applies`).

Three behaviours the drill surfaced that are not defects but will waste the next person's hour:

- **A1's own output blocks A2 on the same key.** `customer_action` is an OPEN incident state, so
  a refire *consolidates onto the A1 ticket* instead of opening a new incident — and a
  consolidated refire never re-enters the pipeline. On a box that has run the A1 leg, the A2 leg
  cannot trigger for that container until a human closes the ticket at the approve-or-close gate.
  Observed exactly: the first A2 kill consolidated onto `34e1a1c8`, the A1 drill's own ticket.
- **Alertmanager will not re-deliver a same-fingerprint refire.** With `group_interval: 5m` and
  `repeat_interval: 4h`, a container that goes down, comes back and goes down again inside the
  group interval produces **no second webhook** — the ladder never sees the second failure.
  Restarting alertmanager does not clear it. Drill deliveries were therefore made by an
  authenticated POST to the real fail-closed receiver, which skips alertmanager's dispatch and
  nothing else.
- **The P3 budget gate held under a 30-container correlated failure.** Stopping 30 bots at once
  produced 30 tickets, every one parked `analysis-skipped:budget` at zero analyst spend — the
  same containment the restart-loop jitter incident recorded, reproduced deliberately.

# ADR-119: Autonomous health ticket processing — the alert stream drives the RCA resolution stream

Date: 2026-07-29
Status: Accepted (direction). The rails are shipped and the triage build this gated on is now
complete — P1 (consolidation), P2 (bundling) and P3 (claim registry + budget/flap/resolved
dispatch gates) all landed 2026-07-31 with their guards green. Autonomy itself (A1/A2) lands
as P4 of the BACKLOG "Alert triage & consolidation" entry; its structural preconditions now
hold.

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

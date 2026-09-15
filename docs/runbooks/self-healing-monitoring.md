# Swarm Self-Healing — Prometheus → RCA Pipeline

How the OSHAL swarm monitors and heals *itself*: Prometheus watches the swarm's
own containers, Alertmanager turns problems into incident tickets, and the
existing `incident-rca` pipeline investigates and proposes a fix that you gate at
approve-or-close.

## The loop

```
cAdvisor  ──scrapes──▶  Prometheus  ──alert-rules.yml──▶  Alertmanager
                                                              │ webhook
                                                              ▼
                              POST oshal-api:5000/api/alerts/alertmanager
                                                              │  (approved alert?)
                                                              ▼
                                      incident ticket (externalProvider=prometheus)
                                                              │ auto-flows in
                                                              ▼
                          incident-rca pipeline → bots root-cause + PROPOSE a fix
                                                              │
                                                              ▼
                                approve-or-close gate (human-in-the-loop)
                                                              │ approve
                                                              ▼
                       self-healing-bot restarts the container (selfHealingTools)
```

Every consequential action is a ticket you can see and gate — that's the point
of routing self-healing through the same ticket system.

## What was added

| Piece | File |
|---|---|
| Webhook intake route | `src/app/routes/alertmanager-routes.ts` (`POST /api/alerts/alertmanager`) |
| Auto-approve trusted alert sources | `src/features/ticketing/services/ticket-service.ts` (`TRUSTED_ALERT_PROVIDERS`) |
| Prometheus scrape + alerting | `ops/monitoring/prometheus.yml` |
| Container-health alert rules | `ops/monitoring/alert-rules.yml` |
| Alertmanager → webhook routing | `ops/monitoring/alertmanager.yml` |
| Monitoring stack overlay | `docker-compose.monitoring.yml` |

Everything downstream of the ticket already existed: the RCA roster,
`selfHealingTools.restartContainer` (whitelisted to `oshal-*`/`swarm-*`), and the
`incident-approval-remediation-loop.sh` operator loop.

## Registering the bot that actually applies the fix

The RCA bots (`rca-specialist`, `incident-remediation-bot`) *propose* a fix; the
`self-healing-bot` *executes* it. Registering it correctly took four things that
all have to line up — miss any one and the bot looks registered but silently
can't heal:

| Requirement | Where | Why |
|---|---|---|
| Roster entry (UUID `…0030`) | `swarm-apps/intelligent-operations.yaml` | Framework upserts it active so the agent router can select it. |
| Running worker container | `docker-compose.oshal-local.yml` service `self-healing-bot` (profile `incident`) | A manifest bot with no container = work routed into a void. |
| Docker socket mounted | `- /var/run/docker.sock` on that service | `restart-container` shells out to `docker`; this is the only worker that has it. `oshal-bot:latest` already ships `docker-cli`. |
| Tool auth ON | `TOOL_AUTH_DOCKER_SOCKET: auto` on that service | The swarm-wide default is `off`; without the override the socket is mounted but the tool stays authorization-blocked. |
| Monitoring hook enabled | `ENABLE_SELF_HEALING_SCHEDULER: "true"` | The `SelfHealingScheduler` hook used to gate on `AGENT_ID === 'self-healing-bot'`, which never matched once the bot runs under its routing UUID. Now gated on the explicit flag (protected, single-owner). See `any-bot/server/app.js`. |

The bot runs with `BOT_NAME=self-healing-bot` (string, for any-bot identity) and
`AGENT_ID=<UUID>` (for mesh routing) — both, the way every other worker does.

Bring it up with the incident profile and confirm it subscribed:

```bash
docker compose -f docker-compose.oshal-local.yml --profile incident up -d self-healing-bot
docker logs oshal-local-self-healing 2>&1 | grep -E "SelfHealingScheduler|docker|Registered tool"
# expect: "[PHASE_61] SelfHealingScheduler started"
curl -s http://localhost:35457/api/swarm/bots/registry | grep self-healing-bot
```

## Run it

```bash
# 1. Main swarm (creates the oshal-local_oshal network)
docker compose -f docker-compose.oshal-local.yml up -d

# 2. Monitoring overlay
docker compose -f docker-compose.monitoring.yml up -d

# 3. Check wiring
#    Prometheus targets all UP:   http://localhost:9090/targets
#    Alert rules loaded:          http://localhost:9090/alerts
#    Alertmanager up:             http://localhost:9093
```

### Prove the loop without breaking anything

Kill a non-critical bot and watch a ticket open:

```bash
docker stop oshal-local-research-bot
# ~1-2 min: SwarmContainerDown fires -> Alertmanager -> webhook -> incident ticket
bash scripts/monitor-oshal.sh        # the new incident appears
docker start oshal-local-research-bot
```

Or fire a synthetic alert straight at the webhook (bypasses Prometheus):

```bash
curl -s -X POST http://localhost:35457/api/alerts/alertmanager \
  -H 'Content-Type: application/json' \
  -d '{"alerts":[{"status":"firing","fingerprint":"test-1",
        "labels":{"alertname":"SwarmContainerDown","severity":"critical","container":"oshal-local-research-bot"},
        "annotations":{"summary":"synthetic test"}},"startsAt":"2026-06-19T00:00:00Z"}]}'
# -> {"success":true,"created":1,...}
```

## Configuration

| Env var (on `oshal-api`) | Default | Effect |
|---|---|---|
| `ALERT_WEBHOOK_TOKEN` | unset | When set, the webhook requires `Authorization: Bearer <token>`. Put the same value in `alertmanager.yml`'s `http_config`. |
| `ALERT_APPROVED_NAMES` | unset (accept all firing) | Comma-separated allowlist of `alertname`s that may open tickets — the "create a ticket at all" gate. |
| `ALERT_BACKLOG_NAMES` | unset | Comma-separated `alertname`s that land as **backlog** (operator triage) instead of auto-flowing into RCA. |
| `ALERT_DEFAULT_INTAKE` | `approved` | Default intake for any alert not otherwise routed: `approved` (auto-flow) or `backlog` (manual triage). Flip to `backlog` to make the whole pipeline human-gated up front. |

### Backlog vs auto-flow intake

Two gates, do not confuse them:

1. **Create gate** (`ALERT_APPROVED_NAMES`) — does this alert open a ticket at all.
2. **Intake gate** — of the tickets that open, which **auto-flow into incident-rca** (`approved`) vs **park in backlog** for an operator to pull in (`backlog`).

Intake resolves first-match-wins: (1) the alert's `intake` label (`backlog`/`manual`/`queue` vs `auto`/`approved`/`flow`) → (2) `ALERT_BACKLOG_NAMES` → (3) `ALERT_DEFAULT_INTAKE`.

Set it per-rule in `alert-rules.yml` (the natural home — the SRE who writes the rule decides its urgency):

```yaml
labels:
  severity: warning
  intake: backlog      # this alert waits in the queue instead of auto-flowing
```

`SwarmContainerHighCPU` already carries `intake: backlog` as a worked example.

**Surface:** backlog tickets appear in the cockpit ticket workbench — filter
**Status = Backlog**, **Type = Incident**. The webhook response reports the split:
`{ created, backlogged, autoFlowed, skipped, resolved }`.

## The overlay is gone after an engine restart

Symptom: the swarm is up and `docker ps` looks correct, but Prometheus and
Alertmanager are not in it. After an **ungraceful** engine stop — the Docker VM
killed rather than a clean `compose down` — `oshal-local-prometheus` and
`oshal-local-alertmanager` have been observed recording **exit 255** and *not*
restarting, despite `restart: unless-stopped`, while every container that recorded
exit 0 came back on its own. `docker ps` shows what is running, not what is
missing, so the fleet can auto-restart monitored by nothing until a human looks.
Observed 2026-09-14 twice in one night; the api showed the same exit-255 symptom on
the second.

What the surviving state says about the second occurrence, read 2026-09-15:
Prometheus and Alertmanager had already stopped at 03:25:25Z, about 29 minutes
before cAdvisor and the docker proxy stopped at 03:54:35Z — and those two, same
overlay and same policy, restarted by themselves at 03:54:49Z and 03:55:22Z. Docker
documents `unless-stopped` as not restarting a container that was already stopped
when the daemon restarts, and consults the exit code only for `on-failure`, so on
that night's timings the two monitoring containers behaved as the policy is written.
What stopped them half an hour earlier, and why the api did not come back although
it stopped with the containers that did, is still open. The exit codes from that
night are no longer readable — a started container reports `.State.ExitCode` 0. If
you find the overlay down again, read `.State.Error`, `.State.ExitCode`,
`.State.FinishedAt` and `.RestartCount` for every container **before** starting
anything, and copy the dockerd log for that window out of
`%LOCALAPPDATA%\Docker\log\vm\` — it rotates by size and does not keep a night.
See BUG-21 in [../operations/bug-log.md](../operations/bug-log.md) and the BUG-21
tail entry in [../BACKLOG.md](../BACKLOG.md).

Do not infer the answer from `docker ps`; assert it:

```bash
bash scripts/monitoring-liveness-check.sh --strict
```

It fails loudly when Prometheus is unreachable, has discovered no targets, or any
discovered target is down, and names the ones that are. `bash scripts/oshal-up.sh`
brings the overlay back as part of the ordered bring-up.

### Running that check when nobody is watching

`scripts/monitoring-liveness-watch.sh` runs the strict check unattended and reports
a confirmed failure on the alert rail the rest of the box already uses
(`oshal-send-alert.js`: Telegram first, then Gmail from inside the api container).
It **observes only** — it never starts the Docker engine and never starts a
container, because Docker must not start by itself on this box, which is also why
`scripts/oshal-stack-watchdog.ps1` is paused. With the engine absent it logs that
and exits 0: an engine that is not answering is a different fault with a different
owner, and there is no alert rail without the api container anyway.

It alerts only after `MONITORING_WATCH_CONFIRM_RUNS` consecutive failures (default
3, so a single miss during a deploy or a container recreate does not mail anyone),
and it re-alerts at most once per `MONITORING_WATCH_REALERT_MINUTES` (default 60) so
a standing outage does not become wallpaper — the BUG-22 lesson from the nightly CI
mail. Recovery is announced once. Its exit status is the strict check's own, so
Task Scheduler's Last Result is the real answer. Log and streak state live beside
every other unattended oshal task, in `%LOCALAPPDATA%\oshal\`:

```bash
bash scripts/monitoring-liveness-watch.sh          # run it by hand
cat "$LOCALAPPDATA/oshal/monitoring-liveness-watch.log"
```

Register it as a five-minute scheduled task **from the checkout you want watched** —
the registration derives the launcher path from its own location, which is what
keeps a task from ending up judging the ADR-115 archive:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-monitoring-liveness-task.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-monitoring-liveness-task.ps1
```

`-DryRun` prints the exact action without touching Task Scheduler; `-Remove` deletes
the task. Guard: `tests/unit/monitoring-liveness-watch.spec.ts`.

## The bootstrap caveat (important)

If **`oshal-local-api` itself** is the thing that's down, the ticket-based heal
path can't open its own ticket — the API that receives the webhook is gone. The
`SwarmApiUnreachable` rule exists to flag exactly this, but recovering core infra
(`oshal-local-api`, `-redis`, `-db`) needs a **dumb watchdog outside the swarm**
that restarts those directly. The ticket/RCA path is for everything *else* — a
worker bot looping, a queue stall, resource pressure — where the API is alive to
reason about the fault. Don't rely on the swarm to resurrect its own control
plane.

## Extending to error-based alerts (next)

Container health is the starting signal. To alert on application errors (LLM
failures, queue stalls, task error-rate), add a real Prometheus `/metrics`
endpoint to the bots (`prom-client`), add a scrape job in `prometheus.yml`, and
add a rule group in `alert-rules.yml` keyed on those series. Nothing in the
intake route or pipeline changes — a firing alert is a firing alert.

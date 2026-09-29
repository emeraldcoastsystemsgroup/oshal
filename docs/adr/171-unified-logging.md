# ADR-171: Unified logging — one log format, one searchable store

Date: 2026-09-29
Status: **Accepted (operator, 2026-09-29) — configuration only, never run.** `docker-compose.logging.yml`
and `ops/logging/config.alloy` are in the tree; no bring-up, deploy or installer script starts them.
Wiring them into bring-up and the installer, the first measured run, the cockpit read path, and moving
the JavaScript layer onto the standard format are two BACKLOG entries (see Rollout).

Related: [ADR-107](107-run-trace-read-model-observability.md) (the run trace, a read model over
database rows), [ADR-119](119-autonomous-health-ticket-processing.md) (the monitoring overlay:
Prometheus, Alertmanager and the self-healing loop).

## Context

Triaging a problem on the swarm, and especially on somebody else's deployment, means reading what the
api and several bots logged about one ticket. Today that is `docker logs` against each container by
hand. This ADR records what exists and what replaces the hand work.

### What exists at core `main` 677be050

- **The mandated logger.** CLAUDE.md "Logging" requires pino through
  `createChildLogger({ module })` from `@/shared/logger` on the TypeScript side
  (`src/shared/logger/logger.ts`). Each process writes JSON to stdout, which is what `docker logs`
  shows, and debug-level JSON to `output/logs/<SERVICE_NAME>.log`. Secret-bearing keys are masked by
  one list, `LOG_REDACT_OPTIONS`, guarded by `tests/unit/logger-redaction.spec.ts`.
- **Every bot has its own output volume.** `docker-compose.oshal-local.yml` mounts a separate
  `<bot>-output` volume at `/app/output` for each bot, so each container's log file lives where no
  other container can read it.
- **The cockpit Logs tab shows the api only.** `src/pages/cockpit/js/views/LogsView.js` calls
  `GET /api/v1/logs/query` and `/api/v1/logs/modules` (`src/app/routes/cockpit-log-routes.ts`).
  `LogReaderService` (`src/features/logging/log-reader-service.ts`) reads the tail of one file, the
  api process's own, 1 MB at first and at most 4 MB. No bot line can reach it, and its "All" range
  means as far back as that tail reaches. The filters themselves (ticket with child tickets, level,
  module, free text, time range) are sound and are kept.
- **`GET /api/logs` is not a log reader.** It builds a feed from task and message rows for the
  health dashboard and the debug stream (`src/app/routes/logs-routes.ts`).
- **The JavaScript layer does not use pino.** `any-bot/server/utils/logger.js` is winston: coloured
  plain text on the console, JSON files under `any-bot/logs/`, and no redaction list.
  `any-bot/server/services/queue-manager/LoggingStandard.js` wraps start/complete/error helpers.
  Some files still call `console.*` directly
  (`grep -rlE "console\.(log|warn|error|info)" any-bot/server --include=*.js` lists them). ESLint's
  `no-console` rule covers `src/**` only; `eslint.config.mjs` ignores `any-bot/**`.
- **Nothing collects logs.** The monitoring overlay (`docker-compose.monitoring.yml`) runs cAdvisor,
  Prometheus, Alertmanager and a Docker API proxy: metrics and alerts only.
- **The run trace (ADR-107) is not a log view.** It answers "what did this ticket do" from
  `ticket_status_history`, `chat_tasks` and the cost ledger, and carries no log lines.
- **The container is not in the line.** Every bot gets `SERVICE_NAME: oshal` from the shared bot
  environment, so the `service` field on a bot's log line does not say which bot wrote it.

### The options, with where each number comes from

| Component | License | Memory | Source |
|---|---|---|---|
| Grafana Loki (store) | AGPL-3.0 | No official figure for a single-container install. Community reports: ~500 MiB average and ~2.6 GiB peak during queries on a few GB/day; another settled near 1.5 GB and passed 4 GB on one heavy parsing query | [Grafana forum](https://community.grafana.com/t/optimizing-ram-for-small-installation/120459), [Grafana forum](https://community.grafana.com/t/loki-monolithic-memory-consumption/112032) |
| VictoriaLogs (store) | Apache-2.0 | Vendor claim: "up to 30x less RAM" than Loki or Elasticsearch. Not measured here | [VictoriaLogs docs](https://docs.victoriametrics.com/victorialogs/) |
| Grafana Alloy (collector) | Apache-2.0 | Grafana's estimate: about 120 MiB and one CPU core per 1 MiB/s of logs ingested; no idle figure published | [Alloy resource estimates](https://grafana.com/docs/alloy/latest/introduction/estimate-resource-usage/) |
| Promtail (collector) | — | Reached end of life on 2026-03-02; Alloy is its replacement | [Promtail docs](https://grafana.com/docs/loki/latest/send-data/promtail/) |
| Grafana (dashboards) | AGPL-3.0 | Not needed: the cockpit Logs tab and VictoriaLogs' own web UI cover the use | — |

The box budget is in [the engine sizing runbook](../runbooks/docker-engine-memory-sizing.md): the
full swarm idles near 4 GB, and the engine cap is sized against that plus an image build. A store
whose memory spikes during a search, which is exactly when someone is triaging, is the risk to size
against.

The licenses are not a constraint. oshal is AGPL-3.0-or-later; nothing here is vendored or modified,
and [docs/legal/licensing.md](../legal/licensing.md) already sets the rule that runtime dependencies
are fetched at install time rather than redistributed.

## Decision

**D1 — One log format.** The JSON line the pino logger already writes is the format for every oshal
process, TypeScript and JavaScript:

- `time` (ISO-8601), `level` (pino's numeric level), `msg`;
- `module` on every line, from the child logger;
- `ticketId`, `agentId`, `runId`, `phase` whenever the code knows them. These are the fields
  `LogReaderService` already treats as first-class;
- `err` for errors, through pino's error serializer so the stack is kept;
- secrets masked by `LOG_REDACT_OPTIONS`, one list for both runtimes.

Stdout is the transport. The per-container file stays as a local fallback. Which container wrote a
line is added by the collector (D3), not by the process. The JavaScript layer moves onto this format
as a thin wrapper over the same pino configuration, and gets its own guard against `console.*` and
winston; that is BACKLOG entry "One log format across the TypeScript and JavaScript runtimes
(ADR-171 D1)".

**D2 — The store is VictoriaLogs, single container.** It is chosen over Loki on memory. Loki's
reported search spikes exceed the headroom the sizing runbook leaves. VictoriaLogs' advantage is
still a vendor claim, so the first run measures it. If it does not hold under its cap, Loki is the
fallback: VictoriaLogs takes the Loki push protocol, so switching stores changes one URL in the
collector config. VictoriaLogs also has its own web UI (`/select/vmui/`) and a query API
(`/select/logsql/query`, JSON lines) for the cockpit to read.

**D3 — The collector is Grafana Alloy.** It follows each container's stdout and stderr through the
Docker API (`loki.source.docker`). It takes every container on the `oshal-local_oshal` network, so a
new bot is collected from its first line with nothing to register, the same property the Prometheus
jobs get from label discovery. Each line is labelled `container`, `compose_service`,
`compose_project` and `tier` (the `oshal.tier` label). The log stack's own containers are left out.
VictoriaLogs parses each JSON line into fields, takes pino's `msg` as the message, and keeps a
non-JSON line whole.

**D4 — Security posture.**

- Alloy reaches Docker only through a read-only socket proxy (container and network reads, `POST`
  denied), on the same reasoning as the monitoring overlay's proxy. The logging overlay has its own
  proxy so the two overlays start and stop independently.
- VictoriaLogs is published on `127.0.0.1` only. It has no authentication of its own, and these logs
  carry ticket titles and message previews. Reaching it from elsewhere goes through the operator's
  existing access path, never a public port.
- Secrets are masked where the line is written (D1). The store never adds masking of its own, which
  is why the JavaScript layer's unmasked winston output is part of D1 and not a detail.

**D5 — Bounded resources.** Every service carries a hard `mem_limit`: VictoriaLogs 512m, Alloy 256m,
the proxy 64m. VictoriaLogs' cache is capped below its limit. Logs are kept seven days or 2 GiB,
whichever comes first. All of these are environment overrides with those defaults
(`docker-compose.logging.yml` header). The numbers are starting budgets from the sources above; the
first run replaces them with measurements.

**D6 — Optional, pulled at install time.** The overlay is its own compose file, like monitoring.
Images are pinned by version and pulled from their upstream registries when the overlay is started;
oshal ships only its own compose and config files. A deployment that never starts the overlay pays
nothing.

**D7 — The cockpit Logs tab reads the store when it is present.** Same inputs as today (ticket with
child tickets, level, module, text, time range), answered by VictoriaLogs across every container,
with a container filter added. When the overlay is absent, the tab falls back to today's file reader
and says which source it is showing.

## Consequences

- One place to search the api and every bot, and once D7 lands, a ticket trace across all of them
  from the cockpit.
- When running, the overlay is capped at 832 MB of container memory in total. It is zero when not
  started.
- Until D1's migration, lines from the JavaScript layer arrive as unparsed text, found by free-text
  search only.
- Nothing in this ADR has run. The first run has to show: the Alloy config loads; log streams stay
  attached through the proxy over hours; the line rate per container, so a noisy container can be
  dropped deliberately; and VictoriaLogs' peak memory during a search.

## Rollout

| Step | What | Where |
|---|---|---|
| R0 | Overlay compose file, Alloy pipeline, this ADR, a static guard (`tests/unit/logging-overlay.spec.ts`) | In the tree, never run |
| R1 | Wire the overlay into bring-up and the installer as an option; first measured run; the cockpit read path (D7) | BACKLOG "Unified logging overlay: wire it into bring-up and the installer, and measure it (ADR-171)" |
| R2 | The JavaScript layer on the D1 format, with a guard | BACKLOG "One log format across the TypeScript and JavaScript runtimes (ADR-171 D1)" |
